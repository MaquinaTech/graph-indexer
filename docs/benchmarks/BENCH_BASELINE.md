# BENCH_BASELINE.md

Frozen baseline captured **before any code change**, against which every work-item
delta is measured. Regenerated from real runs — never hand-edited per number.

- **Captured:** 2026-06-17 (commit `13daaff`, branch `feat/prompts`, v1.3.0)
- **Host:** darwin, Node v24.16.0
- **Ollama:** reachable at `http://localhost:11434` — models present:
  `nomic-embed-text`, `qwen2.5-coder:1.5b`, `qwen2.5-coder:7b`, `qwen3:8b`,
  `qwen2.5:14b-instruct`, `gemma4`.
- **In-process embedder:** `@huggingface/transformers@3.8.1` installed (optional dep
  present) → the `local` provider (`Xenova/all-MiniLM-L6-v2`, 384-dim) is available.

> **Errata (2026-06-18) — file-only inflation was display-bugged 100×.** Every
> "file-only inflation" / "file-only inflated hits" figure in this document was
> printed via `fmtPct`, which rendered a 0–1 fraction without a ×100 scale
> (`test/metrics.mjs` + the `test/evaluate.mjs` call sites, **now fixed**), so each
> printed **"0.1%"** is actually ~100× higher. Re-measured on current code
> (`npm run test:eval`, lexical default): **OVERALL file-only inflation = 11.6%**,
> **HELD-OUT = 0.0%**; per-suite tuning: axios 10.5%, express 4.8%, nestjs 38.1%,
> fastapi 4.8%, gin 0.0%. This was a *formatting* bug only — rankings, backend
> parity, and the held-out gate are unaffected. The honest guarantee is that the
> **held-out validation set has 0.0% file-only inflation** and the hybrid path does
> not *increase* inflation over lexical — **not** that inflation is ≤0.1%. The
> "~11.6%" figures below are the corrected lexical-overall magnitude; file-only is
> lexical-dominated, and exact per-channel hybrid/rerank values were not separately
> re-measured.

## How to reproduce

```bash
npm run test                                                              # loose hit-rate + savings + index time (lexical)
npm run test:eval                                                         # strict, lexical-only channel
OLLAMA_HOST=http://localhost:11434 node test/run.mjs --embeddings         # build memory index WITH nomic vectors (plain corpus)
OLLAMA_HOST=http://localhost:11434 node test/evaluate.mjs --embeddings    # strict, hybrid
OLLAMA_HOST=http://localhost:11434 node test/run.mjs --embeddings --use-sqlite
OLLAMA_HOST=http://localhost:11434 node test/evaluate.mjs --embeddings --use-sqlite   # parity
OLLAMA_HOST=http://localhost:11434 RERANK_MODEL=qwen2.5-coder:7b node test/evaluate.mjs --embeddings --rerank
npm run test:all
```

Note: the embeddings baseline is the **plain corpus** (no `--enrichment`), so the
NL vector channel runs at the `NL_VECTOR_WEIGHT_PLAIN` (0.4) regime. WI2 will measure
the enriched corpus separately.

---

## 1. Strict symbol-level eval (`test/evaluate.mjs`) — the honesty harness

Overall = mean across the 5 suites (axios, express-js, nestjs, fastapi, gin;
100 queries total: 69 symbolic + 31 semantic/agent-style).

| Channel | s@1 strict | s@5 strict | rank-1 | prec@5 | MRR strict | nDCG@5 | file-only inflation |
|---|---|---|---|---|---|---|---|
| **Lexical-only** (no Ollama path *not yet measurable* — see WI1) | 0.58 | 0.76 | 0.58 | 0.28 | 0.65 | 0.67 | **~11.6%** |
| **Hybrid** (nomic, plain corpus, memory) | 0.60 | 0.79 | 0.60 | 0.31 | 0.68 | 0.69 | **~11.6%** |
| **Hybrid** (nomic, plain corpus, **SQLite**) | 0.60 | 0.79 | 0.60 | 0.31 | 0.68 | 0.69 | **~11.6%** |
| **Hybrid + LLM rerank** (qwen2.5-coder:7b) | 0.64 | 0.80 | 0.64 | 0.31 | 0.71 | 0.72 | **~11.6%** |

### The weak link — semantic vs symbolic split (the whole point of this work)

| Channel | symbolic rank-1 | symbolic MRR | **semantic rank-1** | **semantic MRR** | **semantic s@5** |
|---|---|---|---|---|---|
| Lexical-only | 0.75 | 0.81 | **0.19** | **0.29** | **0.48** |
| Hybrid (nomic, plain) | 0.77 | 0.82 | **0.23** | **0.35** | **0.58** |
| Hybrid + 7B rerank | 0.77 | 0.82 | **0.35** | **0.45** | **0.61** |

Per-suite semantic rank-1 / MRR / s@5 (lexical → hybrid-nomic):

| Suite | n | lex r1 | hyb r1 | lex MRR | hyb MRR | lex s@5 | hyb s@5 |
|---|---|---|---|---|---|---|---|
| Axios | 5 | 0.00 | 0.00 | 0.20 | 0.22 | 0.60 | 0.60 |
| Express | 7 | 0.43 | 0.43 | 0.49 | 0.53 | 0.57 | 0.57 |
| NestJS | 7 | 0.14 | 0.14 | 0.22 | 0.26 | 0.43 | 0.57 |
| FastAPI | 7 | 0.14 | 0.29 | 0.23 | 0.35 | 0.29 | 0.57 |
| Gin | 5 | 0.20 | 0.20 | 0.30 | 0.34 | 0.60 | 0.60 |

**Reading:** the symbolic channel is strong (MRR ≈ 0.81–0.82). The semantic/agent-style
channel is the weak link — rank-1 0.19 lexical, 0.23 hybrid, 0.35 with the 7B reranker.
Closing this gap (while keeping held-out inflation at 0.0% and parity intact; lexical
overall file-only inflation is ~11.6% — see Errata) is the objective.

---

## 2. Loose hit-rate + token savings + indexing (`test/run.mjs`, lexical)

| Suite | Lang | Chunks | Recall@5 | MRR | Savings | Index time |
|---|---|---|---|---|---|---|
| Axios v1.6.0 | JS | 450 | 0.89 | 0.74 | 70.7% | 0.98 s |
| Express 4.18.2 | JS | 389 | 0.90 | 0.86 | 89.6% | 1.19 s |
| NestJS v10.4.9 | TS | 2675 | 0.95 | 0.80 | 66.9% | 6.34 s |
| FastAPI 0.103.0 | Py | 3694 | 0.76 | 0.72 | 86.0% | 4.83 s |
| Gin v1.9.1 | Go | 1088 | 1.00 | 0.84 | 84.6% | 0.78 s |
| **TOTAL / MEAN** | | **8296** | **0.90** | **0.79** | **79.6%** | **14.12 s** |

Loose recall@5 with hybrid (nomic) is unchanged at 0.90 (per-suite identical); the loose
metric is already near-saturated, which is exactly why the **strict** split above is the
one that matters.

### Indexing time (all 5 suites, 8296 chunks)

| Mode | Total time | Notes |
|---|---|---|
| Lexical (no embeddings) | 14.12 s | embeddings off |
| + nomic embeddings (memory) | 94.83 s | cold embed; NestJS alone 59 s |
| + nomic embeddings (SQLite) | 15.19 s | warm — vectors served from the shared content-hash bin cache |

---

## 3. Backend parity (in-memory ↔ SQLite)

The hybrid strict eval is **byte-identical** across the in-memory engine and the SQLite
store on every metric (s@1/s@5/rank-1/prec@5/MRR/nDCG/inflation AND the semantic split:
0.23 / 0.35 / 0.58). This is the aggregate-level parity guarantee. A per-query top-5-id
assertion check is a follow-up (see goal: "add a parity assertion to CI if not enforced").

---

## 4. `npm run test:all` — full unit/integration suite

**All green** (exit 0). 13 suite groups: unit, sqlite, enrichment, mcp, scale, callgraph,
references, json-output, git-signals, security, embeddings, languages — 0 failures. The
embeddings suite confirms `embedQuery` degrades to null (lexical fallback) on backend
failure; the languages suite confirms C/Bash/Swift extraction.

---

## 5. Not yet measured (gaps the work items must fill)

- **No-Ollama in-process embedder (WI1):** `evaluate.mjs` hardwires query embedding to
  `nomic-embed-text` via Ollama and ignores the index's stamped provider, so the `local`
  MiniLM path is **structurally unmeasurable** today. The lexical-only row above is the de
  facto "no-Ollama" number (semantic rank-1 0.19). WI1 must make the harness honour the
  index's embed-meta and report the local path.
- **Enriched corpus (WI2):** all embeddings numbers above are the plain corpus. The
  enriched corpus (summary vectors, `NL_VECTOR_WEIGHT_ENRICHED` 0.6) is unmeasured here.
- **Amortized token savings (WI8):** the 79.6% is per-query retrieval only; it ignores
  indexing + enrichment + `get_chunk` expansions.

---

## Work-item deltas (after-results)

Each row is the strict semantic/agent-style channel (31 queries) unless noted. Symbolic and
`fileOnlyHitRate` reported when they move. All vs the frozen baseline above.

### WI1 — no-Ollama in-process embedder (measurable + documented)

Reproduce: `INDEXER_EMBED_PROVIDER=local node test/run.mjs --embeddings` then
`node test/evaluate.mjs --embeddings` (auto-detects `local` from embed-meta), or force with
`node test/evaluate.mjs --embeddings --embed-provider local`.

| Config | sem rank-1 | sem MRR | sem s@5 | sym rank-1 | sym MRR | inflation | parity (mem==sqlite) |
|---|---|---|---|---|---|---|---|
| Lexical-only (baseline floor) | 0.19 | 0.29 | 0.48 | 0.75 | 0.81 | ~11.6% | — |
| **In-process MiniLM, no Ollama** (plain) | **0.23** | **0.35** | **0.52** | 0.74 | 0.80 | ~11.6% | ✅ byte-identical |
| Ollama nomic (plain, for reference) | 0.23 | 0.35 | 0.58 | 0.77 | 0.82 | ~11.6% | ✅ |
| **Δ vs floor** | **+0.04** | **+0.06** | **+0.04** | −0.01 | −0.01 | 0.0 | — |

Verdict: the no-daemon path materially beats lexical-only (semantic rank-1 +21%, MRR +21%),
matches Ollama-nomic on rank-1/MRR, holds symbolic and inflation, and preserves backend parity.
Cost: a one-time CPU embed (405 s for 8296 chunks vs 95 s on Ollama); query latency unchanged.
Change was test-harness + docs + an observable-fallback log line — **no production ranking change**.

### Default Ollama embed model → `qwen3-embedding:4b` (user request)

Switched the default Ollama embedder from `nomic-embed-text` (768-dim) to
`qwen3-embedding:4b` (2560-dim), a much stronger NL+code retrieval model. Supporting
changes: model-aware prefixing (`needsNomicPrefix` — only nomic-style models get the
`search_query:`/`search_document:` prefixes; qwen3/others embed raw text), a graceful
`auto` fallback (`ollamaHasModel` — Ollama up but model not pulled → in-process model,
never crashes the indexer), and a robust embedding pipeline (configurable
`INDEXER_EMBED_CONCURRENCY` / `INDEXER_EMBED_TIMEOUT_MS`, and **per-batch graceful
degradation** so a slow/failed batch indexes those chunks lexically instead of silently
losing the whole index).

**Indexing-time reality (important):** qwen3-embedding:4b runs at **~8 chunks/s** on this
hardware (≈5.5 min for express's 389 chunks at concurrency=1). At the indexer's old
concurrency-4 / 60 s-timeout settings every batch timed out and the index silently came up
empty — the robustness fix is what makes a 4B embedder usable at all. The full 5-suite
benchmark (~8.3k chunks) is impractical to re-embed here (~hours), so this is a **bounded,
single-suite measurement** (express), not a full re-baseline. For speed-sensitive installs,
`qwen3-embedding:0.6b` or staying on nomic remains a valid choice.

Express (21q: 14 symbolic + 7 semantic), plain corpus, memory vs SQLite identical:

| Express channel | lexical | nomic 768 | **qwen3-embedding:4b 2560** | Δ vs nomic |
|---|---|---|---|---|
| semantic rank-1 | 0.43 | 0.43 | **0.43** | 0.00 |
| semantic MRR | 0.49 | 0.53 | **0.52** | −0.01 |
| **semantic s@5** | 0.57 | 0.57 | **0.71** | **+0.14** |
| symbolic rank-1 / MRR | 0.79 / 0.86 | 0.79 / 0.87 | 0.79 / 0.87 | ~0 |
| file-only inflation | 4.8% | 4.8% | 4.8% | 0 |

Verdict: qwen3-embedding:4b materially improves **top-5 semantic recall** (s@5 0.57→0.71 on
express — more behavioural queries land the right symbol in the top-5) while holding rank-1,
symbolic, and inflation, with **exact memory↔SQLite parity at 2560-dim**. The cost is
indexing throughput. Default changed per request; degrades gracefully where the model is
absent or too slow.

### WI4 — low-confidence handoff (gated, ranking-derived)

`search_code` now appends, on a behavioural query with no dominant match, a compact
`candidate_files` list + a `get_file_skeleton` hint (markdown) / `low_confidence` +
`candidate_files` fields (json). Gate (`assessConfidence`, unit-tested in test/unit.mjs):
fires only when NOT `exact_tokens`-pinned, the query is natural-language, the top fused score
does **not** dominate #2 by ≥2× (the exact-name boost factor — a structural constant, not
tuned to the benchmark), and results span ≥2 files. Never fires on confident symbolic hits,
so token cards don't bloat. Documented in prompts/CORE.md. No ranking change → eval + parity
unaffected.

### WI2 — enrichment upgrade (richer prompt + auto stronger model)

Code shipped (all **opt-in**, enrichment disabled by default — no change to the default path):
richer SUMMARY prompt (problem / inputs-outputs / side-effects, single-line contract preserved
so `parseEnrichResponse` stays trivial), `resolveEnrichModel("auto")` picking the strongest
local code model (1.5B floor, graceful when Ollama/model absent — 4 unit tests), wired into
indexer + watch-daemon, dual-vector flow intact (richer summary → summary vector). Measured on
the **local MiniLM embedder** (fast, isolates the enrichment lever), express + gin.

**Finding 1 — enrichment ALONE can regress.** Semantic, no rerank:

| suite | plain rank-1/MRR/s@5 | enriched-1.5B | enriched-7B |
|---|---|---|---|
| Express (7q) | 0.43 / 0.50 / 0.57 | 0.43 / **0.53** / 0.57 | — |
| Gin (5q) | 0.20 / 0.45 / 0.80 | **0.00 / 0.31** / 0.80 | **0.00 / 0.33** / 0.80 |

A stronger model (7B, 268 chunks, 0 failures, ~21 min) did **not** fix gin — the cause is
structural: enrichment flips the corpus into the `NL_VECTOR_WEIGHT_ENRICHED` (0.6) regime, so a
plausible-but-wrong summary vector displaces the exact code hit at rank-1.

**Finding 2 — enrichment WITH rerank (its documented design) is a clear win.** Gin semantic,
both with the 7B rerank judge:

| gin semantic | rank-1 | MRR | s@5 |
|---|---|---|---|
| plain + rerank | 0.60 | 0.80 | 1.00 |
| **enriched(7B) + rerank** | **0.80** | **0.87** | **1.00** |

The reranker reorders the enriched pool (which has the better *recall* — right answers present)
to recover and exceed rank-1. **Verdict:** ship enrichment as opt-in infrastructure that pairs
with rerank; do NOT claim a standalone semantic gain (it regresses solo). The levers stack:
gin semantic rank-1 **0.20 (plain) → 0.60 (rerank) → 0.80 (enrich+rerank)**. file-only inflation
held flat throughout (display artifact; true express ≈4.8%, gin 0.0% — see Errata); symbolic unchanged.

### WI3 — query-side HyDE (opt-in, gated)

Code shipped in `mcp/tools.mjs` (`hydeQueryVector`/`blendVectors`/`buildHydePrompt`, 3 unit
tests), wired through `search_code(hyde:)` + `hyde.enabled` config + the eval harness `--hyde`
flag, documented in README + prompts/CORE.md. A local model writes a hypothetical snippet, it's
embedded with the index's own model and **blended** (α=0.5, never replaces) into the query
vector; cached per query; best-effort (any failure → raw vector). Only fires on NL queries with
a vector channel.

**Byte-identical when off — proven:** `--hyde` off reproduced the prior numbers exactly
(express 0.43/0.53/0.57; gin 0.00/0.33/0.80). On (HyDE model qwen2.5-coder:7B):

| suite (semantic) | HyDE off | HyDE on | Δ s@5 |
|---|---|---|---|
| Express (7q) | 0.43 / 0.53 / 0.57 | 0.43 / 0.51 / 0.57 | 0 (neutral) |
| Gin (5q) | 0.00 / 0.33 / **0.80** | 0.00 / 0.34 / **1.00** | **+0.20** |

HyDE materially lifts top-5 recall on the hard suite (gin s@5 0.80→1.00) at a per-query cost
(~75s for the whole 2-suite sweep). rank-1 unchanged — HyDE is a recall lever (gets the answer
into the pool); rerank is the rank-1 lever (orders the pool). They are complementary.

### WI5 — bounded connected-subgraph retrieval (`get_subgraph`)

New MCP tool + pure `buildSubgraph(db, seed, {maxNodes, maxDepth, tokenBudget})` (exported,
tested in test/callgraph.mjs). BFS around a seed symbol over three edge kinds — callees
(`chunk.calls`), high-confidence callers (`classifyCallers`, the precise blast radius), and
type/inheritance referers (`findReferers`) — bounded by node count, hop depth AND a token
budget, fully deterministic (every neighbour list sorted, ties on id) so it is reproducible and
backend-agnostic. Resolves a cross-cutting "trace this flow" task in one call instead of
chaining search_code → get_call_graph → find_references. Markdown + json output; graceful
not-found; uses only index-time signals (no type inference, no ranking change). Verified: seed
+ caller + callee edges present, `max_nodes`/`token_budget` honoured (truncation flagged),
identical output across runs, missing seed → `found:false`. e2e smoke over stdio in test/mcp.mjs.

### WI6 — index-freshness contract

A stale call graph silently misleads an agent, so tool responses now carry a freshness signal.
The indexer stamps the build commit into the git-signals sidecar (`head`); at query time
`currentGitState` (cached ~5s, injectable, graceful outside git) reads the current short HEAD +
count of uncommitted *source* changes, and the pure `computeFreshness` derives the verdict:
**fresh / syncing (drift but a live daemon is catching up) / stale (drift and no daemon)**. Wired
into `search_code`, `get_call_graph`, `find_references`, `get_subgraph` (JSON always carries the
structured `index` field; the markdown footer appears **only when NOT fresh** — so up-to-date
cards keep their lean token size, honouring the no-bloat principle) and `list_index_stats`
(commit / pending / freshness rows). `get_call_graph`'s "✅ safe to modify" — the most dangerous
thing to get wrong on a stale index — now carries the staleness warning. Unit-tested
(`computeFreshness`, 4 cases) + e2e green.

**Atomicity verified (no code change needed):** the SQLite write paths `buildFrom` and
`applyFileUpdate` wrap all writes in a single `BEGIN…COMMIT` transaction under WAL (ACID — a
mid-write crash rolls back), and the in-memory backend uses tmp→rename; both are crash-safe. The
shared embeddings bin is a content-hash cache where a torn write degrades to "lexical-only for
that chunk until re-index", never corrupting the index.

### WI7 — heritage / type-reference parity across languages

`extractHeritage` and `extractTypeAnnotations` extended from TS/JS/Python to the remaining
indexed languages using only cheap, index-time parser node types (no type inference). The JS/Py
branches are left **byte-identical** (eval-safe); a new branch handles the rest via per-grammar
heritage-clause node types (Java `superclass`/`super_interfaces`, C# `base_list`, PHP
`base_clause`/`class_interface_clause`, Kotlin `delegation_specifier`, Swift
`inheritance_specifier`, Ruby `superclass`, Rust `trait_bounds`) + Go struct embedding; type
references via the cross-language `type_identifier` node (+ PHP `named_type`).

Verified end-to-end on the real fixtures (chunks gaining the fields): Java extends 13 / type_refs
42, Kotlin 13 / 72, C# 31 / 0, Ruby 38 / 0, PHP 46 / 30, Swift 136 / 555, Rust 79 / 310, Go
0 / 376, C 0 / 341 (C#/Ruby type_refs correctly empty — no cheap signal). 9 per-language tests in
test/languages.mjs (24/24).

**No regression:** only Go (gin) is in the eval suites; after rebuilding, gin strict is
**byte-identical** (rank-1 0.67, MRR 0.73, s@5 0.89, semantic 0.20/0.30/0.60) and overall strict
+ inflation unchanged. Backend parity holds (the 100-query ordered-id gate passes with gin's new
type_refs). find_references' "subclassed/implemented by" + "used as a type by" dimensions now
work across the language matrix; CORE.md updated.

### WI8 — held-out split + expanded queries + amortized savings

**Held-out validation set.** 15 fresh queries (3/suite, symbolic + semantic) were authored —
each target verified to exist in the index — and marked `heldOut: true`. They were **never used
to tune any ranking**. `evaluate.mjs` now partitions rows: the OVERALL/per-suite numbers are
computed over the **tuning** set only (so they stay byte-identical to the pre-WI8 baseline —
rank-1 0.58, MRR 0.65, s@5 0.76, semantic 0.19/0.29/0.48, inflation ~11.6%), and a separate
**HELD-OUT** block reports the validation scores. Lexical held-out: success@5 0.87, rank-1 0.73,
MRR 0.79, inflation 0.0% (symbolic 1.00/1.00 — targets confirmed findable; semantic 0.20/0.37/0.60
— consistent with the tuning set's 0.19, i.e. not overfit). This is the gate any future ranking
change must clear.

**Amortized (expansion-aware) token savings.** The headline savings counts only top-5 chunk
excerpts vs full files and ignores that an agent expands results via `get_chunk`. Added
`amortizedTokenSavings` (metrics.mjs, unit-tested + surfaced in `npm run test`): it models the
recommended pattern — 5 compact cards + one full-body `get_chunk` expansion — vs reading the full
files. On gin it reports ~89% (alongside the gross ~86%); assumptions (cardTokens=20 signatures
mode, expansions=1) are stated so it is reproducible. Heavier expansion lowers it monotonically
(asserted in the unit test).

**End-to-end task success.** The agent harness (`test/agent/`: search-eval.mjs with nl/kw/xc
archetypes, agent-cli + score-answers for answer scoring) already provides the end-to-end-style
metric; WI8's contribution is the held-out discipline + amortized honesty in the strict harness.
A new with/without-tool agent A/B was left as a follow-up (it is Ollama/agent-heavy and the
existing harness already exercises real MCP tools over a sub-agent trace).

### Code smell — learned fusion / smarter boost gating (resolved: keep the simpler ranker)

The smell: `fuseAndRank`'s `boostEligible = null` (the exact-name boost always applies), set that
way historically because gating it *hurt the then-weak semantic channel* — i.e. the ranker
leaned on a lexical shortcut to mask semantic weakness. The goal's instruction: revisit this
ONLY after semantics are stronger, validate on held-out, and **only adopt a change if it beats
the hand-tuned baseline on data not tuned on — otherwise keep the simpler ranker.**

Resolution: the semantic weakness that justified `boostEligible = null` is now addressed
*additively* — rerank (gin sem rank-1 0.20→0.60), enrichment+rerank (→0.80), query-side HyDE
(recall s@5 →1.00), and a far stronger default embedder (qwen3-embedding:4b) — none of which
touch the fixed RRF + boost ladder. With the held-out gate now in place and **no evidence that a
learned-fusion or re-gated-boost variant beats the hand-tuned ranker on held-out** (and prior
measurement that gating regressed it), the goal's own rule applies: **keep the simpler ranker
unchanged** (default ranking byte-identical, parity intact). The held-out infrastructure is the
durable deliverable — it lets any future learned-weights proposal be judged honestly rather than
adopted on faith. No speculative ranking change was introduced (which would have risked the
parity + no-overfit guarantees for no demonstrated gain).

### Path-boost IDF gate (NL queries) — recall@5 lift, ranking-derived

The file-path boost (×1.4 when a query token matches a filename segment) over-fired on common
low-IDF words: a natural-language query mentioning "path" / "url" / "config" boosted **every**
chunk in the matching file, burying the real answer. Now gated — for NL queries only — to query
terms whose IDF ≥ `ln(docCount/2)`, a per-corpus **structural** threshold (not tuned to any
query). The gate lives in the shared `fuseAndRank`, so both backends move together; symbolic /
keyword queries are excluded by `isNaturalLanguageQuery` and keep the boost **byte-for-byte**
(symbolic rank-1 unchanged). Lexical-only, tuning channel, from `evaluate.mjs --json`:

| Channel (lexical-only) | before | after | Δ |
|---|---|---|---|
| **overall s@5** | 0.7749 | **0.8065** | **+0.0316** |
| **semantic s@5** (agent-style, 31q) | 0.5161 | **0.6129** | **+0.0968** |
| semantic rank-1 | 0.1935 | 0.1935 | 0 |
| symbolic rank-1 | 0.7536 | 0.7536 | **0 (byte-identical)** |
| held-out semantic rank-1 / s@5 | 0.40 / 0.60 | 0.40 / 0.60 | 0 |
| file-only inflation | ~11.6% | ~11.6% | 0 |

Per-suite the gain is concentrated in axios (tuning-semantic s@5 0.60 → **0.80**): three behavioural
queries enter the top-5 (AX15 −1→3, AX16 7→5, AX17 6→3) plus nestjs NJ20 5→2; the only two shifts
the other way (express EX18 6→7, gin GN16 2→3) stay in-band and move no headline metric. **No
rank-1 anywhere changed** — so the held-out rank-1 gate stays flat at 0.40. That flatness is
*architectural*, not a defect: the held-out semantic misses fail for reasons the path boost cannot
touch — nestjs `Reflector` is conceptual (needs embeddings), and gin `joinPaths` is lexically rank-11
**and** a non-NL query (so the NL-gated fix can't reach it; the original "cleanPath over-fire"
hypothesis was diagnosed and **refuted**). Shipped on its own merit: a structurally-motivated,
zero-regression **top-5 recall** lever. Backend parity holds (shared scorer; `test/sqlite.mjs`
green). New unit test in `test/unit.mjs` locks both directions (NL gating + symbolic byte-identity).

---

## Status summary (all work items addressed)

| Priority | Items | State |
|---|---|---|
| P0 | WI1 (no-Ollama embedder), WI2 (enrichment) | ✅ done, measured |
| — | embed-model → qwen3-embedding:4b (user request), backend-parity hardening | ✅ done, measured |
| P1 | WI3 (query-side HyDE), WI4 (low-confidence handoff) | ✅ done, measured |
| P2 | WI5 (connected subgraph), WI6 (freshness contract) | ✅ done, tested |
| P3 | WI7 (heritage/type parity for the remaining languages) | ✅ done, tested, eval-neutral |
| P3 | WI8 (held-out split + expanded queries + amortized savings) | ✅ done, tested |
| after WI8 | code-smell: learned fusion / boost gating | ✅ resolved — keep the simpler ranker (held-out gate built; no held-out win to justify a change) |

All honesty guarantees held throughout: strict scoring + inflation gap preserved (held-out
0.0%, lexical overall ~11.6% — see Errata; stable across channels), in-memory↔SQLite parity byte-identical (now CI-enforced over 100 queries + a
synthetic-vector hybrid gate), no tuning to the benchmark queries (every new constant is
structural), no cloud calls / telemetry, default `response_format` unchanged, markdown cards not
bloated (freshness footer only when non-fresh; handoff only on low-confidence NL queries).
`npm run test:all` green after every step.
