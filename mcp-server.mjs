#!/usr/bin/env node
/**
 * @file mcp-server.mjs
 * @description MCP Server — graph-indexer hybrid search with infinite scalability,
 *              cross-file symbol resolution, and query-driven token pruning.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path, { resolve } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { MemoryGraphIndex } from "./core-engine.mjs";
import { getLocalEmbedding, getParserForFile, extractFileSkeleton } from './parser-utils.mjs';

const PROJECT_ROOT = process.env.MCP_PROJECT_ROOT || process.cwd();
const INDEX_PATH = resolve(PROJECT_ROOT, "code-index.json");
const PID_FILE = resolve(PROJECT_ROOT, ".idx-daemon.pid");

// ─── Daemon Orchestration ─────────────────────────────────────────────────────

function ensureDaemonRunning() {
    if (fs.existsSync(PID_FILE)) {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
        try {
            process.kill(pid, 0);
            process.stderr.write(`✅ Daemon already active (PID: ${pid}).\n`);
            return;
        } catch {
            fs.unlinkSync(PID_FILE);
        }
    }
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const daemonPath = path.join(__dirname, "watch-daemon.mjs");
    const logPath = path.join(PROJECT_ROOT, ".idx-daemon.log");
    process.stderr.write(`🚀 Starting Watcher Daemon...\n   Log: ${logPath}\n`);
    let logFd;
    try { logFd = fs.openSync(logPath, 'a'); } catch { logFd = null; }
    const child = spawn(process.execPath, [daemonPath], {
        detached: true,
        stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
        env: { ...process.env, MCP_PROJECT_ROOT: PROJECT_ROOT }
    });
    child.unref();
    if (logFd !== null) fs.closeSync(logFd);
    fs.writeFileSync(PID_FILE, child.pid.toString());
}

// ─── Frontier 3: Query-Driven Body Pruning ───────────────────────────────────

/**
 * Extracts just the function signature (first N lines up to opening brace).
 */
function extractSignatureLine(codeSnippet) {
    if (!codeSnippet) return '';
    const lines = codeSnippet.split('\n');
    const sigLines = [];
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
        sigLines.push(lines[i]);
        const l = lines[i];
        // Stop at opening brace or arrow that ends the signature
        if (i > 0 && (l.trimEnd().endsWith('{') || l.includes('=>') || l.trimEnd().endsWith(':'))) break;
    }
    return sigLines.join('\n');
}

/**
 * Prune a function body: keep signature + lines containing any query token + return/throw lines.
 * Falls back to first maxLines lines when no match found.
 */
function pruneBodyByQuery(codeSnippet, queryTokens, maxLines = 40) {
    if (!codeSnippet) return '';
    const lines = codeSnippet.split('\n');
    if (lines.length <= maxLines) return codeSnippet;

    const querySet = new Set(queryTokens.filter(t => t.length >= 3).map(t => t.toLowerCase()));
    if (querySet.size === 0) return lines.slice(0, maxLines).join('\n') + '\n// …';

    // Always include: opening lines (signature + brace), closing lines, return/throw
    const SIG_LINES = Math.min(5, lines.length);
    const TAIL_LINES = Math.min(3, lines.length);
    const sigBlock = lines.slice(0, SIG_LINES);
    const tailBlock = lines.slice(Math.max(lines.length - TAIL_LINES, SIG_LINES));

    const bodyLines = lines.slice(SIG_LINES, lines.length - TAIL_LINES);
    const relevant = bodyLines.filter(line => {
        const ll = line.toLowerCase();
        if (/^\s*(return|throw|raise|yield)\b/.test(ll)) return true;
        return [...querySet].some(token => ll.includes(token));
    });

    if (relevant.length === 0) return lines.slice(0, maxLines).join('\n') + '\n// …';
    return [...sigBlock, ...relevant, ...tailBlock].join('\n');
}

// ─── Server Initialization ────────────────────────────────────────────────────

ensureDaemonRunning();
const version = "1.0.3";
const server = new McpServer({ name: "graph-indexer", version });

// Use lazy (disk-backed) vector loading for large corpora — cacheEmbeddings:false
const db = new MemoryGraphIndex(INDEX_PATH, { cacheEmbeddings: false });
try { db.load(); } catch { process.stderr.write("⏳ Waiting for initial indexing…\n"); }

// Graceful shutdown
process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT', () => { db.close(); process.exit(0); });

// ─── Graph Resource ───────────────────────────────────────────────────────────

server.resource(
    "graph-dependencies",
    new ResourceTemplate("graph://dependencies/{file_path}", {
        list: async () => ({
            resources: Object.keys(db.graph.dependencies).map(fp => ({
                uri: `graph://dependencies/${encodeURIComponent(fp)}`,
                name: fp, mimeType: "text/markdown",
                description: `Dependency topology for ${fp}`,
            }))
        })
    }),
    async (uri, { file_path }) => {
        const p = decodeURIComponent(String(file_path));
        const deps = db.graph.dependencies[p] || [];
        const usedBy = db.graph.importedBy[p] || [];
        const md = [
            `# Dependency Topology: \`${p}\``, '',
            `## Imports (${deps.length})`,
            deps.length ? deps.map(d => `- \`${d}\``).join('\n') : '_No local imports_', '',
            `## Imported By (${usedBy.length})`,
            usedBy.length ? usedBy.map(d => `- \`${d}\``).join('\n') : '_No files import this_',
        ].join('\n');
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: md }] };
    }
);

// ─── search_code ──────────────────────────────────────────────────────────────

server.tool(
    "search_code",
    "CRITICAL: ALWAYS USE THIS TOOL FIRST to find code. High-precision AST hybrid search returning exact chunks and cross-file topology.",
    {
        query: z.string().describe("Natural language description of the logic to find."),
        exact_tokens: z.string().optional().describe("Exact symbol name for guaranteed rank-1 placement."),
        include_topology: z.boolean().default(true),
        min_score: z.number().min(0).max(1).default(0.3),
        top_k: z.number().int().min(1).max(20).default(5),
        token_budget: z.number().int().min(100).optional().describe(
            "Token budget for code bodies (1 token ≈ 4 chars). Omit to use smart default."
        ),
        detail: z.enum(['signatures', 'smart', 'full']).default('smart').describe(
            "'signatures': compact cards only (~20 tok each, no bodies) — fastest. " +
            "'smart' (default): signatures + query-relevant body snippets. " +
            "'full': signatures + complete bodies."
        ),
    },
    async ({ query, exact_tokens, include_topology, min_score, top_k, token_budget, detail }) => {
        try {
            const fullQuery = exact_tokens ? `${query} ${exact_tokens}` : query;
            let queryVector = null;
            try { queryVector = await getLocalEmbedding(fullQuery); } catch { /* lexical fallback */ }

            const matches = db.searchHybrid(fullQuery, queryVector, top_k, min_score, exact_tokens || null);
            if (matches.length === 0) return { content: [{ type: "text", text: "No results found." }] };

            const depSignature = (depPath) => {
                const syms = [];
                for (const c of db.chunks.values()) {
                    if (c.file_path === depPath && c.name && c.node_type !== 'expression_statement') {
                        syms.push(c.name);
                        if (syms.length >= 4) break;
                    }
                }
                return syms.length ? `${depPath} [${syms.join(', ')}]` : depPath;
            };

            const lines = [`🔍 QUERY: "${fullQuery}" — ${matches.length} result(s)\n`];

            // Phase 1: Signature cards (always emitted)
            for (let i = 0; i < matches.length; i++) {
                const { score, chunk } = matches[i];
                lines.push(`${'─'.repeat(50)}`);
                lines.push(`#${i + 1} · **${chunk.name}** [${chunk.node_type}]`);
                lines.push(`📄 ${chunk.file_path}:${chunk.start_line}–${chunk.end_line} · ID: \`${chunk.id}\` · RRF: ${score.toFixed(4)}`);

                // Frontier 3: show return type and key params in card
                const sig = [];
                if (chunk.params?.length) sig.push(`(${chunk.params.slice(0, 4).join(', ')})`);
                if (chunk.return_type) sig.push(`→ ${chunk.return_type}`);
                if (chunk.type_refs?.length) sig.push(`types: ${chunk.type_refs.slice(0, 4).join(', ')}`);
                if (sig.length) lines.push(`🔤 ${sig.join('  ')}`);

                if (chunk.docstring) lines.push(`💬 ${chunk.docstring.slice(0, 140).replace(/\n/g, ' ')}`);

                if (include_topology) {
                    const deps = (db.graph.dependencies[chunk.file_path] || []).slice(0, 3);
                    const usedBy = (db.graph.importedBy[chunk.file_path] || []).slice(0, 3);
                    if (deps.length) lines.push(`⬇️  Deps:    ${deps.map(depSignature).join(' | ')}`);
                    if (usedBy.length) lines.push(`⬆️  Used by: ${usedBy.join(', ')}`);
                    if (chunk.calls?.length) lines.push(`🔗 Calls:   ${chunk.calls.slice(0, 6).join(', ')}`);
                }
                lines.push(`↩️  Expand: get_chunk("${chunk.id}")`);
            }

            // Phase 2: Code bodies — controlled by `detail`
            if (detail !== 'signatures') {
                const CHARS_PER_TOKEN = 4;
                const defaultBudget = detail === 'full' ? 6000 : 2000;
                let remainingChars = token_budget != null ? token_budget * CHARS_PER_TOKEN : defaultBudget;

                lines.push(`\n${'═'.repeat(50)}`);
                lines.push(`CODE BODIES (detail: ${detail}, budget: ~${Math.round(remainingChars / CHARS_PER_TOKEN)} tok)\n`);

                const queryTokens = fullQuery.toLowerCase().split(/[\s\W_]+/).filter(t => t.length >= 3);

                for (const { chunk } of matches) {
                    if (remainingChars <= 0) break;
                    const raw = chunk.code_snippet || '';
                    if (!raw) continue;

                    let snippet;
                    if (detail === 'full') {
                        snippet = raw.slice(0, remainingChars);
                    } else {
                        // 'smart': query-driven pruning for long functions
                        snippet = pruneBodyByQuery(raw, queryTokens).slice(0, remainingChars);
                    }

                    lines.push(`### ${chunk.name} — ${chunk.file_path}`);
                    lines.push('```\n' + snippet + '\n```\n');
                    remainingChars -= snippet.length;
                }
            }

            return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
);

// ─── get_chunk ────────────────────────────────────────────────────────────────

server.tool(
    "get_chunk",
    "CRITICAL: Use this INSTEAD of reading full files. Returns the complete body of a function/class by its chunk_id from search_code results.",
    {
        chunk_id: z.string().describe("The chunk ID shown in search_code results."),
        view: z.enum(['full', 'signature']).default('full').describe(
            "'full': complete source body. 'signature': just the function signature line (~5 tokens)."
        ),
    },
    async ({ chunk_id, view }) => {
        try {
            const chunk = db.chunks.get(chunk_id);
            if (!chunk) return { content: [{ type: "text", text: `Chunk '${chunk_id}' not found. Run search_code to get valid IDs.` }] };

            const parts = [
                `# ${chunk.name}`,
                `**File:** \`${chunk.file_path}\` · **Lines:** ${chunk.start_line}–${chunk.end_line} · **Type:** ${chunk.node_type}`,
            ];
            if (chunk.params?.length) parts.push(`**Params:** ${chunk.params.join(', ')}`);
            if (chunk.return_type) parts.push(`**Returns:** ${chunk.return_type}`);
            if (chunk.type_refs?.length) parts.push(`**Type refs:** ${chunk.type_refs.join(', ')}`);
            if (chunk.docstring) parts.push(`**Doc:** ${chunk.docstring}`);

            const deps = db.graph.dependencies[chunk.file_path] || [];
            const usedBy = db.graph.importedBy[chunk.file_path] || [];
            if (deps.length) parts.push(`⬇️ Imports: ${deps.join(', ')}`);
            if (usedBy.length) parts.push(`⬆️ Used by: ${usedBy.join(', ')}`);
            if (chunk.calls?.length) parts.push(`🔗 Calls: ${chunk.calls.join(', ')}`);

            if (view === 'signature') {
                parts.push('', '```', extractSignatureLine(chunk.code_snippet), '```');
            } else {
                parts.push('', '```', chunk.code_snippet, '```');
            }
            return { content: [{ type: "text", text: parts.join('\n') }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
);

// ─── resolve_symbol (Frontier 2) ─────────────────────────────────────────────

server.tool(
    "resolve_symbol",
    "Frontier 2: Instantly finds the definition of any symbol (function, class, type, variable) by exact name — O(1) lookup, no search needed. Returns the defining chunk and cross-file topology.",
    {
        symbol: z.string().describe("Exact symbol name (e.g. 'validateToken', 'User', 'PaymentService')."),
    },
    async ({ symbol }) => {
        try {
            const key = symbol.toLowerCase().trim();
            const chunkIds = db.symbolTable.get(key);

            if (!chunkIds || chunkIds.size === 0) {
                return { content: [{ type: "text", text: `Symbol '${symbol}' not in index. Try search_code(query="${symbol}") for fuzzy search.` }] };
            }

            const lines = [`# Symbol: \`${symbol}\` — ${chunkIds.size} definition(s)\n`];
            for (const chunkId of chunkIds) {
                const chunk = db.chunks.get(chunkId);
                if (!chunk) continue;
                lines.push(`${'─'.repeat(50)}`);
                lines.push(`**${chunk.name}** [${chunk.node_type}]`);
                lines.push(`📄 ${chunk.file_path}:${chunk.start_line}–${chunk.end_line} · ID: \`${chunk.id}\``);
                if (chunk.params?.length) lines.push(`🔤 Params: ${chunk.params.join(', ')}`);
                if (chunk.return_type) lines.push(`🔤 Returns: ${chunk.return_type}`);
                if (chunk.type_refs?.length) lines.push(`🔗 Type refs: ${chunk.type_refs.join(', ')}`);
                if (chunk.docstring) lines.push(`💬 ${chunk.docstring.slice(0, 160).replace(/\n/g, ' ')}`);
                const deps = (db.graph.dependencies[chunk.file_path] || []).slice(0, 4);
                const usedBy = (db.graph.importedBy[chunk.file_path] || []).slice(0, 4);
                if (deps.length) lines.push(`⬇️  Imports: ${deps.join(', ')}`);
                if (usedBy.length) lines.push(`⬆️  Used by: ${usedBy.join(', ')}`);
                if (chunk.calls?.length) lines.push(`🔗 Calls: ${chunk.calls.slice(0, 8).join(', ')}`);
                lines.push(`\n\`\`\`\n${extractSignatureLine(chunk.code_snippet)}\n\`\`\``);
                lines.push(`↩️  Full body: get_chunk("${chunk.id}")`);
            }
            return { content: [{ type: "text", text: lines.join('\n') }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
);

// ─── get_chunk_summary (Frontier 3) ──────────────────────────────────────────

server.tool(
    "get_chunk_summary",
    "Returns the function/class signature + docstring + called functions — no full body. ~50 tokens vs ~300 for full body. Use when you only need to understand the interface, not the implementation.",
    {
        chunk_id: z.string().describe("The chunk ID from search_code results."),
    },
    async ({ chunk_id }) => {
        try {
            const chunk = db.chunks.get(chunk_id);
            if (!chunk) return { content: [{ type: "text", text: `Chunk '${chunk_id}' not found.` }] };

            const lines = [
                `# ${chunk.name} · ${chunk.file_path}:${chunk.start_line}–${chunk.end_line}`,
                `**Type:** ${chunk.node_type}`,
            ];
            if (chunk.params?.length) lines.push(`**Params:** ${chunk.params.join(', ')}`);
            if (chunk.return_type) lines.push(`**Returns:** ${chunk.return_type}`);
            if (chunk.type_refs?.length) lines.push(`**Type refs:** ${chunk.type_refs.join(', ')}`);
            if (chunk.docstring) lines.push(`\n**Doc:** ${chunk.docstring.slice(0, 300)}`);
            if (chunk.calls?.length) lines.push(`**Calls:** ${chunk.calls.join(', ')}`);
            lines.push('', '```', extractSignatureLine(chunk.code_snippet), '```');
            lines.push(`\n↩️  Full body: get_chunk("${chunk.id}")`);

            return { content: [{ type: "text", text: lines.join('\n') }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
);

// ─── get_file_skeleton ────────────────────────────────────────────────────────

server.tool(
    "get_file_skeleton",
    "Returns all top-level exports and definitions in a file with line numbers — no code bodies (~50 tokens vs 5000).",
    { file_path: z.string().describe("Relative path (e.g. 'src/app.ts').") },
    async ({ file_path }) => {
        try {
            const absolutePath = resolve(PROJECT_ROOT, file_path);
            const safeRoot = path.normalize(PROJECT_ROOT);
            if (!path.normalize(absolutePath).startsWith(safeRoot + path.sep) &&
                path.normalize(absolutePath) !== safeRoot) {
                throw new Error("Access denied: path is outside the project root.");
            }
            if (!fs.existsSync(absolutePath)) throw new Error("File not found.");
            const content = fs.readFileSync(absolutePath, 'utf-8');
            const ext = path.extname(absolutePath);
            const parser = getParserForFile(ext);
            if (!parser) return { content: [{ type: "text", text: "Language not supported." }] };
            const tree = parser.parse((offset) => offset < content.length ? content.slice(offset, offset + 4096) : null);
            const skeleton = extractFileSkeleton(tree.rootNode, content);
            return { content: [{ type: "text", text: `# Skeleton: ${file_path}\n\n${skeleton || "_No semantic signatures found_"}` }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
);

// ─── get_call_graph ───────────────────────────────────────────────────────────

server.tool(
    "get_call_graph",
    "Finds all chunks that call a specific function. CRITICAL for safe refactoring.",
    { target_function: z.string().describe("Exact function name (e.g. 'validateToken').") },
    async ({ target_function }) => {
        try {
            const callers = [];
            for (const chunk of db.chunks.values()) {
                if (chunk.calls?.includes(target_function)) {
                    callers.push(`- [${chunk.node_type}] \`${chunk.name}\` in \`${chunk.file_path}\` (lines ${chunk.start_line}–${chunk.end_line})`);
                }
            }
            if (callers.length === 0) {
                return { content: [{ type: "text", text: `✅ Safe to modify: no callers of '${target_function}' found.` }] };
            }
            return {
                content: [{
                    type: "text", text: [
                        `# ⚠️ Call Graph: \`${target_function}\``,
                        `${callers.length} caller(s) depend on this — review before changing signature:`,
                        ...callers
                    ].join('\n')
                }]
            };
        } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
);

// ─── get_repo_map ─────────────────────────────────────────────────────────────

/**
 * Compute simplified PageRank over the file dependency graph.
 * Files imported by many others receive higher rank (= more important).
 */
function computePageRank(graph, iters = 30, damping = 0.85) {
    const files = Object.keys(graph.dependencies || {});
    const N = files.length;
    if (N === 0) return new Map();

    const idx = new Map(files.map((f, i) => [f, i]));
    const ranks = new Float64Array(N).fill(1.0 / N);
    const outDeg = files.map(f => Math.max((graph.dependencies[f] || []).length, 1));

    for (let iter = 0; iter < iters; iter++) {
        const next = new Float64Array(N).fill((1 - damping) / N);
        for (let i = 0; i < N; i++) {
            const contrib = damping * ranks[i] / outDeg[i];
            for (const dep of (graph.dependencies[files[i]] || [])) {
                const j = idx.get(dep);
                if (j !== undefined) next[j] += contrib;
            }
        }
        ranks.set(next);
    }
    return new Map(files.map((f, i) => [f, ranks[i]]));
}

server.tool(
    "get_repo_map",
    "Returns a compact symbol map of the entire codebase grouped by file, ordered by importance (most-imported files first via PageRank). Use this FIRST to orient yourself in an unfamiliar codebase — ~1-2k tokens vs reading every file. Combine with path_filter to focus on a subsystem.",
    {
        path_filter: z.string().optional().describe(
            "Only include files whose path contains this string (e.g. 'auth', 'api/v2', 'src/core')."
        ),
        max_files: z.number().int().min(1).max(300).default(80).describe(
            "Max files to include in the map."
        ),
        sort_by: z.enum(['importance', 'path']).default('importance').describe(
            "'importance' (default): most-imported files first (PageRank). 'path': alphabetical."
        ),
    },
    async ({ path_filter, max_files, sort_by }) => {
        try {
            // Group chunks by file
            const fileChunks = new Map();
            for (const chunk of db.chunks.values()) {
                if (path_filter && !chunk.file_path.toLowerCase().includes(path_filter.toLowerCase())) continue;
                if (chunk.name === 'anonymous' || chunk.name === 'default_export') continue;
                if (!fileChunks.has(chunk.file_path)) fileChunks.set(chunk.file_path, []);
                fileChunks.get(chunk.file_path).push(chunk);
            }

            if (fileChunks.size === 0) {
                return {
                    content: [{
                        type: 'text', text: path_filter
                            ? `No files found matching '${path_filter}'. Try a broader filter.`
                            : 'Index is empty. Run `npm run mcp:index` first.'
                    }]
                };
            }

            // Sort files
            let sortedFiles = Array.from(fileChunks.keys());
            if (sort_by === 'importance') {
                const pr = computePageRank(db.graph);
                sortedFiles.sort((a, b) => (pr.get(b) ?? 0) - (pr.get(a) ?? 0));
            } else {
                sortedFiles.sort();
            }
            sortedFiles = sortedFiles.slice(0, max_files);

            // Render compact map
            const totalFiles = fileChunks.size;
            const totalSymbols = Array.from(fileChunks.values()).reduce((s, a) => s + a.length, 0);
            const lines = [
                `# Repo Map — ${totalSymbols} symbols across ${totalFiles} files`,
                path_filter ? `(filtered to '${path_filter}')` : '',
                sortedFiles.length < totalFiles
                    ? `(showing top ${sortedFiles.length} by ${sort_by}; use path_filter to narrow)\n`
                    : '',
            ].filter(Boolean);

            for (const filePath of sortedFiles) {
                const chunks = fileChunks.get(filePath);
                lines.push(`\n${filePath}`);
                // Deduplicate by name (prefer class/function over expression_statement)
                const seen = new Set();
                const deduped = [];
                for (const c of chunks) {
                    const key = c.name.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    deduped.push(c);
                }
                for (const c of deduped.slice(0, 8)) {
                    const kind = c.node_type.includes('class') ? 'class'
                        : c.node_type.includes('interface') ? 'interface'
                            : c.node_type.includes('enum') ? 'enum'
                                : c.node_type.includes('struct') ? 'struct'
                                    : c.node_type.includes('trait') ? 'trait'
                                        : 'fn';
                    const params = c.params?.length
                        ? `(${c.params.slice(0, 3).join(', ')}${c.params.length > 3 ? ', …' : ''})`
                        : '';
                    const ret = c.return_type ? ` → ${c.return_type.slice(0, 40)}` : '';
                    lines.push(`  ${kind} ${c.name}${params}${ret}`);
                }
                if (deduped.length > 8) lines.push(`  … (${deduped.length - 8} more)`);
            }
            if (totalFiles > max_files) {
                lines.push(`\n… ${totalFiles - max_files} more files not shown. Use path_filter or increase max_files.`);
            }

            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
    }
);

// ─── list_index_stats ─────────────────────────────────────────────────────────

server.tool(
    "list_index_stats",
    "Returns index health: chunk count, embedding status, daemon status, search mode, and index freshness.",
    {},
    async () => {
        try {
            const chunkCount = db.chunks.size;
            const fileSet = new Set([...db.chunks.values()].map(c => c.file_path));
            const hasVectors = db.vectors.size > 0 || db._vecOffsets.size > 0;
            const embeddingsEnabled = process.env.INDEXER_EMBEDDINGS !== 'off';

            let indexAge = 'unknown';
            try {
                const ageMs = Date.now() - fs.statSync(INDEX_PATH).mtimeMs;
                const ageSec = Math.floor(ageMs / 1000);
                indexAge = ageSec < 60 ? `${ageSec}s ago` : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m ago` : `${Math.floor(ageSec / 3600)}h ago`;
            } catch { }

            let daemonStatus = 'unknown';
            try {
                if (fs.existsSync(PID_FILE)) {
                    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
                    process.kill(pid, 0);
                    daemonStatus = `running (PID: ${pid})`;
                } else { daemonStatus = 'not running'; }
            } catch { daemonStatus = 'not running (stale PID)'; }

            const extCounts = new Map();
            for (const chunk of db.chunks.values()) {
                const ext = chunk.file_path.split('.').pop() || 'unknown';
                extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
            }

            const lazyModeActive = db._lazyMode;
            const vectorSource = lazyModeActive
                ? (db._vecFd >= 0 ? 'disk-backed fd' : 'buffer-lazy')
                : 'eager (in-memory matrix)';
            const searchMode = !embeddingsEnabled
                ? '🔤 Lexical only (INDEXER_EMBEDDINGS=off)'
                : hasVectors
                    ? `🧠 Hybrid (semantic + lexical RRF) — vectors: ${vectorSource}`
                    : '🔤 Lexical only (Ollama unavailable or not yet indexed)';

            const lines = [
                `# 📊 graph-indexer Index Stats`, '',
                `| Metric | Value |`, `| :--- | :--- |`,
                `| **Chunks** | ${chunkCount} |`,
                `| **Files indexed** | ${fileSet.size} |`,
                `| **Symbols in table** | ${db.symbolTable.size} |`,
                `| **Vector entries** | ${lazyModeActive ? db._vecOffsets.size : db.vectors.size} |`,
                `| **Search mode** | ${searchMode} |`,
                `| **Lazy vec mode** | ${lazyModeActive ? '✅ Yes (enterprise scale)' : '❌ No (small corpus)'} |`,
                `| **Daemon** | ${daemonStatus} |`,
                `| **Index age** | ${indexAge} |`,
                '', `## Extension Breakdown`,
                ...Array.from(extCounts.entries()).sort((a, b) => b[1] - a[1]).map(([e, n]) => `- .${e}: ${n} chunks`),
            ];
            if (chunkCount === 0) lines.push('', `⚠️ Index empty. Run \`npm run mcp:index\`.`);
            return { content: [{ type: "text", text: lines.join('\n') }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
);

// ─── Connect ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`✅ graph-indexer MCP server running (v${version}).\n`);
