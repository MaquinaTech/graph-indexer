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
 * {gi} (this graph-indexer checkout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const CHARS_PER_TOKEN = 2.63; // tool results, measured on real transcripts (bench/agentic/anatomy.mjs)

export function loadSystems(file) {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (cfg.systems ?? []).filter(s => !s.disabled);
}

const fill = (v, vars) => typeof v === 'string' ? v.replace(/\{gi\}/g, GI).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
    : Array.isArray(v) ? v.map(x => fill(x, vars)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)])) : v;

/** Build (or refresh) a system's index of `repo`; returns the wall time in ms. */
export function indexWith(sys, repo) {
    if (!sys.index) return null;
    const t = Date.now();
    const r = spawnSync(fill(sys.index.command, { repo }), fill(sys.index.args ?? [], { repo }), { cwd: repo, encoding: 'utf8', env: { ...process.env, ...(sys.env ?? {}) }, timeout: 7_200_000, maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`${sys.name}: indexing failed (${r.status}): ${(r.stderr || r.stdout || '').slice(-400)}`);
    return Date.now() - t;
}

/** A minimal MCP client over stdio (newline-delimited JSON-RPC). */
export async function startSystem(sys, repo) {
    const child = spawn(fill(sys.command, { repo }), fill(sys.args ?? [], { repo }), { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(sys.env ?? {}) } });
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
    return {
        listTools: async () => (await request('tools/list', {})).tools ?? [],
        /** The answer as text: text content, plus structured content serialised. */
        call: async (name, args) => {
            const r = await request('tools/call', { name, arguments: args });
            return [...(r.content ?? []).map(c => c.text ?? ''), r.structuredContent ? JSON.stringify(r.structuredContent) : ''].join('\n');
        },
        stop: () => { stopped = true; child.kill(); },
    };
}

/**
 * Every `path:line` an answer names, for the repository's files: `src/a.ts:12`, `src/a.ts:12:5`,
 * `"file": "src/a.ts", "line": 12` (JSON), absolute paths under the repository included.
 */
export function locationsIn(text, root, files) {
    const out = new Set();
    const rel = (p) => { let r = p.replace(/\\/g, '/'); if (r.startsWith(root + '/')) r = r.slice(root.length + 1); return r.replace(/^\.\//, ''); };
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
export async function answersOf(systems, { root, sample, files, fileRe = null, declLine = (s) => `${s.path}:${s.name_line}` }) {
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
                let text = '';
                try { text = await srv.call(sys.references.tool, fill(sys.references.arguments ?? {}, vars)); } catch { errors++; }
                sizes.push(text.length / CHARS_PER_TOKEN);
                // `stopAt`: where the answer's own list ends and notes about candidates begin
                // `ignoreLines`: single lines that are not part of the list (a note naming other definitions)
                const stop = sys.references.stopAt ? new RegExp(sys.references.stopAt) : null, skip = sys.references.ignoreLines ? new RegExp(sys.references.ignoreLines) : null;
                const all = text.split('\n'), end = stop ? all.findIndex(l => stop.test(l)) : -1;
                const claimed = (end >= 0 ? all.slice(0, end) : all).filter(l => !skip?.test(l)).join('\n');
                const locs = locationsIn(claimed, root, files);
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
