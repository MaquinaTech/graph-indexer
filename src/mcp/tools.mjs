/**
 * The MCP tool surface: eight read-only tools, each answering one kind of question an agent has
 * while changing code (`get_symbol`, which `read_code` replaced, stays callable for older clients).
 * Descriptions say when to use the tool (and when grep/read is better);
 * outputs are compact text with file:line locations and explicit totals/truncation notes.
 */
import path from 'node:path';
import { analyzeQuery } from '../search/tokenize.mjs';
import { loc, clip, codeBlock, symHeader, confWord, matchingLines, plural } from './render.mjs';
import { textSearch, findFiles, identifierOf } from '../query/textsearch.mjs';
import { checkChanges } from '../query/check.mjs';
import { definitionsUsed, testsUsing } from '../query/read.mjs';
import fs from 'node:fs';

const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'type', 'object', 'module', 'impl']);
const VALUE_KINDS = new Set(['field', 'property', 'variable', 'constant']);
const CALLABLE_KINDS = new Set(['function', 'method']);
// examples, docs snippets and sample apps come after the library code they exercise
const EXAMPLE_PATH = /(^|\/)(docs?_src|docs?|examples?|samples?|demos?|tutorials?|benchmarks?|fixtures?|playground)\//i;
const pathRank = (p) => (EXAMPLE_PATH.test(p) ? 1 : 0);

export const TOOLS = [
    {
        name: 'search_code',
        title: 'Search code',
        description: 'Find where something is implemented in this repository. Ranks functions, methods, classes and types by name, signature, docs and body, with graph-aware ranking. Use it when you do not know the exact file or symbol name — natural language ("where are JWT tokens validated") or identifiers ("parseHeaders", "UserService.find") both work. Returns ranked symbols with location, signature, doc line and the lines that matched. Filters: `path` (directory or file prefix), `kind` (function, method, class, interface, struct, type…). Prefer grep for exact string literals, log messages or config keys.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'What you are looking for: a behaviour description or identifier(s).' },
                path: { type: 'string', description: 'Only results under this path prefix, e.g. "src/auth/".' },
                kind: { type: 'string', description: 'Only this symbol kind (function, method, class, interface, struct, enum, type, field…).' },
                limit: { type: 'integer', minimum: 1, maximum: 30, default: 8, description: 'Max results (default 8).' },
            },
            required: ['query'],
        },
    },
    {
        name: 'search_text',
        title: 'Search text',
        description: 'Grep with structure: search the text of every file in the repository (code, config, docs, tests) for a regular expression or literal string. Each code match shows its enclosing function/class, and when the pattern is an identifier each match says what it is — the definition, a reference bound to a specific symbol (so same-named methods of different classes are told apart), an unbound reference, or a comment/string — with a summary per target at the end. Use it for string literals, error messages, config keys, and whenever you would grep an identifier; use find_references when you already know which symbol you mean.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'JavaScript regular expression (or literal text with literal: true).' },
                path: { type: 'string', description: 'Only files under this path prefix, e.g. "src/" or "config/app.yaml".' },
                literal: { type: 'boolean', default: false, description: 'Treat the pattern as plain text.' },
                ignore_case: { type: 'boolean', default: false },
                limit: { type: 'integer', minimum: 1, maximum: 300, default: 60, description: 'Max matching lines shown (totals are always complete).' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'read_code',
        title: 'Read code',
        description: 'Read code without searching for what it uses: a function, class or method by name ("Parser.parse_interval", "handleRequest"), a line range ("src/app.py:120-180") or a file — several targets per call. Returns the code with line numbers and, below it, where each name the code uses is defined (file:line and signature), so following a call or a type means reading the listed targets instead of grepping for them. For a symbol it also shows what it overrides, who uses it and which tests exercise it. A file over 300 lines comes back as its outline (definitions with line ranges); read the parts you need, or pass full: true. Your editor may still ask you to open the lines you change with its own read tool.',
        inputSchema: {
            type: 'object',
            properties: {
                targets: { type: 'array', items: { type: 'string' }, description: 'Symbols (name, Class.method, path:Name), ranges (path:START-END) or files; up to 12.' },
                full: { type: 'boolean', default: false, description: 'Whole files even when long (up to 2000 lines).' },
                max_lines: { type: 'integer', minimum: 5, maximum: 1000, default: 200, description: 'Truncate a long definition after this many lines (default 200).' },
            },
            required: ['targets'],
        },
    },
    {
        name: 'find_references',
        title: 'Find references',
        description: 'Every place that uses a symbol — calls, instantiations, type annotations, inheritance, decorators, field reads and function references passed as values — grouped by file with the enclosing function and the source line. Methods that merely share the name (other classes, standard-library `get`/`set`…) are kept apart. Use it before renaming or changing a signature, or to learn how something is used. References are bound through scopes, imports and inferred receiver types (including injected fields); calls through a parent class or interface are included and marked. For a class or interface it also lists the types that inherit it indirectly, through a subclass or sub-interface. The footer lists same-name calls whose receiver type is unknown and says whether any of them is plausible (its file mentions the type), so a grep cross-check is only needed when it says so.',
        inputSchema: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'Name, Class.member, path:Name or path:line.' },
                kind: { type: 'string', enum: ['all', 'call', 'type', 'inherit', 'new', 'value', 'decorator'], default: 'all', description: 'Only this reference kind.' },
                path: { type: 'string', description: 'Only references in files under this path, e.g. "packages/".' },
                include_tests: { type: 'boolean', default: true },
                limit: { type: 'integer', minimum: 1, maximum: 500, default: 80 },
            },
            required: ['symbol'],
        },
    },
    {
        name: 'call_graph',
        title: 'Call graph',
        description: 'Show the call hierarchy around a function or method: who calls it (callers, transitively up to `depth`) and/or what it calls (callees), as a tree with locations and confidence. Use it to trace a request/data flow across files or to understand the execution path into and out of a function without opening every file. direction: "callers", "callees" or "both" (default).',
        inputSchema: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'Name, Class.member, path:Name or path:line.' },
                direction: { type: 'string', enum: ['callers', 'callees', 'both'], default: 'both' },
                depth: { type: 'integer', minimum: 1, maximum: 4, default: 2 },
                limit: { type: 'integer', minimum: 5, maximum: 200, default: 40, description: 'Max nodes per direction.' },
                include_tests: { type: 'boolean', default: true, description: 'Include callers in test files.' },
            },
            required: ['symbol'],
        },
    },
    {
        name: 'change_impact',
        title: 'Change impact',
        description: 'What a change to some symbols or files affects: the call sites to update (file:line), overrides and implementations that must stay in line, callers of callers, the tests that exercise the code, the public surface, files that historically change together (git), and what the index cannot see. Pass `symbols` and/or `files`, or `diff: true` for your uncommitted changes. Use it before changing a widely used function or a signature; after editing, check_changes verifies what you actually changed.',
        inputSchema: {
            type: 'object',
            properties: {
                symbols: { type: 'array', items: { type: 'string' }, description: 'Symbols you are changing.' },
                files: { type: 'array', items: { type: 'string' }, description: 'Files you are changing (all their symbols).' },
                diff: { type: 'boolean', default: false, description: 'Use the uncommitted git diff as the change set.' },
                depth: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
            },
        },
    },
    {
        name: 'check_changes',
        title: 'Check changes',
        description: 'Verify your uncommitted edits before you finish, without building: compares every changed file with the last commit and reports syntax errors you introduced, calls whose argument count no longer fits a changed definition (call sites across the repository and calls you wrote), definitions you removed or renamed that are still used or imported, callers of a changed signature in files you did not touch, and the tests that exercise the changed code — the closest test functions first — with the commands to run them. Use it after editing and before declaring a task done; it complements, not replaces, running the tests and the type checker.',
        inputSchema: {
            type: 'object',
            properties: {
                files: { type: 'array', items: { type: 'string' }, description: 'Only check these changed files/directories (default: all changes).' },
                base: { type: 'string', default: 'HEAD', description: 'Git revision to compare with.' },
            },
        },
    },
    {
        name: 'outline',
        title: 'Outline',
        description: 'Structure without bodies. For a file: every definition with its signature and line range (cheap way to see what a file contains before reading parts of it). For a directory or the whole repository (empty path): the most important symbols ranked by how central they are in the dependency graph, grouped by file, within a token budget — a map for orienting in unfamiliar code. `focus` (a query or symbol names) personalizes the map around a task.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File or directory; empty = whole repository.' },
                focus: { type: 'string', description: 'Optional task/query to center the repository map on.' },
                max_tokens: { type: 'integer', minimum: 200, maximum: 8000, default: 1500 },
            },
        },
    },
];

// `get_symbol` predates read_code: still callable by clients configured for it, no longer listed
export const LEGACY_TOOLS = [
    {
        name: 'get_symbol',
        title: 'Get symbol',
        description: 'Read one definition instead of a whole file: source code with line numbers, signature, doc comment, members (for classes/structs/interfaces) and a summary of what it calls and who calls it. Accepts a name ("handleRequest"), qualified name ("Router.handle"), "path/file.ts:Name" or "path/file.ts:42" (the symbol enclosing that line). When a name is ambiguous, shows the most central definition and lists the others. Use it after search_code, or directly when you know the name. Set include_code=false to get only the signature and relationships.',
        inputSchema: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'Name, Class.member, path:Name or path:line.' },
                include_code: { type: 'boolean', default: true, description: 'Include the source (default true).' },
                max_lines: { type: 'integer', minimum: 5, maximum: 1000, default: 200, description: 'Truncate long bodies after this many lines (default 200).' },
            },
            required: ['symbol'],
        },
    },
];

// loaded up front even when the client defers MCP tools behind a tool search: the three tools an
// agent needs at the moments it would otherwise guess (which uses? what text? what did I break?)
const ALWAYS_LOAD = new Set(['read_code', 'search_text', 'find_references', 'check_changes']);
for (const t of [...TOOLS, ...LEGACY_TOOLS]) {
    t.annotations = { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    if (ALWAYS_LOAD.has(t.name)) t._meta = { 'anthropic/alwaysLoad': true };
}

export const SERVER_INSTRUCTIONS = `graph-indexer keeps a live structural index of this repository: definitions, references bound through scopes, imports and receiver types, the call graph, and the tests that exercise each function. It re-syncs with the files before every answer, so results include edits made seconds ago.

Reading and following code:
- read_code reads symbols (Class.method), line ranges (file:120-180) or files, several per call, and lists where each name the code uses is defined, with its signature. To follow a call or a type, read the listed targets (several at once) instead of searching for their definitions.
- search_text: anything grep would find (identifiers, strings, config keys, any file), plus for each code match its enclosing function and the definition an identifier refers to; when the definition of the name is elsewhere it says where.
- search_code: code for a behaviour described in words.

Changing code:
- Uses of a known symbol, even when other classes have same-name methods: find_references gives the exact call sites and says which same-name calls could not be bound and whether they are plausible; for a class or interface, every type that inherits it.
- Before changing a signature, renaming or removing something, or changing behaviour other code relies on: change_impact (call sites to update, overrides, dependents, tests to run). After such an edit: check_changes (syntax errors, calls that no longer fit, removed names still in use, the test command).
- A fix inside one function that keeps its signature needs neither: run the tests that cover it.
- Callers of callers and request flows: call_graph. A map of an unfamiliar area: outline.

Every answer states its confidence and what the index cannot see (dynamic dispatch, untyped receivers); an empty result says why.`;

// ── handlers ─────────────────────────────────────────────────────────────────────

const SELF_DESCRIBING = /^(export\s+|pub(\([^)]*\))?\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|async\s+|abstract\s+|final\s+|override\s+|default\s+)*(function|func|def|fn|class|interface|struct|enum|trait|type|impl|module|namespace|object|record|macro_rules!|val|var|let|const|@)/;

/** A signature line that says what the symbol is without repeating the kind ("function function f"). */
function describe(r, max = 140) {
    const sig = r.sig || r.qname || r.name;
    return SELF_DESCRIBING.test(sig) ? clip(sig, max) : `${r.kind} ${clip(sig, max)}`;
}

/** Matches for a target, with overloads of one method collapsed (they are one definition to an agent). */
function pickSymbol(intel, target) {
    const { matches } = intel.findSymbols(target);
    const seen = new Set();
    return matches.filter(m => { const k = `${m.file_id}|${m.qname}|${m.kind}|${m.is_static}`; return !seen.has(k) && seen.add(k); });
}

/** "other definitions" note: each alternative as a ready-to-use qualified target with its use count. */
function otherDefinitions(intel, matches, max = 5) {
    // `path:Name` is ambiguous when one file declares the name twice (static + instance, overloads
    // of different classes with the same qualified name): point at the line instead
    const key = (m) => `${m.path}:${m.qname}`;
    const dup = new Set(matches.map(key).filter((k, i, a) => a.indexOf(k) !== i));
    const alts = matches.slice(1, 1 + max).map(m => `${dup.has(key(m)) ? `${m.path}:${m.start_line}` : key(m)}${m.is_static ? ' (static' : ' ('}${m.is_static ? ', ' : ''}${plural(refSummary(intel, m.id).n, 'ref')})`);
    return alts.join(', ') + (matches.length > 1 + max ? `, … ${matches.length - 1 - max} more` : '');
}
/** Which of several same-name definitions is shown: `Logger.error (static) in path:209`. */
const shownAs = (s, matches) => `${s.qname}${s.is_static ? ' (static)' : ''} in ${matches.filter(m => m.path === s.path && m.qname === s.qname).length > 1 ? `${s.path}:${s.start_line}` : s.path}`;

function notFound(intel, target) {
    const { results } = intel.search.search(String(target), { limit: 5 });
    const sugg = results.map(r => intel.sym(r.id)).filter(Boolean).map(s => `  ${symHeader(s)}`);
    return `No symbol named "${target}".` + (sugg.length ? `\nClosest matches:\n${sugg.join('\n')}` : `\nTry ${tn('search_code')} with a description of what it does.`);
}

/**
 * Footer for same-name call sites whose receiver type is unknown: list the plausible ones (their
 * file mentions the declaring type, or the receiver is named after it) and say why the rest can
 * be ignored, so the agent does not have to grep hundreds of unrelated calls.
 */
function unboundNote(u, s, max = 8) {
    if (!u?.total) return [];
    const others = u.total - u.plausible.length;
    const what = `"${s.name}(…)" call${u.total === 1 ? '' : 's'}`;
    const typeText = u.typeNames.length ? typeList(u.typeNames, true) : null;
    if (!u.plausible.length) {
        return [`Unbound: ${u.total} other ${what} with receivers of unknown type; ${typeText ? `none is in a file that mentions ${typeText}` : 'none is in a file that imports this one or sits next to it'}, so none is likely to be a call to it.`];
    }
    const one = u.plausible.length === 1;
    const where = typeText ? `${one ? 'is in a file that mentions' : 'are in files that mention'} ${typeText}` : `${one ? 'is in a file that imports' : 'are in files that import'} this one or next to it`;
    const out = [`Possibly missed: ${u.plausible.length} "${s.name}(…)" call${one ? '' : 's'} with ${one ? 'a receiver' : 'receivers'} of unknown type ${where} — check ${one ? 'it' : 'them'}:`];
    for (const r of u.plausible.slice(0, max)) out.push(`  ${r.path}:${r.line}${r.recv ? `  (${r.recv}.${s.name})` : ''}`);
    if (u.plausible.length > max) out.push(`  … ${u.plausible.length - max} more`);
    if (others) out.push(`The other ${others} unbound "${s.name}(…)" call${others === 1 ? ' is in a file' : 's are in files'} that never mention${others === 1 ? 's' : ''} ${typeText ?? 'it'}.`);
    return out;
}

function typeList(names, code = false, max = 3) {
    const q = (n) => code ? `\`${n}\`` : n;
    return names.slice(0, max).map(q).join('/') + (names.length > max ? ` (+${names.length - max} related types)` : '');
}

function refSummary(intel, id) {
    const c = intel.store.get(`SELECT COUNT(*) AS n, COUNT(DISTINCT file_id) AS f FROM refs WHERE dst_id = ?`, id);
    return c ?? { n: 0, f: 0 };
}

/**
 * Hints inside tool output name the next tool to call; through the CLI they must name the
 * equivalent command instead (`symbol <target>`, not `get_symbol(…)`).
 */
const CLI_NAMES = { search_code: 'search', search_text: 'grep', get_symbol: 'symbol', read_code: 'read', find_references: 'refs', call_graph: 'callgraph', change_impact: 'impact', check_changes: 'check', outline: 'outline', find_files: 'files' };
let surface = 'mcp';
const tn = (name) => (surface === 'cli' ? `\`${CLI_NAMES[name]}\`` : name);

/**
 * Agents often pass absolute paths (`/work/repo/src`, `./src/`): path arguments are relative to
 * the repository root everywhere else, so normalise them once here.
 */
function relativePaths(intel, args) {
    const root = String(intel.root ?? '').replace(/\/+$/, '');
    const rel = (p) => {
        if (typeof p !== 'string') return p;
        let r = p.trim();
        if (root && (r === root || r.startsWith(root + '/'))) r = r.slice(root.length + 1);
        r = r.replace(/^\.\/+/, '');
        return r === '.' ? '' : r;
    };
    const out = { ...args };
    if ('path' in out) out.path = rel(out.path);
    if (Array.isArray(out.files)) out.files = out.files.map(rel);
    else if (typeof out.files === 'string') out.files = out.files.split(',').map(rel);
    return out;
}

export async function callTool(intel, name, args = {}, { cli = false } = {}) {
    surface = cli ? 'cli' : 'mcp';
    try { return await dispatchTool(intel, name, relativePaths(intel, args ?? {})); } finally { surface = 'mcp'; }
}

async function dispatchTool(intel, name, args) {
    switch (name) {
        case 'search_code': return toolSearch(intel, args);
        case 'search_text': return toolText(intel, args);
        case 'read_code': return toolRead(intel, args);
        case 'get_symbol': return toolSymbol(intel, args); // predates read_code; no longer listed
        case 'find_references': return toolReferences(intel, args);
        case 'call_graph': return toolCallGraph(intel, args);
        case 'change_impact': return toolImpact(intel, args);
        case 'outline': return toolOutline(intel, args);
        case 'check_changes': return toolCheck(intel, args);
        case 'find_files': return toolFiles(intel, args); // CLI helper (`files`): MCP hosts have their own file finder
        default: throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
    }
}

function toolFiles(intel, { pattern, path: p = null, limit = 100 }) {
    const pat = String(pattern ?? '').trim();
    if (!pat) return 'Provide part of a file path or name, or a glob (*.toml, tests/test_*.py, docs/**).';
    const glob = /[*?[{]/.test(pat);
    const all = findFiles(intel.root, pat, { path: p });
    const under = p ? ` under ${p}` : '';
    if (!all.length) return `No file path ${glob ? 'matches' : 'contains'} "${pat}"${under}. Text without wildcards is matched anywhere in the path, ignoring case; a glob without a slash is matched against file names. To search inside files use ${tn('search_text')}.`;
    const tests = new Set(intel.store.all('SELECT path FROM files WHERE is_test = 1').map(f => f.path));
    const n = Math.min(Math.max(1, limit), 1000);
    const out = [`${plural(all.length, 'file')} ${glob ? `matching "${pat}"` : `with "${pat}" in the path`}${under}:`];
    for (const f of all.slice(0, n)) out.push(f + (tests.has(f) ? '  (test)' : ''));
    if (all.length > n) out.push(`… ${all.length - n} more (narrow the pattern, or pass a path or a higher limit)`);
    return out.join('\n');
}

async function toolSearch(intel, { query, path: p = null, kind = null, limit = 8 }) {
    if (!query || !String(query).trim()) return 'Provide a query: a behaviour description or an identifier.';
    const { results, total } = intel.search.search(String(query), { limit: Math.min(Math.max(1, limit), 30), path: p || null, kinds: kind ? [kind] : null });
    if (!results.length) return `No matches for "${query}"${p ? ` under ${p}` : ''}. Try other words for the behaviour, an identifier fragment, or outline for a map of the repository.`;
    const syms = results.map(r => intel.sym(r.id)).filter(Boolean);
    await intel.revalidate([...new Set(syms.map(s => s.path))]);
    const a = analyzeQuery(query);
    const terms = [...new Set([...a.terms, ...a.identifiers.map(x => x.toLowerCase())])];
    const out = [`${plural(syms.length, 'result')} for "${clip(query, 80)}"${total > syms.length ? ` (of ${total} candidates)` : ''}:`];
    syms.forEach((s, i) => {
        out.push(`${i + 1}. ${s.qname} — ${s.kind}${s.is_test ? ', test' : ''} · ${loc(s)}`);
        if (s.sig) out.push(`   ${clip(s.sig, 180)}`);
        if (s.doc) out.push(`   ${clip(s.doc, 160)}`);
        if (i < 5 && !TYPE_KINDS.has(s.kind)) {
            const lines = intel.fileLines(s.path);
            for (const ln of matchingLines(lines, s, terms, 2)) out.push(`   ${ln}: ${clip(lines[ln - 1].trim(), 150)}`);
        }
    });
    out.push(surface === 'cli' ? 'Next: `read <name | path:START-END>…` to read them (several at once); `refs` / `callgraph` for usages.' : 'Next: read_code with the names you want (several at once); find_references / call_graph for usages.');
    return out.join('\n');
}

async function toolText(intel, { pattern, path: p = null, literal = false, ignore_case = false, limit = 60 }) {
    if (!pattern) return 'Provide a pattern.';
    const r = await textSearch(intel, { pattern: String(pattern), path: p, literal, ignoreCase: ignore_case, limit: Math.min(Math.max(1, limit), 300) });
    if (r.error) return r.error;
    const shownPat = literal ? `"${clip(pattern, 60)}"` : `/${clip(pattern, 60)}/${ignore_case ? 'i' : ''}`;
    if (!r.total) return [`No matches for ${shownPat}${p ? ` under ${p}` : ''}.`, ...definitionRescue(intel, pattern, literal, r)].join('\n');
    const out = [`${plural(r.total, 'match', 'matches')} in ${plural(r.files, 'file')} for ${shownPat}${p ? ` under ${p}` : ''}${r.truncated ? ` (showing ${r.shown.length}; code first, then tests, examples and other files)` : ''}:`];
    let cur = null;
    for (const m of r.shown) {
        if (m.path !== cur) { cur = m.path; out.push(m.path + (m.isTest ? '  (test)' : '')); }
        // compact: the enclosing definition is the context; tags only where they add something
        const tag = m.what === 'def' ? 'def' : m.what === 'ref' ? `→ ${m.target}` : m.what === 'unbound' ? 'unbound' : m.what === 'comment' ? 'comment' : '';
        const where = m.encl && m.what !== 'def' ? `(${m.encl})` : '';
        const label = [tag, where].filter(Boolean).join(' ');
        out.push(`${String(m.line).padStart(6)} ${label ? label + ' ' : ''}│ ${clip(m.text.trim(), 120)}`);
    }
    if (r.truncated) out.push(`… ${r.total - r.shown.length} more matching lines (narrow with path, or raise limit)`);
    const sm = r.summary;
    if (sm) {
        const parts = [...sm.targets].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => { const [q, fp] = k.split('\u0000'); return `${n} → ${q} (${fp})`; });
        if (sm.targets.size > 6) parts.push(`${sm.targets.size - 6} more targets`);
        if (sm.defs) parts.push(`${sm.defs} definition${sm.defs === 1 ? '' : 's'}`);
        if (sm.unbound) parts.push(`${sm.unbound} unbound`);
        if (sm.text) parts.push(`${sm.text} in comments/strings/other text`);
        if (sm.nonCode) parts.push(`${sm.nonCode} in non-code files`);
        out.push(`"${sm.ident}" across all ${r.total} matches: ${parts.join(', ')}.`);
    }
    out.push(...definitionRescue(intel, pattern, literal, r));
    return out.join('\n');
}

/**
 * A search for a name whose definition it did not match — wrong file or directory, a pattern that
 * misses the definition line, a name defined in another module — says where the definition is,
 * so the next call is a read instead of another search.
 */
function definitionRescue(intel, pattern, literal, r) {
    if (r.summary?.defs) return [];
    const ident = identifierOf(String(pattern), literal);
    if (!ident || ident.length < 3) return [];
    const defs = intel.store.all(`SELECT s.id, s.qname, s.kind, s.start_line, s.sig, f.path FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE s.name = ? AND s.kind NOT IN ('variable', 'parameter') ORDER BY f.is_test, (SELECT COUNT(*) FROM refs x WHERE x.dst_id = s.id) DESC LIMIT 4`, ident);
    if (!defs.length) return [];
    const shown = defs.slice(0, 3).map(d => `${d.qname}  ${d.path}:${d.start_line}  ${clip(String(d.sig || d.kind).replace(/\s+/g, ' '), 100)}`);
    return [`${r.total ? 'None of these matches is where' : 'Not found here, but'} "${ident}" is defined${defs.length > 3 ? ' (first 3 of several)' : ''}:`, ...shown.map(x => `  ${x}`)];
}

/**
 * "Defined elsewhere" card for lines [from, to] of a file: one line per definition the code uses that
 * lives outside those lines — qualified name, location, signature (and the first doc line for the top
 * few) — so a read also answers where the names it contains are defined. Definitions already listed
 * in this answer (`seen`) are not repeated.
 */
function definitionsCard(intel, file, from, to, { seen = new Set(), skipAncestorsOf = null, max = 10, docs = 3 } = {}) {
    const { rows, more } = definitionsUsed(intel, file, from, to, { max, skipIds: seen, skipAncestorsOf });
    if (!rows.length) return [];
    const out = ['Defined elsewhere (used above):'];
    rows.forEach((s, i) => {
        seen.add(s.id);
        const sig = clip(String(s.sig || `${s.kind} ${s.name}${s.type ? `: ${s.type}` : ''}`).replace(/\s+/g, ' ').replace(/([([{])\s+/g, '$1').replace(/,?\s+([)\]}])/g, '$1').replace(/:\s+#.*$/, ':').replace(/\s+#.*$/, ''), 110);
        const doc = i < docs && s.doc ? ` — ${clip(s.doc.split('\n').map(l => l.trim()).find(Boolean) ?? '', 80)}` : '';
        out.push(`  ${s.qname}  ${s.path}:${s.start_line}${s.byName ? ' (by name)' : ''}  ${sig}${doc}`);
    });
    // the rest in one line, still with where each one is
    if (more.length) out.push(`  … ${more.length} more: ${more.slice(0, 12).map(s => `${s.qname} ${s.path}:${s.start_line}`).join(', ')}${more.length > 12 ? ', …' : ''}`);
    return out;
}

/** Card rows for a read of n lines: about one per dozen lines read, between 8 and 25. */
const cardRows = (n) => Math.min(25, Math.max(8, Math.round(n / 12)));

// whole-file reads return files up to this many lines; longer ones come back as their outline
const READ_WHOLE_MAX = 300;

async function toolRead(intel, { targets = [], target = null, full = false, max_lines = 200 }) {
    let list = Array.isArray(targets) ? [...targets] : typeof targets === 'string' ? targets.split(/[\s,]+/) : [];
    if (target) list.unshift(target);
    list = list.map(t => String(t).trim()).filter(Boolean);
    if (!list.length) return 'Provide one or more targets: a symbol (Class.method), a file, or file:START-END.';
    const seen = new Set();
    const sections = [];
    for (const t of list.slice(0, 12)) sections.push(await readOne(intel, t, { full, maxLines: max_lines, seen }));
    if (list.length > 12) sections.push(`(${list.length - 12} more targets not read: at most 12 per call)`);
    return sections.join('\n\n');
}

function isFile(intel, rel) {
    try { return fs.statSync(path.join(intel.root, rel)).isFile(); } catch { return false; }
}

async function readOne(intel, raw, { full, maxLines, seen }) {
    const root = String(intel.root ?? '').replace(/\/+$/, '');
    const t = raw.startsWith(root + '/') ? raw.slice(root.length + 1) : raw.replace(/^\.\/+/, '');
    const m = /^(.+?):(\d+)-(\d+)$/.exec(t);
    if (m && isFile(intel, m[1])) return readRange(intel, m[1], Number(m[2]), Number(m[3]), { maxLines, seen });
    if (isFile(intel, t)) return readFile(intel, t, { full, seen });
    // anything else names a definition: name, Class.member, path:Name, path:LINE
    return toolSymbol(intel, { symbol: t, include_code: true, max_lines: maxLines, seen });
}

async function readFile(intel, rel, { full, seen }) {
    const indexed = intel.store.get('SELECT id FROM files WHERE path = ?', rel);
    if (indexed) await intel.revalidate([rel]);
    const lines = intel.fileLines(rel);
    if (!lines) return `Cannot read ${rel}.`;
    const n = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    if (!full && indexed && n > READ_WHOLE_MAX) {
        return fileOutline(intel, rel, 1500) + `\n(${n} lines, so this is the outline. Read the parts you need by range or name — ${surface === 'cli' ? `\`read ${rel}:START-END Name …\`` : 'read_code with several targets'} — or the whole file with ${surface === 'cli' ? '`--full`' : 'full: true'}.)`;
    }
    const cap = full ? 2000 : READ_WHOLE_MAX;
    const out = [`${rel} — ${plural(n, 'line')}`, codeBlock(lines, 1, n, { maxLines: cap })];
    if (n > cap) out.push(`(${n - cap} more lines: read ${rel}:${cap + 1}-${n})`);
    if (indexed) out.push(...definitionsCard(intel, rel, 1, Math.min(n, cap), { seen, max: cardRows(Math.min(n, cap)) }));
    return out.join('\n');
}

async function readRange(intel, rel, a, b, { maxLines, seen }) {
    const indexed = intel.store.get('SELECT id FROM files WHERE path = ?', rel);
    if (indexed) await intel.revalidate([rel]);
    const lines = intel.fileLines(rel);
    if (!lines) return `Cannot read ${rel}.`;
    if (a > b) [a, b] = [b, a];
    a = Math.max(1, a); b = Math.min(b, lines.length);
    if (a > b) return `${rel} has ${plural(lines.length, 'line')}; nothing at ${a}-${b}.`;
    const encl = intel.store.get(`SELECT s.qname, s.kind, s.start_line, s.end_line FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.path = ? AND s.start_line <= ? AND s.end_line >= ? ORDER BY (s.end_line - s.start_line) ASC LIMIT 1`, rel, a, b);
    const cap = Math.max(maxLines, 400);
    const out = [`${rel}:${a}-${b}${encl ? ` — in ${encl.qname} (${encl.kind}, ${encl.start_line}-${encl.end_line})` : ''}`, codeBlock(lines, a, b, { maxLines: cap })];
    if (b - a + 1 > cap) out.push(`(${b - a + 1 - cap} more lines: read ${rel}:${a + cap}-${b})`);
    if (indexed) out.push(...definitionsCard(intel, rel, a, Math.min(b, a + cap - 1), { seen, max: cardRows(Math.min(b - a + 1, cap)) }));
    return out.join('\n');
}

async function toolSymbol(intel, { symbol, include_code = true, max_lines = 200, seen = new Set() }) {
    const matches = pickSymbol(intel, symbol);
    if (!matches.length) return notFound(intel, symbol);
    const s = matches[0];
    await intel.revalidate([s.path]);
    const fresh = intel.sym(s.id) ?? s;
    const out = [`${fresh.qname} — ${fresh.kind}${fresh.exported ? ', exported' : ''}${fresh.is_test ? ', test' : ''} · ${loc(fresh)}`];
    if (fresh.sig) out.push(`signature: ${clip(fresh.sig, 300)}`);
    if (fresh.doc) out.push(`doc: ${clip(fresh.doc, 400)}`);
    if (fresh.parent_id) { const p = intel.sym(fresh.parent_id); if (p) out.push(`member of: ${p.qname} (${p.kind}) ${loc(p)}`); }
    const bases = fresh.bases ? JSON.parse(fresh.bases) : [];
    if (bases.length) out.push(`extends/implements: ${bases.join(', ')}`);
    if (TYPE_KINDS.has(fresh.kind)) {
        const mem = [...intel.members(fresh.id), ...intel.ownedMembers(fresh)];
        if (mem.length) {
            out.push(`members (${mem.length}):`);
            for (const m of mem.slice(0, 60)) out.push(`  ${String(m.start_line).padStart(5)}  ${m.kind.padEnd(9)} ${clip(m.sig || m.name, 150)}${m.path && m.path !== fresh.path ? `  (${m.path})` : ''}`);
            if (mem.length > 60) out.push(`  … ${mem.length - 60} more`);
        }
        const { direct, indirect } = subtypeTree(intel, fresh.id);
        if (direct.length) out.push(`subtypes/implementations (${direct.length}${direct.length > 20 ? ', showing 20' : ''}): ${direct.slice(0, 20).map(x => `${x.qname} (${x.path}:${x.start_line})`).join(', ')}`);
        if (indirect.length) out.push(`indirect, through one of those (${indirect.length}${indirect.length > 20 ? ', showing 20' : ''}): ${indirect.slice(0, 20).map(x => `${x.qname} via ${x.via} (${x.path}:${x.start_line})`).join(', ')}`);
    }
    if (fresh.kind === 'method' && !fresh.is_static) {
        const fam = intel.methodFamily(fresh);
        const order = (a, b) => (a.is_test - b.is_test) || pathRank(a.path) - pathRank(b.path) || a.path.localeCompare(b.path);
        fam.up.sort(order); fam.down.sort(order);
        if (fam.up.length) out.push(`overrides/implements: ${fam.up.slice(0, 6).map(m => `${m.qname} (${m.path}:${m.start_line})`).join(', ')}`);
        if (fam.down.length) out.push(`overridden by (${fam.down.length}): ${fam.down.slice(0, 12).map(m => `${m.qname} (${m.path}:${m.start_line})`).join(', ')}${fam.down.length > 12 ? ', …' : ''}`);
    }
    // what the body uses that is defined elsewhere, with signatures (read the listed targets rather
    // than searching for them); the bare callee list only when there is no card to show
    seen.add(fresh.id);
    const card = definitionsCard(intel, fresh.path, fresh.start_line, fresh.end_line, { seen, skipAncestorsOf: fresh.id, max: cardRows(Math.min(fresh.end_line - fresh.start_line + 1, max_lines)) });
    const callees = card.length ? [] : intel.callees(fresh.id).filter(c => c.dst_id != null);
    if (callees.length && !TYPE_KINDS.has(fresh.kind)) {
        const uniq = new Map();
        for (const c of callees) if (!uniq.has(c.dst_id)) uniq.set(c.dst_id, c);
        out.push(`calls (${uniq.size}): ${[...uniq.values()].slice(0, 12).map(c => `${c.dst_qname} (${c.dst_path}:${c.dst_line})`).join(', ')}${uniq.size > 12 ? ', …' : ''}`);
    }
    // same counting as find_references (overloads and the method family included)
    const refs = intel.references(fresh.id, { minConf: 0.4 });
    if (refs.total) {
        const top = [...refs.groups.values()].flat().slice(0, 8);
        out.push(`used by: ${plural(refs.total, 'reference')} in ${plural(refs.groups.size, 'file')} — e.g. ${top.map(t => `${t.src_qname ?? '(module)'} ${t.path}:${t.line}`).join(', ')}${refs.total > 8 ? ` … (${tn('find_references')} for all)` : ''}`);
    } else out.push(`used by: no bound references${VALUE_KINDS.has(fresh.kind) ? ' (field/attribute uses through untyped receivers are not all indexed — grep the name before concluding it is unused)' : ' (may be an entry point, framework-invoked, or called dynamically)'}.`);
    if (refs.unbound?.plausible.length) out.push(`also possibly used at: ${refs.unbound.plausible.slice(0, 5).map(r => `${r.path}:${r.line}`).join(', ')}${refs.unbound.plausible.length > 5 ? ', …' : ''} (unknown receiver type, file mentions ${typeList(refs.unbound.typeNames) || 'it'})`);
    const tests = fresh.is_test ? [] : testsUsing(intel, fresh.id);
    if (tests.length) out.push(`tested in: ${tests.slice(0, 3).map(t => `${t.qname} (${t.path}:${t.line})`).join(', ')}${tests.length > 3 ? ', …' : ''}`);
    if (include_code) {
        const lines = intel.fileLines(fresh.path);
        const span = fresh.end_line - fresh.start_line + 1;
        const cap = TYPE_KINDS.has(fresh.kind) && span > max_lines ? Math.min(max_lines, 40) : max_lines;
        out.push('');
        out.push(codeBlock(lines, fresh.start_line, fresh.end_line, { maxLines: cap }));
        if (span > cap) out.push(`(${span - cap} more lines — read ${fresh.path}:${fresh.start_line + cap}-${fresh.end_line} or ${tn('read_code')} on a member)`);
    }
    if (card.length) out.push(...card);
    if (matches.length > 1) {
        out.push('');
        out.push(`${matches.length - 1} other definition${matches.length > 2 ? 's' : ''} named "${symbol}":`);
        for (const m of matches.slice(1, 8)) out.push(`  ${symHeader(m)}`);
    }
    return out.join('\n');
}

async function toolReferences(intel, { symbol, kind = 'all', include_tests = true, limit = 80, path: p = null }) {
    const matches = pickSymbol(intel, symbol);
    if (!matches.length) return notFound(intel, symbol);
    const s = matches[0];
    const all = intel.references(s.id, { kinds: kind && kind !== 'all' ? [kind] : null, includeTests: include_tests });
    const inPath = pathFilter(p);
    const groups = p ? new Map([...all.groups].filter(([f]) => inPath(f))) : all.groups;
    const res = { ...all, groups, total: p ? [...groups.values()].reduce((n, rows) => n + rows.length, 0) : all.total };
    const files = [...res.groups.keys()];
    await intel.revalidate(files);
    const counts = {};
    for (const rows of res.groups.values()) for (const r of rows) counts[r.confidence] = (counts[r.confidence] ?? 0) + 1;
    const cstr = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
    const scope = p ? ` under ${p}${all.total !== res.total ? ` (of ${all.total})` : ''}` : '';
    const out = [`References to ${s.qname} (${s.kind}) ${loc(s)} — ${res.total} in ${plural(files.length, 'file')}${scope}${cstr ? ` (${cstr})` : ''}`];
    if (matches.length > 1) out.push(`note: "${symbol}" matches ${matches.length} definitions; showing ${shownAs(s, matches)}. Others (pass one as symbol): ${otherDefinitions(intel, matches)}.`);
    let shown = 0;
    for (const [file, rows] of res.groups) {
        if (shown >= limit) break;
        const lines = intel.fileLines(file);
        out.push(file + (rows[0].is_test ? '  (test)' : ''));
        for (const r of rows) {
            if (shown >= limit) break;
            // an `implements`/`extends` clause may sit lines below the declaration it belongs to
            const decl = r.kind === 'inherit' && r.src_line && r.src_line !== r.line ? ` (${r.src_kind} at line ${r.src_line})` : '';
            const src = r.src_qname ? `in ${r.src_qname}${decl}` : 'module level';
            const via = r.via ? ` via ${r.via}` : '';
            const conf = r.confidence === 'exact' ? '' : ` [${r.confidence}${r.ncand > 1 ? `, ${r.ncand} candidates` : ''}]`;
            out.push(`  ${String(r.line).padStart(5)}  ${r.kind.padEnd(9)} ${src}${via}${conf}  │ ${clip((lines?.[r.line - 1] ?? '').trim(), 120)}`);
            shown++;
        }
    }
    if (res.total > shown) out.push(`… ${res.total - shown} more (raise limit, or filter with kind / path / include_tests=false)`);
    if (TYPE_KINDS.has(s.kind) && (!kind || kind === 'all' || kind === 'inherit')) out.push(...indirectNote(intel, s, { includeTests: include_tests, inPath, p }));
    const allKinds = !res.total && kind && kind !== 'all' ? intel.references(s.id, { includeTests: include_tests }).total : 0;
    if (allKinds) out.push(`No references of kind "${kind}"; ${plural(allKinds, 'reference')} of other kinds exist (use kind: "all").`);
    else if (!res.total) out.push(VALUE_KINDS.has(s.kind)
        ? `No bound references. Uses of fields/attributes through untyped receivers are not all indexed — grep "${s.name}" before concluding it is unused.`
        : 'No bound references. It may be unused, an entry point, invoked by a framework/reflection, or only called through dynamic receivers.');
    if (res.elsewhere?.length) out.push(`Other references named "${s.name}" resolve elsewhere: ${res.elsewhere.map(e => `${e.n} → ${e.qname} (${e.path})`).join(', ')}.`);
    out.push(...unboundNote(res.unbound, s));
    if (CALLABLE_KINDS.has(s.kind) && (!kind || kind === 'all' || kind === 'call') && all.total && !res.unbound?.total) {
        out.push(`Complete: every "${s.name}(…)" call in the indexed files is bound${res.elsewhere?.length ? ', here or to the definitions named above' : ' to this definition'}; none is left unresolved.`);
    }
    out.push(...stringMentionNote(intel, s));
    return out.join('\n');
}

/** `path` argument → predicate on repository-relative paths (a directory prefix or one file). */
function pathFilter(p) {
    if (!p) return () => true;
    const dir = p.replace(/\/+$/, '') + '/';
    return (f) => f === p || f.startsWith(dir);
}

/** Types that extend or implement a type: direct, and indirect through one of those (named in `via`). */
function subtypeTree(intel, id, maxDepth = 8) {
    const q = `SELECT DISTINCT src.id, src.qname, src.kind, src.start_line, f.path, f.is_test FROM refs r JOIN symbols src ON src.id = r.src_id JOIN files f ON f.id = src.file_id WHERE r.dst_id = ? AND r.kind = 'inherit' ORDER BY f.is_test, f.path, src.start_line`;
    const direct = intel.store.all(q, id);
    const seen = new Set([id, ...direct.map(x => x.id)]);
    const indirect = [];
    let frontier = direct;
    for (let depth = 2; depth <= maxDepth && frontier.length; depth++) {
        const next = [];
        for (const parent of frontier) {
            for (const x of intel.store.all(q, parent.id)) {
                if (seen.has(x.id)) continue;
                seen.add(x.id);
                next.push(x);
                indirect.push({ ...x, via: parent.qname });
            }
        }
        frontier = next;
    }
    indirect.sort((a, b) => (a.is_test - b.is_test) || a.path.localeCompare(b.path) || a.start_line - b.start_line);
    return { direct, indirect };
}

/** For a type: what inherits it through its direct subtypes, so "every implementation" is one answer. */
function indirectNote(intel, s, { includeTests, inPath, p, max = 30 }) {
    const { direct, indirect } = subtypeTree(intel, s.id);
    if (!direct.length) return [];
    const shown = indirect.filter(x => (includeTests || !x.is_test) && inPath(x.path));
    if (!shown.length) {
        const where = [p && `under ${p}`, !includeTests && 'outside tests'].filter(Boolean).join(' ');
        return [indirect.length
            ? `No indirect subtypes ${where} (${indirect.length} elsewhere).`
            : `No indirect subtypes: nothing extends or implements the types that inherit ${s.name} directly.`];
    }
    return [`Indirect subtypes (${shown.length}) — inherit ${s.name} through the type after "via":`,
        ...shown.slice(0, max).map(x => `  ${x.path}:${x.start_line}  ${x.kind} ${x.qname}  via ${x.via}${x.is_test ? '  (test)' : ''}`),
        ...(shown.length > max ? [`  … ${shown.length - max} more`] : [])];
}

/** Stubs/spies/getattr naming a member by string: a rename must update them, the index cannot bind them. */
function stringMentionNote(intel, s, max = 8) {
    const sm = intel.stringMentions(s.id);
    if (!sm.length) return [];
    const nf = new Set(sm.map(m => m.path)).size;
    return [`Also named as a string in ${plural(nf, 'file')} that use${nf === 1 ? 's' : ''} this class (stubs, spies, getattr — not bound by the index; a rename must update them):`,
        ...sm.slice(0, max).map(m => `  ${m.path}:${m.line}  │ ${clip(m.text, 110)}`),
        ...(sm.length > max ? [`  … ${sm.length - max} more`] : [])];
}

async function toolCallGraph(intel, { symbol, direction = 'both', depth = 2, limit = 40, include_tests = true }) {
    const matches = pickSymbol(intel, symbol);
    if (!matches.length) return notFound(intel, symbol);
    const s = matches[0];
    const out = [`Call graph of ${s.qname} (${s.kind}) ${loc(s)}`];
    if (direction === 'callers' || direction === 'both') {
        const kinds = ['call', 'new', 'value', 'decorator'];
        const isTestFile = (p) => Boolean(intel.store.get('SELECT is_test FROM files WHERE path = ?', p)?.is_test);
        // every direct caller of every node shown, so a function called from two places appears under
        // both; one reached again is marked instead of expanded twice
        const direct = (id) => {
            const { nodes, fileLevel } = intel.dependents([id], { depth: 1, maxNodes: 400, kinds });
            const callers = [...nodes].map(([k, info]) => ({ id: k, ...info, s: intel.sym(k) }))
                .filter(k => k.s && (include_tests || !k.s.is_test))
                .sort((a, b) => (a.s.is_test - b.s.is_test) || pathRank(a.s.path) - pathRank(b.s.path) || (b.conf - a.conf) || a.s.path.localeCompare(b.s.path) || a.s.start_line - b.s.start_line);
            const modules = [...fileLevel].filter(([f]) => include_tests || !isTestFile(f));
            return { callers, modules };
        };
        // levels first (breadth-first), so a function reachable at two depths is expanded at the
        // shallower one; then print every edge, a node's callers under its first appearance at its level
        const level = new Map([[s.id, 0]]), kids = new Map();
        let frontier = [s.id];
        for (let d = 1; d <= depth && frontier.length; d++) {
            const next = [];
            for (const id of frontier) {
                const got = direct(id);
                kids.set(id, got);
                for (const k of got.callers) if (!level.has(k.id)) { level.set(k.id, d); next.push(k.id); }
            }
            frontier = next;
        }
        const lines = [];
        const expanded = new Set([s.id]);
        let count = 0, cut = false;
        const walk = (id, indent, d) => {
            const { callers, modules } = kids.get(id) ?? { callers: [], modules: [] };
            for (const k of callers) {
                if (count >= limit) { cut = true; return; }
                const ks = k.s, here = level.get(k.id) === d && !expanded.has(k.id);
                count++;
                lines.push(`${'  '.repeat(indent)}← ${ks.qname}  ${loc(ks)}${ks.is_test ? '  (test)' : ''}${k.kind === 'override' ? '  (override)' : ''}${k.conf < 0.9 ? `  [${confWord(k.conf)}]` : ''}${here ? '' : '  (also listed elsewhere)'}`);
                if (here) { expanded.add(k.id); if (d < depth) walk(k.id, indent + 1, d + 1); }
            }
            // module-level code (scripts, describe blocks) calling this node, placed under it
            for (const [file, m] of modules) {
                if (count >= limit) { cut = true; return; }
                count++;
                lines.push(`${'  '.repeat(indent)}← module level of ${file}:${m.sites[0]}${isTestFile(file) ? '  (test)' : ''}${m.conf < 0.9 ? `  [${confWord(m.conf)}]` : ''}`);
            }
        };
        walk(s.id, 1, 1);
        const distinct = level.size - 1 + new Set([...kids.values()].flatMap(g => g.modules.map(([f]) => f))).size;
        out.push(`callers (${distinct} distinct${cut ? ' shown' : ''}, depth ≤ ${depth}${include_tests ? '' : ', tests left out'}; indentation = one call level):`);
        out.push(...lines);
        if (!lines.length) out.push('  (no bound callers — entry point, framework-invoked, or dynamic dispatch)');
        if (cut) out.push(`  … more callers not shown (raise limit or lower depth)`);
        const unbound = unboundNote(intel.unboundFor(s.id), s, 5);
        if (unbound.length) out.push(...unbound.map(l => '  ' + l));
        else if (!cut) out.push(`  Complete: every call the index binds is listed${depth > 1 ? ' at each level' : ''}, and no same-name call with a receiver of unknown type could reach ${s.name}.`);
    }
    if (direction === 'callees' || direction === 'both') {
        out.push('callees:');
        let count = 0;
        const seen = new Set([s.id]);
        const walk = (id, indent, d) => {
            const uniq = new Map();
            for (const c of intel.callees(id)) if (c.dst_id != null && !uniq.has(c.dst_id)) uniq.set(c.dst_id, c);
            for (const c of uniq.values()) {
                if (count >= limit) return;
                count++;
                const again = seen.has(c.dst_id);
                seen.add(c.dst_id);
                out.push(`${'  '.repeat(indent)}→ ${c.dst_qname}  ${c.dst_path}:${c.dst_line}${c.conf < 0.9 ? `  [${confWord(c.conf)}]` : ''}${again ? '  (seen)' : ''}`);
                if (!again && d < depth) walk(c.dst_id, indent + 1, d + 1);
            }
        };
        walk(s.id, 1, 1);
        if (count === 0) out.push('  (calls nothing inside this repository)');
        const external = intel.callees(s.id).filter(c => c.dst_id == null).map(c => (c.recv ? `${c.recv}.` : '') + c.name);
        if (external.length) out.push(`  external/unbound: ${[...new Set(external)].slice(0, 12).join(', ')}${external.length > 12 ? ', …' : ''}`);
    }
    if (matches.length > 1) out.push(`note: "${symbol}" matches ${matches.length} definitions; showing ${shownAs(s, matches)}. Others (pass one as symbol): ${otherDefinitions(intel, matches)}.`);
    return out.join('\n');
}

async function toolImpact(intel, { symbols = [], files = [], diff = false, depth = 3 }) {
    const seeds = new Set();
    const labels = [];
    const seedFiles = new Set(files);
    if (diff) {
        const d = intel.diffSeeds();
        if (d.error) return `Could not read the git diff: ${d.error}`;
        for (const id of d.seeds) seeds.add(id);
        for (const f of d.files) seedFiles.add(f);
        labels.push(`uncommitted diff (${plural(d.files.length, 'file')}, ${plural(d.seeds.length, 'changed symbol')})`);
    }
    for (const t of symbols) {
        const m = pickSymbol(intel, t);
        if (!m.length) { labels.push(`"${t}" (not found)`); continue; }
        seeds.add(m[0].id);
        seedFiles.add(m[0].path);
        labels.push(`${m[0].qname}`);
    }
    for (const f of files) {
        const rows = intel.store.all(`SELECT s.id FROM symbols s JOIN files fl ON fl.id = s.file_id WHERE fl.path = ? AND (s.parent_id IS NULL OR s.kind IN ('method','function'))`, f.replace(/^\.\//, ''));
        for (const r of rows) seeds.add(r.id);
        labels.push(f);
    }
    if (!seeds.size) return 'Nothing to analyse: pass symbols, files, or diff:true (with uncommitted changes).';
    const { nodes, fileLevel, truncated, overflow } = intel.dependents([...seeds], { depth, maxNodes: 400 });
    const direct = [], overrides = [], transitive = new Map();
    const tests = new Map();
    const affectedFiles = new Set();
    const addTest = (file, what) => { const a = tests.get(file) ?? tests.set(file, []).get(file); if (!a.includes(what)) a.push(what); };
    for (const [id, info] of nodes) {
        const s = intel.sym(id);
        if (!s) continue;
        affectedFiles.add(s.path);
        if (s.is_test) { addTest(s.path, s.name); continue; }
        if (info.kind === 'override') overrides.push({ s, info });
        else if (info.depth === 1) direct.push({ s, info });
        else (transitive.get(info.depth) ?? transitive.set(info.depth, []).get(info.depth)).push({ s, info });
    }
    const moduleUses = [];
    for (const [file, info] of fileLevel) {
        const isTest = intel.store.get('SELECT is_test FROM files WHERE path = ?', file)?.is_test;
        if (isTest) addTest(file, '(test code at module level / describe blocks)');
        else moduleUses.push([file, info]);
    }
    moduleUses.sort((a, b) => pathRank(a[0]) - pathRank(b[0]) || a[0].localeCompare(b[0]));
    overrides.sort((a, b) => pathRank(a.s.path) - pathRank(b.s.path) || a.s.path.localeCompare(b.s.path));
    for (const t of intel.conventionTests([...seedFiles])) if (!tests.has(t)) tests.set(t, ['(by naming convention)']);

    const out = [`Impact of changing ${labels.join(', ')}`];
    const seedSyms = [...seeds].map(id => intel.sym(id)).filter(Boolean);
    const exported = seedSyms.filter(s => s.exported && !s.is_test);
    if (exported.length) out.push(`public surface: ${exported.slice(0, 8).map(s => s.qname).join(', ')}${exported.length > 8 ? ', …' : ''} ${exported.length === 1 ? 'is' : 'are'} exported`);

    // 1. what has to change with a signature change: direct call sites and overrides
    const siteCount = direct.reduce((n, x) => n + Math.max(1, x.info.sites?.length ?? 0), 0);
    const examples = direct.filter(x => pathRank(x.s.path)).length;
    out.push(`direct uses (update these if the signature or contract changes): ${plural(siteCount, 'site')} in ${plural(direct.length, 'function')}${examples ? ` (${examples} in examples/docs)` : ''}${truncated ? `; ${overflow} more dependents beyond the analysis limit (examples/docs first to be cut)` : ''}`);
    direct.sort((a, b) => pathRank(a.s.path) - pathRank(b.s.path) || b.info.conf - a.info.conf || a.s.path.localeCompare(b.s.path));
    let shown = 0;
    for (const { s, info } of direct) {
        if (shown >= 30) break;
        const sites = info.sites?.length ? info.sites : [{ path: s.path, line: s.start_line }];
        for (const site of sites.slice(0, 3)) {
            if (shown >= 30) break;
            out.push(`    ${site.path}:${site.line}  in ${s.qname}${info.conf < 0.9 ? `  [${confWord(info.conf)}]` : ''}`);
            shown++;
        }
    }
    if (siteCount > shown) out.push(`    … ${siteCount - shown} more (${tn('find_references')} on the symbol lists them all)`);
    for (const [file, info] of moduleUses.slice(0, 8)) out.push(`    ${file}:${info.sites[0]}  (module level)${info.conf < 0.9 ? `  [${confWord(info.conf)}]` : ''}`);
    if (moduleUses.length > 8) out.push(`    … ${moduleUses.length - 8} more files with module-level uses`);
    if (overrides.length) {
        out.push(`overrides / implementations (keep them in line with the change): ${overrides.length}`);
        for (const { s } of overrides.slice(0, 15)) out.push(`    ${s.qname}  ${loc(s)}`);
        if (overrides.length > 15) out.push(`    … ${overrides.length - 15} more`);
    }
    // 2. what is affected further away
    const transTotal = [...transitive.values()].reduce((n, a) => n + a.length, 0);
    if (transTotal) {
        out.push(`transitively affected (callers of callers): ${transTotal} symbols${truncated ? ' — truncated, narrow the change set for the full list' : ''}`);
        for (const d of [...transitive.keys()].sort()) {
            const arr = transitive.get(d).sort((a, b) => b.info.conf - a.info.conf);
            out.push(`  distance ${d} (${arr.length}):`);
            for (const { s, info } of arr.slice(0, 12)) out.push(`    ${s.qname}  ${loc(s)}${info.conf < 0.9 ? `  [${confWord(info.conf)}]` : ''}`);
            if (arr.length > 12) {
                const byFile = new Map();
                for (const { s } of arr.slice(12)) byFile.set(s.path, (byFile.get(s.path) ?? 0) + 1);
                out.push(`    … ${arr.length - 12} more in ${[...byFile].slice(0, 6).map(([f, n]) => `${f} (${n})`).join(', ')}${byFile.size > 6 ? ', …' : ''}`);
            }
        }
    }
    // 3. tests
    if (tests.size) {
        out.push(`tests to run (${tests.size} file${tests.size === 1 ? '' : 's'}):`);
        for (const [f, names] of [...tests].slice(0, 15)) out.push(`    ${f}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`);
        if (tests.size > 15) out.push(`    … ${tests.size - 15} more test files`);
    } else out.push('tests: none found that reference the changed code (consider adding one).');
    // 4. what the index cannot see
    const blind = [];
    for (const s of seedSyms.slice(0, 12)) {
        if (s.kind === 'field' || s.kind === 'property') blind.push(`${s.qname}: field/attribute uses are only partly indexed (untyped receivers) — grep "${s.name}"`);
        const u = intel.unboundFor(s.id);
        if (u.plausible.length) blind.push(`${s.qname}: ${u.plausible.length} same-name call site${u.plausible.length === 1 ? '' : 's'} with unknown receiver type in files that mention ${u.typeNames.length ? u.typeNames.join('/') : 'it'} — ${u.plausible.slice(0, 4).map(r => `${r.path}:${r.line}`).join(', ')}${u.plausible.length > 4 ? ', …' : ''}`);
        const sm = intel.stringMentions(s.id);
        if (sm.length) blind.push(`${s.qname}: named as a string (stub/spy/getattr) at ${sm.slice(0, 4).map(m => `${m.path}:${m.line}`).join(', ')}${sm.length > 4 ? `, … ${sm.length - 4} more` : ''}`);
    }
    if (blind.length) { out.push('not visible to the index (check by hand):'); for (const b of blind) out.push(`    ${b}`); }
    const co = intel.coChange([...seedFiles]);
    if (co.length) out.push(`often changed together (git): ${co.map(c => `${c.file} (${c.together}/${c.of})`).join(', ')}`);
    const total = direct.length + overrides.length + transTotal + moduleUses.length;
    let risk = total > 40 || affectedFiles.size > 15 ? 'high' : total > 8 ? 'medium' : 'low';
    if (!total && (blind.length || exported.length)) risk = `unknown (no bound dependents, but ${blind.length ? 'the index has blind spots listed above' : 'the code is exported and may be used by callers outside this repository or by a framework'})`;
    out.push(`risk: ${risk} (${direct.length} direct, ${overrides.length} overrides, ${transTotal} transitive, ${tests.size} test files)`);
    return out.join('\n');
}

async function toolCheck(intel, { files = null, base = 'HEAD' }) {
    const r = await checkChanges(intel, { base, files: files?.length ? files : null });
    if (r.error) return r.error;
    if (!r.files) return `No changed source files against ${base}${files?.length ? ` under ${files.join(', ')}` : ''}.`;
    const out = [`Checked ${plural(r.files, 'changed file')} against ${base}.`];
    let problems = 0;
    if (r.syntax.length) {
        problems += r.syntax.length;
        out.push(`✗ syntax errors introduced (${r.syntax.length}):`);
        for (const e of r.syntax.slice(0, 8)) out.push(`    ${e.path}:${e.line}${e.missing ? ` (missing ${e.missing})` : ''}  │ ${clip(e.text, 120)}`);
    }
    for (const a of r.arity) {
        problems += a.sites.length;
        out.push(a.newCall
            ? `✗ call does not fit ${a.target} (${a.path}; takes ${a.is} argument${a.is === '1' ? '' : 's'}):`
            : `✗ ${a.sites.length} of ${a.total} call site${a.total === 1 ? '' : 's'} no longer fit${a.sites.length === 1 ? 's' : ''} ${a.target} (${a.path}; now takes ${a.is}, was ${a.was}):`);
        for (const x of a.sites.slice(0, 10)) out.push(`    ${x.path}:${x.line}${x.src_qname ? `  in ${x.src_qname}` : ''}  passes ${x.argc.n}${x.argc.open ? '+' : ''}  │ ${clip(x.text ?? '', 110)}`);
        if (a.sites.length > 10) out.push(`    … ${a.sites.length - 10} more`);
    }
    for (const m of r.removed) {
        problems += m.total + m.imports.length;
        out.push(`✗ ${m.qname} (${m.kind}, ${m.path}) was removed or renamed but is still used (${m.total}${m.imports.length ? ` + ${plural(m.imports.length, 'import')}` : ''}):`);
        for (const u of m.uses) out.push(`    ${u.path}:${u.line}${u.src_qname ? `  in ${u.src_qname}` : ''}${u.recv ? `  (${u.recv}.${m.qname.split('.').pop()})` : ''}`);
        if (m.total > m.uses.length) out.push(`    … ${m.total - m.uses.length} more`);
        for (const i of m.imports.slice(0, 6)) out.push(`    imported at ${i.path}:${i.line}`);
    }
    for (const u of r.untouched) {
        out.push(`• ${u.target} changed signature (${u.was} → ${u.is} arguments); ${plural(u.sites.length, 'call site')} in files you did not modify still fit — review them if the meaning changed:`);
        for (const x of u.sites.slice(0, 8)) out.push(`    ${x.path}:${x.line}${x.src_qname ? `  in ${x.src_qname}` : ''}  │ ${clip(x.text ?? '', 110)}`);
        if (u.sites.length > 8) out.push(`    … ${u.sites.length - 8} more`);
    }
    if (r.cases.length) {
        const name = (c) => `${c.path}::${c.cls ? `${c.cls}::` : ''}${c.name}`;
        out.push(`test functions that reach the changed code through calls the index sees, or that you changed (${r.casesTotal}${r.casesTotal > r.cases.length ? `, first ${r.cases.length}` : ''}): ${r.cases.map(name).join(', ')}`);
        for (const c of r.caseCommands) out.push(`    run these first: ${clip(c, 600)}`);
    }
    if (r.tests.length) {
        out.push(`test files that exercise the change (${r.tests.length}): ${r.tests.slice(0, 12).join(', ')}${r.tests.length > 12 ? ', …' : ''}`);
        for (const c of r.commands) out.push(`    run: ${clip(c, 400)}`);
    } else out.push('tests: none found that exercise the changed code.');
    out.push(problems ? `${plural(problems, 'problem')} found.` : 'No problems found in the changed code (this check does not replace running the tests).');
    return out.join('\n');
}

/** Every definition of an indexed file with its signature and line range, within a token budget. */
function fileOutline(intel, rel, maxTokens = 1500) {
    const rows = intel.store.all(`SELECT s.id, s.qname, s.name, s.kind, s.parent_id, s.start_line, s.end_line, s.sig, s.doc FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? ORDER BY s.start_line`, rel);
    const f = intel.store.get('SELECT lines, lang, is_test FROM files WHERE path = ?', rel);
    const depthOf = new Map();
    const out = [`${rel} — ${f.lang}, ${f.lines} lines, ${plural(rows.length, 'symbol')}${f.is_test ? ', test file' : ''}`];
    const imports = intel.store.all('SELECT DISTINCT source FROM imports i JOIN files f ON f.id = i.file_id WHERE f.path = ? LIMIT 30', rel).map(r => r.source);
    if (imports.length) out.push(`imports: ${imports.join(', ')}`);
    let budget = maxTokens * 4;
    for (const r of rows) {
        const d = r.parent_id != null ? (depthOf.get(r.parent_id) ?? 0) + 1 : 0;
        depthOf.set(r.id, d);
        if (r.kind === 'field' && d > 1) continue;
        const line = `${String(r.start_line).padStart(5)}-${String(r.end_line).padEnd(5)} ${'  '.repeat(d)}${describe(r)}`;
        budget -= line.length;
        if (budget < 0) { out.push(`… truncated (${rows.length} symbols); raise max_tokens`); break; }
        out.push(line);
    }
    return out.join('\n');
}

async function toolOutline(intel, { path: p = '', focus = null, max_tokens = 1500 }) {
    const rel = String(p || '').replace(/^\.\//, '').replace(/\/$/, '');
    const isFile = rel && intel.store.get('SELECT id FROM files WHERE path = ?', rel);
    if (isFile) {
        await intel.revalidate([rel]);
        return fileOutline(intel, rel, max_tokens);
    }
    // directory / repository map
    let focusIds = null;
    if (focus) {
        const { results } = intel.search.search(focus, { limit: 10 });
        focusIds = results.map(r => r.id);
    }
    const ranked = intel.rankedSymbols({ focusIds, pathPrefix: rel || null, limit: 600 });
    if (!ranked.length) return rel ? `No indexed code under "${rel}".` : 'The index is empty.';
    const st = intel.stats();
    const header = rel ? `Map of ${rel}/ (most central symbols first${focus ? `, focused on "${clip(focus, 60)}"` : ''})` : `Repository map: ${st.files} files, ${st.symbols} symbols (${st.langs.slice(0, 5).map(l => `${l.lang} ${l.n}`).join(', ')}); most central symbols first${focus ? `, focused on "${clip(focus, 60)}"` : ''}`;
    const byFile = new Map();
    const fileOrder = [];
    for (const r of ranked) {
        if (!byFile.has(r.path)) { byFile.set(r.path, []); fileOrder.push(r.path); }
        byFile.get(r.path).push(r);
    }
    const budgetChars = max_tokens * 4;
    const render = (nFiles, perFile) => {
        const out = [header];
        for (const f of fileOrder.slice(0, nFiles)) {
            out.push(f);
            for (const r of byFile.get(f).slice(0, perFile).sort((a, b) => a.start_line - b.start_line)) out.push(`  ${String(r.start_line).padStart(5)} ${describe(r, 120)}`);
        }
        return out.join('\n');
    };
    // binary search on the number of files that fits the budget
    let lo = 1, hi = fileOrder.length, best = render(1, 6);
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const text = render(mid, 6);
        if (text.length <= budgetChars) { best = text; lo = mid + 1; } else hi = mid - 1;
    }
    const shownFiles = Math.min(fileOrder.length, hi < 1 ? 1 : hi);
    return best + (fileOrder.length > shownFiles ? `\n… ${fileOrder.length - shownFiles} more files (raise max_tokens, narrow path, or add focus)` : '');
}
