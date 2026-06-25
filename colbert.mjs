/**
 * @file colbert.mjs
 * @description B4 — ColBERT-style LATE-INTERACTION reranker (multi-vector MaxSim). A third,
 *              opt-in reranker provider (rerank.provider === 'late-interaction'), sibling to the
 *              generative judge and the cross-encoder (B2). Where a single-vector dense channel
 *              pools the query and the document each into ONE vector (losing which part matched
 *              where), late interaction keeps MULTIPLE vectors per side and scores them with MaxSim:
 *
 *                  score(q, d) = Σ_{qi}  max_{dj}  cos(qi, dj)
 *
 *              i.e. every query sub-vector finds its best-matching document sub-vector and the hits
 *              sum — the compositional-query win ColBERT is known for. It reuses the document
 *              sub-vectors the engine ALREADY stores (the base + `|s` summary + `|wN` window vectors
 *              of each chunk), so there is **no storage blow-up** — the canonical ColBERT cost. It is
 *              deployed as a RERANKER over the over-fetched candidate pool (the standard
 *              retrieve-then-late-interact pattern), so it is a post-retrieval re-order — the default
 *              ranking is untouched and parity is preserved (both backends read the SAME bin → the
 *              SAME doc vectors → the SAME MaxSim → the SAME order).
 *
 *              AIR-GAPPED / HONEST SCOPE: the query multi-vectors are produced by the SAME local
 *              embedder the dense channel already uses (no new model, no network). A true ColBERT
 *              uses a token-level CONTEXTUAL encoder; a general sentence embedder over query
 *              sub-units only APPROXIMATES that — so this is "late interaction over the existing
 *              encoder," with a real token-level ColBERT model a clean future drop-in behind
 *              `encodeMultiVector`. Requires --embeddings (the doc vectors + the embedder); a no-op
 *              (returns the original order) when either is absent.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { collectVectorsByKey } from './engine/binary.mjs';
import { embeddingKeyFor, SUMMARY_VEC_SUFFIX, WINDOW_VEC_SUFFIX, EMBEDDING_MAX_WINDOWS } from './search-core.mjs';

// Query sub-unit extraction is intentionally light (no stemming — surface forms, like the dense
// channel). A tiny stopword guard keeps function words from spending a query vector slot.
const STOP = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'that', 'this', 'is', 'are', 'was', 'were', 'be', 'how', 'what', 'when', 'where', 'which',
    'who', 'why', 'does', 'do', 'it', 'its', 'into', 'if', 'then', 'there', 'all', 'any',
]);

/** Cosine similarity of two equal-length vectors (0 when either is degenerate). */
export function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * MaxSim late-interaction score: Σ over query vectors of the max cosine to any document vector.
 * Order-independent (a sum of maxes) → no parity dependence on vector ordering.
 * @param {Float32Array[]} qVecs  query sub-vectors
 * @param {Float32Array[]} dVecs  document sub-vectors
 * @returns {number}  0 when either side is empty
 */
export function maxSimScore(qVecs, dVecs) {
    if (!qVecs?.length || !dVecs?.length) return 0;
    let total = 0;
    for (const q of qVecs) {
        let best = -Infinity;
        for (const d of dVecs) { const s = cosine(q, d); if (s > best) best = s; }
        if (best > -Infinity) total += best;
    }
    return total;
}

/** The embedding keys that hold a chunk's stored sub-vectors (base + summary + windows). */
function chunkVectorKeys(chunk) {
    const vecKey = embeddingKeyFor(chunk);
    const keys = [vecKey, chunk.content_hash, vecKey + SUMMARY_VEC_SUFFIX];
    for (let i = 1; i < EMBEDDING_MAX_WINDOWS; i++) keys.push(vecKey + WINDOW_VEC_SUFFIX + i);
    return { vecKey, keys };
}

/**
 * Load each chunk's stored sub-vectors from the shared `.embeddings.bin` in a SINGLE pass (one bin
 * read per rerank, not per candidate). Identical for both backends (same file, same keys) →
 * parity-by-construction. @returns {Map<chunkId, Float32Array[]>}
 */
export function loadChunkVectors(binPath, chunks) {
    const meta = new Map();        // chunkId → { vecKey, hash }
    const allKeys = new Set();
    for (const c of chunks) {
        if (!c || !c.content_hash) { meta.set(c?.id, null); continue; }
        const { vecKey, keys } = chunkVectorKeys(c);
        meta.set(c.id, { vecKey, hash: c.content_hash });
        for (const k of keys) allKeys.add(k);
    }
    const found = collectVectorsByKey(binPath, allKeys);
    const out = new Map();
    for (const [id, m] of meta) {
        if (!m) { out.set(id, []); continue; }
        const vecs = [];
        const base = found.get(m.vecKey) || found.get(m.hash);     // deterministic order: base, summary, windows
        if (base) vecs.push(base);
        const s = found.get(m.vecKey + SUMMARY_VEC_SUFFIX); if (s) vecs.push(s);
        for (let i = 1; i < EMBEDDING_MAX_WINDOWS; i++) { const w = found.get(m.vecKey + WINDOW_VEC_SUFFIX + i); if (w) vecs.push(w); }
        out.set(id, vecs);
    }
    return out;
}

/**
 * Encode a query into MULTIPLE vectors (the whole query plus its content sub-units) with the SAME
 * local embedder the dense channel uses. Best-effort: returns [] on any failure / no embedder.
 * @param {{embedDocuments?:Function, embedQuery?:Function}} embedder
 * @param {string} text
 * @param {object} [opts]
 * @returns {Promise<Float32Array[]>}
 */
export async function encodeMultiVector(embedder, text, { maxVecs = 8 } = {}) {
    if (!embedder || typeof embedder.embedDocuments !== 'function') return [];
    const words = String(text).toLowerCase().split(/[\s\W_]+/).filter(Boolean);
    const units = [];
    const seen = new Set();
    for (const w of words) {
        if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
        seen.add(w); units.push(w);
        if (units.length >= maxVecs - 1) break;
    }
    units.unshift(String(text));        // the holistic query vector always leads
    let vecs;
    try { vecs = await embedder.embedDocuments(units); }
    catch { return []; }
    return (vecs || []).filter(v => v && v.length).map(v => v instanceof Float32Array ? v : new Float32Array(v));
}

/**
 * Late-interaction RERANK of the over-fetched pool. Re-orders the top-`topM` by MaxSim of the query
 * multi-vectors against each candidate's stored doc sub-vectors; the tail is preserved. Best-effort
 * and never throws: any shortfall (no embedder, <2 candidates with vectors, empty query vectors)
 * returns the ORIGINAL order, so the channel can only help, never corrupt. Never mutates `r.score`
 * (protects the downstream git-boost / formatting), exactly like rerankCrossEncoder.
 *
 * @param {Array<{chunk:object, score:number}>} results
 * @param {object} opts
 * @param {Float32Array[]} opts.qVecs    query multi-vectors (from encodeMultiVector)
 * @param {string} opts.binPath          the `.embeddings.bin` path (db.embeddingBinPath())
 * @param {number} [opts.topM]
 * @returns {Array}
 */
export function rerankLateInteraction(results, { qVecs, binPath, topM = 12 } = {}) {
    const head = results.slice(0, topM);
    if (head.length < 2 || !qVecs?.length || !binPath) return results;
    const vecsById = loadChunkVectors(binPath, head.map(r => r.chunk));
    const scored = head.map((r, i) => {
        const dVecs = vecsById.get(r.chunk.id) || [];
        return { i, id: r.chunk.id, s: dVecs.length ? maxSimScore(qVecs, dVecs) : NaN };
    });
    // "Can only help, never corrupt": treat no-signal as a shortfall. Re-order only when at least two
    // candidates carry a FINITE and DISTINCT MaxSim — so all-zero scores (e.g. a dim mismatch making
    // every cosine 0) or undifferentiated ties fall through to the original order instead of being
    // scrambled into id-lexicographic order by the tie-break.
    const finite = scored.filter(x => Number.isFinite(x.s));
    if (finite.length < 2 || new Set(finite.map(x => x.s)).size < 2) return results;
    const order = scored
        // finite MaxSim first (desc); candidates without vectors sink but keep a stable id order
        .sort((a, b) => {
            const af = Number.isFinite(a.s), bf = Number.isFinite(b.s);
            if (af && bf) return (b.s - a.s) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
            if (af) return -1; if (bf) return 1;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .map(x => x.i);
    return [...order.map(i => head[i]), ...results.slice(topM)];
}
