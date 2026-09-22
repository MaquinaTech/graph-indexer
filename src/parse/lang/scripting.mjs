/** Ruby, PHP and Bash extraction specs. */

// ─── Ruby ──────────────────────────────────────────────────────────────────────
const RUBY_CALLBACKS = 'before_action|after_action|around_action|skip_before_action|prepend_before_action|before_filter|after_filter|validate|validates_with|before_save|after_save|around_save|after_commit|after_create_commit|after_update_commit|before_validation|after_validation|before_create|after_create|before_update|after_update|before_destroy|after_destroy|helper_method|delegate|alias_method';
const RUBY_QUERY = `
(method name: (_) @name) @def.method
(singleton_method name: (_) @name) @def.method
(class name: [(constant) @name (scope_resolution name: (constant) @name)]) @def.class
(module name: [(constant) @name (scope_resolution name: (constant) @name)]) @def.module
(assignment left: (constant) @name) @def.constant

(call method: (identifier) @name) @ref.call
(call receiver: (_) @recv method: (identifier) @name) @ref.call
(call receiver: [(constant) @name (scope_resolution name: (constant) @name)] method: (identifier) @_new (#eq? @_new "new")) @ref.new
(superclass [(constant) @name (scope_resolution name: (constant) @name)]) @ref.inherit
(call method: (identifier) @_inc arguments: (argument_list [(constant) @name (scope_resolution name: (constant) @name)]) (#match? @_inc "^(include|extend|prepend)$")) @ref.inherit
(call method: (identifier) @_cb arguments: (argument_list (simple_symbol) @name) (#match? @_cb "^(${RUBY_CALLBACKS})$")) @ref.value
(scope_resolution scope: (constant) @recv name: (constant) @name) @ref.type
(constant) @name @ref.type

(call method: (identifier) @_r arguments: (argument_list . (string) @src) (#match? @_r "^(require|require_relative|load|autoload)$")) @import.require

(assignment left: (identifier) @bind.name right: (call receiver: (constant) @bind.new method: (identifier) @_n (#eq? @_n "new"))) @bind
(assignment left: (instance_variable) @field.name right: (call receiver: (constant) @field.new method: (identifier) @_n2 (#eq? @_n2 "new"))) @field
`;

function rubyRequire(callNode, srcNode) {
    const method = callNode.childForFieldName('method')?.text;
    const source = srcNode.text.replace(/^['"]|['"]$/g, '');
    return [{ source: method === 'require_relative' ? (source.startsWith('.') ? source : './' + source) : source, imported: '*', local: null }];
}

export const ruby = {
    id: 'ruby',
    grammar: 'ruby',
    extensions: ['.rb', '.rake', '.gemspec'],
    family: 'ruby',
    query: RUBY_QUERY,
    implicitThis: true,
    selfNames: ['self'],
    externalReceivers: new Set(['Rails', 'ActiveRecord', 'Time', 'Date', 'DateTime', 'File', 'Dir', 'JSON', 'YAML',
        'Kernel', 'Math', 'Logger', 'ENV', 'STDOUT', 'STDERR', 'Struct', 'Integer', 'String', 'Array', 'Hash', 'Set',
        'Float', 'Regexp', 'Thread', 'Process', 'IO', 'URI', 'Net', 'OpenStruct', 'SecureRandom', 'Digest', 'Base64']),
    builtinCalls: new Set(['puts', 'print', 'p', 'pp', 'raise', 'require', 'require_relative', 'include', 'extend',
        'attr_reader', 'attr_writer', 'attr_accessor', 'private', 'protected', 'public', 'lambda', 'proc', 'loop',
        'block_given?', 'yield', 'new', 'freeze', 'dup', 'to_s', 'to_i', 'to_a', 'to_h', 'to_sym', 'nil?', 'present?',
        'blank?', 'respond_to?', 'is_a?', 'kind_of?', 'send', 'public_send', 'tap', 'then', 'each', 'map', 'select',
        'reject', 'find', 'where', 'let', 'describe', 'it', 'context', 'expect', 'subject', 'before', 'after']),
    testFile: /(^|\/)(spec|test)\/|_spec\.rb$|_test\.rb$/,
    commentTypes: ['comment'],
    parseImport: () => [],
    parseRequire: rubyRequire,
    normalizeRefName: (name) => name.replace(/^:/, ''),
    refineKind(kind, d, parent) {
        if (kind === 'method' && !parent) return 'function';
        return kind;
    },
    isExported: () => true,
    visibility: null,
    receiverDescriptor: (node) => (node.type === 'instance_variable' ? 'this.' + node.text.slice(1) : undefined),
    isPrimitiveType: () => false,
    bodyField: 'body',
};

// ─── PHP ───────────────────────────────────────────────────────────────────────
const PT = (cap) => `[(named_type (name) @${cap}) (named_type (qualified_name (name) @${cap} .)) (optional_type (named_type (name) @${cap}))]`;
const PHP_QUERY = `
(function_definition name: (name) @name) @def.function
(class_declaration name: (name) @name) @def.class
(interface_declaration name: (name) @name) @def.interface
(trait_declaration name: (name) @name) @def.trait
(enum_declaration name: (name) @name) @def.enum
(method_declaration name: (name) @name return_type: ${PT('type')}) @def.method
(method_declaration name: (name) @name) @def.method
(property_declaration type: ${PT('type')} (property_element name: (variable_name (name) @name))) @def.property
(property_declaration (property_element name: (variable_name (name) @name))) @def.property
(const_declaration (const_element (name) @name)) @def.constant
(enum_case name: (name) @name) @def.constant

(function_call_expression function: (name) @name) @ref.call
(function_call_expression function: (qualified_name (name) @name .)) @ref.call
(member_call_expression object: (_) @recv name: (name) @name) @ref.call
(nullsafe_member_call_expression object: (_) @recv name: (name) @name) @ref.call
(scoped_call_expression scope: (_) @recv name: (name) @name) @ref.call
(object_creation_expression (name) @name) @ref.new
(object_creation_expression (qualified_name (name) @name .)) @ref.new
(base_clause (name) @name) @ref.inherit
(base_clause (qualified_name (name) @name .)) @ref.inherit
(class_interface_clause (name) @name) @ref.inherit
(class_interface_clause (qualified_name (name) @name .)) @ref.inherit
(use_declaration (name) @name) @ref.inherit
(use_declaration (qualified_name (name) @name .)) @ref.inherit
(named_type (name) @name) @ref.type
(named_type (qualified_name (name) @name .)) @ref.type
(class_constant_access_expression . (name) @name) @ref.type
(class_constant_access_expression . (qualified_name (name) @name .)) @ref.type
(attribute (name) @name) @ref.decorator
(attribute (qualified_name (name) @name .)) @ref.decorator

(namespace_use_declaration) @import

(simple_parameter type: ${PT('bind.type')} name: (variable_name (name) @bind.name)) @bind
(assignment_expression left: (variable_name (name) @bind.name) right: (object_creation_expression (name) @bind.new)) @bind
(assignment_expression left: (variable_name (name) @bind.name) right: (object_creation_expression (qualified_name (name) @bind.new .))) @bind
(property_promotion_parameter type: ${PT('field.type')} name: (variable_name (name) @field.name)) @field
(property_declaration type: ${PT('field.type')} (property_element name: (variable_name (name) @field.name))) @field
(assignment_expression left: (member_access_expression object: (variable_name (name) @_t) name: (name) @field.name) right: (object_creation_expression (name) @field.new) (#eq? @_t "this")) @field
(assignment_expression left: (member_access_expression object: (variable_name (name) @_t2) name: (name) @field.name) right: (variable_name (name) @field.var) (#eq? @_t2 "this")) @field
`;

function phpUse(node) {
    const out = [];
    for (const clause of node.namedChildren) {
        if (clause.type === 'namespace_use_clause') {
            const nameNode = clause.namedChildren.find(c => c.type === 'qualified_name' || c.type === 'name');
            const full = nameNode?.text.replace(/^\\/, '') ?? '';
            const alias = clause.childForFieldName('alias')?.text;
            const parts = full.split('\\');
            const name = parts.pop();
            out.push({ source: parts.join('\\'), imported: name, local: alias || name });
        } else if (clause.type === 'namespace_use_group') {
            const prefix = node.namedChildren.find(c => c.type === 'namespace_name')?.text ?? '';
            for (const g of clause.namedChildren) {
                const nameNode = g.namedChildren.find(c => c.type === 'qualified_name' || c.type === 'name');
                if (!nameNode) continue;
                const full = (prefix ? prefix + '\\' : '') + nameNode.text;
                const parts = full.split('\\');
                const name = parts.pop();
                out.push({ source: parts.join('\\'), imported: name, local: g.childForFieldName('alias')?.text || name });
            }
        }
    }
    return out;
}

function phpVisibility(node) {
    const v = node.namedChildren.find(c => c.type === 'visibility_modifier');
    return v ? v.text : null;
}

function phpFileInfo(root) {
    const ns = root.namedChildren.find(c => c.type === 'namespace_definition');
    return { package: ns?.childForFieldName('name')?.text ?? null };
}

export const php = {
    id: 'php',
    grammar: 'php',
    extensions: ['.php', '.phtml'],
    family: 'php',
    query: PHP_QUERY,
    implicitThis: false,
    selfNames: ['$this', 'this', 'self', 'static'],
    externalReceivers: new Set(['DB', 'Log', 'Cache', 'Config', 'Route', 'Auth', 'Str', 'Arr', 'Carbon', 'Http', 'Storage',
        'Session', 'Request', 'Response', 'Validator', 'Hash', 'Event', 'Queue', 'Mail', 'Gate', 'App', 'URL', 'View',
        'Redirect', 'Artisan', 'Schema', 'Crypt', 'Cookie', 'Lang', 'Notification', 'Password', 'Bus', 'File']),
    builtinCalls: new Set(['array_map', 'array_filter', 'array_merge', 'array_keys', 'array_values', 'in_array', 'count',
        'isset', 'empty', 'unset', 'sprintf', 'printf', 'implode', 'explode', 'str_replace', 'strlen', 'strtolower',
        'strtoupper', 'trim', 'json_encode', 'json_decode', 'is_array', 'is_string', 'is_null', 'is_int', 'intval',
        'array_key_exists', 'var_dump', 'print_r', 'die', 'exit', 'define', 'defined', 'compact', 'extract', 'app', 'config',
        'env', 'view', 'response', 'redirect', 'route', 'url', 'trans', '__', 'collect', 'now', 'dd', 'dump', 'abort',
        'request', 'auth', 'session', 'logger', 'info', 'event', 'dispatch', 'optional', 'tap', 'value', 'with']),
    testFile: /(^|\/)(tests?|Tests?)\/|Test\.php$/,
    commentTypes: ['comment'],
    parseImport: phpUse,
    isExported: (node) => phpVisibility(node) !== 'private',
    visibility: phpVisibility,
    receiverDescriptor(node) {
        const t = node.text.replace(/\s+/g, '');
        if (t === '$this') return 'this';
        const norm = t.replace(/^\$/, '').replace(/->|::|\?->/g, '.').replace(/\.\$/g, '.');
        if (/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*){0,4}$/.test(norm)) return norm.startsWith('this.') ? norm : norm;
        return undefined;
    },
    isPrimitiveType: (t) => /^(int|string|bool|float|array|mixed|void|null|object|callable|iterable|self|static|never|false|true)$/i.test(t),
    decoratorsOf(node) {
        const al = node.childForFieldName('attributes');
        return al ? al.text.replace(/[#[\]]/g, ' ').split(/[\s,]+/).filter(x => /^[A-Z]\w*$/.test(x)).slice(0, 8) : [];
    },
    fileInfo: phpFileInfo,
    bodyField: 'body',
};

// ─── Bash ──────────────────────────────────────────────────────────────────────
const BASH_QUERY = `
(function_definition name: (word) @name) @def.function
(command name: (command_name (word) @name)) @ref.call
(command name: (command_name (word) @_src) argument: (_) @src (#match? @_src "^(source|\\\\.)$")) @import.require
`;

const BASH_BUILTINS = new Set(['echo', 'cd', 'ls', 'cat', 'rm', 'cp', 'mv', 'mkdir', 'rmdir', 'touch', 'ln', 'export',
    'local', 'readonly', 'declare', 'unset', 'shift', 'read', 'printf', 'exit', 'return', 'eval', 'exec', 'trap', 'wait',
    'sleep', 'pwd', 'set', 'shopt', 'source', '.', 'test', '[', '[[', 'true', 'false', 'kill', 'jobs', 'type', 'command',
    'getopts', 'grep', 'sed', 'awk', 'cut', 'tr', 'sort', 'uniq', 'head', 'tail', 'find', 'xargs', 'chmod', 'chown', 'tee',
    'wc', 'basename', 'dirname', 'tar', 'curl', 'wget', 'env', 'git', 'npm', 'node', 'make', 'docker', 'python', 'python3',
    'which', 'hash', 'builtin', 'alias', 'unalias', 'printenv', 'date', 'uname', 'id', 'whoami', 'sudo', 'ps', 'nohup', 'bash', 'sh', 'zsh']);

export const bash = {
    id: 'bash',
    grammar: 'bash',
    extensions: ['.sh', '.bash', '.zsh'],
    family: 'shell',
    query: BASH_QUERY,
    implicitThis: false,
    selfNames: [],
    externalReceivers: new Set(),
    builtinCalls: BASH_BUILTINS,
    testFile: /(^|\/)(tests?)\/|_test\.sh$|\.bats$/,
    commentTypes: ['comment'],
    parseImport: () => [],
    parseRequire: (node, src) => [{ source: src.text.replace(/^['"]|['"]$/g, '').replace(/^\$\{?\w+\}?\//, ''), imported: '*', local: null }],
    isExported: () => true,
    visibility: null,
    isPrimitiveType: () => true,
    bodyField: 'body',
};
