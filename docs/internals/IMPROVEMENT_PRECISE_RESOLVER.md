# Improvement: precise resolver provider (A1)

An **opt-in** resolver provider for the A4 symbol graph. The default `heuristic` provider keeps
edge confidence exactly `{ high, name_only }`. The opt-in `precise` provider adds a third,
stronger tier — **`resolved`** — for edges whose binding is *provably unambiguous*, and an
`impact_of_edit` **precision dial** that can follow only those edges for a false-positive-free
blast radius.

- **Branch:** `feat/improvements` (Frontier Phase 2 — the last Phase 2 milestone).
- **Files:** `mcp/resolver.mjs` (new — `getResolver`, `CONFIDENCE_RANK`, `strongerConfidence`),
  `mcp/topology.mjs` (`classifyCallers`/`findReferences` gain a `proven` flag; `buildImpact` gains
  `precision`), `mcp/symbolgraph.mjs` (applies the resolver; rank-aware dedupe), `config.mjs`
  (`--resolver` / `INDEXER_RESOLVER`), `indexer.mjs` (selects the provider), `mcp/centrality.mjs`
  (`resolved` weight), `mcp/tools.mjs` (`impact_of_edit(precision)`), `test/edges.mjs` (5 tests).

## The confidence model

| tier | meaning |
|------|---------|
| `resolved` | **unambiguous binding** — there is no question which definition it is: a *sole definition* (no same-named rival), or a *type-pinned receiver* (typed receiver / the A3 fixpoint / `this.m()` in the defining class / explicit target class). Type-resolved → immune to name shadowing. |
| `high` | ambiguous name, disambiguated by import or proximity (likely, not proven). |
| `name_only` | ambiguous name, no evidence. |

The key realisation: `classifyCallers` already computes *why* each edge is `high` (its `reason`),
and several of those reasons are unambiguous bindings — they were just collapsed into one bucket.
A1 surfaces that distinction. `classifyCallers` / `findReferences` now also return a `proven`
boolean (true for sole-definition / type-match / this-in-class / explicit-target-class; false for
import / same-file), and the `precise` provider promotes `proven && high → resolved`.

## Why it is additive and parity-free

The resolver only changes the **`confidence` string** on edges that already exist — it never adds,
drops, or reorders an edge. So:

- **Set-equivalence holds:** `findCallers` / `findReferers` ignore confidence and return the same
  chunks as before (and the same as the name-match scan).
- **Parity is free:** confidence is already serialized; both backends round-trip the `resolved`
  tier identically (`test/edges.mjs` asserts memory↔sqlite getEdges confidence parity).
- **Centrality is unperturbed:** `resolved` is a precision refinement of `high` and carries the
  same A5 PageRank weight (1.0), so enabling the resolver does not change centrality scores.
- **Default byte-identical:** with `heuristic` (default) no edge is ever `resolved`; the dedupe now
  keeps the *strongest* confidence (`resolved > high > name_only`), which on the default path is
  the same `high`-wins result as the prior keep-first dedupe.

Measured on the repo's own source: of 325 `high` calls/refs edges, **303** are provably
unambiguous (→ `resolved`) and 22 remain heuristic `high`; the 28 `name_only` edges are never
promoted; the edge count is unchanged (353).

## The payoff: `impact_of_edit(precision)`

A promotion that is treated identically everywhere would be a no-op, so the `resolved` tier drives
a real dial:

- **`standard`** (default) — follow the high-confidence closure (`resolved` + `high`): the usual
  blast radius.
- **`strict`** — follow **only `resolved`** edges: the type/uniqueness-proven closure, a
  *false-positive-free* "what definitely breaks." With no symbol graph it follows the `proven`
  query-time callers, so it degrades gracefully.

`test/edges.mjs` proves the narrowing: seeding an ambiguous symbol (`format`) and a unique one
(`getId`), `standard` impacts both `handle` and `Admin`, while `strict` keeps `handle` (reached by
a `resolved` edge through `getId`) and drops `Admin` (reached only by a `high` `format` edge).

## Honest scope — what A1 v1 does *not* do

A1 ships the unambiguous-binding tier the engine can already prove from index-time signals. Two
layers are deliberately deferred because they need per-language AST/scope analysis or an external
toolchain that does not fit the air-gapped default:

1. **Shadow refutation** — re-parsing a chunk to detect a *local variable that shadows an import*
   and *refuting* the (currently `high`) edge. This is net-new precision (suppressing false edges,
   not just relabelling) but requires per-language declaration walking.
2. **Cross-file precise resolution via `tree-sitter-stack-graphs`** — the plan's literal A1
   backend. It has **no production Node binding** (it is a Rust project), so a real integration
   would mean a Rust CLI sidecar (user installs `cargo` + the CLI; limited language coverage) or a
   native addon — both off the zero-friction, air-gapped path. The **resolver-provider abstraction
   shipped here is exactly the seam** a future stack-graphs (or LSP/SCIP) backend would plug into:
   a new provider that returns `resolved` for cross-file-proven bindings, with no change to the
   graph, the tools, or the storage contract.
