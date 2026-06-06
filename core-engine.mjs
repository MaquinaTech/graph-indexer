/**
 * @file core-engine.mjs
 * @description In-Memory Graph Indexer Core Engine.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 * Copyright (c) 2026 MaquinaTech. All rights reserved.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright
 * notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 */
import fs from 'fs';

export const EMBEDDING_CONTEXT_LIMIT = 8000;

// Optional HNSW accelerator for large corpora (≥ HNSW_THRESHOLD vectors).
// Falls back silently to exact flat scan if the package is not installed.
const HNSW_THRESHOLD = 5000;
let HierarchicalNSW = null;
try {
    const mod = await import('hnswlib-node');
    HierarchicalNSW = mod.HierarchicalNSW ?? mod.default?.HierarchicalNSW ?? null;
} catch { /* not installed — flat scan will be used */ }

export function truncateForEmbedding(text) {
    return text.length > EMBEDDING_CONTEXT_LIMIT ? text.slice(0, EMBEDDING_CONTEXT_LIMIT) : text;
}

export function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function tokenize(text) {
    if (!text) return [];
    const rawTokens = text.split(/[\s\W_]+/);
    const tokens = [];

    for (const word of rawTokens) {
        if (word.length < 2) continue; // Skip very short tokens (e.g., single letters)
        tokens.push(word.toLowerCase());

        // Split CamelCase and PascalCase into parts
        // E.g.: "TripList" -> "Trip", "List" -> "trip", "list"
        // E.g.: "useTripsPage" -> "use", "Trips", "Page" -> "use", "trips", "page"
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
 * Serializes an embeddingCache (Map<hash,Float32Array> or plain object {hash:number[]})
 * to a compact binary buffer. Format per entry:
 *   [uint32 hashLen][utf8 hash][uint32 dim][float32 * dim]
 * The buffer is ~4.8× smaller than JSON float text.
 */
export function writeEmbeddingBinary(embeddingCache) {
    const entries = embeddingCache instanceof Map
        ? Array.from(embeddingCache.entries())
        : Object.entries(embeddingCache);
    let size = 4; // count header
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
    constructor(indexPath, { rrfK = 60 } = {}) {
        this.indexPath = indexPath;
        this.chunks = new Map();
        this.vectors = new Map();
        this.graph = { dependencies: {}, importedBy: {} };
        this.embeddingCache = new Map();
        this.rrfK = rrfK;
        this.docCount = 0;
        this.df = new Map();
        this.tf = new Map();
        this._saveTimer = null;
        // Flat vector matrix for O(N·d) exact cosine search — no N-API overhead
        this._matrixDirty = true;
        this._vecMatrix = null;   // Float32Array(N × dim)
        this._vecNorms = null;    // Float32Array(N) — pre-computed L2 norms
        this._vecIds = [];        // string[N] — row-index → chunk-id lookup
        this._dim = 0;
        this._hnsw = null;        // HierarchicalNSW instance (optional large-repo accelerator)
        this._embeddingPath = indexPath.replace(/\.json$/, '.embeddings.bin');
    }

    load() {
        if (!fs.existsSync(this.indexPath)) return;
        const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
        this.graph = data.graph || { dependencies: {}, importedBy: {} };

        // Prefer binary sidecar (~4.8× smaller); fall back to JSON embeddingCache for old indexes
        if (fs.existsSync(this._embeddingPath)) {
            this._loadEmbeddingBinary(fs.readFileSync(this._embeddingPath));
        } else {
            for (const [hash, vec] of Object.entries(data.embeddingCache || {})) {
                this.embeddingCache.set(hash, new Float32Array(vec));
            }
        }

        for (const chunk of data.chunks) {
            this.chunks.set(chunk.id, chunk);
            if (chunk.content_hash && this.embeddingCache.has(chunk.content_hash)) {
                this.vectors.set(chunk.id, this.embeddingCache.get(chunk.content_hash));
            } else if (chunk.embedding) {
                const vec = new Float32Array(chunk.embedding);
                this.vectors.set(chunk.id, vec);
                if (chunk.content_hash) this.embeddingCache.set(chunk.content_hash, vec);
            }

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
                chunk.code_snippet
            ].join(' ');
            this._indexLexical(chunk.id, enrichedContext, chunk.file_path);
        }
    }

    _indexLexical(chunkId, text, filePath = '') {
        const tokens = tokenize(text);
        if (tokens.length === 0) return;

        const termCounts = new Map();
        for (const token of tokens) {
            termCounts.set(token, (termCounts.get(token) || 0) + 1);
        }

        const tfMap = new Map();
        for (const [term, count] of termCounts.entries()) {
            tfMap.set(term, 1 + Math.log(count));
            this.df.set(term, (this.df.get(term) || 0) + 1);
        }

        // 🥇 FILENAME TOKEN BOOST: Add file path tokens with fixed TF weight 1.0 (not sublinear)
        // Splits on /, -, _, ., CamelCase so "authStore.ts" → ["auth", "store", "ts", "authstore"]
        if (filePath) {
            const fileTokens = tokenize(filePath.replace(/[\/\-_.]/g, ' '));
            for (const token of fileTokens) {
                if (!tfMap.has(token)) {
                    // Only add if not already from the body (avoids double-counting)
                    tfMap.set(token, 1.0);
                    this.df.set(token, (this.df.get(token) || 0) + 1);
                }
            }
        }

        this.tf.set(chunkId, tfMap);
        this.docCount++;
    }

    _removeLexical(chunkId) {
        const tfMap = this.tf.get(chunkId);
        if (!tfMap) return;
        for (const term of tfMap.keys()) {
            const freq = this.df.get(term);
            if (freq === undefined) continue;
            if (freq <= 1) this.df.delete(term);
            else this.df.set(term, freq - 1);
        }
        this.tf.delete(chunkId);
        this.docCount = Math.max(0, this.docCount - 1);
    }

    _searchLexical(queryText) {
        const queryTokens = tokenize(queryText);
        const scores = new Map();
        for (const token of queryTokens) {
            const docFreq = this.df.get(token);
            if (!docFreq) continue;
            const idf = Math.log(this.docCount / docFreq);
            for (const [chunkId, tfMap] of this.tf.entries()) {
                const tf = tfMap.get(token);
                if (tf) scores.set(chunkId, (scores.get(chunkId) || 0) + tf * idf);
            }
        }
        return Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([id, score], rank) => ({ id, score, rank: rank + 1 }));
    }

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
            this._vecMatrix = null;
            this._vecNorms = null;
            this._dim = 0;
            this._hnsw = null;
            this._matrixDirty = false;
            return;
        }
        const dim = this.vectors.get(ids[0]).length;
        this._dim = dim;
        const matrix = new Float32Array(n * dim);
        const norms = new Float32Array(n);
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
        this._vecNorms = norms;
        this._matrixDirty = false;

        // Build HNSW index for large corpora when library is available
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
                process.stderr.write(`[core-engine] HNSW build failed, using flat scan: ${e.message}\n`);
                this._hnsw = null;
            }
        }
    }

    _searchVector(queryVector, minScore = 0.3) {
        if (this.vectors.size === 0) return [];
        if (this._matrixDirty) this._rebuildMatrix();
        if (!this._vecMatrix) return [];
        if (queryVector.length !== this._dim) return [];

        const n = this._vecIds.length;
        const dim = this._dim;

        // Pre-compute query L2 norm once
        let qNorm = 0;
        for (let d = 0; d < dim; d++) qNorm += queryVector[d] * queryVector[d];
        qNorm = Math.sqrt(qNorm);
        if (qNorm === 0) return [];

        // Large-corpus fast path: approximate nearest-neighbour via HNSW
        if (this._hnsw) {
            const topK = Math.min(200, n);
            try {
                const qArr = Array.isArray(queryVector) ? queryVector : Array.from(queryVector);
                const { neighbors, distances } = this._hnsw.searchKnn(qArr, topK);
                const results = [];
                for (let i = 0; i < neighbors.length; i++) {
                    const score = 1 - distances[i]; // cosine distance → similarity
                    if (score > minScore) results.push({ id: this._vecIds[neighbors[i]], score, rank: i + 1 });
                }
                return results;
            } catch {
                // HNSW search failed; fall through to exact flat scan
            }
        }

        // Exact brute-force flat scan — O(N·d), no marshalling overhead
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

    searchHybrid(queryText, queryVector, topK = 5, minScore = 0.3, exactBoostName = null) {
        const lexicalResults = this._searchLexical(queryText);
        const vectorResults = queryVector ? this._searchVector(queryVector, minScore) : [];
        const rrfScores = new Map();
        const K = this.rrfK;

        const queryLower = queryText.toLowerCase();

        // 🥇 FILENAME PATH BOOST: when Ollama offline (no vectors), boost chunks from
        // files whose path contains a token from the query (e.g. "auth middleware" → authStore.ts)
        const vectorEmpty = vectorResults.length === 0;
        const queryFileTokens = vectorEmpty
            ? queryLower.split(/[\s\W_]+/).filter(t => t.length >= 3)
            : [];

        // Weighted RRF: lexical weight 1.5×, vector weight 1.0×
        // Keeps semantic lift without drowning precise TF-IDF matches.
        const LEXICAL_WEIGHT = 1.5;
        const VECTOR_WEIGHT = 1.0;

        const allResults = [
            ...vectorResults.map(r => ({ ...r, _w: VECTOR_WEIGHT })),
            ...lexicalResults.map(r => ({ ...r, _w: LEXICAL_WEIGHT })),
        ];

        for (const { id, rank, _w } of allResults) {
            let baseScore = (_w ?? 1.0) / (K + rank);
            const chunk = this.chunks.get(id);
            if (!chunk) continue;

            // Generic: demote test/spec files when the query is not about tests.
            // Catches: foo.test.js, foo.spec.js, __tests__/foo.js, foo_test.go,
            //          test/foo.js, tests/foo.js, spec/foo.js (plain test dirs).
            if (/\.(test|spec)\.|[/\\]__tests__[/\\]|_test\.|^tests?[/\\]|[/\\]tests?[/\\]|[/\\]spec[/\\]/.test(chunk.file_path)) {
                if (!queryLower.includes('test') && !queryLower.includes('spec')) baseScore *= 0.25;
            }
            // Demote example/sample/demo/docs directories — prefer canonical lib/src definitions
            if (/^examples?[/\\]|[/\\]examples?[/\\]|^samples?[/\\]|[/\\]samples?[/\\]|^demos?[/\\]|[/\\]demos?[/\\]|^docs?_?src[/\\]|[/\\]docs?_?src[/\\]|^docs?[/\\]|[/\\]tutorials?[/\\]/.test(chunk.file_path)) {
                baseScore *= 0.5;
            }
            // Prefer definitions (functions/classes/impls) over pure usage/expression sites
            if (chunk.node_type === 'expression_statement' || chunk.node_type === 'call_expression') {
                baseScore *= 0.8;
            }

            // Filename path boost when no vectors available.
            // Also checks if any query token is a prefix of a path segment (≥4 chars),
            // so "initialise" matches "init.js", "decorator" matches "decorators/", etc.
            if (vectorEmpty && queryFileTokens.length > 0) {
                const filePathLower = chunk.file_path.toLowerCase();
                const hasExact = queryFileTokens.some(t => filePathLower.includes(t));
                const hasPrefix = !hasExact && queryFileTokens.some(t =>
                    t.length >= 4 && filePathLower.split(/[/\\._-]/).some(seg => seg.startsWith(t.slice(0, 5)))
                );
                if (hasExact) baseScore *= 1.5;
                else if (hasPrefix) baseScore *= 1.25;
            }

            // Name-exact-token boost (applies in both lexical and hybrid mode):
            // If the chunk name exactly matches any significant query token (≥4 chars),
            // give it an extra 1.4× lift. This promotes WriteJSON over WriteContentType
            // when the query contains "JSON", and GET/POST/Handle over GetPostForm.
            if (chunk.name) {
                const nameLower = chunk.name.toLowerCase();
                const queryTokensAll = queryLower.split(/[\s\W_]+/).filter(t => t.length >= 4);
                if (queryTokensAll.some(t => nameLower === t || nameLower.endsWith('.' + t))) {
                    baseScore *= 1.4;
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

    async save() {
        const chunksData = Array.from(this.chunks.values()).map(c => ({
            id: c.id, file_path: c.file_path, node_type: c.node_type,
            name: c.name, docstring: c.docstring || '', code_snippet: c.code_snippet,
            content_hash: c.content_hash, start_line: c.start_line, end_line: c.end_line,
            calls: c.calls || [],
            params: c.params || [], return_type: c.return_type || '', class_context: c.class_context || ''
        }));
        // Embeddings go to a compact binary sidecar — NOT in the JSON payload
        const payload = JSON.stringify({ chunks: chunksData, graph: this.graph });
        const tmpPath = `${this.indexPath}.tmp`;
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
}