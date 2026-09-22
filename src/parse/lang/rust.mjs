/** Rust extraction spec. `impl Type { fn m() }` methods are qualified as Type.m. */

const TH = (cap) => `[(type_identifier) @${cap} (generic_type type: (type_identifier) @${cap}) (scoped_type_identifier name: (type_identifier) @${cap}) (reference_type type: (type_identifier) @${cap}) (reference_type type: (generic_type type: (type_identifier) @${cap}))]`;

const QUERY = `
(function_item name: (identifier) @name return_type: ${TH('type')}) @def.function
(function_item name: (identifier) @name) @def.function
(function_signature_item name: (identifier) @name return_type: ${TH('type')}) @def.function
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
(field_declaration name: (field_identifier) @name type: ${TH('type')}) @def.field
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
(impl_item trait: ${TH('name')}) @ref.inherit
(trait_item bounds: (trait_bounds ${TH('name')})) @ref.inherit
(arguments (identifier) @name) @ref.value
(arguments (scoped_identifier path: (_) @recv name: (identifier) @name)) @ref.value

(use_declaration) @import

(let_declaration pattern: (identifier) @bind.name type: ${TH('bind.type')}) @bind
(let_declaration pattern: (mut_pattern (identifier) @bind.name) type: ${TH('bind.type')}) @bind
(let_declaration pattern: (identifier) @bind.name value: (struct_expression name: (type_identifier) @bind.new)) @bind
(let_declaration pattern: (identifier) @bind.name value: (call_expression function: (scoped_identifier path: (identifier) @bind.new name: (identifier) @_ctor))) @bind
(let_declaration pattern: (mut_pattern (identifier) @bind.name) value: (call_expression function: (scoped_identifier path: (identifier) @bind.new name: (identifier) @_ctor))) @bind
(let_declaration pattern: (identifier) @bind.name value: (call_expression function: (identifier) @bind.call)) @bind
(parameter pattern: (identifier) @bind.name type: ${TH('bind.type')}) @bind
`;

const PRIMITIVES = new Set(['i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
    'f32', 'f64', 'bool', 'char', 'str', 'String', 'Self', 'Option', 'Result', 'Vec', 'Box', 'Rc', 'Arc', 'RefCell',
    'Cell', 'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet', 'Cow', 'Mutex', 'RwLock', 'Pin', 'PhantomData']);
const BUILTIN_MACROS = new Set(['println', 'print', 'eprintln', 'eprint', 'format', 'vec', 'panic', 'assert',
    'assert_eq', 'assert_ne', 'debug_assert', 'debug_assert_eq', 'write', 'writeln', 'unreachable', 'unimplemented',
    'todo', 'matches', 'include_str', 'include_bytes', 'concat', 'stringify', 'env', 'cfg', 'dbg', 'format_args', 'Ok',
    'Err', 'Some', 'None', 'Box', 'Default', 'drop', 'Into', 'From']);

function implOwner(node) {
    // function_item inside (impl_item body: (declaration_list ...))
    const list = node.parent;
    const impl = list?.parent;
    if (list?.type === 'declaration_list' && impl?.type === 'impl_item') {
        const t = impl.childForFieldName('type');
        if (!t) return null;
        if (t.type === 'type_identifier') return t.text;
        const inner = t.childForFieldName('type') ?? t.childForFieldName('name');
        return inner?.type === 'type_identifier' ? inner.text : t.text.replace(/<.*$/s, '').split('::').pop();
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
    ownerOf: implOwner,
    refineKind(kind, d, parent) {
        if (kind === 'function' && implOwner(d.node)) return 'method';
        return kind;
    },
    isExported: (node) => node.namedChildren.some(c => c.type === 'visibility_modifier') || node.parent?.parent?.type === 'trait_item',
    visibility,
    isPrimitiveType: (t) => PRIMITIVES.has(t),
    normalizeRefName: (name, r) => (r.node.type === 'macro_invocation' ? (BUILTIN_MACROS.has(name) ? null : name) : name),
    bodyField: 'body',
};
