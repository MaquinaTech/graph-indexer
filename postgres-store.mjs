/**
 * @file postgres-store.mjs
 * @description External-database backend: the index lives in PostgreSQL so it
 *              can be shared across machines and survive ephemeral checkouts.
 *
 *              Design: PostgresGraphStore extends MemoryGraphIndex and answers
 *              every query from the same in-memory structures the default
 *              engine uses — Postgres is the system of record, not the query
 *              engine. load() pulls chunks, the dependency graph and the
 *              vectors into RAM through the exact ingest path of the in-memory
 *              engine, which makes ranking parity with the other backends true
 *              BY CONSTRUCTION (identical floats, identical fusion, identical
 *              tie-breaks) instead of something a SQL reimplementation would
 *              have to chase. pgvector is deliberately not used: an ANN index
 *              is approximate and its C float math differs from the engine's
 *              double-precision cosine at near-tie precision — either would
 *              break the deterministic cross-backend ranking guarantee.
 *
 *              Writes are incremental and live: applyFileUpdate() commits one
 *              file's rows in a single transaction and fires NOTIFY, which a
 *              long-running MCP server consumes (LISTEN) to reload — the same
 *              freshness model the SQLite backend gets from PRAGMA data_version.
 *
 *              The `pg` driver is an optional dependency, imported lazily so
 *              the default backends never require it. Connection resolution
 *              (config.mjs): GRAPH_INDEXER_PG_URL > DATABASE_URL >
 *              `postgres.url` in .graph-indexer.json > the driver's native
 *              PGHOST/PGUSER/PGPASSWORD/PGDATABASE variables.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { MemoryGraphIndex } from './core-engine.mjs';

const CHANGE_CHANNEL = 'graph_indexer_changed';
const INSERT_BATCH = 200; // rows per multi-value INSERT during a full build

/** Float32 vector → little-endian bytes (matches the .embeddings.bin layout). */
export function vectorToBytes(vec) {
    const buf = Buffer.allocUnsafe(vec.length * 4);
    for (let d = 0; d < vec.length; d++) buf.writeFloatLE(vec[d], d * 4);
    return buf;
}

/** Little-endian bytes → Float32Array. */
export function bytesToVector(buf, dim) {
    const vec = new Float32Array(dim);
    for (let d = 0; d < dim; d++) vec[d] = buf.readFloatLE(d * 4);
    return vec;
}

export class PostgresGraphStore extends MemoryGraphIndex {
    /**
     * @param {object} [conn]
     * @param {string} [conn.url]     Connection string ('' → pg native PG* env vars).
     * @param {string} [conn.schema]  Schema holding the index tables.
     * @param {object} [opts]
     * @param {number} [opts.rrfK]
     * @param {() => Promise<object>} [opts.poolFactory]  Injectable pool (tests).
     */
    constructor({ url = '', schema = 'graph_indexer' } = {}, { rrfK = 60, poolFactory = null } = {}) {
        super('', { rrfK, cacheEmbeddings: true });
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
            throw new Error(`Invalid PostgreSQL schema name '${schema}'.`);
        }
        this._url = url;
        this._schema = schema;
        this._poolFactory = poolFactory;
        this._pool = null;
        this._listenClient = null;
        this._meta = {};
    }

    get backend() { return 'postgres'; }

    /** Value of one index-level meta row (e.g. 'built_at', 'embed_provider'). */
    getMeta(key) { return this._meta[key]; }

    // ─── Connection / schema ───────────────────────────────────────────────────

    async _connect() {
        if (this._pool) return;
        if (this._poolFactory) {
            this._pool = await this._poolFactory();
        } else {
            let pgMod;
            try {
                pgMod = await import('pg');
            } catch {
                throw new Error(
                    "the PostgreSQL backend requires the optional 'pg' package — run `npm install pg`."
                );
            }
            const { Pool } = pgMod.default ?? pgMod;
            this._pool = new Pool(this._url ? { connectionString: this._url } : {});
        }
        await this._ensureSchema();
    }

    _t(table) { return `"${this._schema}"."${table}"`; }

    async _ensureSchema() {
        const q = (sql) => this._pool.query(sql);
        await q(`CREATE SCHEMA IF NOT EXISTS "${this._schema}"`);
        await q(`CREATE TABLE IF NOT EXISTS ${this._t('chunks')} (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, data JSONB NOT NULL)`);
        await q(`CREATE INDEX IF NOT EXISTS gi_chunks_file ON ${this._t('chunks')} (file_path)`);
        await q(`CREATE TABLE IF NOT EXISTS ${this._t('vectors')} (key TEXT PRIMARY KEY, dim INTEGER NOT NULL, data BYTEA NOT NULL)`);
        await q(`CREATE TABLE IF NOT EXISTS ${this._t('deps')} (file TEXT NOT NULL, dep TEXT)`);
        await q(`CREATE INDEX IF NOT EXISTS gi_deps_file ON ${this._t('deps')} (file)`);
        await q(`CREATE TABLE IF NOT EXISTS ${this._t('meta')} (key TEXT PRIMARY KEY, value TEXT)`);
    }

    // ─── Load / reload ─────────────────────────────────────────────────────────

    async load() {
        await this._connect();
        this._resetState();
        this._meta = {};

        const meta = await this._pool.query(`SELECT key, value FROM ${this._t('meta')}`);
        for (const r of meta.rows) this._meta[r.key] = r.value;

        const deps = await this._pool.query(`SELECT file, dep FROM ${this._t('deps')}`);
        const dependencies = {};
        const importedBy = {};
        for (const { file, dep } of deps.rows) {
            dependencies[file] ||= [];
            if (dep != null) {
                dependencies[file].push(dep);
                (importedBy[dep] ||= []).push(file);
            }
        }
        this.graph = { dependencies, importedBy };

        const vectors = await this._pool.query(`SELECT key, dim, data FROM ${this._t('vectors')}`);
        for (const { key, dim, data } of vectors.rows) {
            this.embeddingCache.set(key, bytesToVector(data, dim));
        }

        const chunks = await this._pool.query(`SELECT data FROM ${this._t('chunks')} ORDER BY id`);
        for (const row of chunks.rows) {
            const chunk = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
            this.graph.dependencies[chunk.file_path] ||= []; // node-set parity with the other backends
            this._ingestChunk(chunk);
        }
        return this;
    }

    async reload() { return this.load(); }

    // Persistence is per-file and immediate (applyFileUpdate below); the
    // debounced file-snapshot path of the parent class does not apply here.
    saveDebounced() {}
    async save() {}

    // ─── Incremental writes (used by the watch daemon) ─────────────────────────

    /**
     * Atomically replace every chunk of one file: parent class updates the
     * in-memory state, then the same payload is committed to Postgres in one
     * transaction and announced via NOTIFY for listening MCP servers.
     */
    async applyFileUpdate(filePath, { chunks = [], imports = [], embeddings = null } = {}) {
        await this._connect();
        super.applyFileUpdate(filePath, { chunks, imports, embeddings });
        const vecEntries = embeddings
            ? (embeddings instanceof Map ? Array.from(embeddings.entries()) : Object.entries(embeddings))
            : [];

        const client = await this._pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`DELETE FROM ${this._t('chunks')} WHERE file_path = $1`, [filePath]);
            for (const chunk of chunks) {
                await client.query(
                    `INSERT INTO ${this._t('chunks')} (id, file_path, data) VALUES ($1, $2, $3)
                     ON CONFLICT (id) DO UPDATE SET file_path = EXCLUDED.file_path, data = EXCLUDED.data`,
                    [chunk.id, chunk.file_path, JSON.stringify(chunk)]
                );
            }
            for (const [key, vec] of vecEntries) {
                await client.query(
                    `INSERT INTO ${this._t('vectors')} (key, dim, data) VALUES ($1, $2, $3)
                     ON CONFLICT (key) DO UPDATE SET dim = EXCLUDED.dim, data = EXCLUDED.data`,
                    [key, vec.length, vectorToBytes(vec)]
                );
            }
            await client.query(`DELETE FROM ${this._t('deps')} WHERE file = $1`, [filePath]);
            if (!imports || imports.length === 0) {
                await client.query(`INSERT INTO ${this._t('deps')} (file, dep) VALUES ($1, NULL)`, [filePath]);
            } else {
                for (const dep of imports) {
                    await client.query(`INSERT INTO ${this._t('deps')} (file, dep) VALUES ($1, $2)`, [filePath, dep]);
                }
            }
            await client.query(
                `INSERT INTO ${this._t('meta')} (key, value) VALUES ('built_at', $1)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                [String(Date.now())]
            );
            await client.query('COMMIT');
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch { /* not in txn */ }
            throw err;
        } finally {
            client.release();
        }
        await this._notify();
    }

    /** Remove a deleted file's chunks and its dependency-graph node entirely. */
    async removeFile(filePath) {
        await this.applyFileUpdate(filePath, { chunks: [], imports: [] });
        await this._pool.query(`DELETE FROM ${this._t('deps')} WHERE file = $1`, [filePath]);
        delete this.graph.dependencies[filePath];
    }

    // ─── Build (write path, used by the indexer) ───────────────────────────────

    /**
     * (Re)build the entire index in one transaction — readers keep the old
     * index until COMMIT. Mirrors SqliteGraphStore.buildFrom.
     *
     * @param {object} payload  { chunks, graph, embeddingCache, meta? }
     * @returns {Promise<{chunks: number, vectors: number, dim: number}>}
     */
    async buildFrom({ chunks, graph, embeddingCache, meta = {} }) {
        await this._connect();
        const vecEntries = embeddingCache instanceof Map
            ? Array.from(embeddingCache.entries())
            : Object.entries(embeddingCache || {});
        const dim = vecEntries.length > 0 ? vecEntries[0][1].length : 0;

        const client = await this._pool.connect();
        try {
            await client.query('BEGIN');
            for (const table of ['chunks', 'vectors', 'deps', 'meta']) {
                await client.query(`DELETE FROM ${this._t(table)}`);
            }

            for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
                const batch = chunks.slice(i, i + INSERT_BATCH);
                const values = batch.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`).join(', ');
                const params = batch.flatMap(c => [c.id, c.file_path, JSON.stringify(c)]);
                await client.query(`INSERT INTO ${this._t('chunks')} (id, file_path, data) VALUES ${values}`, params);
            }

            for (let i = 0; i < vecEntries.length; i += INSERT_BATCH) {
                const batch = vecEntries.slice(i, i + INSERT_BATCH);
                const values = batch.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`).join(', ');
                const params = batch.flatMap(([key, vec]) => [key, vec.length, vectorToBytes(vec)]);
                await client.query(`INSERT INTO ${this._t('vectors')} (key, dim, data) VALUES ${values}`, params);
            }

            const depRows = [];
            for (const [file, list] of Object.entries(graph?.dependencies || {})) {
                if (!list || list.length === 0) depRows.push([file, null]);
                else for (const dep of list) depRows.push([file, dep]);
            }
            for (let i = 0; i < depRows.length; i += INSERT_BATCH) {
                const batch = depRows.slice(i, i + INSERT_BATCH);
                const values = batch.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(', ');
                await client.query(`INSERT INTO ${this._t('deps')} (file, dep) VALUES ${values}`, batch.flat());
            }

            const metaRows = { ...meta, dim: String(dim), built_at: String(Date.now()) };
            for (const [key, value] of Object.entries(metaRows)) {
                await client.query(`INSERT INTO ${this._t('meta')} (key, value) VALUES ($1, $2)`, [key, String(value)]);
            }
            await client.query('COMMIT');
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch { /* not in txn */ }
            throw err;
        } finally {
            client.release();
        }
        await this._notify();
        return { chunks: chunks.length, vectors: vecEntries.length, dim };
    }

    // ─── Live updates (LISTEN/NOTIFY) ──────────────────────────────────────────

    async _notify() {
        try { await this._pool.query(`NOTIFY ${CHANGE_CHANNEL}`); }
        catch { /* notification is best-effort; readers also reload on restart */ }
    }

    /**
     * Invoke `callback` whenever another process commits an index change.
     * Holds one dedicated connection on LISTEN for the store's lifetime.
     */
    async subscribeToChanges(callback) {
        await this._connect();
        const client = await this._pool.connect();
        if (typeof client.on !== 'function') { client.release(); return; }
        this._listenClient = client;
        client.on('notification', (msg) => {
            if (msg.channel === CHANGE_CHANNEL) callback();
        });
        await client.query(`LISTEN ${CHANGE_CHANNEL}`);
    }

    // ─── Stats / cleanup ───────────────────────────────────────────────────────

    stats() {
        return {
            ...super.stats(),
            backend: 'postgres',
            vectorSource: 'postgres (eager in-memory matrix)',
            builtAt: Number(this._meta.built_at) || 0,
        };
    }

    async close() {
        super.close();
        if (this._listenClient) {
            try { this._listenClient.release(); } catch { /* already released */ }
            this._listenClient = null;
        }
        if (this._pool) {
            try { await this._pool.end(); } catch { /* already closed */ }
            this._pool = null;
        }
    }
}
