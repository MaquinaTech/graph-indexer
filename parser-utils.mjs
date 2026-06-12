/**
 * @file parser-utils.mjs
 * @description Shared AST parsing, language registry, and chunk-extraction utilities.
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

export const MAX_FILE_SIZE_BYTES = 500000;

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
    TypeScript, JavaScript, CSS, Python, Rust,
    Go, PHP, Java, Kotlin, CSharp, Ruby
] = await Promise.all([
    _tryLang('tree-sitter-typescript', _enabled, 'typescript'),
    _tryLang('tree-sitter-javascript', _enabled, 'javascript'),
    _tryLang('tree-sitter-css',        _enabled, 'css'),
    _tryLang('tree-sitter-python',     _enabled, 'python'),
    _tryLang('tree-sitter-rust',       _enabled, 'rust'),
    _tryLang('tree-sitter-go',         _enabled, 'go'),
    _tryLang('tree-sitter-php',        _enabled, 'php'),
    _tryLang('tree-sitter-java',       _enabled, 'java'),
    _tryLang('tree-sitter-kotlin',     _enabled, 'kotlin'),
    _tryLang('tree-sitter-c-sharp',    _enabled, 'csharp'),
    _tryLang('tree-sitter-ruby',       _enabled, 'ruby'),
]);

const LANGUAGE_MAP = {
    ...(TypeScript ? { '.ts': TypeScript.typescript, '.tsx': TypeScript.tsx } : {}),
    ...(JavaScript ? { '.js': JavaScript, '.jsx': JavaScript, '.mjs': JavaScript, '.cjs': JavaScript } : {}),
    ...(CSS        ? { '.css': CSS, '.scss': CSS } : {}),
    ...(Python     ? { '.py': Python }  : {}),
    ...(Rust       ? { '.rs': Rust }    : {}),
    ...(Go         ? { '.go': Go }      : {}),
    ...(PHP        ? { '.php': PHP.php } : {}),
    ...(Java       ? { '.java': Java }  : {}),
    ...(Kotlin     ? { '.kt': Kotlin, '.kts': Kotlin } : {}),
    ...(CSharp     ? { '.cs': CSharp }  : {}),
    ...(Ruby       ? { '.rb': Ruby }    : {}),
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

// ─── God-class defence ────────────────────────────────────────────────────────

/**
 * Token-safe skeleton for a class that exceeds GOD_CLASS_LINES.
 *
 * The agent's PROMPT.md promises get_chunk() costs ~300 tokens. A 2 000-line
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
            const hash = generateChunkHash(docstring + snippet);
            const outgoingCalls = extractCalls(chunkNode);

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
                calls: outgoingCalls,
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
                    calls: [], params: [], return_type: '', class_context: '',
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
export function buildEmbeddingPayload(chunk, depRelPaths = []) {
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
        chunk.code_snippet,
    ].filter(Boolean).join('\n');
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
    }
    return Array.from(bases).slice(0, 12);
}

/**
 * Frontier 2: Extract TypeScript/Python type annotation names from a chunk node.
 * Returns simple type names (e.g. ['User', 'AuthToken', 'PaymentService'])
 * used to enrich the inverted index and the type_refs chunk field.
 */
export function extractTypeAnnotations(chunkNode, ext) {
    const types = new Set();
    const JS_LIKE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
    if (!JS_LIKE.includes(ext) && ext !== '.py') return [];

    function walk(node) {
        // TypeScript: type_annotation nodes contain the type text
        if (node.type === 'type_annotation') {
            const typeText = node.text.replace(/^:\s*/, '').trim();
            // Extract simple identifiers from the type (skip primitives)
            const PRIMITIVES = new Set(['string','number','boolean','void','any','unknown','never','null','undefined','object','symbol','bigint']);
            for (const match of typeText.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)) {
                if (!PRIMITIVES.has(match[1].toLowerCase())) types.add(match[1]);
            }
        }
        // TypeScript: generic_type, predefined_type (string, number…) skip, named types keep
        else if (node.type === 'type_identifier' || node.type === 'generic_type') {
            const name = node.children[0]?.text || node.text;
            if (name && /^[A-Z]/.test(name)) types.add(name);
        }
        // Python: type comments or annotations (annotation nodes)
        else if (node.type === 'annotation' && ext === '.py') {
            const typeText = node.text.replace(/^->\s*|^:\s*/, '').trim();
            for (const match of typeText.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)) {
                types.add(match[1]);
            }
        }
        for (const child of node.children) walk(child);
    }
    walk(chunkNode);
    return Array.from(types).slice(0, 20);
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