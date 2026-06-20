/**
 * bench/configs.mjs
 *
 * The user-facing retrieval configurations measured by the multi-language
 * benchmark. Each entry describes (a) how to build a CLEAN index for that
 * configuration and (b) how to score it with the strict evaluator
 * (test/evaluate.mjs). Nothing here changes ranking logic — these are only the
 * env vars / flags a real user would set to select a mode.
 *
 *   build:  { embeddings, provider, embedModel, localModel, enrichment, enrichModel, sqlite }
 *   score:  flags appended to `node test/evaluate.mjs` ({ embeddings, embedProvider, rerank, rerankModel })
 *
 * O1 (qwen3-embedding:0.6b) is intentionally absent: the model is not pulled in
 * this environment, so it is reported "not run — model not pulled" rather than
 * silently skipped.
 */

export const CONFIGS = {
    // ── Lexical (default path — zero dependencies) ──────────────────────────────
    L1: {
        label: 'lexical + stemming (shipped default)',
        family: 'lexical',
        build: { embeddings: false },
        score: {},
        needsOllama: false,
    },

    // ── In-process embeddings (no Ollama daemon) ────────────────────────────────
    E0: {
        label: 'in-process all-MiniLM-L6-v2 (current default embedder)',
        family: 'in-process',
        build: { embeddings: true, provider: 'local', localModel: 'Xenova/all-MiniLM-L6-v2' },
        score: { embeddings: true, embedProvider: 'local' },
        needsOllama: false,
    },
    E1: {
        label: 'in-process jina-embeddings-v2-base-code',
        family: 'in-process',
        build: { embeddings: true, provider: 'local', localModel: 'jinaai/jina-embeddings-v2-base-code' },
        score: { embeddings: true, embedProvider: 'local' },
        needsOllama: false,
        // The shipped _localPipeline loads jina at fp32 (no dtype option), which is
        // ~1-3 chunks/s and blows any sane build budget; enabling q8 requires editing
        // engine source, which this measurement task forbids. The gin/express deltas
        // were measured in the v2.0 analysis pass (see ANALYSIS_V2.md) and are cited
        // there. Mark this row "not run — q8 dtype not shipped" unless BENCH_FORCE_E1=1.
        blocked: 'jina fp32 via the shipped engine is impractically slow; q8 dtype is not a shipped option (would require an engine edit). See ANALYSIS_V2.md for the measured gin/express deltas.',
    },

    // ── Ollama embeddings ───────────────────────────────────────────────────────
    O0: {
        label: 'Ollama nomic-embed-text',
        family: 'ollama-embed',
        build: { embeddings: true, provider: 'ollama', embedModel: 'nomic-embed-text' },
        score: { embeddings: true, embedProvider: 'ollama' },
        needsOllama: true,
    },
    O2: {
        label: 'Ollama qwen3-embedding:4b',
        family: 'ollama-embed',
        build: { embeddings: true, provider: 'ollama', embedModel: 'qwen3-embedding:4b' },
        score: { embeddings: true, embedProvider: 'ollama' },
        needsOllama: true,
    },

    // ── Rerank / enrichment (the full stack) ────────────────────────────────────
    // Reranking is a QUERY-time step → same index as O2, rerank flag at score time.
    R0: {
        label: 'O2 + LLM rerank (qwen2.5-coder:7b)',
        family: 'rerank',
        build: { embeddings: true, provider: 'ollama', embedModel: 'qwen3-embedding:4b' },
        score: { embeddings: true, embedProvider: 'ollama', rerank: true, rerankModel: 'qwen2.5-coder:7b' },
        needsOllama: true,
    },
    // Enrichment is an INDEX-time step → rebuild with --enrichment.
    R1: {
        label: 'O2 + LLM enrichment (qwen2.5-coder:1.5b)',
        family: 'enrichment',
        build: { embeddings: true, provider: 'ollama', embedModel: 'qwen3-embedding:4b', enrichment: true, enrichModel: 'qwen2.5-coder:1.5b' },
        score: { embeddings: true, embedProvider: 'ollama' },
        needsOllama: true,
    },
    R2: {
        label: 'O2 + enrichment + rerank (full stack)',
        family: 'full',
        build: { embeddings: true, provider: 'ollama', embedModel: 'qwen3-embedding:4b', enrichment: true, enrichModel: 'qwen2.5-coder:1.5b' },
        score: { embeddings: true, embedProvider: 'ollama', rerank: true, rerankModel: 'qwen2.5-coder:7b' },
        needsOllama: true,
    },

    // ── Query-side HyDE variants (WI3) ──────────────────────────────────────────
    // HyDE and rerank are QUERY-time steps: they share the SAME index as their base
    // embed config, so they are always scored with `--reuse` (no rebuild) right after
    // the base build. They are NONDETERMINISTIC (generation temperature > 0) — the
    // bench driver scores each one 3× via bench/repeat-score.mjs and reports the
    // stable value with the rank-1 spread. The prior Laravel investigation found
    // nomic + HyDE + rerank (O0HR) was the winning config there, which is why these
    // exist (the original catalog had no HyDE row).
    //
    // nomic-embed-text base (O0): cheap to (re)build, so HyDE is affordable.
    O0H: {
        label: 'O0 + query-side HyDE (nomic-embed-text)',
        family: 'hyde',
        build: { embeddings: true, provider: 'ollama', embedModel: 'nomic-embed-text' },
        score: { embeddings: true, embedProvider: 'ollama', hyde: true },
        needsOllama: true, nondeterministic: true, reuseBase: 'O0',
    },
    O0R: {
        label: 'O0 + LLM rerank (nomic-embed-text + qwen2.5-coder:7b)',
        family: 'rerank',
        build: { embeddings: true, provider: 'ollama', embedModel: 'nomic-embed-text' },
        score: { embeddings: true, embedProvider: 'ollama', rerank: true, rerankModel: 'qwen2.5-coder:7b' },
        needsOllama: true, nondeterministic: true, reuseBase: 'O0',
    },
    O0HR: {
        label: 'O0 + HyDE + LLM rerank (nomic-embed-text, full query-side stack)',
        family: 'full',
        build: { embeddings: true, provider: 'ollama', embedModel: 'nomic-embed-text' },
        score: { embeddings: true, embedProvider: 'ollama', hyde: true, rerank: true, rerankModel: 'qwen2.5-coder:7b' },
        needsOllama: true, nondeterministic: true, reuseBase: 'O0',
    },

    // qwen3-embedding:4b base (O2): expensive to build, so HyDE/rerank reuse it.
    O2H: {
        label: 'O2 + query-side HyDE (qwen3-embedding:4b)',
        family: 'hyde',
        build: { embeddings: true, provider: 'ollama', embedModel: 'qwen3-embedding:4b' },
        score: { embeddings: true, embedProvider: 'ollama', hyde: true },
        needsOllama: true, nondeterministic: true, reuseBase: 'O2',
    },
    O2HR: {
        label: 'O2 + HyDE + LLM rerank (qwen3-embedding:4b, full query-side stack)',
        family: 'full',
        build: { embeddings: true, provider: 'ollama', embedModel: 'qwen3-embedding:4b' },
        score: { embeddings: true, embedProvider: 'ollama', hyde: true, rerank: true, rerankModel: 'qwen2.5-coder:7b' },
        needsOllama: true, nondeterministic: true, reuseBase: 'O2',
    },
};

// Cheap configs run on EVERY language; costly ones on the representative subset.
export const CHEAP_CONFIGS = ['L1', 'E0', 'O0'];
export const COSTLY_CONFIGS = ['O2', 'R0', 'R1', 'R2']; // E1 blocked (see above)
// Query-time variants — scored on an already-built index (--reuse), nondeterministic.
export const QUERY_TIME_CONFIGS = ['O0H', 'O0R', 'O0HR', 'O2H', 'R0', 'O2HR', 'R2'];

// One representative fixture per language family, chosen small-to-medium so the
// qwen3:4b / rerank passes stay tractable, while still spanning the languages
// where the prior findings diverge (Go gains, JS regresses under rerank, etc.).
export const SUBSET = ['gin', 'express-js', 'django', 'spring', 'rust', 'alamofire'];

// All benchmark fixtures (dir name === evaluate.mjs --suite id).
export const FIXTURES = [
    'axios', 'express-js', 'nestjs', 'fastapi', 'gin', 'react', 'django', 'rust',
    'spring', 'android', 'aspnet', 'rails', 'laravel', 'symfony', 'css', 'cjson',
    'nvm', 'alamofire',
];
