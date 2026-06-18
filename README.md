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
| `get_subgraph` | The dependency/import neighbourhood around a file. |
| `get_repo_map` | A high-level map of the repository's modules and topology. |
| `list_index_stats` | Index health: chunk/file/symbol/vector counts and the active config. |

## Configuration

Everything beyond the lexical default is opt-in. The server, indexer, and daemon all print their **effective configuration** at startup (storage backend, model names, which optional features are on), and emit a visible warning whenever an opt-in feature has a known trade-off — nothing is enabled silently.

### Headline trade-offs

| Option | Default | When to enable | Cost |
|--------|---------|----------------|------|
| `--embeddings` | off | Larger repos where recall matters; lifts success@5 | Requires Ollama or the in-process MiniLM model; slower indexing |
| `--embed-model qwen3-embedding:4b` | `nomic-embed-text` | Better code recall + symbolic precision | ~18 min to embed ~1k chunks at ~1.4 chunks/s; requires Ollama |
| `--enrichment` | off | Only useful paired with `--rerank`; alone it regresses | LLM call per chunk; thousands of chunks ≈ hours |
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

## Benchmark results

These benchmarks were run on 5 OSS repositories (axios, express, NestJS, FastAPI, gin) totalling **8,296 chunks**, with **100 ground-truth queries** (15 held-out, never used for tuning). Scoring is strict and symbol-level — a hit must be the correct *symbol*, not just the correct file. The **held-out set is the gold standard**: it was authored fresh and never used to tune ranking.

### Default path (lexical + stemming) — 5 suites, no model required

| Metric | Before stemming | Default (lexical + stemming) |
|--------|-----------------|------------------------------|
| Held-out rank-1 | 0.733 | **0.800** |
| Held-out semantic rank-1 | 0.200 | **0.400** |
| Held-out MRR | 0.789 | **0.833** |
| Overall rank-1 (strict) | 0.582 | 0.582 |
| Overall success@5 (strict) | 0.764 | 0.775 |
| Overall semantic s@5 | 0.497 | 0.526 |
| Symbolic rank-1 / MRR | 0.755 / 0.807 | **0.755 / 0.807** (byte-identical) |

The morphological stemming bridge (added in this line of work) closes the inflection gap between behavioural queries and code identifiers — "validating" → `Validator`, "serializing" → `Serialize` — and **doubles held-out semantic rank-1 (0.20 → 0.40) while leaving symbolic ranking byte-identical.** It needs no model and applies to every supported language. See [IMPROVEMENT_STEMMING.md](IMPROVEMENT_STEMMING.md).

### Embeddings & reranker — gin + express subset (requires Ollama)

A separate run measured the full embeddings/enrichment/reranker stack on a 2-suite subset — **gin** (Go, the hardest semantic suite) and **express** (JS) — to decide whether to commission a full 5-suite re-embed. These numbers are from that subset, **not** the 5-suite held-out set above. See [BENCH_FULL_SUITE.md](BENCH_FULL_SUITE.md).

| Configuration | gin semantic rank-1 / MRR / s@5 | gin symbolic rank-1 | Notes |
|---------------|----------------------------------|---------------------|-------|
| Lexical (default) | 0.20 / 0.30 / 0.60 | 0.85 | no model |
| + nomic embeddings | 0.20 / 0.30 / 0.60 | 0.85 | embeddings alone don't move rank-1 |
| + qwen3-embedding:4b | 0.20 / 0.48 / **0.80** | **0.92** | recall + symbolic lift; slow indexing |
| + qwen3:4b & reranker | **0.40** / 0.63 / 0.80 | 0.92 | best on gin; **regressed express** (sem rank-1 0.43 → 0.29) |

The honest conclusion from that run: **embeddings are a recall lever (they get the answer into the top-5), the reranker is the rank-1 lever (it reorders the top), and they are complementary but inconsistent across languages.** qwen3 also *inverts* the enrichment verdict — enrichment helped a weak embedder but regresses a strong one (gin semantic MRR 0.48 → 0.39). The gate to justify a full 5-suite re-embed was gin semantic rank-1 > 0.65; the best achieved was **0.40**, so the full re-embed was not commissioned.

> Your results will vary by repository and language. To reproduce: `npm run test:setup && npm run test:eval`.

## Known limitations

- Semantic rank-1 on the default path is **0.40 (held-out)**. Closing the remaining gap is bounded by the embedding/reranker channel, not lexical reweighting (see the table above).
- The reranker is inconsistent across languages — it helps Go/Python and regresses JavaScript.
- qwen3 embeddings improve symbolic recall but slow indexing significantly (~1.4 chunks/s on real payloads vs. ~32 for nomic).
- Enrichment only pays off paired with the reranker; alone it regresses semantic precision.

## Contributing / reproducing the benchmarks

The benchmark numbers in this README are generated by the eval harness, not hand-edited. The harness lives in [test/evaluate.mjs](test/evaluate.mjs); reproduce commands are documented in [BENCH_BASELINE.md](BENCH_BASELINE.md), [BENCH_FULL_SUITE.md](BENCH_FULL_SUITE.md), and [IMPROVEMENT_STEMMING.md](IMPROVEMENT_STEMMING.md).

```bash
npm run test:all                  # full unit + integration suite
npm run test:setup                # index the benchmark fixtures
npm run test:eval                 # lexical (default-path) eval — matches the table above
npm run test:eval -- --embeddings # hybrid eval (requires Ollama)
node test/sqlite.mjs              # backend-parity gate (memory ↔ SQLite identical top-5)
```

To verify the default-path numbers: `npm run test:eval` and read the `HELD-OUT` block.

---

<div align="center">
  <sub>MIT licensed · runs entirely on your machine · see <a href="SECURITY.md">SECURITY.md</a> and <a href="TRADEMARK.md">TRADEMARK.md</a></sub>
</div>
