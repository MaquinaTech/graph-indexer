/**
 * @file engine/binary.mjs
 * @description Dense-embedding binary codec (`.embeddings.bin` read/write/append/scan),
 *              the optional HNSW vector index, and the approximate sketch search used
 *              for large corpora — plus the thresholds that select eager vs lazy access.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';

export const HNSW_THRESHOLD = 5000;      // Build HNSW index above this (eager mode only)
export const LAZY_VEC_THRESHOLD = 10000; // Switch to lazy (disk-backed) vector access above this
export const SKETCH_THRESHOLD = 10000;   // Build the binary-quantized sketch above this many VECTORS.
                                         // Single-sourced so the memory and SQLite stores switch to
                                         // the approximate sketch at the exact same point (parity).

export let HierarchicalNSW = null;
try {
    const mod = await import('hnswlib-node');
    HierarchicalNSW = mod.HierarchicalNSW ?? mod.default?.HierarchicalNSW ?? null;
} catch { /* not installed — flat scan used */ }

/** Format per entry: [uint32 hashLen][utf8 hash][uint32 dim][float32 × dim] */
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

    const top = [];
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
// ordering well enough that a 4× oversampled rescore returns a NEAR-EXACT head:
// at the production topN (400) the consumed top-5/top-10 overlap the exhaustive
// scan ~95% (rank-1 parity is asserted in test/unit.mjs). Full top-N recall is
// APPROXIMATE — the tail past the consumed head can differ — which is the
// bounded-RAM, sub-linear trade the sketch exists to make.
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
        let lo = 0, hi = count;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (candHam[mid] <= ham) lo = mid + 1; else hi = mid; }
        const end = Math.min(count, M - 1);
        for (let j = end; j > lo; j--) { candHam[j] = candHam[j - 1]; candIdx[j] = candIdx[j - 1]; }
        candHam[lo] = ham; candIdx[lo] = i;
        if (count < M) count++;
        worst = candHam[count - 1];
    }

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
