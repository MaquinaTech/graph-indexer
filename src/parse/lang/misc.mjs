/** Scala and CSS extraction specs. */

const SCALA_QUERY = `
(class_definition name: (identifier) @name) @def.class
(object_definition name: (identifier) @name) @def.object
(trait_definition name: (identifier) @name) @def.trait
(enum_definition name: (identifier) @name) @def.enum
(function_definition name: (identifier) @name return_type: [(type_identifier) @type (generic_type type: (type_identifier) @type)]) @def.function
(function_definition name: (identifier) @name) @def.function
(function_declaration name: (identifier) @name) @def.function
(val_definition pattern: (identifier) @name type: [(type_identifier) @type (generic_type type: (type_identifier) @type)]) @def.variable
(val_definition pattern: (identifier) @name) @def.variable
(var_definition pattern: (identifier) @name) @def.variable
(type_definition name: (type_identifier) @name) @def.type

(call_expression function: (identifier) @name) @ref.call
(call_expression function: (field_expression value: (_) @recv field: (identifier) @name)) @ref.call
(call_expression function: (generic_function function: (identifier) @name)) @ref.call
(instance_expression (type_identifier) @name) @ref.new
(instance_expression (generic_type type: (type_identifier) @name)) @ref.new
(extends_clause type: (type_identifier) @name) @ref.inherit
(extends_clause type: (generic_type type: (type_identifier) @name)) @ref.inherit
(type_identifier) @name @ref.type
(arguments (identifier) @name) @ref.value

(import_declaration) @import

(val_definition pattern: (identifier) @bind.name type: [(type_identifier) @bind.type (generic_type type: (type_identifier) @bind.type)]) @bind
(val_definition pattern: (identifier) @bind.name value: (instance_expression (type_identifier) @bind.new)) @bind
(val_definition pattern: (identifier) @bind.name value: (call_expression function: (identifier) @bind.call)) @bind
(parameter name: (identifier) @bind.name type: [(type_identifier) @bind.type (generic_type type: (type_identifier) @bind.type)]) @bind
(class_parameter name: (identifier) @field.name type: [(type_identifier) @field.type (generic_type type: (type_identifier) @field.type)]) @field
`;

function scalaImport(node) {
    const text = node.text.replace(/^import\s+/, '').trim();
    const brace = /^(.*)\.\{(.*)\}$/.exec(text);
    if (brace) {
        return brace[2].split(',').map(s => s.trim()).filter(Boolean).map(s => {
            const [n, a] = s.split(/\s*(?:=>|as)\s*/);
            return n === '_' || n === '*' ? { source: brace[1], imported: '*', local: null, wildcard: true } : { source: brace[1], imported: n, local: a || n };
        });
    }
    if (/\.(_|\*)$/.test(text)) return [{ source: text.replace(/\.(_|\*)$/, ''), imported: '*', local: null, wildcard: true }];
    const parts = text.split('.');
    const name = parts.pop();
    return [{ source: parts.join('.'), imported: name, local: name }];
}

export const scala = {
    id: 'scala',
    grammar: 'scala',
    extensions: ['.scala', '.sc'],
    family: 'jvm',
    query: SCALA_QUERY,
    implicitThis: true,
    selfNames: ['this'],
    externalReceivers: new Set(['System', 'Math', 'Future', 'Option', 'Some', 'Seq', 'List', 'Map', 'Set', 'Vector', 'Array', 'println']),
    builtinCalls: new Set(['println', 'print', 'require', 'assert', 'Some', 'None', 'Seq', 'List', 'Map', 'Set', 'Vector', 'Array', 'Option', 'Future']),
    testFile: /(^|\/)src\/test\/|(Spec|Test|Suite)\.scala$/,
    commentTypes: ['comment', 'block_comment'],
    parseImport: scalaImport,
    isExported: (node) => !/^\s*(private|protected)\b/.test(node.text),
    visibility: (node) => (/^\s*private\b/.test(node.text) ? 'private' : null),
    isPrimitiveType: (t) => /^(Int|Long|Double|Float|Boolean|Char|Byte|Short|Unit|String|Any|AnyRef|Nothing|Option|List|Seq|Map|Set|Vector|Array|Future)$/.test(t),
    transparentTypes: new Set(['Option', 'Some']),
    elementTypes: new Set(['List', 'Seq', 'IndexedSeq', 'Vector', 'Set', 'Array', 'Iterable', 'Iterator', 'ArrayBuffer', 'ListBuffer']),
    elementMethods: new Set(['head', 'last', 'apply', 'find', 'headOption', 'lastOption']),
    mapTypes: new Set(['Map', 'HashMap', 'TreeMap', 'mutable.Map']),
    mapMethods: new Set(['apply', 'get', 'getOrElse']),
    mapValueMethods: new Set(['values']),
    refineKind(kind, d, parent) {
        if (kind === 'variable' && parent && ['class', 'object', 'trait'].includes(parent.kind)) return 'field';
        return kind;
    },
    isModuleLevel: (node) => ['compilation_unit', 'template_body', 'package_clause'].includes(node.parent?.type ?? '') || node.parent?.parent?.type === 'package_clause',
    fileInfo(root) {
        const pkg = root.namedChildren.find(c => c.type === 'package_clause');
        return { package: pkg ? pkg.text.replace(/^package\s+/, '').split(/\s|\{/)[0] : null };
    },
    bodyField: 'body',
};

// CSS: selectors, custom properties and keyframes are the addressable units.
const CSS_QUERY = `
(stylesheet (rule_set (selectors) @name) @def.selector)
(keyframes_statement (keyframes_name) @name) @def.keyframes
(stylesheet (declaration (property_name) @name) @def.variable (#match? @name "^--"))
(rule_set (block (declaration (property_name) @name) @def.variable (#match? @name "^--")))
(call_expression (function_name) @_f (arguments (plain_value) @name) (#eq? @_f "var")) @ref.value
(import_statement) @import
`;

export const css = {
    id: 'css',
    grammar: 'css',
    extensions: ['.css', '.scss', '.less'],
    family: 'css',
    query: CSS_QUERY,
    implicitThis: false,
    selfNames: [],
    externalReceivers: new Set(),
    builtinCalls: new Set(),
    testFile: /$^/,
    commentTypes: ['comment'],
    parseImport(node) {
        const m = /["']([^"']+)["']|url\(([^)]+)\)/.exec(node.text);
        return m ? [{ source: (m[1] || m[2]).trim(), imported: '*', local: null }] : [];
    },
    isExported: () => true,
    visibility: null,
    isPrimitiveType: () => true,
    normalizeName: (name) => name.replace(/\s+/g, ' ').trim().slice(0, 120),
    bodyField: 'block',
};
