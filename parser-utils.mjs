/**
 * @file parser-utils.mjs
 * @description Shared AST parsing, language registry, and embedding utilities.
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
import { createHash } from 'crypto';
import ignore from 'ignore';
import Parser from 'tree-sitter';
const { Query } = Parser; // Native parser query helper

import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import CSS from 'tree-sitter-css';
import Python from 'tree-sitter-python';
import Rust from 'tree-sitter-rust';
import Go from 'tree-sitter-go';
import PHP from 'tree-sitter-php';
import Java from 'tree-sitter-java';
import Kotlin from 'tree-sitter-kotlin';
import CSharp from 'tree-sitter-c-sharp';
import Ruby from 'tree-sitter-ruby';
import { truncateForEmbedding } from './core-engine.mjs';

export const MAX_FILE_SIZE_BYTES = 500000;
export const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

const LANGUAGE_MAP = {
    '.ts': TypeScript.typescript, '.tsx': TypeScript.tsx,
    '.js': JavaScript, '.jsx': JavaScript, '.mjs': JavaScript, '.cjs': JavaScript,
    '.css': CSS, '.scss': CSS,
    '.py': Python, '.rs': Rust, '.go': Go,
    '.php': PHP.php,
    '.java': Java,
    '.kt': Kotlin, '.kts': Kotlin,
    '.cs': CSharp,
    '.rb': Ruby,
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
    `,
    java: `
        (method_declaration) @chunk
        (class_declaration) @chunk
        (interface_declaration) @chunk
        (constructor_declaration) @chunk
        (enum_declaration) @chunk
    `,
    kotlin: `
        (function_declaration) @chunk
        (class_declaration) @chunk
        (object_declaration) @chunk
        (companion_object) @chunk
        (secondary_constructor) @chunk
    `,
    cs: `
        (method_declaration) @chunk
        (class_declaration) @chunk
        (interface_declaration) @chunk
        (constructor_declaration) @chunk
        (enum_declaration) @chunk
        (property_declaration) @chunk
    `,
    rb: `
        (method) @chunk
        (singleton_method) @chunk
        (class) @chunk
        (module) @chunk
    `
};

export const EXTENSIONS = new Set(Object.keys(LANGUAGE_MAP));

// Definition of container node types to avoid nested duplicates
const CONTAINERS = new Set([
    'class_declaration', 'function_declaration', 'method_definition',
    'lexical_declaration', 'expression_statement', 'export_statement',
    'function_definition', 'class_definition', 'rule_set',
    'function_item', 'struct_item', 'enum_item', 'trait_item', 'impl_item',
    'method_declaration', 'type_declaration',
    // Java / C#
    'interface_declaration', 'constructor_declaration', 'enum_declaration',
    // Kotlin
    'object_declaration', 'companion_object', 'secondary_constructor',
    // C#
    'property_declaration',
    // Ruby
    'method', 'singleton_method', 'module'
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
        }        // ── Java ─────────────────────────────────────────────────────────────
        else if (ext === '.java') {
            if (node.type === 'import_declaration') {
                const scopedId = node.children.find(c => c.type === 'scoped_identifier' || c.type === 'identifier');
                if (scopedId) imports.add(scopedId.text.replace(/\./g, '/'));
            }
        }
        // ── Kotlin ───────────────────────────────────────────────────────────
        else if (ext === '.kt' || ext === '.kts') {
            if (node.type === 'import_header') {
                const path = node.children.find(c => c.type === 'identifier' || c.type === 'user_type' || c.isNamed);
                const raw = node.text.replace(/^import\s+/, '').replace(/\s*\.\*\s*$/, '').trim();
                if (raw) imports.add(raw.replace(/\./g, '/'));
            }
        }
        // ── C# ───────────────────────────────────────────────────────────────
        else if (ext === '.cs') {
            if (node.type === 'using_directive') {
                const ns = node.children.find(c => c.type === 'qualified_name' || c.type === 'identifier' || c.type === 'name_equals');
                if (ns) {
                    const raw = ns.text.replace(/\s*=\s*.*$/, '').trim();
                    if (raw) imports.add(raw.replace(/\./g, '/'));
                }
            }
        }
        // ── Ruby ──────────────────────────────────────────────────────────────
        else if (ext === '.rb') {
            if (node.type === 'call' || node.type === 'method_call') {
                const method = node.childForFieldName?.('method') || node.children[0];
                if (method && (method.text === 'require' || method.text === 'require_relative')) {
                    const args = node.childForFieldName?.('arguments') || node.children.find(c => c.type === 'argument_list');
                    const strArg = args?.children?.find(c => c.type === 'string' || c.type === 'simple_string');
                    if (strArg) imports.add(strArg.text.replace(/['"]/g, ''));
                }
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
    const EXT_TO_LANG = {
        '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.cs': 'cs',
        '.rb': 'rb'
    };
    const langKey = JS_LIKE.includes(ext) ? 'ts'
        : (EXT_TO_LANG[ext] || (LANGUAGE_QUERIES[ext.slice(1)] ? ext.slice(1) : null));
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

            // 🥇 DEDUPLICATION LOGIC: Ignore nodes that are nested inside other container nodes.
            // Stop at the actual tree root (parent === null) to be language-agnostic:
            // Python root = 'module', JS root = 'program', Go root = 'source_file', Ruby root = 'program'.
            // Stopping at 'program' alone was falsely marking top-level Python classes as nested
            // because Ruby's 'module' keyword (also in CONTAINERS) shares the name with Python's root.
            let isNested = false;
            let currentParent = chunkNode.parent;
            while (currentParent && currentParent.parent !== null) {
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

            // 🥇 PARAMETER / TYPE / CLASS CONTEXT ENRICHMENT (improves recall on undocumented code)
            const params = extractParams(chunkNode, ext);
            const returnType = extractReturnType(chunkNode, ext);
            const classContext = extractClassContext(chunkNode);

            const id = createHash('sha256')
                .update(`${relPath}::${chunkNode.startPosition.row}::${chunkNode.startPosition.column}`)
                .digest('hex').slice(0, 24);

            chunks.push({
                id, file_path: relPath, node_type: chunkNode.type, name: nameText,
                docstring: docstring, code_snippet: snippet, content_hash: hash,
                start_line: chunkNode.startPosition.row + 1, end_line: chunkNode.endPosition.row + 1,
                calls: outgoingCalls,
                params, return_type: returnType, class_context: classContext
            });
        }
    } catch (e) {
        // Visible protective log for developers
        process.stderr.write(`\n[parser-utils] 💥 Query Error in ${relPath}: ${e.message}\n`);
    }
    return chunks;
}

// ─── Barrel export resolution ─────────────────────────────────────────────────

// Module-level cache: barrelAbsPath → Map<exportedName, sourceRelPath>
const _barrelCache = new Map();

/**
 * Parses a barrel file (index.ts / index.js) and returns a map of
 * exportedName → sourceFilePath (relative to projectRoot).
 * e.g. { useAuthStore: 'src/stores/authStore.ts' }
 */
export function resolveBarrelExports(barrelAbsPath, projectRoot) {
    if (_barrelCache.has(barrelAbsPath)) return _barrelCache.get(barrelAbsPath);

    const result = new Map();
    _barrelCache.set(barrelAbsPath, result);

    const ext = path.extname(barrelAbsPath);
    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return result;

    let content;
    try { content = fs.readFileSync(barrelAbsPath, 'utf-8'); } catch { return result; }

    const parser = getParserForFile(ext);
    if (!parser) return result;

    let tree;
    try { tree = parser.parse((offset) => offset < content.length ? content.slice(offset, offset + 4096) : null); } catch { return result; }

    const barrelDir = path.dirname(barrelAbsPath);

    function walk(node) {
        // export { X, Y as Z } from './source'
        if (node.type === 'export_statement') {
            const fromNode = node.children.find(c => c.type === 'string');
            if (!fromNode) { node.children.forEach(walk); return; }

            const rawSource = fromNode.text.replace(/['"]/g, '');
            if (!rawSource.startsWith('.')) { node.children.forEach(walk); return; }

            // Resolve the source file
            const absSource = path.resolve(barrelDir, rawSource);
            let finalAbs = null;
            if (EXTENSIONS.has(path.extname(absSource)) && fs.existsSync(absSource)) {
                finalAbs = absSource;
            } else {
                for (const e of EXTENSIONS) {
                    if (fs.existsSync(absSource + e)) { finalAbs = absSource + e; break; }
                    const idx = path.join(absSource, 'index' + e);
                    if (fs.existsSync(idx)) { finalAbs = idx; break; }
                }
            }
            if (!finalAbs) { node.children.forEach(walk); return; }

            const relSource = path.relative(projectRoot, finalAbs).replace(/\\/g, '/');

            // Walk named exports
            const namedExports = node.children.find(c => c.type === 'named_imports' || c.type === 'export_clause');
            if (namedExports) {
                for (const child of namedExports.children) {
                    if (child.type === 'import_specifier' || child.type === 'export_specifier') {
                        // `alias as exported` or just `name`
                        const names = child.children.filter(c => c.type === 'identifier');
                        if (names.length > 0) {
                            // The exported name is the last identifier (the alias if present)
                            result.set(names[names.length - 1].text, relSource);
                        }
                    }
                }
            }

            // export * from './source' → map the source file itself
            const starNode = node.children.find(c => c.text === '*');
            if (starNode) {
                result.set('*', relSource);
            }
        }
        node.children.forEach(walk);
    }
    walk(tree.rootNode);
    return result;
}

// ─── Go module-name cache (reads go.mod once per project root) ──────────────
const _goModCache = new Map();
function _readGoModuleName(projectRoot) {
    if (_goModCache.has(projectRoot)) return _goModCache.get(projectRoot);
    const modFile = path.join(projectRoot, 'go.mod');
    let name = null;
    if (fs.existsSync(modFile)) {
        try {
            const first = fs.readFileSync(modFile, 'utf-8').split('\n').find(l => l.trimStart().startsWith('module '));
            if (first) name = first.trim().replace(/^module\s+/, '').split(/\s/)[0];
        } catch { /* ignore */ }
    }
    _goModCache.set(projectRoot, name);
    return name;
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
            if (finalAbs) {
                const relPath = path.relative(projectRoot, finalAbs).replace(/\\/g, '/');
                const baseName = path.basename(finalAbs, path.extname(finalAbs));
                // 🥇 BARREL RESOLUTION: If the resolved file is an index file, expand barrel exports
                if (baseName === 'index' && ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(path.extname(finalAbs))) {
                    const barrelMap = resolveBarrelExports(finalAbs, projectRoot);
                    if (barrelMap.size > 0) {
                        // Add all unique source files referenced by this barrel
                        const sources = new Set(barrelMap.values());
                        for (const src of sources) {
                            if (!resolved.includes(src)) resolved.push(src);
                        }
                    } else {
                        // Barrel has no re-exports — keep the barrel file itself
                        if (!resolved.includes(relPath)) resolved.push(relPath);
                    }
                } else {
                    if (!resolved.includes(relPath)) resolved.push(relPath);
                }
            }
        }
        // ── Go intra-module: github.com/owner/repo/sub → sub/*.go ──────────
        // Go import paths use the module name as prefix; map them to local dirs.
        else if (ext === '.go') {
            const modName = _readGoModuleName(projectRoot);
            if (modName && raw.startsWith(modName + '/')) {
                const subPkg = raw.slice(modName.length + 1); // e.g. 'render'
                const absDir = path.join(projectRoot, subPkg);
                if (fs.existsSync(absDir)) {
                    try {
                        const goFiles = fs.readdirSync(absDir)
                            .filter(f => f.endsWith('.go') && !f.includes('_test'))
                            .slice(0, 5); // cap: take a representative sample
                        for (const gof of goFiles) {
                            const rel = path.relative(projectRoot, path.join(absDir, gof)).replace(/\\/g, '/');
                            if (!resolved.includes(rel)) resolved.push(rel);
                        }
                    } catch { /* directory unreadable — skip */ }
                }
            }
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

// ─── Enrichment helpers (param names, return type, class context) ─────────────

export function extractParams(chunkNode, ext) {
    const params = [];
    const JS_LIKE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
    const paramTypes = JS_LIKE.includes(ext)
        ? ['required_parameter', 'optional_parameter', 'formal_parameters', 'identifier']
        : ['parameter', 'formal_parameter', 'identifier'];

    function walkParams(node) {
        if (node.type === 'formal_parameters' || node.type === 'parameters' || node.type === 'parameter_list') {
            for (const child of node.children) {
                // TS: required_parameter / optional_parameter have an identifier child
                if (child.type === 'required_parameter' || child.type === 'optional_parameter' || child.type === 'formal_parameter') {
                    const id = child.childForFieldName?.('pattern') || child.childForFieldName?.('name') ||
                        child.children.find(c => c.type === 'identifier');
                    if (id) params.push(id.text);
                    // also grab type annotation text
                    const typeAnnotation = child.childForFieldName?.('type');
                    if (typeAnnotation) {
                        const typeText = typeAnnotation.text.replace(/^:\s*/, '').trim();
                        if (typeText) params.push(typeText);
                    }
                } else if (child.type === 'identifier') {
                    params.push(child.text);
                }
            }
        }
        for (const child of node.children) walkParams(child);
    }

    // Only walk the direct params node to avoid deep recursion into body
    const paramsNode = chunkNode.childForFieldName?.('parameters') || chunkNode.childForFieldName?.('formal_parameters');
    if (paramsNode) walkParams(paramsNode);
    return [...new Set(params)].filter(p => p && p.length > 1).slice(0, 15);
}

export function extractReturnType(chunkNode, ext) {
    const JS_LIKE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
    if (JS_LIKE.includes(ext)) {
        const retTypeNode = chunkNode.childForFieldName?.('return_type');
        if (retTypeNode) return retTypeNode.text.replace(/^:\s*/, '').trim().slice(0, 80);
    }
    return '';
}

export function extractClassContext(chunkNode) {
    let parent = chunkNode.parent;
    while (parent) {
        if (parent.type === 'class_declaration' || parent.type === 'class_definition' ||
            parent.type === 'class_body' || parent.type === 'impl_item') {
            const nameNode = parent.childForFieldName?.('name');
            if (nameNode) return nameNode.text;
        }
        parent = parent.parent;
    }
    return '';
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
        // Java / C#: method_invocation
        else if (node.type === 'method_invocation') {
            const nameNode = node.childForFieldName?.('name') || node.children.find(c => c.type === 'identifier');
            if (nameNode) calls.add(nameNode.text);
        }
        // Ruby: method_call / call
        else if (node.type === 'method_call') {
            const method = node.childForFieldName?.('method') || node.children.find(c => c.type === 'identifier');
            if (method && method.type === 'identifier') calls.add(method.text);
        }
        node.children.forEach(walk);
    }
    walk(rootNode);
    const noise = new Set(['require', 'console', 'log', 'expect', 'test', 'it', 'describe', 'setTimeout', 'print', 'println!']);
    return Array.from(calls).filter(c => c && c.length > 2 && !noise.has(c));
}