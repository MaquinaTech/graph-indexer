/**
 * @file search-sparse.mjs
 * @description B3 — opt-in LEARNED-SPARSE vocabulary-expansion channel. A learned-sparse retriever
 *              (SPLADE / uniCOIL family) expands a query into a WEIGHTED term set — original terms
 *              plus learned associates — and fuses that as an extra sparse channel, closing
 *              lexical-gap misses the Porter-stemming bridge structurally cannot (stemming only
 *              normalises morphology; it cannot connect "auth" → "credential"/"token").
 *
 *              THE AIR-GAPPED, ZERO-DEPENDENCY REALISATION: rather than require a neural MLM
 *              (which needs a downloaded model + @huggingface/transformers and cannot be measured
 *              air-gapped), the SHIPPED provider LEARNS the term associations FROM THE CORPUS at
 *              index time via positive pointwise mutual information (PMI) over chunk co-occurrence.
 *              It is genuine learned-sparse — learned per-term weights + vocabulary expansion — with
 *              ZERO new dependency, fully deterministic, and measurable on the honest `test:eval`.
 *              A neural SPLADE provider is a clean future drop-in behind the same `expandSparseQuery`
 *              seam (see docs/internals/IMPROVEMENT_LEARNED_SPARSE.md).
 *
 *              SOUNDNESS / SACRED DEFAULT: the model is built ONLY with --learned-sparse and
 *              serialized as an ISOLATED index artifact (like centrality/taint/scip_refs), so it
 *              cannot perturb the lexical postings or the default path. The channel is
 *              NL-ASYMMETRIC — it fires only for natural-language queries with a real expansion —
 *              so symbolic/exact lookups stay byte-identical. Scoring is delegated to a SHARED
 *              core (search-core.scoreSparseExpanded) that both backends call through their own
 *              postings accessors → parity by construction.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { tokenize } from './search-core.mjs';

// ── Model-build knobs (structural, not tuned to any query) ──────────────────────────────────
const MIN_TOKEN_LEN = 3;          // ignore 1-2 char noise
const MAX_TOKENS_PER_CHUNK = 40;  // cap co-occurrence fan-out per chunk (most-discriminative first)
const MIN_DF = 2;                 // a term must occur in ≥2 chunks to carry association signal
const MAX_DF_RATIO = 0.30;        // skip ultra-common terms (in >30% of chunks → no discriminative value)
const MIN_COOC = 2;               // a pair must co-occur in ≥2 chunks (kills incidental pairs)
const TOPK_ASSOC = 8;             // keep the strongest K associates per term
const PMI_NORM = 6;               // PMI (log2) normaliser → stored weight = clamp(pmi/6, 0..1)

// ── Query-expansion knobs ───────────────────────────────────────────────────────────────────
const EXPANSION_SCALE = 0.35;     // an associate term contributes ≤0.35× a real query term
const MAX_QUERY_EXPANSIONS = 12;  // total associate terms added across the whole query
const MIN_EXPANSION_WEIGHT = 0.05;// drop near-zero associates (no point fusing them)

/** Distinct, length-filtered RAW tokens of a text (no stems — associations are surface-form). */
function distinctTokens(text) {
    const out = new Set();
    for (const t of tokenize(text, false)) if (t.length >= MIN_TOKEN_LEN) out.add(t);
    return out;
}

/**
 * Learn the sparse association model from the corpus. Two passes:
 *   1. document frequency per token (over distinct per-chunk tokens);
 *   2. co-occurrence counts over each chunk's top-MAX_TOKENS_PER_CHUNK most-discriminative tokens
 *      (rarest first by df), then positive PMI per pair, keeping the top-K associates per term.
 *
 * Deterministic: every map is materialised through SORTED keys, and stored weights are rounded, so
 * the serialized model is byte-identical run to run and the two backends read identical bytes.
 *
 * @param {Iterable<{code_snippet?:string,name?:string,docstring?:string}>} chunks  the index chunks
 * @param {object} [opts]
 * @returns {{ assoc: Record<string, Array<[string, number]>>, meta: object } | null}  null if no signal
 */
export function buildSparseModel(chunks, opts = {}) {
    const minDf = opts.minDf ?? MIN_DF;
    const maxDfRatio = opts.maxDfRatio ?? MAX_DF_RATIO;
    const topK = opts.topKAssoc ?? TOPK_ASSOC;

    // The text a chunk contributes its vocabulary from — name + docstring + the snippet.
    const chunkText = (c) => `${c.name || ''} ${c.docstring || ''} ${c.summary || ''} ${c.code_snippet || ''}`;

    // Pass 1: per-chunk distinct tokens + document frequency.
    const perChunk = [];
    const df = new Map();
    for (const c of chunks) {
        const toks = distinctTokens(chunkText(c));
        if (toks.size < 2) { perChunk.push(null); continue; }
        perChunk.push(toks);
        for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
    }
    const docCount = perChunk.length;
    if (!docCount) return null;
    const maxDf = Math.max(minDf, Math.floor(maxDfRatio * docCount));

    // A token carries association signal only inside the df band [minDf, maxDf].
    const eligible = (t) => { const d = df.get(t) || 0; return d >= minDf && d <= maxDf; };

    // Pass 2: co-occurrence over each chunk's most-discriminative (rarest) eligible tokens.
    const cooc = new Map();  // term → Map<term, count>
    const bump = (a, b) => {
        let m = cooc.get(a); if (!m) { m = new Map(); cooc.set(a, m); }
        m.set(b, (m.get(b) || 0) + 1);
    };
    for (const toks of perChunk) {
        if (!toks) continue;
        const elig = [...toks].filter(eligible);
        if (elig.length < 2) continue;
        // rarest-first (df asc, then lexical) → cap fan-out deterministically
        elig.sort((a, b) => (df.get(a) - df.get(b)) || (a < b ? -1 : a > b ? 1 : 0));
        const top = elig.slice(0, MAX_TOKENS_PER_CHUNK);
        for (let i = 0; i < top.length; i++) {
            for (let j = i + 1; j < top.length; j++) {
                bump(top[i], top[j]); bump(top[j], top[i]);   // symmetric
            }
        }
    }

    // Positive PMI per pair → top-K associates per term, weight = clamp(pmi / PMI_NORM, 0..1).
    const log2 = (x) => Math.log(x) / Math.LN2;
    const assoc = {};
    let pairs = 0;
    for (const term of [...cooc.keys()].sort()) {
        const dfa = df.get(term);
        const row = [];
        for (const [other, c] of cooc.get(term)) {
            if (c < MIN_COOC) continue;
            const dfb = df.get(other);
            // PMI = log2( P(a,b) / (P(a) P(b)) ) = log2( c·N / (dfa·dfb) )
            const pmi = log2((c * docCount) / (dfa * dfb));
            if (pmi <= 0) continue;
            const w = Math.min(1, pmi / PMI_NORM);
            if (w < MIN_EXPANSION_WEIGHT) continue;
            row.push([other, Number(w.toFixed(4))]);
        }
        if (!row.length) continue;
        // strongest first; lexical tie-break for determinism; keep top-K
        row.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
        assoc[term] = row.slice(0, topK);
        pairs += assoc[term].length;
    }
    if (!pairs) return null;

    return {
        assoc,
        meta: { terms: Object.keys(assoc).length, pairs, docs: docCount, metric: 'pmi', version: 1 },
    };
}

/**
 * Expand a natural-language query into a WEIGHTED term set for the sparse channel: the learned
 * ASSOCIATE terms only (the original query terms already drive the lexical channel, so the sparse
 * channel is a pure vocabulary-EXPANSION view — it surfaces chunks that match the semantically
 * associated vocabulary the literal query never mentions). Deterministic insertion order (query-token
 * order, then per-token associate order) so both backends accumulate scores identically.
 *
 * Returns null when nothing fires (no model, no eligible token, no association) — the caller then
 * runs ZERO sparse channel and the result is byte-identical to the default path.
 *
 * @param {string} queryText
 * @param {{assoc:Record<string,Array<[string,number]>>}} model
 * @param {object} [opts]
 * @returns {Map<string, number> | null}  associate term → fusion weight, or null
 */
export function expandSparseQuery(queryText, model, opts = {}) {
    if (!model || !model.assoc) return null;
    const scale = opts.scale ?? EXPANSION_SCALE;
    const maxExp = opts.maxExpansions ?? MAX_QUERY_EXPANSIONS;
    const assoc = model.assoc;

    const qTokens = [...distinctTokens(queryText)];           // raw surface forms, query order via Set
    const weights = new Map();                                // associate term → best weight seen
    for (const qt of qTokens) {
        const row = assoc[qt];
        if (!row) continue;
        for (const [term, w] of row) {
            if (qTokens.includes(term)) continue;             // don't re-add a literal query term
            const ew = scale * w;
            if (ew < MIN_EXPANSION_WEIGHT) continue;
            const prev = weights.get(term);
            if (prev === undefined || ew > prev) weights.set(term, ew);
        }
    }
    if (!weights.size) return null;

    // Keep the strongest MAX_QUERY_EXPANSIONS, but REBUILD the map in deterministic order
    // (weight desc, then term asc) so both backends iterate — and float-accumulate — identically.
    const ranked = [...weights.entries()]
        .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
        .slice(0, maxExp);
    if (!ranked.length) return null;
    return new Map(ranked);
}
