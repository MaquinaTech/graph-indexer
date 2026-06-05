#!/usr/bin/env node
/**
 * @file indexer.mjs
 * @description In-Memory Graph Indexer — Bootstrap Engine. Reads .ts/.tsx/.js/.jsx files → Tree-sitter AST → Local Embeddings → code-index.json. Zero external dependencies (only Tree-sitter). No ChromaDB.
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
import {
    MAX_FILE_SIZE_BYTES, EXTENSIONS, getParserForFile, buildIgnoreFilter, getLocalEmbeddingsBatch,
    extractImportsFromAST, extractSemanticChunks, resolveLocalImports
} from './parser-utils.mjs';
import { MemoryGraphIndex, writeEmbeddingBinary } from './core-engine.mjs';

const args = process.argv.slice(2);
const repoArg = args[args.indexOf("--repo") + 1] ?? process.cwd();
const PROJECT_ROOT = path.resolve(repoArg);
const INDEX_PATH = path.join(PROJECT_ROOT, 'code-index.json');

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
    console.log(`\n🚀 Starting Optimized Indexer\n📂 Directory: ${PROJECT_ROOT}\n`);

    const ig = buildIgnoreFilter(PROJECT_ROOT);
    const files = walkRepo(PROJECT_ROOT, PROJECT_ROOT, ig);
    console.log(`Found ${files.length} files to analyse.\n`);

    const db = new MemoryGraphIndex(INDEX_PATH);
    db.load();
    const existingCache = db.embeddingCache;
    console.log(`📦 Loaded ${existingCache.size} cached embeddings from previous runs.\n`);

    const indexData = { chunks: [], graph: { dependencies: {}, importedBy: {} }, embeddingCache: {} };
    let totalCheckedFiles = 0;

    for (const absolutePath of files) {
        totalCheckedFiles++;
        const relPath = path.relative(PROJECT_ROOT, absolutePath).replace(/\\/g, '/');
        process.stdout.write(`\r⚡ Parsing AST: [${totalCheckedFiles}/${files.length}] Procesando: ${relPath.slice(-40)}                 `);

        if (relPath.includes('.bundle.') || relPath.includes('.min.')) continue;

        try {
            const stats = await fs.promises.stat(absolutePath);
            if (stats.size > MAX_FILE_SIZE_BYTES) continue;

            let content = await fs.promises.readFile(absolutePath, 'utf-8');
            if (!content.trim()) continue;

            const ext = path.extname(absolutePath);
            const parser = getParserForFile(ext);
            if (!parser) continue;

            let tree = parser.parse((offset) => offset < content.length ? content.slice(offset, offset + 4096) : null);
            const rawImports = extractImportsFromAST(tree.rootNode, ext);
            const imports = resolveLocalImports(rawImports, relPath, PROJECT_ROOT);
            indexData.graph.dependencies[relPath] = imports;

            const chunks = extractSemanticChunks(tree.rootNode, relPath, content, ext);
            for (const chunk of chunks) {
                if (existingCache.has(chunk.content_hash)) {
                    indexData.embeddingCache[chunk.content_hash] = Array.from(existingCache.get(chunk.content_hash));
                    indexData.chunks.push(chunk);
                } else {
                    indexData.chunksToEmbed = indexData.chunksToEmbed || [];
                    indexData.chunksToEmbed.push(chunk);
                }
            }
        } catch (err) {
            console.error(`\n💥 Error en ${relPath}: ${err.message}`);
        }
    }

    const pendingChunks = indexData.chunksToEmbed || [];
    console.log(`\n\n🧠 Embedding Generation (Ollama)`);
    console.log(`Chunks reciclados de la caché: ${indexData.chunks.length}`);
    console.log(`Chunks nuevos a procesar: ${pendingChunks.length}`);

    if (pendingChunks.length > 0) {
        const BATCH_SIZE = 64;
        const CONCURRENCY = 4;
        const batches = [];
        for (let i = 0; i < pendingChunks.length; i += BATCH_SIZE) {
            batches.push(pendingChunks.slice(i, i + BATCH_SIZE));
        }

        let completedChunksCount = 0;
        console.time("Embedding Generation Duration");

        const worker = async (batch) => {
            const textsToEmbed = batch.map(c => {
                const dependencies = indexData.graph.dependencies[c.file_path] || [];
                const cleanDeps = dependencies.map(d => {
                    const depsFile = path.relative(PROJECT_ROOT, d);
                    const chunkMatches = indexData.chunks.filter(c => c.file_path === depsFile);
                    return chunkMatches.map(c => c.name).join(' ');
                });
                const topologicalContext = cleanDeps.length > 0
                    ? `This code architectural neighborhood connects with: ${cleanDeps.join(', ')}.`
                    : '';

                // 🥇 BLEED PROTECTION: Flattened linear payload for Ollama without hidden indentation
                return [
                    `File Location: ${c.file_path}`,
                    `Symbol Name: ${c.node_type} -> ${c.name}`,
                    c.docstring ? `Developer Documentation: ${c.docstring}` : '',
                    topologicalContext,
                    `--- Source Code ---`,
                    c.code_snippet
                ].filter(Boolean).join('\n');
            });

            const embeddingsMatrix = await getLocalEmbeddingsBatch(textsToEmbed, true);
            if (embeddingsMatrix && embeddingsMatrix.length === batch.length) {
                for (let j = 0; j < batch.length; j++) {
                    const chunk = batch[j];
                    indexData.embeddingCache[chunk.content_hash] = embeddingsMatrix[j];
                    indexData.chunks.push(chunk);
                }
            } else {
                for (const chunk of batch) indexData.chunks.push(chunk);
            }
            completedChunksCount += batch.length;
            process.stdout.write(`\r🤖 Embedding Progress: [${completedChunksCount}/${pendingChunks.length}] Chunks procesados...`);
        };

        for (let i = 0; i < batches.length; i += CONCURRENCY) {
            const ráfaga = batches.slice(i, i + CONCURRENCY);
            await Promise.all(ráfaga.map(batch => worker(batch)));
        }
        console.timeEnd("Embedding Generation Duration");
    }

    for (const [filePath, imports] of Object.entries(indexData.graph.dependencies)) {
        for (const dep of imports) {
            if (!indexData.graph.importedBy[dep]) indexData.graph.importedBy[dep] = [];
            if (!indexData.graph.importedBy[dep].includes(filePath)) indexData.graph.importedBy[dep].push(filePath);
        }
    }

    const EMBEDDINGS_PATH = INDEX_PATH.replace(/\.json$/, '.embeddings.bin');
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
    console.log(`\n🎉 Indexing completed blazingly fast. Total fragments: ${indexData.chunks.length}\n`);
}

main().catch(console.error);