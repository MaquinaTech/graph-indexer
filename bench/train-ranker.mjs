/**
 * @file bench/train-ranker.mjs
 * @description OFFLINE trainer for the D3 learned re-ranker (NOT shipped at runtime). Builds a
 *              (feature, label) matrix from the benchmark's labelled query→candidate pairs — over
 *              indexes built with --symbol-graph so the structure features (centrality / resolved
 *              in-degree) are populated — and fits a zero-dependency logistic-regression model by
 *              gradient descent. Prints the model JSON to paste into search-core.mjs
 *              (DEFAULT_RANKER_MODEL) and the held-out fit so the result stays honest.
 *
 *              Usage:
 *                # 1. build the eval fixtures WITH the graph features:
 *                for fx in axios express-js nestjs fastapi gin; do \
 *                    node indexer.mjs --repo test/fixtures/$fx --symbol-graph; done
 *                # 2. train:
 *                node bench/train-ranker.mjs
 *
 *              Honesty: trains on TUNING queries only (heldOut === false); reports the fit on the
 *              held-out split separately. RRF remains the shipped default unless the learned model
 *              clears the eval bar — this script measures, it does not force a win.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @license MIT
 */
import { FIXTURES_DIR } from '../test/setup.mjs';
import { loadIndex } from '../test/harness.mjs';
import { RANKER_FEATURES, extractRankerFeatures } from '../search-core.mjs';

import * as axiosSuite from '../test/suites/axios.mjs';
import * as expressJsSuite from '../test/suites/express-js.mjs';
import * as nestjsSuite from '../test/suites/nestjs.mjs';
import * as fastapiSuite from '../test/suites/fastapi.mjs';
import * as ginSuite from '../test/suites/gin.mjs';
import path from 'node:path';

const SUITES = [axiosSuite, expressJsSuite, nestjsSuite, fastapiSuite, ginSuite];
const POOL = 15;     // candidate pool per query (over-fetch, matches the runtime re-rank pool)

/** Strict label: a candidate's name (or a dotted/.::-split part) exactly equals an expected name. */
function isCorrect(chunk, expectedNames) {
    if (!chunk || !chunk.name) return false;
    const parts = new Set([String(chunk.name).toLowerCase(), ...String(chunk.name).toLowerCase().split(/[.#:]+/)]);
    return (expectedNames || []).some(n => parts.has(String(n).toLowerCase()));
}

/**
 * Build PER-QUERY candidate pools (each its own row group) from every suite's labelled queries.
 * Grouping is query-keyed — NOT a fixed-row chunking — because searchHybrid can return fewer than
 * POOL candidates for a query, which would otherwise desync downstream query boundaries.
 * @returns {Array<{ rows: Array<{x:number[], y:number}>, heldOut: boolean }>}
 */
function buildQueries() {
    const queries = [];
    let skipped = 0;
    for (const suite of SUITES) {
        const dir = path.join(FIXTURES_DIR, suite.META.id);
        const db = loadIndex(dir, {});
        if (!db) { skipped++; console.error(`  ⚠️  no index for ${suite.META.id} — build it with --symbol-graph`); continue; }
        const hasGraph = db.hasSymbolGraph?.() ?? false;
        const getCentrality = db.hasCentrality?.() ? (id) => db.getCentrality(id) : null;
        const getInEdges = hasGraph ? (id) => db.getEdges(id, { direction: 'in' }) : null;
        let pos = 0, tot = 0, dropped = 0;
        for (const q of suite.QUERIES) {
            const pool = db.searchHybrid(q.query, null, POOL);
            if (!pool.length) { dropped++; continue; }   // a 0-result query cannot be ranked
            const maxScore = pool.reduce((m, r) => Math.max(m, r.score || 0), 0);
            const rows = pool.map((r, i) => {
                const f = extractRankerFeatures(r, i, { maxScore, getCentrality, getInEdges, gitScoreFor: null });
                const y = isCorrect(r.chunk, q.expected_names) ? 1 : 0;
                pos += y; tot++;
                return { x: RANKER_FEATURES.map(k => f[k]), y };
            });
            queries.push({ rows, heldOut: Boolean(q.heldOut) });
        }
        console.error(`  ${suite.META.id}: graph=${hasGraph} · ${tot} candidates · ${pos} positives${dropped ? ` · ${dropped} zero-result q dropped` : ''}`);
    }
    if (skipped) console.error(`  (${skipped} suite(s) had no index)`);
    return queries;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Logistic regression by full-batch gradient descent with L2 + positive-class upweighting. */
function train(queries, { epochs = 4000, lr = 0.3, l2 = 1e-3 } = {}) {
    const n = RANKER_FEATURES.length;
    const w = new Array(n).fill(0);
    let b = 0;
    const rows = queries.filter(q => !q.heldOut).flatMap(q => q.rows);  // TRAIN split only
    const npos = rows.reduce((s, r) => s + r.y, 0) || 1;
    const nneg = rows.length - npos || 1;
    const posW = nneg / npos;        // upweight the rare positive class to counter imbalance
    for (let e = 0; e < epochs; e++) {
        const gw = new Array(n).fill(0); let gb = 0; let wsum = 0;
        for (const r of rows) {
            const z = b + w.reduce((s, wi, j) => s + wi * r.x[j], 0);
            const p = sigmoid(z);
            const sw = r.y ? posW : 1;
            const err = (p - r.y) * sw;
            for (let j = 0; j < n; j++) gw[j] += err * r.x[j];
            gb += err; wsum += sw;
        }
        for (let j = 0; j < n; j++) w[j] -= lr * (gw[j] / wsum + l2 * w[j]);
        b -= lr * (gb / wsum);
    }
    return { bias: Number(b.toFixed(4)), weights: Object.fromEntries(RANKER_FEATURES.map((k, j) => [k, Number(w[j].toFixed(4))])) };
}

/** Rank-1 accuracy: per query, does the highest-scored candidate carry label 1? */
function rank1(queries, model) {
    let hit = 0, total = 0;
    for (const q of queries) {
        if (!q.rows.length) continue;
        total++;
        let best = -Infinity, bestY = 0;
        for (const r of q.rows) {
            const s = model.bias + RANKER_FEATURES.reduce((acc, k, j) => acc + (model.weights[k] || 0) * r.x[j], 0);
            if (s > best) { best = s; bestY = r.y; }
        }
        hit += bestY;
    }
    return total ? hit / total : 0;
}

console.error('Building per-query training pools (needs --symbol-graph fixture indexes)…');
const queries = buildQueries();
if (!queries.length) { console.error('No data — build the fixtures first.'); process.exit(1); }
const model = train(queries);

// Held-out rank-1 vs the RRF baseline (rrf-only model) — the honest comparison, grouped per query.
const held = queries.filter(q => q.heldOut);
const rrfOnly = { bias: 0, weights: { rrf: 1 } };
console.error(`\nHeld-out queries: ${held.length}`);
console.error(`Held-out rank-1:  RRF-only ${rank1(held, rrfOnly).toFixed(3)}  ·  learned ${rank1(held, model).toFixed(3)}`);
console.error('\n// Data-fit model (RRF stays the shipped default regardless — see IMPROVEMENT_LEARNED_RANKER.md):');
console.log(JSON.stringify(model, null, 2));
