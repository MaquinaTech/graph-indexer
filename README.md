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

The default path works with zero external dependencies — just Node.js (18+ for the in-memory index; 22+ if you use the optional SQLite backend).

```bash
npx graph-indexer /path/to/your/repo
```

That runs the interactive setup, indexes the repo, and prints the MCP command to connect. Then point your agent at the server:

**Claude Code**

```bash
claude mcp add graph-indexer -- npx -y graph-indexer idx-mcp --repo /path/to/your/repo
```

**Cursor / Cody / any MCP client** — add to the client's MCP config:

```json
{
  "mcpServers": {
    "graph-indexer": {
      "command": "npx",
      "args": ["-y", "graph-indexer", "idx-mcp", "--repo", "/path/to/your/repo"]
    }
  }
}
```

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
| `get_subgraph` | The dependency/import neighbourhood around a file. |
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
| `--embed-provider <auto\|ollama\|local\|off>` | `auto` | Force the embedding backend. |
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
| `INDEXER_EMBED_PROVIDER` | `auto` | `auto` \| `ollama` \| `local` \| `off`. |
| `INDEXER_STORAGE` | `auto` | `auto` \| `memory` \| `sqlite`. |
| `ENRICH_MODEL` | (unset) | Naming a model enables enrichment and selects it. |
| `RERANK_MODEL` | (unset) | Naming a model enables the reranker and selects it. |
| `INDEXER_GIT_SIGNALS` | (on) | Set to `off` to skip git-signal collection. |
| `INDEXER_GIT_RANK_BOOST` | 0 | Opt-in git recency/churn ranking weight (0..1). |
| `INDEXER_EMBED_CONCURRENCY` | 4 | Parallel embedding batches; lower to 1 for large models on modest hardware. |
| `INDEXER_EMBED_TIMEOUT_MS` | 120000 | Per-batch embedding timeout; raise for very large models. |

When embeddings are enabled, the provider is selected in this order, and every fallback is logged (never silent): Ollama with `EMBED_MODEL` if set and reachable → Ollama with `nomic-embed-text` → the in-process MiniLM model (optional `@huggingface/transformers`) → lexical-only with a warning.

## Known limitations

- Semantic rank-1 on the default path is **0.40 (held-out)**. Closing the remaining gap is bounded by the embedding/reranker channel, not lexical reweighting (see the table above).
- The reranker is inconsistent across languages — it helps Go/Python and regresses JavaScript.
- Enrichment only pays off paired with the reranker; alone it regresses semantic precision.
- The *typed* reference channel is uneven across languages. `find_references`' "subclassed by" / "used as a type by" dimensions are precise for **TypeScript/JavaScript/Python**, ride a shared `type_identifier` heuristic for **Java/PHP/Kotlin/Swift/Rust/Go/C**, use a dedicated field-precise branch for **C#** (params/fields/properties/returns/base list — ~54% of C# chunks on the aspnet fixture), and are **empty for Ruby, Express.js, Django, Bash, SCSS** (dynamic types or no type annotations in scope). AST chunking and lexical search cover all supported languages; the typed cross-reference channel is narrower.
- Call-graph callers reached through a dynamically-typed or unresolved receiver (e.g. `const s = getStore(); s.save()`) are reported in the lower-confidence **name-only** bucket — they are not statically disambiguated by class.
- Java (Spring) is chunked at *class* granularity (god-class split only fires ≥200 lines), so `get_call_graph` attributes at class level, not method level. SCSS has 6 trivial `@include` edges that resolve to no indexed definition — effectively no call graph.

## Benchmark results

All numbers are generated by the eval harness on cold, isolated builds — not hand-edited. Scoring is strict (exact symbol match, no file-path fallback). Each language has a held-out validation split (~20–25%) that was never used to tune.

**Configs:** **L1** = lexical + stemming (shipped default) · **E0** = in-process MiniLM embeddings · **O0** = Ollama nomic-embed-text · **O2** = Ollama qwen3-embedding:4b · **R0** = O2 + LLM rerank.

### Retrieval accuracy — default lexical path (L1) vs best achievable

`sym r1` = strict rank-1 on symbolic/exact queries (larger n, reliable). `sem r1` / `sem s@5` = strict rank-1 / success@5 on behavioural queries (small per-language n=2–7 — directional, not precise; a single query shifts the number by 14–50 points).

| Language | Fixture | sym n | sym r1 | sem n | sem r1 | sem s@5 | best sem r1 | best sem s@5 |
|---|---|---|---|---|---|---|---|---|
| JavaScript | axios | 14 | 79% | 5 | 0% | 80% | 20% (E0) | 80% (L1) |
| JavaScript | express-js | 14 | 79% | 7 | 43% | 57% | 43% (L1) | 86% (R0) |
| TypeScript | nestjs | 14 | 57% | 7 | 14% | 43% | 14% (L1) | 57% (O0) |
| TS/React | react | 7 | 57% | 3 | 0% | 33% | 0% (L1) | 33% (L1) |
| Python | fastapi | 14 | 79% | 7 | 14% | 43% | 43% (E0) | 57% (O0) |
| Python/Django | django | 6 | 83% | 3 | 33% | 67% | 67% (R0) | 100% (O2) |
| Go | gin | 13 | 85% | 5 | 20% | 100% | 80% (R0) | 100% (L1) |
| Rust | rust | 9 | 78% | 3 | 0% | 0% | 33% (R2) | 33% (R2) |
| Java/Spring | spring | 7 | 86% | 4 | 25% | 100% | 75% (R0) | 100% (L1) |
| Kotlin/Android | android | 8 | 75% | 3 | 33% | 100% | 33% (L1) | 100% (L1) |
| C#/ASP.NET | aspnet | 8 | 63% | 2 | 0% | 100% | 50% (E0) | 100% (L1) |
| Ruby/Rails | rails | 7 | 71% | 5 | 0% | 20% | 0% (L1) | 20% (L1) |
| PHP/Laravel | laravel | 8 | 63% | 3 | 33% | 33% | 33% (L1) | 33% (L1) |
| PHP/Symfony | symfony | 9 | 78% | 3 | 33% | 67% | 67% (E0) | 67% (L1) |
| SCSS | css | 7 | 43% | 4 | 25% | 50% | 50% (E0) | 50% (L1) |
| C | cjson | 8 | 63% | 4 | 25% | 25% | 25% (L1) | 50% (E0) |
| Bash | nvm | 9 | 44% | 3 | 33% | 67% | 67% (E0) | 67% (L1) |
| Swift | alamofire | 9 | 78% | 3 | 67% | 100% | 100% (R0) | 100% (L1) |
| **Mean (18 langs)** | | | **70%** | | **23%** | **60%** | | |

The 70% symbolic mean covers exact/near-exact symbol queries where the lexical+stemming path is the primary signal. The 23% semantic mean covers behavioural ("rate limiting middleware") queries where the embedding channel is the primary lever — the gap is real and bounded by the embedding/reranker channel, not lexical reweighting.

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

File-hit metrics across 11 fixtures (L1 default path):

| Fixture | sym r1 | file hit@1 | file hit@5 |
|---|---|---|---|
| axios | 58% | 68% | 89% |
| express-js | 67% | 76% | 90% |
| fastapi | 57% | 62% | 71% |
| gin | 67% | 61% | 83% |
| react | 40% | 50% | 80% |
| rails | 42% | 33% | 67% |
| django | 67% | 78% | 89% |
| css | 36% | 55% | 91% |
| aspnet | 50% | 50% | 90% |
| laravel | 55% | 55% | 64% |
| symfony | 67% | 67% | 75% |
| Mean | 55% | 60% | 81% |

The gap between `sym r1` and `file hit@1` shows how often the agent lands in the right file but on a sibling chunk rather than the exact definition. A wide gap indicates the retrieval granularity is right (file-level) but the within-file ranking needs improvement (typically addressed by `get_file_skeleton` + `get_chunk`). For example, rails has only 33% file hit@1 despite landing in the file half the time at @5 — worth exploring via `--verbose` to diagnose within-file ranking issues.

## Contributing / reproducing the benchmarks

The benchmark numbers in this README are generated by the eval harness, not hand-edited. The harness lives in [test/evaluate.mjs](test/evaluate.mjs); reproduce commands are documented in [BENCH_BASELINE.md](BENCH_BASELINE.md), [BENCH_FULL_SUITE.md](BENCH_FULL_SUITE.md), and [IMPROVEMENT_STEMMING.md](IMPROVEMENT_STEMMING.md).

```bash
npm run test:all                  # full unit + integration suite
npm run test:setup                # index the benchmark fixtures
npm run test:eval                 # lexical (default-path) eval — matches the table above
npm run test:eval -- --embeddings # hybrid eval (requires Ollama)
npm run test:eval -- --verbose    # per-query breakdown including file rank column
node test/sqlite.mjs              # backend-parity gate (memory ↔ SQLite identical top-5)
node bench/cell.mjs <fixture> L1  # cold rebuild + score one fixture
node bench/synth.mjs              # regenerate BENCH_LANGUAGES.md + BENCH_SUMMARY.md
```

To verify the default-path numbers: `npm run test:eval` and read the `HELD-OUT` block. The `OVERALL` block now shows `file hit@1 / @5` alongside strict rank-1.

---

<div align="center">
  <sub>MIT licensed · runs entirely on your machine · see <a href="SECURITY.md">SECURITY.md</a> and <a href="TRADEMARK.md">TRADEMARK.md</a></sub>
</div>
