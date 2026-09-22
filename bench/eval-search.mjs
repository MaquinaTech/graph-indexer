#!/usr/bin/env node
/**
 * Retrieval benchmark: runs the authored query suites (bench/suites/*.mjs) against the index and
 * scores them with the same STRICT rule as graph-indexer v2's harness (a hit = the result's name,
 * or one of its qualified-name segments, equals an expected name; case-insensitive; no file-path
 * fallback). Reports rank-1, success@5 and MRR@10, split into tuning vs held-out queries, and
 * compares per query with the v2 baseline (bench/baseline-v2.json) when present.
 *
 *   node bench/eval-search.mjs [--fixtures a,b] [--rebuild] [--verbose] [--json out.json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/db.mjs';
import { Indexer } from '../src/index/indexer.mjs';
import { SearchEngine, DEFAULT_WEIGHTS } from '../src/search/search.mjs';
import { computeCentrality } from '../src/index/graph.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FIXTURES = (opt('--fixtures', 'axios,express-js,gin,spring,rust,cjson,nvm,fastapi,nestjs')).split(',');
const FIXDIR = path.resolve(opt('--fixture-dir', path.join(here, '../test/fixtures')));
const DBDIR = path.resolve(opt('--db-dir', path.join(os.tmpdir(), 'graph-indexer-bench')));
const verbose = args.includes('--verbose');
const rebuild = args.includes('--rebuild');
const baseline = fs.existsSync(path.join(here, 'baseline-v2.json')) ? JSON.parse(fs.readFileSync(path.join(here, 'baseline-v2.json'), 'utf8')) : null;
const weights = opt('--weights', null) ? { ...DEFAULT_WEIGHTS, ...JSON.parse(opt('--weights')) } : DEFAULT_WEIGHTS;

/**
 * v2's strict rule matched an expected name against the chunk name, its dotted segments and its
 * enclosing class. v2 chunk names were things like `res.cookie`, `module.exports`,
 * `http_export_statement` (anonymous default export of http.js). The equivalent here: the symbol
 * name, every contiguous run of qualified-name segments (`res.cookie`, `Layer.match`, `Layer`),
 * with `X.prototype.y` ≡ `X.y` and `<file>_export_statement` ≡ the default export of <file>.
 */
export function strictHit(sym, expected) {
    const segs = sym.qname.toLowerCase().split(/[.#:]/).filter(Boolean);
    const parts = new Set([sym.name.toLowerCase()]);
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j <= segs.length; j++) parts.add(segs.slice(i, j).join('.'));
    const base = (sym.path ?? '').split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
    return expected.some(n => {
        let e = n.toLowerCase().replace(/\.prototype\./g, '.');
        if (e.endsWith('_export_statement')) return sym.kind !== 'field' && e.slice(0, -'_export_statement'.length) === base && (sym.isDefault || parts.has(base));
        return parts.has(e);
    });
}

export async function openFixture(fx, { rebuild: rb = false } = {}) {
    const root = path.join(FIXDIR, fx);
    const dbPath = path.join(DBDIR, fx + '.db');
    if (rb) for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch { /* none */ } }
    const store = new Store(dbPath);
    const ix = new Indexer({ root, store });
    const t0 = Date.now();
    const r = await ix.sync();
    return { store, ix, sync: r, ms: Date.now() - t0 };
}

async function main() {
    const pooled = { tune: [], held: [] };
    const report = {};
    for (const fx of FIXTURES) {
        const suite = await import(path.join(here, 'suites', fx + '.mjs'));
        const { store, ix, sync, ms } = await openFixture(fx, { rebuild });
        const cen = computeCentrality(store);
        const engine = new SearchEngine(ix, { weights, centrality: () => cen });
        const rows = [];
        for (const q of suite.QUERIES) {
            const { results } = engine.search(q.query, { limit: 10 });
            const syms = results.map(r => store.get('SELECT s.name, s.qname, s.kind, f.path, s.visibility = \'default\' AS isDefault FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?', r.id));
            const hits = syms.map(s => strictHit(s, q.expected_names || []));
            const first = hits.indexOf(true);
            const row = { id: q.id, q: q.query, d: q.difficulty, held: !!q.heldOut, r1: hits[0] ? 1 : 0, s5: first >= 0 && first < 5 ? 1 : 0, rr: first >= 0 ? 1 / (first + 1) : 0, top1: syms[0] ? `${syms[0].qname} @ ${syms[0].path}` : '-', exp: q.expected_names };
            const base = baseline?.[fx]?.rows?.find(b => b.id === q.id);
            if (base) row.base = { r1: base.r1, s5: base.s5, rr: base.rr };
            rows.push(row);
            (row.held ? pooled.held : pooled.tune).push({ ...row, fx });
        }
        const agg = (rs) => ({ n: rs.length, r1: avg(rs, 'r1'), s5: avg(rs, 's5'), mrr: avg(rs, 'rr') });
        const all = agg(rows), sem = agg(rows.filter(r => r.d === 'semantic')), sym = agg(rows.filter(r => r.d !== 'semantic'));
        const b = baseline?.[fx];
        report[fx] = { all, sem, sym, index: { files: sync.total, ms } };
        console.log(`${fx.padEnd(11)} n=${String(all.n).padStart(3)}  r1 ${f2(all.r1)} (v2 ${b ? f2(b.all.r1) : '-'})  s@5 ${f2(all.s5)} (v2 ${b ? f2(b.all.s5) : '-'})  MRR ${f2(all.mrr)} (v2 ${b ? f2(b.all.mrr) : '-'})  | sym r1 ${f2(sym.r1)} (v2 ${b ? f2(b.symbolic.r1) : '-'})  sem r1 ${f2(sem.r1)} s@5 ${f2(sem.s5)} (v2 ${b ? f2(b.semantic.r1) + '/' + f2(b.semantic.s5) : '-'})  [index ${ms}ms]`);
        if (verbose) for (const r of rows) if (r.r1 !== 1 || (r.base && r.base.r1 > r.r1)) console.log(`     ${r.held ? 'H' : ' '} ${r.r1 ? '✓' : r.s5 ? '~' : '✗'} ${r.id.padEnd(8)} ${r.d.padEnd(8)} ${JSON.stringify(r.q).slice(0, 70).padEnd(72)} exp=${r.exp.join('|')}  top1=${r.top1}${r.base ? `  v2:${r.base.r1 ? 'r1' : r.base.s5 ? 's5' : 'miss'}` : ''}`);
        store.close();
    }
    for (const [label, rs] of [['TUNING', pooled.tune], ['HELD-OUT', pooled.held], ['ALL', [...pooled.tune, ...pooled.held]]]) {
        const sem = rs.filter(r => r.d === 'semantic'), sym = rs.filter(r => r.d !== 'semantic');
        const withBase = rs.filter(r => r.base);
        console.log(`${label.padEnd(9)} n=${rs.length}  r1 ${f3(avg(rs, 'r1'))}  s@5 ${f3(avg(rs, 's5'))}  MRR ${f3(avg(rs, 'rr'))} | sym(${sym.length}) r1 ${f3(avg(sym, 'r1'))} s@5 ${f3(avg(sym, 's5'))} | sem(${sem.length}) r1 ${f3(avg(sem, 'r1'))} s@5 ${f3(avg(sem, 's5'))}` +
            (withBase.length ? `   || v2 on same queries: r1 ${f3(avgB(withBase, 'r1'))} s@5 ${f3(avgB(withBase, 's5'))} MRR ${f3(avgB(withBase, 'rr'))}` : ''));
    }
    if (opt('--json', null)) fs.writeFileSync(opt('--json'), JSON.stringify({ report, pooled }, null, 1));
}

function avg(rs, k) { return rs.length ? rs.reduce((s, r) => s + r[k], 0) / rs.length : 0; }
function avgB(rs, k) { return rs.length ? rs.reduce((s, r) => s + r.base[k], 0) / rs.length : 0; }
function f2(x) { return x.toFixed(2); }
function f3(x) { return x.toFixed(3); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
