# Improvement: learned-sparse vocabulary-expansion channel (B3)

An **opt-in, zero-dependency, air-gapped** learned-sparse retrieval channel (SPLADE / uniCOIL
family): a learned model expands a query into a *weighted term set* — the literal terms plus learned
associates — and that expansion fuses as an extra sparse channel via RRF, closing lexical-gap misses
the Porter-stemming bridge structurally cannot (stemming only normalises morphology; it cannot
connect `auth` → `credential`/`token`). It is the **honest** version of B3: the capability ships, the
**measurement is reported in full**, and **lexical stays the default** because the learned channel
does not beat it on the strict benchmark.

- **Branch:** `feat/improvements` (Frontier — v2.1.0 milestone).
- **Files:** `search-sparse.mjs` (new — `buildSparseModel`, `expandSparseQuery`), `search-core.mjs`
  (`scoreSparseExpanded` shared scorer + `NL_SPARSE_WEIGHT` + the `sparseResults` fusion seam),
  `engine/{memory,sqlite}.mjs` (the isolated `sparse_model` artifact + `_searchSparseExpanded` +
  `hasSparseModel`), `config.mjs` (`--learned-sparse` / `INDEXER_LEARNED_SPARSE`), `indexer.mjs`
  (build + serialize), `test/sparse.mjs` (7 tests).

## The air-gapped realisation: corpus-learned, not a neural model

A canonical SPLADE needs a masked-LM model (and `@huggingface/transformers` + a multi-hundred-MB
download), which **cannot be measured air-gapped** and would violate the zero-dependency default. So
the shipped provider **learns the term associations FROM THE CORPUS** at index time via positive
pointwise mutual information (PMI) over chunk co-occurrence:

```
PMI(a,b) = log2( cooc(a,b)·N / (df(a)·df(b)) )      # kept when > 0, top-K per term
```

It is genuine learned-sparse — *learned per-term weights + vocabulary expansion* — with **zero new
dependency**, fully deterministic, and measurable on the honest `test:eval`. A neural SPLADE provider
is a clean future drop-in behind the same `expandSparseQuery` seam (it would replace the PMI model
with MLM logits and serialise into the identical `sparse_model` artifact).

## Design — presence-gated, NL-asymmetric, parity-by-construction

- **Opt-in + isolated.** The model is built ONLY with `--learned-sparse` and serialised as an
  isolated artifact (`sparse_model` — a memory JSON key / a single-row sqlite table), exactly like
  centrality/taint/scip_refs. It **cannot perturb the lexical postings**; a default index has no
  model → the channel is inert → **byte-identical** (proven by `test:eval` + a dedicated test).
- **NL-asymmetric.** The channel fires only for natural-language queries (`isNaturalLanguageQuery`)
  *and* only when an association actually fires — symbolic/exact lookups skip it entirely, mirroring
  the stemming bridge. The sparse channel carries the ASSOCIATE terms only (the literal terms already
  drive the lexical channel), so it is a pure vocabulary-EXPANSION view.
- **Parity by construction.** Scoring is delegated to a shared `scoreSparseExpanded` over the
  *existing* BM25 postings; both backends call it through their own postings accessors, and the
  expansion map is built in a deterministic order, so the float sums — and the ranked output — are
  byte-identical across memory ↔ sqlite (enforced by `test/sparse.mjs`).

## Measurement (honest — this is the point)

In-process A/B over the five core eval suites (load each fixture's existing default index, inject the
PMI model built from its own chunks, score the suite queries with vs without it — never rebuilding,
so the on-disk baseline is untouched). Strict rank-1 / success@5, split symbolic vs semantic, swept
across the fusion weight:

| `NL_SPARSE_WEIGHT` | semantic s@5 | semantic r1 | symbolic r1 (guard) | overall s@5 |
|--------------------|--------------|-------------|---------------------|-------------|
| baseline (off)     | **57.4**     | 24.1        | 74.7                | **83.5**    |
| 0.5                | 51.9 ⬇       | 27.8 ⬆      | 74.1                | 81.1 ⬇      |
| 0.3                | 55.6 ⬇       | 25.9        | 74.1                | 82.5 ⬇      |
| **0.2 (shipped)**  | **57.4 =**   | **24.1 =**  | **74.7 =**          | 83.0        |
| 0.1                | 57.4 =       | 22.2 ⬇      | 74.7                | 83.5        |

**The learned-sparse channel does not beat the lexical baseline at any weight.** Higher weights
REGRESS semantic s@5 — the co-occurrence associates add noise that buries correct hits (axios
semantic s@5 90.9→72.7, gin 83.3→33.3 at weight 0.5); the best case is ≈neutral at 0.2 (semantic and
symbolic rank-1 both exactly preserved). The benchmark fixtures are well-named, lexically-aligned code
where the literal query already matches the target — the regime where vocabulary expansion has the
least to add and the most noise to introduce.

This is the same result the engine has reached honestly before (**BM25F**, **AST def-boost**, the
**code-embedding NL weight** — all measured net-negative-to-neutral, all shipped *nothing as
default*). Per the **honest-metrics** and **sacred-default** invariants, **lexical remains the default
and `--learned-sparse` is opt-in.**

## What ships, and why it is not a placebo

B3 ships the **capability**, not a forced win:

- The shipped `NL_SPARSE_WEIGHT = 0.2` is the **measured least-harmful active setting** — on the
  benchmark it leaves semantic and symbolic rank-1 untouched, so opting in never regresses the cases
  that matter, and it surfaces the occasional expansion-only recall hit.
- The model build is **real and air-gapped** (corpus PMI, zero dependency, deterministic, parity-safe)
  and serialises into a clean artifact a neural SPLADE provider can later reuse byte-for-byte.
- A repo with **genuine query/code vocabulary mismatch** (where users search with domain words the
  code never spells out) is exactly the regime the benchmark fixtures lack — such a corpus may see the
  recall win the strict suite does not. The honest guidance: **opt in, measure on YOUR repo.**

So: opt-in (`--learned-sparse`, default off), default index/path byte-identical, lexical the measured
winner and the default. The honest deliverable is the working, air-gapped infrastructure + the
reported finding — not a tuned benchmark number.

## Honest scope / next

- The channel only fires on NL queries (≥5 words) — short keyword/symbol queries never expand.
- The association model is whole-program; the watch daemon drops it on a per-file edit (refreshes on
  the next full `idx-index`), degrading gracefully to lexical (never worse).
- A neural SPLADE/uniCOIL provider behind `expandSparseQuery` (MLM logits instead of PMI) is the
  natural next layer — but it must clear the honest `test:eval` bar, which this corpus-learned model,
  over these fixtures, does not.
