#!/usr/bin/env node
/**
 * @file watch-daemon.mjs
 * @description Native FileSystem Watcher Daemon to maintain in-memory graph index. Uses Tree-sitter for AST parsing and local embedding generation.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { MemoryGraphIndex, truncateForEmbedding } from './core-engine.mjs';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import CSS from 'tree-sitter-css';
import Python from 'tree-sitter-python';
import Rust from 'tree-sitter-rust';
import Go from 'tree-sitter-go';
import ignore from 'ignore';

const PROJECT_ROOT = process.env.MCP_PROJECT_ROOT || process.cwd();
const INDEX_PATH = path.join(PROJECT_ROOT, 'code-index.json');
const DEBOUNCE_MS = 300;

// ─── Language Registry ────────────────────────────────────────────────────────

const LANGUAGE_MAP = {
    '.ts': TypeScript.typescript,
    '.tsx': TypeScript.tsx,
    '.js': JavaScript,
    '.jsx': JavaScript,
    '.css': CSS,
    '.scss': CSS,
    '.py': Python,
    '.rs': Rust,
    '.go': Go,
};

const EXTENSIONS = new Set(Object.keys(LANGUAGE_MAP));

function getParserForFile(ext) {
    const language = LANGUAGE_MAP[ext];
    if (!language) return null;
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
}

// ─── Semantic AST Node Registry ───────────────────────────────────────────────
// Each entry is a Tree-sitter node type considered a "logical indexable unit".

const SEMANTIC_NODES = new Set([
    // TypeScript / JavaScript
    'function_declaration', 'method_definition', 'class_declaration',
    'interface_declaration', 'type_alias_declaration', 'arrow_function',
    'lexical_declaration',

    // CSS / SCSS
    'rule_set', 'declaration',

    // Python
    'function_definition', 'class_definition',

    // Rust
    'function_item', 'impl_item', 'struct_item', 'trait_item', 'enum_item',

    // Go
    'method_declaration', 'type_declaration',
]);

// ─── .gitignore-Aware File Filter ────────────────────────────────────────────

function buildIgnoreFilter(root) {
    const ig = ignore();
    // Always ignore common build artifacts regardless of .gitignore
    ig.add(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '*.tmp']);
    const gitignorePath = path.join(root, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        ig.add(fs.readFileSync(gitignorePath, 'utf-8'));
    }
    return ig;
}

const ignoreFilter = buildIgnoreFilter(PROJECT_ROOT);

// ─── AST Utilities ────────────────────────────────────────────────────────────

function extractImportsFromAST(rootNode, ext) {
    const imports = new Set();

    function walk(node) {
        // JS / TS (ES Modules)
        if (node.type === 'import_statement' && ['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
            const source = node.children.find(c => c.type === 'string');
            if (source) imports.add(source.text.replace(/['"]/g, ''));
        }
        // JS (CommonJS require)
        else if (node.type === 'call_expression' && node.children[0]?.text === 'require') {
            const arg = node.children[1]?.children?.find(c => c.type === 'string');
            if (arg) imports.add(arg.text.replace(/['"]/g, ''));
        }
        // SCSS (@use, @import)
        else if (node.type === 'import_statement' && ext === '.scss') {
            const source = node.children.find(c => c.type === 'string_value');
            if (source) imports.add(source.text.replace(/['"]/g, ''));
        }
        // Python (import os / from os import path)
        else if ((node.type === 'import_statement' || node.type === 'import_from_statement') && ext === '.py') {
            const moduleName = node.children.find(c => c.type === 'dotted_name');
            if (moduleName) imports.add(moduleName.text);
        }
        // Rust (use std::collections::HashMap)
        else if (node.type === 'use_declaration' && ext === '.rs') {
            const pathNode = node.children.find(c =>
                c.type === 'scoped_identifier' || c.type === 'identifier' || c.type === 'use_tree'
            );
            if (pathNode) imports.add(pathNode.text);
        }
        // Go (import "fmt" or import ( "os" ))
        else if (node.type === 'import_spec' && ext === '.go') {
            const pathNode = node.children.find(c =>
                c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal'
            );
            if (pathNode) imports.add(pathNode.text.replace(/["`]/g, ''));
        }

        node.children.forEach(walk);
    }

    walk(rootNode);
    return Array.from(imports);
}

function extractSemanticChunks(rootNode, relPath, sourceCode) {
    const chunks = [];

    function walk(node) {
        const lineCount = node.endPosition.row - node.startPosition.row;

        if (SEMANTIC_NODES.has(node.type) && lineCount >= 2) {
            // Avoid duplicating nested functions within classes or exports
            const isNested = node.parent && SEMANTIC_NODES.has(node.parent.type) && node.parent.type !== 'export_statement';

            if (!isNested) {
                let name = "anonymous";
                if (node.type === "lexical_declaration") {
                    const decl = node.children.find(c => c.type === "variable_declarator");
                    name = decl?.childForFieldName("name")?.text || name;
                } else {
                    name = node.childForFieldName?.("name")?.text || name;
                }

                // Deterministic ID based on semantics
                const id = createHash('sha256')
                    .update(`${relPath}::${node.type}::${name}`)
                    .digest('hex').slice(0, 24);

                chunks.push({
                    id,
                    file_path: relPath,
                    node_type: node.type,
                    name: name,
                    code_snippet: node.text.slice(0, 3000), // Safety limit
                    start_line: node.startPosition.row + 1,
                    end_line: node.endPosition.row + 1
                });
            }
        }
        node.children.forEach(walk);
    }
    walk(rootNode);
    return chunks;
}

// ─── Local Import Path Resolution ─────────────────────────────────────────────

function resolveLocalImports(rawImports, fromFileRelPath) {
    const fileDir = path.dirname(path.join(PROJECT_ROOT, fromFileRelPath));
    const tryExts = ['.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.py', '.rs', '.go'];
    const resolved = [];

    for (const raw of rawImports) {
        if (!raw.startsWith('.')) continue; // skip npm packages and Node built-ins

        const absResolved = path.resolve(fileDir, raw);
        const existingExt = path.extname(absResolved);
        let finalAbs = null;

        if (existingExt && tryExts.includes(existingExt) && fs.existsSync(absResolved)) {
            finalAbs = absResolved;
        } else {
            for (const ext of tryExts) {
                if (fs.existsSync(absResolved + ext)) { finalAbs = absResolved + ext; break; }
                const idx = path.join(absResolved, 'index' + ext);
                if (fs.existsSync(idx)) { finalAbs = idx; break; }
            }
        }

        if (finalAbs) resolved.push(path.relative(PROJECT_ROOT, finalAbs).replace(/\\/g, '/'));
    }

    return resolved;
}

// ─── Local Embedding Engine ───────────────────────────────────────────────────

async function getLocalEmbedding(text) {
    const MAX_RETRIES = 3;
    // Truncate to prevent HTTP 400 from context-limited Ollama models
    const safeText = truncateForEmbedding(text);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch('http://localhost:11434/api/embeddings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'nomic-embed-text', prompt: safeText }),
                signal: AbortSignal.timeout(15000),
            });
            if (res.status === 429 || res.status === 503) throw new Error(`Retryable: ${res.status}`);
            if (!res.ok) {
                process.stderr.write(`[embedding-error] HTTP ${res.status}\n`);
                return null; // Graceful degradation: caller will index lexically only
            }
            const data = await res.json();
            return data.embedding;
        } catch {
            if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
            } else {
                return null;
            }
        }
    }
    return null;
}

// ─── Watcher Daemon Logic ─────────────────────────────────────────────────────

const db = new MemoryGraphIndex(INDEX_PATH);
db.load(); // Cargar estado actual en memoria

const changeRegistry = new Map();

async function processFileChange(filename, absolutePath) {
    try {
        if (!fs.existsSync(absolutePath)) {
            // File deleted: surgically purge only its chunks from the index
            for (const [id, chunk] of db.chunks.entries()) {
                if (chunk.file_path === filename) {
                    db._removeLexical(id); // Clean up TF-IDF document frequency state
                    db.chunks.delete(id);
                    db.vectors.delete(id);
                }
            }
            db.updateFileGraph(filename, []);
            db.saveDebounced();
            process.stderr.write(`[daemon] 🗑️  Purged: ${filename}\n`);
            return;
        }

        const content = fs.readFileSync(absolutePath, 'utf-8');
        const ext = path.extname(absolutePath);
        const parser = getParserForFile(ext);

        if (!parser) return;

        const tree = parser.parse(content);
        const rawImports = extractImportsFromAST(tree.rootNode, ext);
        const imports = resolveLocalImports(rawImports, filename);
        db.updateFileGraph(filename, imports);

        const newChunks = extractSemanticChunks(tree.rootNode, filename, content);

        // Remove old chunks for this file, cleaning the lexical index first
        for (const [id, chunk] of db.chunks.entries()) {
            if (chunk.file_path === filename) {
                db._removeLexical(id); // Prevents TF-IDF memory leak on file updates
                db.chunks.delete(id);
                db.vectors.delete(id);
            }
        }

        // Index new chunks; gracefully degrade to lexical-only if Ollama is unavailable.
        // The hybrid search engine will automatically use pure TF-IDF for chunks
        // that lack a vector, ensuring zero data loss even when the embedding
        // service is down.
        for (const chunk of newChunks) {
            const embedText = truncateForEmbedding(`${chunk.node_type} ${chunk.name}\n${chunk.code_snippet}`);
            const vector = await getLocalEmbedding(embedText);

            if (vector) {
                chunk.embedding = vector;
                db.vectors.set(chunk.id, new Float32Array(vector));
            }
            // Always register in TF-IDF regardless of embedding availability
            db._indexLexical(chunk.id, chunk.code_snippet);
            db.chunks.set(chunk.id, chunk);
        }

        // Debounced async save batches rapid IDE saves into one disk write
        db.saveDebounced();
        process.stderr.write(`[daemon] 🔄 Synced: ${filename} (${newChunks.length} chunks)\n`);

    } catch (err) {
        process.stderr.write(`[daemon] ❌ Error en ${filename}: ${err.message}\n`);
    }
}

// ─── Native FileSystem Watcher Initialization ────────────────────────────────

process.stderr.write(`🚀 Native In-Memory Indexer Daemon iniciado en: ${PROJECT_ROOT}\n`);

const watcher = fs.watch(PROJECT_ROOT, { recursive: true });

watcher.on('change', (eventType, filename) => {
    if (!filename) return;

    const normalizedFilename = filename.replace(/\\/g, '/');

    // Use the gitignore-aware filter to honour the project's own ignore rules
    if (ignoreFilter.ignores(normalizedFilename)) return;
    if (normalizedFilename.endsWith('.json')) return; // Prevent infinite loop on index file writes
    if (path.basename(normalizedFilename).startsWith('.')) return;

    const ext = path.extname(filename);
    if (!EXTENSIONS.has(ext)) return;

    const fullPath = path.join(PROJECT_ROOT, filename);
    const now = Date.now();

    // Native debounce to avoid processing IDE save bursts
    if (changeRegistry.has(fullPath) && (now - changeRegistry.get(fullPath) < DEBOUNCE_MS)) return;
    changeRegistry.set(fullPath, now);

    setTimeout(() => {
        processFileChange(normalizedFilename, fullPath);
    }, 50); // Small delay to release OS I/O locks
});

watcher.on('error', (err) => {
    process.stderr.write(`[daemon] 💥 OS Watcher panic: ${err.message}\n`);
});