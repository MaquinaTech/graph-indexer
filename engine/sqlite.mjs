/**
 * @file engine/sqlite.mjs
 * @description Disk-backed graph store for enterprise-scale monorepos. Implements
 *              the same read contract as MemoryGraphIndex (see storage.mjs) over
 *              `node:sqlite` — built into Node, so this adds ZERO dependencies.
 *
 *              The whole point is bounded RAM: chunk payloads, the BM25 posting
 *              lists and the symbol/call indexes live in SQLite tables and are
 *              touched only for the candidates a query actually needs. Vectors
 *              live in the shared `.embeddings.bin`: point reads are pread on
 *              demand, and the semantic channel streams the whole bin in bounded
 *              buffers. Nothing scales with corpus size in the resident set
 *              except the small file-level dependency graph (needed wholesale by
 *              PageRank).
 *
 *              The store is LIVE: the watch daemon applies per-file incremental
 *              updates through applyFileUpdate() (WAL mode, single transaction
 *              per file), and reader processes detect those commits via
 *              `PRAGMA data_version` and transparently refresh their cached
 *              meta/graph state — no re-indexing, no server restarts.
 *
 *              Ranking is delegated to search-core.fuseAndRank, so results are
 *              consistent with the in-memory engine.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import {
    tokenize, okapiIdf, bm25Score, fuseAndRank, buildLexicalDocument, embeddingKeyFor,
    LEXICAL_FUSION_CAP, VECTOR_SCAN_RAW_N, finalizeVectorCandidates,
    isNaturalLanguageQuery, baseEmbeddingKey, scoreSparseExpanded,
} from '../search-core.mjs';
import { expandSparseQuery } from '../search-sparse.mjs';
import {
    writeEmbeddingBinary, appendEmbeddingBinary, scanEmbeddingBinary,
    updateVectorSketch, searchVectorSketch, SKETCH_THRESHOLD,
} from './binary.mjs';

// node:sqlite is loaded lazily so the default in-memory path never requires it.
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* reported in ctor */ }

// SKETCH_THRESHOLD (shared with the memory store via binary.mjs) — build the binary
// sketch above this many vectors. Below it the exact streaming scan stays under ~20 ms
                                  // AND both backends rank identically (the sketch is
                                  // approximate in the candidate tail); above it the
                                  // sketch caps latency at ~5–15 ms regardless of size.

const SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY, file_path TEXT NOT NULL, node_type TEXT,
  name TEXT, name_lower TEXT, docstring TEXT, code_snippet TEXT, content_hash TEXT,
  start_line INTEGER, end_line INTEGER,
  calls TEXT, params TEXT, return_type TEXT, class_context TEXT,
  type_refs TEXT, decorators TEXT, extends_ TEXT, hyde TEXT, summary TEXT, concepts TEXT,
  doc_len INTEGER, path_tokens TEXT, vec_key TEXT, vec_offset INTEGER, vec_dim INTEGER,
  call_sites TEXT
);
CREATE TABLE IF NOT EXISTS postings (term TEXT, chunk_id TEXT, tf INTEGER);
CREATE TABLE IF NOT EXISTS terms (term TEXT PRIMARY KEY, df INTEGER);
CREATE TABLE IF NOT EXISTS call_edges (callee TEXT, chunk_id TEXT);
CREATE TABLE IF NOT EXISTS edges (from_chunk_id TEXT, to_chunk_id TEXT, kind TEXT, confidence TEXT);
CREATE TABLE IF NOT EXISTS centrality (chunk_id TEXT, score REAL, rank INTEGER);
CREATE TABLE IF NOT EXISTS taint (id INTEGER PRIMARY KEY, payload TEXT);
CREATE TABLE IF NOT EXISTS scip_refs (id INTEGER PRIMARY KEY, payload TEXT);
CREATE TABLE IF NOT EXISTS sparse_model (id INTEGER PRIMARY KEY, payload TEXT);
CREATE TABLE IF NOT EXISTS deps (file TEXT, dep TEXT);
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  handler_name TEXT,
  handler_chunk_id TEXT,
  file_path TEXT NOT NULL,
  line INTEGER,
  framework TEXT
);
`;

const SCHEMA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_name ON chunks(name_lower);
CREATE INDEX IF NOT EXISTS idx_chunks_veckey ON chunks(vec_key);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS idx_postings_term ON postings(term);
CREATE INDEX IF NOT EXISTS idx_postings_chunk ON postings(chunk_id);
CREATE INDEX IF NOT EXISTS idx_calledges_callee ON call_edges(callee);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_chunk_id);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_chunk_id);
CREATE INDEX IF NOT EXISTS idx_centrality_chunk ON centrality(chunk_id);
CREATE INDEX IF NOT EXISTS idx_centrality_rank ON centrality(rank);
CREATE INDEX IF NOT EXISTS idx_deps_file ON deps(file);
CREATE INDEX IF NOT EXISTS idx_deps_dep ON deps(dep);
CREATE INDEX IF NOT EXISTS idx_routes_method ON routes(method);
CREATE INDEX IF NOT EXISTS idx_routes_path ON routes(path);
CREATE INDEX IF NOT EXISTS idx_routes_handler ON routes(handler_chunk_id);
`;

const CHUNK_COLS = [
    'id', 'file_path', 'node_type', 'name', 'name_lower', 'docstring', 'code_snippet',
    'content_hash', 'start_line', 'end_line', 'calls', 'params', 'return_type',
    'class_context', 'type_refs', 'decorators', 'extends_', 'hyde', 'summary', 'concepts',
    'doc_len', 'path_tokens', 'vec_key', 'vec_offset', 'vec_dim', 'call_sites',
];

function jsonArr(v) { return JSON.stringify(Array.isArray(v) ? v : []); }
function parseArr(s) {
    if (!s) return [];
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}
function nameLowerOf(name) {
    return (name && name !== 'anonymous') ? String(name).toLowerCase() : null;
}

export class SqliteGraphStore {
    constructor(dbPath, { embeddingPath, rrfK = 60 } = {}) {
        if (!DatabaseSync) {
            throw new Error(
                'node:sqlite is unavailable — the --use-sqlite backend requires Node >= 22.5. '
                + 'Use the default in-memory engine, or upgrade Node.'
            );
        }
        this.dbPath = dbPath;
        this._embeddingPath = embeddingPath || dbPath.replace(/\.db$/, '.embeddings.bin');
        this.db = null;
        this._vecFd = -1;
        this.rrfK = rrfK;

        // File-level dependency graph — small (per file, not per chunk); held in RAM
        // because PageRank needs the whole thing. This is the only corpus-scaling
        // structure kept resident, and it is orders of magnitude smaller than chunks.
        this._graph = { dependencies: {}, importedBy: {} };
        this._docCount = 0;
        this._totalDocLen = 0;
        this._avgdl = 1;
        this._dim = 0;
        this._dataVersion = -1;
        this._writeReady = false;
        this._sketch = null; // binary-quantized vector sketch (built above SKETCH_THRESHOLD)
        this._hasEdges = false; // A4: resolved symbol graph present (opt-in)
        this._hasCentrality = false; // A5: symbol centrality present (opt-in, built with the graph)
        this._centralityTotal = 0;
        this._hasTaint = false; // C2: serialized taint flows present (opt-in --taint)
        this._hasScipRefs = false; // A2 v2: SCIP precise references present (opt-in --resolver scip)
        this._scipRefsObj = null;  // lazily-parsed `{ defId: [refId,…] }` payload (memoized)
        this._hasSparseModel = false; // B3: learned-sparse model present (opt-in --learned-sparse)
        this._sparseModelObj = null;  // lazily-parsed `{ assoc: {…} }` payload (memoized)
    }

    get backend() { return 'sqlite'; }

    /** Live view of the file dependency graph (refreshed when another process commits). */
    get graph() {
        this._maybeRefresh();
        return this._graph;
    }

    // ─── Open / load ───────────────────────────────────────────────────────────

    _open() {
        this.db = new DatabaseSync(this.dbPath);
        // WAL: one writer (daemon) + many readers (MCP server) across processes.
        // busy_timeout absorbs brief writer/checkpoint locks instead of throwing.
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;');
    }

    load() {
        const existed = fs.existsSync(this.dbPath);
        this._open();
        this.db.exec(SCHEMA_TABLES);
        if (existed) {
            // Forward migrations for indexes built by older versions.
            try { this.db.exec('ALTER TABLE chunks ADD COLUMN concepts TEXT DEFAULT NULL'); } catch { /* exists */ }
            try {
                this.db.exec('ALTER TABLE chunks ADD COLUMN vec_key TEXT DEFAULT NULL');
                // Pre-enrichment-key indexes stored vectors under the plain content hash.
                this.db.exec('UPDATE chunks SET vec_key = content_hash WHERE vec_key IS NULL');
            } catch { /* exists */ }
            // Receiver-aware call graph (precise get_call_graph) landed later; older
            // indexes lack the column. NULL → callers fall back to name-only grouping.
            try { this.db.exec('ALTER TABLE chunks ADD COLUMN call_sites TEXT DEFAULT NULL'); } catch { /* exists */ }
        }
        this.db.exec(SCHEMA_INDEXES);
        this._reloadMeta();
        // Does this corpus carry LLM enrichment? One cheap probe → drives the NL
        // vector-channel weight in fuseAndRank (parity with the in-memory engine).
        try {
            this._corpusEnriched = Boolean(
                this.db.prepare("SELECT 1 FROM chunks WHERE summary IS NOT NULL AND summary != '' LIMIT 1").get()
            );
        } catch { this._corpusEnriched = false; }
        this._loadGraph();
        this._openVecFd();
        this._refreshSketch();
        this._prepare();
        this._refreshHasEdges();
        this._refreshHasCentrality();
        this._refreshHasTaint();
        this._refreshHasScipRefs();
        this._refreshHasSparseModel();
        this._dataVersion = this._readDataVersion();
        return this;
    }

    /** Whether the opt-in resolved symbol graph (A4) has any edges. */
    _refreshHasEdges() {
        try { this._hasEdges = Boolean(this.db.prepare('SELECT 1 FROM edges LIMIT 1').get()); }
        catch { this._hasEdges = false; }
    }

    /** Whether opt-in symbol centrality (A5) is present, and how many chunks are ranked. */
    _refreshHasCentrality() {
        try {
            const row = this.db.prepare('SELECT COUNT(*) AS n FROM centrality').get();
            this._centralityTotal = row ? row.n : 0;
            this._hasCentrality = this._centralityTotal > 0;
        } catch { this._hasCentrality = false; this._centralityTotal = 0; }
    }

    /** Whether opt-in serialized taint flows (C2 --taint) are present. */
    _refreshHasTaint() {
        try {
            const row = this.db.prepare('SELECT COUNT(*) AS n FROM taint').get();
            this._hasTaint = Boolean(row && row.n > 0);
        } catch { this._hasTaint = false; }
    }

    /** Whether opt-in SCIP precise references (A2 v2 --resolver scip) are present. */
    _refreshHasScipRefs() {
        try {
            const row = this.db.prepare('SELECT COUNT(*) AS n FROM scip_refs').get();
            this._hasScipRefs = Boolean(row && row.n > 0);
        } catch { this._hasScipRefs = false; }
        this._scipRefsObj = null;   // drop any memoized payload — the row may have changed
    }

    /** Whether opt-in learned-sparse associations (B3 --learned-sparse) are present. */
    _refreshHasSparseModel() {
        try {
            const row = this.db.prepare('SELECT COUNT(*) AS n FROM sparse_model').get();
            this._hasSparseModel = Boolean(row && row.n > 0);
        } catch { this._hasSparseModel = false; }
        this._sparseModelObj = null;   // drop any memoized payload — the row may have changed
    }

    _openVecFd() {
        if (this._vecFd >= 0) { try { fs.closeSync(this._vecFd); } catch {} this._vecFd = -1; }
        if (fs.existsSync(this._embeddingPath)) {
            try { this._vecFd = fs.openSync(this._embeddingPath, 'r'); } catch { this._vecFd = -1; }
        }
    }

    /** Read the bin's entry count + first entry key (cheap, two small preads). */
    _binFingerprint() {
        if (this._vecFd < 0) return null;
        try {
            const hdr = Buffer.allocUnsafe(8);
            if (fs.readSync(this._vecFd, hdr, 0, 8, 0) < 8) return null;
            const count = hdr.readUInt32LE(0);
            const keyLen = hdr.readUInt32LE(4);
            if (keyLen <= 0 || keyLen > 4096) return { count, firstKey: null };
            const kb = Buffer.allocUnsafe(keyLen);
            if (fs.readSync(this._vecFd, kb, 0, keyLen, 8) < keyLen) return { count, firstKey: null };
            return { count, firstKey: kb.toString('utf8') };
        } catch { return null; }
    }

    /**
     * Build / extend / rebuild the binary vector sketch to match the bin on disk.
     * Appends (the daemon's write path) extend the sketch by scanning only the
     * unseen tail; a replaced bin (full re-index) is detected via the entry count
     * + first-key fingerprint and triggers a rebuild.
     */
    _refreshSketch() {
        if (this._vecFd < 0) { this._sketch = null; return; }
        const fp = this._binFingerprint();
        if (!fp || fp.count < SKETCH_THRESHOLD) { this._sketch = null; return; }
        try {
            const size = fs.fstatSync(this._vecFd).size;
            if (this._sketch) {
                const replaced = fp.count < this._sketch.n
                    || size < this._sketch.consumed
                    || (this._sketch.firstKey !== null && fp.firstKey !== this._sketch.firstKey);
                if (replaced) this._sketch = null;
            }
            this._sketch = updateVectorSketch(this._sketch, { fd: this._vecFd });
        } catch { this._sketch = null; }
    }

    _reloadMeta() {
        const meta = {};
        for (const r of this.db.prepare('SELECT key, value FROM meta').all()) meta[r.key] = r.value;
        this._docCount = Number(meta.doc_count || 0);
        this._totalDocLen = Number(meta.total_doc_len || 0);
        this._avgdl = this._docCount > 0 ? this._totalDocLen / this._docCount : 1;
        this._dim = Number(meta.dim || 0);
    }

    _loadGraph() {
        const dependencies = {};
        const importedBy = {};
        for (const { file, dep } of this.db.prepare('SELECT file, dep FROM deps').all()) {
            (dependencies[file] ||= []);
            if (dep != null) {
                dependencies[file].push(dep);
                (importedBy[dep] ||= []).push(file);
            }
        }
        // Ensure every file that has chunks is a graph node (PageRank node set parity).
        for (const { f } of this.db.prepare('SELECT DISTINCT file_path AS f FROM chunks').all()) {
            dependencies[f] ||= [];
        }
        this._graph = { dependencies, importedBy };
    }

    _readDataVersion() {
        try { return this.db.prepare('PRAGMA data_version').get()?.data_version ?? -1; }
        catch { return -1; }
    }

    /**
     * Detect commits made by OTHER processes (the watch daemon, a re-run of the
     * indexer) via PRAGMA data_version — a single cheap pragma per call — and
     * refresh the cached meta, dependency graph and embeddings fd when the
     * underlying database changed. This is what keeps a long-running MCP server
     * consistent with the daemon without restarts or full re-indexes.
     */
    _maybeRefresh() {
        if (!this.db) return;
        try {
            const v = this._readDataVersion();
            if (v === this._dataVersion) return;
            this._dataVersion = v;
            this._reloadMeta();
            this._loadGraph();
            this._openVecFd();
            this._refreshSketch();
        } catch { /* keep previous snapshot on transient errors */ }
    }

    _prepare() {
        this._stmtChunk     = this.db.prepare('SELECT * FROM chunks WHERE id = ?');
        this._stmtByFile    = this.db.prepare('SELECT * FROM chunks WHERE file_path = ?');
        this._stmtByName    = this.db.prepare('SELECT * FROM chunks WHERE name_lower = ?');
        this._stmtIdByName  = this.db.prepare('SELECT id FROM chunks WHERE name_lower = ?');
        this._stmtCallers   = this.db.prepare(
            'SELECT c.* FROM chunks c JOIN call_edges e ON e.chunk_id = c.id WHERE e.callee = ?'
        );
        // type_refs / extends_ are JSON arrays of names. LIKE is a cheap prefilter
        // (ASCII case-insensitive in SQLite); findReferers() verifies exact, quoted
        // membership in JS so e.g. "User" never matches "UserProfile".
        this._stmtReferers  = this.db.prepare(
            'SELECT * FROM chunks WHERE type_refs LIKE ? ESCAPE \'\\\' OR extends_ LIKE ? ESCAPE \'\\\''
        );
        this._stmtPosting   = this.db.prepare(
            'SELECT p.chunk_id AS id, p.tf AS tf, c.doc_len AS doc_len '
            + 'FROM postings p JOIN chunks c ON c.id = p.chunk_id WHERE p.term = ?'
        );
        this._stmtDf        = this.db.prepare('SELECT df FROM terms WHERE term = ?');
        this._stmtVec       = this.db.prepare('SELECT vec_offset, vec_dim FROM chunks WHERE id = ?');
        // ORDER BY id: duplicate-content chunks share one vector key; emitting their
        // ids in a deterministic order keeps both backends rank-identical on ties.
        this._stmtIdsByKey  = this.db.prepare('SELECT id FROM chunks WHERE vec_key = ? ORDER BY id');
        this._stmtIdsByHash = this.db.prepare('SELECT id FROM chunks WHERE content_hash = ? ORDER BY id');
        // ORDER BY id (rowid = insertion order) keeps routes in index-build order,
        // matching the in-memory graph.routes array order for cross-backend parity.
        this._stmtRoutes    = this.db.prepare(
            'SELECT method, path, handler_name, handler_chunk_id, file_path, line, framework '
            + 'FROM routes ORDER BY id'
        );
        // A4 symbol graph. ORDER mirrors the in-memory engine's per-endpoint slice of the
        // globally-sorted edge list (fixed `to` → sort by from,kind,confidence; fixed `from`
        // → sort by to,kind,confidence) so getEdges is byte-identical cross-backend.
        this._stmtEdgesIn   = this.db.prepare(
            'SELECT from_chunk_id, to_chunk_id, kind, confidence FROM edges WHERE to_chunk_id = ? '
            + 'ORDER BY from_chunk_id, kind, confidence'
        );
        this._stmtEdgesOut  = this.db.prepare(
            'SELECT from_chunk_id, to_chunk_id, kind, confidence FROM edges WHERE from_chunk_id = ? '
            + 'ORDER BY to_chunk_id, kind, confidence'
        );
        // A5 symbol centrality. rank/score are precomputed at index time; topCentral orders by
        // the stored rank (chunk_id tie-break mirrors the in-memory ranked cache).
        this._stmtCentrality = this.db.prepare('SELECT score, rank FROM centrality WHERE chunk_id = ?');
        this._stmtTopCentral = this.db.prepare(
            'SELECT chunk_id, score, rank FROM centrality ORDER BY rank ASC, chunk_id ASC LIMIT ?'
        );
        // C2 serialized taint flows — a single JSON payload row (id = 0).
        this._stmtTaint = this.db.prepare('SELECT payload FROM taint WHERE id = 0');
        this._stmtScipRefs = this.db.prepare('SELECT payload FROM scip_refs WHERE id = 0');
        this._stmtSparseModel = this.db.prepare('SELECT payload FROM sparse_model WHERE id = 0');
    }

    _prepareWrite() {
        if (this._writeReady) return;
        this._stmtInsChunk = this.db.prepare(
            `INSERT OR REPLACE INTO chunks (${CHUNK_COLS.join(', ')}) `
            + `VALUES (${CHUNK_COLS.map(() => '?').join(', ')})`
        );
        this._stmtInsPost     = this.db.prepare('INSERT INTO postings (term, chunk_id, tf) VALUES (?, ?, ?)');
        this._stmtInsEdge     = this.db.prepare('INSERT INTO call_edges (callee, chunk_id) VALUES (?, ?)');
        this._stmtInsDep      = this.db.prepare('INSERT INTO deps (file, dep) VALUES (?, ?)');
        this._stmtDelDeps     = this.db.prepare('DELETE FROM deps WHERE file = ?');
        this._stmtUpsertTerm  = this.db.prepare(
            'INSERT INTO terms (term, df) VALUES (?, 1) ON CONFLICT(term) DO UPDATE SET df = df + 1'
        );
        this._stmtDecTerm     = this.db.prepare('UPDATE terms SET df = df - 1 WHERE term = ?');
        this._stmtPruneTerms  = this.db.prepare('DELETE FROM terms WHERE df <= 0');
        this._stmtPostByChunk = this.db.prepare('SELECT term FROM postings WHERE chunk_id = ?');
        this._stmtDelPostings = this.db.prepare('DELETE FROM postings WHERE chunk_id = ?');
        this._stmtDelEdges    = this.db.prepare('DELETE FROM call_edges WHERE chunk_id = ?');
        this._stmtDelChunk    = this.db.prepare('DELETE FROM chunks WHERE id = ?');
        this._stmtInsMeta     = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
        this._stmtVecByKey    = this.db.prepare(
            'SELECT vec_offset, vec_dim FROM chunks WHERE vec_key = ? AND vec_offset >= 0 LIMIT 1'
        );
        this._stmtVecByHash   = this.db.prepare(
            'SELECT vec_offset, vec_dim FROM chunks WHERE content_hash = ? AND vec_offset >= 0 LIMIT 1'
        );
        this._writeReady = true;
    }

    // ─── Row → chunk ───────────────────────────────────────────────────────────

    _rowToChunk(row) {
        if (!row) return null;
        return {
            id: row.id, file_path: row.file_path, node_type: row.node_type, name: row.name,
            docstring: row.docstring || '', code_snippet: row.code_snippet || '',
            content_hash: row.content_hash, start_line: row.start_line, end_line: row.end_line,
            calls: parseArr(row.calls), params: parseArr(row.params),
            return_type: row.return_type || '', class_context: row.class_context || '',
            type_refs: parseArr(row.type_refs), decorators: parseArr(row.decorators),
            extends: parseArr(row.extends_), hyde: row.hyde || '', summary: row.summary || '',
            concepts: parseArr(row.concepts), call_sites: parseArr(row.call_sites),
        };
    }

    // ─── Contract: point reads ─────────────────────────────────────────────────

    getChunk(id) { return this._rowToChunk(this._stmtChunk.get(id)); }

    getChunksByFile(filePath) { return this._stmtByFile.all(filePath).map(r => this._rowToChunk(r)); }

    resolveSymbol(name) {
        const key = nameLowerOf(name);
        if (!key) return [];
        return this._stmtByName.all(key).map(r => this._rowToChunk(r));
    }

    /**
     * Resolved symbol-graph edges incident to a chunk (A4). Mirrors MemoryGraphIndex.getEdges,
     * including deterministic order. Returns [] unless the opt-in graph was built.
     */
    /** Whether the opt-in resolved symbol graph (A4) is loaded. */
    hasSymbolGraph() { return this._hasEdges; }

    getEdges(chunkId, { kind = null, direction = 'in' } = {}) {
        if (!this._hasEdges) return [];
        const rows = direction === 'out' ? this._stmtEdgesOut.all(chunkId) : this._stmtEdgesIn.all(chunkId);
        const out = [];
        for (const e of rows) {
            if (kind && e.kind !== kind) continue;
            const otherId = direction === 'out' ? e.to_chunk_id : e.from_chunk_id;
            out.push({ from_chunk_id: e.from_chunk_id, to_chunk_id: e.to_chunk_id, kind: e.kind, confidence: e.confidence, chunk: this.getChunk(otherId) });
        }
        return out;
    }

    /** Whether opt-in symbol centrality (A5) is loaded. */
    hasCentrality() { return this._hasCentrality; }

    /** Whether opt-in serialized taint flows (C2 --taint) are loaded. */
    hasTaint() { return this._hasTaint; }

    /** The serialized taint payload `{ flows, meta }` (C2), or null. Mirrors MemoryGraphIndex. */
    getTaintFlows() {
        if (!this._hasTaint) return null;
        const row = this._stmtTaint.get();
        if (!row || !row.payload) return null;
        try { return JSON.parse(row.payload); } catch { return null; }
    }

    /** Whether opt-in SCIP precise references (A2 v2 --resolver scip) are loaded. */
    hasScipRefs() { return this._hasScipRefs; }

    /** Parse the single JSON payload `{ defId: [refId,…] }` once, then memoize. */
    _loadScipRefs() {
        if (!this._hasScipRefs) return {};
        if (!this._scipRefsObj) {
            const row = this._stmtScipRefs.get();
            try { this._scipRefsObj = row && row.payload ? JSON.parse(row.payload) : {}; }
            catch { this._scipRefsObj = {}; }
        }
        return this._scipRefsObj;
    }

    /** SCIP-confirmed referer chunk ids for a definition chunk (A2 v2), or []. Mirrors MemoryGraphIndex. */
    getScipReferers(defChunkId) {
        const refs = this._loadScipRefs()[defChunkId];
        return Array.isArray(refs) ? refs : [];
    }

    /** How many definitions carry SCIP precise references (A2 v2). 0 when not loaded. */
    scipRefCount() { return this._hasScipRefs ? Object.keys(this._loadScipRefs()).length : 0; }

    /** Whether opt-in learned-sparse associations (B3 --learned-sparse) are loaded. */
    hasSparseModel() { return this._hasSparseModel; }

    /** Path to the shared `.embeddings.bin` (B4 late-interaction reranker reads candidate vectors from it). */
    embeddingBinPath() { return this._embeddingPath; }

    /** Parse the single learned-sparse payload once, then memoize. Mirrors MemoryGraphIndex._sparseModel. */
    _loadSparseModel() {
        if (!this._hasSparseModel) return null;
        if (!this._sparseModelObj) {
            const row = this._stmtSparseModel.get();
            try { this._sparseModelObj = row && row.payload ? JSON.parse(row.payload) : null; }
            catch { this._sparseModelObj = null; }
        }
        return this._sparseModelObj;
    }

    /**
     * Symbol centrality (A5) for one chunk. Mirrors MemoryGraphIndex.getCentrality — same
     * { score, rank, total } shape; null when unranked or centrality was not built.
     */
    getCentrality(chunkId) {
        if (!this._hasCentrality) return null;
        const row = this._stmtCentrality.get(chunkId);
        return row ? { score: row.score, rank: row.rank, total: this._centralityTotal } : null;
    }

    /** The most central symbols (A5), rank-ascending. @returns {Array<{chunk,score,rank}>} */
    topCentral(limit = 20) {
        if (!this._hasCentrality) return [];
        const out = [];
        for (const row of this._stmtTopCentral.all(limit)) {
            const chunk = this.getChunk(row.chunk_id);
            if (chunk) out.push({ chunk, score: row.score, rank: row.rank });
        }
        return out;
    }

    /** From-chunks of edges of a kept kind pointing at any of `defs`, id-sorted. */
    _referrersByEdge(defs, keepKind) {
        const ids = new Set();
        for (const def of defs) for (const e of this._stmtEdgesIn.all(def.id)) if (keepKind(e.kind)) ids.add(e.from_chunk_id);
        const out = [];
        for (const id of [...ids].sort()) { const c = this.getChunk(id); if (c) out.push(c); }
        return out;
    }

    findCallers(funcName) {
        if (this._hasEdges) {
            const defs = this.resolveSymbol(funcName);
            if (defs.length > 0) return this._referrersByEdge(defs, k => k === 'calls');
        }
        return this._stmtCallers.all(funcName).map(r => this._rowToChunk(r));
    }

    findReferers(symbol) {
        const key = String(symbol).toLowerCase().trim();
        if (!key) return [];
        if (this._hasEdges) {
            const defs = this.resolveSymbol(symbol);
            if (defs.length > 0) return this._referrersByEdge(defs, k => k === 'extends' || k === 'type');
        }
        // Escape LIKE metacharacters in the symbol, then bracket with JSON quotes so
        // the prefilter only fires on a whole array element.
        const esc = key.replace(/[\\%_]/g, m => '\\' + m);
        const pat = `%"${esc}"%`;
        const out = [];
        for (const row of this._stmtReferers.all(pat, pat)) {
            const c = this._rowToChunk(row);
            // A class/type lists its own name in type_refs — that self-mention is a
            // definition, not a reference; skip it.
            if (c.name && c.name.toLowerCase() === key) continue;
            const hit = c.type_refs.some(t => t.toLowerCase() === key)
                || c.extends.some(t => t.toLowerCase() === key);
            if (hit) out.push(c);
        }
        return out;
    }

    /**
     * HTTP routes filtered by method and/or path prefix, each augmented with its
     * resolved handler chunk (`chunk`, or null). Filtering logic is byte-identical
     * to MemoryGraphIndex.findRoutes; rows arrive in index-build order (ORDER BY id)
     * so both backends return identical records. An index built before this feature
     * (empty routes table) yields [].
     * @returns {object[]}
     */
    findRoutes({ method = null, pathPrefix = null } = {}) {
        this._maybeRefresh();
        const m = method ? String(method).toUpperCase().trim() : null;
        const p = pathPrefix ? String(pathPrefix).toLowerCase() : null;
        const out = [];
        for (const r of this._stmtRoutes.all()) {
            if (m && String(r.method || '').toUpperCase() !== m) continue;
            if (p && !String(r.path || '').toLowerCase().startsWith(p)) continue;
            const chunk = r.handler_chunk_id ? this.getChunk(r.handler_chunk_id) : null;
            out.push({
                method: r.method, path: r.path, handler_name: r.handler_name,
                handler_chunk_id: r.handler_chunk_id, file_path: r.file_path,
                line: r.line, framework: r.framework, chunk,
            });
        }
        return out;
    }

    *iterateChunks() {
        // Stream rows via a cursor so repo-map / call-graph passes never materialise
        // the whole table. Falls back to paging if .iterate() is unavailable.
        const stmt = this.db.prepare('SELECT * FROM chunks');
        if (typeof stmt.iterate === 'function') {
            for (const row of stmt.iterate()) yield this._rowToChunk(row);
            return;
        }
        const page = this.db.prepare('SELECT * FROM chunks LIMIT ? OFFSET ?');
        let offset = 0;
        for (;;) {
            const rows = page.all(1000, offset);
            if (rows.length === 0) break;
            for (const row of rows) yield this._rowToChunk(row);
            offset += rows.length;
        }
    }

    getDependencies(filePath) { return this.graph.dependencies[filePath] || []; }
    getImportedBy(filePath)   { return this.graph.importedBy[filePath] || []; }

    chunkCount()  { return this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n; }
    symbolCount() { return this.db.prepare('SELECT COUNT(DISTINCT name_lower) AS n FROM chunks WHERE name_lower IS NOT NULL').get().n; }
    fileCount()   { return this.db.prepare('SELECT COUNT(DISTINCT file_path) AS n FROM chunks').get().n; }
    vectorCount() { return this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE vec_offset >= 0').get().n; }

    stats() {
        this._maybeRefresh();
        // Extension tally, streamed via a cursor so it never materialises all rows.
        const extCounts = new Map();
        const stmt = this.db.prepare('SELECT file_path FROM chunks');
        const rows = typeof stmt.iterate === 'function' ? stmt.iterate() : stmt.all();
        for (const r of rows) {
            const ext = r.file_path.split('.').pop() || 'unknown';
            extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
        }
        const vectors = this.vectorCount();
        return {
            backend: 'sqlite',
            chunks: this.chunkCount(),
            files: this.fileCount(),
            symbols: this.symbolCount(),
            vectors,
            hasVectors: vectors > 0,
            lazyMode: true,
            vectorSource: this._vecFd >= 0 ? 'sqlite + disk-backed .bin' : 'sqlite (no vectors)',
            extCounts,
        };
    }

    // ─── Vector access (pread from shared .embeddings.bin) ─────────────────────

    _readVector(id) {
        if (this._vecFd < 0) return null;
        const row = this._stmtVec.get(id);
        if (!row || row.vec_offset == null || row.vec_offset < 0 || !row.vec_dim) return null;
        const byteLen = row.vec_dim * 4;
        const raw = Buffer.allocUnsafe(byteLen);
        try {
            const read = fs.readSync(this._vecFd, raw, 0, byteLen, row.vec_offset);
            if (read < byteLen) return null;
            const vec = new Float32Array(row.vec_dim);
            for (let d = 0; d < row.vec_dim; d++) vec[d] = raw.readFloatLE(d * 4);
            return vec;
        } catch { return null; }
    }

    /** Whether a vector for this embedding key is already stored (skip re-embedding). */
    hasEmbedding(key) {
        this._prepareWrite();
        return Boolean(this._stmtVecByKey.get(key));
    }

    // ─── Hybrid search ─────────────────────────────────────────────────────────

    searchHybrid(queryText, queryVector, topK = 5, minScore = 0.3, exactBoostName = null) {
        this._maybeRefresh();

        // Asymmetric stemming: stem only for natural-language queries so symbolic
        // lookups stay exact — mirrors the in-memory engine for parity.
        const qTokens = tokenize(queryText, isNaturalLanguageQuery(queryText));
        const occ = new Map();
        for (const t of qTokens) occ.set(t, (occ.get(t) || 0) + 1);

        const lexScores = new Map();
        for (const [token, n] of occ) {
            const dfRow = this._stmtDf.get(token);
            if (!dfRow || dfRow.df <= 0) continue;
            const idf = okapiIdf(this._docCount, dfRow.df);
            for (const row of this._stmtPosting.all(token)) {
                const dl = row.doc_len ?? this._avgdl;
                const s = bm25Score(idf, row.tf, dl, this._avgdl) * n;
                lexScores.set(row.id, (lexScores.get(row.id) || 0) + s);
            }
        }
        const lexicalResults = Array.from(lexScores.entries())
            .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)) // id tie-break: backend parity
            .slice(0, LEXICAL_FUSION_CAP)
            .map(([id, score], i) => ({ id, score, rank: i + 1 }));

        // B3 learned-sparse channel: opt-in (model present) + NL-asymmetric. Shares scoreSparseExpanded
        // with the in-memory engine over identically-ordered terms → byte-identical to memory. [] when
        // inert (no model / symbolic query / no association) → fusion byte-identical to the default path.
        const sparseResults = this._searchSparseExpanded(queryText);

        // Stream the FULL embeddings bin (bounded buffers) so conceptual queries
        // that share no tokens with the code can still match — scoring only lexical
        // candidates silently disabled semantic search where it mattered most.
        let vectorResults = [];
        if (queryVector && this._vecFd >= 0) {
            // Binary sketch above SKETCH_THRESHOLD (Hamming prefilter + exact
            // rescore, O(candidates) disk reads); exact streaming scan below it.
            const hits = this._sketch
                ? searchVectorSketch(this._sketch, { fd: this._vecFd }, queryVector, {
                    topN: VECTOR_SCAN_RAW_N, minScore,
                })
                : scanEmbeddingBinary({ fd: this._vecFd }, queryVector, {
                    topN: VECTOR_SCAN_RAW_N, minScore,
                });
            const entries = [];
            for (const { key, score } of hits) {
                // Summary-only (`<key>|s`) and per-window (`<key>|wN`) vectors fold onto
                // the chunk; finalizeVectorCandidates keeps the max-sim score per chunk.
                const baseKey = baseEmbeddingKey(key);
                let rows = this._stmtIdsByKey.all(baseKey);
                if (rows.length === 0) rows = this._stmtIdsByHash.all(baseKey); // legacy bins
                for (const { id } of rows) entries.push({ id, score });
            }
            vectorResults = finalizeVectorCandidates(entries);
        }

        const rowCache = new Map();
        const fetchRow = (id) => {
            if (rowCache.has(id)) return rowCache.get(id);
            const row = this._stmtChunk.get(id);
            rowCache.set(id, row);
            return row;
        };
        for (const r of lexicalResults) fetchRow(r.id);
        for (const r of vectorResults)  fetchRow(r.id);

        const chunkCache = new Map();
        const getChunk = (id) => {
            if (chunkCache.has(id)) return chunkCache.get(id);
            const c = this._rowToChunk(fetchRow(id));
            chunkCache.set(id, c);
            return c;
        };
        const pathCache = new Map();
        const getPathTokens = (id) => {
            if (pathCache.has(id)) return pathCache.get(id);
            const row = fetchRow(id);
            const set = row ? new Set(parseArr(row.path_tokens)) : undefined;
            pathCache.set(id, set);
            return set;
        };
        const dfCache = new Map();
        const getDf = (t) => {
            if (dfCache.has(t)) return dfCache.get(t);
            const row = this._stmtDf.get(t);
            const df = row ? row.df : 0;
            dfCache.set(t, df);
            return df;
        };

        return fuseAndRank({
            lexicalResults, vectorResults, sparseResults, getChunk, getPathTokens, getDf,
            docCount: this._docCount, rrfK: this.rrfK, topK, queryText, exactBoostName,
            corpusEnriched: this._corpusEnriched,
            resolveExact: (term) => this._stmtIdByName.all(term).map(r => r.id),
        });
    }

    /**
     * B3 — the learned-sparse expansion channel (NL queries, model present). Mirrors
     * MemoryGraphIndex._searchSparseExpanded: identical expansion + the shared scoreSparseExpanded
     * scorer over identically-ordered terms → byte-identical to memory. Returns [] when inert.
     */
    _searchSparseExpanded(queryText) {
        if (!this._hasSparseModel || !isNaturalLanguageQuery(queryText)) return [];
        const model = this._loadSparseModel();
        const termWeights = model && expandSparseQuery(queryText, model);
        if (!termWeights) return [];
        const avgdl = this._avgdl;
        const docLenCache = new Map();
        return scoreSparseExpanded(termWeights, {
            docCount: this._docCount,
            avgdl,
            getDf: (t) => { const r = this._stmtDf.get(t); return r ? r.df : 0; },
            // .map() materialises the postings AND populates the doc-len cache before scoring iterates,
            // so getDocLen always resolves without a second query.
            getPostings: (t) => this._stmtPosting.all(t).map(r => { docLenCache.set(r.id, r.doc_len); return [r.id, r.tf]; }),
            getDocLen: (id) => docLenCache.get(id) ?? avgdl,
        });
    }

    close() {
        if (this._vecFd >= 0) { try { fs.closeSync(this._vecFd); } catch {} this._vecFd = -1; }
        if (this.db) { try { this.db.close(); } catch {} this.db = null; }
    }

    // ─── Incremental writes (used by the watch daemon) ─────────────────────────

    /** Internal: index one chunk's lexical document + row + call edges. */
    _insertChunk(chunk, imports, vecEntry) {
        const doc = buildLexicalDocument(chunk, imports);
        const tokens = tokenize(doc);                       // raw + additive stems
        const docLen = tokenize(doc, false).length;          // raw-only length for BM25 avgdl (parity w/ memory engine)

        const termCounts = new Map();
        for (const t of tokens) termCounts.set(t, (termCounts.get(t) || 0) + 1);
        for (const [term, cnt] of termCounts) {
            this._stmtUpsertTerm.run(term);
            this._stmtInsPost.run(term, chunk.id, cnt);
        }

        const pathTokens = Array.from(new Set(tokenize(chunk.file_path.replace(/[/\-_.]/g, ' '), false)));
        this._stmtInsChunk.run(
            chunk.id, chunk.file_path, chunk.node_type ?? null, chunk.name ?? null,
            nameLowerOf(chunk.name), chunk.docstring ?? '', chunk.code_snippet ?? '',
            chunk.content_hash ?? null, chunk.start_line ?? null, chunk.end_line ?? null,
            jsonArr(chunk.calls), jsonArr(chunk.params), chunk.return_type ?? '',
            chunk.class_context ?? '', jsonArr(chunk.type_refs), jsonArr(chunk.decorators),
            jsonArr(chunk.extends), chunk.hyde ?? null, chunk.summary ?? null, jsonArr(chunk.concepts),
            docLen, JSON.stringify(pathTokens),
            chunk.content_hash ? embeddingKeyFor(chunk) : null,
            vecEntry ? vecEntry.offset : -1, vecEntry ? vecEntry.dim : 0,
            jsonArr(chunk.call_sites)
        );
        for (const callee of (chunk.calls || [])) this._stmtInsEdge.run(callee, chunk.id);
        return docLen;
    }

    /**
     * Atomically replace every chunk of one file — the incremental-update entry
     * point used by the watch daemon. Mirrors MemoryGraphIndex.applyFileUpdate.
     *
     * New vectors are APPENDED to the shared .embeddings.bin (O(changed chunks),
     * never a full rewrite); unchanged chunks reuse their existing bin offsets.
     * All SQL runs in one WAL transaction, so concurrent readers see either the
     * old or the new file state, never a partial one. BM25 document-frequency
     * and length accounting is decremented from the chunk's actual posting rows,
     * so incremental state matches what a full rebuild would produce.
     *
     * @param {string} filePath
     * @param {object} p
     * @param {object[]} [p.chunks]
     * @param {string[]} [p.imports]
     * @param {Map<string, Float32Array|number[]>} [p.embeddings] New vectors keyed by embeddingKeyFor(chunk).
     */
    applyFileUpdate(filePath, { chunks = [], imports = [], embeddings = null } = {}) {
        if (!this.db) this.load();
        this._prepareWrite();
        this._maybeRefresh();

        // Append new vectors first — orphan bytes on a failed commit are harmless
        // and compacted away by the next full index run.
        let appended = new Map();
        const embCount = embeddings ? (embeddings instanceof Map ? embeddings.size : Object.keys(embeddings).length) : 0;
        if (embCount > 0) {
            appended = appendEmbeddingBinary(this._embeddingPath, embeddings);
            if (this._vecFd < 0) this._openVecFd();
            if (!this._dim && appended.size > 0) this._dim = appended.values().next().value.dim;
            // Keep our own sketch current (tail-only scan of what we just wrote).
            if (this._sketch) {
                try { this._sketch = updateVectorSketch(this._sketch, { fd: this._vecFd }); }
                catch { this._sketch = null; }
            }
        }

        this.db.exec('BEGIN');
        try {
            // A per-file edit makes the whole-program symbol graph (A4) stale; clear it so
            // findCallers/findReferers fall back to the always-correct scan until the next
            // full `idx-index` rebuilds it (the daemon never rebuilds the graph).
            if (this._hasEdges) { this.db.exec('DELETE FROM edges'); this._hasEdges = false; }
            if (this._hasCentrality) { this.db.exec('DELETE FROM centrality'); this._hasCentrality = false; this._centralityTotal = 0; }
            if (this._hasTaint) { this.db.exec('DELETE FROM taint'); this._hasTaint = false; }
            if (this._hasScipRefs) { this.db.exec('DELETE FROM scip_refs'); this._hasScipRefs = false; this._scipRefsObj = null; }
            if (this._hasSparseModel) { this.db.exec('DELETE FROM sparse_model'); this._hasSparseModel = false; this._sparseModelObj = null; }

            // Capture reusable vector offsets BEFORE deleting old rows, which may
            // be the only rows that hold those offsets.
            const reuse = new Map();
            for (const chunk of chunks) {
                if (!chunk.content_hash) continue;
                const key = embeddingKeyFor(chunk);
                if (appended.has(key) || reuse.has(key)) continue;
                const row = this._stmtVecByKey.get(key) ?? this._stmtVecByHash.get(chunk.content_hash);
                if (row) reuse.set(key, { offset: row.vec_offset, dim: row.vec_dim });
            }

            let docCount = this._docCount;
            let totalDocLen = this._totalDocLen;
            for (const row of this._stmtByFile.all(filePath)) {
                for (const { term } of this._stmtPostByChunk.all(row.id)) {
                    this._stmtDecTerm.run(term);
                }
                this._stmtDelPostings.run(row.id);
                this._stmtDelEdges.run(row.id);
                this._stmtDelChunk.run(row.id);
                totalDocLen -= (row.doc_len || 0);
                docCount--;
            }

            for (const chunk of chunks) {
                const key = chunk.content_hash ? embeddingKeyFor(chunk) : null;
                const vecEntry = key ? (appended.get(key) ?? reuse.get(key) ?? null) : null;
                totalDocLen += this._insertChunk(chunk, imports, vecEntry);
                docCount++;
            }
            this._stmtPruneTerms.run();

            this._stmtDelDeps.run(filePath);
            if (!imports || imports.length === 0) this._stmtInsDep.run(filePath, null);
            else for (const d of imports) this._stmtInsDep.run(filePath, d);

            docCount = Math.max(0, docCount);
            totalDocLen = Math.max(0, totalDocLen);
            this._stmtInsMeta.run('doc_count', String(docCount));
            this._stmtInsMeta.run('total_doc_len', String(totalDocLen));
            this._stmtInsMeta.run('dim', String(this._dim));
            this._stmtInsMeta.run('built_at', String(Date.now()));
            this.db.exec('COMMIT');

            this._docCount = docCount;
            this._totalDocLen = totalDocLen;
            this._avgdl = docCount > 0 ? totalDocLen / docCount : 1;
        } catch (err) {
            try { this.db.exec('ROLLBACK'); } catch { /* not in txn */ }
            throw err;
        }

        const oldDeps = this._graph.dependencies[filePath] || [];
        for (const oldDep of oldDeps) {
            if (this._graph.importedBy[oldDep]) {
                this._graph.importedBy[oldDep] = this._graph.importedBy[oldDep].filter(f => f !== filePath);
            }
        }
        this._graph.dependencies[filePath] = imports || [];
        for (const dep of (imports || [])) {
            (this._graph.importedBy[dep] ||= []);
            if (!this._graph.importedBy[dep].includes(filePath)) this._graph.importedBy[dep].push(filePath);
        }
        // Our own commit bumps data_version for other connections, not this one —
        // re-read so the next _maybeRefresh() doesn't see a spurious change.
        this._dataVersion = this._readDataVersion();
    }

    /** Remove a deleted file's chunks, postings, edges and graph node. */
    removeFile(filePath) {
        this.applyFileUpdate(filePath, { chunks: [], imports: [] });
        // applyFileUpdate leaves a (file → null) deps row so the file stays a graph
        // node; a deleted file should disappear from the graph entirely.
        this._stmtDelDeps.run(filePath);
        delete this._graph.dependencies[filePath];
        this._dataVersion = this._readDataVersion();
    }

    // ─── Build (write path, used by the indexer) ───────────────────────────────

    /**
     * (Re)build the entire database from an in-memory index payload. Runs as a
     * single transaction (concurrent readers see the old index until the commit);
     * mirrors exactly how MemoryGraphIndex derives its BM25 posting lists,
     * document lengths, symbol and call indexes, so the two backends stay
     * rank-consistent.
     *
     * @param {object} payload
     * @param {object[]} payload.chunks
     * @param {{dependencies:Object<string,string[]>}} payload.graph
     * @param {Map<string,Float32Array>|object} [payload.embeddingCache]  Keyed by embeddingKeyFor(chunk).
     */
    buildFrom({ chunks, graph, embeddingCache, edges = null, centrality = null, taint = null, scipRefs = null, sparseModel = null }) {
        this._open();
        this.db.exec('PRAGMA synchronous = OFF;'); // safe only for a full rebuild; not used for incremental writes

        const offsets = new Map();
        let dim = 0;
        const cacheSize = embeddingCache instanceof Map ? embeddingCache.size : Object.keys(embeddingCache || {}).length;
        if (cacheSize > 0) {
            const buf = writeEmbeddingBinary(embeddingCache);
            fs.writeFileSync(this._embeddingPath, buf);
            let off = 0;
            const count = buf.readUInt32LE(off); off += 4;
            for (let i = 0; i < count; i++) {
                const hl = buf.readUInt32LE(off); off += 4;
                const key = buf.subarray(off, off + hl).toString('utf8'); off += hl;
                const d = buf.readUInt32LE(off); off += 4;
                offsets.set(key, { offset: off, dim: d });
                if (!dim) dim = d;
                off += d * 4;
            }
        }

        const df = new Map();
        let totalDocLen = 0, docCount = 0;

        this.db.exec('BEGIN');
        // Drop inside the transaction so concurrent readers see the old index
        // until COMMIT, never briefly-empty tables.
        this.db.exec(`
            DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS postings;
            DROP TABLE IF EXISTS terms;  DROP TABLE IF EXISTS call_edges;
            DROP TABLE IF EXISTS deps;   DROP TABLE IF EXISTS meta;
            DROP TABLE IF EXISTS routes; DROP TABLE IF EXISTS edges;
            DROP TABLE IF EXISTS centrality; DROP TABLE IF EXISTS taint;
            DROP TABLE IF EXISTS scip_refs; DROP TABLE IF EXISTS sparse_model;
        `);
        this.db.exec(SCHEMA_TABLES);
        this.db.exec(SCHEMA_INDEXES);

        const insChunk = this.db.prepare(
            `INSERT OR REPLACE INTO chunks (${CHUNK_COLS.join(', ')}) `
            + `VALUES (${CHUNK_COLS.map(() => '?').join(', ')})`
        );
        const insPost = this.db.prepare('INSERT INTO postings (term, chunk_id, tf) VALUES (?, ?, ?)');
        const insEdge = this.db.prepare('INSERT INTO call_edges (callee, chunk_id) VALUES (?, ?)');

        for (const chunk of chunks) {
            const deps = (graph?.dependencies?.[chunk.file_path]) || [];
            const doc = buildLexicalDocument(chunk, deps);
            const tokens = tokenize(doc);                       // raw + additive stems
            const docLen = tokenize(doc, false).length;          // raw-only length for BM25 avgdl (parity w/ memory engine)
            totalDocLen += docLen; docCount++;

            const termCounts = new Map();
            for (const t of tokens) termCounts.set(t, (termCounts.get(t) || 0) + 1);
            for (const [term, cnt] of termCounts) {
                df.set(term, (df.get(term) || 0) + 1);
                insPost.run(term, chunk.id, cnt);
            }

            const pathTokens = Array.from(new Set(tokenize(chunk.file_path.replace(/[/\-_.]/g, ' '), false)));
            const vecKey = chunk.content_hash ? embeddingKeyFor(chunk) : null;
            const vec = vecKey ? (offsets.get(vecKey) ?? offsets.get(chunk.content_hash)) : null;

            insChunk.run(
                chunk.id, chunk.file_path, chunk.node_type ?? null, chunk.name ?? null,
                nameLowerOf(chunk.name), chunk.docstring ?? '', chunk.code_snippet ?? '',
                chunk.content_hash ?? null, chunk.start_line ?? null, chunk.end_line ?? null,
                jsonArr(chunk.calls), jsonArr(chunk.params), chunk.return_type ?? '',
                chunk.class_context ?? '', jsonArr(chunk.type_refs), jsonArr(chunk.decorators),
                jsonArr(chunk.extends), chunk.hyde ?? null, chunk.summary ?? null, jsonArr(chunk.concepts),
                docLen, JSON.stringify(pathTokens), vecKey,
                vec ? vec.offset : -1, vec ? vec.dim : 0,
                jsonArr(chunk.call_sites)
            );
            for (const callee of (chunk.calls || [])) insEdge.run(callee, chunk.id);
        }

        const insTerm = this.db.prepare('INSERT OR REPLACE INTO terms (term, df) VALUES (?, ?)');
        for (const [term, d] of df) insTerm.run(term, d);

        const insDep = this.db.prepare('INSERT INTO deps (file, dep) VALUES (?, ?)');
        for (const [file, list] of Object.entries(graph?.dependencies || {})) {
            if (!list || list.length === 0) insDep.run(file, null);
            else for (const d of list) insDep.run(file, d);
        }

        // Inserted in array order so the autoincrement id mirrors the in-memory
        // graph.routes order, keeping both backends rank-identical.
        const insRoute = this.db.prepare(
            'INSERT INTO routes (method, path, handler_name, handler_chunk_id, file_path, line, framework) '
            + 'VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        for (const r of (graph?.routes || [])) {
            insRoute.run(
                String(r.method || ''), String(r.path ?? ''), r.handler_name ?? null,
                r.handler_chunk_id ?? null, String(r.file_path || ''),
                r.line ?? null, r.framework ?? null
            );
        }

        // A4 resolved symbol graph (opt-in). Inserted in the deterministic order produced
        // by buildSymbolGraph so the table mirrors the in-memory edge list.
        if (Array.isArray(edges) && edges.length) {
            const insEdge = this.db.prepare(
                'INSERT INTO edges (from_chunk_id, to_chunk_id, kind, confidence) VALUES (?, ?, ?, ?)'
            );
            for (const e of edges) insEdge.run(e.from_chunk_id, e.to_chunk_id, e.kind, e.confidence);
        }

        // A5 symbol centrality (opt-in). Precomputed score/rank per chunk id; both backends
        // read these exact numbers → parity-free. Inserted in rank order for tidy storage.
        if (centrality && typeof centrality === 'object') {
            const insCen = this.db.prepare('INSERT INTO centrality (chunk_id, score, rank) VALUES (?, ?, ?)');
            const rows = Object.entries(centrality).sort((a, b) => a[1].rank - b[1].rank);
            for (const [id, v] of rows) insCen.run(id, v.score, v.rank);
        }

        // C2 serialized taint flows (opt-in). A single JSON payload (id = 0); both backends parse
        // the identical bytes → parity-free, exactly like edges/centrality.
        if (taint && typeof taint === 'object') {
            this.db.prepare('INSERT INTO taint (id, payload) VALUES (0, ?)').run(JSON.stringify(taint));
        }

        // A2 v2 SCIP precise references (opt-in --resolver scip). A single JSON payload (id = 0) of
        // `{ defChunkId: [refererChunkId, …] }`; both backends parse identical bytes → parity-free,
        // exactly like taint. find_references reads it for the cross-file `resolved` reference tier.
        if (scipRefs && typeof scipRefs === 'object' && Object.keys(scipRefs).length) {
            this.db.prepare('INSERT INTO scip_refs (id, payload) VALUES (0, ?)').run(JSON.stringify(scipRefs));
        }

        // B3 learned-sparse model (opt-in --learned-sparse). A single JSON payload (id = 0); both
        // backends parse identical bytes → parity-free, exactly like taint/scip_refs.
        if (sparseModel && typeof sparseModel === 'object' && sparseModel.assoc) {
            this.db.prepare('INSERT INTO sparse_model (id, payload) VALUES (0, ?)').run(JSON.stringify(sparseModel));
        }

        const insMeta = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
        insMeta.run('doc_count', String(docCount));
        insMeta.run('total_doc_len', String(totalDocLen));
        insMeta.run('dim', String(dim));
        insMeta.run('built_at', String(Date.now()));
        this.db.exec('COMMIT');

        this.db.close();
        this.db = null;
        this._writeReady = false;
        return { chunks: docCount, terms: df.size, dim };
    }
}
