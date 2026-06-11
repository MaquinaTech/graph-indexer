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

export const DEFAULTS = Object.freeze({
    storage: 'memory',                 // 'memory' (default, zero-dependency) | 'sqlite'
    embedModel: 'nomic-embed-text',
    ollamaHost: 'http://localhost:11434',
    enrichment: Object.freeze({
        enabled: false,
        model: 'qwen2.5-coder:1.5b',   // small, code-aware; configurable, opt-in
        coreRatio: 1.0,                // 1.0 = all production files (tests/examples always excluded);
                                       // <1 bounds enrichment to the most-central share by PageRank
        maxChunks: 500,                // cap on NEW LLM calls per index run (cache accumulates across runs)
        concurrency: 12,               // parallel Ollama requests during enrichment
    }),
    rerank: Object.freeze({
        enabled: false,                // opt-in: one LLM call (~1–2 s) per natural-language query
        model: 'qwen2.5-coder:7b',     // judge quality matters: 7B measured +50% semantic rank-1, 1.5B ~nil
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

    // Storage: --use-sqlite flag or "storage" key. The in-memory engine remains
    // the default so the zero-dependency baseline is never disturbed implicitly.
    const storage = argv.includes('--use-sqlite') ? 'sqlite'
        : (file.storage === 'sqlite' ? 'sqlite' : DEFAULTS.storage);

    const enrichmentEnabled = argv.includes('--llm-enrichment')
        || argv.includes('--enrich')
        || Boolean(fileEnrich.enabled);

    const ollamaHost = env.OLLAMA_HOST || file.ollamaHost || DEFAULTS.ollamaHost;
    const embeddingsEnabled = env.INDEXER_EMBEDDINGS !== 'off';

    return Object.freeze({
        projectRoot,
        storage,
        // Index artifact paths — all derive from the same stem next to the project.
        indexPath: path.join(projectRoot, 'code-index.json'),
        embeddingPath: path.join(projectRoot, 'code-index.embeddings.bin'),
        sqlitePath: path.join(projectRoot, 'code-index.db'),
        enrichmentCachePath: path.join(projectRoot, 'code-index.enrichment.json'),

        languages: Array.isArray(file.languages) ? file.languages : null, // null = all

        ollamaHost,
        embeddingsEnabled,
        embedModel: file.embedModel || DEFAULTS.embedModel,

        enrichment: Object.freeze({
            enabled: enrichmentEnabled,
            model: flagValue(argv, '--enrich-model') || fileEnrich.model || DEFAULTS.enrichment.model,
            coreRatio: Number(fileEnrich.coreRatio) > 0 ? Number(fileEnrich.coreRatio) : DEFAULTS.enrichment.coreRatio,
            maxChunks: Number(flagValue(argv, '--enrich-max')) > 0
                ? Number(flagValue(argv, '--enrich-max'))
                : (Number.isInteger(fileEnrich.maxChunks) ? fileEnrich.maxChunks : DEFAULTS.enrichment.maxChunks),
            concurrency: Number(flagValue(argv, '--enrich-concurrency')) > 0
                ? Number(flagValue(argv, '--enrich-concurrency'))
                : (Number(fileEnrich.concurrency) > 0 ? Number(fileEnrich.concurrency) : DEFAULTS.enrichment.concurrency),
        }),

        rerank: Object.freeze({
            enabled: Boolean((file.rerank || {}).enabled),
            model: (file.rerank || {}).model || DEFAULTS.rerank.model,
            topM: Number.isInteger((file.rerank || {}).topM) ? (file.rerank || {}).topM : DEFAULTS.rerank.topM,
        }),
    });
}

// Memoised singleton for import-time consumers (e.g. parser-utils language loading).
let _cached = null;
export function getConfig() {
    if (!_cached) _cached = resolveConfig();
    return _cached;
}
