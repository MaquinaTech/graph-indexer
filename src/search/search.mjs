/**
 * Hybrid symbol search.
 *
 *   1. name channel     exact / case-insensitive / qualified / prefix matches on symbol names
 *   2. lexical channel  FTS5 BM25 over fields (name, qualified name, signature, doc, path, body)
 *   3. concept channel  the same index queried with thesaurus expansions (natural-language queries)
 *   4. semantic channel (optional) cosine similarity of a static code-embedding model (vectors.mjs),
 *                       on when its model is installed
 *   5. rerank           a small linear model over interpretable features (name evidence, field
 *                       coverage, kind/test/export priors, graph centrality), then per-file
 *                       diversification so one file cannot flood the top results.
 */
import { analyzeQuery, codeTokens, splitIdentifier } from './tokenize.mjs';
import { VectorIndex } from './vectors.mjs';

const FTS_WEIGHTS = [10.0, 6.0, 3.0, 2.0, 2.5, 1.0]; // name, qname, sig, doc, path, body
const KIND_PRIOR = {
    class: 1.0, interface: 0.95, struct: 1.0, trait: 0.95, enum: 0.85, type: 0.8, object: 0.95, module: 0.7, impl: 0.7,
    function: 1.0, method: 1.0, constructor: 0.75, macro: 0.8, field: 0.55, property: 0.6, variable: 0.55, constant: 0.6,
    selector: 0.35, keyframes: 0.3, section: 0.5,
};

export const DEFAULT_WEIGHTS = {
    // Tuned by coordinate ascent on the TUNING split of bench/suites (bench/tune-weights.mjs);
    // the held-out split is reported, never used for selection.
    bm25: 2.66,         // normalized lexical score
    concept: 0.056,     // normalized concept-expansion score
    exact: 1.6,         // query identifier == symbol name (case-sensitive)
    exactCI: 0.8,       // case-insensitive (×0.75 for singular/plural)
    qualified: 1.8,     // query `A.b` matches qualified name suffix
    prefix: 0.27,       // symbol name starts with the query identifier
    nameCover: 0.45,    // fraction of symbol-name words present in the query
    queryCover: 0.8,    // fraction of query terms present in name/qname
    kind: 0.35,         // kind prior
    test: -1.6,         // test file (unless the query is about tests)
    exported: 0.06,
    doc: 0.033,
    central: 0.25,      // graph centrality (PageRank percentile)
    nested: -0.3,       // local/nested function inside another function
    declaration: -1.4,  // .d.ts declarations (implementations are what agents want)
    example: -1.2,      // examples/, samples/, sandbox/, docs/, benchmarks/ trees
    nlField: -0.93,     // fields/properties/variables for natural-language (behavioural) queries
    file: 1.0,          // file-level BM25 of the symbol's file (hierarchical: file relevance first)
    fileNL: 0.5,        // extra file-level weight for natural-language (behavioural) queries
    docs: 2.0,          // documentation channel BM25 (only for queries about docs, design or rationale)
    // semantic channel (opt-in): cosine, min-max normalised over its top candidates. Higher weights
    // (0.5 / 2.0) score better on symbol search and worse on localizing real commits; these are
    // the highest that leave localization within noise (docs/BENCHMARKS.md)
    sem: 0.25,
    semNL: 0.5,         // extra semantic weight for natural-language queries
};

const EXAMPLE_PATH = /(^|\/)(examples?|samples?|demos?|sandbox|playground|docs?(_src|_source|_examples?)?|documentation|benchmarks?|bench|scripts?|fixtures?|testdata|tutorials?|website|\.github)\//i;
const DECLARATION_PATH = /\.d\.[cm]?ts$/;
export const WANTS_DOCS = /\b(docs?|documentation|documented|readme|guide|tutorial|design|rationale|architecture|adr|why|explained?|explanation|changelog|faq|how to)\b/i;
const BM25_FLOOR = 1.0;
const SEM_K = 200; // semantic candidates per query
const RRF_K = 60;
export const MAX_QUERIES = 6;
const FILE_GATE = 0.25; // own normalized BM25 at which the file boost applies in full (tuning split)

function stem(w) {
    // light stemmer for coverage features (FTS5 does the real stemming for retrieval)
    return w.replace(/(ies)$/, 'y').replace(/(sses|ches|shes|xes)$/, (m) => m.slice(0, -2)).replace(/([^s])s$/, '$1')
        .replace(/(ing|ed|er|or|ion|ions|ation|ations)$/, '').replace(/e$/, '');
}

function ftsQuery(terms) {
    const uniq = [...new Set(terms.filter(t => /^[a-z0-9]+$/i.test(t)))].slice(0, 32);
    return uniq.length ? uniq.map(t => `"${t}"`).join(' OR ') : null;
}

export class SearchEngine {
    constructor(indexer, { weights = DEFAULT_WEIGHTS, centrality = null, perFileCap = Number(process.env.GI_PER_FILE_CAP) || 3, semantic = undefined } = {}) {
        this.semantic = semantic === undefined ? VectorIndex.maybe(indexer) : semantic;
        this.perFileCap = perFileCap;
        this.ix = indexer;
        this.store = indexer.store;
        this.w = weights;
        this.centrality = centrality; // () => Map(id -> percentile 0..1)
    }

    /**
     * @param {string} query
     * @param {{ limit?: number, path?: string, kinds?: string[], includeTests?: boolean, lang?: string }} opts
     * @returns {{ results: Array<{ id:number, score:number, reasons:string[] }>, analysis: object }}
     */
    search(query, opts = {}) {
        const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
        const a = analyzeQuery(query);
        const pathFilter = opts.path ?? a.filters.path?.[0] ?? null;
        const kindFilter = opts.kinds ?? a.filters.kind ?? null;
        const langFilter = opts.lang ?? a.filters.lang?.[0] ?? null;
        const wantsTests = opts.includeTests ?? /\b(test|tests|spec|specs|mock|fixture)\b/i.test(query);
        const wantsDocs = WANTS_DOCS.test(query);
        const cands = new Map(); // id -> feature bag
        const bag = (id) => { let f = cands.get(id); if (!f) cands.set(id, (f = { id })); return f; };

        // 1. name channel
        const idents = new Set(a.identifiers);
        for (const id of idents) {
            const qualified = /[.#:]|->/.test(id);
            if (qualified) {
                const parts = id.split(/::|\.|#|->/).filter(Boolean);
                const name = parts[parts.length - 1];
                const suffix = parts.join('.');
                for (const r of this.store.all('SELECT id, qname FROM symbols WHERE name = ? LIMIT 200', name)) {
                    if (r.qname === suffix || r.qname.endsWith('.' + suffix)) bag(r.id).qualified = 1;
                    else bag(r.id).exact = Math.max(bag(r.id).exact ?? 0, 0.5);
                }
                continue;
            }
            const lc = id.toLowerCase();
            const variants = [lc, lc.endsWith('s') ? lc.slice(0, -1) : lc + 's'];
            for (const r of this.store.all('SELECT id, name, name_lc FROM symbols WHERE name_lc IN (?, ?) LIMIT 300', variants[0], variants[1])) {
                const f = bag(r.id);
                if (r.name === id) f.exact = 1;
                else if (r.name_lc === lc) f.exactCI = 1;
                else f.exactCI = Math.max(f.exactCI ?? 0, 0.75); // singular/plural (BackgroundTask ↔ BackgroundTasks)
            }
            if (id.length >= 4) {
                for (const r of this.store.all("SELECT id FROM symbols WHERE name_lc >= ? AND name_lc < ? LIMIT 60", id.toLowerCase(), id.toLowerCase() + '￿')) {
                    const f = bag(r.id);
                    if (!f.exact && !f.exactCI) f.prefix = 1;
                }
            }
        }

        // 2. lexical channel
        const lexTerms = a.terms.length ? a.terms : codeTokens(query);
        const q1 = ftsQuery(lexTerms);
        let maxBm = 0;
        if (q1) {
            const rows = this.store.all(`SELECT rowid AS id, bm25(fts, ${FTS_WEIGHTS.join(', ')}) AS s FROM fts WHERE fts MATCH ? ORDER BY s LIMIT 400`, q1);
            for (const r of rows) { const v = -r.s; bag(r.id).bm25 = v; if (v > maxBm) maxBm = v; }
        }
        // 3. concept channel
        let maxCx = 0;
        const q2 = a.expansions.length ? ftsQuery(a.expansions) : null;
        if (q2) {
            const rows = this.store.all(`SELECT rowid AS id, bm25(fts, ${FTS_WEIGHTS.join(', ')}) AS s FROM fts WHERE fts MATCH ? ORDER BY s LIMIT 150`, q2);
            for (const r of rows) { const v = -r.s; bag(r.id).concept = v; if (v > maxCx) maxCx = v; }
        }
        // 4. file channel: files whose whole text matches the query best; their best-matching
        //    symbols become candidates even when long-body length normalisation buried them
        const fileScore = new Map();
        if (q1 && (this.w.file || this.w.fileNL)) {
            const frows = this.store.all('SELECT rowid AS fid, bm25(file_fts, 2.0, 1.0) AS s FROM file_fts WHERE file_fts MATCH ? ORDER BY s LIMIT 40', q1);
            const maxF = frows.length ? -frows[0].s : 0;
            for (const r of frows) fileScore.set(r.fid, -r.s / Math.max(maxF, BM25_FLOOR));
            const top = frows.slice(0, 8).map(r => r.fid);
            if (top.length) {
                const rows = this.store.all(`SELECT rowid AS id, bm25(fts, ${FTS_WEIGHTS.join(', ')}) AS s FROM fts WHERE fts MATCH ?
                    AND rowid IN (SELECT id FROM symbols WHERE file_id IN (${top.map(() => '?').join(',')})) ORDER BY s LIMIT 200`, q1, ...top);
                for (const r of rows) { const f = bag(r.id); if (f.bm25 == null) { f.bm25 = -r.s; if (-r.s > maxBm) maxBm = -r.s; } }
            }
        }
        // documentation channel: Markdown sections, only when the query is about docs, design or rationale
        let maxDoc = 0;
        if (q1 && (wantsDocs || opts.docs)) {
            for (const r of this.store.all('SELECT rowid AS id, bm25(doc_fts, 4.0, 1.0) AS s FROM doc_fts WHERE doc_fts MATCH ? ORDER BY s LIMIT 60', q1)) {
                bag(r.id).doc = -r.s; if (-r.s > maxDoc) maxDoc = -r.s;
            }
        }
        // semantic channel: definitions whose embedding is closest to the query's
        let semLo = 0, semHi = 0;
        if (this.semantic && (this.w.sem || this.w.semNL)) {
            const hits = this.semantic.search(query, SEM_K);
            if (hits.size) {
                const vals = [...hits.values()];
                semHi = Math.max(...vals); semLo = Math.min(...vals);
                for (const [id, c] of hits) bag(id).sem = c;
            }
        }
        if (!cands.size) return { results: [], analysis: a };

        // 4. features + rerank
        const ids = [...cands.keys()];
        const rows = new Map();
        for (let i = 0; i < ids.length; i += 500) {
            const chunk = ids.slice(i, i + 500);
            for (const r of this.store.all(`SELECT s.id, s.name, s.qname, s.kind, s.exported, s.doc IS NOT NULL AS has_doc, s.parent_id, s.file_id, f.path, f.lang, f.is_test,
                (SELECT kind FROM symbols p WHERE p.id = s.parent_id) AS parent_kind
                FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) rows.set(r.id, r);
        }
        const qStems = new Set(lexTerms.map(stem));
        const central = this.centrality?.() ?? null;
        const w = this.w;
        const scored = [];
        for (const f of cands.values()) {
            const r = rows.get(f.id);
            if (!r) continue;
            if (pathFilter && !r.path.startsWith(pathFilter.replace(/^\.\//, ''))) continue;
            if (kindFilter && !kindFilter.includes(r.kind)) continue;
            if (langFilter && r.lang !== langFilter) continue;
            if (r.kind === 'section' && !wantsDocs && !opts.docs) continue; // documentation answers only questions about it
            const nameWords = splitIdentifier(r.name).map(stem);
            const qnameWords = new Set(splitIdentifier(r.qname.replace(/\./g, '_')).map(stem));
            const nameCover = nameWords.length ? nameWords.filter(x => qStems.has(x)).length / nameWords.length : 0;
            const queryCover = qStems.size ? [...qStems].filter(x => qnameWords.has(x)).length / qStems.size : 0;
            let s = 0;
            const reasons = [];
            // floors keep near-zero-IDF matches (a word present in most documents) from being
            // blown up by max-normalisation; when literal evidence is weak, the concept channel
            // (thesaurus expansions) takes over — that is exactly the vocabulary-mismatch case.
            if (f.bm25) s += w.bm25 * (f.bm25 / Math.max(maxBm, BM25_FLOOR));
            if (f.doc) s += (w.docs ?? 0) * (f.doc / Math.max(maxDoc, BM25_FLOOR));
            if (f.concept) s += (maxBm < BM25_FLOOR ? Math.max(w.concept, 1.0) : w.concept) * (f.concept / Math.max(maxCx, BM25_FLOOR));
            if (f.sem != null && semHi > semLo) s += ((w.sem ?? 0) + (a.natural ? (w.semNL ?? 0) : 0)) * (f.sem - semLo) / (semHi - semLo);
            if (f.exact) { s += w.exact * f.exact; reasons.push('name'); }
            if (f.exactCI) { s += w.exactCI * f.exactCI; reasons.push('name'); }
            if (f.qualified) { s += w.qualified; reasons.push('qualified name'); }
            if (f.prefix) s += w.prefix;
            s += w.nameCover * nameCover + w.queryCover * queryCover;
            s += w.kind * (KIND_PRIOR[r.kind] ?? 0.5);
            if (r.is_test && !wantsTests) s += w.test;
            if (r.exported) s += w.exported;
            if (r.has_doc) s += w.doc;
            if (central) s += w.central * (central.get(r.id) ?? 0);
            // hierarchical evidence: a relevant file lifts its symbols in proportion to their own
            // lexical match (P(file) × P(symbol | file)), never symbols that merely live there
            const fs = fileScore.get(r.file_id);
            if (fs && f.bm25 && r.kind !== 'selector' && r.kind !== 'keyframes') s += (w.file + (a.natural ? w.fileNL : 0)) * fs * Math.min(1, (f.bm25 / Math.max(maxBm, BM25_FLOOR)) / FILE_GATE);
            if (r.parent_kind === 'function' || r.parent_kind === 'method') s += w.nested;
            if (DECLARATION_PATH.test(r.path)) s += w.declaration;
            if (r.kind !== 'section' && EXAMPLE_PATH.test(r.path) && !(pathFilter && EXAMPLE_PATH.test(pathFilter))) s += w.example;
            if (a.natural && (r.kind === 'field' || r.kind === 'property' || r.kind === 'variable' || r.kind === 'constant')) s += w.nlField;
            scored.push({ id: r.id, score: s, reasons, path: r.path, ...(opts.debug ? { features: { ...f, nameCover, queryCover, kind: r.kind } } : {}) });
        }
        scored.sort((x, y) => y.score - x.score || x.id - y.id);
        return { results: diversify(scored, limit, this.perFileCap), total: scored.length, analysis: a };
    }

    /**
     * Several phrasings of one need ("where are tokens refreshed", "refreshToken", "session renewal")
     * in one call: each is searched on its own and the rankings are fused by reciprocal rank
     * (k = 60), so a definition several phrasings agree on rises and one phrasing's noise does not
     * dominate. One query is the same as search().
     */
    searchMany(queries, opts = {}) {
        const qs = [...new Set((queries ?? []).map(q => String(q ?? '').trim()).filter(Boolean))].slice(0, MAX_QUERIES);
        if (qs.length <= 1) return this.search(qs[0] ?? '', opts);
        const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
        const per = Math.max(2 * limit, 20);
        const fused = new Map();
        let total = 0, analysis = null;
        qs.forEach((q, qi) => {
            const r = this.search(q, { ...opts, limit: per });
            analysis ??= r.analysis;
            total = Math.max(total, r.total ?? r.results.length);
            r.results.forEach((x, rank) => {
                let e = fused.get(x.id);
                if (!e) fused.set(x.id, (e = { id: x.id, score: 0, reasons: [], path: x.path, queries: [] }));
                e.score += 1 / (RRF_K + rank + 1);
                e.queries.push(qi);
                for (const why of x.reasons) if (!e.reasons.includes(why)) e.reasons.push(why);
            });
        });
        const scored = [...fused.values()].sort((x, y) => y.score - x.score || x.id - y.id);
        return { results: diversify(scored, limit, this.perFileCap), total: Math.max(total, scored.length), analysis, queries: qs };
    }
}

/** Per-file diversification: results past the cap from one file are pushed below the others. */
function diversify(scored, limit, cap) {
    const perFile = new Map();
    const out = [];
    const deferred = [];
    for (const r of scored) {
        const n = perFile.get(r.path) ?? 0;
        if (n >= cap) { deferred.push(r); continue; }
        perFile.set(r.path, n + 1);
        out.push(r);
        if (out.length >= limit) break;
    }
    for (const r of deferred) { if (out.length >= limit) break; out.push(r); }
    return out;
}
