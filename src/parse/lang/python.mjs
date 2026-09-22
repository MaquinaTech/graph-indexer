/** Python extraction spec. See ../extract.mjs for the capture convention. */

const QUERY = `
(function_definition name: (identifier) @name return_type: (type) @type) @def.function
(function_definition name: (identifier) @name) @def.function
(class_definition name: (identifier) @name) @def.class
(module (expression_statement (assignment left: (identifier) @name)) @def.variable)
(class_definition body: (block (expression_statement (assignment left: (identifier) @name type: (type) @type)) @def.field))
(class_definition body: (block (expression_statement (assignment left: (identifier) @name)) @def.field))

(call function: (identifier) @name) @ref.call
(call function: (attribute object: (_) @recv attribute: (identifier) @name)) @ref.call
(class_definition superclasses: (argument_list (identifier) @name)) @ref.inherit
(class_definition superclasses: (argument_list (attribute object: (_) @recv attribute: (identifier) @name))) @ref.inherit
(decorator (identifier) @name) @ref.decorator
(decorator (attribute object: (_) @recv attribute: (identifier) @name)) @ref.decorator
(decorator (call function: (identifier) @name)) @ref.decorator
(decorator (call function: (attribute object: (_) @recv attribute: (identifier) @name))) @ref.decorator
(type (identifier) @name) @ref.type
(type (attribute object: (_) @recv attribute: (identifier) @name)) @ref.type
(type (generic_type (identifier) @name)) @ref.type
(type (generic_type (type_parameter (type (identifier) @name)))) @ref.type
(argument_list (identifier) @name) @ref.value
(keyword_argument value: (identifier) @name) @ref.value
(list (identifier) @name) @ref.value

[(lambda) (list_comprehension) (set_comprehension) (dictionary_comprehension) (generator_expression)] @scope
(return_statement (_) @ret)
(import_statement) @import
(import_from_statement) @import

(assignment left: (identifier) @bind.name right: (_) @bind.expr) @bind
(assignment left: (identifier) @bind.name type: (type) @bind.type) @bind
(typed_parameter (identifier) @bind.name type: (type) @bind.type) @bind
(typed_default_parameter name: (identifier) @bind.name type: (type) @bind.type) @bind
(for_statement left: (identifier) @bind.name right: (_) @bind.elem) @bind
(for_in_clause left: (identifier) @bind.name right: (_) @bind.elem) @bind
(with_item value: (as_pattern (_) @bind.expr alias: (as_pattern_target (identifier) @bind.name))) @bind
(assignment left: (attribute object: (identifier) @_self attribute: (identifier) @field.name) right: (_) @field.expr (#eq? @_self "self")) @field
(assignment left: (attribute object: (identifier) @_self attribute: (identifier) @field.name) type: (type) @field.type (#eq? @_self "self")) @field
(class_definition body: (block (expression_statement (assignment left: (identifier) @field.name type: (type) @field.type)) @field))
`;

const BUILTIN_CALLS = new Set([
    'print', 'len', 'range', 'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr', 'delattr', 'super',
    'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'frozenset', 'bytes', 'bytearray', 'type',
    'object', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'min', 'max', 'sum', 'any', 'all',
    'abs', 'round', 'repr', 'hash', 'id', 'iter', 'next', 'open', 'callable', 'vars', 'dir', 'format',
    'staticmethod', 'classmethod', 'property', 'NotImplementedError', 'ValueError', 'TypeError', 'KeyError',
    'RuntimeError', 'Exception', 'AttributeError', 'IndexError', 'StopIteration', 'AssertionError', 'OSError',
    'IOError', 'ImportError', 'NameError', 'ZeroDivisionError', 'PermissionError', 'FileNotFoundError',
]);
const EXTERNAL_RECEIVERS = new Set(['os', 'sys', 're', 'json', 'math', 'time', 'datetime', 'logging', 'logger',
    'log', 'typing', 'collections', 'itertools', 'functools', 'asyncio', 'subprocess', 'shutil', 'pathlib', 'random',
    'np', 'pd', 'torch', 'tf', 'pytest', 'unittest', 'mock', 'warnings', 'inspect', 'copy', 'pickle', 'uuid', 'base64',
    'hashlib', 'threading', 'contextlib', 'dataclasses', 'enum', 'abc', 'io', 'tempfile', 'glob', 'string', 'decimal']);
const PRIMITIVES = new Set(['str', 'int', 'float', 'bool', 'bytes', 'None', 'Any', 'object', 'list', 'dict', 'set',
    'tuple', 'List', 'Dict', 'Set', 'Tuple', 'Optional', 'Union', 'Callable', 'Iterable', 'Iterator', 'Sequence',
    'Mapping', 'Type', 'Generator', 'AsyncGenerator', 'Awaitable', 'Coroutine', 'Literal', 'ClassVar', 'Self']);

function stripDocString(t) {
    return t.replace(/^[rRbBuUfF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '')
        .split('\n').map(l => l.trim()).filter(Boolean).join(' ');
}

function docOf(defNode) {
    const body = defNode.childForFieldName('body');
    const first = body?.namedChild(0);
    if (first?.type === 'expression_statement') {
        const s = first.namedChild(0);
        if (s?.type === 'string') return stripDocString(s.text);
    }
    return null; // fall back to comments above
}

function dotted(node) { return node ? node.text.replace(/\s+/g, '') : null; }

function parseImport(node) {
    const out = [];
    if (node.type === 'import_statement') {
        for (const c of node.namedChildren) {
            if (c.type === 'dotted_name') {
                const mod = dotted(c);
                out.push({ source: mod, imported: '*', local: mod });
            } else if (c.type === 'aliased_import') {
                const mod = dotted(c.childForFieldName('name'));
                out.push({ source: mod, imported: '*', local: c.childForFieldName('alias')?.text || mod });
            }
        }
    } else if (node.type === 'import_from_statement') {
        const modNode = node.childForFieldName('module_name');
        const source = dotted(modNode) || '.';
        let any = false;
        for (const c of node.namedChildren) {
            if (c === modNode || c.id === modNode?.id) continue;
            if (c.type === 'dotted_name') { const n = dotted(c); out.push({ source, imported: n, local: n.split('.').pop() }); any = true; }
            else if (c.type === 'aliased_import') {
                const n = dotted(c.childForFieldName('name'));
                out.push({ source, imported: n, local: c.childForFieldName('alias')?.text || n }); any = true;
            } else if (c.type === 'wildcard_import') { out.push({ source, imported: '*', local: null, wildcard: true }); any = true; }
        }
        if (!any) out.push({ source, imported: null, local: null });
    }
    return out;
}

function isModuleLevel(node) {
    // (module (expression_statement (assignment)))
    return node.parent?.type === 'module';
}

export const python = {
    id: 'python',
    grammar: 'python',
    extensions: ['.py', '.pyi'],
    family: 'python',
    query: QUERY,
    implicitThis: false,
    selfNames: ['self', 'cls'],
    externalReceivers: EXTERNAL_RECEIVERS,
    builtinCalls: BUILTIN_CALLS,
    testFile: /(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/,
    commentTypes: ['comment'],
    docWrappers: new Set(['decorated_definition']),
    docOf,
    parseImport,
    isModuleLevel,
    isExported: (node, name) => !name.startsWith('_') || /^__\w+__$/.test(name),
    visibility: (node, name) => (name && name.startsWith('_') && !/^__\w+__$/.test(name) ? 'private' : null),
    isPrimitiveType: (t) => PRIMITIVES.has(t),
    isStatic: (node) => node.parent?.type === 'decorated_definition' && node.parent.namedChildren.some(c => c.type === 'decorator' && /^@(staticmethod|classmethod)\b/.test(c.text)),
    transparentTypes: new Set(['Optional', 'Final', 'ClassVar', 'Annotated', 'Type', 'type', 'Awaitable', 'Required', 'NotRequired', 'ReadOnly']),
    elementTypes: new Set(['list', 'List', 'Sequence', 'MutableSequence', 'Iterable', 'Iterator', 'AsyncIterable', 'AsyncIterator',
        'Generator', 'AsyncGenerator', 'set', 'Set', 'frozenset', 'FrozenSet', 'AbstractSet', 'MutableSet', 'Collection', 'Deque', 'deque', 'tuple', 'Tuple']),
    elementMethods: new Set(['pop', 'popleft']),
    decoratorsOf(node) {
        const p = node.parent;
        if (p?.type !== 'decorated_definition') return [];
        return p.namedChildren.filter(c => c.type === 'decorator').map(d => d.text.replace(/^@/, '').split('(')[0].trim()).slice(0, 8);
    },
    bodyField: 'body',
    signatureCleanup: (text) => text.replace(/:$/, ''),
};
