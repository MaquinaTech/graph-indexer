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
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { resolveConfig, describeConfig, configNotices } from './config.mjs';
import { ensureDataDir, migrateLegacyLayout } from './layout.mjs';
import { daemonStatus } from './daemon-lock.mjs';
import { createStore } from './storage.mjs';
import { registerTools } from './mcp-tools.mjs';
import { createEmbedder, readEmbedMeta } from './embeddings.mjs';
import { loadGitSignals } from './git-signals.mjs';

const config = resolveConfig();
const PROJECT_ROOT = config.projectRoot;
const PID_FILE = config.pidFile;
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

// Make sure the data dir exists and any pre-v1.4 root artifacts are relocated
// before we touch index paths or start watching the data dir.
ensureDataDir(PROJECT_ROOT);
migrateLegacyLayout(PROJECT_ROOT);

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
    // The daemon owns the PID lock exclusively (it acquires it atomically on
    // startup — see daemon-lock.mjs). We only check whether one is already live;
    // if not, we spawn it detached. Even if two servers race here, the losing
    // daemon fails to acquire the lock and exits, so never more than one runs.
    const { running, pid } = daemonStatus(PID_FILE);
    if (running) { process.stderr.write(`✅ Daemon already active (PID: ${pid}).\n`); return; }

    const daemonPath = path.join(PACKAGE_DIR, 'watch-daemon.mjs');
    process.stderr.write(`🚀 Starting Watcher Daemon...\n   Log: ${config.logFile}\n`);
    let logFd;
    try { logFd = fs.openSync(config.logFile, 'a'); } catch { logFd = null; }
    const child = spawn(process.execPath, [daemonPath], {
        detached: true,
        stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
        env: { ...process.env, MCP_PROJECT_ROOT: PROJECT_ROOT },
    });
    child.unref();
    if (logFd !== null) fs.closeSync(logFd);
}

// ─── Boot ──────────────────────────────────────────────────────────────────────

ensureDaemonRunning();

const version = readPackageVersion();
const server = new McpServer({ name: 'graph-indexer', version });

const db = await createStore(config, { cacheEmbeddings: false });
const backend = db.backend; // 'auto' is resolved to a concrete backend by createStore.

// Effective configuration, so users can see exactly what is running, never silently.
process.stderr.write('⚙️  Effective configuration:\n');
for (const line of describeConfig(config, { backend })) process.stderr.write(`     ${line}\n`);
for (const notice of configNotices(config)) process.stderr.write(`⚠️  ${notice}\n`);

try { db.load(); } catch (err) { process.stderr.write(`⏳ Waiting for initial indexing… (${err.message})\n`); }

// In-memory backend: the daemon is a separate process that rewrites
// code-index.json — without reloading, this server would answer from a stale
// snapshot until restart. (The SQLite store refreshes itself per query via
// PRAGMA data_version, so no watcher is needed there.)
if (backend !== 'sqlite' && typeof db.reload === 'function') {
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

// ─── Query embedder ────────────────────────────────────────────────────────────
// Query with the SAME provider/model the index was built with (stamped in the
// embeddings-bin sidecar). No stamp → an index from an older version: keep the
// legacy behaviour (try Ollama, fall back to lexical). The local pipeline loads
// lazily on first query, so an unused provider costs nothing at startup.
const embedMeta = readEmbedMeta(config.embeddingPath);
const embedder = await createEmbedder(
    config,
    embedMeta?.provider
        ? { provider: embedMeta.provider, model: embedMeta.model }
        : { provider: config.embeddingsEnabled ? 'ollama' : 'off', model: config.embedModel }
);

// ─── Git signals (air-gapped sidecar; blast-radius hint + opt-in rank boost) ────
const gitSignals = config.gitSignals ? loadGitSignals(config.gitSignalsPath) : null;

// ─── Tools ───────────────────────────────────────────────────────────────────
registerTools(server, db, {
    projectRoot: PROJECT_ROOT,
    artifactPath: backend === 'sqlite' ? config.sqlitePath : config.indexPath,
    pidFile: PID_FILE,
    embeddingsEnabled: config.embeddingsEnabled && embedder.provider !== 'off',
    embedder,
    rerank: config.rerank,
    hyde: config.hyde,
    ollamaHost: config.ollamaHost,
    gitSignals,
    gitRankBoost: config.gitRankBoost,
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`✅ graph-indexer MCP server running (v${version}, ${backend} backend).\n`);
