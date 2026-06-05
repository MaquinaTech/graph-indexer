/**
 * @file parser-utils.mjs
 * @description Shared AST parsing, language registry, and embedding utilities.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license GPL-3.0-only
 * * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import ignore from 'ignore';
import Parser from 'tree-sitter';
const { Query } = Parser; // Importación robusta nativa

import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import CSS from 'tree-sitter-css';
import Python from 'tree-sitter-python';
import Rust from 'tree-sitter-rust';
import Go from 'tree-sitter-go';
import PHP from 'tree-sitter-php';
import { truncateForEmbedding } from './core-engine.mjs';

export const MAX_FILE_SIZE_BYTES = 500000;
export const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

const LANGUAGE_MAP = {
    '.ts': TypeScript.typescript, '.tsx': TypeScript.tsx,
    '.js': JavaScript, '.jsx': JavaScript, '.mjs': JavaScript, '.cjs': JavaScript,
    '.css': CSS, '.scss': CSS,
    '.py': Python, '.rs': Rust, '.go': Go,
    '.php': PHP.php,
};

// 🥇 ULTRA-GENERIC QUERIES: Immune to grammar changes between TS/JS/TSX
const LANGUAGE_QUERIES = {
    ts: `
        (class_declaration) @chunk
        (function_declaration) @chunk
        (method_definition) @chunk
        (lexical_declaration) @chunk
        (expression_statement) @chunk
        (export_statement) @chunk
    `,
    css: `(rule_set) @chunk`,
    py: `
        (function_definition) @chunk
        (class_definition) @chunk
        (expression_statement) @chunk
    `,
    rs: `
        (function_item) @chunk
        (struct_item) @chunk
        (enum_item) @chunk
        (trait_item) @chunk
        (impl_item) @chunk
    `,
    go: `
        (function_declaration) @chunk
        (method_declaration) @chunk
        (type_declaration) @chunk
    `,
    php: `
        (function_definition) @chunk
        (class_declaration) @chunk
        (expression_statement) @chunk
    `
};

export const EXTENSIONS = new Set(Object.keys(LANGUAGE_MAP));

// Definition of container node types to avoid nested duplicates
const CONTAINERS = new Set([
    'class_declaration', 'function_declaration', 'method_definition',
    'lexical_declaration', 'expression_statement', 'export_statement',
    'function_definition', 'class_definition', 'rule_set',
    'function_item', 'struct_item', 'enum_item', 'trait_item', 'impl_item',
    'method_declaration', 'type_declaration'
]);

export function getParserForFile(ext) {
    const language = LANGUAGE_MAP[ext];
    if (!language) return null;
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
}

export function buildIgnoreFilter(rootPath) {
    const ig = ignore();
    ig.add(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '*.tmp', 'vendor', '.venv']);
    const gitignorePath = path.join(rootPath, '.gitignore');
    if (fs.existsSync(gitignorePath)) ig.add(fs.readFileSync(gitignorePath, 'utf-8'));
    return ig;
}

export function generateChunkHash(text) {
    return createHash('sha256').update(text).digest('hex');
}

export function extractFileSkeleton(rootNode, content) {
    const signatures = [];
    function walk(node) {
        if (node.type.includes('declaration') || node.type.includes('definition')) {
            let name = node.childForFieldName?.("name")?.text || "anonymous";
            signatures.push(`- [${node.type}] ${name} (lines ${node.startPosition.row + 1}-${node.endPosition.row + 1})`);
        }
        node.children.forEach(walk);
    }
    walk(rootNode);
    return signatures.join('\n');
}

export function extractImportsFromAST(rootNode, ext) {
    const imports = new Set();
    function walk(node) {
        // ── JavaScript / TypeScript ──────────────────────────────────────────
        if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
            if (node.type === 'import_statement') {
                const source = node.children.find(c => c.type === 'string');
                if (source) imports.add(source.text.replace(/['"]/g, ''));
            } else if (node.type === 'call_expression' && node.children[0]?.text === 'require') {
                const arg = node.children[1]?.children?.find(c => c.type === 'string');
                if (arg) imports.add(arg.text.replace(/['"]/g, ''));
            }
        }
        // ── Python ──────────────────────────────────────────────────────────
        else if (ext === '.py') {
            if (node.type === 'import_statement') {
                // import foo.bar.baz  → store as foo/bar/baz
                for (const child of node.children) {
                    if (child.type === 'dotted_name') imports.add(child.text.replace(/\./g, '/'));
                }
            } else if (node.type === 'import_from_statement') {
                // from .sibling import X  → relative: emit as ./sibling
                // from ..pkg import Y    → relative: emit as ../pkg
                // from foo.bar import Z  → absolute: store foo/bar
                const relNode = node.children.find(c => c.type === 'relative_import');
                if (relNode) {
                    // dots count = depth; remainder is the module path after dots
                    const raw = relNode.text; // e.g. '.' or '..utils'
                    const dots = raw.match(/^\.+/)?.[0] ?? '.';
                    const mod = raw.slice(dots.length);
                    const prefix = dots.length === 1 ? './' : '../'.repeat(dots.length - 1);
                    imports.add(mod ? prefix + mod.replace(/\./g, '/') : prefix.slice(0, -1) || '.');
                } else {
                    const mod = node.children.find(c => c.type === 'dotted_name');
                    if (mod) imports.add(mod.text.replace(/\./g, '/'));
                }
            }
        }
        // ── Rust ────────────────────────────────────────────────────────────
        else if (ext === '.rs') {
            if (node.type === 'use_declaration') {
                // Collect the first path text from the argument subtree
                const arg = node.childForFieldName?.('argument') ||
                    node.children.find(c => !['use', ';', 'pub'].includes(c.type));
                if (arg) imports.add(arg.text.split('::').slice(0, 3).join('::'));
            }
        }
        // ── Go ──────────────────────────────────────────────────────────────
        else if (ext === '.go') {
            if (node.type === 'import_spec') {
                const pathNode = node.children.find(c =>
                    c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal');
                if (pathNode) imports.add(pathNode.text.replace(/['"`]/g, ''));
            }
        }
        // ── PHP ─────────────────────────────────────────────────────────────
        else if (ext === '.php') {
            if (node.type === 'include_expression' || node.type === 'require_expression' ||
                node.type === 'include_once_expression' || node.type === 'require_once_expression') {
                const strNode = node.children.find(c =>
                    c.type === 'string' || c.type === 'encapsed_string');
                if (strNode) imports.add(strNode.text.replace(/['"]/g, ''));
            }
        }
        node.children.forEach(walk);
    }
    walk(rootNode);
    return Array.from(imports);
}

export function extractSemanticChunks(rootNode, relPath, sourceCode, ext) {
    const chunks = [];
    const parser = getParserForFile(ext);
    if (!parser) return chunks;

    const JS_LIKE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
    const langKey = JS_LIKE.includes(ext) ? 'ts' : (LANGUAGE_QUERIES[ext.slice(1)] ? ext.slice(1) : null);
    if (!langKey || !LANGUAGE_QUERIES[langKey]) return chunks;

    // 🥇 HEADER INHERITANCE: Extract top-of-file/global comments for module context
    let fileDocstring = "";
    let cursorNode = rootNode.children[0];
    while (cursorNode) {
        if (cursorNode.type === 'comment') fileDocstring += cursorNode.text + "\n";
        else if (cursorNode.type !== 'import_statement' && cursorNode.type !== 'expression_statement') break;
        cursorNode = cursorNode.nextSibling;
    }
    fileDocstring = fileDocstring.trim();

    try {
        const query = new Query(parser.getLanguage(), LANGUAGE_QUERIES[langKey]);
        const matches = query.matches(rootNode);
        const processedNodes = new Set();

        for (const match of matches) {
            let chunkNode = null;
            for (const capture of match.captures) {
                if (capture.name === 'chunk') chunkNode = capture.node;
            }

            if (!chunkNode || processedNodes.has(chunkNode.id)) continue;
            processedNodes.add(chunkNode.id);

            // Filter out very small fragments (simple variables, etc.)
            if (chunkNode.endPosition.row - chunkNode.startPosition.row < 2) continue;

            // 🥇 DEDUPLICATION LOGIC: Ignore nodes that are nested inside other container nodes
            let isNested = false;
            let currentParent = chunkNode.parent;
            while (currentParent && currentParent.type !== 'program') {
                if (CONTAINERS.has(currentParent.type)) {
                    isNested = true;
                    break;
                }
                currentParent = currentParent.parent;
            }
            if (isNested) continue;

            // 🥇 ROBUST NAME EXTRACTION (JS logic)
            let nameText = "anonymous";
            const nameNode = chunkNode.childForFieldName?.("name");

            if (nameNode) {
                nameText = nameNode.text;
            } else if (chunkNode.type === "export_statement") {
                const decl = chunkNode.children.find(c => ['lexical_declaration', 'function_declaration', 'class_declaration'].includes(c.type));
                if (decl) {
                    if (decl.type === "lexical_declaration") {
                        const varDecl = decl.children.find(c => c.type === "variable_declarator");
                        nameText = varDecl?.children.find(c => c.type === "identifier")?.text || "anonymous";
                    } else {
                        nameText = decl.childForFieldName?.("name")?.text || "anonymous";
                    }
                } else {
                    const defaultChild = chunkNode.children.find(c => c.type === 'identifier' || c.type === 'call_expression');
                    if (defaultChild) {
                        if (defaultChild.type === 'identifier') {
                            nameText = `default_${defaultChild.text}`;
                        } else if (defaultChild.type === 'call_expression') {
                            const funcName = defaultChild.childForFieldName?.("function")?.text || defaultChild.children[0]?.text;
                            const argNode = defaultChild.childForFieldName?.("arguments")?.children?.find(c => c.type === 'identifier');
                            nameText = argNode ? `default_${funcName}_${argNode.text}` : `default_${funcName}`;
                        }
                    } else {
                        nameText = "default_export";
                    }
                }
            } else if (chunkNode.type === "lexical_declaration") {
                const decl = chunkNode.children.find(c => c.type === "variable_declarator");
                nameText = decl?.children.find(c => c.type === "identifier")?.text || "anonymous";
            } else if (chunkNode.type === "expression_statement") {
                const callExp = chunkNode.children.find(c => c.type === "call_expression");
                const assignExp = chunkNode.children.find(c => c.type === "assignment_expression");
                if (callExp) {
                    const funcName = callExp.childForFieldName?.("function")?.text || callExp.children[0]?.text;
                    const argsNode = callExp.childForFieldName?.("arguments");
                    const stringArg = argsNode?.children?.find(c => c.type === "string" || c.type === "template_string");
                    nameText = stringArg ? `${funcName}_${stringArg.text.replace(/['"`]/g, '')}` : (funcName || "anonymous");
                } else if (assignExp) {
                    nameText = assignExp.childForFieldName?.("left")?.text || "anonymous";
                }
            } else {
                const idNode = chunkNode.children.find(c => c.type === "identifier" || c.type === "name" || c.type === "property_identifier");
                nameText = idNode?.text || "anonymous";
            }

            if (nameText === "anonymous" || nameText === "default_export") {
                nameText = `${path.basename(relPath, path.extname(relPath))}_${chunkNode.type}`;
            }

            let docstring = "";
            let prev = chunkNode.previousSibling;
            while (prev && (prev.type === 'comment' || !prev.isNamed)) {
                if (prev.type === 'comment') docstring = prev.text + "\n" + docstring;
                prev = prev.previousSibling;
            }
            docstring = docstring.trim();

            if (!docstring && fileDocstring) {
                docstring = `[File Context]: ${fileDocstring}`;
            }

            const snippet = chunkNode.text.slice(0, 3000);
            const hash = generateChunkHash(docstring + snippet);
            const outgoingCalls = extractCalls(chunkNode);

            const id = createHash('sha256')
                .update(`${relPath}::${chunkNode.startPosition.row}::${chunkNode.startPosition.column}`)
                .digest('hex').slice(0, 24);

            chunks.push({
                id, file_path: relPath, node_type: chunkNode.type, name: nameText,
                docstring: docstring, code_snippet: snippet, content_hash: hash,
                start_line: chunkNode.startPosition.row + 1, end_line: chunkNode.endPosition.row + 1,
                calls: outgoingCalls
            });
        }
    } catch (e) {
        // Visible protective log for developers
        process.stderr.write(`\n[parser-utils] 💥 Query Error in ${relPath}: ${e.message}\n`);
    }
    return chunks;
}

export function resolveLocalImports(rawImports, fromFileRelPath, projectRoot) {
    const fileDir = path.dirname(path.join(projectRoot, fromFileRelPath));
    const ext = path.extname(fromFileRelPath);
    const resolved = [];
    for (const raw of rawImports) {
        // ── Dot-relative (JS/TS/Python relative) ────────────────────────────
        if (raw.startsWith('.')) {
            const absResolved = path.resolve(fileDir, raw);
            const existingExt = path.extname(absResolved);
            let finalAbs = null;
            if (existingExt && EXTENSIONS.has(existingExt) && fs.existsSync(absResolved)) {
                finalAbs = absResolved;
            } else {
                for (const e of EXTENSIONS) {
                    if (fs.existsSync(absResolved + e)) { finalAbs = absResolved + e; break; }
                    const idx = path.join(absResolved, 'index' + e);
                    if (fs.existsSync(idx)) { finalAbs = idx; break; }
                    // Python: also try __init__.py for package directories
                    if (e === '.py') {
                        const init = path.join(absResolved, '__init__.py');
                        if (fs.existsSync(init)) { finalAbs = init; break; }
                    }
                }
            }
            if (finalAbs) resolved.push(path.relative(projectRoot, finalAbs).replace(/\\/g, '/'));
        }
        // ── Rust crate-local: crate::module::item → src/module.rs ──────────
        else if (ext === '.rs' && raw.startsWith('crate::')) {
            const parts = raw.slice('crate::'.length).split('::').filter(Boolean);
            for (let depth = parts.length; depth >= 1; depth--) {
                const subPath = parts.slice(0, depth).join('/');
                const candidates = [
                    path.join(projectRoot, 'src', subPath + '.rs'),
                    path.join(projectRoot, 'src', subPath, 'mod.rs'),
                ];
                let found = false;
                for (const c of candidates) {
                    if (fs.existsSync(c)) {
                        resolved.push(path.relative(projectRoot, c).replace(/\\/g, '/'));
                        found = true; break;
                    }
                }
                if (found) break;
            }
        }
    }
    return resolved;
}

export async function getLocalEmbedding(text, graceful = true) {
    if (process.env.INDEXER_EMBEDDINGS === 'off') return null; // lexical-only mode
    const MAX_RETRIES = 3;
    const safeText = "search_query: " + truncateForEmbedding(text);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: "nomic-embed-text", prompt: safeText }),
                signal: AbortSignal.timeout(15000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return data.embedding;
        } catch (err) {
            if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
            else if (!graceful) throw err;
        }
    }
    return null;
}

export async function getLocalEmbeddingsBatch(texts, graceful = true) {
    if (!texts || texts.length === 0) return [];
    if (process.env.INDEXER_EMBEDDINGS === 'off') return null; // lexical-only mode
    const MAX_RETRIES = 3;
    const safeTexts = texts.map(t => "search_document: " + (t.length > 8000 ? t.slice(0, 8000) : t));

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: "nomic-embed-text", input: safeTexts }),
                signal: AbortSignal.timeout(60000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return data.embeddings;
        } catch (err) {
            if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
            else if (!graceful) throw err;
        }
    }
    return null;
}

export function extractCalls(rootNode) {
    const calls = new Set();
    function walk(node) {
        // JavaScript / TypeScript / Go / Rust: call_expression
        if (node.type === 'call_expression') {
            const funcNode = node.childForFieldName?.('function') || node.children[0];
            if (funcNode) {
                if (funcNode.type === 'identifier') calls.add(funcNode.text);
                else if (funcNode.type === 'member_expression' || funcNode.type === 'property_identifier') {
                    const prop = funcNode.childForFieldName?.('property');
                    if (prop) calls.add(prop.text);
                    else calls.add(funcNode.text.split('.').pop());
                }
            }
        }
        // Python: `call` node type (different name from call_expression)
        else if (node.type === 'call') {
            const funcNode = node.childForFieldName?.('function') || node.children[0];
            if (funcNode) {
                if (funcNode.type === 'identifier') calls.add(funcNode.text);
                else if (funcNode.type === 'attribute') {
                    const attr = funcNode.childForFieldName?.('attribute');
                    if (attr) calls.add(attr.text);
                }
            }
        }
        // Rust: macro_invocation (e.g. vec!, println!, format!)
        else if (node.type === 'macro_invocation') {
            const macroNode = node.childForFieldName?.('macro') || node.children[0];
            if (macroNode && macroNode.type === 'identifier') calls.add(macroNode.text + '!');
        }
        node.children.forEach(walk);
    }
    walk(rootNode);
    const noise = new Set(['require', 'console', 'log', 'expect', 'test', 'it', 'describe', 'setTimeout', 'print', 'println!']);
    return Array.from(calls).filter(c => c && c.length > 2 && !noise.has(c));
}