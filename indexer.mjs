#!/usr/bin/env node
/**
 * @file indexer.mjs
 * @description Bootstrap indexer. Walks a repository, extracts Tree-sitter AST
 *              chunks + cross-file topology, generates embeddings through the
 *              configured AI provider (local Ollama by default; OpenAI or
 *              Gemini optionally), optionally enriches the most central chunks
 *              with an LLM, and writes the index to the configured backend —
 *              the default in-memory JSON artifacts, a disk-backed SQLite
 *              database (--use-sqlite), or PostgreSQL (--use-postgres).
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import path from 'path';
import {
    MAX_FILE_SIZE_BYTES, EXTENSIONS, getParserForFile, buildIgnoreFilter,
    extractImportsFromAST, extractSemanticChunks, resolveLocalImports, buildEmbeddingPayload,
} from './parser-utils.mjs';
import { readEmbeddingBinary, writeEmbeddingBinary } from './core-engine.mjs';
import { embeddingKeyFor, summaryEmbeddingText, SUMMARY_VEC_SUFFIX } from './search-core.mjs';
import { resolveConfig } from './config.mjs';
import { enrichCoreChunks } from './enrichment.mjs';
import { createEmbedder } from './providers.mjs';

const config = resolveConfig();
const PROJECT_ROOT = config.projectRoot;
const INDEX_PATH = config.indexPath;
const EMBEDDINGS_PATH = config.embeddingPath;
const embedder = createEmbedder(config);

/**
 * Vectors are reusable across runs only when they came from the same embedding
 * provider + model — mixing vector spaces silently corrupts ranking. File
 * backends record the pair in a small sidecar next to the bin; bins written
 * before the sidecar existed were always Ollama-generated.
 */
function existingCacheIsCompatible() {
    try {
        const meta = JSON.parse(fs.readFileSync(config.embeddingMetaPath, 'utf-8'));
        return meta.provider === embedder.provider && meta.model === embedder.model;
    } catch {
        return embedder.provider === 'ollama';
    }
}

function writeEmbeddingMeta() {
    fs.writeFileSync(
        config.embeddingMetaPath,
        JSON.stringify({ provider: embedder.provider, model: embedder.model }) + '\n'
    );
}

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
    console.log(
        `🗄  Storage: ${config.storage} · 🤖 Embeddings: ${embedder.model} [${embedder.provider}]`
        + `${config.enrichment.enabled ? ` · 🧠 LLM enrichment: ${config.enrichment.model} [${config.enrichment.provider}]` : ''}\n`
    );

    // A misconfigured cloud provider must fail loudly here, not silently produce
    // a lexical-only index. (An unreachable local Ollama stays graceful — the
    // air-gapped lexical-only index is a supported mode.)
    if (config.embeddingsEnabled && embedder.provider !== 'ollama') {
        const ready = embedder.available();
        if (!ready.ok) {
            console.error(`\n❌ Embedding provider '${embedder.provider}' is not usable: ${ready.reason}.`);
            console.error(`   Fix the configuration, or set INDEXER_EMBEDDINGS=off for a lexical-only index.\n`);
            process.exit(1);
        }
    }

    const ig = buildIgnoreFilter(PROJECT_ROOT);
    const files = walkRepo(PROJECT_ROOT, PROJECT_ROOT, ig);
    console.log(`Found ${files.length} files to analyse.\n`);

    // Postgres: the store is opened up front so vectors already in the database
    // serve as the cross-run embedding cache (there is no local bin artifact).
    let pgStore = null;
    let existingCache;
    if (config.storage === 'postgres') {
        const { PostgresGraphStore } = await import('./postgres-store.mjs');
        pgStore = new PostgresGraphStore(config.postgres);
        try {
            await pgStore.load();
            const sameSpace = pgStore.getMeta('embed_provider') === embedder.provider
                && pgStore.getMeta('embed_model') === embedder.model;
            existingCache = sameSpace ? pgStore.embeddingCache : new Map();
        } catch (err) {
            console.error(`\n❌ PostgreSQL connection failed: ${err.message}`);
            console.error('   Set GRAPH_INDEXER_PG_URL / DATABASE_URL (or "postgres.url" in .graph-indexer.json).\n');
            process.exit(1);
        }
    } else {
        existingCache = existingCacheIsCompatible() ? readEmbeddingBinary(EMBEDDINGS_PATH) : new Map();
    }
    console.log(`📦 Loaded ${existingCache.size} cached embeddings from previous runs.\n`);

    const indexData = { chunks: [], graph: { dependencies: {}, importedBy: {} }, embeddingCache: {} };
    const pendingChunks = [];
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
            for (const chunk of extractSemanticChunks(tree.rootNode, relPath, content, ext)) {
                pendingChunks.push(chunk);
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
        // An enriched chunk needs BOTH vectors cached (code payload + summary) to
        // skip embedding — e.g. indexes built before dual vectors only have the base.
        const summaryMissing = summaryEmbeddingText(chunk) && !existingCache.has(sKey);
        if (existingCache.has(vecKey) && !summaryMissing) {
            indexData.embeddingCache[vecKey] = Array.from(existingCache.get(vecKey));
            if (existingCache.has(sKey)) indexData.embeddingCache[sKey] = Array.from(existingCache.get(sKey));
            indexData.chunks.push(chunk);
        } else {
            toEmbed.push(chunk);
        }
    }

    console.log(`\n\n🧠 Embedding Generation (${embedder.provider})`);
    console.log(`Chunks reused from cache: ${indexData.chunks.length}`);
    console.log(`New chunks to process: ${toEmbed.length}`);

    if (toEmbed.length > 0) {
        const BATCH_SIZE = 64;
        const CONCURRENCY = 4;
        const batches = [];
        for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) batches.push(toEmbed.slice(i, i + BATCH_SIZE));

        let completed = 0;
        console.time('Embedding Generation Duration');
        const worker = async (batch) => {
            // Enriched chunks get TWO vectors: the full code payload (base key)
            // and a compact summary-only text (`key|s`) that matches the vocabulary
            // of natural-language queries (see search-core.summaryEmbeddingText).
            const entries = [];
            for (const c of batch) {
                entries.push({ key: embeddingKeyFor(c), text: buildEmbeddingPayload(c, indexData.graph.dependencies[c.file_path] || []) });
                const sText = summaryEmbeddingText(c);
                if (sText) entries.push({ key: embeddingKeyFor(c) + SUMMARY_VEC_SUFFIX, text: sText });
            }
            const matrix = await embedder.embedDocuments(entries.map(e => e.text));
            if (matrix && matrix.length === entries.length) {
                for (let j = 0; j < entries.length; j++) {
                    indexData.embeddingCache[entries[j].key] = matrix[j];
                }
            }
            for (const chunk of batch) indexData.chunks.push(chunk);
            completed += batch.length;
            process.stdout.write(`\r🤖 Embedding Progress: [${completed}/${toEmbed.length}] Chunks processed...`);
        };
        for (let i = 0; i < batches.length; i += CONCURRENCY) {
            await Promise.all(batches.slice(i, i + CONCURRENCY).map(worker));
        }
        console.timeEnd('Embedding Generation Duration');
    }

    // ── Reverse topology edges ────────────────────────────────────────────────────
    for (const [filePath, imports] of Object.entries(indexData.graph.dependencies)) {
        for (const dep of imports) {
            if (!indexData.graph.importedBy[dep]) indexData.graph.importedBy[dep] = [];
            if (!indexData.graph.importedBy[dep].includes(filePath)) indexData.graph.importedBy[dep].push(filePath);
        }
    }

    // ── Persist to the configured backend ─────────────────────────────────────────
    if (config.storage === 'postgres') {
        const res = await pgStore.buildFrom({
            chunks: indexData.chunks, graph: indexData.graph, embeddingCache: indexData.embeddingCache,
            meta: { embed_provider: embedder.provider, embed_model: embedder.model },
        });
        await pgStore.close();
        console.log(`\n🎉 PostgreSQL index built: ${res.chunks} chunks · ${res.vectors} vectors · dim ${res.dim}`);
        console.log(`   → schema "${config.postgres.schema}"\n`);
    } else if (config.storage === 'sqlite') {
        const { SqliteGraphStore } = await import('./sqlite-store.mjs');
        const store = new SqliteGraphStore(config.sqlitePath, { embeddingPath: EMBEDDINGS_PATH });
        const res = store.buildFrom({
            chunks: indexData.chunks, graph: indexData.graph, embeddingCache: indexData.embeddingCache,
        });
        writeEmbeddingMeta();
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
        writeEmbeddingMeta();
        console.log(`\n🎉 Indexing completed blazingly fast. Total fragments: ${indexData.chunks.length}\n`);
    }
}

main().catch(console.error);
