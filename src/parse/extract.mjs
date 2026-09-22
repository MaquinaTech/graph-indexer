/**
 * Language-agnostic extraction engine. One tree-sitter query per grammar (compiled once)
 * yields definitions, references, imports and type evidence; this module turns the raw
 * captures into:
 *
 *   symbols  — every definition (functions, methods, classes, fields, ...), nested with a
 *              qualified name (Class.method), signature, doc, exported/visibility flags;
 *   refs     — every reference occurrence with its position, enclosing symbol, receiver
 *              descriptor and (when inferable intra-file) the receiver's static type;
 *   imports  — the file's import bindings (resolved against the repo by the resolver).
 *
 * Only captured nodes cross the WASM boundary, which keeps extraction fast.
 */
import { compileQuery, createParser, loadGrammar } from './runtime.mjs';

const MAX_SIG = 240;
const MEMBER_PARENT = new Set(['class', 'interface', 'struct', 'trait', 'impl', 'enum', 'object', 'module']);
const REF_PRIORITY = { decorator: 6, inherit: 5, new: 4, call: 3, import: 2, type: 1, value: 0, read: -1 };
const MAX_DOC = 600;

const compiled = new Map(); // spec.id -> { language, query, parser }

export async function prepareLanguage(spec) {
    let c = compiled.get(spec.id);
    if (!c) {
        const language = await loadGrammar(spec.grammar);
        const query = compileQuery(language, spec.query, spec.id);
        c = { language, query, parser: createParser(language) };
        compiled.set(spec.id, c);
    }
    return c;
}

function collapse(s) { return s.replace(/\s+/g, ' ').trim(); }

/** Signature = definition text up to its body, whitespace-collapsed. */
function signatureOf(defNode, spec, source) {
    // `const f = (a, b) => {…}` / `f = lambda …`: the function is the value, its body ends the signature
    const body = (spec.bodyField ? defNode.childForFieldName(spec.bodyField) : null)
        ?? defNode.childForFieldName('value')?.childForFieldName('body') ?? null;
    let end = body ? body.startIndex : defNode.endIndex;
    let text = source.slice(defNode.startIndex, end);
    if (!body) {
        const nl = text.indexOf('\n');
        if (nl > 0) text = text.slice(0, nl);
    }
    text = collapse(text).replace(/[{:=\s]+$/, '');
    if (spec.signatureCleanup) text = spec.signatureCleanup(text, defNode);
    return text.length > MAX_SIG ? text.slice(0, MAX_SIG - 1) + '…' : text;
}

function cleanComment(text) {
    return text
        .replace(/^\s*(\/\*\*?|\*\/|\/\/\/?!?|#+|--)/gm, '')
        .replace(/\*\/\s*$/gm, '')
        .replace(/^\s*\*\s?/gm, '')
        .split('\n').map(l => l.trim()).filter(Boolean).join(' ');
}

/** Doc = contiguous comments immediately above the definition (or its decorators/export wrapper). */
function docOf(defNode, spec, source) {
    if (spec.docOf) {
        const d = spec.docOf(defNode, source);
        if (d != null) return d.length > MAX_DOC ? d.slice(0, MAX_DOC - 1) + '…' : d;
    }
    let anchor = defNode;
    // climb through wrappers that sit between comment and definition
    while (anchor.parent && spec.docWrappers?.has(anchor.parent.type)) anchor = anchor.parent;
    if (anchor.type === 'variable_declarator') anchor = anchor.parent;
    if (anchor.parent?.type === 'export_statement') anchor = anchor.parent;
    const parts = [];
    let prev = anchor.previousNamedSibling ?? anchor.previousSibling;
    let expectRow = anchor.startPosition.row;
    // attributes/annotations written between the doc comment and the definition (#[inline], [Attr])
    while (prev && spec.skipBeforeDoc?.has(prev.type)) { expectRow = prev.startPosition.row; prev = prev.previousNamedSibling ?? prev.previousSibling; }
    while (prev && spec.commentTypes.includes(prev.type) && expectRow - prev.endPosition.row <= 2) {
        parts.unshift(prev.text);
        expectRow = prev.startPosition.row;
        prev = prev.previousNamedSibling ?? prev.previousSibling;
    }
    if (!parts.length) return '';
    const doc = cleanComment(parts.join('\n'));
    return doc.length > MAX_DOC ? doc.slice(0, MAX_DOC - 1) + '…' : doc;
}

// Expression wrappers that do not change the static type of what they wrap.
const PASS_THROUGH = new Set(['parenthesized_expression', 'non_null_expression', 'await_expression', 'await', 'try_expression', 'reference_expression']);
// Literal constructions: `Foo{…}` (Go), `Foo { … }` (Rust), `new Foo(…)` (Java/C#/PHP)
const CONSTRUCTIONS = { composite_literal: 'type', struct_expression: 'name', object_creation_expression: 'type', new_expression: 'constructor' };
// Casts / assertions: the asserted type is the static type.
const CASTS = new Set(['as_expression', 'satisfies_expression', 'cast_expression', 'type_assertion_expression']);
// Literal values: their members are the language's (`'x'.trim()`); null-ish ones carry no type.
const LITERAL_NODES = new Set(['string', 'template_string', 'number', 'true', 'false', 'string_literal', 'integer', 'float', 'integer_literal',
    'decimal_integer_literal', 'decimal_floating_point_literal', 'interpreted_string_literal', 'raw_string_literal', 'int_literal', 'float_literal',
    'boolean', 'boolean_literal', 'char_literal', 'character_literal', 'real_literal', 'concatenated_string', 'rune_literal', 'regex']);
const NULL_NODES = new Set(['null', 'undefined', 'none', 'nil', 'null_literal']);
const CHAIN_RE = /^[A-Za-z_$@][\w$]*(?:\(\)|\[\])*(?:\.[A-Za-z_$][\w$]*(?:\(\)|\[\])*){0,7}$/;

/**
 * `a.b(x).c[i]` → `a.b().c[]`: argument lists and subscripts collapsed, operators normalised
 * (`?.` `!.` `->` `::` `!!`), string literals neutralised. Null when not a plain access chain.
 */
function simplifyChain(text) {
    if (text.length > 400) return null;
    let s = text.replace(/\bawait\s+/g, '').replace(/^new\s+/, '');
    if (/["'`]/.test(s)) s = s.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '0');
    s = s.replace(/\s+/g, '').replace(/<[^<>()]*>(?=\()/g, '');
    for (let i = 0; i < 12 && /[()[\]]/.test(s); i++) {
        const next = s.replace(/\([^()[\]]*\)/g, '\u0001').replace(/\[[^()[\]]*\]/g, '\u0002');
        if (next === s) return null; // unbalanced
        s = next;
    }
    s = s.replace(/\u0001/g, '()').replace(/\u0002/g, '[]')
        .replace(/!!/g, '').replace(/\?\.|!\.|->|::/g, '.').replace(/[!?]+(?=\.|$)/g, '');
    return CHAIN_RE.test(s) ? s : null;
}

/**
 * Compact descriptor of an expression, used for receivers and for variable initialisers:
 *   `this` · `super` · `x` · `a.b().c[]` (access chain) · `new X` · `as T` (cast) · `?` (opaque)
 */
function receiverDescriptor(node, spec) {
    if (!node) return '';
    for (let i = 0; i < 6 && node.namedChildCount >= 1; i++) {
        if (PASS_THROUGH.has(node.type)) node = node.namedChildren[0];
        else if (node.type === 'unary_expression' && node.childForFieldName('operator')?.text === '&') node = node.childForFieldName('operand') ?? node.namedChildren[0]; // Go &T{}
        else break;
    }
    const t = node.type;
    if (CONSTRUCTIONS[t]) {
        const tn = node.childForFieldName(CONSTRUCTIONS[t]);
        const tt = tn ? normalizeType(tn.text, spec) : null;
        if (tt) return 'new ' + tt;
    }
    const text = node.text;
    if (NULL_NODES.has(t)) return 'null';
    if (LITERAL_NODES.has(t)) return '!';
    if (spec.selfNames.includes(text) || t === 'this' || t === 'self') return 'this';
    if (t === 'super' || text === 'super' || /^super\s*\([^()]*\)$/.test(text)) return 'super'; // Python `super()` / `super(Cls, self)`
    if (CASTS.has(t)) {
        const tn = node.childForFieldName('type') ?? node.namedChildren[node.namedChildCount - 1];
        const tt = tn && tn !== node.namedChildren[0] ? normalizeType(tn.text, spec) : null;
        return tt ? 'as ' + tt : '?';
    }
    if (spec.receiverDescriptor) {
        const d = spec.receiverDescriptor(node);
        if (d !== undefined) return d;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(text)) return text;
    const ctor = /^new\s+([A-Za-z_$][\w$.]*)\s*(?:<[^()]*>)?\s*(?:\([^]*\))?$/.exec(text);
    if (ctor && !/\)\s*[.[]/.test(text)) return 'new ' + ctor[1];
    const chain = simplifyChain(text);
    if (!chain) return '?';
    const parts = chain.split('.');
    if (spec.selfNames.includes(parts[0]) || parts[0] === 'this' || parts[0] === '$this') parts[0] = 'this';
    return parts.join('.');
}

// ── type tests that narrow a variable (`x instanceof T`, `isinstance(x, T)`) ──
const EXIT_STATEMENTS = new Set(['return_statement', 'throw_statement', 'raise_statement', 'continue_statement', 'break_statement']);
const opText = (n) => n.childForFieldName('operator')?.text;
const isNegation = (n) => (n.type === 'unary_expression' && opText(n) === '!') || n.type === 'not_operator';
const isLogical = (n, ops) => (n.type === 'binary_expression' || n.type === 'boolean_operator') && ops.includes(opText(n));

/** A block (or single statement) whose last statement leaves it: return / throw / raise / continue / break. */
function alwaysExits(stmt) {
    if (!stmt) return false;
    if (EXIT_STATEMENTS.has(stmt.type)) return true;
    if (stmt.type !== 'statement_block' && stmt.type !== 'block') return false;
    const body = stmt.namedChildren.filter(c => c.type !== 'comment');
    return body.length > 0 && EXIT_STATEMENTS.has(body[body.length - 1].type);
}

/**
 * Source ranges where a type test proves a variable's type: `if (x instanceof T) {…}`, the rest of
 * a block after `if (!(x instanceof T)) return …`, `x instanceof T && x.m()`, ternaries, Python's
 * `isinstance(x, T)` in the same positions. Returns [{ subject node, type node, from, to }].
 */
function typeNarrowings(root, source) {
    const out = [];
    for (const m of source.matchAll(/\binstanceof\b|\bisinstance\s*\(/g)) {
        let test = root.descendantForIndex(m.index);
        for (let i = 0; test && i < 3 && !(test.type === 'binary_expression' || test.type === 'call'); i++) test = test.parent;
        if (!test) continue;
        let subject, type;
        if (test.type === 'binary_expression' && opText(test) === 'instanceof') {
            subject = test.childForFieldName('left'); type = test.childForFieldName('right');
        } else if (test.type === 'call' && test.childForFieldName('function')?.text === 'isinstance') {
            const args = test.childForFieldName('arguments')?.namedChildren ?? [];
            if (args.length !== 2 || args[1].type === 'tuple') continue;
            [subject, type] = args;
        } else continue;
        if (!subject || !type) continue;
        const add = (node) => { if (node) out.push({ subject, type, from: node.startIndex, to: node.endIndex }); };
        // climb through the condition, tracking the truth value of `n` under which the test holds
        let n = test, holdsWhen = true;
        for (let p = n.parent; p; n = p, p = p.parent) {
            if (p.type === 'parenthesized_expression') continue;
            if (isNegation(p)) { holdsWhen = !holdsWhen; continue; }
            const left = p.childForFieldName('left');
            if (isLogical(p, ['&&', 'and'])) {
                if (!holdsWhen) break;
                if (left && left.id === n.id) add(p.childForFieldName('right'));
                continue;
            }
            if (isLogical(p, ['||', 'or'])) {
                if (holdsWhen) break;
                if (left && left.id === n.id) add(p.childForFieldName('right'));
                continue;
            }
            const cond = p.childForFieldName('condition');
            if (p.type === 'if_statement' || p.type === 'elif_clause' || p.type === 'while_statement') {
                if (!cond || cond.id !== n.id) break;
                const cons = p.childForFieldName('consequence') ?? p.childForFieldName('body');
                if (holdsWhen) { add(cons); break; }
                const alts = p.childrenForFieldName?.('alternative') ?? [];
                for (const a of alts) if (a.type === 'else_clause') add(a);
                // `if (!(x instanceof T)) return;` — the rest of the enclosing block
                if (p.type === 'if_statement' && !alts.length && alwaysExits(cons) && p.parent) out.push({ subject, type, from: p.endIndex, to: p.parent.endIndex });
                break;
            }
            if (p.type === 'ternary_expression') {
                if (!cond || cond.id !== n.id) break;
                add(p.childForFieldName(holdsWhen ? 'consequence' : 'alternative'));
                break;
            }
            if (p.type === 'conditional_expression') { // Python: a if cond else b
                const [a, c, b] = p.namedChildren;
                if (!c || c.id !== n.id) break;
                add(holdsWhen ? a : b);
                break;
            }
            break;
        }
    }
    return out;
}

/**
 * Extract symbols/refs/imports for one file.
 * @returns {{ symbols: object[], refs: object[], imports: object[], errors: number }}
 */
export async function extractFile(spec, source, relPath) {
    const { query, parser } = await prepareLanguage(spec);
    const tree = parser.parse(source);
    try {
        return extractFromTree(spec, query, tree, source, relPath);
    } finally {
        tree.delete();
    }
}

function extractFromTree(spec, query, tree, source, relPath) {
    const root = tree.rootNode;
    const matches = query.matches(root);

    const defs = [];          // { node, nameNode, kind, owner }
    const rawRefs = [];       // { node, nameNode, kind, recvNode }
    const importNodes = [];
    const requireCalls = [];
    const binds = [];         // { node, name, type|new|call }
    const fields = [];        // { node, name, type|new }
    const seenDef = new Map();
    const seenRef = new Map();
    const bindSites = new Map();
    const scopeNodes = [];    // anonymous functions / lambdas / comprehensions: lexical scopes
    const retNodes = [];      // returned expressions (return-type inference)

    for (const m of matches) {
        let role = null, kind = null, main = null, nameNode = null, recvNode = null, ownerNode = null, typeNode = null;
        let bindName = null, bindType = null, bindNew = null, bindCall = null, bindVar = null, bindExpr = null, bindElem = null, srcNode = null;
        for (const c of m.captures) {
            const n = c.name;
            if (n === 'name') nameNode = c.node;
            else if (n === 'recv') recvNode = c.node;
            else if (n === 'owner') ownerNode = c.node;
            else if (n === 'type') typeNode = c.node;
            else if (n === 'src') srcNode = c.node;
            else if (n.startsWith('def.')) { role = 'def'; kind = n.slice(4); main = c.node; }
            else if (n.startsWith('ref.')) { role = 'ref'; kind = n.slice(4); main = c.node; }
            else if (n === 'import') { role = 'import'; main = c.node; }
            else if (n === 'import.require') { role = 'require'; main = c.node; }
            else if (n === 'bind') { role = 'bind'; main = c.node; }
            else if (n === 'field') { role = 'field'; main = c.node; }
            else if (n === 'bind.name' || n === 'field.name') bindName = c.node.text;
            else if (n === 'bind.type' || n === 'field.type') bindType = c.node.text;
            else if (n === 'bind.new' || n === 'field.new') bindNew = c.node.text;
            else if (n === 'bind.call' || n === 'field.call') bindCall = c.node.text;
            else if (n === 'field.var') bindVar = c.node.text;
            else if (n === 'bind.expr' || n === 'field.expr') bindExpr = c.node;
            else if (n === 'bind.elem' || n === 'field.elem') bindElem = c.node;
            else if (n === 'scope') { role = 'scope'; main = c.node; }
            else if (n === 'ret') { role = 'ret'; main = c.node; }
        }
        if (role === 'scope') { scopeNodes.push(main); continue; }
        if (role === 'ret') { retNodes.push(main); continue; }
        if (role === 'def' && nameNode) {
            // several patterns may match one definition (with/without return type, owner); merge them
            const prev = seenDef.get(main.id);
            if (prev !== undefined) {
                const d = defs[prev];
                if (!d.type && typeNode) d.type = typeNode.text;
                if (!d.owner && ownerNode) d.owner = ownerNode.text;
                continue;
            }
            seenDef.set(main.id, defs.length);
            defs.push({ node: main, nameNode, kind, owner: ownerNode?.text ?? null, type: typeNode?.text ?? null });
        } else if (role === 'ref' && nameNode) {
            // one reference per name node; the most specific kind wins (a decorator's call is a
            // decorator ref, a `new X()` is an instantiation, not also a plain call).
            const prev = seenRef.get(nameNode.id);
            if (prev !== undefined) {
                if ((REF_PRIORITY[kind] ?? 0) > (REF_PRIORITY[rawRefs[prev].kind] ?? 0)) rawRefs[prev] = { node: main, nameNode, kind, recvNode: recvNode ?? rawRefs[prev].recvNode };
                continue;
            }
            seenRef.set(nameNode.id, rawRefs.length);
            rawRefs.push({ node: main, nameNode, kind, recvNode });
        } else if (role === 'import') importNodes.push(main);
        else if (role === 'require' && srcNode) requireCalls.push({ node: main, srcNode });
        else if ((role === 'bind' || role === 'field') && bindName) {
            // one record per binding site; an explicit type annotation beats an initialiser
            const list = role === 'bind' ? binds : fields;
            const key = role + ':' + main.id + ':' + bindName;
            const rec = { node: main, name: bindName, type: bindType, new: bindNew, call: bindCall, var: bindVar,
                expr: bindExpr ? receiverDescriptor(bindExpr, spec) : null, elem: bindElem ? receiverDescriptor(bindElem, spec) : null };
            const prev = bindSites.get(key);
            if (prev === undefined) { bindSites.set(key, list.length); list.push(rec); }
            else { const p = list[prev]; for (const k of ['type', 'new', 'call', 'var', 'expr', 'elem']) p[k] ??= rec[k]; }
        }
    }

    // ── definitions ────────────────────────────────────────────────────────────
    const filtered = [];
    for (const d of defs) {
        if ((d.kind === 'variable' || d.kind === 'constant') && spec.isModuleLevel && !spec.isModuleLevel(d.node)) continue;
        if (d.kind === 'field' && spec.keepField && !spec.keepField(d.node)) continue;
        if (spec.filterDef && !spec.filterDef(d)) continue;
        filtered.push(d);
    }
    filtered.sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex);

    const byNodeId = new Map();
    const hoisted = new Set();
    const defNameIds = new Set();
    const symbols = [];
    for (const d of filtered) {
        let name = d.nameNode.text;
        if (spec.normalizeName) name = spec.normalizeName(name, d, relPath);
        if (!name) continue;
        // enclosing definition (container) by walking ancestors
        let parentIdx = -1;
        for (let p = d.node.parent, hops = 0; p && hops < 64; p = p.parent, hops++) {
            const idx = byNodeId.get(p.id);
            if (idx !== undefined) { parentIdx = idx; break; }
        }
        const lexParent = parentIdx;
        // constructor parameter properties (`constructor(private repo: Repo)`) are class members
        if (d.kind === 'field' && parentIdx >= 0 && CONSTRUCTOR_NAMES.has(symbols[parentIdx].name) && symbols[parentIdx].parentIdx >= 0) parentIdx = symbols[parentIdx].parentIdx;
        // attributes assigned on self inside any method (Python) belong to the class, once each
        else if (d.kind === 'field' && spec.hoistMemberFields && parentIdx >= 0 && CALLABLE_KINDS.has(symbols[parentIdx].kind) && symbols[parentIdx].parentIdx >= 0
            && CLASS_KINDS.has(symbols[symbols[parentIdx].parentIdx].kind)) {
            const cls = symbols[parentIdx].parentIdx;
            if (hoisted.has(cls + ':' + name) || symbols.some(x => x.parentIdx === cls && x.name === name)) continue;
            hoisted.add(cls + ':' + name);
            parentIdx = cls;
        }
        let kind = d.kind;
        const parent = parentIdx >= 0 ? symbols[parentIdx] : null;
        if (kind === 'function' && parent && (parent.kind === 'class' || parent.kind === 'interface' || parent.kind === 'struct' || parent.kind === 'trait' || parent.kind === 'impl' || parent.kind === 'object')) kind = 'method';
        if (spec.refineKind) kind = spec.refineKind(kind, d, parent) ?? kind;
        let owner = d.owner;
        if (spec.ownerOf && !owner) owner = spec.ownerOf(d.node);
        let qname;
        if (owner && (!parent || parent.name !== owner)) qname = (parent ? parent.qname + '.' : '') + owner + '.' + name;
        else qname = parent ? parent.qname + '.' + name : name;
        const node = d.node;
        const sym = {
            name,
            qname,
            kind,
            parentIdx,
            lexParent,
            owner: owner || (parent && ['class', 'interface', 'struct', 'trait', 'impl', 'enum', 'object', 'module'].includes(parent.kind) ? parent.name : null),
            startLine: node.startPosition.row + 1,
            startCol: node.startPosition.column,
            endLine: node.endPosition.row + 1,
            endCol: node.endPosition.column,
            nameLine: d.nameNode.startPosition.row + 1,
            nameCol: d.nameNode.startPosition.column,
            sig: signatureOf(node, spec, source),
            doc: docOf(node, spec, source),
            exported: false,
            visibility: d.isDefault ? 'default' : (spec.visibility ? spec.visibility(node, name) : null),
            decorators: spec.decoratorsOf ? spec.decoratorsOf(node) : [],
            bases: [],
            type: d.type ? normalizeType(typeParamBound(node, d.type) ?? d.type, spec) : null,
            isStatic: isStaticMember(node, d.nameNode, spec),
            startIndex: node.startIndex,
            endIndex: node.endIndex,
        };
        // a class's type records what collection it behaves as (`extends Map<string, Module>`)
        if (MEMBER_PARENT.has(kind) && sym.type && !/(\[\]|\{\})$/.test(sym.type)) sym.type = null;
        // `-> Self` / `: this` (fluent APIs) return the enclosing type
        if (sym.type === 'Self' || sym.type === 'this' || sym.type === 'static') sym.type = parent && MEMBER_PARENT.has(parent.kind) ? (parent.kind === 'impl' ? parent.owner ?? parent.name : parent.name) : owner || null;
        // members are part of the public surface when their container is and they are not private
        if (parent && MEMBER_PARENT.has(parent.kind)) sym.exported = parent.exported && sym.visibility !== 'private';
        else sym.exported = spec.isExported ? Boolean(spec.isExported(node, name)) : true;
        byNodeId.set(node.id, symbols.length);
        defNameIds.add(d.nameNode.id);
        symbols.push(sym);
    }

    // innermost enclosing symbol for a byte offset (symbols sorted by start; nested ranges)
    const enclosingIdx = (offset) => {
        let best = -1;
        // binary search last symbol with startIndex <= offset, then walk up parents
        let lo = 0, hi = symbols.length - 1, cand = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (symbols[mid].startIndex <= offset) { cand = mid; lo = mid + 1; } else hi = mid - 1;
        }
        for (let i = cand; i >= 0; i = symbols[i].lexParent) {
            if (symbols[i].endIndex >= offset) { best = i; break; }
            // not containing: try previous siblings/ancestors
            if (symbols[i].lexParent < 0) {
                // scan backwards for a container that encloses offset
                for (let j = i - 1; j >= 0; j--) if (symbols[j].startIndex <= offset && symbols[j].endIndex >= offset) { best = j; break; }
                break;
            }
        }
        return best;
    };

    // ── lexical scopes: callables and types, plus anonymous functions (closures, lambdas) ──
    const scopes = [];        // { start, end, sym (owning symbol or -1), parent }
    for (let i = 0; i < symbols.length; i++) if (!VALUE_KINDS.has(symbols[i].kind)) scopes.push({ start: symbols[i].startIndex, end: symbols[i].endIndex, sym: i });
    for (const n of scopeNodes) {
        // `const f = () => …` / `m: function () {}`: the closure is the body of that symbol
        const own = n.parent ? byNodeId.get(n.parent.id) : undefined;
        scopes.push({ start: n.startIndex, end: n.endIndex, sym: own ?? -1 });
    }
    scopes.sort((a, b) => a.start - b.start || b.end - a.end);
    {
        const stack = [];
        for (let k = 0; k < scopes.length; k++) {
            while (stack.length && scopes[stack[stack.length - 1]].end <= scopes[k].start) stack.pop();
            scopes[k].parent = stack.length ? stack[stack.length - 1] : -1;
            stack.push(k);
        }
    }
    const scopeAt = (offset) => {
        let lo = 0, hi = scopes.length - 1, cand = -1;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (scopes[mid].start <= offset) { cand = mid; lo = mid + 1; } else hi = mid - 1; }
        for (let k = cand; k >= 0; k = scopes[k].parent) if (scopes[k].end > offset) return k;
        return -1;
    };
    /** Where an expression is evaluated: enclosing symbol (for `this`/fields) + lexical scope (for locals). */
    const ctxAt = (offset) => ({ sym: enclosingIdx(offset), scope: scopeAt(offset) });

    // ── type evidence (local bindings, class fields, returns) ────────────────
    //
    // Types are strings the resolver understands:
    //   'T' / 'T[]'   (a collection of) a named type
    //   'T{}'         a map (dictionary) whose values are T
    //   'call:f'      the return type of callable f (resolved globally)
    //   '…#a#b'       member a, then member b, of the preceding type (crosses files)
    //   '[]' after a call/member part: the element type of that part
    //   '!'           a value whose members never live in the repository (primitives, arrays)
    const deferred = (t) => t.startsWith('call:') || t.includes('#');
    const typeText = (t) => {
        const n = normalizeType(t, spec);
        if (!n) return null;
        return !/(\[\]|\{\})$/.test(n) && spec.isPrimitiveType?.(n) ? '!' : n;
    };
    // narrowed types by source range: { key (receiver descriptor), type, from, to }
    const narrowed = [];
    if (/\binstanceof\b|\bisinstance\s*\(/.test(source)) {
        for (const r of typeNarrowings(root, source)) {
            const key = receiverDescriptor(r.subject, spec), type = typeText(r.type.text);
            if (type && type !== '!' && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(key)) narrowed.push({ key, type, from: r.from, to: r.to });
        }
    }
    /** The narrowest type test that holds at `pos` for `key` (`x`, `this.x`). */
    const narrowedAt = (pos, key) => {
        let best = null;
        for (const r of narrowed) if (r.key === key && r.from <= pos && pos < r.to && (!best || r.to - r.from < best.to - best.from)) best = r;
        return best?.type ?? null;
    };
    const localTypes = new Map();   // `${scope}:${name}` -> binding record | { conflict }
    const sameBinding = (a, b) => a.type === b.type && a.call === b.call && a.expr === b.expr && a.elem === b.elem;
    const setLocal = (scope, name, val) => {
        const k = scope + ':' + name;
        const prev = localTypes.get(k);
        if (!prev) localTypes.set(k, val);
        else if (!prev.conflict && !sameBinding(prev, val)) localTypes.set(k, { conflict: true });
    };
    for (const b of binds) {
        const ctx = { ...ctxAt(b.node.startIndex), pos: b.node.startIndex };
        const typed = b.expr && /^(new|as) /.test(b.expr) ? b.expr.slice(3).trim() : null; // `new X(…)` / `… as X`
        const type = b.type ? typeText(b.type) : (b.new ? typeText(b.new) : typed ? typeText(typed) : b.expr === '!' ? '!' : null);
        if (type) setLocal(ctx.scope, b.name, { type, ctx });
        else if (b.call) setLocal(ctx.scope, b.name, { call: b.call, ctx });
        else if (b.expr && b.expr !== '?' && b.expr !== 'null' && b.expr !== b.name) setLocal(ctx.scope, b.name, { expr: b.expr, ctx });
        else if (b.elem && b.elem !== '?') setLocal(ctx.scope, b.name, { elem: b.elem, ctx });
        else if (b.type || (b.expr && b.expr !== 'null')) setLocal(ctx.scope, b.name, { opaque: true, ctx }); // shadows outer bindings
    }
    const lookupLocal = (ctx, name) => {
        for (let k = ctx.scope; ; k = scopes[k].parent) {
            const v = localTypes.get(k + ':' + name);
            if (v) return v.conflict || v.opaque ? null : v;
            if (k < 0) break;
        }
        return null;
    };
    /** A local binding of `name` (typed or not) is visible at ctx: it shadows globals and builtins. */
    const isDeclared = (ctx, name) => {
        for (let k = ctx.scope; ; k = scopes[k].parent) {
            if (localTypes.has(k + ':' + name)) return true;
            if (k < 0) break;
        }
        return false;
    };
    const fieldTypes = new Map();   // `${classIdx}:${field}` -> type string (see above)

    /** Apply `()` / `[]` operators to a type string; null when the result is unknown. */
    const applyOps = (t, ops) => {
        for (const op of ops) {
            if (!t) return null;
            if (op === '()') { if (!deferred(t)) return null; continue; } // a method's type is its return type
            if (deferred(t)) t += '[]';
            else if (t.endsWith('[]') || t.endsWith('{}')) t = t.slice(0, -2); // element / map value
            else return null; // indexing a string or an untyped object
        }
        return t;
    };
    // iterating a map yields keys or entries except where the language hands out values (Go's `range`)
    const elemOf = (t) => (!t ? null : deferred(t) ? t + '[]' : t.endsWith('[]') ? t.slice(0, -2) : t.endsWith('{}') && spec.mapIterValues ? t.slice(0, -2) : null);
    const bindingType = (v, depth) => {
        if (v.type) return v.type;
        if (v.call) return 'call:' + v.call;
        if (v.expr) return inferType(v.expr, v.ctx, depth + 1);
        if (v.elem) return elemOf(inferType(v.elem, v.ctx, depth + 1));
        return null;
    };
    const SEG_RE = /^([A-Za-z_$@][\w$]*)((?:\(\)|\[\])*)$/;
    // the type `this`/`self` denotes inside a symbol: its class, or the receiver type of an
    // out-of-body method (Rust impl blocks, Go receivers) — { idx: class symbol or -1, name }
    const classByName = new Map();
    const selfType = (encl) => {
        const cls = classOf(encl, symbols);
        if (cls >= 0) return { idx: cls, name: symbols[cls].qname };
        for (let i = encl; i >= 0; i = symbols[i].parentIdx) {
            const o = symbols[i].owner;
            if (!o) continue;
            if (!classByName.has(o)) classByName.set(o, symbols.findIndex(x => x.name === o && CLASS_KINDS.has(x.kind)));
            const j = classByName.get(o);
            return { idx: j, name: j >= 0 ? symbols[j].qname : o };
        }
        return null;
    };

    /** Static type of an expression descriptor evaluated in `ctx`, as far as this file tells. */
    const inferType = (desc, ctx, depth = 0) => {
        if (!desc || depth > 5 || desc === '?' || desc === 'super' || desc === 'null') return null;
        if (desc === '!') return '!';
        if (desc.startsWith('new ') || desc.startsWith('as ')) {
            const tn = desc.slice(3).trim();
            if (tn === 'Self' || tn === 'self' || tn === 'static' || tn === 'this') return selfType(ctx.sym)?.name ?? null;
            return typeText(tn);
        }
        const segs = [];
        for (const p of desc.split('.')) {
            const m = SEG_RE.exec(p);
            if (!m) return null;
            segs.push({ name: m[1], ops: m[2].match(/\(\)|\[\]/g) ?? [] });
        }
        let t = null, i = 1;
        const first = segs[0];
        if (first.name === 'this') {
            const st = selfType(ctx.sym);
            if (!st) return null;
            if (segs.length === 1) return first.ops.length ? null : st.name;
            const nt = ctx.pos != null && narrowed.length ? narrowedAt(ctx.pos, 'this.' + segs[1].name) : null;
            const ft = nt ?? (st.idx >= 0 ? fieldTypes.get(st.idx + ':' + segs[1].name) : null);
            t = applyOps(ft ?? st.name + '#' + segs[1].name, segs[1].ops);
            i = 2;
        } else {
            const isCall = first.ops[0] === '()';
            const nt = !isCall && ctx.pos != null && narrowed.length ? narrowedAt(ctx.pos, first.name) : null;
            const v = isCall ? null : nt ? { type: nt } : lookupLocal(ctx, first.name);
            if (v) t = applyOps(bindingType(v, depth), first.ops);
            else if (isCall) t = applyOps('call:' + first.name, first.ops.slice(1));
            else if (spec.implicitThis && classOf(ctx.sym, symbols) >= 0) t = applyOps(fieldTypes.get(classOf(ctx.sym, symbols) + ':' + first.name) ?? null, first.ops);
            // `Type.staticField…`: a capitalised root that is not a local names a type
            if (!t && !v && segs.length > 1 && !first.ops.length && /^[A-Z]/.test(first.name)) t = first.name;
            // `pkg.New()` / `utils.makeFoo()`: a call through a module or import alias returns the callee's type
            else if (!t && !v && segs.length > 1 && !first.ops.length && segs[1].ops[0] === '()') {
                t = applyOps('call:' + first.name + '.' + segs[1].name, segs[1].ops.slice(1));
                i = 2;
            }
        }
        for (; i < segs.length && t; i++) {
            const seg = segs[i];
            const call = seg.ops[0] === '()';
            if (call && spec.identityMethods?.has(seg.name)) { t = applyOps(t, seg.ops.slice(1)); continue; }
            if (t === '!') return '!';
            if (!deferred(t) && t.endsWith('[]')) {
                // `list.get(0)`, `xs.first()`: collection accessors hand back an element
                if (call && spec.elementMethods?.has(seg.name)) { t = applyOps(t.slice(0, -2), seg.ops.slice(1)); continue; }
                return '!'; // any other member of a collection is the language's
            }
            if (!deferred(t) && t.endsWith('{}')) {
                // `m.get(k)` hands back a value, `m.values()` a collection of values
                if (call && spec.mapMethods?.has(seg.name)) { t = applyOps(t.slice(0, -2), seg.ops.slice(1)); continue; }
                if (call && spec.mapValueMethods?.has(seg.name)) { t = applyOps(t.slice(0, -2) + '[]', seg.ops.slice(1)); continue; }
                return '!';
            }
            t = applyOps(t + '#' + seg.name, seg.ops);
        }
        return t;
    };

    for (const f of fields) {
        const ctx = ctxAt(f.node.startIndex);
        const cls = classOf(ctx.sym, symbols);
        if (cls < 0) continue;
        let type = f.type ? typeText(f.type) : (f.new ? typeText(f.new) : null);
        if (!type && f.var) { const v = lookupLocal(ctx, f.var); type = v ? bindingType(v, 0) : null; }
        if (!type && f.call) type = 'call:' + f.call;
        if (!type && f.expr) type = inferType(f.expr, ctx);
        if (!type) continue;
        if (!fieldTypes.has(cls + ':' + f.name)) fieldTypes.set(cls + ':' + f.name, type);
    }
    // declared field/property symbols carry their type too (struct fields, typed class attributes)
    for (let i = 0; i < symbols.length; i++) {
        const s = symbols[i];
        if ((s.kind === 'field' || s.kind === 'property') && s.parentIdx >= 0) {
            const k = s.parentIdx + ':' + s.name;
            if (s.type) { if (!fieldTypes.has(k) && typeText(s.type) !== '!') fieldTypes.set(k, s.type); }
            else if (fieldTypes.has(k)) s.type = fieldTypes.get(k);
        }
    }
    // record inferred (assignment-based) field types as field symbols' type when the field itself
    // is not declared in the class body (common in Python/JS: self.x = X() in __init__)
    const inferredFields = [];
    for (const [k, type] of fieldTypes) {
        const [clsIdx, fname] = [Number(k.slice(0, k.indexOf(':'))), k.slice(k.indexOf(':') + 1)];
        inferredFields.push({ owner: symbols[clsIdx].qname, name: fname, type });
    }
    // module-level values typed by their initialiser (`export const api = new ApiClient()`), so
    // importers can reach the members of such singletons
    for (let i = 0; i < symbols.length; i++) {
        const s = symbols[i];
        if (s.type || (s.kind !== 'variable' && s.kind !== 'constant')) continue;
        const v = localTypes.get(scopeAt(s.startIndex) + ':' + s.name);
        if (v && !v.conflict && !v.opaque) s.type = bindingType(v, 0);
    }
    // undeclared return types: all `return` expressions of a callable agree on one type
    const returns = new Map(); // symIdx -> [types]
    for (const n of retNodes) {
        const k = scopeAt(n.startIndex);
        const owner = k >= 0 ? scopes[k].sym : -1;
        if (owner < 0 || symbols[owner].type || !CALLABLE_KINDS.has(symbols[owner].kind)) continue;
        const desc = receiverDescriptor(n, spec);
        if (desc === 'null') continue; // `return null` / `return None` keeps the other paths' type
        const list = returns.get(owner) ?? returns.set(owner, []).get(owner);
        list.push(inferType(desc, { sym: owner, scope: k }));
    }
    for (const [owner, types] of returns) {
        const uniq = new Set(types);
        if (uniq.size === 1 && !uniq.has(null)) symbols[owner].type = types[0];
    }

    const inferReceiverType = (recv, ctx) => {
        if (!recv || recv === 'this') return null;
        const t = inferType(recv, ctx);
        return t && !deferred(t) && /(\[\]|\{\})$/.test(t) ? '!' : t; // a collection's own methods are the language's
    };

    // ── references ─────────────────────────────────────────────────────────────
    const refs = [];
    for (const r of rawRefs) {
        if (defNameIds.has(r.nameNode.id)) continue; // a definition's own name
        let name = r.nameNode.text;
        if (spec.normalizeRefName) name = spec.normalizeRefName(name, r);
        if (!name || name.length > 128) continue;
        const kind = r.kind;
        const recv = r.recvNode ? receiverDescriptor(r.recvNode, spec) : '';
        const ctx = ctxAt(r.nameNode.startIndex);
        if (kind === 'call' && !recv && spec.builtinCalls?.has(name) && !isDeclared(ctx, name)) continue;
        const root = recv.split('.')[0];
        // `module.x()` is the CommonJS global only when no local `module` is in scope
        if (recv && spec.externalReceivers?.has(root) && !isDeclared(ctx, root)) continue;
        if (kind === 'value' && spec.isNoiseValue?.(name)) continue;
        const pos = r.nameNode.startPosition;
        const encl = ctx.sym;
        const recvType = inferReceiverType(recv, { ...ctx, pos: r.nameNode.startIndex });
        refs.push({ name, kind, line: pos.row + 1, col: pos.column, recv, recvType, symIdx: encl });
    }

    // inheritance: attach base names to the enclosing class symbol
    for (const r of refs) {
        if (r.kind !== 'inherit' || r.symIdx < 0) continue;
        const s = symbols[r.symIdx];
        if (['class', 'interface', 'struct', 'trait', 'enum', 'object', 'impl'].includes(s.kind) && !s.bases.includes(r.name)) s.bases.push(r.name);
    }

    // ── imports ────────────────────────────────────────────────────────────────
    const imports = [];
    for (const n of importNodes) {
        for (const rec of spec.parseImport(n, source)) imports.push({ ...rec, line: n.startPosition.row + 1 });
    }
    for (const { node, srcNode } of requireCalls) {
        for (const rec of spec.parseRequire(node, srcNode)) imports.push({ ...rec, line: node.startPosition.row + 1 });
    }
    const extra = spec.fileInfo ? spec.fileInfo(root, source) : null;

    for (const s of symbols) { delete s.startIndex; delete s.endIndex; delete s.lexParent; }
    return { symbols, refs, imports, fields: inferredFields, fileInfo: extra, errors: root.hasError ? 1 : 0 };
}

const NULLISH_TYPES = new Set(['null', 'undefined', 'None', 'void', 'nil', 'never', 'NoneType', 'Nothing', 'Unit']);
// declared-by-inference keywords in type position: the initialiser decides
const INFERRED_TYPES = new Set(['var', 'auto', 'let', 'val', 'dynamic', '_', 'implicit_type']);

/** Split at top-level occurrences of `sep` (outside <> [] () {}; `=>` is not a bracket). */
function splitTop(s, sep) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '<' || c === '[' || c === '(' || c === '{') depth++;
        else if ((c === '>' && s[i - 1] !== '=' && s[i - 1] !== '-') || c === ']' || c === ')' || c === '}') depth--;
        else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
    }
    out.push(s.slice(start));
    return out;
}

const arrayOf = (e) => (e && !/(\[\]|\{\})$/.test(e) ? e + '[]' : null);
const mapOf = (v) => (v && !/(\[\]|\{\})$/.test(v) ? v + '{}' : null);

/**
 * Static type text → what member lookup needs: `Foo`, `Foo[]` (a collection of Foo, so `x[i]`
 * and loop variables are Foo), `Foo{}` (a map whose values are Foo: `m[k]`, `m.get(k)`) or null. Optional/nullable unions collapse (`Foo | undefined`,
 * `Optional[Foo]`, `Foo?`), transparent wrappers unwrap per language (`Promise<Foo>`,
 * `Box<Foo>`, `Task<Foo>`), pointers/references/qualifiers and namespaces are dropped.
 */
export function normalizeType(t, spec, depth = 0) {
    if (t == null || depth > 5) return null;
    let s = String(t).trim();
    if (spec?.cleanType) { s = spec.cleanType(s); if (!s) return null; }
    s = s.replace(/^["']|["']$/g, '')
        .replace(/^(?:(?:readonly|const|mut|dyn|impl|typeof|unique|volatile|struct|enum|class|final|ref|in|out|inout)\s+|[&*^]\s*|'[A-Za-z_]\w*\s+)+/, '')
        .replace(/(?:\s*(?:[?!*&]|\.\.\.))+$/, '')
        .trim();
    if (!s || /^keyof\s/.test(s) || INFERRED_TYPES.has(s)) return null;
    const alts = splitTop(s, '|').map(x => x.trim()).filter(Boolean);
    if (alts.length > 1) {
        const norm = [...new Set(alts.filter(a => !NULLISH_TYPES.has(a)).map(a => normalizeType(a, spec, depth + 1)))];
        return norm.length === 1 ? norm[0] : null;
    }
    if (splitTop(s, '&').length > 1 || splitTop(s, ',').length > 1) return null; // intersections / tuples
    let m;
    if ((m = /^\((.*)\)$/s.exec(s))) return normalizeType(m[1], spec, depth + 1);
    if ((m = /^(.+?)\s*\[\s*\]$/s.exec(s))) return arrayOf(normalizeType(m[1], spec, depth + 1));      // T[]
    if ((m = /^\[\s*\]\s*(.+)$/s.exec(s))) return arrayOf(normalizeType(m[1], spec, depth + 1));        // Go []T
    if ((m = /^map\s*\[[^\]]*\]\s*(.+)$/s.exec(s))) return mapOf(normalizeType(m[1], spec, depth + 1));  // Go map[K]V
    if ((m = /^\[([^;\]]+?)\s*(?:;[^\]]*)?\]$/s.exec(s))) return arrayOf(normalizeType(m[1], spec, depth + 1)); // Rust [T] / [T; N]
    if ((m = /^([A-Za-z_$][\w$]*(?:(?:\.|::|\\)[A-Za-z_$][\w$]*)*)\s*[<[](.*)[>\]]$/s.exec(s))) {
        const head = m[1].split(/\.|::|\\/).pop();
        const args = splitTop(m[2], ',').map(x => x.trim());
        if (spec?.transparentTypes?.has(head)) return normalizeType(args[0], spec, depth + 1);
        if (spec?.elementTypes?.has(head)) return arrayOf(normalizeType(args[0], spec, depth + 1));
        if (spec?.mapTypes?.has(head)) return mapOf(normalizeType(args[args.length - 1], spec, depth + 1));
        if (head === 'Union') return normalizeType(args.join('|'), spec, depth + 1);
        s = m[1];
    }
    s = s.replace(/<.*$/s, '').replace(/\(.*$/s, '').replace(/\[.*$/s, '').trim();
    const segs = s.split(/::|\.|\\/).filter(Boolean);
    s = segs.length ? segs[segs.length - 1] : s;
    return /^[A-Za-z_$][\w$]*$/.test(s) ? s : null;
}

/** @deprecated nominal head only (kept for callers that need a plain name). */
export function cleanTypeName(t, spec) {
    const n = normalizeType(t, spec);
    return n && n.endsWith('[]') ? n.slice(0, -2) : n;
}

const CLASS_KINDS = new Set(['class', 'struct', 'impl', 'object', 'trait', 'interface', 'enum']);
const VALUE_KINDS = new Set(['variable', 'constant', 'field', 'property']);
const CALLABLE_KINDS = new Set(['function', 'method']);
const CONSTRUCTOR_NAMES = new Set(['constructor', '__construct']);

/** `get<T extends Foo = Foo>(): T` → the declared return type `T` means `Foo` (bound or default). */
function typeParamBound(defNode, typeText) {
    const name = String(typeText).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
    const tps = defNode.childForFieldName?.('type_parameters') ?? defNode.namedChildren?.find(c => c.type === 'type_parameters');
    if (!tps) return undefined;
    for (const p of tps.namedChildren) {
        const m = /^(?:(?:in|out|const|reified)\s+)*([A-Za-z_$][\w$]*)\s*(?:(?:extends|:)\s*([^=]+?))?\s*(?:=\s*(.+))?$/s.exec(p.text);
        if (m && m[1] === name) return (m[3] ?? m[2] ?? '').trim() || null;
    }
    return undefined;
}

/** Static members (`static`, `@staticmethod`/`@classmethod`) never share a family with instance members. */
function isStaticMember(node, nameNode, spec) {
    if (spec.isStatic) return spec.isStatic(node);
    const head = node.text.slice(0, Math.max(0, nameNode.startIndex - node.startIndex));
    return /(^|\s)static\s/.test(head);
}

function classOf(idx, symbols) {
    for (let i = idx; i >= 0; i = symbols[i].parentIdx) {
        const k = symbols[i].kind;
        if (k === 'class' || k === 'struct' || k === 'impl' || k === 'object' || k === 'trait' || k === 'interface' || k === 'enum') return i;
    }
    return -1;
}
