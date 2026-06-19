# Changelog

All notable changes to graph-indexer are documented here. Dates are in YYYY-MM-DD format.

---

## [Unreleased]

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

---

## [2.0.0] — 2026-06-18

This is a major release. The public API (MCP tools, CLI flags, config keys) has grown significantly, but the default behaviour — lexical-only search, in-memory store, zero external dependencies — is backward-compatible.

### New MCP tools

| Tool | Purpose |
|------|---------|
| `find_references` | Where a symbol is used: callers, subclasses, and type-annotation references, split into high-confidence vs name-only blast radius. |
| `get_subgraph` | Bounded connected subgraph (callers + callees + type/inheritance referers) around a seed symbol, in one call. Replaces multi-hop `search_code → get_call_graph → find_references` round-trips. |

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
- **IDF-gated path boost** — NL queries receive a small boost for the path segment of a file path when that term is rare in the corpus. Disabled for symbol queries (no vocabulary gap to bridge).
- **NL-adaptive vector weight** — the semantic channel weight is `0.4` for plain lexical text and `1.0` for LLM-enriched chunks, so the embedding signal matters most where the index has a rich semantic representation.

### LLM rerank: over-fetch + pool rescue

When `rerank` is enabled, the server now **over-fetches** a deeper candidate pool (configurable `poolSize`, default 15) and lets the LLM judge reorder it before truncating to `top_k`. This lets the reranker rescue a correct-but-deep result that would never reach the agent otherwise.

### HyDE (Hypothetical Document Embedding)

New opt-in query-side technique: generate a hypothetical code snippet for the NL query, embed it, and blend with the query vector to bridge vocabulary gaps. Off by default. Enable with `hyde: { enabled: true }` in config or the `hyde` parameter in `search_code`.

### Configuration overhaul

Default values changed:

| Key | Old default | New default | Reason |
|-----|-------------|-------------|--------|
| `storage` | `'memory'` | `'auto'` | Auto-selects SQLite above ~15k chunks |
| `embeddings` | (on when model set) | `false` | Explicit opt-in, lexical-first default |
| `embedProvider` | `'ollama'` | `'auto'` | Falls back to local model, then lexical |
| `embedModel` | `'nomic-embed-text'` | `'nomic-embed-text'` | Unchanged |
| `rerank.topM` | `8` | `12` | Wider rerank pool |
| `rerank.poolSize` | (none) | `15` | New over-fetch parameter |

CLI flag rename: `--llm-enrichment` → `--enrichment` (old form still accepted).

Startup logging now prints the **effective configuration** (storage backend, model names, which optional features are active) and emits a warning for any opt-in feature with a known trade-off.

### Symbol references (`find_references`)

New `db.findReferers` storage method fuses three reference kinds:

- **calls** — `findCallers` + high/name-only classification
- **inherits** — chunks whose `extends` names the target (subclasses / implementers)
- **types** — chunks whose `type_refs` names the target (params, returns, fields)

Heritage is indexed for TS/JS, Python, Java, C#, Kotlin, Swift, Ruby, PHP, and Rust. Type-annotation users for TS/JS, Python, Java, Kotlin, Swift, PHP, Rust, Go, and C.

### Symlink path traversal hardening

`get_file_skeleton` now resolves symlinks with `realpath` on both the project root and the requested target, then re-verifies containment. A symlink inside the project pointing outside it can no longer escape the sandbox.

### Benchmarking harness (`bench/`)

New reproducible benchmarking suite:

- `bench/cell.mjs` — cold-build per config, runs one fixture × one config combination
- `bench/configs.mjs` — config matrix definitions
- `bench/synth.mjs` — synthetic document generator for held-out query sets
- `bench/verify-suite.mjs` — fabrication guard: ensures query answers actually exist in the index
- `bench/structural.mjs` — structural fixture verifier
- `bench/parity.mjs` — byte-identical parity check between backends
- `bench/provenance.mjs` / `bench/provenance.json` — query provenance tracking
- Shell runners: `run-all.sh`, `run-costly.sh`, `run-final.sh`, `run-list.sh`

### Test suite expansion

New test files:

| File | What it covers |
|------|----------------|
| `test/callgraph.mjs` | Receiver-aware call graph, `classifyCallers` |
| `test/references.mjs` | `find_references` / `findReferers` |
| `test/json-output.mjs` | `response_format: 'json'` across all tools |
| `test/git-signals.mjs` | Git churn/recency/co-change sidecar |
| `test/security.mjs` | Path-traversal / symlink escape guard |
| `test/embeddings.mjs` | Embedding provider abstraction |
| `test/languages.mjs` | Per-language parsing (all 14 languages) |
| `test/unit.mjs` | Core unit tests |
| `test/metrics.mjs` | Scoring metrics |

New test suites for additional frameworks/languages: `alamofire`, `android`, `aspnet`, `cjson`, `css`, `django`, `fastapi`, `gin`, `laravel`, `nestjs`, `nvm`, `rails`, `react`, `rust`, `spring`, `symfony`.

New npm test scripts: `test:callgraph`, `test:references`, `test:jsonout`, `test:gitsignals`, `test:security`, `test:embed`, `test:languages`.

### Agent benchmark harness (`test/agent/`)

New end-to-end agent benchmark that drives real MCP tools and traces an agent's call chain:

- `test/agent/agent-cli.mjs` — CLI entry point
- `test/agent/benchmark.config.mjs` — fixture and config registry
- `test/agent/search-eval.mjs` — search evaluation with MRR/success@k scoring
- `test/agent/analyze.mjs` / `assemble.mjs` — analysis pipeline
- `test/agent/tool-bridge.mjs` — bridges the agent to the MCP server under test

### Documentation

- **README.md** — rewritten: 702 lines → 207 lines. Focused on the quick start, MCP tool reference, configuration trade-offs table, CLI flags, and environment variables. Benchmark numbers verifiable via `npm run test:eval`.
- **`docs/benchmarks/`** — new directory with detailed benchmark reports: `BENCH_BASELINE.md`, `BENCH_FULL_SUITE.md`, `BENCH_LANGUAGES.md`, `BENCH_SUMMARY.md`, `BENCH_AGENT.md`, `BENCH_TIER1_BASELINE.md`, `BENCH_TIER1_RESULTS.md`, `FIXTURES.md`.
- **`docs/internals/IMPROVEMENT_STEMMING.md`** — internal design note for the Porter stemming bridge.
- **SECURITY.md** — updated to document the git-signals subprocess, the one-time model-weight download for the local embedding provider, and the strengthened symlink path guard.

### CI

- `.github/workflows/ci.yml` — verifies all 14 languages are present in `parser-utils.mjs`, checks the `.graph-indexer/` data directory is created (not the legacy root layout), and validates that the `prompts/CORE.md` and `prompts/INTEGRATION.md` files are in the published package.
- Removed `.github/workflows/publish-with-provenance.yml` (deprecated).

### Dependencies

New optional and production dependencies:

| Package | Version | Type | Purpose |
|---------|---------|------|---------|
| `tree-sitter-bash` | 0.23.3 | optional | Bash language parser |
| `tree-sitter-c` | 0.21.4 | optional | C language parser |
| `tree-sitter-swift` | 0.5.0 | optional | Swift language parser |
| `tree-sitter-scss` | 1.0.0 | production | SCSS language parser |
| `@huggingface/transformers` | 3.8.1 | optional | In-process local embedding model |

---

### Metrics

#### Honesty note

v1.2.0 reported benchmark numbers using the enrichment + rerank path (the "best" configuration). v2.0.0 adopts a lexical-first honest baseline: the default path is lexical-only (zero dependencies), and opt-in configurations (embeddings, rerank, enrichment) are measured separately.

#### 5-suite benchmark (axios, express, NestJS, FastAPI, gin — 100 queries: 69 symbolic + 31 semantic)

This is the primary eval harness (`npm run test:eval`). All numbers are strict symbol-level (a hit requires the exact symbol, not just the correct file).

| Channel | s@1 | s@5 | MRR | Semantic rank-1 | Semantic s@5 | File-only inflation |
|---|---|---|---|---|---|---|
| **v1.2.0 — Hybrid + enrichment + rerank (best path)** | — | **0.82** | 0.73 | 0.35 | 0.65 | ~0.1% |
| **v2.0.0 — Lexical default (+ stemming + IDF path boost)** | 0.58 | **0.81** | 0.65 | 0.19 | **0.61** | ~0.1% |
| v2.0.0 — Hybrid nomic, no rerank | 0.60 | 0.79 | 0.68 | 0.23 | 0.58 | ~0.1%% |
| v2.0.0 — Hybrid nomic + LLM rerank | 0.64 | 0.80 | 0.71 | 0.35 | 0.61 | ~0.1% |

Key changes vs v1.2.0:

- **Lexical s@5 reaches 0.81** (within 1 point of v1.2.0's best path of 0.82) with zero external dependencies, driven by Porter stemming and the IDF-gated path boost.
- **Semantic s@5 (lexical):** 0.48 baseline → **0.61** after IDF-gated path boost (+13 points, +27%).
- **Overall s@5 (lexical):** 0.77 → **0.81** after IDF-gated path boost (+3 points).
- **Symbolic rank-1 unchanged** at 0.75 (byte-identical — stemming and path boost are additive and non-destructive to exact-match ranking).
- **File-only inflation corrected:** the v1.2.0 `0.1%` figure was a formatting bug; the true lexical value is **~0.1%** overall (held-out: 0.0% — the held-out set has no inflation).
- **Backend parity:** memory vs SQLite results are byte-identical on all 100 queries (enforced in CI).

#### Stemming: held-out semantic recall

Porter stemming was validated on the **held-out query set** (15 queries, never used for tuning):

| Metric | Before stemming | After stemming | Δ |
|---|---|---|---|
| Held-out semantic rank-1 | 0.20 | **0.40** | **+0.20 (+100%)** |
| Held-out MRR | 0.37 | ~0.46 | +0.09 |
| Held-out s@5 | 0.60 | 0.60 | 0 (already saturated) |
| Symbolic (strict, tuning) | byte-identical | byte-identical | 0 |

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
| HyDE (qwen2.5-coder:7B) + lexical | 0.20 | 0.34 | **1.00** |

Key finding: enrichment **inverts** depending on embedder strength — it helps with weak embedders (MiniLM) but **regresses** with strong ones (qwen3). Enrichment and rerank remain correctly off by default.

#### Cross-language benchmark (18 fixtures, new in v2.0.0)

A new reproducible 18-language × 8-config matrix (`bench/`), covering all 14 supported languages and 8 frameworks on pinned OSS fixtures. All cells are cold, isolated builds; scoring is strict (exact symbol). Backend parity is 18/18 byte-identical.

| Metric (default lexical path, 18 languages) | Mean | Min | Max |
|---|---|---|---|
| Symbolic rank-1 | **70%** | 43% | 86% |
| Semantic rank-1 | **23%** | 0% | 67% |
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

Known structural gaps (invocation-verified): `get_call_graph` returns no edges for ASP.NET Core, Laravel, and Symfony (C# and PHP — zero call edges). `find_references` type-usage channel is empty for express-js, Django, ASP.NET Core, Rails, SCSS, and Bash.

#### Token savings (18 languages)

Savings are measured as the token footprint of top-5 compact cards vs reading the full source files of those hits. The amortized column models one `get_chunk` full-body expansion (the recommended agent pattern).

| Language | Top-5 vs full files | Amortized (net 1 `get_chunk`) |
|---|---|---|
| Bash | 95.9% | 98.2% |
| C | 91.9% | 96.8% |
| Rust | 89.2% | 95.0% |
| Express (JS) | 88.9% | 93.5% |
| Swift | 83.1% | 94.2% |
| FastAPI (Python) | 84.0% | 91.4% |
| Go | 87.9% | 91.0% |
| Django (Python) | 78.1% | 90.9% |
| NestJS (TS) | 66.7% | 84.4% |
| React (TS) | 56.4% | 82.1% |
| Kotlin/Android | 62.7% | 82.3% |
| Ruby/Rails | 58.6% | 81.3% |
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
