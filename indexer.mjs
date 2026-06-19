#!/usr/bin/env node
/**
 * @file indexer.mjs
 * @description Bootstrap indexer. Walks a repository, extracts Tree-sitter AST
 *              chunks + cross-file topology, generates local embeddings (Ollama),
 *              optionally enriches the most central chunks with an LLM, and writes
 *              the index to the configured backend — the default in-memory JSON
 *              artifacts, or a disk-backed SQLite database (--use-sqlite).
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import path from 'path';
import {
    MAX_FILE_SIZE_BYTES, EXTENSIONS, getParserForFile, buildIgnoreFilter,
    extractImportsFromAST, extractSemanticChunks, extractRoutes, resolveLocalImports, buildEmbeddingPayload,
    fullBodyForEmbedding,
} from './parser-utils.mjs';
import { readEmbeddingBinary, writeEmbeddingBinary } from './core-engine.mjs';
import { embeddingKeyFor, summaryEmbeddingText, SUMMARY_VEC_SUFFIX, WINDOW_VEC_SUFFIX, embeddingWindows } from './search-core.mjs';
import { createEmbedder, describeEmbedder, readEmbedMeta, writeEmbedMeta } from './embeddings.mjs';
import { resolveConfig, describeConfig, configNotices } from './config.mjs';
import { AUTO_SQLITE_CHUNK_THRESHOLD } from './storage.mjs';
import { ensureDataDir, migrateLegacyLayout } from './layout.mjs';
import { enrichCoreChunks } from './enrichment.mjs';
import { collectGitSignals, writeGitSignals } from './git-signals.mjs';

const config = resolveConfig();
const PROJECT_ROOT = config.projectRoot;
const INDEX_PATH = config.indexPath;
const EMBEDDINGS_PATH = config.embeddingPath;

// Artifacts are written under <root>/.graph-indexer/ — make sure it exists and
// relocate any artifacts left at the root by a pre-v1.4 install.
ensureDataDir(PROJECT_ROOT);
migrateLegacyLayout(PROJECT_ROOT);

function walkRepo(dir, root, ig, files = []) {
    for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith('.')) continue;
        const fullPath = path.join(dir, entry);
        const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
        if (ig.ignores(relPath)) continue;
        if (fs.statSync(fullPath).isDirectory()) {
            walkRepo(fullPath, root, ig, files);
        } else if (EXTENSIONS.has(path.extname(fullPath))) {
            files.push(fullPath);
        }
    }
    return files;
}

async function main() {
    console.log(`\n🚀 Starting Optimized Indexer\n📂 Directory: ${PROJECT_ROOT}`);
    console.log('⚙️  Effective configuration:');
    for (const line of describeConfig(config)) console.log(`     ${line}`);
    for (const notice of configNotices(config)) console.log(`⚠️  ${notice}`);
    console.log('');

    const ig = buildIgnoreFilter(PROJECT_ROOT);
    const files = walkRepo(PROJECT_ROOT, PROJECT_ROOT, ig);
    console.log(`Found ${files.length} files to analyse.\n`);

    // Resolve the embedding provider for this run (Ollama → in-process local →
    // lexical, unless forced). Index time and query time must share the model.
    const embedder = await createEmbedder(config);
    console.log(`🔎 Embeddings: ${describeEmbedder(embedder)}`);
    // Make the `auto` fallback ladder observable — never silently lexical-only.
    if (config.embedProvider === 'auto') {
        if (embedder.provider === 'local') {
            console.log(`   ↪ Ollama not reachable at ${config.ollamaHost}; using the bundled in-process model (no daemon required).`);
        } else if (embedder.provider === 'off') {
            console.log(`   ↪ No Ollama and no in-process model installed (\`npm i @huggingface/transformers\`) — indexing lexical-only.`);
        }
    }
    console.log('');

    let existingCache = readEmbeddingBinary(EMBEDDINGS_PATH);
    // A model switch invalidates the cached vectors — vectors of different models
    // (and dims) must never be mixed in one bin. Re-embed from scratch.
    const prevMeta = readEmbedMeta(EMBEDDINGS_PATH);
    if (prevMeta?.model && embedder.model && prevMeta.model !== embedder.model) {
        console.log(`⚠️  Embedding model changed (${prevMeta.model} → ${embedder.model}); re-embedding from scratch.`);
        existingCache = new Map();
    }
    console.log(`📦 Loaded ${existingCache.size} cached embeddings from previous runs.\n`);

    const indexData = { chunks: [], graph: { dependencies: {}, importedBy: {}, routes: [] }, embeddingCache: {} };
    const pendingChunks = [];
    // Full bodies of oversized chunks (snippet was truncated by the 3000-char cap),
    // captured here while we still hold the source so the dense channel can window the
    // WHOLE definition. Kept out of the chunk/JSON — transient, dropped after embedding.
    const fullBodies = new Map();
    let totalCheckedFiles = 0;

    for (const absolutePath of files) {
        totalCheckedFiles++;
        const relPath = path.relative(PROJECT_ROOT, absolutePath).replace(/\\/g, '/');
        process.stdout.write(`\r⚡ Parsing AST: [${totalCheckedFiles}/${files.length}] Processing: ${relPath.slice(-40)}                 `);

        if (relPath.includes('.bundle.') || relPath.includes('.min.')) continue;

        try {
            const stats = await fs.promises.stat(absolutePath);
            if (stats.size > MAX_FILE_SIZE_BYTES) continue;

            const content = await fs.promises.readFile(absolutePath, 'utf-8');
            if (!content.trim()) continue;

            const ext = path.extname(absolutePath);
            const parser = getParserForFile(ext);
            if (!parser) continue;

            const tree = parser.parse((offset) => offset < content.length ? content.slice(offset, offset + 4096) : null);
            const rawImports = extractImportsFromAST(tree.rootNode, ext);
            const imports = resolveLocalImports(rawImports, relPath, PROJECT_ROOT);
            indexData.graph.dependencies[relPath] = imports;

            // Chunks are collected first; embedding/enrichment happen in batch below so
            // we can route the high-value subset through the LLM before vectorising.
            const fileChunks = extractSemanticChunks(tree.rootNode, relPath, content, ext);
            for (const chunk of fileChunks) {
                const fullBody = fullBodyForEmbedding(chunk, content);
                if (fullBody) fullBodies.set(chunk.id, fullBody);
                pendingChunks.push(chunk);
            }

            // HTTP routes → handler chunks. Accumulated into the global graph.routes
            // array (each route is self-describing with file_path/line/handler_chunk_id),
            // mirroring the per-file dependencies assignment above.
            for (const route of extractRoutes(tree.rootNode, relPath, fileChunks, ext)) {
                indexData.graph.routes.push(route);
            }
        } catch (err) {
            console.error(`\n💥 Error in ${relPath}: ${err.message}`);
        }
    }

    // ── Optional LLM enrichment of the most central chunks (HyDE + summaries) ──────
    // Runs before embedding so the hypothetical questions ride the same vector.
    if (config.enrichment.enabled) {
        await enrichCoreChunks(pendingChunks, indexData.graph, config);
    }

    // ── Embedding generation (cache-aware) ────────────────────────────────────────
    // Vectors are keyed by embeddingKeyFor(chunk): content_hash for plain chunks,
    // content_hash + enrichment digest for enriched ones. Because the enrichment
    // cache returns the same summary for the same code, enriched chunks now HIT
    // this cache on re-runs — previously every enriched chunk was re-embedded on
    // every single index run.
    const toEmbed = [];
    for (const chunk of pendingChunks) {
        const vecKey = embeddingKeyFor(chunk);
        const sKey = vecKey + SUMMARY_VEC_SUFFIX;
        // Compute the payload once here and reuse it in the worker (avoids a second
        // build) — it also tells us how many window vectors an oversized chunk needs.
        // Oversized definitions embed their full body (windowed); others use the snippet.
        const payload = buildEmbeddingPayload(chunk, indexData.graph.dependencies[chunk.file_path] || [], fullBodies.get(chunk.id) || null);
        const windows = embeddingWindows(payload); // [] unless the payload is oversized
        // An enriched chunk needs its summary vector cached, and an oversized chunk
        // needs all its window vectors, to skip embedding — e.g. indexes built before
        // dual/window vectors only have the base.
        const summaryMissing = summaryEmbeddingText(chunk) && !existingCache.has(sKey);
        let windowsMissing = false;
        for (let i = 1; i < windows.length; i++) if (!existingCache.has(vecKey + WINDOW_VEC_SUFFIX + i)) { windowsMissing = true; break; }
        if (existingCache.has(vecKey) && !summaryMissing && !windowsMissing) {
            indexData.embeddingCache[vecKey] = Array.from(existingCache.get(vecKey));
            if (existingCache.has(sKey)) indexData.embeddingCache[sKey] = Array.from(existingCache.get(sKey));
            for (let i = 1; i < windows.length; i++) {
                const wk = vecKey + WINDOW_VEC_SUFFIX + i;
                if (existingCache.has(wk)) indexData.embeddingCache[wk] = Array.from(existingCache.get(wk));
            }
            indexData.chunks.push(chunk);
        } else {
            toEmbed.push({ chunk, payload, windows });
        }
    }

    console.log(`\n\n🧠 Embedding Generation — ${describeEmbedder(embedder)}`);
    console.log(`Chunks reused from cache: ${indexData.chunks.length}`);
    console.log(`New chunks to process: ${toEmbed.length}`);

    if (toEmbed.length > 0) {
        const BATCH_SIZE = 64;
        // Embedding concurrency. A single local Ollama model serves requests
        // serially, so a high fan-out just queues batches and risks per-request
        // timeouts (a large model like qwen3-embedding:4b made every queued batch
        // breach the old cap). Default 4 (fast on small models / when
        // OLLAMA_NUM_PARALLEL is set); lower it (e.g. 1) for big models on modest
        // hardware via INDEXER_EMBED_CONCURRENCY.
        const CONCURRENCY = Number(process.env.INDEXER_EMBED_CONCURRENCY) > 0
            ? Number(process.env.INDEXER_EMBED_CONCURRENCY) : 4;
        const batches = [];
        for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) batches.push(toEmbed.slice(i, i + BATCH_SIZE));

        let completed = 0, vectorBatches = 0, failedBatches = 0;
        console.time('Embedding Generation Duration');
        const worker = async (batch) => {
            // Each chunk yields: the base code-payload vector; one vector per tail
            // window (`key|wN`) when the payload is oversized so semantic search can
            // reach the tail (the base text is the full payload — the embedder
            // truncates it to window 0, byte-identical to the single-vector path); and
            // a compact summary-only vector (`key|s`) for enriched chunks, which
            // matches the vocabulary of natural-language queries.
            const entries = [];
            for (const { chunk: c, payload, windows } of batch) {
                const baseKey = embeddingKeyFor(c);
                entries.push({ key: baseKey, text: payload });
                for (let i = 1; i < windows.length; i++) entries.push({ key: baseKey + WINDOW_VEC_SUFFIX + i, text: windows[i] });
                const sText = summaryEmbeddingText(c);
                if (sText) entries.push({ key: baseKey + SUMMARY_VEC_SUFFIX, text: sText });
            }
            // Per-batch graceful degradation: a slow/failed embedding batch (e.g. a
            // timeout on a big model) must NOT abort the whole index. Those chunks
            // are still indexed lexically — they just miss their vector until the
            // next run re-tries them (the cache only stores what succeeded).
            let matrix = null;
            try { matrix = await embedder.embedDocuments(entries.map(e => e.text)); }
            catch (e) { failedBatches++; process.stderr.write(`\n⚠️  embedding batch failed (${e.message}); indexing ${batch.length} chunks lexical-only this run.\n`); }
            if (matrix && matrix.length === entries.length) {
                for (let j = 0; j < entries.length; j++) {
                    indexData.embeddingCache[entries[j].key] = matrix[j];
                }
                vectorBatches++;
            }
            for (const { chunk } of batch) indexData.chunks.push(chunk);
            completed += batch.length;
            process.stdout.write(`\r🤖 Embedding Progress: [${completed}/${toEmbed.length}] Chunks processed...`);
        };
        for (let i = 0; i < batches.length; i += CONCURRENCY) {
            await Promise.all(batches.slice(i, i + CONCURRENCY).map(worker));
        }
        console.timeEnd('Embedding Generation Duration');
        if (failedBatches > 0) {
            console.log(`⚠️  ${failedBatches}/${batches.length} embedding batches failed (lexical-only for those chunks); re-run to fill them in. `
                + `Tip: a large embed model on modest hardware wants INDEXER_EMBED_CONCURRENCY=1 and/or a higher INDEXER_EMBED_TIMEOUT_MS.`);
        }
    }

    // ── Reverse topology edges ────────────────────────────────────────────────────
    for (const [filePath, imports] of Object.entries(indexData.graph.dependencies)) {
        for (const dep of imports) {
            if (!indexData.graph.importedBy[dep]) indexData.graph.importedBy[dep] = [];
            if (!indexData.graph.importedBy[dep].includes(filePath)) indexData.graph.importedBy[dep].push(filePath);
        }
    }

    // ── Persist to the configured backend ─────────────────────────────────────────
    // Resolve 'auto' now that the true chunk count is known: keep small repos in the
    // zero-dependency in-memory JSON index; switch big ones to disk-backed SQLite.
    const backend = config.storage === 'auto'
        ? (indexData.chunks.length >= AUTO_SQLITE_CHUNK_THRESHOLD ? 'sqlite' : 'memory')
        : config.storage;
    if (config.storage === 'auto') {
        console.log(`🗄  Storage: auto → ${backend} (${indexData.chunks.length} chunks, threshold ${AUTO_SQLITE_CHUNK_THRESHOLD}).`);
    }

    if (backend === 'sqlite') {
        const { SqliteGraphStore } = await import('./sqlite-store.mjs');
        const store = new SqliteGraphStore(config.sqlitePath, { embeddingPath: EMBEDDINGS_PATH });
        const res = store.buildFrom({
            chunks: indexData.chunks, graph: indexData.graph, embeddingCache: indexData.embeddingCache,
        });
        store.close?.();
        // Remove the in-memory artifact so readers (server/daemon) unambiguously pick SQLite.
        for (const p of [INDEX_PATH, `${INDEX_PATH}.tmp`]) { try { fs.unlinkSync(p); } catch { /* none */ } }
        console.log(`\n🎉 SQLite index built: ${res.chunks} chunks · ${res.terms} terms · dim ${res.dim}`);
        console.log(`   → ${config.sqlitePath}\n`);
    } else {
        const tmpPath = `${INDEX_PATH}.tmp`;
        const tmpBinPath = `${EMBEDDINGS_PATH}.tmp`;
        await Promise.all([
            fs.promises.writeFile(tmpPath, JSON.stringify({ chunks: indexData.chunks, graph: indexData.graph })),
            fs.promises.writeFile(tmpBinPath, writeEmbeddingBinary(indexData.embeddingCache)),
        ]);
        await Promise.all([
            fs.promises.rename(tmpPath, INDEX_PATH),
            fs.promises.rename(tmpBinPath, EMBEDDINGS_PATH),
        ]);
        // Remove any SQLite artifact so readers unambiguously pick the in-memory index.
        for (const p of [config.sqlitePath, `${config.sqlitePath}-wal`, `${config.sqlitePath}-shm`]) {
            try { fs.unlinkSync(p); } catch { /* none */ }
        }
        console.log(`\n🎉 Indexing completed blazingly fast. Total fragments: ${indexData.chunks.length}\n`);
    }

    // Stamp which model produced the shared embeddings bin, so the server queries
    // with the same provider and the next index run detects a model switch.
    writeEmbedMeta(EMBEDDINGS_PATH, {
        provider: embedder.provider,
        model: embedder.model,
        dim: embedder.dim ?? prevMeta?.dim ?? null,
    });

    // ── Git signals (air-gapped: local commit log only) ───────────────────────────
    // A sidecar of churn / recency / co-change, consumed by the blast-radius tools
    // and the opt-in ranking boost. Kept out of the index/ranking math so the
    // measured retrieval ranking is unchanged. No-op outside a git repo.
    if (config.gitSignals) {
        const signals = collectGitSignals(PROJECT_ROOT);
        if (signals) {
            writeGitSignals(config.gitSignalsPath, signals);
            console.log(`🔄 Git signals: ${signals.commits} commits · ${Object.keys(signals.churn).length} files (churn/recency/co-change).\n`);
        } else {
            // Not a git repo (or a subtree with no tracked history) — drop any stale
            // sidecar so degenerate/foreign signals never linger.
            try { fs.unlinkSync(config.gitSignalsPath); } catch { /* none to remove */ }
        }
    }
}

main().catch(console.error);
