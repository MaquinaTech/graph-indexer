# Improvement: inter-procedural receiver-type fixpoint (A3)

An **opt-in** precision improvement to the **call graph** (`get_call_graph` / `find_references`):
resolve a call-site receiver whose type flows through a *multi-hop or unannotated factory chain*,
by propagating function return types along call edges with a bounded, deterministic fixpoint at
index time. It does not touch search ranking and leaves the default index byte-identical.

- **Branch:** `feat/improvements` (Frontier Phase 1).
- **Files:** `parse/interprocedural.mjs` (new — the fixpoint), `parse/metadata.mjs`
  (`extractReturnVia`), `parse/extractor.mjs` (opt-in `_return_via` capture), `indexer.mjs`
  (whole-program pass after parsing, before enrichment), `mcp/topology.mjs` (`classifyCallers`
  prefers `recv_resolved_type`), `config.mjs` (`--interprocedural` flag/env/config +
  describe/notices), `test/callgraph.mjs` (2-hop + conflict + determinism tests).

## The gap

`classifyCallers` promotes a caller from *name-only* to *high-confidence* when it can show the
call's receiver has the type that defines the target method. The intra-procedural inference
already handles one hop: `const r = makeRepo(); r.save()` records `recv_via_call = 'makeRepo'`, and
at query time `classifyCallers` reads `makeRepo`'s recorded `return_type`. Two cases defeat that:

1. **Unannotated factory** — `function makeRepo() { return new OrderRepo(); }` has no `return_type`
   annotation, so the 1-hop reader finds nothing.
2. **Multi-hop chain** — `makeRepoIndirect()` returns `makeRepo()`; the indirect factory's return
   type is only knowable by following the chain.

Both are common in real code (builder/factory layers), and both leave correct callers in the
*name-only* bucket — exactly the false-negatives that make an agent distrust the blast radius.

## Design

A whole-program pass, run **once at index time** (in `indexer.mjs`, after all files are parsed and
before enrichment/embedding) so it has every chunk's return information at once.

- **Capture (parse time, gated):** `extractReturnVia(chunkNode)` classifies a function's own return
  expression(s) via the existing `_classifyValueNode` — `{type}` for `return new X()`, `{viaCall}`
  for `return factory()`, `null` for anything ambiguous (mixed returns, opaque expressions). It is
  attached as the transient `_return_via` **only when `--interprocedural` is set**, so the default
  parse output is unchanged.
- **Fixpoint (`resolveReturnTypes`):** a per-symbol lattice `nameLower → typeName | CONFLICT`.
  Seeds come from a single-type `return_type` annotation and/or `_return_via.type`; a
  `_return_via.viaCall` with no direct type becomes an **edge** `sym → callee`. A monotone worklist
  (bounded `MAX_ITERS = 8`; converges in 2–3 passes) propagates a callee's resolved type to its
  callers. A symbol that would gain a second distinct type becomes `CONFLICT` and contributes
  nothing (conservative DROP, mirroring `_inferLocalBindings`).
- **Annotate (`applyInterprocedural`):** for each call site with a `recv_via_call` and no
  intra-procedural `recv_type`, write `recv_resolved_type` = the fixpoint result. Strip the
  transient `_return_via` so it never serializes.
- **Consume:** `classifyCallers` precedence becomes `recv_type` → `recv_resolved_type` →
  1-hop `recv_via_call`. Keeping the 1-hop fallback means a non-fixpoint index (or a daemon
  per-file update) still resolves exactly as before — never worse.

### Why it is parity-free and default-safe

- `recv_resolved_type` lives **inside `call_sites`**, which both backends serialize identically
  (`jsonArr`/`parseArr` in SQLite, JSON round-trip in memory). A new nested field needs no schema
  change and cannot diverge across backends. (A new *top-level* chunk field would have been dropped
  by the memory engine's explicit-field `save()` — hence the nesting.)
- The fixpoint is **deterministic**: iteration is over sorted symbol/edge keys and the lattice is
  monotone, so the result is independent of chunk/map order — verified by a test that reverses the
  input and asserts an identical map.
- It only feeds `classifyCallers`. `searchHybrid` never reads receiver types, so `npm run
  test:eval` and the memory↔sqlite top-5 parity gate are untouched. With the flag off, the
  serialized index is byte-identical (no `_return_via`, no `recv_resolved_type`) — confirmed by an
  integration check that diffs a real index with/without the flag.

## Verification

`test/callgraph.mjs` (no Ollama, pure parser + in-memory engine):

- A 2-hop, **unannotated** factory chain (`makeRepoBare` → `makeRepoBareIndirect`) where the
  indirect factory's `return_type` is `''`. Negative control: without the fixpoint the caller is
  name-only. With the fixpoint it is high-confidence with `reason === 'OrderRepo.save()'`.
- Conflict guard: a factory returning two different concrete types stays unresolved → its caller
  remains name-only (no fabricated type).
- `resolveReturnTypes` direct/transitive/conflict cases + order-independence.

Integration check (real `idx-index`): with `--interprocedural`, the `save` call site of
`useChain` gains `recv_resolved_type: "OrderRepo"` resolved two hops across files; without it, the
call site is byte-identical to before; `_return_via` never appears in the index.

## Residual limitation

The watch daemon (`watch-daemon.mjs`) re-indexes one file at a time via `applyFileUpdate` and does
**not** run the whole-program fixpoint. After a live edit to a factory file, callers in *other*
files keep their previous `recv_resolved_type` until the next full `idx-index`; in the meantime
they degrade to the 1-hop fallback — never worse than the default. An incremental daemon fixpoint
is intentionally out of scope (it would be a correctness hazard).
