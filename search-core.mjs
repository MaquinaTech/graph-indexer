/**
 * @file search-core.mjs
 * @description Storage-agnostic retrieval primitives shared by every backend:
 *              tokenisation, cosine similarity, BM25 scoring, the RRF fusion +
 *              boost ladder, and PageRank centrality. Keeping this math in one
 *              place is what lets the in-memory engine and the SQLite store
 *              return identical rankings — the numbers are measured once and
 *              reused, never re-derived per backend.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */

import { createHash } from 'crypto';

export const EMBEDDING_CONTEXT_LIMIT = 8000;

/**
 * Cache key for a chunk's embedding vector.
 *
 * The embedding payload includes the LLM enrichment summary when present, so a
 * vector computed for an enriched chunk is NOT interchangeable with one computed
 * for the same code without enrichment. Keying by content_hash alone caused two
 * defects: enriched chunks were re-embedded on every index run (cache never hit),
 * and a stale un-enriched vector could be silently reused for an enriched chunk.
 *
 * The key is content_hash for plain chunks, and content_hash + a digest of the
 * enrichment text for enriched ones — deterministic as long as the enrichment
 * cache returns the same summary for the same code.
 *
 * @param {object} chunk
 * @returns {string}
 */
export function embeddingKeyFor(chunk) {
    const hasEnrichment = Boolean(chunk.summary) || (chunk.concepts?.length > 0);
    if (!hasEnrichment) return chunk.content_hash;
    const enrichText = `${chunk.summary || ''}|${(chunk.concepts || []).join(',')}`;
    const suffix = createHash('sha256').update(enrichText).digest('hex').slice(0, 12);
    return `${chunk.content_hash}|e:${suffix}`;
}

export function truncateForEmbedding(text) {
    return text.length > EMBEDDING_CONTEXT_LIMIT ? text.slice(0, EMBEDDING_CONTEXT_LIMIT) : text;
}

export function cosineSimilarity(vecA, vecB) {
    let dot = 0, nA = 0, nB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        nA  += vecA[i] * vecA[i];
        nB  += vecB[i] * vecB[i];
    }
    return nA === 0 || nB === 0 ? 0 : dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

/**
 * Tokenise code/identifiers: lowercase words plus camelCase sub-parts, so
 * `dispatchRequest` indexes as `dispatchrequest`, `dispatch`, `request`.
 */
export function tokenize(text) {
    if (!text) return [];
    const rawTokens = text.split(/[\s\W_]+/);
    const tokens = [];
    for (const word of rawTokens) {
        if (word.length < 2) continue;
        tokens.push(word.toLowerCase());
        const camelParts = word.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
        if (camelParts.length > 1) {
            for (const part of camelParts) {
                if (part.length >= 2) tokens.push(part.toLowerCase());
            }
        }
    }
    return tokens;
}

/**
 * Suffix appended to an embedding key for a chunk's summary-only vector.
 * Enriched chunks carry TWO vectors in the bin: the full code payload (base key)
 * and this compact summary+concepts text. A one-line natural-language query is
 * far closer in embedding space to a one-line summary than to 700 chars of code,
 * so the summary vector is what lets behavioural queries hit code that shares
 * none of their words. Scan hits on `<key>|s` map back to the same chunk.
 */
export const SUMMARY_VEC_SUFFIX = '|s';

/** The text embedded as the summary-only vector, or null when not enriched. */
export function summaryEmbeddingText(chunk) {
    if (!chunk.summary && !(chunk.concepts?.length > 0)) return null;
    return [chunk.summary, (chunk.concepts || []).join(', '), chunk.name]
        .filter(Boolean).join('. ');
}

/**
 * Build the lexical document indexed for BM25. Concatenates the discriminative
 * fields of a chunk (name, docstring, neighbour basenames, calls, params, return
 * type, qualified name, type refs, LLM concept tags, body).
 *
 * Single source of truth shared by the in-memory engine, the watch daemon and the
 * SQLite writer so every backend indexes identical text. Decorators are
 * deliberately excluded — measured to regress framework repos (see core-engine).
 * When enrichment ran, chunk.concepts contains domain keyword strings that bridge
 * lexical gaps (e.g. "authentication JWT middleware"); chunk.hyde is concepts.join(' ')
 * and serves as the backward-compatible field for existing serialized indexes.
 *
 * @param {object}   chunk
 * @param {string[]} depRelPaths  Resolved local imports of the chunk's file.
 * @returns {string}
 */
export function buildLexicalDocument(chunk, depRelPaths = []) {
    const cleanDeps = depRelPaths.map(d => d.split('/').pop().split('.')[0]);
    // Prefer the structured concepts array (new); fall back to the joined hyde string
    // (old serialized indexes) so both formats index identical terms.
    const conceptTokens = chunk.concepts?.length
        ? chunk.concepts.join(' ')
        : (chunk.hyde || '');
    return [
        chunk.name,
        chunk.docstring || '',
        cleanDeps.join(' '),
        (chunk.calls || []).join(' '),
        (chunk.params || []).join(' '),
        chunk.return_type || '',
        chunk.class_context ? `${chunk.class_context}.${chunk.name}` : '',
        (chunk.type_refs || []).join(' '),
        conceptTokens,  // domain concept keywords from LLM enrichment (opt-in)
        chunk.code_snippet,
    ].join(' ');
}

// ─── BM25 (tuned for code) ─────────────────────────────────────────────────────
// b lowered from 0.75 → 0.3: code chunks have purposeful length variation unlike
// prose, so heavy length normalisation wrongly penalises long implementations vs
// short export stubs.
export const BM25_K1 = 1.5;
export const BM25_B  = 0.3;

/** Okapi IDF — always positive, avoids negative IDF for very common terms. */
export function okapiIdf(docCount, docFreq) {
    return Math.log((docCount - docFreq + 0.5) / (docFreq + 0.5) + 1);
}

/** BM25 term contribution: diminishing TF returns + document-length normalisation. */
export function bm25Score(idf, tf, docLen, avgdl, k1 = BM25_K1, b = BM25_B) {
    return idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgdl));
}

// ─── Hybrid fusion (RRF + boost ladder) ────────────────────────────────────────

// Lexical candidates handed to fusion — shared by BOTH backends. An asymmetric
// cap would let deep-ranked chunks earn RRF contributions on one backend only,
// silently breaking rank parity.
export const LEXICAL_FUSION_CAP = 2000;

// Unique vector candidates handed to fusion (after summary-vector dedupe).
export const VECTOR_FUSION_CAP = 200;
// Raw bin entries to collect before dedupe: each chunk owns at most TWO entries
// (code vector + summary vector), so 2× the cap guarantees the full unique set.
export const VECTOR_SCAN_RAW_N = VECTOR_FUSION_CAP * 2;

/**
 * Normalize a store's raw vector hits into the fusion-ready candidate list:
 * best score per chunk id, deterministic (score desc, id asc) order, capped.
 * EVERY backend path (eager matrix, streaming scan, binary sketch) must funnel
 * through this so the vector channel is rank-identical across stores — dedupe
 * scope and tie order were measured to silently diverge otherwise.
 *
 * @param {Array<{id:string, score:number}>} entries  May contain duplicate ids.
 * @returns {Array<{id:string, score:number, rank:number}>}
 */
export function finalizeVectorCandidates(entries, cap = VECTOR_FUSION_CAP) {
    const best = new Map();
    for (const e of entries) {
        const prev = best.get(e.id);
        if (prev === undefined || e.score > prev) best.set(e.id, e.score);
    }
    return Array.from(best.entries())
        .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
        .slice(0, cap)
        .map(([id, score], i) => ({ id, score, rank: i + 1 }));
}

const LEXICAL_WEIGHT = 1.5;
const VECTOR_WEIGHT  = 1.0;

// Natural-language queries flip the channel weights: behavioural descriptions
// ("how does the app parse incoming JSON payloads?") carry their signal in the
// embedding, while their common English words only add BM25 noise.
const NL_LEXICAL_WEIGHT = 1.0;
const NL_VECTOR_WEIGHT  = 1.6;

// Exact-name boost on NL queries. A behavioural description naming a generic
// English word that happens to be a symbol ("string data" → Go's String(),
// "route definitions" → Routes()) is weak evidence compared to a symbol lookup,
// so NL queries get a reduced multiplier. Measured (hybrid strict): 1.4 lifts
// semantic rank-1 0.23→0.26 and s@5 0.55→0.61 with symbolic unchanged; 1.2 and
// 1.6 are both worse, and removing the boost entirely drops semantic to 0.16.
const NL_NAME_BOOST = 1.4;

const QUERY_STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'at',
    'by', 'from', 'that', 'this', 'is', 'are', 'was', 'were', 'be', 'how', 'what',
    'when', 'where', 'which', 'who', 'why', 'does', 'do', 'it', 'its', 'into',
    'back', 'if', 'then', 'their', 'there', 'all', 'any',
]);

/**
 * Heuristic: is this an agent-style natural-language query (a behavioural
 * description / question) rather than a keyword or symbol lookup? NL queries are
 * long and contain English function words; symbol queries ("ShouldBindJSON bind
 * request body") contain none.
 */
export function isNaturalLanguageQuery(queryText) {
    const words = String(queryText).toLowerCase().split(/[\s\W_]+/).filter(Boolean);
    if (words.length < 5) return false;
    const stops = words.filter(w => QUERY_STOPWORDS.has(w)).length;
    return stops >= 2 && stops / words.length >= 0.2;
}

export const TEST_FILE_RE = /\.(test|spec)\.|[/\\]__tests__[/\\]|_test\.|^tests?[/\\]|[/\\]tests?[/\\]|[/\\]spec[/\\]/;
// `^integration/` is root-anchored ONLY: a repo-root integration/ tree is an e2e
// test-app convention (NestJS), while nested src/integrations/ is real code.
export const EXAMPLE_DIR_RE = /^examples?[/\\]|[/\\]examples?[/\\]|^samples?[/\\]|[/\\]samples?[/\\]|^demos?[/\\]|[/\\]demos?[/\\]|[/\\]tutorials?[/\\]|^docs_src[/\\]|[/\\]docs_src[/\\]|^sandbox[/\\]|[/\\]sandbox[/\\]|^benchmarks?[/\\]|[/\\]benchmarks?[/\\]|^scripts?[/\\]|[/\\]scripts?[/\\]/;

/**
 * Reciprocal-Rank-Fusion of lexical + vector candidate lists, with the measured
 * boost ladder (test/example demotion, expression demotion, TS barrel demotion,
 * file-path boost, exact/snake name boost, optional exact-symbol boost).
 *
 * All backend-specific data is reached through accessors so the identical math
 * serves both the in-memory Maps and SQLite row lookups.
 *
 * @param {object}   p
 * @param {Array<{id:string,rank:number}>} p.lexicalResults
 * @param {Array<{id:string,rank:number}>} p.vectorResults
 * @param {(id:string)=>object|undefined}  p.getChunk
 * @param {(id:string)=>Set<string>|undefined} p.getPathTokens
 * @param {(token:string)=>number}          p.getDf       Document frequency of a token.
 * @param {number}   p.docCount
 * @param {number}   p.rrfK
 * @param {number}   p.topK
 * @param {string}   p.queryText
 * @param {string|null} [p.exactBoostName]
 * @param {(termLower:string)=>Iterable<string>} [p.resolveExact] Ids whose name === term.
 * @returns {Array<{score:number, chunk:object}>}
 */
export function fuseAndRank({
    lexicalResults, vectorResults, getChunk, getPathTokens, getDf,
    docCount, rrfK, topK, queryText, exactBoostName = null, resolveExact = null,
}) {
    const rrfScores  = new Map();
    const K          = rrfK;
    const queryLower = queryText.toLowerCase();

    const _queryPathTokens = queryLower.split(/[\s\W_]+/).filter(t => t.length >= 3);

    // Name-boost eligibility: long tokens, or short-but-discriminative ones whose
    // document frequency is ≤15% of the corpus (self-tunes per repo/language,
    // surfacing exact matches on short API names without re-introducing stopwords).
    const _docN = docCount || 1;
    const _queryNameTokens = queryLower.split(/[\s\W_]+/).filter(t =>
        t.length >= 5 || (t.length >= 3 && (getDf(t) || 0) <= 0.15 * _docN)
    );

    // Query-adaptive channel weights: lexical-led for keyword/symbol lookups,
    // vector-led for natural-language behavioural queries (only when a vector
    // channel actually produced candidates — lexical-only mode is unaffected).
    const nlQuery = vectorResults.length > 0 && isNaturalLanguageQuery(queryText);
    const wLex = nlQuery ? NL_LEXICAL_WEIGHT : LEXICAL_WEIGHT;
    const wVec = nlQuery ? NL_VECTOR_WEIGHT  : VECTOR_WEIGHT;

    // Re-rank the vector channel with test/example demotion applied to the cosine
    // scores BEFORE ranks are assigned: a test helper that out-scores the real
    // implementation in raw cosine otherwise occupies the top RRF positions and
    // pushes the right answer's reciprocal rank down, even though the boost
    // ladder demotes the helper later.
    if (vectorResults.length > 0) {
        const adjusted = vectorResults.map(r => {
            const c = getChunk(r.id);
            let f = 1;
            if (c) {
                if (TEST_FILE_RE.test(c.file_path) && !queryLower.includes('test') && !queryLower.includes('spec')) f = 0.25;
                else if (EXAMPLE_DIR_RE.test(c.file_path)) f = 0.5;
            }
            return { id: r.id, score: (r.score ?? 0) * f };
        });
        adjusted.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
        vectorResults = adjusted.map((r, i) => ({ ...r, rank: i + 1 }));
    }

    // On NL queries the name/path boosts misfire: identifiers that happen to share
    // a generic English word with the query ("_global" for "global configuration")
    // get 1.4–2.0× promotions over the semantically right answer. Gate the boosts
    // on semantic agreement — a chunk must also be a vector candidate to earn them.
    const boostEligible = nlQuery ? new Set(vectorResults.map(r => r.id)) : null;

    const allResults = [
        ...vectorResults.map(r => ({ ...r, _w: wVec })),
        ...lexicalResults.map(r => ({ ...r, _w: wLex })),
    ];

    for (const { id, rank, _w } of allResults) {
        let baseScore = (_w ?? 1.0) / (K + rank);
        const chunk = getChunk(id);
        if (!chunk) continue;

        // Demotion: test / spec files (unless the query is itself about tests).
        if (TEST_FILE_RE.test(chunk.file_path)) {
            if (!queryLower.includes('test') && !queryLower.includes('spec')) baseScore *= 0.25;
        }
        // Demotion: example / docs dirs (tutorial snippets over-rank on short length
        // + high keyword density vs the real implementation).
        if (EXAMPLE_DIR_RE.test(chunk.file_path)) baseScore *= 0.5;
        // Demotion: pure expression sites.
        if (chunk.node_type === 'expression_statement' || chunk.node_type === 'call_expression') {
            baseScore *= 0.8;
        }
        // Demotion: TypeScript barrel re-exports (`export { X } from 'y'`) — no
        // implementation. JS exports are excluded since those often ARE the module.
        if (chunk.name && chunk.name.endsWith('_export_statement') && chunk.file_path?.endsWith('.ts')) {
            baseScore *= 0.7;
        }
        // Demotion: Python public re-exports (`from x import Y as Y`) — but only
        // when a REAL definition of the same name exists in the index. When the
        // re-export is the only in-repo occurrence (the implementation lives in a
        // dependency, e.g. fastapi re-exporting starlette's BackgroundTasks), the
        // alias IS the best available answer and must not be demoted.
        if (chunk.node_type === 're_export' && resolveExact && chunk.name) {
            for (const rid of resolveExact(String(chunk.name).toLowerCase())) {
                const rc = getChunk(rid);
                if (rc && rc.node_type !== 're_export') { baseScore *= 0.7; break; }
            }
        }

        // File-path boost via the separate path-token set (not the BM25 index), so
        // length normalisation never penalises long implementations sharing a path.
        const canBoost = !boostEligible || boostEligible.has(id);
        if (canBoost && _queryPathTokens.length > 0) {
            const pathToks = getPathTokens(id);
            if (pathToks) {
                const hasExact = _queryPathTokens.some(t => pathToks.has(t));
                const hasPrefix = !hasExact && _queryPathTokens.some(t =>
                    t.length >= 4 && Array.from(pathToks).some(pt => pt.startsWith(t.slice(0, 5)))
                );
                if (hasExact)       baseScore *= 1.4;
                else if (hasPrefix) baseScore *= 1.2;
            }
        }

        // Name boost: 2.0× exact (token IS the name), 1.4× snake_case suffix match.
        // Only [._] splitting keeps camelCase names atomic (no generic-suffix bleed).
        // Plural equivalence (`BackgroundTask` ↔ `BackgroundTasks`) is included —
        // API names pluralize and a strict equality check missed them.
        if (canBoost && chunk.name && chunk.name !== 'anonymous') {
            const nameLower      = chunk.name.toLowerCase();
            const lastDotted     = nameLower.split('.').pop() ?? nameLower;
            const queryTokensAll = _queryNameTokens;
            const eq = (a, b) => a === b || a === b + 's' || b === a + 's';
            if (queryTokensAll.some(t => eq(nameLower, t) || eq(lastDotted, t))) {
                // NOTE: a PageRank multiplier was trialled here (tie-break duplicate
                // names toward central files) and measured NEGATIVE — hub files win
                // exact-name matches on common words and the semantic channel drops.
                baseScore *= nlQuery ? NL_NAME_BOOST : 2.0;
            } else {
                const snakeParts = nameLower.split(/[._]+/);
                const lastSnake  = snakeParts[snakeParts.length - 1] ?? '';
                if (snakeParts.length >= 2 && lastSnake.length >= 3 && queryTokensAll.includes(lastSnake)) {
                    baseScore *= 1.4;
                }
            }
        }

        rrfScores.set(id, (rrfScores.get(id) || 0) + baseScore);
    }

    // Optional guaranteed boost for an exactly-named symbol (search_code exact_tokens).
    if (exactBoostName && resolveExact) {
        const boostTerm = String(exactBoostName).toLowerCase().trim();
        for (const id of resolveExact(boostTerm)) {
            rrfScores.set(id, (rrfScores.get(id) || 0) + 1 / (K + 1));
        }
    }

    // Deterministic tie-break on id: equal fused scores must order identically
    // on every backend (Map iteration vs SQL row order would otherwise differ).
    return Array.from(rrfScores.entries())
        .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
        .slice(0, topK)
        .map(([id, rrfScore]) => ({ score: rrfScore, chunk: getChunk(id) }))
        .filter(r => r.chunk !== undefined);
}

// ─── Graph centrality ──────────────────────────────────────────────────────────

/**
 * Simplified PageRank over the file dependency graph. Files imported by many
 * others receive higher rank (= more important). Used by get_repo_map ordering
 * and by LLM enrichment to pick the "core" files worth summarising.
 *
 * @param {{dependencies:Object<string,string[]>}} graph
 * @returns {Map<string, number>} file → rank
 */
export function computePageRank(graph, iters = 30, damping = 0.85) {
    const files = Object.keys(graph?.dependencies || {});
    const N = files.length;
    if (N === 0) return new Map();

    const idx = new Map(files.map((f, i) => [f, i]));
    const ranks = new Float64Array(N).fill(1.0 / N);
    const outDeg = files.map(f => Math.max((graph.dependencies[f] || []).length, 1));

    for (let iter = 0; iter < iters; iter++) {
        const next = new Float64Array(N).fill((1 - damping) / N);
        for (let i = 0; i < N; i++) {
            const contrib = damping * ranks[i] / outDeg[i];
            for (const dep of (graph.dependencies[files[i]] || [])) {
                const j = idx.get(dep);
                if (j !== undefined) next[j] += contrib;
            }
        }
        ranks.set(next);
    }
    return new Map(files.map((f, i) => [f, ranks[i]]));
}
