/**
 * @file parse/extractor.mjs
 * @description File-level AST extraction: ignore filter, chunk hashing,
 *              file skeleton, import extraction, and semantic chunking.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import ignore from 'ignore';
import Parser from 'tree-sitter';
const { Query } = Parser;

import { getParserForFile, LANGUAGE_MAP, EXTENSIONS } from './languages.mjs';
import {
    extractParams, extractReturnType, extractClassContext,
    extractDecorators, extractHeritage, extractTypeAnnotations, extractCallSites,
} from './metadata.mjs';

export const MAX_FILE_SIZE_BYTES = 500000;

// Detect whether a dedicated SCSS grammar is installed (distinct from the CSS grammar).
// Used to select the correct LANGUAGE_QUERIES key for .scss files.
const _hasSCSS = Boolean(LANGUAGE_MAP['.scss']) && LANGUAGE_MAP['.scss'] !== LANGUAGE_MAP['.css'];

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
        '.scss': _hasSCSS ? 'scss' : 'css',
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
