/**
 * @file layout.mjs
 * @description Single source of truth for graph-indexer's on-disk layout. All
 *              machine-generated runtime state lives in one tidy `.graph-indexer/`
 *              directory at the project root (index, vectors, SQLite db, enrichment
 *              cache, daemon pid/log, resolved config) instead of littering the
 *              root. Earlier versions wrote these artifacts straight into the root;
 *              `migrateLegacyLayout` relocates them transparently on the next run.
 *
 *              Files that other tools must discover at conventional paths — the
 *              agent prompt suite (CLAUDE.md, GRAPH_INDEXER_PROMPT.md, Cursor
 *              rules) and IDE MCP configs (.vscode/mcp.json, .cursor/mcp.json, …) —
 *              intentionally stay where those tools expect them.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import path from 'path';

export const DATA_DIR_NAME = '.graph-indexer';

export const CONFIG_FILE_NAME = 'config.json';

export function dataDir(root) {
    return path.join(root, DATA_DIR_NAME);
}

export function ensureDataDir(root) {
    const dir = dataDir(root);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * All generated artifact paths for a project root, derived from one stem so the
 * indexer, daemon, MCP server and test harness can never drift apart.
 * @returns {{dataDir,indexPath,embeddingPath,sqlitePath,enrichmentCachePath,pidFile,logFile,configPath}}
 */
export function artifactPaths(root) {
    const dir = dataDir(root);
    return {
        dataDir: dir,
        indexPath: path.join(dir, 'code-index.json'),
        embeddingPath: path.join(dir, 'code-index.embeddings.bin'),
        sqlitePath: path.join(dir, 'code-index.db'),
        enrichmentCachePath: path.join(dir, 'code-index.enrichment.json'),
        gitSignalsPath: path.join(dir, 'code-index.git.json'),
        pidFile: path.join(dir, 'daemon.pid'),
        logFile: path.join(dir, 'daemon.log'),
        configPath: path.join(dir, CONFIG_FILE_NAME),
    };
}

// ─── Legacy → current migration ─────────────────────────────────────────────────

// Regenerable runtime artifacts that lived at the project root before v1.4.
// Each [legacy-root-name, new-name-inside-data-dir]. When both copies exist the
// stale root one is safe to drop — it is a derived cache, not user data.
const LEGACY_ARTIFACTS = [
    ['code-index.json', 'code-index.json'],
    ['code-index.json.tmp', 'code-index.json.tmp'],
    ['code-index.embeddings.bin', 'code-index.embeddings.bin'],
    ['code-index.embeddings.bin.tmp', 'code-index.embeddings.bin.tmp'],
    ['code-index.db', 'code-index.db'],
    ['code-index.db-wal', 'code-index.db-wal'],
    ['code-index.db-shm', 'code-index.db-shm'],
    ['code-index.enrichment.json', 'code-index.enrichment.json'],
    ['.idx-daemon.pid', 'daemon.pid'],
    ['.idx-daemon.log', 'daemon.log'],
];

function relocate(src, dst) {
    try { fs.renameSync(src, dst); return true; }
    catch {
        try { fs.copyFileSync(src, dst); fs.unlinkSync(src); return true; }
        catch { return false; }
    }
}

/**
 * Relocate pre-v1.4 root artifacts into `.graph-indexer/`. Idempotent and
 * non-destructive to live data: an artifact is only *moved* when the destination
 * is absent; when a fresh copy already exists in the data dir, the orphaned root
 * copy (a regenerable cache) is removed to declutter. The user-editable config
 * (`.graph-indexer.json`) is only ever moved when no new config exists yet —
 * never overwritten or deleted out from under the user.
 *
 * @returns {{moved:Array<{from:string,to:string}>, removed:string[], stoppedDaemon:boolean}}
 */
export function migrateLegacyLayout(root) {
    const moved = [];
    const removed = [];
    const dir = dataDir(root);

    for (const [legacyName, newName] of LEGACY_ARTIFACTS) {
        const src = path.join(root, legacyName);
        if (!fs.existsSync(src)) continue;
        const dst = path.join(dir, newName);
        if (fs.existsSync(dst)) {
            try { fs.unlinkSync(src); removed.push(legacyName); } catch { /* keep on failure */ }
        } else {
            ensureDataDir(root);
            if (relocate(src, dst)) moved.push({ from: legacyName, to: path.join(DATA_DIR_NAME, newName) });
        }
    }

    const legacyCfg = path.join(root, '.graph-indexer.json');
    const newCfg = path.join(dir, CONFIG_FILE_NAME);
    if (fs.existsSync(legacyCfg) && !fs.existsSync(newCfg)) {
        ensureDataDir(root);
        if (relocate(legacyCfg, newCfg)) {
            moved.push({ from: '.graph-indexer.json', to: path.join(DATA_DIR_NAME, CONFIG_FILE_NAME) });
        }
    }

    return { moved, removed, stoppedDaemon: false };
}

export function hasLegacyLayout(root) {
    if (fs.existsSync(path.join(root, '.graph-indexer.json'))) return true;
    return LEGACY_ARTIFACTS.some(([legacyName]) => fs.existsSync(path.join(root, legacyName)));
}
