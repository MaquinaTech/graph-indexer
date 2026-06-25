# Improvement: ColBERT-style late-interaction reranker (B4)

An **opt-in, air-gapped, zero-storage-blow-up** late-interaction reranker — the multi-vector
**MaxSim** idea from ColBERT, deployed as a third reranker provider
(`--rerank-provider late-interaction`) alongside the generative judge and the cross-encoder (B2).
A single-vector dense channel pools the query and each document into ONE vector, losing *which part
matched where*; late interaction keeps **multiple** vectors per side and scores them with MaxSim:

```
score(q, d) = Σ_{qi}  max_{dj}  cos(qi, dj)
```

— every query sub-vector finds its best-matching document sub-vector and the hits sum, the
compositional-query win ColBERT is known for.

- **Branch:** `feat/improvements` (Frontier — v2.1.0 milestone).
- **Files:** `colbert.mjs` (new — `maxSimScore`, `loadChunkVectors`, `encodeMultiVector`,
  `rerankLateInteraction`), `engine/binary.mjs` (`collectVectorsByKey`), `engine/{memory,sqlite}.mjs`
  (`embeddingBinPath()`), `config.mjs` (`late-interaction` rerank provider), `mcp/tools.mjs` +
  `test/evaluate.mjs` (dispatch), `test/colbert.mjs` (7 tests).

## No storage blow-up — it reuses the doc vectors the engine already stores

The canonical ColBERT cost is **storage** (tokens × dim × chunks). graph-indexer sidesteps it
entirely: the engine **already** stores multiple vectors per chunk — the base content vector plus a
`|s` summary vector plus up to `EMBEDDING_MAX_WINDOWS` `|wN` window vectors (created for oversized
chunks). The single-vector channel already max-pools them against one query vector
(`finalizeVectorCandidates`). B4 adds the missing half — a **multi-vector QUERY** and **full MaxSim**
— over those already-stored document sub-vectors. So a `--learned-sparse`-style new artifact is *not*
needed; `loadChunkVectors` reads a candidate's existing sub-vectors from the shared `.embeddings.bin`
in one pass.

## Design — a reranker (retrieve-then-late-interact), parity-by-construction

Deploying late interaction as a **reranker** over the over-fetched candidate pool (the standard
ColBERT serving pattern) is what keeps it safe and cheap:

- **Default path byte-identical.** It only runs when reranking is explicitly enabled *and*
  `provider === 'late-interaction'`; like the other rerankers it is a post-retrieval re-order, so the
  fused ranking and `db.searchHybrid` are untouched. It also **never mutates `r.score`** (protects the
  git-boost / formatting), and degrades to the original order on any shortfall (no embedder, no doc
  vectors, <2 scorable candidates) — it can only help, never corrupt.
- **Parity-by-construction.** `loadChunkVectors` reads the candidate sub-vectors from the *same*
  `.embeddings.bin` both backends share (`db.embeddingBinPath()` → `collectVectorsByKey`), and MaxSim
  is order-independent — so the reranked order is identical across memory ↔ sqlite without any
  per-backend code.
- **Air-gapped.** The query multi-vectors come from the SAME local embedder the dense channel uses
  (`encodeMultiVector`: the whole query plus its content sub-units) — no new model, no network.

## Measurement (honest — at production retrieval depth)

`npm run test:eval -- --suite <fx> --embeddings` (dense baseline) vs the same `+ --rerank
--rerank-provider late-interaction`, on real Ollama (`nomic-embed-text`) indexes. A reranker can only
re-order the candidate pool it is handed, so the measurement must use the **same over-fetch depth as
production** — `mcp/tools.mjs` retrieves a pool of 15 and reranks the top 12. The harness defaults to
a shallower pool (10 / topM 8); an early run at that depth manufactured a *false* JS regression
(express s@5 0.57→0.43) that vanishes once the pool matches production. The honest numbers below are
at `RETRIEVE_K=15 RERANK_TOPM=12` (production-equivalent):

| fixture | overall rank-1 | semantic rank-1 | semantic s@5 | symbolic rank-1 (guard) |
|---------|----------------|-----------------|--------------|--------------------------|
| **gin** (Go)        | 0.68 → **0.77** ⬆ | 0.00 → **0.40** ⬆ | 1.00 → 0.95 | 0.88 → 0.88 = |
| **express-js** (JS) | 0.65 → 0.65 = | 0.43 → 0.43 = | 0.57 → 0.57 = | 0.75 → 0.75 = |

**At production depth B4 helps Go and is neutral on JavaScript** — it rescues deep semantic hits on
`gin` (semantic rank-1 0.00→0.40, overall **+9pts**, with **no symbolic regression**) and leaves
`express-js` unchanged on every metric (semantic MRR 0.52→0.53). This is the "helps Go/Python" half of
the known reranker profile (CLAUDE.md) **without** the JavaScript regression the other rerankers show
and that the under-fetched harness falsely attributed to it. (`n` is small — gin semantic n=5, express
n=7 — so these are directional, per the standing small-n caveat.)

Even so, it does not *uniformly* beat the baseline across languages, and like every reranker here it
needs a query-time model, so it stays **opt-in, default off**, with the trade-off printed at startup
(`configNotices`) — the engine's honest-metrics tradition: ship the *capability*, measure it honestly
at the depth production uses, and let users measure on their own repo.

## Honest scope / next

- **Approximate ColBERT.** A true ColBERT uses a token-level *contextual* encoder; this uses a
  sentence embedder over query sub-units, so the query "tokens" are coarser than real ColBERT tokens.
  A token-level ColBERT model is a clean future drop-in behind `encodeMultiVector` (the MaxSim
  scorer, the doc-vector store, and the rerank seam all stay).
- **Doc multi-vectors come for free only where they exist** — small chunks have a single vector, so
  the late-interaction signal is strongest on large chunks (more windows) and compositional queries.
- It requires `--embeddings` (the doc vectors + the embedder); without them it is a no-op.
- Like the other rerankers, it fires only on natural-language queries (the over-fetch + NL gate in
  `mcp/tools.mjs`), so symbolic/exact lookups are unaffected except where a symbolic query is phrased
  as a long NL sentence.
