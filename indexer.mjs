#!/usr/bin/env node
/**
 * In-Memory Graph Indexer — Bootstrap Engine
 * Lee archivos .ts/.tsx → Tree-sitter AST → Local Embeddings → code-index.json
 * Cero dependencias externas (solo Tree-sitter). Sin ChromaDB.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import PHP from 'tree-sitter-php';
import CSS from 'tree-sitter-css';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Configuración ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const repoArg = args[args.indexOf("--repo") + 1] ?? process.cwd();
const PROJECT_ROOT = path.resolve(repoArg);
const INDEX_PATH = path.join(PROJECT_ROOT, 'code-index.json');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.php', '.scss', '.css']);
const LANGUAGE_MAP = {
    '.ts': TypeScript.typescript,
    '.tsx': TypeScript.tsx,
    '.js': JavaScript,
    '.jsx': JavaScript,
    '.php': PHP,
    '.css': CSS,
    '.scss': CSS
};

// Nodos semánticos para Tree-sitter
const SEMANTIC_NODES = new Set([
    // TypeScript / JavaScript
    "function_declaration", "method_definition", "class_declaration",
    "interface_declaration", "type_alias_declaration", "arrow_function",
    "lexical_declaration",

    // PHP
    "function_definition", "method_declaration", "class_declaration",
    "trait_declaration", "interface_declaration",

    // SCSS / CSS
    "rule_set", "declaration" // rule_set captura clases como .btn { ... }
]);

function getParserForFile(ext) {
    const language = LANGUAGE_MAP[ext];
    if (!language) return null;
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
}

// Inicializar Parser
const parser = new Parser();
parser.setLanguage(TypeScript.typescript);

// ─── Utilidades de Extracción AST (Idénticas al Watch-Daemon) ─────────────────

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
        // PHP (require_once, include)
        else if (node.type === 'require_once_expression' || node.type === 'include_expression') {
            const source = node.children.find(c => c.type === 'string');
            if (source) imports.add(source.text.replace(/['"]/g, ''));
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
            const isNested = node.parent && SEMANTIC_NODES.has(node.parent.type) && node.parent.type !== 'export_statement';
            if (!isNested) {
                let name = "anonymous";
                if (node.type === "lexical_declaration") {
                    const decl = node.children.find(c => c.type === "variable_declarator");
                    name = decl?.childForFieldName("name")?.text || name;
                } else {
                    name = node.childForFieldName?.("name")?.text || name;
                }

                // ID Determinista para evitar duplicados en actualizaciones iterativas
                const id = createHash('sha256')
                    .update(`${relPath}::${node.type}::${name}`)
                    .digest('hex').slice(0, 24);

                chunks.push({
                    id,
                    file_path: relPath,
                    node_type: node.type,
                    name,
                    code_snippet: node.text.slice(0, 3000), // Límite por seguridad de contexto
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

// ─── Cliente Local de Ollama ──────────────────────────────────────────────────

async function getLocalEmbedding(text) {
    try {
        const res = await fetch("http://localhost:11434/api/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.embedding;
    } catch (err) {
        return null;
    }
}

// ─── Lógica de Indexación ─────────────────────────────────────────────────────

function walkRepo(dir, files = []) {
    for (const entry of fs.readdirSync(dir)) {
        if (IGNORE_DIRS.has(entry) || entry.startsWith('.')) continue;
        const fullPath = path.join(dir, entry);
        if (fs.statSync(fullPath).isDirectory()) {
            walkRepo(fullPath, files);
        } else if (EXTENSIONS.has(path.extname(fullPath))) {
            files.push(fullPath);
        }
    }
    return files;
}

async function main() {
    console.log(`\n🚀 Iniciando In-Memory Indexer (Bootstrap)\n📂 Directorio: ${PROJECT_ROOT}\n`);

    const files = walkRepo(PROJECT_ROOT);
    console.log(`Encontrados ${files.length} archivos para analizar.\n`);

    const indexData = {
        chunks: [],
        graph: { dependencies: {}, importedBy: {} }
    };

    let processedChunks = 0;

    // 1. Procesamiento Secuencial (AST + Embeddings)
    for (let i = 0; i < files.length; i++) {
        const absolutePath = files[i];
        const relPath = path.relative(PROJECT_ROOT, absolutePath).replace(/\\/g, '/');

        try {
            const content = fs.readFileSync(absolutePath, 'utf-8');
            const ext = path.extname(absolutePath);
            const parser = getParserForFile(ext);

            if (!parser) return; // Ignorar si no hay parser

            const tree = parser.parse(content);
            const imports = extractImportsFromAST(tree.rootNode, ext);
            indexData.graph.dependencies[relPath] = imports;

            // Extraer y procesar chunks
            const chunks = extractSemanticChunks(tree.rootNode, relPath, content);

            for (const chunk of chunks) {
                const embedText = `${chunk.node_type} ${chunk.name}\n${chunk.code_snippet}`;
                const embedding = await getLocalEmbedding(embedText);

                if (embedding) {
                    chunk.embedding = embedding;
                    indexData.chunks.push(chunk);
                    processedChunks++;
                }
            }

            process.stdout.write(`\r✅ Procesando: [${i + 1}/${files.length}] ${relPath} (${chunks.length} chunks)`);
        } catch (err) {
            console.error(`\n❌ Error en ${relPath}: ${err.message}`);
        }
    }

    console.log(`\n\n🧩 Generando topología de dependencias downstream (importedBy)...`);

    // 2. Construir Grafo Inverso (importedBy) en memoria RAM (< 5ms)
    for (const [filePath, imports] of Object.entries(indexData.graph.dependencies)) {
        for (const dep of imports) {
            if (!indexData.graph.importedBy[dep]) {
                indexData.graph.importedBy[dep] = [];
            }
            if (!indexData.graph.importedBy[dep].includes(filePath)) {
                indexData.graph.importedBy[dep].push(filePath);
            }
        }
    }

    // 3. Persistencia Atómica
    const tmpPath = `${INDEX_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(indexData));
    fs.renameSync(tmpPath, INDEX_PATH);

    console.log(`\n🎉 Indexación completada con éxito.`);
    console.log(`💾 Base de datos guardada en: code-index.json`);
    console.log(`📊 Total de fragmentos indexados: ${processedChunks}\n`);
}

main().catch(console.error);