/**
 * @file config.mjs
 * @description Single source of truth for runtime configuration. Resolves, in
 *              order of precedence, CLI flags > environment variables >
 *              `.graph-indexer.json` > built-in defaults, into one frozen object
 *              consumed by the indexer, watch daemon and MCP server.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import path from 'path';
import { PROVIDER_DEFAULTS, PROVIDER_IDS } from './providers.mjs';

export const STORAGE_BACKENDS = Object.freeze(['memory', 'sqlite', 'postgres']);

export const DEFAULTS = Object.freeze({
    storage: 'memory',                 // 'memory' (default, zero-dependency) | 'sqlite' | 'postgres'
    provider: 'ollama',                // default AI provider for embeddings + generation
    ollamaHost: 'http://localhost:11434',
    enrichment: Object.freeze({
        enabled: false,
        coreRatio: 1.0,                // 1.0 = all production files (tests/examples always excluded);
                                       // <1 bounds enrichment to the most-central share by PageRank
        maxChunks: 500,                // cap on NEW LLM calls per index run (cache accumulates across runs)
        concurrency: 12,               // parallel generation requests during enrichment
    }),
    rerank: Object.freeze({
        enabled: false,                // opt-in: one LLM call (~1–2 s) per natural-language query
        topM: 8,                       // fused results shown to the judge (8 measured better than 10)
    }),
});

/** Reads `.graph-indexer.json` from a directory, tolerating absence/corruption. */
export function loadConfigFile(root) {
    const configPath = path.join(root, '.graph-indexer.json');
    try {
        if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { /* malformed config is ignored — defaults apply */ }
    return {};
}

/** Returns the value following `--flag` in argv, or undefined. */
function flagValue(argv, flag) {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// OLLAMA_HOST in the shell is Ollama's binding address (e.g. "0.0.0.0:11435"),
// not an HTTP client URL — normalise bare "host:port" strings by adding http://
// and translating 0.0.0.0 → localhost so fetches work in both formats.
function normalizeOllamaHost(raw) {
    if (!raw) return null;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    return 'http://' + raw.replace(/^0\.0\.0\.0/, 'localhost');
}

function validProvider(value) {
    return PROVIDER_IDS.includes(value) ? value : undefined;
}

/**
 * Resolve the effective configuration.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv]  Defaults to process.argv.slice(2).
 * @param {object}   [opts.env]   Defaults to process.env.
 * @param {string}   [opts.cwd]   Defaults to process.cwd().
 * @returns {Readonly<object>}
 */
export function resolveConfig({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
    // Project root: --repo wins, then MCP_PROJECT_ROOT, then cwd. The config file,
    // index artifacts and language selection are all anchored to this directory.
    const repoArg = flagValue(argv, '--repo');
    const projectRoot = path.resolve(repoArg || env.MCP_PROJECT_ROOT || cwd);

    const file = loadConfigFile(projectRoot);
    const fileEnrich = file.enrichment || {};
    const fileRerank = file.rerank || {};

    // Storage: --use-sqlite / --use-postgres flags or "storage" key. The
    // in-memory engine remains the default so the zero-dependency baseline is
    // never disturbed implicitly.
    const storage = argv.includes('--use-sqlite') ? 'sqlite'
        : argv.includes('--use-postgres') ? 'postgres'
            : (STORAGE_BACKENDS.includes(file.storage) ? file.storage : DEFAULTS.storage);

    // AI provider: one default for every channel, overridable per channel.
    // No silent substitution: Anthropic offers no embeddings API, so an
    // anthropic embedding channel resolves as-is and is reported unusable by
    // providers.createEmbedder — `embedProvider` must name a provider that
    // embeds (init.mjs prompts for it explicitly).
    const provider = validProvider(flagValue(argv, '--provider'))
        || validProvider(env.GRAPH_INDEXER_PROVIDER)
        || validProvider(file.provider)
        || DEFAULTS.provider;
    const embedProvider = validProvider(flagValue(argv, '--embed-provider'))
        || validProvider(file.embedProvider)
        || provider;

    const enrichmentEnabled = argv.includes('--llm-enrichment')
        || argv.includes('--enrich')
        || Boolean(fileEnrich.enabled);

    const ollamaHost = normalizeOllamaHost(env.OLLAMA_HOST)
        || normalizeOllamaHost(file.ollamaHost)
        || DEFAULTS.ollamaHost;
    const embeddingsEnabled = env.INDEXER_EMBEDDINGS !== 'off';

    // PostgreSQL connection: env wins so the URL (which may carry a password)
    // never has to live in the project config. An empty string is valid — the
    // pg driver then falls back to its native PGHOST/PGUSER/… variables.
    const filePg = file.postgres || {};
    const postgres = Object.freeze({
        url: env.GRAPH_INDEXER_PG_URL || env.DATABASE_URL || filePg.url || '',
        schema: filePg.schema || 'graph_indexer',
    });

    return Object.freeze({
        projectRoot,
        storage,
        // Index artifact paths — all derive from the same stem next to the project.
        indexPath: path.join(projectRoot, 'code-index.json'),
        embeddingPath: path.join(projectRoot, 'code-index.embeddings.bin'),
        embeddingMetaPath: path.join(projectRoot, 'code-index.embeddings.meta.json'),
        sqlitePath: path.join(projectRoot, 'code-index.db'),
        enrichmentCachePath: path.join(projectRoot, 'code-index.enrichment.json'),
        postgres,

        languages: Array.isArray(file.languages) ? file.languages : null, // null = all

        provider,
        ollamaHost,
        embeddingsEnabled,
        embedProvider,
        embedModel: file.embedModel || PROVIDER_DEFAULTS[embedProvider].embedModel,

        enrichment: Object.freeze({
            enabled: enrichmentEnabled,
            provider: validProvider(fileEnrich.provider) || provider,
            model: flagValue(argv, '--enrich-model') || fileEnrich.model
                || PROVIDER_DEFAULTS[validProvider(fileEnrich.provider) || provider].enrichModel,
            coreRatio: Number(fileEnrich.coreRatio) > 0 ? Number(fileEnrich.coreRatio) : DEFAULTS.enrichment.coreRatio,
            maxChunks: Number(flagValue(argv, '--enrich-max')) > 0
                ? Number(flagValue(argv, '--enrich-max'))
                : (Number.isInteger(fileEnrich.maxChunks) ? fileEnrich.maxChunks : DEFAULTS.enrichment.maxChunks),
            concurrency: Number(flagValue(argv, '--enrich-concurrency')) > 0
                ? Number(flagValue(argv, '--enrich-concurrency'))
                : (Number(fileEnrich.concurrency) > 0 ? Number(fileEnrich.concurrency) : DEFAULTS.enrichment.concurrency),
        }),

        rerank: Object.freeze({
            enabled: Boolean(fileRerank.enabled),
            provider: validProvider(fileRerank.provider) || provider,
            model: fileRerank.model
                || PROVIDER_DEFAULTS[validProvider(fileRerank.provider) || provider].rerankModel,
            topM: Number.isInteger(fileRerank.topM) ? fileRerank.topM : DEFAULTS.rerank.topM,
        }),
    });
}

// Memoised singleton for import-time consumers (e.g. parser-utils language loading).
let _cached = null;
export function getConfig() {
    if (!_cached) _cached = resolveConfig();
    return _cached;
}
