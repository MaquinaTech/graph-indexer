/**
 * @file storage.mjs
 * @description Storage backend factory. Selects the in-memory engine (default,
 *              zero-dependency) or the disk-backed SQLite store based on config,
 *              and documents the single read contract that the MCP tools depend
 *              on so they remain backend-agnostic.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 *
 * ── Store contract (implemented by both MemoryGraphIndex and SqliteGraphStore) ──
 *   load()                                   Prepare for queries (open db / parse json).
 *   get backend()                            'memory' | 'sqlite'.
 *   get graph()                              { dependencies, importedBy } (file-level).
 *   searchHybrid(q, vec, topK, minScore, exactBoost) → [{ score, chunk }]
 *   getChunk(id)                             → chunk | null
 *   getChunksByFile(path)                    → chunk[]
 *   resolveSymbol(name)                      → chunk[]   (exact, case-insensitive)
 *   findCallers(funcName)                    → chunk[]
 *   iterateChunks()                          → Iterable<chunk>  (cursor on SQLite)
 *   getDependencies(path) / getImportedBy(path) → string[]
 *   chunkCount() / fileCount() / symbolCount() / vectorCount() → number
 *   stats()                                  → engine health facts
 *   close()                                  Release fds / db handles.
 */
import { MemoryGraphIndex } from './core-engine.mjs';

/**
 * Construct (but do not yet load) the configured store.
 *
 * @param {object}  config                 Resolved config from config.mjs.
 * @param {object}  [opts]
 * @param {boolean} [opts.cacheEmbeddings] Eager vector cache (in-memory backend only).
 * @returns {Promise<object>} a store implementing the contract above.
 */
export async function createStore(config, { cacheEmbeddings = false } = {}) {
    if (config.storage === 'sqlite') {
        // Imported lazily so the default path never loads node:sqlite.
        const { SqliteGraphStore } = await import('./sqlite-store.mjs');
        return new SqliteGraphStore(config.sqlitePath, { embeddingPath: config.embeddingPath });
    }
    return new MemoryGraphIndex(config.indexPath, { cacheEmbeddings });
}
