# Phase 3 — C2: Taint Analysis

> **Status: IMPLEMENTED (v1 + hardening)** (`parse/taint-patterns.mjs`, `mcp/taint.mjs`, the
> `trace_taint` / `find_tainted_sinks` tools in `mcp/tools.mjs`; `test/taint.mjs`). v1 shipped
> **query-time** (the tools compute on demand, like `get_call_graph`). The **hardening pass (v2.1)**
> added the index-time path the sketch below describes: an **opt-in `--taint`** precomputes the flow
> set once and serializes it (a `taint` table in SQLite / a `taint` JSON key in memory; new store
> methods `hasTaint()` / `getTaintFlows()`), so the tools serve instantly while the **default index
> stays byte-identical** (off → no serialization) and **both backends serve byte-identical flows**
> (computed once, like A4 edges / A5 centrality — parity-free). `buildTaintGraph` gained a fast path
> that serves the cache filtered to the query's category/depth envelope, falling back to a live
> recompute outside it. Language coverage extended to **Java and Go** (was JS/TS + Python). The
> honesty framing ("finder, not verifier") is unchanged.

## One line

Track untrusted data from **sources** (request bodies, argv/env, file/socket reads) to dangerous
**sinks** (eval/exec, SQL string-building, filesystem paths, HTML output, outbound URLs) across the
A4 symbol graph — surfacing injection-class vulnerabilities (SQLi, RCE, path traversal, XSS, SSRF)
with a concrete source→sink path an agent can act on.

## Why this is the highest-value moonshot

It is the natural escalation of the symbol graph from *"who calls what"* (A4) to *"what data
reaches where."* Security-sensitive verticals — banking, defense, health — need data-flow evidence,
not just a call graph, and they pay for it. It has the **clearest MCP tool shape** of any moonshot
(trace a flow; list reachable sinks), it **reuses what already exists** (the A4 resolved edges, the
A3 dataflow inference in `parse/metadata.mjs`, the framework-pattern catalog approach from
`parse/routes.mjs`), and it stays **fully air-gapped** (pure AST + graph analysis; no model, no
network).

## What it produces

Two MCP tools over an index built with `--taint`:

```
trace_taint({ source_kind?, category?, max_depth?, max_flows?, response_format })
   → flows from a tainted source to a sink; the path is the chunk-id chain between them
find_tainted_sinks({ category?, reachable_only?, max_depth?, response_format })
   → every dangerous sink grouped by category, each flagged whether a source reaches it
```

A `TaintFlow` is the deliverable:

```
TaintFlow = {
  source: { chunk_id, file, line, kind, snippet },             // kind e.g. 'http-request'
  sink:   { chunk_id, file, line, category, label, snippet },  // category 'sqli'|'rce'|'path'|'xss'|'ssrf'
  path:   [ chunkId, ... ],                          // the source→sink chunk-id chain
  via:    'direct' | 'reachable',                    // same-function vs cross-function
  depth:  2,                                          // call hops from source to sink
  confidence: 'high' | 'medium' | 'low',             // see below
  sanitized: false
}
```

Reporting at **three confidence levels** (`mcp/taint.mjs`): a same-function source→sink is `high`
(`via: 'direct'`); a source that transitively reaches a sink across call edges is `medium`
(`via: 'reachable'`); a sanitizer (escape/encode/parameterize/`Number()`/`int()`…) seen on the path
drops it to `low`. Security tools live or die on false-positive rate, so flows are emitted ordered by
category severity → confidence → location, letting a caller triage high-confidence first.

## Architecture & seams

1. **Catalogs** — `parse/taint-patterns.mjs` (new): per-language source / sink / sanitizer
   patterns, in the same spirit as the framework route patterns. Sources: `req.body|query|params`,
   `process.argv|env`, `fs.read*`, socket/`request` data. Sinks by category: `eval` / `Function`
   / `child_process.exec*` (rce), string-concatenated `db.query` / raw SQL (sqli), `fs`/`path`
   joins with tainted input (path), `res.send` / `innerHTML` / template injection (xss), `fetch` /
   `http.request` URL (ssrf). Sanitizers: escape/encode/parameterize/validate functions that clear
   taint.
2. **Intra-procedural taint** — extend the existing dataflow in `parse/metadata.mjs`
   (`_inferLocalBindings`, `_classifyValueNode`) from a *type* lattice to a *taint* lattice
   (`tainted | clean | conflict`): a binding seeded by a source pattern is tainted; assignment /
   return propagates; a sanitizer call clears it. This is the same machinery A3 already uses for
   receiver types — taint is a second lattice over the same walk.
3. **Inter-procedural taint** — a worklist fixpoint (mirroring `parse/interprocedural.mjs`) over the
   A4 call edges: a tainted *argument* taints the callee's corresponding *parameter*; a tainted
   *return* taints the caller's binding. Follow only `resolved`/`high` edges (precision) — this is
   exactly why A1's resolved tier matters here. Bounded iterations + deterministic ordering, like
   A3.
4. **Flow assembly** — when tainted data reaches a sink pattern with no intervening sanitizer, emit
   a `TaintFlow` with the path reconstructed from the propagation edges. Deterministic ordering
   (category severity, then source file/line, then id).
5. **Serialization** — `--taint` computes the flow set once at index time and serializes it (a
   `taint` table / `taint` JSON array), exactly like A4 edges and A5 centrality → **parity-free**,
   both backends serve identical flows. New store methods `hasTaint()`, `getTaintFlows(filter)`.
6. **Tools** — `mcp/taint.mjs` builds/queries; `mcp/tools.mjs` registers the two tools (16-tool
   surface). Markdown + json, like every other tool.

## Interface (as built)

```js
// parse/taint-patterns.mjs
export const SOURCES;          // Record<lang, Pattern[]>
export const SINKS;            // Record<lang, { pattern, category }[]>
export const SANITIZERS;       // Record<lang, Pattern[]>
export const CATEGORY_SEVERITY; // deterministic worst-first ordering
export function langKeyForExt(ext);

// mcp/taint.mjs
export function buildTaintGraph(db, { maxDepth = 4, maxFlows = 200, category = null, includeReachable = true });  // → { flows, scanned, truncated }
export function traceTaint(db, { sourceKind = null, sinkCategory = null, maxDepth = 4, maxFlows = 200 });          // → { flows, scanned, truncated }
export function findTaintedSinks(db, { category = null, reachableOnly = false, maxDepth = 4 });                    // → { byCategory, total, scanned, flowCount }
export function computeTaintCache(db, { maxDepth = 4 });  // index-time precompute for --taint

// store contract additions: hasTaint() → bool, getTaintFlows(filter) → TaintFlow[]
```

## Invariant compliance

- **Opt-in** — `--taint` / `INDEXER_TAINT` / `config.taint`, default off; index-time + serialized so
  query latency is unaffected and the default index is byte-identical.
- **Air-gapped** — pure AST + graph analysis; zero network, zero model. (An *optional* LLM pass to
  rank/explain findings would be a separate, separately-gated provider — never on the air-gapped
  default.)
- **Parity** — flows computed once and serialized → both backends identical, like edges/centrality.
- **Honest** — see below; the docs must state the soundness limits plainly.

## Risks, scope, and honesty

Taint analysis is genuinely hard: aliasing, collections/containers, dynamic dispatch, reflection,
and framework magic all defeat naive tracking. The honest framing: **this is a finder, not a
verifier.** It favours *precision* (resolved-edge paths, explicit sanitizer catalog) and will
*miss* flows through dynamic dispatch, reflection, ORM/query-builder indirection, and untyped
collections. Every report must carry its confidence and its path so a human can adjudicate; the
tool must never imply completeness ("0 findings" ≠ "no vulnerabilities").

Phased delivery:
- **v1** — receiver-aware languages (TS/JS, Python); intra-procedural + one inter-procedural hop
  over resolved edges; the five sink categories above; explicit sanitizer catalog.
- **v2** — full inter-procedural fixpoint; container/field taint; more languages.
- **v3** — sanitizer inference + optional LLM explanation/triage (separately gated).

## Effort

Large — this is the flagship moonshot. v1 is a well-bounded slice (catalogs + the two-lattice walk +
one-hop propagation + two tools) that reuses A3/A4/A1 wholesale; v2/v3 are the long tail.
Strong synergy with F1 (a sealed, taint-aware index is a compelling regulated-deployment story).
