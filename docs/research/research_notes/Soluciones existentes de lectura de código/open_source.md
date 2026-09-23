# Open-source code intelligence, code reading and token-saving tools for coding agents (2025 – September 2026)

Method and scope notes. All observations are dated 2026-09-23. Star counts come from the GitHub search API (via the GitHub MCP connector). "Commits since 06-23" means commits on the default branch since 2026-06-23, counted from a `git clone --shallow-since=2026-06-23` made on 2026-09-23. Latest tags come from the same clone. Licences come from each repo's LICENSE file. Tool lists and design facts come from the README and source of shallow clones kept in the session scratchpad. The proxy blocked raw.githubusercontent.com, Hugging Face, arXiv, go.dev, jetbrains.com, quesma.com, HN and Reddit, and the shared web-search budget ran out part-way through. Figures from those sites therefore come from search-result snippets or from quotations inside GitHub repos, and are marked that way. Facts already established in `Indexación de código para agentes IA.md` and `reports/Impacto real de indexación en agentes.md` are not repeated. That covers LocAgent and SWE-agent ablations, the claude-context evaluation, codebase-memory-mcp #1382/#2265, Serena #1470/#1491/#1845, the basic hook designs of GitNexus and codebase-memory-mcp, the Semble benchmark, the potion-code licence and the zvec-grep port, the stack-graphs archival, and the gaps in tags.scm coverage. These notes only add updates and corrections to them.

## 1. Code-intelligence MCP servers and CLIs for agents: what they do, how, maturity, licence, measured effects, failure modes, verdict

### Takeaway
By September 2026 the category is dominated by projects created in 2026 with very high star counts: graphify (~121k), codegraph (~72k), codebase-memory-mcp (~44k) and code-review-graph (~32k), alongside the older GitNexus (~47.5k) and Serena (~30k). They all follow one recipe: a tree-sitter parse, a symbol/call/import graph in an embedded store, one or a few MCP tools, plus agent hooks and skills. They differ mainly in storage, licence and how honestly they measure. The closest architectural twin of graph-indexer is **codegraph**: MIT, Node, `node:sqlite`, WASM grammars and a single MCP tool. The most candid measurements come from small projects (trace-mcp, repowise). Their results show quality at parity at best, big token savings, and tool adoption collapsing under Claude Code's deferred MCP loading. Several popular projects cannot be reused by an MIT project: GitNexus (PolyForm Noncommercial), jCodeMunch (non-commercial), sdl-mcp (personal-use), repowise and SocratiCode (AGPL), Sourcebot (FSL) and Serena v2 (GPL; only SolidLSP stays MIT).

### Cited Findings

#### Maturity and licence snapshot (observed 2026-09-23)

Graph and index servers (★ from the GitHub search API; activity from shallow clones):

| Project | ★ | Created | Last commit | Commits since 06-23 | Latest tag | Licence | Runtime / store |
|---|---|---|---|---|---|---|---|
| [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) | 120,825 | 2026-04-03 | 2026-09-22 | 1,080 | v0.9.66 (09-22) | Apache-2.0; pre-relicensing contributions stay MIT ([NOTICE](https://github.com/Graphify-Labs/graphify/blob/v8/NOTICE)) | Python, tree-sitter, Leiden |
| [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) | 71,922 | 2026-01-18 | 2026-09-16 | 488 | v1.6.0 (08-26) | MIT | Node + `node:sqlite` + WASM grammars, optional native Rust kernel |
| [abhigyanpatwari/GitNexus](https://github.com/abhigyanpatwari/GitNexus) | 47,542 | 2025-08-02 | 2026-09-23 | 800 (plus hundreds of `rc/*` tags) | package 1.6.12 | **PolyForm Noncommercial 1.0.0** ([LICENSE](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE)) | Node, native `tree-sitter`, `@ladybugdb/core`, `onnxruntime-common` ([package.json](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/package.json)) |
| [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | 44,418 | 2026-02-24 | 2026-09-22 | 2,192 | v0.11.0 (09-15) | MIT | C single binary, SQLite |
| [tirth8205/code-review-graph](https://github.com/tirth8205/code-review-graph) | 31,742 | 2026-02-26 | 2026-09-18 | 520 | v2.3.8 (08-21) | MIT | Python ≥3.10, tree-sitter-language-pack, SQLite, networkx |
| [oraios/serena](https://github.com/oraios/serena) | 29,746 | 2025-03-23 | 2026-09-23 | 460 | `mit-final` (09-14) | MIT up to v1.7.0; v2 application GPL-3.0-or-later; SolidLSP stays MIT ([LICENSE](https://github.com/oraios/serena/blob/main/LICENSE)) | Python + language servers / JetBrains |
| [zilliztech/claude-context](https://github.com/zilliztech/claude-context) | 12,565 | 2025-06-06 | 2026-07-14 | 3 | — | MIT | Node, Milvus/Zilliz |
| [repowise-dev/repowise](https://github.com/repowise-dev/repowise) | 6,978 | 2026-03-23 | 2026-09-23 | 1,371 | v0.52.0 (09-20) | **AGPL-3.0** | Python |
| [MinishLab/semble](https://github.com/MinishLab/semble) | 6,135 | 2026-04-06 | 2026-09-18 | 28 | v0.6.0 (09-11) | MIT | Python, potion-code-16M-v2 |
| [vitali87/code-graph-rag](https://github.com/vitali87/code-graph-rag) | 5,173 | 2025-06-16 | 2026-09-23 | 5,529 (automated; 788 tags, v0.0.974) | v0.0.974 | MIT | Python, Memgraph |
| [mixedbread-ai/mgrep](https://github.com/mixedbread-ai/mgrep) | 4,404 | 2025-11-06 | 2026-04-26 | 0 | — | Apache-2.0 | Node, cloud store |
| [CodeGraphContext/CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) | 4,221 | 2025-08-16 | 2026-09-06 | 240 | v0.5.7 (08-08) | MIT | Python, KùzuDB / FalkorDB Lite / Neo4j |
| [giancarloerra/SocratiCode](https://github.com/giancarloerra/SocratiCode) | 3,318 | 2026-02-26 | 2026-09-22 | 349 | v1.14.0 (09-16) | **AGPL-3.0** | Node + Docker (Qdrant, Ollama) |
| [jgravelle/jcodemunch-mcp](https://github.com/jgravelle/jcodemunch-mcp) | 2,711 | 2026-02-09 | 2026-09-23 | 1,054 | v1.108.319 (09-16) | **Dual-Use, non-commercial** ([LICENSE](https://github.com/jgravelle/jcodemunch-mcp/blob/main/LICENSE)) | Python, tree-sitter |
| [zzet/gortex](https://github.com/zzet/gortex) | 1,719 | 2026-04-06 | 2026-09-23 | 2,675 | v0.64.4 (09-16) | Apache-2.0 | Go 1.26 + CGO tree-sitter, SQLite |
| [BeaconBay/ck](https://github.com/BeaconBay/ck) | 1,729 | 2025-08-30 | 2026-07-10 | 17 | — | Apache-2.0 | Rust, fastembed/ort, tantivy |
| [justrach/codedb](https://github.com/justrach/codedb) | 1,383 | 2026-03-03 | 2026-09-19 | 234 | v0.2.5856 | BSD-3-Clause | Zig, no SQLite |
| [cased/kit](https://github.com/cased/kit) | 1,310 | 2025-04-21 | 2026-03-02 | 0 | — | MIT | Python |
| [johnhuang316/code-index-mcp](https://github.com/johnhuang316/code-index-mcp) | 1,002 | 2025-03-18 | 2026-07-27 | 12 | v2.17.1 | MIT | Python |
| [bgauryy/octocode](https://github.com/bgauryy/octocode) | 944 | 2025-06-05 | 2026-08-25 | 24 | — | MIT | Node (GitHub-wide research, not a local index) |
| [harshkedia177/axon](https://github.com/harshkedia177/axon) | 815 | 2026-02-21 | 2026-08-03 | 1 | — | **no LICENSE file** | Python, KùzuDB |
| [CodeBendKit/codeseek](https://github.com/CodeBendKit/codeseek) | 768 | 2026-06-03 | 2026-07-30 | 55 | v0.1.31 | MIT | Rust, LanceDB + Tantivy + petgraph |
| [bartolli/codanna](https://github.com/bartolli/codanna) | 744 | 2025-07-24 | 2026-09-23 | 191 | v0.16.0 (08-29) | Apache-2.0 | Rust, Tantivy + fastembed |
| [probelabs/probe](https://github.com/probelabs/probe) | 716 | 2025-03-05 | 2026-09-22 | 68 | v0.6.0-rc339 (09-08) | Apache-2.0 | Rust, no index |
| [aovestdipaperino/tokensave](https://github.com/aovestdipaperino/tokensave) | 646 | 2026-02-26 | 2026-09-23 | 450 | v7.12.1 (09-12) | MIT | Rust |
| [Cranot/roam-code](https://github.com/Cranot/roam-code) | 518 | 2026-02-09 | 2026-09-20 | 1,240 | v14.1.0 (09-08) | Apache-2.0 | Python, SQLite |
| [aoci-spec/aoci-code](https://github.com/aoci-spec/aoci-code) | 493 | 2026-08-08 | 2026-09-21 | 174 | v0.1.0-rc14 | FSL-1.1-MIT (turns MIT later) | Go |
| [GlitterKill/sdl-mcp](https://github.com/GlitterKill/sdl-mcp) | 488 | 2026-02-08 | 2026-09-21 | 1,091 | v0.13.7 (09-06) | **"Free personal use" community licence** | Node |
| [Muvon/octocode](https://github.com/Muvon/octocode) | 477 | 2025-06-01 | 2026-09-20 | 147 | 0.26.2 (09-18) | Apache-2.0 | Rust, LanceDB |
| [blarApp/blarify](https://github.com/blarApp/blarify) | 232 | 2024-03-20 | 2026-08-17 | 1 | — | MIT | Python, Neo4j / FalkorDB |
| [nikolai-vysotskyi/trace-mcp](https://github.com/nikolai-vysotskyi/trace-mcp) | 181 | 2026-04-03 | 2026-09-23 | 1,222 | v3.31.3 (09-22) | MIT | Node ≥22, better-sqlite3 + web-tree-sitter |
| [postrv/narsil-mcp](https://github.com/postrv/narsil-mcp) | 182 | 2025-12-24 | 2026-05-12 | 0 | 1.7.0 (Cargo) | Apache-2.0 | Rust |
| [helixml/kodit](https://github.com/helixml/kodit) | 124 | 2025-05-01 | 2026-06-23 | ~0 | — | Apache-2.0 | Go |

LSP bridges, structural search, packers:

| Project | ★ | Last commit | Commits since 06-23 | Licence | Note |
|---|---|---|---|---|---|
| [isaacphi/mcp-language-server](https://github.com/isaacphi/mcp-language-server) | 1,598 | 2025-06-03 | 0 | BSD-3-Clause | stale; 69 open issues |
| [jonrad/lsp-mcp](https://github.com/jonrad/lsp-mcp) | 191 | 2025-03-31 | 0 | MIT | dead |
| [golang/tools](https://github.com/golang/tools) (gopls MCP) | — | 2026-09-22 | 225 | BSD-3-Clause | x/tools v0.50.0 (09-08) |
| [microsoft/multilspy](https://github.com/microsoft/multilspy) | 611 | — | — | MIT | LSP client library |
| [ast-grep/ast-grep](https://github.com/ast-grep/ast-grep) | 16,010 | 2026-09-18 | 126 | MIT | 0.45.3 (08-30) |
| [ast-grep/ast-grep-mcp](https://github.com/ast-grep/ast-grep-mcp) | 467 | 2026-08-24 | 3 | MIT | self-described "experimental" |
| [sourcebot-dev/sourcebot](https://github.com/sourcebot-dev/sourcebot) | 3,948 | 2026-09-22 | 210 | **FSL-1.1-ALv2** core + separate `ee/` licence ([LICENSE.md](https://github.com/sourcebot-dev/sourcebot/blob/main/LICENSE.md)) | v5.1.14 (09-17) |
| [sourcegraph/zoekt](https://github.com/sourcegraph/zoekt) | 1,924 | 2026-09-11 | 60 | Apache-2.0 | trigram engine behind Sourcebot |
| [yamadashy/repomix](https://github.com/yamadashy/repomix) | 28,471 | 2026-09-23 | 476 | MIT | v1.18.1 (09-21) |
| [mufeedvh/code2prompt](https://github.com/mufeedvh/code2prompt) | 7,695 | 2026-09-07 | 25 | MIT | Rust |
| [wrale/mcp-server-tree-sitter](https://github.com/wrale/mcp-server-tree-sitter) | 309 | — | — | — | archived |

Agent harnesses and research tooling:

| Project | ★ | Last commit | Commits since 06-23 | Licence | Status |
|---|---|---|---|---|---|
| [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | 88,978 | 2026-09-23 | 694 | MIT | v1.22.0 (09-22); agent logic in [software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) (1,160★) |
| [cline/cline](https://github.com/cline/cline) | 69,151 | 2026-09-23 | 1,219 | Apache-2.0 | active, SDK-based |
| [Aider-AI/aider](https://github.com/Aider-AI/aider) | 49,134 | 2026-05-22 | 0 | Apache-2.0 | stalled for four months |
| [continuedev/continue](https://github.com/continuedev/continue) | 36,002 | 2026-07-20 | 2 | Apache-2.0 | near-dormant; last commit "login flow retired" |
| [TabbyML/tabby](https://github.com/TabbyML/tabby) | 33,889 | 2026-06-30 | 1 | mixed (EE) | dormant |
| [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) | 27,400 | 2026-09-23 | 7,299 | **MIT** (now "Copyright (c) 2025 opencode" + Kilo Code) | active, rebased on opencode |
| [RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code) | 24,299 | 2026-05-15 | 0 | Apache-2.0 | **archived** |
| [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) | 20,390 | 2026-07-16 | 14 | MIT | maintenance |
| [SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) | 7,920 | 2026-09-03 | 20 | MIT | v2.4.6 (07-22) |
| [AutoCodeRoverSG/auto-code-rover](https://github.com/AutoCodeRoverSG/auto-code-rover) | 3,100 | 2025-04-24 | 0 | **SONAR Source-Available v1.0** | inactive |
| [aorwall/moatless-tools](https://github.com/aorwall/moatless-tools) | 643 | 2025-09-01 | 0 | MIT | inactive |
| [gersteinlab/LocAgent](https://github.com/gersteinlab/LocAgent) | 629 | 2026-08-12 | 1 | Apache-2.0 | low activity |

#### Graph and index servers, one by one

- **codegraph** (colbymchenry). *What and how:* a pre-built knowledge graph of symbols, call edges and dependencies. It ships as a bundle with a vendored Node 22.5+ runtime so it can use `node:sqlite` with WAL and FTS5. In the README's words, "better-sqlite3 is gone… zero native addons to compile", and there is "no wasm fallback — and therefore no more `database is locked` (issue #238)" ([BUNDLING.md](https://github.com/colbymchenry/codegraph/blob/main/BUNDLING.md); [sqlite-adapter.ts](https://github.com/colbymchenry/codegraph/blob/main/src/db/sqlite-adapter.ts)). The npm dependencies are `web-tree-sitter` and `tree-sitter-wasms`, and a native Rust kernel parses 20 languages "with one boundary crossing per file" ([package.json](https://github.com/colbymchenry/codegraph/blob/main/package.json); [README](https://github.com/colbymchenry/codegraph/blob/main/README.md)). The README claims the Linux kernel (70k files, 2M symbols, 6.4M relationships) indexes in under 12 minutes on a 2-core, 6 GB VPS, and that a one-file save re-syncs in ~0.3–0.4 s ([README](https://github.com/colbymchenry/codegraph/blob/main/README.md)). *Agent surface:* the server lists a **single MCP tool**, `codegraph_explore`, which returns "the relevant symbols' verbatim source grouped by file, plus the call paths between them and a blast-radius summary… Name a file or symbol in the query to read its current line-numbered source, the same shape the Read tool gives you". Seven other tools (node, search, callers, callees, impact, files, status) are kept "unlisted by default" because "one strong tool steers agents better than a menu of narrower ones" ([README](https://github.com/colbymchenry/codegraph/blob/main/README.md)). An opt-in, default-yes Claude Code `UserPromptSubmit` "prompt-hook" injects `codegraph_explore` context on "how / where / trace / impact" prompts ([installer](https://github.com/colbymchenry/codegraph/blob/main/src/installer/index.ts)). *Measured (vendor):* Claude Opus 4.8, headless, 7 repos × 1 architecture question, median of 4 runs per arm, with the codegraph CLI blocked in both arms. The result was 88% fewer tool calls, 53% less time, 62% fewer tokens and 44% lower cost, and zero file reads in the treatment arm. The same README concedes that ~80% more retrieval context stays resident at the end of multi-turn sessions (VS Code: 67k vs 18k tokens) ([README](https://github.com/colbymchenry/codegraph/blob/main/README.md)). Self-measured "fair coverage" of resolved cross-file dependents is 73.8–100% per language ([README](https://github.com/colbymchenry/codegraph/blob/main/README.md)). *Failure modes:* [#914](https://github.com/colbymchenry/codegraph/issues/914) "LLM don't call codeGraph mcp tools in long-running task". In [#1918](https://github.com/colbymchenry/codegraph/issues/1918), Claude wrote "The codegraph output is heavily compressed, so I'm reading the strategy file directly", even with rules in CLAUDE.md and in memory. In [#1830](https://github.com/colbymchenry/codegraph/issues/1830), a path without an extension was treated as free text: unrelated files came back with the footer "Complete source for 5 files is included above — do NOT re-read them", and the prompt-hook injected ~16 KB of unrelated source. In [#1474](https://github.com/colbymchenry/codegraph/issues/1474), a stale index combined with a fresh disk read returned "a DIFFERENT symbol's code under the requested name, while asserting 'verbatim, current on-disk source … do not Read'". In [#1902](https://github.com/colbymchenry/codegraph/issues/1902), the daemon kept writing into an unlinked old DB. *Verdict:* the nearest twin to graph-indexer and a direct competitor. Copy its guards and its lessons (see Implications). MIT allows code reuse with attribution.

- **graphify** (Graphify-Labs). *What and how:* turns code, docs, SQL schemas and configs into a knowledge graph. Code goes through a local, LLM-free tree-sitter AST pass over about 40 languages (37 grammars listed), with `calls`/`imports`/`inherits`/`mixes_in` resolved across files, Leiden communities, and "no vector store". Docs and media optionally go through a model ([README](https://github.com/Graphify-Labs/graphify/blob/v8/README.md)). *Agent surface:* the main interface is a `/graphify` skill that writes `GRAPH_REPORT.md` and `graph.json`. An optional MCP server exposes `query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `list_prs`, `get_pr_impact` and `triage_prs`. Hooks nudge the agent before search calls and before per-file Read/Glob on Claude Code and Gemini CLI. `--strict` mode "blocks the first raw source read of a s[ession]", and git hooks rebuild the graph on commit and checkout ([README](https://github.com/Graphify-Labs/graphify/blob/v8/README.md)). *Measured (vendor harness):* on ERPNext (~1M LOC) with Opus 4.8, at most 14 turns, grep/read/list plus one tool, key-fact coverage went from 70.8% to 82.0% at ~140K tokens per query. That is **n = 6 questions**, graded by Kimi K2.6 ([BENCHMARKS.md](https://github.com/Graphify-Labs/graphify/blob/v8/BENCHMARKS.md)). *Failure mode:* [#2420](https://github.com/Graphify-Labs/graphify/issues/2420) "explain silently caps connections at 20 and never points to affected, which returns the complete set". *Verdict:* ignore as a library (Python, graph-report workflow). Its skill-first plus strict-hook distribution is worth noting.

- **GitNexus.** It has 17 MCP tools (`list_repos`, `query`, `context`, `impact`, `trace`, `detect_changes`, `check`, `rename`, `cypher`, `route_map`, `tool_map`, `shape_check`, `api_impact`, `explain`, `pdg_query`, `group_list`, `group_sync`), MCP resources (`gitnexus://repo/{name}/schema`, group contracts, group staleness), two MCP prompts (`detect_impact`, `generate_map`) and a PDG/taint mode ([README](https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md)). Its eval harness defines `baseline`, `native` and `native_augment` arms, where `native_augment` means "grep results automatically enriched with graph context (**recommended**)". The README publishes no resolve-rate result ([eval/README.md](https://github.com/abhigyanpatwari/GitNexus/blob/main/eval/README.md)). Its own workflow bench (2026-07-11, n = 1 per cell, one repo) reports the following. The full plan→work skill workflow cost 3–4× the baseline on small tasks ($9.16 vs $2.11). The `workflow_direct` mode cost 15–55% more on small tasks but 47% less (and took 56% less wall time) on one cross-module task. "Resolve rate stayed tied across all cells" ([workflow_bench/README.md](https://github.com/abhigyanpatwari/GitNexus/blob/main/eval/workflow_bench/README.md)). *Verdict:* **cannot be reused** (PolyForm Noncommercial). Ideas only.

- **codebase-memory-mcp (CBM)** — new facts beyond the prior report. Its tools are `index_repository`, `list_projects`, `delete_project`, `index_status`, `check_index_coverage`, `search_graph`, `trace_path`, `detect_changes`, `query_graph` (Cypher-like), `get_graph_schema`, `compare_graphs`, `get_code_snippet`, `get_file_outline`, `get_architecture`, `search_code`, `manage_adr` and `ingest_traces`. It says of `check_index_coverage`: "A clean result means no recorded gap, not proof of completeness." ([README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)). In Claude Code it installs a skill, three graph subagents, `SessionStart`, `SubagentStart`, a non-blocking `PreToolUse` on Grep/Glob/Bash and "post-`Read` coverage". It withholds hooks for Cursor ("session injection races") and for Cline ("output is not reliably consumed") ([README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)). The hook returns 5 results, and its in-process deadline default was raised to **2,000 ms** (range 50–10,000). The source explains that "the original 300ms budget silently self-terminated on real cold" starts and that a fired deadline "is otherwise indistinguishable from 'no matches'", so the hook now writes a breadcrumb (#858). After a Read, the hook injects only a coverage note when the file is partially indexed or "not reliably represented" ("Read source directly and qualify graph…") ([hook_augment.c](https://github.com/DeusData/codebase-memory-mcp/blob/main/src/cli/hook_augment.c)). Its own 63-language benchmark is tool-QA with 12 questions per language, not an agent outcome ([BENCHMARK.md](https://github.com/DeusData/codebase-memory-mcp/blob/main/docs/BENCHMARK.md)). *Verdict:* MIT. Copy its hook contract (never block, breadcrumbs, coverage notes). Nothing to reuse as a library (C binary).

- **Serena.** The licence changed in September 2026. The application is GPL-3.0-or-later from v2. SolidLSP (`src/solidlsp/`) "remain[s] MIT-licensed and may be… used separately under MIT terms". Everything up to v1.7.0 stays MIT ([LICENSE](https://github.com/oraios/serena/blob/main/LICENSE); snippet summary via [GitHub](https://github.com/oraios/serena)). About 50 tool classes span LSP and JetBrains backends: symbol find/overview/references/implementations/declaration, diagnostics per file and per symbol, symbol-level edits, rename, JetBrains move/safe-delete/type-hierarchy/inspections, memories, a REPL and onboarding ([src/serena/tools](https://github.com/oraios/serena/tree/main/src/serena/tools)). Its published "evaluation" is an agent self-assessment (Opus 4.6, GPT 5.4). It admits that small edits are more efficient with built-ins ("~4.5x less payload") ([evaluation docs](https://github.com/oraios/serena/blob/main/docs/04-evaluation/010_methodology.md)). *Verdict:* ignore the app (GPL). SolidLSP is reusable under MIT, but graph-indexer avoids LSPs by design.

- **code-review-graph.** Tree-sitter ASTs go into a SQLite graph of functions, classes and imports, with calls, inheritance and test-coverage edges. Incremental updates re-parse only files whose SHA-256 changed. There are hooks, a pre-commit hook and a watch mode ([README](https://github.com/tirth8205/code-review-graph/blob/main/README.md)). Its headline "~63x median per-question reduction" is measured against a whole-corpus baseline that the README itself calls "an upper bound no real agent pays". Its impact F1 of 0.693 uses graph-derived ground truth ("recall 1.0 is circular") ([README](https://github.com/tirth8205/code-review-graph/blob/main/README.md)). The README also admits that "Graph context can exceed a plain file read for trivial edits" ([README](https://github.com/tirth8205/code-review-graph/blob/main/README.md)). *Verdict:* ignore; its measurements are weak (see Q5 for its 0/15 adoption).

- **trace-mcp** (Node, MIT). A framework-aware graph covering 81 languages and 88 framework integrations ([repo description](https://github.com/nikolai-vysotskyi/trace-mcp)). Dependencies are better-sqlite3, web-tree-sitter + tree-sitter-wasm, `@ast-grep/napi`, `oxc-resolver`, `@parcel/watcher`, xxhash-wasm and `@toon-format/toon`, with optional `@huggingface/transformers` and sqlite-vec ([package.json](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/package.json)). Tool presets register 28 (minimal), 55 (standard) or 166 (full) tools. The full surface costs about 42–45k tokens, and renaming the server key saved only ~1% ([name-token-savings.md](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/benchmarks/name-token-savings.md)). It has the most rigorous public measurement culture in the field: preregistered bars, a struck and re-run quality arm, and a cache study (see Q2, Q4, Q5). *Verdict:* the best source of techniques and measurement protocol. MIT, so code can be copied.

- **repowise** (AGPL). It builds five layers (call graph, git history, wiki, decisions, health). `get_context` costs "393 tokens instead of 13,984". There is a `distill` command-output compressor ("pytest 61% fewer tokens, all 11 failure lines kept"; "git log -50 89% fewer") and optional hooks that "push" context ([README](https://github.com/repowise-dev/repowise/blob/main/README.md)). Its head-to-head benchmark is in Q5. *Verdict:* reuse its benchmark protocol (compiler oracle), not its code (AGPL).

- **Codanna** (Apache-2.0, Rust: Tantivy + fastembed + 15 tree-sitter grammar crates, per [Cargo.toml](https://github.com/bartolli/codanna/blob/main/Cargo.toml)). The headline tool `semantic_search_with_context` returns "the symbol identity, signature, docstring, callees [with exact call sites], callers, and recursive impact analysis — five MCP tools fused into one query". A one-shot CLI (`codanna mcp find_symbol name:"…"`) works for "slash-commands, bash hooks, scripts, CI. No daemon required", and there is a Claude Code plugin ([README](https://github.com/bartolli/codanna/blob/main/README.md)). *Verdict:* copy its output format and its one-shot CLI mode. Apache-2.0 is compatible, with a NOTICE.

- **Probe** (Apache-2.0, Rust). No index. It pairs "ripgrep speed" with tree-sitter to return complete functions or classes, and offers Elasticsearch-style boolean queries with BM25, `--max-tokens` and session dedup. Commands include `extract` (by line, symbol or compiler output), `symbols` and an ast-grep `query` ([README](https://github.com/probelabs/probe/blob/main/README.md)). It ships an `lsp-daemon` crate on the turso DB ([Cargo.toml](https://github.com/probelabs/probe/blob/main/lsp-daemon/Cargo.toml)). Its stated thesis is "AI agents don't need embedding search … the LLM already handles [vocabulary mismatch]" ([README](https://github.com/probelabs/probe/blob/main/README.md)). *Verdict:* copy the "complete AST block per hit" and session-dedup ideas.

- **Octocode (Muvon)** (Apache-2.0, Rust, LanceDB). A live tree-sitter symbol graph (contains/imports/calls/extends/implements), optional embedding and LLM enrichment, and MCP tools `semantic_search`, `view_signatures`, `graphrag`, `structural_search` and `lsp_*` (with `--with-lsp`). Its vendor benchmark runs 127 queries on its own source. Dense-only Hit@5 was 0.598, and keyword-tilted RRF (0.3 dense / 0.7 BM25) reached 0.732 (+22%), with Recall@10 going from 0.671 to 0.807. A generic cross-encoder (`bge-reranker-base`) **regressed** Hit@5 from 0.732 to 0.598 ([README](https://github.com/Muvon/octocode/blob/master/README.md)). *Verdict:* this independently corroborates graph-indexer's own finding that generic rerankers hurt symbolic queries.

- **ck** (Apache-2.0, Rust). A grep-compatible CLI with semantic (fastembed/ONNX via `ort`) and BM25 (Tantivy) hybrid search, chunk-level delta caching, and MCP tools `semantic_search`, `regex_search`, `hybrid_search`, `index_status`, `reindex` and `health_check` ([README](https://github.com/BeaconBay/ck/blob/main/README.md); [Cargo.toml](https://github.com/BeaconBay/ck/blob/main/Cargo.toml)). Activity is slowing: 17 commits since 06-23, last on 2026-07-10. *Verdict:* ignore.

- **The rest of the 2026 cohort** (all vendor claims):
  - gortex: Go + CGO, SQLite graph, 257 languages in three tiers (bespoke tree-sitter, regex, "forest-backed signatures"), LSP enrichment for some languages, "50× fewer tokens per response" ([README](https://github.com/zzet/gortex/blob/main/README.md)).
  - codedb: Zig, "No SQLite. No dependencies."; a `PreToolUse` hook "nudges agents from grep/cat to codedb"; micro-benchmarks such as "1,628x fewer" tokens on one search ([README](https://github.com/justrach/codedb/blob/main/README.md)).
  - tokensave: Rust. Its `PreToolUse` hook blocks Explore agents "outright" and intercepts symbol-shaped grep/rg/ag calls, plus `UserPromptSubmit`/`Stop` hooks and git hooks ([README](https://github.com/aovestdipaperino/tokensave/blob/master/README.md)).
  - roam-code: Python/SQLite, 28 languages, 246 MCP tools, and optional Claude hooks that pair context preparation with post-edit checks. The README warns that "Installation does not prove the hooks executed" ([README](https://github.com/Cranot/roam-code/blob/main/README.md)).
  - SocratiCode: Docker + Qdrant + Ollama. Claims "61% less context, 84% fewer tool calls, and 37x faster than grep-based exploration" on VS Code with Opus 4.6 ([README](https://github.com/giancarloerra/SocratiCode/blob/main/README.md)).
  - sdl-mcp: tree-sitter plus SCIP/LSP "provider-first indexing", and a "gateway mode" that reduces the surface "to four namespace tools" ([README](https://github.com/GlitterKill/sdl-mcp/blob/main/README.md)).
  - axon: KùzuDB graph + FTS + vectors, with a built-in blocklist of 138 builtins (`print`, `len`, `console`, `setTimeout`, `useState`…) to cut false call edges ([README](https://github.com/harshkedia177/axon/blob/main/README.md)).
  - codeseek: LanceDB + Tantivy + petgraph, 7 languages, dense + sparse + RRF + reranker ([README](https://github.com/CodeBendKit/codeseek/blob/main/README.md)).
  - aoci-code: a git-versioned "description of the system", with only a "thin `PreToolUse` guard" (a pre-write reminder or stale guard) ([README](https://github.com/aoci-spec/aoci-code/blob/main/README.md)).
  - jCodeMunch tools: `get_symbol_source`, `search_symbols`, `get_file_outline`, `find_references`, `get_call_hierarchy`, `get_blast_radius`, `check_edit_safe`, `check_delete_safe`, `find_dead_code`, `plan_turn`… ([README](https://github.com/jgravelle/jcodemunch-mcp/blob/main/README.md)).
  - kodit: "MCP server to index external repositories", with tools `kodit_semantic_search`, `kodit_keyword_search`, `kodit_grep`, `kodit_ls`, `kodit_read_resource`, `kodit_architecture_docs`, `kodit_api_docs`, `kodit_database_schema`… ([README](https://github.com/helixml/kodit/blob/main/README.md)).
  - narsil-mcp: "90 tools, 32 languages", optional RDF/SPARQL, neural (ort) and a ~3 MB WASM build ([README](https://github.com/postrv/narsil-mcp/blob/main/README.md)).
  - code-index-mcp: shallow and deep index, `search_code_advanced`, `find_files`, `get_file_summary`, file watcher ([README](https://github.com/johnhuang316/code-index-mcp/blob/master/README.md)).
  - claude-context has 4 tools (`index_codebase`, `search_code`, `clear_index`, `get_indexing_status`) and only 3 commits since 06-23 ([index.ts](https://github.com/zilliztech/claude-context/blob/master/packages/mcp/src/index.ts)).

#### LSP↔MCP bridges and compiler-backed servers
- **gopls MCP** (BSD-3). Experimental since gopls v0.20.0 (July 2025). In *attached* mode (`-mcp.listen`) it "share[s] memory with your LSP session and observe[s] the current unsaved buffer state"; in *detached* mode (`gopls mcp`) it "only sees saved files on disk". Its model instructions "are not automatically published during initialization" and must be printed with `gopls mcp -instructions` ([mcp.md](https://github.com/golang/tools/blob/master/gopls/doc/features/mcp.md)). The instructions are MUST-style workflows: `go_workspace` first; `go_search`; `go_file_context`; `go_package_api`; `go_symbol_references` "before modifying the definition of any symbol"; `go_diagnostics` "after every code modification" ([instructions.md](https://github.com/golang/tools/blob/master/gopls/internal/mcp/instructions.md)). Tool list per the v0.20.0 release notes (via [search snippet](https://go.dev/gopls/release/v0.20.0)).
- **mcp-language-server** (tools `definition`, `references`, `diagnostics`, `hover`, `rename_symbol`, `edit_file`) has had no commits since 2025-06-03. **lsp-mcp** has had none since 2025-03-31 ([mcp-language-server README](https://github.com/isaacphi/mcp-language-server/blob/main/README.md)).
- **Kilo (opencode base) `lsp` tool:** nine operations (goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls), 1-based positions, and an error if no server is configured ([lsp.txt](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/tool/lsp.txt)).

#### Structural search, search engines and packers
- **ast-grep-mcp** describes itself as "An experimental … MCP server", with `dump_syntax_tree`, `test_match_code_rule`, `find_code` and `find_code_by_rule` ([README](https://github.com/ast-grep/ast-grep-mcp/blob/main/README.md)).
- **Sourcebot** moved its core to the Functional Source License 1.1 (ALv2 future licence), with `ee/` under a separate licence ([LICENSE.md](https://github.com/sourcebot-dev/sourcebot/blob/main/LICENSE.md)).
- **repomix** `--compress` "uses Tree-sitter to extract key code elements" (classes, functions, interfaces) and ships MCP file-system tools ([README](https://github.com/yamadashy/repomix/blob/main/README.md)).

#### Agent-harness tooling (status in 2026)
- **Continue:** `@Codebase` is deprecated. Agent mode "can now use file exploration and search tools" ([docs](https://docs.continue.dev/reference/deprecated-codebase)). Only 2 commits since 06-23 ([repo](https://github.com/continuedev/continue)).
- **Cline** (SDK era): its tools are `run_commands`, `read_files`, `search_codebase`, `fetch_web_content`, `apply_patch`, `editor`, `skills`, `ask_question` and `submit_and_exit`. `search_codebase` is a regex search whose output beyond a fixed character budget is "middle-truncated; narrow patterns beat broad ones". There is no semantic index ([definitions.ts](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/tools/definitions.ts)).
- **Roo Code:** shutdown announced 2026-04-21 and repository archived 2026-05-15, to go "all-in on Roomote". Zoo Code (community fork), Kilo and Cline are listed as migration paths ([vibecodinghub](https://vibecodinghub.org/blog/roo-code-shutdown); [Bodega One](https://www.bodegaone.ai/blog/roo-code-shutdown-alternatives); archived flag via the GitHub API). Its indexer chunked tree-sitter blocks of 50–1,000 characters into Qdrant ([constants](https://github.com/RooCodeInc/Roo-Code/tree/main/src/services/code-index/constants)).
- **Kilo** is now MIT and rebased on opencode. Codebase indexing is **opt-in** ("disabled by default"): tree-sitter blocks, then embeddings, then **LanceDB or Qdrant**, exposed through a `semantic_search` tool ([codebase-indexing.md](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/customize/context/codebase-indexing.md)). Tool output is truncated at 2,000 lines or 50 KB, configurable via `tool_output` ([truncate.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/tool/truncate.ts)). Read returns up to 2,000 numbered lines ([read.txt](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/tool/read.txt)).
- **OpenHands** V1 lives in software-agent-sdk. Its primary condenser replaces "the first half of all events with a single summary event", and the README notes that "condensation destroys the prompt cache" ([condenser README](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/context/condenser/README.md)). Its tools are terminal, file_editor, grep, glob, apply_patch, task_tracker and others, with no code-intelligence tools ([tools](https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-tools/openhands/tools)).
- **SWE-agent** tool bundles are `windowed`, `windowed_edit_*`, `search`, `filemap`, `edit_anthropic`, `review_on_submit_m`, `diff_state` and others ([tools/](https://github.com/SWE-agent/SWE-agent/tree/main/tools)). **mini-swe-agent** is bash-only and claims ">74% on SWE-bench verified" ([repo](https://github.com/SWE-agent/mini-swe-agent)).
- **Aider** has had no commits since 2026-05-22. Unreleased notes say the repo map now tags Fortran, Haskell, Julia and Zig ([HISTORY.md](https://github.com/Aider-AI/aider/blob/main/HISTORY.md)).
- **CodeCompass** (arXiv 2602.20048, cited in the prior report): the GitHub search found no public code release, only unrelated repos with 0–2 stars ([search](https://github.com/search?q=codecompass+mcp&type=repositories)).

### Inferences
- The field has converged technically: tree-sitter plus an embedded graph plus hooks is table stakes. Products now differ on precision/recall, freshness, the honesty of each answer and distribution, not on having a graph. This supports the prior report's thesis that honest, fresh answers are the differentiator.
- Stars measure virality, not value. The 5k–120k-star projects publish mostly weak baselines (whole-corpus, n = 6, n = 1 per cell). The 181-star trace-mcp publishes the only preregistered, reproducible quality arm.
- codegraph showed that `node:sqlite` plus WASM grammars scale to a released product. graph-indexer's stack is not a handicap. Its differentiation has to come from resolution precision (scope/import/type-aware), edit checks and test selection, which codegraph and the rest do not advertise at the same depth.
- Harness vendors are retreating from built-in semantic indexes (Continue deprecated @Codebase, Cline has none, Kilo made indexing opt-in, Roo shut down, Aider stalled). That leaves room for a portable, harness-independent local engine delivered through hooks.

### Gaps
- No neutral third party has run a controlled resolve-rate study of any of these servers. All agent-level numbers above are vendor-run.
- The claude-context and ck stagnation and the Aider pause have no public explanation in the repos.
- I could not verify the licence and model-card text of potion-code-16M-v2 directly (Hugging Face was blocked). The prior report's MIT finding stands unverified here.
- CodeCompass has no public code. Blarify, Kodit and narsil-mcp have too little recent activity or documentation to assess their resolution quality.
- Star counts for some agent-harness rows (multilspy activity, the golang/tools gopls subtree) were not broken out.

## 2. Output compressors and token savers: design and measured savings

### Takeaway
Command-output compressors and proxies are the most-starred category of 2026: caveman ~107.5k, RTK ~81.6k, headroom ~73.6k, context-mode ~24k. Yet every cross-vendor or independent measurement finds that their token counts do not turn into lower cost in agentic coding. RTK came out **+7.6%** (JetBrains, low effort, p = 0.004), **+1% to +17%** (Quesma) and **+13%** (Dasein). Headroom came out **+44%**, because it re-pays cache writes. The approaches that do pay are these: remove tokens without churning the prompt cache or adding turns, mask old observations, and append small facts only to the newest message.

### Cited Findings
- **RTK design.** A single Rust binary that "filters and compresses command outputs before they reach your LLM context", "100+ supported commands, <10ms overhead". Hook-based agents "rewrite Bash commands (e.g., `git status` -> `rtk git status`) before execution". The README states: "the hook only runs on Bash tool calls. Claude Code built-in tools like `Read`, `Grep`, and `Glob` do not pass through the Bash hook". "The token counts RTK reports are estimated as `bytes / 4`" ([README](https://github.com/rtk-ai/rtk/blob/develop/README.md)).
- **RTK measured, JetBrains (July 2026; figures from search snippets and third-party quotes).** On SkillsBench, the median cost change was **+7.6% at low reasoning effort (p = 0.004) and ±0% at high effort**. RTK can intercept only **~20% of tool-output bytes** because Read/Grep bypass the hook, and cached re-reads are billed at a tenth of the price ([JetBrains blog](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/); [TechTimes](https://www.techtimes.com/articles/321223/20260721/rtk-raises-claude-code-costs-low-effort-jetbrains-benchmark-debunks-6090-claim.htm)). trace-mcp describes the study as "a paired A/B over 80 Claude Code tasks" ([mirror-prompt-cache.md](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/benchmarks/mirror-prompt-cache.md)).
- **RTK measured, Quesma (from search snippets).** Across 445 DeepSeek attempts, `rtk gain` reported 349.2M tokens saved (89%) while average task cost **rose 17%**. Per-turn input fell 7% but turns rose 18%. With Claude Code, cost was +1% on "Fable" and +17% on DeepSeek, and pass rates moved from 84% to 83% and from 71% to 69%. Quesma concluded it "does not recommend RTK as a generic cost-saving tool" ([Quesma](https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/); [HN thread](https://news.ycombinator.com/item?id=49656471)).
- **Dasein code-compression bench (sponsor-run; the sponsor's product "Parsec" is one arm).** Headless Claude Code, `claude-sonnet-4-6`, 100 SWE-bench Verified tasks, official Docker grader, cache-aware pricing, **one run per arm**:

  | Arm | Solved | $/solved | Total cost vs baseline | Input tokens vs baseline | Cache read:write |
  |---|---|---|---|---|---|
  | Baseline | 57 | $2.58 | — | — | 41.6 |
  | RTK | 54 | $3.07 | **+13%** | +16% | 46.4 |
  | Headroom | 58 | $3.66 | **+44%** | +6% | 11.3 |
  | Caveman | 58 | $2.05 | −19% | −19% | 40.4 |
  | Woz | 55 | $2.33 | −13% | −35% | 24.7 |
  | Fermat (run 09-21) | 55 | $2.09 | −22% | −32% | 35.5 |
  | Parsec (sponsor) | 62 | $1.45 | −39% | −54% | 22.6 |

  The bench explains that "A layer that trims the visible prompt but rewrites the cached prefix each turn re-pays the expensive cache-write rate". Headroom's 11.3 read:write ratio "is why it is the most expensive arm (+44%) despite input tokens that barely move (+6%)" ([README](https://github.com/daseinlabs/code-compression-bench/blob/master/README.md)). Its FACT-VS-FICTION page quotes RTK's own site, whose `/benchmarks` page "reads: 'No benchmark data yet'" ([FACT-VS-FICTION.md](https://github.com/daseinlabs/code-compression-bench/blob/master/FACT-VS-FICTION.md)). Its README says Headroom's "60–95% fewer tokens, same answers" was measured on "Single-shot QA (GSM8K, SQuAD…)", and that Headroom's own docs say "code passes through" uncompressed ([README](https://github.com/daseinlabs/code-compression-bench/blob/master/README.md)).
- **RTK failure modes (issue titles):**
  - [#2281](https://github.com/rtk-ai/rtk/issues/2281) "Go filters can hide real compiler errors and report misleading success"
  - [#3500](https://github.com/rtk-ai/rtk/issues/3500) "truncates cargo build / cargo test error output"
  - [#3984](https://github.com/rtk-ai/rtk/issues/3984) "`rtk git diff --check` emits no output at all"
  - [#4212](https://github.com/rtk-ai/rtk/issues/4212) "`rtk proxy rg` silently corrupts matched text"
  - [#2445](https://github.com/rtk-ai/rtk/issues/2445) "Silent auto-rewrite hook trips Claude Code's tampering/injection heuristics → agent distrusts rtk output"
  - [#4200](https://github.com/rtk-ai/rtk/issues/4200) the hook prints one git error per sibling repo on every Bash call.
- **context-mode** (**Elastic License 2.0**, [LICENSE](https://github.com/mksglu/context-mode/blob/main/LICENSE)). An MCP server with 11 tools (six sandbox tools such as `ctx_execute`, `ctx_batch_execute`, `ctx_index` and `ctx_search`, plus five meta tools). Sandboxes keep raw output out of context ("315 KB becomes 5.4 KB"), session events are tracked in SQLite and re-retrieved through FTS5/BM25 after compaction, and hooks (PreToolUse, PostToolUse, UserPromptSubmit, PreCompact, SessionStart) enforce routing across 17 platforms ([README](https://github.com/mksglu/context-mode/blob/main/README.md)). Its issues:
  - [#1003](https://github.com/mksglu/context-mode/issues/1003) "PreToolUse denies and nudges are defeated by parallel tool batches"
  - [#1037](https://github.com/mksglu/context-mode/issues/1037) "routing denies WebFetch/curl for subagents that cannot reach the MCP server"
  - [#724](https://github.com/mksglu/context-mode/issues/724) routing "stalls read-only subagents: injected block omits the ToolSearch bootstrap for deferred ctx_* tools"
  - [#1000](https://github.com/mksglu/context-mode/issues/1000) "no timeout on hot PostToolUse hook"
- **Headroom** (Apache-2.0). A proxy, library and MCP server (`headroom_compress`, `headroom_retrieve`) with SmartCrusher (JSON), CodeCompressor (AST), Kompress (prose), CCR reversible originals and a CacheAligner that "never rewrites prompts". Its quick-start installs Serena ([README](https://github.com/headroomlabs-ai/headroom/blob/main/README.md)). The Quesma list notes that its "TOST non-inferiority framework was removed from the public repo on 2026-07-10" ([awesome-ai-tokenomics](https://github.com/QuesmaOrg/awesome-ai-tokenomics/blob/main/README.md)).
- **Caveman** (MIT except "Engine-linked directories"). An output-style skill plus proxy. By its own summary of JetBrains' study: "86 real coding tasks, paired A/B, Claude Code 2.1.200… **8.5% fewer output tokens**, about 10% cost. No detectable quality change (sign test p = 0.82)". Its conclusion is that an agent's bill "is mostly *reading*, not writing" ([README](https://github.com/JuliusBrussee/caveman/blob/main/README.md)).
- **sqz** (ELv2) claims "24.7% avg reduction · up to 92% on output the model already has", deduplicating repeats to 13-token refs ([README](https://github.com/ojuschugh1/sqz/blob/main/README.md)). **lean-ctx** (Apache-2.0, 3,828★) returns "a compact deterministic reference" for cached re-reads, offers map-mode reads, and keeps a self-measured savings ledger plus a "Shadow Mode" baseline ([README](https://github.com/yvgude/lean-ctx/blob/main/README.md)).
- **trace-mcp Read/Bash "mirror" hooks:**
  - A mirror *tool* would compete with Read and was adopted 13–16% of the time. A `PostToolUse` hook with `updatedToolOutput` sees 100% of Read and Bash calls.
  - The replacement must match the tool's output envelope exactly or it is "discard[ed]… *silently*". Read expects `{type:"text", file:{filePath, content, numLines, startLine, totalLines}}`; Bash expects `{stdout, stderr, interrupted, isImage, noOutputExpected}`.
  - Noise filtering "never runs on a `Read`", outputs under 2,000 characters pass through untouched, and "Four of five real outputs were too small to be worth touching".
  - The host already persists large outputs itself; the SDK host behind `claude -p` persisted a 30 KB output.

  Source: [e1-read-bash-mirror.md](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/benchmarks/e1-read-bash-mirror.md).
- **trace-mcp cache study.**
  - Because `updatedToolOutput` only alters the newest appended message, "no cached prefix can be invalidated by it".
  - Corpus of 2,746 sessions and 113,501 requests: cache_read 92.6%, cache_write 2.8%, uncached 4.6%. The prefix-break rate was 1.76% at baseline and 1 in 41 after a rewrite.
  - Live A/B (one task, five runs): cost −83% and cache_write −95%.
  - Spilled full outputs were recalled "0 of 48" times.
  - Two defects were fixed: the escape hatch re-mirrored the spill file, and spill names were non-deterministic (now content-addressed).

  Source: [mirror-prompt-cache.md](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/benchmarks/mirror-prompt-cache.md).
- **trace-mcp "skeleton gate"** (compressing Read/Bash output by structure). The corpus was 493 calls from 2,416 transcripts, and evidence recall is the share of lines the agent later quotes, edits or carries forward. The gate required recall ≥0.85 at a ≥50% cut:

  | Arm | Calls | Mean recall | Mass cut |
  |---|---|---|---|
  | Structural units (focal code keeps its body, the rest keeps signatures) | 493 | 0.623 | 53.2% |
  | Structural units, Read calls only | 180 | 0.606 | 51.2% |
  | Head/tail window at the same budget, Read calls only | 180 | **0.639** | 50.7% |
  | Signatures only, Read calls only | 180 | 0.348 | 71.6% |
  | Oracle structural focus, Read calls only | 180 | 1.00 | **16.7%** |

  In its words, "At equal mass, structure loses to a dumb window", and the verdict was "the direction is closed" ([skeleton-gate](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/benchmarks/skeleton-gate/README.md)).
- **Observation masking (independent, JetBrains Research, NeurIPS 2025 DL4Code).** In SWE-agent on SWE-bench Verified, masking old observations "halves cost relative to the raw agent while matching, and sometimes slightly exceeding, the solve rate of LLM summarization". With Qwen3-Coder 480B, the solve rate went from 53.8% to 54.8%, and a hybrid cut a further 7–11% ([arXiv 2508.21433](https://arxiv.org/abs/2508.21433); [code](https://github.com/JetBrains-Research/the-complexity-trap)).

### Inferences
- The mechanism behind the negative results is known and avoidable: rewriting the agent's commands, which changes its behaviour and turn count; rewriting cached prefixes; and counting raw bytes/4 as "tokens saved". A graph-indexer hook that only *appends* small facts to the newest message is cache-neutral by construction. That is what trace-mcp measured for rewrites of the newest message.
- Compressing the agent's own Read output is a losing direction for source code. trace-mcp's oracle ceiling of 16.7% says the evidence the agent later uses is spread across the file. Augmenting reads beats trimming them.
- None of these compressors is worth integrating. At best they are complementary for shell logs, and their cost claims are contradicted. context-mode and sqz are not even licence-compatible (ELv2).

### Gaps
- The full JetBrains and Quesma methodology (task lists, run counts per arm) could not be read (blocked). The figures above rest on snippets and quotes.
- The Dasein bench is one run per arm with the sponsor's own product in the table. Its ±3–5 task differences in solve counts are within noise (by the prior report's power table, ~573 tasks would be needed to detect 5 points with one run per arm).
- There is no measurement of an *additive* (definitions-appending) hook on cost or solve rate. trace-mcp's live cache A/B is n = 5 on a single task.

## 3. Building blocks for structural and semantic search usable from Node without native builds

### Takeaway
The zero-native path for a dense channel is still a pure-JS Model2Vec implementation (static embeddings, MIT model). transformers.js 4.3.0 now **hard-depends on native `onnxruntime-node` and `sharp`**. For scope resolution, the most valuable reusable asset found is nvim-treesitter's **151 `locals.scm` query files** (Apache-2.0), which cover all 17 languages graph-indexer targets. SCIP stays the precise import format, with TypeScript bindings available, but its Python indexer has been idle for a year, and stack-graphs remains archived. codegraph shows that `node:sqlite` with WAL and FTS5 in production removed its "database is locked" problems.

### Cited Findings
- **model2vec** is MIT, v0.9.0 (2026-08-12) ([LICENSE](https://github.com/MinishLab/model2vec/blob/main/LICENSE)). semble (MIT) uses `DEFAULT_MODEL_NAME = "minishlab/potion-code-16M-v2"` ([utils.py](https://github.com/MinishLab/semble/blob/main/src/semble/utils.py)).
- **transformers.js 4.3.0** (2026-09-16, Apache-2.0) depends on `onnxruntime-node` 1.30.0, `onnxruntime-web` 1.31.0-dev, `sharp` ^0.35.4, `@huggingface/tokenizers` and `@huggingface/jinja` ([package.json](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/package.json)). Using it breaks a zero-native-dependency policy unless the web/WASM build is isolated.
- **SCIP** (Apache-2.0) has bindings for dotnet, go, haskell, java, kotlin, rust and **typescript** ([bindings/](https://github.com/sourcegraph/scip/tree/main/bindings)). The Go bindings tagged v0.10.0 on 2026-09-03. scip-typescript had 5 commits since 06-23 (last 2026-09-11), and scip-python has had none since 2025-09-05 ([scip-typescript](https://github.com/sourcegraph/scip-typescript); [scip-python](https://github.com/sourcegraph/scip-python)). stack-graphs is archived, last commit 2025-09-09 ([repo](https://github.com/github/stack-graphs)).
- **tree-sitter-language-pack** (now xberg-io, formerly kreuzberg; MIT; v1.16.0 of 2026-08-31) covers 371 languages. Only 9 `tags.scm` files and 1 `locals.scm` file exist in its tree ([repo](https://github.com/xberg-io/tree-sitter-language-pack)), which confirms that bundled query coverage is thin.
- **nvim-treesitter** (Apache-2.0, last bot update 2026-09-19) contains **151 `locals.scm`** files. Among them are bash, c, c_sharp, cpp, dart, go, java, javascript, kotlin, lua, php, python, ruby, rust, scala, swift, tsx and typescript ([repo tree](https://github.com/nvim-treesitter/nvim-treesitter); [LICENSE](https://github.com/nvim-treesitter/nvim-treesitter/blob/main/LICENSE)).
- **`node:sqlite` in production.** codegraph bundles Node 22.5+ because it "has a built-in real SQLite (`node:sqlite`, with WAL + FTS5)". It removed better-sqlite3 and its WASM SQLite fallback, the latter because of "database is locked" (issue #238) ([BUNDLING.md](https://github.com/colbymchenry/codegraph/blob/main/BUNDLING.md)). trace-mcp still uses better-sqlite3 and native `@ast-grep/napi` and `oxc-resolver` ([package.json](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/package.json)).
- **Fusion and reranking evidence.** Octocode's keyword-tilted RRF (0.7 BM25) beat dense-only by +22% Hit@5, and a generic cross-encoder regressed Hit@5 from 0.732 to 0.598 ([README](https://github.com/Muvon/octocode/blob/master/README.md)).
- **False-edge suppression.** axon filters 138 builtin and stdlib names (for example `print`, `len`, `console`, `setTimeout`, `useState`) before creating call edges ([README](https://github.com/harshkedia177/axon/blob/main/README.md)).
- **Zoekt** is still actively maintained (60 commits since 06-23; Apache-2.0) ([repo](https://github.com/sourcegraph/zoekt)).

### Inferences
- nvim-treesitter's locals queries are the cheapest way to close the "missing locals for 10 languages" gap noted in the prior report. They need porting, though. Neovim-only predicates and directives such as `#lua-match?` and `#set!` must be removed or rewritten, captures renamed from `@local.definition.*`/`@local.reference`/`@local.scope` to graph-indexer's own conventions, and node names checked against the pinned WASM grammar versions. As Apache-2.0 files they can ship inside an MIT project if the licence text and attribution are kept.
- Keeping embeddings in pure JS (a vocabulary table lookup plus mean pooling) is now more clearly right than depending on transformers.js.
- SCIP ingestion through the TypeScript bindings stays viable as an optional precision tier for TypeScript and Java-family code. It is not viable for Python, given scip-python's stalled activity.

### Gaps
- No open-source sparse n-gram (Cursor-style) index with a Node binding was found. The session's search budget ran out before this could be checked thoroughly.
- I did not verify whether ast-grep offers a WASM build usable from Node without `@ast-grep/napi`.
- I did not run a compatibility test of nvim-treesitter queries against the official WASM grammars graph-indexer vendors.

## 4. Who already implements "go to definition for every name in a read" (or an equivalent), and how agents respond

### Takeaway
Only **gopls** implements the exact semantics: its `go_file_context` walks every identifier in a file and lists the declarations it uses from other files, printing functions as doc plus signature and types, vars and consts as full declarations. It is compiler-precise, Go-only, and a separate tool the agent must call. Others approximate it. trace-mcp's `get_context_bundle` adds a symbol plus its import dependencies within a token budget. Codanna fuses a symbol with its callees, callers and impact. `codegraph_explore` returns bodies plus call paths. Continue's autocomplete adds LSP definitions of the types used around the cursor. **No project attaches such definitions automatically to the agent's own Read.** The evidence on how agents respond:

- Bodies of the focal code matter (signature-only bundles cost 15 points of comprehension).
- Dense payloads stay resident (+80%).
- Agents skip outputs they perceive as "compressed".
- A wrong "do not re-read" footer turns a miss into a refusal to look further.

### Cited Findings
- **gopls `go_file_context`.** For every `*ast.Ident` in the file it collects `info.Uses[id]` and `info.Defs[id]`, keeps objects defined in *other* files, groups them by file, and prints "Referenced declarations from <file> (package …)" with a summary of those declarations, telling the model "To read the full API of any package, use go_package_api" ([file_context.go](https://github.com/golang/tools/blob/master/gopls/internal/mcp/file_context.go)). The instructions describe it as showing "a summary of the declarations from other files in the same package" that a file uses ([instructions.md](https://github.com/golang/tools/blob/master/gopls/internal/mcp/instructions.md)). The shared `writeFileSummary` then prints, **for the referenced names only**, each function's doc comment plus its signature up to `decl.Type.End()` (no body). Referenced type, var and const declarations are dumped whole with their doc comment. When a specific set of declarations is requested, the file header (package clause and imports) is skipped ([context.go](https://github.com/golang/tools/blob/master/gopls/internal/mcp/context.go)).
- **trace-mcp `get_context_bundle`:** "Get a symbol's source code + its import dependencies + optional callers, packed within a token budget. Supports batch queries with shared-import deduplication… Returns JSON: { primary: [{ symbol_id, file, source }], imports: [{ file, source }], token_usage }". The default budget is 8,000 tokens and a batch holds up to 20 symbols ([context-tools.ts](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/src/tools/register/navigation/context-tools.ts)). Each item records whether the assembled context carries its body ("full") or a "signature-only fallback" ([context-bundle.ts](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/src/tools/navigation/context-bundle.ts)).
- **How agents responded to trace-mcp bundles** (60 merged bug-fix PRs, same model and prompts):
  - The first ("struck") run went from 65.0% to 50.0% of changes understood (−15 pp), with false positives per PR rising from 0.65 to 1.20. The cause was a bug that dropped all symbol bodies ("assembled signatures only").
  - After the fix, comprehension was **65.0% (naive) vs 66.7% (trace)** and false positives 0.58 vs 0.80, with median input tokens down 70.5% (later 72.7%).
  - On 42 of 60 PRs the budget still fell back to a signature for at least one changed symbol. `changed_symbol_readable` dropped from 100% to 71% and `dependent_readable` from 58% to 22%.

  Source: [ROADMAP.md](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/docs/ROADMAP.md).
- **`codegraph_explore`** returns verbatim source grouped by file, call paths between symbols (including "dynamic-dispatch hops (callbacks, React re-render, interface→impl) grep can't follow") and a blast radius. It also carries "a symbol's body as its callee list" ([README](https://github.com/colbymchenry/codegraph/blob/main/README.md)). Agent responses:
  - Claude's refusal "The codegraph output is heavily compressed, so I'm reading the strategy file directly" ([#1918](https://github.com/colbymchenry/codegraph/issues/1918)).
  - ~80% more retrieval context resident at the end of a session ([README](https://github.com/colbymchenry/codegraph/blob/main/README.md)).
  - A GPT-5-class agent got unrelated files plus "do NOT re-read them", "reported the tooling as unreliable and dropped the results" ([#1830](https://github.com/colbymchenry/codegraph/issues/1830)).
- **Codanna `semantic_search_with_context`** returns the symbol, signature, docstring, callees with call sites, callers and impact, followed by a "Guidance:" line ([README](https://github.com/bartolli/codanna/blob/main/README.md)).
- **Continue autocomplete.**
  - `RootPathContextService` takes the enclosing function and class nodes on the path to the cursor, runs per-language tree-sitter queries over their signatures, and calls `ide.gotoDefinition` for each match to add definition snippets ([RootPathContextService.ts](https://github.com/continuedev/continue/blob/main/core/autocomplete/context/root-path-context/RootPathContextService.ts)).
  - `ImportDefinitionsService` caches imported symbols' definitions for the 10 most recent files ([ImportDefinitionsService.ts](https://github.com/continuedev/continue/blob/main/core/autocomplete/context/ImportDefinitionsService.ts)).
  - `StaticContextService` works from a "hole type" and "relevant types" ([StaticContextService.ts](https://github.com/continuedev/continue/blob/main/core/autocomplete/context/static-context/StaticContextService.ts)).
- **Signature-only views that exist but carry no definitions:** Octocode `view_signatures` ([README](https://github.com/Muvon/octocode/blob/master/README.md)), repomix `--compress` ([README](https://github.com/yamadashy/repomix/blob/main/README.md)), SWE-agent `filemap` ([tools/](https://github.com/SWE-agent/SWE-agent/tree/main/tools)), and codebase-memory-mcp `get_file_outline` ([README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)).
- **Post-Read injection today** is limited to codebase-memory-mcp's coverage note, which fires only when the file is not reliably indexed ([hook_augment.c](https://github.com/DeusData/codebase-memory-mcp/blob/main/src/cli/hook_augment.c)). graphify's and tokensave's pre-read hooks nudge or block the agent; they do not augment ([graphify README](https://github.com/Graphify-Labs/graphify/blob/v8/README.md); [tokensave README](https://github.com/aovestdipaperino/tokensave/blob/master/README.md)).
- **Harness constraints on augmenting Read in Claude Code:**
  - Since 2.1.86, repeated identical Reads of an unchanged file are deduplicated into "Wasted call - file unchanged since your last Read". The hook then receives `{type:"file_unchanged"}` with no content, so a substituting hook is "cut out of the loop on every repeat". After `--resume`, the file-state cache records the hook's substituted text as if it were disk bytes. The dedup is gated by a remote flag (it fired in 7 of 11 sessions) ([#88118](https://github.com/anthropics/claude-code/issues/88118)).
  - Read never triggers PreToolUse for binary files in the Desktop app ([#93439](https://github.com/anthropics/claude-code/issues/93439)).
  - A hook without the executable bit "fails open" ([#94362](https://github.com/anthropics/claude-code/issues/94362)).

### Inferences
- The gopls semantics (identifier walk, resolve, group by defining file, signatures only, a pointer to more) is the right reference design, and graph-indexer can reproduce it without a compiler for any language its resolver covers. Signature-only is fine for *dependencies*, since the read itself keeps the focal bodies verbatim. trace-mcp's −15 pp came from losing the *focal* bodies, not the dependencies' bodies.
- Delivery should go through `additionalContext` appended after the Read, not through `updatedToolOutput` substitution. That avoids envelope mismatches, the dedup bypass (#88118) and any risk of corrupting what the agent believes is on disk. The `file_unchanged` payload also tells the hook when not to repeat itself.
- Attachments must dedupe across the session, stay well below the host's spill thresholds, and never tell the agent not to read.

### Gaps
- No study measures agents' behaviour when definitions arrive *automatically* after their own reads. The closest are codegraph's prompt-hook (no published effect) and trace-mcp's mirrors (compression, not augmentation).
- I found no quantitative result for Continue's LSP-definition autocomplete context in the repo.

## 5. Head-to-head comparisons, benchmarks, and adoption problems

### Takeaway
No neutral third party has compared code-intelligence MCP servers head to head. The best comparisons are vendor-run but unusually transparent. repowise measured call-graph precision and recall against compiler oracles for five tools, plus agent loops on three harnesses. The dominant adoption failure is the harness itself: under Claude Code's deferred MCP loading, tools were called 0–4 times in 15 questions, while under Codex the same tools were called on every question. For compressors there are independent A/Bs (JetBrains, Quesma), and they contradict the vendors.

### Cited Findings
- **Call-graph correctness vs compiler oracles (repowise, vendor-run).** The answer key is `golang.org/x/tools/go/callgraph/rta` over the fully type-checked program for Go, and "the `tsc` type checker's own resolution" for TypeScript: 37,853 oracle edges. Precision / recall per cell:

  | Cell | repowise | CodeGraph 1.5.0 | codebase-memory-mcp 0.10.8 | Graphify 0.9.31 | code-review-graph 2.3.7 |
  |---|---|---|---|---|---|
  | cobra (with tests) | .972 / .684 | .929 / .763 | .912 / .743 | .971 / .433 | .997 / .174 |
  | gitleaks (no tests) | .976 / .955 | .972 / .920 | .934 / .967 | .997 / .886 | .759 / .026 |
  | syft (no tests) | .943 / .513 | .872 / .508 | .635 / .542 | .771 / .447 | .968 / .201 |
  | zod (no tests) | .992 / .703 | .729 / .373 | .987 / .694 | .825 / .248 | .932 / .652 |
  | hono (no tests) | .977 / .731 | .805 / .684 | .949 / .686 | .980 / .688 | .966 / .691 |

  On syft, "more than a third of what the coverage leader emits is a call the Go compiler says does not exist". On cross-file coverage across 35 repos, "codebase-memory-mcp separates from us on 15 and we separate on none" ([BENCHMARKS.md](https://github.com/repowise-dev/repowise/blob/main/docs/BENCHMARKS.md)).
- **Agent loop, Codex (`gpt-5.6-sol`), 43 django questions, paired.** Output tokens against a bare agent were −31.6% for repowise (3.8 calls vs 7.2), −24.4% for CodeGraph, −14.8% for Serena (10.1 calls), −8.9% for Graphify and −6.0% for code-review-graph. "Every tool called on every question" ([BENCHMARKS.md](https://github.com/repowise-dev/repowise/blob/main/docs/BENCHMARKS.md)).
- **Agent loop, Claude Code (`claude-sonnet-5`), 15 questions.**

  | Tool | Tools advertised | Schema cost (chars) | Questions where it was used |
  |---|---|---|---|
  | repowise | 10 | 17,561 | 15/15 (reruns: 4/15, 3/15) |
  | CodeGraph | 1 | 1,567 | 13/15 (later 2/14) |
  | Serena | 29 | 29,050 | 4/15 |
  | code-review-graph | 30 | 28,118 | **0/15** |
  | Graphify | 10 | 5,482 | 3/15 |

  The explanation given: "Claude Code loads MCP tool schemas on demand, so the agent has to go looking before it can call anything, and frequently never does". Whether the cause is the model or the schema deferral was "inconclusive" (an Opus rerun scored 7/15) ([BENCHMARKS.md](https://github.com/repowise-dev/repowise/blob/main/docs/BENCHMARKS.md)).
- **File finding on 42 sealed ContextBench instances** (deterministic gold spans): repowise `get_answer` 0.876 (uses a hosted model), `search_codebase` 0.742, CodeGraph 0.610, Graphify 0.546, code-review-graph 0.445 (the best precision, 0.240), cocoindex 0.361 ([BENCHMARKS.md](https://github.com/repowise-dev/repowise/blob/main/docs/BENCHMARKS.md)).
- **trace-mcp's navigation guard, live** (11 tasks × 3 arms × 3 repeats = 99 runs, Sonnet 4.5, $12.76).
  - Light questions: geo-mean cost 0.975× when the guard intervenes on the first navigation call and 0.888× when it waits until 3 calls; all arms solved 18/18.
  - Crawls: 0.958× and 0.883×, with 12/15 solved against 13/15 for the bare agent.
  - An earlier eager-guard result of 1.39–1.45× "does not reproduce at this task size".

  Source: [crawl-detector-three-arm.md](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/benchmarks/crawl-detector-three-arm.md).
- **Compressors:** see Q2 (JetBrains, Quesma, Dasein).
- **Adoption and user reports** (new beyond the prior report):
  - codegraph: [#914](https://github.com/colbymchenry/codegraph/issues/914) the tool is not called in long tasks; [#1918](https://github.com/colbymchenry/codegraph/issues/1918) Claude avoids it despite rules; [#1474](https://github.com/colbymchenry/codegraph/issues/1474) stale index plus fresh disk read returns the wrong code; [#1902](https://github.com/colbymchenry/codegraph/issues/1902) a daemon writes to a stale DB.
  - graphify: [#2420](https://github.com/Graphify-Labs/graphify/issues/2420) silent cap at 20 connections.
  - context-mode: [#1003](https://github.com/mksglu/context-mode/issues/1003), [#1037](https://github.com/mksglu/context-mode/issues/1037), [#724](https://github.com/mksglu/context-mode/issues/724) (subagents and deferred tools).
  - RTK: [#2445](https://github.com/rtk-ai/rtk/issues/2445) silent rewrites trip injection heuristics.
  - codebase-memory-mcp: #858 (a 300 ms deadline silently killed hooks on cold start) ([hook_augment.c](https://github.com/DeusData/codebase-memory-mcp/blob/main/src/cli/hook_augment.c)).
  - GitNexus eval: its recommended mode is grep augmentation, but no resolve-rate result is published ([eval/README.md](https://github.com/abhigyanpatwari/GitNexus/blob/main/eval/README.md)).
- **Benchmark hygiene worth copying.**
  - codegraph blocks its own CLI in both arms, because "without that block the control arm is not a control" ([README](https://github.com/colbymchenry/codegraph/blob/main/README.md)).
  - GitNexus discovered that worktree-shared refs let one arm "adopt the finished work" of another ([workflow_bench/README.md](https://github.com/abhigyanpatwari/GitNexus/blob/main/eval/workflow_bench/README.md)).
  - trace-mcp gives every run its own naive column and preregisters its bars ([ROADMAP.md](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/docs/ROADMAP.md)).
  - Dasein ranks by cache-aware cost per solved task ([README](https://github.com/daseinlabs/code-compression-bench/blob/master/README.md)).

### Inferences
- The same tools look useful under Codex and nearly unused under Claude Code. The delivery channel (hooks, prompt hooks, `alwaysLoad`) now matters more than the tool's quality for Claude Code users. Small schemas also help: CodeGraph's single 1.6k-character tool was the only competitor used in 13/15 at first. graph-indexer should expect its MCP tools to be ignored by default in Claude Code and should design the hook path as the primary interface.
- On precision/recall, tree-sitter-only tools already reach 0.9+ precision and 0.5–0.97 recall on Go and TypeScript against compiler oracles. graph-indexer's own reference numbers (0.979 / 0.895 against TypeScript `findReferences`, per the prior report) are competitive and could be published on the same oracle protocol to make the claim comparable.

### Gaps
- All head-to-head numbers are vendor-run. repowise's agent-loop metric is *output* tokens, not total cost or resolve rate.
- No comparison includes graph-indexer, Codanna, Probe or GitNexus on the compiler-oracle protocol.
- No study isolates the effect of the prompt-hook or read-augmenting hooks on solve rate.

## Implications for graph-indexer

### Takeaway
There is little to reuse as a library. The competitive products are in other runtimes or carry incompatible licences, and graph-indexer's zero-native Node stack is already the same one codegraph uses. There is much to copy as technique and as a guard against known failure modes:

- Augment reads with gopls-style definition summaries through appended `additionalContext`.
- Adopt trace-mcp's and codebase-memory-mcp's hook contracts (exact envelopes, cache-safety, fail-open with breadcrumbs, coverage notes).
- Avoid codegraph's honesty failures (stale spans served as "verbatim", "do NOT re-read" footers).
- Port nvim-treesitter locals queries.
- Keep embeddings pure-JS.
- Measure with a compiler-oracle protocol and cache-aware cost per solved task.

Ignore command-output compressors and anything under PolyForm-NC, AGPL, ELv2, FSL or custom non-commercial licences.

### Cited Findings
- Licence facts that bound reuse:
  - MIT: codegraph, codebase-memory-mcp, trace-mcp, code-review-graph, semble, model2vec, CodeGraphContext, code-graph-rag, repomix, ast-grep, Kilo.
  - Apache-2.0: graphify, Codanna, Probe, Octocode, ck, headroom, RTK, lean-ctx, nvim-treesitter, transformers.js, SCIP, Zoekt.
  - BSD-3-Clause: gopls/x-tools, mcp-language-server, codedb.
  - PolyForm Noncommercial: GitNexus.
  - Non-commercial Dual-Use: jCodeMunch.
  - Personal-use: sdl-mcp.
  - AGPL-3.0: repowise, SocratiCode.
  - ELv2: context-mode, sqz.
  - FSL: Sourcebot, aoci-code.
  - GPL-3.0-or-later: Serena v2 application (SolidLSP MIT).
  - SONAR Source-Available: AutoCodeRover.
  - No licence: axon.

  All from each repo's LICENSE file as linked in Q1.

### Inferences

#### Ranked list
1. **Copy (technique): gopls-style "definitions of every used name" as the semantics of the new augmented read.** Walk the identifiers in the range just read. Resolve each through graph-indexer's scope, import and type-aware references. Group the definitions that live outside the range by defining file. Emit functions as signature plus a one-line doc and `path:line`, and short type, const and enum declarations in full, as gopls does (it prints whole type declarations and bodiless function signatures). Order entries by use count. Report unresolved or ambiguous names as counts, never as silence. Reference: [file_context.go](https://github.com/golang/tools/blob/master/gopls/internal/mcp/file_context.go). BSD-3 is compatible, but this is a design copy, not a code copy (Go/types-specific). Keep the Read's own content verbatim, since focal bodies matter (trace-mcp −15 pp). Dependencies can stay as signatures.
2. **Copy (technique and some MIT code): trace-mcp's hook engineering.**
   - Deliver through `PostToolUse` on the newest message only, which is cache-safe (measured −95% cache writes, 0 breaks).
   - Preserve the exact Read/Bash envelopes if substitution is ever used, since a mismatch is dropped silently.
   - Pass through below ~2,000 characters.
   - Use content-addressed, deterministic outputs.
   - Never filter Read content.
   - Exempt your own spill paths.

   For graph-indexer, prefer `additionalContext` over `updatedToolOutput`, because of Claude Code's Read dedup ([#88118](https://github.com/anthropics/claude-code/issues/88118)) and to avoid altering what the agent believes the file contains. MIT, attribution only.
3. **Copy (guards): lessons from codegraph's failures** (MIT; the design twin).
   - Revalidate every attached span against the current file hash before claiming it is current (#1474).
   - Never emit "do not re-read" or "complete source" footers, and above all never when any part of the query was unmatched (#1830).
   - Dedupe definitions already delivered in the session to limit resident context (+80% residual).
   - Keep payloads small enough not to read as "heavily compressed" noise (#1918).
   - Consider the single-strong-tool plus unlisted-tools pattern and a `UserPromptSubmit` prompt-hook for structural prompts.

   Its vendored-Node bundling proves `node:sqlite` with WAL and FTS5 in the field.
4. **Copy (hook contract): codebase-memory-mcp.**
   - The hook never blocks.
   - The deadline is configurable (2 s default, not 300 ms) and writes a breadcrumb when it fires, so "deadline" is distinguishable from "no matches".
   - Post-Read coverage notes ("this file was only partially indexed; read source directly").
   - `check_index_coverage` wording ("clean means no recorded gap, not proof of completeness").
   - Hooks are withheld on clients where injected output is not reliably consumed (Cursor, Cline).

   MIT.
5. **Reuse (data): nvim-treesitter `locals.scm`** (Apache-2.0; 151 files covering all 17 target languages) as the starting point for the locals queries that do not exist yet. Port the predicates and captures and test them against the vendored WASM grammars. Ship with the Apache licence text and attribution; this is compatible with an MIT distribution.
6. **Reuse (model) and avoid (library): potion-code-16M-v2 through a pure-JS Model2Vec implementation** (model2vec MIT; model MIT per the prior report). **Do not** take transformers.js 4.3.0 as a dependency (native `onnxruntime-node` and `sharp`). Use Octocode's evidence (keyword-tilted fusion +22% Hit@5; generic reranker −0.134 Hit@5) to keep BM25 dominant for identifier-shaped queries.
7. **Copy (output format and CLI mode): Codanna** (Apache-2.0). Symbol, signature, doc, callees with call sites, callers and impact in one block with `symbol_id`s and a guidance line. A one-shot `graph-indexer mcp <tool> args` path for hooks and skills without a daemon. Copy Probe's "complete AST block per hit" and session dedup as well (Apache-2.0).
8. **Integrate (optional precision tier): SCIP** via its TypeScript bindings when `index.scip` exists (Apache-2.0). Do not plan on scip-python (idle since 2025-09). Treat gopls MCP as a complementary server for Go users, not a dependency.
9. **Copy (evaluation protocol).** repowise's compiler-oracle precision/recall (Go `callgraph/rta`, `tsc`), which would put graph-indexer's call graph on the same scale as the numbers published for codebase-memory-mcp, CodeGraph, Graphify and code-review-graph. Dasein's cache-aware cost per solved task, with cache read:write reported. codegraph's rule of blocking the tool's CLI in the control arm. trace-mcp's preregistered bars and naive column per run. Methodology only; no licence issue.
10. **Copy (surface design):** keep the always-visible MCP surface tiny. The repowise data shows Claude Code usage collapses with deferred schemas, a 29–30-tool surface was used 0–4/15, and a single ~1.6k-character tool was used most. sdl-mcp's "gateway" (4 namespace tools) and codegraph's single tool are precedents. Deliver the value through hooks.
11. **Ignore: command-output compressors as integrations** (RTK, headroom, context-mode, sqz, caveman). Measured cost is neutral to negative in agentic coding (JetBrains +7.6%, Quesma +1% to +17%, Dasein +13% and +44%). There are correctness bugs (hidden compiler errors, corrupted rg output), and context-mode and sqz are ELv2. Keep only the lessons: do not rewrite the agent's commands, do not rewrite cached prefixes, measure dollars rather than bytes/4.
12. **Ignore as sources of code: GitNexus** (PolyForm-NC), **jCodeMunch** (non-commercial), **sdl-mcp** (personal-use), **repowise and SocratiCode** (AGPL), **Sourcebot and aoci-code** (FSL), **axon** (no licence), **AutoCodeRover** (Sonar), **Serena v2** (GPL). Ideas and measurements may still be cited.
13. **Ignore as architecture:** anything that needs an external DB or service (claude-context/Milvus, CodeGraphContext/Kùzu-Neo4j, code-graph-rag/Memgraph, SocratiCode/Qdrant+Ollama+Docker, mgrep/cloud, Kodit). Also skip stale LSP bridges (mcp-language-server, lsp-mcp) and IDE-harness indexers that are shut down or dormant (Roo, Continue @Codebase, Aider repo map, whose ideas are already absorbed).

### Gaps
- No controlled evidence yet that definition-augmented reads improve solve rate or cost. The recommended design rests on mechanism evidence (cache, envelopes, adoption) and on analogues (the gopls semantics, trace-mcp's bundles), so graph-indexer's own A/B is needed.
- I did not verify the potion-code-16M-v2 licence at the source in this session (Hugging Face blocked). Recheck it before bundling.
- I did not verify that nvim-treesitter queries run unmodified on web-tree-sitter 0.25 with the vendored grammars.
