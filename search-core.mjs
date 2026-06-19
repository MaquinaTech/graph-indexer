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

// Max embedding-input length in chars. ~8000 chars ≈ the usable context of the
// default embedders (nomic-embed-text / MiniLM) once a query/document prefix is
// added; longer inputs are silently truncated by the backend, so this is also the
// per-window size for oversized definitions (see embeddingWindows).
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

// Window-and-pool sub-chunking for the dense channel. A large definition (e.g. a
// ~600-line free function) used to be embedded as a single vector over only its
// first EMBEDDING_CONTEXT_LIMIT chars — its tail was invisible to semantic search
// (BM25 still indexed the whole text, so this gap is dense-only). Instead we embed
// a few overlapping windows and retrieve the chunk by the MAX cosine over its
// windows (max-sim), which preserves tail recall where mean-pooling would dilute it.
//
// 12% overlap: a definition that straddles a boundary still lands wholly inside an
// adjacent window (EMBEDDING_CONTEXT_LIMIT*0.12 ≈ 960 chars of shared context).
export const EMBEDDING_WINDOW_OVERLAP = 0.12;
// Hard cap on windows per chunk. Bounds embed cost and .bin growth at ~MAX× a
// single vector. 4 windows at the 7040-char stride cover ~29k chars (~700 lines);
// beyond that the god-class split already shards classes into method chunks, and a
// non-class definition that large is rare enough to accept head-only coverage.
export const EMBEDDING_MAX_WINDOWS = 4;
// Suffix for a chunk's window vectors past the first: <key>|w1, <key>|w2, … Window 0
// is the base key itself (identical to the single-vector path), so small chunks and
// the head of large chunks are byte-identical to before windowing existed.
export const WINDOW_VEC_SUFFIX = '|w';

const _VEC_SUFFIX_RE = /\|(?:s|w\d+)$/;
/** Strip a vector-key suffix (summary `|s` or window `|wN`) back to the base key, so
 *  every per-chunk vector folds onto one fusion candidate. Both backends use this. */
export function baseEmbeddingKey(key) {
    return key.replace(_VEC_SUFFIX_RE, '');
}

/**
 * Split an oversized embedding payload into overlapping windows of
 * ≤EMBEDDING_CONTEXT_LIMIT chars, capped at EMBEDDING_MAX_WINDOWS. Returns [] when
 * the payload fits in a single window (the default path — the caller embeds it under
 * the base key unchanged). Window 0 is the same first-EMBEDDING_CONTEXT_LIMIT slice
 * the single-vector path produced, so the base vector is unchanged; windows 1..N
 * cover the tail and are stored under WINDOW_VEC_SUFFIX keys.
 *
 * @param {string} payload
 * @returns {string[]}  [] or [window0, window1, …] (length ≥ 2 when it splits).
 */
export function embeddingWindows(payload) {
    if (!payload || payload.length <= EMBEDDING_CONTEXT_LIMIT) return [];
    const stride = Math.max(1, Math.round(EMBEDDING_CONTEXT_LIMIT * (1 - EMBEDDING_WINDOW_OVERLAP)));
    const windows = [];
    for (let i = 0; i < EMBEDDING_MAX_WINDOWS; i++) {
        const start = i * stride;
        if (start >= payload.length) break;
        windows.push(payload.slice(start, start + EMBEDDING_CONTEXT_LIMIT));
        if (start + EMBEDDING_CONTEXT_LIMIT >= payload.length) break; // tail covered
    }
    return windows;
}

export function cosineSimilarity(vecA, vecB) {
    let dot = 0, nA = 0, nB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        nA += vecA[i] * vecA[i];
        nB += vecB[i] * vecB[i];
    }
    return nA === 0 || nB === 0 ? 0 : dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

// ─── Light Porter stemmer (additive recall bridge) ─────────────────────────────
// Collapses English morphological variants to a shared root so behavioural queries
// reach code identifiers across the inflection gap that lexical match otherwise
// misses: "intercepting"↔"Interceptor", "injection"↔"Injectable",
// "bootstrapping"↔"bootstrap", "managing"↔"Manager". Classic Porter (1980) steps
// 1–5 plus an agent-noun "-or" rule for code (Interceptor→intercept,
// Constructor→construct). Used ADDITIVELY in tokenize(): the raw token is always
// emitted and the stem only when it differs — so exact matches, df statistics and
// the name/path boosts are byte-for-byte unchanged; only recall is added.
// Deterministic and pure → both backends produce identical postings (parity-safe).
const _isVowel = (s, i) => {
    const c = s.charCodeAt(i);
    // a e i o u
    if (c === 97 || c === 101 || c === 105 || c === 111 || c === 117) return true;
    if (s[i] === 'y') return i === 0 ? true : !_isVowel(s, i - 1);
    return false;
};
const _measure = (s) => {
    let n = 0, prevV = false;
    for (let i = 0; i < s.length; i++) { const v = _isVowel(s, i); if (prevV && !v) n++; prevV = v; }
    return n;
};
const _hasVowel = (s) => { for (let i = 0; i < s.length; i++) if (_isVowel(s, i)) return true; return false; };
const _endsDoubleCons = (s) => s.length >= 2 && s[s.length - 1] === s[s.length - 2] && !_isVowel(s, s.length - 1);
const _cvc = (s) => {
    const n = s.length; if (n < 3) return false;
    if (_isVowel(s, n - 1) || !_isVowel(s, n - 2) || _isVowel(s, n - 3)) return false;
    const c = s[n - 1]; return c !== 'w' && c !== 'x' && c !== 'y';
};
const _STEP2 = [['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'], ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'], ['logi', 'log']];
const _STEP3 = [['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', '']];
// Longest-first; 'or' added to Porter's set so agent nouns reduce like '-er'.
const _STEP4 = ['ement', 'ance', 'ence', 'able', 'ible', 'ment', 'ant', 'ent', 'ion', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize', 'al', 'er', 'or', 'ic', 'ou'];

/** Porter stem of a single lowercase word. Returns the input unchanged for short
 *  tokens (≤3 chars: acronyms, short API names) so precise symbols never blur. */
export function stemToken(word) {
    let w = word;
    if (w.length <= 3) return w;

    // Step 1a — plurals
    if (w.endsWith('sses')) w = w.slice(0, -2);
    else if (w.endsWith('ies')) w = w.slice(0, -2);
    else if (!w.endsWith('ss') && w.endsWith('s')) w = w.slice(0, -1);

    // Step 1b — -eed / -ed / -ing (with the classic clean-up)
    let fix = false;
    if (w.endsWith('eed')) { if (_measure(w.slice(0, -3)) > 0) w = w.slice(0, -1); }
    else if (w.endsWith('ed') && _hasVowel(w.slice(0, -2))) { w = w.slice(0, -2); fix = true; }
    else if (w.endsWith('ing') && _hasVowel(w.slice(0, -3))) { w = w.slice(0, -3); fix = true; }
    if (fix) {
        if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) w += 'e';
        else if (_endsDoubleCons(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
        else if (_measure(w) === 1 && _cvc(w)) w += 'e';
    }

    // Step 1c — terminal y → i when a vowel precedes
    if (w.length > 2 && w.endsWith('y') && _hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + 'i';

    // Step 2 & 3 — derivational suffixes (only when the stem has measure > 0)
    for (const [suf, rep] of _STEP2) { if (w.endsWith(suf)) { const st = w.slice(0, -suf.length); if (_measure(st) > 0) w = st + rep; break; } }
    for (const [suf, rep] of _STEP3) { if (w.endsWith(suf)) { const st = w.slice(0, -suf.length); if (_measure(st) > 0) w = st + rep; break; } }

    // Step 4 — strip the suffix entirely on multi-syllable stems
    for (const suf of _STEP4) {
        if (w.endsWith(suf)) {
            const st = w.slice(0, -suf.length);
            if (suf === 'ion') { if (_measure(st) > 1 && /[st]$/.test(st)) w = st; }
            else if (_measure(st) > 1) w = st;
            break;
        }
    }

    // Step 5 — final -e and double-l clean-up
    if (w.endsWith('e')) { const st = w.slice(0, -1); const m = _measure(st); if (m > 1 || (m === 1 && !_cvc(st))) w = st; }
    if (_measure(w) > 1 && w.endsWith('l') && _endsDoubleCons(w)) w = w.slice(0, -1);

    return w;
}

/**
 * Tokenise code/identifiers: lowercase words plus camelCase sub-parts, so
 * `dispatchRequest` indexes as `dispatchrequest`, `dispatch`, `request`. Each
 * emitted token also contributes its Porter stem (when different) so behavioural
 * queries bridge the inflection gap to code names — see stemToken. Additive: the
 * raw token is never dropped, so exact match and the boost ladder are unaffected.
 */
// Stem postings live in a separate term namespace (sentinel-prefixed) so a raw
// query token can NEVER match a stem posting: symbolic/exact lookups stay precisely
// what they were before stemming existed, and only a query that opts in (emits the
// prefixed stem) reaches the morphological bridges. Index always emits both; the
// query emits the prefixed stem only for natural-language queries.
export const STEM_PREFIX = '~stem~'; // sentinel namespace: raw tokens are [A-Za-z0-9]+, so '~' can never collide

export function tokenize(text, stem = true) {
    if (!text) return [];
    const rawTokens = text.split(/[\s\W_]+/);
    const tokens = [];
    const emit = (t) => {
        const lo = t.toLowerCase();
        tokens.push(lo);
        if (!stem) return;
        const s = stemToken(lo);
        if (s !== lo && s.length >= 3) tokens.push(STEM_PREFIX + s);
    };
    for (const word of rawTokens) {
        if (word.length < 2) continue;
        emit(word);
        const camelParts = word.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
        if (camelParts.length > 1) {
            for (const part of camelParts) {
                if (part.length >= 2) emit(part);
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

/** The text embedded as the summary-only vector, or null when not enriched.
 * The leading LLM summary carries the behavioural signal; the concept tags add
 * domain vocabulary; the qualified name (class_context.name when present) anchors
 * the vector to the symbol so a method is disambiguated from same-named peers. */
export function summaryEmbeddingText(chunk) {
    if (!chunk.summary && !(chunk.concepts?.length > 0)) return null;
    const qualifiedName = chunk.class_context ? `${chunk.class_context}.${chunk.name}` : chunk.name;
    return [chunk.summary, (chunk.concepts || []).join(', '), qualifiedName]
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
export const BM25_B = 0.3;

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

// Non-natural-language channel weights (keyword / symbol-lookup queries). The
// vector weight was lowered 1.0 → 0.7 after the 15-fixture search-eval was fixed
// to actually exercise embeddings (its "semantic" pass had been silently lexical,
// because the test bridge forced embeddings off — so the prior 1.0 was tuned
// against a vector-less harness). With honest measurement, a full-strength vector
// channel slightly OVER-contributes on keyword queries (BM25's home turf): it
// displaces a confident exact-name lexical rank-1 with a same-prefixed sibling
// (`Map`→`key`, `GardenPlantingRepository`→`…Dao`). 0.7 is the top of the winning
// plateau — it restores those rank-1s (broad kw MRR 0.569 → 0.588, +1 hit@1) while
// keeping the vector channel's recall lift, and leaves the 5-suite repo-eval
// byte-identical (symbolic 0.78/0.83). Below 0.7 the repo-eval symbolic starts to
// erode; the NL path keeps its own (higher) vector weight below.
const LEXICAL_WEIGHT = 1.5;
const VECTOR_WEIGHT = 0.7;

// Natural-language queries keep the lexical channel at full strength (exact-name and
// keyword matches are the most reliable signal); the vector channel's weight depends on
// whether the corpus carries LLM enrichment:
//
//   • PLAIN corpus (no enrichment) — the only vectors are raw-code embeddings, a weak
//     conceptual signal that DISPLACES correct lexical hits at any real weight. It acts
//     as a low-weight rescue (0.4). This was the historical "joint optimum" finding.
//   • ENRICHED corpus — every central chunk also owns a summary vector that speaks the
//     vocabulary of behavioural queries, so the vector channel becomes a strong semantic
//     signal and earns more weight. The value is the JOINT optimum of two independent
//     suites that DISAGREE: the repo-eval behavioural channel keeps climbing to ~1.0,
//     while the broader 15-fixture search-eval (mixed nl/kw/xc) peaks at 0.4 and decays
//     above it (a high weight lets a confident-but-wrong summary vector displace a good
//     lexical hit on cross-cutting queries). 0.6 improves BOTH over baseline and avoids
//     overfitting either; the opt-in LLM reranker recovers the top-rank precision that a
//     lower weight gives up. (Plain stays 0.4 — raw-code vectors are a weak rescue.)
//
// The engine selects the regime per index via `corpusEnriched` (see core-engine /
// sqlite-store), so a repo indexed without --enrich is never hurt by the strong weight.
const NL_LEXICAL_WEIGHT = 1.5;
const NL_VECTOR_WEIGHT_PLAIN = 0.4;
const NL_VECTOR_WEIGHT_ENRICHED = 0.6;

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

export const TEST_FILE_RE = /\.(test|spec)\.|[/\\]__tests__[/\\]|_test\.|^tests?[/\\]|[/\\]tests?[/\\]|[/\\]spec[/\\]/i;
// Example/sample/demo/sandbox/etc. trees are a top-level project convention
// (examples/, samples/, demo/, docs_src/, …). The keyword is matched ONLY as the
// FIRST or SECOND path segment. Matching it at ANY depth (the previous behaviour)
// false-positived on PACKAGE PATHS that merely contain the word — e.g. Spring's
// `src/main/java/org/springframework/samples/petclinic/…` and Google's
// `com/google/samples/apps/…` — silently excluding real application code from LLM
// enrichment and demoting it in search. The fixtures' legitimate example/sample
// dirs all sit at depth ≤1, so this only stops the deep package-path false hits.
export const EXAMPLE_DIR_RE = /^(?:[^/\\]+[/\\])?(?:examples?|samples?|demos?|tutorials?|docs_src|sandbox|benchmarks?|scripts?)[/\\]/;

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
    corpusEnriched = false,
}) {
    const rrfScores = new Map();
    const K = rrfK;
    const queryLower = queryText.toLowerCase();

    const _queryPathTokens = queryLower.split(/[\s\W_]+/).filter(t => t.length >= 3);

    // File-path boost discriminativeness gate (natural-language queries only).
    // The file-path boost (further down) fires when a query token matches a
    // filename segment — but a common low-IDF word ("path", "url", "config",
    // "index") that merely appears in a filename then over-promotes EVERY chunk in
    // that file (an NL query mentioning "path" boosts all of path.go, burying the
    // real answer that lives elsewhere). Restrict the boost to query terms
    // discriminative enough to be a genuine filename signal: IDF ≥ ln(docCount/2),
    // a per-corpus structural threshold (not tuned to any query). Symbolic/keyword
    // queries are excluded by the NL gate and keep the original token set
    // byte-for-byte. Measured: lifts agent-style recall@5 (overall s@5 0.77→0.81;
    // tuning-semantic s@5 0.52→0.61) with symbolic rankings unchanged, no regression.
    const _pathBoostIsNL = isNaturalLanguageQuery(queryText);
    const _pathBoostMinIdf = Math.log(Math.max(docCount, 2) / 2);
    const _queryPathTokensBoost = _pathBoostIsNL
        ? _queryPathTokens.filter(t => okapiIdf(docCount, getDf(t)) >= _pathBoostMinIdf)
        : _queryPathTokens;

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
    const nlVecWeight = corpusEnriched ? NL_VECTOR_WEIGHT_ENRICHED : NL_VECTOR_WEIGHT_PLAIN;
    const wLex = nlQuery ? NL_LEXICAL_WEIGHT : LEXICAL_WEIGHT;
    const wVec = nlQuery ? nlVecWeight : VECTOR_WEIGHT;

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

    // Boosts are NOT gated on vector-candidate membership. Gating was intended to
    // stop generic-word name collisions on NL queries, but because the code-embedding
    // channel is weak it mostly suppressed the EXACT-name boost on the correct hit
    // (which then sank below a noisy vector candidate). Removing the gate measured
    // strictly better on both retrieval suites; the exact-name boost is the single
    // most reliable signal and must always apply.
    const boostEligible = null;

    // Style-intent detection: a stylesheet bundle vendored into a source tree
    // (e.g. a bundled bootstrap.css) produces hundreds of synthetic-named
    // `*_rule_set` chunks that pollute CODE searches in mixed repos. Demote those
    // synthetic rule_sets UNLESS the query is actually about styling (a selector
    // char, an exact_tokens pin, or a style keyword). Named SCSS @mixin/@function
    // chunks are unaffected — only nameless rule_sets are noise for code queries.
    const queryIsStyle = exactBoostName != null ||
        /[.#]|css|scss|stylesheet|selector|\bstyle\b|\bclass\b|color|margin|padding|font|border|background|hover|keyframe|animation|mixin|breakpoint|responsive|\bwidth\b|\bheight\b/.test(queryLower);

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
        // Demotion: synthetic-named stylesheet rule_sets on non-style queries
        // (vendored CSS bundle noise in mixed repos). Named mixins/functions exempt.
        if (!queryIsStyle && chunk.name && chunk.name.endsWith('_rule_set')) baseScore *= 0.2;
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
        if (canBoost && _queryPathTokensBoost.length > 0) {
            const pathToks = getPathTokens(id);
            if (pathToks) {
                const hasExact = _queryPathTokensBoost.some(t => pathToks.has(t));
                const hasPrefix = !hasExact && _queryPathTokensBoost.some(t =>
                    t.length >= 4 && Array.from(pathToks).some(pt => pt.startsWith(t.slice(0, 5)))
                );
                if (hasExact) baseScore *= 1.4;
                else if (hasPrefix) baseScore *= 1.2;
            }
        }

        // Name boost: 2.0× exact (token IS the name), 1.4× snake_case suffix match.
        // Only [._] splitting keeps camelCase names atomic (no generic-suffix bleed).
        // Plural equivalence (`BackgroundTask` ↔ `BackgroundTasks`) is included —
        // API names pluralize and a strict equality check missed them.
        if (canBoost && chunk.name && chunk.name !== 'anonymous') {
            const nameLower = chunk.name.toLowerCase();
            const lastDotted = nameLower.split('.').pop() ?? nameLower;
            const queryTokensAll = _queryNameTokens;
            const eq = (a, b) => a === b || a === b + 's' || b === a + 's';
            if (queryTokensAll.some(t => eq(nameLower, t) || eq(lastDotted, t))) {
                // NOTE: a PageRank multiplier was trialled here (tie-break duplicate
                // names toward central files) and measured NEGATIVE — hub files win
                // exact-name matches on common words and the semantic channel drops.
                baseScore *= 2.0;
            } else {
                const snakeParts = nameLower.split(/[._]+/);
                const lastSnake = snakeParts[snakeParts.length - 1] ?? '';
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
