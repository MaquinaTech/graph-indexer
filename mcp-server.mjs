#!/usr/bin/env node
/**
 * @file mcp-server.mjs
 * @description MCP server bootstrap. Resolves configuration, selects the storage
 *              backend (in-memory by default, SQLite when configured), registers
 *              the tool surface (mcp-tools.mjs) and connects over stdio. All
 *              retrieval logic lives in the store + search-core; all tool logic in
 *              mcp-tools — this file is wiring only.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs';
import path, { resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { resolveConfig } from './config.mjs';
import { createStore } from './storage.mjs';
import { registerTools } from './mcp-tools.mjs';
import { createEmbedder, createGenerator } from './providers.mjs';

const config = resolveConfig();
const PROJECT_ROOT = config.projectRoot;
const PID_FILE = resolve(PROJECT_ROOT, '.idx-daemon.pid');
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

function readPackageVersion() {
    try {
        return JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf-8')).version || '0.0.0';
    } catch { return '0.0.0'; }
}

// ─── Watch-daemon orchestration (both backends) ─────────────────────────────────
// The incremental watcher keeps the configured backend fresh: it rewrites the
// JSON snapshot for the in-memory engine (picked up below via an fs watch), and
// applies per-file WAL transactions for SQLite (picked up by the store via
// PRAGMA data_version). Either way, a long-running MCP server stays consistent
// with the working tree without restarts or full re-indexes.
function ensureDaemonRunning() {
    if (fs.existsSync(PID_FILE)) {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
        try { process.kill(pid, 0); process.stderr.write(`✅ Daemon already active (PID: ${pid}).\n`); return; }
        catch { fs.unlinkSync(PID_FILE); }
    }
    const daemonPath = path.join(PACKAGE_DIR, 'watch-daemon.mjs');
    const logPath = path.join(PROJECT_ROOT, '.idx-daemon.log');
    process.stderr.write(`🚀 Starting Watcher Daemon...\n   Log: ${logPath}\n`);
    let logFd;
    try { logFd = fs.openSync(logPath, 'a'); } catch { logFd = null; }
    const child = spawn(process.execPath, [daemonPath], {
        detached: true,
        stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
        env: { ...process.env, MCP_PROJECT_ROOT: PROJECT_ROOT },
    });
    child.unref();
    if (logFd !== null) fs.closeSync(logFd);
    fs.writeFileSync(PID_FILE, child.pid.toString());
}

// ─── Boot ──────────────────────────────────────────────────────────────────────

if (config.storage === 'sqlite') {
    process.stderr.write('🗄  Storage backend: SQLite (disk-backed, live daemon updates).\n');
} else if (config.storage === 'postgres') {
    process.stderr.write(`🗄  Storage backend: PostgreSQL (schema "${config.postgres.schema}", LISTEN/NOTIFY live updates).\n`);
}
ensureDaemonRunning();

const version = readPackageVersion();
const server = new McpServer({ name: 'graph-indexer', version });

const db = await createStore(config, { cacheEmbeddings: false });
try { await db.load(); } catch (err) { process.stderr.write(`⏳ Waiting for initial indexing… (${err.message})\n`); }

// In-memory backend: the daemon is a separate process that rewrites
// code-index.json — without reloading, this server would answer from a stale
// snapshot until restart. (The SQLite store refreshes itself per query via
// PRAGMA data_version; the Postgres store pushes change notifications.)
if (config.storage === 'memory' && typeof db.reload === 'function') {
    let reloadTimer = null;
    const scheduleReload = () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
            reloadTimer = null;
            try {
                db.reload();
                process.stderr.write('🔄 Index reloaded from disk (daemon update).\n');
            } catch (err) {
                process.stderr.write(`⚠️ Index reload failed: ${err.message}\n`);
            }
        }, 1000);
    };
    try {
        fs.watch(path.dirname(config.indexPath), (event, name) => {
            if (name === path.basename(config.indexPath)) scheduleReload();
        });
    } catch { /* fs.watch unavailable — index stays load-time static */ }
}

// Postgres backend: the daemon NOTIFYs after every committed file update; a
// debounced reload keeps this long-running server consistent without polling.
if (config.storage === 'postgres' && typeof db.subscribeToChanges === 'function') {
    let reloadTimer = null;
    db.subscribeToChanges(() => {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(async () => {
            reloadTimer = null;
            try {
                await db.reload();
                process.stderr.write('🔄 Index reloaded from PostgreSQL (daemon update).\n');
            } catch (err) {
                process.stderr.write(`⚠️ Index reload failed: ${err.message}\n`);
            }
        }, 1000);
    }).catch(err => process.stderr.write(`⚠️ Change subscription failed: ${err.message}\n`));
}

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT', () => { db.close(); process.exit(0); });

// ─── Graph dependency resource ─────────────────────────────────────────────────
server.resource(
    'graph-dependencies',
    new ResourceTemplate('graph://dependencies/{file_path}', {
        list: async () => ({
            resources: Object.keys(db.graph.dependencies).map(fp => ({
                uri: `graph://dependencies/${encodeURIComponent(fp)}`,
                name: fp, mimeType: 'text/markdown',
                description: `Dependency topology for ${fp}`,
            }))
        })
    }),
    async (uri, { file_path }) => {
        const p = decodeURIComponent(String(file_path));
        const deps = db.getDependencies(p);
        const usedBy = db.getImportedBy(p);
        const md = [
            `# Dependency Topology: \`${p}\``, '',
            `## Imports (${deps.length})`,
            deps.length ? deps.map(d => `- \`${d}\``).join('\n') : '_No local imports_', '',
            `## Imported By (${usedBy.length})`,
            usedBy.length ? usedBy.map(d => `- \`${d}\``).join('\n') : '_No files import this_',
        ].join('\n');
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: md }] };
    }
);

// ─── Tools ───────────────────────────────────────────────────────────────────
const embedder = createEmbedder(config);
registerTools(server, db, {
    projectRoot: PROJECT_ROOT,
    artifactPath: config.storage === 'postgres' ? null
        : config.storage === 'sqlite' ? config.sqlitePath : config.indexPath,
    pidFile: PID_FILE,
    embeddingsEnabled: config.embeddingsEnabled,
    embedQuery: embedder.embedQuery,
    rerank: config.rerank,
    rerankGenerate: createGenerator(config, 'rerank'),
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`✅ graph-indexer MCP server running (v${version}, ${config.storage} backend).\n`);
