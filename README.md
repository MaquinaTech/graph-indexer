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

## Quick start

The default path works with zero external dependencies — just Node.js (18+ for the in-memory index; 22+ if you use the optional SQLite backend). It works in **any** repository — Python, Go, Rust, Java, and so on — not only Node projects.

```bash
npx graph-indexer /path/to/your/repo
```

That runs the guided setup against that repo: it detects your stack, wires your installed editors to the MCP server (merging into existing configs, never clobbering), assembles the agent prompt suite, and offers to build the index — so it finishes ready to use. Useful flags: `--yes` (non-interactive/CI), `--dry-run` (preview the file actions), `--all-languages`, `--help`.

To point an agent at the server manually (the setup above already wires VS Code, Cursor, and Claude Code), use `idx-mcp` via `npx -p` so the correct bin runs:

**Claude Code**

```bash
claude mcp add graph-indexer -- npx -y -p graph-indexer idx-mcp --repo /path/to/your/repo
```

**Cursor / Cody / any MCP client** — add to the client's MCP config:

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

> The `-p graph-indexer idx-mcp` form is required: `npx graph-indexer idx-mcp` would run the package's same-named (setup) bin, not the MCP server. If graph-indexer is a local dependency of a Node project, `npm run mcp:start` (wired by `init`) works too.

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
| `get_repo_map` | A high-level map of the repository's modules and topology. |
| `list_index_stats` | Index health: chunk/file/symbol/vector counts and the active config. |

## Configuration

Everything beyond the lexical default is opt-in. The server, indexer, and daemon all print their **effective configuration** at startup (storage backend, model names, which optional features are on), and emit a visible warning whenever an opt-in feature has a known trade-off — nothing is enabled silently.

### Headline trade-offs

| Option | Default | When to enable | Cost |
|--------|---------|----------------|------|
| `--embeddings` | off | Larger repos where recall matters; lifts success@5 | Requires Ollama or the in-process MiniLM model; slower indexing |
| `--embed-model qwen3-embedding:4b` | `nomic-embed-text` | Better code recall + symbolic precision | slower indexing; requires Ollama |
| `--enrichment` | off | Only useful paired with `--rerank`; alone it regresses | slowest indexing |
| `--rerank` | off | Go/Python repos with weak semantic recall; regresses JS repos | Requires an Ollama 7B model; adds query latency |
| `--use-sqlite` | `auto` | Repos past ~15k chunks or memory-constrained environments | Slightly higher query latency; needs Node 22+ |

For most repos, the default (lexical + stemming, no embeddings) is the right starting point. Enable embeddings when you notice the agent missing chunks it should find. Enable the reranker only on Go or Python repos after measuring whether it helps — it is known to regress JavaScript repositories.

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
| `--rerank` | off | Enable the LLM reranker (one call per NL query). |
| `--no-git-signals` | (signals on) | Skip collecting local git churn/recency/co-change. |
| `--git-rank-boost <0..1>` | 0 | Opt-in weight for git recency/churn in ranking (0 = ranking unchanged). |

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
| `RERANK_MODEL` | (unset) | Naming a model enables the reranker and selects it. |
| `INDEXER_GIT_SIGNALS` | (on) | Set to `off` to skip git-signal collection. |
| `INDEXER_GIT_RANK_BOOST` | 0 | Opt-in git recency/churn ranking weight (0..1). |
| `INDEXER_EMBED_CONCURRENCY` | 4 | Parallel embedding batches; lower to 1 for large models on modest hardware. |
| `INDEXER_EMBED_TIMEOUT_MS` | 120000 | Per-batch embedding timeout; raise for very large models. |

When embeddings are enabled, the provider is selected in this order, and every fallback is logged (never silent): Ollama with `EMBED_MODEL` if set and reachable → Ollama with `nomic-embed-text` → the in-process MiniLM model (optional `@huggingface/transformers`) → lexical-only with a warning.

### Embedder backends

Set the backend with `--embed-provider` (or `INDEXER_EMBED_PROVIDER`). `mlx` is a native Python embedder that runs the Apple Metal GPU as a reused subprocess — faster in-process vectors than the bundled Xenova path, with no running Ollama daemon. The in-process (`local`) and `mlx` backends produce all-MiniLM-L6-v2-family **384-dim** vectors; the default `auto`→Ollama path uses `nomic-embed-text` (768-dim).

| Backend | `--embed-provider` | Platform | Throughput¹ | Setup |
|---------|--------------------|----------|-------------|-------|
| Auto (Ollama → local → off) | `auto` (default) | any | varies | none |
| In-process (Xenova) | `local` | any | ~17 ch/s | `npm i @huggingface/transformers` |
| **Apple Metal (MLX)** | **`mlx`** | **macOS Apple Silicon** | **~150 ch/s** | `npm run embed:setup:mlx` |
| Ollama daemon | `ollama` | any | ~35 ch/s | `ollama serve` + `ollama pull` |

¹ Indicative chunks/sec on a developer laptop; measure your own with `node bench/cell.mjs <fixture> E0_MLX`.

The index records which provider/model built it (in the `code-index.embeddings.bin.meta.json` sidecar) and queries with the same one, so vectors never get mixed across models. Switching providers or the MLX model between builds is detected and triggers a clean re-embed.

**macOS Apple Silicon (recommended):**

```bash
npm run embed:setup:mlx                                  # one-time: creates embedders/venv-mlx + installs MLX
npx idx-index --repo . --embeddings --embed-provider mlx
```

`embed:setup:mlx` provisions a **dedicated Python virtualenv** under `embedders/venv-mlx` (so MLX's deps never touch your system Python) and is idempotent — re-running it is a no-op once ready. The interactive setup (`npx graph-indexer`) offers MLX directly and can run this step for you. The first index downloads the model (~90 MB) into the Hugging Face cache; later builds reuse it.

Choose a different MLX model with `--mlx-embed-model <id>` (or `INDEXER_MLX_EMBED_MODEL`); it must be an `mlx_embeddings`-compatible sentence model, and the default `mlx-community/all-MiniLM-L6-v2-4bit` is the proven option. Tune batch size with `INDEXER_MLX_BATCH_SIZE` (default 32; lower to 16 on 8 GB machines, raise to 64 on M-series Max/Ultra). `mlx` is macOS-only; requesting it elsewhere fails fast with the alternative to use.

## Known limitations

- Semantic rank-1 on the default path is **0.30** (held-out: 95 validation queries across the 5 core suites — reproduce with `npm run test:eval` and read the `HELD-OUT` block). Closing the remaining gap is bounded by the embedding/reranker channel, not lexical reweighting (the per-fixture table below shows exactly where the heavy stack does and does not close it).
- The LLM reranker is language- and repo-dependent (measured per fixture at n=17–20 held-out): it lifts held-out on **8 fixtures** (nestjs, fastapi, react, django, rails, laravel, cjson, alamofire), but **taxes the tuning symbolic set on JS (express-js) and spring** — enable it only where measured to help (see [BENCH_PER_FIXTURE.md](docs/benchmarks/BENCH_PER_FIXTURE.md)). (The earlier "rerank regresses rails 0.67→0.33" was a small-sample artifact — at n=20 rerank *helps* rails, 0.40→0.50.)
- Enrichment helped **only rust** in the per-fixture sweep (held-out success@5 0.39→0.61, as part of the full `R2` stack); on laravel it left held-out flat and **dropped the tuning split** — a core-chunk-selection coverage miscalibration (budget spent on Http controllers, starving Services/), flagged in [BENCH_PER_FIXTURE.md](docs/benchmarks/BENCH_PER_FIXTURE.md), not yet fixed.
- The *typed* reference channel is uneven across languages. `find_references`' "subclassed by" / "used as a type by" dimensions are precise for **TypeScript/JavaScript/Python**, ride a shared `type_identifier` heuristic for **Java/PHP/Kotlin/Swift/Rust/Go/C**, use a dedicated field-precise branch for **C#** (params/fields/properties/returns/base list — ~54% of C# chunks on the aspnet fixture), and are **empty for Ruby, Express.js, Django, Bash, SCSS** (dynamic types or no type annotations in scope). AST chunking and lexical search cover all supported languages; the typed cross-reference channel is narrower.
- Call-graph callers reached through a dynamically-typed or unresolved receiver (e.g. `const s = getStore(); s.save()`) are reported in the lower-confidence **name-only** bucket — they are not statically disambiguated by class.
- Java (Spring) is chunked at *class* granularity (god-class split only fires ≥200 lines), so `get_call_graph` attributes at class level, not method level. SCSS has 6 trivial `@include` edges that resolve to no indexed definition — effectively no call graph.

## Benchmark results

All numbers are generated by the eval harness on cold, isolated builds — not hand-edited. Scoring is strict (exact symbol match, no file-path fallback). Each language has a held-out validation split (~20–25%) that was never used to tune.

**Configs:** `L1` lexical+stemming (shipped default, zero deps) · `E0` in-process MiniLM · `O0` Ollama nomic-embed-text · `O2` Ollama qwen3-embedding:4b · `R0`/`R1`/`R2` qwen3 + rerank / enrichment / both · `O0R`/`O0HR` nomic + rerank / + HyDE+rerank. Full catalog, 3× spreads, and copy-paste enable flags: [BENCH_PER_FIXTURE.md](docs/benchmarks/BENCH_PER_FIXTURE.md).

### Per-fixture best achievable quality (selected on held-out)

For each fixture, the configuration that maximizes the **held-out** strict metric — `success@5` first, then rank-1, then *lowest cost* (a fixture whose cheap default already maxes held-out keeps that cheap default; a heavier config that merely ties is not chosen). HyDE and the LLM reranker are nondeterministic, so every config using them was reproduced **3×** and reports the stable (median) value; rank-1 carries its min–max spread in [BENCH_PER_FIXTURE.md](docs/benchmarks/BENCH_PER_FIXTURE.md). `s@5`/`r1` = held-out strict success@5 / rank-1.

> **Held-out splits are now n=17–20 per fixture** (raised from n=3; tuning n=22–24). At n≈19 the 95% Wilson CI half-width on held success@5 is ≈ **±0.16** (was ±0.34 at n=3 — 52% tighter), so a ≥0.15 gap is real and a 0.05 gap is noise. 18 fixtures are measured; express-ts is omitted (its upstream fixture repo is gone). **13 of 18 winners changed vs the n=3 run** — see [BENCH_PER_FIXTURE.md](docs/benchmarks/BENCH_PER_FIXTURE.md) for what did not survive the larger sample.

| Language | Fixture | Default `L1` (s@5/r1) | Best config | Best (s@5/r1) | Ollama | Why this config wins |
|---|---|---|---|---|---|---|
| JavaScript | axios | 0.89 / 0.74 | **E0 · MiniLM (in-proc)** | 0.95 / 0.74 | no | Cheap in-process embeddings edge lexical on held s@5; exact-name JS. (n=3 saw L1 "saturate" at 1.00.) |
| JavaScript | express-js | 0.84 / 0.53 | **L1 · lexical (default)** | 0.84 / 0.53 | no | All configs tie held s@5 0.84; O0R's rank-1 gain **taxes the tuning set** (rerank tax on JS) → lexical wins. |
| TypeScript | nestjs | 0.70 / 0.45 | **O0HR · nomic+HyDE+rerank** | 0.75 / 0.65 | yes | nomic+HyDE+rerank is the **only** lift past the 0.70 held-s@5 ceiling (→0.75); qwen3:4b ties at far higher cost. |
| Python | fastapi | 0.70 / 0.55 | **O0R · nomic+rerank** | 0.80 / 0.70 | yes | nomic+rerank lifts held s@5 0.70→0.80, rank-1 →0.70. (n=3 saw L1 "saturate" at 1.00.) |
| Go | gin | 0.88 / 0.71 | **E0 · MiniLM (in-proc)** | 0.94 / 0.76 | no | Cheap in-process embeddings lift held s@5 0.88→0.94; **qwen3:4b regresses it** to 0.88. |
| TS/React | react | 0.75 / 0.50 | **O0R · nomic+rerank** | 0.85 / 0.70 | yes | nomic+rerank lifts held s@5 0.75→0.85 and rank-1 0.50→0.70. |
| Python/Django | django | 0.79 / 0.47 | **O0R · nomic+rerank** | 0.95 / 0.53 | yes | nomic+rerank lifts held s@5 0.79→0.95; **qwen3:4b regresses** to 0.89. |
| Rust | rust | 0.39 / 0.22 | **R2 · qwen3+enrich+rerank** | 0.61 / 0.39 | yes | The **only** fixture needing the full heavy stack: held s@5 0.39→0.61 (enrichment + rerank). |
| Java/Spring | spring | 0.84 / 0.53 | **L1 · lexical (default)** | 0.84 / 0.53 | no | Cheap and heavy tie at 0.84; R2's 0.89 taxes the tuning set → lexical wins. (n=3 "heavy-needed" collapsed.) |
| Kotlin/Android | android | 0.90 / 0.55 | **E0 · MiniLM (in-proc)** | 0.95 / 0.55 | no | Cheap in-process embeddings edge lexical on held s@5. |
| C#/ASP.NET | aspnet | 0.85 / 0.65 | **E0 · MiniLM (in-proc)** | 0.95 / 0.70 | no | Cheap in-process embeddings lift held s@5 0.85→0.95 — **no Ollama** (n=3 crowned nomic). |
| Ruby/Rails | rails | 0.35 / 0.25 | **O0HR · nomic+HyDE+rerank** | 0.50 / 0.45 | yes | nomic+HyDE+rerank lifts held s@5 0.40→0.50 — **rerank HELPS rails** (n=3 said it regresses). Lowest ceiling. |
| PHP/Laravel | laravel | 0.89 / 0.33 | **O0R · nomic+rerank** | 0.89 / 0.61 | yes | nomic+rerank sharpens held rank-1 0.33→0.61 at s@5 0.89; **qwen3:4b/enrichment don't help**. |
| PHP/Symfony | symfony | 0.95 / 0.60 | **E0 · MiniLM (in-proc)** | 0.95 / 0.70 | no | Held s@5 **0.95** (n=3's "0.75 ceiling no channel closes" was a small-sample artifact); MiniLM sharpens rank-1. |
| SCSS | css | 1.00 / 0.70 | **O0 · nomic** | 1.00 / 0.85 | yes | The **lone** held s@5 1.00 saturator; nomic sharpens held rank-1 0.70→0.85. |
| C | cjson | 0.72 / 0.44 | **O0R · nomic+rerank** | 0.89 / 0.72 | yes | nomic+rerank lifts held s@5 0.72→0.89 and rank-1 0.44→0.72 (n=3 saw rank-1 stuck at 0.00). |
| Bash | nvm | 0.84 / 0.74 | **E0 · MiniLM (in-proc)** | 0.95 / 0.68 | no | Cheap in-process embeddings lift held s@5 0.84→0.95 (trading a little rank-1). |
| Swift | alamofire | 0.70 / 0.55 | **O0R · nomic+rerank** | 0.80 / 0.70 | yes | nomic+rerank lifts held s@5 0.70→0.80 and rank-1 0.55→0.70, helps tuning too. |

**How to read it.** "Ollama: no" means the best config runs with zero network or daemon — `L1` (pure lexical) or `E0` (in-process MiniLM). **Two** fixtures are maxed by the lexical default alone (express-js, spring); **seven** more want only a cheap embedding channel (axios, gin, android, aspnet, symfony, nvm via in-process `E0`; css via nomic `O0`) — so **8 fixtures need nothing beyond the in-process default**. **Eight** fixtures are best with nomic embeddings + LLM rerank/HyDE (no qwen3 embedder): nestjs, fastapi, react, django, rails, laravel, cjson, alamofire. **One** fixture (rust) genuinely needs the full qwen3:4b + enrichment + rerank stack.

**Enabling a winning config.** `L1` is the shipped default (nothing to set). `E0`: `--embeddings` (in-process MiniLM, used when no Ollama daemon is up). `O0`: `--embeddings --embed-model nomic-embed-text`. **Rerank**: `--rerank` (or `RERANK_MODEL=qwen2.5-coder:7b`) at serve time, or per call `search_code(query, rerank: true)`. **HyDE**: `{"hyde":{"enabled":true}}` in `.graph-indexer/config.json`, or per call `search_code(query, hyde: true)`. **Enrichment**: `--enrichment` at index time.

**What did *not* reproduce (honest negatives).** The heavier `qwen3-embedding:4b` embedder is **never a sole winner** and **regresses** held-out success@5 on gin (0.94→0.88) and django (0.95→0.89) — confirmed at high power; the only place a qwen3 build earns its keep is rust's `R2` (and there the lift is from enrichment+rerank, not the embedder). Enrichment helps **only rust** and actively hurts laravel (drops its tuning split 0.82→0.55 — the known core-chunk coverage miscalibration). The residual hard cases no config solves are now stated at the higher n: **rails** (held s@5 capped at 0.50, the lowest ceiling), **rust** (0.61, even with the full stack), **nestjs** (0.75), **fastapi/alamofire** (0.80) — bounded by the embedding/reranker channel, not lexical reweighting. **Several n=3 conclusions did not survive the larger sample** (symfony's "0.75 ceiling no channel closes" → 0.95; spring's "heavy stack needed" → cheap ties; "rerank regresses rails" → rerank helps it; cjson's "rank-1 0.00 for every config" → 0.72) — see [BENCH_PER_FIXTURE.md](docs/benchmarks/BENCH_PER_FIXTURE.md).

### Structural coverage — call graph and references (invocation-verified)

Every verdict below was confirmed by calling `get_call_graph` and `find_references` on the real index, not by reading a field count.

| Language | Fixture | `get_call_graph` | `type_refs` channel | Callers resolution | Inheritance (`extends`) |
|---|---|---|---|---|---|
| JavaScript | axios | yes | populated (26.7%) | receiver-aware (80.2%) | yes (0.2%) |
| JavaScript | express-js | yes | **empty** | receiver-aware (74.2%) | n/a |
| TypeScript | nestjs | yes | populated (86%) | receiver-aware (73%) | yes (11%) |
| TS/React | react | yes | populated (85.8%) | mixed (33.5%) | yes (0.3%) |
| Python | fastapi | yes | populated (17.8%) | receiver-aware (64.7%) | yes (10.9%) |
| Python/Django | django | yes | **empty** | receiver-aware (73.9%) | yes (47.7%) |
| Go | gin | yes | populated (87.9%) | name-only | yes (0.6%) |
| Rust | rust | yes | populated (86%) | name-only | yes (26.1%) |
| Java/Spring | spring | **degraded** (class-granular) | populated (3.6%) | receiver-aware (87.7%) | yes (1.1%) |
| Kotlin/Android | android | yes | populated (100%) | name-only | yes (18.1%) |
| C#/ASP.NET | aspnet | yes | populated (53.6%) | receiver-aware (91.1%) | yes (32.2%) |
| Ruby/Rails | rails | yes | **empty** | name-only | yes (11.9%) |
| PHP/Laravel | laravel | yes | populated (73.1%) | receiver-aware (83.6%) | yes (65.9%) |
| PHP/Symfony | symfony | yes | populated (35.2%) | receiver-aware (86%) | yes (23.2%) |
| SCSS | css | **degraded** (6 trivial edges) | **empty** | none | n/a |
| C | cjson | yes | populated (9.3%) | name-only | n/a |
| Bash | nvm | yes | **empty** | name-only | n/a |
| Swift | alamofire | yes | populated (97.7%) | receiver-aware (53.4%) | yes (23.9%) |

**Legend.** `get_call_graph`: **yes** = callers resolve correctly · **degraded** = edges exist but callee method is not its own chunk (Java class-granular) · **none** = zero call edges, tool returns nothing. `type_refs`: **populated** = ≥1 chunk carries type-usage refs · **empty** = `find_references` degrades to callers + `extends` only. `callers resolution`: **receiver-aware** = high-confidence per-class caller classification · **name-only** = call sites carry no receiver (Go/Rust/Kotlin/Ruby/Bash/C).

**Backend parity: memory vs SQLite top-5 is byte-identical on all 18 fixtures** — enforced by `test/sqlite.mjs`.

### File-hit metric

In addition to strict symbol-level scoring, the eval harness now tracks **file hit@k**: did any result in the top-k land on the correct file, even if the exact symbol wasn't rank-1? This is computed independently of the strict metric — a query with `file hit@1 = 1` and `sym r1 = 0` means the agent landed in the right file but fetched the wrong chunk within it.

```
npm run test:eval -- --suite aspnet --verbose   # shows fileR (file rank) per query
npm run test:eval                               # OVERALL section shows file hit@1 / @5
```

File-hit metrics across 11 fixtures (L1 default path, **tuning split**). `sym r1` here is the *symbolic-query* rank-1 on the tuning split — a different slice from the held-out, all-query rank-1 in the per-fixture table above, so the two `r1` columns are not meant to match. Reproduce any row with `npm run test:eval -- --suite <fixture>` and read the per-suite `file hit@1 / @5` line plus the symbolic rank-1 in the breakdown.

| Fixture | sym r1 | file hit@1 | file hit@5 |
|---|---|---|---|
| axios | 89% | 75% | 92% |
| express-js | 75% | 74% | 91% |
| fastapi | 76% | 63% | 71% |
| gin | 88% | 64% | 86% |
| react | 63% | 64% | 86% |
| rails | 44% | 29% | 63% |
| django | 78% | 71% | 92% |
| css | 53% | 70% | 91% |
| aspnet | 67% | 65% | 96% |
| laravel | 47% | 41% | 77% |
| symfony | 83% | 71% | 88% |
| Mean | 69% | 62% | 85% |

The gap between `sym r1` and `file hit@1` shows how often the agent lands in the right file but on a sibling chunk rather than the exact definition. A wide gap means the retrieval granularity is right (file-level) while within-file ranking has room to improve (typically closed by `get_file_skeleton` + `get_chunk`). For example, rails lands in the correct file 63% of the time at @5 but only 29% at rank-1 — worth exploring via `--verbose` to diagnose within-file ranking.

## Contributing / reproducing the benchmarks

The benchmark numbers in this README are generated by the eval harness, not hand-edited. The harness lives in [test/evaluate.mjs](test/evaluate.mjs); reproduce commands are documented in [docs/benchmarks/BENCH_BASELINE.md](docs/benchmarks/BENCH_BASELINE.md), [docs/benchmarks/BENCH_FULL_SUITE.md](docs/benchmarks/BENCH_FULL_SUITE.md), and [docs/internals/IMPROVEMENT_STEMMING.md](docs/internals/IMPROVEMENT_STEMMING.md).

```bash
npm run test:all                   # full unit + integration suite
npm run test:setup                 # index the benchmark fixtures
npm run test:eval                  # lexical default-path eval over the 5 core suites (axios/express/nestjs/fastapi/gin)
npm run test:eval -- --suite css   # any single fixture (18 authored suites)
npm run test:eval -- --embeddings  # hybrid eval (requires Ollama)
npm run test:eval -- --verbose     # per-query breakdown including file rank column
node test/sqlite.mjs               # backend-parity gate (memory ↔ SQLite identical top-5)
node bench/cell.mjs <fixture> L1   # cold rebuild + score one fixture
bash bench/run-focused.sh          # reproduce the per-fixture best-config grid (per-fixture, resumable)
node bench/synth-best.mjs --md     # regenerate the matrix table → bench/results/_matrix.md (pasted into the per-fixture doc)
```

To verify the 5 core suites on the default path: `npm run test:eval` and read the `HELD-OUT` block (the `OVERALL` block also prints `file hit@1 / @5`). The full per-fixture / file-hit tables span more fixtures — reproduce a single one with `npm run test:eval -- --suite <fixture>`, or the whole best-config grid with the `bench/` harness above.

---

<div align="center">
  <sub>MIT licensed · runs entirely on your machine · see <a href="SECURITY.md">SECURITY.md</a> and <a href="TRADEMARK.md">TRADEMARK.md</a></sub>
</div>
