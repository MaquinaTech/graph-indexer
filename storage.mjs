/**
 * @file storage.mjs
 * @description Storage backend factory. Selects the in-memory engine (default,
 *              zero-dependency), the disk-backed SQLite store, or the external
 *              PostgreSQL store based on config, and documents the single
 *              contract that the MCP tools depend on so they remain
 *              backend-agnostic.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 *
 * ── Store contract (MemoryGraphIndex, SqliteGraphStore, PostgresGraphStore) ──
 *   load()                                   Prepare for queries (open db / parse json).
 *                                            May return a Promise — always await it.
 *   get backend()                            'memory' | 'sqlite' | 'postgres'.
 *   get graph()                              { dependencies, importedBy } (file-level).
 *   searchHybrid(q, vec, topK, minScore, exactBoost) → [{ score, chunk }]   (synchronous —
 *                                            ranking runs on local state on every backend)
 *   getChunk(id)                             → chunk | null
 *   getChunksByFile(path)                    → chunk[]
 *   resolveSymbol(name)                      → chunk[]   (exact, case-insensitive)
 *   findCallers(funcName)                    → chunk[]
 *   iterateChunks()                          → Iterable<chunk>  (cursor on SQLite)
 *   getDependencies(path) / getImportedBy(path) → string[]
 *   chunkCount() / fileCount() / symbolCount() / vectorCount() → number
 *   stats()                                  → engine health facts
 *   applyFileUpdate(path, payload)           Replace one file's chunks (daemon write path).
 *                                            May return a Promise — always await it.
 *   close()                                  Release fds / db handles / connections.
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
    if (config.storage === 'postgres') {
        // Imported lazily so the default path never loads the optional pg driver.
        const { PostgresGraphStore } = await import('./postgres-store.mjs');
        return new PostgresGraphStore(config.postgres);
    }
    return new MemoryGraphIndex(config.indexPath, { cacheEmbeddings });
}
