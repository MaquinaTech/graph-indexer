#!/usr/bin/env node
/**
 * Reference-graph accuracy for Java against the Java compiler (the counterpart of eval-graph.mjs
 * and eval-graph-go.mjs).
 *
 * For a seeded random sample of methods and types, compare the references graph-indexer reports
 * (find_references) with the elements javac binds every identifier, member access and method
 * reference to (bench/oracle-java/Oracle.java), at (file, line) granularity, over the source
 * directories given (--src, main code by default: tests need their libraries on the class path).
 * Imports and the declaration itself are excluded on both sides. Two oracles:
 *   - exact:    uses of that very element;
 *   - dispatch: exact plus, for a method, uses of the methods it overrides or implements and of
 *               those that override it — what find_references promises.
 * Baselines: grep (the name as a whole word) and name-only (every syntactic reference by name).
 *
 *   node bench/eval-graph-java.mjs --fixture jsoup --fixture-dir ~/.gi-agentic/java [--src src/main/java] [--n 200] [--seed 7]
 * Needs a JDK (17+) on PATH.
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
const fixture = opt('--fixture', 'spring');
const srcDirs = opt('--src', 'src/main/java').split(',');
const scope = opt('--scope', '').split(',').filter(Boolean);
const N = Number(opt('--n', 150));
const seed = Number(opt('--seed', 7));
const root = path.resolve(opt('--fixture-dir', path.join(here, '../test/fixtures')), fixture);

function rng(s) { return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

const intel = new CodeIntel({ root, dbPath: path.join(opt('--db-dir', path.join(os.tmpdir(), 'graph-indexer-bench')), fixture + '.db') });
await intel.open();
const javaFiles = intel.store.all("SELECT path FROM files WHERE lang = 'java'").map(r => r.path).filter(p => srcDirs.some(d => p.startsWith(d + '/')));

// ── sample ───────────────────────────────────────────────────────────────────────
const cands = intel.store.all(`SELECT s.id, s.name, s.qname, s.kind, s.name_line, s.name_col, f.path FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE f.lang = 'java' AND s.kind IN ('method','class','interface','enum') AND length(s.name) > 2
    AND s.name NOT LIKE '<%'`)
    .filter(s => srcDirs.some(d => s.path.startsWith(d + '/')) && (!scope.length || scope.some(p => s.path.startsWith(p))));
const rand = rng(seed);
const sample = [];
const pool = [...cands];
while (sample.length < N && pool.length) sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);

// ── oracle ───────────────────────────────────────────────────────────────────────
const t0 = Date.now();
const queries = sample;
const run = spawnSync('java', [path.join(here, 'oracle-java', 'Oracle.java'), root, srcDirs.join(',')], { input: queries.map(s => `${s.path}\t${s.name_line}\t${s.name}`).join('\n') + '\n', encoding: 'utf8', maxBuffer: 256 << 20 });
if (run.status !== 0) throw new Error(`the Java oracle failed: ${run.stderr.slice(-2000)}`);
const { files: built, answers: truth } = JSON.parse(run.stdout);
const inBuild = new Set(built);
console.log(`javac oracle: ${truth.filter(Boolean).length}/${sample.length} sampled declarations found, ${inBuild.size} files, ${Date.now() - t0} ms`);

// ── systems ──────────────────────────────────────────────────────────────────────
const drop = (set, sym) => {
    set.delete(`${sym.path}:${sym.name_line}`);
    for (const x of set) if (!inBuild.has(x.slice(0, x.lastIndexOf(':')))) set.delete(x);
    return set;
};
function oursRefs(sym, { minConf = 0 } = {}) {
    const r = intel.references(sym.id, { minConf });
    const out = new Set();
    for (const rows of r.groups.values()) for (const x of rows) if (x.kind !== 'import' && x.path.endsWith('.java')) out.add(`${x.path}:${x.line}`);
    return drop(out, sym);
}
function nameOnlyRefs(sym) {
    const rows = intel.store.all("SELECT f.path, r.line FROM refs r JOIN files f ON f.id = r.file_id WHERE r.name = ? AND f.lang = 'java'", sym.name);
    return drop(new Set(rows.map(r => `${r.path}:${r.line}`)), sym);
}
const lineCache = new Map();
const linesOf = (f) => { let l = lineCache.get(f); if (!l) { l = fs.readFileSync(path.join(root, f), 'utf8').split('\n'); lineCache.set(f, l); } return l; };
function grepRefs(sym) {
    const re = new RegExp(`\\b${sym.name}\\b`);
    const out = new Set();
    for (const f of javaFiles) linesOf(f).forEach((l, i) => { if (re.test(l) && !/^\s*import\b/.test(l)) out.add(`${f}:${i + 1}`); });
    return drop(out, sym);
}
const systems = { 'graph-indexer': oursRefs, 'gi (>=likely)': (s) => oursRefs(s, { minConf: 0.4 }), 'name-only': nameOnlyRefs, grep: grepRefs };
const ORACLES = ['dispatch', 'exact'];

const newAgg = () => Object.fromEntries(Object.keys(systems).map(k => [k, { tp: 0, fp: 0, fn: 0, pSum: 0, rSum: 0, n: 0, perfect: 0 }]));
const aggs = Object.fromEntries(ORACLES.map(o => [o, newAgg()]));
let evaluated = 0, withRefs = 0;
queries.forEach((sym, i) => {
    if (!truth[i]) return;
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
console.log(`\n${fixture}${scope.length ? ` (${scope.join(', ')})` : ''}: ${evaluated} sampled symbols (${withRefs} with ≥1 dispatch-oracle reference), oracle = javac`);
const result = {};
for (const o of ORACLES) {
    console.log(`\noracle: ${o === 'dispatch' ? 'dispatch (self + overridden + overriding methods)' : 'exact (uses of the element itself)'}`);
    console.log('system          micro-P  micro-R  micro-F1 | macro-P  macro-R | exact-set');
    result[o] = {};
    for (const [name, a] of Object.entries(aggs[o])) {
        const P = a.tp / Math.max(1, a.tp + a.fp), R = a.tp / Math.max(1, a.tp + a.fn), F = 2 * P * R / Math.max(1e-9, P + R);
        result[o][name] = { microP: P, microR: R, microF1: F, macroP: a.pSum / a.n, macroR: a.rSum / a.n, exactSet: a.perfect / a.n };
        console.log(`${name.padEnd(15)} ${P.toFixed(3).padStart(7)}  ${R.toFixed(3).padStart(7)}  ${F.toFixed(3).padStart(8)} | ${(a.pSum / a.n).toFixed(3).padStart(7)}  ${(a.rSum / a.n).toFixed(3).padStart(7)} | ${(a.perfect / a.n).toFixed(3)}`);
    }
}
if (opt('--json', null)) fs.writeFileSync(opt('--json'), JSON.stringify({ fixture, scope, n: evaluated, result }, null, 2));
intel.close();
