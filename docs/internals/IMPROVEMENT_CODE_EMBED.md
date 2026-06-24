# Code-specialized embeddings — and why the NL vector-weight re-tune was rejected (B1)

Frontier Phase 1 explored whether a **code-specialized embedding model** (e.g. `qwen3-embedding`)
should let the dense (vector) channel earn **more weight** on natural-language queries than the
general-purpose default does. The hypothesis: the existing low NL vector weight
(`NL_VECTOR_WEIGHT_PLAIN = 0.4`) was tuned for weak raw-code vectors from `nomic-embed-text`, so a
stronger code embedder deserves more.

**Outcome: the embedder helps (sometimes); the weight re-tune does not.** We measured it honestly,
found no recall@5 benefit from raising the weight, and **shipped no ranking change** — only
documentation. This note records the measurement so the dead end is not re-explored.

- **Branch:** `feat/improvements` (Frontier Phase 1).
- **Shipped:** documentation only (`README.md`, `CHANGELOG.md`) — code embedders are now a
  documented, measure-first opt-in via `--embed-model`. No change to `search-core.mjs` or the
  engines.
- **Not shipped (reverted):** a `--vector-weight-profile code` flag + raised NL vector weights.

## Method

Each fixture was re-embedded cleanly with `qwen3-embedding:16k` (a code-relevant Qwen3 embedder,
2560-dim) and scored with `test/evaluate.mjs --suite <f> --embeddings`. A temporary, opt-in weight
profile threaded a `vectorWeightProfile` through `fuseAndRank` and both backends; the
natural-language plain-corpus vector weight was swept `0.4 → 1.2` on one code-embedded index per
fixture (an A/B that isolates the weight from the embedding). The benchmark indexes carry no
enrichment, so the sweep tuned the plain-corpus weight.

> **Cache gotcha (cost us a first run).** The indexer reuses cached vectors keyed by content hash
> and only re-embeds when the embed-meta sidecar's *model name* changes. A prior run had stamped
> `qwen3-embedding:16k` in the meta but the cached vectors were 768-dim (an earlier model/dim);
> fresh query vectors were 2560-dim, so the dim mismatch silently no-op'd the vector channel to
> lexical-only. **When measuring a model change, delete `code-index.embeddings.bin{,.meta.json}`
> first** to force a clean re-embed.

## Results

Semantic = agent-style behavioural queries (small-n: gin 5, django 6, express 7 — directional).

| fixture | lexical semantic (r1 / MRR / s@5) | qwen3 @ default weight 0.4 | weight sweep 0.5 → 1.2 |
|---------|-----------------------------------|----------------------------|------------------------|
| **gin** (Go)      | 0.20 / 0.41 / 1.00 | **0.40 / 0.67 / 1.00** (embedder helps) | rank-1 falls to 0.20; **s@5 flat 1.00** |
| **django** (Py)   | 0.33 / 0.57 / 0.83 | 0.33 / 0.51 / 0.83 (neutral)             | **s@5 flat 0.83**; symbolic r1 0.72 → 0.61; held-out sem s@5 0.71 → 0.57 |
| **express-js** (JS) | 0.43 / 0.50 / 0.57 | 0.43 / 0.51 / 0.57 (neutral)           | flat / slightly worse |

Two separate conclusions:

1. **The code embedder itself** lifts agent-style recall on Go (gin rank-1 +0.20, MRR +0.26) but
   is neutral on Python and JavaScript. That benefit is available today via `--embed-model
   qwen3-embedding` at the **default** weight — it needs no ranking change.
2. **Raising the NL vector weight is refuted.** Across the full sweep, recall@5 never moves (gin
   1.00, django 0.83 throughout); rank-1 is flat-to-negative and symbolic precision regresses at
   higher weights. The measured optimum is ≈0.4 — *identical to the current default*.

## Why the weight re-tune fails

It is consistent with the original tuning rationale in `search-core.mjs`. On these benchmarks the
correct answer is usually reachable lexically (BM25), so the vector channel's role is **low-weight
rescue** — surfacing the few cases lexical misses. At weight 0.4 recall@5 is already saturated
(gin 1.00). Raising the weight cannot improve recall that is already maxed; it only lets a
confident-but-wrong vector neighbour **displace a correct lexical rank-1**, which is exactly the
rank-1 / symbolic regression observed. A stronger embedder produces better neighbours but does not
change this structural role on lexical-friendly corpora.

## What would change the conclusion (not pursued)

- **Enriched corpora.** With LLM summary vectors, the vector channel speaks the vocabulary of
  behavioural queries and may earn more weight. We could not test this (no enriched code-embed
  index; enrichment is slow) and did not ship a knob on speculation.
- **Larger semantic sets.** 5–7 queries/fixture is directional; a broader held-out set could move
  rank-1 numbers. recall@5, the more stable metric, was flat — so this is unlikely to flip the
  verdict.

If revisited, gate any new weight strictly behind an opt-in profile and re-run this A/B; do not
raise a default weight on the strength of a single embedder.
