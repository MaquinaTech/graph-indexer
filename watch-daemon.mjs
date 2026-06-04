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
import { MemoryGraphIndex } from './core-engine.mjs';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import CSS from 'tree-sitter-css';

const PROJECT_ROOT = process.env.MCP_PROJECT_ROOT || process.cwd();
const INDEX_PATH = path.join(PROJECT_ROOT, 'code-index.json');
const DEBOUNCE_MS = 300;

const LANGUAGE_MAP = {
    '.ts': TypeScript.typescript,
    '.tsx': TypeScript.tsx,
    '.js': JavaScript,
    '.jsx': JavaScript,
    '.css': CSS,
    '.scss': CSS
};

function getParserForFile(ext) {
    const language = LANGUAGE_MAP[ext];
    if (!language) return null;
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
}

// Semantic AST nodes for fragment extraction
const SEMANTIC_NODES = new Set([
    // TypeScript / JavaScript
    "function_declaration", "method_definition", "class_declaration",
    "interface_declaration", "type_alias_declaration", "arrow_function",
    "lexical_declaration",

    // SCSS / CSS
    "rule_set", "declaration" // rule_set captures CSS classes like .btn { ... }
]);

// ─── AST Utilities ────────────────────────────────────────────────────────────

function extractImportsFromAST(rootNode, ext) {
    const imports = new Set();

    function walk(node) {
        // JS / TS (ES Modules)
        if (node.type === 'import_statement') {
            const source = node.children.find(c => c.type === 'string');
            if (source) imports.add(source.text.replace(/['"]/g, ''));
        }
        // JS (CommonJS)
        else if (node.type === 'call_expression' && node.children[0]?.text === 'require') {
            const arg = node.children[1]?.children?.find(c => c.type === 'string');
            if (arg) imports.add(arg.text.replace(/['"]/g, ''));
        }
        // SCSS (@use, @import)
        else if (node.type === 'import_statement' && ext === '.scss') {
            const source = node.children.find(c => c.type === 'string_value');
            if (source) imports.add(source.text.replace(/['"]/g, ''));
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
    const tryExts = ['.ts', '.tsx', '.js', '.jsx', '.css', '.scss'];
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
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch("http://localhost:11434/api/embeddings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
                signal: AbortSignal.timeout(15000),
            });
            if (res.status === 429 || res.status === 503) throw new Error(`Retryable: ${res.status}`);
            if (!res.ok) {
                process.stderr.write(`[embedding-error] HTTP ${res.status}\n`);
                return null;
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
            // Archivo eliminado: Purgar del índice
            const newChunks = Array.from(db.chunks.values()).filter(c => c.file_path !== filename);
            db.chunks.clear();
            db.vectors.clear();

            for (const c of newChunks) {
                db.chunks.set(c.id, c);
                if (c.embedding) db.vectors.set(c.id, new Float32Array(c.embedding));
            }

            db.updateFileGraph(filename, []); // Clear dependencies
            db.save();
            process.stderr.write(`[daemon] 🗑️  Purged: ${filename}\n`);
            return;
        }

        const content = fs.readFileSync(absolutePath, 'utf-8');
        const ext = path.extname(absolutePath);
        const parser = getParserForFile(ext);

        if (!parser) return; // Skip unsupported extensions

        const tree = parser.parse(content);
        const rawImports = extractImportsFromAST(tree.rootNode, ext);
        const imports = resolveLocalImports(rawImports, filename);
        db.updateFileGraph(filename, imports);

        // 2. Extract semantic chunks
        const newChunks = extractSemanticChunks(tree.rootNode, filename, content);

        // 3. Remove old chunks from this file in memory DB
        for (const [id, chunk] of db.chunks.entries()) {
            if (chunk.file_path === filename) {
                db.chunks.delete(id);
                db.vectors.delete(id);
            }
        }

        // 4. Generate vectors and insert new chunks
        for (const chunk of newChunks) {
            const embedText = `${chunk.node_type} ${chunk.name}\n${chunk.code_snippet}`;
            const vector = await getLocalEmbedding(embedText);

            if (vector) {
                chunk.embedding = vector;
                db.vectors.set(chunk.id, new Float32Array(vector));
            }
            db.chunks.set(chunk.id, chunk);
        }

        db.save(); // Atomically persist to disk
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

    // Ignore build directories, modules, and hidden files
    if (
        filename.includes('node_modules') ||
        filename.includes('.git') ||
        filename.includes('dist') ||
        filename.endsWith('.json') || // Prevent infinite loop on index save
        filename.startsWith('.')
    ) return;

    const ext = path.extname(filename);
    if (!['.ts', '.tsx', '.js', '.jsx', '.scss', '.css'].includes(ext)) return;

    const fullPath = path.join(PROJECT_ROOT, filename);
    const now = Date.now();

    // Native debounce to avoid processing IDE save bursts
    if (changeRegistry.has(fullPath) && (now - changeRegistry.get(fullPath) < DEBOUNCE_MS)) return;
    changeRegistry.set(fullPath, now);

    setTimeout(() => {
        processFileChange(filename, fullPath);
    }, 50); // Small delay to release OS I/O locks
});

watcher.on('error', (err) => {
    process.stderr.write(`[daemon] 💥 OS Watcher panic: ${err.message}\n`);
});