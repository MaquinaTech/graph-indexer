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
const REF_PRIORITY = { decorator: 6, inherit: 5, new: 4, call: 3, import: 2, type: 1, value: 0 };
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
    const body = spec.bodyField ? defNode.childForFieldName(spec.bodyField) : null;
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

/** Compact receiver descriptor: this | super | this.x | x | a.b | f() | new X | ? */
function receiverDescriptor(node, spec) {
    if (!node) return '';
    const t = node.type;
    const text = node.text;
    if (spec.selfNames.includes(text) || t === 'this' || t === 'self') return 'this';
    if (t === 'super' || text === 'super') return 'super';
    if (spec.receiverDescriptor) {
        const d = spec.receiverDescriptor(node);
        if (d !== undefined) return d;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(text)) return text;
    // member chain: a.b.c / this.x / self.x / $this->x / a::b
    const norm = text.replace(/\s+/g, '').replace(/->|::|\?\./g, '.');
    if (/^[A-Za-z_$@][\w$]*(\.[A-Za-z_$][\w$]*){1,4}$/.test(norm)) {
        const parts = norm.split('.');
        if (spec.selfNames.includes(parts[0]) || parts[0] === 'this' || parts[0] === '$this') parts[0] = 'this';
        return parts.join('.');
    }
    if (/^(new\s+)[A-Za-z_$][\w$.]*\s*(\(.*\))?$/s.test(text)) return 'new ' + text.replace(/^new\s+/, '').replace(/\(.*$/s, '').trim();
    const call = /^([A-Za-z_$][\w$]*)\s*(<[^>]*>)?\s*\(.*\)$/s.exec(text);
    if (call) return call[1] + '()';
    return '?';
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

    for (const m of matches) {
        let role = null, kind = null, main = null, nameNode = null, recvNode = null, ownerNode = null, typeNode = null;
        let bindName = null, bindType = null, bindNew = null, bindCall = null, bindVar = null, srcNode = null;
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
        }
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
        else if (role === 'bind' && bindName) binds.push({ node: main, name: bindName, type: bindType, new: bindNew, call: bindCall });
        else if (role === 'field' && bindName) fields.push({ node: main, name: bindName, type: bindType, new: bindNew, call: bindCall, var: bindVar });
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
            type: d.type ? cleanTypeName(d.type, spec) : null,
            startIndex: node.startIndex,
            endIndex: node.endIndex,
        };
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
        for (let i = cand; i >= 0; i = symbols[i].parentIdx) {
            if (symbols[i].endIndex >= offset) { best = i; break; }
            // not containing: try previous siblings/ancestors
            if (symbols[i].parentIdx < 0) {
                // scan backwards for a container that encloses offset
                for (let j = i - 1; j >= 0; j--) if (symbols[j].startIndex <= offset && symbols[j].endIndex >= offset) { best = j; break; }
                break;
            }
        }
        return best;
    };

    // ── type evidence (local bindings, class fields) ──────────────────────────
    const localTypes = new Map();   // `${scopeIdx}:${name}` -> { type?, call? }
    const setLocal = (scope, name, val) => {
        const k = scope + ':' + name;
        const prev = localTypes.get(k);
        if (!prev) localTypes.set(k, val);
        else if (prev.type !== val.type || prev.call !== val.call) localTypes.set(k, { conflict: true });
    };
    for (const b of binds) {
        const scope = enclosingIdx(b.node.startIndex);
        const type = b.type ? cleanTypeName(b.type, spec) : (b.new ? cleanTypeName(b.new, spec) : null);
        if (type && spec.isPrimitiveType?.(type)) continue;
        if (type) setLocal(scope, b.name, { type });
        else if (b.call) setLocal(scope, b.name, { call: b.call });
    }
    const lookupLocal = (scopeIdx, name) => {
        for (let i = scopeIdx; ; i = symbols[i].parentIdx) {
            const v = localTypes.get(i + ':' + name);
            if (v && !v.conflict) return v;
            if (i < 0) break;
        }
        return null;
    };
    const fieldTypes = new Map();   // `${classIdx}:${field}` -> type | 'call:f'
    for (const f of fields) {
        const scope = enclosingIdx(f.node.startIndex);
        const cls = classOf(scope, symbols);
        if (cls < 0) continue;
        let type = f.type ? cleanTypeName(f.type, spec) : (f.new ? cleanTypeName(f.new, spec) : null);
        if (!type && f.var) { const v = lookupLocal(scope, f.var); type = v?.type ?? (v?.call ? 'call:' + v.call : null); }
        if (!type && f.call) type = 'call:' + f.call;
        if (!type || spec.isPrimitiveType?.(type)) continue;
        if (!fieldTypes.has(cls + ':' + f.name)) fieldTypes.set(cls + ':' + f.name, type);
    }
    // declared field/property symbols carry their type too (struct fields, typed class attributes)
    for (let i = 0; i < symbols.length; i++) {
        const s = symbols[i];
        if ((s.kind === 'field' || s.kind === 'property') && s.parentIdx >= 0) {
            const k = s.parentIdx + ':' + s.name;
            if (s.type && !spec.isPrimitiveType?.(s.type)) { if (!fieldTypes.has(k)) fieldTypes.set(k, s.type); }
            else if (!s.type && fieldTypes.has(k)) s.type = fieldTypes.get(k);
        }
    }
    // record inferred (assignment-based) field types as field symbols' type when the field itself
    // is not declared in the class body (common in Python/JS: self.x = X() in __init__)
    const inferredFields = [];
    for (const [k, type] of fieldTypes) {
        const [clsIdx, fname] = [Number(k.slice(0, k.indexOf(':'))), k.slice(k.indexOf(':') + 1)];
        inferredFields.push({ owner: symbols[clsIdx].qname, name: fname, type });
    }

    /**
     * Static type of a receiver, when inferable from this file alone. Encodings:
     *   'T'          concrete type name
     *   'call:f'     return type of callable f (resolved globally)
     *   'T#a#b'      type of member b of member a of T (resolved globally, crosses files)
     */
    const inferReceiverType = (recv, encl) => {
        if (!recv || recv === 'this' || recv === 'super' || recv === '?') return null;
        if (recv.startsWith('new ')) return cleanTypeName(recv.slice(4), spec);
        if (recv.endsWith('()')) return 'call:' + recv.slice(0, -2);
        const parts = recv.split('.');
        let base;
        if (parts[0] === 'this') {
            const cls = classOf(encl, symbols);
            if (cls < 0 || parts.length === 1) return null;
            const ft = fieldTypes.get(cls + ':' + parts[1]);
            base = ft ?? (symbols[cls].qname + '#' + parts[1]);
            if (!ft && spec.implicitFieldLookupOnly) return null;
            return parts.length > 2 ? base + '#' + parts.slice(2).join('#') : base;
        }
        const v = lookupLocal(encl, parts[0]);
        if (v) base = v.type ?? (v.call ? 'call:' + v.call : null);
        else if (spec.implicitThis) {
            // a bare identifier that is not a local may be a field of the enclosing class
            // (Java/Kotlin/C#/Scala/C++ access fields without `this.`)
            const cls = classOf(encl, symbols);
            if (cls >= 0) base = fieldTypes.get(cls + ':' + parts[0]) ?? null;
        }
        if (!base) return null;
        return parts.length > 1 ? base + '#' + parts.slice(1).join('#') : base;
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
        if (kind === 'call' && !recv && spec.builtinCalls?.has(name)) continue;
        const root = recv.split('.')[0];
        if (recv && spec.externalReceivers?.has(root)) continue;
        if (kind === 'value' && spec.isNoiseValue?.(name)) continue;
        const pos = r.nameNode.startPosition;
        const encl = enclosingIdx(r.nameNode.startIndex);
        const recvType = inferReceiverType(recv, encl);
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

    for (const s of symbols) { delete s.startIndex; delete s.endIndex; }
    return { symbols, refs, imports, fields: inferredFields, fileInfo: extra, errors: root.hasError ? 1 : 0 };
}

/** `*Foo`, `&mut Foo`, `Foo<T>`, `pkg.Foo`, `Foo[]`, `?Foo` → `Foo` (the nominal head a member lookup needs). */
export function cleanTypeName(t, spec) {
    if (!t) return null;
    let s = String(t).trim();
    if (spec?.cleanType) { s = spec.cleanType(s); if (!s) return null; }
    s = s.replace(/^[&*?\s]+|mut\s+|const\s+|readonly\s+/g, '').replace(/[?!\[\]\s]+$/g, '');
    s = s.replace(/<.*$/s, '').replace(/\[.*$/s, '').replace(/\(.*$/s, '');
    const segs = s.split(/::|\.|\\/).filter(Boolean);
    s = segs.length ? segs[segs.length - 1] : s;
    return /^[A-Za-z_$][\w$]*$/.test(s) ? s : null;
}

function classOf(idx, symbols) {
    for (let i = idx; i >= 0; i = symbols[i].parentIdx) {
        const k = symbols[i].kind;
        if (k === 'class' || k === 'struct' || k === 'impl' || k === 'object' || k === 'trait' || k === 'interface' || k === 'enum') return i;
    }
    return -1;
}
