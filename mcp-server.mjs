#!/usr/bin/env node
/**
 * @file mcp-server.mjs
 * @description MCP Server to expose in-memory graph index with hybrid search capabilities. Connects to local Ollama instance for embedding generation. Zero external dependencies.
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
    // 1. Check if a daemon is already running to avoid duplicate processes
    if (fs.existsSync(PID_FILE)) {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
        try {
            process.kill(pid, 0); // Esto no mata el proceso, solo comprueba si existe
            process.stderr.write(`✅ Daemon is already active in background (PID: ${pid}).\n`);
            return;
        } catch (e) {
            // The process does not exist (crashed or exited improperly), clean up the stale pid file
            fs.unlinkSync(PID_FILE);
        }
    }

    // 2. Spawn the Daemon in detached mode
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const daemonPath = path.join(__dirname, "watch-daemon.mjs");

    const logPath = path.join(PROJECT_ROOT, ".idx-daemon.log");
    process.stderr.write(`🚀 Starting the Watcher Daemon in background...\n`);
    process.stderr.write(`   Daemon log: ${logPath}\n`);

    // Open a log file in append mode so daemon crashes are always visible
    let logFd;
    try { logFd = fs.openSync(logPath, 'a'); } catch { logFd = null; }
    const stdioOpt = logFd !== null ? ['ignore', logFd, logFd] : 'ignore';

    const child = spawn(process.execPath, [daemonPath], {
        detached: true,
        stdio: stdioOpt,
        env: { ...process.env, MCP_PROJECT_ROOT: PROJECT_ROOT }
    });

    // 3. Unlink the child process so parent doesn't wait on its IO
    child.unref();
    if (logFd !== null) fs.closeSync(logFd);

    // Save the PID for future checks
    fs.writeFileSync(PID_FILE, child.pid.toString());
}

// ─── Inicialización del Servidor ──────────────────────────────────────────────

// Wake the watcher before loading the index
ensureDaemonRunning();

const server = new McpServer({ name: "graph-indexer", version: "1.0.0" });
const db = new MemoryGraphIndex(INDEX_PATH);

// If the index doesn't exist (first run), the newly started daemon will create it
// Perform a safe load
try { db.load(); } catch (e) { process.stderr.write("⏳ Waiting for initial indexing...\n"); }

// ─── Graph Topology Resource ──────────────────────────────────────────────────
// Exposes the bidirectional dependency graph via the graph:// URI scheme.
// Agents can inspect the topology of any indexed file without running a search.

server.resource(
    "graph-dependencies",
    new ResourceTemplate("graph://dependencies/{file_path}", {
        list: async () => ({
            resources: Object.keys(db.graph.dependencies).map(fp => ({
                uri: `graph://dependencies/${encodeURIComponent(fp)}`,
                name: fp,
                mimeType: "text/markdown",
                description: `Dependency topology for ${fp}`,
            }))
        })
    }),
    async (uri, { file_path }) => {
        const decodedPath = decodeURIComponent(String(file_path));
        const dependencies = db.graph.dependencies[decodedPath] || [];
        const importedBy = db.graph.importedBy[decodedPath] || [];

        const md = [
            `# Dependency Topology: \`${decodedPath}\``,
            ``,
            `## Imports (${dependencies.length})`,
            dependencies.length
                ? dependencies.map(d => `- \`${d}\``).join('\n')
                : '_No local imports_',
            ``,
            `## Imported By (${importedBy.length})`,
            importedBy.length
                ? importedBy.map(d => `- \`${d}\``).join('\n')
                : '_No files import this_',
        ].join('\n');

        return {
            contents: [{ uri: uri.href, mimeType: "text/markdown", text: md }]
        };
    }
);

server.tool(
    "search_code",
    "CRITICAL: ALWAYS USE THIS TOOL FIRST to find code. DO NOT use native file search or grep. High-precision AST search returning exact chunks and topology. Use natural language query.",
    {
        query: z.string().describe("What logic to search for. Example: 'JWT authentication in middleware'"),
        exact_tokens: z.string().optional().describe("Exact variable or function name to boost in results"),
        include_topology: z.boolean().default(true),
        min_score: z.number().min(0).max(1).default(0.3).describe("Minimum cosine similarity threshold (0–1)."),
        top_k: z.number().int().min(1).max(20).default(5).describe("Number of results to return (1–20)."),
        token_budget: z.number().int().min(100).optional().describe(
            "Optional estimated token budget for code snippets (1 token ≈ 4 chars). All signature cards are always shown; snippets fill the remaining budget in rank order."
        ),
    },
    async ({ query, exact_tokens, include_topology, min_score, top_k, token_budget }) => {
        try {
            const fullQueryText = exact_tokens ? `${query} ${exact_tokens}` : query;
            let queryVector = null;
            try { queryVector = await getLocalEmbedding(fullQueryText); } catch { /* degrade to lexical */ }

            const matches = db.searchHybrid(fullQueryText, queryVector, top_k, min_score, exact_tokens || null);
            if (matches.length === 0) return { content: [{ type: "text", text: "No results found." }] };

            // Helper: build a compact dep signature string for a file path
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

            const lines = [`🔍 QUERY: "${fullQueryText}" — ${matches.length} result(s)\n`];

            // ── Phase 1: Signature cards (always emitted, ~40 tokens each) ────────────────
            for (let i = 0; i < matches.length; i++) {
                const { score, chunk } = matches[i];
                lines.push(`${'─'.repeat(50)}`);
                lines.push(`#${i + 1} · **${chunk.name}** [${chunk.node_type}]`);
                lines.push(`📄 ${chunk.file_path}:${chunk.start_line}–${chunk.end_line} · ID: \`${chunk.id}\` · RRF: ${score.toFixed(4)}`);
                if (chunk.docstring) lines.push(`💬 ${chunk.docstring.slice(0, 120).replace(/\n/g, ' ')}`);

                if (include_topology) {
                    const deps = (db.graph.dependencies[chunk.file_path] || []).slice(0, 3);
                    const usedBy = (db.graph.importedBy[chunk.file_path] || []).slice(0, 3);
                    if (deps.length) lines.push(`⬇️  Deps:    ${deps.map(depSignature).join(' | ')}`);
                    if (usedBy.length) lines.push(`⬆️  Used by: ${usedBy.join(', ')}`);
                    if (chunk.calls?.length) lines.push(`🔗 Calls:   ${chunk.calls.slice(0, 6).join(', ')}`);
                }
                lines.push(`↩️  Expand body: get_chunk("${chunk.id}")`);
            }

            // ── Phase 2: Code snippets — fill token budget in rank order ──────────────
            const CHARS_PER_TOKEN = 4;
            const MAX_SNIPPET_CHARS = token_budget != null ? 0 : 1500; // default: show rank-1 snippet
            let remainingChars = token_budget != null ? token_budget * CHARS_PER_TOKEN : MAX_SNIPPET_CHARS;

            lines.push(`\n${'═'.repeat(50)}`);
            lines.push(`CODE BODIES (budget: ${token_budget != null ? token_budget + ' tok' : '1500 chars rank-1'})\n`);

            for (const { chunk } of matches) {
                if (remainingChars <= 0) break;
                const snippet = (chunk.code_snippet || '').slice(0, remainingChars);
                if (!snippet) continue;
                lines.push(`### ${chunk.name} — ${chunk.file_path}`);
                lines.push('```\n' + snippet + '\n```\n');
                remainingChars -= snippet.length;
            }

            return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
);

server.tool(
    "get_chunk",
    "CRITICAL: Use this INSTEAD of reading full files to get the body of a function or class. Requires the chunk_id returned by search_code.",
    { chunk_id: z.string().describe("The chunk ID shown in search_code results (e.g. \"abc123def456\").") },
    async ({ chunk_id }) => {
        try {
            const chunk = db.chunks.get(chunk_id);
            if (!chunk) return { content: [{ type: "text", text: `Chunk '${chunk_id}' not found. Run search_code to get valid IDs.` }] };
            const parts = [
                `# ${chunk.name}`,
                `**File:** \`${chunk.file_path}\` · **Lines:** ${chunk.start_line}–${chunk.end_line} · **Type:** ${chunk.node_type}`,
            ];
            if (chunk.docstring) parts.push(`**Doc:** ${chunk.docstring}`);
            const deps = db.graph.dependencies[chunk.file_path] || [];
            const usedBy = db.graph.importedBy[chunk.file_path] || [];
            if (deps.length) parts.push(`⬇️ Imports: ${deps.join(', ')}`);
            if (usedBy.length) parts.push(`⬆️ Used by: ${usedBy.join(', ')}`);
            if (chunk.calls?.length) parts.push(`🔗 Calls: ${chunk.calls.join(', ')}`);
            parts.push('', '```', chunk.code_snippet, '```');
            return { content: [{ type: "text", text: parts.join('\n') }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
);

server.tool(
    "get_file_skeleton",
    "Returns ONLY the function and class signatures of a file. Use this to quickly understand a file's structure without consuming thousands of tokens reading the full code.",
    { file_path: z.string().describe("Relative path to the file (e.g., 'src/app.ts')") },
    async ({ file_path }) => {
        try {
            const absolutePath = resolve(PROJECT_ROOT, file_path);
            // Guard against path traversal attacks
            const safeRoot = path.normalize(PROJECT_ROOT);
            if (!path.normalize(absolutePath).startsWith(safeRoot + path.sep) &&
                path.normalize(absolutePath) !== safeRoot) {
                throw new Error("Access denied: path is outside the project root.");
            }
            if (!fs.existsSync(absolutePath)) throw new Error("File not found.");

            const content = fs.readFileSync(absolutePath, 'utf-8');
            const ext = path.extname(absolutePath);
            const parser = getParserForFile(ext);

            if (!parser) return { content: [{ type: "text", text: "Language not supported for AST parsing." }] };

            const tree = parser.parse((offset) => offset < content.length ? content.slice(offset, offset + 4096) : null);
            const skeleton = extractFileSkeleton(tree.rootNode, content);

            return { content: [{ type: "text", text: `# Skeleton: ${file_path}\n\n${skeleton || "_No semantic signatures found_"}` }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
);

server.tool(
    "get_call_graph",
    "Finds all code chunks across the entire repository that invoke a specific function. CRITICAL for safe refactoring.",
    { target_function: z.string().describe("The exact name of the function being called (e.g., 'validateToken')") },
    async ({ target_function }) => {
        try {
            const callers = [];
            for (const chunk of db.chunks.values()) {
                if (chunk.calls && chunk.calls.includes(target_function)) {
                    callers.push(`- [${chunk.node_type}] \`${chunk.name}\` in \`${chunk.file_path}\` (lines ${chunk.start_line}-${chunk.end_line})`);
                }
            }

            if (callers.length === 0) {
                return { content: [{ type: "text", text: `✅ Safe to modify: No local functions found calling '${target_function}'.` }] };
            }

            const md = [
                `# ⚠️ Cross-File Call Graph: \`${target_function}\``,
                `The following ${callers.length} function(s) depend on this method. You must review them before modifying the target's signature:`,
                ...callers
            ].join('\n');

            return { content: [{ type: "text", text: md }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
);

server.tool(
    "list_index_stats",
    "Returns the current state of the graph-indexer index: chunk count, file count, embedding status, daemon status, and index freshness. Call this first if search results seem wrong or stale.",
    {},
    async () => {
        try {
            const chunkCount = db.chunks.size;
            const fileSet = new Set();
            for (const chunk of db.chunks.values()) fileSet.add(chunk.file_path);
            const fileCount = fileSet.size;

            const hasEmbeddings = db.vectors.size > 0;
            const embeddingsEnabled = process.env.INDEXER_EMBEDDINGS !== 'off';

            let indexAge = 'unknown';
            try {
                const stat = fs.statSync(INDEX_PATH);
                const ageMs = Date.now() - stat.mtimeMs;
                const ageSec = Math.floor(ageMs / 1000);
                if (ageSec < 60) indexAge = `${ageSec}s ago`;
                else if (ageSec < 3600) indexAge = `${Math.floor(ageSec / 60)}m ago`;
                else indexAge = `${Math.floor(ageSec / 3600)}h ago`;
            } catch { /* file not found */ }

            let daemonStatus = 'unknown';
            try {
                if (fs.existsSync(PID_FILE)) {
                    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
                    process.kill(pid, 0);
                    daemonStatus = `running (PID: ${pid})`;
                } else {
                    daemonStatus = 'not running';
                }
            } catch { daemonStatus = 'not running (stale PID)'; }

            // Extension distribution
            const extCounts = new Map();
            for (const chunk of db.chunks.values()) {
                const ext = chunk.file_path.split('.').pop() || 'unknown';
                extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
            }

            const searchMode = !embeddingsEnabled
                ? '🔤 Lexical only (INDEXER_EMBEDDINGS=off)'
                : hasEmbeddings
                    ? '🧠 Hybrid (semantic + lexical RRF)'
                    : '🔤 Lexical only (Ollama unavailable or not yet indexed)';

            const lines = [
                `# 📊 graph-indexer Index Stats`,
                ``,
                `| Metric | Value |`,
                `| :--- | :--- |`,
                `| **Chunks** | ${chunkCount} |`,
                `| **Files indexed** | ${fileCount} |`,
                `| **Embeddings loaded** | ${db.vectors.size} |`,
                `| **Search mode** | ${searchMode} |`,
                `| **Daemon** | ${daemonStatus} |`,
                `| **Index age** | ${indexAge} |`,
                ``,
                `## Extension Breakdown`,
                ...Array.from(extCounts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .map(([ext, count]) => `- .${ext}: ${count} chunks`),
            ];

            if (chunkCount === 0) {
                lines.push(``, `⚠️ Index is empty. Run \`npm run mcp:index\` to build it.`);
            }

            return { content: [{ type: "text", text: lines.join('\n') }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("✅ graph-indexer MCP server running (v1.0.0).\n");