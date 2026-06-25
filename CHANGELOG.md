# Changelog

All notable changes to graph-indexer are documented here. Dates are in YYYY-MM-DD format.

---

## [Unreleased]

Frontier upgrade — Phase 1. Every item is **opt-in**: the default path stays lexical-only,
in-memory, zero-dependency, with byte-identical `npm run test:eval` output and byte-identical
memory↔sqlite top-5 parity.

### Code-specialized embedding models — documented; NL vector-weight re-tune evaluated and rejected (B1)

- **Code-specialized embedders are now documented as a first-class opt-in.** `qwen3-embedding`,
  `nomic-embed-code`, and `jina-embeddings-v2-base-code` embed code semantics more faithfully than
  the general-purpose `nomic-embed-text` default. They are selected with `--embed-model <name>`
  (no new code — Ollama models are chosen by name) and stamped into the index meta so query and
  document vectors always share a space. **Measured (honest):** on a clean `qwen3-embedding:16k`
  re-embed, semantic rank-1 lifted on Go (`gin` 0.20 → 0.40, MRR 0.41 → 0.67) but was neutral on
  Python (`django` rank-1 0.33 → 0.33) and JavaScript (`express-js` 0.43 → 0.43); it also indexes
  substantially slower. So a code embedder is a *measure-first* opt-in, not a default.
- **Rejected: re-weighting the NL vector channel upward for code embedders.** We implemented an
  opt-in weight profile and swept the natural-language vector weight from 0.4 → 1.2 on
  `gin`/`django` with `qwen3-embedding`. There was **no recall@5 gain at any weight** (gin s@5 flat
  at 1.00, django at 0.83); rank-1 was flat-to-negative and symbolic regressed at higher weights
  (`django` symbolic rank-1 0.72 → 0.61). The existing default weighting (`NL_VECTOR_WEIGHT_PLAIN
  = 0.4`) is already optimal even for the stronger embedder — the vector channel's job here is
  low-weight *rescue*, and recall is already saturated. The profile was therefore **not shipped**
  (no placebo knob); the ranking core is unchanged. Full write-up:
  `docs/internals/IMPROVEMENT_CODE_EMBED.md`.

### Local cross-encoder reranker provider (B2)

- **`--rerank-provider cross-encoder`** (`RERANK_PROVIDER` / `rerank.provider` config) adds a
  second, **air-gapped** reranker alongside the generative LLM judge. It scores each
  (query, candidate) pair with a local MS-MARCO cross-encoder
  (`Xenova/ms-marco-MiniLM-L-6-v2`, via the optional `@huggingface/transformers` — the same dep
  as the in-process embedder) and sorts by score. No Ollama, no daemon, **deterministic**, fast
  (~tens of ms per NL query); the model downloads once on first use.
- **Measured (honest), core suites, lexical channel:** agent-style semantic rank-1 0.19 → 0.26
  (held-out 0.30 → 0.35; held-out s@5 0.48 → 0.52), strongest on Go (gin 0.20 → 0.40) and Python
  (fastapi 0.14 → 0.29). It is **weaker than the generative 7B judge** (0.42 agent-style rank-1)
  and shows the usual reranker behaviour on JavaScript (mixed) plus a small symbolic wobble (long
  symbolic queries that pass the NL gate). The generative judge stays the higher-reasoning tier;
  the cross-encoder is the no-LLM-in-the-loop option. Full write-up:
  `docs/internals/IMPROVEMENT_CROSS_ENCODER.md`.
- Implementation: `rerankCrossEncoder` / `crossEncoderScore` in `enrichment.mjs` (sibling to the
  generative `rerankResults`, lazy-loads transformers, deterministic score-desc/id-asc sort,
  never mutates the fused score, degrades gracefully); dispatched in `mcp/tools.mjs` on
  `rerank.provider`, reusing the existing over-fetch pool unchanged. Default path (provider
  `generative`, reranker off) is byte-identical; memory↔sqlite parity unaffected. New
  `test/unit.mjs` tests inject the scorer (no model in CI).

### Inter-procedural receiver-type fixpoint (A3)

- **`--interprocedural`** (`INDEXER_INTERPROCEDURAL` / `interprocedural` config) adds an
  index-time, whole-program fixpoint that propagates function return types along **factory call
  chains**, so a call-site receiver whose type comes from a multi-hop or unannotated factory
  resolves to its concrete class. Example: `makeRepoIndirect()` returns `makeRepo()` returns
  `new OrderRepo()` — the indirect factory has no return type to read, but the fixpoint resolves
  the chain, so `const m = makeRepoIndirect(); m.save()` is now a **high-confidence** caller of
  `OrderRepo.save` in `get_call_graph` / `find_references` instead of a name-only match.
- **Design:** a new `parse/interprocedural.mjs` runs a bounded (`MAX_ITERS = 8`), monotone,
  deterministic worklist over a per-symbol return-type lattice (conflicts — ≥2 distinct types —
  are conservatively dropped). It writes `recv_resolved_type` onto the relevant call sites;
  because `call_sites` is serialized identically by both backends, the resolved data is
  **parity-free**. `classifyCallers` prefers `recv_resolved_type` and keeps the existing 1-hop
  `recv_via_call` fallback, so an index built without the pass (or a per-file daemon update) is
  never worse. The transient capture (`_return_via`) is stripped before serialization.
- **Invariants:** OFF by default → the index and `get_call_graph` output are byte-identical, and
  `npm run test:eval` is unchanged (search ranking never reads receiver types). Air-gapped,
  zero new runtime deps. **Residual limitation (documented):** the watch daemon re-indexes one
  file at a time and does not re-run the whole-program pass, so cross-file chains refresh on the
  next full `idx-index`. New `test/callgraph.mjs` tests prove a 2-hop chain promotes only with the
  fixpoint, the conflict guard holds, and `resolveReturnTypes` is order-independent. Write-up:
  `docs/internals/IMPROVEMENT_INTERPROCEDURAL.md`.

### Test→code mapping + two compound MCP tools (C5 + D1)

The MCP tool surface grows from 11 to 13. Both new tools are read-only and compose existing
store primitives — no ranking, parity, or default-path impact.

- **`tests_for(symbol)`** — the test/spec chunks that exercise a symbol: a chunk under a
  test path (`TEST_FILE_RE`) that calls or references it. Reuses `findCallers` + `findReferers`
  filtered to tests, deterministically ordered (file, line, id). Tells an agent which tests to
  run or update before a change, and how the symbol is meant to behave.
- **`explain_symbol(symbol, target_class?)`** — a single-round-trip overview that previously took
  four tool calls: signature(s) (`resolve_symbol`), callees (the symbol's `calls`), callers /
  blast radius + subclasses + type users (`find_references` / `classifyCallers`), the HTTP routes
  it handles (`find_routes`), the tests that exercise it (`tests_for`), and git recency/co-change.
  Both `markdown` and `json` (`structuredContent`) formats.
- `test/mcp.mjs` asserts the 13-tool surface; `test/references.mjs` adds a test→code fixture
  proving `tests_for` returns only the test chunk (not the production caller) and `explain_symbol`
  composes definition + callees + callers + tests, in both response formats.

### Persistent resolved symbol graph (A4) — Phase 2

- **`--symbol-graph`** (`INDEXER_SYMBOL_GRAPH` / `symbolGraph` config) materializes a resolved
  **chunk→chunk** graph at index time: one edge `{from_chunk_id, to_chunk_id, kind, confidence}`
  per resolved reference, where `kind` ∈ `calls` | `extends` | `type` and `confidence` ∈
  `high` | `name_only`. It is built by **reusing the query-time resolvers** (`classifyCallers` /
  `findReferences`) over every defined symbol, so an edge's confidence is identical to what
  `get_call_graph` / `find_references` report — no logic duplication, no drift.
- New store method **`getEdges(chunkId, { kind?, direction })`** (`direction: 'in'` = referrers,
  `'out'` = referents) on both backends, deterministically ordered → byte-identical
  memory↔sqlite. Stored in a SQLite `edges` table / the in-memory index JSON.
- `findCallers` / `findReferers` now **read the edge graph when present**, returning the *same*
  sets as the name-match scan (a set-equivalence test is the load-bearing guard), and **fall back
  to the scan** when the graph is absent or the name is undefined — so the default path is
  byte-identical and an undefined-symbol lookup never returns empty-by-edges.
- **Invariants:** OFF by default → index + call graph byte-identical, `test:eval` unchanged
  (edges never touch search). Air-gapped, zero new deps. Deterministic edge order. A per-file
  daemon update **invalidates** the graph (it would otherwise go stale) so callers fall back to
  the always-correct scan until the next full `idx-index`. New `test/edges.mjs` (6 tests):
  set-equivalence, getEdges direction/kind/confidence, undefined-name fallback, memory↔sqlite
  parity, daemon invalidation, deterministic ordering. Foundation for `impact_of_edit` (C4) and
  symbol-level PageRank (A5). Write-up: `docs/internals/IMPROVEMENT_SYMBOL_GRAPH.md`.

### `impact_of_edit` — precise blast radius (C1 + C4) — Phase 2

- New MCP tool **`impact_of_edit({ symbols?, files? })`** (13 → 14 tools): pass what you are
  about to change and get the **transitively-affected** code (callers, subclasses, type users by
  hop depth), the HTTP routes that reach it, the tests to run, the direct same-named referrers to
  verify, and git co-change — in one call instead of recursively walking `get_call_graph`.
- It follows **high-confidence** edges transitively (a precise closure that does not explode on
  ambiguous names) and lists direct `name_only` referrers separately. It is **chunk-precise on a
  `--symbol-graph` index** (walks `getEdges`) and falls back to query-time `classifyCallers` /
  `findReferences` otherwise — a new `buildImpact` in `mcp/topology.mjs`, plus a `hasSymbolGraph()`
  store predicate. Deterministic ordering (depth, file, line, id); both response formats.
- Additive and read-only — no ranking/parity/default-path impact. `test/edges.mjs` adds 4 tests
  (transitive depth via the graph AND the fallback, the two agreeing, and the tool composing
  changed + impacted + tests + routes); `test/mcp.mjs` asserts the 14-tool surface.

### Symbol-level centrality (A5) — Phase 2

- On a `--symbol-graph` index, the indexer now also computes **symbol centrality**: a
  confidence-weighted **PageRank over the resolved chunk→chunk edges** (`high` edges weighted
  1.0, `name_only` 0.5). A definition referenced — called / extended / used as a type — by many
  *other central* symbols scores high; it surfaces the program's load-bearing hubs. New module
  `mcp/centrality.mjs` (`computeSymbolCentrality`). This is **distinct** from the existing
  file-level `computePageRank` (import graph): A5 is symbol-granular and call/type-aware.
- **Surfaced** through two existing tools (no new tool — the surface stays at 14): `explain_symbol`
  attaches each definition's `{ score, rank, total }` (markdown shows `🎯 centrality #R/T`, with a
  `(hub)` tag in the top decile); `get_repo_map`'s unfiltered view lists the most-central symbols.
  Both **omit** centrality entirely when the graph is absent → default output unchanged.
- **Parity-free, like the edges:** computed **once at index time** and serialized
  (memory `centrality` map; SQLite `centrality(chunk_id, score, rank)` table), so both backends
  read byte-identical scores and ranks. It never touches `searchHybrid`, so `test:eval` and the
  search parity gate are unaffected. New store methods `hasCentrality()`, `getCentrality(id)`,
  `topCentral(limit)` on both backends. Deterministic (sorted node set, fixed-order power
  iteration, rounded scores, rank tie-broken by id).
- **Daemon staleness:** a per-file update invalidates the centrality alongside the edges
  (it is a whole-program quantity) — both engines drop it until the next full `idx-index`.
- `test/edges.mjs` adds 8 tests (PageRank determinism, hub-outranks-leaf, confidence weighting,
  serialization round-trip + store methods, memory↔sqlite parity, daemon invalidation, default-path
  gating, and the two tools surfacing/omitting it). Full write-up:
  `docs/internals/IMPROVEMENT_SYMBOL_CENTRALITY.md`.

### Precise resolver provider + impact precision dial (A1) — Phase 2

- **`--resolver precise`** (`INDEXER_RESOLVER` / `resolver` config) adds a pluggable resolver
  provider for the symbol graph. The default `heuristic` provider keeps edge confidence exactly
  `{ high, name_only }` (byte-identical). `precise` lifts the **provably-unambiguous** subset into
  a third, stronger tier — **`resolved`** — a reference is `resolved` when there is no question
  *which* definition it binds to: a **sole definition** (no same-named rival), or a **type-pinned
  receiver** (typed receiver, the A3 inter-procedural fixpoint, `this.m()` inside the class, or an
  explicit target class — type-resolved, so shadow-immune). `high` then means "ambiguous name,
  import/proximity-disambiguated"; `name_only` means "ambiguous, no evidence."
- **`impact_of_edit` gains a `precision` dial:** `standard` (default) follows the high-confidence
  closure (`resolved` + `high`); **`strict`** follows **only `resolved`** edges — a
  false-positive-free blast radius ("what *definitely* breaks"). Without a graph, `strict` follows
  the `proven` query-time callers, so it degrades gracefully. Measured on the repo's own source:
  of 325 `high` calls/refs edges, 303 are provably unambiguous (→ `resolved`), 22 remain heuristic
  `high`; `name_only` is never promoted.
- **Additive and parity-free:** the resolver only changes the `confidence` STRING on edges that
  already exist (never adds, drops, or reorders them), so `findCallers`/`findReferers`
  set-equivalence holds and both backends round-trip the `resolved` tier identically. `resolved`
  carries the same A5 centrality weight as `high`, so enabling it does not perturb centrality. The
  symbol-graph dedupe now keeps the **strongest** confidence (`resolved > high > name_only`); on the
  default path the values are unchanged so the dedupe is identical. New module `mcp/resolver.mjs`;
  `classifyCallers` / `findReferences` gain an additive `proven` flag.
- **Honest scope:** v1 ships the unambiguous-binding tier the engine can already prove from
  index-time signals. Detecting a local variable that **shadows** an import (and *refuting* that
  edge), and cross-file precise resolution via stack-graphs, are the documented next layers — both
  need per-language AST/scope analysis and an external toolchain that does not fit the air-gapped
  default. `tree-sitter-stack-graphs` has no production Node binding, so a literal integration would
  require a Rust CLI sidecar (rejected for v1). `test/edges.mjs` adds 5 tests; full write-up:
  `docs/internals/IMPROVEMENT_PRECISE_RESOLVER.md`.

## [2.0.0] — 2026-06-21

This is a major release. The public API (MCP tools, CLI flags, config keys) has grown significantly, but the default behaviour — lexical-only search, in-memory store, zero external dependencies — is backward-compatible. Internal modules were reorganized into `engine/`, `mcp/`, and `parse/` (see [Module reorganization](#module-reorganization-breaking-only-for-deep-imports) below) — breaking only for code that deep-imported internal files.

### Onboarding (`graph-indexer init`) — environment-agnostic setup

The first-run setup now produces a working configuration in **any** repository, not just a Node repo that already has graph-indexer installed.

- **Self-contained MCP launch command.** The wired command is now decided per-project. When graph-indexer is resolvable as a local dependency, the wiring keeps using `npm run mcp:start`. Otherwise — **non-Node repos** (Python, Go, Rust, …) and **npx-only Node repos** — it wires a self-contained `npx -y -p graph-indexer idx-mcp --repo <abs path>` that launches the real server regardless of ecosystem. The same decision drives the npm scripts (wrapped in `npx -p` when not a local dep, so they aren't broken) and the global Claude Desktop config.
- **Subcommand dispatch.** `graph-indexer <idx-mcp|idx-index|idx-watch|idx-daemon> …` now delegates to the real bin (previously these tokens were swallowed by the init wizard, because `npx <pkg> <x>` runs the package's same-named bin, not the `<x>` bin). This makes the documented `npx -y graph-indexer idx-mcp` form work too.
- **Target a repo + CI flags.** `init` now honors a positional path and `--repo <path>` (resolved to an absolute root used everywhere), adds `--help`, and adds `--yes` / `--non-interactive` (a non-TTY stdin already implied this) for scripted/CI runs.
- **Claude Code MCP target.** Project-scoped servers are now written to `.mcp.json` (the file Claude Code reads for project MCP servers) instead of `.claude/settings.json`.
- **Claude Desktop on Linux.** Added the `~/.config/Claude` path (honoring `$XDG_CONFIG_HOME`); Linux users with Claude Desktop installed now get wired instead of reported "not installed".
- **Node version guard.** Selecting (or auto-resolving on a large repo to) the SQLite backend on Node < 22 now surfaces a clear warning in the summary instead of failing later at runtime.
- **Faster default path + ready to use.** The engine step opens with a single "Use recommended defaults?" confirm that skips the ~10 follow-up prompts, and the run ends by offering to build the index so the flow finishes genuinely ready to use. Editor wiring now distinguishes "detected" from "ready if you use it" in the summary.

Idempotency, merge-safe config writes, air-gapped defaults, and `--dry-run` are all preserved.

### New MCP tools

| Tool | Purpose |
|------|---------|
| `find_references` | Where a symbol is used: callers, subclasses, and type-annotation references, split into high-confidence vs name-only blast radius. |
| `find_routes` | HTTP routes mapped to their handler chunks — NestJS, Express/Koa, FastAPI/Flask, and Spring (Java); the controller/router prefix is joined onto the method path. Attribute-routed C#/ASP.NET, PHP (Laravel/Symfony), Rails, and Django URLconf are out of scope. |
| `get_subgraph` | Bounded connected subgraph (callers + callees + type/inheritance referers) around a seed symbol, in one call. Replaces multi-hop `search_code → get_call_graph → find_references` round-trips. |

HTTP route extraction (`parse/routes.mjs`) parses route definitions from the AST so `find_routes` can resolve an endpoint straight to its handler chunk; coverage is per-framework as noted above.

**All tools** now support a `response_format: 'json'` parameter that returns typed structured fields instead of markdown prose, for programmatic clients.

All tool responses carry an **index-freshness signal** (age, commit it was built at, pending uncommitted changes). The freshness footer is omitted on up-to-date indexes to keep card sizes lean.

### New language support

Added three languages, bringing the total to 14:

- **C** (`.c`, `.h`) — struct/function/declaration extraction with declarator name descender
- **Bash** (`.sh`, `.bash`) — command and function extraction with built-ins filter
- **Swift** (`.swift`) — class/struct/enum/function extraction

Existing language support: TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin, C#, Ruby, PHP, CSS/SCSS.

### Prompt suite (new `prompts/` directory)

Replaced the single `PROMPT.md` with a structured, composable **3-layer prompt suite**:

- **`prompts/CORE.md`** — universal rules (4-call budget, batch-don't-iterate, consume-before-call, rule-of-one). Always required.
- **`prompts/languages/`** — 13 language-specific overlays: BASH, C, C#, CSS/SCSS, Go, Java, JavaScript/TypeScript, Kotlin, PHP, Python, Ruby, Rust, Swift
- **`prompts/frameworks/`** — 8 framework-specific overlays: Android, ASP.NET Core, FastAPI/Django, Laravel/Symfony, Node/Express/NestJS, Rails, React, Spring Boot
- **`prompts/DOMAIN_TEMPLATE.md`** — a copy-and-fill template for project-specific rules
- **`prompts/INTEGRATION.md`** — guide explaining the 3-layer architecture and how to compose the layers

### Embedding provider abstraction (`embeddings.mjs`)

New module with an `auto` provider selection policy:

1. Ollama (user's running daemon, highest quality)
2. In-process local model via the optional `@huggingface/transformers` dependency (`Xenova/all-MiniLM-L6-v2` by default) — runs with no external daemon
3. Lexical-only fallback (logged, never silent)

Embeddings remain **off by default**. The index stamps the resolved `{ provider, model, dim }` into its metadata; the server reads it back on load so index time and query time always use the same model.

New `--embed-provider <auto|ollama|local|off>` flag and `INDEXER_EMBED_PROVIDER` env variable to override provider selection.

New `mlx` provider uses a dedicated Python virtualenv (`embedders/venv-mlx/`) and the `mlx_embeddings` library to embed via the Apple Metal GPU as a persistent subprocess — no Ollama daemon required. Measured throughput on an **Apple M2 Mac mini (24 GB)**, `express-js` fixture, median of 3 cold builds: `mlx` **~42 ch/s** vs in-process Xenova **~18 ch/s** vs Ollama/nomic **~14 ch/s** (throughput is hardware-dependent — expect different figures on other chips). Note: on Apple Silicon, Ollama also uses the Metal GPU internally; the `mlx` provider's advantage is a smaller 4-bit model and no HTTP round-trip, not GPU vs CPU.

**Bug fix:** `indexer.mjs` (and the eval harness) now calls `_resetSubprocesses()` after encoding completes so the MLX Python subprocess is killed and the Node.js event loop can drain. Previously `npx idx-index --embed-provider mlx` would hang indefinitely after building a correct index.

**Setup & onboarding.** Install the MLX virtualenv with `npm run embed:setup:mlx` (`node embedders/setup-mlx.mjs`), or accept it during `graph-indexer init` when you select the MLX provider (onboarding also lets you choose the MLX embed model, default `mlx-community/all-MiniLM-L6-v2-4bit`, 384-dim). New MLX implementation files: `embedders/setup-mlx.mjs` (venv installer), `embedders/python/mlx_embed_server.py` (persistent MLX subprocess server), `embedders/python/requirements-mlx.txt`, `embedders/python/test_servers.mjs`.

**Graceful per-batch degradation.** Embedding generation no longer aborts the whole index when a batch fails or times out — those chunks are indexed lexical-only and retried on the next run, with a per-batch warning and an end-of-run summary of how many batches were skipped.

### Git signals (`git-signals.mjs`)

New module that computes three per-file ranking signals from the local git log (no network, no remote):

- **churn** — commit count per file
- **recency** — time since last commit
- **co-change** — files that historically change together

Signals are collected once at index time into a sidecar file (`code-index.git.json`). The co-change hint is surfaced in tool blast-radius responses. The recency/churn ranking weight is **off by default** (`gitRankBoost: 0`) — enable with `--git-rank-boost <0..1>` or `INDEXER_GIT_RANK_BOOST`.

### Daemon control CLI (`daemon-ctl.mjs` / `idx-daemon`)

New `idx-daemon` binary with subcommands:

```
idx-daemon start      Start the watch daemon (no-op if already running)
idx-daemon stop       Gracefully stop it
idx-daemon restart    Stop then start
idx-daemon status     Show daemon + index state (default)
idx-daemon logs [-f]  Print recent daemon logs
```

New `daemon-lock.mjs` ensures exactly one daemon runs per project — `start` is safe to call repeatedly. New npm scripts: `mcp:daemon`, `mcp:daemon:start`, `mcp:daemon:stop`, `mcp:daemon:restart`, `mcp:daemon:status`, `mcp:daemon:logs`.

### Directory layout (`layout.mjs`)

New `layout.mjs` is the single source of truth for on-disk paths. All machine-generated runtime files (index, vectors, SQLite database, enrichment cache, daemon PID/log, resolved config) now live under `.graph-indexer/` at the project root instead of being scattered at the root level. `migrateLegacyLayout()` relocates pre-v1.4 artifacts transparently on next run. The config file is `config.json` inside that directory; the legacy `.graph-indexer.json` root file is still read as a fallback for backward compatibility.

### CLI UI (`cli-ui.mjs`)

New dependency-free shared console styling module for CLI utilities (init, daemon control). Provides ANSI colour with graceful degradation when stdout is not a TTY or `NO_COLOR` is set, plus boxed banners, rules, and status glyphs for a consistent look.

### Receiver-aware call graph

`get_call_graph` now uses receiver hints captured by the parser (`this.X()`, `Receiver.X()`, free-function `X()`) to classify callers as **high-confidence** (the real blast radius) vs **name-only** (callers of a same-named symbol elsewhere). Eliminates false positives on methods with common names (e.g., `save`, `find`, `validate`).

### Lexical search improvements

- **Porter stemming** — language-agnostic Porter stemmer (steps 1–5 plus an agent-noun `-or` rule for code) bridging vocabulary gaps: `"intercepting"` ↔ `Interceptor`, `"managing"` ↔ `Manager`, `"injection"` ↔ `Injectable`. Applied **additively** (raw token always emitted alongside the stem) so exact matches, IDF statistics, and name boosts are byte-for-byte unchanged.
- **IDF-gated path boost** — for NL queries, the path-segment boost is restricted to file-path terms that are rare in the corpus (high IDF). Symbol/keyword queries keep the original path boost unchanged — the IDF gate, not the boost itself, is NL-only.
- **NL-adaptive vector weight** — the semantic channel weight is `0.4` for plain lexical text and `0.6` for LLM-enriched chunks (the joint optimum across the eval suites), so the embedding signal matters most where the index has a rich semantic representation.
- **Dense-channel window sub-chunking** — oversized definitions (beyond the single-vector context limit) are embedded as up to 4 overlapping windows and retrieved by the maximum cosine across windows (max-sim), recovering tail recall that single-vector truncation lost. Window 0 is byte-identical to the prior single vector, so existing head vectors are unchanged; extra windows are stored under `<key>|w1..|wN` keys in the embeddings binary.

### LLM rerank: over-fetch + pool rescue

When `rerank` is enabled, the server now **over-fetches** a deeper candidate pool (configurable `poolSize`, default 15) and lets the LLM judge reorder it before truncating to `top_k`. This lets the reranker rescue a correct-but-deep result that would never reach the agent otherwise.

### HyDE (Hypothetical Document Embedding)

New opt-in query-side technique: generate a hypothetical code snippet for the NL query, embed it, and blend with the query vector to bridge vocabulary gaps. Off by default. Enable with `hyde: { enabled: true }` in config or the `hyde` parameter in `search_code`. The HyDE prompt is **language-aware** — the repo's dominant language (detected from extension counts and chunk metadata) selects a per-language hypothetical-snippet template, with a generic, never-regressing fallback when the language is unknown.

### Configuration overhaul

Default values changed:

| Key | Old default | New default | Reason |
|-----|-------------|-------------|--------|
| `storage` | `'memory'` | `'auto'` | Auto-selects SQLite above ~15k chunks |
| `embeddings` | (on unless `INDEXER_EMBEDDINGS=off`) | `false` | Explicit opt-in, lexical-first default |
| `embedProvider` | (none — Ollama was the only path) | `'auto'` | Falls back to local model, then lexical |
| `embedModel` | `'nomic-embed-text'` | `'nomic-embed-text'` | Unchanged |
| `rerank.topM` | `8` | `12` | Wider rerank pool |
| `rerank.poolSize` | (none) | `15` | New over-fetch parameter |

CLI flag rename: `--llm-enrichment` (and `--enrich`) → `--enrichment`. The old forms are no longer accepted.

Startup logging now prints the **effective configuration** (storage backend, model names, which optional features are active) and emits a warning for any opt-in feature with a known trade-off.

New embedding/enrichment flags and environment variables:

- `--mlx-embed-model` / `INDEXER_MLX_EMBED_MODEL` — MLX model id (default `mlx-community/all-MiniLM-L6-v2-4bit`).
- `EMBED_MODEL` — env alias for `--embed-model`.
- `ENRICH_MODEL` — env that enables enrichment and names its model. Setting `enrichment.model: 'auto'` probes the local Ollama and picks the strongest available code model (preference ladder `qwen2.5-coder:7b → 3b → deepseek-coder-v2 → 1.5b`), falling back to the `qwen2.5-coder:1.5b` floor — best-effort and non-throwing.
- `INDEXER_EMBED_CONCURRENCY` (parallel embed batches, default `4`), `INDEXER_EMBED_TIMEOUT_MS` (per-batch timeout, default `120000`), `INDEXER_MLX_BATCH_SIZE` (default `32`), `INDEXER_EMBED_STARTUP_TIMEOUT_MS` (default `120000`).

Fixed the Ollama endpoint in the embeddings test scripts from the non-default `:11435` to Ollama's real default `:11434` (`OLLAMA_HOST`).

### Symbol references (`find_references`)

`find_references` (`findReferences` in `mcp/topology.mjs`) fuses three reference kinds, combining `classifyCallers` (calls) with the new `db.findReferers` storage method (which returns the non-call referers — `extends` and `type_refs` matches):

- **calls** — `findCallers` + high/name-only classification
- **inherits** — chunks whose `extends` names the target (subclasses / implementers)
- **types** — chunks whose `type_refs` names the target (params, returns, fields)

Heritage is indexed for TS/JS, Python, Java, C#, Kotlin, Swift, Ruby, PHP, Rust, and Go (Go via struct/interface embedding rather than an inheritance keyword). Type-annotation users for TS/JS, Python, Java, C#, Kotlin, Swift, PHP, Rust, Go, and C (C# is field-precise: params, fields, properties, returns, base list).

### Symlink path traversal hardening

`get_file_skeleton` now resolves symlinks with `realpath` on both the project root and the requested target, then re-verifies containment. A symlink inside the project pointing outside it can no longer escape the sandbox.

### Benchmarking harness (`bench/`)

New reproducible benchmarking suite:

- `bench/cell.mjs` — cold-build per config, runs one fixture × one config combination
- `bench/configs.mjs` — config matrix definitions
- `bench/synth.mjs` / `bench/synth-agent.mjs` / `bench/synth-best.mjs` — report generators (cross-language, agent-facing, per-fixture best-config)
- `bench/tokens.mjs` — token-savings measurement (drives the token-savings tables below)
- `bench/repeat-score.mjs`, `bench/query.mjs`, `bench/dump-chunks.mjs`, `bench/fixtures-doc.mjs`, `bench/_confidence.mjs` — scoring, query, and reporting helpers
- `bench/verify-suite.mjs` / `bench/verify-ground-truth.mjs` / `bench/verify-structural.mjs` — fabrication guards: ensure query answers actually exist in the index
- `bench/structural.mjs` — structural fixture verifier
- `bench/parity.mjs` — byte-identical parity check between backends
- `bench/provenance.mjs` / `bench/provenance.json` — query provenance tracking
- Shell runners: `run-all.sh`, `run-costly.sh`, `run-final.sh`, `run-focused.sh`, `run-list.sh` (plus internal `_rerun-v2.sh`)

### Test suite expansion

New test files:

| File | What it covers |
|------|----------------|
| `test/callgraph.mjs` | Receiver-aware call graph, `classifyCallers` |
| `test/references.mjs` | `find_references` / `findReferers` |
| `test/routes.mjs` | `find_routes` / HTTP route extraction per framework |
| `test/json-output.mjs` | `response_format: 'json'` across all tools |
| `test/git-signals.mjs` | Git churn/recency/co-change sidecar |
| `test/security.mjs` | Path-traversal / symlink escape guard |
| `test/embeddings.mjs` | Embedding provider abstraction |
| `test/languages.mjs` | Per-language parsing (all 14 languages) |

(`test/unit.mjs` and `test/metrics.mjs` already existed in v1.2.0 and were extended, not added.)

New test suites for additional frameworks/languages: `alamofire`, `android`, `aspnet`, `cjson`, `css`, `django`, `laravel`, `nvm`, `rails`, `react`, `rust`, `spring`, `symfony`. (The `axios`, `express-js`, `fastapi`, `gin`, and `nestjs` suites already shipped in v1.2.0 and had their query sets expanded.)

New npm test scripts: `test:callgraph`, `test:references`, `test:routes`, `test:jsonout`, `test:gitsignals`, `test:security`, `test:embed`, `test:languages`.

### Agent benchmark harness (`test/agent/`)

New end-to-end agent benchmark that drives real MCP tools and traces an agent's call chain:

- `test/agent/agent-cli.mjs` — CLI entry point
- `test/agent/benchmark.config.mjs` — fixture and config registry
- `test/agent/fixtures.manifest.mjs` / `test/agent/setup-fixtures.mjs` — fixture manifest and setup
- `test/agent/search-cases.mjs` — search case definitions
- `test/agent/search-eval.mjs` — search evaluation with MRR/success@k scoring
- `test/agent/parse-eval.mjs` / `test/agent/score-answers.mjs` / `test/agent/se-mrr.mjs` — eval parsing and scoring
- `test/agent/analyze.mjs` / `assemble.mjs` — analysis pipeline
- `test/agent/tool-bridge.mjs` — bridges the agent to the MCP server under test

### Documentation

- **README.md** — rewritten to roughly a third its previous length (~700 → ~310 lines). Focused on the quick start, MCP tool reference, configuration trade-offs table, CLI flags, and environment variables. Benchmark numbers verifiable via `npm run test:eval`.
- **`docs/benchmarks/`** — new directory with detailed benchmark reports: `BENCH_BASELINE.md`, `BENCH_FULL_SUITE.md`, `BENCH_LANGUAGES.md`, `BENCH_SUMMARY.md`, `BENCH_AGENT.md`, `BENCH_PER_FIXTURE.md`, `FIXTURES.md`.
- **`docs/internals/IMPROVEMENT_STEMMING.md`** — internal design note for the Porter stemming bridge.
- **SECURITY.md** — updated to document the git-signals subprocess, the one-time model-weight download for the local embedding provider, and the strengthened symlink path guard.

### CI

- `.github/workflows/ci.yml` — verifies all 14 languages are present in `parse/languages.mjs`, checks the `.graph-indexer/` data directory is created (not the legacy root layout), validates that `prompts/CORE.md` and `prompts/INTEGRATION.md` are present, and runs a package-integrity step that `npm pack`s the tarball and asserts the `engine/`, `mcp/`, and `parse/` subdir modules ship and every entrypoint resolves its imports from the package.
- Removed `.github/workflows/publish-with-provenance.yml` (deprecated).

### Dependencies

New optional and production dependencies:

| Package | Version | Type | Purpose |
|---------|---------|------|---------|
| `tree-sitter-bash` | 0.23.3 | optional | Bash language parser |
| `tree-sitter-c` | 0.21.4 | optional | C language parser |
| `tree-sitter-swift` | 0.5.0 | optional | Swift language parser |
| `tree-sitter-scss` | 1.0.0 | optional | SCSS language parser |
| `@huggingface/transformers` | 3.8.1 | optional | In-process local embedding model |

(`hnswlib-node` 3.0.0, the optional approximate-nearest-neighbour vector index, already shipped in v1.2.0 — it is not new in v2.0.0.)

### Module reorganization (breaking only for deep imports)

Internal source files were grouped into directories. The CLI bins, the MCP server, and the default behaviour are unchanged; only code that imported a specific internal file path is affected. The package entry point (`import 'graph-indexer'`) now resolves to `engine/memory.mjs`.

| Old path | New path |
|----------|----------|
| `core-engine.mjs` | `engine/memory.mjs` |
| `sqlite-store.mjs` | `engine/sqlite.mjs` |
| `mcp-tools.mjs` | `mcp/tools.mjs` |
| `parser-utils.mjs` | split into `parse/extractor.mjs`, `parse/imports.mjs`, `parse/languages.mjs`, `parse/metadata.mjs`, `parse/routes.mjs` |

New modules added in the reorg: `engine/binary.mjs` (embedding binary codec + vector index), `mcp/format.mjs`, `mcp/topology.mjs`, `embeddings.mjs`, `git-signals.mjs`, `layout.mjs`, `daemon-ctl.mjs`, `daemon-lock.mjs`, `cli-ui.mjs`. (`config.mjs` and `storage.mjs` already existed in v1.2.0 and were extended, not added.)

---

### Metrics

#### Honesty note

v1.2.0 reported benchmark numbers using the enrichment + rerank path (the "best" configuration). v2.0.0 adopts a lexical-first honest baseline: the default path is lexical-only (zero dependencies), and opt-in configurations (embeddings, rerank, enrichment) are measured separately.

#### 5-suite benchmark (axios, express, NestJS, FastAPI, gin — 100 queries: 69 symbolic + 31 semantic)

This is the primary eval harness (`npm run test:eval`). All numbers are strict symbol-level (a hit requires the exact symbol, not just the correct file).

| Channel | s@1 | s@5 | MRR | Semantic rank-1 | Semantic s@5 | File-only inflation |
|---|---|---|---|---|---|---|
| **v1.2.0 — Hybrid + enrichment + rerank (best path)** | — | **0.82** | 0.73 | 0.35 | 0.65 | ~11.6% |
| **v2.0.0 — Lexical default (+ stemming + IDF path boost)** | 0.58 | **0.81** | 0.65 | 0.19 | **0.61** | ~11.6% |
| v2.0.0 — Hybrid nomic, no rerank | 0.60 | 0.79 | 0.68 | 0.23 | 0.58 | ~11.6% |
| v2.0.0 — Hybrid nomic + LLM rerank | 0.64 | 0.80 | 0.71 | 0.35 | 0.61 | ~11.6% |

Key changes vs v1.2.0:

- **Lexical s@5 reaches 0.81** (within 1 point of v1.2.0's best path of 0.82) with zero external dependencies, driven by Porter stemming and the IDF-gated path boost.
- **Semantic s@5 (lexical):** 0.48 floor → **0.61** from stemming + the IDF-gated path boost combined (+13 points, +27%); the path boost alone contributes +0.097 (0.516 → 0.613).
- **Overall s@5 (lexical):** 0.775 → **0.807** after IDF-gated path boost (+0.032, ≈+3 points).
- **Symbolic rank-1 unchanged** at 0.75 (byte-identical — stemming and path boost are additive and non-destructive to exact-match ranking).
- **File-only inflation corrected:** the v1.2.0 `0.1%` figure was a 100× display-formatting bug (`fmtPct` rendered a 0–1 fraction without the ×100 scale); the true lexical value is **~11.6%** overall, while the held-out validation set has **0.0%** inflation. The hybrid path does not increase inflation over lexical.
- **Backend parity:** memory vs SQLite results are byte-identical on all 100 queries (enforced in CI).

#### Stemming: held-out semantic recall

Porter stemming was validated on the **held-out query set** (15 queries, never used for tuning):

| Metric | Before stemming | After stemming | Δ |
|---|---|---|---|
| Held-out rank-1 (overall) | 0.733 | **0.800** | **+0.067** |
| Held-out semantic rank-1 | 0.200 | **0.400** | **+0.20 (+100%)** |
| Held-out MRR (overall) | 0.789 | **0.833** | +0.044 |
| Symbolic rank-1 / MRR (strict, tuning) | 0.755 / 0.807 | 0.755 / 0.807 | 0 (byte-identical) |

#### IDF-gated path boost delta (lexical, tuning channel)

| Metric | Before | After | Δ |
|---|---|---|---|
| Overall s@5 | 0.7749 | **0.8065** | **+0.0316** |
| Semantic s@5 (31q) | 0.5161 | **0.6129** | **+0.0968** |
| Semantic rank-1 | 0.1935 | 0.1935 | 0 |
| Symbolic rank-1 | 0.7536 | 0.7536 | 0 (byte-identical) |

#### Embedding quality: qwen3-embedding:4b (express suite, 21 queries)

| Channel | Semantic rank-1 | Semantic s@5 | Symbolic rank-1 |
|---|---|---|---|
| Lexical floor | 0.43 | 0.57 | 0.79 |
| nomic-embed-text (768-dim) | 0.43 | 0.57 | 0.79 |
| **qwen3-embedding:4b (2560-dim)** | 0.43 | **0.71** | 0.79 |

qwen3-embedding:4b raises express semantic s@5 from 0.57 to 0.71 (+24%) while holding rank-1 and symbolic precision. Cost: qwen3 4b is **~23× slower** than nomic-embed-text. The embedding channel is **off by default**; enable with `--embed-provider ollama --embed-model qwen3-embedding:4b` or the equivalent config.

#### Enrichment + HyDE (gin suite, semantic, opt-in)

| Config | Semantic rank-1 | Semantic MRR | Semantic s@5 |
|---|---|---|---|
| Lexical floor | 0.20 | 0.30 | 0.60 |
| Plain + rerank (7B) | 0.60 | 0.80 | 1.00 |
| Enriched (7B) + rerank | **0.80** | **0.87** | 1.00 |
| HyDE (qwen2.5-coder:7B), enriched corpus | **0.00** | 0.34 | **1.00** |

Key finding: enrichment **inverts** depending on embedder strength — it helps with weak embedders (MiniLM) but **regresses** with strong ones (qwen3). Enrichment and rerank remain correctly off by default.

#### Cross-language benchmark (18 fixtures, new in v2.0.0)

A new reproducible 18-language × 8-config matrix (`bench/`), covering all 14 supported languages and 8 frameworks on pinned OSS fixtures. All cells are cold, isolated builds; scoring is strict (exact symbol). Backend parity is 18/18 byte-identical.

| Metric (default lexical path, 18 languages) | Mean | Min | Max |
|---|---|---|---|
| Symbolic rank-1 | **70%** | 43% | 86% |
| Semantic rank-1 | **22%** | 0% | 67% |
| Semantic s@5 | **60%** | 0% | 100% |

Per-language symbolic rank-1 highlights (default path):

| Language | Fixture | Symbolic rank-1 | Semantic rank-1 | Semantic s@5 |
|---|---|---|---|---|
| Go | gin | 85% | 20% | 100% |
| Java/Spring | spring | 86% | 25% | 100% |
| Python/Django | django | 83% | 33% | 67% |
| Swift | alamofire | 78% | 67% | 100% |
| TypeScript | nestjs | 57% | 14% | 43% |
| SCSS | css | 43% | 25% | 50% |
| Bash | nvm | 44% | 33% | 67% |

Known structural gaps (invocation-verified, per `docs/benchmarks/BENCH_LANGUAGES.md` — the single source of truth): `get_call_graph` is effectively empty for SCSS (only 6 trivial `@include`/`@function` edges) and degraded to class-granularity for Java/Spring (call edges resolve, but methods aren't their own chunks). C#/ASP.NET, PHP/Laravel, and PHP/Symfony all resolve call edges (the Tier-1 C# and PHP call-graph fixes landed in v2.0.0). The `find_references` type-usage (`type_refs`) channel is empty for express-js, Django, Rails, SCSS, and Bash.

#### Token savings (18 languages)

Savings are measured as the token footprint of top-5 compact cards vs reading the full source files of those hits. The amortized column models one `get_chunk` full-body expansion (the recommended agent pattern).

| Language | Top-5 vs full files | Amortized (net 1 `get_chunk`) |
|---|---|---|
| Bash | 95.9% | 98.2% |
| C | 91.9% | 96.8% |
| Rust | 89.2% | 95.0% |
| Express (JS) | 88.9% | 93.5% |
| Go | 87.9% | 91.0% |
| FastAPI (Python) | 84.0% | 91.4% |
| Swift | 83.1% | 94.2% |
| Django (Python) | 78.1% | 90.9% |
| axios (JS) | 73.1% | 85.2% |
| NestJS (TS) | 66.7% | 84.4% |
| SCSS | 65.4% | 79.4% |
| Kotlin/Android | 62.7% | 82.3% |
| Ruby/Rails | 58.6% | 81.3% |
| PHP/Symfony | 57.6% | 86.1% |
| React (TS) | 56.4% | 82.1% |
| Java/Spring | 50.8% | 79.8% |
| PHP/Laravel | 32.4% | 72.7% |
| C#/ASP.NET | 19.3% | 65.1% |

v1.2.0 reported a mean of 79.0% (gross, 5 suites). v2.0.0's gross mean across the original 5 suites is 79.6%. The amortized figure (new metric) accounts for get_chunk expansions and is 65%–98% across languages.

#### End-to-end agent trace (real MCP tools, LLM sub-agent)

New in v2.0.0. Tested on 3 fixtures with real MCP tool calls traced through a sub-agent:

| Fixture | Tasks | Success | Avg tool calls | Avg tokens/task |
|---|---|---|---|---|
| gin (Go) | 2 | 100% | 4.0 | 4,286 |
| express-js (JS) | 2 | 100% | 3.5 | 2,089 |
| django (Python) | 2 | 100% | 5.0 | 1,763 |

---

## [1.2.0] — (main branch baseline)

Initial stable release with:

- AST indexing for 11 languages (TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin, C#, Ruby, PHP, CSS/SCSS)
- Hybrid lexical + optional dense-vector search with RRF fusion
- 8 MCP tools: `search_code`, `get_chunk`, `resolve_symbol`, `get_chunk_summary`, `get_file_skeleton`, `get_call_graph`, `get_repo_map`, `list_index_stats`
- In-memory and SQLite storage backends with backend parity
- Optional LLM enrichment and reranker
- Watch daemon with file-change tracking
- Interactive `npx graph-indexer` setup wizard

### Metrics (v1.2.0, 5 suites — 100 queries)

Measured with the enrichment + rerank path active (the "best" configuration at the time).

| Channel | Strict s@5 | Rank-1 | MRR | Symbolic rank-1 | Semantic rank-1 | Semantic s@5 |
|---|---|---|---|---|---|---|
| Hybrid + enrichment + rerank | 0.82 | 0.66 | 0.73 | 0.80 | 0.35 | 0.65 |
| Hybrid (no rerank) | — | — | — | — | 0.23 | 0.55 |
| Lexical-only | — | — | — | — | 0.19 | 0.48 |

Token savings: 79.0% (gross, top-5 cards vs full-file reads). Loose recall@5: 0.90.
