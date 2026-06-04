## Why This Beats Standard RAG

| Feature | **graph-indexer-mcp** | Standard RAG (e.g. ChromaDB + naive chunks) |
| --- | --- | --- |
| **Chunking strategy** | AST-precise: functions, classes, impls | Naive line-count or token-count splits |
| **Database** | Zero-DB — pure in-memory `Map` + `Float32Array` | External vector DB (Chroma, Pinecone, Weaviate) |
| **Privacy** | 100% air-gapped (local Ollama) | Often requires cloud embedding APIs |
| **Search quality** | Hybrid RRF (Dense + Sparse) | Dense-only or BM25-only |
| **Dependency context** | Bidirectional graph topology (`importedBy` / `imports`) | None |
| **Embedding failure** | Graceful degradation to pure TF-IDF | Hard failure |
| **Latency** | Sub-millisecond (V8 + `Float32Array` SIMD layout) | Network RTT + DB query overhead |
| **Context window safety** | 8,000-char prompt truncation + 1,500-char snippet cap | Uncapped — risks LLM context overflow |
| **Polyglot support** | TS · JS · Python · Rust · Go · CSS/SCSS | Language-agnostic (but loses semantic precision) |
| **Memory management** | `_removeLexical` prevents TF-IDF leaks on file updates | Full reindex required |

---

## Key Features

* **In-Memory Engine** — Native cosine similarity in V8 with `Float32Array`. Sub-millisecond searches with zero network overhead.
* **Absolute Privacy** — Direct integration with a local Ollama instance (`nomic-embed-text`). Your code never leaves your machine.
* **Hybrid RRF Search** — Combines vector semantic search (Dense) with a sublinear-scaled TF-IDF inverted index (Sparse) using Reciprocal Rank Fusion. Find abstract concepts *and* exact business tokens in the same query.
* **AST Precision** — Surgical extraction using Tree-sitter grammars. Immune to commented imports or string-embedded identifiers.
* **Graceful Degradation** — If Ollama is unavailable, every chunk is still indexed lexically. Hybrid search silently falls back to pure TF-IDF without losing a single fragment.
* **Real-Time Sync** — Debounced `fs.watch` daemon with non-blocking async I/O. Batches rapid IDE auto-saves into a single atomic disk write.
* **graph:// URI Scheme** — Query bidirectional dependency topology for any file directly from your MCP client without running a search.
* **Polyglot** — TypeScript, JavaScript, Python, Rust, Go, CSS, SCSS out of the box. Extensible to any Tree-sitter grammar in minutes.

---

## Installation

Add as a development dependency in your repository:

```bash
npm install graph-indexer-mcp --save-dev

```

Add the execution shortcuts to your `package.json`:

```json
"scripts": {
  "mcp:index": "idx-index --repo .",
  "mcp:watch": "idx-watch",
  "mcp:start": "idx-mcp"
}

```

### System Requirements

* **Node.js** v18+ (ES Modules support)
* **Ollama** running at `http://localhost:11434` with `nomic-embed-text` pulled:
```bash
ollama pull nomic-embed-text

```


* **C/C++ Build Toolchain (Optional)**: Tree-sitter uses native C++ compilation bindings. If prebuilt binaries are not available for your specific platform/architecture, a local C/C++ compiler toolchain (such as GCC/Clang or VS Build Tools) along with `node-gyp` requirements may be necessary.

---

## Usage

### Phase 1 — Bootstrap (Initial Indexing)

Scans the repository, builds the `code-index.json` file, and generates embeddings:

```bash
npm run mcp:index

```

### Phase 2 — Daemon (Real-Time Sync)

Run in a secondary terminal. Watches for file changes and updates the index atomically:

```bash
npm run mcp:watch

```

### Phase 3 — MCP Server

Point your MCP client (Claude Desktop, VS Code Copilot Agent, Cursor) to this command. The server loads RAM in $O(1)$ and communicates via stdio:

```bash
npm run mcp:start

```

---

## MCP Tools & Resources

### `search_code` tool

Hybrid semantic + lexical search with dependency topology.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `query` | `string` | — | Natural language or code query |
| `exact_tokens` | `string?` | — | Exact function/class name to boost |
| `top_k` | `number` | `5` | Results to return (1–20) |
| `min_score` | `number` | `0.3` | Cosine similarity threshold |
| `include_topology` | `boolean` | `true` | Append dependency graph context |

### `graph://dependencies/{file_path}` resource

Returns the full bidirectional dependency topology for any indexed file as Markdown.

```
graph://dependencies/src/auth/middleware.ts

```

**Response:**

```markdown
# Dependency Topology: `src/auth/middleware.ts`

## Imports (2)
- `src/utils/jwt.ts`
- `src/db/session.ts`

## Imported By (3)
- `src/routes/api.ts`
- `src/routes/admin.ts`
- `src/app.ts`

```

Use `list` on the resource template to enumerate all indexed files.

---

## Polyglot Extension Guide

Adding a new language takes four steps. Example: **PHP**

### Step 1 — Install the Grammar

```bash
npm install tree-sitter-php

```

### Step 2 — Import and Map the Extension

In `indexer.mjs` and `watch-daemon.mjs`:

```js
import PHP from 'tree-sitter-php';

const LANGUAGE_MAP = {
    // ... existing
    '.php': PHP.php,
};

```

### Step 3 — Register Semantic Nodes

```js
const SEMANTIC_NODES = new Set([
    // ... existing
    // PHP
    'function_definition', 'method_declaration', 'class_declaration',
]);

```

### Step 4 — Teach the Import Extractor

In `extractImportsFromAST`:

```js
else if (node.type === 'require_expression' && ext === '.php') {
    const pathNode = node.children.find(c => c.type === 'string');
    if (pathNode) imports.add(pathNode.text.replace(/['"]/g, ''));
}

```

Restart the daemon after saving a `.php` file and it will be automatically extracted, dual-indexed, and made searchable.

---

## Mathematical Notes

### Sublinear TF Scaling

Term frequencies are scaled as:


$$\text{weight}(t,d) = 1 + \log(\text{raw\_count})$$


instead of raw counts. This compresses the dynamic range, preventing ubiquitous tokens like `return` or `const` from drowning out semantically rich but less-frequent identifiers.

### Reciprocal Rank Fusion

$$\text{score}(d) = \sum_{i} \frac{1}{K + \text{rank}_i(d)} \quad K = 60$$

RRF merges the vector and lexical ranked lists by position rather than raw score, making it robust to the incompatible scales of cosine similarity and TF-IDF. The exact-name boost adds $\frac{1}{K+1}$ — the theoretical maximum single-list contribution — to any chunk whose `name` exactly matches `exact_tokens`.

---

## Author & Maintainer

Developed and maintained by **MaquinaTech**.

* **GitHub:** [@MaquinaTech](https://github.com/MaquinaTech)
* **NPM:** [graph-indexer-mcp](https://www.npmjs.com/package/graph-indexer-mcp)

Issues and pull requests are welcome.

---

## License

MIT — see [LICENSE](https://www.google.com/search?q=LICENSE) for details.