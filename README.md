# graph-indexer

<p align="center">
  <strong>Zero-Database · Air-Gapped · AST-Precise · Hybrid Search</strong><br>
  <em>An MCP server that lets AI coding agents search your codebase by concept instead of reading files — reducing context usage by 65–88% per query.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/graph-indexer"><img src="https://img.shields.io/npm/v/graph-indexer?color=blue&style=flat-square" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-green?style=flat-square" alt="Node.js 18+"></a>
  <a href="#results"><img src="https://img.shields.io/badge/Recall@5-100%25-brightgreen?style=flat-square" alt="Recall@5 100%"></a>
</p>

---

## Table of Contents

- [What it does](#what-it-does)
- [Results](#results)
- [Getting started](#getting-started)
- [MCP tools](#mcp-tools)
- [Configuration](#configuration)
- [Supported languages](#supported-languages)
- [How it works](#how-it-works)
- [Best practices](#best-practices)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Security](#security)
- [License](#license)

---

## What it does

graph-indexer pre-indexes your codebase into an AST-precise search index and exposes it as an MCP server. Instead of reading full files, AI agents call `search_code("payment validation")` and get back the exact functions that match — with type signatures, docstrings, dependency graph, and call sites — in a fraction of the tokens.

It runs entirely on your machine. No external database, no cloud APIs, no telemetry.

**Token comparison:**

```
Agent task: "Add error handling to the payment processing flow"

Without graph-indexer:
  readFile("src/payments/service.ts")   →  8,400 tokens
  readFile("src/payments/handlers.ts")  →  6,200 tokens
  readFile("src/types/payment.ts")      →  1,800 tokens
  Total:                                ~ 16,400 tokens

With graph-indexer:
  search_code("payment processing")     →    650 tokens  (5 exact chunks)
  get_chunk("chunk_id")                 →    280 tokens  (full function body)
  Total:                                ~    930 tokens
```

The difference compounds across a session. Agents that read files also lack topology — they can't see which other functions call the one they're modifying, so they miss side effects.

---

## Results

Measured across 5 production open-source codebases (7,503 AST chunks, 70 ground-truth queries across 3 difficulty levels).

### Token savings per query

| Project | Language | Without (full files) | With graph-indexer | Savings | Latency |
| :--- | :--- | ---: | ---: | ---: | ---: |
| Axios v1.6.0 | JavaScript | ~2,290 tok | ~655 tok | **71.4%** | 0.2 ms |
| Express 4.18.2 | JavaScript | ~7,330 tok | ~850 tok | **88.4%** | 0.2 ms |
| NestJS v10.4.9 | TypeScript | ~2,535 tok | ~900 tok | **64.5%** | 0.7 ms |
| FastAPI 0.103.0 | Python | ~4,030 tok | ~685 tok | **83.0%** | 1.0 ms |
| Gin v1.9.1 | Go | ~2,530 tok | ~450 tok | **82.2%** | 0.4 ms |
| **Mean** | | | | **77.9%** | **0.5 ms** |

> "Full files" = tokens in the source files containing the top-5 results. "With graph-indexer" = tokens in the returned chunk snippets only. Measured at 4 chars/token. NestJS is 700k tokens of source — larger than most LLMs' context windows.

### Search quality

| Project | Chunks | Recall@1 | Recall@3 | Recall@5 | MRR |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Axios v1.6.0 | 435 | 0.86 | 1.00 | **1.00** | 0.92 |
| Express 4.18.2 | 389 | 0.93 | 0.93 | **1.00** | 0.95 |
| NestJS v10.4.9 | 2,019 | 1.00 | 1.00 | **1.00** | **1.00** |
| FastAPI 0.103.0 | 3,572 | 0.93 | 1.00 | **1.00** | 0.96 |
| Gin v1.9.1 | 1,088 | 0.85 | 1.00 | **1.00** | 0.92 |
| **Mean** | **7,503** | **0.91** | **0.99** | **1.00** | **0.95** |

**Recall@5 = 1.00** across every project: the correct answer is always in the top 5. **MRR = 0.95**: the correct answer is rank 1 or 2 on average.

---

## Getting started

**Requirements:** Node.js v18+ · Ollama (optional, for semantic search)

### 1. Install

```bash
npm install graph-indexer --save-dev
npx graph-indexer init
```

`init` auto-detects your IDE (Claude, Cursor, VS Code), adds npm scripts to `package.json`, updates `.gitignore`, and opens an interactive language selector:

```
⚙️  Select languages (Arrows/Tab: move, Space: toggle, Enter: confirm):

  ❯ ◯ TypeScript / TSX         .ts, .tsx
    ◯ JavaScript               .js, .jsx, .mjs, .cjs
    ◯ Python                   .py
    ◯ Go                       .go
    ◯ Rust                     .rs
    ◯ PHP                      .php
    ◯ Java                     .java
    ◯ Kotlin                   .kt, .kts
    ◯ C#                       .cs
    ◯ Ruby                     .rb
    ◯ CSS / SCSS               .css, .scss
```

Navigate with **↑ ↓**, toggle with **Space**, confirm with **Enter**. Leaving all unselected enables every language. Your selection is saved to `.graph-indexer.json`. Pass `--all-languages` to skip the prompt.

### 2. Index your codebase

**With semantic search (recommended):**
```bash
# Install Ollama: https://ollama.ai
ollama pull nomic-embed-text
npm run mcp:index
```

**Lexical-only (no Ollama required):**
```bash
INDEXER_EMBEDDINGS=off npm run mcp:index
```

Lexical-only still achieves Recall@5 = 1.00 on all benchmarks above.

### 3. Configure your IDE

`init` writes the config automatically. Manual examples:

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "graph-indexer": {
      "command": "npm",
      "args": ["run", "--prefix", "/path/to/project", "mcp:start"],
      "env": { "MCP_PROJECT_ROOT": "/path/to/project" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`) and **Claude Code** (`.mcp.json`):
```json
{
  "mcpServers": {
    "graph-indexer": {
      "command": "npm",
      "args": ["run", "mcp:start"],
      "env": { "MCP_PROJECT_ROOT": "${workspaceFolder}" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):
```json
{
  "servers": {
    "graph-indexer": {
      "type": "stdio",
      "command": "npm",
      "args": ["run", "mcp:start"],
      "env": { "MCP_PROJECT_ROOT": "${workspaceFolder}" }
    }
  }
}
```

### 4. Add the agent system prompt

Copy [PROMPT.md](./PROMPT.md) into your AI agent's system prompt to instruct it to use graph-indexer tools instead of reading files directly.

---

## MCP tools

### `search_code`

Hybrid BM25 + vector search over the index. The primary entry point for agents.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `query` | string | required | Natural language description of the logic to find |
| `exact_tokens` | string? | — | Exact symbol name — guarantees rank-1 placement |
| `detail` | `"signatures"` \| `"smart"` \| `"full"` | `"smart"` | How much code to return per result |
| `top_k` | number | `5` | Results to return (1–20) |
| `include_topology` | boolean | `true` | Include imports / used-by / calls |
| `min_score` | number | `0.3` | Minimum relevance threshold |
| `token_budget` | number? | auto | Cap total tokens returned |

**`detail` levels:**

| Value | Cost | Returns |
| :--- | ---: | :--- |
| `"signatures"` | ~20 tok | Name, type, params, return type, topology |
| `"smart"` (default) | ~150 tok | Signature + lines relevant to the query |
| `"full"` | ~300 tok | Signature + complete source body |

---

### `resolve_symbol`

O(1) lookup by exact name — no search ranking needed.

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `symbol` | string | Exact function, class, or type name (e.g. `"validateToken"`) |

---

### `get_chunk`

Returns the source code of a single chunk by its ID.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `chunk_id` | string | required | ID from `search_code` results |
| `view` | `"full"` \| `"signature"` | `"full"` | Full body or first line only |

---

### `get_chunk_summary`

Signature + docstring + calls without the body. ~50 tokens vs ~300 for full.

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `chunk_id` | string | ID from `search_code` results |

---

### `get_file_skeleton`

All top-level exports and definitions in a file with line numbers — no bodies.

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `file_path` | string | Relative path (e.g. `src/utils/auth.ts`) |

---

### `get_call_graph`

Every chunk across the repo that calls a specific function.

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `target_function` | string | Exact function name (e.g. `"validateToken"`) |

Call this before modifying any exported function to find all affected call sites.

---

### `get_repo_map`

Compact symbol map ordered by PageRank (most-imported files first). Orients agents in an unfamiliar codebase in ~1,500 tokens.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `path_filter` | string? | — | Limit to files whose path contains this string |
| `max_files` | number | `80` | Maximum files to include |
| `sort_by` | `"importance"` \| `"path"` | `"importance"` | Sort order |

---

### `list_index_stats`

Index health snapshot: chunk count, file count, symbol table size, vector count, search mode, daemon status, index age.

---

### `graph://dependencies/{file_path}` (resource)

Full bidirectional dependency topology for a file: what it imports and what imports it.

---

## Configuration

### Environment variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MCP_PROJECT_ROOT` | `process.cwd()` | Project root directory |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint |
| `INDEXER_EMBEDDINGS` | — | Set to `off` to disable vector embeddings |

### Language selection

`init` saves your selection to `.graph-indexer.json` in the project root:

```json
{ "languages": ["typescript", "javascript", "python"] }
```

Valid keys: `typescript`, `javascript`, `python`, `go`, `rust`, `php`, `java`, `kotlin`, `csharp`, `ruby`, `css`.

Update at any time by re-running `init`:

```bash
npx graph-indexer init                    # Re-run interactive selector
npx graph-indexer init --all-languages   # Enable all, no prompt
```

If `.graph-indexer.json` is absent or has no `languages` key, all installed parsers are used.

---

## Supported languages

| Language | Extensions | Chunks extracted |
| :--- | :--- | :--- |
| TypeScript / TSX | `.ts`, `.tsx` | functions, classes, methods, exports |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | functions, classes, expressions |
| Python | `.py` | functions, classes |
| Go | `.go` | functions, methods, types |
| Rust | `.rs` | fn, struct, enum, trait, impl |
| Java | `.java` | class, method, interface, constructor, enum |
| Kotlin | `.kt`, `.kts` | function, class, object, companion |
| C# | `.cs` | class, method, interface, property, enum |
| Ruby | `.rb` | method, class, module |
| PHP | `.php` | function, class |
| CSS / SCSS | `.css`, `.scss` | rule sets |

---

## How it works

### Indexing

When you run `npm run mcp:index`:

1. **Parses** every source file with Tree-sitter — no regex, exact AST boundaries.
2. **Extracts chunks**: named functions, classes, methods, and exports, each with name, docstring, parameters, return type, call sites, and type references.
3. **Builds a dependency graph**: bidirectional import map so each chunk knows what it imports and what imports it.
4. **Creates two indexes**: a BM25 inverted index (lexical) and per-chunk float32 embeddings via Ollama `nomic-embed-text` (optional).
5. **Serializes to disk**: `code-index.json` + `code-index.embeddings.bin`.

A background watcher daemon re-indexes changed files automatically. It respects
`.gitignore` and skips `node_modules`, build output, and dot-directories, so it
never traverses (or exhausts OS file-watcher limits on) dependency trees.

### Search pipeline

```
Source files
     │
     ▼
Tree-sitter AST
     │
     ├──► Chunks ──► BM25 inverted index ──┐
     │         └──► Float32 embeddings  ──┤── RRF fusion ──► Ranked results ──► MCP tools
     │                                     │
     └──► Dependency graph ────────────────┘
```

1. **BM25 lexical search** — O(query_terms) over the inverted index.
2. **Vector search** — cosine similarity over pre-normalized float32 embeddings.
3. **RRF fusion** merges both lists (lexical 1.5×, vector 1.0×).
4. **Score boosts**: exact name match +2.0×, suffix match +1.4×, path token +1.4×, test files demoted.

---

## Best practices

**Write descriptive docstrings.** Docstrings are embedded alongside code — better documentation directly improves semantic search quality.

**Use specific function names.** Names like `fetchAndCacheUserProfile` trigger the exact-name boost (2.0×) and reliably appear as rank-1 results when queried by name.

**Export named functions, not anonymous ones.** Anonymous default exports can't be targeted by `resolve_symbol` and rank lower in name-boost scoring.

**Avoid catch-all utility files.** Files that mix unrelated utilities produce weaker per-chunk signals. One responsibility per module indexes more cleanly.

---

## Troubleshooting

**Index takes too long**
- Verify Ollama is running: `curl http://localhost:11434/api/tags`
- Use lexical-only mode: `INDEXER_EMBEDDINGS=off npm run mcp:index`

**Search returns irrelevant results**
- Use `exact_tokens` for known symbol names
- Check coverage with `list_index_stats()`
- Increase `top_k` to see more candidates

**MCP server won't connect**
- Verify `MCP_PROJECT_ROOT` points to the indexed directory
- Check `code-index.json` exists: `ls -la code-index.json`
- Test manually: `npm run mcp:start`

**Results are stale after file changes**
- The daemon auto-updates; if stale, run `npm run mcp:index` manually
- Check daemon status with `list_index_stats()`

---

## Development

```bash
git clone https://github.com/MaquinaTech/graph-indexer.git
cd graph-indexer
npm install
npm run mcp:index   # index this repo
npm run test        # run test suite (lexical-only)
npm run mcp:start   # start MCP server
```

---

## Security

graph-indexer runs locally and is air-gapped by default — its only outbound call
is to a local Ollama endpoint for embeddings (skipped entirely with
`INDEXER_EMBEDDINGS=off`). It never executes the code it indexes, and the index
artifacts contain source snippets, so keep them git-ignored (as `init` configures).

See [SECURITY.md](SECURITY.md) for the full threat model and how to report a
vulnerability.

---

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 MaquinaTech.

---

Built by [MaquinaTech](https://github.com/MaquinaTech) · [Issues](https://github.com/MaquinaTech/graph-indexer/issues) · [npm](https://www.npmjs.com/package/graph-indexer)
