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

## What it does

graph-indexer pre-indexes your codebase into an AST-precise search index and exposes it as an MCP server. Instead of reading full files, AI agents call `search_code("payment validation")` and get back the exact functions that match — with their type signatures, docstrings, dependency graph, and call sites — in a fraction of the tokens.

It runs entirely on your machine. No external database, no cloud APIs, no telemetry.

---

## Why it matters

When an AI agent works on a real codebase without graph-indexer, it reads files to find code:

```
Agent task: "Add error handling to the payment processing flow"

Without graph-indexer:
  readFile("src/payments/service.ts")   → 8,400 tokens
  readFile("src/payments/handlers.ts")  → 6,200 tokens
  readFile("src/types/payment.ts")      → 1,800 tokens
  Total context consumed:               ~16,400 tokens for 3 files

With graph-indexer:
  search_code("payment processing")     → 650 tokens (5 exact chunks)
  get_chunk("chunk_id")                 → 280 tokens (full function body)
  Total context consumed:               ~930 tokens
```

The difference compounds across a session. Agents that read files also lack topology — they can't see which other functions call the one they're modifying, so they miss side effects.

---

## Results

Measured across 5 production open-source codebases (7,503 total AST chunks, 65 ground-truth queries). Token savings compare the chunks returned per query against reading the full source files they came from.

### Token usage per query: with vs. without graph-indexer

| Project | Language | Codebase size | Without (full files) | With graph-indexer | Savings | Latency |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| Axios v1.6.0 | JavaScript | 111k tokens | ~2,290 tok/query | ~655 tok/query | **71.4%** | 0.2 ms |
| Express 4.18.2 | JavaScript | 145k tokens | ~7,330 tok/query | ~850 tok/query | **88.4%** | 0.2 ms |
| NestJS v10.4.9 | TypeScript | 700k tokens | ~2,535 tok/query | ~900 tok/query | **64.5%** | 0.7 ms |
| FastAPI 0.103.0 | Python | 859k tokens | ~4,030 tok/query | ~685 tok/query | **83.0%** | 1.0 ms |
| Gin v1.9.1 | Go | 131k tokens | ~2,530 tok/query | ~450 tok/query | **82.2%** | 0.4 ms |
| **Mean** | | | | | **77.9%** | **0.5 ms** |

> "Full files" = reading the source files that contain the top-5 retrieved chunks. "With graph-indexer" = tokens in the returned chunk code snippets only. Measured at 4 chars/token.

**Key observations:**
- NestJS has 700k tokens of source — larger than most LLMs' full context window. graph-indexer reduces each query to ~900 tokens.
- Express shows 88.4% savings because its core router logic is spread across large files with much non-relevant code.
- Latency is sub-millisecond for all suites at their real corpus sizes.

### Search quality

| Project | Chunks | Recall@1 | Recall@3 | Recall@5 | MRR | Queries |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| Axios v1.6.0 | 435 | 0.86 | 1.00 | **1.00** | 0.92 | 14 |
| Express 4.18.2 | 389 | 0.93 | 0.93 | **1.00** | 0.95 | 14 |
| NestJS v10.4.9 | 2,019 | 1.00 | 1.00 | **1.00** | **1.00** | 15 |
| FastAPI 0.103.0 | 3,572 | 0.93 | 1.00 | **1.00** | 0.96 | 14 |
| Gin v1.9.1 | 1,088 | 0.85 | 1.00 | **1.00** | 0.92 | 13 |
| **Mean** | **7,503** | **0.91** | **0.99** | **1.00** | **0.95** | **70** |

- **Recall@5 = 1.00** across every project and language: the correct answer is always in the top 5 results.
- **MRR = 0.95** overall: on average, the correct answer is the first or second result.
- Queries span three difficulty levels: easy (exact symbol names), medium (multi-token descriptions), hard (semantic concepts with vocabulary mismatch).

---

## How it works

### Indexing

When you run `npm run mcp:index`, graph-indexer:

1. **Parses** every source file with Tree-sitter to build an AST — no regex, exact code boundaries.
2. **Extracts chunks**: named functions, classes, methods, and exports. Each chunk includes its name, docstring, parameters, return type, call sites, and type references.
3. **Builds a dependency graph**: bidirectional import map so each chunk knows what it imports and what imports it.
4. **Creates two search indexes**:
   - A BM25 inverted index (lexical search, O(1) per-token lookup).
   - A vector embedding per chunk via Ollama `nomic-embed-text` (optional; falls back to lexical-only if Ollama is unavailable).
5. **Serializes to disk**: `code-index.json` (metadata + BM25 index) and `code-index.embeddings.bin` (binary float32 vectors).

A background file watcher daemon (`watch-daemon.mjs`) re-indexes changed files automatically after the initial index is built.

### Search

When an agent calls `search_code("payment validation middleware")`:

1. **Lexical search** over the BM25 inverted index — returns candidates with BM25 scores in O(query_terms) time.
2. **Vector search** over pre-normalized float32 embeddings — returns semantically similar chunks.
3. **Reciprocal Rank Fusion (RRF)** merges both ranked lists with weights (lexical 1.5×, vector 1.0×).
4. **Scoring adjustments**: exact name match +2.0×, snake_case suffix match +1.4×, path token match +1.4×, test/example files demoted.
5. **Returns** top-k chunks with: code snippet, type signature, docstring, call graph, and dependency topology — all in one response.

### Architecture

```
Source files (.ts .js .py .go .rs …)
     │
     ▼
Tree-sitter AST parser
     │
     ├──► Named chunks (functions, classes, methods)
     │         │
     │         ├──► BM25 inverted index  ──┐
     │         └──► Ollama embeddings    ──┤── RRF fusion ──► Ranked results
     │                                     │
     └──► Dependency graph ────────────────┘
               (importedBy / imports)           ▼
                                          MCP tools for agents
```

---

## Getting started

### 1. Install

```bash
npm install graph-indexer --save-dev
npx graph-indexer init
```

`init` auto-detects your IDE (Claude, Cursor, VS Code), adds npm scripts to `package.json`, and updates `.gitignore`.

### 2. Index your repository

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

Lexical-only still achieves Recall@5 = 1.00 for the test suites above.

### 3. Configure your IDE

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "graph-indexer": {
      "command": "node",
      "args": ["/path/to/project/node_modules/graph-indexer/mcp-server.mjs"],
      "env": { "MCP_PROJECT_ROOT": "/path/to/project" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "graph-indexer": {
      "command": "node",
      "args": ["${workspaceFolder}/node_modules/graph-indexer/mcp-server.mjs"],
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
      "command": "node",
      "args": ["${workspaceFolder}/node_modules/graph-indexer/mcp-server.mjs"]
    }
  }
}
```

### 4. Add the agent system prompt

Copy the contents of [PROMPT.md](./PROMPT.md) into your AI agent's system prompt. This instructs the agent to use graph-indexer tools instead of reading files directly.

---

## MCP tools

### `search_code`

Searches the index by natural language query. Returns signature cards for all results, then code bodies according to the `detail` level.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `query` | string | required | Natural language description of the logic to find |
| `exact_tokens` | string? | — | Exact symbol name — guarantees rank-1 placement |
| `detail` | `"signatures"` \| `"smart"` \| `"full"` | `"smart"` | Controls how much code is returned |
| `top_k` | number | `5` | Results to return (1–20) |
| `include_topology` | boolean | `true` | Include Deps / Used by / Calls in each card |
| `min_score` | number | `0.3` | Minimum score threshold |
| `token_budget` | number? | auto | Token budget for code bodies |

**`detail` levels:**

| Value | Per-result cost | What you get |
| :--- | ---: | :--- |
| `"signatures"` | ~20 tokens | Name, type, params, return type, topology only |
| `"smart"` (default) | ~150 tokens | Signature + only lines relevant to the query |
| `"full"` | ~300 tokens | Signature + complete source body |

Start with `"signatures"`, escalate only when you need implementation details.

---

### `resolve_symbol`

Looks up any symbol by exact name in O(1) — no search needed.

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `symbol` | string | Exact function, class, or type name (e.g. `"validateToken"`) |

Returns: definition location, type signature, docstring, type references, and cross-file topology. Faster than `search_code` for known names.

---

### `get_chunk`

Returns the full source code of one chunk by its ID from search results.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `chunk_id` | string | required | ID shown in `search_code` results |
| `view` | `"full"` \| `"signature"` | `"full"` | `"full"` = complete body; `"signature"` = first line only |

---

### `get_chunk_summary`

Returns the interface of a chunk (signature + docstring + calls) without the body. About 50 tokens vs ~300 for the full body.

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `chunk_id` | string | ID from `search_code` results |

Use when you need to understand what a function does without reading its implementation.

---

### `get_file_skeleton`

Returns all top-level exports and definitions in a file with line numbers — no bodies.

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `file_path` | string | Relative path (e.g. `src/utils/auth.ts`) |

Useful for understanding what a file exports before deciding which chunk to read.

---

### `get_call_graph`

Finds all chunks that call a specific function by name.

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `target_function` | string | Exact function name (e.g. `"validateToken"`) |

Always call this before modifying an exported function — it shows every call site repo-wide.

---

### `get_repo_map`

Returns a compact symbol map of the entire codebase ordered by importance (PageRank over the dependency graph — most-imported files first). Useful for orienting in an unfamiliar codebase in ~1,500 tokens.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `path_filter` | string? | — | Only show files whose path contains this string |
| `max_files` | number | `80` | Maximum files to include |
| `sort_by` | `"importance"` \| `"path"` | `"importance"` | Sort order |

---

### `list_index_stats`

Returns index health: chunk count, file count, symbol table size, vector entry count, search mode (hybrid or lexical-only), daemon status, and index age.

---

### `graph://dependencies/{file_path}` (resource)

Returns the full bidirectional dependency topology for a file: what it imports and what imports it.

---

## Configuration

### Environment variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MCP_PROJECT_ROOT` | `process.cwd()` | Project root for import resolution |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint |
| `INDEXER_EMBEDDINGS` | — | Set to `off` to disable vector embeddings |

### Custom Ollama host

```bash
# Non-default port
OLLAMA_HOST=http://localhost:11435 npm run mcp:index

# Remote host
OLLAMA_HOST=http://192.168.1.100:11434 npm run mcp:index
```

---

## Supported languages

| Language | Extensions | Chunk types extracted |
| :--- | :--- | :--- |
| TypeScript / TSX | `.ts`, `.tsx` | functions, classes, methods, exports |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | functions, classes, expressions |
| Python | `.py` | function_definition, class_definition |
| Go | `.go` | function_declaration, method, type |
| Rust | `.rs` | fn, struct, enum, trait, impl |
| Java | `.java` | class, method, interface, constructor, enum |
| Kotlin | `.kt`, `.kts` | function, class, object, companion |
| C# | `.cs` | class, method, interface, property, enum |
| Ruby | `.rb` | method, class, module |
| PHP | `.php` | function, class |
| CSS / SCSS | `.css`, `.scss` | rule_set |

---

## Requirements

| | |
| :--- | :--- |
| **Node.js** | v18+ (ES Modules) |
| **Ollama** | Optional — enables semantic search. Pull `nomic-embed-text`. |
| **Disk** | `code-index.json` + `code-index.embeddings.bin` (both gitignored by default) |

---

## Troubleshooting

**Index takes too long to build**
- Verify Ollama is running: `curl http://localhost:11434/api/tags`
- Fall back to lexical-only: `INDEXER_EMBEDDINGS=off npm run mcp:index`

**Search returns irrelevant results**
- Use `exact_tokens` for known symbol names
- Verify the chunk is indexed with `list_index_stats()`
- Increase `top_k` to see more candidates

**MCP server won't connect**
- Verify `MCP_PROJECT_ROOT` points to the indexed directory
- Check that `code-index.json` exists: `ls -la code-index.json`
- Test the server manually: `node mcp-server.mjs`

**Results are stale after file changes**
- The background daemon auto-updates; if changes aren't reflected, run `npm run mcp:index` manually
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

## Best practices for better search quality

**Write descriptive docstrings.** The indexer embeds docstrings alongside code. Better documentation directly improves semantic search quality.

**Use specific function names.** Functions with exact, descriptive names (e.g. `fetchAndCacheUserProfile`) hit the exact-name boost (2.0×) and return as rank-1 results when queried by name.

**Export named functions, not anonymous ones.** Anonymous default exports cannot be targeted by `resolve_symbol` and score lower in name-boost ranking.

**Avoid catch-all utility files.** Large files that mix unrelated utilities produce weaker per-chunk signals. One responsibility per module indexes more cleanly.

---

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 MaquinaTech.

---

Built by [MaquinaTech](https://github.com/MaquinaTech) · [Issues](https://github.com/MaquinaTech/graph-indexer/issues) · [npm](https://www.npmjs.com/package/graph-indexer)
