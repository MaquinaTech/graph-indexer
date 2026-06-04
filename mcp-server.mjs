#!/usr/bin/env node
/**
 * @file mcp-server.mjs
 * @description MCP Server to expose in-memory graph index with hybrid search capabilities. Connects to local Ollama instance for embedding generation. Cero dependencias externas.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "path";
import { MemoryGraphIndex } from "./core-engine.mjs";

const PROJECT_ROOT = process.env.MCP_PROJECT_ROOT || process.cwd();
const INDEX_PATH = resolve(PROJECT_ROOT, "code-index.json");

const server = new McpServer({
    name: "secure-graph-indexer",
    version: "2.0.0",
});

const db = new MemoryGraphIndex(INDEX_PATH);
db.load();

async function generateLocalEmbedding(text) {
    const MAX_RETRIES = 3;
    let lastErr = new Error('Ollama unreachable');
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch("http://localhost:11434/api/embeddings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
                signal: AbortSignal.timeout(15000),
            });
            if (res.status === 429 || res.status === 503) {
                lastErr = new Error(`Ollama returned ${res.status}`);
                throw lastErr;
            }
            if (!res.ok) throw new Error(`Ollama connection failed: ${res.status}`);
            const data = await res.json();
            return data.embedding;
        } catch (err) {
            lastErr = err;
            if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
        }
    }
    throw lastErr;
}

server.tool(
    "search_code",
    "Hybrid semantic search (Vector + Lexical). Returns code snippets and dependency topology.",
    {
        query: z.string().describe("What logic to search for. Example: 'JWT authentication in middleware'"),
        exact_tokens: z.string().optional().describe("Exact variable or function names to require"),
        include_topology: z.boolean().default(true),
        min_score: z.number().min(0).max(1).default(0.3).describe("Minimum cosine similarity threshold (0–1). Lower values return more results.")
    },
    async ({ query, exact_tokens, include_topology, min_score }) => {
        try {
            // Combine query and exact tokens to boost TF-IDF
            const fullQueryText = exact_tokens ? `${query} ${exact_tokens}` : query;
            const queryVector = await generateLocalEmbedding(fullQueryText);

            // Use hybrid search engine
            const matches = db.searchHybrid(fullQueryText, queryVector, 5, min_score);

            if (matches.length === 0) return { content: [{ type: "text", text: "Sin resultados." }] };

            const lines = [`🔍 QUERY HÍBRIDA: "${fullQueryText}"\n`];

            for (const { score, chunk } of matches) {
                lines.push(`─`.repeat(50));
                lines.push(`📄 ${chunk.file_path} (RRF Score: ${score.toFixed(4)})`);
                lines.push(`🏷  [${chunk.node_type}] ${chunk.name}`);

                if (include_topology) {
                    const deps = db.graph.dependencies[chunk.file_path] || [];
                    const usedBy = db.graph.importedBy[chunk.file_path] || [];
                    if (deps.length) lines.push(`⬇️  Importa a: ${deps.slice(0, 3).join(", ")}`);
                    if (usedBy.length) lines.push(`⬆️  Usado por: ${usedBy.slice(0, 3).join(", ")}`);
                }

                lines.push("```typescript\n" + chunk.code_snippet + "\n```\n");
            }

            return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("✅ Servidor MCP In-Memory Vectorial iniciado.\n");