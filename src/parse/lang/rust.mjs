/** Rust extraction spec. `impl Type { fn m() }` methods are qualified as Type.m. */

const TH = (cap) => `[(type_identifier) @${cap} (generic_type type: (type_identifier) @${cap}) (scoped_type_identifier path: (_) @recv name: (type_identifier) @${cap}) (reference_type type: (type_identifier) @${cap}) (reference_type type: (generic_type type: (type_identifier) @${cap}))]`;
// a whole type (normalizeType unwraps references, Box/Rc/Arc/Option/Result, and sees Vec<T> as T[])
const TW = (cap) => `[(type_identifier) (generic_type) (scoped_type_identifier) (reference_type) (array_type) (pointer_type) (tuple_type)] @${cap}`;

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

function implOwner(node) {
    // function_item inside (impl_item body: (declaration_list ...))
    const list = node.parent;
    const impl = list?.parent;
    if (list?.type === 'declaration_list' && impl?.type === 'impl_item') return typeHead(impl.childForFieldName('type'));
    return null;
}

// bounds that say nothing about the methods a value has
const MARKER_TRAITS = new Set(['Copy', 'Clone', 'Send', 'Sync', 'Sized', 'Unpin', 'Debug', 'Display', 'Default', 'Eq', 'PartialEq',
    'Hash', 'Ord', 'PartialOrd', 'Any', 'UnwindSafe', 'RefUnwindSafe']);
const GENERIC_ITEMS = new Set(['function_item', 'function_signature_item', 'impl_item', 'trait_item', 'struct_item', 'enum_item']);

/**
 * The trait a type parameter in scope at `node` is bound by (`fn f<R: Read>(r: &mut R)`,
 * `impl<W, F: Formatter> Serializer<W, F>`, `where R: Read<'de>`), so `r.read()` and `R::read(x)`
 * reach the trait's method; null when `name` is no type parameter there or its bounds are markers.
 */
function typeParamBound(node, name) {
    for (let n = node; n; n = n.parent) {
        if (!GENERIC_ITEMS.has(n.type)) continue;
        let declared = false, bound = null;
        const take = (bounds) => { for (const b of bounds?.namedChildren ?? []) { const h = typeHead(b.type === 'higher_ranked_trait_bound' ? b.childForFieldName('type') : b); if (h && !MARKER_TRAITS.has(h)) { bound ??= b.text; break; } } };
        for (const p of n.childForFieldName('type_parameters')?.namedChildren ?? []) {
            if (p.type !== 'type_parameter' || p.childForFieldName('name')?.text !== name) continue;
            declared = true;
            take(p.childForFieldName('bounds'));
        }
        for (const w of n.namedChildren.find(c => c.type === 'where_clause')?.namedChildren ?? []) {
            if (w.type === 'where_predicate' && w.childForFieldName('left')?.text === name) { declared ||= GENERIC_ITEMS.has(n.type); take(w.childForFieldName('bounds')); }
        }
        if (declared) return bound;
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
        edit = { from: node.startIndex, to: bang + 1, text: blank(text.slice(node.startIndex, bang + 1)) };
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
    if (node.type !== 'call_expression') return undefined;
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'scoped_identifier') return undefined;
    const owner = fn.childForFieldName('path')?.text.split('::').pop();
    if (!WRAPPERS.has(owner) || !WRAP_CTORS.has(fn.childForFieldName('name')?.text)) return undefined;
    const args = node.childForFieldName('arguments')?.namedChildren.filter(c => !c.type.endsWith('comment')) ?? [];
    return args.length === 1 ? describe(args[0]) : undefined;
}

/**
 * A file whose own crate defines a type named like a transparent wrapper (tokio's `Mutex`,
 * `RwLock`, `Semaphore`…) keeps that type: `inner: Mutex<Inner>` is tokio's Mutex, whose
 * methods (`get_mut`, `lock`) are the repository's, not a view of Inner.
 */
function specForSource(source) {
    let shadowed = null;
    for (const t of rust.transparentTypes) {
        if (!source.includes(t)) continue;
        const own = new RegExp(`\\b(?:struct|enum|type|trait|union)\\s+${t}\\b|\\buse\\s+(?:crate|self|super)::[^;]*\\b${t}\\b[^;]*;`).test(source);
        if (own) (shadowed ??= new Set()).add(t);
    }
    if (!shadowed) return null;
    return { ...rust, transparentTypes: new Set([...rust.transparentTypes].filter(t => !shadowed.has(t))) };
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
    tupleTypes: true,
    shadowing: true,
    pathCalls: true,
    ownerOf: implOwner,
    refineKind(kind, d, parent) {
        if (kind === 'function' && implOwner(d.node)) return 'method';
        return kind;
    },
    isExported: (node) => node.namedChildren.some(c => c.type === 'visibility_modifier') || node.parent?.parent?.type === 'trait_item',
    visibility,
    isPrimitiveType: (t) => PRIMITIVES.has(t),
    transparentTypes: new Set(['Box', 'Rc', 'Arc', 'Cow', 'RefCell', 'Cell', 'Mutex', 'RwLock', 'MutexGuard', 'RwLockReadGuard', 'RwLockWriteGuard', 'Ref', 'RefMut', 'Pin', 'Option', 'Result', 'Weak']),
    elementTypes: new Set(['Vec', 'VecDeque', 'HashSet', 'BTreeSet', 'BinaryHeap', 'LinkedList', 'IntoIter', 'Iter', 'IterMut', 'Drain']),
    elementMethods: new Set(['first', 'last', 'get', 'get_mut', 'first_mut', 'last_mut', 'pop', 'pop_front', 'pop_back', 'front', 'back', 'remove', 'swap_remove', 'next', 'peek', 'find']),
    mapTypes: new Set(['HashMap', 'BTreeMap', 'IndexMap', 'DashMap']),
    mapMethods: new Set(['get', 'get_mut', 'remove', 'insert']),
    mapValueMethods: new Set(['values', 'values_mut', 'into_values']),
    // calls that hand back (a view of) the same value: unwrap, clone, borrow, lock, iter …
    identityMethods: new Set(['unwrap', 'expect', 'unwrap_or_default', 'unwrap_or', 'unwrap_or_else', 'as_ref', 'as_mut', 'as_deref', 'as_deref_mut',
        'clone', 'borrow', 'borrow_mut', 'lock', 'read', 'write', 'to_owned', 'deref', 'deref_mut', 'cloned', 'copied', 'iter', 'iter_mut', 'into_iter', 'drain', 'upgrade',
        'get_mut', 'get_ref', 'into_inner', 'take']),
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
