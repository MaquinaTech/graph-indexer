<div align="center">
  <img src="https://raw.githubusercontent.com/MaquinaTech/graph-indexer/main/assets/logo.jpg" alt="Graph Indexer Logo" width="250" />

  <h1>Graph Indexer</h1>

  <p>
    <em>A local MCP server that gives AI coding agents an AST-precise, topology-aware index of your codebase.</em>
  </p>

  <a href="https://www.npmjs.com/package/graph-indexer"><img src="https://img.shields.io/npm/v/graph-indexer?color=007acc&style=for-the-badge" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/graph-indexer"><img src="https://img.shields.io/npm/dt/graph-indexer?color=4caf50&style=for-the-badge" alt="NPM Downloads"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen?style=for-the-badge&logo=nodedotjs" alt="Node.js 18+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge" alt="License: MIT"></a>
</div>

<br />

## What it does

Graph Indexer is a local [Model Context Protocol](https://modelcontextprotocol.io) server that builds an AST-precise index of your repository with Tree-sitter and serves it to AI coding agents. Instead of grepping text or embedding whole files, it indexes *semantic chunks* — functions, classes, methods — and the call graph and import topology that connect them, so an agent can find the right symbol, see every caller and dependency that would be affected by a change, and resolve references across files. It runs entirely on your machine: the default search path is lexical (BM25 + morphological stemming) and needs no model, no daemon, and no network. Dense vector embeddings, LLM enrichment, and an LLM reranker are all available but off by default — you opt into each one when you have a measured reason to.

**Why it matters for AI coding agents:**

- **Up to 98.2% Token Savings:** Delivers the exact AST chunk needed instead of dumping 1M token context files.
- **Blast radius before every edit.** `get_call_graph` and `find_references` surface every caller, subclass, and dependency a change would touch, so the agent reasons about impact on code it never opened.
- **Private by default.** Everything runs locally; the default path makes zero network calls and needs no model — your code never leaves your machine.
- **One command, any language.** Guided setup wires your editors in seconds, and the zero-dependency lexical engine indexes 14 languages out of the box.

## 📦 Prerequisites

* **Node.js** 18+ (22+ recommended if you hit >15k chunks for automatic SQLite scaling).
* **OS:** Agnostic. macOS Apple Silicon required only for the optional MLX GPU acceleration.
* **Optional:** Ollama for embeddings, enrichment, and reranking (see [Ollama setup](#ollama-setup)).
* **Optional:** Python 3.10+ for the MLX embedder (macOS Apple Silicon only).

## Quick start

### 1. Run the Interactive Indexer
Go to your project root (works for Python, Go, Rust, TS/JS, C#, and 9 more languages) and run:

```bash
npx graph-indexer /path/to/your/repo
```

That runs the [guided setup](#guided-setup) against that repo, which leaves it ready to use. It is idempotent — re-run it whenever you add a language or change a setting; it merges into what you already have and never clobbers another tool's config. Every generated file lands in `.graph-indexer/` (git-ignored), so your repo root stays clean.

### 2. Connect Your Agent

**If you ran the guided setup and selected your agent in step 4, this is already done — skip ahead.**

The guided setup writes the MCP config automatically (with absolute paths that survive GUI launches) for **Claude Code** (`.mcp.json`), **Claude Desktop**, **Cursor** (`.cursor/mcp.json`), and **VS Code** (`.vscode/mcp.json`). Re-run `npx graph-indexer /path/to/your/repo` at any time to add or refresh a client.

<details>
<summary>Manual wiring (if you skipped setup or use a client not listed above)</summary>

#### Claude Code — CLI

```bash
claude mcp add graph-indexer -- npx -y -p graph-indexer idx-mcp --repo /path/to/your/repo
```

#### Cursor — `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "graph-indexer": {
      "command": "npx",
      "args": ["-y", "-p", "graph-indexer", "idx-mcp", "--repo", "/path/to/your/repo"]
    }
  }
}
```

#### VS Code — `.vscode/mcp.json`

```json
{
  "servers": {
    "graph-indexer": {
      "command": "npx",
      "args": ["-y", "-p", "graph-indexer", "idx-mcp", "--repo", "/path/to/your/repo"]
    }
  }
}
```

#### Claude Desktop — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "graph-indexer": {
      "command": "npx",
      "args": ["-y", "-p", "graph-indexer", "idx-mcp", "--repo", "/path/to/your/repo"]
    }
  }
}
```

> **Note:** The `-p graph-indexer idx-mcp` form is required — `npx graph-indexer` runs the setup wizard, not the MCP server. If `npx` isn't on your GUI PATH (common on macOS when launching editors from Finder/Dock), run the guided setup instead — it writes absolute paths that always work.

</details>

Once connected, the agent can call `search_code`. A query like `search_code("rate limiting middleware")` returns ranked semantic chunks, not whole files:

```jsonc
[
  {
    "score": 8.41,
    "chunk": {
      "id": "src/middleware/rateLimit.ts:14",
      "file_path": "src/middleware/rateLimit.ts",
      "name": "rateLimiter",
      "node_type": "function_declaration",
      "start_line": 14, "end_line": 47,
      "calls": ["tokenBucket", "getClientKey"],
      "class_context": ""
    }
  }
]
```

The agent can then call `get_call_graph("rateLimiter")` to see what calls it (the blast radius) before changing it.

## Guided setup

`npx graph-indexer <path>` runs an interactive wizard that leaves the repo ready to use. It is **idempotent** — re-run it whenever you add a language or change a setting; it merges into what you already have and never clobbers another tool's config. Every generated file lands in `.graph-indexer/` (git-ignored), so your repo root stays clean.

Before the steps, it scans the repo to pre-select your stack — languages from a bounded file walk, frameworks from your manifests (`package.json`, `pyproject.toml`, `composer.json`, `pom.xml`, `Gemfile`, `*.csproj`, …) — and, if it finds a pre-v1.4 layout, tidies those stray artifacts into `.graph-indexer/` first. Then six steps:

| Step | You choose | What happens |
|------|------------|--------------|
| **1 · Languages** | Languages to index | Detected languages are pre-checked — press Enter to accept. Selecting none indexes **all** supported languages. |
| **2 · Frameworks** | Prompt add-ons | Filtered to your languages and pre-checked from detection. Sharpens the agent prompt for React, Express/NestJS, FastAPI/Django, Spring, Rails, Laravel/Symfony, ASP.NET, or Android. |
| **3 · Search engine & LLM** | Retrieval engine | **Press Enter for the recommended default** — lexical search, no LLM, no network. Everything heavier is opt-in (see below). |
| **4 · Agents & IDEs** | Your coding tools | Multi-select which agents to wire: Claude Code/Desktop, Cursor, VS Code/Copilot, Windsurf, Cline/Roo, JetBrains Junie, Codex (AGENTS.md), Gemini CLI. Pre-checked from your saved choice, else what's detected, else all. Drives steps 5 **and** 7 — deselect a tool and graph-indexer generates nothing for it. |
| **5 · MCP server wiring** | *(automatic)* | Wires the MCP server for each **selected** editor (VS Code, Cursor, Claude Desktop, Claude Code). **Merge-safe**: your other MCP servers and keys are preserved. |
| **6 · Project files & daemon** | *(automatic)* | Adds `mcp:*` npm scripts (index + daemon control), a managed `.gitignore` block, and `.graph-indexer/config.json` (which remembers your agent selection). |
| **7 · Agent instructions** | *(automatic)* | Always writes the canonical layered prompt (`GRAPH_INDEXER_PROMPT.md`) + a `GRAPH_INDEXER_DOMAIN.md` template for your own rules. Then, for each **selected** agent: `@`-imports (no duplication) in `CLAUDE.md` and `GEMINI.md`; rule files for Cursor, Windsurf, and Cline/Roo; and managed blocks in `.github/copilot-instructions.md`, `.junie/guidelines.md`, and `AGENTS.md` (Codex/Zed/Jules) — preserving anything already there. |

It finishes with a grouped summary (created / updated / kept / skipped / warnings), offers to **build the index now**, and prints your next steps.

**Most repos need nothing past step 3's default** — the lexical engine has zero dependencies and works in any language. Step 3 only branches when you decline the defaults:

- **Storage** — `auto` (in-memory, promoting to SQLite past ~15k chunks), or force in-memory / SQLite.
- **Embeddings** — `off` (default), `auto`, **Ollama**, **local** (in-process MiniLM, ~25 MB on first index), or **Apple Metal (MLX)** on macOS. Ollama is probed only when you actually pick it; choosing MLX offers to provision its Python venv on the spot.
- **Enrichment / reranker** — off by default. A measured per-language note is shown before the reranker prompt (it helps Go/Python, regresses JS/TS). Model pickers are provider-aware, and if you select MLX the wizard verifies `mlx_lm.server` end-to-end — installing `mlx-lm`, starting the server, and pre-loading the model — so your first index can't fail against a server that isn't up.

### Non-interactive & preview

| Flag | Effect |
|------|--------|
| `--yes`, `-y` | Accept all detected/default selections — no prompts (CI). |
| `--dry-run` | Print every file action without writing anything. |
| `--all-languages` | Index every supported language (implies `--yes`). |
| `--help`, `-h` | Show usage. |

Setup also runs non-interactively whenever stdin isn't a TTY, so piping into it behaves like `--yes`.

## How it works

- **AST indexing.** Tree-sitter parses each file into a syntax tree, and the indexer extracts one *chunk* per top-level definition (function, class, method, struct, …) with its name, parameters, line range, call sites, and enclosing class. A "god class" is split so its methods become their own chunks. Supported languages: **TypeScript/JavaScript** (`.ts .tsx .js .jsx .mjs .cjs`), **Python**, **Go**, **Rust**, **Java**, **Kotlin**, **C#**, **C**, **Ruby**, **PHP**, **Bash**, and **Swift**, plus **CSS/SCSS**.
- **Retrieval.** A hybrid ranker fuses a lexical channel (BM25 with camelCase splitting and language-agnostic Porter stemming) with an optional dense-vector channel (local embeddings) via Reciprocal Rank Fusion. With embeddings off, only the lexical channel runs — and it is the default.
- **Call graph.** `get_call_graph` returns the callers and callees of a symbol — the *blast radius* of a change — so an agent can see what it might break before editing code it never read.
- **Backend parity.** The in-memory and SQLite backends share the same ranking core, so they return identical top-5 results for the same query (enforced by `test/sqlite.mjs`).

### MCP tools

| Tool | Returns |
|------|---------|
| `search_code` | Ranked semantic chunks for a natural-language or symbol query. |
| `get_chunk` | The full source of one chunk by id. |
| `get_chunk_summary` | A compact summary of a chunk (signature, calls, context). |
| `resolve_symbol` | Exact, case-insensitive symbol lookup by name. |
| `get_file_skeleton` | The top-level structure (symbols + signatures) of a file. |
| `get_call_graph` | Callers and callees of a symbol — the blast radius. |
| `find_references` | Where a symbol is used: callers, subclasses, and type references. |
| `find_routes` | HTTP routes mapped to their handler chunks (NestJS, FastAPI/Flask, Spring, Express/Koa). |
| `get_subgraph` | A bounded connected subgraph around a seed symbol — its callees, high-confidence callers, and type/inheritance users, in one call. |
| `get_repo_map` | A high-level map of the repository's modules and topology. With `--symbol-graph`, also lists the most-central symbols (PageRank). |
| `list_index_stats` | Index health: chunk/file/symbol/vector counts and the active config. |
| `tests_for` | The test/spec chunks that exercise a symbol (call or reference it) — which tests to run or update before changing it. |
| `explain_symbol` | One-call overview of a symbol: signature, callees, callers (blast radius), subclasses/type users, routes it handles, tests, git recency/co-change, and (with `--symbol-graph`) its symbol-centrality rank. |
| `impact_of_edit` | The precise blast radius of a change: pass the symbols/files you're about to edit → transitively-affected code, the routes that reach it, the tests to run, and git co-change. Most precise with `--symbol-graph`; `precision: 'strict'` follows only provably-unambiguous (`resolved`) edges (best on a `--resolver precise` or `--resolver scip` index). |
| `trace_taint` | Security: trace untrusted data from a source (request body/query/params, argv/env, stdin) to a dangerous sink (eval/exec, SQL, fs/path, HTML, outbound request) across the call graph — injection-class risks (rce/sqli/xss/path/ssrf) with the source→sink path. JS/TS, Python, Java, Go; heuristic finder, not a verifier. |
| `find_tainted_sinks` | Security orientation: every dangerous sink grouped by category, each flagged with whether an untrusted source reaches it — map the attack surface, then `trace_taint` a specific one. |

## Configuration

Everything beyond the lexical default is opt-in. The server, indexer, and daemon all print their **effective configuration** at startup (storage backend, model names, which optional features are on), and emit a visible warning whenever an opt-in feature has a known trade-off — nothing is enabled silently.

### Headline trade-offs

| Option | Default | When to enable | Cost |
|--------|---------|----------------|------|
| `--embeddings` | off | Larger repos where recall matters; lifts success@5 | Requires Ollama or the in-process MiniLM model; slower indexing |
| `--embed-model qwen3-embedding:4b` | `nomic-embed-text` | A code-specialized embedder — lifts agent-style recall on Go (and some code-heavy repos); measure first | slower indexing; requires Ollama; neutral on JS/Python in our tests |
| `--enrichment` | off | Only useful paired with `--rerank`; alone it regresses | slowest indexing |
| `--rerank` | off | Go/Python repos with weak semantic recall; regresses JS repos | Requires an Ollama 7B model; adds query latency |
| `--rerank --rerank-provider cross-encoder` | `generative` | Want a reranker's semantic lift with **no LLM/daemon** — air-gapped, deterministic, fast | Optional `@huggingface/transformers`; smaller lift than the 7B judge |
| `--use-sqlite` | `auto` | Repos past ~15k chunks or memory-constrained environments | Slightly higher query latency; needs Node 22+ |

For most repos, the default (lexical + stemming, no embeddings) is the right starting point. Enable embeddings when you notice the agent missing chunks it should find. Enable the reranker only on Go or Python repos after measuring whether it helps — it is known to regress JavaScript repositories.

**Reranker providers.** The reranker reorders the over-fetched candidate pool on natural-language queries; two providers are available (`--rerank-provider`):

- **`generative`** (default) — a local LLM judge (Ollama 7B). The strongest reranker in our benchmarks (agent-style semantic rank-1 0.19 → 0.42 across the core suites; no symbolic regression), but it needs a running model and its output is non-deterministic.
- **`cross-encoder`** — a local MS-MARCO cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`, via the optional `@huggingface/transformers`). It scores each (query, candidate) pair and sorts. **Air-gapped, deterministic, and fast** (no Ollama/daemon; the model downloads once). It captures part of the lift — agent-style semantic rank-1 0.19 → 0.26, and notably Go (gin) 0.20 → 0.40 and Python (fastapi) 0.14 → 0.29 — but less than the 7B judge, and like all rerankers it is mixed on JavaScript. Pick it when you want a reranker without an LLM in the loop. Measure on your repo: `npm run test:eval -- --rerank --rerank-provider cross-encoder`.

### All CLI flags

| Flag | Default | Effect |
|------|---------|--------|
| `--repo <path>` | current directory | Repository to index / serve. |
| `--embeddings` | off | Enable the dense-vector channel. |
| `--embed-model <model>` | `nomic-embed-text` | Ollama embedding model (e.g. `qwen3-embedding:4b`). |
| `--embed-provider <auto\|ollama\|local\|mlx\|off>` | `auto` | Force the embedding backend (see [Embedder backends](#embedder-backends)). |
| `--mlx-embed-model <model>` | `mlx-community/all-MiniLM-L6-v2-4bit` | Model loaded by the MLX (Apple Metal) embedder. |
| `--use-sqlite` | `auto` | Force the disk-backed SQLite backend. |
| `--enrichment` | off | Enable LLM enrichment of central chunks. |
| `--enrich-model <model>` | `qwen2.5-coder:1.5b` | Model used for enrichment. |
| `--enrich-max <n>` | 500 | Cap on new LLM calls per index run. |
| `--enrich-concurrency <n>` | 4 | Parallel Ollama requests during enrichment. |
| `--rerank` | off | Enable the reranker (reorders the over-fetched pool on NL queries). |
| `--rerank-provider <generative\|cross-encoder>` | `generative` | `generative` = local LLM judge; `cross-encoder` = local air-gapped MS-MARCO cross-encoder (optional `@huggingface/transformers`, no Ollama). |
| `--interprocedural` | off | Index-time inter-procedural receiver-type fixpoint: propagate return types along factory call chains so multi-hop receivers resolve in `get_call_graph` / `find_references`. Air-gapped, deterministic; default index byte-identical; search ranking unaffected. |
| `--symbol-graph` | off | Persist a resolved chunk→chunk symbol graph (edges with kind + confidence) at index time, exposed via `getEdges`. `findCallers`/`findReferers` read it (identical sets, fall back to a scan). Also computes symbol-level centrality (confidence-weighted PageRank over the edges), surfaced by `explain_symbol` and `get_repo_map`. Air-gapped, deterministic; default index byte-identical; search ranking unaffected. |
| `--taint` | off | Precompute and serialize the taint flow set (C2) at index time, so `trace_taint` / `find_tainted_sinks` answer instantly instead of walking the call graph per query. Computed against the symbol-graph edges when `--symbol-graph` is on (cross-function precision), else `chunk.calls`. Both backends serve byte-identical flows; default index byte-identical; air-gapped. |
| `--resolver <heuristic\|precise\|scip>` | `heuristic` | Resolver provider for the symbol graph. `precise` lifts provably-unambiguous edges (sole definition, or a type-pinned receiver) from `high` to a `resolved` tier. `scip` ingests a locally-generated SCIP index (`--scip-index`) and resolves edges by *real cross-file bindings* — promoting confirmed edges to `resolved` **and suppressing the wrong-target fan-out** an ambiguous same-name reference would otherwise emit. Both power `impact_of_edit(precision: 'strict')`. Only meaningful with `--symbol-graph`. |
| `--scip-index <path>` | — | Path to a SCIP index generated locally by your own toolchain (`scip-typescript`, `scip-python`, `scip-java`, `rust-analyzer --scip`), consumed by `--resolver scip`. Air-gapped (a local file read — sealed-compatible). Files the index doesn't cover fall back to heuristic confidence (never worse); coverage is printed at index time. Accepts the `.scip` protobuf or a SCIP-shaped JSON. |
| `--sealed [strict\|local]` | off | **Sealed mode** — air-gapped *enforced and verifiable*. `strict` = zero network egress (lexical-only); `local` = loopback only (local LLM/embedders OK, nothing off-box). Fail-closed: refuses to start if any enabled feature would egress beyond the tier, and installs a deny-by-default runtime egress guard. Bare `--sealed` = `strict`. |
| `--attest` | — | Print the deterministic sealed-mode manifest (tier, providers, egress posture) and exit — an auditor/CI artifact. Add `--sign-key <path>` to print a **cryptographically signed** envelope instead (Ed25519/RSA/EC via `node:crypto`; air-gapped). |
| `--gen-attestation-key <prefix>` | — | Write an Ed25519 attestation keypair (`<prefix>.key` private, `<prefix>.pub` public) and exit. |
| `--verify-attestation <file> --pub-key <path>` | — | Verify a signed attestation's signature and report whether it still matches the current effective config (policy drift → non-zero exit). |
| `--no-git-signals` | (signals on) | Skip collecting local git churn/recency/co-change. |
| `--git-rank-boost <0..1>` | 0 | Opt-in weight for git recency/churn in ranking (0 = ranking unchanged). |
| `--llm-provider <ollama\|mlx>` | `ollama` | LLM backend for enrichment, reranking, and HyDE. `mlx` routes calls to a local `mlx_lm.server`. |
| `--mlx-lm-host <url>` | `http://localhost:8080` | Endpoint for the `mlx_lm.server` when `--llm-provider mlx` is set. |

### All environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `MCP_PROJECT_ROOT` | current directory | Repository root when `--repo` is not given. |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint for embeddings/enrichment/rerank. |
| `INDEXER_EMBEDDINGS` | `off` | `on` enables embeddings; `off` always wins over `--embeddings`. |
| `EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model (overrides config; overridden by `--embed-model`). |
| `INDEXER_EMBED_PROVIDER` | `auto` | `auto` \| `ollama` \| `local` \| `mlx` \| `off`. |
| `INDEXER_MLX_EMBED_MODEL` | `mlx-community/all-MiniLM-L6-v2-4bit` | Model loaded by the MLX embedder (overridden by `--mlx-embed-model`). |
| `INDEXER_MLX_BATCH_SIZE` | 32 | Texts per batch sent to the MLX subprocess (raise on large unified memory). |
| `INDEXER_STORAGE` | `auto` | `auto` \| `memory` \| `sqlite`. |
| `ENRICH_MODEL` | (unset) | Naming a model enables enrichment and selects it. |
| `RERANK_MODEL` | (unset) | Naming a model enables the (generative) reranker and selects it. |
| `RERANK_PROVIDER` | `generative` | `generative` (LLM judge) or `cross-encoder` (local air-gapped); setting it enables reranking. |
| `RERANK_CROSS_ENCODER_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Cross-encoder model id (downloaded on first use). |
| `INDEXER_GIT_SIGNALS` | (on) | Set to `off` to skip git-signal collection. |
| `INDEXER_INTERPROCEDURAL` | (off) | `on` enables the index-time inter-procedural receiver-type fixpoint (`--interprocedural`). |
| `INDEXER_SYMBOL_GRAPH` | (off) | `on` builds the persistent resolved symbol graph (`--symbol-graph`). |
| `INDEXER_TAINT` | (off) | `on` precomputes + serializes the taint flow set at index time (`--taint`). |
| `INDEXER_RESOLVER` | `heuristic` | `precise` enables the precise resolver; `scip` enables the SCIP cross-file resolver (`resolved` edge tier) for the symbol graph (`--resolver`). |
| `INDEXER_SCIP_INDEX` | (unset) | Path to a locally-generated SCIP index for `--resolver scip` (`--scip-index`). |
| `INDEXER_SEALED` | (off) | `strict` (or `on`) / `local` enables sealed mode (`--sealed`): fail-closed validation + a runtime egress guard. |
| `INDEXER_GIT_RANK_BOOST` | 0 | Opt-in git recency/churn ranking weight (0..1). |
| `INDEXER_LLM_PROVIDER` | `ollama` | LLM backend for enrichment, reranking, and HyDE: `ollama` or `mlx`. |
| `INDEXER_MLX_LM_HOST` | `http://localhost:8080` | Endpoint for the `mlx_lm.server` when `INDEXER_LLM_PROVIDER=mlx`. |
| `INDEXER_EMBED_CONCURRENCY` | 4 | Parallel embedding batches; lower to 1 for large models on modest hardware. |
| `INDEXER_EMBED_TIMEOUT_MS` | 120000 | Per-batch embedding timeout; raise for very large models. |

When embeddings are enabled, the provider is selected in this order, and every fallback is logged (never silent): Ollama with `EMBED_MODEL` if set and reachable → Ollama with `nomic-embed-text` → the in-process MiniLM model (optional `@huggingface/transformers`) → lexical-only with a warning.

### Embedder backends

Set the backend with `--embed-provider` (or `INDEXER_EMBED_PROVIDER`). `mlx` is a native Python embedder that runs the Apple Metal GPU as a reused subprocess — faster in-process vectors than the bundled Xenova path, with no running Ollama daemon. The in-process (`local`) and `mlx` backends produce all-MiniLM-L6-v2-family **384-dim** vectors; the default `auto`→Ollama path uses `nomic-embed-text` (768-dim).

| Backend | `--embed-provider` | Platform | Throughput¹ | Setup |
|---------|--------------------|----------|-------------|-------|
| Auto (Ollama → local → off) | `auto` (default) | any | varies | none |
| In-process (Xenova) | `local` | any | ~18 ch/s | `npm i @huggingface/transformers` |
| **Apple Metal (MLX)** | **`mlx`** | **macOS Apple Silicon** | **~42 ch/s** | `npm run embed:setup:mlx` |
| Ollama daemon | `ollama` | any | ~14 ch/s² | `ollama serve` + `ollama pull` |

¹ **Throughput is hardware-dependent.** These figures are the median of 3 cold builds on an **Apple M2 Mac mini (24 GB)** indexing the `express-js` fixture (389 chunks): `node bench/cell.mjs express-js <E0|E0_MLX|O0>`. Expect different numbers on other chips; reproduce on your own machine. Throughput also varies with system load, model warm state, and corpus size — larger repos amortize cold-start better (e.g. Ollama/nomic reaches ~32 ch/s on the larger `gin` corpus).

² On Apple Silicon, Ollama already uses the Metal GPU internally (via llama.cpp). The `mlx` provider's advantage comes from a smaller model (all-MiniLM-L6-v2-4bit, 22M params, 384-dim) and no HTTP round-trip, not from GPU vs CPU.

The index records which provider/model built it (in the `code-index.embeddings.bin.meta.json` sidecar) and queries with the same one, so vectors never get mixed across models. Switching providers or the MLX model between builds is detected and triggers a clean re-embed.

**Code-specialized embedding models.** The default `nomic-embed-text` is a general-purpose embedder. Models trained on code — `qwen3-embedding`, `nomic-embed-code`, `jina-embeddings-v2-base-code` — embed code semantics more faithfully and can lift agent-style (natural-language) recall. Select one with `--embed-model <name>` (Ollama); it is stamped into the index meta and queried with the same model so vectors never get mixed. **Measure before adopting** — in our benchmarks `qwen3-embedding` lifted Go (gin) semantic rank-1 0.20 → 0.40 but was neutral on Python (django) and JavaScript (express), and it indexes substantially slower than `nomic-embed-text`. Run `npm run test:eval -- --embeddings` on your own repo to confirm the trade-off. We also evaluated *re-weighting the vector channel upward* for these stronger embedders and found **no measurable recall@5 gain** (it regressed rank-1/symbolic at higher weights) — the existing default weighting already extracts the benefit, so there is no separate "code weight" knob. `jina-embeddings-v2-base-code` remains opt-in only: it helped some fixtures, regressed others, and indexes far slower, so it is never a default.

**macOS Apple Silicon (recommended):**

```bash
npm run embed:setup:mlx                                  # one-time: creates embedders/venv-mlx + installs MLX
npx idx-index --repo . --embeddings --embed-provider mlx
```

`embed:setup:mlx` provisions a **dedicated Python virtualenv** under `embedders/venv-mlx` (so MLX's deps never touch your system Python) and is idempotent — re-running it is a no-op once ready. The interactive setup (`npx graph-indexer`) offers MLX directly and can run this step for you. The first index downloads the model (~90 MB) into the Hugging Face cache; later builds reuse it.

Choose a different MLX model with `--mlx-embed-model <id>` (or `INDEXER_MLX_EMBED_MODEL`); it must be an `mlx_embeddings`-compatible sentence model, and the default `mlx-community/all-MiniLM-L6-v2-4bit` is the proven option. Tune batch size with `INDEXER_MLX_BATCH_SIZE` (default 32; lower to 16 on 8 GB machines, raise to 64 on M-series Max/Ultra). `mlx` is macOS-only; requesting it elsewhere fails fast with the alternative to use.

## Benchmarks

Every number here is produced by the eval harness on cold, isolated builds — never hand-edited — with **strict scoring** (exact symbol match, no file-path fallback) against a **held-out** split (~20–25% per language, never used to tune). Reproduce it all with `npm run test:eval`.

What the measurements say, across 18 real-world fixtures spanning every supported language:

- **The zero-dependency lexical default is the right starting point.** It wins the held-out metric outright on 2 fixtures, and 6 more need only a cheap in-process embedder — so **8 of 18 run with no Ollama and no network**. Most repos never need more.
- **Symbolic lookups are strong** (mean rank-1 ≈ 0.70). Behavioural, natural-language queries are harder (≈ 0.30 overall (held-out semantic rank-1 0.40 with stemming)) — that's where the optional embedding and reranker channels earn their keep.
- **Optional features are measured, not assumed.** Dense embeddings lift recall on larger repos; the LLM reranker is language- and repo-dependent (it lifts 8 fixtures but taxes JavaScript and Spring); enrichment helps only where proven (just rust). Setup surfaces each trade-off before you enable it.
- **Backend parity:** the in-memory and SQLite backends return byte-identical top-5 on all 18 fixtures (gated by `test/sqlite.mjs`).

Per-fixture best configs, 3× spreads, and copy-paste enable flags live in **[docs/benchmarks/BENCH_PER_FIXTURE.md](docs/benchmarks/BENCH_PER_FIXTURE.md)**.

### Structural coverage by language

`get_call_graph` and `find_references` are richest for typed languages. Every verdict is confirmed by invocation on the real index, not by reading field counts:

| Capability | Strong | Limited |
|---|---|---|
| **Call graph** (callers/callees) | resolves on every supported language | Java/Spring is class-granular; SCSS effectively none |
| **Caller precision** | receiver-aware: TS/JS, Python, C#, Swift, PHP | name-only: Go, Rust, Kotlin, Ruby, Bash, C |
| **Typed `find_references`** | precise: TS/JS, Python · field-precise: C# | heuristic: Java/PHP/Kotlin/Swift/Rust/Go/C · empty: Ruby, Bash, SCSS, dynamic JS/Python |

AST chunking and lexical search cover **every** supported language; only the typed cross-reference channel narrows for dynamic ones.

**Multi-hop receivers (`--interprocedural`).** Caller precision relies on resolving a call's receiver type. Intra-procedurally, graph-indexer already resolves `const r = makeRepo(); r.save()` one hop (reading `makeRepo`'s recorded return type). The opt-in `--interprocedural` flag adds an index-time fixpoint that propagates return types *along factory call chains*, so a receiver whose type comes from a multi-hop or unannotated factory (`makeRepoIndirect()` → `makeRepo()` → `new OrderRepo()`) still resolves to its concrete class — promoting those callers from *name-only* to *high-confidence* in `get_call_graph` / `find_references`. It is air-gapped and deterministic, the result is serialized into the index (both backends identical), and it leaves search ranking and the default index byte-identical. Note: the watch daemon updates one file at a time and does not re-run the whole-program pass, so cross-file chains refresh on the next full `idx-index` (degrading to single-hop until then, never worse).

### Where it's weakest (honestly)

- Behavioural, natural-language recall on the default path (rank-1 ≈ 0.30 overall; held-out semantic rank-1 0.40 — the embedding/reranker channel closes it further) — closing it needs the embedding/reranker channel, not lexical tuning.
- The hardest fixtures stay below 0.65 held-out success@5 even with the full stack (rails 0.50, rust 0.61).
- Java/Spring `get_call_graph` reports at class granularity (the god-class split only fires ≥200 lines); SCSS has no meaningful call graph.
- LLM enrichment without reranking regresses precision — enable it only paired with `--rerank`.

## Reproducing the benchmarks

```bash
npm run test:all                   # full unit + integration suite
npm run test:setup                 # index the benchmark fixtures
npm run test:eval                  # default lexical path — prints the HELD-OUT block
npm run test:eval -- --suite css   # any single fixture (18 authored suites)
npm run test:eval -- --embeddings  # hybrid eval (requires Ollama)
npm run test:eval -- --verbose     # per-query breakdown incl. file-rank column
node test/sqlite.mjs               # backend-parity gate (memory ↔ SQLite top-5)
node bench/cell.mjs <fixture> L1   # cold rebuild + score one fixture
```

The harness is [test/evaluate.mjs](test/evaluate.mjs); deeper reproduction notes live in [docs/benchmarks/BENCH_BASELINE.md](docs/benchmarks/BENCH_BASELINE.md) and [docs/benchmarks/BENCH_FULL_SUITE.md](docs/benchmarks/BENCH_FULL_SUITE.md).

---

<div align="center">
  <sub>MIT licensed · runs entirely on your machine · see <a href="SECURITY.md">SECURITY.md</a> and <a href="TRADEMARK.md">TRADEMARK.md</a></sub>
</div>
