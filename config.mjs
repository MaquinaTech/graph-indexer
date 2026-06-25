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
    embedProvider: 'auto',
    // 'auto'   → Ollama (if running w/ the model) → in-process local → lexical-only
    // 'ollama' → force Ollama daemon   (requires: ollama serve + pulled model)
    // 'local'  → in-process Xenova     (requires: npm i @huggingface/transformers)
    // 'mlx'    → Apple Metal GPU       (requires: npm run embed:setup:mlx; macOS only)
    // 'off'    → lexical-only, no vectors
    embedModel: 'nomic-embed-text',    // default Ollama embed model when embeddings are enabled.
                                       // qwen3-embedding:4b is a documented opt-in upgrade
                                       // (--embed-model / EMBED_MODEL), never a hardcoded default.
    localEmbedModel: 'Xenova/all-MiniLM-L6-v2', // in-process model (optional @huggingface/transformers)
    mlxEmbedModel: 'mlx-community/all-MiniLM-L6-v2-4bit', // MLX embedder model (provider 'mlx').
                                       // Override with --mlx-embed-model / INDEXER_MLX_EMBED_MODEL;
                                       // must be an mlx_embeddings-compatible sentence model.
    ollamaHost: 'http://localhost:11434',
    llmProvider: 'ollama',               // LLM backend for enrichment, reranking, HyDE: 'ollama' | 'mlx'
                                         // 'mlx' requires mlx_lm.server running (mlx_lm.server --model <name>)
    mlxLmHost: 'http://localhost:8080',  // mlx_lm.server endpoint (default port 8080)
    gitSignals: true,                  // collect local git churn/recency/co-change at index time (air-gapped)
    gitRankBoost: 0,                   // 0..1 opt-in recency/churn weight in search_code (0 = ranking unchanged)
    interprocedural: false,            // OPT-IN: index-time inter-procedural receiver-type fixpoint —
                                       // propagate return types along factory call chains so multi-hop
                                       // receivers resolve in get_call_graph / find_references. Air-gapped,
                                       // deterministic; default index is byte-identical. Enable with
                                       // --interprocedural / INDEXER_INTERPROCEDURAL.
    symbolGraph: false,                // OPT-IN: persist a resolved symbol graph (chunk→chunk edges with
                                       // kind + confidence) at index time, exposed via getEdges. findCallers/
                                       // findReferers read it when present (identical sets, fall back to scan).
                                       // Air-gapped, deterministic; default index byte-identical; search
                                       // ranking unaffected. Enable with --symbol-graph / INDEXER_SYMBOL_GRAPH.
    resolver: 'heuristic',             // Resolver provider for the symbol graph (A1). 'heuristic' (default):
                                       // edges stay { high, name_only } — byte-identical. 'precise': lift
                                       // provably-unambiguous edges (sole definition / type-pinned receiver)
                                       // to a `resolved` tier, powering impact_of_edit precision='strict'.
                                       // Only meaningful with --symbol-graph. --resolver / INDEXER_RESOLVER.
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
        enabled: false,                // opt-in: one rerank pass per natural-language query
        provider: 'generative',        // 'generative' = LLM judge (default) | 'cross-encoder' =
                                       // local air-gapped MS-MARCO cross-encoder (no Ollama/daemon,
                                       // deterministic, fast). Set with --rerank-provider / RERANK_PROVIDER.
        model: 'qwen2.5-coder:7b',     // generative judge model: 7B measured +50% semantic rank-1, 1.5B ~nil
        crossEncoderModel: 'Xenova/ms-marco-MiniLM-L-6-v2', // cross-encoder provider model
                                       // (optional @huggingface/transformers; downloaded on first use)
        topM: 12,                      // candidates the reranker reorders
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
        path.join(root, DATA_DIR_NAME, CONFIG_FILE_NAME),
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

    // LLM provider for enrichment / reranking / HyDE: env > flag > config > default.
    // 'mlx' routes generation through a local mlx_lm.server (OpenAI-compatible).
    const llmProviderRaw = env.INDEXER_LLM_PROVIDER || flagValue(argv, '--llm-provider') || file.llmProvider || DEFAULTS.llmProvider;
    const llmProvider = ['ollama', 'mlx'].includes(llmProviderRaw) ? llmProviderRaw : DEFAULTS.llmProvider;
    const mlxLmHost = env.INDEXER_MLX_LM_HOST || flagValue(argv, '--mlx-lm-host') || file.mlxLmHost || DEFAULTS.mlxLmHost;

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
    const gitRankBoostRaw = env.INDEXER_GIT_RANK_BOOST ?? flagValue(argv, '--git-rank-boost')
        ?? (Number.isFinite(file.gitRankBoost) ? file.gitRankBoost : DEFAULTS.gitRankBoost);
    const gitRankBoost = Math.min(1, Math.max(0, Number(gitRankBoostRaw) || 0));

    // Opt-in inter-procedural receiver-type fixpoint (index-time, air-gapped).
    const interprocedural = argv.includes('--interprocedural')
        || env.INDEXER_INTERPROCEDURAL === 'on'
        || file.interprocedural === true;

    // Opt-in persistent resolved symbol graph (index-time, air-gapped).
    const symbolGraph = argv.includes('--symbol-graph')
        || env.INDEXER_SYMBOL_GRAPH === 'on'
        || file.symbolGraph === true;

    // Resolver provider for the symbol graph (A1). Unknown values fall back to 'heuristic'.
    const resolverRaw = flagValue(argv, '--resolver') || env.INDEXER_RESOLVER || file.resolver || DEFAULTS.resolver;
    const resolver = (resolverRaw === 'precise' || resolverRaw === 'heuristic') ? resolverRaw : 'heuristic';

    const paths = artifactPaths(projectRoot);

    return Object.freeze({
        projectRoot,
        storage,
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
        llmProvider,
        mlxLmHost,
        embeddingsEnabled,
        embedProvider,
        // Embed model: --embed-model flag > EMBED_MODEL env > config > nomic default.
        // This is the model `auto`/`ollama` providers pull (e.g. qwen3-embedding:4b).
        embedModel: flagValue(argv, '--embed-model') || env.EMBED_MODEL || file.embedModel || DEFAULTS.embedModel,
        localEmbedModel: file.localEmbedModel || DEFAULTS.localEmbedModel,
        // MLX embedder model: --mlx-embed-model flag > INDEXER_MLX_EMBED_MODEL env >
        // config > pinned MiniLM default. Passed to the Python server + stamped in meta.
        mlxEmbedModel: flagValue(argv, '--mlx-embed-model') || env.INDEXER_MLX_EMBED_MODEL
            || file.mlxEmbedModel || DEFAULTS.mlxEmbedModel,
        gitSignals,
        gitRankBoost,
        interprocedural,
        symbolGraph,
        resolver,

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

        rerank: (() => {
            // Provider: env > --rerank-provider flag > config; validated to a known provider.
            const provRaw = env.RERANK_PROVIDER || flagValue(argv, '--rerank-provider') || (file.rerank || {}).provider;
            const provider = ['generative', 'cross-encoder'].includes(provRaw) ? provRaw : DEFAULTS.rerank.provider;
            return Object.freeze({
                // OFF unless requested: --rerank flag, RERANK_MODEL env (naming a model implies
                // enabling it), an explicit provider (env/flag), or the project config.
                enabled: argv.includes('--rerank') || Boolean(env.RERANK_MODEL) || Boolean(provRaw)
                    || Boolean((file.rerank || {}).enabled),
                provider,
                model: env.RERANK_MODEL || (file.rerank || {}).model || DEFAULTS.rerank.model,
                crossEncoderModel: env.RERANK_CROSS_ENCODER_MODEL || (file.rerank || {}).crossEncoderModel
                    || DEFAULTS.rerank.crossEncoderModel,
                topM: Number.isInteger((file.rerank || {}).topM) ? (file.rerank || {}).topM : DEFAULTS.rerank.topM,
                poolSize: Number.isInteger((file.rerank || {}).poolSize) ? (file.rerank || {}).poolSize : DEFAULTS.rerank.poolSize,
            });
        })(),

        hyde: Object.freeze({
            enabled: Boolean((file.hyde || {}).enabled),
            model: (file.hyde || {}).model || DEFAULTS.hyde.model,
        }),
    });
}

// Memoised singleton for import-time consumers (e.g. parse/languages.mjs language loading).
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
    // Show the model that the chosen provider actually loads (mlx/local use their own).
    const provModel = config.embedProvider === 'mlx' ? config.mlxEmbedModel
        : config.embedProvider === 'local' ? config.localEmbedModel
            : config.embedModel;
    const emb = config.embeddingsEnabled
        ? `on · provider=${config.embedProvider}, model=${provModel}`
        : 'off (lexical + stemming only)';
    return [
        `storage     : ${backend}`,
        `embeddings  : ${emb}`,
        `enrichment  : ${config.enrichment.enabled ? `on · model=${config.enrichment.model} · provider=${config.llmProvider}` : 'off'}`,
        `reranker    : ${config.rerank.enabled
            ? (config.rerank.provider === 'cross-encoder'
                ? `on · provider=cross-encoder · model=${config.rerank.crossEncoderModel}`
                : `on · provider=generative · model=${config.rerank.model} · llm=${config.llmProvider}`)
            : 'off'}`,
        `git signals : ${config.gitSignals ? 'on' : 'off'}${config.gitRankBoost ? ` · rank boost=${config.gitRankBoost}` : ''}`,
        `interproc.  : ${config.interprocedural ? 'on · factory return-type propagation' : 'off'}`,
        `symbol graph: ${config.symbolGraph ? 'on · persisted resolved edges (getEdges)' : 'off'}`,
        `resolver    : ${config.resolver === 'precise' ? 'precise · unambiguous edges → `resolved` tier' : 'heuristic (default)'}`,
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
    if (config.interprocedural) {
        out.push('Inter-procedural receiver types are resolved at index time (a whole-program pass). '
            + 'The watch daemon updates one file at a time and does NOT re-run the fixpoint, so '
            + 'cross-file factory chains refresh on the next full `idx-index`; until then they fall '
            + 'back to single-hop resolution (never worse than the default). It only sharpens '
            + 'get_call_graph / find_references — search ranking is unaffected.');
    }
    if (config.symbolGraph) {
        out.push('The resolved symbol graph is built once at index time (a whole-program pass), adding '
            + 'index time roughly proportional to repo size. The watch daemon does NOT rebuild it, so '
            + 'edges refresh on the next full `idx-index`; until then findCallers/findReferers fall back '
            + 'to the name-match scan (never worse). It powers getEdges; search ranking is unaffected.');
    }
    if (config.resolver === 'precise' && !config.symbolGraph) {
        out.push('--resolver precise has no effect without --symbol-graph (the resolver runs only when '
            + 'the symbol graph is built). Add --symbol-graph to enable the `resolved` edge tier.');
    } else if (config.resolver === 'precise') {
        out.push('Precise resolver: edges with a provably-unambiguous binding (sole definition, or a '
            + 'type-pinned receiver) are promoted from `high` to a `resolved` tier — used by '
            + "impact_of_edit(precision: 'strict') for a false-positive-free blast radius. Confidence "
            + 'strings only change; edge sets, parity, and search ranking are unaffected.');
    }
    if (config.enrichment.enabled && !config.rerank.enabled) {
        out.push('Enrichment is most effective when paired with --rerank. Running enrichment-only may '
            + 'regress semantic precision (measured: gin MRR 0.48→0.39 on qwen3 embeddings).');
    }
    if (config.rerank.enabled && config.rerank.provider === 'cross-encoder') {
        out.push('Cross-encoder reranker scores (query, candidate) pairs locally and air-gapped — '
            + 'no LLM/daemon, deterministic, ~tens of ms per natural-language query. It needs the '
            + "optional '@huggingface/transformers' package (first run downloads the model). It sees "
            + 'only a candidate signature/summary line, not full code, so it sharpens near-ties rather '
            + 'than reasoning about behaviour. Measure on your repo (`npm run test:eval -- --rerank '
            + '--rerank-provider cross-encoder`) before adopting.');
    } else if (config.rerank.enabled) {
        out.push('Reranker improves rank-1 for Go/Python repositories (gin: 0.20→0.40) but has shown '
            + 'regressions on JavaScript repositories (express: 0.43→0.29). Behaviour depends on '
            + 'repository language. See README for per-language benchmark data.');
    }
    return out;
}
