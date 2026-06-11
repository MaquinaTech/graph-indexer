<div align="center">
  <!-- Reemplaza la URL de abajo con la ruta a tu nuevo logo profesional en formato SVG o PNG transparente -->
  <img src="https://raw.githubusercontent.com/MaquinaTech/graph-indexer/main/assets/logo.jpg" alt="Graph Indexer Logo" width="250" />

  <h1>Graph Indexer</h1>

  <p>
    <strong>Zero-Database · Air-Gapped · AST-Precise · Hybrid Search · Monorepo-Scale</strong>
  </p>
  <p>
    <em>An MCP server that lets AI coding agents search your codebase by concept instead of reading files, cutting context usage by 65–88% per query.</em>
  </p>

  <!-- Badges -->
  <a href="https://www.npmjs.com/package/graph-indexer"><img src="https://img.shields.io/npm/v/graph-indexer?color=007acc&style=for-the-badge" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/graph-indexer"><img src="https://img.shields.io/npm/dt/graph-indexer?color=4caf50&style=for-the-badge" alt="NPM Downloads"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen?style=for-the-badge&logo=nodedotjs" alt="Node.js 18+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge" alt="License: MIT"></a>
</div>

<br />

---

## Table of Contents

- [What it does](#what-it-does)
- [Results](#results)
- [Getting started](#getting-started)
- [Storage backends](#storage-backends)
- [Semantic enrichment](#semantic-enrichment)
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

graph-indexer pre-indexes your codebase into an AST-precise search index and exposes it as an MCP server. Instead of reading full files, AI agents call `search_code("payment validation")` and get back the exact functions that match — with type signatures, docstrings, decorators, inheritance edges, dependency graph, and call sites — in a fraction of the tokens.

It runs entirely on your machine. No external database, no cloud APIs, no telemetry. Two design choices make it suitable for any repository size:

- A **default in-memory engine** that is instant and dependency-free, and an optional **disk-backed SQLite backend** that holds the index on disk so retrieval RAM stays flat on enterprise monorepos that would otherwise exhaust Node's heap.
- Optional **local-LLM semantic enrichment** that teaches the index what each core component *does*, so conceptual queries match code that shares none of their words.

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

Measured across 5 production open-source codebases (8,296 AST chunks, 100 ground-truth queries:
69 **symbolic** — the developer names or paraphrases the symbol — and 31 **semantic** — agent-style
behavioural descriptions sharing few or no words with the code).

* **Average Token Savings:** 79.0%
* **Strict Success@5 (Hybrid + Rerank):** 82%
* **Strict MRR (Symbolic queries):** 0.84

### Token savings per query

| Project | Language | Chunks | Recall@5 (loose) | Savings | 
| :--- | :--- | ---: | ---: | ---: |
| Axios v1.6.0 | JavaScript | 450 | 0.89 | **69.7%** |
| Express 4.18.2 | JavaScript | 389 | 0.95 | **88.7%** |
| NestJS v10.4.9 | TypeScript | 2,675 | 0.95 | **67.5%** |
| FastAPI 0.103.0 | Python | 3,694 | 0.76 | **85.5%** |
| Gin v1.9.1 | Go | 1,088 | 0.94 | **83.7%** |
| **Mean** | | **8,296** | **0.90** | **79.0%** |

> Savings = tokens in the returned chunk snippets vs the full source files containing the top-5
> results, at 4 chars/token. Search latency is sub-millisecond lexical; the hybrid channel adds
> one local embedding call plus a streamed vector scan (a few ms at this corpus size).

### Search quality (strict)

Strict scoring: a result counts **only** if its symbol name (or its class, for method chunks)
exactly equals the ground truth — no substring matching, no file-path credit. Hybrid =
BM25 + `nomic-embed-text` vectors with `qwen2.5-coder:1.5b` enrichment; rerank adds the
opt-in `qwen2.5-coder:7b` judge on natural-language queries.

| Project | Strict success@5 | **Rank-1 (strict)** | MRR (strict) |
| :--- | ---: | ---: | ---: |
| Axios v1.6.0 | 0.74 | 0.68 | 0.72 |
| Express 4.18.2 | 0.90 | 0.62 | 0.73 |
| NestJS v10.4.9 | 0.67 | 0.57 | 0.60 |
| FastAPI 0.103.0 | 0.81 | 0.67 | 0.74 |
| Gin v1.9.1 | 1.00 | 0.78 | 0.84 |
| **Mean (hybrid + rerank)** | **0.82** | **0.66** | **0.73** |

Split by query style and configuration (the numbers that matter for agent workflows):

| Channel | Rank-1 | MRR | Success@5 |
| :--- | ---: | ---: | ---: |
| **Symbolic** (name-lookup, 69q), hybrid | **0.80** | **0.84** | — |
| **Semantic** (behavioural, 31q), hybrid + rerank | **0.35** | **0.47** | **0.65** |
| Semantic, hybrid (no rerank) | 0.23 | 0.37 | 0.55 |
| Semantic, lexical-only (no Ollama) | 0.19 | 0.29 | 0.48 |

Read the semantic rows with their denominator in mind: under *strict* scoring several of those
queries are unwinnable in-repo (the expected symbol is an anonymous default export, or is
re-exported from a dependency whose implementation isn't in the codebase), and most strict
"misses" still land the right file in the top-2 — which the loose channel (0.89) credits and an
agent can use. Symbol-naming queries — the bulk of real agent traffic — find the exact chunk
first try 80% of the time and in the top ranks (MRR 0.84) almost always.

Ranking favours exact symbol matches even for short, high-signal names — `res.json`,
`req.get`, `app.all` — by gating the name boost on corpus **document frequency** instead of a
blunt length cutoff (with singular/plural equivalence, so `BackgroundTask` finds
`BackgroundTasks`). Natural-language queries are detected and ranked **vector-first** (with the
name/path boosts gated on semantic agreement), so behavioural questions aren't drowned by
keyword noise. Test, spec, example and sandbox chunks are demoted in both channels.

**Backend parity is exact**: every rank-assigning sort uses deterministic tie-breaking and both
stores funnel vector candidates through one shared finalizer, so the in-memory engine and the
SQLite store return **identical top-5 chunk ids for 100/100 benchmark queries** — verified, not
approximate.

Reproduce every view:

```bash
npm run test:setup     # clone the 5 fixture repos
npm run test           # loose hit-rate + token savings + indexing stats
npm run test:eval      # strict symbol-level accuracy, lexical channel
OLLAMA_HOST=http://localhost:11434 node test/evaluate.mjs --embeddings              # hybrid
OLLAMA_HOST=http://localhost:11434 node test/evaluate.mjs --embeddings --use-sqlite # parity
OLLAMA_HOST=http://localhost:11434 RERANK_MODEL=qwen2.5-coder:7b \
  node test/evaluate.mjs --embeddings --rerank                                      # + judge
```

> The strict harness ([test/evaluate.mjs](test/evaluate.mjs)) exists specifically to keep
> these numbers honest and prevent the tool from being tuned to a friendly benchmark — it
> reports the inflation gap (loose minus strict) per suite so regressions in real precision
> can't hide behind a permissive hit-rate, and it splits the symbolic and semantic channels
> so neither inflates the other.

---

## Getting started

**Requirements:** Node.js v18+ · Ollama (optional, for semantic search and enrichment) · Node.js v22.5+ for the optional SQLite backend

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

Lexical-only still scores loose recall@5 = 0.90 and strict symbolic MRR 0.81 on the benchmarks above — only the semantic (behavioural-query) channel needs embeddings.

**On a large monorepo, keep retrieval RAM flat with the SQLite backend:**
```bash
npm run mcp:index -- --use-sqlite
```

**Sharpen conceptual recall with local-LLM enrichment:**
```bash
ollama pull qwen2.5-coder:1.5b
npm run mcp:index -- --llm-enrichment
```

The two options compose (`--use-sqlite --llm-enrichment`) and can be made permanent in `.graph-indexer.json` — see [Configuration](#configuration).

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

The server reads the backend from `.graph-indexer.json`, so the same launch config works for both the in-memory and SQLite indexes.

### 4. Add the agent system prompt

Copy [PROMPT.md](./PROMPT.md) into your AI agent's system prompt to instruct it to use graph-indexer tools instead of reading files directly.

---

## Storage backends

The same index, the same tools, the same ranking — two ways to hold the data. The MCP tools are written against a storage contract and never see which backend is active.

| Backend | Default | Resident RAM* | Dependencies | Best for |
| :--- | :--- | ---: | :--- | :--- |
| **In-memory** | ✅ | ~586 MB | none | Single packages and services; instant cold start. |
| **SQLite** | `--use-sqlite` | ~79 MB | none — uses Node's built-in `node:sqlite` | Monorepos / 1M+ LOC where holding every chunk in the heap would OOM. |

> *Resident set serving the **same** 50,000-chunk corpus, measured in isolated processes by
> [test/scale.mjs](test/scale.mjs). The in-memory engine keeps every chunk and the full inverted
> index in the heap, so its footprint grows with the codebase; the SQLite store keeps only the
> small file-level dependency graph resident and reads chunks, posting lists and vectors from disk
> on demand, so its footprint stays flat regardless of corpus size — an **87% smaller** resident
> set here, and the gap widens as the repo grows.

The SQLite backend adds **no external dependency**: `node:sqlite` ships inside Node (v22.5+). Lexical BM25 reads from an indexed `postings` table, symbols and call edges from indexed columns, and vectors live in the shared `code-index.embeddings.bin` — point reads are `pread` on demand. Because both backends feed the same fusion-and-boost ranker with deterministic tie-breaking, switching is purely an operational choice with **zero** quality trade-off (identical top-5 ids on the full benchmark).

### Vector search that stays fast at monorepo scale

Below 10k vectors the semantic channel runs an exact streaming scan of the bin (~20 ms worst
case). Above it, a **binary-quantized sketch** takes over: each vector's sign bits (768 dims →
96 bytes, 0.1 % of the float data) are kept in RAM; a query does a Hamming-distance pass over
packed Uint32 words, then exact-cosine rescores only the top candidates from disk. Measured on
synthetic corpora (warm):

| Corpus | Exact scan | Sketch | Speedup | Sketch RAM |
| ---: | ---: | ---: | ---: | ---: |
| 50,000 vectors | 104 ms | **5–11 ms** | ~20× | ~9 MB |
| 200,000 vectors | 519 ms | **11 ms** | ~36× | ~35 MB |

The sketch recovers the exact top-10 (10/10 in validation) because it rescores 2× the candidate
budget with true cosine before ranking. It is **append-aware**: daemon updates extend it by
scanning only the unseen tail of the bin, and a full re-index is detected by fingerprint and
triggers a rebuild. `test/scale.mjs` asserts hybrid queries stay interactive (<60 ms) at 50k
chunks on both backends.

```bash
npm run mcp:index -- --use-sqlite     # writes code-index.db
```

### Live updates on both backends

The watch daemon keeps **whichever backend is configured** fresh, incrementally:

- **In-memory** — the daemon rewrites the JSON snapshot; a running MCP server watches the file and reloads it automatically.
- **SQLite** — each file save becomes one WAL transaction (`applyFileUpdate`): the file's old chunks, postings and call edges are replaced with exact BM25 bookkeeping, and new vectors are *appended* to the embeddings bin (O(changed chunks), never a full rewrite). Running MCP servers detect the commit via `PRAGMA data_version` on their next query and refresh themselves — no re-indexing, no restarts.

Daemon startup is also O(changed files): files older than the index artifact are skipped during the initial scan, so edits made while the daemon was down are picked up without re-parsing the whole repo.

---

## Semantic enrichment

Embeddings match text proximity, not intent. A query like *"payment gateway webhook bottleneck"* misses the function that handles it if that function never spells out those words. Enrichment closes that gap.

With `--llm-enrichment`, the indexer routes every substantive **production-source chunk** (tests, specs and example trees are excluded — agents search for implementations) through a local LLM via Ollama, producing per chunk:

- a one-line **summary** in developer vocabulary, and
- a set of **concept tags** (e.g. `authentication, JWT, middleware`).

These ride **three** retrieval paths: the tags join the chunk's BM25 lexical document as high-IDF domain terms; the summary leads the code-payload embedding; and — decisive for natural-language queries — each enriched chunk gets a **second, summary-only vector**. A one-line behavioural query embeds far closer to a one-line summary than to hundreds of characters of code, so conceptual searches hit code that shares none of their words.

Enrichment is **incremental**: results are cached in `code-index.enrichment.json` keyed by content hash, so a re-index only sends new or changed code to the LLM (the embedding cache keys account for enrichment too, so nothing is re-embedded needlessly). Each run enriches up to `maxChunks` new chunks, ordered by file centrality (PageRank), and coverage accumulates across runs. The watch daemon re-attaches cached enrichment on every file save and live-enriches changed chunks. Generation is best-effort — if the model is unreachable the index is built without enrichment rather than failing.

```bash
ollama pull qwen2.5-coder:1.5b
npm run mcp:index -- --llm-enrichment
```

The model, the file-selection ratio and the per-run cap are all configurable (see [Configuration](#configuration)). Enrichment is fully optional and leaves the default index byte-for-byte unchanged when disabled.

### LLM reranking (query time, opt-in)

Fusion resolves most queries, but a natural-language query can end in a near-tie between the
semantically right chunk and a lexically similar neighbour — a gap no static boost can close.
With `rerank.enabled` (or `search_code(..., rerank: true)`), the fused top-8 is shown to a local
LLM judge — one line per candidate — which reorders them. Measured effect on the strict semantic
channel: **rank-1 0.23 → 0.35, MRR 0.37 → 0.47, success@5 0.55 → 0.65**, with the symbolic
channel untouched (the judge only fires on natural-language queries, never on symbol lookups or
`exact_tokens` calls). Cost: one generation call (~1–2 s with `qwen2.5-coder:7b`). Best-effort —
any model failure preserves the original order.

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
| `rerank` | boolean? | config | LLM-judge rerank for natural-language queries (see `rerank.*` config) |

**`detail` levels:**

| Value | Cost | Returns |
| :--- | ---: | :--- |
| `"signatures"` | ~20 tok | Name, type, params, return type, topology |
| `"smart"` (default) | ~150 tok | Signature + lines relevant to the query |
| `"full"` | ~300 tok | Signature + complete source body |

For purely conceptual queries with no lexical overlap, `"smart"` falls back to a structural skeleton — control-flow lines and call sites — so the agent always gets meaningful signal about what the code does, never a blind truncation.

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

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `chunk_id` | string | required | ID from `search_code` results |
| `expand_calls` | boolean | `false` | Resolve each outgoing call's signature inline (~150 tok) instead of issuing a follow-up tool call per dependency |

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

Index health snapshot: storage backend, chunk count, file count, symbol table size, vector count, search mode, daemon status, index age.

---

### `graph://dependencies/{file_path}` (resource)

Full bidirectional dependency topology for a file: what it imports and what imports it.

---

## Configuration

### `.graph-indexer.json`

All persistent settings live in one file at the project root, written by `init` and read by the indexer, watcher and server:

```json
{
  "languages": ["typescript", "javascript", "python"],
  "storage": "sqlite",
  "enrichment": {
    "enabled": true,
    "model": "qwen2.5-coder:1.5b",
    "coreRatio": 0.15,
    "maxChunks": 400
  }
}
```

| Key | Default | Description |
| :--- | :--- | :--- |
| `languages` | all installed | Parsers to load. Valid keys: `typescript`, `javascript`, `python`, `go`, `rust`, `php`, `java`, `kotlin`, `csharp`, `ruby`, `css`. |
| `storage` | `"memory"` | `"memory"` (in-heap, zero-dependency) or `"sqlite"` (disk-backed). |
| `ollamaHost` | `"http://localhost:11434"` | Ollama endpoint (also settable via `OLLAMA_HOST`). |
| `embedModel` | `"nomic-embed-text"` | Embedding model (index and queries must use the same one). |
| `enrichment.enabled` | `false` | Run local-LLM enrichment during indexing. |
| `enrichment.model` | `"qwen2.5-coder:1.5b"` | Ollama model used for generation. |
| `enrichment.coreRatio` | `1.0` | Share of production files eligible (by PageRank). `1.0` = all; tests/examples are always excluded. |
| `enrichment.maxChunks` | `500` | Cap on **new** LLM calls per index run — the cache accumulates coverage across runs. |
| `enrichment.concurrency` | `12` | Parallel Ollama requests during enrichment. |
| `rerank.enabled` | `false` | LLM-judge reranking of natural-language queries (+50% semantic rank-1, ~1–2 s per NL query). |
| `rerank.model` | `"qwen2.5-coder:7b"` | Judge model. Quality matters: 7B measured a large gain where 1.5B measured ~none. |
| `rerank.topM` | `8` | Fused results shown to the judge (8 measured better than 10). |

### CLI flags

Flags override the config file for a single run:

| Flag | Equivalent |
| :--- | :--- |
| `--repo <dir>` | Index a directory other than the cwd |
| `--use-sqlite` | `"storage": "sqlite"` |
| `--llm-enrichment` | `"enrichment.enabled": true` |
| `--enrich-model <name>` | `"enrichment.model"` |
| `--enrich-max <n>` | `"enrichment.maxChunks"` for this run |
| `--enrich-concurrency <n>` | `"enrichment.concurrency"` for this run |

### Environment variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MCP_PROJECT_ROOT` | `process.cwd()` | Project root directory |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint |
| `INDEXER_EMBEDDINGS` | — | Set to `off` to disable vector embeddings |

Re-run `init` at any time to change languages, or `init --all-languages` to enable every installed parser without the prompt.

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

Oversized "god classes" are split automatically: a class longer than ~200 lines is indexed as a compact skeleton header plus one independently searchable chunk per method, so a single `get_chunk` never blows the token budget and every method stays reachable by search.

---

## How it works

### Architecture

graph-indexer is organised around a small set of cohesive modules with a strict separation between *retrieval math*, *storage*, and *transport*:

```
config.mjs        Resolves CLI flags > env > .graph-indexer.json into one config.
parser-utils.mjs  Tree-sitter parsing, chunk extraction, Ollama embeddings.
search-core.mjs   Shared retrieval math: tokenisation, BM25, RRF fusion + boosts
                  (query-adaptive NL weighting), PageRank, embedding cache keys.
                  The numbers are measured once here and reused.
core-engine.mjs   MemoryGraphIndex — the default in-heap store — plus the
                  embeddings-bin codecs (write/read/append/scan) and the
                  binary-quantized vector sketch (Hamming prefilter + rescore).
sqlite-store.mjs  SqliteGraphStore — the disk-backed store (node:sqlite) with
                  per-file incremental writes and data_version live refresh.
storage.mjs       createStore(config) — picks a backend; documents the contract
                  both implement (searchHybrid, getChunk, applyFileUpdate, …).
enrichment.mjs    Optional LLM summaries + concept tags, cached by content hash.
mcp-tools.mjs     The eight tools, written against the storage contract only.
mcp-server.mjs    Thin bootstrap: config → store → tools → stdio.
indexer.mjs       Bootstrap indexer.   watch-daemon.mjs  Incremental updates.
```

Because both stores call the identical `fuseAndRank` from `search-core`, the in-memory and SQLite backends are rank-consistent by construction, and a single change to the ranking math applies everywhere.

### Indexing

When you run `npm run mcp:index`:

1. **Parses** every source file with Tree-sitter — no regex, exact AST boundaries.
2. **Extracts chunks**: named functions, classes, methods, and exports — including Go/Rust `type`/`struct` declarations by their real name — each with docstring, parameters, return type, call sites, type references, **decorators/annotations** (`@Controller`, `@Injectable`, `@app.route`), and **inheritance edges** (`extends`/`implements`/base classes).
3. **Builds a dependency graph**: bidirectional import map so each chunk knows what it imports and what imports it.
4. **(Optional) Enriches** production-source chunks with LLM summaries + concept tags (cache-first; only new code pays an LLM call).
5. **Creates two indexes**: a BM25 inverted index (lexical) and per-chunk float32 embeddings via Ollama `nomic-embed-text` (optional) — two vectors per enriched chunk (code payload + summary-only).
6. **Persists** to the configured backend: `code-index.json` + `code-index.embeddings.bin`, or `code-index.db` + the same embeddings binary.

A background watcher daemon applies changed files incrementally to **either** backend (JSON
snapshot rewrites for in-memory, per-file WAL transactions for SQLite). It respects
`.gitignore` and skips `node_modules`, build output, and dot-directories, so it never traverses
(or exhausts OS file-watcher limits on) dependency trees.

### Search pipeline

```
Source files
     │
     ▼
Tree-sitter AST
     │
     ├──► Chunks ──► BM25 inverted index ──┐
     │         └──► Float32 embeddings  ──┤── RRF fusion ──► Ranked results ──► MCP tools
     │                                     │   (search-core)
     └──► Dependency graph ────────────────┘
```

1. **BM25 lexical search** — O(query_terms) over the inverted index / `postings` table.
2. **Vector search** — exact cosine below 10k vectors; binary-sketch Hamming prefilter +
   exact rescore above it (5–11 ms at 50k+, see [Storage backends](#storage-backends)). Both
   code and summary vectors compete; hits fold onto their chunk through one shared finalizer.
3. **RRF fusion** merges both lists — lexical-led (1.5×/1.0×) for keyword queries,
   vector-led (1.0×/1.6×) for natural-language ones.
4. **Score boosts**: exact name match +2.0× (df-gated, plural-aware), suffix match +1.4×,
   path token +1.4×, test/example files demoted; on NL queries, boosts require semantic
   agreement (the chunk must also be a vector candidate).
5. **(Opt-in) LLM rerank** of the fused top-8 on natural-language queries.

---

## Best practices

**Write descriptive docstrings.** Docstrings are embedded alongside code — better documentation directly improves semantic search quality.

**Use specific function names.** Names like `fetchAndCacheUserProfile` trigger the exact-name boost (2.0×) and reliably appear as rank-1 results when queried by name.

**Export named functions, not anonymous ones.** Anonymous default exports can't be targeted by `resolve_symbol` and rank lower in name-boost scoring.

**Avoid catch-all utility files.** Files that mix unrelated utilities produce weaker per-chunk signals. One responsibility per module indexes more cleanly.

**Reach for the SQLite backend when the heap gets tight.** If indexing a large monorepo pushes Node toward its memory limit, switch to `--use-sqlite`; retrieval quality is identical and resident memory stops scaling with the codebase.

---

## Troubleshooting

**Index takes too long**
- Verify Ollama is running: `curl http://localhost:11434/api/tags`
- Use lexical-only mode: `INDEXER_EMBEDDINGS=off npm run mcp:index`

**Indexing a huge repo runs out of memory**
- Build with `--use-sqlite` so chunks live on disk instead of the heap
- Confirm the active backend with `list_index_stats()`

**`--use-sqlite` reports node:sqlite is unavailable**
- The SQLite backend needs Node v22.5+; upgrade Node, or use the default in-memory backend

**Search returns irrelevant results**
- Use `exact_tokens` for known symbol names
- For conceptual queries, index with `--llm-enrichment` and embeddings enabled
- Check coverage with `list_index_stats()`; increase `top_k` to see more candidates

**MCP server won't connect**
- Verify `MCP_PROJECT_ROOT` points to the indexed directory
- Check the index exists: `ls -la code-index.json` (or `code-index.db`)
- Test manually: `npm run mcp:start`

**Results are stale after file changes**
- The daemon updates both backends live and running servers refresh automatically; check `list_index_stats()` for daemon status
- If the daemon isn't running, restart the MCP server (it spawns the daemon) or run `npm run mcp:index` manually

---

## Development

```bash
git clone https://github.com/MaquinaTech/graph-indexer.git
cd graph-indexer
npm install
npm run mcp:index   # index this repo
npm run mcp:start   # start MCP server
```

### Tests

| Command | Scope |
| :--- | :--- |
| `npm run test` | Integration suite: indexing + loose hit-rate + token savings across 5 fixtures |
| `npm run test:eval` | Strict symbol-level accuracy (rank-1, precision, nDCG) |
| `npm run test:unit` | Pure helpers, chunk splitting |
| `npm run test:sqlite` | SQLite round-trip + rank consistency vs the in-memory engine |
| `npm run test:enrich` | HyDE enrichment, including the lexically-disjoint rank-1 flip |
| `npm run test:mcp` | End-to-end MCP server over stdio |
| `npm run test:scale` | Mock 50k-chunk corpus proving SQLite RAM stays bounded |
| `npm run test:all` | Every dependency-free suite above, no Ollama required |

---

## Security

graph-indexer runs locally and is air-gapped by default — its only outbound calls
are to a local Ollama endpoint for embeddings and optional enrichment (skipped entirely with
`INDEXER_EMBEDDINGS=off` and without `--llm-enrichment`). It never executes the code it indexes,
and the index artifacts contain source snippets, so keep them git-ignored (as `init` configures).

See [SECURITY.md](SECURITY.md) for the full threat model and how to report a
vulnerability.

---

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 MaquinaTech.

---

Built by [MaquinaTech](https://github.com/MaquinaTech) · [Issues](https://github.com/MaquinaTech/graph-indexer/issues) · [npm](https://www.npmjs.com/package/graph-indexer)
