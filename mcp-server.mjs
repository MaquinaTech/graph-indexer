#!/usr/bin/env node
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
db.load(); // Carga en memoria instantánea

async function generateLocalEmbedding(text) {
    const res = await fetch("http://localhost:11434/api/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error("Ollama connection failed");
    const data = await res.json();
    return data.embedding;
}

server.tool(
    "search_code",
    "Búsqueda semántica (Híbrida: Vectorial + Exacta) en memoria. Devuelve código y topología.",
    {
        query: z.string().describe("Lógica a buscar. Ej: 'autenticación de JWT en middleware'"),
        exact_tokens: z.string().optional().describe("Nombres de variables o funciones exactas requeridas"),
        include_topology: z.boolean().default(true)
    },
    async ({ query, exact_tokens, include_topology }) => {
        try {
            // Combinamos query y tokens exactos para potenciar el TF-IDF
            const fullQueryText = exact_tokens ? `${query} ${exact_tokens}` : query;
            const queryVector = await generateLocalEmbedding(fullQueryText);

            // Usamos el motor híbrido
            const matches = db.searchHybrid(fullQueryText, queryVector, 5);

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