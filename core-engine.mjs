/**
 * @file core-engine.mjs
 * @description In-Memory Graph Indexer Core Engine.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';

export const EMBEDDING_CONTEXT_LIMIT = 8000;

// Thresholds for adaptive vector loading strategy
const HNSW_THRESHOLD = 5000;      // Build HNSW index above this (eager mode only)
const LAZY_VEC_THRESHOLD = 10000; // Switch to lazy (disk-backed) vector access above this
const TFIDF_PREFILTER_K = 2000;   // TF-IDF candidates fed into lazy vector scoring

// Optional HNSW accelerator for medium corpora (eager mode only)
let HierarchicalNSW = null;
try {
    const mod = await import('hnswlib-node');
    HierarchicalNSW = mod.HierarchicalNSW ?? mod.default?.HierarchicalNSW ?? null;
} catch { /* not installed — flat scan used */ }

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

function tokenize(text) {
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
 * Serializes embeddingCache to compact binary.
 * Format per entry: [uint32 hashLen][utf8 hash][uint32 dim][float32 × dim]
 */
export function writeEmbeddingBinary(embeddingCache) {
    const entries = embeddingCache instanceof Map
        ? Array.from(embeddingCache.entries())
        : Object.entries(embeddingCache);
    let size = 4;
    for (const [hash, vec] of entries) {
        size += 4 + Buffer.byteLength(hash, 'utf8') + 4 + vec.length * 4;
    }
    const buf = Buffer.allocUnsafe(size);
    let off = 0;
    buf.writeUInt32LE(entries.length, off); off += 4;
    for (const [hash, vec] of entries) {
        const hashBytes = Buffer.from(hash, 'utf8');
        buf.writeUInt32LE(hashBytes.length, off); off += 4;
        hashBytes.copy(buf, off); off += hashBytes.length;
        buf.writeUInt32LE(vec.length, off); off += 4;
        for (let d = 0; d < vec.length; d++) { buf.writeFloatLE(vec[d], off); off += 4; }
    }
    return buf;
}

export class MemoryGraphIndex {
    /**
     * @param {string} indexPath
     * @param {object} opts
     * @param {number}  opts.rrfK            RRF rank discount constant (default 60)
     * @param {boolean} opts.cacheEmbeddings  When false, vectors are accessed lazily from disk
     *                                         (ideal for MCP server on large corpora). Default true.
     */
    constructor(indexPath, { rrfK = 60, cacheEmbeddings = true } = {}) {
        this.indexPath = indexPath;
        this._embeddingPath = indexPath.replace(/\.json$/, '.embeddings.bin');

        // ── Core data ─────────────────────────────────────────────────────────
        this.chunks = new Map();           // chunkId → chunk metadata
        this.graph  = { dependencies: {}, importedBy: {} };

        // ── Embedding cache (used by indexer to avoid re-embedding) ───────────
        this.embeddingCache = new Map();   // hash → Float32Array

        // ── Frontier 2: Symbol table ──────────────────────────────────────────
        this.symbolTable = new Map();      // nameLower → Set<chunkId>

        // ── Lexical search: TRUE inverted index (BM25 scoring) ───────────────
        // invertedIndex: Map<token, Map<chunkId, rawCount>>  ← O(1) per-token lookup
        // chunkTerms:    Map<chunkId, Set<token>>            ← for efficient removal
        // docLens:       Map<chunkId, number>                ← token count for BM25 length norm
        this.invertedIndex = new Map();
        this.chunkTerms    = new Map();
        this.docLens       = new Map();    // chunkId → token count (BM25 length normalization)
        this.totalDocLen   = 0;            // Σ doc lengths for avgdl
        this.pathTokens    = new Map();    // chunkId → Set<token> from file path (not in BM25 index)
        this.docCount = 0;
        this.df       = new Map();         // token → document frequency

        // ── Vector search: eager mode (small corpora) ─────────────────────────
        this.vectors      = new Map();     // chunkId → Float32Array (eager only)
        this._matrixDirty = true;
        this._vecMatrix   = null;          // Float32Array(N × dim)
        this._vecNorms    = null;          // Float32Array(N)
        this._vecIds      = [];            // row index → chunkId
        this._dim         = 0;
        this._hnsw        = null;

        // ── Vector search: lazy mode (large corpora, cacheEmbeddings=false) ───
        this._cacheEmbeddings = cacheEmbeddings;
        this._vecOffsets  = new Map();     // hash → { offset: number, dim: number }
        this._embeddingBuf = null;         // Buffer kept for small-lazy corpora (<50k)
        this._vecFd       = -1;            // open fd for disk-backed access (≥50k)
        this._lazyMode    = false;

        this.rrfK = rrfK;
        this._saveTimer = null;
    }

    // ─── Load ─────────────────────────────────────────────────────────────────

    load() {
        if (!fs.existsSync(this.indexPath)) return;
        const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
        this.graph = data.graph || { dependencies: {}, importedBy: {} };

        const chunkCount = (data.chunks || []).length;

        // Decide loading strategy based on corpus size and cacheEmbeddings flag
        this._lazyMode = (!this._cacheEmbeddings) && chunkCount >= LAZY_VEC_THRESHOLD;

        if (fs.existsSync(this._embeddingPath)) {
            const binBuf = fs.readFileSync(this._embeddingPath);
            if (this._lazyMode) {
                this._buildVecOffsets(binBuf);
                // For very large corpora: open persistent fd, release buffer from heap
                if (chunkCount >= 50000) {
                    try { this._vecFd = fs.openSync(this._embeddingPath, 'r'); } catch { this._vecFd = -1; }
                    // binBuf goes out of scope → GC can collect it
                } else {
                    // Medium-large: keep buffer for zero-copy slice access
                    this._embeddingBuf = binBuf;
                }
            } else {
                // Eager: fill embeddingCache (needed by indexer + small-corpus MCP server)
                this._loadEmbeddingBinary(binBuf);
            }
        } else if (data.embeddingCache) {
            for (const [hash, vec] of Object.entries(data.embeddingCache)) {
                this.embeddingCache.set(hash, new Float32Array(vec));
            }
        }

        for (const chunk of (data.chunks || [])) {
            this.chunks.set(chunk.id, chunk);

            // Eager vector population
            if (!this._lazyMode) {
                if (chunk.content_hash && this.embeddingCache.has(chunk.content_hash)) {
                    this.vectors.set(chunk.id, this.embeddingCache.get(chunk.content_hash));
                } else if (chunk.embedding) {
                    const vec = new Float32Array(chunk.embedding);
                    this.vectors.set(chunk.id, vec);
                    if (chunk.content_hash) this.embeddingCache.set(chunk.content_hash, vec);
                }
            }

            // Build inverted lexical index
            const deps = this.graph.dependencies[chunk.file_path] || [];
            const cleanDeps = deps.map(d => d.split('/').pop().split('.')[0]);
            const enrichedContext = [
                chunk.name,
                chunk.docstring || '',
                cleanDeps.join(' '),
                (chunk.calls || []).join(' '),
                (chunk.params || []).join(' '),
                chunk.return_type || '',
                chunk.class_context ? `${chunk.class_context}.${chunk.name}` : '',
                (chunk.type_refs || []).join(' '),
                chunk.code_snippet
            ].join(' ');
            this._indexLexical(chunk.id, enrichedContext, chunk.file_path);

            // Build symbol table (Frontier 2)
            if (chunk.name && chunk.name !== 'anonymous') {
                const n = chunk.name.toLowerCase();
                if (!this.symbolTable.has(n)) this.symbolTable.set(n, new Set());
                this.symbolTable.get(n).add(chunk.id);
            }
        }
    }

    // ─── Embedding binary helpers ──────────────────────────────────────────────

    _loadEmbeddingBinary(buf) {
        let off = 0;
        const count = buf.readUInt32LE(off); off += 4;
        for (let i = 0; i < count; i++) {
            const hashLen = buf.readUInt32LE(off); off += 4;
            const hash = buf.subarray(off, off + hashLen).toString('utf8'); off += hashLen;
            const dim = buf.readUInt32LE(off); off += 4;
            const vec = new Float32Array(dim);
            for (let d = 0; d < dim; d++) { vec[d] = buf.readFloatLE(off); off += 4; }
            this.embeddingCache.set(hash, vec);
        }
    }

    /** Build offset table without creating Float32Array objects. */
    _buildVecOffsets(buf) {
        this._vecOffsets = new Map();
        let off = 0;
        const count = buf.readUInt32LE(off); off += 4;
        for (let i = 0; i < count; i++) {
            const hashLen = buf.readUInt32LE(off); off += 4;
            const hash = buf.subarray(off, off + hashLen).toString('utf8'); off += hashLen;
            const dim = buf.readUInt32LE(off); off += 4;
            this._vecOffsets.set(hash, { offset: off, dim });
            off += dim * 4; // skip float data — never loaded into JS heap
        }
    }

    /** Return Float32Array for a chunk, using in-memory buffer or disk fd. */
    _getVecForChunk(chunkId) {
        const chunk = this.chunks.get(chunkId);
        if (!chunk?.content_hash) return null;
        const entry = this._vecOffsets.get(chunk.content_hash);
        if (!entry) return null;

        if (this._embeddingBuf) {
            // Buffer-backed: zero-copy aligned view or fallback copy
            const byteStart = entry.offset;
            if ((this._embeddingBuf.byteOffset + byteStart) % 4 === 0) {
                return new Float32Array(
                    this._embeddingBuf.buffer,
                    this._embeddingBuf.byteOffset + byteStart,
                    entry.dim
                );
            }
            const vec = new Float32Array(entry.dim);
            for (let d = 0; d < entry.dim; d++)
                vec[d] = this._embeddingBuf.readFloatLE(byteStart + d * 4);
            return vec;
        }

        if (this._vecFd >= 0) {
            // Disk-backed: single pread syscall
            const byteLen = entry.dim * 4;
            const raw = Buffer.allocUnsafe(byteLen);
            try {
                const read = fs.readSync(this._vecFd, raw, 0, byteLen, entry.offset);
                if (read < byteLen) return null;
                const vec = new Float32Array(entry.dim);
                for (let d = 0; d < entry.dim; d++) vec[d] = raw.readFloatLE(d * 4);
                return vec;
            } catch { return null; }
        }

        return null;
    }

    // ─── Lexical index (TRUE inverted index) ──────────────────────────────────

    _indexLexical(chunkId, text, filePath = '') {
        const tokens = tokenize(text);
        if (tokens.length === 0) return;

        const termCounts = new Map();
        for (const token of tokens) {
            termCounts.set(token, (termCounts.get(token) || 0) + 1);
        }

        // Track document length for BM25 length normalization.
        // Only content tokens are counted — path tokens are handled separately
        // in searchHybrid to avoid BM25 length normalisation amplifying short
        // export stubs that share a path with a larger implementation.
        this.docLens.set(chunkId, tokens.length);
        this.totalDocLen += tokens.length;

        const chunkTokenSet = new Set();
        for (const [term, count] of termCounts) {
            // Store raw term count — BM25 applies saturation at search time
            this.df.set(term, (this.df.get(term) || 0) + 1);
            let posting = this.invertedIndex.get(term);
            if (!posting) { posting = new Map(); this.invertedIndex.set(term, posting); }
            posting.set(chunkId, count);
            chunkTokenSet.add(term);
        }

        this.chunkTerms.set(chunkId, chunkTokenSet);
        this.docCount++;

        // ── Path tokens: stored separately from content, not in BM25 index ──────
        // Path matching is done multiplicatively in searchHybrid, which avoids
        // amplifying short stubs that happen to share a path with a long function.
        if (filePath) {
            const pathTokenSet = new Set(tokenize(filePath.replace(/[/\-_.]/g, ' ')));
            if (!this.pathTokens) this.pathTokens = new Map();
            this.pathTokens.set(chunkId, pathTokenSet);
        }
    }

    _removeLexical(chunkId) {
        const terms = this.chunkTerms.get(chunkId);
        if (!terms) return;
        for (const term of terms) {
            const posting = this.invertedIndex.get(term);
            if (posting) {
                posting.delete(chunkId);
                if (posting.size === 0) this.invertedIndex.delete(term);
            }
            const freq = this.df.get(term);
            if (freq !== undefined) {
                if (freq <= 1) this.df.delete(term);
                else this.df.set(term, freq - 1);
            }
        }
        // Update BM25 length accounting
        const dl = this.docLens.get(chunkId);
        if (dl !== undefined) {
            this.totalDocLen = Math.max(0, this.totalDocLen - dl);
            this.docLens.delete(chunkId);
        }
        this.pathTokens.delete(chunkId);
        this.chunkTerms.delete(chunkId);
        this.docCount = Math.max(0, this.docCount - 1);
    }

    _searchLexical(queryText) {
        const queryTokens = tokenize(queryText);
        const scores = new Map();

        // BM25 parameters tuned for code (b lowered from 0.75 to 0.3 — code chunks
        // have purposeful length variation unlike prose, so heavy length normalization
        // incorrectly penalises long implementations vs short export stubs).
        const k1 = 1.5;
        const b  = 0.3;
        const avgdl = this.docCount > 0 ? this.totalDocLen / this.docCount : 1;

        for (const token of queryTokens) {
            const docFreq = this.df.get(token);
            if (!docFreq) continue;
            // Okapi IDF — always positive, avoids negative IDF for very common terms
            const idf = Math.log((this.docCount - docFreq + 0.5) / (docFreq + 0.5) + 1);
            const posting = this.invertedIndex.get(token);
            if (!posting) continue;
            for (const [chunkId, tf] of posting) {
                const dl = this.docLens.get(chunkId) ?? avgdl;
                // BM25: diminishing returns for high TF + document-length normalisation
                const bm25 = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
                scores.set(chunkId, (scores.get(chunkId) || 0) + bm25);
            }
        }
        return Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([id, score], rank) => ({ id, score, rank: rank + 1 }));
    }

    // ─── Vector search ─────────────────────────────────────────────────────────

    _invalidateMatrix() {
        this._matrixDirty = true;
        this._hnsw = null;
    }

    addVector(id, vec) {
        this.vectors.set(id, vec);
        this._invalidateMatrix();
    }

    removeVector(id) {
        if (this.vectors.delete(id)) this._invalidateMatrix();
    }

    _rebuildMatrix() {
        const ids = Array.from(this.vectors.keys());
        const n = ids.length;
        this._vecIds = ids;
        if (n === 0) {
            this._vecMatrix = null; this._vecNorms = null;
            this._dim = 0; this._hnsw = null; this._matrixDirty = false;
            return;
        }
        const dim = this.vectors.get(ids[0]).length;
        this._dim = dim;
        const matrix = new Float32Array(n * dim);
        const norms  = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const v = this.vectors.get(ids[i]);
            let normSq = 0;
            const base = i * dim;
            for (let d = 0; d < dim; d++) {
                const vd = v[d];
                matrix[base + d] = vd;
                normSq += vd * vd;
            }
            norms[i] = Math.sqrt(normSq);
        }
        this._vecMatrix = matrix;
        this._vecNorms  = norms;
        this._matrixDirty = false;

        // HNSW for large eager corpora
        if (HierarchicalNSW && n >= HNSW_THRESHOLD) {
            try {
                const hnsw = new HierarchicalNSW('cosine', dim);
                hnsw.initIndex(n, 16, 200, 100);
                if (typeof hnsw.setEf === 'function') hnsw.setEf(100);
                const buf = new Array(dim);
                for (let i = 0; i < n; i++) {
                    const base = i * dim;
                    for (let d = 0; d < dim; d++) buf[d] = matrix[base + d];
                    hnsw.addPoint(buf, i);
                }
                this._hnsw = hnsw;
            } catch (e) {
                process.stderr.write(`[core-engine] HNSW build failed: ${e.message}\n`);
                this._hnsw = null;
            }
        }
    }

    /** Full flat-scan / HNSW search (eager mode). */
    _searchVector(queryVector, minScore = 0.3) {
        if (this.vectors.size === 0) return [];
        if (this._matrixDirty) this._rebuildMatrix();
        if (!this._vecMatrix) return [];
        if (queryVector.length !== this._dim) return [];

        const n   = this._vecIds.length;
        const dim = this._dim;
        let qNorm = 0;
        for (let d = 0; d < dim; d++) qNorm += queryVector[d] * queryVector[d];
        qNorm = Math.sqrt(qNorm);
        if (qNorm === 0) return [];

        // HNSW fast path
        if (this._hnsw) {
            const topK = Math.min(200, n);
            try {
                const qArr = Array.isArray(queryVector) ? queryVector : Array.from(queryVector);
                const { neighbors, distances } = this._hnsw.searchKnn(qArr, topK);
                const results = [];
                for (let i = 0; i < neighbors.length; i++) {
                    const score = 1 - distances[i];
                    if (score > minScore) results.push({ id: this._vecIds[neighbors[i]], score, rank: i + 1 });
                }
                return results;
            } catch { /* fall through to flat scan */ }
        }

        // Exact flat scan
        const results = [];
        for (let i = 0; i < n; i++) {
            const base = i * dim;
            let dp = 0;
            for (let d = 0; d < dim; d++) dp += queryVector[d] * this._vecMatrix[base + d];
            const score = dp / (qNorm * this._vecNorms[i]);
            if (score > minScore) results.push({ id: this._vecIds[i], score, rank: 0 });
        }
        results.sort((a, b) => b.score - a.score);
        for (let i = 0; i < results.length; i++) results[i].rank = i + 1;
        return results;
    }

    /**
     * Two-phase vector search (lazy mode):
     * Only compute cosine for candidateIds (top-K TF-IDF pre-filter).
     * Reads vectors on-demand from buffer or disk — no full matrix in RAM.
     */
    _searchVectorCandidates(queryVector, candidateIds, minScore = 0.3) {
        const qDim = queryVector.length;
        let qNorm = 0;
        for (let d = 0; d < qDim; d++) qNorm += queryVector[d] * queryVector[d];
        qNorm = Math.sqrt(qNorm);
        if (qNorm === 0) return [];

        const results = [];
        for (const chunkId of candidateIds) {
            const vec = this._getVecForChunk(chunkId);
            if (!vec || vec.length !== qDim) continue;
            let dp = 0, normVec = 0;
            for (let d = 0; d < qDim; d++) {
                dp      += queryVector[d] * vec[d];
                normVec += vec[d] * vec[d];
            }
            const normV = Math.sqrt(normVec);
            if (normV === 0) continue;
            const score = dp / (qNorm * normV);
            if (score > minScore) results.push({ id: chunkId, score });
        }
        results.sort((a, b) => b.score - a.score);
        for (let i = 0; i < results.length; i++) results[i].rank = i + 1;
        return results;
    }

    // ─── Hybrid search ─────────────────────────────────────────────────────────

    searchHybrid(queryText, queryVector, topK = 5, minScore = 0.3, exactBoostName = null) {
        const lexicalResults = this._searchLexical(queryText);

        let vectorResults;
        if (queryVector) {
            if (this._lazyMode && this._vecOffsets.size > 0) {
                // Two-phase: TF-IDF pre-filter → lazy vector load
                const candidateIds = lexicalResults.slice(0, TFIDF_PREFILTER_K).map(r => r.id);
                vectorResults = this._searchVectorCandidates(queryVector, candidateIds, minScore);
            } else {
                vectorResults = this._searchVector(queryVector, minScore);
            }
        } else {
            vectorResults = [];
        }

        const rrfScores  = new Map();
        const K          = this.rrfK;
        const queryLower = queryText.toLowerCase();

        const LEXICAL_WEIGHT = 1.5;
        const VECTOR_WEIGHT  = 1.0;

        // Pre-compute query file tokens once for path boosting
        const _queryPathTokens = queryLower.split(/[\s\W_]+/).filter(t => t.length >= 3);

        const allResults = [
            ...vectorResults.map(r => ({ ...r, _w: VECTOR_WEIGHT })),
            ...lexicalResults.map(r => ({ ...r, _w: LEXICAL_WEIGHT })),
        ];

        for (const { id, rank, _w } of allResults) {
            let baseScore = (_w ?? 1.0) / (K + rank);
            const chunk = this.chunks.get(id);
            if (!chunk) continue;

            // Demotion: test / spec files
            if (/\.(test|spec)\.|[/\\]__tests__[/\\]|_test\.|^tests?[/\\]|[/\\]tests?[/\\]|[/\\]spec[/\\]/.test(chunk.file_path)) {
                if (!queryLower.includes('test') && !queryLower.includes('spec')) baseScore *= 0.25;
            }
            // Demotion: example / docs dirs (tutorial snippets over-rank due to short length
            // and high keyword density relative to the actual framework implementation).
            if (/^examples?[/\\]|[/\\]examples?[/\\]|^samples?[/\\]|[/\\]samples?[/\\]|^demos?[/\\]|[/\\]demos?[/\\]|[/\\]tutorials?[/\\]|^docs_src[/\\]|[/\\]docs_src[/\\]/.test(chunk.file_path)) {
                baseScore *= 0.5;
            }
            // Demotion: pure expression sites
            if (chunk.node_type === 'expression_statement' || chunk.node_type === 'call_expression') {
                baseScore *= 0.8;
            }
            // Demotion: TypeScript barrel re-exports (e.g. "controller.decorator_export_statement"
            // in .ts files). These are synthetic chunks created for `export { X } from 'y'`
            // declarations — no implementation, just re-exporting from another file.
            // JavaScript .js exports (e.g. "http_export_statement") are intentionally excluded
            // since those often ARE the primary module export (the file IS the implementation).
            if (chunk.name && chunk.name.endsWith('_export_statement') && chunk.file_path?.endsWith('.ts')) {
                baseScore *= 0.7;
            }

            // File-path boost: applied to ALL queries (not just when vectors are absent).
            // Uses the separate pathTokens index (not the BM25 inverted index) so that
            // length normalisation does not penalise long implementations sharing a path
            // with short stubs.
            if (_queryPathTokens.length > 0) {
                const pathToks = this.pathTokens.get(id);
                if (pathToks) {
                    const hasExact = _queryPathTokens.some(t => pathToks.has(t));
                    const hasPrefix = !hasExact && _queryPathTokens.some(t =>
                        t.length >= 4 && Array.from(pathToks).some(pt => pt.startsWith(t.slice(0, 5)))
                    );
                    if (hasExact)       baseScore *= 1.4;
                    else if (hasPrefix) baseScore *= 1.2;
                }
            }

            // Name boost:
            //   2.0x exact match — a query token IS the full chunk name.
            //   1.4x snake_case suffix — the last underscore/dot component of the name
            //     matches a query token.  Intentionally uses only [._] splitting so
            //     camelCase names stay atomic: "dispatchRequest" is one token, not
            //     ["dispatch","request"], preventing false boosts from generic suffixes.
            if (chunk.name && chunk.name !== 'anonymous') {
                const nameLower      = chunk.name.toLowerCase();
                const queryTokensAll = queryLower.split(/[\s\W_]+/).filter(t => t.length >= 5);
                if (queryTokensAll.some(t => nameLower === t || nameLower.endsWith('.' + t))) {
                    baseScore *= 2.0;
                } else {
                    const snakeParts = nameLower.split(/[._]+/);
                    const lastSnake  = snakeParts[snakeParts.length - 1] ?? '';
                    if (snakeParts.length >= 2 && lastSnake.length >= 5 && queryTokensAll.includes(lastSnake)) {
                        baseScore *= 1.4;
                    }
                }
            }

            rrfScores.set(id, (rrfScores.get(id) || 0) + baseScore);
        }

        if (exactBoostName) {
            const boostTerm = String(exactBoostName).toLowerCase().trim();
            for (const [id, chunk] of this.chunks.entries()) {
                if (chunk.name && String(chunk.name).toLowerCase() === boostTerm) {
                    rrfScores.set(id, (rrfScores.get(id) || 0) + 1 / (K + 1));
                }
            }
        }

        return Array.from(rrfScores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, topK)
            .map(([id, rrfScore]) => ({ score: rrfScore, chunk: this.chunks.get(id) }))
            .filter(r => r.chunk !== undefined);
    }

    // ─── Persistence ───────────────────────────────────────────────────────────

    async save() {
        const chunksData = Array.from(this.chunks.values()).map(c => ({
            id: c.id, file_path: c.file_path, node_type: c.node_type,
            name: c.name, docstring: c.docstring || '', code_snippet: c.code_snippet,
            content_hash: c.content_hash, start_line: c.start_line, end_line: c.end_line,
            calls: c.calls || [], params: c.params || [],
            return_type: c.return_type || '', class_context: c.class_context || '',
            type_refs: c.type_refs || [],
        }));
        const payload  = JSON.stringify({ chunks: chunksData, graph: this.graph });
        const tmpPath    = `${this.indexPath}.tmp`;
        const tmpBinPath = `${this._embeddingPath}.tmp`;
        await Promise.all([
            fs.promises.writeFile(tmpPath, payload),
            fs.promises.writeFile(tmpBinPath, writeEmbeddingBinary(this.embeddingCache)),
        ]);
        await Promise.all([
            fs.promises.rename(tmpPath, this.indexPath),
            fs.promises.rename(tmpBinPath, this._embeddingPath),
        ]);
    }

    saveDebounced(delayMs = 3000) {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(async () => {
            this._saveTimer = null;
            try { await this.save(); }
            catch (err) { process.stderr.write(`[core-engine] ❌ Async save failed: ${err.message}\n`); }
        }, delayMs);
    }

    updateFileGraph(filePath, imports) {
        const oldDeps = this.graph.dependencies[filePath] || [];
        for (const oldDep of oldDeps) {
            if (this.graph.importedBy[oldDep]) {
                this.graph.importedBy[oldDep] = this.graph.importedBy[oldDep].filter(f => f !== filePath);
            }
        }
        this.graph.dependencies[filePath] = imports;
        for (const dep of imports) {
            if (!this.graph.importedBy[dep]) this.graph.importedBy[dep] = [];
            if (!this.graph.importedBy[dep].includes(filePath)) this.graph.importedBy[dep].push(filePath);
        }
    }

    // ─── Cleanup ───────────────────────────────────────────────────────────────

    close() {
        if (this._vecFd >= 0) {
            try { fs.closeSync(this._vecFd); } catch {}
            this._vecFd = -1;
        }
    }
}
