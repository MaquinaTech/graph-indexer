# Improvement: persistent resolved symbol graph (A4)

An **opt-in** structural feature: materialize a resolved **chunk→chunk** symbol graph at index
time and serve it through a new `getEdges` store method, instead of recomputing the call graph on
every query. It is the foundation for Phase 2's program-wide understanding (`impact_of_edit`,
symbol-level PageRank, precise resolution), and it leaves the default path untouched.

- **Branch:** `feat/improvements` (Frontier Phase 2).
- **Files:** `mcp/symbolgraph.mjs` (new — `buildSymbolGraph`), `config.mjs` (`--symbol-graph` /
  `INDEXER_SYMBOL_GRAPH`), `indexer.mjs` (build + serialize when on), `engine/memory.mjs` +
  `engine/sqlite.mjs` (edge storage, `getEdges`, edge-backed `findCallers`/`findReferers`,
  daemon invalidation), `storage.mjs` (contract), `test/edges.mjs` (6 tests).

## Model

Edge: `{ from_chunk_id, to_chunk_id, kind, confidence }` —
`kind ∈ {calls, extends, type}`, `confidence ∈ {high, name_only}`.

The call graph was previously **query-time only**: `classifyCallers(db, name)` scans for name-match
callers and buckets them high vs name-only on every call; there was no persistent resolved graph to
traverse. A4 runs that resolution **once at index time** and stores the result.

## How the edges are built (no logic duplication)

`buildSymbolGraph(db)` reuses the exact query-time resolvers:

- For every referenced-and-defined name, it calls `classifyCallers` (for `calls`) and
  `findReferences` (for `extends` / `type`), then emits one edge per (referencing-chunk →
  each-definition-chunk) pair, tagged with that resolver's confidence.
- Because it calls the same functions the MCP tools call, an edge's confidence is **identical** to
  what `get_call_graph` / `find_references` would report — there is no second copy of the
  resolution heuristics to drift.
- The edge list is emitted in a fixed total order (`from, to, kind, confidence`) and deduped by
  `(from, to, kind)` keeping the strongest confidence. A per-name cap guards pathological
  high-degree names and is **logged, not silent**.

At index time the indexer builds a throwaway in-memory store from the finalized chunks (so the
graph sees the same resolution — including the A3 `recv_resolved_type` if enabled), runs
`buildSymbolGraph`, and serializes the edges: a SQLite `edges` table, or an `edges` array in the
in-memory index JSON.

## getEdges, and the findCallers/findReferers migration

`getEdges(chunkId, { kind?, direction })` returns the incident edges (`'in'` = referrers of the
chunk = its precise blast radius; `'out'` = its referents), each with the resolved other-endpoint
chunk attached, in deterministic order.

`findCallers` / `findReferers` **read the graph when it is present and the name is defined**,
returning the *same* sets as the name-match scan (every name-match caller has an edge to each
definition of the name). When the graph is absent (default path) or the name has no in-repo
definition (e.g. a library call), they **fall back to the scan** — so behaviour is unchanged and an
undefined-symbol lookup never returns empty-by-edges.

### Why this is safe

- **Set-equivalence** is the load-bearing property and is tested directly: `findCallers` /
  `findReferers` edge-backed == scan, for defined, ambiguous, and undefined names.
- **Parity-free:** edges are serialized identically by both backends and `getEdges`/`findCallers`
  return the same deterministically-ordered results — `test/edges.mjs` asserts memory↔sqlite
  parity on getEdges tuples + caller/referer sets. Edges never touch `searchHybrid`, so
  `test:eval` and the search parity gate are unaffected.
- **Default byte-identical:** with the flag off there are no edges; the engines take the scan path,
  the serialized index has no `edges`, and nothing changes.

## Daemon staleness

A whole-program graph cannot be correctly maintained by per-file edits. So `applyFileUpdate` (the
watch-daemon path) **invalidates** the graph — memory drops `_edges`, SQLite `DELETE`s the `edges`
table — and `findCallers`/`findReferers` fall back to the always-correct scan until the next full
`idx-index` rebuilds it. This is "never worse than the default," and is tested.

## Scope and next steps

A4 ships the **additive** layer: edges + `getEdges` + the equivalence-preserving reader migration.
`classifyCallers` / `find_references` still compute confidence at query time (their output is
unchanged); the stored confidence powers `getEdges` and the Phase 2 milestones that build on it:

- **C1/C4 — `impact_of_edit` (shipped):** `buildImpact` (`mcp/topology.mjs`) does a reverse-direction
  transitive BFS over high-confidence referrers — `getEdges('in')` when the graph is present, else
  query-time `classifyCallers`/`findReferences` — and the `impact_of_edit` MCP tool composes that
  with affected routes, tests, and git co-change. A `hasSymbolGraph()` store predicate selects the
  fast path; both paths produce the same blast radius (tested).
- **A5 — symbol centrality (shipped):** `computeSymbolCentrality` (`mcp/centrality.mjs`) runs a
  confidence-weighted PageRank over these edges at index time, serializes `{ score, rank }` per
  chunk (parity-free, like the edges), and surfaces it through `explain_symbol` / `get_repo_map`.
  Betweenness / community detection are intentionally deferred. See
  `docs/internals/IMPROVEMENT_SYMBOL_CENTRALITY.md`.
- **A1 — precise resolution** (tree-sitter-stack-graphs) upgrading edge confidence `high → resolved`.
