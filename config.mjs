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
import { artifactPaths, CONFIG_FILE_NAME, DATA_DIR_NAME } from './layout.mjs';

export const DEFAULTS = Object.freeze({
    storage: 'memory',                 // 'memory' (default, zero-dependency) | 'sqlite'
    embedProvider: 'auto',             // 'auto' (Ollama→local→lexical) | 'ollama' | 'local' | 'off'
    embedModel: 'nomic-embed-text',    // Ollama embedding model
    localEmbedModel: 'Xenova/all-MiniLM-L6-v2', // in-process model (optional @huggingface/transformers)
    ollamaHost: 'http://localhost:11434',
    gitSignals: true,                  // collect local git churn/recency/co-change at index time (air-gapped)
    gitRankBoost: 0,                   // 0..1 opt-in recency/churn weight in search_code (0 = ranking unchanged)
    enrichment: Object.freeze({
        enabled: false,
        model: 'qwen2.5-coder:1.5b',   // small, code-aware; configurable, opt-in
        coreRatio: 1.0,                // 1.0 = all production files (tests/examples always excluded);
                                       // <1 bounds enrichment to the most-central share by PageRank
        maxChunks: 500,                // cap on NEW LLM calls per index run (cache accumulates across runs)
        concurrency: 4,                // parallel Ollama requests during enrichment; keep low —
                                       // a single local model serves requests fastest one-at-a-time
                                       // unless OLLAMA_NUM_PARALLEL + hardware allow more

    }),
    rerank: Object.freeze({
        enabled: false,                // opt-in: one LLM call per natural-language query
        model: 'qwen2.5-coder:7b',     // judge quality matters: 7B measured +50% semantic rank-1, 1.5B ~nil
        topM: 12,                      // candidates shown to the judge to reorder
        poolSize: 15,                  // over-fetch depth when reranking, so a correct-but-deep
                                       // hit can be RESCUED into top_k (then truncated to top_k)
    }),
});

/**
 * Reads the project config, tolerating absence/corruption. Looks first inside the
 * tidy data dir (`.graph-indexer/config.json`), then falls back to the legacy
 * root file (`.graph-indexer.json`) so pre-v1.4 projects keep working until they
 * are migrated.
 */
export function loadConfigFile(root) {
    const candidates = [
        path.join(root, DATA_DIR_NAME, CONFIG_FILE_NAME), // current canonical location
        path.join(root, '.graph-indexer.json'),           // legacy root config (back-compat)
    ];
    for (const configPath of candidates) {
        try {
            if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch { /* malformed config — try the next candidate, else defaults */ }
    }
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

    // Embedding provider: env > --embed-provider flag > config > default 'auto'.
    // 'auto' prefers a running Ollama and falls back to the in-process local model
    // (optional @huggingface/transformers) so semantic search works with no daemon.
    const embedProvider = env.INDEXER_EMBED_PROVIDER
        || flagValue(argv, '--embed-provider')
        || file.embedProvider || DEFAULTS.embedProvider;

    // Git signals: collection is air-gapped (local `git log` only). Disable with
    // INDEXER_GIT_SIGNALS=off, --no-git-signals, or "gitSignals": false.
    const gitSignals = env.INDEXER_GIT_SIGNALS === 'off' || argv.includes('--no-git-signals')
        ? false
        : (file.gitSignals === false ? false : DEFAULTS.gitSignals);
    // Opt-in ranking boost weight (0..1). 0 keeps search ranking byte-identical.
    const gitRankBoostRaw = env.INDEXER_GIT_RANK_BOOST ?? flagValue(argv, '--git-rank-boost')
        ?? (Number.isFinite(file.gitRankBoost) ? file.gitRankBoost : DEFAULTS.gitRankBoost);
    const gitRankBoost = Math.min(1, Math.max(0, Number(gitRankBoostRaw) || 0));

    // All generated artifacts live together under `<projectRoot>/.graph-indexer/`
    // (see layout.mjs) so they never clutter the project root.
    const paths = artifactPaths(projectRoot);

    return Object.freeze({
        projectRoot,
        storage,
        // Index artifact paths — all derive from the same data dir (layout.mjs).
        dataDir: paths.dataDir,
        indexPath: paths.indexPath,
        embeddingPath: paths.embeddingPath,
        sqlitePath: paths.sqlitePath,
        enrichmentCachePath: paths.enrichmentCachePath,
        gitSignalsPath: paths.gitSignalsPath,
        pidFile: paths.pidFile,
        logFile: paths.logFile,

        languages: Array.isArray(file.languages) ? file.languages : null, // null = all

        ollamaHost,
        embeddingsEnabled,
        embedProvider,
        embedModel: file.embedModel || DEFAULTS.embedModel,
        localEmbedModel: file.localEmbedModel || DEFAULTS.localEmbedModel,
        gitSignals,
        gitRankBoost,

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
            poolSize: Number.isInteger((file.rerank || {}).poolSize) ? (file.rerank || {}).poolSize : DEFAULTS.rerank.poolSize,
        }),
    });
}

// Memoised singleton for import-time consumers (e.g. parser-utils language loading).
let _cached = null;
export function getConfig() {
    if (!_cached) _cached = resolveConfig();
    return _cached;
}
