# Improvement: learned re-ranker (D3)

An **opt-in, zero-dependency, trainable** learning-to-rank layer that re-orders the fused top-N with
a small linear model over features the engine already computes — the RRF fused score plus the
program-structure signals A4/A5/A1 added (symbol **centrality**, **resolved**/SCIP **in-degree**) and
git recency. It is the honest version of D3: the capability ships, the **measurement is reported in
full**, and **RRF stays the default** because the learned model does not beat it on the benchmark.

- **Branch:** `feat/improvements` (Frontier Phase 3 — the last v2.1.0 milestone).
- **Files:** `search-core.mjs` (`RANKER_FEATURES`, `extractRankerFeatures`, `scoreLearned`,
  `learnedRerank`, `DEFAULT_RANKER_MODEL`), `config.mjs` (`--ranker` / `INDEXER_RANKER`),
  `mcp/tools.mjs` + `mcp-server.mjs` (search_code over-fetch + re-rank), `test/evaluate.mjs`
  (`--ranker learned` for measurement), `bench/train-ranker.mjs` (offline trainer, **not shipped**),
  `test/ranker.mjs` (6 tests).

## Design — post-fusion, like the git boost / LLM reranker

The model is a **post-fusion re-rank**: `fuseAndRank` (RRF + the heavily-tuned boost ladder) runs
untouched and produces the fused pool; only when the caller opts in (`config.ranker === 'learned'`)
does `learnedRerank` re-order an over-fetched pool of that output. This is deliberately the same
seam the git boost and the LLM reranker use — *the tool layer, never inside `db.searchHybrid`* — so:

- **the default RRF ordering is byte-identical** (`learnedRerank` is never called under `rrf`);
- **measured retrieval stays honest** (the re-rank is visible and opt-in, not baked into the core);
- **parity holds** — inference is a deterministic dot product (ties broken on id), and both backends
  feed it identical features through the same accessors.

`score = bias + Σ wₖ·fₖ` over eight features: `rrf` (normalised fused score), `rank` (1/(1+pos)),
`centrality` (A5), `in_degree` + `resolved_in` (A4/A1 resolved-edge in-degree), `git` (recency),
`is_def`, `is_test`. The structure features are **zero without `--symbol-graph`**, so on a plain
index the model degrades to RRF + git + node-type.

## Measurement (honest — this is the point)

The offline trainer (`bench/train-ranker.mjs`, zero-dep logistic regression) was run over all five
default eval fixtures **built with `--symbol-graph`** (so the structure features are populated):
**3 161 candidates, 410 positives**. Trained on the tuning queries, scored on the **95 held-out
queries** (grouped per query — an early version chunked rows by a fixed pool size and mis-grouped the
9 short queries, reporting a spurious 0.564; the corrected per-query grouping is below):

| ranker | held-out rank-1 |
|--------|-----------------|
| RRF-only (`rrf` weight = 1) | **0.579** |
| fully data-fit learned model | 0.579 |

**The learned model does not beat RRF — it ties it.** The fit assigns the program-structure features
near-zero weight (`centrality ≈ 0.04`, `resolved_in = 0`) because, on symbol-retrieval, **the correct
symbol is usually *not* the most central / most-called one** — a specific handler, not the hub. RRF
(which already fuses lexical + vector + the boost ladder) is the signal; the structure features are
noise *for this task*. A tie gives **no reason to adopt a more complex, slower ranker** over the
proven default.

This is the same result the engine has reached honestly before (BM25F, AST def-boost, the
code-embedding NL weight — all measured net-negative, all shipped *nothing as default*). Per the
**honest-metrics** and **sacred-default** invariants, **RRF remains the default ranker.**

## What ships, and why it is not a placebo

D3 ships the **capability**, not a forced win:

- The **shipped `DEFAULT_RANKER_MODEL` is conservative and RRF-dominant** (`rrf` 1.0, `rank` 0.3,
  structure features ≈0.04 each, `is_test` −0.2). Measured under `--ranker learned` on the five
  fixtures, it is **byte-identical to RRF** (same rank-1 / MRR / success@5 on every suite) — a safe,
  never-regressing opt-in.
- The **offline trainer is real** and produces *repo-specific* models. A user whose codebase *does*
  carry signal in its call structure (where the central, heavily-called symbols are the ones queries
  target) can `node bench/train-ranker.mjs` over their own `--symbol-graph` index and ship the
  emitted coefficients. The generic benchmark simply isn't that kind of corpus.
- Inference is a **dot product** — zero runtime dependency, no model server, air-gapped,
  deterministic, parity-safe. The model is a frozen literal in `search-core.mjs` (no file load); a
  custom model is a one-line constant swap.

So: opt-in (`--ranker learned`, default `rrf`), default index/path byte-identical, RRF the measured
winner and the default. The honest deliverable is the trainable infrastructure + the reported
finding — not a tuned benchmark number.

## Honest scope / next

- The structure features need `--symbol-graph`; without it the model is RRF + git + node-type only.
- The benchmark is small (95 held-out queries across five fixtures) — but the held-out result (an
  exact tie) and the independent feature-weight analysis (structure weights ≈ 0) point the same way.
- A richer feature set (query-term-in-name overlap, sibling-distance, an embedding-similarity term
  when vectors are on) or a pairwise (LambdaMART-style) objective could revisit this — but only if it
  clears the honest `test:eval` bar, which this linear model over these features does not.
