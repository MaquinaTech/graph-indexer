# graph-indexer Test Suite

Comprehensive quality, performance, and token-savings evaluation using five pinned
open-source projects across four languages.

> **Not published** — `test/` is in `.gitignore` and excluded from the npm package.

---

## Fixture projects

| Suite | Project | Language | Pinned version |
|-------|---------|----------|----------------|
| `axios` | [axios/axios](https://github.com/axios/axios) | JavaScript | v1.6.0 |
| `express-js` | [expressjs/express](https://github.com/expressjs/express) | JavaScript | 4.18.2 |
| `nestjs` | [nestjs/nest](https://github.com/nestjs/nest) | TypeScript (Express-based) | v10.4.9 |
| `fastapi` | [tiangolo/fastapi](https://github.com/tiangolo/fastapi) | Python | 0.103.0 |
| `gin` | [gin-gonic/gin](https://github.com/gin-gonic/gin) | Go | v1.9.1 |

---

## Quick start

```bash
# 1. Clone all fixtures (one-time setup, ~150 MB total)
node test/setup.mjs

# 2. Run the full test suite (lexical-only, no Ollama required)
node test/run.mjs

# 3. Run a single suite
node test/run.mjs --suite axios

# 4. Run with Ollama embeddings (requires Ollama + nomic-embed-text)
node test/run.mjs --embeddings

# 5. Emit a JSON report to test/reports/
node test/run.mjs --json
```

---

## Metrics measured

### Indexing quality
| Metric | Description |
|--------|-------------|
| `chunkCount` | Total AST chunks extracted |
| `namedChunksPct` | % of chunks with a real symbol name (vs `anonymous`) |
| `docstringPct` | % of chunks that captured a docstring/comment |
| `callsPct` | % of chunks with outgoing call-graph data |
| `avgChunkTokens` | Mean tokens per chunk (`chars / 4`) |
| `throughput` | Chunks indexed per second |

### Dependency graph
| Metric | Description |
|--------|-------------|
| `totalDepEdges` | Total import edges in the dependency graph |
| `filesWithDepsPct` | % of source files with at least one resolved import |

### Search quality (per query + aggregate)
| Metric | Description |
|--------|-------------|
| `recall@1/3/5/10` | Fraction of queries where the target appears in top-k |
| `MRR` | Mean Reciprocal Rank across all queries |
| `avgSearchMs` | Mean query latency (pure in-memory, no I/O) |

Queries are classified as **easy** (exact symbol name), **medium** (partial/related terms),
or **hard** (semantic/conceptual description only).

### Token savings
| Metric | Description |
|--------|-------------|
| `chunkTokens` | Tokens in the top-5 returned chunks |
| `fileTokens` | Tokens in the **full source files** those chunks came from |
| `savingsPct` | `100 × (1 − chunkTokens / fileTokens)` — the headroom an agent saves |
| `srcTokensTotal` | Total source tokens in the entire fixture project |

---

## Interpreting results

- **recall@5 ≥ 0.80** → the indexer reliably surfaces relevant code within 5 results.
- **MRR ≥ 0.65** → the top result is usually correct.
- **savingsPct ≥ 75%** → using chunk search instead of full-file context cuts token cost by ≥ 75%.
- **namedChunksPct ≥ 90%** → AST extraction is producing well-labelled chunks.

---

## Re-pinning fixtures

To update a fixture to a newer version, delete its directory and re-run setup:

```bash
rm -rf test/fixtures/nestjs
node test/setup.mjs
```

Then update the `ref` in `test/setup.mjs` and the ground-truth queries in
`test/suites/nestjs.mjs` accordingly.
