/**
 * JavaScript / TypeScript / TSX extraction specs.
 *
 * Captures follow the engine convention (see ../extract.mjs):
 *   @def.<kind> + @name [+ @owner]        a definition
 *   @ref.<kind> + @name [+ @recv]         a reference (call/new/type/inherit/decorator/value)
 *   @import                               an import/export-from statement (parsed by the hook)
 *   @import.require + @src                a CommonJS require() call
 *   @bind + @bind.name + @bind.(type|new|call|expr|elem)    local variable → type evidence
 *   @field + @field.name + @field.(type|new|expr)           class field → type evidence
 * (`expr` = the initialiser expression, `elem` = a collection whose element the name is bound to)
 */

const DEFS_COMMON = `
(function_declaration name: (identifier) @name) @def.function
(generator_function_declaration name: (identifier) @name) @def.function
(class_declaration name: (_) @name) @def.class
(class name: (_) @name) @def.class
(method_definition name: (_) @name) @def.method
(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)]) @def.function)
(variable_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)]) @def.function)
(variable_declarator name: (identifier) @name value: (class)) @def.class
(lexical_declaration (variable_declarator name: (identifier) @name value: (_) @_v) @def.variable (#not-match? @_v "^(async\\\\s*)?(function|\\\\(|[A-Za-z_$][A-Za-z0-9_$]*\\\\s*=>)"))
(variable_declaration (variable_declarator name: (identifier) @name value: (_) @_v) @def.variable (#not-match? @_v "^(async\\\\s*)?(function|\\\\(|[A-Za-z_$][A-Za-z0-9_$]*\\\\s*=>)"))
(assignment_expression
  left: (member_expression
    object: (member_expression object: (identifier) @owner property: (property_identifier) @_proto)
    property: (property_identifier) @name)
  right: [(function_expression) (arrow_function)]
  (#eq? @_proto "prototype")) @def.method
(expression_statement (assignment_expression
  left: (member_expression object: (identifier) @owner property: (property_identifier) @name)
  right: [(function_expression) (arrow_function)])) @def.function
(expression_statement (assignment_expression
  left: (member_expression object: (member_expression object: (identifier) @_m property: (property_identifier) @_e) property: (property_identifier) @name)
  right: [(function_expression) (arrow_function)]
  (#eq? @_m "module") (#eq? @_e "exports"))) @def.function
(pair key: (property_identifier) @name value: [(function_expression) (arrow_function)]) @def.method
(export_statement "default" value: [(function_expression) (arrow_function) (object) (call_expression) (binary_expression) (class)] @name) @def.function
(export_statement "default" declaration: [(function_declaration !name) (class_declaration !name)] @name) @def.function
`;

const DEFS_JS = `
(field_definition property: (_) @name value: [(arrow_function) (function_expression)]) @def.method
(field_definition property: (_) @name) @def.field
`;

const DEFS_TS = `
(function_signature name: (identifier) @name) @def.function
(abstract_class_declaration name: (type_identifier) @name) @def.class
(interface_declaration name: (type_identifier) @name) @def.interface
(type_alias_declaration name: (type_identifier) @name) @def.type
(enum_declaration name: (identifier) @name) @def.enum
(internal_module name: (_) @name) @def.module
(module name: (_) @name) @def.module
(method_signature name: (_) @name) @def.method
(abstract_method_signature name: (_) @name) @def.method
(public_field_definition name: (_) @name value: [(arrow_function) (function_expression)]) @def.method
(public_field_definition name: (_) @name value: (class)) @def.class
(public_field_definition name: (_) @name) @def.field
(required_parameter (accessibility_modifier) pattern: (identifier) @name) @def.field
(required_parameter "readonly" pattern: (identifier) @name) @def.field
(optional_parameter (accessibility_modifier) pattern: (identifier) @name) @def.field
(property_signature name: (_) @name) @def.field
(function_declaration name: (identifier) @name return_type: (type_annotation (_) @type)) @def.function
(function_signature name: (identifier) @name return_type: (type_annotation (_) @type)) @def.function
(method_definition name: (_) @name return_type: (type_annotation (_) @type)) @def.method
(method_signature name: (_) @name return_type: (type_annotation (_) @type)) @def.method
(abstract_method_signature name: (_) @name return_type: (type_annotation (_) @type)) @def.method
(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function return_type: (type_annotation (_) @type))) @def.function)
(public_field_definition name: (_) @name type: (type_annotation (_) @type)) @def.field
(property_signature name: (_) @name type: (type_annotation (_) @type)) @def.field
(class_declaration name: (_) @name (class_heritage (extends_clause) @type)) @def.class
(abstract_class_declaration name: (_) @name (class_heritage (extends_clause) @type)) @def.class
(required_parameter (accessibility_modifier) pattern: (identifier) @name type: (type_annotation (_) @type)) @def.field
(required_parameter "readonly" pattern: (identifier) @name type: (type_annotation (_) @type)) @def.field
(optional_parameter (accessibility_modifier) pattern: (identifier) @name type: (type_annotation (_) @type)) @def.field
`;

const REFS_COMMON = `
(call_expression function: (identifier) @name) @ref.call
(call_expression function: (member_expression object: (_) @recv property: (_) @name)) @ref.call
(call_expression function: (await_expression (identifier) @name)) @ref.call
(call_expression function: (await_expression (member_expression object: (_) @recv property: (_) @name))) @ref.call
(new_expression constructor: (identifier) @name) @ref.new
(new_expression constructor: (member_expression object: (_) @recv property: (_) @name)) @ref.new
(decorator (identifier) @name) @ref.decorator
(decorator (call_expression function: (identifier) @name)) @ref.decorator
(decorator (call_expression function: (member_expression object: (_) @recv property: (_) @name))) @ref.decorator
(arguments (identifier) @name) @ref.value
(pair value: (identifier) @name) @ref.value
(array (identifier) @name) @ref.value
(shorthand_property_identifier) @name @ref.value
(member_expression object: (_) @recv property: (property_identifier) @name) @ref.read
(member_expression object: (identifier) @name) @ref.value
(binary_expression operator: "instanceof" right: (identifier) @name) @ref.type
(computed_property_name (identifier) @name) @ref.value
(computed_property_name (member_expression object: (_) @recv property: (property_identifier) @name)) @ref.read
(unary_expression operator: "typeof" argument: (identifier) @name) @ref.value
`;

const REFS_JSX = `
(jsx_opening_element name: (identifier) @name) @ref.call
(jsx_self_closing_element name: (identifier) @name) @ref.call
(jsx_opening_element name: (member_expression object: (_) @recv property: (_) @name)) @ref.call
(jsx_self_closing_element name: (member_expression object: (_) @recv property: (_) @name)) @ref.call
`;

const REFS_JS = `
(class_heritage (identifier) @name) @ref.inherit
(class_heritage (member_expression object: (_) @recv property: (_) @name)) @ref.inherit
`;

const REFS_TS = `
(extends_clause value: (identifier) @name) @ref.inherit
(extends_clause value: (member_expression object: (_) @recv property: (_) @name)) @ref.inherit
(implements_clause (type_identifier) @name) @ref.inherit
(implements_clause (generic_type name: (type_identifier) @name)) @ref.inherit
(extends_type_clause type: (type_identifier) @name) @ref.inherit
(extends_type_clause type: (generic_type name: (type_identifier) @name)) @ref.inherit
(type_identifier) @name @ref.type
(nested_type_identifier module: (_) @recv name: (type_identifier) @name) @ref.type
(type_query (identifier) @name) @ref.type
(type_query (member_expression object: (_) @recv property: (property_identifier) @name)) @ref.type
`;

const IMPORTS_COMMON = `
(import_statement) @import
(export_statement source: (string)) @import
(call_expression function: (identifier) @_req arguments: (arguments . (string) @src) (#eq? @_req "require")) @import.require

[(arrow_function) (function_expression) (generator_function)] @scope
(return_statement (_) @ret)
(arrow_function body: [(call_expression) (new_expression) (member_expression) (identifier) (await_expression) (parenthesized_expression) (this) (subscript_expression)] @ret)
`;

// `xs.forEach(x => …)`: the first callback parameter of an element-wise array method is an element.
const callbackParam = (param) => `(call_expression
  function: (member_expression object: (_) @bind.elem property: (property_identifier) @_m)
  arguments: (arguments . (arrow_function ${param}))
  (#match? @_m "^(forEach|map|filter|find|findLast|findIndex|findLastIndex|some|every|flatMap)$")) @bind`;

const BINDINGS_COMMON = `
(variable_declarator name: (identifier) @bind.name value: (_) @bind.expr) @bind
(for_in_statement left: (identifier) @bind.name "of" right: (_) @bind.elem) @bind
${callbackParam('parameter: (identifier) @bind.name')}
(assignment_expression left: (member_expression object: (this) property: (property_identifier) @field.name) right: (_) @field.expr) @field
`;

const BINDINGS_TS = `
${callbackParam('parameters: (formal_parameters . (required_parameter pattern: (identifier) @bind.name))')}
(call_expression function: [(identifier) (member_expression)] @cb.fn arguments: (arguments [(arrow_function) (function_expression)] @cb.arg)) @cb
(variable_declarator name: (identifier) @bind.name type: (type_annotation (_) @bind.type)) @bind
(required_parameter pattern: (identifier) @bind.name type: (type_annotation (_) @bind.type)) @bind
(optional_parameter pattern: (identifier) @bind.name type: (type_annotation (_) @bind.type)) @bind
(public_field_definition name: (property_identifier) @field.name type: (type_annotation (_) @field.type)) @field
(public_field_definition name: (property_identifier) @field.name value: (_) @field.expr) @field
(required_parameter (accessibility_modifier) pattern: (identifier) @field.name type: (type_annotation (_) @field.type)) @field
(required_parameter "readonly" pattern: (identifier) @field.name type: (type_annotation (_) @field.type)) @field
(optional_parameter (accessibility_modifier) pattern: (identifier) @field.name type: (type_annotation (_) @field.type)) @field
`;

const BINDINGS_JS = `
${callbackParam('parameters: (formal_parameters . (identifier) @bind.name)')}
(field_definition property: (property_identifier) @field.name value: (_) @field.expr) @field
`;

// Wrappers whose members are reached through the wrapped type (after await / by convention).
const TRANSPARENT_TYPES = new Set(['Promise', 'PromiseLike', 'Awaited', 'Readonly', 'Partial', 'Required', 'NonNullable', 'DeepPartial', 'DeepReadonly', 'Mutable']);
// Collections: `x[i]`, `for (const e of x)` and `x.forEach(e => …)` see the element type.
const ELEMENT_TYPES = new Set(['Array', 'ReadonlyArray', 'Set', 'ReadonlySet', 'Iterable', 'IterableIterator', 'Iterator', 'AsyncIterable', 'AsyncIterableIterator', 'Generator', 'AsyncGenerator']);
// Types whose members never live in the repository.
// (`any` / `unknown` are not here: a value of that type may well be an instance of a repository class)
const PRIMITIVE_TYPES = new Set(['string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'void', 'never', 'undefined', 'null',
    'String', 'Number', 'Boolean', 'Object', 'Function', 'Date', 'RegExp', 'Map', 'WeakMap', 'WeakSet', 'Record', 'Error', 'Buffer',
    'ArrayBuffer', 'Uint8Array', 'DataView', 'URL', 'URLSearchParams', 'Headers', 'Request', 'Response', 'AbortController', 'AbortSignal']);

// Ubiquitous globals whose members never resolve into the repository.
const EXTERNAL_RECEIVERS = new Set([
    'console', 'JSON', 'Math', 'Object', 'Array', 'Promise', 'Reflect', 'Number', 'String', 'Symbol',
    'Date', 'process', 'window', 'document', 'globalThis', 'Buffer', 'Intl', 'navigator', 'performance',
    'localStorage', 'sessionStorage', 'location', 'history', 'Error', 'Map', 'Set', 'WeakMap', 'RegExp',
    'module', 'exports', 'require', 'jest', 'vi', 'expect', 'assert', 'chai', 'sinon',
]);
const BUILTIN_CALLS = new Set([
    'require', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'parseInt',
    'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
    'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'queueMicrotask', 'structuredClone', 'fetch', 'eval',
    'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'suite', 'context',
]);

// a top-level integration/ directory holds integration-test apps (nestjs, many monorepos)
const TEST_FILE_RE = /(^|\/)(__tests__|__mocks__|tests?|spec|e2e)\/|^integration\/|\.(test|spec|e2e-spec|cy)\.[cm]?[jt]sx?$/;

function stripQuotes(s) { return s.replace(/^['"`]|['"`]$/g, ''); }

/** Parse an ES import / export-from statement node into import records. */
function parseImportNode(node) {
    const out = [];
    const srcNode = node.childForFieldName('source');
    if (!srcNode) return out;
    const source = stripQuotes(srcNode.text);
    if (node.type === 'import_statement') {
        let any = false;
        for (const child of node.namedChildren) {
            if (child.type === 'import_clause') {
                for (const c of child.namedChildren) {
                    if (c.type === 'identifier') { out.push({ source, imported: 'default', local: c.text }); any = true; }
                    else if (c.type === 'namespace_import') {
                        const id = c.namedChildren.find(n => n.type === 'identifier');
                        if (id) { out.push({ source, imported: '*', local: id.text }); any = true; }
                    } else if (c.type === 'named_imports') {
                        for (const spec of c.namedChildren) {
                            if (spec.type !== 'import_specifier') continue;
                            const name = spec.childForFieldName('name')?.text;
                            const alias = spec.childForFieldName('alias')?.text;
                            if (name) { out.push({ source, imported: stripQuotes(name), local: alias || stripQuotes(name) }); any = true; }
                        }
                    }
                }
            } else if (child.type === 'import_require_clause') {
                const id = child.namedChildren.find(n => n.type === 'identifier');
                if (id) { out.push({ source, imported: '*', local: id.text }); any = true; }
            }
        }
        if (!any) out.push({ source, imported: null, local: null }); // side-effect import
    } else if (node.type === 'export_statement') {
        const clause = node.namedChildren.find(n => n.type === 'export_clause');
        const nsExport = node.namedChildren.find(n => n.type === 'namespace_export');
        if (clause) {
            for (const spec of clause.namedChildren) {
                if (spec.type !== 'export_specifier') continue;
                const name = spec.childForFieldName('name')?.text;
                const alias = spec.childForFieldName('alias')?.text;
                if (name) out.push({ source, imported: stripQuotes(name), local: null, reexport: stripQuotes(alias || name) });
            }
        } else if (nsExport) {
            const id = nsExport.namedChildren[0];
            out.push({ source, imported: '*', local: null, reexport: id ? stripQuotes(id.text) : '*' });
        } else {
            out.push({ source, imported: '*', local: null, reexport: '*' });
        }
    }
    return out;
}

/** const x = require('m') / const { a, b: c } = require('m') / require('m') */
function parseRequire(callNode, srcNode) {
    const source = stripQuotes(srcNode.text);
    let p = callNode.parent;
    if (p?.type === 'await_expression') p = p.parent;
    if (p?.type === 'variable_declarator') {
        const nameNode = p.childForFieldName('name');
        if (nameNode?.type === 'identifier') return [{ source, imported: '*', local: nameNode.text }];
        if (nameNode?.type === 'object_pattern') {
            const out = [];
            for (const c of nameNode.namedChildren) {
                if (c.type === 'shorthand_property_identifier_pattern') out.push({ source, imported: c.text, local: c.text });
                else if (c.type === 'pair_pattern') {
                    const k = c.childForFieldName('key')?.text, v = c.childForFieldName('value');
                    if (k && v?.type === 'identifier') out.push({ source, imported: k, local: v.text });
                }
            }
            if (out.length) return out;
        }
    }
    return [{ source, imported: null, local: null }];
}

/** `const x = require('y')` / `const x = require('y').z` / `const {a} = require('y')` are imports, not definitions. */
function isRequireBinding(node) {
    const decl = node.type === 'variable_declarator' ? node : node.namedChildren?.find(c => c.type === 'variable_declarator');
    const v = decl?.childForFieldName('value');
    return !!v && /^(await\s+)?require\s*\(/.test(v.text);
}

function isModuleLevel(node) {
    // a variable declarator is module-level if its declaration sits in program / export_statement
    let decl = node.type === 'variable_declarator' ? node.parent : node;
    const p = decl?.parent;
    return p?.type === 'program' || (p?.type === 'export_statement' && p.parent?.type === 'program');
}

function isExported(defNode) {
    let n = defNode;
    if (n.type === 'variable_declarator') n = n.parent;
    const p = n.parent;
    if (p?.type === 'export_statement') return true;
    // `module.exports.x = ...`, `exports.x = ...`
    if (defNode.type === 'expression_statement') return /^(module\.)?exports\./.test(defNode.text);
    return false;
}

function visibility(defNode) {
    for (const c of defNode.children) {
        if (c.type === 'accessibility_modifier') return c.text; // public/private/protected
    }
    const name = defNode.childForFieldName('name');
    if (name?.type === 'private_property_identifier') return 'private';
    return null;
}

function makeSpec(id, grammar, extensions, { ts, jsx }) {
    return {
        id,
        grammar,
        extensions,
        family: 'ecma',
        query: [
            DEFS_COMMON, ts ? DEFS_TS : DEFS_JS,
            REFS_COMMON, ts ? REFS_TS : REFS_JS, jsx ? REFS_JSX : '',
            IMPORTS_COMMON, BINDINGS_COMMON, ts ? BINDINGS_TS : BINDINGS_JS,
        ].join('\n'),
        implicitThis: false,
        selfNames: ['this'],
        externalReceivers: EXTERNAL_RECEIVERS,
        builtinCalls: BUILTIN_CALLS,
        transparentTypes: TRANSPARENT_TYPES,
        elementTypes: ELEMENT_TYPES,
        isPrimitiveType: (t) => PRIMITIVE_TYPES.has(t),
        elementMethods: new Set(['at', 'find', 'findLast', 'pop', 'shift']),
        mapTypes: new Set(['Map', 'ReadonlyMap', 'WeakMap', 'Record']),
        mapMethods: new Set(['get']),
        mapValueMethods: new Set(['values']),
        cleanType: (t) => t.replace(/^extends\s+/, ''),
        testFile: TEST_FILE_RE,
        commentTypes: ['comment'],
        containerKinds: new Set(['class', 'interface', 'module', 'enum', 'function', 'method']),
        parseImport: parseImportNode,
        filterDef: (d) => !((d.kind === 'variable') && isRequireBinding(d.node)),
        normalizeName: (name, d, relPath) => {
            if (d.node.type === 'export_statement') {
                // default export → its own name, else named after its file (what importers call it)
                d.isDefault = true;
                const inner = d.nameNode;
                let own = inner.childForFieldName?.('name')?.text;
                if (!own && inner.type === 'binary_expression') own = inner.childForFieldName('right')?.childForFieldName?.('name')?.text;
                if (own) return own;
                const base = String(relPath ?? '').split('/').pop().replace(/\.[^.]+$/, '');
                const stem = base === 'index' ? String(relPath).split('/').slice(-2, -1)[0] ?? base : base;
                return stem.replace(/[-_.](\w)/g, (_, c) => c.toUpperCase()) || null;
            }
            return name;
        },
        parseRequire,
        isModuleLevel,
        isExported,
        visibility,
        bodyField: 'body',
    };
}

export const javascript = makeSpec('javascript', 'javascript', ['.js', '.jsx', '.mjs', '.cjs'], { ts: false, jsx: true });
export const typescript = makeSpec('typescript', 'typescript', ['.ts', '.mts', '.cts'], { ts: true, jsx: false });
export const tsx = makeSpec('tsx', 'tsx', ['.tsx'], { ts: true, jsx: true });
