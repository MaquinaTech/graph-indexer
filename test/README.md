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

# 6. Strict, symbol-level accuracy (harness — see below)
node test/evaluate.mjs            # all suites (lexical channel)
node test/evaluate.mjs --verbose  # per-query top-1 + inflation flags

# 7. Strict accuracy on the HYBRID channel (lexical + nomic-embed-text vectors)
#    Requires fixtures indexed with INDEXER_EMBEDDINGS=on and a running Ollama.
OLLAMA_HOST=http://localhost:11435 node test/evaluate.mjs --embeddings

# 8. Full pipeline incl. LLM enrichment (summaries/tags cached per fixture in
#    code-index.enrichment.json — the first run is slow, re-runs are cache hits)
for f in axios express-js nestjs fastapi gin; do
  INDEXER_EMBEDDINGS=on OLLAMA_HOST=http://localhost:11435 \
    node indexer.mjs --repo test/fixtures/$f --llm-enrichment --enrich-max 4000
done
OLLAMA_HOST=http://localhost:11435 node test/evaluate.mjs --embeddings              # memory
OLLAMA_HOST=http://localhost:11435 node test/evaluate.mjs --embeddings --use-sqlite # parity

# 9. LLM-judge reranking on top (natural-language queries only; RERANK_MODEL
#    defaults to qwen2.5-coder:1.5b — use the 7B for the measured quality gain)
OLLAMA_HOST=http://localhost:11435 RERANK_MODEL=qwen2.5-coder:7b \
  node test/evaluate.mjs --embeddings --rerank
```

> ⚠️ `node test/run.mjs` re-indexes fixtures **without** enrichment/embeddings by
> default, which downgrades indexes built by step 8. Use `--skip-indexing` to
> measure loose metrics on existing enriched indexes.

---

## Two harnesses: loose vs strict

`run.mjs` and `evaluate.mjs` score the **same queries** with different relevance rules,
and you should read them together:

| Harness | Relevance rule | What it tells you |
|---------|----------------|-------------------|
| `run.mjs` (loose) | top-k contains a chunk whose **name** *or* **file path** matches an expected substring | Optimistic **hit-rate**. Credits "landed in the right file" even if the #1 result is the wrong symbol. Upper bound. |
| `evaluate.mjs` (strict) | the result's symbol **name** (whole or last dotted component) **exactly equals** an expected name — no file-path fallback, no substring | Pessimistic **symbol accuracy**: rank-1, precision@k, strict MRR, correctly-normalised nDCG. Lower bound. |

`run.mjs`'s `recall@k` is, strictly speaking, a **success/hit-rate@k** (1 if *any* top-k
result is relevant), not classical recall. `evaluate.mjs` additionally reports a
**file-only inflation rate** — the share of loose hits that are *not* strict hits, i.e. how
much of the headline number comes from the permissive file-path clause. Use it to catch
benchmark-gaming: a ranking tweak that lifts loose hit-rate but leaves rank-1 flat is noise.

---

## Ablation findings (what these harnesses decided)

Every retrieval-path change was validated against strict rank-1 / MRR before shipping. The
record, so future work doesn't repeat dead ends:

| Change | Channel | Measured effect on strict rank-1 / MRR | Decision |
|--------|---------|----------------------------------------|----------|
| **df-aware name boost** (short discriminative tokens like `json`, `all` boost; ubiquitous `get`/`the`/`use` don't) | lexical | Express 0.64→0.71, Gin 0.77→0.85, FastAPI s@5 0.86→0.93; **overall 0.73→0.75 / 0.79→0.81** | **shipped** |
| Go `type`/`struct` real-name extraction | indexing | Gin rank-1 0.69→0.77, removed file-only inflation | **shipped** |
| Graded path-overlap boost | lexical | neutral | reverted |
| Decorators / inheritance as **BM25 tokens** | lexical | NestJS rank-1 **0.57→0.43** (regression — `controller`/`module` become ubiquitous, dilute definition queries) | **excluded** |
| Decorators / inheritance in **embedding payload** | hybrid | exactly **neutral** (Δ0 on Express/NestJS/FastAPI, A/B via `--embeddings`) | **excluded** from payload |
| Decorators / inheritance as **result metadata** | display | n/a (not a ranking signal) | **shipped** (MCP cards) |

Takeaway: decorator/annotation and `extends`/`implements` extraction is real and surfaced to
agents as metadata, but it is deliberately kept out of *both* retrieval channels because it
did not measurably improve symbol retrieval (and hurt it lexically). The benchmark is
symbol-centric; a query set that tests concept→implementation traversal would be needed to
measure semantic-linking value.

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
| Metric | Harness | Description |
|--------|---------|-------------|
| `recall@1/3/5/10` | run.mjs | Hit-rate: fraction of queries with ≥1 loose match in top-k |
| `MRR` | run.mjs | Mean Reciprocal Rank (loose) |
| `strictSuccess@k` | evaluate.mjs | Fraction of queries with the exact target symbol in top-k |
| `rank1` | evaluate.mjs | Fraction of queries where the **#1** result is the exact target |
| `precision@k` | evaluate.mjs | Fraction of top-k that are exactly correct |
| `nDCG@k` | both | Normalised DCG, correctly bounded to `[0,1]` |
| `fileOnlyHitRate` | evaluate.mjs | Share of loose hits that are not strict hits (inflation) |
| `avgSearchMs` | run.mjs | Mean query latency (pure in-memory, no I/O) |

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
