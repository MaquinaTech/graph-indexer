#!/usr/bin/env node
/**
 * Reference-graph accuracy for Rust against a compiler-grade oracle: rust-analyzer.
 *
 * rust-analyzer is the Rust language server; its Find All References comes from its own name
 * resolution, trait solving and macro expansion over the cargo workspace. For a seeded random
 * sample of functions, methods, structs, enums and traits, the references graph-indexer reports are
 * compared with rust-analyzer's at (file, line) granularity, as in bench/eval-graph-python.mjs.
 * `use` declarations and declaration lines are excluded on both sides, and so are two kinds of
 * reference rust-analyzer reports that do not name the symbol: `Self` standing for a type, and the
 * `fn` of each implementation of a trait method. Code that the build leaves
 * out (`#[cfg(...)]` that is inactive with the default features; rust-analyzer reports it as
 * `inactive-code`) is excluded on both sides too, since the oracle has no answer there; so are
 * files outside the module tree (a `#[cfg(feature = "x")] mod m;` with x off makes all of m.rs
 * inactive; rust-analyzer then reports no parent module for it) and files outside the cargo
 * workspace (a `fuzz/` crate of its own, for instance).
 *
 * rust-analyzer binds `x.m()` to the method of x's type, and a call through a trait bound
 * (`T: Tr`, `t.m()`) to the trait's method, not to its implementations: its answer is the
 * **exact** oracle. graph-indexer is scored twice: `exact` (references to the definition itself)
 * and its default answer, which adds calls through the trait that may dispatch to an
 * implementation — a superset the oracle counts as false positives.
 *
 * Dependencies are resolved by cargo as rust-analyzer usually does (`cargo fetch` first). Without
 * network access, remove the dependency tables from a copy of Cargo.toml: what the repository
 * declares still resolves, as for the Java oracle without a classpath.
 *
 * `--features full` (or `all`) analyses with those cargo features instead of the defaults, for a
 * crate such as tokio whose default feature set is empty. `--sample FILE` freezes the sample: the
 * symbols named in FILE (one `path:line:qname` per line) are used if it exists, and the drawn sample is
 * written to it if not, so that two builds are compared on the same symbols.
 *
 *   node bench/eval-graph-rust.mjs [--fixture rust] [--fixture-dir DIR] [--scope src/] [--n 150] [--seed 7] [--features F] [--sample FILE] [--rust-analyzer rust-analyzer] [--debug] [--systems bench/arena/systems.json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodeIntel } from '../src/query/intel.mjs';
import { loadSystems, answersOf, sourceOf } from './arena/mcp-system.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const fixture = opt('--fixture', 'rust');
const scope = opt('--scope', '').split(',').filter(Boolean);
const N = Number(opt('--n', 150));
const seed = Number(opt('--seed', 7));
const root = path.resolve(opt('--fixture-dir', path.join(here, '../test/fixtures')), fixture);
const server = opt('--rust-analyzer', 'rust-analyzer');

function rng(s) { return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

const intel = new CodeIntel({ root, dbPath: path.join(opt('--db-dir', path.join(os.tmpdir(), 'graph-indexer-bench')), fixture + '.db') });
await intel.open();

// ── the cargo workspace: its members' directories, minus nested packages that are not members ──
const meta = JSON.parse(spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }).stdout);
const memberDirs = meta.packages.filter(p => meta.workspace_members.includes(p.id)).map(p => path.relative(root, path.dirname(p.manifest_path)).split(path.sep).join('/'));
const allRs = intel.store.all("SELECT path FROM files WHERE lang = 'rust'").map(r => r.path);
const foreignDirs = [...new Set(allRs.map(f => { let d = path.posix.dirname(f); while (d !== '.' && !fs.existsSync(path.join(root, d, 'Cargo.toml'))) d = path.posix.dirname(d); return d; }))].filter(d => d !== '.' && !memberDirs.includes(d));
const inWorkspace = (f) => memberDirs.some(d => d === '' || d === '.' || f.startsWith(d + '/')) && !foreignDirs.some(d => f.startsWith(d + '/'));
const rsFiles = allRs.filter(inWorkspace);

// ── a minimal LSP client ─────────────────────────────────────────────────────────
// rust-analyzer's settings, given at start and again whenever it asks for its configuration
const raConfig = opt('--features', null) ? { cargo: { features: opt('--features') === 'all' ? 'all' : opt('--features').split(',') } } : {};
const child = spawn(server, [], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
let buf = Buffer.alloc(0), nextId = 0, quiescent = false;
const pending = new Map(), inactive = new Map(); // file → Set of inactive lines
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
            // server → client requests: configuration (defaults), capability registration, progress tokens
            const result = msg.method === 'workspace/configuration' ? (msg.params?.items ?? []).map(() => raConfig) : null;
            send({ id: msg.id, result });
        } else if (msg.method === 'experimental/serverStatus') {
            quiescent = !!msg.params?.quiescent;
        } else if (msg.method === 'textDocument/publishDiagnostics') {
            const rel = path.relative(root, fileURLToPath(msg.params.uri)).split(path.sep).join('/');
            const lines = new Set();
            for (const d of msg.params.diagnostics ?? []) if (d.code === 'inactive-code') for (let l = d.range.start.line + 1; l <= d.range.end.line + 1; l++) lines.add(l);
            inactive.set(rel, lines);
        }
    }
});
const rootUri = pathToFileURL(root).href;
const init = await request('initialize', {
    processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: fixture }],
    capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: { references: {}, publishDiagnostics: {} },
        window: { workDoneProgress: true },
        experimental: { serverStatusNotification: true },
    },
    initializationOptions: raConfig,
});
notify('initialized', {});
const version = init?.serverInfo?.version ?? '?';
const until = async (cond, ms) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await new Promise(r => setTimeout(r, 200)); };
await until(() => quiescent, 600_000);

const lineCache = new Map();
const linesOf = (f) => { let l = lineCache.get(f); if (!l) { l = fs.readFileSync(path.join(root, f), 'utf8').split('\n'); lineCache.set(f, l); } return l; };
const opened = new Set();
function open(rel) {
    if (opened.has(rel)) return;
    opened.add(rel);
    notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(path.join(root, rel)).href, languageId: 'rust', version: 1, text: linesOf(rel).join('\n') } });
}
// every workspace file is opened once, so that rust-analyzer reports its inactive code
const t0 = Date.now();
for (const f of rsFiles) open(f);
await until(() => rsFiles.every(f => inactive.has(f)), 300_000);
const inactiveLines = [...inactive.values()].reduce((n, s) => n + s.size, 0);
// a file outside the module tree (`#[cfg(feature = "x")] mod m;` with x off) has no answer either:
// rust-analyzer gives it no parent module, or a parent that is itself outside
const parentOf = new Map();
for (const f of rsFiles) {
    const r = await request('experimental/parentModule', { textDocument: { uri: pathToFileURL(path.join(root, f)).href }, position: { line: 0, character: 0 } }).catch(() => null);
    const loc = Array.isArray(r) ? r[0] : r;
    const uri = loc?.uri ?? loc?.targetUri;
    parentOf.set(f, uri ? path.relative(root, fileURLToPath(uri)).split(path.sep).join('/') : null);
}
const inTreeMemo = new Map();
const inTree = (f, depth = 0) => {
    if (inTreeMemo.has(f)) return inTreeMemo.get(f);
    const p = parentOf.get(f);
    const v = p == null ? false : (p.endsWith('Cargo.toml') || depth > 32 ? true : (parentOf.has(p) ? inTree(p, depth + 1) : true));
    inTreeMemo.set(f, v);
    return v;
};
const outOfTree = new Set(rsFiles.filter(f => !inTree(f)));

// ── each system's answer, as `path:line` ─────────────────────────────────────────
const USE_LINE = /^\s*(pub(\([^)]*\))?\s+)?use\s/;
/** Lines inside a multi-line `use a::{\n b,\n c\n};` belong to the use declaration too. */
function inUse(f, line) {
    const lines = linesOf(f);
    if (USE_LINE.test(lines[line - 1] ?? '')) return true;
    for (let i = line - 2; i >= Math.max(0, line - 60); i--) {
        const l = lines[i] ?? '';
        if (/;\s*$/.test(l) || /^\s*$/.test(l)) return false;
        if (USE_LINE.test(l)) return true;
    }
    return false;
}
const counted = (f, line) => f.endsWith('.rs') && inWorkspace(f) && !outOfTree.has(f) && !inactive.get(f)?.has(line) && !inUse(f, line);

async function oracleRefs(sym) {
    const res = await request('textDocument/references', {
        textDocument: { uri: pathToFileURL(path.join(root, sym.path)).href },
        position: { line: sym.name_line - 1, character: sym.name_col },
        context: { includeDeclaration: false },
    }).catch(() => null);
    if (!res) return null;
    const out = new Set();
    for (const r of res) {
        const rel = path.relative(root, fileURLToPath(r.uri)).split(path.sep).join('/');
        if (rel.startsWith('..')) continue;
        const line = r.range.start.line + 1, text = linesOf(rel)[line - 1] ?? '';
        // a use by name: not `Self` standing for the type, not another declaration of the name
        // (a trait method's implementations are reported as references to it)
        if (text.slice(r.range.start.character, r.range.end.character) !== sym.name) continue;
        if (/\b(fn|struct|enum|trait|type|union|mod)\s+$/.test(text.slice(0, r.range.start.character))) continue;
        if (counted(rel, line)) out.add(`${rel}:${line}`);
    }
    out.delete(`${sym.path}:${sym.name_line}`);
    return out;
}

function oursRefs(sym, { family = true, minConf = 0 } = {}) {
    const r = intel.references(sym.id, { family, minConf });
    const out = new Set();
    for (const rows of r.groups.values()) for (const x of rows) if (x.kind !== 'import' && counted(x.path, x.line)) out.add(`${x.path}:${x.line}`);
    out.delete(`${sym.path}:${sym.name_line}`);
    return out;
}

function nameOnlyRefs(sym) {
    const rows = intel.store.all("SELECT f.path, r.line FROM refs r JOIN files f ON f.id = r.file_id WHERE r.name = ? AND f.lang = 'rust'", sym.name);
    const out = new Set(rows.filter(r => counted(r.path, r.line)).map(r => `${r.path}:${r.line}`));
    out.delete(`${sym.path}:${sym.name_line}`);
    return out;
}

function grepRefs(sym) {
    const re = new RegExp(`\\b${sym.name}\\b`);
    const out = new Set();
    for (const f of rsFiles) {
        const lines = linesOf(f);
        for (let i = 0; i < lines.length; i++) if (re.test(lines[i]) && counted(f, i + 1)) out.add(`${f}:${i + 1}`);
    }
    out.delete(`${sym.path}:${sym.name_line}`);
    return out;
}

// ── sample ───────────────────────────────────────────────────────────────────────
const cands = intel.store.all(`SELECT s.id, s.name, s.qname, s.kind, s.name_line, s.name_col, f.path FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE f.lang = 'rust' AND f.is_test = 0 AND s.kind IN ('function', 'method', 'struct', 'enum', 'trait') AND length(s.name) > 2`)
    .filter(s => (!scope.length || scope.some(p => s.path.startsWith(p))) && inWorkspace(s.path) && !outOfTree.has(s.path) && !inactive.get(s.path)?.has(s.name_line));
const rand = rng(seed);
let sample = [];
const pool = [...cands];
while (sample.length < N && pool.length) sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
const sampleFile = opt('--sample', null);
if (sampleFile && fs.existsSync(sampleFile)) {
    const byKey = new Map(cands.map(s => [`${s.path}:${s.name_line}:${s.qname}`, s]));
    const keys = fs.readFileSync(sampleFile, 'utf8').split('\n').filter(Boolean);
    sample = keys.map(k => byKey.get(k)).filter(Boolean);
    console.log(`sample from ${sampleFile}: ${sample.length} of ${keys.length} symbols found`);
} else if (sampleFile) fs.writeFileSync(sampleFile, sample.map(s => `${s.path}:${s.name_line}:${s.qname}`).join('\n') + '\n');
console.log(`rust-analyzer ${version}: ${rsFiles.length} workspace files (${outOfTree.size} outside the module tree), ${inactiveLines} inactive lines, ready in ${Date.now() - t0} ms`);

// other tools through their MCP servers (bench/arena/systems.json)
const ext = opt('--systems', null) ? await answersOf(loadSystems(opt('--systems')), { root, sample, files: new Set(rsFiles), fileRe: /\.rs$/, ...sourceOf(intel, root) }) : {};
for (const [name, a] of Object.entries(ext)) console.log(`${name}: median answer ${a.medianTokens} tokens`);
const extSystems = Object.fromEntries(Object.entries(ext).map(([name, a]) => [name, (s) => new Set([...(a.per.get(s.id) ?? [])].filter(x => { const i = x.lastIndexOf(':'); return counted(x.slice(0, i), Number(x.slice(i + 1))); }))]));
const systems = { ...extSystems, 'gi (exact)': (s) => oursRefs(s, { family: false }), 'gi (>=likely)': (s) => oursRefs(s, { family: false, minConf: 0.4 }), 'graph-indexer': oursRefs, 'name-only': nameOnlyRefs, grep: grepRefs };
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
console.log(`\n${fixture}${scope.length ? ` (${scope.join(', ')})` : ''}: ${evaluated} sampled symbols (${withRefs} with ≥1 reference), oracle = rust-analyzer ${version} Find All References, ${Date.now() - t1} ms`);
for (const o of ORACLES) {
    console.log(`\noracle: ${o === 'exact' ? 'exact (references rust-analyzer binds to the definition)' : 'exact, file level'}`);
    console.log('system          micro-P  micro-R  micro-F1 | macro-P  macro-R | exact-set');
    for (const [name, a] of Object.entries(aggs[o])) {
        const p = a.tp / (a.tp + a.fp), r = a.tp / (a.tp + a.fn);
        console.log(`${name.padEnd(15)} ${f3(p).padStart(7)}  ${f3(r).padStart(7)}  ${f3(2 * p * r / (p + r)).padStart(8)} | ${f3(a.pSum / a.n).padStart(7)}  ${f3(a.rSum / a.n).padStart(7)} | ${f3(a.perfect / a.n)}`);
    }
}
