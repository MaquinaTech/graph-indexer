/**
 * @file core-engine.mjs
 * @description In-Memory Graph Indexer Core Engine.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';

// Maximum character length for embedding API prompts.
// Prevents HTTP 400 errors from local Ollama instances with strict context limits.
export const EMBEDDING_CONTEXT_LIMIT = 8000;

/** Safely truncate text to the embedding context window before an API call. */
export function truncateForEmbedding(text) {
    return text.length > EMBEDDING_CONTEXT_LIMIT ? text.slice(0, EMBEDDING_CONTEXT_LIMIT) : text;
}

// V8-optimized cosine similarity using typed arrays for SIMD-friendly memory layout
export function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Native lexical tokenizer (Zero dependencies)
function tokenize(text) {
    // Lowercase, extract alphanumeric words > 2 characters
    return text.toLowerCase().split(/[\s\W_]+/).filter(w => w.length > 2);
}

export class MemoryGraphIndex {
    /**
     * @param {string} indexPath - Absolute path to the code-index.json persistence file.
     * @param {object} [options]
     * @param {number} [options.rrfK=60] - Reciprocal Rank Fusion constant K.
     *   The RRF paper (Cormack et al., 2009) recommends K=60 as the stabilizing
     *   constant. Higher K smooths rank differences; lower K amplifies top-rank
     *   advantages. K=60 is the well-validated default for mixed retrieval tasks.
     */
    constructor(indexPath, { rrfK = 60 } = {}) {
        this.indexPath = indexPath;
        this.chunks = new Map();
        this.vectors = new Map();
        this.graph = { dependencies: {}, importedBy: {} };

        // Reciprocal Rank Fusion constant — tunable per corpus characteristics
        this.rrfK = rrfK;

        // TF-IDF Lexical structures
        this.docCount = 0;
        this.df = new Map(); // Document Frequency: term → count of chunks containing it
        this.tf = new Map(); // Term Frequency: chunkId → Map(term → sublinear_tf_weight)

        // Timer handle for saveDebounced()
        this._saveTimer = null;
    }

    load() {
        if (!fs.existsSync(this.indexPath)) return;
        const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
        this.graph = data.graph || { dependencies: {}, importedBy: {} };

        for (const chunk of data.chunks) {
            this.chunks.set(chunk.id, chunk);
            if (chunk.embedding) {
                this.vectors.set(chunk.id, new Float32Array(chunk.embedding));
            }
            this._indexLexical(chunk.id, chunk.code_snippet);
        }
    }

    /**
     * Add a chunk to the TF-IDF inverted index.
     *
     * Uses sublinear TF scaling: weight = 1 + log(raw_count)
     * This compresses the dynamic range of term frequencies, preventing
     * high-frequency but low-information tokens (e.g., `return`, `const`)
     * from overwhelming semantically rich but less-repeated identifiers.
     */
    _indexLexical(chunkId, text) {
        const tokens = tokenize(text);
        if (tokens.length === 0) return;

        const termCounts = new Map();
        for (const token of tokens) {
            termCounts.set(token, (termCounts.get(token) || 0) + 1);
        }

        const tfMap = new Map();
        for (const [term, count] of termCounts.entries()) {
            // Sublinear TF scaling: 1 + log(count) instead of raw count/total
            tfMap.set(term, 1 + Math.log(count));
            this.df.set(term, (this.df.get(term) || 0) + 1);
        }

        this.tf.set(chunkId, tfMap);
        this.docCount++;
    }

    /**
     * Remove a chunk from the TF-IDF inverted index.
     *
     * Prevents memory leaks during incremental index updates (file saves/deletes).
     * Decrements document frequency for each term the chunk contributed;
     * fully removes term entries when their document frequency reaches zero.
     */
    _removeLexical(chunkId) {
        const tfMap = this.tf.get(chunkId);
        if (!tfMap) return;

        for (const term of tfMap.keys()) {
            const freq = this.df.get(term);
            if (freq === undefined) continue;
            if (freq <= 1) {
                this.df.delete(term); // Prune orphaned term entry to reclaim memory
            } else {
                this.df.set(term, freq - 1);
            }
        }

        this.tf.delete(chunkId);
        this.docCount = Math.max(0, this.docCount - 1);
    }

    /** Pure lexical search using TF-IDF with sublinear term frequencies. */
    _searchLexical(queryText) {
        const queryTokens = tokenize(queryText);
        const scores = new Map();

        for (const token of queryTokens) {
            const docFreq = this.df.get(token);
            if (!docFreq) continue;

            // IDF = log(N / df): penalizes terms appearing in many chunks
            const idf = Math.log(this.docCount / docFreq);

            for (const [chunkId, tfMap] of this.tf.entries()) {
                const tf = tfMap.get(token); // Pre-scaled sublinear weight from _indexLexical
                if (tf) {
                    scores.set(chunkId, (scores.get(chunkId) || 0) + tf * idf);
                }
            }
        }

        return Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([id, score], rank) => ({ id, score, rank: rank + 1 }));
    }

    /** Pure vector search using cosine similarity. */
    _searchVector(queryVector, minScore = 0.3) {
        const qVec = new Float32Array(queryVector);
        const results = [];

        for (const [id, vec] of this.vectors.entries()) {
            const score = cosineSimilarity(qVec, vec);
            if (score > minScore) results.push({ id, score });
        }

        return results
            .sort((a, b) => b.score - a.score)
            .map((item, rank) => ({ ...item, rank: rank + 1 }));
    }

    /**
     * Hybrid search using Reciprocal Rank Fusion (RRF).
     *
     * RRF Formula:  score(d) = Σᵢ  1 / (K + rankᵢ(d))
     *
     * Merges vector and lexical result lists by rank position rather than raw
     * scores, making it robust to differing score scales (cosine vs TF-IDF).
     * Degrades gracefully to pure TF-IDF when queryVector is null (e.g., when
     * Ollama is unavailable).
     *
     * @param {string} queryText - The search query.
     * @param {number[]|null} queryVector - Pre-computed query embedding (null = lexical-only mode).
     * @param {number} topK - Number of top results to return.
     * @param {number} minScore - Minimum cosine similarity threshold.
     * @param {string|null} exactBoostName - Exact function/class name to boost.
     *   Chunks whose `name` exactly matches this string receive an additional
     *   1/(K+1) RRF boost — equivalent to a rank-1 hit in a third virtual result
     *   list — prioritising named-symbol lookups without breaking fusion math.
     */
    searchHybrid(queryText, queryVector, topK = 5, minScore = 0.3, exactBoostName = null) {
        const lexicalResults = this._searchLexical(queryText);
        const vectorResults = queryVector ? this._searchVector(queryVector, minScore) : [];

        const rrfScores = new Map();
        const K = this.rrfK;

        // Accumulate vector ranks
        for (const { id, rank } of vectorResults) {
            rrfScores.set(id, (rrfScores.get(id) || 0) + 1 / (K + rank));
        }

        // Accumulate lexical ranks
        for (const { id, rank } of lexicalResults) {
            rrfScores.set(id, (rrfScores.get(id) || 0) + 1 / (K + rank));
        }

        // Exact-name boost: applied after both lists merge to preserve RRF integrity.
        // Adds 1/(K+1) — the maximum possible single-list contribution — for any
        // chunk whose name exactly matches the provided token.
        if (exactBoostName) {
            const boostTerm = exactBoostName.toLowerCase().trim();
            for (const [id, chunk] of this.chunks.entries()) {
                if (chunk.name && chunk.name.toLowerCase() === boostTerm) {
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

    /**
     * Atomically persist the index to disk using non-blocking async I/O.
     *
     * Write-to-tmp-then-rename pattern guarantees zero data corruption:
     * the OS rename syscall is atomic, so readers always see a complete valid file.
     */
    async save() {
        const chunksData = Array.from(this.chunks.values()).map(c => ({
            ...c,
            embedding: this.vectors.has(c.id) ? Array.from(this.vectors.get(c.id)) : null
        }));

        const payload = JSON.stringify({ chunks: chunksData, graph: this.graph });
        const tmpPath = `${this.indexPath}.tmp`;
        await fs.promises.writeFile(tmpPath, payload);
        await fs.promises.rename(tmpPath, this.indexPath);
    }

    /**
     * Debounced save: batches rapid consecutive writes into a single disk flush.
     *
     * Prevents event-loop saturation during IDE auto-save bursts (multiple files
     * saved in quick succession) by coalescing all writes within the delay window
     * into one async save at the end of the quiet period.
     *
     * @param {number} delayMs - Debounce window in milliseconds (default: 3000ms).
     */
    saveDebounced(delayMs = 3000) {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(async () => {
            this._saveTimer = null;
            try {
                await this.save();
            } catch (err) {
                process.stderr.write(`[core-engine] ❌ Async save failed: ${err.message}\n`);
            }
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
            if (!this.graph.importedBy[dep].includes(filePath)) {
                this.graph.importedBy[dep].push(filePath);
            }
        }
    }
}