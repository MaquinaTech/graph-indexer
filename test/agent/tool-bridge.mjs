/**
 * test/agent/tool-bridge.mjs
 *
 * Faithful, in-process bridge to the real graph-indexer MCP tools.
 *
 * Instead of standing up a stdio MCP server, we hand `registerTools` a *mock*
 * server that simply captures every `server.tool(name, desc, schemaShape, handler)`
 * registration. We can then invoke any tool exactly as the live server would:
 * the same handlers, the same storage backend, the same rendered text — so a
 * sub-agent driving these tools sees byte-identical output to production.
 *
 * Token accounting matches the tool/cost model used throughout the codebase and
 * the README: 1 token ≈ 4 characters of returned text.
 */
import { z } from 'zod';
import path from 'path';
import { resolveConfig } from '../../config.mjs';
import { createStore } from '../../storage.mjs';
import { registerTools } from '../../mcp-tools.mjs';

const CHARS_PER_TOKEN = 4;

/** Map a fixture name (or absolute/relative path) to its repo root. */
export function resolveFixtureRoot(nameOrPath) {
    if (!nameOrPath) throw new Error('fixture is required (name or path)');
    if (nameOrPath.includes('/') || path.isAbsolute(nameOrPath)) {
        return path.resolve(nameOrPath);
    }
    // bare name → test/fixtures/<name>
    return path.resolve(new URL('../fixtures/', import.meta.url).pathname, nameOrPath);
}

/**
 * Build an in-process tool bridge for one indexed fixture.
 *
 * @param {object} opts
 * @param {string} opts.fixture  Fixture name (e.g. "nestjs") or a repo path.
 * @returns {Promise<{ callTool(name, args): Promise<{text, tokens, isError}>, tools: string[], stats: object }>}
 */
export async function createBridge({ fixture }) {
    const projectRoot = resolveFixtureRoot(fixture);

    // Lexical-only, no Ollama: deterministic and dependency-free. The handlers
    // still try a query embedding and fall back to lexical on connection refusal.
    const config = resolveConfig({
        argv: ['--repo', projectRoot],
        env: { ...process.env, INDEXER_EMBEDDINGS: 'off' },
        cwd: projectRoot,
    });

    const db = await createStore(config, { cacheEmbeddings: false });
    db.load();

    // Mock MCP server: capture each tool registration.
    const registry = new Map();
    const mockServer = {
        tool(name, _description, schemaShape, handler) {
            registry.set(name, { schema: z.object(schemaShape), handler });
        },
        // registerTools never calls .resource(); provided for safety.
        resource() {},
    };

    registerTools(mockServer, db, {
        projectRoot,
        artifactPath: config.indexPath,
        pidFile: null,
        embeddingsEnabled: false,
        ollamaHost: config.ollamaHost,
        embedModel: config.embedModel,
        rerank: config.rerank,
    });

    async function callTool(name, args = {}) {
        const entry = registry.get(name);
        if (!entry) {
            throw new Error(`Unknown tool "${name}". Available: ${[...registry.keys()].join(', ')}`);
        }
        const parsed = entry.schema.parse(args ?? {}); // applies defaults + validates
        const result = await entry.handler(parsed);
        const text = (result?.content || [])
            .map(c => (typeof c?.text === 'string' ? c.text : ''))
            .join('\n');
        return {
            text,
            tokens: Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN)),
            isError: Boolean(result?.isError),
        };
    }

    return {
        callTool,
        tools: [...registry.keys()],
        stats: db.stats(),
        projectRoot,
    };
}
