# Phase 3 design — brief stubs: B3, B4, A2, D3

> **Status: DESIGN ONLY. Nothing here is implemented.** Brief stubs; F1 (sealed mode) and C2
> (taint) have their own detailed docs. Each item below states the idea, the seam in the current
> code, the air-gapped/opt-in story, and the main risk — enough to plan from, not to build from.

---

## A2 — LSP / SCIP resolver bridge

> **Status: IMPLEMENTED (v1, SCIP path).** `parse/scip.mjs` (`loadScip`, `buildScipBindings`,
> `normalizeScipPath`), `createScipResolver` in `mcp/resolver.mjs`, the `resolveEdges` consult in
> `mcp/symbolgraph.mjs`, `--resolver scip` / `--scip-index` in `config.mjs` + `indexer.mjs`,
> `test/scip.mjs` (8 tests). Two deviations from the sketch below: (1) the binding alignment also
> **suppresses** wrong-target fan-out (not just relabels), which is the main precision win and is
> still parity-free because it is opt-in + computed once + serialized; (2) the protobuf is decoded
> by a hand-rolled zero-dependency reader (no protobuf lib). The LSP-server variant remains future
> work. Full write-up: `docs/internals/IMPROVEMENT_SCIP_RESOLVER.md`.

**Idea.** The realistic, air-gapped backend for A1's resolver-provider seam. Ingest a **SCIP** index
(Sourcegraph's protocol; local indexers exist: `scip-typescript`, `scip-python`, `scip-java`,
`rust-analyzer --scip`) — or query a running LSP server — and emit truly cross-file-`resolved`
edges with real binding precision, beyond A1's "unambiguous name / typed receiver" heuristic.

**Why it matters.** It is the honest path to "literal A1" without an in-process Rust sidecar: the
user's own toolchain produces the `.scip` index out of band; graph-indexer just *consumes* a
protobuf. This is the most defensible precision upgrade we have.

**Seam.** `mcp/resolver.mjs` already defines the provider interface (`getResolver`). A2 adds a
`scip` provider; `parse/scip.mjs` (new) reads the SCIP protobuf and aligns SCIP symbol occurrences
to our chunk ids by `(file, range)`. `--resolver scip --scip-index path.scip`. The provider's
`confidenceFor` returns `resolved` when SCIP confirms the binding, else falls through.

**Stub (DESIGN).**
```js
// parse/scip.mjs — DESIGN
export function loadScip(path) { /* → SymbolOccurrence[] keyed by (file, startLine, startCol) */ }
// mcp/resolver.mjs — DESIGN: a 'scip' provider using the loaded occurrence map
```

**Air-gapped / opt-in.** Fully local (the SCIP file is generated on-box); opt-in flag; only changes
edge confidence → parity-free, default byte-identical, like A1.

**Risk.** SCIP language coverage varies; the hard part is **chunk-id alignment** (SCIP ranges ↔ our
AST chunks) and staleness (a `.scip` older than the index). Effort: medium.

---

## B3 — Learned sparse retrieval (SPLADE / uniCOIL style)

**Idea.** A learned model expands a query/document into a *weighted term set* (term → importance),
fused into the existing BM25 inverted index. Still sparse retrieval — the engine's home turf — but
with learned weights and vocabulary expansion that close lexical-gap misses the Porter-stemming
bridge can't.

**Seam.** `search-core.mjs` `buildLexicalDocument` + a learned-expansion provider; the postings
table already stores per-term `tf`, so it generalises to learned weights. `fuseAndRank` already does
RRF, so the learned-sparse channel fuses like the dense one.

**Stub (DESIGN).**
```js
// a learned-sparse provider — DESIGN
export function expandSparse(text) { /* → Map<term, weight> */ }
```

**Air-gapped / opt-in.** Local ONNX/transformers model (the optional `@huggingface/transformers`
dep already in the tree); opt-in provider mirroring embeddings. Default lexical path untouched.

**Risk.** Model size + indexing cost; must beat the **honest** BM25+stemming baseline on
`npm run test:eval` (per the honest-metrics constraint), not a friendly suite. Effort: medium-large.

---

## B4 — ColBERT late-interaction retrieval

**Idea.** Multi-vector per chunk (token-level embeddings) + MaxSim late interaction — markedly higher
recall than single-vector dense, especially for compositional queries.

**Seam.** `engine/binary.mjs` already owns the on-disk vector layout with lazy/sketch thresholds —
the scaffold for storing N token-vectors per chunk. `embeddings.mjs` adds a multi-vector encoder
provider; a `maxSim(qVecs, dVecs)` scorer fuses via RRF in `fuseAndRank`.

**Stub (DESIGN).**
```js
// embeddings.mjs / engine/binary.mjs — DESIGN
export function encodeMultiVector(text) { /* → Float32Array[] (one per token) */ }
export function maxSimScore(qVecs, dVecs) { /* → number */ }
```

**Air-gapped / opt-in.** Local encoder; gated behind `--embeddings-colbert` with a loud storage-cost
notice. Default path untouched.

**Risk.** **Storage blow-up** (tokens × dim × chunks) and query latency — must reuse the existing
lazy/sketch path and a binary-quantized token store, and document the cost honestly. Effort: large.

---

## D3 — Learned ranker (learning-to-rank)

**Idea.** Replace the hand-tuned RRF/weight fusion with a learned model (gradient-boosted trees or a
tiny linear model) over features the engine **already computes**: BM25, dense similarity,
stem-overlap, the NL-gated path-IDF signal, git recency/churn, and now **A5 centrality**. Learn the
weights from the benchmark's labelled query→chunk pairs instead of tuning them by hand.

**Seam.** `search-core.mjs` `fuseAndRank` — add a `learned` fusion mode that scores a feature vector
with shipped coefficients; inference is a dot product / small tree ensemble → **zero runtime deps**.
Training is an offline script (not shipped at runtime). A5 centrality becoming a ranking feature is
a clean cross-link from Phase 2.

**Stub (DESIGN).**
```js
// search-core.mjs — DESIGN
export function scoreLearned(features) { /* → number; features include bm25, dense, stem, pathIdf, git, centrality */ }
// offline: train-ranker.mjs (NOT shipped) → emits a small model file loaded at query time
```

**Air-gapped / opt-in.** Train offline; ship a tiny model (coefficients); query-time inference is
pure arithmetic — no network, no model server. Opt-in fusion mode; RRF stays the default.

**Risk.** **Overfitting the small held-out benchmark** (the standing honest-metrics concern) — must
hold out cleanly and report per-language deltas, not a pooled number. Strong fit with the existing
eval harness, which is exactly the discipline needed to keep it honest. Effort: medium.

---

## Sequencing note

F1 and C2 are the headline Phase 3 bets (guarantee + flagship security tool). Of these stubs, **A2
is the most strategically aligned** — it completes the A1 resolver story with a real cross-file
backend and unlocks higher-fidelity edges that C2 (taint) and D3 (centrality-as-feature) both
consume. B3/B4/D3 are retrieval-quality bets that must each clear the honest `test:eval` bar before
shipping; B4 carries the largest cost/complexity risk.
