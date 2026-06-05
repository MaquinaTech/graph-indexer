#!/usr/bin/env node
/**
 * @file watch-daemon.mjs
 * @description Native FileSystem Watcher Daemon to maintain an in-memory graph index. Utilizes Tree-sitter for AST parsing and local embedding generation.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license GPL-3.0-only
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed with the hope that it will be beneficial,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 */

import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';
import { MemoryGraphIndex } from './core-engine.mjs';
import {
    MAX_FILE_SIZE_BYTES, EXTENSIONS, getParserForFile, buildIgnoreFilter,
    extractImportsFromAST, extractSemanticChunks, resolveLocalImports, getLocalEmbeddingsBatch
} from './parser-utils.mjs';

const PROJECT_ROOT = process.env.MCP_PROJECT_ROOT || process.cwd();
const INDEX_PATH = path.join(PROJECT_ROOT, 'code-index.json');

const ignoreFilter = buildIgnoreFilter(PROJECT_ROOT);
const db = new MemoryGraphIndex(INDEX_PATH);
db.load();

async function processFileChange(absolutePath) {
    const filename = path.relative(PROJECT_ROOT, absolutePath).replace(/\\/g, '/');
    if (ignoreFilter.ignores(filename)) return;
    if (filename.includes('.bundle.') || filename.includes('.min.')) return;

    try {
        if (!fs.existsSync(absolutePath)) {
            for (const [id, chunk] of db.chunks.entries()) {
                if (chunk.file_path === filename) {
                    db._removeLexical(id);
                    db.chunks.delete(id);
                    db.removeVector(id);
                }
            }
            db.updateFileGraph(filename, []);
            db.saveDebounced();
            process.stderr.write(`[daemon] 🗑️  Purged: ${filename}\n`);
            return;
        }

        const stats = fs.statSync(absolutePath);
        if (stats.size > MAX_FILE_SIZE_BYTES) return;

        let content = fs.readFileSync(absolutePath, 'utf-8');
        if (!content.trim()) return;

        const ext = path.extname(absolutePath);
        const parser = getParserForFile(ext);
        if (!parser) return;

        const tree = parser.parse(content);
        const imports = resolveLocalImports(extractImportsFromAST(tree.rootNode, ext), filename, PROJECT_ROOT);
        db.updateFileGraph(filename, imports);

        const newChunks = extractSemanticChunks(tree.rootNode, filename, content, ext);

        for (const [id, chunk] of db.chunks.entries()) {
            if (chunk.file_path === filename) {
                db._removeLexical(id);
                db.chunks.delete(id);
                db.removeVector(id); // invalidates flat matrix so next search rebuilds it
            }
        }

        const chunksToEmbed = newChunks.filter(c => !db.embeddingCache.has(c.content_hash));

        if (chunksToEmbed.length > 0) {
            const textsToEmbed = chunksToEmbed.map(c => {
                const dependencies = db.graph.dependencies[c.file_path] || [];
                const cleanDeps = dependencies.map(d => path.basename(d, path.extname(d)));
                const topologicalContext = cleanDeps.length > 0
                    ? `This code architectural neighborhood connects with: ${cleanDeps.join(', ')}.`
                    : '';

                // 🥇 STRICT PAYLOAD PARITY: Eliminate real-time bleed
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
            if (embeddingsMatrix) {
                chunksToEmbed.forEach((chunk, j) => {
                    if (embeddingsMatrix[j]) {
                        db.embeddingCache.set(chunk.content_hash, new Float32Array(embeddingsMatrix[j]));
                    }
                });
            }
        }

        for (const chunk of newChunks) {
            if (db.embeddingCache.has(chunk.content_hash)) {
                db.addVector(chunk.id, db.embeddingCache.get(chunk.content_hash));
            }

            // Unified lexical re-indexing of neighborhood
            const cleanDeps = imports.map(d => d.split('/').pop().split('.')[0]);
            const enrichedContext = `${chunk.name} ${chunk.docstring || ''} ${cleanDeps.join(' ')} ${(chunk.calls || []).join(' ')} ${chunk.code_snippet}`;

            db._indexLexical(chunk.id, enrichedContext);
            db.chunks.set(chunk.id, chunk);
        }

        db.saveDebounced();
        process.stderr.write(`[daemon] 🔄 Synced: ${filename} (Cache Hit: ${newChunks.length - chunksToEmbed.length}/${newChunks.length})\n`);
    } catch (err) {
        process.stderr.write(`[daemon] ❌ Error en ${filename}: ${err.message}\n`);
    }
}

process.stderr.write(`🚀 Chokidar Watcher Daemon iniciado en: ${PROJECT_ROOT}\n`);
const watcher = chokidar.watch(PROJECT_ROOT, {
    ignored: /(^|[\/\\])\../, persistent: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
});
watcher.on('add', processFileChange).on('change', processFileChange).on('unlink', (p) => processFileChange(p));
watcher.on('error', (err) => process.stderr.write(`[daemon] 💥 OS Watcher panic: ${err.message}\n`));