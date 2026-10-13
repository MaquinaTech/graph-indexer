/**
 * Another code-intelligence tool as a system in the arena: started through its own MCP server,
 * asked for the uses of each sampled symbol with the tool and arguments its entry in the systems
 * file names, and scored on the `path:line` locations its answer contains.
 *
 * Nothing about another tool is assumed here: its entry in bench/arena/systems.json says how to
 * start it, how to index, which tool answers "where is X used", and which arguments that tool takes,
 * with placeholders filled per symbol. `node bench/arena/arena.mjs tools --system NAME` lists the
 * tools a server exposes, to write that entry from what it actually offers.
 *
 *   { "name": "…", "command": "…", "args": ["…"], "env": {},
 *     "index": { "command": "…", "args": ["…"] },
 *     "references": { "tool": "…", "arguments": { "symbol": "{name}", "file": "{path}" }, "stopAt": "regex" } }
 *
 * `ignoreLines` (optional) matches single lines that are not part of that list.
 * `stopAt` (optional) is the first line of the notes that follow the tool's own list of uses (candidates
 * it does not claim): locations from that line on are not scored. Declared per tool, in the open.
 *
 * Placeholders: {name} (symbol name), {qname} (Class.method), {owner} (enclosing class, or empty),
 * {path} (repository-relative file), {abspath}, {line} (declaration line), {repo} (repository root),
 * {repoName} (its directory name), {gi} (this graph-indexer checkout).
 *
 * Some tools answer with the referencing declarations, not with the lines of the uses. Such an answer
 * is read the way an agent reads it, as for graph-indexer 2.x: a declaration's lines are those inside
 * it that contain the name as a word, outside comments and string literals.
 *   - a range in the answer (`src/a.ts:10-24`, or a JSON row `["src/a.ts", null, 10, 24]`) is read so;
 *   - `"enclosing": true` says each `path:line` the answer names is the first line of a referencing
 *     declaration; its extent is the declaration's extent in the parsed source (`extentOf`), and a
 *     file named at line 1 with no declaration there stands for the whole file (module scope).
 * The answer's size is measured on its text content (what an agent reads), structured content only
 * when there is no text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escapeRegExp } from '../../src/util/regex.mjs';

const GI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const CHARS_PER_TOKEN = 2.63; // tool results, measured on real transcripts (bench/agentic/anatomy.mjs)

export function loadSystems(file) {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (cfg.systems ?? []).filter(s => !s.disabled);
}

export const fill = (v, vars) => typeof v === 'string' ? v.replace(/\{gi\}/g, GI).replace(/\{repoName\}/g, vars.repo ? path.basename(vars.repo) : '{repoName}').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
    : Array.isArray(v) ? v.map(x => fill(x, vars)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)])) : v;

/** Build (or refresh) a system's index of `repo`; returns the wall time in ms. */
export function indexWith(sys, repo) {
    if (!sys.index) return null;
    const t = Date.now();
    const r = spawnSync(fill(sys.index.command, { repo }), fill(sys.index.args ?? [], { repo }), { cwd: repo, encoding: 'utf8', env: { ...process.env, ...fill(sys.env ?? {}, { repo }) }, timeout: 7_200_000, maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`${sys.name}: indexing failed (${r.status}): ${(r.stderr || r.stdout || '').slice(-400)}`);
    return Date.now() - t;
}

/** A line without its comment and the contents of its string literals (a rough cut, in the tools' favour). */
const codeOnly = (l) => /^\s*(\*|\/\*|\/\/|#)/.test(l) ? '' : l.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\s(\/\/|#).*$/, '');

/** A minimal MCP client over stdio (newline-delimited JSON-RPC). */
export async function startSystem(sys, repo) {
    const child = spawn(fill(sys.command, { repo }), fill(sys.args ?? [], { repo }), { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...fill(sys.env ?? {}, { repo }) } });
    let buf = '', next = 1;
    const pending = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            const p = msg.id != null && !msg.method ? pending.get(msg.id) : null;
            if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
        }
    });
    child.stderr.on('data', () => {});
    let stopped = false;
    const failed = new Promise((_, reject) => child.on('exit', (code) => { if (!stopped) reject(new Error(`${sys.name}: server exited (${code})`)); }));
    failed.catch(() => {});
    const request = (method, params) => Promise.race([failed, new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    })]);
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'graph-indexer-arena', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    /** `all`: text content plus structured content serialised; `read`: what an agent reads. */
    async function callRaw(name, args) {
        const r = await request('tools/call', { name, arguments: args });
        const text = (r.content ?? []).map(c => c.text ?? '').join('\n'), structured = r.structuredContent ? JSON.stringify(r.structuredContent) : '';
        return { all: [text, structured].join('\n'), read: text.trim() ? text : structured };
    }
    return {
        listTools: async () => (await request('tools/list', {})).tools ?? [],
        /** The answer as text: text content, plus structured content serialised. */
        call: async (name, args) => (await callRaw(name, args)).all,
        callRaw,
        stop: () => { stopped = true; child.kill(); },
    };
}

/**
 * Every `path:line` an answer names, for the repository's files: `src/a.ts:12`, `src/a.ts:12:5`,
 * `"file": "src/a.ts", "line": 12` (JSON), absolute paths under the repository included.
 * With `range(file, start, end)`, ranges are read too (`src/a.ts:10-24`, and JSON rows
 * `["src/a.ts", line]` or `["src/a.ts", null, start, end]`): `range` returns the lines to count.
 */
export function locationsIn(text, root, files, range = null) {
    const out = new Set();
    const rel = (p) => { let r = p.replace(/\\/g, '/'); if (r.startsWith(root + '/')) r = r.slice(root.length + 1); return r.replace(/^\.\//, ''); };
    if (range) {
        for (const m of text.matchAll(/([\w./@~+-]+\.[A-Za-z]{1,5}):(\d+)-(\d+)\b/g)) { const f = rel(m[1]); if (files.has(f)) for (const l of range(f, +m[2], +m[3])) out.add(`${f}:${l}`); }
        text = text.replace(/([\w./@~+-]+\.[A-Za-z]{1,5}):(\d+)-(\d+)\b/g, '');
        for (const m of text.matchAll(/\[[^\[\]{}]*\]/g)) {
            let row; try { row = JSON.parse(m[0]); } catch { continue; }
            const num = (v) => v != null && v !== '' && /^\d+$/.test(String(v)) ? Number(v) : null;
            for (let i = 0; i < row.length; i++) {
                if (typeof row[i] !== 'string' || !files.has(rel(row[i]))) continue;
                const f = rel(row[i]);
                if (num(row[i + 1]) != null) out.add(`${f}:${num(row[i + 1])}`);
                else if (num(row[i + 2]) != null && num(row[i + 3]) != null) for (const l of range(f, num(row[i + 2]), num(row[i + 3]))) out.add(`${f}:${l}`);
            }
        }
    }
    for (const m of text.matchAll(/([\w./@~+-]+\.[A-Za-z]{1,5}):(\d+)/g)) { const f = rel(m[1]); if (files.has(f)) out.add(`${f}:${m[2]}`); }
    for (const m of text.matchAll(/"(?:file|path|filePath|file_path)"\s*:\s*"([^"]+)"[^{}]*?"(?:line|startLine|start_line|lineNumber)"\s*:\s*(\d+)/g)) { const f = rel(m[1]); if (files.has(f)) out.add(`${f}:${m[2]}`); }
    // grouped by file: a line naming a file, then indented lines that start with a line number
    let cur = null;
    for (const l of text.split('\n')) {
        const head = /^(\S+)(?:\s{2,}.*)?$/.exec(l);
        if (head && files.has(rel(head[1]))) { cur = rel(head[1]); continue; }
        const row = /^\s+(?:L)?(\d+)\b/.exec(l);
        if (cur && row) out.add(`${cur}:${row[1]}`);
        else if (!/^\s/.test(l)) cur = null;
    }
    return out;
}

/**
 * Each configured system's answer for every sampled symbol: { name → Map(symbol id → Set of
 * `path:line`) }, plus the size of its answers in tokens. Failures are reported, not hidden.
 */
export async function answersOf(systems, { root, sample, files, fileRe = null, declLine = (s) => `${s.path}:${s.name_line}`, linesOf = null, extentOf = null }) {
    const out = {};
    for (const sys of systems) {
        const per = new Map(), sizes = [];
        let errors = 0;
        let srv;
        try { srv = await startSystem(sys, root); } catch (e) { console.log(`${sys.name}: could not start (${e.message})`); continue; }
        try {
            for (const s of sample) {
                const owner = s.qname?.includes('.') ? s.qname.slice(0, s.qname.lastIndexOf('.')).split('.').pop() : '';
                const vars = { name: s.name, qname: s.qname ?? s.name, owner, path: s.path, abspath: path.join(root, s.path), line: s.name_line, repo: root };
                let text = '', read = '';
                try { ({ all: text, read } = await srv.callRaw(sys.references.tool, fill(sys.references.arguments ?? {}, vars))); } catch { errors++; }
                sizes.push(read.length / CHARS_PER_TOKEN);
                // `stopAt`: where the answer's own list ends and notes about candidates begin
                // `ignoreLines`: single lines that are not part of the list (a note naming other definitions)
                const stop = sys.references.stopAt ? new RegExp(sys.references.stopAt) : null, skip = sys.references.ignoreLines ? new RegExp(sys.references.ignoreLines) : null;
                const all = text.split('\n'), end = stop ? all.findIndex(l => stop.test(l)) : -1;
                const claimed = (end >= 0 ? all.slice(0, end) : all).filter(l => !skip?.test(l)).join('\n');
                // a declaration's lines are those inside it that contain the name as a word
                const word = new RegExp(`(^|[^\\w$])${escapeRegExp(s.name)}(?![\\w$])`);
                const within = linesOf ? (f, a, b) => { const ls = linesOf(f), r = []; for (let i = Math.max(1, a); i <= Math.min(ls.length, b); i++) if (word.test(codeOnly(ls[i - 1]))) r.push(i); return r; } : null;
                let locs = locationsIn(claimed, root, files, within);
                if (sys.references.enclosing && within && extentOf) {
                    const expanded = new Set();
                    for (const x of locs) {
                        const i = x.lastIndexOf(':'), f = x.slice(0, i), l = Number(x.slice(i + 1));
                        const e = extentOf(f, l) ?? (l === 1 ? [1, Infinity] : [l, l]);
                        for (const k of within(f, e[0], e[1])) expanded.add(`${f}:${k}`);
                    }
                    locs = expanded;
                }
                locs.delete(declLine(s));
                per.set(s.id, fileRe ? new Set([...locs].filter(x => fileRe.test(x.slice(0, x.lastIndexOf(':'))))) : locs);
            }
        } finally { srv.stop(); }
        if (errors) console.log(`${sys.name}: ${errors} of ${sample.length} calls failed`);
        sizes.sort((a, b) => a - b);
        out[sys.name] = { per, medianTokens: Math.round(sizes[sizes.length >> 1] ?? 0) };
    }
    return out;
}

/**
 * `linesOf` and `extentOf` for answersOf, from the repository's files and the parsed declarations in
 * graph-indexer's index (a declaration's extent is syntax, the same for any parser).
 */
export function sourceOf(intel, root) {
    const cache = new Map();
    const linesOf = (f) => { let l = cache.get(f); if (!l) { l = fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8').split('\n') : []; cache.set(f, l); } return l; };
    const extentOf = (f, line) => {
        const r = intel.store.all('SELECT s.start_line, s.end_line FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND (s.start_line = ? OR s.name_line = ?) ORDER BY (s.start_line = ?) DESC, s.end_line - s.start_line DESC LIMIT 1', f, line, line, line)[0];
        return r ? [r.start_line, r.end_line] : null;
    };
    return { linesOf, extentOf };
}
