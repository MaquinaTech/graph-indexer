#!/usr/bin/env node
/**
 * Coordinate-ascent tuning of the search reranker weights on the TUNING split only.
 * The held-out split is evaluated and printed for every accepted step but never used for
 * selection, so the reported held-out numbers stay an honest generalisation estimate.
 *
 *   node bench/tune-weights.mjs [--passes 2]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SearchEngine, DEFAULT_WEIGHTS } from '../src/search/search.mjs';
import { computeCentrality } from '../src/index/graph.mjs';
import { openFixture, strictHit } from './eval-search.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = 'axios,express-js,gin,spring,rust,cjson,nvm,fastapi,nestjs'.split(',');
const passes = Number(process.argv[process.argv.indexOf('--passes') + 1] || 2);

const loaded = [];
for (const fx of FIXTURES) {
    const suite = await import(path.join(here, 'suites', fx + '.mjs'));
    const { store, ix } = await openFixture(fx);
    const cen = computeCentrality(store);
    const symCache = new Map();
    const sym = (id) => { let s = symCache.get(id); if (!s) { s = store.get("SELECT s.name, s.qname, s.kind, f.path, s.visibility = 'default' AS isDefault FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?", id); symCache.set(id, s); } return s; };
    loaded.push({ fx, suite, store, ix, cen, sym });
}

function evaluate(weights) {
    const agg = { tune: { r1: 0, rr: 0, s5: 0, n: 0 }, held: { r1: 0, rr: 0, s5: 0, n: 0 } };
    for (const L of loaded) {
        const engine = new SearchEngine(L.ix, { weights, centrality: () => L.cen });
        for (const q of L.suite.QUERIES) {
            const { results } = engine.search(q.query, { limit: 10 });
            const hits = results.map(r => strictHit(L.sym(r.id), q.expected_names || []));
            const first = hits.indexOf(true);
            const a = q.heldOut ? agg.held : agg.tune;
            a.n++; a.r1 += hits[0] ? 1 : 0; a.rr += first >= 0 ? 1 / (first + 1) : 0; a.s5 += first >= 0 && first < 5 ? 1 : 0;
        }
    }
    for (const k of ['tune', 'held']) { const a = agg[k]; a.r1 /= a.n; a.rr /= a.n; a.s5 /= a.n; }
    return agg;
}
const objective = (m) => m.tune.rr + 0.5 * m.tune.r1 + 0.25 * m.tune.s5;
const fmt = (m) => `tune r1 ${m.tune.r1.toFixed(3)} s5 ${m.tune.s5.toFixed(3)} mrr ${m.tune.rr.toFixed(3)} | held r1 ${m.held.r1.toFixed(3)} s5 ${m.held.s5.toFixed(3)} mrr ${m.held.rr.toFixed(3)}`;

let best = { ...DEFAULT_WEIGHTS };
let bestM = evaluate(best);
let bestObj = objective(bestM);
console.log('start   ', fmt(bestM));
const factors = [0, 0.5, 0.75, 1.33, 2];
for (let p = 0; p < passes; p++) {
    for (const k of Object.keys(best)) {
        for (const f of factors) {
            const cand = { ...best, [k]: best[k] === 0 ? (f === 0 ? 0 : 0.1 * f) : +(best[k] * f).toFixed(4) };
            if (cand[k] === best[k]) continue;
            const m = evaluate(cand);
            const o = objective(m);
            if (o > bestObj + 1e-9) { best = cand; bestM = m; bestObj = o; console.log(`accept  ${k}=${cand[k]}`.padEnd(32), fmt(m)); }
        }
    }
}
console.log('\nbest weights:', JSON.stringify(best));
console.log('final   ', fmt(bestM));
