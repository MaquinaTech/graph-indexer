/**
 * Persistent index store (node:sqlite, WAL). Every fact is owned by exactly one file, so
 * re-indexing a file is "delete its rows, insert the new ones" — the Glean model, which keeps
 * incremental updates simple and correct.
 */
import fs from 'node:fs';
import path from 'node:path';

// node:sqlite prints an ExperimentalWarning on Node 22; it is noise on an MCP server's stderr.
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (msg && msg.includes('SQLite is an experimental feature')) return;
    return origEmit.call(this, warning, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');

export const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  lang TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  hash TEXT NOT NULL,
  lines INTEGER NOT NULL,
  package TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,
  parse_errors INTEGER NOT NULL DEFAULT 0,
  api_hash TEXT,
  indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  name_lc TEXT NOT NULL,
  qname TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_id INTEGER,
  owner TEXT,
  start_line INTEGER NOT NULL, start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL, end_col INTEGER NOT NULL,
  name_line INTEGER NOT NULL, name_col INTEGER NOT NULL,
  sig TEXT, doc TEXT, type TEXT,
  exported INTEGER NOT NULL DEFAULT 0,
  visibility TEXT,
  decorators TEXT,
  bases TEXT,
  ordinal INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name_lc);
CREATE INDEX IF NOT EXISTS symbols_qname ON symbols(qname);
CREATE INDEX IF NOT EXISTS symbols_parent ON symbols(parent_id);
CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL,
  src_id INTEGER,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  recv TEXT,
  recv_type TEXT,
  dst_id INTEGER,
  conf REAL NOT NULL DEFAULT 0,
  ncand INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS refs_file ON refs(file_id);
CREATE INDEX IF NOT EXISTS refs_dst ON refs(dst_id);
CREATE INDEX IF NOT EXISTS refs_src ON refs(src_id);
CREATE INDEX IF NOT EXISTS refs_name ON refs(name);
CREATE TABLE IF NOT EXISTS imports (
  file_id INTEGER NOT NULL,
  source TEXT,
  imported TEXT,
  local TEXT,
  reexport TEXT,
  wildcard INTEGER NOT NULL DEFAULT 0,
  line INTEGER,
  target_file_id INTEGER,
  target_dir TEXT,
  target_path TEXT
);
CREATE INDEX IF NOT EXISTS imports_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS imports_target ON imports(target_file_id);
CREATE TABLE IF NOT EXISTS fields (
  file_id INTEGER NOT NULL,
  owner_qname TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fields_file ON fields(file_id);
CREATE INDEX IF NOT EXISTS fields_owner ON fields(owner_qname);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  name, qname, sig, doc, path, body,
  tokenize = 'porter unicode61 remove_diacritics 2',
  content = '', contentless_delete = 1
);
CREATE TABLE IF NOT EXISTS cochange (a INTEGER NOT NULL, b INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (a, b)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS churn (file_id INTEGER PRIMARY KEY, commits INTEGER NOT NULL, last_ts INTEGER NOT NULL);
`;

export class Store {
    constructor(dbPath) {
        this.path = dbPath;
        this.stmts = new Map();
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536; PRAGMA busy_timeout = 5000;');
        const v = this.#schemaVersion();
        if (v !== null && v !== SCHEMA_VERSION) {
            // schema changed: rebuild from scratch (the index is a cache of the source tree)
            this.db.close();
            for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch { /* none */ } }
            this.db = new DatabaseSync(dbPath);
            this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536; PRAGMA busy_timeout = 5000;');
        }
        this.db.exec(SCHEMA);
        this.setMeta('schema_version', String(SCHEMA_VERSION));
    }

    #schemaVersion() {
        try {
            const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
            return row ? Number(row.value) : null;
        } catch { return null; }
    }

    /** Cached prepared statement. */
    q(sql) {
        let s = this.stmts.get(sql);
        if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
        return s;
    }

    all(sql, ...params) { return this.q(sql).all(...params); }
    get(sql, ...params) { return this.q(sql).get(...params); }
    run(sql, ...params) { return this.q(sql).run(...params); }

    tx(fn) {
        this.db.exec('BEGIN');
        try { const r = fn(); this.db.exec('COMMIT'); return r; }
        catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
    }

    getMeta(key) { return this.get('SELECT value FROM meta WHERE key = ?', key)?.value ?? null; }
    setMeta(key, value) { this.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }

    close() { try { this.db.close(); } catch { /* closed */ } }
}
