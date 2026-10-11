#!/usr/bin/env node
/**
 * Reference-graph accuracy for Python against a type checker oracle: pyright.
 *
 * Python has no compiler; pyright (Microsoft's type checker, the engine behind Pylance) is the
 * closest thing to one, and its language server answers Find All References from its own binding
 * of scopes, imports and inferred types. For a seeded random sample of functions, methods and
 * classes, the references graph-indexer reports are compared with pyright's at (file, line)
 * granularity, as in bench/eval-graph.mjs. Import statements and declaration lines (the sampled
 * one, and redeclarations such as `if V2: def f … else: def f`) are excluded on both sides. Third-party packages are not installed: what the repository declares still
 * resolves, as for the other oracles.
 *
 * pyright binds `obj.m()` to the method of obj's declared type only, so its answer is the
 * **exact** oracle. graph-indexer is scored twice: `exact` (references to the definition itself,
 * what the oracle answers) and its default answer, which adds calls through a base type that may
 * dispatch to the method — a superset the oracle counts as false positives.
 *
 *   node bench/eval-graph-python.mjs [--fixture fastapi] [--scope fastapi/] [--n 150] [--seed 7] [--pyright pyright-langserver] [--debug]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodeIntel } from '../src/query/intel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const fixture = opt('--fixture', 'fastapi');
const scope = opt('--scope', 'fastapi/').split(',');
const N = Number(opt('--n', 150));
const seed = Number(opt('--seed', 7));
const root = path.resolve(opt('--fixture-dir', path.join(here, '../test/fixtures')), fixture);
const server = opt('--pyright', 'pyright-langserver');

function rng(s) { return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

const intel = new CodeIntel({ root, dbPath: path.join(opt('--db-dir', path.join(os.tmpdir(), 'graph-indexer-bench')), fixture + '.db') });
await intel.open();
const pyFiles = intel.store.all("SELECT path FROM files WHERE lang = 'python'").map(r => r.path);

// ── a minimal LSP client ─────────────────────────────────────────────────────────
const child = spawn(server, ['--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0), nextId = 0;
const pending = new Map();
const send = (msg) => { const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg })); child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); child.stdin.write(body); };
const request = (method, params) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); send({ id, method, params }); });
const notify = (method, params) => send({ method, params });
child.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) return;
        const len = Number(/Content-Length: (\d+)/i.exec(buf.slice(0, sep).toString())?.[1]);
        if (buf.length < sep + 4 + len) return;
        const msg = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString());
        buf = buf.slice(sep + 4 + len);
        if (msg.id != null && pending.has(msg.id) && !msg.method) {
            const p = pending.get(msg.id); pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
        } else if (msg.id != null && msg.method) {
            // server → client requests: configuration (all defaults), capability registration, progress
            const result = msg.method === 'workspace/configuration' ? (msg.params?.items ?? []).map(() => ({})) : null;
            send({ id: msg.id, result });
        }
    }
});
const rootUri = pathToFileURL(root).href;
const init = await request('initialize', {
    processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: fixture }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true }, textDocument: { references: {} } },
    initializationOptions: {},
});
notify('initialized', {});
const version = init?.serverInfo?.version ?? '?';
const opened = new Set();
function open(rel) {
    if (opened.has(rel)) return;
    opened.add(rel);
    notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(path.join(root, rel)).href, languageId: 'python', version: 1, text: fs.readFileSync(path.join(root, rel), 'utf8') } });
}

// ── each system's answer, as `path:line` ─────────────────────────────────────────
const lineCache = new Map();
const linesOf = (f) => { let l = lineCache.get(f); if (!l) { l = fs.readFileSync(path.join(root, f), 'utf8').split('\n'); lineCache.set(f, l); } return l; };
const IMPORT_LINE = /^\s*(from\s+\S+\s+import\b|import\s)/;
/** Lines of a multi-line `from x import (\n a,\n b\n)` belong to the import too. */
function inImport(f, line) {
    const lines = linesOf(f);
    if (IMPORT_LINE.test(lines[line - 1] ?? '')) return true;
    for (let i = line - 1; i >= Math.max(0, line - 40); i--) {
        const l = lines[i] ?? '';
        if (/^\s*from\s+\S+\s+import\s*\($/.test(l) || /^\s*from\s+\S+\s+import\s*\(/.test(l)) return !lines.slice(i, line - 1).some(x => x.includes(')'));
        if (i < line - 1 && !/^\s+[\w, ]*,?\s*(#.*)?$/.test(l)) return false;
    }
    return false;
}

async function oracleRefs(sym) {
    open(sym.path);
    const res = await request('textDocument/references', {
        textDocument: { uri: pathToFileURL(path.join(root, sym.path)).href },
        position: { line: sym.name_line - 1, character: sym.name_col },
        context: { includeDeclaration: false },
    });
    if (!res) return null;
    const out = new Set();
    for (const r of res) {
        const rel = path.relative(root, fileURLToPath(r.uri)).split(path.sep).join('/');
        if (rel.startsWith('..') || !rel.endsWith('.py')) continue;
        const line = r.range.start.line + 1;
        if (inImport(rel, line)) continue;
        // another declaration of the same name (`if V2: def f … else: def f`) is not a use
        if (new RegExp(`^\\s*(async\\s+)?(def|class)\\s+${sym.name}\\b`).test(linesOf(rel)[line - 1] ?? '')) continue;
        out.add(`${rel}:${line}`);
    }
    out.delete(`${sym.path}:${sym.name_line}`);
    return out;
}

function oursRefs(sym, { family = true, minConf = 0 } = {}) {
    const r = intel.references(sym.id, { family, minConf });
    const out = new Set();
    for (const rows of r.groups.values()) for (const x of rows) if (x.kind !== 'import' && x.path.endsWith('.py') && !inImport(x.path, x.line)) out.add(`${x.path}:${x.line}`);
    out.delete(`${sym.path}:${sym.name_line}`);
    return out;
}

function nameOnlyRefs(sym) {
    const rows = intel.store.all("SELECT f.path, r.line FROM refs r JOIN files f ON f.id = r.file_id WHERE r.name = ? AND f.lang = 'python'", sym.name);
    const out = new Set(rows.map(r => `${r.path}:${r.line}`).filter(x => { const i = x.lastIndexOf(':'); return !inImport(x.slice(0, i), Number(x.slice(i + 1))); }));
    out.delete(`${sym.path}:${sym.name_line}`);
    return out;
}

function grepRefs(sym) {
    const re = new RegExp(`\\b${sym.name}\\b`);
    const out = new Set();
    for (const f of pyFiles) {
        const lines = linesOf(f);
        for (let i = 0; i < lines.length; i++) if (re.test(lines[i]) && !inImport(f, i + 1)) out.add(`${f}:${i + 1}`);
    }
    out.delete(`${sym.path}:${sym.name_line}`);
    return out;
}

// ── sample ───────────────────────────────────────────────────────────────────────
const cands = intel.store.all(`SELECT s.id, s.name, s.qname, s.kind, s.name_line, s.name_col, f.path FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE f.lang = 'python' AND f.is_test = 0 AND s.kind IN ('function', 'method', 'class') AND length(s.name) > 2 AND s.name NOT LIKE '\\_\\_%\\_\\_' ESCAPE '\\'`)
    .filter(s => scope.some(p => s.path.startsWith(p)));
const rand = rng(seed);
const sample = [];
const pool = [...cands];
while (sample.length < N && pool.length) sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);

// pyright analyses lazily: one warm-up query lets it build the program before timing starts
if (sample.length) await oracleRefs(sample[0]);

const systems = { 'gi (exact)': (s) => oursRefs(s, { family: false }), 'gi (>=likely)': (s) => oursRefs(s, { family: false, minConf: 0.4 }), 'graph-indexer': oursRefs, 'name-only': nameOnlyRefs, grep: grepRefs };
const filesOf = (set) => new Set([...set].map(x => x.slice(0, x.lastIndexOf(':'))));
const ORACLES = ['exact', 'exact/files'];
const aggs = Object.fromEntries(ORACLES.map(o => [o, Object.fromEntries(Object.keys(systems).map(k => [k, { tp: 0, fp: 0, fn: 0, pSum: 0, rSum: 0, n: 0, perfect: 0 }]))]));
let evaluated = 0, withRefs = 0;
const t1 = Date.now();
for (const sym of sample) {
    const gold = await oracleRefs(sym);
    if (!gold) continue;
    evaluated++;
    if (gold.size) withRefs++;
    const golds = { exact: gold, 'exact/files': filesOf(gold) };
    if (args.includes('--debug')) {
        const got = oursRefs(sym, { family: false });
        const miss = [...gold].filter(x => !got.has(x)), extra = [...got].filter(x => !gold.has(x));
        if (miss.length || extra.length) {
            console.log(`\n${sym.qname} (${sym.kind}) ${sym.path}:${sym.name_line}  gold=${gold.size} ours=${got.size}`);
            for (const m of miss.slice(0, 6)) { const i = m.lastIndexOf(':'); console.log(`   MISS  ${m}  ${linesOf(m.slice(0, i))[Number(m.slice(i + 1)) - 1]?.trim().slice(0, 110)}`); }
            for (const m of extra.slice(0, 4)) { const i = m.lastIndexOf(':'); console.log(`   EXTRA ${m}  ${linesOf(m.slice(0, i))[Number(m.slice(i + 1)) - 1]?.trim().slice(0, 110)}`); }
        }
    }
    for (const [name, fn] of Object.entries(systems)) {
        const lines = fn(sym);
        for (const o of ORACLES) {
            const g = golds[o], got = o.endsWith('/files') ? filesOf(lines) : lines;
            let tp = 0;
            for (const x of got) if (g.has(x)) tp++;
            const a = aggs[o][name], fp = got.size - tp, fn_ = g.size - tp;
            a.tp += tp; a.fp += fp; a.fn += fn_;
            a.pSum += got.size ? tp / got.size : (g.size ? 0 : 1);
            a.rSum += g.size ? tp / g.size : 1;
            a.n++;
            if (!fp && !fn_) a.perfect++;
        }
    }
}
child.kill();
intel.close();

const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '  –  ');
console.log(`\n${fixture} (${scope.join(', ')}): ${evaluated} sampled symbols (${withRefs} with ≥1 reference), oracle = pyright ${version} Find All References, ${Date.now() - t1} ms`);
for (const o of ORACLES) {
    console.log(`\noracle: ${o === 'exact' ? 'exact (references pyright binds to the definition)' : 'exact, file level'}`);
    console.log('system          micro-P  micro-R  micro-F1 | macro-P  macro-R | exact-set');
    for (const [name, a] of Object.entries(aggs[o])) {
        const p = a.tp / (a.tp + a.fp), r = a.tp / (a.tp + a.fn);
        console.log(`${name.padEnd(15)} ${f3(p).padStart(7)}  ${f3(r).padStart(7)}  ${f3(2 * p * r / (p + r)).padStart(8)} | ${f3(a.pSum / a.n).padStart(7)}  ${f3(a.rSum / a.n).padStart(7)} | ${f3(a.perfect / a.n)}`);
    }
}
