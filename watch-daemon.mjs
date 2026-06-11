#!/usr/bin/env node
/**
 * @file watch-daemon.mjs
 * @description Native FileSystem Watcher Daemon that keeps the configured index
 *              backend fresh incrementally. Backend-agnostic: file changes are
 *              parsed once (Tree-sitter), optionally enriched (LLM cache-first)
 *              and embedded (Ollama), then handed to the store's applyFileUpdate
 *              — the in-memory engine persists a debounced JSON snapshot, the
 *              SQLite store commits a per-file WAL transaction that running MCP
 *              servers pick up live via PRAGMA data_version. No more "SQLite
 *              requires a full re-index on every change".
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 * Copyright (c) 2026 MaquinaTech. All rights reserved.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright
 * notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 */

import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';
import { resolveConfig } from './config.mjs';
import { createStore } from './storage.mjs';
import {
    embeddingKeyFor, computePageRank, TEST_FILE_RE, EXAMPLE_DIR_RE,
    summaryEmbeddingText, SUMMARY_VEC_SUFFIX,
} from './search-core.mjs';
import {
    MAX_FILE_SIZE_BYTES, getParserForFile, buildIgnoreFilter,
    extractImportsFromAST, extractSemanticChunks, resolveLocalImports, getLocalEmbeddingsBatch,
    buildEmbeddingPayload,
} from './parser-utils.mjs';
import {
    loadEnrichmentCache, saveEnrichmentCache, attachEnrichment,
    ollamaGenerate, parseEnrichResponse, buildEnrichPrompt,
} from './enrichment.mjs';

const config = resolveConfig();
const PROJECT_ROOT = config.projectRoot;

const ignoreFilter = buildIgnoreFilter(PROJECT_ROOT);
const db = await createStore(config, { cacheEmbeddings: true });
db.load();

// ─── Enrichment (cache-first, live for core files) ──────────────────────────────
// Cached entries re-attach for free on every change. When enrichment is enabled
// and the changed file sits in the PageRank core, new/changed chunks are enriched
// live (best-effort, low concurrency) so edits don't silently lose their semantic
// metadata until the next full index run.
const enrichCache = config.enrichment.enabled
    ? loadEnrichmentCache(config.enrichmentCachePath)
    : null;
let enrichCacheDirty = false;
let saveCacheTimer = null;
function scheduleEnrichCacheSave() {
    if (!enrichCacheDirty) return;
    if (saveCacheTimer) clearTimeout(saveCacheTimer);
    saveCacheTimer = setTimeout(() => {
        saveCacheTimer = null;
        try { saveEnrichmentCache(config.enrichmentCachePath, enrichCache); enrichCacheDirty = false; }
        catch (err) { process.stderr.write(`[daemon] ⚠️ enrichment cache save failed: ${err.message}\n`); }
    }, 3000);
}

let _coreFiles = null;
function isEnrichableFile(filename) {
    if (TEST_FILE_RE.test(filename) || EXAMPLE_DIR_RE.test(filename)) return false;
    if (config.enrichment.coreRatio >= 1) return true; // all production files
    if (!_coreFiles) {
        const pr = computePageRank(db.graph);
        const files = Array.from(pr.keys()).sort((a, b) => (pr.get(b) ?? 0) - (pr.get(a) ?? 0));
        const coreCount = Math.max(1, Math.ceil(files.length * config.enrichment.coreRatio));
        _coreFiles = new Set(files.slice(0, coreCount));
    }
    return _coreFiles.has(filename);
}

async function enrichChunks(filename, chunks) {
    if (!enrichCache) return;
    const pending = [];
    for (const chunk of chunks) {
        if (!chunk.content_hash) continue;
        if (attachEnrichment(chunk, enrichCache.get(chunk.content_hash))) continue;
        pending.push(chunk);
    }
    if (pending.length === 0 || !isEnrichableFile(filename)) return;
    // Live enrichment of changed core chunks: sequential and best-effort — a file
    // save touches a handful of chunks, so latency stays low and failures only
    // mean "no enrichment until the next full index run".
    for (const chunk of pending) {
        if ((chunk.end_line - chunk.start_line) < 4) continue; // trivial stubs
        const raw = await ollamaGenerate(buildEnrichPrompt(chunk), {
            model: config.enrichment.model, ollamaHost: config.ollamaHost, timeoutMs: 20000,
        });
        const parsed = parseEnrichResponse(raw);
        if (!parsed) break; // model unreachable — stop trying for this batch
        chunk.summary  = parsed.summary;
        chunk.concepts = parsed.concepts;
        chunk.hyde     = parsed.hyde;
        enrichCache.set(chunk.content_hash, {
            summary: parsed.summary, concepts: parsed.concepts, model: config.enrichment.model,
        });
        enrichCacheDirty = true;
    }
    scheduleEnrichCacheSave();
}

// ─── Incremental file sync ──────────────────────────────────────────────────────

// Catch-up scan: chokidar fires 'add' for every existing file at startup. Files
// not modified since the index artifact was last written are already indexed —
// skipping them turns daemon start from O(repo) parse work into O(changed files),
// while still picking up edits made while the daemon was down.
const ARTIFACT_PATH = config.storage === 'sqlite' ? config.sqlitePath : config.indexPath;
let indexBuiltAt = 0;
try { indexBuiltAt = fs.statSync(ARTIFACT_PATH).mtimeMs; } catch { /* no index yet → full scan */ }
let initialScan = true;

async function processFileChange(absolutePath) {
    const filename = path.relative(PROJECT_ROOT, absolutePath).replace(/\\/g, '/');
    if (ignoreFilter.ignores(filename)) return;
    if (filename.includes('.bundle.') || filename.includes('.min.')) return;
    if (filename.startsWith('code-index.')) return; // never index our own artifacts

    try {
        if (initialScan && indexBuiltAt > 0 && fs.existsSync(absolutePath)
            && fs.statSync(absolutePath).mtimeMs <= indexBuiltAt) {
            return; // unchanged since the last index write
        }

        if (!fs.existsSync(absolutePath)) {
            if (typeof db.removeFile === 'function') db.removeFile(filename);
            else db.applyFileUpdate(filename, { chunks: [], imports: [] });
            _coreFiles = null;
            process.stderr.write(`[daemon] 🗑️  Purged: ${filename}\n`);
            return;
        }

        const stats = fs.statSync(absolutePath);
        if (stats.size > MAX_FILE_SIZE_BYTES) return;

        const content = fs.readFileSync(absolutePath, 'utf-8');
        if (!content.trim()) return;

        const ext = path.extname(absolutePath);
        const parser = getParserForFile(ext);
        if (!parser) return;

        const tree = parser.parse((offset) => offset < content.length ? content.slice(offset, offset + 4096) : null);
        const imports = resolveLocalImports(extractImportsFromAST(tree.rootNode, ext), filename, PROJECT_ROOT);
        const newChunks = extractSemanticChunks(tree.rootNode, filename, content, ext);
        _coreFiles = null; // dependency graph may change → PageRank core set is stale

        // Enrichment BEFORE embedding so the summary rides the vector payload
        // (embeddingKeyFor accounts for it, so cache lookups stay correct).
        await enrichChunks(filename, newChunks);

        // 🥇 STRICT PAYLOAD PARITY: identical embedding payloads to indexer.mjs
        // (shared helpers) so incremental updates match the bootstrap index —
        // including the summary-only second vector for enriched chunks.
        const chunksToEmbed = newChunks.filter(c => !db.hasEmbedding(embeddingKeyFor(c)));
        const embeddings = new Map();
        if (chunksToEmbed.length > 0) {
            const entries = [];
            for (const c of chunksToEmbed) {
                entries.push({ key: embeddingKeyFor(c), text: buildEmbeddingPayload(c, imports) });
                const sText = summaryEmbeddingText(c);
                if (sText) entries.push({ key: embeddingKeyFor(c) + SUMMARY_VEC_SUFFIX, text: sText });
            }
            const embeddingsMatrix = await getLocalEmbeddingsBatch(entries.map(e => e.text), true, {
                ollamaHost: config.ollamaHost, model: config.embedModel,
            });
            if (embeddingsMatrix && embeddingsMatrix.length === entries.length) {
                entries.forEach((entry, j) => {
                    if (embeddingsMatrix[j]) embeddings.set(entry.key, new Float32Array(embeddingsMatrix[j]));
                });
            }
        }

        db.applyFileUpdate(filename, { chunks: newChunks, imports, embeddings });
        process.stderr.write(
            `[daemon] 🔄 Synced: ${filename} (${newChunks.length} chunks, `
            + `${newChunks.length - chunksToEmbed.length} cached vectors, ${config.storage})\n`
        );
    } catch (err) {
        process.stderr.write(`[daemon] ❌ Error in ${filename}: ${err.message}\n`);
    }
}

// Serialize updates: chokidar can fire bursts (git checkout, format-on-save across
// files); per-file work must not interleave inside the store.
let queue = Promise.resolve();
function enqueue(absolutePath) {
    queue = queue.then(() => processFileChange(absolutePath)).catch(() => {});
}

process.stderr.write(`🚀 Watcher Daemon started in: ${PROJECT_ROOT} (backend: ${config.storage})\n`);

// Only watch source files we can actually index. Critically, this prevents
// chokidar from descending into node_modules / dist / .git / .gitignored dirs —
// watching those would exhaust the OS file-watcher limit (ENOSPC on Linux) and
// waste CPU/memory on large projects. The ignore decision happens at the watcher
// level, not just in processFileChange, so ignored trees are never traversed.
function shouldIgnore(absPath) {
    const rel = path.relative(PROJECT_ROOT, absPath).replace(/\\/g, '/');
    if (!rel) return false;                       // the project root itself
    if (path.basename(absPath).startsWith('.')) return true; // dotfiles / dot-dirs
    if (rel.startsWith('code-index.')) return true;          // our own artifacts (.db/-wal/.bin/.json)
    try { return ignoreFilter.ignores(rel); }     // node_modules, dist, .gitignore, …
    catch { return false; }
}

const watcher = chokidar.watch(PROJECT_ROOT, {
    ignored: shouldIgnore,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
});
watcher.on('add', enqueue).on('change', enqueue).on('unlink', enqueue);
watcher.on('ready', () => { queue = queue.then(() => { initialScan = false; }); });
watcher.on('error', (err) => process.stderr.write(`[daemon] 💥 OS Watcher panic: ${err.message}\n`));

function shutdown() {
    watcher.close().catch(() => {});
    if (enrichCache && enrichCacheDirty) {
        try { saveEnrichmentCache(config.enrichmentCachePath, enrichCache); } catch { /* best effort */ }
    }
    if (typeof db.close === 'function') db.close();
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
