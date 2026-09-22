/** Kotlin extraction spec (fwcd/tree-sitter-kotlin; the grammar has no field names, so patterns are positional). */

const QUERY = `
(class_declaration (type_identifier) @name) @def.class
(object_declaration (type_identifier) @name) @def.object
(function_declaration (simple_identifier) @name (user_type (type_identifier) @type)) @def.function
(function_declaration (simple_identifier) @name) @def.function
(class_body (property_declaration (variable_declaration (simple_identifier) @name (user_type (type_identifier) @type))) @def.property)
(class_body (property_declaration (variable_declaration (simple_identifier) @name)) @def.property)
(source_file (property_declaration (variable_declaration (simple_identifier) @name)) @def.variable)
(class_parameter (binding_pattern_kind) (simple_identifier) @name (user_type (type_identifier) @type)) @def.property
(class_parameter (binding_pattern_kind) (simple_identifier) @name) @def.property
(type_alias (type_identifier) @name) @def.type
(enum_entry (simple_identifier) @name) @def.constant

(call_expression . (simple_identifier) @name) @ref.call
(call_expression . (navigation_expression (_) @recv . (navigation_suffix (simple_identifier) @name))) @ref.call
(delegation_specifier (constructor_invocation (user_type (type_identifier) @name))) @ref.inherit
(delegation_specifier (user_type (type_identifier) @name)) @ref.inherit
(user_type (type_identifier) @name) @ref.type
(annotation (user_type (type_identifier) @name)) @ref.decorator
(annotation (constructor_invocation (user_type (type_identifier) @name))) @ref.decorator
(value_argument (simple_identifier) @name) @ref.value
(callable_reference (simple_identifier) @name) @ref.value

(import_header) @import

(property_declaration (variable_declaration (simple_identifier) @bind.name (user_type (type_identifier) @bind.type))) @bind
(property_declaration (variable_declaration (simple_identifier) @bind.name) (call_expression . (simple_identifier) @bind.call)) @bind
(parameter (simple_identifier) @bind.name (user_type (type_identifier) @bind.type)) @bind
(class_parameter (simple_identifier) @field.name (user_type (type_identifier) @field.type)) @field
(class_body (property_declaration (variable_declaration (simple_identifier) @field.name (user_type (type_identifier) @field.type))) @field)
(class_body (property_declaration (variable_declaration (simple_identifier) @field.name) (call_expression . (simple_identifier) @field.call)) @field)
`;

const PRIMITIVES = new Set(['String', 'Int', 'Long', 'Double', 'Float', 'Boolean', 'Char', 'Byte', 'Short', 'Unit',
    'Any', 'Nothing', 'List', 'MutableList', 'Map', 'MutableMap', 'Set', 'MutableSet', 'Array', 'Pair', 'Triple',
    'Flow', 'StateFlow', 'MutableStateFlow', 'LiveData', 'MutableLiveData', 'Sequence']);

function parseImport(node) {
    const text = node.text.split('\n')[0].replace(/^import\s+/, '').replace(/;\s*$/, '').trim();
    const alias = /\s+as\s+(\w+)$/.exec(text);
    const path = text.replace(/\s+as\s+\w+$/, '').trim();
    if (path.endsWith('.*')) return [{ source: path.slice(0, -2), imported: '*', local: null, wildcard: true }];
    const parts = path.split('.');
    const name = parts.pop();
    return [{ source: parts.join('.'), imported: name, local: alias ? alias[1] : name }];
}

function modifiers(node) { return node.namedChildren.find(c => c.type === 'modifiers')?.text ?? ''; }

function fileInfo(root) {
    const pkg = root.namedChildren.find(c => c.type === 'package_header');
    return { package: pkg ? pkg.text.replace(/^package\s+/, '').trim() : null };
}

export const kotlin = {
    id: 'kotlin',
    grammar: 'kotlin',
    extensions: ['.kt', '.kts'],
    family: 'jvm',
    query: QUERY,
    implicitThis: true,
    selfNames: ['this'],
    externalReceivers: new Set(['Log', 'Timber', 'System', 'Math', 'println']),
    builtinCalls: new Set(['println', 'print', 'listOf', 'mutableListOf', 'mapOf', 'mutableMapOf', 'setOf', 'mutableSetOf',
        'arrayOf', 'emptyList', 'emptyMap', 'emptySet', 'require', 'requireNotNull', 'check', 'checkNotNull', 'error',
        'lazy', 'let', 'also', 'apply', 'run', 'with', 'repeat', 'TODO', 'assert', 'assertEquals', 'assertTrue', 'launch',
        'async', 'runBlocking', 'withContext', 'remember', 'mutableStateOf']),
    testFile: /(^|\/)src\/(test|androidTest)\/|Test\.kt$/,
    commentTypes: ['comment', 'multiline_comment', 'line_comment'],
    parseImport,
    isExported: (node) => !/\b(private|internal)\b/.test(modifiers(node)),
    visibility: (node) => { const m = modifiers(node); return /\bprivate\b/.test(m) ? 'private' : /\bprotected\b/.test(m) ? 'protected' : null; },
    isPrimitiveType: (t) => PRIMITIVES.has(t),
    refineKind(kind, d) {
        if (d.node.type === 'class_declaration') {
            const head = d.node.text.slice(0, d.node.text.indexOf(d.nameNode.text));
            if (/\binterface\b/.test(head)) return 'interface';
            if (/\benum\b/.test(head)) return 'enum';
        }
        return kind;
    },
    decoratorsOf(node) {
        const m = node.namedChildren.find(c => c.type === 'modifiers');
        return m ? m.namedChildren.filter(c => c.type === 'annotation').map(a => a.text.replace(/^@/, '').split('(')[0]).slice(0, 8) : [];
    },
    fileInfo,
    bodyField: null,
    signatureCleanup: (text) => text.replace(/\s*[{=].*$/s, ''),
};
