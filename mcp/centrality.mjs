/**
 * @file mcp/centrality.mjs
 * @description Symbol-level centrality (A5): confidence-weighted PageRank over the A4
 *              resolved chunk→chunk symbol graph. A definition referenced (called / extended /
 *              used as a type) by many *other central* symbols scores high — it is a hub the
 *              rest of the program leans on.
 *
 *              This is DISTINCT from `computePageRank` in search-core.mjs, which ranks FILES
 *              over the import graph (and drives enrichment selection + get_repo_map file
 *              ordering). A5 is symbol-granular and call/type-aware, not import-aware.
 *
 *              Like the edges themselves, it is computed ONCE at index time and serialized into
 *              the index, so both backends serve byte-identical scores/ranks — parity is free,
 *              and it never touches search ranking. Opt-in: only built when --symbol-graph is on.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */

/**
 * Per-confidence edge weight. A `name_only` edge is a heuristic name match (no receiver type
 * / no import evidence) and is noisier than a `high` edge, so it contributes half the flow.
 * Both are deterministic constants — no tuning knob, no config surface.
 */
const CONFIDENCE_WEIGHT = { high: 1.0, name_only: 0.5 };

const DAMPING = 0.85;
const MAX_ITERS = 100;          // hard safety net; sparse symbol graphs converge in ~20–40
const TOLERANCE = 1e-12;        // L1 delta convergence
const SCORE_DECIMALS = 8;       // round before serialization → identical bytes both backends

/**
 * Confidence-weighted PageRank over the resolved symbol graph.
 *
 * Deterministic: nodes are the sorted set of edge endpoints, multi-edges between the same
 * (from→to) pair sum their confidence weights, iteration walks nodes/adjacency in fixed order,
 * and scores are rounded to a fixed precision. Ranks are a dense ordering by score DESC, then
 * chunk-id ASC (the same tie-break the rest of the engine uses). The result is serialized, so
 * cross-backend parity is by construction — both engines read these exact numbers.
 *
 * @param {Array<{from_chunk_id:string,to_chunk_id:string,kind:string,confidence:string}>} edges
 * @param {object} [opts]
 * @param {number} [opts.damping]
 * @param {number} [opts.maxIters]
 * @param {number} [opts.tolerance]
 * @returns {{ centrality: Record<string,{score:number,rank:number}>, total:number, iters:number }}
 *          `centrality` is keyed by chunk id; `total` is the number of ranked (connected) chunks.
 */
export function computeSymbolCentrality(edges, {
    damping = DAMPING, maxIters = MAX_ITERS, tolerance = TOLERANCE,
} = {}) {
    // ── Node set = every chunk that appears in ANY edge (the connected sub-graph). Isolated
    //    chunks are not ranked — "rank N of M connected symbols" stays meaningful. ──────────
    const nodeSet = new Set();
    for (const e of (edges || [])) { nodeSet.add(e.from_chunk_id); nodeSet.add(e.to_chunk_id); }
    const nodes = [...nodeSet].sort();
    const N = nodes.length;
    if (N === 0) return { centrality: {}, total: 0, iters: 0 };

    const index = new Map();
    nodes.forEach((id, i) => index.set(id, i));

    // ── Aggregate edge weights by (from → to), summing confidence weights for multi-edges
    //    (a chunk that both calls AND extends a target flows more) → adjacency sorted by `to`
    //    index for deterministic float accumulation. ────────────────────────────────────────
    const outMaps = nodes.map(() => new Map());     // i → Map(j → summed weight)
    for (const e of (edges || [])) {
        const i = index.get(e.from_chunk_id);
        const j = index.get(e.to_chunk_id);
        const w = CONFIDENCE_WEIGHT[e.confidence] ?? CONFIDENCE_WEIGHT.name_only;
        outMaps[i].set(j, (outMaps[i].get(j) || 0) + w);
    }
    const adj = new Array(N);                        // i → [[j, weight], …] sorted by j
    const outWeight = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        const arr = [...outMaps[i].entries()].sort((a, b) => a[0] - b[0]);
        let tot = 0;
        for (const [, w] of arr) tot += w;
        adj[i] = arr;
        outWeight[i] = tot;
    }

    // ── Power iteration. Dangling nodes (no out-edges) redistribute their mass uniformly so
    //    the rank vector stays a probability distribution. ────────────────────────────────────
    let rank = new Float64Array(N).fill(1 / N);
    const teleport = (1 - damping) / N;
    let iters = 0;
    for (; iters < maxIters; iters++) {
        let dangling = 0;
        for (let i = 0; i < N; i++) if (outWeight[i] === 0) dangling += rank[i];
        const danglingShare = damping * dangling / N;

        const next = new Float64Array(N);
        for (let i = 0; i < N; i++) next[i] = teleport + danglingShare;
        for (let i = 0; i < N; i++) {
            if (outWeight[i] === 0) continue;
            const share = damping * rank[i] / outWeight[i];
            for (const [j, w] of adj[i]) next[j] += share * w;
        }

        let delta = 0;
        for (let i = 0; i < N; i++) delta += Math.abs(next[i] - rank[i]);
        rank = next;
        if (delta < tolerance) { iters++; break; }
    }

    // ── Round, then assign dense ranks by score DESC / id ASC. ───────────────────────────────
    const round = 10 ** SCORE_DECIMALS;
    const scored = nodes.map((id, i) => ({ id, score: Math.round(rank[i] * round) / round }));
    scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const centrality = {};
    scored.forEach((s, i) => { centrality[s.id] = { score: s.score, rank: i + 1 }; });
    return { centrality, total: N, iters };
}
