/** Go extraction spec. Methods are qualified by their receiver type (Engine.Run). */

const RECV_TYPE = `[(type_identifier) @owner (pointer_type (type_identifier) @owner) (generic_type type: (type_identifier) @owner) (pointer_type (generic_type type: (type_identifier) @owner))]`;
// a whole (single) type; normalizeType reduces it to what member lookup needs (`[]*pkg.T` → T[])
const TYPE_HEAD = `[(type_identifier) (pointer_type) (qualified_type) (generic_type) (slice_type) (array_type) (map_type) (channel_type)] @type`;

const QUERY = `
(function_declaration name: (identifier) @name result: ${TYPE_HEAD}) @def.function
(function_declaration name: (identifier) @name result: (parameter_list . (parameter_declaration type: ${TYPE_HEAD}))) @def.function
(function_declaration name: (identifier) @name) @def.function
(method_declaration receiver: (parameter_list (parameter_declaration type: ${RECV_TYPE})) name: (field_identifier) @name result: ${TYPE_HEAD}) @def.method
(method_declaration receiver: (parameter_list (parameter_declaration type: ${RECV_TYPE})) name: (field_identifier) @name result: (parameter_list . (parameter_declaration type: ${TYPE_HEAD}))) @def.method
(method_declaration receiver: (parameter_list (parameter_declaration type: ${RECV_TYPE})) name: (field_identifier) @name) @def.method
(type_spec name: (type_identifier) @name type: (struct_type)) @def.struct
(type_spec name: (type_identifier) @name type: (interface_type)) @def.interface
(type_spec name: (type_identifier) @name type: [(type_identifier) (qualified_type) (function_type) (map_type) (slice_type) (array_type) (pointer_type) (generic_type) (channel_type)]) @def.type
(type_alias name: (type_identifier) @name) @def.type
(method_elem name: (field_identifier) @name) @def.method
(field_declaration name: (field_identifier) @name type: ${TYPE_HEAD}) @def.field
(field_declaration name: (field_identifier) @name) @def.field
(const_spec name: (identifier) @name) @def.constant
(var_spec name: (identifier) @name) @def.variable

(call_expression function: (identifier) @name) @ref.call
(call_expression function: (selector_expression operand: (_) @recv field: (field_identifier) @name)) @ref.call
(type_identifier) @name @ref.type
(qualified_type package: (package_identifier) @recv name: (type_identifier) @name) @ref.type
(composite_literal type: (type_identifier) @name) @ref.new
(composite_literal type: (qualified_type package: (package_identifier) @recv name: (type_identifier) @name)) @ref.new
(field_declaration_list (field_declaration !name type: [(type_identifier) @name (pointer_type (type_identifier) @name)])) @ref.inherit
(field_declaration_list (field_declaration !name type: [(qualified_type package: (package_identifier) @recv name: (type_identifier) @name) (pointer_type (qualified_type package: (package_identifier) @recv name: (type_identifier) @name))])) @ref.inherit
(interface_type (type_elem (type_identifier) @name)) @ref.inherit
(argument_list (identifier) @name) @ref.value
(argument_list (selector_expression operand: (identifier) @recv field: (field_identifier) @name)) @ref.value
(keyed_element (literal_element) (literal_element (identifier) @name)) @ref.value
(composite_literal type: [(map_type) (slice_type) (array_type)] body: (literal_value (keyed_element . (literal_element (identifier) @name)))) @ref.value
(composite_literal type: [(type_identifier) (qualified_type) (generic_type)] body: (literal_value (keyed_element . (literal_element (identifier) @name)))) @recv @ref.read
(selector_expression operand: (_) @recv field: (field_identifier) @name) @ref.read

(func_literal) @scope
(return_statement (expression_list . (_) @ret))
(import_spec) @import

(short_var_declaration left: (expression_list . (identifier) @bind.name) right: (expression_list . (composite_literal type: (type_identifier) @bind.new))) @bind
(short_var_declaration left: (expression_list . (identifier) @bind.name) right: (expression_list . (unary_expression operand: (composite_literal type: (type_identifier) @bind.new)))) @bind
(short_var_declaration left: (expression_list . (identifier) @bind.name) right: (expression_list . (_) @bind.expr)) @bind
(var_spec name: (identifier) @bind.name value: (expression_list . (_) @bind.expr)) @bind
(for_statement (range_clause left: (expression_list . (_) . (identifier) @bind.name) right: (_) @bind.elem)) @bind
(var_spec name: (identifier) @bind.name type: ${TYPE_HEAD.replaceAll('@type', '@bind.type')}) @bind
(parameter_declaration name: (identifier) @bind.name type: ${TYPE_HEAD.replaceAll('@type', '@bind.type')}) @bind
`;

const BUILTIN_CALLS = new Set(['make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'panic', 'recover', 'print',
    'println', 'close', 'complex', 'real', 'imag', 'min', 'max', 'clear', 'string', 'int', 'int64', 'int32', 'uint',
    'uint64', 'uint32', 'float64', 'float32', 'byte', 'rune', 'bool', 'error', 'uintptr']);
const PRIMITIVES = new Set(['string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32',
    'uint64', 'uintptr', 'float32', 'float64', 'complex64', 'complex128', 'byte', 'rune', 'bool', 'error', 'any',
    'interface', 'map', 'chan', 'func']);

function parseImport(node) {
    const pathNode = node.childForFieldName('path');
    if (!pathNode) return [];
    const source = pathNode.text.replace(/^["`]|["`]$/g, '');
    const alias = node.childForFieldName('name')?.text;
    const local = alias && alias !== '_' && alias !== '.' ? alias : (alias === '.' ? null : source.split('/').pop().replace(/^go-|-go$/g, ''));
    return [{ source, imported: '*', local, wildcard: alias === '.' }];
}

function isModuleLevel(node) {
    // var_spec → var_declaration → source_file (or var_spec_list in between)
    let p = node.parent;
    if (p?.type === 'var_spec_list') p = p.parent;
    return p?.type === 'var_declaration' ? p.parent?.type === 'source_file' : p?.type === 'const_declaration' ? p.parent?.type === 'source_file' : true;
}

function docOf(defNode) {
    // type_spec lives inside a type_declaration; comments sit above the declaration
    return null;
}

function fileInfo(root) {
    const pkg = root.namedChildren.find(c => c.type === 'package_clause');
    return { package: pkg?.namedChildren[0]?.text ?? null };
}

export const go = {
    id: 'go',
    grammar: 'go',
    extensions: ['.go'],
    family: 'go',
    query: QUERY,
    implicitThis: false,
    selfNames: [],
    externalReceivers: new Set(['fmt', 'os', 'strings', 'strconv', 'errors', 'io', 'bytes', 'sync', 'time', 'context',
        'log', 'math', 'sort', 'regexp', 'filepath', 'reflect', 'atomic', 'bufio', 'unicode', 'utf8', 'json', 'xml',
        'hex', 'base64', 'rand', 'runtime', 'testing', 'assert', 'require', 'ioutil', 'url', 'unsafe']),
    builtinCalls: BUILTIN_CALLS,
    testFile: /_test\.go$|(^|\/)testdata\//,
    commentTypes: ['comment'],
    docWrappers: new Set(['type_declaration', 'const_declaration', 'var_declaration']),
    docOf,
    parseImport,
    isModuleLevel,
    isExported: (node, name) => /^[A-Z]/.test(name),
    visibility: (node, name) => (name && /^[a-z_]/.test(name) ? 'private' : null),
    isPrimitiveType: (t) => PRIMITIVES.has(t),
    // `(T, error)` results: the value is the first element
    mapIterValues: true, // `for _, v := range m` binds values
    cleanType: (t) => t.replace(/^\(\s*(?:\w+\s+)?([^,()]+?)\s*,\s*(?:\w+\s+)?error\s*\)$/s, '$1'),
    refineKind(kind, d, parent) {
        if (d.node.type === 'method_elem') return 'method';
        return kind;
    },
    fileInfo,
    bodyField: 'body',
};
