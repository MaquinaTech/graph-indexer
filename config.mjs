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
    // 'auto' keeps the index in memory below AUTO_SQLITE_CHUNK_THRESHOLD chunks and
    // switches to disk-backed SQLite above it. Force either with --use-sqlite /
    // INDEXER_STORAGE. (see storage.mjs: resolveBackend / AUTO_SQLITE_CHUNK_THRESHOLD)
    storage: 'auto',                   // 'auto' (default) | 'memory' | 'sqlite'
    embeddings: false,                 // OFF by default — lexical + stemming need zero dependencies.
                                       // Opt in with --embeddings or INDEXER_EMBEDDINGS=on.
    embedProvider: 'auto',             // 'auto' (Ollama→local→lexical) | 'ollama' | 'local' | 'off'
    embedModel: 'nomic-embed-text',    // default Ollama embed model when embeddings are enabled.
                                       // qwen3-embedding:4b is a documented opt-in upgrade
                                       // (--embed-model / EMBED_MODEL), never a hardcoded default.
    localEmbedModel: 'Xenova/all-MiniLM-L6-v2', // in-process model (optional @huggingface/transformers)
    ollamaHost: 'http://localhost:11434',
    gitSignals: true,                  // collect local git churn/recency/co-change at index time (air-gapped)
    gitRankBoost: 0,                   // 0..1 opt-in recency/churn weight in search_code (0 = ranking unchanged)
    enrichment: Object.freeze({
        enabled: false,
        model: 'qwen2.5-coder:1.5b',   // smallest coder model; quality sufficient for summaries.
                                       // Opt in with --enrichment or ENRICH_MODEL=<model>.
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
    hyde: Object.freeze({
        enabled: false,                // opt-in: query-side HyDE — one LLM call per NL query, blended into the query vector
        model: 'qwen2.5-coder:1.5b',   // local coder model that writes the hypothetical snippet
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

    // Storage: --use-sqlite forces SQLite; otherwise INDEXER_STORAGE / "storage" key
    // / default 'auto' (resolved to memory-or-sqlite by chunk count at index time and
    // by artifact presence at query time — see storage.mjs:resolveBackend).
    const storageRaw = argv.includes('--use-sqlite') ? 'sqlite'
        : (env.INDEXER_STORAGE || file.storage || DEFAULTS.storage);
    const storage = ['memory', 'sqlite', 'auto'].includes(storageRaw) ? storageRaw : DEFAULTS.storage;

    // Enrichment is OFF unless explicitly requested: --enrichment flag, ENRICH_MODEL
    // env (naming a model implies enabling it), or the project config.
    const enrichModelEnv = env.ENRICH_MODEL || undefined;
    const enrichmentEnabled = argv.includes('--enrichment')
        || Boolean(enrichModelEnv)
        || Boolean(fileEnrich.enabled);

    const ollamaHost = env.OLLAMA_HOST || file.ollamaHost || DEFAULTS.ollamaHost;

    // Embeddings are OFF by default (lexical + stemming need zero dependencies).
    // Enable with --embeddings or INDEXER_EMBEDDINGS=on; INDEXER_EMBEDDINGS=off always wins.
    const embeddingsEnabled = env.INDEXER_EMBEDDINGS === 'off'
        ? false
        : (argv.includes('--embeddings') || env.INDEXER_EMBEDDINGS === 'on' || file.embeddings === true);

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
        // Embed model: --embed-model flag > EMBED_MODEL env > config > nomic default.
        // This is the model `auto`/`ollama` providers pull (e.g. qwen3-embedding:4b).
        embedModel: flagValue(argv, '--embed-model') || env.EMBED_MODEL || file.embedModel || DEFAULTS.embedModel,
        localEmbedModel: file.localEmbedModel || DEFAULTS.localEmbedModel,
        gitSignals,
        gitRankBoost,

        enrichment: Object.freeze({
            enabled: enrichmentEnabled,
            model: flagValue(argv, '--enrich-model') || enrichModelEnv || fileEnrich.model || DEFAULTS.enrichment.model,
            coreRatio: Number(fileEnrich.coreRatio) > 0 ? Number(fileEnrich.coreRatio) : DEFAULTS.enrichment.coreRatio,
            maxChunks: Number(flagValue(argv, '--enrich-max')) > 0
                ? Number(flagValue(argv, '--enrich-max'))
                : (Number.isInteger(fileEnrich.maxChunks) ? fileEnrich.maxChunks : DEFAULTS.enrichment.maxChunks),
            concurrency: Number(flagValue(argv, '--enrich-concurrency')) > 0
                ? Number(flagValue(argv, '--enrich-concurrency'))
                : (Number(fileEnrich.concurrency) > 0 ? Number(fileEnrich.concurrency) : DEFAULTS.enrichment.concurrency),
        }),

        rerank: Object.freeze({
            // OFF unless requested: --rerank flag, RERANK_MODEL env (naming a model
            // implies enabling it), or the project config.
            enabled: argv.includes('--rerank') || Boolean(env.RERANK_MODEL) || Boolean((file.rerank || {}).enabled),
            model: env.RERANK_MODEL || (file.rerank || {}).model || DEFAULTS.rerank.model,
            topM: Number.isInteger((file.rerank || {}).topM) ? (file.rerank || {}).topM : DEFAULTS.rerank.topM,
            poolSize: Number.isInteger((file.rerank || {}).poolSize) ? (file.rerank || {}).poolSize : DEFAULTS.rerank.poolSize,
        }),

        hyde: Object.freeze({
            enabled: Boolean((file.hyde || {}).enabled),
            model: (file.hyde || {}).model || DEFAULTS.hyde.model,
        }),
    });
}

// Memoised singleton for import-time consumers (e.g. parser-utils language loading).
let _cached = null;
export function getConfig() {
    if (!_cached) _cached = resolveConfig();
    return _cached;
}

/**
 * Human-readable lines describing the effective configuration, printed at startup
 * by the indexer / MCP server / daemon so users can see exactly what is running
 * (storage backend, model names, which optional features are on).
 *
 * @param {object} config  Resolved config from resolveConfig().
 * @param {object} [opts]
 * @param {string} [opts.backend]  Concrete backend ('memory'|'sqlite') once 'auto'
 *                                 has been resolved; defaults to config.storage.
 * @returns {string[]}
 */
export function describeConfig(config, { backend = config.storage } = {}) {
    const emb = config.embeddingsEnabled
        ? `on · provider=${config.embedProvider}, model=${config.embedModel}`
        : 'off (lexical + stemming only)';
    return [
        `storage     : ${backend}`,
        `embeddings  : ${emb}`,
        `enrichment  : ${config.enrichment.enabled ? `on · model=${config.enrichment.model}` : 'off'}`,
        `reranker    : ${config.rerank.enabled ? `on · model=${config.rerank.model}` : 'off'}`,
        `git signals : ${config.gitSignals ? 'on' : 'off'}${config.gitRankBoost ? ` · rank boost=${config.gitRankBoost}` : ''}`,
    ];
}

/**
 * Operational warnings for risky / edge configurations. The transition between
 * default and an opt-in feature must never be silent: callers print these at
 * startup so a user who enabled enrichment-only or the reranker sees the measured
 * trade-off before they wonder why precision moved.
 *
 * @param {object} config  Resolved config from resolveConfig().
 * @returns {string[]}
 */
export function configNotices(config) {
    const out = [];
    if (config.enrichment.enabled && !config.rerank.enabled) {
        out.push('Enrichment is most effective when paired with --rerank. Running enrichment-only may '
            + 'regress semantic precision (measured: gin MRR 0.48→0.39 on qwen3 embeddings).');
    }
    if (config.rerank.enabled) {
        out.push('Reranker improves rank-1 for Go/Python repositories (gin: 0.20→0.40) but has shown '
            + 'regressions on JavaScript repositories (express: 0.43→0.29). Behaviour depends on '
            + 'repository language. See README for per-language benchmark data.');
    }
    return out;
}
