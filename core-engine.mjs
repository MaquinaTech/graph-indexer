/**
 * @file core-engine.mjs
 * @description In-Memory Graph Indexer Core Engine.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import {
    EMBEDDING_CONTEXT_LIMIT, truncateForEmbedding, cosineSimilarity, tokenize,
    okapiIdf, bm25Score, fuseAndRank, buildLexicalDocument, embeddingKeyFor,
    SUMMARY_VEC_SUFFIX, LEXICAL_FUSION_CAP, VECTOR_SCAN_RAW_N, finalizeVectorCandidates,
} from './search-core.mjs';

// Re-exported for backward compatibility — callers historically imported these
// retrieval primitives from core-engine; they now live in search-core.mjs.
export { EMBEDDING_CONTEXT_LIMIT, truncateForEmbedding, cosineSimilarity };

// Thresholds for adaptive vector loading strategy
const HNSW_THRESHOLD = 5000;      // Build HNSW index above this (eager mode only)
const LAZY_VEC_THRESHOLD = 10000; // Switch to lazy (disk-backed) vector access above this

// Optional HNSW accelerator for medium corpora (eager mode only)
let HierarchicalNSW = null;
try {
    const mod = await import('hnswlib-node');
    HierarchicalNSW = mod.HierarchicalNSW ?? mod.default?.HierarchicalNSW ?? null;
} catch { /* not installed — flat scan used */ }

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

/**
 * Decode an `.embeddings.bin` file into a Map<content_hash, Float32Array>.
 * Standalone (mirrors the instance loader) so the indexer can reuse cached
 * vectors across runs regardless of the active storage backend.
 */
export function readEmbeddingBinary(filePath) {
    const cache = new Map();
    if (!fs.existsSync(filePath)) return cache;
    const buf = fs.readFileSync(filePath);
    let off = 0;
    const count = buf.readUInt32LE(off); off += 4;
    for (let i = 0; i < count; i++) {
        const hashLen = buf.readUInt32LE(off); off += 4;
        const hash = buf.subarray(off, off + hashLen).toString('utf8'); off += hashLen;
        const dim = buf.readUInt32LE(off); off += 4;
        const vec = new Float32Array(dim);
        for (let d = 0; d < dim; d++) { vec[d] = buf.readFloatLE(off); off += 4; }
        cache.set(hash, vec);
    }
    return cache;
}

/**
 * Append embedding entries to an `.embeddings.bin` file in place (creating it if
 * absent) and return the absolute float-data offset of each appended entry.
 * The leading uint32 entry count is updated so readEmbeddingBinary stays valid.
 *
 * Used by the watch daemon for incremental updates: a full bin rewrite on every
 * file change would be O(corpus) — appending is O(changed chunks). Dead entries
 * from replaced chunks are compacted away on the next full index run.
 *
 * @param {string} filePath
 * @param {Map<string, Float32Array|number[]>|object} entries  key → vector
 * @returns {Map<string, {offset:number, dim:number}>}
 */
export function appendEmbeddingBinary(filePath, entries) {
    const list = entries instanceof Map ? Array.from(entries.entries()) : Object.entries(entries || {});
    const offsets = new Map();
    if (list.length === 0) return offsets;

    if (!fs.existsSync(filePath)) {
        const hdr = Buffer.alloc(4);
        hdr.writeUInt32LE(0, 0);
        fs.writeFileSync(filePath, hdr);
    }
    const fd = fs.openSync(filePath, 'r+');
    try {
        const pos = fs.fstatSync(fd).size;
        let size = 0;
        for (const [key, vec] of list) size += 4 + Buffer.byteLength(key, 'utf8') + 4 + vec.length * 4;
        const buf = Buffer.allocUnsafe(size);
        let off = 0;
        for (const [key, vec] of list) {
            const kb = Buffer.from(key, 'utf8');
            buf.writeUInt32LE(kb.length, off); off += 4;
            kb.copy(buf, off); off += kb.length;
            buf.writeUInt32LE(vec.length, off); off += 4;
            offsets.set(key, { offset: pos + off, dim: vec.length });
            for (let d = 0; d < vec.length; d++) { buf.writeFloatLE(vec[d], off); off += 4; }
        }
        fs.writeSync(fd, buf, 0, buf.length, pos);
        const hdr = Buffer.allocUnsafe(4);
        fs.readSync(fd, hdr, 0, 4, 0);
        hdr.writeUInt32LE(hdr.readUInt32LE(0) + list.length, 0);
        fs.writeSync(fd, hdr, 0, 4, 0);
    } finally {
        fs.closeSync(fd);
    }
    return offsets;
}

/**
 * Cosine-score EVERY vector in an `.embeddings.bin` against a query vector,
 * streaming from disk in bounded buffers, and return the top-N entry keys.
 *
 * This is the semantic channel for the disk-backed stores. The previous design
 * scored vectors only for chunks that already matched lexically, which silently
 * disabled semantic search exactly where it matters: conceptual queries that
 * share no tokens with the code. A sequential scan of the bin is fast (the OS
 * page cache holds it after the first query) and keeps resident RAM flat.
 *
 * @param {{fd?: number, buffer?: Buffer}} source  Open fd or in-memory buffer of the bin.
 * @param {Float32Array|number[]} queryVector
 * @param {{topN?: number, minScore?: number}} [opts]
 * @returns {Array<{key: string, score: number}>}  Sorted by score, descending.
 */
export function scanEmbeddingBinary({ fd = -1, buffer = null }, queryVector, { topN = 200, minScore = 0 } = {}) {
    const qDim = queryVector.length;
    let qNorm = 0;
    for (let d = 0; d < qDim; d++) qNorm += queryVector[d] * queryVector[d];
    qNorm = Math.sqrt(qNorm);
    if (qNorm === 0) return [];

    const top = []; // sorted desc, capped at topN
    let worst = -Infinity;
    const push = (key, score) => {
        if (score <= minScore) return;
        if (top.length >= topN && score <= worst) return;
        let lo = 0, hi = top.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (top[mid].score >= score) lo = mid + 1; else hi = mid; }
        top.splice(lo, 0, { key, score });
        if (top.length > topN) top.pop();
        worst = top[top.length - 1].score;
    };

    // Parses complete entries in buf starting at startOff; returns the offset of
    // the first incomplete entry (callers carry the remainder into the next read).
    const processEntries = (buf, startOff) => {
        let off = startOff;
        for (;;) {
            if (off + 4 > buf.length) return off;
            const keyLen = buf.readUInt32LE(off);
            if (off + 4 + keyLen + 4 > buf.length) return off;
            const dim = buf.readUInt32LE(off + 4 + keyLen);
            const entryEnd = off + 4 + keyLen + 4 + dim * 4;
            if (entryEnd > buf.length) return off;
            if (dim === qDim) {
                const key = buf.toString('utf8', off + 4, off + 4 + keyLen);
                let dp = 0, nv = 0;
                let p = off + 4 + keyLen + 4;
                for (let d = 0; d < dim; d++, p += 4) {
                    const v = buf.readFloatLE(p);
                    dp += queryVector[d] * v;
                    nv += v * v;
                }
                const n = Math.sqrt(nv);
                if (n > 0) push(key, dp / (qNorm * n));
            }
            off = entryEnd;
        }
    };

    if (buffer) { processEntries(buffer, 4); return top; }
    if (fd < 0) return [];

    const CHUNK = 4 * 1024 * 1024;
    let filePos = 0;
    let carry = null;
    let first = true;
    for (;;) {
        const buf = Buffer.allocUnsafe(CHUNK);
        const read = fs.readSync(fd, buf, 0, CHUNK, filePos);
        if (read <= 0) break;
        filePos += read;
        const work = carry && carry.length
            ? Buffer.concat([carry, buf.subarray(0, read)])
            : buf.subarray(0, read);
        const consumed = processEntries(work, first ? 4 : 0);
        first = false;
        carry = work.subarray(consumed);
        if (read < CHUNK) break;
    }
    return top;
}

// ─── Binary-quantized vector sketch ─────────────────────────────────────────────
// The streaming full scan above is exact but O(corpus × dim) per query: ~104 ms
// at 50k chunks and ~519 ms at 200k (measured warm). The sketch removes that
// ceiling while keeping resident RAM bounded: each vector is reduced to its SIGN
// BITS (768 dims → 96 bytes, 0.1% of the float32 data). A query is answered by
// (1) a Hamming-distance pass over the packed bits (XOR + popcount over Uint32
// words — a few ms even at 200k rows), keeping the best `oversample × topN`
// candidates, then (2) an exact cosine rescore of only those candidates, pread
// from the bin. Sign quantization of normalized embeddings preserves cosine
// ordering well enough that a 4× oversampled rescore recovers the exact top-N
// (validated in test/unit.mjs against the exhaustive scan).
//
// The sketch is APPEND-AWARE: the bin only ever grows between full rebuilds
// (the daemon appends), so `updateVectorSketch` re-reads just the tail beyond
// what it has already consumed, keeping refresh O(changed chunks).

function popcnt32(x) {
    x -= (x >> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    x = (x + (x >> 4)) & 0x0f0f0f0f;
    return (x * 0x01010101) >> 24;
}

/** Pack a float vector's sign bits into `words` Uint32 words. */
function quantizeToBits(vec, out, base, words) {
    for (let w = 0; w < words; w++) {
        let bits = 0;
        const d0 = w * 32;
        const dMax = Math.min(d0 + 32, vec.length);
        for (let d = d0; d < dMax; d++) {
            if (vec[d] > 0) bits |= (1 << (d - d0));
        }
        out[base + w] = bits;
    }
}

/**
 * Build or incrementally extend a binary sketch of an `.embeddings.bin`.
 *
 * @param {object|null} sketch  Existing sketch to extend, or null to create.
 * @param {{fd?: number, buffer?: Buffer}} source
 * @returns {object} sketch { dim, words, n, keys[], offsets[], bits: Uint32Array,
 *                            consumed, headerCount, firstKey }
 */
export function updateVectorSketch(sketch, { fd = -1, buffer = null }) {
    const readAt = (buf, pos, len) => {
        if (buffer) return buffer.subarray(pos, pos + len);
        const b = Buffer.allocUnsafe(len);
        const r = fs.readSync(fd, b, 0, len, pos);
        return r < len ? b.subarray(0, r) : b;
    };
    const fileSize = buffer ? buffer.length : (fd >= 0 ? fs.fstatSync(fd).size : 0);
    if (fileSize < 4) return sketch;

    const headerCount = readAt(null, 0, 4).readUInt32LE(0);
    if (!sketch) {
        sketch = {
            dim: 0, words: 0, n: 0, keys: [], offsets: [],
            bits: new Uint32Array(0), consumed: 4, headerCount: 0, firstKey: null,
        };
    }
    if (fileSize <= sketch.consumed) return sketch;

    // Read the unseen tail in large blocks. No carry buffers / Buffer.concat —
    // the next block simply re-reads from the last complete entry boundary
    // (at most one partial entry of overlap), so the build leaves no transient
    // garbage behind. Sign bits are quantized straight off the block buffer.
    const CHUNK = 8 * 1024 * 1024;
    const reusable = buffer ? null : Buffer.allocUnsafe(CHUNK);
    let pos = sketch.consumed;
    while (pos < fileSize) {
        const len = Math.min(CHUNK, fileSize - pos);
        let work;
        if (buffer) {
            work = buffer.subarray(pos, pos + len);
        } else {
            const r = fs.readSync(fd, reusable, 0, len, pos);
            work = r < len ? reusable.subarray(0, r) : (len < CHUNK ? reusable.subarray(0, len) : reusable);
        }
        let off = 0;
        let parsedAny = false;
        for (;;) {
            if (off + 4 > work.length) break;
            const keyLen = work.readUInt32LE(off);
            if (off + 4 + keyLen + 4 > work.length) break;
            const dim = work.readUInt32LE(off + 4 + keyLen);
            const entryEnd = off + 4 + keyLen + 4 + dim * 4;
            if (entryEnd > work.length) break;

            const key = work.toString('utf8', off + 4, off + 4 + keyLen);
            const floatBase = off + 4 + keyLen + 4;
            if (sketch.dim === 0) {
                sketch.dim = dim;
                sketch.words = Math.ceil(dim / 32);
            }
            if (dim === sketch.dim) {
                if ((sketch.n + 1) * sketch.words > sketch.bits.length) {
                    const grown = new Uint32Array(Math.max(1024 * sketch.words, sketch.bits.length * 2));
                    grown.set(sketch.bits);
                    sketch.bits = grown;
                }
                // Quantize sign bits directly from the block buffer.
                const bitBase = sketch.n * sketch.words;
                for (let w = 0; w < sketch.words; w++) {
                    let bits = 0;
                    const d0 = w * 32;
                    const dMax = Math.min(d0 + 32, dim);
                    for (let d = d0; d < dMax; d++) {
                        if (work.readFloatLE(floatBase + d * 4) > 0) bits |= (1 << (d - d0));
                    }
                    sketch.bits[bitBase + w] = bits;
                }
                sketch.keys.push(key);
                sketch.offsets.push(pos + floatBase);
                if (sketch.firstKey === null) sketch.firstKey = key;
                sketch.n++;
            }
            off = entryEnd;
            parsedAny = true;
        }
        if (!parsedAny) break; // partial entry larger than the block — corrupt tail
        pos += off;            // resume exactly at the last complete entry boundary
        sketch.consumed = pos;
    }
    sketch.headerCount = headerCount;
    return sketch;
}

/**
 * Approximate top-N search via the sketch + exact cosine rescore from the bin.
 * Drop-in replacement for scanEmbeddingBinary (same return shape), ~20–50×
 * faster at scale.
 *
 * @returns {Array<{key: string, score: number}>} sorted by exact cosine, desc.
 */
export function searchVectorSketch(sketch, { fd = -1, buffer = null }, queryVector, {
    topN = 200, minScore = 0, oversample = 4,
} = {}) {
    if (!sketch || sketch.n === 0 || queryVector.length !== sketch.dim) return [];
    const words = sketch.words;

    // 1. Quantize the query and rank rows by Hamming distance (bounded top-M).
    const qbits = new Uint32Array(words);
    quantizeToBits(queryVector, qbits, 0, words);

    const M = Math.min(sketch.n, Math.max(topN * oversample, 64));
    const candIdx = new Int32Array(M);
    const candHam = new Int32Array(M);
    let count = 0, worst = -1;
    const bits = sketch.bits;
    for (let i = 0; i < sketch.n; i++) {
        const base = i * words;
        let ham = 0;
        for (let w = 0; w < words; w++) ham += popcnt32((bits[base + w] ^ qbits[w]) >>> 0);
        if (count >= M && ham >= worst) continue;
        // bounded insertion sort (ascending hamming)
        let lo = 0, hi = count;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (candHam[mid] <= ham) lo = mid + 1; else hi = mid; }
        const end = Math.min(count, M - 1);
        for (let j = end; j > lo; j--) { candHam[j] = candHam[j - 1]; candIdx[j] = candIdx[j - 1]; }
        candHam[lo] = ham; candIdx[lo] = i;
        if (count < M) count++;
        worst = candHam[count - 1];
    }

    // 2. Exact cosine rescore of the candidates only (pread per candidate).
    let qNorm = 0;
    for (let d = 0; d < queryVector.length; d++) qNorm += queryVector[d] * queryVector[d];
    qNorm = Math.sqrt(qNorm);
    if (qNorm === 0) return [];

    const byteLen = sketch.dim * 4;
    const raw = Buffer.allocUnsafe(byteLen);
    const scored = [];
    for (let c = 0; c < count; c++) {
        const i = candIdx[c];
        let view;
        if (buffer) {
            view = buffer.subarray(sketch.offsets[i], sketch.offsets[i] + byteLen);
            if (view.length < byteLen) continue;
        } else {
            const read = fs.readSync(fd, raw, 0, byteLen, sketch.offsets[i]);
            if (read < byteLen) continue;
            view = raw;
        }
        let dp = 0, nv = 0;
        for (let d = 0; d < sketch.dim; d++) {
            const v = view.readFloatLE(d * 4);
            dp += queryVector[d] * v;
            nv += v * v;
        }
        const n = Math.sqrt(nv);
        if (n === 0) continue;
        const score = dp / (qNorm * n);
        if (score > minScore) scored.push({ key: sketch.keys[i], score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
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

            // Eager vector population. Vectors are keyed by embeddingKeyFor(chunk)
            // (content_hash + enrichment digest); plain content_hash is the
            // backward-compatible fallback for bins written before enrichment keys.
            if (!this._lazyMode) {
                const vecKey = embeddingKeyFor(chunk);
                if (chunk.content_hash && this.embeddingCache.has(vecKey)) {
                    this.vectors.set(chunk.id, this.embeddingCache.get(vecKey));
                    // Summary-only second vector (enriched chunks): stored under a
                    // pseudo row id; searchHybrid folds hits back onto the chunk id.
                    const sVec = this.embeddingCache.get(vecKey + SUMMARY_VEC_SUFFIX);
                    if (sVec) this.vectors.set(chunk.id + SUMMARY_VEC_SUFFIX, sVec);
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
                // Eager rows include summary-only pseudo ids (`<id>|s`) — fold each
                // back onto its chunk via the shared finalizer (best score per
                // chunk, deterministic order, same cap as the disk-backed paths).
                const entries = this._searchVector(queryVector, minScore).map(r => ({
                    id: r.id.endsWith(SUMMARY_VEC_SUFFIX)
                        ? r.id.slice(0, -SUMMARY_VEC_SUFFIX.length) : r.id,
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
            calls: c.calls || [], params: c.params || [],
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
        if (this._lazyMode) {
            let n = 0;
            for (const k of this._vecOffsets.keys()) if (!k.endsWith(SUMMARY_VEC_SUFFIX)) n++;
            return n;
        }
        let n = 0;
        for (const k of this.vectors.keys()) if (!k.endsWith(SUMMARY_VEC_SUFFIX)) n++;
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
