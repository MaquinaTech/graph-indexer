/**
 * @file engine/memory.mjs
 * @description In-Memory Graph Indexer Core Engine.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import {
    tokenize, okapiIdf, bm25Score, fuseAndRank, buildLexicalDocument, embeddingKeyFor,
    SUMMARY_VEC_SUFFIX, LEXICAL_FUSION_CAP, VECTOR_SCAN_RAW_N, finalizeVectorCandidates,
    isNaturalLanguageQuery, WINDOW_VEC_SUFFIX, EMBEDDING_MAX_WINDOWS, baseEmbeddingKey,
} from '../search-core.mjs';
import {
    HierarchicalNSW, HNSW_THRESHOLD, LAZY_VEC_THRESHOLD,
    writeEmbeddingBinary, scanEmbeddingBinary, updateVectorSketch, searchVectorSketch,
} from './binary.mjs';

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
        this._keyToIds    = null;          // embedding key → chunkId[] (built lazily for scans)
        this._sketch      = null;          // binary-quantized sketch (lazy mode, large corpora)

        this.rrfK = rrfK;
        this._saveTimer = null;
    }

    // ─── Load ─────────────────────────────────────────────────────────────────

    load() {
        if (!fs.existsSync(this.indexPath)) return;
        const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
        this.graph = data.graph || { dependencies: {}, importedBy: {} };
        // Does this corpus carry LLM enrichment? Drives the NL vector-channel weight
        // in fuseAndRank (strong summary vectors earn full weight; plain code vectors
        // stay a low-weight rescue). Set during the chunk load loop below.
        this._corpusEnriched = false;

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
            if (!this._corpusEnriched && (chunk.summary || (chunk.concepts && chunk.concepts.length))) {
                this._corpusEnriched = true;
            }

            // Eager vector population. Vectors are keyed by embeddingKeyFor(chunk)
            // (content_hash + enrichment digest); plain content_hash is the
            // backward-compatible fallback for bins written before enrichment keys.
            if (!this._lazyMode) {
                const vecKey = embeddingKeyFor(chunk);
                if (chunk.content_hash && this.embeddingCache.has(vecKey)) {
                    this.vectors.set(chunk.id, this.embeddingCache.get(vecKey));
                    // Summary-only and per-window vectors (enriched / oversized chunks):
                    // stored under pseudo row ids; searchHybrid folds hits back onto the
                    // chunk id (max-sim across all of the chunk's vectors).
                    const sVec = this.embeddingCache.get(vecKey + SUMMARY_VEC_SUFFIX);
                    if (sVec) this.vectors.set(chunk.id + SUMMARY_VEC_SUFFIX, sVec);
                    for (let i = 1; i < EMBEDDING_MAX_WINDOWS; i++) {
                        const wVec = this.embeddingCache.get(vecKey + WINDOW_VEC_SUFFIX + i);
                        if (!wVec) break;
                        this.vectors.set(chunk.id + WINDOW_VEC_SUFFIX + i, wVec);
                    }
                } else if (chunk.content_hash && this.embeddingCache.has(chunk.content_hash)) {
                    this.vectors.set(chunk.id, this.embeddingCache.get(chunk.content_hash));
                } else if (chunk.embedding) {
                    const vec = new Float32Array(chunk.embedding);
                    this.vectors.set(chunk.id, vec);
                    if (chunk.content_hash) this.embeddingCache.set(chunk.content_hash, vec);
                }
            }

            // Build inverted lexical index from the shared document builder
            // (search-core.buildLexicalDocument) — identical text across backends.
            const deps = this.graph.dependencies[chunk.file_path] || [];
            this._indexLexical(chunk.id, buildLexicalDocument(chunk, deps), chunk.file_path);

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
        const entry = this._vecOffsets.get(embeddingKeyFor(chunk))
            ?? this._vecOffsets.get(chunk.content_hash); // pre-enrichment-key bins
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
        const tokens = tokenize(text);               // raw + additive Porter stems
        if (tokens.length === 0) return;

        const termCounts = new Map();
        for (const token of tokens) {
            termCounts.set(token, (termCounts.get(token) || 0) + 1);
        }

        // Track document length for BM25 length normalization.
        // RAW token count only — the additive stem tokens earn their own postings
        // (so behavioural queries can match them) but must NOT inflate docLen, or
        // they would perturb length normalisation for exact symbolic matches. With
        // raw-based docLen, raw-term BM25 is byte-identical to the pre-stem index.
        // Path tokens are handled separately in searchHybrid.
        const rawLen = tokenize(text, false).length;
        this.docLens.set(chunkId, rawLen);
        this.totalDocLen += rawLen;

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
            const pathTokenSet = new Set(tokenize(filePath.replace(/[/\-_.]/g, ' '), false));
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
        // Asymmetric stemming: the index always carries stems, but only stem the
        // QUERY for natural-language/behavioural queries — symbolic name lookups
        // stay exact so stem collisions never dilute a precise symbol match.
        const queryTokens = tokenize(queryText, isNaturalLanguageQuery(queryText));
        const scores = new Map();
        const avgdl = this.docCount > 0 ? this.totalDocLen / this.docCount : 1;

        for (const token of queryTokens) {
            const docFreq = this.df.get(token);
            if (!docFreq) continue;
            const idf = okapiIdf(this.docCount, docFreq);
            const posting = this.invertedIndex.get(token);
            if (!posting) continue;
            for (const [chunkId, tf] of posting) {
                const dl = this.docLens.get(chunkId) ?? avgdl;
                scores.set(chunkId, (scores.get(chunkId) || 0) + bm25Score(idf, tf, dl, avgdl));
            }
        }
        return Array.from(scores.entries())
            .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)) // id tie-break: backend parity
            .slice(0, LEXICAL_FUSION_CAP)                            // same cap as SQLite: parity
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
        // Float64: norms must carry full precision — f32-rounded norms produced
        // ~1e-7 score skew vs the disk-backed store's double-precision rescore,
        // which was enough to flip near-tied ranks between backends.
        const norms  = new Float64Array(n);
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
     * Full vector search in lazy mode: stream the entire embeddings bin (bounded
     * buffers, no full matrix in RAM) and map the top entry keys back to chunks.
     * Replaces the old lexical-prefiltered scoring, which could never surface a
     * chunk for a conceptual query that shared no tokens with the code.
     */
    _scanVectorsLazy(queryVector, minScore = 0.3) {
        const source = this._embeddingBuf ? { buffer: this._embeddingBuf } : { fd: this._vecFd };
        if (!this._embeddingBuf && this._vecFd < 0) return [];
        // Large corpora: binary sketch (built once on first vector query) replaces
        // the exact O(corpus) scan with a Hamming prefilter + bounded rescore.
        // 10k threshold matches the SQLite store so backends stay rank-identical
        // wherever the exact scan is still fast.
        if (!this._sketch && this._vecOffsets.size >= 10000) {
            try { this._sketch = updateVectorSketch(null, source); } catch { this._sketch = null; }
        }
        const hits = this._sketch
            ? searchVectorSketch(this._sketch, source, queryVector, { topN: VECTOR_SCAN_RAW_N, minScore })
            : scanEmbeddingBinary(source, queryVector, { topN: VECTOR_SCAN_RAW_N, minScore });
        if (hits.length === 0) return [];

        if (!this._keyToIds) {
            const map = new Map();
            const put = (key, id) => {
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(id);
            };
            for (const c of this.chunks.values()) {
                if (!c.content_hash) continue;
                const key = embeddingKeyFor(c);
                put(key, c.id);
                put(key + SUMMARY_VEC_SUFFIX, c.id);     // summary-only vector → same chunk
                for (let i = 1; i < EMBEDDING_MAX_WINDOWS; i++) put(key + WINDOW_VEC_SUFFIX + i, c.id); // window vectors → same chunk
                if (key !== c.content_hash) put(c.content_hash, c.id); // legacy bins
            }
            this._keyToIds = map;
        }

        const entries = [];
        for (const { key, score } of hits) {
            for (const id of (this._keyToIds.get(key) || [])) entries.push({ id, score });
        }
        return finalizeVectorCandidates(entries);
    }

    // ─── Hybrid search ─────────────────────────────────────────────────────────

    searchHybrid(queryText, queryVector, topK = 5, minScore = 0.3, exactBoostName = null) {
        const lexicalResults = this._searchLexical(queryText);

        let vectorResults;
        if (queryVector) {
            if (this._lazyMode && this._vecOffsets.size > 0) {
                // Full streaming scan of the bin — covers conceptual queries with
                // zero lexical overlap, which the old TF-IDF prefilter never could.
                vectorResults = this._scanVectorsLazy(queryVector, minScore);
            } else {
                // Eager rows include summary-only and per-window pseudo ids
                // (`<id>|s`, `<id>|wN`) — fold each back onto its chunk via the shared
                // finalizer (best/max-sim score per chunk, deterministic order, same
                // cap as the disk-backed paths).
                const entries = this._searchVector(queryVector, minScore).map(r => ({
                    id: baseEmbeddingKey(r.id),
                    score: r.score,
                }));
                vectorResults = finalizeVectorCandidates(entries);
            }
        } else {
            vectorResults = [];
        }

        // Fusion + boost ladder lives in search-core.mjs so the in-memory engine
        // and the SQLite store rank identically. Backend state is reached through
        // accessors; the math is measured once and shared.
        return fuseAndRank({
            lexicalResults,
            vectorResults,
            getChunk:      (id) => this.chunks.get(id),
            getPathTokens: (id) => this.pathTokens.get(id),
            getDf:         (t)  => this.df.get(t) || 0,
            docCount:      this.docCount,
            rrfK:          this.rrfK,
            topK,
            queryText,
            exactBoostName,
            corpusEnriched: this._corpusEnriched,
            // Equivalent to the former full-scan (symbolTable is keyed by name.toLowerCase()),
            // but O(1) and reusable by the SQLite backend.
            resolveExact:  (term) => this.symbolTable.get(term) || [],
        });
    }

    // ─── Persistence ───────────────────────────────────────────────────────────

    async save() {
        const chunksData = Array.from(this.chunks.values()).map(c => ({
            id: c.id, file_path: c.file_path, node_type: c.node_type,
            name: c.name, docstring: c.docstring || '', code_snippet: c.code_snippet,
            content_hash: c.content_hash, start_line: c.start_line, end_line: c.end_line,
            calls: c.calls || [], call_sites: c.call_sites || [], params: c.params || [],
            return_type: c.return_type || '', class_context: c.class_context || '',
            type_refs: c.type_refs || [], decorators: c.decorators || [],
            extends: c.extends || [],
            hyde: c.hyde || '', summary: c.summary || '', concepts: c.concepts || [],
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

    _removeSymbol(chunk) {
        if (!chunk.name || chunk.name === 'anonymous') return;
        const n = chunk.name.toLowerCase();
        const set = this.symbolTable.get(n);
        if (set) {
            set.delete(chunk.id);
            if (set.size === 0) this.symbolTable.delete(n);
        }
    }

    /** Whether a vector for this embedding key is already cached (skip re-embedding). */
    hasEmbedding(key) { return this.embeddingCache.has(key); }

    /**
     * Atomically replace every chunk of one file — the incremental-update entry
     * point used by the watch daemon. Removes the file's old chunks from the
     * lexical, vector AND symbol indexes (the old daemon path leaked symbol-table
     * entries), stores newly computed embeddings, indexes the new chunks, and
     * schedules a debounced save. Pass empty chunks/imports for a deleted file.
     *
     * @param {string} filePath
     * @param {object} p
     * @param {object[]} [p.chunks]
     * @param {string[]} [p.imports]
     * @param {Map<string, Float32Array|number[]>} [p.embeddings] New vectors keyed by embeddingKeyFor(chunk).
     */
    applyFileUpdate(filePath, { chunks = [], imports = [], embeddings = null } = {}) {
        this.updateFileGraph(filePath, imports);

        for (const [id, chunk] of Array.from(this.chunks.entries())) {
            if (chunk.file_path !== filePath) continue;
            this._removeLexical(id);
            this.removeVector(id);
            this.removeVector(id + SUMMARY_VEC_SUFFIX);
            for (let i = 1; i < EMBEDDING_MAX_WINDOWS; i++) this.removeVector(id + WINDOW_VEC_SUFFIX + i);
            this._removeSymbol(chunk);
            this.chunks.delete(id);
        }

        if (embeddings) {
            for (const [key, vec] of embeddings) {
                this.embeddingCache.set(key, vec instanceof Float32Array ? vec : new Float32Array(vec));
            }
        }

        for (const chunk of chunks) {
            const vecKey = embeddingKeyFor(chunk);
            const vec = this.embeddingCache.get(vecKey) ?? this.embeddingCache.get(chunk.content_hash);
            if (vec) this.addVector(chunk.id, vec);
            const sVec = this.embeddingCache.get(vecKey + SUMMARY_VEC_SUFFIX);
            if (sVec) this.addVector(chunk.id + SUMMARY_VEC_SUFFIX, sVec);
            for (let i = 1; i < EMBEDDING_MAX_WINDOWS; i++) {
                const wVec = this.embeddingCache.get(vecKey + WINDOW_VEC_SUFFIX + i);
                if (wVec) this.addVector(chunk.id + WINDOW_VEC_SUFFIX + i, wVec);
            }
            this._indexLexical(chunk.id, buildLexicalDocument(chunk, imports), chunk.file_path);
            this.chunks.set(chunk.id, chunk);
            if (chunk.name && chunk.name !== 'anonymous') {
                const n = chunk.name.toLowerCase();
                if (!this.symbolTable.has(n)) this.symbolTable.set(n, new Set());
                this.symbolTable.get(n).add(chunk.id);
            }
        }

        this._keyToIds = null;
        this.saveDebounced();
    }

    /**
     * Drop every in-memory structure and re-read the index artifacts from disk.
     * Used by the MCP server when the watch daemon (a separate process) rewrites
     * code-index.json — without this the server would serve a stale snapshot
     * until restart.
     */
    reload() {
        if (this._vecFd >= 0) { try { fs.closeSync(this._vecFd); } catch {} this._vecFd = -1; }
        this.chunks = new Map();
        this.graph = { dependencies: {}, importedBy: {} };
        this.embeddingCache = new Map();
        this.symbolTable = new Map();
        this.invertedIndex = new Map();
        this.chunkTerms = new Map();
        this.docLens = new Map();
        this.totalDocLen = 0;
        this.pathTokens = new Map();
        this.docCount = 0;
        this.df = new Map();
        this.vectors = new Map();
        this._invalidateMatrix();
        this._vecOffsets = new Map();
        this._embeddingBuf = null;
        this._keyToIds = null;
        this._sketch = null;
        this._lazyMode = false;
        this.load();
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

    // ─── Store contract ────────────────────────────────────────────────────────
    // The read surface the MCP tools consume. The SQLite store implements the same
    // methods over disk so tools never reach into a backend's internals.

    get backend() { return 'memory'; }

    /** @returns {object|null} */
    getChunk(id) { return this.chunks.get(id) ?? null; }

    /** All chunks defined in a given file. @returns {object[]} */
    getChunksByFile(filePath) {
        const out = [];
        for (const c of this.chunks.values()) if (c.file_path === filePath) out.push(c);
        return out;
    }

    /** Chunks whose symbol name matches exactly (case-insensitive). @returns {object[]} */
    resolveSymbol(name) {
        const ids = this.symbolTable.get(String(name).toLowerCase().trim());
        if (!ids) return [];
        const out = [];
        for (const id of ids) { const c = this.chunks.get(id); if (c) out.push(c); }
        return out;
    }

    /** Chunks that call the given function name. @returns {object[]} */
    findCallers(funcName) {
        const out = [];
        for (const c of this.chunks.values()) if (c.calls?.includes(funcName)) out.push(c);
        return out;
    }

    /**
     * Chunks that reference a symbol *by name* as a type (`type_refs`) or as a
     * base class/interface (`extends`) — the non-call half of symbol-level
     * references. Calls are served by findCallers; mcp-tools.findReferences fuses
     * the two and classifies each by confidence. Case-insensitive exact match.
     * @returns {object[]}
     */
    findReferers(symbol) {
        const key = String(symbol).toLowerCase().trim();
        if (!key) return [];
        const out = [];
        for (const c of this.chunks.values()) {
            // A class/type lists its own name in type_refs (the name node is a
            // type_identifier) — that self-mention is a definition, not a reference.
            if (c.name && c.name.toLowerCase() === key) continue;
            const hit = (c.type_refs && c.type_refs.some(t => t.toLowerCase() === key))
                || (c.extends && c.extends.some(t => t.toLowerCase() === key));
            if (hit) out.push(c);
        }
        return out;
    }

    /**
     * HTTP routes filtered by method and/or path prefix, each augmented with its
     * resolved handler chunk (`chunk`, looked up by handler_chunk_id, or null).
     * `graph.routes` round-trips verbatim through load(); a route-less index yields
     * []. Method is matched case-insensitively (HTTP verbs are upper-cased); the
     * path prefix match is case-insensitive. Mirrors SqliteGraphStore.findRoutes so
     * both backends return identical records.
     * @returns {object[]}
     */
    findRoutes({ method = null, pathPrefix = null } = {}) {
        const routes = (this.graph && this.graph.routes) || [];
        const m = method ? String(method).toUpperCase().trim() : null;
        const p = pathPrefix ? String(pathPrefix).toLowerCase() : null;
        const out = [];
        for (const r of routes) {
            if (m && String(r.method || '').toUpperCase() !== m) continue;
            if (p && !String(r.path || '').toLowerCase().startsWith(p)) continue;
            const chunk = r.handler_chunk_id ? (this.chunks.get(r.handler_chunk_id) || null) : null;
            out.push({ ...r, chunk });
        }
        return out;
    }

    /** Lazily iterate every chunk (cursor-friendly parity with the SQLite store). */
    *iterateChunks() { yield* this.chunks.values(); }

    chunkCount()  { return this.chunks.size; }
    symbolCount() { return this.symbolTable.size; }
    fileCount() {
        const files = new Set();
        for (const c of this.chunks.values()) files.add(c.file_path);
        return files.size;
    }
    vectorCount() {
        // Count one vector per chunk: exclude the summary (`|s`) and window (`|wN`)
        // pseudo-entries, which all fold onto a base key / chunk id.
        if (this._lazyMode) {
            let n = 0;
            for (const k of this._vecOffsets.keys()) if (baseEmbeddingKey(k) === k) n++;
            return n;
        }
        let n = 0;
        for (const k of this.vectors.keys()) if (baseEmbeddingKey(k) === k) n++;
        return n;
    }

    getDependencies(filePath) { return this.graph.dependencies[filePath] || []; }
    getImportedBy(filePath)   { return this.graph.importedBy[filePath] || []; }

    /** Engine-level health facts for list_index_stats (daemon/age added by the tool). */
    stats() {
        const extCounts = new Map();
        for (const c of this.chunks.values()) {
            const ext = c.file_path.split('.').pop() || 'unknown';
            extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
        }
        const vectorSource = this._lazyMode
            ? (this._vecFd >= 0 ? 'disk-backed fd' : 'buffer-lazy')
            : 'eager (in-memory matrix)';
        return {
            backend: 'memory',
            chunks: this.chunks.size,
            files: this.fileCount(),
            symbols: this.symbolTable.size,
            vectors: this.vectorCount(),
            hasVectors: this.vectors.size > 0 || this._vecOffsets.size > 0,
            lazyMode: this._lazyMode,
            vectorSource,
            extCounts,
        };
    }

    // ─── Cleanup ───────────────────────────────────────────────────────────────

    close() {
        if (this._vecFd >= 0) {
            try { fs.closeSync(this._vecFd); } catch {}
            this._vecFd = -1;
        }
    }
}
