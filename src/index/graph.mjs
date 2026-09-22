/**
 * Graph analytics over the resolved reference graph: symbol centrality (PageRank, optionally
 * personalized to a focus set — the Aider repo-map idea applied to symbols) and helpers for
 * traversals used by the impact / call-graph tools.
 */

/** Load the weighted symbol graph: edges src → dst (references), plus member → container. */
export function loadGraph(store) {
    const edges = store.all(`SELECT src_id AS s, dst_id AS d, SUM(conf) AS w, COUNT(*) AS n FROM refs
        WHERE dst_id IS NOT NULL AND src_id IS NOT NULL AND src_id != dst_id GROUP BY src_id, dst_id`);
    const contain = store.all('SELECT id AS s, parent_id AS d FROM symbols WHERE parent_id IS NOT NULL');
    const ids = store.all('SELECT id FROM symbols').map(r => r.id);
    return { ids, edges, contain };
}

/**
 * PageRank over symbols. Edge weight = Σconf (√ damped so one hot call site does not dominate).
 * @param {object} store
 * @param {{ personalization?: Map<number, number>, damping?: number, iters?: number }} opts
 * @returns {Map<number, number>} id → score normalized to a [0,1] percentile
 */
export function computeCentrality(store, { personalization = null, damping = 0.85, iters = 40, graph = null } = {}) {
    const g = graph ?? loadGraph(store);
    const n = g.ids.length;
    if (!n) return new Map();
    const index = new Map(g.ids.map((id, i) => [id, i]));
    const out = new Float64Array(n);
    const src = [], dst = [], wt = [];
    const add = (s, d, w) => {
        const a = index.get(s), b = index.get(d);
        if (a === undefined || b === undefined) return;
        src.push(a); dst.push(b); wt.push(w); out[a] += w;
    };
    for (const e of g.edges) add(e.s, e.d, Math.sqrt(e.w));
    for (const e of g.contain) add(e.s, e.d, 0.3);
    let pers = null;
    if (personalization?.size) {
        pers = new Float64Array(n);
        let tot = 0;
        for (const [id, v] of personalization) { const i = index.get(id); if (i !== undefined) { pers[i] += v; tot += v; } }
        if (tot > 0) for (let i = 0; i < n; i++) pers[i] /= tot; else pers = null;
    }
    let rank = new Float64Array(n).fill(1 / n);
    for (let it = 0; it < iters; it++) {
        const next = new Float64Array(n);
        let dangling = 0;
        for (let i = 0; i < n; i++) if (out[i] === 0) dangling += rank[i];
        for (let k = 0; k < src.length; k++) next[dst[k]] += damping * rank[src[k]] * wt[k] / out[src[k]];
        for (let i = 0; i < n; i++) {
            const teleport = pers ? pers[i] : 1 / n;
            next[i] += (1 - damping + damping * dangling) * teleport;
        }
        rank = next;
    }
    if (personalization) return new Map(g.ids.map((id, i) => [id, rank[i]]));
    // percentile normalization: robust to the heavy tail
    const order = [...rank.keys()].sort((a, b) => rank[a] - rank[b]);
    const pct = new Map();
    for (let r = 0; r < order.length; r++) pct.set(g.ids[order[r]], n > 1 ? r / (n - 1) : 1);
    return pct;
}
