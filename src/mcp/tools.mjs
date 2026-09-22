/**
 * The MCP tool surface: six read-only tools, each answering one kind of question an agent has
 * while changing code. Descriptions say when to use the tool (and when grep/read is better);
 * outputs are compact text with file:line locations and explicit totals/truncation notes.
 */
import path from 'node:path';
import { analyzeQuery } from '../search/tokenize.mjs';
import { loc, clip, codeBlock, symHeader, confWord, matchingLines, plural } from './render.mjs';

const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'type', 'object', 'module', 'impl']);

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
            additionalProperties: false,
        },
    },
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
            additionalProperties: false,
        },
    },
    {
        name: 'find_references',
        title: 'Find references',
        description: 'List every place that uses a symbol — calls, instantiations, type annotations, inheritance, decorators and function references passed as values — grouped by file with line numbers, the enclosing function and the source line. Use it before renaming or changing a signature, or to learn how something is used. References are bound through scopes, imports and inferred receiver types (including dependency-injected fields); each carries a confidence (exact/high/likely/possible), calls through a parent class/interface are included and marked, and the footer states how many same-name call sites could not be bound (dynamic receivers) so you know when a grep cross-check is worthwhile.',
        inputSchema: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'Name, Class.member, path:Name or path:line.' },
                kind: { type: 'string', enum: ['all', 'call', 'type', 'inherit', 'new', 'value', 'decorator'], default: 'all', description: 'Only this reference kind.' },
                include_tests: { type: 'boolean', default: true },
                limit: { type: 'integer', minimum: 1, maximum: 500, default: 80 },
            },
            required: ['symbol'],
            additionalProperties: false,
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
            },
            required: ['symbol'],
            additionalProperties: false,
        },
    },
    {
        name: 'change_impact',
        title: 'Change impact',
        description: 'Blast radius of a change before (or after) you make it: the code that transitively depends on the given symbols or files, grouped by distance, the tests that exercise it, exported/public surface affected, and files that historically change together (git). Pass `symbols` and/or `files`, or set `diff: true` to analyse your current uncommitted changes (git working tree vs HEAD). Use it before editing a widely used function, and again before finishing a task to check what else might need updating or testing.',
        inputSchema: {
            type: 'object',
            properties: {
                symbols: { type: 'array', items: { type: 'string' }, description: 'Symbols you are changing.' },
                files: { type: 'array', items: { type: 'string' }, description: 'Files you are changing (all their symbols).' },
                diff: { type: 'boolean', default: false, description: 'Use the uncommitted git diff as the change set.' },
                depth: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
            },
            additionalProperties: false,
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
            additionalProperties: false,
        },
    },
];

for (const t of TOOLS) {
    t.annotations = { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

export const SERVER_INSTRUCTIONS = `graph-indexer serves a live structural index of this repository (definitions, references, call graph, tests) built with tree-sitter. It re-syncs with the files on disk before every answer, so results reflect your latest edits.
Typical workflow:
1. search_code to locate the code for a behaviour or identifier (or outline for a map of an unfamiliar area).
2. get_symbol to read just the definition you need (with line numbers) instead of whole files.
3. find_references / call_graph before changing a signature or behaviour: every caller with file:line.
4. change_impact (symbols, files or diff:true) to see what else depends on the change and which tests to run.
Confidence: exact/high = bound via scope, import or receiver type; likely/possible = name-based. Footers report unbound same-name call sites; grep them when you need certainty. Use grep/read for string literals, config and non-code files.`;

// ── handlers ─────────────────────────────────────────────────────────────────────

const SELF_DESCRIBING = /^(export\s+|pub(\([^)]*\))?\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|async\s+|abstract\s+|final\s+|override\s+|default\s+)*(function|func|def|fn|class|interface|struct|enum|trait|type|impl|module|namespace|object|record|macro_rules!|val|var|let|const|@)/;

/** A signature line that says what the symbol is without repeating the kind ("function function f"). */
function describe(r, max = 140) {
    const sig = r.sig || r.qname || r.name;
    return SELF_DESCRIBING.test(sig) ? clip(sig, max) : `${r.kind} ${clip(sig, max)}`;
}

function pickSymbol(intel, target) {
    const { matches } = intel.findSymbols(target);
    return matches;
}

function notFound(intel, target) {
    const { results } = intel.search.search(String(target), { limit: 5 });
    const sugg = results.map(r => intel.sym(r.id)).filter(Boolean).map(s => `  ${symHeader(s)}`);
    return `No symbol named "${target}".` + (sugg.length ? `\nClosest matches:\n${sugg.join('\n')}` : '\nTry search_code with a description of what it does.');
}

function refSummary(intel, id) {
    const c = intel.store.get(`SELECT COUNT(*) AS n, COUNT(DISTINCT file_id) AS f FROM refs WHERE dst_id = ?`, id);
    return c ?? { n: 0, f: 0 };
}

export async function callTool(intel, name, args = {}) {
    switch (name) {
        case 'search_code': return toolSearch(intel, args);
        case 'get_symbol': return toolSymbol(intel, args);
        case 'find_references': return toolReferences(intel, args);
        case 'call_graph': return toolCallGraph(intel, args);
        case 'change_impact': return toolImpact(intel, args);
        case 'outline': return toolOutline(intel, args);
        default: throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
    }
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
    out.push('Next: get_symbol(<name or path:line>) to read one; find_references / call_graph for usages.');
    return out.join('\n');
}

async function toolSymbol(intel, { symbol, include_code = true, max_lines = 200 }) {
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
        const subs = intel.store.all(`SELECT DISTINCT src.qname, f.path, src.start_line FROM refs r JOIN symbols src ON src.id = r.src_id JOIN files f ON f.id = src.file_id WHERE r.dst_id = ? AND r.kind = 'inherit' LIMIT 20`, fresh.id);
        if (subs.length) out.push(`subtypes/implementations: ${subs.map(x => `${x.qname} (${x.path}:${x.start_line})`).join(', ')}`);
    }
    const callees = intel.callees(fresh.id).filter(c => c.dst_id != null);
    if (callees.length && !TYPE_KINDS.has(fresh.kind)) {
        const uniq = new Map();
        for (const c of callees) if (!uniq.has(c.dst_id)) uniq.set(c.dst_id, c);
        out.push(`calls (${uniq.size}): ${[...uniq.values()].slice(0, 12).map(c => `${c.dst_qname} (${c.dst_path}:${c.dst_line})`).join(', ')}${uniq.size > 12 ? ', …' : ''}`);
    }
    const rs = refSummary(intel, fresh.id);
    if (rs.n) {
        const top = intel.store.all(`SELECT DISTINCT src.qname, f.path, r.line FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols src ON src.id = r.src_id WHERE r.dst_id = ? ORDER BY r.conf DESC LIMIT 8`, fresh.id);
        out.push(`used by: ${rs.n} references in ${plural(rs.f, 'file')} — e.g. ${top.map(t => `${t.qname ?? '(module)'} ${t.path}:${t.line}`).join(', ')}${rs.n > 8 ? ' … (find_references for all)' : ''}`);
    } else out.push('used by: no bound references (may be an entry point, framework-invoked, or called dynamically).');
    if (include_code) {
        const lines = intel.fileLines(fresh.path);
        const span = fresh.end_line - fresh.start_line + 1;
        const cap = TYPE_KINDS.has(fresh.kind) && span > max_lines ? Math.min(max_lines, 40) : max_lines;
        out.push('');
        out.push(codeBlock(lines, fresh.start_line, fresh.end_line, { maxLines: cap }));
        if (span > cap) out.push(`(${span - cap} more lines — read ${fresh.path}:${fresh.start_line + cap}-${fresh.end_line} or get_symbol on a member)`);
    }
    if (matches.length > 1) {
        out.push('');
        out.push(`${matches.length - 1} other definition${matches.length > 2 ? 's' : ''} named "${symbol}":`);
        for (const m of matches.slice(1, 8)) out.push(`  ${symHeader(m)}`);
    }
    return out.join('\n');
}

async function toolReferences(intel, { symbol, kind = 'all', include_tests = true, limit = 80 }) {
    const matches = pickSymbol(intel, symbol);
    if (!matches.length) return notFound(intel, symbol);
    const s = matches[0];
    const res = intel.references(s.id, { kinds: kind && kind !== 'all' ? [kind] : null, includeTests: include_tests });
    const files = [...res.groups.keys()];
    await intel.revalidate(files);
    const counts = {};
    for (const rows of res.groups.values()) for (const r of rows) counts[r.confidence] = (counts[r.confidence] ?? 0) + 1;
    const cstr = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
    const out = [`References to ${s.qname} (${s.kind}) ${loc(s)} — ${res.total} in ${plural(files.length, 'file')}${cstr ? ` (${cstr})` : ''}`];
    if (matches.length > 1) out.push(`note: "${symbol}" is ambiguous (${matches.length} definitions); showing ${s.path}. Qualify it (e.g. ${matches[1].path}:${matches[1].qname}) for another.`);
    let shown = 0;
    for (const [file, rows] of res.groups) {
        if (shown >= limit) break;
        const lines = intel.fileLines(file);
        out.push(file + (rows[0].is_test ? '  (test)' : ''));
        for (const r of rows) {
            if (shown >= limit) break;
            const src = r.src_qname ? `in ${r.src_qname}` : 'module level';
            const via = r.via ? ` via ${r.via}` : '';
            const conf = r.confidence === 'exact' ? '' : ` [${r.confidence}${r.ncand > 1 ? `, ${r.ncand} candidates` : ''}]`;
            out.push(`  ${String(r.line).padStart(5)}  ${r.kind.padEnd(9)} ${src}${via}${conf}  │ ${clip((lines?.[r.line - 1] ?? '').trim(), 120)}`);
            shown++;
        }
    }
    if (res.total > shown) out.push(`… ${res.total - shown} more (raise limit, or filter with kind / include_tests=false)`);
    if (!res.total) out.push('No bound references. It may be unused, an entry point, invoked by a framework/reflection, or only called through dynamic receivers.');
    if (res.unresolvedSameName) out.push(`Unbound: ${res.unresolvedSameName === 1 ? '1 other call site' : `${res.unresolvedSameName} other call sites`} named "${s.name}" ${res.unresolvedSameName === 1 ? 'has a receiver' : 'have receivers'} of unknown type and ${res.unresolvedSameName === 1 ? 'is' : 'are'} not counted — grep "${s.name}(" if you need an exhaustive list.`);
    return out.join('\n');
}

async function toolCallGraph(intel, { symbol, direction = 'both', depth = 2, limit = 40 }) {
    const matches = pickSymbol(intel, symbol);
    if (!matches.length) return notFound(intel, symbol);
    const s = matches[0];
    const out = [`Call graph of ${s.qname} (${s.kind}) ${loc(s)}`];
    if (direction === 'callers' || direction === 'both') {
        const { nodes, fileLevel } = intel.dependents([s.id], { depth, maxNodes: limit * 3, kinds: ['call', 'new', 'value', 'decorator'] });
        const byVia = new Map();
        for (const [id, info] of nodes) (byVia.get(info.via) ?? byVia.set(info.via, []).get(info.via)).push({ id, ...info });
        out.push(`callers (${nodes.size}${nodes.size >= limit ? '+' : ''}, depth ≤ ${depth}):`);
        let count = 0;
        const walk = (parent, indent, d) => {
            const kids = (byVia.get(parent) ?? []).map(k => ({ ...k, s: intel.sym(k.id) })).filter(k => k.s)
                .sort((a, b) => (a.s.is_test - b.s.is_test) || (b.conf - a.conf) || a.s.path.localeCompare(b.s.path));
            for (const k of kids) {
                if (count >= limit) return;
                const ks = k.s;
                count++;
                out.push(`${'  '.repeat(indent)}← ${ks.qname}  ${loc(ks)}${ks.is_test ? '  (test)' : ''}${k.conf < 0.9 ? `  [${confWord(k.conf)}]` : ''}`);
                if (d < depth) walk(k.id, indent + 1, d + 1);
            }
        };
        walk(s.id, 1, 1);
        if (!nodes.size) out.push('  (no bound callers — entry point, framework-invoked, or dynamic dispatch)');
        for (const [file, info] of [...fileLevel].slice(0, 5)) out.push(`  ← module level of ${file}${info.conf < 0.9 ? `  [${confWord(info.conf)}]` : ''}`);
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
    if (matches.length > 1) out.push(`note: ${matches.length} definitions match "${symbol}"; showing ${loc(s)}.`);
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
    const { nodes, fileLevel, truncated } = intel.dependents([...seeds], { depth, maxNodes: 400 });
    const byDepth = new Map();
    const tests = new Map();
    const affectedFiles = new Set();
    for (const [id, info] of nodes) {
        const s = intel.sym(id);
        if (!s) continue;
        affectedFiles.add(s.path);
        if (s.is_test) { (tests.get(s.path) ?? tests.set(s.path, []).get(s.path)).push(s.name); continue; }
        (byDepth.get(info.depth) ?? byDepth.set(info.depth, []).get(info.depth)).push({ s, info });
    }
    for (const t of intel.conventionTests([...seedFiles])) if (!tests.has(t)) tests.set(t, ['(by naming convention)']);
    const out = [`Impact of changing ${labels.join(', ')}`];
    const seedSyms = [...seeds].map(id => intel.sym(id)).filter(Boolean);
    const exported = seedSyms.filter(s => s.exported && !s.is_test);
    if (exported.length) out.push(`public surface: ${exported.slice(0, 8).map(s => s.qname).join(', ')}${exported.length > 8 ? ', …' : ''} ${exported.length === 1 ? 'is' : 'are'} exported`);
    const total = [...byDepth.values()].reduce((n, a) => n + a.length, 0);
    out.push(`dependents: ${total} symbols in ${plural(new Set([...byDepth.values()].flat().map(x => x.s.path)).size, 'file')} (non-test)${truncated ? ' — truncated, narrow the change set for the full list' : ''}`);
    for (const d of [...byDepth.keys()].sort()) {
        const arr = byDepth.get(d).sort((a, b) => b.info.conf - a.info.conf);
        out.push(`  distance ${d} (${arr.length}):`);
        const show = d === 1 ? 25 : 12;
        for (const { s, info } of arr.slice(0, show)) out.push(`    ${s.qname}  ${loc(s)}${info.conf < 0.9 ? `  [${confWord(info.conf)}]` : ''}`);
        if (arr.length > show) {
            const byFile = new Map();
            for (const { s } of arr.slice(show)) byFile.set(s.path, (byFile.get(s.path) ?? 0) + 1);
            out.push(`    … ${arr.length - show} more in ${[...byFile].slice(0, 6).map(([f, n]) => `${f} (${n})`).join(', ')}${byFile.size > 6 ? ', …' : ''}`);
        }
    }
    if (fileLevel.size) out.push(`module-level uses: ${[...fileLevel.keys()].slice(0, 10).join(', ')}${fileLevel.size > 10 ? ', …' : ''}`);
    if (tests.size) {
        out.push(`tests to run (${tests.size} file${tests.size === 1 ? '' : 's'}):`);
        for (const [f, names] of [...tests].slice(0, 15)) out.push(`    ${f}: ${[...new Set(names)].slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`);
        if (tests.size > 15) out.push(`    … ${tests.size - 15} more test files`);
    } else out.push('tests: none found that reference the changed code (consider adding one).');
    const co = intel.coChange([...seedFiles]);
    if (co.length) out.push(`often changed together (git): ${co.map(c => `${c.file} (${c.together}/${c.of})`).join(', ')}`);
    const risk = total > 40 || affectedFiles.size > 15 ? 'high' : total > 8 ? 'medium' : 'low';
    out.push(`risk: ${risk} (${total} dependents, ${tests.size} test files)`);
    return out.join('\n');
}

async function toolOutline(intel, { path: p = '', focus = null, max_tokens = 1500 }) {
    const rel = String(p || '').replace(/^\.\//, '').replace(/\/$/, '');
    const isFile = rel && intel.store.get('SELECT id FROM files WHERE path = ?', rel);
    if (isFile) {
        await intel.revalidate([rel]);
        const rows = intel.store.all(`SELECT s.id, s.qname, s.name, s.kind, s.parent_id, s.start_line, s.end_line, s.sig, s.doc FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? ORDER BY s.start_line`, rel);
        const f = intel.store.get('SELECT lines, lang, is_test FROM files WHERE path = ?', rel);
        const depthOf = new Map();
        const out = [`${rel} — ${f.lang}, ${f.lines} lines, ${plural(rows.length, 'symbol')}${f.is_test ? ', test file' : ''}`];
        const imports = intel.store.all('SELECT DISTINCT source FROM imports i JOIN files f ON f.id = i.file_id WHERE f.path = ? LIMIT 30', rel).map(r => r.source);
        if (imports.length) out.push(`imports: ${imports.join(', ')}`);
        let budget = max_tokens * 4;
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
