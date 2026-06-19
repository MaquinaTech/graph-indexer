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

import { truncateForEmbedding } from './core-engine.mjs';

export const MAX_FILE_SIZE_BYTES = 500000;
export const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

// Resolves the Ollama host at call time so callers that set ollamaHost via
// .graph-indexer.json don't have to pass it through every call chain.
// Priority: caller override → OLLAMA_HOST env var → PROJECT .graph-indexer.json
// (MCP_PROJECT_ROOT or cwd — NOT the package directory: when graph-indexer is
// installed as a dependency, the user's config lives in their project root) →
// default. Mirrors config.mjs precedence so every entry point agrees.
//
// Note: OLLAMA_HOST in the shell is Ollama's binding address (e.g. "0.0.0.0:11434"), not an
// HTTP client URL. We normalise bare "host:port" strings by adding http:// and translating
// 0.0.0.0 → localhost so fetches work in both formats.
let _cachedHost = null;
let _cachedEmbedModel = null;
function _normalizeOllamaHost(raw) {
    if (!raw) return null;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    return 'http://' + raw.replace(/^0\.0\.0\.0/, 'localhost');
}
function _readProjectConfig() {
    const root = process.env.MCP_PROJECT_ROOT || process.cwd();
    try {
        return JSON.parse(fs.readFileSync(path.join(root, '.graph-indexer.json'), 'utf8'));
    } catch { return null; }
}
function _resolveOllamaHost(override) {
    if (override) return _normalizeOllamaHost(override) || 'http://localhost:11434';
    if (_cachedHost) return _cachedHost;
    if (process.env.OLLAMA_HOST) {
        _cachedHost = _normalizeOllamaHost(process.env.OLLAMA_HOST) || 'http://localhost:11434';
        return _cachedHost;
    }
    const cfg = _readProjectConfig();
    _cachedHost = _normalizeOllamaHost(cfg?.ollamaHost) || 'http://localhost:11434';
    return _cachedHost;
}
function _resolveEmbedModel(override) {
    if (override) return override;
    if (_cachedEmbedModel) return _cachedEmbedModel;
    const cfg = _readProjectConfig();
    _cachedEmbedModel = cfg?.embedModel || 'nomic-embed-text';
    return _cachedEmbedModel;
}

// ─── Dynamic Language Loading ─────────────────────────────────────────────────

function _loadProjectConfig() {
    const configPath = path.join(process.env.MCP_PROJECT_ROOT || process.cwd(), '.graph-indexer.json');
    try {
        if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { /* ignore */ }
    return null;
}

async function _tryLang(pkg, enabledLangs, key) {
    if (enabledLangs && !enabledLangs.includes(key)) return null;
    try {
        return (await import(pkg)).default;
    } catch {
        process.stderr.write(`[graph-indexer] WARNING: ${pkg} not installed — ${key} files will be skipped\n`);
        return null;
    }
}

const _cfg = _loadProjectConfig();
const _enabled = _cfg?.languages ?? null; // null = all languages

const [
    TypeScript, JavaScript, CSS, SCSS, Python, Rust,
    Go, PHP, Java, Kotlin, CSharp, Ruby, C, Bash, Swift
] = await Promise.all([
    _tryLang('tree-sitter-typescript', _enabled, 'typescript'),
    _tryLang('tree-sitter-javascript', _enabled, 'javascript'),
    _tryLang('tree-sitter-css', _enabled, 'css'),
    // SCSS shares the 'css' enable-key — init records .css and .scss under one
    // 'css' language, so the SCSS grammar must load whenever CSS is enabled.
    _tryLang('tree-sitter-scss', _enabled, (_enabled && _enabled.includes('css')) ? 'css' : 'scss'),
    _tryLang('tree-sitter-python', _enabled, 'python'),
    _tryLang('tree-sitter-rust', _enabled, 'rust'),
    _tryLang('tree-sitter-go', _enabled, 'go'),
    _tryLang('tree-sitter-php', _enabled, 'php'),
    _tryLang('tree-sitter-java', _enabled, 'java'),
    _tryLang('tree-sitter-kotlin', _enabled, 'kotlin'),
    _tryLang('tree-sitter-c-sharp', _enabled, 'csharp'),
    _tryLang('tree-sitter-ruby', _enabled, 'ruby'),
    _tryLang('tree-sitter-c', _enabled, 'c'),
    _tryLang('tree-sitter-bash', _enabled, 'bash'),
    _tryLang('tree-sitter-swift', _enabled, 'swift'),
]);

const LANGUAGE_MAP = {
    ...(TypeScript ? { '.ts': TypeScript.typescript, '.tsx': TypeScript.tsx } : {}),
    ...(JavaScript ? { '.js': JavaScript, '.jsx': JavaScript, '.mjs': JavaScript, '.cjs': JavaScript } : {}),
    ...(CSS ? { '.css': CSS } : {}),
    ...(SCSS ? { '.scss': SCSS } : (CSS ? { '.scss': CSS } : {})),
    ...(Python ? { '.py': Python } : {}),
    ...(Rust ? { '.rs': Rust } : {}),
    ...(Go ? { '.go': Go } : {}),
    ...(PHP ? { '.php': PHP.php } : {}),
    ...(Java ? { '.java': Java } : {}),
    ...(Kotlin ? { '.kt': Kotlin, '.kts': Kotlin } : {}),
    ...(CSharp ? { '.cs': CSharp } : {}),
    ...(Ruby ? { '.rb': Ruby } : {}),
    // C maps .c sources and .h headers (structs/typedefs/macros live in headers).
    ...(C ? { '.c': C, '.h': C } : {}),
    // Bash maps .sh and .bash; shebang-only extensionless scripts are not keyed.
    ...(Bash ? { '.sh': Bash, '.bash': Bash } : {}),
    ...(Swift ? { '.swift': Swift } : {}),
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
    scss: `
        (rule_set) @chunk
        (mixin_statement) @chunk
        (function_statement) @chunk
    `,
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
        (method_declaration) @chunk
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
    `,
    // C: functions + record/typedef definitions. Bare prototypes (declaration) and
    // object macros (preproc_def) are intentionally excluded — too noisy / sub-chunk.
    c: `
        (function_definition) @chunk
        (struct_specifier) @chunk
        (union_specifier) @chunk
        (enum_specifier) @chunk
        (type_definition) @chunk
        (preproc_function_def) @chunk
    `,
    // Bash: the function is the only meaningful indexable unit. Top-level command
    // sequences are script glue, not symbols, so they are not chunked.
    bash: `
        (function_definition) @chunk
    `,
    // Swift: struct/class/enum/extension all parse as class_declaration (the grammar
    // distinguishes them by an inner keyword); protocols and free funcs are separate.
    swift: `
        (class_declaration) @chunk
        (protocol_declaration) @chunk
        (function_declaration) @chunk
    `
};

export const EXTENSIONS = new Set(Object.keys(LANGUAGE_MAP));

// Definition of container node types to avoid nested duplicates
const CONTAINERS = new Set([
    'class_declaration', 'function_declaration', 'method_definition',
    'lexical_declaration', 'expression_statement', 'export_statement',
    'function_definition', 'class_definition', 'rule_set',
    // SCSS
    'mixin_statement', 'function_statement',
    'function_item', 'struct_item', 'enum_item', 'trait_item', 'impl_item',
    'method_declaration', 'type_declaration',
    // Java / C#
    'interface_declaration', 'constructor_declaration', 'enum_declaration',
    // Kotlin
    'object_declaration', 'companion_object', 'secondary_constructor',
    // C#
    'property_declaration',
    // Ruby
    'method', 'singleton_method', 'module',
    // C (records + typedef so nested/anonymous specifiers dedupe to one chunk)
    'struct_specifier', 'union_specifier', 'enum_specifier', 'type_definition',
    'preproc_function_def',
    // Swift (class_declaration + function_declaration already listed above)
    'protocol_declaration'
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
        // ── C ──────────────────────────────────────────────────────────────────
        else if (ext === '.c' || ext === '.h') {
            // Only quoted local includes (`#include "foo.h"`) carry intra-project
            // edges; angle-bracket system includes (<stdio.h>) are stdlib noise.
            if (node.type === 'preproc_include') {
                const str = node.children.find(c => c.type === 'string_literal');
                if (str) imports.add(str.text.replace(/^[<"]|[>"]$/g, ''));
            }
        }
        // ── Bash ─────────────────────────────────────────────────────────────────
        else if (ext === '.sh' || ext === '.bash') {
            // `source path` / `. path` pull another script into scope.
            if (node.type === 'command') {
                const cmd = node.childForFieldName?.('name')?.text;
                if (cmd === 'source' || cmd === '.') {
                    const arg = node.namedChildren.find(c => c.type !== 'command_name');
                    if (arg) imports.add(arg.text.replace(/['"]/g, ''));
                }
            }
        }
        // ── Swift ─────────────────────────────────────────────────────────────────
        else if (ext === '.swift') {
            // `import Foundation` / `import MyModule.Submodule` — module-level, rarely
            // file-resolvable, but tracked so the dependency list is non-empty.
            if (node.type === 'import_declaration') {
                const raw = node.text.replace(/^@?\w*\s*import\s+/, '').trim();
                if (raw) imports.add(raw.replace(/\./g, '/'));
            }
        }
        node.children.forEach(walk);
    }
    walk(rootNode);
    return Array.from(imports);
}

// ─── God-class defence ────────────────────────────────────────────────────────

/**
 * Token-safe skeleton for a class that exceeds GOD_CLASS_LINES.
 *
 * The agent prompt (prompts/CORE.md) promises get_chunk() costs ~300 tokens. A 2 000-line
 * "god class" stored as one chunk violates that contract. This skeleton keeps
 * only the first HEADER_LINES of the class (signature + opening brace) and
 * appends a one-line summary — enough for name resolution and embeddings, while
 * the real bodies are reachable via the individual method chunks that the
 * god-class split produces.
 */
function buildGodClassSkeleton(classNode) {
    const allLines = classNode.text.split('\n');
    const HEADER_LINES = 15;
    const header = allLines.slice(0, HEADER_LINES).join('\n');
    return (
        `${header}\n` +
        `  // ⚠ [Large class: ${allLines.length} lines — ` +
        `methods are indexed as individual searchable chunks. ` +
        `Use search_code() to find specific methods.]\n}`
    );
}

/**
 * Resolve the declared name out of a C declarator chain.
 * C nests the identifier under layers of pointer_declarator / array_declarator /
 * function_declarator (`int *make_node(void)` → pointer_declarator → function_declarator
 * → identifier), so we descend the `declarator` field until we hit the identifier.
 */
function _cDeclaratorName(node) {
    let d = node, guard = 0;
    while (d && guard++ < 16) {
        if (d.type === 'identifier' || d.type === 'type_identifier' || d.type === 'field_identifier') return d.text;
        // Descend the declarator field, or — for wrappers without that field, e.g. a
        // function-pointer typedef's parenthesized_declarator — the inner *_declarator.
        const next = d.childForFieldName?.('declarator')
            || d.namedChildren?.find(c => /_declarator$/.test(c.type));
        if (next && next !== d) { d = next; continue; }
        const id = d.namedChildren?.find(c =>
            c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'field_identifier');
        if (id) return id.text;
        break;
    }
    return null;
}

export function extractSemanticChunks(rootNode, relPath, sourceCode, ext) {
    const chunks = [];
    const parser = getParserForFile(ext);
    if (!parser) return chunks;

    const JS_LIKE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
    const EXT_TO_LANG = {
        '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.cs': 'cs',
        '.rb': 'rb',
        // .scss uses the SCSS grammar+query when installed; otherwise it parses
        // with the CSS grammar, so it MUST use the css query (the scss query
        // references node types the CSS grammar doesn't have).
        '.scss': SCSS ? 'scss' : 'css',
        // C headers share the C grammar/query; .sh and .bash share the bash query.
        // (.c and .swift resolve via the ext.slice(1) fallback below.)
        '.h': 'c', '.sh': 'bash', '.bash': 'bash',
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

        // ── God-class pre-pass ─────────────────────────────────────────────────
        // Identify class-type container nodes whose line count exceeds the threshold.
        // Their methods are allowed through the isNested filter below so each method
        // becomes its own independent, searchable chunk; the class node itself gets a
        // compact skeleton instead of a truncated body dump.
        //
        // Cross-language: class_declaration (TS/JS/Java/C#), class_definition (Python),
        // impl_item (Rust impl blocks), class (Ruby), object_declaration (Kotlin).
        // TS special case: exported classes live inside export_statement — we mark the
        // inner class_declaration so the method-isNested check works correctly.
        const GOD_CLASS_LINES = 200;
        const GOD_CLASS_NODE_TYPES = new Set([
            'class_declaration', 'class_definition',
            'impl_item',           // Rust impl blocks
            'class',               // Ruby
            'object_declaration',  // Kotlin
        ]);
        const oversizedClassIds = new Set(); // node IDs whose direct methods are un-nested

        for (const match of matches) {
            for (const capture of match.captures) {
                if (capture.name !== 'chunk') continue;
                const n = capture.node;
                const nLines = n.endPosition.row - n.startPosition.row + 1;
                if (nLines <= GOD_CLASS_LINES) continue;
                if (GOD_CLASS_NODE_TYPES.has(n.type)) {
                    oversizedClassIds.add(n.id);
                }
                // TS: large export_statement wrapping a class — mark the inner class_declaration
                // so method_definition.parent chain finds the oversized class node, not the
                // export_statement (which isn't what the isNested walk stops at).
                if (n.type === 'export_statement') {
                    for (let ci = 0; ci < n.namedChildCount; ci++) {
                        const c = n.namedChild(ci);
                        if (GOD_CLASS_NODE_TYPES.has(c.type)) {
                            oversizedClassIds.add(c.id);
                            break;
                        }
                    }
                }
            }
        }

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
            //
            // God-class exception: if the first CONTAINERS ancestor is an oversized class, the
            // node is a direct method of that class — allow it through as its own chunk.
            let isNested = false;
            let currentParent = chunkNode.parent;
            while (currentParent && currentParent.parent !== null) {
                if (CONTAINERS.has(currentParent.type)) {
                    if (!oversizedClassIds.has(currentParent.id)) {
                        isNested = true;
                    }
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
            } else if (chunkNode.type === "type_declaration") {
                // Go: `type X struct {…}` / `type X interface {…}` / `type X = Y`.
                // The identifier lives on the nested type_spec / type_alias node, not on
                // the type_declaration itself, so childForFieldName("name") above is null.
                // Without this branch every Go struct/interface collapses to the useless
                // synthetic name `<file>_type_declaration`, making core types (e.g. Gin's
                // RouterGroup, Engine, Context) unsearchable by name and invisible to the
                // 2.0× name-boost in searchHybrid.
                const spec = chunkNode.namedChildren?.find(c => c.type === "type_spec" || c.type === "type_alias");
                nameText = spec?.childForFieldName?.("name")?.text
                    || spec?.children?.find(c => c.type === "type_identifier")?.text
                    || "anonymous";
            } else if (chunkNode.type === "function_definition" || chunkNode.type === "type_definition"
                || chunkNode.type === "preproc_function_def") {
                // C: the name is not a direct `name` field. For a function it is buried in
                // declarator → … → identifier (e.g. `int *make()` nests through a
                // pointer_declarator); for a typedef the `declarator` field is the new type
                // name; a function-like macro carries an `identifier` child. Without this the
                // chunk collapses to the useless synthetic `<file>_function_definition`, making
                // every C function unsearchable by name and invisible to the 2.0× name boost.
                nameText = _cDeclaratorName(chunkNode.childForFieldName?.("declarator"))
                    || chunkNode.children.find(c => c.type === "identifier")?.text
                    || "anonymous";
            } else {
                // Generic fallback: search direct children for an identifier-like node.
                // Includes type_identifier (Go/TS), constant (Ruby class/module names) and
                // field_identifier so nested-name grammars don't fall through to anonymous.
                const idNode = chunkNode.children.find(c =>
                    c.type === "identifier" || c.type === "name" || c.type === "property_identifier"
                    || c.type === "type_identifier" || c.type === "constant" || c.type === "field_identifier");
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

            // For oversized class containers — or TS export_statements wrapping one —
            // store a compact skeleton so get_chunk() returns a bounded token count.
            // All metadata fields (calls, params, type_refs, decorators, extends) are
            // still extracted from the FULL AST node, so ranking and topology are intact.
            const isOversizedClass = oversizedClassIds.has(chunkNode.id);
            const wrapsOversizedClass = !isOversizedClass && chunkNode.type === 'export_statement' && (() => {
                for (let ci = 0; ci < chunkNode.namedChildCount; ci++) {
                    if (oversizedClassIds.has(chunkNode.namedChild(ci).id)) return true;
                }
                return false;
            })();
            const snippet = (isOversizedClass || wrapsOversizedClass)
                ? buildGodClassSkeleton(isOversizedClass ? chunkNode : (() => {
                    for (let ci = 0; ci < chunkNode.namedChildCount; ci++) {
                        const c = chunkNode.namedChild(ci);
                        if (oversizedClassIds.has(c.id)) return c;
                    }
                    return chunkNode;
                })())
                : chunkNode.text.slice(0, 3000);
            // Hash the FULL node text (not the 3000-char snippet) so the content key
            // reflects a definition's whole body. This keeps the dense channel's window
            // vectors (which embed the full body — see buildEmbeddingPayload/embeddingWindows)
            // correctly invalidated when a tail-only edit changes code past the snippet
            // cap. For chunks whose body fits the cap, node text == snippet, so the hash
            // is unchanged (no needless re-embed); BM25 and code_snippet are untouched.
            const hash = generateChunkHash(docstring + chunkNode.text);
            // Receiver-aware call sites (bounded for index size); the legacy
            // name-only `calls` list is derived from them so they never diverge.
            const callSites = extractCallSites(chunkNode).slice(0, 256);
            const outgoingCalls = Array.from(new Set(callSites.map(s => s.name)));

            // 🥇 PARAMETER / TYPE / CLASS CONTEXT ENRICHMENT (improves recall on undocumented code)
            const params = extractParams(chunkNode, ext);
            const returnType = extractReturnType(chunkNode, ext);
            const classContext = extractClassContext(chunkNode);
            const typeRefs = extractTypeAnnotations(chunkNode, ext);
            const decorators = extractDecorators(chunkNode);
            const heritage = extractHeritage(chunkNode, ext);

            const id = createHash('sha256')
                .update(`${relPath}::${chunkNode.startPosition.row}::${chunkNode.startPosition.column}`)
                .digest('hex').slice(0, 24);

            chunks.push({
                id, file_path: relPath, node_type: chunkNode.type, name: nameText,
                docstring: docstring, code_snippet: snippet, content_hash: hash,
                start_line: chunkNode.startPosition.row + 1, end_line: chunkNode.endPosition.row + 1,
                calls: outgoingCalls, call_sites: callSites,
                params, return_type: returnType, class_context: classContext,
                type_refs: typeRefs, decorators, extends: heritage,
            });
        }
    } catch (e) {
        // Visible protective log for developers
        process.stderr.write(`\n[parser-utils] 💥 Query Error in ${relPath}: ${e.message}\n`);
    }

    // ── Python public re-exports ────────────────────────────────────────────────
    // PEP 484 convention: `from starlette.background import BackgroundTasks as
    // BackgroundTasks` re-exports a symbol as public API. Files like
    // fastapi/background.py consist ONLY of such lines and previously produced
    // zero chunks — resolve_symbol('BackgroundTasks') found nothing and agents
    // hit a dead end. Each explicit re-export becomes a small chunk that names
    // the symbol and points at its source module. (JS/TS barrels already chunk
    // via the export_statement capture.)
    if (ext === '.py') {
        for (const node of rootNode.children) {
            if (node.type !== 'import_from_statement') continue;
            const moduleName = node.childForFieldName?.('module_name')?.text || '';
            for (const child of node.children) {
                if (child.type !== 'aliased_import') continue;
                const orig = child.childForFieldName?.('name')?.text || '';
                const alias = child.childForFieldName?.('alias')?.text || '';
                if (!alias || orig.split('.').pop() !== alias) continue; // only `import X as X`
                const snippet = node.text.slice(0, 300);
                const docstring = `Public re-export of ${alias} from ${moduleName}.`;
                const id = createHash('sha256')
                    .update(`${relPath}::${node.startPosition.row}::${child.startPosition.column}`)
                    .digest('hex').slice(0, 24);
                chunks.push({
                    id, file_path: relPath, node_type: 're_export', name: alias,
                    docstring, code_snippet: snippet,
                    content_hash: generateChunkHash(docstring + snippet),
                    start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1,
                    calls: [], call_sites: [], params: [], return_type: '', class_context: '',
                    type_refs: [], decorators: [], extends: [],
                });
            }
        }
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
        // ── C / Bash non-dotted relative includes ──────────────────────────
        // C `#include "net/socket.h"` and Bash `source lib/util.sh` are resolved
        // relative to the including file's directory, then to the project root.
        else if ((ext === '.c' || ext === '.h' || ext === '.sh' || ext === '.bash')) {
            for (const abs of [path.resolve(fileDir, raw), path.join(projectRoot, raw)]) {
                if (EXTENSIONS.has(path.extname(abs)) && fs.existsSync(abs)) {
                    const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
                    if (!rel.startsWith('..') && !resolved.includes(rel)) resolved.push(rel);
                    break;
                }
            }
        }
    }
    return resolved;
}

/**
 * Build the text payload sent to the embedding model for a chunk.
 *
 * Shared by the bootstrap indexer (indexer.mjs) and the watch daemon
 * (watch-daemon.mjs) so a chunk yields the SAME embedding regardless of which
 * path embedded it first. This matters because the cache key (content_hash) is
 * derived from code + docstring only — it does NOT include this payload — so two
 * divergent payloads for the same hash would silently produce inconsistent
 * embeddings across a full re-index vs. an incremental update.
 *
 * @param {object}   chunk        Semantic chunk: { file_path, node_type, name, docstring, type_refs, code_snippet }.
 * @param {string[]} depRelPaths  Resolved local imports of the chunk's file (project-relative paths).
 * @returns {string}
 */
export function buildEmbeddingPayload(chunk, depRelPaths = [], bodyOverride = null) {
    const neighbors = depRelPaths
        .map(d => path.basename(d, path.extname(d)))
        .filter(Boolean);
    const topologicalContext = neighbors.length
        ? `This code architectural neighborhood connects with: ${neighbors.join(', ')}.`
        : '';
    // NOTE: decorators and inheritance edges are NOT added here (A/B-tested: neutral
    // on vector, regression on BM25 — surfaced as metadata only).
    // LLM summary leads the payload when available: declarative voice aligns with
    // nomic-embed-text's search_document: training objective and anchors the embedding
    // toward developer query vocabulary. Questions/hyde are intentionally excluded from
    // the vector payload — they add stopword noise and dilute the code's semantic
    // fingerprint. Concept keywords (chunk.hyde = concepts.join(' ')) go to BM25 only
    // via buildLexicalDocument, keeping both retrieval channels clean.
    return [
        chunk.summary || '',   // semantic lead: LLM-generated declarative summary (opt-in)
        `File Location: ${chunk.file_path}`,
        `Symbol Name: ${chunk.node_type} -> ${chunk.name}`,
        chunk.docstring ? `Developer Documentation: ${chunk.docstring}` : '',
        chunk.type_refs?.length ? `Type References: ${chunk.type_refs.join(', ')}` : '',
        topologicalContext,
        `--- Source Code ---`,
        // The dense channel embeds the FULL body for oversized definitions (bodyOverride,
        // windowed by embeddingWindows); BM25 keeps using the 3000-char code_snippet.
        bodyOverride || chunk.code_snippet,
    ].filter(Boolean).join('\n');
}

/**
 * The full source body of a chunk whose code_snippet was truncated by the 3000-char
 * cap — sliced from the file content by line range — so the dense channel can window
 * the WHOLE definition (the lexical/BM25 path stays capped, byte-identical). Returns
 * null when the chunk is not truncated (snippet == body) or is a god-class skeleton
 * (its methods are already their own chunks). Used at embed time by the indexer and
 * the watch daemon, both of which hold the source content.
 *
 * @param {object} chunk        A semantic chunk (needs code_snippet, start_line, end_line).
 * @param {string} fileContent  The chunk's full file source.
 * @returns {string|null}
 */
export function fullBodyForEmbedding(chunk, fileContent) {
    if (!chunk || !fileContent) return null;
    if ((chunk.code_snippet?.length || 0) < 3000) return null;          // not truncated
    if (chunk.code_snippet.includes('Large class:')) return null;       // god-class skeleton
    if (!chunk.start_line || !chunk.end_line) return null;
    const body = fileContent.split('\n').slice(chunk.start_line - 1, chunk.end_line).join('\n');
    return body.length > chunk.code_snippet.length ? body : null;
}

export async function getLocalEmbedding(text, graceful = true, { ollamaHost, model } = {}) {
    if (process.env.INDEXER_EMBEDDINGS === 'off') return null; // lexical-only mode
    const host = _resolveOllamaHost(ollamaHost);
    const embedModel = _resolveEmbedModel(model);
    const MAX_RETRIES = 3;
    const safeText = "search_query: " + truncateForEmbedding(text);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(`${host}/api/embeddings`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: embedModel, prompt: safeText }),
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

export async function getLocalEmbeddingsBatch(texts, graceful = true, { ollamaHost, model } = {}) {
    if (!texts || texts.length === 0) return [];
    if (process.env.INDEXER_EMBEDDINGS === 'off') return null; // lexical-only mode
    const host = _resolveOllamaHost(ollamaHost);
    const embedModel = _resolveEmbedModel(model);
    const MAX_RETRIES = 3;
    const safeTexts = texts.map(t => "search_document: " + (t.length > 8000 ? t.slice(0, 8000) : t));

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(`${host}/api/embed`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: embedModel, input: safeTexts }),
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

/**
 * Extract decorator / annotation names applied to a chunk (and, for class chunks,
 * to the methods inside it). Decorators encode what a symbol *is* in modern
 * frameworks — `@Controller`, `@Injectable`, `@Get`, `@Entity` (TS: NestJS,
 * Angular, TypeORM) and `@app.route`, `@pytest.fixture`, `@dataclass`,
 * `@property` (Python) — yet as raw snippet text they are diluted to a single
 * low-weight token inside a large class body. Surfacing them as a dedicated field
 * lets a class annotated `@Controller` be retrieved by "controller" and a method
 * annotated `@Get` by "get/route", independent of language.
 *
 * Generalises by node type only (the tree-sitter `decorator` node is shared across
 * TS/JS/Python grammars) — no framework-specific names are hardcoded. Callee
 * arguments are stripped: `@Controller('cats')` -> 'Controller',
 * `@app.route('/x')` -> 'app.route', `@UseGuards(AuthGuard)` -> 'UseGuards'.
 *
 * @returns {string[]} unique decorator callee names (max 24)
 */
export function extractDecorators(chunkNode) {
    const names = new Set();
    const addDecorator = (decoNode) => {
        let t = (decoNode.text || '').trim().replace(/^@/, '');
        t = t.split('(')[0];              // drop call arguments: @Get(':id') -> Get
        t = t.split(/[\s\n{]/)[0].trim(); // first token only
        if (t && t.length <= 64) names.add(t);
    };

    // (1) Decorators that PRECEDE the chunk as siblings. Python wraps a decorated
    //     symbol in `decorated_definition` ([decorator…, def]); some grammars place
    //     class decorators as leading siblings rather than children.
    let prev = chunkNode.previousSibling;
    while (prev) {
        if (prev.type === 'decorator') addDecorator(prev);
        else if (prev.isNamed && prev.type !== 'comment') break;
        prev = prev.previousSibling;
    }

    // (2) Decorators within the chunk's subtree. A captured TS class chunk (the
    //     enclosing export_statement / class_declaration) carries its own class
    //     decorators plus the @Get/@Post/@Inject decorators on its methods.
    //     Bounded traversal so a large class body cannot inflate indexing time.
    let budget = 800;
    const stack = [chunkNode];
    while (stack.length && budget-- > 0) {
        const n = stack.pop();
        for (let i = 0; i < n.namedChildCount; i++) {
            const child = n.namedChild(i);
            if (child.type === 'decorator') addDecorator(child);
            else stack.push(child);
        }
    }

    return Array.from(names).slice(0, 24);
}

/**
 * Extract the base classes and implemented interfaces of a class chunk — the
 * inheritance edge that links a concept to its implementations
 * (`class ValidationPipe extends BasePipe implements PipeTransform`). Surfacing
 * this lets an agent move from an abstract type to the concrete classes that
 * realise it, and feeds the semantic embedding so an implementation is retrievable
 * by the interface it fulfils.
 *
 * Generalises across `extends`/`implements` (TS/JS) and base-class argument lists
 * (Python) by node type. Returns parent type names, e.g.
 * ['BasePipe', 'PipeTransform', 'OnInit'].
 *
 * @returns {string[]} base/interface names (max 12)
 */
export function extractHeritage(chunkNode, ext) {
    const bases = new Set();
    const JS_LIKE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

    const addTypeNames = (node) => {
        const stack = [node];
        let budget = 200;
        while (stack.length && budget-- > 0) {
            const n = stack.pop();
            if ((n.type === 'type_identifier' || n.type === 'identifier') && /^[A-Za-z_$]/.test(n.text)) {
                bases.add(n.text);
            }
            for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
        }
    };

    if (JS_LIKE.includes(ext)) {
        // Walk the chunk subtree for extends/implements clauses, but never descend
        // into class_body — base types of the class only, not its method internals.
        const stack = [chunkNode];
        let budget = 400;
        while (stack.length && budget-- > 0) {
            const n = stack.pop();
            if (n.type === 'extends_clause' || n.type === 'implements_clause') { addTypeNames(n); continue; }
            for (let i = 0; i < n.namedChildCount; i++) {
                const c = n.namedChild(i);
                if (c.type !== 'class_body' && c.type !== 'statement_block') stack.push(c);
            }
        }
    } else if (ext === '.py') {
        const sc = chunkNode.childForFieldName?.('superclasses');
        if (sc) {
            for (let i = 0; i < sc.namedChildCount; i++) {
                const c = sc.namedChild(i);
                // skip keyword args like metaclass=… (keyword_argument node)
                if (c.type === 'identifier' || c.type === 'attribute') bases.add(c.text);
            }
        }
    } else {
        // Other indexed languages: each grammar exposes the base class / implemented
        // interface / supertrait names under a small set of "heritage clause" node
        // types (discovered per grammar). We walk the chunk for those clause nodes
        // and collect the capitalized type names inside — cheap, no type inference.
        // A grammar we don't have a clause for simply yields [] (today's behaviour).
        const CLAUSES = HERITAGE_CLAUSES[ext];
        if (CLAUSES) {
            const stack = [chunkNode];
            let budget = 400;
            while (stack.length && budget-- > 0) {
                const n = stack.pop();
                if (CLAUSES.has(n.type)) { collectHeritageNames(n, bases); continue; }
                for (let i = 0; i < n.namedChildCount; i++) {
                    const c = n.namedChild(i);
                    if (!HERITAGE_BODY_TYPES.has(c.type)) stack.push(c); // base types sit before the body
                }
            }
        }
        // Go has no inheritance keyword — embedding (an anonymous field whose name IS
        // a type) is the closest "is-a/has-a" edge, so surface embedded type names.
        if (ext === '.go') collectGoEmbedding(chunkNode, bases);
    }
    return Array.from(bases).slice(0, 12);
}

// Per-grammar node types whose subtree holds base/interface/supertrait names.
const HERITAGE_CLAUSES = {
    '.java': new Set(['superclass', 'super_interfaces']),
    '.cs': new Set(['base_list']),
    '.php': new Set(['base_clause', 'class_interface_clause']),
    '.kt': new Set(['delegation_specifier']),
    '.swift': new Set(['inheritance_specifier']),
    '.rb': new Set(['superclass']),
    '.rs': new Set(['trait_bounds']), // supertrait bounds on a trait_item
};
// Member-body nodes the heritage walk must not descend into (base types precede them).
const HERITAGE_BODY_TYPES = new Set([
    'class_body', 'declaration_list', 'enum_body', 'statement_block', 'block',
    'function_body', 'field_declaration_list', 'interface_body', 'struct_body', 'class_body_declaration',
]);

/** Collect capitalized type names anywhere under a heritage-clause node. */
function collectHeritageNames(node, set) {
    const stack = [node];
    let budget = 200;
    while (stack.length && budget-- > 0) {
        const n = stack.pop();
        if (HERITAGE_NAME_TYPES.has(n.type) && /^[A-Z]/.test(n.text || '')) set.add(n.text);
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}
const HERITAGE_NAME_TYPES = new Set([
    'type_identifier', 'identifier', 'constant', 'simple_identifier', 'name', 'scoped_type_identifier',
]);

/** Go struct/interface embedding: a field/spec whose name IS a bare type. */
function collectGoEmbedding(chunkNode, set) {
    const stack = [chunkNode];
    let budget = 400;
    while (stack.length && budget-- > 0) {
        const n = stack.pop();
        // An embedded field_declaration has a type but no field name; the type node
        // is the embed. (A named field `leash Leash` has a `name` child.)
        if (n.type === 'field_declaration' && !n.childForFieldName?.('name')) {
            for (let i = 0; i < n.namedChildCount; i++) {
                const c = n.namedChild(i);
                if ((c.type === 'type_identifier' || c.type === 'qualified_type') && /^[A-Z]/.test(c.text || '')) {
                    set.add(c.text.split('.').pop());
                }
            }
        }
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}

// C#: C# spells type names as bare `identifier` / `generic_name` (NOT the
// `type_identifier` node the cross-language branch keys on), so the generic walk
// yields [] for C#. These constants drive a `.cs`-gated branch that reads types
// only from the field-precise positions where an identifier IS a type, so we never
// mistake a variable/member name for a type.
const CS_TYPE_HOST = new Set(['parameter', 'variable_declaration', 'property_declaration', 'method_declaration', 'base_list']);
// Generic-constraint / contextual keywords that occupy type position but aren't types.
const CS_TYPE_KEYWORDS = new Set(['where', 'new', 'class', 'struct', 'unmanaged', 'notnull', 'var']);

/** Collect simple C# type names from a type-position node (descending through
 *  generics / arrays / nullables / tuples). Skips predefined primitives and `var`,
 *  keeps only PascalCase names, and reduces a qualified name to its last segment. */
function _csTypeNamesFrom(node, out) {
    if (!node) return;
    const stack = [node];
    let budget = 200;
    while (stack.length && budget-- > 0) {
        const n = stack.pop();
        const t = n.type;
        if (t === 'predefined_type' || t === 'implicit_type') continue; // int/string/void/var…
        if (t === 'identifier' || t === 'type_identifier') {
            const nm = n.text;
            if (nm && /^[A-Z]/.test(nm) && !CS_TYPE_KEYWORDS.has(nm)) out.add(nm);
            continue;
        }
        if (t === 'qualified_name') {
            // The type is the LAST segment; it may itself be a generic_name
            // (System.Collections.Generic.List<Order>). Descend into just that
            // segment → "List" + "Order" (not a malformed "List<Order>"), while
            // never visiting the namespace identifiers (System/Collections/Generic).
            const last = n.namedChild(n.namedChildCount - 1);
            if (last && (last.type === 'generic_name' || last.type === 'identifier' || last.type === 'type_identifier')) {
                stack.push(last);
            } else {
                const seg = (n.text || '').split('.').pop();
                if (seg && /^[A-Z]/.test(seg) && !CS_TYPE_KEYWORDS.has(seg)) out.add(seg);
            }
            continue;
        }
        // generic_name / array_type / nullable_type / tuple_type / type_argument_list /
        // pointer_type … → descend to reach the inner type names.
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}

/**
 * Frontier 2: Extract TypeScript/Python type annotation names from a chunk node.
 * Returns simple type names (e.g. ['User', 'AuthToken', 'PaymentService'])
 * used to enrich the inverted index and the type_refs chunk field.
 */
export function extractTypeAnnotations(chunkNode, ext) {
    const types = new Set();
    // JS/TS + Python use the precise annotation branches below. Every other indexed
    // language is covered by the shared `type_identifier` branch (that node appears
    // ONLY in type position across Go/Rust/Java/Kotlin/Swift/C) plus a `named_type`
    // branch for PHP — so the type-user dimension of find_references works in those
    // languages too, with no early-out and no type inference. C# is the exception:
    // it spells types as bare `identifier`/`generic_name`, so it gets a dedicated
    // field-precise branch below (gated on `.cs`). Ruby (dynamically typed) still
    // carries no cheap type signal and naturally yields [].

    function walk(node) {
        // TypeScript: type_annotation nodes contain the type text
        if (node.type === 'type_annotation') {
            const typeText = node.text.replace(/^:\s*/, '').trim();
            // Extract simple identifiers from the type (skip primitives)
            const PRIMITIVES = new Set(['string', 'number', 'boolean', 'void', 'any', 'unknown', 'never', 'null', 'undefined', 'object', 'symbol', 'bigint']);
            for (const match of typeText.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)) {
                if (!PRIMITIVES.has(match[1].toLowerCase())) types.add(match[1]);
            }
        }
        // type_identifier / generic_type: a named type in type position. This is the
        // cross-language branch — type_identifier is how Go/Rust/Java/Kotlin/Swift/C
        // (and TS) all spell a referenced type name.
        else if (node.type === 'type_identifier' || node.type === 'generic_type') {
            const name = node.children[0]?.text || node.text;
            if (name && /^[A-Z]/.test(name)) types.add(name);
        }
        // PHP: a typed parameter / return uses `named_type` (e.g. `Owner`, `\App\User`).
        else if (node.type === 'named_type') {
            const seg = (node.text || '').replace(/^\?/, '').split('\\').pop().trim();
            if (seg && /^[A-Z]/.test(seg)) types.add(seg);
        }
        // Python: type comments or annotations (annotation nodes)
        else if (node.type === 'annotation' && ext === '.py') {
            const typeText = node.text.replace(/^->\s*|^:\s*/, '').trim();
            for (const match of typeText.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)) {
                types.add(match[1]);
            }
        }
        // C#: types live as bare identifiers in field-precise positions — a
        // parameter/field/property/local's `type`, a method's `returns`, and the
        // class `base_list`. Additive and `.cs`-only, so all other languages are
        // byte-identical to before.
        else if (ext === '.cs' && CS_TYPE_HOST.has(node.type)) {
            if (node.type === 'base_list') {
                _csTypeNamesFrom(node, types);
            } else {
                _csTypeNamesFrom(node.childForFieldName?.('type') || node.childForFieldName?.('returns') || null, types);
            }
        }
        for (const child of node.children) walk(child);
    }
    walk(chunkNode);
    return Array.from(types).slice(0, 20);
}

// Call names that are framework/stdlib noise rather than project call edges.
const CALL_NOISE = new Set(['require', 'console', 'log', 'expect', 'test', 'it', 'describe', 'setTimeout', 'print', 'println!']);
function _validCallName(c) { return Boolean(c) && c.length > 2 && !CALL_NOISE.has(c); }

// Shell builtins / ubiquitous coreutils — emitting these as Bash call edges would
// bury the project's own function-to-function calls in noise (they never resolve to
// an indexed symbol anyway). Project functions and notable tools (docker, git, npm,
// kubectl…) are kept.
const BASH_BUILTINS = new Set([
    'echo', 'cd', 'ls', 'cat', 'rm', 'cp', 'mv', 'mkdir', 'rmdir', 'touch', 'ln',
    'export', 'local', 'readonly', 'declare', 'unset', 'shift', 'read', 'printf',
    'exit', 'return', 'eval', 'exec', 'trap', 'wait', 'sleep', 'pwd', 'set', 'shopt',
    'source', 'test', 'true', 'false', 'kill', 'jobs', 'type', 'command', 'getopts',
    'grep', 'sed', 'awk', 'cut', 'tr', 'sort', 'uniq', 'head', 'tail', 'find', 'xargs',
    'chmod', 'chown', 'tee', 'wc', 'basename', 'dirname', 'tar', 'curl', 'wget', 'env',
]);

/**
 * Collapse a call's receiver expression into a compact disambiguation hint:
 *   • ''        — unqualified call (`foo()`): a free function or in-scope name.
 *   • 'this'    — `this.`/`self.`-rooted: dispatch on the SAME instance/class.
 *   • '<ident>' — the last identifier of the receiver expression (`db.save()` → 'db',
 *                 `UserService.find()` → 'UserService'), the only cheap type signal
 *                 available without full inference.
 * This is what lets get_call_graph separate the real callers of `OrderService.save`
 * from every unrelated `save()` in the repo (see mcp-tools.classifyCallers).
 */
function _receiverHint(objNode) {
    if (!objNode) return '';
    const t = objNode.text || '';
    if (/^(this|self)\b/.test(t)) return 'this';
    const segs = t.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
    return segs.length ? segs[segs.length - 1] : '';
}

/**
 * C#: the invoked-name node is either a plain `identifier` or a `generic_name`
 * (`Method<T>`, children = identifier + type_argument_list) whose leading
 * `identifier` is the real method name. Strip the type-argument list so the
 * recorded callee is `Method`, not `Method<T>`.
 */
function _csInvokedName(node) {
    if (!node) return '';
    if (node.type === 'identifier') return node.text;
    const id = node.children?.find(c => c.type === 'identifier');
    return id ? id.text : (node.text || '').split('<')[0];
}

// ─── Scope-aware receiver type inference (intra-procedural, best-effort) ──────────
// `db.s.save()` and `const s = getStore(); s.save()` both record a receiver hint of
// `s` (a variable, not a type), so classifyCallers can only name-match them and they
// leak into every `save()` in the repo. A cheap pass over the SAME chunk subtree
// resolves the simple local bindings the AST already makes explicit — `new Repo()`,
// a constructor/factory call, and TS/Python type annotations — and tags the call
// site with `recv_type` (resolved here) or `recv_via_call` (a factory whose return
// type is resolved at query time from the index). This is strictly additive: a call
// site that cannot be resolved keeps exactly its old `{ name, recv }` shape and stays
// name-only. Only languages whose type is recoverable from the AST participate
// (TS/JS via `new`/annotations, Python via annotations/obvious constructors, plus the
// trivially-safe Java/C# `new Foo()`); receiver-less languages are untouched.

/** Clean a type-position node's text to a type string, or null if it carries no
 *  capitalized identifier (drops primitives like `string`/`number[]`). Generics and
 *  namespaces are preserved verbatim — classifyCallers token-matches against them. */
function _bindingTypeName(typeText) {
    if (!typeText) return null;
    const cleaned = typeText.replace(/^->\s*/, '').replace(/^[:\s]+/, '').trim().slice(0, 64);
    return /[A-Z]/.test(cleaned) ? cleaned : null;
}

/** Peel await/parenthesized wrappers off a value expression (TS `await getStore()`,
 *  Python `await get_store()`). Bounded to avoid pathological nesting. */
function _unwrapValueNode(node) {
    let n = node, guard = 0;
    while (n && guard++ < 6) {
        if (n.type === 'await_expression' || n.type === 'await') { n = n.namedChildren?.[0]; continue; }
        if (n.type === 'parenthesized_expression') { n = n.namedChildren?.[0]; continue; }
        break;
    }
    return n;
}

/**
 * Classify a right-hand-side value into the type of the binding it produces:
 *   • { type }     — directly recoverable now (`new Repo()`, `(x as Repo)`,
 *                    a Python `Repo()` constructor, Java/C# `new Repo()`).
 *   • { viaCall }  — a factory call whose return type is resolved later from the
 *                    callee's recorded return_type (`getStore()`).
 *   • null         — nothing safe to infer.
 */
function _classifyValueNode(node) {
    node = _unwrapValueNode(node);
    if (!node) return null;
    const t = node.type;
    if (t === 'new_expression') { // TS/JS: new Repo()
        const ctor = node.childForFieldName?.('constructor') || node.namedChildren?.[0];
        const tn = _bindingTypeName(ctor?.text);
        return tn ? { type: tn } : null;
    }
    if (t === 'object_creation_expression') { // Java / C#: new Repo() (trivially safe)
        const ty = node.childForFieldName?.('type') || node.namedChildren?.find(c => /type|name|identifier/.test(c.type));
        const tn = _bindingTypeName(ty?.text);
        return tn ? { type: tn } : null;
    }
    if (t === 'as_expression' || t === 'satisfies_expression') { // TS: const s = x as Repo
        const ty = node.childForFieldName?.('type') || node.namedChildren?.[node.namedChildren.length - 1];
        const tn = _bindingTypeName(ty?.text);
        if (tn) return { type: tn };
        return _classifyValueNode(node.childForFieldName?.('expression') || node.namedChildren?.[0]);
    }
    if (t === 'call') { // Python: Repo() is a constructor by convention; get_store() is a factory
        const fn = node.childForFieldName?.('function') || node.children?.[0];
        if (fn?.type === 'identifier') {
            return /^[A-Z]/.test(fn.text) ? { type: fn.text } : (_validCallName(fn.text) ? { viaCall: fn.text } : null);
        }
        if (fn?.type === 'attribute') {
            const last = fn.childForFieldName?.('attribute')?.text; // mod.Repo()
            if (last && /^[A-Z]/.test(last)) return { type: last };
        }
        return null;
    }
    if (t === 'call_expression') { // TS/JS/Swift/Go/Rust/C: factory call — defer to return_type
        const fn = node.childForFieldName?.('function') || node.children?.[0];
        if (fn && (fn.type === 'identifier' || fn.type === 'simple_identifier') && _validCallName(fn.text)) return { viaCall: fn.text };
        return null;
    }
    return null;
}

/**
 * Collect simple local variable → binding-type for one chunk subtree. Handles the
 * common, unambiguous forms only; a variable bound to two different things is dropped
 * (conflict) rather than guessed. `this`/`self` are excluded (handled by the `this`
 * receiver bucket). One extra subtree pass per chunk — O(chunk size), no whole-program
 * analysis — justified by the precision win on dynamically-typed receivers.
 */
function _inferLocalBindings(rootNode) {
    const bindings = new Map();
    const set = (name, val) => {
        if (!name || name === 'this' || name === 'self' || !val) return;
        const prev = bindings.get(name);
        if (prev === undefined) { bindings.set(name, val); return; }
        if (prev.conflict) return;
        if (prev.type !== val.type || prev.viaCall !== val.viaCall) bindings.set(name, { conflict: true });
    };
    function walk(node) {
        const t = node.type;
        if (t === 'variable_declarator') { // TS/JS: const s = new Repo() / getStore()
            const nameNode = node.childForFieldName?.('name');
            if (nameNode && nameNode.type === 'identifier') {
                const val = _classifyValueNode(node.childForFieldName?.('value'));
                if (val) set(nameNode.text, val);
            }
        } else if (t === 'required_parameter' || t === 'optional_parameter') { // TS typed param: (s: Repo)
            const id = node.childForFieldName?.('pattern');
            const ty = node.childForFieldName?.('type');
            if (id && id.type === 'identifier' && ty) { const tn = _bindingTypeName(ty.text); if (tn) set(id.text, { type: tn }); }
        } else if (t === 'assignment') { // Python: s = Repo() / s: Repo = ...
            const left = node.childForFieldName?.('left');
            const ty = node.childForFieldName?.('type');
            if (left && left.type === 'identifier') {
                if (ty) { const tn = _bindingTypeName(ty.text); if (tn) set(left.text, { type: tn }); }
                else { const val = _classifyValueNode(node.childForFieldName?.('right')); if (val) set(left.text, val); }
            }
        } else if (t === 'typed_parameter' || t === 'typed_default_parameter') { // Python typed param: (s: Repo)
            const id = node.childForFieldName?.('name') || node.children?.find(c => c.type === 'identifier');
            const ty = node.childForFieldName?.('type');
            if (id && ty) { const tn = _bindingTypeName(ty.text); if (tn) set(id.text, { type: tn }); }
        }
        node.children.forEach(walk);
    }
    walk(rootNode);
    return bindings;
}

/** Resolve a call site's receiver object node to a binding ({type}|{viaCall}|null):
 *  a simple variable via the binding map, or an inline `new Repo()`/`getStore()`. */
function _inferReceiverType(objNode, bindings) {
    if (!objNode) return null;
    if (objNode.type === 'identifier' || objNode.type === 'simple_identifier') {
        const v = objNode.text;
        if (v === 'this' || v === 'self') return null;
        const b = bindings.get(v);
        return (b && !b.conflict) ? b : null;
    }
    return _classifyValueNode(objNode); // inline: new Repo().save(), getStore().save()
}

/**
 * Walk a subtree and collect every call site as { name, recv } (receiver hint), plus
 * an optional `recv_type` / `recv_via_call` when the receiver's type is recoverable
 * intra-procedurally (see the inference helpers above). Deduplicated by (name, recv).
 * Cross-language: call_expression (JS/TS/Go/Rust/C and Swift via simple_identifier/
 * navigation_expression), call (Python), macro_invocation (Rust), method_invocation
 * (Java/C#), method_call (Ruby), command (Bash). The receiver is the precision half of
 * the call graph — extractCalls() derives the legacy name-only list from these sites.
 */
export function extractCallSites(rootNode) {
    const sites = [];
    const bindings = _inferLocalBindings(rootNode);
    const seen = new Set();
    // `objNode` is the receiver expression node (when the call is a method call), used
    // to recover a static type for the receiver. Free calls pass none.
    const add = (name, recv, objNode = null) => {
        if (!name) return;
        const key = name + ' ' + recv;
        if (seen.has(key)) return;
        seen.add(key);
        const site = { name, recv };
        const inferred = objNode ? _inferReceiverType(objNode, bindings) : null;
        if (inferred?.type) site.recv_type = inferred.type;
        else if (inferred?.viaCall) site.recv_via_call = inferred.viaCall;
        sites.push(site);
    };
    function walk(node) {
        const t = node.type;
        if (t === 'call_expression') {
            const funcNode = node.childForFieldName?.('function') || node.children[0];
            if (funcNode) {
                if (funcNode.type === 'identifier') add(funcNode.text, '');
                else if (funcNode.type === 'simple_identifier') add(funcNode.text, ''); // Swift free call
                else if (funcNode.type === 'member_expression' || funcNode.type === 'property_identifier') {
                    const prop = funcNode.childForFieldName?.('property');
                    const obj = funcNode.childForFieldName?.('object');
                    if (prop) add(prop.text, _receiverHint(obj), obj);
                    else add(funcNode.text.split('.').pop(), '');
                } else if (funcNode.type === 'navigation_expression') { // Swift obj.method / self.method
                    const suffix = funcNode.childForFieldName?.('suffix');
                    const m = suffix?.namedChildren?.find(c => c.type === 'simple_identifier')?.text
                        || suffix?.text?.replace(/^\./, '');
                    const target = funcNode.childForFieldName?.('target');
                    if (m) add(m, _receiverHint(target), target);
                }
            }
        } else if (t === 'command') { // Bash: a command is a function/program invocation
            const cmd = (node.childForFieldName?.('name')?.text || '').trim();
            // bare identifiers only — skip paths, env-prefixed assignments, builtins.
            if (cmd && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(cmd) && !BASH_BUILTINS.has(cmd)) add(cmd, '');
        } else if (t === 'call') { // Python
            const funcNode = node.childForFieldName?.('function') || node.children[0];
            if (funcNode) {
                if (funcNode.type === 'identifier') add(funcNode.text, '');
                else if (funcNode.type === 'attribute') {
                    const attr = funcNode.childForFieldName?.('attribute');
                    const obj = funcNode.childForFieldName?.('object');
                    if (attr) add(attr.text, _receiverHint(obj), obj);
                }
            }
        } else if (t === 'macro_invocation') { // Rust
            const macroNode = node.childForFieldName?.('macro') || node.children[0];
            if (macroNode && macroNode.type === 'identifier') add(macroNode.text + '!', '');
        } else if (t === 'method_invocation') { // Java
            const nameNode = node.childForFieldName?.('name') || node.children.find(c => c.type === 'identifier');
            const obj = node.childForFieldName?.('object');
            if (nameNode) add(nameNode.text, _receiverHint(obj), obj);
        } else if (t === 'invocation_expression') { // C# — the grammar has NO method_invocation; a call is
            // invocation_expression(function, arguments). The function is a bare identifier (same-class /
            // using-static call) or a member_access_expression (obj.Method() / this.Method()).
            const fn = node.childForFieldName?.('function');
            if (fn) {
                if (fn.type === 'member_access_expression') {
                    const nm = _csInvokedName(fn.childForFieldName?.('name'));
                    const expr = fn.childForFieldName?.('expression');
                    if (nm) add(nm, _receiverHint(expr), expr);
                } else if (fn.type === 'identifier') {
                    add(fn.text, '');
                } else if (fn.type === 'generic_name') {
                    const nm = _csInvokedName(fn);
                    if (nm) add(nm, '');
                }
            }
        } else if (t === 'method_call') { // Ruby
            const method = node.childForFieldName?.('method') || node.children.find(c => c.type === 'identifier');
            const receiver = node.childForFieldName?.('receiver');
            if (method && method.type === 'identifier') add(method.text, _receiverHint(receiver), receiver);
        } else if (t === 'function_call_expression') { // PHP: foo() / \App\Helpers\bar()
            const fn = node.childForFieldName?.('function');
            if (fn && (fn.type === 'name' || fn.type === 'qualified_name')) {
                const nm = (fn.text || '').split('\\').filter(Boolean).pop();
                if (nm) add(nm, '');
            }
        } else if (t === 'member_call_expression' || t === 'nullsafe_member_call_expression') { // PHP: $obj->method()
            const nameNode = node.childForFieldName?.('name');
            const obj = node.childForFieldName?.('object');
            if (nameNode && nameNode.type === 'name') add(nameNode.text, _receiverHint(obj), obj);
        } else if (t === 'scoped_call_expression') { // PHP: Class::method() / self::method() / parent::method()
            const nameNode = node.childForFieldName?.('name');
            const scope = node.childForFieldName?.('scope');
            if (nameNode && nameNode.type === 'name') add(nameNode.text, _receiverHint(scope), scope);
        }
        node.children.forEach(walk);
    }
    walk(rootNode);
    return sites.filter(s => _validCallName(s.name));
}

/** Legacy name-only outgoing-call list (unique callee names). Derived from
 *  extractCallSites so the two never diverge; preserved for the BM25 document
 *  and the back-compat findCallers contract. */
export function extractCalls(rootNode) {
    const seen = new Set();
    const out = [];
    for (const { name } of extractCallSites(rootNode)) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}

// ─── HTTP route extraction ────────────────────────────────────────────────────
// The call graph records that a function was called, but cannot connect an HTTP
// verb+path (`GET /api/users`) to the handler that serves it. extractRoutes mines
// that mapping at index time from the four common shapes:
//   • decorator-on-method     — NestJS/Angular  (@Get/@Post on a class method)
//   • decorator-on-function   — FastAPI/Flask    (@app.get / @app.route)
//   • annotation-on-method    — Spring Boot      (@GetMapping / @RequestMapping)
//   • functional registration — Express/Koa      (router.get('/x', handler))
// Each route resolves its handler to a chunk id (by name, case-sensitive) so an
// agent can jump straight from an endpoint to get_chunk / get_call_graph on the
// handler. No framework names are hardcoded beyond the verb sets — detection is by
// AST node type, mirroring extractDecorators / extractCallSites.

const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'head', 'options']);
// C# generic-constraint keywords that can sit in type position but are not types.
const ROUTE_JS_LIKE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Unquote a string-literal node across grammars (JS string_fragment, Python
 *  string_content, Java string_fragment, …). Returns null for non-string nodes. */
function _routeLiteral(node) {
    if (!node) return null;
    const STR = new Set(['string', 'template_string', 'string_literal',
        'interpreted_string_literal', 'raw_string_literal']);
    if (!STR.has(node.type)) return null;
    const frag = node.namedChildren?.find(c => /fragment|content/.test(c.type));
    if (frag) return frag.text;
    return node.text.replace(/^[`'"]+|[`'"]+$/g, '');
}

/** Join a controller/class path prefix to a method path. Empty prefix → path as-is
 *  (spec: "if no Controller prefix, leave it as-is"). Collapses duplicate slashes. */
function _joinRoutePath(prefix, sub) {
    prefix = (prefix || '').trim();
    sub = (sub || '').trim();
    if (!prefix) return sub;
    if (!sub) return prefix;
    return (prefix.replace(/\/+$/, '') + '/' + sub.replace(/^\/+/, '')).replace(/\/{2,}/g, '/');
}

/** Decorators that lead a node as siblings (mirrors extractDecorators' sibling walk).
 *  NestJS method decorators sit as previous siblings inside the class_body. */
function _leadingDecorators(node) {
    const out = [];
    let prev = node.previousSibling;
    while (prev) {
        if (prev.type === 'decorator') out.push(prev);
        else if (prev.isNamed && prev.type !== 'comment') break;
        prev = prev.previousSibling;
    }
    return out;
}

/** Parse a TS/JS decorator node into { name, path } — name is the callee (`Get`,
 *  `Controller`), path is its first string argument (or null for bare `@Get()`). */
function _parseTsDecorator(decoNode) {
    const call = decoNode.namedChildren?.find(c => c.type === 'call_expression');
    if (!call) {
        const id = decoNode.namedChildren?.find(c => c.type === 'identifier');
        return { name: id?.text || decoNode.text.replace(/^@/, '').split(/[\s(]/)[0], path: null };
    }
    const fn = call.childForFieldName?.('function');
    let name = '';
    if (fn?.type === 'identifier') name = fn.text;
    else if (fn?.type === 'member_expression') name = fn.childForFieldName?.('property')?.text || '';
    const args = call.childForFieldName?.('arguments');
    const firstStr = args?.namedChildren?.find(c => _routeLiteral(c) != null);
    return { name, path: _routeLiteral(firstStr) };
}

/** NestJS / Angular: @Get/@Post/… on class methods, with the enclosing
 *  @Controller(prefix) prepended. */
function _extractNestRoutes(rootNode, emit) {
    const stack = [rootNode];
    while (stack.length) {
        const n = stack.pop();
        if (n.type === 'class_declaration' || n.type === 'abstract_class_declaration') {
            // @Controller prefix. For `export class` the decorator is a leading
            // sibling (inside export_statement); for a bare/abstract `class` it is a
            // direct child of the class node before class_body. Check both.
            const classDecos = [..._leadingDecorators(n)];
            for (let i = 0; i < n.namedChildCount; i++) {
                const c = n.namedChild(i);
                if (c.type === 'class_body') break;
                if (c.type === 'decorator') classDecos.push(c);
            }
            let prefix = '';
            for (const d of classDecos) {
                const { name, path } = _parseTsDecorator(d);
                if (name === 'Controller' && path != null) { prefix = path; break; }
            }
            const body = n.childForFieldName?.('body')
                || n.namedChildren?.find(c => c.type === 'class_body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member.type !== 'method_definition') continue;
                    const handler = member.childForFieldName?.('name')?.text
                        || member.namedChildren?.find(c => c.type === 'property_identifier')?.text;
                    for (const d of _leadingDecorators(member)) {
                        const { name, path } = _parseTsDecorator(d);
                        if (!name || !HTTP_VERBS.has(name.toLowerCase())) continue;
                        emit(name, _joinRoutePath(prefix, path), handler, member.startPosition.row + 1, 'nestjs');
                    }
                }
            }
        }
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}

/** Derive a handler name from an Express argument node: a bare identifier, a member
 *  expression (`ctrl.getThing` → 'getThing', `this.handler` → 'handler'), or a
 *  `.bind()` call (`handler.bind(this)` → 'handler'). Arrow/inline fn → 'anonymous'. */
function _jsHandlerName(node) {
    if (!node) return 'anonymous';
    if (node.type === 'identifier') return node.text;
    if (node.type === 'member_expression') {
        return node.childForFieldName?.('property')?.text || 'anonymous';
    }
    if (node.type === 'call_expression') {
        const callee = node.childForFieldName?.('function');
        if (callee?.type === 'member_expression') {
            const obj = callee.childForFieldName?.('object');
            if (obj?.type === 'identifier') return obj.text;                                   // handler.bind(this) → handler
            if (obj?.type === 'member_expression') return obj.childForFieldName?.('property')?.text || 'anonymous';
            return callee.childForFieldName?.('property')?.text || 'anonymous';
        }
        if (callee?.type === 'identifier') return callee.text;                                 // makeHandler() → makeHandler
    }
    return 'anonymous'; // arrow_function / function / function_expression / unknown
}

/** Express / Koa: `<router|app>.<verb>(<path>, …, <handler>)` call sites. The route
 *  path must be rooted ('/…') or a wildcard ('*') — this matches Express/Koa
 *  convention and rejects look-alike calls (`cache.get('key', cb)`, `map.get(k)`). */
function _extractExpressRoutes(rootNode, emit) {
    const stack = [rootNode];
    while (stack.length) {
        const n = stack.pop();
        if (n.type === 'call_expression') {
            const fn = n.childForFieldName?.('function');
            if (fn?.type === 'member_expression') {
                const verb = fn.childForFieldName?.('property')?.text || '';
                const args = n.childForFieldName?.('arguments');
                if (verb && HTTP_VERBS.has(verb.toLowerCase()) && args) {
                    const named = args.namedChildren || [];
                    const routePath = _routeLiteral(named[0]);
                    if (routePath != null && /^[/*]/.test(routePath) && named.length >= 2) {
                        // The handler is the LAST argument (preceding args are middleware);
                        // it may be an identifier, a member expression, or a .bind() call.
                        const handler = _jsHandlerName(named[named.length - 1]);
                        emit(verb, routePath, handler, n.startPosition.row + 1, 'express');
                    }
                }
            }
        }
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}

/** FastAPI / Flask: @app.get / @router.post / @app.route(path, methods=[…]). */
function _extractPyRoutes(rootNode, emit) {
    const stack = [rootNode];
    while (stack.length) {
        const n = stack.pop();
        if (n.type === 'decorated_definition') {
            const def = n.namedChildren?.find(c => c.type === 'function_definition');
            const handler = def?.childForFieldName?.('name')?.text
                || def?.namedChildren?.find(c => c.type === 'identifier')?.text;
            const line = (def || n).startPosition.row + 1;
            for (const d of n.namedChildren || []) {
                if (d.type !== 'decorator') continue;
                const call = d.namedChildren?.find(c => c.type === 'call');
                const fn = call?.childForFieldName?.('function');
                if (fn?.type !== 'attribute') continue;
                const verb = fn.childForFieldName?.('attribute')?.text || '';
                const args = call.childForFieldName?.('arguments');
                // Positional path string, or the `path=`/`rule=` keyword argument.
                let routePath = _routeLiteral(args?.namedChildren?.find(c => c.type === 'string'));
                if (routePath == null) {
                    const kw = args?.namedChildren?.find(c => c.type === 'keyword_argument'
                        && ['path', 'rule'].includes(c.childForFieldName?.('name')?.text));
                    routePath = _routeLiteral(kw?.childForFieldName?.('value'));
                }
                // A real FastAPI/Flask route always carries a rooted path string — this
                // rejects look-alike decorators (`@cache.get("key")`, `@retry.post(n=3)`).
                const isRoute = routePath != null && routePath.startsWith('/');
                if (HTTP_VERBS.has(verb.toLowerCase())) {
                    if (isRoute) emit(verb, routePath, handler, line, 'fastapi');
                } else if (verb === 'route' && isRoute) {
                    // @app.route(path, methods=["GET","POST"]) — Flask. One route per
                    // method; default GET when methods is omitted.
                    const kw = args?.namedChildren?.find(c => c.type === 'keyword_argument'
                        && c.childForFieldName?.('name')?.text === 'methods');
                    const list = kw?.childForFieldName?.('value');
                    const methods = list
                        ? (list.namedChildren || []).map(_routeLiteral).filter(Boolean)
                        : [];
                    for (const m of (methods.length ? methods : ['GET'])) {
                        emit(m, routePath, handler, line, 'flask');
                    }
                }
            }
        }
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}

/** Spring Boot: @GetMapping/@PostMapping/… and @RequestMapping(value=…, method=…)
 *  on methods, with class-level @RequestMapping as a prefix. */
function _springAnnotation(annNode) {
    // annotation > identifier <name> + annotation_argument_list
    const name = annNode.namedChildren?.find(c => c.type === 'identifier')?.text || '';
    const argList = annNode.namedChildren?.find(c => c.type === 'annotation_argument_list');
    const verbOf = (t) => (t || '').split('.').pop(); // RequestMethod.POST → POST
    let path = null, methods = [];
    if (argList) {
        const positional = argList.namedChildren?.find(c => _routeLiteral(c) != null);
        if (positional) path = _routeLiteral(positional);
        for (const pair of argList.namedChildren || []) {
            if (pair.type !== 'element_value_pair') continue;
            const key = pair.namedChildren?.[0]?.text;
            const valNode = pair.namedChildren?.[1];
            if (key === 'value' || key === 'path') path = _routeLiteral(valNode) ?? path;
            else if (key === 'method') {
                // Single (method = RequestMethod.GET) or array (method = {…, …}).
                methods = (valNode?.type === 'element_value_array_initializer'
                    ? (valNode.namedChildren || []).map(c => verbOf(c.text))
                    : [verbOf(valNode?.text)]).filter(Boolean);
            }
        }
    }
    return { name, path, methods };
}

const SPRING_VERB = {
    GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT',
    DeleteMapping: 'DELETE', PatchMapping: 'PATCH',
};

function _extractSpringRoutes(rootNode, emit) {
    const stack = [rootNode];
    while (stack.length) {
        const n = stack.pop();
        if (n.type === 'class_declaration') {
            const mods = n.namedChildren?.find(c => c.type === 'modifiers');
            let prefix = '';
            for (const a of (mods?.namedChildren || [])) {
                if (a.type !== 'annotation') continue;
                const { name, path } = _springAnnotation(a);
                if (name === 'RequestMapping' && path != null) { prefix = path; break; }
            }
            const body = n.namedChildren?.find(c => c.type === 'class_body');
            for (const member of (body?.namedChildren || [])) {
                if (member.type !== 'method_declaration') continue;
                const handler = member.childForFieldName?.('name')?.text;
                const mMods = member.namedChildren?.find(c => c.type === 'modifiers');
                for (const a of (mMods?.namedChildren || [])) {
                    if (a.type !== 'annotation' && a.type !== 'marker_annotation') continue;
                    const { name, path, methods } = _springAnnotation(a);
                    let verbs;
                    if (SPRING_VERB[name]) verbs = [SPRING_VERB[name]];
                    else if (name === 'RequestMapping') verbs = methods.length ? methods : ['ALL'];
                    else continue;
                    // @RequestMapping(method = {GET, POST}) → one route per verb.
                    for (const verb of verbs) {
                        emit(verb, _joinRoutePath(prefix, path), handler, member.startPosition.row + 1, 'spring');
                    }
                }
            }
        }
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}

/**
 * Map HTTP routes to their handlers for one parsed file.
 *
 * @param {object}  rootNode  parsed AST root
 * @param {string}  relPath   repo-relative file path (stored on each route)
 * @param {object[]} chunks   the file's already-extracted chunks (handler→id lookup)
 * @param {string}  ext       dotted file extension
 * @returns {Array<{method,path,handler_name,handler_chunk_id,file_path,line,framework}>}
 */
export function extractRoutes(rootNode, relPath, chunks, ext) {
    const routes = [];
    if (!rootNode) return routes;

    // handler name → chunk id (case-sensitive, first definition wins).
    const idByName = new Map();
    for (const c of (chunks || [])) {
        if (c && c.name && !idByName.has(c.name)) idByName.set(c.name, c.id);
    }

    const emit = (method, routePath, handlerName, line, framework) => {
        if (!method) return;
        // Normalise to a rooted path so NestJS controller-prefixed paths ('users/:id')
        // are uniform with Spring/Express/FastAPI ('/…') and a '/'-prefix query matches.
        let p = routePath == null ? '' : String(routePath);
        if (p && !p.startsWith('/')) p = '/' + p;
        routes.push({
            method: String(method).toUpperCase(),
            path: p,
            handler_name: handlerName || 'anonymous',
            handler_chunk_id: (handlerName && idByName.has(handlerName)) ? idByName.get(handlerName) : null,
            file_path: relPath,
            line,
            framework,
        });
    };

    try {
        if (ROUTE_JS_LIKE.includes(ext)) {
            _extractNestRoutes(rootNode, emit);    // decorator-based (NestJS/Angular)
            _extractExpressRoutes(rootNode, emit);  // functional (Express/Koa)
        } else if (ext === '.py') {
            _extractPyRoutes(rootNode, emit);
        } else if (ext === '.java') {
            _extractSpringRoutes(rootNode, emit);
        }
    } catch { /* route extraction is best-effort metadata — never fail indexing */ }
    return routes;
}