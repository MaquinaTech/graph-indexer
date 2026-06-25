# Graph Indexer — Competitive Analysis & Roadmap to Best-in-Class

> **Status:** Forward-looking strategy document (2026-06-25, against v2.1.0). The **Roadmap**
> initiatives below are *proposals, not shipped features* — nothing here changes the current
> product. It complements the factual docs (README, CHANGELOG, `docs/internals/`) by setting
> direction. Every roadmap item is designed to preserve the four non-negotiable invariants:
> **lexical/local/zero-dependency default · memory↔SQLite parity · no default-path regression ·
> honest, reproducible metrics.**
>
> Sources: a 13-agent competitive scan of the code-intelligence & agent-context field
> (Sourcegraph, GitHub, Cursor, Aider, Continue.dev, Tabby, Kythe/Glean, Serena, Zilliz
> claude-context, Probe, ripgrep/ast-grep/Zoekt, the LSP/SCIP/stack-graphs lineage) cross-checked
> against graph-indexer's own source.

---

## 1. Executive summary

graph-indexer (v2.1.0, **16 MCP tools**) is already **the broadest single-process, air-gapped
code-intelligence substrate for AI agents that exists**. It fuses ranked lexical (+ optional dense)
retrieval, a confidence-tiered call graph, symbol-level `find_references` with opt-in SCIP
precision, route→handler mapping, blast-radius `impact_of_edit`, `tests_for`, and a taint finder
into **one MCP surface**, over **parity-enforced** memory/SQLite backends, with an honest, strict
benchmark culture baked into the artifact.

No competitor matches that combination locally:

- **Serena** has compiler-precise references + edits, but **no ranked search** and no persistent index.
- **Zilliz claude-context / octocode** have strong semantic recall, but only ~4 tools and a cloud-recommended path.
- **Sourcegraph / GitHub / Kythe / Glean** have compiler-grade precision and planet scale, but require a server/cluster and are **not air-gapped**.
- **ripgrep / ast-grep** are always-fresh and zero-setup, but carry **no meaning and no relationships**.

But graph-indexer is **not #1 today on the two axes that most decide whether an agent succeeds at a
real task**:

1. **Semantic recall** — measured semantic rank-1 **0.19** lexical / **0.23** nomic-hybrid / **0.35**
   with a 7B reranker (`docs/benchmarks/BENCH_BASELINE.md`). The dense channel uses **general-purpose**
   text embedders (MiniLM, `nomic-embed-text`), not code-specialized models — exactly where the field
   has moved (CodeRankEmbed 60.1 CoIR, SFR-2B 67.4, Cursor's agent-trace embedder +12.5% QA, GitHub
   +37.6% retrieval).
2. **Reference / call-graph precision** — heuristic and **name-only** for Go/Rust/Kotlin/Ruby/Bash/C,
   class-granular for Java, where LSP / stack-graphs / SCIP are scope- and shadow-correct.

The path to #1 is **not** to abandon the sacred default or chase cloud incumbents' scale. It is a
small set of **additive, opt-in, parity-safe** moves that close exactly those two gaps using seams
that already exist in the code.

---

## 2. Positioning — the niche graph-indexer should own

> **"The precision of stack-graphs, the recall of a code embedder, and the breadth of a code-intel
> platform — in one offline `npx`, byte-identical and attestable."**

graph-indexer should own **"the complete, air-gapped, agent-native code-intelligence substrate"** —
the one local MCP server that:

- answers ranked **discovery** search **and** structural/relationship queries **and**
  blast-radius/route/taint questions in a single process;
- is **provably** zero-egress and attestable (`seal.mjs`);
- installs onto **8+ agents** in one command.

It should explicitly **not** try to be Sourcegraph (planet-scale cross-repo governance), **not** a
chat product (Tabby/Continue/Cody ship a model + UI), and **not** a pure semantic RAG
(Zilliz/Bloop). Its defensible center is the **intersection** three competitors each hold only one
corner of:

| Competitor | Corner it owns | What it lacks |
|---|---|---|
| Serena | precision-without-ranking | no ranked search, no persistent index |
| Zilliz claude-context | semantic-without-graph | no relationships, cloud-leaning |
| Probe | local-without-intelligence | no graph, no ranking |
| **graph-indexer** | **all three corners, locally** | recall + precision *depth* (closeable) |

**Sharpest wedge:** regulated / offline / privacy-first teams (finance, defense, healthcare,
on-prem) for whom Cursor/GitHub/Sourcegraph's cloud-embedding round-trip is a hard non-starter —
**and** the mass of agent users who want one MCP server that "just works" on an unfamiliar repo
without standing up Milvus, a language-server farm, or a Sourcegraph instance.

---

## 3. The landscape — six camps, three axes

The field separates along two decisive axes — **precision** (heuristic → compiler-exact) and
**locality/footprint** (zero-dep-offline → cloud-cluster) — with a cross-cutting third axis of
**capability breadth** (single-mode → full code-intel).

1. **Compiler-grade precision platforms** — Sourcegraph (SCIP + Zoekt + Deep Search), GitHub
   (Blackbird + stack-graphs + Copilot embeddings), Kythe/Glean. Exact and planet-scale, but
   server/cluster-shaped, build-coupled, not air-gapped.
2. **LSP-symbol MCP servers** — Serena. Compiler-exact references + symbolic **editing** over 30+
   languages, local — but a stateful live server, no ranked search, no persistent index.
3. **Semantic / vector RAG** — Zilliz claude-context, octocode, Bloop, plus the code-embedder model
   layer (CodeRankEmbed / SFR / Voyage / jina). Strong recall, cloud-leaning, snippet-only (no graph).
4. **Zero-index lexical/structural baseline** — ripgrep, ast-grep, Zoekt, Probe, repomix. Perfectly
   fresh, zero-setup, but no meaning / relationships.
5. **Repo-map context selectors** — Aider. Task-aware PageRank auto-context, but a file-node
   name-only graph, no query API, welded to one CLI.
6. **Full assistants** — Tabby, Continue, Cody. Ship model + UI, but shallow code-intel.

**Strategic insight:** every camp is strong on **one** axis and concedes the others. graph-indexer
is the only artifact sitting at the **center of all three** (local + broad + opportunistically
precise). And the **2026 LSP-over-MCP wave** (Serena, mcpls, agent-lsp, Copilot-CLI/Codex-CLI adding
LSP) is converging on graph-indexer's exact transport — meaning the precision camp is now coming to
fight **on graph-indexer's home turf (MCP)**, which makes the precision gap the most *time-sensitive*
front.

---

## 4. Head-to-head — where graph-indexer wins and loses

| Competitor | Deployment | graph-indexer **wins** | graph-indexer **loses** |
|---|---|---|---|
| **Sourcegraph** | proprietary, self-host/cloud cluster | zero-dep air-gapped single process; open & free; time-to-first-value | cross-repo & into-dependency moniker nav; planet scale |
| **GitHub (Blackbird + stack-graphs + Copilot)** | cloud, proprietary | 100% local/air-gapped; agent-agnostic MCP | stack-graphs scope/shadow-correct precision; Blackbird scale (45M repos) |
| **Cursor** | cloud index (Turbopuffer), proprietary | true air-gap (Cursor embeds server-side even in privacy mode); portable over MCP | org-scale index + cross-user cache; agent-trace-trained embedder recall |
| **Aider repo map** | local, CLI-coupled | MCP-native, 16 queryable tools; consumable by 8+ agents | **zero-query** PageRank auto-context; live task-aware personalization |
| **Continue.dev** | local-first client app | structural code-intel (call graph/refs/routes/taint); AST-symbol granularity | complete product (IDE/CLI/chat); embeddings on by default → recall OOTB |
| **Tabby** | self-hosted, on-prem | deep queryable code-intel; MCP-pluggable into any agent | finished product (completion + chat + Answer Engine + UI) |
| **Kythe / Glean** | open-source, cluster/CI-batch | zero-build on any/broken/polyglot repo; laptop-local | compiler-resolved exact refs; **cross-language** xrefs |
| **LSP / SCIP / stack-graphs** | mostly local, server/build per language | ranked **discovery** search (the lineage is position-nav only); no per-language server/build | exact same-name/overload/generic/dispatch resolution; rename-safe refactor |
| **Semantic/vector RAG (Bloop, Zilliz, code embedders)** | mixed, cloud-leaning | code-intel depth; true air-gap default | **dense retrieval quality** (code-specialized SOTA); no code embedder option today |
| **ripgrep / ast-grep / Zoekt** | local, zero-index | ranked token-bounded results; relationships in one call | **freshness** (always-live); zero cold-start cost |
| **MCP servers (Serena, Probe, octocode, repomix)** | mixed | breadth in one local index; air-gapped default + sealed mode | Serena's LSP-exact refs + edits; Zilliz/octocode semantic recall OOTB |

**The two losses repeat in every row:** *semantic recall* and *reference precision*. Everything else
graph-indexer already wins or ties.

---

## 5. graph-indexer's moat (genuine, defensible)

1. **Breadth-in-one-local-process** — 16 MCP tools spanning ranked search + call graph +
   receiver-aware callers + `find_references` (callers/inheritance/type_refs/SCIP) + `find_routes` +
   `impact_of_edit` + `tests_for` + `trace_taint` + `get_repo_map`, in a single zero-egress server.
   No competitor covers this surface locally.
2. **Enforceable + attestable air-gap** (`seal.mjs`) — fail-closed config validation, a deny-by-default
   in-process egress guard (net/tls/http(s)/fetch), and a deterministic **signed** attestation
   manifest. Every other "local" tool is no-network-*by-convention*; this is no-network-*by-proof* —
   the only entry defensible to a regulated/classified buyer.
3. **Parity-by-construction dual backend** — memory and SQLite both call the single shared
   `fuseAndRank`, gated to **byte-identical top-5** by `test/sqlite.mjs`, auto-promoting to SQLite at
   15k chunks. The *same* index scales laptop → 100k+ chunks with no external DB.
4. **Honest-metrics culture shipped *in* the artifact** — strict exact-symbol scoring, held-out
   splits never used to tune, per-feature trade-offs printed at startup, and documented **negative
   results** (learned-sparse / BM25F / AST net-neutral; enrichment regresses alone; rerank taxes JS).
   A trust differentiator vs unreproducible cloud metrics.
5. **Zero-third-party-runtime-dependency default path** — embedders, grammars, HNSW are all
   *optional* and degrade gracefully; it runs lexical search on a broken/polyglot repo that
   compiler-coupled tools (Kythe/Glean/scip-*) cannot index at all.
6. **Graceful-degradation confidence tiering** — works everywhere at name-only/heuristic and
   *opportunistically* promotes to SCIP-precise where a `.scip` exists, with **sound suppression**
   under partial coverage. Best-effort-that-labels-its-confidence beats all-or-nothing for an
   autonomous agent.
7. **Turnkey multi-agent onboarding** (`init.mjs`) — one `npx` detects the stack and writes
   per-language/framework prompt playbooks into 8+ agents' native rule files plus a GUI-host-safe MCP
   entry. The broadest auto-wiring in the cohort.

---

## 6. The honest gaps (severity-ranked)

| # | Severity | Gap | Who does it better |
|---|---|---|---|
| 1 | **critical** | Semantic recall weak on default **and** opt-in paths; dense channel is a *general* text embedder, not code-specialized | Cursor, GitHub Copilot, Zilliz (voyage-code-3), CodeRankEmbed/SFR/jina-code |
| 2 | **critical** | Reference/call precision heuristic & language-tiered (name-only 6 langs, class-granular Java); precise resolver can't refute a shadowing local | stack-graphs, LSP (rust-analyzer/gopls/pyright), SCIP, Kythe/Glean, Serena |
| 3 | **high** | No cross-repo / into-dependency resolution; graph stops at the repo boundary | Sourcegraph monikers, GitHub, Kythe/Glean, octocode |
| 4 | **high** | SCIP precision down-sampled to the containing chunk (file:line:col discarded) | SCIP/LSP consumers, Serena, stack-graphs |
| 5 | **high** | No symbolic **edit** capability (read-only; `impact_of_edit` analyzes, doesn't mutate) | Serena (rename/replace_symbol_body/safe_delete via LSP) |
| 6 | **high** | Freshness/staleness vs grep — index can drift between daemon cycles | ripgrep/ast-grep (always-live), stack-graphs (file-incremental), Glean, Cursor |
| 7 | medium | No exact substring/regex primitive — agents escalate *to* it, not *from* it | ripgrep (SIMD DFA), Zoekt (trigram), ast-grep |
| 8 | medium | No content-hash embedding cache → re-embed cost blocks dense-by-default | Cursor, Tabby, Zilliz (Merkle incremental) |
| 9 | medium | No composable structural-query primitive (one verb per question) | Meta Glean (Angle Datalog) |
| 10 | medium | No zero-query / personalized whole-repo overview mode | Aider (PageRank-personalized token-fit auto-context) |

---

## 7. Roadmap to #1 (ranked, every item invariant-safe)

> Ordering reflects **impact × architectural alignment × time-sensitivity**. Each item is **opt-in**,
> leaves the lexical/local/zero-dep default **byte-identical**, and preserves memory↔SQLite parity.
> Per honest-metrics discipline, a new capability moves the **default** only on strict, held-out,
> reproducible proof.

### Tier 1 — close the two task-deciding gaps (do now)

1. **Local code-specialized embedder as a first-class dense provider** *(semantic-recall · M ·
   transformational)*. Add CodeRankEmbed (137M, MIT) and/or jina-code-embeddings (GGUF) behind the
   existing `createEmbedder()` / `resolveEmbedProvider()` seam, with **asymmetric NL2Code/Code2Code
   instruction prefixes** (the `needsNomicPrefix` asymmetry already proves the prefix plumbing
   exists). Closes the #1 measured weakness while staying fully offline. *Risk:* laptop RAM/latency —
   ship opt-in, measure on strict held-out before touching any default.
2. **Stack-graphs name-resolution tier** *(precision · L · high)*. Add `tree-sitter-stack-graphs` as a
   **third resolver provider** between `heuristic` and `scip`, upgrading the existing
   `find_references` / `get_call_graph` to scope/shadow-aware precision **without a build step or
   compiler**. Uniquely matches the no-build ethos; file-incremental (daemon-friendly); answers the
   LSP-over-MCP wave on home turf. *Time-sensitive.* Start with JS/TS/Python/Java where TSG rules are
   mature; label confidence as a distinct tier.
3. **Staleness-honest grep fast-path** *(developer-experience · M · high)*. Return index age +
   dirty-file count on `search_code` / `list_index_stats`; on a miss for a token that exists in live
   files, transparently fall back to (or hint) a live scan; expose a thin exact/literal/regex
   line-search tool over live files. Neutralizes grep's single structural moat (freshness) and makes
   graph-indexer the **single MCP entry point** agents never escalate out of.

### Tier 2 — deepen precision & make dense cheap (next)

4. **Preserve SCIP occurrence-precision** *(precision · M · high)*. Keep each occurrence's
   file:line:col (the `.scip` is already parsed) instead of down-sampling to the containing chunk —
   closes a chunk of the LSP precision gap **for free** and gives agents exact, edit-safe positions.
5. **Content-hash–keyed embedding cache + Merkle change detection** *(scale · M · high)*. Persist
   embeddings keyed by `chunk content hash + model id` across re-index runs/branches; Merkle-diff the
   daemon's re-embed path. Removes the dominant cost gating dense-by-default and fixes the documented
   fs.watch drift.
6. **Cross-repo / into-dependency resolution via SCIP-style monikers** *(precision · L · high)*.
   Resolve references into locally-present dependency sources (`node_modules`/`site-packages`/vendored)
   and a lightweight **multi-index federation** mode (one server, several local indexes, merged +
   ranked). The biggest "graph" gap and the thing the product name promises — all reads local, air-gap
   intact.
7. **Agent-trace-supervised reranker/embedder distillation** *(semantic-recall · L · high)*. Mine the
   `test/agent` benchmark traces (which chunk *should* have been retrieved) to distill the local
   reranker — Cursor's retrieval-in-hindsight method, on data graph-indexer **already generates** and
   competitors can't replicate. Validate on held-out splits; ship opt-in.

### Tier 3 — breadth & expressiveness (then)

8. **Optional symbolic edit tools** (`replace_symbol_body`, `insert_after_symbol`, `safe_delete`)
   gated behind the precise AST chunk spans graph-indexer already computes — turns a read-only
   substrate into read/write (the main reason agents pick Serena). Scope as **span edits**, not
   semantic refactors, until a precise resolver backs cross-ref-aware edits.
9. **Token-budgeted, PageRank-personalized auto-context** on `get_repo_map` — accept a `focus` set
   (the agent's edit set) that biases the existing symbol PageRank, with Aider-style binary-search
   token-fit. Wires existing parts (symbol centrality + skeleton rendering) into Aider's killer feature,
   over MCP, *without* embeddings.
10. **Bounded composable structural-query tool** — a constrained Datalog/Angle-lite over the existing
    symbol graph (chunks as predicates; calls/refs/extends/type_refs as relations) so agents ask ad-hoc
    relational/transitive questions without a new bespoke verb each time. Glean's lesson, bounded by
    `maxNodes`/`maxDepth` like `get_subgraph`.
11. **Materialize reverse edges + a dedicated symbol-search channel** at index time (rides
    `--symbol-graph`) — O(result-set) reverse lookups regardless of repo size; both backends build
    identically (parity preserved).

---

## 8. North star — what "#1" concretely means

An autonomous coding agent, dropped into **any** repo (polyglot, half-broken, offline, regulated),
gets — in one local MCP server, with zero cloud round-trip and a signable attestation:

- **(a) Discovery** ranked search that bridges vocabulary gaps as well as a code-specialized embedder
  — *target: semantic rank-1 ≥ 0.55 held-out, success@5 ≥ 0.85 across languages.*
- **(b) Relationship** answers (callers/callees/references/definitions) that are scope- and
  shadow-correct and occurrence-precise — **without requiring a build**.
- **(c) Higher-order** intel to act safely — blast-radius, routes, tests-for, taint, ownership.
- **(d) Freshness it can trust** — the substrate tells the agent when it's stale and self-heals on
  just-written code.
- …all reproducible under a strict, honest benchmark the user can re-run.

**The 3–5 defining bets:**

1. **Local code-specialized recall** — own the best *offline* semantic recall (bundled code embedder +
   agent-trace-distilled reranker). The one axis that decides agent success and the one cloud
   incumbents think requires their servers.
2. **No-build precision** — own compiler-*close* reference/call precision via a stack-graphs tier that
   needs no compiler. The unique intersection of "precise" and "works on any repo offline."
3. **Attestable air-gap as a product**, not a footnote — make `seal.mjs` the reason regulated/offline
   teams standardize on graph-indexer where Cursor/GitHub/Sourcegraph structurally cannot follow.
4. **Breadth-in-one-process with freshness trust** — the single MCP entry point agents never escalate
   out of, by owning the cheap exact/regex layer *and* the staleness contract grep wins on.
5. **Honest, reproducible trust** — keep strict held-out benchmarking and per-feature trade-off
   disclosure as a *marketed* differentiator against opaque cloud metrics.

---

## 9. Honest verdict — the real distance to #1

graph-indexer is genuinely **the most complete local code-intelligence substrate that exists**, and
on its strong axes — breadth-in-one-process, attestable air-gap, parity discipline, honest metrics,
symbolic/exact retrieval (rank-1 ~0.75, MRR ~0.81) — it is **already at or near #1**, with no
competitor matching the combination.

"Best in *every* sense" it is not yet, and the distance is concentrated in exactly the two axes that
most determine whether an agent succeeds at a real task: **semantic recall** (general-purpose
embedder; rank-1 0.19/0.23/0.35) and **reference precision** (heuristic, name-only for 6 languages,
class-granular Java). The encouraging truth is that **none of the fixes require abandoning the sacred
default or chasing the incumbents' scale** — the highest-leverage moves (a local code embedder behind
the existing `createEmbedder` seam; a stack-graphs tier isolated like the SCIP tier; preserving the
occurrence-precision already parsed; a staleness-honest grep fast-path; mining agent traces already
generated) are all **additive, opt-in, parity-safe, and architecturally aligned** with what's shipped.

**Realistic distance:** roughly **two well-scoped releases** from undisputed #1 for offline/regulated
agent work *today*, and **~3–4 releases** (initiatives 1–7) from being the best general-purpose agent
substrate measured by task success — *provided* honest-metrics discipline holds and the default moves
only on strict, held-out, reproducible proof.

**Biggest strategic risk is not a competitor but drift:** the 2026 LSP-over-MCP wave is bringing the
precision camp onto graph-indexer's transport, so the **precision tier (initiative 2) is
time-sensitive**. Move on recall and no-build precision now, keep the air-gap attestable and the
metrics honest, and **#1 in the defensible center is within reach.**
