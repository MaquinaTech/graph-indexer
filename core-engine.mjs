import fs from 'fs';

// Optimización V8 para similitud vectorial
export function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Tokenizador Léxico Nativo (Cero Dependencias)
function tokenize(text) {
    // Convierte a minúsculas, extrae palabras alfanuméricas mayores a 2 caracteres
    return text.toLowerCase().split(/[\s\W_]+/).filter(w => w.length > 2);
}

export class MemoryGraphIndex {
    constructor(indexPath) {
        this.indexPath = indexPath;
        this.chunks = new Map();
        this.vectors = new Map();
        this.graph = { dependencies: {}, importedBy: {} };

        // Estructuras Léxicas (TF-IDF)
        this.docCount = 0;
        this.df = new Map(); // Frecuencia de Documento (Término -> Cantidad de chunks que lo contienen)
        this.tf = new Map(); // Frecuencia de Término (ChunkId -> Map(Término -> Frecuencia))
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

    // Indexación Léxica Incremental
    _indexLexical(chunkId, text) {
        const tokens = tokenize(text);
        if (tokens.length === 0) return;

        const termCounts = new Map();
        for (const token of tokens) {
            termCounts.set(token, (termCounts.get(token) || 0) + 1);
        }

        const tfMap = new Map();
        for (const [term, count] of termCounts.entries()) {
            tfMap.set(term, count / tokens.length); // Term Frequency
            this.df.set(term, (this.df.get(term) || 0) + 1); // Document Frequency
        }

        this.tf.set(chunkId, tfMap);
        this.docCount++;
    }

    // Búsqueda Léxica Pura (TF-IDF)
    _searchLexical(queryText) {
        const queryTokens = tokenize(queryText);
        const scores = new Map();

        for (const token of queryTokens) {
            const docFreq = this.df.get(token);
            if (!docFreq) continue;

            // Inverse Document Frequency
            const idf = Math.log(this.docCount / docFreq);

            for (const [chunkId, tfMap] of this.tf.entries()) {
                const tf = tfMap.get(token);
                if (tf) {
                    const currentScore = scores.get(chunkId) || 0;
                    scores.set(chunkId, currentScore + (tf * idf));
                }
            }
        }

        return Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([id, score], rank) => ({ id, score, rank: rank + 1 }));
    }

    // Búsqueda Vectorial Pura
    _searchVector(queryVector) {
        const qVec = new Float32Array(queryVector);
        const results = [];

        for (const [id, vec] of this.vectors.entries()) {
            const score = cosineSimilarity(qVec, vec);
            if (score > 0.3) results.push({ id, score });
        }

        return results
            .sort((a, b) => b.score - a.score)
            .map((item, rank) => ({ ...item, rank: rank + 1 }));
    }

    // Búsqueda Híbrida usando RRF (Reciprocal Rank Fusion)
    searchHybrid(queryText, queryVector, topK = 5) {
        const lexicalResults = this._searchLexical(queryText);
        const vectorResults = this._searchVector(queryVector);

        const rrfScores = new Map();
        const RRF_K = 60; // Constante de estabilización estándar

        // Fusionar ranks vectoriales
        for (const { id, rank } of vectorResults) {
            rrfScores.set(id, 1 / (RRF_K + rank));
        }

        // Fusionar ranks léxicos
        for (const { id, rank } of lexicalResults) {
            const currentRRF = rrfScores.get(id) || 0;
            rrfScores.set(id, currentRRF + (1 / (RRF_K + rank)));
        }

        // Recuperar y ordenar los chunks finales
        const finalResults = Array.from(rrfScores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, topK)
            .map(([id, rrfScore]) => ({
                score: rrfScore,
                chunk: this.chunks.get(id)
            }));

        return finalResults;
    }

    save() {
        const chunksData = Array.from(this.chunks.values()).map(c => ({
            ...c,
            embedding: this.vectors.has(c.id) ? Array.from(this.vectors.get(c.id)) : null
        }));

        const payload = JSON.stringify({ chunks: chunksData, graph: this.graph });
        const tmpPath = `${this.indexPath}.tmp`;
        fs.writeFileSync(tmpPath, payload);
        fs.renameSync(tmpPath, this.indexPath);
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