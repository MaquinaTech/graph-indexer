/** Rust extraction spec. `impl Type { fn m() }` methods are qualified as Type.m. */

const TH = (cap) => `[(type_identifier) @${cap} (generic_type type: (type_identifier) @${cap}) (scoped_type_identifier path: (_) @recv name: (type_identifier) @${cap}) (reference_type type: (type_identifier) @${cap}) (reference_type type: (generic_type type: (type_identifier) @${cap}))]`;
// a whole type (normalizeType unwraps references, Box/Rc/Arc/Option/Result, and sees Vec<T> as T[])
const TW = (cap) => `[(type_identifier) (primitive_type) (generic_type) (scoped_type_identifier) (reference_type) (array_type) (pointer_type) (tuple_type)] @${cap}`;

const QUERY = `
(function_item name: (identifier) @name return_type: ${TW('type')}) @def.function
(function_item name: (identifier) @name) @def.function
(function_signature_item name: (identifier) @name return_type: ${TW('type')}) @def.function
(function_signature_item name: (identifier) @name) @def.function
(struct_item name: (type_identifier) @name) @def.struct
(enum_item name: (type_identifier) @name) @def.enum
(union_item name: (type_identifier) @name) @def.struct
(trait_item name: (type_identifier) @name) @def.trait
(type_item name: (type_identifier) @name) @def.type
(const_item name: (identifier) @name) @def.constant
(static_item name: (identifier) @name) @def.constant
(mod_item name: (identifier) @name body: (_)) @def.module
(macro_definition name: (identifier) @name) @def.macro
(field_declaration name: (field_identifier) @name type: ${TW('type')}) @def.field
(field_declaration name: (field_identifier) @name) @def.field
(enum_variant name: (identifier) @name) @def.constant

(call_expression function: (identifier) @name) @ref.call
(call_expression function: (field_expression value: (_) @recv field: (field_identifier) @name)) @ref.call
(call_expression function: (scoped_identifier path: (_) @recv name: (identifier) @name)) @ref.call
(call_expression function: (generic_function function: (identifier) @name)) @ref.call
(call_expression function: (generic_function function: (scoped_identifier path: (_) @recv name: (identifier) @name))) @ref.call
(call_expression function: (generic_function function: (field_expression value: (_) @recv field: (field_identifier) @name))) @ref.call
(macro_invocation macro: (identifier) @name) @ref.call
(struct_expression name: (type_identifier) @name) @ref.new
(struct_expression name: (scoped_type_identifier path: (_) @recv name: (type_identifier) @name)) @ref.new
(type_identifier) @name @ref.type
(scoped_type_identifier path: (_) @recv name: (type_identifier) @name) @ref.type
(scoped_identifier path: [(identifier) @name (scoped_identifier path: (_) @recv name: (identifier) @name)]) @ref.type
(identifier) @name @ref.value
(impl_item trait: ${TH('name')}) @ref.inherit
(trait_item bounds: (trait_bounds ${TH('name')})) @ref.inherit
(arguments (identifier) @name) @ref.value
(arguments (scoped_identifier path: (_) @recv name: (identifier) @name)) @ref.value

(closure_expression) @scope
(return_expression (_) @ret)
(function_item body: (block [(call_expression) (struct_expression) (field_expression) (identifier) (self) (reference_expression) (try_expression) (scoped_identifier)] @ret .))
(use_declaration) @import

(let_declaration pattern: (identifier) @bind.name type: ${TW('bind.type')}) @bind
(let_declaration pattern: (mut_pattern (identifier) @bind.name) type: ${TW('bind.type')}) @bind
(let_declaration pattern: (identifier) @bind.name value: (_) @bind.expr) @bind
(let_declaration pattern: (mut_pattern (identifier) @bind.name) value: (_) @bind.expr) @bind
(for_expression pattern: (identifier) @bind.name value: (_) @bind.elem) @bind
(let_declaration pattern: (identifier) @bind.name value: (struct_expression name: (type_identifier) @bind.new)) @bind
(let_declaration pattern: (identifier) @bind.name value: (call_expression function: (scoped_identifier path: (identifier) @bind.new name: (identifier) @_ctor)) (#not-match? @bind.new "^(Arc|Rc|Box|Pin)$")) @bind
(let_declaration pattern: (mut_pattern (identifier) @bind.name) value: (call_expression function: (scoped_identifier path: (identifier) @bind.new name: (identifier) @_ctor)) (#not-match? @bind.new "^(Arc|Rc|Box|Pin)$")) @bind
(let_declaration pattern: (identifier) @bind.name value: (call_expression function: (identifier) @bind.call)) @bind
(parameter pattern: (identifier) @bind.name type: ${TW('bind.type')}) @bind
(parameter pattern: (mut_pattern (identifier) @bind.name) type: ${TW('bind.type')}) @bind
(let_declaration pattern: (tuple_pattern) @bind.tuple value: (_) @bind.expr) @bind
(let_condition pattern: (tuple_struct_pattern type: (identifier) @_wrap [(identifier) @bind.name (ref_pattern (identifier) @bind.name) (mut_pattern (identifier) @bind.name)]) value: (_) @bind.expr (#match? @_wrap "^(Some|Ok)$")) @bind
(struct_item name: (type_identifier) @tuple.owner body: (ordered_field_declaration_list) @tuple.fields)
(enum_variant name: (identifier) @tuple.variant body: (ordered_field_declaration_list) @tuple.fields)
(match_arm pattern: (match_pattern (tuple_struct_pattern) @bind.variant)) @bind
(let_condition pattern: (tuple_struct_pattern) @bind.variant) @bind
(match_expression value: (_) @bind.expr body: (match_block (match_arm pattern: (match_pattern . (identifier) @bind.name .)) @bind) (#match? @bind.name "^[a-z_]"))
(for_expression pattern: (tuple_pattern (_) (identifier) @bind.name .) value: (call_expression function: (field_expression value: (_) @bind.elem field: (field_identifier) @_en)) (#eq? @_en "enumerate")) @bind
(block) @scope.block
(match_arm) @scope.block
(if_expression) @scope.block
(while_expression) @scope.block
(for_expression) @scope.block
`;

const PRIMITIVES = new Set(['i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
    'f32', 'f64', 'bool', 'char', 'str', 'String', 'Option', 'Result', 'Vec', 'Box', 'Rc', 'Arc', 'RefCell',
    'Cell', 'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet', 'Cow', 'Mutex', 'RwLock', 'Pin', 'PhantomData']);
const BUILTIN_MACROS = new Set(['println', 'print', 'eprintln', 'eprint', 'format', 'vec', 'panic', 'assert',
    'assert_eq', 'assert_ne', 'debug_assert', 'debug_assert_eq', 'write', 'writeln', 'unreachable', 'unimplemented',
    'todo', 'matches', 'include_str', 'include_bytes', 'concat', 'stringify', 'env', 'cfg', 'dbg', 'format_args', 'Ok',
    'Err', 'Some', 'None', 'Box', 'Default', 'drop', 'Into', 'From']);

/** The type a type expression names: `&'a mut Deserializer<R>`, `Box<T>` and `a::B<C>` name Deserializer, Box and B. */
function typeHead(t) {
    for (let g = 0; t && g < 8; g++) {
        if (t.type === 'type_identifier' || t.type === 'primitive_type') return t.text;
        if (t.type === 'reference_type' || t.type === 'pointer_type' || t.type === 'generic_type') t = t.childForFieldName('type');
        else if (t.type === 'scoped_type_identifier') t = t.childForFieldName('name');
        else return null;
    }
    return null;
}

const implOf = (node) => (node.parent?.type === 'declaration_list' && node.parent.parent?.type === 'impl_item' ? node.parent.parent : null);

/**
 * The type whose method a function in an impl block is. A blanket impl over a type parameter
 * (`impl<'a, M: Matcher> Matcher for &'a M`, `… for Box<M>`) adds the trait's methods to every implementor:
 * its methods belong to the trait.
 */
function implOwner(node) {
    const impl = implOf(node);
    if (!impl) return null;
    const type = impl.childForFieldName('type');
    const head = typeHead(type);
    const params = (impl.childForFieldName('type_parameters')?.namedChildren ?? []).filter(p => p.type === 'type_parameter').map(p => p.childForFieldName('name')?.text);
    // `impl<M: Matcher> Matcher for Box<M>`: a wrapper around the parameter is the parameter
    let inner = head;
    if (WRAPPERS.has(head) && type?.type === 'generic_type') inner = typeHead(type.childForFieldName('type_arguments')?.namedChildren[0]) ?? head;
    const isParam = inner && params.includes(inner);
    const trait = isParam ? impl.childForFieldName('trait') : null;
    return trait ? typeHead(trait) ?? head : head;
}

/** The trait an impl block implements, for the functions declared in it (`impl fmt::Debug for Number` → Debug). */
function implTrait(node) {
    if (node.type !== 'function_item' && node.type !== 'function_signature_item') return [];
    const t = implOf(node)?.childForFieldName('trait');
    const h = t ? typeHead(t) : null;
    return h ? [h] : [];
}

// bounds that say nothing about the methods a value has
const MARKER_TRAITS = new Set(['Copy', 'Clone', 'Send', 'Sync', 'Sized', 'Unpin', 'Debug', 'Display', 'Default', 'Eq', 'PartialEq',
    'Hash', 'Ord', 'PartialOrd', 'Any', 'UnwindSafe', 'RefUnwindSafe']);
const GENERIC_ITEMS = new Set(['function_item', 'function_signature_item', 'impl_item', 'trait_item', 'struct_item', 'enum_item']);

/**
 * The traits a type parameter in scope at `node` is bound by (`fn f<R: Read>(r: &mut R)`,
 * `impl<W, F: Formatter> Serializer<W, F>`, `where R: Read<'de>`), so `r.read()` and `R::read(x)`
 * reach the trait's method (`A + B` when several give it methods: `W: AsyncWrite + AsyncSeek`);
 * null when `name` is no type parameter there or its bounds are markers.
 */
function typeParamBound(node, name) {
    for (let n = node; n; n = n.parent) {
        if (!GENERIC_ITEMS.has(n.type)) continue;
        let declared = false;
        const bounds = [];
        const take = (list) => { for (const b of list?.namedChildren ?? []) { const t = b.type === 'higher_ranked_trait_bound' ? b.childForFieldName('type') : b; const h = typeHead(t); if (h && !MARKER_TRAITS.has(h) && !bounds.includes(t.text)) bounds.push(t.text); } };
        for (const p of n.childForFieldName('type_parameters')?.namedChildren ?? []) {
            if (p.type !== 'type_parameter' || p.childForFieldName('name')?.text !== name) continue;
            declared = true;
            take(p.childForFieldName('bounds'));
        }
        for (const w of n.namedChildren.find(c => c.type === 'where_clause')?.namedChildren ?? []) {
            if (w.type === 'where_predicate' && w.childForFieldName('left')?.text === name) { declared ||= GENERIC_ITEMS.has(n.type); take(w.childForFieldName('bounds')); }
        }
        if (declared) return bounds.length ? bounds.join(' + ') : null;
    }
    return null;
}

function flattenUse(node, prefix, out) {
    switch (node.type) {
        case 'scoped_identifier': case 'identifier': case 'crate': case 'self': case 'super': {
            const full = (prefix ? prefix + '::' : '') + node.text;
            const name = full.split('::').pop();
            out.push({ source: full.split('::').slice(0, -1).join('::'), imported: name, local: name === 'self' ? full.split('::').slice(-2, -1)[0] : name });
            break;
        }
        case 'use_as_clause': {
            const p = node.childForFieldName('path');
            const full = (prefix ? prefix + '::' : '') + (p?.text ?? '');
            out.push({ source: full.split('::').slice(0, -1).join('::'), imported: full.split('::').pop(), local: node.childForFieldName('alias')?.text });
            break;
        }
        case 'use_wildcard': {
            const inner = node.namedChildren[0];
            out.push({ source: (prefix ? prefix + '::' : '') + (inner?.text ?? ''), imported: '*', local: null, wildcard: true });
            break;
        }
        case 'scoped_use_list': {
            const p = node.childForFieldName('path');
            const np = (prefix ? prefix + '::' : '') + (p?.text ?? '');
            const list = node.childForFieldName('list');
            for (const c of list?.namedChildren ?? []) flattenUse(c, np, out);
            break;
        }
        case 'use_list':
            for (const c of node.namedChildren) flattenUse(c, prefix, out);
            break;
        default: break;
    }
}

function parseImport(node) {
    const arg = node.childForFieldName('argument');
    const out = [];
    if (arg) flattenUse(arg, '', out);
    return out;
}

/**
 * Macro arguments are a token tree to tree-sitter: `tri!(self.parse(x))` and `assert_eq!(a.f(), 1)`
 * hold calls the index would not see, and `cfg_rt! { pub struct Runtime … }` holds whole items. Before
 * extraction, invocations whose arguments are plain Rust are rewritten in place, to text of the same
 * length (so every position stays where it is): `m!(args)` → `m (args)` (a call of `m`), `m![args]`
 * → `   [args]` (an array) and, where an item may stand, `m! { items }` → the items unwrapped.
 * A rewrite is kept only if its text parses without errors on its own; macros inside the arguments
 * become nodes once the outer one is rewritten, so this repeats a few rounds. Macro definitions
 * (`macro_rules!`, with `$x` fragments) are left alone.
 */
function rewriteMacros(source, parse) {
    let text = source;
    for (let round = 0; round < 4; round++) {
        const tree = parse(text);
        const edits = [];
        try {
            const stack = [tree.rootNode];
            while (stack.length) {
                const n = stack.pop();
                if (n.type === 'macro_definition') continue;
                if (n.type === 'macro_invocation') {
                    const e = macroEdit(n, text, parse);
                    if (e) edits.push(e);
                    continue;
                }
                for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i));
            }
        } finally { tree.delete(); }
        if (!edits.length) break;
        let out = '', at = 0;
        for (const e of edits.sort((a, b) => a.from - b.from)) { out += text.slice(at, e.from) + e.text; at = e.to; }
        text = out + text.slice(at);
    }
    return text;
}

const blank = (s) => s.replace(/[^\n]/g, ' ');
const ITEM_PARENTS = new Set(['source_file', 'declaration_list']);

/** The same-length rewrite of one macro invocation, or null when its arguments are not plain Rust. */
function macroEdit(node, text, parse) {
    const macro = node.childForFieldName('macro');
    const tt = node.namedChildren[node.namedChildCount - 1];
    if (!macro || tt?.type !== 'token_tree' || macro.text === 'macro_rules') return null;
    const bang = text.indexOf('!', macro.endIndex);
    if (bang < 0 || bang >= tt.startIndex || text.slice(macro.endIndex, bang).trim()) return null;
    const open = text[tt.startIndex], inner = text.slice(tt.startIndex + 1, tt.endIndex - 1);
    let edit, probe;
    if (open === '(') {
        edit = { from: bang, to: bang + 1, text: ' ' };
        probe = `fn __() { let _ = __(${inner}); }`;
    } else if (open === '[') {
        // `vec![..]` keeps an empty block comment where its name stood: the array is a Vec (see rustArgType)
        const gap = blank(text.slice(node.startIndex, bang + 1));
        edit = { from: node.startIndex, to: bang + 1, text: macro.text === 'vec' && gap.length === 4 ? '/**/' : gap };
        probe = `fn __() { let _ = [${inner}]; }`;
    } else if (open === '{' && ITEM_PARENTS.has(node.parent?.type) && inner.trim()) {
        edit = { from: node.startIndex, to: tt.endIndex, text: blank(text.slice(node.startIndex, tt.startIndex + 1)) + inner + ' ' };
        probe = `mod __ {${inner}}`;
    } else return null;
    // `$x` metavariables belong to a macro definition's body (a nested one is not a node here)
    if (/\$[\w(]/.test(inner)) return null;
    const t = parse(probe);
    try { return t.rootNode.hasError ? null : edit; } finally { t.delete(); }
}

// `Arc::new(x)`, `Box::pin(f)`, `Pin::new(&mut x)`, `Rc::clone(&x)`: a value of the wrapped type
const WRAPPERS = new Set(['Arc', 'Rc', 'Box', 'Pin']);
const WRAP_CTORS = new Set(['new', 'pin', 'clone', 'new_unchecked', 'from']);

function wrappedValue(node, describe) {
    // `(*self).m()`, `(**self).m()`: method calls dereference on their own
    if (node.type === 'unary_expression' && node.text.startsWith('*') && node.namedChildren[0]) return describe(node.namedChildren[0]);
    if (node.type !== 'call_expression') return undefined;
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'scoped_identifier') return undefined;
    const owner = fn.childForFieldName('path')?.text.split('::').pop();
    if (!WRAPPERS.has(owner) || !WRAP_CTORS.has(fn.childForFieldName('name')?.text)) return undefined;
    const args = node.childForFieldName('arguments')?.namedChildren.filter(c => !c.type.endsWith('comment')) ?? [];
    return args.length === 1 ? describe(args[0]) : undefined;
}

const POINTER_TYPES = new Set(['Box', 'Rc', 'Arc', 'Cow', 'Pin', 'Option', 'Result', 'Weak']);

/**
 * A file whose own crate defines a type named like a transparent wrapper or a collection (tokio's
 * `Mutex`, `RwLock`, `LinkedList`…) keeps that type: `inner: Mutex<Inner>` is tokio's Mutex, whose
 * methods (`get_mut`, `lock`) are the repository's, not a view of Inner. A `use` rooted anywhere but
 * the standard library (`use crate::…`, `use tokio::sync::Mutex` in the crate's tests) names such a type.
 */
function specForSource(source) {
    let shadowed = null;
    for (const t of [...rust.transparentTypes, ...rust.elementTypes, ...rust.mapTypes]) {
        if (!source.includes(t)) continue;
        // a pointer or an Option reached through a path (`use crate::loom::sync::Arc`) is still a pointer to its contents
        const defined = new RegExp(`\\b(?:struct|enum|type|trait|union)\\s+${t}\\b`).test(source);
        const imported = !POINTER_TYPES.has(t) && new RegExp(`\\buse\\s+(?!(?:std|core|alloc)::)\\w+::[^;]*\\b${t}\\b[^;]*;`).test(source);
        if (defined || imported) (shadowed ??= new Set()).add(t);
    }
    const local = ownModuleNames(source);
    if (!shadowed && !local) return null;
    const out = { ...rust };
    if (shadowed) {
        out.isPrimitiveType = (t) => PRIMITIVES.has(t) && !shadowed.has(t);
        for (const k of ['transparentTypes', 'elementTypes', 'mapTypes']) out[k] = new Set([...rust[k]].filter(t => !shadowed.has(t)));
    }
    if (local) out.externalReceivers = new Set([...rust.externalReceivers].filter(t => !local.has(t)));
    return out;
}

/**
 * `fs::symlink(..)` names std's `fs` unless the file brings in another `fs`: `use tokio::fs;`,
 * `use crate::io::{self, …}`, `mod fs;`. The names the file binds that way, among the standard
 * library's module names (a name followed by `::` in a path is not bound by it).
 */
function ownModuleNames(source) {
    let names = null;
    const add = (n) => { if (rust.externalReceivers.has(n)) (names ??= new Set()).add(n); };
    for (const m of source.matchAll(/\bmod\s+(\w+)/g)) add(m[1]);
    for (const m of source.matchAll(/\buse\s+(?!(?:std|core|alloc)::)([^;]*);/g)) {
        const body = m[1];
        for (const b of body.matchAll(/\bas\s+(\w+)/g)) add(b[1]);
        for (const b of body.matchAll(/\b(\w+)\s*(?=[,;}]|$)/g)) if (b[1] !== 'self') add(b[1]);
        for (const b of body.matchAll(/\b(\w+)::\{\s*self\b/g)) add(b[1]);
    }
    return names;
}

// ── argument types ──────────────────────────────────────────────────────────────
// Impls of one trait for one type differ by the trait's type argument (`impl From<f32> for Value`,
// `impl From<bool> for Value`): `Value::from(x)` runs the impl whose parameter is the type of `x`.
// The types below are Rust type text, normalised (no lifetimes, `&mut T` / `&T`, `_` = not known,
// `{int}` / `{float}` = an unsuffixed literal), as far as the call's own source shows them.

const INT_TYPES = new Set(['i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize']);

/** A type as written, without lifetimes and spacing: `&'a mut [u8]` → `&mut [u8]`. */
function normTy(t) {
    if (!t) return null;
    const s = String(t).replace(/'[A-Za-z_]\w*\s*/g, '').replace(/::</g, '<').replace(/\s+/g, ' ').replace(/&\s+/g, '&').replace(/\s*([<>,;\[\]()])\s*/g, (m, c) => (c === ',' || c === ';' ? c + ' ' : c)).trim();
    return s || null;
}

/** `Vec<u8>` → { head: 'Vec', args: ['u8'] }; `&mut T` → { ref: 'mut', to: 'T' }; `[T]`, `[T; N]`, `(A, B)`. */
function parseTy(s) {
    s = s.trim();
    let m;
    if ((m = /^&(mut )?(.*)$/s.exec(s))) return { ref: m[1] ? 'mut' : '', to: m[2] };
    if (s[0] === '[' && s.endsWith(']')) { const parts = splitTop(s.slice(1, -1), ';'); return parts.length === 2 ? { arr: parts[0] } : { slice: parts[0] }; }
    if (s[0] === '(' && s.endsWith(')')) return { tuple: splitTop(s.slice(1, -1), ',').filter(Boolean) };
    const i = s.indexOf('<');
    const base = i < 0 ? s : s.slice(0, i);
    const head = base.replace(/^(dyn|impl)\s+/, '').split('::').pop().trim();
    return { head, args: i < 0 ? [] : splitTop(s.slice(i + 1, s.lastIndexOf('>')), ',').filter(Boolean), sized: !/^(dyn|impl)\s/.test(base) };
}

/** Split at top-level `sep` (not inside <>, (), []). */
function splitTop(s, sep) {
    const out = [];
    let depth = 0, cur = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if ('<([{'.includes(c)) depth++;
        else if ('>)]}'.includes(c) && !(c === '>' && s[i - 1] === '-')) depth--;
        if (c === sep && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    out.push(cur.trim());
    return out;
}

/**
 * How well an argument type fits a parameter type: 2 the same type, 1 fits through something not
 * known (`_`, a literal's `{int}`, a generic parameter), 0 never. A reference is no value of its type
 * (`From<&T>` and `From<T>` are different impls), and `&mut` is no `&`: trait selection does not coerce.
 */
function tyFit(a, p, generics) {
    if (a === '_') return 1;
    const pa = parseTy(a), pp = parseTy(p);
    if (pp.head !== undefined && !pp.args.length && (generics.has(pp.head) || /^[A-Z][A-Z0-9]?$/.test(pp.head))) return 1;
    if (a === '{int}') return pp.head && INT_TYPES.has(pp.head) ? 1 : 0;
    if (a === '{float}') return pp.head === 'f32' || pp.head === 'f64' ? 1 : 0;
    if (pa.ref != null || pp.ref != null) return pa.ref === pp.ref && pa.ref != null ? tyFit(pa.to, pp.to, generics) : 0;
    if (pa.slice != null || pp.slice != null) return pa.slice != null && pp.slice != null ? tyFit(pa.slice, pp.slice, generics) : 0;
    if (pa.arr != null || pp.arr != null) return pa.arr != null && pp.arr != null ? tyFit(pa.arr, pp.arr, generics) : 0;
    if (pa.tuple || pp.tuple) {
        if (!pa.tuple || !pp.tuple || pa.tuple.length !== pp.tuple.length) return 0;
        return pa.tuple.reduce((m, t, i) => Math.min(m, tyFit(t, pp.tuple[i], generics)), 2);
    }
    if (pa.head !== pp.head) return 0;
    if (!pa.args.length || !pp.args.length) return pa.args.length === pp.args.length ? 2 : 1;
    if (pa.args.length !== pp.args.length) return 0;
    return pa.args.reduce((m, t, i) => Math.min(m, tyFit(t, pp.args[i], generics)), 2);
}

/** The parameters of the function `name` declared in a signature: { self, types, generics }, or null. */
function rustParams(sig, name) {
    const m = sig ? new RegExp(`\\bfn\\s+${name}\\s*`).exec(sig) : null;
    if (!m) return null;
    let i = m.index + m[0].length;
    const generics = new Set();
    if (sig[i] === '<') {
        let d = 0, j = i;
        for (; j < sig.length; j++) { if (sig[j] === '<') d++; else if (sig[j] === '>' && sig[j - 1] !== '-' && --d === 0) break; }
        for (const g of splitTop(sig.slice(i + 1, j), ',')) { const n = /^(?:const\s+)?([A-Za-z_]\w*)/.exec(g); if (n) generics.add(n[1]); }
        i = j + 1;
        while (sig[i] === ' ') i++;
    }
    if (sig[i] !== '(') return null;
    let d = 0, j = i;
    for (; j < sig.length; j++) { if ('([{<'.includes(sig[j])) d++; else if (')]}>'.includes(sig[j]) && sig[j - 1] !== '-' && --d === 0) break; }
    if (d !== 0) return null;
    let self = false;
    const types = [];
    for (const p of splitTop(sig.slice(i + 1, j), ',')) {
        if (!p) continue;
        if (/^(?:&\s*(?:'\w+\s*)?(?:mut\s+)?|mut\s+)?self\b/.test(p)) { self = true; continue; }
        const c = p.indexOf(':');
        if (c < 0) return null;
        types.push(normTy(p.slice(c + 1)));
    }
    return { self, types, generics };
}

/**
 * Among the methods of impls of one trait for one type (`Bytes::from` in `impl From<Vec<u8>>`,
 * `impl From<&[u8]>`…), the one the call's argument types select: `argTypes` are the call's, `owner` the
 * implementing type (for `Self`), `sigs` the candidates' signatures. Returns the index of the one best fit
 * or -1 when the types do not say (an argument not known, several fits, none).
 */
function pickByArgs(sigs, name, owner, argTypes) {
    if (!argTypes?.length || argTypes.every(t => t === '?')) return -1;
    const scored = sigs.map(sig => {
        const ps = rustParams(sig, name);
        if (!ps) return -1;
        let args = argTypes;
        if (ps.self && args.length === ps.types.length + 1) args = args.slice(1); // `Trait::m(&x, y)`
        if (args.length !== ps.types.length) return -1;
        let score = 2;
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '?') continue;
            const p = ps.types[i].replace(/\bSelf\b/g, owner ?? 'Self');
            const f = tyFit(args[i], p, ps.generics);
            if (f === 0) return -1;
            score = Math.min(score, f);
        }
        return score;
    });
    const best = Math.max(...scored);
    if (best < 0) return -1;
    const at = scored.flatMap((s, i) => (s === best ? [i] : []));
    return at.length === 1 ? at[0] : -1;
}

const ctorOwner = (fn) => {
    const path = fn.childForFieldName('path');
    const t = path?.type === 'generic_type' ? path.childForFieldName('type') : path;
    return t && (t.type === 'identifier' || t.type === 'type_identifier') && /^[A-Z]\w+$/.test(t.text) && t.text !== 'Self' ? { name: t.text, args: path.type === 'generic_type' ? path.childForFieldName('type_arguments')?.namedChildren.map(c => normTy(c.text)) : null } : null;
};

/** The element type of a sliceable value (`Vec<u8>`, `[u8; 4]`, `&[u8]`) as `[u8]`; `str` for text. */
function sliceOf(t) {
    for (let g = 0; t && g < 4; g++) {
        const p = parseTy(t);
        if (p.ref != null) { t = p.to; continue; }
        if (p.slice != null || p.arr != null) return `[${p.slice ?? p.arr}]`;
        if (p.head === 'Vec' && p.args.length === 1) return `[${p.args[0]}]`;
        if (p.head === 'String' || p.head === 'str') return 'str';
        return null;
    }
    return null;
}

const OWNED_TEXT = { to_string: 'String', to_owned: null, into_bytes: 'Vec<u8>', to_vec: 'Vec<_>' };

/**
 * The static type of an expression where the source shows it: a literal with its suffix, `vec![..]`,
 * `Vec::new()`, `String::from(..)`, `Box::new(x)`, `Type::new(..)`, a struct literal, a typed local
 * (`look` gives its declared type), `&x`, `&mut x`, `&x[..]`, `x.clone()`, `x.to_string()`. Null when it does not.
 */
function rustArgType(n, look) {
    switch (n.type) {
        case 'integer_literal': { const m = /(?:[ui](?:8|16|32|64|128|size))$/.exec(n.text); return m ? m[0] : '{int}'; }
        case 'float_literal': { const m = /f(?:32|64)$/.exec(n.text); return m ? m[0] : '{float}'; }
        case 'boolean_literal': return 'bool';
        case 'char_literal': return /^b/.test(n.text) ? 'u8' : 'char';
        case 'string_literal': case 'raw_string_literal': return /^br?[#"]/.test(n.text) ? '&[u8; _]' : '&str';
        case 'parenthesized_expression': return n.namedChildren[0] ? rustArgType(n.namedChildren[0], look) : null;
        case 'unary_expression': return n.text.startsWith('-') && n.namedChildren[0] && /literal$/.test(n.namedChildren[0].type) ? rustArgType(n.namedChildren[0], look) : null;
        case 'type_cast_expression': return normTy(n.childForFieldName('type')?.text);
        case 'identifier': return normTy(look(n.text));
        case 'field_expression': return n.childForFieldName('value')?.type === 'self' ? normTy(look('self.' + n.childForFieldName('field')?.text)) : null;
        case 'array_expression': {
            // `vec![..]` is rewritten to an array behind an empty block comment (see macroEdit)
            if (n.previousSibling?.type === 'block_comment' && n.previousSibling.text === '/**/') return 'Vec<_>';
            return null;
        }
        case 'struct_expression': { const t = n.childForFieldName('name'); return t && /^[A-Z]/.test(t.text) && t.text !== 'Self' ? t.text.split('::').pop() : null; }
        case 'reference_expression': {
            const inner = n.childForFieldName('value');
            if (!inner) return null;
            const mut = n.namedChildren.some(c => c.type === 'mutable_specifier') ? 'mut ' : '';
            if (inner.type === 'index_expression' && inner.namedChildren[1]?.type === 'range_expression') {
                const base = inner.namedChildren[0];
                const bt = base.type === 'string_literal' && /^br?[#"]/.test(base.text) ? '[u8; _]' : rustArgType(base, look);
                const sl = bt ? sliceOf(bt) : null;
                return sl ? `&${mut}${sl}` : null;
            }
            const t = rustArgType(inner, look);
            return t && t !== '_' ? `&${mut}${t}` : null;
        }
        case 'call_expression': {
            const fn = n.childForFieldName('function');
            const args = n.childForFieldName('arguments')?.namedChildren.filter(c => !/comment/.test(c.type)) ?? [];
            if (fn?.type === 'identifier') return fn.text === 'format' && n.text[fn.endIndex - n.startIndex] === ' ' ? 'String' : null; // `format!(…)`, rewritten to `format (…)`
            if (fn?.type === 'generic_function') return rustCtorType(fn.childForFieldName('function'), args, look);
            if (fn?.type === 'scoped_identifier') return rustCtorType(fn, args, look);
            if (fn?.type === 'field_expression' && !args.length) {
                const m = fn.childForFieldName('field')?.text;
                const recv = fn.childForFieldName('value');
                if (m === 'to_string') return 'String';
                const rt = recv ? rustArgType(recv, look) : null;
                if (!rt || rt === '_') return null;
                const rp = parseTy(rt);
                if (m === 'clone') return rp.ref != null ? rp.to : rt;       // a reference to a Clone value clones the value
                if (m === 'into_bytes') return rp.head === 'String' ? 'Vec<u8>' : null;
                if (m === 'into_boxed_slice') return rp.head === 'Vec' && rp.args.length === 1 ? `Box<[${rp.args[0]}]>` : null;
                if (m === 'as_bytes') return rp.head === 'String' || rp.head === 'str' || (rp.ref != null && /^(String|str)$/.test(rp.to)) ? '&[u8]' : null;
                if (m === 'to_vec') return sliceOf(rt) && sliceOf(rt) !== 'str' ? `Vec<${sliceOf(rt).slice(1, -1)}>` : null;
            }
            return null;
        }
        default: return null;
    }
}

/** `Vec::new()`, `Vec::<u8>::with_capacity(n)`, `String::from(..)`, `Box::new(x)`, `Type::new(..)`: a value of the type named. */
function rustCtorType(fn, args, look) {
    const name = fn?.childForFieldName('name')?.text;
    const o = fn ? ctorOwner(fn) : null;
    if (!o || !name) return null;
    if (o.name === 'Box') return name === 'new' && args.length === 1 ? (() => { const t = rustArgType(args[0], look); return t && t !== '_' && !/^\{/.test(t) ? `Box<${t}>` : null; })() : null;
    if (o.name === 'Vec') return /^(new|with_capacity)$/.test(name) ? (o.args?.length === 1 ? `Vec<${o.args[0]}>` : 'Vec<_>') : null;
    if (o.name === 'String') return /^(new|from|with_capacity)$/.test(name) ? 'String' : null;
    if (WRAPPERS.has(o.name) || POINTER_TYPES.has(o.name) || PRIMITIVES.has(o.name)) return null;
    // by convention `Type::new(..)` / `Type::default()` / `Type::with_capacity(..)` build a Type, and `Type::from(x)` is `From::from`
    return /^(new|default|with_capacity|from)$/.test(name) ? o.name : null;
}

/** What a binding's declared or initial value says its type is, for the arguments it is later passed as. */
function bindingArgType(node, look) {
    if (node.type === 'let_declaration') {
        const t = node.childForFieldName('type');
        if (t) return /^_$/.test(t.text) ? null : normTy(t.text);
        const v = node.childForFieldName('value');
        const r = v ? rustArgType(v, look) : null;
        return r && r !== '_' && !/^\{/.test(r) ? r : null; // an unsuffixed literal's type is settled by what it is used for
    }
    if (node.type === 'parameter') { const t = node.childForFieldName('type'); return t ? normTy(t.text) : null; }
    return null;
}

function visibility(node) {
    const v = node.namedChildren.find(c => c.type === 'visibility_modifier');
    return v ? 'public' : 'private';
}

export const rust = {
    id: 'rust',
    grammar: 'rust',
    extensions: ['.rs'],
    family: 'rust',
    query: QUERY,
    implicitThis: false,
    selfNames: ['self'],
    externalReceivers: new Set(['std', 'core', 'alloc', 'fmt', 'io', 'mem', 'ptr', 'env', 'fs', 'thread', 'log', 'tracing']),
    builtinCalls: BUILTIN_MACROS,
    testFile: /(^|\/)(tests|benches)\/|_test\.rs$/,
    commentTypes: ['line_comment', 'block_comment'],
    skipBeforeDoc: new Set(['attribute_item', 'inner_attribute_item']),
    parseImport,
    rewriteSource: rewriteMacros,
    specForSource,
    receiverDescriptor: wrappedValue,
    typeParamBound,
    methodCallSteps: true,
    externalRoots: new Set(['std', 'core', 'alloc']),
    tupleTypes: true,
    shadowing: true,
    pathCalls: true,
    ownerOf: implOwner,
    implicitBases: implTrait,
    // the impl a method is declared in (`impl Cursor<Vec<u8>>`): methods of one name in impls of one
    // type are `#[cfg]` variants of one method, in impls of different types (or traits) methods of their own;
    // so are those of a generic trait given different type arguments (`impl From<A> for T`, `impl From<B> for T`)
    decoratorsOf: (node) => {
        const impl = (node.type === 'function_item' || node.type === 'function_signature_item') ? implOf(node) : null;
        const t = impl?.childForFieldName('type');
        const trait = impl?.childForFieldName('trait');
        const targs = trait?.type === 'generic_type' ? normTy(trait.childForFieldName('type_arguments')?.text) : null;
        return t ? ['impl ' + t.text.replace(/\s+/g, ' ') + (targs ? ' as ' + (typeHead(trait) ?? '') + targs : '')] : [];
    },
    traitPathCalls: true,
    argType: rustArgType,          // the types of a call's arguments, where the source shows them…
    bindingArgType,                // … of a local, from its declared type or its first value
    pickByArgs,                    // … tell impls of one trait for one type apart (`impl From<A> for T`, `impl From<B> for T`)
    refineKind(kind, d, parent) {
        if (kind === 'function' && implOwner(d.node)) return 'method';
        return kind;
    },
    isExported: (node) => node.namedChildren.some(c => c.type === 'visibility_modifier') || node.parent?.parent?.type === 'trait_item',
    visibility,
    isPrimitiveType: (t) => PRIMITIVES.has(t),
    markerTraits: MARKER_TRAITS,
    transparentTypes: new Set(['Box', 'Rc', 'Arc', 'Cow', 'RefCell', 'Cell', 'Mutex', 'RwLock', 'MutexGuard', 'RwLockReadGuard', 'RwLockWriteGuard', 'Ref', 'RefMut', 'Pin', 'Option', 'Result', 'Weak']),
    elementTypes: new Set(['Vec', 'VecDeque', 'HashSet', 'BTreeSet', 'BinaryHeap', 'LinkedList', 'IntoIter', 'Iter', 'IterMut', 'Drain']),
    elementMethods: new Set(['first', 'last', 'get', 'get_mut', 'first_mut', 'last_mut', 'pop', 'pop_front', 'pop_back', 'front', 'back', 'remove', 'swap_remove', 'next', 'peek', 'find']),
    mapTypes: new Set(['HashMap', 'BTreeMap', 'IndexMap', 'DashMap']),
    mapMethods: new Set(['get', 'get_mut', 'remove', 'insert']),
    mapValueMethods: new Set(['values', 'values_mut', 'into_values']),
    // calls that hand back (a view of) the same value: unwrap, clone, borrow, lock, iter …
    identityMethods: new Set(['unwrap', 'expect', 'unwrap_or_default', 'unwrap_or', 'unwrap_or_else', 'as_ref', 'as_mut', 'as_deref', 'as_deref_mut',
        'clone', 'borrow', 'borrow_mut', 'lock', 'read', 'write', 'to_owned', 'deref', 'deref_mut', 'cloned', 'copied', 'iter', 'iter_mut', 'into_iter', 'drain', 'upgrade',
        'get_mut', 'get_ref', 'into_inner', 'take',
        // pin-project's projections have the fields of the value they project (`self.project().inner`)
        'project', 'project_ref']),
    normalizeRefName(name, r) {
        if (r.node.type === 'macro_invocation') return BUILTIN_MACROS.has(name) ? null : name;
        // a type named by the path of `Type::item` / `Enum::Variant`, and a unit struct or constant
        // used as a value (`&Mmap`), are capitalised; modules and locals are not
        if ((r.kind === 'type' && r.node.type === 'scoped_identifier') || (r.kind === 'value' && r.node.type === 'identifier')) {
            if (!/^[A-Z]/.test(name)) return null;
            // the last segment of a path (`Value::Number`) is the path's own reference
            if (r.kind === 'value' && (r.nameNode.parent?.type === 'scoped_identifier' || r.nameNode.parent?.type === 'scoped_type_identifier')) return null;
            for (let p = r.nameNode.parent; p; p = p.parent) if (p.type === 'token_tree' || p.type === 'use_declaration' || p.type === 'attribute_item' || p.type === 'macro_definition') return null;
        }
        return name;
    },
    bodyField: 'body',
};
