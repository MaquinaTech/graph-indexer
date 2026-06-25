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
 *   findReferers(symbol)                     → chunk[]   (type_refs / extends matches)
 *   getEdges(chunkId, {kind?, direction})    → edge[]    (A4 resolved symbol graph; [] when off)
 *   findRoutes({method, pathPrefix})         → route[]   (HTTP route → handler chunk)
 *   iterateChunks()                          → Iterable<chunk>  (cursor on SQLite)
 *   getDependencies(path) / getImportedBy(path) → string[]
 *   chunkCount() / fileCount() / symbolCount() / vectorCount() → number
 *   stats()                                  → engine health facts
 *   close()                                  Release fds / db handles.
 */
import fs from 'fs';
import { MemoryGraphIndex } from './engine/memory.mjs';

// 'auto' storage keeps the index in memory until a repo is large enough that the
// disk-backed SQLite store earns its slightly higher per-query latency. The indexer
// decides by the real chunk count it just built; readers decide by which artifact
// exists on disk (see resolveBackend).
export const AUTO_SQLITE_CHUNK_THRESHOLD = 15000;

/**
 * Resolve the abstract storage setting ('auto'|'memory'|'sqlite') to a concrete
 * read backend. Explicit settings win; 'auto' picks SQLite when a SQLite artifact
 * is present (the indexer writes one only for large repos and removes the other
 * backend's artifact, so presence is unambiguous), else the in-memory JSON index.
 *
 * @param {object} config  Resolved config from config.mjs.
 * @returns {'memory'|'sqlite'}
 */
export function resolveBackend(config) {
    if (config.storage === 'sqlite') return 'sqlite';
    if (config.storage === 'memory') return 'memory';
    try { if (fs.existsSync(config.sqlitePath)) return 'sqlite'; } catch { /* fall through to memory */ }
    return 'memory';
}

/**
 * Construct (but do not yet load) the configured store.
 *
 * @param {object}  config                 Resolved config from config.mjs.
 * @param {object}  [opts]
 * @param {boolean} [opts.cacheEmbeddings] Eager vector cache (in-memory backend only).
 * @returns {Promise<object>} a store implementing the contract above.
 */
export async function createStore(config, { cacheEmbeddings = false } = {}) {
    if (resolveBackend(config) === 'sqlite') {
        // Imported lazily so the default path never loads node:sqlite.
        const { SqliteGraphStore } = await import('./engine/sqlite.mjs');
        return new SqliteGraphStore(config.sqlitePath, { embeddingPath: config.embeddingPath });
    }
    return new MemoryGraphIndex(config.indexPath, { cacheEmbeddings });
}
