/** Java extraction spec (Kotlin/Scala live in their own modules). */

const T = (cap) => `[(type_identifier) @${cap} (generic_type (type_identifier) @${cap}) (scoped_type_identifier (type_identifier) @${cap} .) (generic_type (scoped_type_identifier (type_identifier) @${cap} .))]`;

const JAVA_QUERY = `
(class_declaration name: (identifier) @name) @def.class
(class_declaration name: (identifier) @name superclass: (superclass (_) @type)) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(record_declaration name: (identifier) @name) @def.class
(annotation_type_declaration name: (identifier) @name) @def.interface
(method_declaration type: (_) @type name: (identifier) @name) @def.method
(method_declaration name: (identifier) @name) @def.method
(constructor_declaration name: (identifier) @name) @def.constructor
(field_declaration type: (_) @type declarator: (variable_declarator name: (identifier) @name)) @def.field
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @def.field
(enum_constant name: (identifier) @name) @def.constant

(method_invocation !object name: (identifier) @name) @ref.call
(method_invocation object: (_) @recv name: (identifier) @name) @ref.call
(object_creation_expression type: ${T('name')}) @ref.new
(superclass ${T('name')}) @ref.inherit
(super_interfaces (type_list ${T('name')})) @ref.inherit
(extends_interfaces (type_list ${T('name')})) @ref.inherit
(type_identifier) @name @ref.type
(marker_annotation name: (identifier) @name) @ref.decorator
(annotation name: (identifier) @name) @ref.decorator
(method_reference . (identifier) @recv (identifier) @name) @ref.value
(argument_list (identifier) @name) @ref.value

(lambda_expression) @scope
(return_statement (_) @ret)
(import_declaration) @import

(local_variable_declaration type: (_) @bind.type declarator: (variable_declarator name: (identifier) @bind.name)) @bind
(local_variable_declaration declarator: (variable_declarator name: (identifier) @bind.name value: (object_creation_expression type: ${T('bind.new')}))) @bind
(local_variable_declaration declarator: (variable_declarator name: (identifier) @bind.name value: (_) @bind.expr)) @bind
(formal_parameter type: (_) @bind.type name: (identifier) @bind.name) @bind
(enhanced_for_statement type: (_) @bind.type name: (identifier) @bind.name value: (_) @bind.elem) @bind
(field_declaration type: (_) @field.type declarator: (variable_declarator name: (identifier) @field.name)) @field
`;

const JAVA_BUILTIN_TYPES = new Set(['String', 'Object', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Character',
    'Byte', 'Short', 'Void', 'List', 'Map', 'Set', 'Collection', 'Optional', 'Stream', 'Iterable', 'Iterator',
    'ArrayList', 'HashMap', 'HashSet', 'LinkedList', 'Arrays', 'Collections', 'Objects', 'Math', 'System',
    'StringBuilder', 'Exception', 'RuntimeException', 'Throwable', 'Class', 'Thread', 'Override', 'Deprecated',
    'SuppressWarnings', 'FunctionalInterface']);

function javaImport(node) {
    const text = node.text.replace(/^import\s+(static\s+)?/, '').replace(/;\s*$/, '').trim();
    const isStatic = /^import\s+static/.test(node.text);
    if (text.endsWith('.*')) return [{ source: text.slice(0, -2), imported: '*', local: null, wildcard: true, static: isStatic }];
    const parts = text.split('.');
    const name = parts.pop();
    return [{ source: parts.join('.'), imported: name, local: name, static: isStatic }];
}

function modifiersText(node) {
    const m = node.namedChildren.find(c => c.type === 'modifiers');
    return m ? m.text : '';
}

function javaFileInfo(root) {
    const pkg = root.namedChildren.find(c => c.type === 'package_declaration');
    return { package: pkg ? pkg.text.replace(/^package\s+/, '').replace(/;\s*$/, '').trim() : null };
}

export const java = {
    id: 'java',
    grammar: 'java',
    extensions: ['.java'],
    family: 'jvm',
    query: JAVA_QUERY,
    implicitThis: true,
    selfNames: ['this'],
    externalReceivers: new Set(['System', 'Math', 'Arrays', 'Collections', 'Objects', 'String', 'Integer', 'Long',
        'Double', 'Boolean', 'Optional', 'Stream', 'Collectors', 'LoggerFactory', 'log', 'logger', 'LOG', 'LOGGER',
        'Assertions', 'Assert', 'Mockito', 'assertThat']),
    builtinCalls: new Set(['assertEquals', 'assertTrue', 'assertFalse', 'assertNotNull', 'assertNull', 'assertThat',
        'when', 'verify', 'mock', 'any', 'eq', 'println', 'printf', 'format', 'valueOf', 'toString', 'equals',
        'hashCode', 'getClass', 'super', 'this']),
    testFile: /(^|\/)src\/test\/|Tests?\.java$|IT\.java$/,
    commentTypes: ['block_comment', 'line_comment'],
    parseImport: javaImport,
    isExported: (node) => /\bpublic\b/.test(modifiersText(node)) || node.parent?.type === 'interface_body',
    visibility: (node) => { const m = modifiersText(node); return /\bprivate\b/.test(m) ? 'private' : /\bprotected\b/.test(m) ? 'protected' : /\bpublic\b/.test(m) ? 'public' : null; },
    isPrimitiveType: (t) => JAVA_BUILTIN_TYPES.has(t) || /^(int|long|double|float|boolean|char|byte|short|void)$/.test(t),
    elementTypes: new Set(['List', 'ArrayList', 'LinkedList', 'Collection', 'Set', 'HashSet', 'TreeSet', 'LinkedHashSet', 'SortedSet', 'NavigableSet',
        'Iterable', 'Iterator', 'Stream', 'Queue', 'Deque', 'ArrayDeque', 'PriorityQueue', 'Vector', 'CopyOnWriteArrayList', 'BlockingQueue']),
    elementMethods: new Set(['get', 'getFirst', 'getLast', 'peek', 'poll', 'pop', 'element', 'first', 'last', 'next', 'remove', 'take']),
    mapTypes: new Set(['Map', 'HashMap', 'TreeMap', 'LinkedHashMap', 'ConcurrentHashMap', 'SortedMap', 'NavigableMap', 'ConcurrentMap', 'EnumMap']),
    mapMethods: new Set(['get', 'getOrDefault', 'remove', 'put', 'putIfAbsent', 'computeIfAbsent', 'compute', 'merge']),
    mapValueMethods: new Set(['values']),
    decoratorsOf(node) {
        const m = node.namedChildren.find(c => c.type === 'modifiers');
        if (!m) return [];
        return m.namedChildren.filter(c => c.type === 'annotation' || c.type === 'marker_annotation')
            .map(a => a.childForFieldName('name')?.text).filter(Boolean).slice(0, 8);
    },
    fileInfo: javaFileInfo,
    bodyField: 'body',
};
