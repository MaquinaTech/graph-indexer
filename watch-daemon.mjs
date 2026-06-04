#!/usr/bin/env node
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

// Configuración de Tree-sitter
const parser = new Parser();
parser.setLanguage(TypeScript.typescript);

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

// Nodos AST con valor semántico para fragmentación
const SEMANTIC_NODES = new Set([
    // TypeScript / JavaScript
    "function_declaration", "method_definition", "class_declaration",
    "interface_declaration", "type_alias_declaration", "arrow_function",
    "lexical_declaration",

    // SCSS / CSS
    "rule_set", "declaration" // rule_set captura clases como .btn { ... }
]);

// ─── Utilidades del AST ───────────────────────────────────────────────────────

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
            // Evitar duplicación de funciones anidadas dentro de clases o exportaciones
            const isNested = node.parent && SEMANTIC_NODES.has(node.parent.type) && node.parent.type !== 'export_statement';

            if (!isNested) {
                let name = "anonymous";
                if (node.type === "lexical_declaration") {
                    const decl = node.children.find(c => c.type === "variable_declarator");
                    name = decl?.childForFieldName("name")?.text || name;
                } else {
                    name = node.childForFieldName?.("name")?.text || name;
                }

                // ID Determinista basado en Semántica
                const id = createHash('sha256')
                    .update(`${relPath}::${node.type}::${name}`)
                    .digest('hex').slice(0, 24);

                chunks.push({
                    id,
                    file_path: relPath,
                    node_type: node.type,
                    name: name,
                    code_snippet: node.text.slice(0, 3000), // Límite de seguridad
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

// ─── Motor Local de Embedding ─────────────────────────────────────────────────

async function getLocalEmbedding(text) {
    try {
        const res = await fetch("http://localhost:11434/api/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`Ollama Falló: ${res.status}`);
        const data = await res.json();
        return data.embedding;
    } catch (err) {
        process.stderr.write(`[embedding-error] ${err.message}\n`);
        return null;
    }
}

// ─── Lógica del Demonio (Watcher) ─────────────────────────────────────────────

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

            db.updateFileGraph(filename, []); // Eliminar dependencias
            db.save();
            process.stderr.write(`[daemon] 🗑️  Purgado: ${filename}\n`);
            return;
        }

        const content = fs.readFileSync(absolutePath, 'utf-8');
        const ext = path.extname(absolutePath);
        const parser = getParserForFile(ext);

        if (!parser) return; // Ignorar si no hay parser

        const tree = parser.parse(content);
        const imports = extractImportsFromAST(tree.rootNode, ext);
        db.updateFileGraph(filename, imports);

        // 2. Extraer Chunks Semánticos
        const newChunks = extractSemanticChunks(tree.rootNode, filename, content);

        // 3. Eliminar chunks antiguos de este archivo en la DB en memoria
        for (const [id, chunk] of db.chunks.entries()) {
            if (chunk.file_path === filename) {
                db.chunks.delete(id);
                db.vectors.delete(id);
            }
        }

        // 4. Generar vectores e insertar nuevos chunks
        for (const chunk of newChunks) {
            const embedText = `${chunk.node_type} ${chunk.name}\n${chunk.code_snippet}`;
            const vector = await getLocalEmbedding(embedText);

            if (vector) {
                chunk.embedding = vector;
                db.vectors.set(chunk.id, new Float32Array(vector));
            }
            db.chunks.set(chunk.id, chunk);
        }

        db.save(); // Persistir en disco de forma atómica
        process.stderr.write(`[daemon] 🔄 Sincronizado: ${filename} (${newChunks.length} chunks)\n`);

    } catch (err) {
        process.stderr.write(`[daemon] ❌ Error en ${filename}: ${err.message}\n`);
    }
}

// ─── Inicialización del FileSystem Watcher Nativo ──────────────────────────────

process.stderr.write(`🚀 Native In-Memory Indexer Daemon iniciado en: ${PROJECT_ROOT}\n`);

const watcher = fs.watch(PROJECT_ROOT, { recursive: true });

watcher.on('change', (eventType, filename) => {
    if (!filename) return;

    // Ignorar directorios de compilación, módulos y ocultos
    if (
        filename.includes('node_modules') ||
        filename.includes('.git') ||
        filename.includes('dist') ||
        filename.endsWith('.json') || // Prevenir loop infinito al guardar el index
        filename.startsWith('.')
    ) return;

    const ext = path.extname(filename);
    if (!['.ts', '.tsx', '.js', '.jsx', '.scss', '.css'].includes(ext)) return;

    const fullPath = path.join(PROJECT_ROOT, filename);
    const now = Date.now();

    // Debounce nativo para evitar procesar ráfagas de guardado del IDE
    if (changeRegistry.has(fullPath) && (now - changeRegistry.get(fullPath) < DEBOUNCE_MS)) return;
    changeRegistry.set(fullPath, now);

    setTimeout(() => {
        processFileChange(filename, fullPath);
    }, 50); // Pequeño retraso para liberar bloqueos I/O del SO
});

watcher.on('error', (err) => {
    process.stderr.write(`[daemon] 💥 OS Watcher panic: ${err.message}\n`);
});