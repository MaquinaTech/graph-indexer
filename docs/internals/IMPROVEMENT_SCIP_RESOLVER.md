# Improvement: SCIP resolver provider (A2)

The **opt-in `scip` resolver** completes the A1 precision story. Where A1 (`precise`) can only
*relabel* edges the heuristic already emitted — promoting a `high` edge to `resolved` when the
binding is provably unambiguous from index-time signals — A2 ingests a real **cross-file** binding
oracle (a locally-generated [SCIP](https://github.com/sourcegraph/scip) index) and can therefore do
the thing the heuristic structurally cannot: **disambiguate a same-named symbol across files** and
**suppress the wrong-target fan-out** an ambiguous name would otherwise emit.

- **Branch:** `feat/improvements` (Frontier Phase 3 — the realistic, air-gapped backend for the A1
  resolver-provider seam).
- **Files:** `parse/scip.mjs` (new — `loadScip`, `buildScipBindings`, `buildScipReferers` (v2),
  `normalizeScipPath`), `mcp/resolver.mjs` (`createScipResolver` + the `resolveEdges` provider
  method), `mcp/symbolgraph.mjs` (the emit closures consult `resolveEdges`), `mcp/topology.mjs` (v2 —
  the `find_references` reference dimension), `engine/{memory,sqlite}.mjs` (v2 — the isolated
  `scip_refs` artifact: `hasScipRefs`/`getScipReferers`/`scipRefCount`), `config.mjs`
  (`--resolver scip` / `--scip-index` / `INDEXER_SCIP_INDEX` / `scipIndex` config),
  `indexer.mjs` (load + align + coverage logging + graceful fallback), `test/scip.mjs` (15 tests).

## Why SCIP, and why this is the honest path

The plan's literal A1 backend was `tree-sitter-stack-graphs` — which has **no production Node
binding** (it is a Rust project), so a real integration would mean a Rust CLI sidecar off the
zero-friction, air-gapped path (see `IMPROVEMENT_PRECISE_RESOLVER.md`, honest-scope §2). SCIP is the
defensible alternative: the user's **own toolchain** produces the `.scip` index *out of band and
on-box* — `scip-typescript`, `scip-python`, `scip-java`, `rust-analyzer --scip` — and graph-indexer
just **consumes a protobuf**. No bundled binary, no network, no new always-on dependency. It plugs
straight into the resolver-provider seam A1 shipped for exactly this purpose.

## What it does

```
idx-index --symbol-graph --resolver scip --scip-index path/to/index.scip
```

For each candidate **`calls`** edge the heuristic produced (`caller → each definition of a callee
name`), the `scip` resolver asks the SCIP binding relation *which* definition that caller actually
binds to:

| SCIP knowledge for `(caller, name, def D)` | result |
|---|---|
| caller binds to **D** | emit **`resolved`** for `caller → D` |
| caller binds elsewhere, **and SCIP recorded D as a definition** | **suppress** `caller → D` (proven wrong-target) |
| caller binds elsewhere, but **SCIP never saw D** (uncovered file / stale `.scip`) | **fall through** → heuristic (`high` / `name_only`) — never dropped |
| caller has no SCIP binding among this name's defs at all | **fall through** for every def (absence ≠ refutation) |

The first two rows are the precision win the heuristic cannot reach: an ambiguous name with *N*
definitions normally fans out to *N* edges (one real, *N−1* false); SCIP keeps the one real edge
(as `resolved`) and drops the proven-wrong ones. The last two rows are the **soundness gate**:
suppression requires that SCIP *actually saw* the def it is dropping (`def ∈ definedChunks`).
**Absence is not refutation** — and that holds for *partial* coverage too: a covered caller
referencing an *uncovered* def (a `.ts`-only SCIP run that never saw a `.js` definition, a stale
index, a missed occurrence) keeps the heuristic edge, so an incomplete SCIP index is *exactly* the
heuristic, never worse.

**Scope: `calls` edges only (v1).** The binding relation is kind-agnostic (it is built from all
reference occurrences without distinguishing a call from a type annotation from an `extends`
clause), so applying it to heritage/type edges would let a call-site binding contaminate a
different-kind sibling. `extends` / `type` edges therefore stay heuristic under the `scip`
resolver — byte-identical to the default.

## How alignment works (`parse/scip.mjs`)

1. **Decode** — a hand-rolled, zero-dependency protobuf reader walks only the four SCIP fields A2
   needs (`Index.documents`, `Document.relative_path`/`.occurrences`,
   `Occurrence.range`/`.symbol`/`.symbol_roles`). A SCIP-shaped JSON file is also accepted
   (auto-detected) for hand-authored fixtures and `scip print`-style dumps. No protobuf library —
   in keeping with the project's hand-rolled BM25 / Porter-stemmer ethos.
2. **Align** — one pass over `iterateChunks()` buckets chunks by `file_path`; each SCIP occurrence
   is placed into the **most specific** (smallest-span) chunk whose **1-based** `[start_line,
   end_line]` contains it (SCIP lines are 0-based → `+1`; chunks store no columns, so alignment is
   at line granularity). SCIP document paths are normalized to our repo-root-relative, POSIX,
   no-`./` form.
3. **Derive** — definition occurrences build `symbol → {defChunk}`; reference occurrences build
   `chunk → {symbol}`; the join yields `bindings: Map<fromChunkId, Set<defChunkId>>` (self-references
   dropped), plus `definedChunks: Set<chunkId>` (every chunk SCIP recorded as a definition — the
   suppression soundness gate). Both are what `createScipResolver` consults.

## Why it is parity-free and default-byte-identical

- **Index-time, computed once, serialized.** The resolver runs inside `buildSymbolGraph` at index
  time (like A1); the resulting edge list is serialized into both backends identically, so
  memory↔sqlite parity is **free** — there is no per-backend SCIP code (`test/scip.mjs` proves the
  resolved+suppressed graph round-trips byte-identically).
- **Default path untouched.** `resolveEdges` exists only on the `scip` provider; the
  `heuristic`/`precise` providers have no such method, so the emit closures take the original
  `confidenceFor` branch unchanged — the default index is byte-identical (`npm run test:eval`
  byte-identical; `test/sqlite.mjs` parity 7/0).
- **Air-gapped & sealed-compatible.** `parse/scip.mjs` only does `fs.readFileSync` — no network,
  no subprocess — so `assertSealCompatible` does not enumerate it: **`--sealed strict` + `--resolver
  scip` is a valid, sealed, precisely-resolved index.** A compelling regulated-deployment story.

## Measured / observable

Coverage is **never silent**: at index time the build prints
`resolver=scip (<resolved> resolved-tier; <matched>/<docs> docs matched, <bindings> bindings)`, and
warns loudly if the SCIP index matches **0** documents (a path / `project_root` mismatch) or is
missing/unreadable (→ graceful fallback to heuristic, never a failed build).

## A2 v2 — precise cross-file references for `find_references`

v1 applies SCIP to the `calls` symbol-graph edges only (the binding relation is kind-agnostic, so
relabel/suppress on `extends`/`type` would risk cross-kind contamination). **v2 turns that same
kind-agnostic property from a constraint into the feature** by giving SCIP a second consumer for
which kind-agnostic is exactly right: `find_references`.

`buildScipReferers(bindings)` inverts the binding relation (`fromChunkId → Set<defChunkId>`) into a
precise *referenced-by* map (`{ defChunkId: [refererChunkId, …] }`), and `find_references` /
`explain_symbol` surface it as a **`resolved`-tier** reference dimension. A SCIP Reference occurrence
is just "symbol X used here" — no call/type-use/inheritance label — which is precisely the question
`find_references` answers. So this one dimension delivers two wins the name heuristic structurally
cannot:

- **Precision / disambiguation.** Each referer is attached to the *one* definition SCIP bound it to,
  not to every same-named definition the lowercased-name scan matches.
- **Recall.** It surfaces references the AST/name heuristic never produced — e.g. type usages in
  languages whose `type_refs` channel is empty (the v1 "recall concern", now addressed for the
  *reference* surface, though still not for the symbol-graph *edges*).

Architecturally it is the **taint/centrality pattern**: computed once at index time, serialized as an
**isolated artifact** (`scip_refs` — a memory JSON key / a single-row sqlite table), exposed through
`hasScipRefs` / `getScipReferers` / `scipRefCount`. Because it is a separate blob — *not* folded into
the A4 edge list — it **cannot perturb the symbol-graph edges or A5 centrality**, it is parity-free
(both backends parse identical bytes), it is **empty (default byte-identical) on any non-SCIP index**,
and it is dropped on incremental file update (a per-file edit makes the whole-program set stale). The
`find_references` *categorised* dimensions (callers / subclasses / type users) are untouched; the SCIP
set is an additive, clearly-labelled precise overlay.

## Honest scope — what the SCIP resolver does *not* do

1. **It refines candidates; it does not synthesize symbol-graph *edges*.** A2 promotes/suppresses
   among the `calls` edges the AST call-extraction already produced; a binding SCIP knows but our
   call-extraction missed is **not** added to the A4 edge list. (v2 *does* surface such missed
   bindings in the `find_references` reference dimension, but the resolved edge set itself stays
   candidate-refining — deliberately bounded and low-risk.)
2. **Line-granularity alignment.** Chunks store no column offsets and `call_sites` are positionless
   and de-duplicated, so a SCIP occurrence resolves to its *containing chunk*, never to an exact
   span or a specific call site. Sufficient for chunk→chunk edges; not for sub-chunk precision.
3. **Staleness degrades gracefully.** A `.scip` older than the code aligns fewer occurrences;
   unmatched references simply fall through to heuristic. Re-generate the `.scip` when code changes;
   the coverage line makes drift visible.

## The seam, going forward

`createScipResolver` is the first **data-backed** resolver (heuristic/precise are stateless
relabelers). The `resolveEdges({ fromId, defIds }) → { resolved: Set, suppressed: Set } | null`
contract is the general shape any future cross-file oracle (a live LSP server, an LSIF importer)
would implement — promote what it confirms, suppress the disconfirmed siblings, stay silent on what
it doesn't know.
