/**
 * @file parse/metadata.mjs
 * @description Chunk metadata extractors: params, return type, class context,
 *              decorators, heritage (extends/implements), type annotations,
 *              call sites, and the legacy call list.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */

// ─── Enrichment helpers (param names, return type, class context) ─────────────

export function extractParams(chunkNode, ext) {
    const params = [];
    const JS_LIKE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
    const paramTypes = JS_LIKE.includes(ext)
        ? ['required_parameter', 'optional_parameter', 'formal_parameters', 'identifier']
        : ['parameter', 'formal_parameter', 'identifier'];

    function walkParams(node) {
        if (node.type === 'formal_parameters' || node.type === 'parameters' || node.type === 'parameter_list') {
            for (const child of node.children) {
                        if (child.type === 'required_parameter' || child.type === 'optional_parameter' || child.type === 'formal_parameter') {
                    const id = child.childForFieldName?.('pattern') || child.childForFieldName?.('name') ||
                        child.children.find(c => c.type === 'identifier');
                    if (id) params.push(id.text);
                    const typeAnnotation = child.childForFieldName?.('type');
                    if (typeAnnotation) {
                        const typeText = typeAnnotation.text.replace(/^:\s*/, '').trim();
                        if (typeText) params.push(typeText);
                    }
                } else if (child.type === 'identifier') {
                    params.push(child.text);
                }
            }
        }
        for (const child of node.children) walkParams(child);
    }

    // Avoid deep recursion into the function body by walking only the params node.
    const paramsNode = chunkNode.childForFieldName?.('parameters') || chunkNode.childForFieldName?.('formal_parameters');
    if (paramsNode) walkParams(paramsNode);
    return [...new Set(params)].filter(p => p && p.length > 1).slice(0, 15);
}

export function extractReturnType(chunkNode, ext) {
    const JS_LIKE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
    if (JS_LIKE.includes(ext)) {
        const retTypeNode = chunkNode.childForFieldName?.('return_type');
        if (retTypeNode) return retTypeNode.text.replace(/^:\s*/, '').trim().slice(0, 80);
    }
    return '';
}

export function extractClassContext(chunkNode) {
    let parent = chunkNode.parent;
    while (parent) {
        if (parent.type === 'class_declaration' || parent.type === 'class_definition' ||
            parent.type === 'class_body' || parent.type === 'impl_item') {
            const nameNode = parent.childForFieldName?.('name');
            if (nameNode) return nameNode.text;
        }
        parent = parent.parent;
    }
    return '';
}

/**
 * Extract decorator / annotation names applied to a chunk (and, for class chunks,
 * to the methods inside it). Decorators encode what a symbol *is* in modern
 * frameworks — `@Controller`, `@Injectable`, `@Get`, `@Entity` (TS: NestJS,
 * Angular, TypeORM) and `@app.route`, `@pytest.fixture`, `@dataclass`,
 * `@property` (Python) — yet as raw snippet text they are diluted to a single
 * low-weight token inside a large class body. Surfacing them as a dedicated field
 * lets a class annotated `@Controller` be retrieved by "controller" and a method
 * annotated `@Get` by "get/route", independent of language.
 *
 * Generalises by node type only (the tree-sitter `decorator` node is shared across
 * TS/JS/Python grammars) — no framework-specific names are hardcoded. Callee
 * arguments are stripped: `@Controller('cats')` -> 'Controller',
 * `@app.route('/x')` -> 'app.route', `@UseGuards(AuthGuard)` -> 'UseGuards'.
 *
 * @returns {string[]} unique decorator callee names (max 24)
 */
export function extractDecorators(chunkNode) {
    const names = new Set();
    const addDecorator = (decoNode) => {
        let t = (decoNode.text || '').trim().replace(/^@/, '');
        t = t.split('(')[0];              // drop call arguments: @Get(':id') -> Get
        t = t.split(/[\s\n{]/)[0].trim(); // first token only
        if (t && t.length <= 64) names.add(t);
    };

    // (1) Decorators that PRECEDE the chunk as siblings. Python wraps a decorated
    //     symbol in `decorated_definition` ([decorator…, def]); some grammars place
    //     class decorators as leading siblings rather than children.
    let prev = chunkNode.previousSibling;
    while (prev) {
        if (prev.type === 'decorator') addDecorator(prev);
        else if (prev.isNamed && prev.type !== 'comment') break;
        prev = prev.previousSibling;
    }

    // (2) Decorators within the chunk's subtree. A captured TS class chunk (the
    //     enclosing export_statement / class_declaration) carries its own class
    //     decorators plus the @Get/@Post/@Inject decorators on its methods.
    //     Bounded traversal so a large class body cannot inflate indexing time.
    let budget = 800;
    const stack = [chunkNode];
    while (stack.length && budget-- > 0) {
        const n = stack.pop();
        for (let i = 0; i < n.namedChildCount; i++) {
            const child = n.namedChild(i);
            if (child.type === 'decorator') addDecorator(child);
            else stack.push(child);
        }
    }

    return Array.from(names).slice(0, 24);
}

/**
 * Extract the base classes and implemented interfaces of a class chunk — the
 * inheritance edge that links a concept to its implementations
 * (`class ValidationPipe extends BasePipe implements PipeTransform`). Surfacing
 * this lets an agent move from an abstract type to the concrete classes that
 * realise it, and feeds the semantic embedding so an implementation is retrievable
 * by the interface it fulfils.
 *
 * Generalises across `extends`/`implements` (TS/JS) and base-class argument lists
 * (Python) by node type. Returns parent type names, e.g.
 * ['BasePipe', 'PipeTransform', 'OnInit'].
 *
 * @returns {string[]} base/interface names (max 12)
 */
export function extractHeritage(chunkNode, ext) {
    const bases = new Set();
    const JS_LIKE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

    const addTypeNames = (node) => {
        const stack = [node];
        let budget = 200;
        while (stack.length && budget-- > 0) {
            const n = stack.pop();
            if ((n.type === 'type_identifier' || n.type === 'identifier') && /^[A-Za-z_$]/.test(n.text)) {
                bases.add(n.text);
            }
            for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
        }
    };

    if (JS_LIKE.includes(ext)) {
        // Walk the chunk subtree for extends/implements clauses, but never descend
        // into class_body — base types of the class only, not its method internals.
        const stack = [chunkNode];
        let budget = 400;
        while (stack.length && budget-- > 0) {
            const n = stack.pop();
            if (n.type === 'extends_clause' || n.type === 'implements_clause') { addTypeNames(n); continue; }
            for (let i = 0; i < n.namedChildCount; i++) {
                const c = n.namedChild(i);
                if (c.type !== 'class_body' && c.type !== 'statement_block') stack.push(c);
            }
        }
    } else if (ext === '.py') {
        const sc = chunkNode.childForFieldName?.('superclasses');
        if (sc) {
            for (let i = 0; i < sc.namedChildCount; i++) {
                const c = sc.namedChild(i);
                // skip keyword args like metaclass=… (keyword_argument node)
                if (c.type === 'identifier' || c.type === 'attribute') bases.add(c.text);
            }
        }
    } else {
        // Other indexed languages: each grammar exposes the base class / implemented
        // interface / supertrait names under a small set of "heritage clause" node
        // types (discovered per grammar). We walk the chunk for those clause nodes
        // and collect the capitalized type names inside — cheap, no type inference.
        // A grammar we don't have a clause for simply yields [] (today's behaviour).
        const CLAUSES = HERITAGE_CLAUSES[ext];
        if (CLAUSES) {
            const stack = [chunkNode];
            let budget = 400;
            while (stack.length && budget-- > 0) {
                const n = stack.pop();
                if (CLAUSES.has(n.type)) { collectHeritageNames(n, bases); continue; }
                for (let i = 0; i < n.namedChildCount; i++) {
                    const c = n.namedChild(i);
                    if (!HERITAGE_BODY_TYPES.has(c.type)) stack.push(c); // base types sit before the body
                }
            }
        }
        // Go has no inheritance keyword — embedding (an anonymous field whose name IS
        // a type) is the closest "is-a/has-a" edge, so surface embedded type names.
        if (ext === '.go') collectGoEmbedding(chunkNode, bases);
    }
    return Array.from(bases).slice(0, 12);
}

// Per-grammar node types whose subtree holds base/interface/supertrait names.
const HERITAGE_CLAUSES = {
    '.java': new Set(['superclass', 'super_interfaces']),
    '.cs': new Set(['base_list']),
    '.php': new Set(['base_clause', 'class_interface_clause']),
    '.kt': new Set(['delegation_specifier']),
    '.swift': new Set(['inheritance_specifier']),
    '.rb': new Set(['superclass']),
    '.rs': new Set(['trait_bounds']), // supertrait bounds on a trait_item
};
// Member-body nodes the heritage walk must not descend into (base types precede them).
const HERITAGE_BODY_TYPES = new Set([
    'class_body', 'declaration_list', 'enum_body', 'statement_block', 'block',
    'function_body', 'field_declaration_list', 'interface_body', 'struct_body', 'class_body_declaration',
]);

/** Collect capitalized type names anywhere under a heritage-clause node. */
function collectHeritageNames(node, set) {
    const stack = [node];
    let budget = 200;
    while (stack.length && budget-- > 0) {
        const n = stack.pop();
        if (HERITAGE_NAME_TYPES.has(n.type) && /^[A-Z]/.test(n.text || '')) set.add(n.text);
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}
const HERITAGE_NAME_TYPES = new Set([
    'type_identifier', 'identifier', 'constant', 'simple_identifier', 'name', 'scoped_type_identifier',
]);

/** Go struct/interface embedding: a field/spec whose name IS a bare type. */
function collectGoEmbedding(chunkNode, set) {
    const stack = [chunkNode];
    let budget = 400;
    while (stack.length && budget-- > 0) {
        const n = stack.pop();
        // An embedded field_declaration has a type but no field name; the type node
        // is the embed. (A named field `leash Leash` has a `name` child.)
        if (n.type === 'field_declaration' && !n.childForFieldName?.('name')) {
            for (let i = 0; i < n.namedChildCount; i++) {
                const c = n.namedChild(i);
                if ((c.type === 'type_identifier' || c.type === 'qualified_type') && /^[A-Z]/.test(c.text || '')) {
                    set.add(c.text.split('.').pop());
                }
            }
        }
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}

// C#: C# spells type names as bare `identifier` / `generic_name` (NOT the
// `type_identifier` node the cross-language branch keys on), so the generic walk
// yields [] for C#. These constants drive a `.cs`-gated branch that reads types
// only from the field-precise positions where an identifier IS a type, so we never
// mistake a variable/member name for a type.
const CS_TYPE_HOST = new Set(['parameter', 'variable_declaration', 'property_declaration', 'method_declaration', 'base_list']);
// Generic-constraint / contextual keywords that occupy type position but aren't types.
const CS_TYPE_KEYWORDS = new Set(['where', 'new', 'class', 'struct', 'unmanaged', 'notnull', 'var']);

/** Collect simple C# type names from a type-position node (descending through
 *  generics / arrays / nullables / tuples). Skips predefined primitives and `var`,
 *  keeps only PascalCase names, and reduces a qualified name to its last segment. */
function _csTypeNamesFrom(node, out) {
    if (!node) return;
    const stack = [node];
    let budget = 200;
    while (stack.length && budget-- > 0) {
        const n = stack.pop();
        const t = n.type;
        if (t === 'predefined_type' || t === 'implicit_type') continue; // int/string/void/var…
        if (t === 'identifier' || t === 'type_identifier') {
            const nm = n.text;
            if (nm && /^[A-Z]/.test(nm) && !CS_TYPE_KEYWORDS.has(nm)) out.add(nm);
            continue;
        }
        if (t === 'qualified_name') {
            // The type is the LAST segment; it may itself be a generic_name
            // (System.Collections.Generic.List<Order>). Descend into just that
            // segment → "List" + "Order" (not a malformed "List<Order>"), while
            // never visiting the namespace identifiers (System/Collections/Generic).
            const last = n.namedChild(n.namedChildCount - 1);
            if (last && (last.type === 'generic_name' || last.type === 'identifier' || last.type === 'type_identifier')) {
                stack.push(last);
            } else {
                const seg = (n.text || '').split('.').pop();
                if (seg && /^[A-Z]/.test(seg) && !CS_TYPE_KEYWORDS.has(seg)) out.add(seg);
            }
            continue;
        }
        // generic_name / array_type / nullable_type / tuple_type / type_argument_list /
        // pointer_type … → descend to reach the inner type names.
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}

export function extractTypeAnnotations(chunkNode, ext) {
    const types = new Set();
    // JS/TS + Python use the precise annotation branches below. Every other indexed
    // language is covered by the shared `type_identifier` branch (that node appears
    // ONLY in type position across Go/Rust/Java/Kotlin/Swift/C) plus a `named_type`
    // branch for PHP — so the type-user dimension of find_references works in those
    // languages too, with no early-out and no type inference. C# is the exception:
    // it spells types as bare `identifier`/`generic_name`, so it gets a dedicated
    // field-precise branch below (gated on `.cs`). Ruby (dynamically typed) still
    // carries no cheap type signal and naturally yields [].

    function walk(node) {
        if (node.type === 'type_annotation') {
            const typeText = node.text.replace(/^:\s*/, '').trim();
            const PRIMITIVES = new Set(['string', 'number', 'boolean', 'void', 'any', 'unknown', 'never', 'null', 'undefined', 'object', 'symbol', 'bigint']);
            for (const match of typeText.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)) {
                if (!PRIMITIVES.has(match[1].toLowerCase())) types.add(match[1]);
            }
        }
        // type_identifier / generic_type: a named type in type position. This is the
        // cross-language branch — type_identifier is how Go/Rust/Java/Kotlin/Swift/C
        // (and TS) all spell a referenced type name.
        else if (node.type === 'type_identifier' || node.type === 'generic_type') {
            const name = node.children[0]?.text || node.text;
            if (name && /^[A-Z]/.test(name)) types.add(name);
        }
        // PHP: a typed parameter / return uses `named_type` (e.g. `Owner`, `\App\User`).
        else if (node.type === 'named_type') {
            const seg = (node.text || '').replace(/^\?/, '').split('\\').pop().trim();
            if (seg && /^[A-Z]/.test(seg)) types.add(seg);
        }
        else if (node.type === 'annotation' && ext === '.py') {
            const typeText = node.text.replace(/^->\s*|^:\s*/, '').trim();
            for (const match of typeText.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)) {
                types.add(match[1]);
            }
        }
        // C#: types live as bare identifiers in field-precise positions — a
        // parameter/field/property/local's `type`, a method's `returns`, and the
        // class `base_list`. Additive and `.cs`-only, so all other languages are
        // byte-identical to before.
        else if (ext === '.cs' && CS_TYPE_HOST.has(node.type)) {
            if (node.type === 'base_list') {
                _csTypeNamesFrom(node, types);
            } else {
                _csTypeNamesFrom(node.childForFieldName?.('type') || node.childForFieldName?.('returns') || null, types);
            }
        }
        for (const child of node.children) walk(child);
    }
    walk(chunkNode);
    return Array.from(types).slice(0, 20);
}

// Call names that are framework/stdlib noise rather than project call edges.
const CALL_NOISE = new Set(['require', 'console', 'log', 'expect', 'test', 'it', 'describe', 'setTimeout', 'print', 'println!']);
function _validCallName(c) { return Boolean(c) && c.length > 2 && !CALL_NOISE.has(c); }

// Shell builtins / ubiquitous coreutils — emitting these as Bash call edges would
// bury the project's own function-to-function calls in noise (they never resolve to
// an indexed symbol anyway). Project functions and notable tools (docker, git, npm,
// kubectl…) are kept.
const BASH_BUILTINS = new Set([
    'echo', 'cd', 'ls', 'cat', 'rm', 'cp', 'mv', 'mkdir', 'rmdir', 'touch', 'ln',
    'export', 'local', 'readonly', 'declare', 'unset', 'shift', 'read', 'printf',
    'exit', 'return', 'eval', 'exec', 'trap', 'wait', 'sleep', 'pwd', 'set', 'shopt',
    'source', 'test', 'true', 'false', 'kill', 'jobs', 'type', 'command', 'getopts',
    'grep', 'sed', 'awk', 'cut', 'tr', 'sort', 'uniq', 'head', 'tail', 'find', 'xargs',
    'chmod', 'chown', 'tee', 'wc', 'basename', 'dirname', 'tar', 'curl', 'wget', 'env',
]);

/**
 * Collapse a call's receiver expression into a compact disambiguation hint:
 *   • ''        — unqualified call (`foo()`): a free function or in-scope name.
 *   • 'this'    — `this.`/`self.`-rooted: dispatch on the SAME instance/class.
 *   • '<ident>' — the last identifier of the receiver expression (`db.save()` → 'db',
 *                 `UserService.find()` → 'UserService'), the only cheap type signal
 *                 available without full inference.
 * This is what lets get_call_graph separate the real callers of `OrderService.save`
 * from every unrelated `save()` in the repo (see mcp/topology.mjs classifyCallers).
 */
function _receiverHint(objNode) {
    if (!objNode) return '';
    const t = objNode.text || '';
    if (/^(this|self)\b/.test(t)) return 'this';
    const segs = t.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
    return segs.length ? segs[segs.length - 1] : '';
}

/**
 * C#: the invoked-name node is either a plain `identifier` or a `generic_name`
 * (`Method<T>`, children = identifier + type_argument_list) whose leading
 * `identifier` is the real method name. Strip the type-argument list so the
 * recorded callee is `Method`, not `Method<T>`.
 */
function _csInvokedName(node) {
    if (!node) return '';
    if (node.type === 'identifier') return node.text;
    const id = node.children?.find(c => c.type === 'identifier');
    return id ? id.text : (node.text || '').split('<')[0];
}

// ─── Scope-aware receiver type inference (intra-procedural, best-effort) ──────────
// `db.s.save()` and `const s = getStore(); s.save()` both record a receiver hint of
// `s` (a variable, not a type), so classifyCallers can only name-match them and they
// leak into every `save()` in the repo. A cheap pass over the SAME chunk subtree
// resolves the simple local bindings the AST already makes explicit — `new Repo()`,
// a constructor/factory call, and TS/Python type annotations — and tags the call
// site with `recv_type` (resolved here) or `recv_via_call` (a factory whose return
// type is resolved at query time from the index). This is strictly additive: a call
// site that cannot be resolved keeps exactly its old `{ name, recv }` shape and stays
// name-only. Only languages whose type is recoverable from the AST participate
// (TS/JS via `new`/annotations, Python via annotations/obvious constructors, plus the
// trivially-safe Java/C# `new Foo()`); receiver-less languages are untouched.

/** Clean a type-position node's text to a type string, or null if it carries no
 *  capitalized identifier (drops primitives like `string`/`number[]`). Generics and
 *  namespaces are preserved verbatim — classifyCallers token-matches against them. */
function _bindingTypeName(typeText) {
    if (!typeText) return null;
    const cleaned = typeText.replace(/^->\s*/, '').replace(/^[:\s]+/, '').trim().slice(0, 64);
    return /[A-Z]/.test(cleaned) ? cleaned : null;
}

/** Peel await/parenthesized wrappers off a value expression (TS `await getStore()`,
 *  Python `await get_store()`). Bounded to avoid pathological nesting. */
function _unwrapValueNode(node) {
    let n = node, guard = 0;
    while (n && guard++ < 6) {
        if (n.type === 'await_expression' || n.type === 'await') { n = n.namedChildren?.[0]; continue; }
        if (n.type === 'parenthesized_expression') { n = n.namedChildren?.[0]; continue; }
        break;
    }
    return n;
}

/**
 * Classify a right-hand-side value into the type of the binding it produces:
 *   • { type }     — directly recoverable now (`new Repo()`, `(x as Repo)`,
 *                    a Python `Repo()` constructor, Java/C# `new Repo()`).
 *   • { viaCall }  — a factory call whose return type is resolved later from the
 *                    callee's recorded return_type (`getStore()`).
 *   • null         — nothing safe to infer.
 */
function _classifyValueNode(node) {
    node = _unwrapValueNode(node);
    if (!node) return null;
    const t = node.type;
    if (t === 'new_expression') { // TS/JS: new Repo()
        const ctor = node.childForFieldName?.('constructor') || node.namedChildren?.[0];
        const tn = _bindingTypeName(ctor?.text);
        return tn ? { type: tn } : null;
    }
    if (t === 'object_creation_expression') { // Java / C#: new Repo() (trivially safe)
        const ty = node.childForFieldName?.('type') || node.namedChildren?.find(c => /type|name|identifier/.test(c.type));
        const tn = _bindingTypeName(ty?.text);
        return tn ? { type: tn } : null;
    }
    if (t === 'as_expression' || t === 'satisfies_expression') { // TS: const s = x as Repo
        const ty = node.childForFieldName?.('type') || node.namedChildren?.[node.namedChildren.length - 1];
        const tn = _bindingTypeName(ty?.text);
        if (tn) return { type: tn };
        return _classifyValueNode(node.childForFieldName?.('expression') || node.namedChildren?.[0]);
    }
    if (t === 'call') { // Python: Repo() is a constructor by convention; get_store() is a factory
        const fn = node.childForFieldName?.('function') || node.children?.[0];
        if (fn?.type === 'identifier') {
            return /^[A-Z]/.test(fn.text) ? { type: fn.text } : (_validCallName(fn.text) ? { viaCall: fn.text } : null);
        }
        if (fn?.type === 'attribute') {
            const last = fn.childForFieldName?.('attribute')?.text; // mod.Repo()
            if (last && /^[A-Z]/.test(last)) return { type: last };
        }
        return null;
    }
    if (t === 'call_expression') { // TS/JS/Swift/Go/Rust/C: factory call — defer to return_type
        const fn = node.childForFieldName?.('function') || node.children?.[0];
        if (fn && (fn.type === 'identifier' || fn.type === 'simple_identifier') && _validCallName(fn.text)) return { viaCall: fn.text };
        return null;
    }
    return null;
}

/**
 * Collect simple local variable → binding-type for one chunk subtree. Handles the
 * common, unambiguous forms only; a variable bound to two different things is dropped
 * (conflict) rather than guessed. `this`/`self` are excluded (handled by the `this`
 * receiver bucket). One extra subtree pass per chunk — O(chunk size), no whole-program
 * analysis — justified by the precision win on dynamically-typed receivers.
 */
function _inferLocalBindings(rootNode) {
    const bindings = new Map();
    const set = (name, val) => {
        if (!name || name === 'this' || name === 'self' || !val) return;
        const prev = bindings.get(name);
        if (prev === undefined) { bindings.set(name, val); return; }
        if (prev.conflict) return;
        if (prev.type !== val.type || prev.viaCall !== val.viaCall) bindings.set(name, { conflict: true });
    };
    function walk(node) {
        const t = node.type;
        if (t === 'variable_declarator') {
            const nameNode = node.childForFieldName?.('name');
            if (nameNode && nameNode.type === 'identifier') {
                const val = _classifyValueNode(node.childForFieldName?.('value'));
                if (val) set(nameNode.text, val);
            }
        } else if (t === 'required_parameter' || t === 'optional_parameter') {
            const id = node.childForFieldName?.('pattern');
            const ty = node.childForFieldName?.('type');
            if (id && id.type === 'identifier' && ty) { const tn = _bindingTypeName(ty.text); if (tn) set(id.text, { type: tn }); }
        } else if (t === 'assignment') {
            const left = node.childForFieldName?.('left');
            const ty = node.childForFieldName?.('type');
            if (left && left.type === 'identifier') {
                if (ty) { const tn = _bindingTypeName(ty.text); if (tn) set(left.text, { type: tn }); }
                else { const val = _classifyValueNode(node.childForFieldName?.('right')); if (val) set(left.text, val); }
            }
        } else if (t === 'typed_parameter' || t === 'typed_default_parameter') {
            const id = node.childForFieldName?.('name') || node.children?.find(c => c.type === 'identifier');
            const ty = node.childForFieldName?.('type');
            if (id && ty) { const tn = _bindingTypeName(ty.text); if (tn) set(id.text, { type: tn }); }
        }
        node.children.forEach(walk);
    }
    walk(rootNode);
    return bindings;
}

/** Resolve a call site's receiver object node to a binding ({type}|{viaCall}|null):
 *  a simple variable via the binding map, or an inline `new Repo()`/`getStore()`. */
function _inferReceiverType(objNode, bindings) {
    if (!objNode) return null;
    if (objNode.type === 'identifier' || objNode.type === 'simple_identifier') {
        const v = objNode.text;
        if (v === 'this' || v === 'self') return null;
        const b = bindings.get(v);
        return (b && !b.conflict) ? b : null;
    }
    return _classifyValueNode(objNode); // inline: new Repo().save(), getStore().save()
}

/**
 * Walk a subtree and collect every call site as { name, recv } (receiver hint), plus
 * an optional `recv_type` / `recv_via_call` when the receiver's type is recoverable
 * intra-procedurally (see the inference helpers above). Deduplicated by (name, recv).
 * Cross-language: call_expression (JS/TS/Go/Rust/C and Swift via simple_identifier/
 * navigation_expression), call (Python), macro_invocation (Rust), method_invocation
 * (Java/C#), method_call (Ruby), command (Bash). The receiver is the precision half of
 * the call graph — extractCalls() derives the legacy name-only list from these sites.
 */
export function extractCallSites(rootNode) {
    const sites = [];
    const bindings = _inferLocalBindings(rootNode);
    const seen = new Set();
    const add = (name, recv, objNode = null) => {
        if (!name) return;
        const key = name + ' ' + recv;
        if (seen.has(key)) return;
        seen.add(key);
        const site = { name, recv };
        const inferred = objNode ? _inferReceiverType(objNode, bindings) : null;
        if (inferred?.type) site.recv_type = inferred.type;
        else if (inferred?.viaCall) site.recv_via_call = inferred.viaCall;
        sites.push(site);
    };
    function walk(node) {
        const t = node.type;
        if (t === 'call_expression') {
            const funcNode = node.childForFieldName?.('function') || node.children[0];
            if (funcNode) {
                if (funcNode.type === 'identifier') add(funcNode.text, '');
                else if (funcNode.type === 'simple_identifier') add(funcNode.text, '');
                else if (funcNode.type === 'member_expression' || funcNode.type === 'property_identifier') {
                    const prop = funcNode.childForFieldName?.('property');
                    const obj = funcNode.childForFieldName?.('object');
                    if (prop) add(prop.text, _receiverHint(obj), obj);
                    else add(funcNode.text.split('.').pop(), '');
                } else if (funcNode.type === 'navigation_expression') { // Swift obj.method / self.method
                    const suffix = funcNode.childForFieldName?.('suffix');
                    const m = suffix?.namedChildren?.find(c => c.type === 'simple_identifier')?.text
                        || suffix?.text?.replace(/^\./, '');
                    const target = funcNode.childForFieldName?.('target');
                    if (m) add(m, _receiverHint(target), target);
                }
            }
        } else if (t === 'command') {
            const cmd = (node.childForFieldName?.('name')?.text || '').trim();
            // bare identifiers only — skip paths, env-prefixed assignments, builtins.
            if (cmd && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(cmd) && !BASH_BUILTINS.has(cmd)) add(cmd, '');
        } else if (t === 'call') {
            const funcNode = node.childForFieldName?.('function') || node.children[0];
            if (funcNode) {
                if (funcNode.type === 'identifier') add(funcNode.text, '');
                else if (funcNode.type === 'attribute') {
                    const attr = funcNode.childForFieldName?.('attribute');
                    const obj = funcNode.childForFieldName?.('object');
                    if (attr) add(attr.text, _receiverHint(obj), obj);
                }
            }
        } else if (t === 'macro_invocation') {
            const macroNode = node.childForFieldName?.('macro') || node.children[0];
            if (macroNode && macroNode.type === 'identifier') add(macroNode.text + '!', '');
        } else if (t === 'method_invocation') {
            const nameNode = node.childForFieldName?.('name') || node.children.find(c => c.type === 'identifier');
            const obj = node.childForFieldName?.('object');
            if (nameNode) add(nameNode.text, _receiverHint(obj), obj);
        } else if (t === 'invocation_expression') { // C# — the grammar has NO method_invocation; a call is
            // invocation_expression(function, arguments). The function is a bare identifier (same-class /
            // using-static call) or a member_access_expression (obj.Method() / this.Method()).
            const fn = node.childForFieldName?.('function');
            if (fn) {
                if (fn.type === 'member_access_expression') {
                    const nm = _csInvokedName(fn.childForFieldName?.('name'));
                    const expr = fn.childForFieldName?.('expression');
                    if (nm) add(nm, _receiverHint(expr), expr);
                } else if (fn.type === 'identifier') {
                    add(fn.text, '');
                } else if (fn.type === 'generic_name') {
                    const nm = _csInvokedName(fn);
                    if (nm) add(nm, '');
                }
            }
        } else if (t === 'method_call') {
            const method = node.childForFieldName?.('method') || node.children.find(c => c.type === 'identifier');
            const receiver = node.childForFieldName?.('receiver');
            if (method && method.type === 'identifier') add(method.text, _receiverHint(receiver), receiver);
        } else if (t === 'function_call_expression') {
            const fn = node.childForFieldName?.('function');
            if (fn && (fn.type === 'name' || fn.type === 'qualified_name')) {
                const nm = (fn.text || '').split('\\').filter(Boolean).pop();
                if (nm) add(nm, '');
            }
        } else if (t === 'member_call_expression' || t === 'nullsafe_member_call_expression') {
            const nameNode = node.childForFieldName?.('name');
            const obj = node.childForFieldName?.('object');
            if (nameNode && nameNode.type === 'name') add(nameNode.text, _receiverHint(obj), obj);
        } else if (t === 'scoped_call_expression') {
            const nameNode = node.childForFieldName?.('name');
            const scope = node.childForFieldName?.('scope');
            if (nameNode && nameNode.type === 'name') add(nameNode.text, _receiverHint(scope), scope);
        }
        node.children.forEach(walk);
    }
    walk(rootNode);
    return sites.filter(s => _validCallName(s.name));
}

/** Legacy name-only outgoing-call list (unique callee names). Derived from
 *  extractCallSites so the two never diverge; preserved for the BM25 document
 *  and the back-compat findCallers contract. */
export function extractCalls(rootNode) {
    const seen = new Set();
    const out = [];
    for (const { name } of extractCallSites(rootNode)) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}
