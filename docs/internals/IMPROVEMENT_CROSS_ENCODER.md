# Improvement: local cross-encoder reranker provider (B2)

An **opt-in** second reranker provider that reorders the over-fetched candidate pool with a local
**cross-encoder** instead of (or before) the generative LLM judge. It is air-gapped, deterministic,
and fast — a reranker with **no LLM in the loop** — and captures part of the generative judge's
semantic lift.

- **Branch:** `feat/improvements` (Frontier Phase 1).
- **Files:** `enrichment.mjs` (`rerankCrossEncoder`, `crossEncoderScore`, `crossEncoderCandidateText`,
  `_crossEncoderPipeline` + `_resetCrossEncoderPipeline`), `config.mjs` (`rerank.provider` +
  `rerank.crossEncoderModel`; resolution, `describeConfig`, `configNotices`), `mcp/tools.mjs`
  (provider dispatch in the existing rerank block), `test/evaluate.mjs` (`--rerank-provider` for
  measurement), `test/unit.mjs` (4 injectable-scorer tests). `@huggingface/transformers` stays an
  *optional* dependency (already present for the in-process embedder); the import is lazy.

## Design

The generative judge (`rerankResults`) prompts an LLM for a permutation of the candidates. A
cross-encoder is a different shape: it **scores each (query, candidate) pair** with a small
sequence-classification model and sorts by score. Rather than overload `rerankResults`, B2 adds a
**sibling** `rerankCrossEncoder(query, results, {scorer, topM})` so each function keeps an honest
contract (the generative path is left byte-for-byte untouched). Provider selection happens at the
call site in `mcp/tools.mjs`, exactly mirroring how `ollamaGenerate`/`mlxLmGenerate` are chosen.

Key properties:

- **Deterministic:** sort is score-DESC with ties broken on `chunk.id` ASC. The scorer is a pure
  function of (query, candidate text), so the reorder is reproducible.
- **Parity-safe:** reranking is a tool-layer reorder of an already-identical pool — it is not a
  store query, so memory↔sqlite parity is untouched. (`test/sqlite.mjs` is unaffected.)
- **Never mutates `score`:** the downstream git-boost branch assumes rerank only reordered and left
  the fused score intact; `rerankCrossEncoder` honours that (a unit test guards it).
- **Best-effort:** any scorer failure / wrong-length / non-finite / wrong-type output returns the
  original order — never an error.
- **Default path untouched:** `rerank.provider` defaults to `generative` and reranking is off by
  default, so `npm run test:eval` is byte-identical and the optional transformers package is never
  loaded.
- **Candidate text** mirrors the generative judge's candidate line (name + class + summary →
  docstring → snippet) so both providers judge comparable evidence.

## Measurement (honest)

Core suites, **lexical channel** (no embeddings), reranker reordering the top-8 of the lexical
top-10 on natural-language queries. Cross-encoder = `Xenova/ms-marco-MiniLM-L-6-v2`; generative =
`qwen-coder-7b` (local Ollama). Semantic sets are small-n (5–7 queries/suite) — directional.

**Agent-style (semantic) channel, 31 queries pooled:**

| | rank-1 | MRR | s@5 | symbolic rank-1 |
|---|--------|-----|-----|-----------------|
| no rerank (baseline) | 0.19 | 0.35 | 0.65 | 0.80 |
| **cross-encoder** | **0.26** | **0.41** | 0.65 | 0.76 |
| generative (7B judge) | **0.42** | **0.53** | 0.68 | 0.80 |

**Held-out (validation):** semantic rank-1 0.30 → **0.35** (cross-encoder) / 0.30 (generative);
held-out s@5 0.48 → **0.52** (both); held-out symbolic rank-1 0.68 → 0.72 (cross-encoder).

**Per-suite semantic rank-1:**

| suite | baseline | cross-encoder | generative |
|-------|----------|---------------|------------|
| gin (Go)      | 0.20 | **0.40** | 0.80 |
| fastapi (Py)  | 0.14 | **0.29** | 0.43 |
| axios (JS)    | 0.00 | 0.20 | 0.40 |
| express (JS)  | 0.43 | 0.29 | 0.29 |
| nestjs (TS)   | 0.14 | 0.14 | 0.29 |

## Verdict

- The **cross-encoder is a real, measured improvement** over no-rerank on the target metric
  (semantic rank-1 +0.07 pooled, +0.05 held-out; s@5 +0.04 held-out), strongest on Go/Python.
- It is **weaker than the generative 7B judge** (which roughly doubles the pooled semantic rank-1
  and does not wobble symbolic) — so the generative judge stays the higher-reasoning tier.
- Its value is **what it removes**: no LLM, no Ollama/daemon, deterministic output, ~tens of ms per
  query (after a one-time ~model download). It is the reranker for air-gapped / no-LLM setups.
- Honest downsides: the per-suite picture is mixed on JavaScript (the usual reranker behaviour),
  and a few long *symbolic* queries pass the NL gate and get reranked, causing a small symbolic
  wobble (pooled 0.80 → 0.76, though held-out symbolic rose 0.68 → 0.72 — small-n noise).

Shipped opt-in behind `--rerank-provider cross-encoder`; default unchanged.
