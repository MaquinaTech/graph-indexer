#!/usr/bin/env node
/**
 * Reference-graph accuracy for Go against the Go type checker (the counterpart of eval-graph.mjs).
 *
 * For a seeded random sample of functions/methods/types, compare the references graph-indexer
 * reports (find_references) with the identifiers go/types binds to the same object
 * (bench/oracle-go, built on golang.org/x/tools/go/packages), at (file, line) granularity.
 * Imports and the declaration itself are excluded on both sides, and so are files the default
 * build leaves out (build tags): the compiler has no answer there. Two oracles:
 *   - exact:    uses of that very object;
 *   - dispatch: exact plus, for methods, uses of the interface methods it implements and, for an
 *               interface method, uses of its implementations — what find_references promises.
 * Baselines: grep (the name as a whole word) and name-only (every syntactic reference by name).
 * Implicit implementations (graph-indexer's `inherit` rows on a type's declaration line) are not
 * uses: they are scored apart, per sampled interface, against types.Implements.
 *
 *   node bench/eval-graph-go.mjs [--fixture gin] [--scope .] [--n 150] [--seed 7] [--oracle ~/.gi-agentic/oracle-go]
 * Needs Go on PATH and the fixture's modules downloaded (go mod download).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodeIntel } from '../src/query/intel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const fixture = opt('--fixture', 'gin');
const scope = opt('--scope', '').split(',').filter(Boolean);
const N = Number(opt('--n', 150));
const seed = Number(opt('--seed', 7));
const root = path.resolve(opt('--fixture-dir', path.join(here, '../test/fixtures')), fixture);
const oracleBin = opt('--oracle', path.join(os.homedir(), '.gi-agentic/oracle-go'));

function rng(s) { return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

const intel = new CodeIntel({ root, dbPath: path.join(opt('--db-dir', path.join(os.tmpdir(), 'graph-indexer-bench')), fixture + '.db') });
await intel.open();
const goFiles = intel.store.all("SELECT path FROM files WHERE lang = 'go'").map(r => r.path);

// ── sample ───────────────────────────────────────────────────────────────────────
const cands = intel.store.all(`SELECT s.id, s.name, s.qname, s.kind, s.name_line, s.name_col, f.path FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE f.lang = 'go' AND f.is_test = 0 AND s.kind IN ('function','method','class','struct','interface','type') AND length(s.name) > 2
    AND s.name NOT LIKE '<%'`)
    .filter(s => !scope.length || scope.some(p => s.path.startsWith(p)));
const rand = rng(seed);
const sample = [];
const pool = [...cands];
while (sample.length < N && pool.length) sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);

// ── oracle ───────────────────────────────────────────────────────────────────────
const t0 = Date.now();
// every interface in scope is asked for its implementations, sampled or not
const sampled = new Set(sample.map(s => s.id));
const queries = [...sample, ...cands.filter(s => s.kind === 'interface' && !sampled.has(s.id))];
const run = spawnSync(oracleBin, ['-dir', root], { input: JSON.stringify(queries.map(s => ({ path: s.path, line: s.name_line, col: s.name_col + 1 }))), encoding: 'utf8', maxBuffer: 256 << 20 });
if (run.status !== 0) throw new Error(`oracle-go failed: ${run.stderr.slice(-2000)}`);
const { files: built, answers: truth } = JSON.parse(run.stdout);
const inBuild = new Set(built);
console.log(`go/types oracle: ${truth.filter(Boolean).length}/${sample.length} sampled declarations found, ${inBuild.size}/${goFiles.length} files in the default build, ${Date.now() - t0} ms`);

// ── systems ──────────────────────────────────────────────────────────────────────
const drop = (set, sym) => {
    set.delete(`${sym.path}:${sym.name_line}`);
    for (const x of set) if (!inBuild.has(x.slice(0, x.lastIndexOf(':')))) set.delete(x);
    return set;
};
const isImpl = (x) => x.kind === 'inherit' && x.line === x.src_line; // a type satisfying an interface implicitly
function oursRefs(sym, { minConf = 0 } = {}) {
    const r = intel.references(sym.id, { minConf });
    const out = new Set();
    for (const rows of r.groups.values()) for (const x of rows) if (x.kind !== 'import' && !isImpl(x) && x.path.endsWith('.go')) out.add(`${x.path}:${x.line}`);
    return drop(out, sym);
}
function oursImpls(sym) {
    const out = new Set();
    for (const rows of intel.references(sym.id).groups.values()) for (const x of rows) if (isImpl(x)) out.add(`${x.path}:${x.line}`);
    return drop(out, sym);
}
function nameOnlyRefs(sym) {
    const rows = intel.store.all("SELECT f.path, r.line FROM refs r JOIN files f ON f.id = r.file_id WHERE r.name = ? AND f.lang = 'go'", sym.name);
    return drop(new Set(rows.map(r => `${r.path}:${r.line}`)), sym);
}
const lineCache = new Map();
const linesOf = (f) => { let l = lineCache.get(f); if (!l) { l = fs.readFileSync(path.join(root, f), 'utf8').split('\n'); lineCache.set(f, l); } return l; };
function grepRefs(sym) {
    const re = new RegExp(`\\b${sym.name}\\b`);
    const out = new Set();
    for (const f of goFiles) linesOf(f).forEach((l, i) => { if (re.test(l) && !/^\s*import\b/.test(l)) out.add(`${f}:${i + 1}`); });
    return drop(out, sym);
}
const systems = { 'graph-indexer': oursRefs, 'gi (>=likely)': (s) => oursRefs(s, { minConf: 0.4 }), 'name-only': nameOnlyRefs, grep: grepRefs };
const ORACLES = ['dispatch', 'exact'];

const newAgg = () => Object.fromEntries(Object.keys(systems).map(k => [k, { tp: 0, fp: 0, fn: 0, pSum: 0, rSum: 0, n: 0, perfect: 0 }]));
const aggs = Object.fromEntries(ORACLES.map(o => [o, newAgg()]));
let evaluated = 0, withRefs = 0;
const impl = { n: 0, tp: 0, fp: 0, fn: 0 };
queries.forEach((sym, i) => {
    if (!truth[i]) return;
    if (sym.kind === 'interface') {
        const gold = drop(new Set(truth[i].impls ?? []), sym), got = oursImpls(sym);
        impl.n++;
        for (const x of got) if (gold.has(x)) impl.tp++; else { impl.fp++; if (args.includes('--debug')) console.log(`   IMPL EXTRA ${sym.qname} ← ${x}`); }
        for (const x of gold) if (!got.has(x)) { impl.fn++; if (args.includes('--debug')) console.log(`   IMPL MISS ${sym.qname} ← ${x}`); }
    }
    if (!sampled.has(sym.id)) return;
    const golds = { dispatch: drop(new Set(truth[i].dispatch), sym), exact: drop(new Set(truth[i].exact), sym) };
    evaluated++;
    if (golds.dispatch.size) withRefs++;
    if (args.includes('--debug')) {
        const got = oursRefs(sym), gold = golds.dispatch;
        const miss = [...gold].filter(x => !got.has(x)), extra = [...got].filter(x => !gold.has(x));
        if (miss.length || extra.length) {
            console.log(`\n${sym.qname} (${sym.kind}) ${sym.path}:${sym.name_line}  gold=${gold.size} ours=${got.size}`);
            for (const m of miss.slice(0, 6)) { const [f, l] = m.split(':'); console.log(`   MISS ${m}  ${linesOf(f)[l - 1]?.trim().slice(0, 110)}`); }
            for (const m of extra.slice(0, 4)) { const [f, l] = m.split(':'); console.log(`   EXTRA ${m}  ${linesOf(f)[l - 1]?.trim().slice(0, 110)}`); }
        }
    }
    for (const [name, fn] of Object.entries(systems)) {
        const got = fn(sym);
        for (const o of ORACLES) {
            const g = golds[o];
            let tp = 0;
            for (const x of got) if (g.has(x)) tp++;
            const fp = got.size - tp, fnn = g.size - tp, a = aggs[o][name];
            a.tp += tp; a.fp += fp; a.fn += fnn;
            a.pSum += got.size ? tp / got.size : (g.size ? 0 : 1);
            a.rSum += g.size ? tp / g.size : 1;
            a.n++;
            if (fp === 0 && fnn === 0) a.perfect++;
        }
    }
});
console.log(`\n${fixture}${scope.length ? ` (${scope.join(', ')})` : ''}: ${evaluated} sampled symbols (${withRefs} with ≥1 dispatch-oracle reference), oracle = go/types`);
const result = {};
for (const o of ORACLES) {
    console.log(`\noracle: ${o === 'dispatch' ? 'dispatch (self + implemented interface methods / implementations)' : 'exact (uses of the object itself)'}`);
    console.log('system          micro-P  micro-R  micro-F1 | macro-P  macro-R | exact-set');
    result[o] = {};
    for (const [name, a] of Object.entries(aggs[o])) {
        const P = a.tp / Math.max(1, a.tp + a.fp), R = a.tp / Math.max(1, a.tp + a.fn), F = 2 * P * R / Math.max(1e-9, P + R);
        result[o][name] = { microP: P, microR: R, microF1: F, macroP: a.pSum / a.n, macroR: a.rSum / a.n, exactSet: a.perfect / a.n };
        console.log(`${name.padEnd(15)} ${P.toFixed(3).padStart(7)}  ${R.toFixed(3).padStart(7)}  ${F.toFixed(3).padStart(8)} | ${(a.pSum / a.n).toFixed(3).padStart(7)}  ${(a.rSum / a.n).toFixed(3).padStart(7)} | ${(a.perfect / a.n).toFixed(3)}`);
    }
}
const implP = impl.tp / Math.max(1, impl.tp + impl.fp), implR = impl.tp / Math.max(1, impl.tp + impl.fn);
console.log(`\nimplicit implementations (${impl.n} interfaces, oracle = types.Implements): precision ${implP.toFixed(3)} (${impl.tp}/${impl.tp + impl.fp}) · recall ${implR.toFixed(3)} (${impl.tp}/${impl.tp + impl.fn})`);
result.implementations = { n: impl.n, precision: implP, recall: implR };
if (opt('--json', null)) fs.writeFileSync(opt('--json'), JSON.stringify({ fixture, scope, n: evaluated, result }, null, 2));
intel.close();
