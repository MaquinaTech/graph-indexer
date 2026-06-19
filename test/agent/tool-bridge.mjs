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
import { registerTools } from '../../mcp/tools.mjs';
import { createEmbedder, readEmbedMeta } from '../../embeddings.mjs';

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
 * @param {boolean} [opts.embeddings=false]  Build a real query embedder (pinned to
 *        the index's stamped provider/model, exactly like the live mcp-server) so
 *        the hybrid/semantic ranking is exercised. Default false = deterministic,
 *        Ollama-free lexical-only. A query-embed failure degrades to lexical, so an
 *        unreachable Ollama transparently makes this equivalent to lexical-only.
 * @returns {Promise<{ callTool(name, args): Promise<{text, tokens, isError}>, tools: string[], stats: object }>}
 */
export async function createBridge({ fixture, embeddings = false }) {
    const projectRoot = resolveFixtureRoot(fixture);

    // Lexical-only by default (deterministic, dependency-free). With embeddings:true
    // we leave INDEXER_EMBEDDINGS at its resolved value so the hybrid channel runs.
    const config = resolveConfig({
        argv: ['--repo', projectRoot],
        env: embeddings ? { ...process.env } : { ...process.env, INDEXER_EMBEDDINGS: 'off' },
        cwd: projectRoot,
    });

    const db = await createStore(config, { cacheEmbeddings: false });
    db.load();

    // Query embedder: pin to the provider/model stamped in the index meta (the same
    // logic mcp-server uses), so query vectors are produced by the model that built
    // the document vectors. Null in lexical mode → handlers run pure BM25.
    let embedder = null;
    if (embeddings) {
        const embedMeta = readEmbedMeta(config.embeddingPath);
        embedder = await createEmbedder(
            config,
            embedMeta?.provider
                ? { provider: embedMeta.provider, model: embedMeta.model }
                : { provider: config.embeddingsEnabled ? 'ollama' : 'off', model: config.embedModel },
        );
    }

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
        embeddingsEnabled: Boolean(embedder) && embedder.provider !== 'off',
        embedder,
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
