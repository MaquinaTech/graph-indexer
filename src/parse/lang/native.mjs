/** C and C++ extraction specs. */

const C_DEFS = `
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def.function
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @def.function
(function_definition declarator: (pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name)))) @def.function
(struct_specifier name: (type_identifier) @name body: (_)) @def.struct
(union_specifier name: (type_identifier) @name body: (_)) @def.struct
(enum_specifier name: (type_identifier) @name body: (_)) @def.enum
(type_definition declarator: (type_identifier) @name) @def.type
(type_definition declarator: (pointer_declarator declarator: (type_identifier) @name)) @def.type
(type_definition declarator: (function_declarator declarator: (parenthesized_declarator (pointer_declarator declarator: (type_identifier) @name)))) @def.type
(preproc_function_def name: (identifier) @name) @def.macro
(preproc_def name: (identifier) @name) @def.constant
(enumerator name: (identifier) @name) @def.constant
(field_declaration declarator: (field_identifier) @name) @def.field
(field_declaration declarator: (pointer_declarator declarator: (field_identifier) @name)) @def.field
`;

const C_REFS = `
(call_expression function: (identifier) @name) @ref.call
(call_expression function: (field_expression argument: (_) @recv field: (field_identifier) @name)) @ref.call
(type_identifier) @name @ref.type
(argument_list (identifier) @name) @ref.value
(init_declarator value: (identifier) @name) @ref.value
(initializer_list (identifier) @name) @ref.value
(preproc_include) @import
`;

const CPP_DEFS = `
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def.function
(function_definition declarator: (function_declarator declarator: (field_identifier) @name)) @def.method
(function_definition declarator: (function_declarator declarator: (qualified_identifier scope: (_) @owner name: (identifier) @name))) @def.method
(function_definition declarator: (function_declarator declarator: (qualified_identifier scope: (_) @owner name: (destructor_name) @name))) @def.method
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @def.function
(function_definition declarator: (reference_declarator (function_declarator declarator: (identifier) @name))) @def.function
(field_declaration declarator: (function_declarator declarator: (field_identifier) @name)) @def.method
(declaration declarator: (function_declarator declarator: (identifier) @name)) @def.function
(class_specifier name: (type_identifier) @name body: (_)) @def.class
(struct_specifier name: (type_identifier) @name body: (_)) @def.struct
(union_specifier name: (type_identifier) @name body: (_)) @def.struct
(enum_specifier name: (type_identifier) @name body: (_)) @def.enum
(namespace_definition name: (_) @name) @def.module
(alias_declaration name: (type_identifier) @name) @def.type
(type_definition declarator: (type_identifier) @name) @def.type
(preproc_function_def name: (identifier) @name) @def.macro
(field_declaration declarator: (field_identifier) @name) @def.field
(enumerator name: (identifier) @name) @def.constant
`;

const CPP_REFS = `
(call_expression function: (identifier) @name) @ref.call
(call_expression function: (field_expression argument: (_) @recv field: (field_identifier) @name)) @ref.call
(call_expression function: (qualified_identifier scope: (_) @recv name: (identifier) @name)) @ref.call
(call_expression function: (template_function name: (identifier) @name)) @ref.call
(new_expression type: (type_identifier) @name) @ref.new
(base_class_clause (type_identifier) @name) @ref.inherit
(base_class_clause (qualified_identifier name: (type_identifier) @name)) @ref.inherit
(type_identifier) @name @ref.type
(argument_list (identifier) @name) @ref.value
(preproc_include) @import
(declaration type: (type_identifier) @bind.type declarator: (identifier) @bind.name) @bind
(declaration type: (type_identifier) @bind.type declarator: (init_declarator declarator: (identifier) @bind.name)) @bind
(parameter_declaration type: (type_identifier) @bind.type declarator: [(identifier) @bind.name (pointer_declarator declarator: (identifier) @bind.name) (reference_declarator (identifier) @bind.name)]) @bind
(field_declaration type: (type_identifier) @field.type declarator: [(field_identifier) @field.name (pointer_declarator declarator: (field_identifier) @field.name)]) @field
`;

const C_BUILTINS = new Set(['printf', 'fprintf', 'sprintf', 'snprintf', 'malloc', 'calloc', 'realloc', 'free', 'memcpy',
    'memset', 'memmove', 'memcmp', 'strlen', 'strcpy', 'strncpy', 'strcmp', 'strncmp', 'strcat', 'strchr', 'strstr',
    'assert', 'sizeof', 'exit', 'abort', 'puts', 'putchar', 'fopen', 'fclose', 'fread', 'fwrite', 'fgets', 'fputs',
    'atoi', 'atof', 'strtol', 'strtod', 'va_start', 'va_end', 'va_arg', 'isdigit', 'isspace', 'isalpha', 'tolower',
    'toupper', 'abs', 'fabs', 'floor', 'ceil', 'pow', 'sqrt', 'static_cast', 'dynamic_cast', 'reinterpret_cast',
    'const_cast', 'move', 'forward', 'make_shared', 'make_unique']);

function parseInclude(node) {
    const p = node.childForFieldName('path');
    if (!p) return [];
    if (p.type === 'system_lib_string') return [{ source: p.text.replace(/^<|>$/g, ''), imported: '*', local: null, system: true }];
    return [{ source: p.text.replace(/^"|"$/g, ''), imported: '*', local: null }];
}

function cVisibility(node) {
    return node.namedChildren.some(c => c.type === 'storage_class_specifier' && c.text === 'static') ? 'private' : null;
}

const common = {
    implicitThis: false,
    selfNames: ['this'],
    externalReceivers: new Set(['std']),
    builtinCalls: C_BUILTINS,
    testFile: /(^|\/)(tests?|test_\w+)\/|_test\.(c|cc|cpp)$|(^|\/)test_[^/]*\.(c|cc|cpp)$/,
    commentTypes: ['comment'],
    parseImport: parseInclude,
    isExported: (node) => cVisibility(node) !== 'private',
    visibility: cVisibility,
    isPrimitiveType: (t) => /^(int|char|void|float|double|long|short|unsigned|signed|bool|size_t|u?int\d+_t|string|auto)$/.test(t),
    bodyField: 'body',
};

export const c = {
    ...common,
    id: 'c',
    grammar: 'c',
    extensions: ['.c', '.h'],
    family: 'c',
    query: C_DEFS + C_REFS,
};

export const cpp = {
    ...common,
    id: 'cpp',
    grammar: 'cpp',
    extensions: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.h++', '.c++', '.ipp', '.inl'],
    family: 'c',
    implicitThis: true,
    query: CPP_DEFS + CPP_REFS,
    cleanType: (t) => t.replace(/^(std|boost)::/, ''),
};
