/**
 * @file parse/imports.mjs
 * @description Import resolution, barrel export expansion, embedding payload
 *              builders, and legacy Ollama embedding helpers.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import path from 'path';
import { getParserForFile, EXTENSIONS } from './languages.mjs';
import { truncateForEmbedding } from '../search-core.mjs';

// ─── Ollama host / model resolution ──────────────────────────────────────────
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
