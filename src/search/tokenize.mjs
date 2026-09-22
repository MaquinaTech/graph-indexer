/**
 * Code-aware tokenization shared by indexing and querying.
 *
 * An identifier contributes its full lowercase form AND its sub-words, so `getUserById`
 * matches the query "get user by id", the query "getUserById", and the query "user".
 * Acronyms split correctly (`parseHTTPHeader` → parse, http, header). Stemming happens in
 * SQLite's FTS5 porter tokenizer on top of these tokens.
 */

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+/g;

/** Split one identifier into lowercase sub-words (camel/Pascal/snake/kebab/acronyms/digits). */
export function splitIdentifier(id) {
    const parts = id
        .replace(/[$_]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([A-Za-z])([0-9])/g, '$1 $2')
        .replace(/([0-9])([A-Za-z])/g, '$1 $2')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
    return parts;
}

/** Tokens for indexing a piece of code/text (identifier forms + sub-words). */
export function codeTokens(text, { maxTokens = Infinity } = {}) {
    const out = [];
    if (!text) return out;
    IDENT_RE.lastIndex = 0;
    let m;
    while ((m = IDENT_RE.exec(text)) && out.length < maxTokens) {
        const id = m[0];
        if (/^[0-9]+$/.test(id)) { if (id.length <= 6) out.push(id); continue; }
        const lower = id.toLowerCase().replace(/^[$_]+|[$_]+$/g, '');
        const parts = splitIdentifier(id);
        if (lower.length >= 2 && (parts.length !== 1 || parts[0] !== lower)) out.push(lower.replace(/[$]/g, ''));
        for (const p of parts) if (p.length >= 2 || parts.length === 1) out.push(p);
    }
    return out;
}

export function tokenString(text, opts) { return codeTokens(text, opts).join(' '); }

// Words that carry no retrieval signal in a question about code.
export const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done', 'doing', 'have', 'has', 'had',
    'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here', 'what', 'which', 'who', 'whom', 'whose', 'where',
    'when', 'why', 'how', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'i', 'we', 'you',
    'they', 'he', 'she', 'me', 'us', 'them', 'my', 'our', 'your', 'their', 'if', 'then', 'else', 'than', 'so', 'such',
    'as', 'not', 'no', 'yes', 'all', 'any', 'each', 'every', 'some', 'most', 'more', 'other', 'about', 'over', 'under',
    'up', 'down', 'out', 'off', 'again', 'further', 'once', 'also', 'just', 'only', 'very', 'too', 'via', 'per', 'like',
    'code', 'function', 'functions', 'method', 'methods', 'class', 'classes', 'implementation', 'implemented', 'implement',
    'implements', 'logic', 'where', 'find', 'show', 'defined', 'handled', 'handle', 'happens', 'used', 'using', 'use',
    'get', 'gets', 'responsible', 'thing', 'things', 'part', 'called', 'call', 'calls', 'file', 'files', 'module',
]);
// NOTE: 'get', 'handle', 'find', 'use', 'call' are stopwords only for natural-language queries;
// identifier-shaped queries keep them (see analyzeQuery).

/**
 * Small, curated concept thesaurus for natural-language → code vocabulary gaps.
 * Each group is symmetric; expansions are scored below literal terms.
 */
const CONCEPT_GROUPS = [
    ['auth', 'authentication', 'authenticate', 'authorization', 'authorize', 'login', 'credential', 'credentials'],
    ['db', 'database', 'sql', 'query', 'repository', 'repo', 'dao', 'store', 'persistence'],
    ['config', 'configuration', 'settings', 'options', 'opts', 'conf', 'cfg'],
    ['init', 'initialize', 'initialise', 'setup', 'bootstrap', 'boot', 'startup'],
    ['err', 'error', 'errors', 'exception', 'failure', 'fault'],
    ['req', 'request'], ['res', 'resp', 'response', 'reply'],
    ['msg', 'message'], ['ctx', 'context'], ['env', 'environment'], ['impl', 'implementation'],
    ['util', 'utils', 'utility', 'helper', 'helpers'], ['str', 'string', 'text'], ['num', 'number', 'count'],
    ['param', 'params', 'parameter', 'arg', 'args', 'argument'], ['fn', 'func', 'callback', 'cb', 'handler'],
    ['del', 'delete', 'remove', 'destroy', 'drop', 'erase'], ['create', 'new', 'make', 'build', 'construct', 'add', 'insert'],
    ['fetch', 'get', 'retrieve', 'load', 'read', 'lookup'], ['save', 'store', 'persist', 'write', 'put', 'commit'],
    ['update', 'modify', 'patch', 'edit', 'change', 'set'],
    ['search', 'find', 'query', 'lookup', 'filter', 'match'], ['list', 'all', 'collection', 'index'],
    ['parse', 'decode', 'deserialize', 'unmarshal', 'unmarshall', 'read'],
    ['serialize', 'encode', 'marshal', 'stringify', 'dump', 'render'],
    ['validate', 'validation', 'validator', 'check', 'verify', 'assert', 'ensure', 'sanitize'],
    ['send', 'emit', 'dispatch', 'publish', 'post', 'notify', 'broadcast'],
    ['receive', 'consume', 'listen', 'subscribe', 'on', 'handle'],
    ['route', 'routes', 'router', 'routing', 'endpoint', 'path', 'url', 'controller'],
    ['middleware', 'interceptor', 'hook', 'filter', 'guard', 'pipe', 'plugin'],
    ['cache', 'cached', 'memo', 'memoize', 'lru'], ['retry', 'retries', 'backoff', 'attempt'],
    ['timeout', 'deadline', 'expire', 'expiry', 'ttl'], ['log', 'logger', 'logging', 'trace', 'debug'],
    ['user', 'account', 'member', 'profile', 'owner'], ['permission', 'role', 'access', 'acl', 'policy', 'privilege'],
    ['token', 'jwt', 'session', 'cookie', 'bearer'], ['password', 'secret', 'hash', 'crypt', 'encrypt', 'cipher'],
    ['upload', 'file', 'attachment', 'blob', 'multipart'], ['schedule', 'cron', 'job', 'task', 'worker', 'queue'],
    ['event', 'listener', 'subscriber', 'observer', 'emitter', 'signal'], ['test', 'spec', 'mock', 'stub', 'fixture'],
    ['bind', 'binding', 'bound'], ['convert', 'transform', 'map', 'cast', 'coerce', 'normalize'],
    ['compare', 'equal', 'equals', 'diff', 'eq'], ['sort', 'order', 'rank', 'priority'],
    ['merge', 'combine', 'join', 'concat', 'extend', 'assign'], ['split', 'chunk', 'partition', 'segment'],
    ['wrap', 'wrapper', 'decorate', 'decorator', 'proxy', 'adapter'], ['escape', 'sanitize', 'encode', 'quote'],
    ['start', 'begin', 'launch', 'run', 'serve', 'listen'], ['stop', 'end', 'shutdown', 'close', 'terminate', 'dispose', 'teardown'],
    ['http', 'rest', 'api', 'client', 'fetch', 'axios'], ['header', 'headers'], ['body', 'payload', 'content', 'data'],
    ['redirect', 'forward', 'location'], ['status', 'code', 'state'], ['json', 'jsonify'], ['xml', 'html', 'template', 'view'],
    ['stream', 'pipe', 'buffer', 'reader', 'writer'], ['async', 'await', 'promise', 'future', 'deferred'],
    ['thread', 'lock', 'mutex', 'concurrent', 'sync'], ['socket', 'websocket', 'ws', 'connection', 'conn'],
    ['cors', 'origin', 'crossorigin'], ['cookie', 'cookies'], ['static', 'asset', 'assets', 'public'],
    ['dependency', 'dependencies', 'inject', 'injection', 'injectable', 'provider', 'container', 'di'],
    ['schema', 'model', 'entity', 'dto', 'type'], ['migrate', 'migration', 'schema'], ['email', 'mail', 'smtp'],
    ['payment', 'charge', 'billing', 'invoice', 'stripe'], ['image', 'img', 'picture', 'photo', 'thumbnail'],
    ['date', 'time', 'timestamp', 'datetime', 'clock'], ['random', 'rand', 'uuid', 'id', 'identifier'],
    ['env', 'environment', 'variable', 'var'], ['command', 'cmd', 'cli', 'arg', 'flag'],
    ['proxy', 'forward', 'tunnel'], ['compress', 'gzip', 'zip', 'deflate'], ['version', 'semver'],
];

const CONCEPTS = new Map();
for (const group of CONCEPT_GROUPS) {
    for (const w of group) {
        const set = CONCEPTS.get(w) ?? new Set();
        for (const o of group) if (o !== w) set.add(o);
        CONCEPTS.set(w, set);
    }
}

export function expandConcept(word) { return CONCEPTS.get(word) ?? null; }

const IDENTIFIER_SHAPE = /^(?:[a-z]+(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+|[A-Z][A-Z0-9_]{2,}|[A-Za-z_$][\w$]*(?:\.|::|#|->)[A-Za-z_$][\w$.:#>-]*|[A-Za-z_$][\w$]*\(\))$/;

/** Mixed-case (APIRoute, HTTPBearer, iOS), snake/kebab-free words with inner capitals, or a
 *  capitalized word after the first position ("... using Promise") read as code identifiers. */
function looksLikeIdentifier(t, position) {
    if (!/^[A-Za-z_$][\w$]*$/.test(t)) return false;
    if (/[A-Z]/.test(t.slice(1)) && /[a-z]/.test(t)) return true;
    if (/[_$]/.test(t) || /[a-z][0-9]|[0-9][a-z]/i.test(t) && /[a-z]/i.test(t) && t.length > 2) return true;
    if (position > 0 && /^[A-Z][a-z0-9]+$/.test(t)) return true;
    return false;
}

/**
 * Analyse a search query.
 * @returns {{ raw, identifiers: string[], words: string[], terms: string[], expansions: string[], natural: boolean, filters: object }}
 */
export function analyzeQuery(query) {
    const filters = {};
    let q = String(query).replace(/\b(path|file|in|kind|lang|language):(\S+)/gi, (_, k, v) => {
        const key = k.toLowerCase() === 'file' || k.toLowerCase() === 'in' ? 'path' : k.toLowerCase() === 'language' ? 'lang' : k.toLowerCase();
        (filters[key] ??= []).push(v);
        return ' ';
    });
    q = q.trim();
    const rawTokens = q.split(/[\s,;]+/).filter(Boolean).map(t => t.replace(/^[`'"(]+|[`'"),.?!:]+$/g, '')).filter(Boolean);
    const identifiers = [];
    const words = [];
    rawTokens.forEach((t, i) => {
        if (IDENTIFIER_SHAPE.test(t) || looksLikeIdentifier(t, i)) identifiers.push(t.replace(/\(\)$/, ''));
        else words.push(t);
    });
    const lowerWords = words.map(w => w.toLowerCase());
    const stopCount = lowerWords.filter(w => STOPWORDS.has(w)).length;
    // Natural language = several words, mostly not identifier-shaped, with function words.
    const natural = rawTokens.length >= 3 && identifiers.length <= rawTokens.length / 2 && (stopCount >= 1 || rawTokens.length >= 5);
    const termSet = new Set();
    for (const id of identifiers) for (const t of codeTokens(id)) termSet.add(t);
    for (const w of lowerWords) {
        if (natural && STOPWORDS.has(w)) continue;
        for (const t of codeTokens(w)) termSet.add(t);
    }
    // a single bare word query ("router") is an identifier lookup as much as a word
    if (!identifiers.length && rawTokens.length <= 2) for (const w of rawTokens) if (/^[A-Za-z_$][\w$]*$/.test(w)) identifiers.push(w);
    const terms = [...termSet].filter(t => t.length >= 2 || /^[a-z]$/.test(t) === false);
    const expansions = new Set();
    if (natural || identifiers.length === 0) {
        for (const t of terms) {
            const e = expandConcept(t);
            if (e) for (const x of e) if (!termSet.has(x)) expansions.add(x);
        }
    }
    return { raw: q, identifiers, words: lowerWords, terms, expansions: [...expansions], natural, filters };
}
