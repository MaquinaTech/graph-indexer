# Improvement: symbol-level centrality (A5)

An **opt-in** structural feature that rides on the A4 symbol graph: at index time, score every
symbol by a **confidence-weighted PageRank over the resolved chunk→chunk edges**, so an agent can
ask "how central is this symbol to the program?" and orient by the codebase's actual hubs — not
just its most-imported files.

- **Branch:** `feat/improvements` (Frontier Phase 2).
- **Files:** `mcp/centrality.mjs` (new — `computeSymbolCentrality`), `indexer.mjs` (compute +
  serialize when `--symbol-graph` is on), `engine/memory.mjs` + `engine/sqlite.mjs`
  (`centrality` storage, `hasCentrality`/`getCentrality`/`topCentral`, daemon invalidation),
  `storage.mjs` (contract), `mcp/tools.mjs` (`explain_symbol` + `get_repo_map` surfacing),
  `test/edges.mjs` (8 tests).

## What it is — and what it is *not*

A5 is **not** the existing PageRank. `search-core.mjs` `computePageRank` ranks **files** over the
import graph; it drives enrichment selection and the `get_repo_map` *file* ordering. A5 ranks
**symbols (chunks)** over the A4 **resolved** call/extends/type graph. It is symbol-granular and
call/type-aware, where the file PageRank is import-aware. The two are complementary and live in
different modules so neither drifts into the other.

## The model

Edges point **referencer → definition** (`from_chunk_id → to_chunk_id`), so PageRank mass flows
*into* definitions: a definition referenced by many *other central* symbols accumulates rank. That
is exactly "load-bearing hub."

- **Confidence weighting.** A `high` edge weighs `1.0`; a `name_only` edge (heuristic name match,
  no receiver/import evidence — noisier) weighs `0.5`. Multi-edges between the same `(from, to)`
  pair (e.g. a chunk that both calls *and* extends a target) sum their weights. These are fixed
  constants — no tuning knob, no config surface.
- **Node set** is every chunk that appears in *any* edge (the connected sub-graph). Isolated
  chunks are not ranked, so "rank N of M connected symbols" stays meaningful.
- **Algorithm.** Standard damped (`d = 0.85`) power iteration with uniform dangling-mass
  redistribution, bounded at 100 iterations. Scores are rounded to 8 decimals; **dense ranks** are
  assigned by score DESC, chunk-id ASC (the same tie-break the rest of the engine uses).

## Why parity is free

Centrality is computed **once at index time** — right after `buildSymbolGraph`, over the same
finalized chunks — and **serialized into the index**: a `centrality` object (`id → { score, rank }`)
in the in-memory JSON, or a `centrality(chunk_id, score, rank)` table in SQLite. Both backends then
read the *same* numbers, so `getCentrality` / `topCentral` are byte-identical cross-backend by
construction — there is no per-backend recomputation to diverge. Determinism within the single
index-time pass (sorted node set, fixed-order iteration, rounded scores, id-tie-broken ranks)
guarantees the serialized values are reproducible.

It never touches `searchHybrid`, so `npm run test:eval` and the search parity gate are unaffected.
With `--symbol-graph` off there is no centrality, the engines return `null`/`[]`, the serialized
index has no `centrality`, and every tool's output is unchanged.

## Store surface

- `hasCentrality()` → was it built?
- `getCentrality(chunkId)` → `{ score, rank, total } | null` (null for an unranked/isolated chunk).
- `topCentral(limit)` → `[{ chunk, score, rank }]`, rank-ascending — the program's hubs.

## Surfacing (no new tool — the surface stays at 14)

- **`explain_symbol`** attaches centrality to each definition card: JSON gets
  `{ score, rank, total }`; markdown appends `🎯 centrality #R/T`, tagged `(hub)` in the top decile.
- **`get_repo_map`** lists the most-central symbols on its **unfiltered** orientation view
  (`central_symbols` in JSON; a "Most central symbols" block in markdown).
- Both **omit** centrality entirely when `hasCentrality()` is false — the default path is untouched.

## Daemon staleness

Centrality is a whole-program quantity, so a per-file watch-daemon update **invalidates** it exactly
like the edges (memory nulls `_centrality`; SQLite `DELETE`s the `centrality` table). It returns on
the next full `idx-index`. Until then `getCentrality` is `null` and the tools simply omit it — never
wrong, only absent. Tested.

## Tests (`test/edges.mjs`, 8)

PageRank determinism (same input → byte-identical), hub-outranks-leaf, confidence weighting
(identical topology but the `high`-edge target scores higher), serialization round-trip + the three
store methods, **memory↔sqlite parity** (rank exact, score within 1e-9, `topCentral` order
identical), daemon invalidation, default-path gating, and the two tools surfacing/omitting it.

## Scope and next steps

A5 ships the **additive** centrality layer over A4. The plan's heavier graph analytics —
**betweenness** and **community detection** — are deliberately *not* shipped yet: PageRank
centrality is the clearly-valuable, low-risk slice, and the others should be measured for agent
value before adding surface. The remaining Phase 2 milestone is **A1** (precise resolution via
tree-sitter-stack-graphs), which adds an optional dependency and so requires a design review first.
