# Phase 3 design — C2: Taint Analysis

> **Status: DESIGN ONLY. Nothing here is implemented.** Interface stubs are illustrative
> signatures, not code. Plan + approve before any work.

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
trace_taint({ source?, sink?, category?, max_depth?, response_format })
   → flows from a tainted source to a sink, each step a chunk + the propagation reason
find_tainted_sinks({ category?, response_format })
   → every sink reachable from any source, grouped by category, worst-first
```

A `TaintFlow` is the deliverable:

```
TaintFlow = {
  source: { chunk_id, file, line, kind },          // e.g. 'http.req.body'
  sink:   { chunk_id, file, line, category },       // 'sqli' | 'rce' | 'path' | 'xss' | 'ssrf'
  path:   [ { chunk_id, via, confidence } ],        // the propagation chain (calls/params/returns)
  confidence: 'resolved' | 'high',                  // path uses A1 resolved edges → 'resolved'
  sanitized: false,
  remediation: 'parameterize the query / use prepared statements'
}
```

Reporting at **two confidence levels** falls straight out of A1: a flow whose every hop is a
`resolved` edge is `resolved`; a flow that traverses a `high` (import/proximity) edge is `high`.
Security tools live or die on false-positive rate, so `resolved`-only is the default surface and
`high` is opt-in ("show me the maybes").

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

## Interface stubs (DESIGN — not implemented)

```js
// parse/taint-patterns.mjs — DESIGN SKETCH
export const SOURCES;     // Record<lang, Pattern[]>
export const SINKS;       // Record<lang, { pattern, category }[]>
export const SANITIZERS;  // Record<lang, Pattern[]>

// mcp/taint.mjs — DESIGN SKETCH
export function buildTaintGraph(db, { maxDepth, minConfidence }) { /* → { flows: TaintFlow[], stats } */ }
export function traceTaint(db, { source, sink, category, maxDepth }) { /* → TaintFlow[] */ }
export function findTaintedSinks(db, { category }) { /* → TaintFlow[] grouped by category */ }

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
