/** C# extraction spec. */

const T = (cap) => `[(identifier) @${cap} (generic_name (identifier) @${cap}) (qualified_name name: (identifier) @${cap}) (qualified_name name: (generic_name (identifier) @${cap})) (nullable_type (identifier) @${cap})]`;

const QUERY = `
(class_declaration name: (identifier) @name) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(struct_declaration name: (identifier) @name) @def.struct
(enum_declaration name: (identifier) @name) @def.enum
(record_declaration name: (identifier) @name) @def.class
(delegate_declaration name: (identifier) @name) @def.type
(method_declaration returns: (_) @type name: (identifier) @name) @def.method
(method_declaration name: (identifier) @name) @def.method
(constructor_declaration name: (identifier) @name) @def.constructor
(property_declaration type: (_) @type name: (identifier) @name) @def.property
(property_declaration name: (identifier) @name) @def.property
(field_declaration (variable_declaration type: (_) @type (variable_declarator name: (identifier) @name))) @def.field
(field_declaration (variable_declaration (variable_declarator name: (identifier) @name))) @def.field
(enum_member_declaration name: (identifier) @name) @def.constant

(invocation_expression function: (identifier) @name) @ref.call
(invocation_expression function: (generic_name (identifier) @name)) @ref.call
(invocation_expression function: (member_access_expression expression: (_) @recv name: [(identifier) @name (generic_name (identifier) @name)])) @ref.call
(object_creation_expression type: ${T('name')}) @ref.new
(base_list ${T('name')}) @ref.inherit
(base_list (primary_constructor_base_type type: ${T('name')})) @ref.inherit
(attribute name: ${T('name')}) @ref.decorator
(variable_declaration type: ${T('name')}) @ref.type
(parameter type: ${T('name')}) @ref.type
(method_declaration returns: ${T('name')}) @ref.type
(property_declaration type: ${T('name')}) @ref.type
(type_argument_list ${T('name')}) @ref.type
(typeof_expression type: ${T('name')}) @ref.type
(argument (identifier) @name) @ref.value

[(lambda_expression) (anonymous_method_expression)] @scope
(return_statement (_) @ret)
(using_directive) @import

(variable_declaration type: (_) @bind.type (variable_declarator name: (identifier) @bind.name)) @bind
(variable_declaration (variable_declarator name: (identifier) @bind.name (object_creation_expression type: ${T('bind.new')}))) @bind
(variable_declaration (variable_declarator name: (identifier) @bind.name (_) @bind.expr)) @bind
(parameter type: (_) @bind.type name: (identifier) @bind.name) @bind
(foreach_statement type: (_) @bind.type left: (identifier) @bind.name right: (_) @bind.elem) @bind
(field_declaration (variable_declaration type: (_) @field.type (variable_declarator name: (identifier) @field.name))) @field
(property_declaration type: (_) @field.type name: (identifier) @field.name) @field
`;

const BUILTIN = new Set(['string', 'String', 'int', 'long', 'bool', 'double', 'float', 'decimal', 'object', 'Object',
    'void', 'dynamic', 'List', 'Dictionary', 'IEnumerable', 'IList', 'ICollection', 'Task', 'Guid', 'DateTime',
    'TimeSpan', 'Exception', 'Func', 'Action', 'IReadOnlyList', 'IReadOnlyCollection', 'HashSet', 'Nullable',
    'CancellationToken', 'Array', 'Type', 'byte', 'char', 'short', 'uint', 'ulong']);

function usingImport(node) {
    const text = node.text.replace(/^global\s+/, '').replace(/^using\s+(static\s+)?/, '').replace(/;\s*$/, '').trim();
    const alias = /^(\w+)\s*=\s*(.+)$/.exec(text);
    if (alias) return [{ source: alias[2].trim(), imported: '*', local: alias[1] }];
    return [{ source: text, imported: '*', local: null, wildcard: true }];
}

function modifiers(node) { return node.namedChildren.filter(c => c.type === 'modifier').map(c => c.text).join(' '); }

function fileInfo(root) {
    const ns = [];
    (function walk(n, depth) {
        if (depth > 3) return;
        for (const c of n.namedChildren) {
            if (c.type === 'namespace_declaration' || c.type === 'file_scoped_namespace_declaration') ns.push(c.childForFieldName('name')?.text);
            else if (c.type === 'declaration_list') walk(c, depth + 1);
        }
    })(root, 0);
    return { package: ns.filter(Boolean)[0] ?? null };
}

export const csharp = {
    id: 'csharp',
    grammar: 'c_sharp',
    extensions: ['.cs'],
    family: 'dotnet',
    query: QUERY,
    implicitThis: true,
    selfNames: ['this'],
    externalReceivers: new Set(['Console', 'Math', 'String', 'Task', 'Enumerable', 'Guid', 'DateTime', 'Convert',
        'Assert', 'Mock', 'JsonSerializer', 'File', 'Path', 'Directory', 'Environment', 'Debug', 'Trace', '_logger', 'logger', 'Logger']),
    builtinCalls: new Set(['nameof', 'typeof', 'ToString', 'Equals', 'GetHashCode', 'GetType']),
    testFile: /(^|\/)(tests?|Tests?|[\w.]*\.Tests?)\/|Tests?\.cs$/,
    commentTypes: ['comment'],
    parseImport: usingImport,
    isExported: (node) => /\b(public|internal)\b/.test(modifiers(node)) || node.parent?.parent?.type === 'interface_declaration',
    visibility: (node) => { const m = modifiers(node); return /\bprivate\b/.test(m) ? 'private' : /\bprotected\b/.test(m) ? 'protected' : /\bpublic\b/.test(m) ? 'public' : null; },
    isPrimitiveType: (t) => BUILTIN.has(t),
    transparentTypes: new Set(['Task', 'ValueTask', 'Nullable']),
    elementTypes: new Set(['List', 'IList', 'IEnumerable', 'ICollection', 'IReadOnlyList', 'IReadOnlyCollection', 'HashSet', 'ISet', 'Queue', 'Stack',
        'LinkedList', 'Collection', 'ObservableCollection', 'ImmutableList', 'ImmutableArray', 'IAsyncEnumerable', 'IQueryable', 'Span', 'ReadOnlySpan', 'Memory']),
    elementMethods: new Set(['First', 'FirstOrDefault', 'Last', 'LastOrDefault', 'Single', 'SingleOrDefault', 'ElementAt', 'ElementAtOrDefault', 'Find', 'Dequeue', 'Peek', 'Pop']),
    decoratorsOf(node) {
        return node.namedChildren.filter(c => c.type === 'attribute_list')
            .flatMap(l => l.namedChildren.filter(a => a.type === 'attribute').map(a => a.childForFieldName('name')?.text))
            .filter(Boolean).slice(0, 8);
    },
    fileInfo,
    bodyField: 'body',
};
