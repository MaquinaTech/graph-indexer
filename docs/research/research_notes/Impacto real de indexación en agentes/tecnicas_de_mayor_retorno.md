# Highest-return techniques a local, zero-dependency code-intelligence engine can add to help AI coding agents (state as of 2026-09-22)

Access notes: huggingface.co, arxiv.org, cursor.com, jestjs.io, vitest.dev and most doc sites were blocked by the egress proxy this session, and PyPI, npm and crates.io were blocked too. The web-search budget was exhausted near the end.
- Primary facts come from **git clones of the GitHub repositories**. Paper facts marked "(search summary)" come from search-engine abstracts, because arXiv was blocked.
- The potion-code-16M-v2 facts come from a **vendored copy of the Hugging Face files**. Their SHA-256 matches the hashes pinned by an independent project (zvec-grep).
- Figures labelled **"own measurement"** were produced in this session with Node v22.22.2 on a 4-vCPU Intel Xeon @ 2.10 GHz.
- This builds on `notes/local_models_and_ranking.md` and `notes/static_analysis_incremental.md` (BM25F, stack graphs/SCIP, freshness, Ekstazi/STARTS/TCTracer background) and does not repeat them.

---

## 1. Unified text + structure search: making grep structure-aware

### Takeaway
The designs that work do not replace grep. They **annotate and rank grep hits with structure**:
- Label each hit as definition, reference, comment or string. Zoekt scores symbol-overlapping matches at 7,000 vs 500 for a plain word match; cs weights code 1.0 vs comments 0.2.
- Return or group by the **enclosing unit**. probe, ck `--full-section` and Semble do this, and cAST AST-chunking gives +4.3 Recall@5 and +2.67 SWE-bench Pass@1.
- Tie identifier hits to the definition they resolve to. This is Sourcegraph's precise > syntactic > search-based ladder.
- Use an **index to make regex instant**. Cursor's Instant Grep went from 16.8 s to 13 ms. graph-indexer can get the same effect from SQLite FTS5's built-in trigram tokenizer: my own measurement gave 0.2–0.4 ms substring queries at 1.56x raw size.

Evidence of agent benefit is mostly vendor-reported token savings (Semble 348 vs 45,587 tokens/query; mgrep ~2x; codebase-memory 10x). The one semi-independent agent comparison shows a **quality cost when agents rely only on the structured tool**: 83% vs 92% answer quality.

### Cited Findings

**Evidence that structured/ranked search helps agents (and its limits)**
- Semble's context-efficiency benchmark (1,251 queries) models the agent workflow of grep then read. Methodology:
  - The baseline runs `rg --fixed-strings --ignore-case` per keyword and reads matched files ranked by distinct keywords; Semble returns top-50 chunks. Tokens are counted with `cl100k_base`.
  - Expected tokens to the first relevant hit: **348 (semble) vs 45,587 (ripgrep + read file)**.
  - Recall at fixed budgets, semble vs ripgrep+read: 500 tok **0.842** vs 0.001; 2k **0.967** vs 0.037; 8k 0.995 vs 0.207; 32k 0.995 vs 0.583.
  
  This is a simulation, not agent runs. — [Semble benchmarks README](https://github.com/MinishLab/semble/blob/main/benchmarks/README.md)
- The Codebase-Memory preprint (tree-sitter knowledge graph over MCP) was evaluated on 31 real repositories:
  - **83% answer quality vs 92% for a file-exploration agent**, with **10x fewer tokens and 2.1x fewer tool calls**.
  - On graph-native queries (hub detection, caller ranking) it matches or exceeds the explorer on 19 of 31 languages.
  
  — [arXiv 2603.27277](https://arxiv.org/abs/2603.27277) (search summary). The README separately claims "5 structural queries: ~3,400 tokens vs ~412,000 via file-by-file search" (99.2% reduction) — [codebase-memory-mcp README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)
- mgrep ran a 50-task QA benchmark with Claude Code: "~2x fewer tokens than grep-based workflows at similar or better judged quality". Win rate was judged by an LLM, and mgrep syncs files to a Mixedbread cloud store. — [mgrep README](https://github.com/mixedbread-ai/mgrep/blob/main/README.md)
- Cursor Instant Grep cut regex search latency from **16.8 s with ripgrep to 13 ms** in Cursor's internal benchmark. It is a local index (n-grams + inverted index + bloom filters). Cursor does not upload paths or code to build it, and it says the tool "dramatically speeds up how fast agents complete tasks" (no number). — [Analytics India Mag](https://analyticsindiamag.com/ai-news/cursor-delivers-99-faster-ai-code-search-with-instant-grep), [Cursor on X](https://x.com/cursor_ai/status/2036122609931165985), [Rohan Paul on X](https://x.com/rohanpaul_ai/status/2036150628712587449). The primary blog ([cursor.com/blog/fast-regex-search](https://cursor.com/blog/fast-regex-search)) was blocked.
- Instant Grep mechanism, per the secondary summaries:
  - Start from trigrams, then move to **sparse n-grams** (a chosen subset of fragments) because plain trigrams are noisy.
  - Decompose the regex into required literal pieces, look up candidate files, then run the real regex only on those files.
  
  — [Rohan Paul on X](https://x.com/rohanpaul_ai/status/2036150628712587449), [Aihola](https://aihola.com/article/cursor-instant-grep-search-index). Open reimplementations exist: [polargrep](https://www.polarity.so/research/polargrep) ("2,167x faster regex search with sparse n-gram indexing", title only) and [GrowlyX/instantgrep](https://github.com/GrowlyX/instantgrep) (Elixir).
- AST-structured chunking (cAST) recursively splits large AST nodes and merges siblings under a size limit. It beats fixed-size chunking by **+4.3 Recall@5 on RepoEval and +2.67 Pass@1 on SWE-bench generation**. — [cAST, arXiv 2506.15655 / EMNLP Findings 2025](https://aclanthology.org/2025.findings-emnlp.430/) (search summary)
- Prior-round evidence, not repeated here: Cursor semantic search (+12.5% QA accuracy), the claude-context 40% token claim, and Claude Code's LSP tool — see `notes/industry_agent_retrieval.md`.

**Designs in existing implementations**
- **Zoekt scoring constants** (Sourcegraph's engine), from `index/contentprovider.go`, commit 2026-09-11:
  - `scoreWordMatch=500`, `scorePartialWordMatch=50`, `scoreSymbol=7000`, `scorePartialSymbol=4000`, `scoreKindMatch=100`, `scoreFactorAtomMatch=400`. All query-dependent signals are "bounded at ~9000". Tiebreakers are `scoreRepoRankFactor=100` and `scoreFileOrderFactor=10`.
  - A content match counts as a **symbol match if it overlaps a ctags symbol section**. `findMaxOverlappingSection` picks the section with the largest relative overlap.
  - `scoreSymbolKind` default factors: Class 10, Struct 9.5, Enum 9, Interface 8, Type 8, Function/Method 7, Field 5.5, Constant 5, Variable 4, other 1. There are per-language overrides; for Go: Interface 10, Struct/Type/TypeAlias 9, MethodSpec 8.5, Function/Method 8, Field 7.
  
  — [zoekt/index/contentprovider.go](https://github.com/sourcegraph/zoekt/blob/main/index/contentprovider.go)
- **Zoekt BM25 mode**, from `index/score.go`:
  - k=1.2 and b=0.75 (Lucene defaults). Line length is normalized against an assumed 100-character average line, and IDF is skipped.
  - Filename and symbol matches count **5x** in term frequency (`importantTermBoost = 5`).
  - "Low priority" files (tests, generated) have their term frequency divided by 5 (`lowPriorityFilePenalty = 5`). The code comment calls this a BM25F "separate field", although it says "half the priority" while the code divides by 5.
  
  — [zoekt/index/score.go](https://github.com/sourcegraph/zoekt/blob/main/index/score.go)
- **Sourcegraph navigation tiers:**
  - *Search-based* navigation uses ctags/tree-sitter heuristics. It gives more false positives for common names such as `Get`. — [search-based docs](https://4.0.sourcegraph.com/code_navigation/explanations/search_based_code_navigation)
  - *Syntactic* navigation is "zero configuration", periodic indexing "using high level syntax analysis heuristics". It needs no build tools or compilers, runs isolated with no network, and is chosen over search-based navigation when precise data is missing. — [Syntactic Code Navigation](https://sourcegraph.com/docs/code-navigation/syntactic-code-navigation) (search summary)
  - *Precise* navigation uses SCIP and is "compiler-accurate". — [precise docs](https://sourcegraph.com/docs/code_navigation/explanations/precise_code_navigation)
- **cs (Code Spelunker)** has no index:
  - It parses every file on the fly to tell code, comments and strings apart. A match in code ranks higher than the same word in a comment "(1.0 vs 0.2)", and this is configurable.
  - Filters: `--only-code`, `--only-comments`, `--only-strings`, `--only-declarations`.
  - Ranking: a declaration-line boost, BM25, "complexity gravity" (cyclomatic complexity), test-file dampening and a noise penalty for data blobs. It ships an MCP server.
  
  It scored 0.200 NDCG@10 on Semble's benchmark. — [cs README](https://github.com/boyter/cs/blob/master/README.md); [Semble benchmarks](https://github.com/MinishLab/semble/blob/main/benchmarks/README.md)
- **probe** returns "complete functions/classes" (AST blocks). It uses Elasticsearch-style boolean queries with BM25, has token awareness (`--max-tokens`, session dedup) and AST pattern queries (`probe query "fn $NAME($$$) -> Result<$RET>"`). Its thesis: "AI agents don't need embedding search" because the LLM translates intent into precise queries. It scored 0.387 on Semble's benchmark. — [probe README](https://github.com/probelabs/probe/blob/main/README.md)
- **ck**: `ck --sem --full-section` "returns entire functions". It offers hybrid regex + semantic search and chunk-level incremental re-embedding (80–90% cache hit), and recommends JSONL output for agents. It scored 0.642 on Semble's benchmark (bge-small-en-v1.5; index 96 s; p50 187 ms). — [ck README](https://github.com/BeaconBay/ck/blob/main/README.md); [Semble benchmarks](https://github.com/MinishLab/semble/blob/main/benchmarks/README.md)
- **ColGREP** (LightOn, Apache-2.0):
  - Search pipeline: a regex pre-filter narrows candidates, then semantic ranking with LateOn-Code-edge (17M parameters, multi-vector, "~300 embeddings of dimension 128 per document", ONNX Runtime, 2/4-bit product quantization).
  - Its **SQLite FTS5 index uses a trigram tokenizer** over "names, signatures, file paths, source code, docstrings, parameters, imports, and call graph".
  - Each code unit is embedded with a structured header: `# Function`, `# Signature`, `# Description`, `# Parameters`, `# Returns`, `# Calls`, `# Variables`, `# Uses`, `# File`.
  - It installs Claude Code session and task hooks so that it becomes the primary search tool, including in sub-agents.
  
  — [ColGREP README](https://github.com/lightonai/next-plaid/blob/main/colgrep/README.md); [next-plaid README](https://github.com/lightonai/next-plaid/blob/main/README.md)
- **Semble's ranking signals on top of fused retrieval:**
  - Definition boosts: an additive boost with `_DEFINITION_BOOST_MULTIPLIER = 3.0`, scaled from the maximum candidate score. `_DEFINITION_KEYWORDS` covers class/def/func/fn/struct/trait/…, plus SQL `CREATE TABLE`.
  - Identifier-stem matching.
  - A file-coherence boost of 0.2 × max score.
  - Path penalties: test files, compat/legacy and examples ×0.3; re-export/metadata files ×0.5; `.d.ts` ×0.7.
  - A per-file saturation decay.
  
  — [boosting.py](https://github.com/MinishLab/semble/blob/main/src/semble/ranking/boosting.py), [penalties.py](https://github.com/MinishLab/semble/blob/main/src/semble/ranking/penalties.py)
- **SQLite FTS5 trigram tokenizer:**
  - It supports general substring matching and accelerates `LIKE`/`GLOB`. Substrings under 3 characters match nothing.
  - A pattern without a ≥3-character literal run falls back to a linear scan.
  - The `case_sensitive=1` option makes only `GLOB` indexable.
  - `detail=none`/`detail=column` shrink the index, but full-text queries then cannot contain tokens longer than 3 characters.
  
  — [SQLite FTS5 docs](https://sqlite.org/fts5.html) (search summary)
- **Own measurement** (node:sqlite in Node 22.22.2; 435 source files, 3.70 MB of Go/Python/TS/Rust; content stored in the FTS table):

  | Setting | Index size | Build time | Substring query latency |
  | --- | --- | --- | --- |
  | trigram `detail=full` | 17.18 MB (4.64x raw) | 483 ms | LIKE/GLOB 0.3–0.4 ms; phrase MATCH 0.1 ms |
  | trigram `detail=none` | **5.79 MB (1.56x raw)** | 336 ms | LIKE/GLOB 0.2–0.3 ms |
  | Baseline: in-memory JS `RegExp` scan of the same 3.7 MB | — | — | 3.8 ms, excluding disk reads |

### Inferences
- **Recommended tool.** Build a grep-compatible `search_text(pattern, regex?, scope?)` whose hits are **grouped by innermost enclosing definition**. Each hit carries four annotations:
  1. The role of the match (def / ref / import / comment / string / test).
  2. For identifier hits, the **resolved target** from graph-indexer's existing reference graph.
  3. A caller count, so the agent can triage.
  4. Zoekt-style scoring: definition overlap far above plain word matches, tests/generated/vendor divided down, and kind priority.
  
  Output should be capped by a token budget with "N more hits in M symbols; refine with …".
- **Backend.** Use an FTS5 trigram table (`detail=none` or an external-content/contentless table, since graph-indexer already stores file text) as a literal prefilter, then confirm with JS `RegExp` on the candidate files. This has **no new dependency**: trigram is built into SQLite. Extra disk is ~0.6x raw text at `detail=none` (my arithmetic from the 5.79 MB measurement minus the 3.70 MB content). Rebuild cost is ~0.1 s per MB.
- **Classify hits without re-parsing.** At index time, store per-file interval lists of comment and string ranges plus definition ranges, taken from the tree-sitter parse graph-indexer already does. Each hit is then labelled with a binary search. A definition-range lookup gives the enclosing symbol, which is the SCIP `enclosing_range` idea.
- **Why this ranks first.** Agents already call grep: Claude Code chose "agentic search" (see prior notes), so a better grep has the lowest adoption friction. The Codebase-Memory result (83% vs 92% quality) argues for *augmenting* reads rather than replacing them. Keep raw line output available.
- **Pitfalls:**
  - Regexes without a ≥3-character literal, `.*`-heavy patterns, and case-insensitive patterns on a case-sensitive index fall back to scans.
  - Multi-line regexes.
  - Minified, generated or huge files should be excluded or down-weighted.
  - The index must be fresh; stat-before-serve is covered in prior notes.
  - Common-name identifier hits (`get`, `init`) resolve ambiguously. Show "ambiguous: N candidates" rather than one wrong target.

### Gaps
- The Instant Grep index size, build cost and incremental-update cost could not be retrieved (cursor.com blocked).
- No controlled study was found that isolates "structure-aware grep" versus plain grep on agent task success. All token-saving figures are vendor-run or simulated.
- FTS5 trigram size and latency were measured only on a 3.7 MB corpus, not on a large monorepo.
- No published evidence was found on ast-grep's effect on agents. ast-grep is a structural search/lint/rewrite tool — [ast-grep README](https://github.com/ast-grep/ast-grep/blob/main/README.md).

---

## 2. Edit-time diagnostics without a build

### Takeaway
Cheap post-edit checks measurably help agents. In SWE-agent, a lint guardrail was worth **+3 points** on SWE-bench Lite, and removing the dedicated editor cost 7.7 points. Multi-file refactoring is a weak spot: agents solve **22% vs 87%** for humans on RefactorBench.

The highest-value build-free diagnostics a resolved reference graph can offer:
1. Syntax errors from tree-sitter ERROR/MISSING nodes.
2. Imports of names the target module no longer exports (the `import/named` rule).
3. **References and callers still pointing at a removed or renamed symbol, or with the wrong arity after a signature change.**
4. Pyflakes-class undefined names.

Precision must be managed with confidence tiers. Static call graphs miss ~11% of reachable methods even in Java, and name-based resolution has false positives on common names.

### Cited Findings
- **SWE-agent ACI ablation** (NeurIPS 2024):
  - Linting guardrails on edits recover **3 percentage points** over the same editing interface without linting.
  - Removing the dedicated file editor drops performance from **18.0% to 10.3%** (↓7.7) on SWE-bench Lite.
  
  — [SWE-agent paper](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf) (search summary)
- **RefactorBench** (ICLR 2025) has 100 handcrafted multi-file refactoring tasks. LM agents solve **22%** with base instructions, versus **87%** for time-constrained human developers. Conditioning the agent on state representations gave a **43.9%** improvement. — [arXiv 2503.07832](https://arxiv.org/abs/2503.07832), [Microsoft Research](https://www.microsoft.com/en-us/research/publication/refactorbench-evaluating-stateful-reasoning-in-language-agents-through-code/) (search summary)
- **Kiro production telemetry** (Jan–Jun 2026): about 1.5M conversations across seven Claude models, with **406K invocations** of a built-in diagnostics tool that "runs after the coding agent performs file edits" using static-analysis extensions. — [Kiro blog](https://kiro.dev/blog/diagnostics-over-time/) (search summary; page not read)
- **Aider's post-edit lint** (`aider/linter.py`):
  - For Python it runs flake8 restricted to **fatal codes only**: `E9,F821,F823,F831,F406,F407,F701,F702,F704,F706`.
  - For every language it runs a tree-sitter `basic_lint` that reports lines with `ERROR` or `is_missing` nodes.
  
  — [aider linter.py](https://github.com/Aider-AI/aider/blob/main/aider/linter.py)
- **Meaning of those codes:** F821 undefined name; F823 local variable referenced before assignment; F831 duplicate argument; F406 `from x import *` only at module level; F407 undefined `__future__` feature; F701/F702 `break`/`continue` outside a loop; F704 `yield` outside a function; F706 `return` outside a function. — [flake8 error codes](https://github.com/PyCQA/flake8/blob/main/docs/source/user/error-codes.rst)
- **eslint-plugin-import `import/named`** "Verifies that all named imports are part of the set of named exports in the referenced module". It does the same for re-exports.
  - Modules that are ignored, or are not "unambiguously an ES module", are not reported.
  - The rule is **disabled in the plugin's `typescript` config**, because tsc covers it.
  
  — [import/named docs](https://github.com/import-js/eslint-plugin-import/blob/main/docs/rules/named.md)
- **Confidence-tiered edges in 2026 tools:**
  - codebase-memory-mcp separates three edge kinds:
    - `CALLS`
    - `CALL_REFERENCE`, which "resolves to one exact target"
    - `USAGE`: "an identifier is used, but a unique callable target is not proven"
  - It also ships a "Hybrid LSP", a C reimplementation of type-resolution algorithms "inspired by" tsserver, pyright, gopls and others, for 10+ languages.
  - It reports per-language quality tiers across 64 repositories: "Excellent (≥90%)" for C, C++, Kotlin, Lua and others; "Good (75–89%)" for Python, TypeScript, Go, Rust, Java and JavaScript. The metric is not defined in the README.
  
  — [codebase-memory-mcp README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)
- ast-bro uses a three-pass resolver (same-file → global symbol table → dep-graph disambiguation) that "tags every edge `Exact` / `Inferred` / `Ambiguous` so you can filter by precision". — [ast-bro README](https://github.com/aeroxy/ast-bro)
- **Recall ceiling of static call graphs** (Java, ICSE 2020): static analysis "misses around 11% of known reachable methods", with median recall 0.884. The built-in-test oracle gives 0.859 and the generated-test oracle 0.904. — [On the Recall of Static Call Graph Construction in Practice](https://dl.acm.org/doi/pdf/10.1145/3377811.3380441) (search summary). In JavaScript call graphs, "dynamic property accesses were the most common root cause of missed edges". — [Dagstuhl artifact](https://drops.dagstuhl.de/entities/document/10.4230/DARTS.8.2.7) (search summary)
- Sourcegraph states that search-based (heuristic) navigation can return false positives and false negatives, especially for common names, while SCIP-based precise navigation is "compiler-accurate". — [Sourcegraph precise docs](https://sourcegraph.com/docs/code_navigation/explanations/precise_code_navigation)
- Background from prior notes: stack graphs were archived on 2025-09-09; SCIP, Kythe and Glean all need builds. See `notes/static_analysis_incremental.md` §2.

### Inferences
- **Proposed `check_changes` tool, optionally a PostToolUse hook.** It runs over the files and symbols touched since a baseline (a git ref or the last index snapshot). Checks are ordered by expected precision:
  1. **Syntax**: tree-sitter `ERROR`/`MISSING` nodes in edited files. This is ~100% precise and is what Aider uses. Cost is re-parsing only the edited files (milliseconds).
  2. **Broken imports**: a named import or re-export whose target module (a relative path, or a resolved in-repo package) no longer defines or exports that name. This is the `import/named` logic.
     - Skip `export *` chains the engine cannot close, CommonJS `require` with computed paths, and anything under node_modules or site-packages.
     - Honour `tsconfig` `paths` and baseUrl.
  3. **Stale references after a rename or delete.** Diff the per-file definition tables (old vs new). For each removed or renamed definition, list incoming edges from *other* files that are still unresolved in the new state.
     - Report only edges at the "exact"/"resolved" tier. Downgrade name-only matches of common identifiers to "possible".
     - This is the check an LSP-less agent cannot do cheaply, and it targets the RefactorBench failure mode.
  4. **Arity and signature drift**: for resolved calls to a changed function, compare argument count against the parameter spec (required, optional/default, rest/`*args`, keyword-only/`**kwargs`, TS/Java overloads).
     - Skip spread or `*args` call sites, decorators and wrappers, `functools.partial`/bind, dynamic dispatch through interfaces, and default-exported re-bindings.
     - Precision is expected to be moderate, so make it opt-in or report it as "review".
  5. **Undefined names in edited files**: a pyflakes-like scope pass using `locals.scm`-style scopes plus per-language builtins and globals lists. Precision is good within a file; imports should be treated as definitions.
- **Presentation.** Emit at most ~20 findings, each as `path:line`, the rule, a one-line reason, the confidence tier, and a suggested fix target (for example, the list of callers to update). Always add "if available, run `tsc --noEmit` / `pyright` / `go vet` for authoritative checking".
  - Never block edits.
  - Batch reporting to the end of a multi-edit sequence, because mid-refactor states are transiently broken.
- **Cost.** All checks reuse graph-indexer's existing incremental index: re-index the touched files, then run set-difference and reverse-edge queries. This should take tens of milliseconds for typical edits (my estimate) and needs no dependencies.
- **Pitfalls.** False positives are costly because agents follow tool output. The AGENTS.md study found that instructions in context files are well followed ([arXiv 2602.11988](https://arxiv.org/abs/2602.11988), search summary), so a wrong "error" can trigger wasted edits. Keep tiers explicit and default to high-precision checks only.
  - Dynamic languages need care: Python `__getattr__`, monkey-patching, JS computed members.
  - Generated code and codegen-dependent imports (protobuf, GraphQL) need care.
  - Conditional or platform-specific definitions need care.

### Gaps
- No published precision/recall numbers were found for tree-sitter-level "unresolved reference", "stale caller" or "arity mismatch" diagnostics. They should be measured on graph-indexer's own benchmark, for example by replaying real rename and signature-change commits.
- The Kiro diagnostics study's outcome numbers (error rates, trend by model) and Meta's "Agentic Program Repair from Test Failures at Scale" ([arXiv 2507.18755](https://arxiv.org/pdf/2507.18755)) could not be read (blocked or out of search budget).
- The SWE-agent figures come from search summaries of the paper, not from the PDF itself.

---

## 3. Change impact and test selection (without coverage) and how to hand it to an agent

### Takeaway
The strongest 2026 result is **NameRTS** (May 2026, Python). It builds a bipartite graph of code elements and *names* and selects a test if a changed element is reachable from the names the test uses. It **skips 69.90% of test files, cuts end-to-end test time 45.59%, and selects every affected test in 99.6% of commits**, and it needs no call graph. This maps almost directly onto graph-indexer's definition/reference tables.

Safe fallbacks exist. File-level import closure (BabelRTS: regex-based, 12 languages) and the runners' own "related tests" modes (Jest `--findRelatedTests`, `vitest related`) cover it. They have documented blind spots: dynamic imports and `require`.

Present results as tiered lists plus one copy-pasteable command per runner.

### Cited Findings
- **NameRTS** (arXiv 2605.25356, 2026-05-25):
  - Design: it models "a Python program as a bipartite graph of code element nodes and name nodes" (classes, functions and globals vs the identifiers that reference them). RTS becomes reachability: select a test "if any modified code element is reachable from the names used in that test". This avoids call-graph construction and is "conservative… amenable to safety". Two pruning strategies (prior test executions, context information) limit cascades from coarse name matching.
  - Results: it **skips 69.90% of test files on average** (146.5% better than BabelRTS) and **reduces end-to-end testing time by 45.59%** (107.7% better than BabelRTS). It "selects all affected tests for 99.6% of commits".
  
  — [arXiv 2605.25356](https://arxiv.org/abs/2605.25356) (search summary); code and ground truth are in [ZJU-CTAG/NameRTS](https://github.com/ZJU-CTAG/NameRTS) (flags `--prune-cf`, `--prune-nem`)
- **BabelRTS** (IEEE TSE 2025): language-agnostic static RTS using "regex-based rules to extract file-level dependencies", written as patterns plus actions.
  - Coverage: 12 languages and 5 language combinations, evaluated on 142 SUTs with more than 2 billion LOC.
  - On single-language SUTs it matches state-of-the-art single-language tools. On polyglot SUTs, polyglot mode was safer and selected more tests for 60% of commits.
  
  — [BabelRTS, IEEE TSE](https://ieeexplore.ieee.org/document/10944548/) (search summary)
- **Jest CLI:**
  - `--findRelatedTests <spaceSeparatedListOfSourceFiles>`: "Find and run the tests that cover a space separated list of source files… Useful for pre-commit hook integration to run the minimal amount of tests necessary".
  - `--onlyChanged`/`-o` needs git/hg and "requires a static dependency graph (ie. no dynamic requires)".
  - `--changedSince <branch|commit>` runs tests related to changes since that ref.
  - `--listTests` "Lists all test files that Jest will run given the arguments, and exits".
  
  — [Jest docs/CLI.md](https://github.com/jestjs/jest/blob/main/docs/CLI.md)
- **Vitest CLI:** `vitest related /src/index.ts …` "Run[s] only tests that cover a list of source files. Works with static imports… but not the dynamic ones (e.g., `import(filepath)`)". Pass `--run` outside watch mode. — [Vitest docs/guide/cli.md](https://github.com/vitest-dev/vitest/blob/main/docs/guide/cli.md)
- **Other runners** (verified from local `--help` output or official docs this session):
  - pytest takes `file_or_dir` positional arguments (node IDs such as `path::Class::test`). `-k EXPRESSION` substring-matches test names and parent classes, and `--lf` reruns last failures. — [pytest usage docs](https://docs.pytest.org/en/stable/how-to/usage.html) (verified via `pytest --help`)
  - `go test -run regexp` runs "only those tests, examples, and fuzz tests matching the regular expression", split by `/` per subtest level. — [Go testing flags](https://pkg.go.dev/cmd/go#hdr-Testing_flags) (verified via `go help testflag`)
  - `cargo test [TESTNAME]` runs "only… tests containing this string in their names". — [cargo test](https://doc.rust-lang.org/cargo/commands/cargo-test.html) (verified via `cargo test --help`)
  - Maven Surefire: `mvn -Dtest=TestCircle test`. — [Surefire "Running a Single Test"](https://github.com/apache/maven-surefire/blob/master/maven-surefire-plugin/src/site/markdown/examples/single-test.md.vm)
- **Agent Retrieval Bench `code2test`** (106 samples: PR intent → related tests):
  - Qwen3-Embedding-4B has the best `code2test` MRR.
  - A post-hoc RRF of Qwen3-Embedding-8B with RepoMap reaches `code2test` R@20 **0.6972**, MRR **0.2811**.
  - ARB's RepoMap adds explicit **source↔test edges** (weight 2.0) between files that share a canonical test/source key.
  
  — [ARB paper source](https://github.com/eyuansu62/agent-retrieval-bench/blob/main/paper/main.tex), [repomap_eval.py](https://github.com/eyuansu62/agent-retrieval-bench/blob/main/src/agent_retrieval_bench/repomap_eval.py)
- **Reusable naming-convention patterns.** Semble's test-file regex covers:
  - Python `test_*.py`/`*_test.py`; Go `*_test.go`; Java `*Tests?.java`; PHP `*Test.php`; Ruby `*_spec.rb`/`*_test.rb`.
  - JS/TS `*.test.[jt]sx?`/`*.spec.[jt]sx?`; Kotlin `*Tests?.kt`/`*Spec.kt`; Swift `*Tests?.swift`/`*Spec.swift`; C# `*Tests?.cs`.
  - C/C++ `test_*.c(pp)`/`*_test.c(pp)`; Scala `*Spec|Suite|Test.scala`; Dart `*_test.dart`; Lua `*_spec|_test.lua`.
  - Test directories: `tests?/`, `__tests__/`, `spec/`, `testing/`.
  
  — [Semble penalties.py](https://github.com/MinishLab/semble/blob/main/src/semble/ranking/penalties.py)
- **Traceability baselines:**
  - TCTracer reaches MAP 85% for test→function and 92% for test-class→class links. — [TCTracer, EMSE](https://dl.acm.org/doi/abs/10.1007/s10664-021-10079-1). The prior notes also record naming conventions as 100% precision with low recall.
  - LLM-based documentation-to-code tracing reached F1 79.4% and 80.4% (Claude 3.5 Sonnet) versus baselines of 54.2% and 69.3%, with precision above 87%. — [2025 study](https://www.researchgate.net/publication/392918299_Evaluating_the_Use_of_LLMs_for_Documentation_to_Code_Traceability) (search summary; tangential and not zero-dependency)
- **Change-to-symbol mapping in 2026 MCP tools:**
  - codebase-memory-mcp `detect_changes`: "maps uncommitted changes to affected symbols with risk classification".
  - GitNexus `detect_changes`: "maps changed lines to affected processes". GitNexus also has `impact` ("blast radius… with depth grouping and confidence").
  
  — [codebase-memory-mcp README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md), [GitNexus README](https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md)
- Older background (Ekstazi, STARTS, Meta PTS, ROSE, coupling blends) is in `notes/static_analysis_incremental.md` §4.

### Inferences
- **Algorithm (NameRTS adapted to graph-indexer):**
  1. **Changed definitions**: symbols whose body hash changed between the base ref and the working tree. Use per-symbol content hashes, not line diffs.
  2. **Name reachability**: walk *reverse* reference edges from changed definitions through non-test code, and collect the test files and test functions reached.
     - Include unresolved or ambiguous name matches as a *conservative* frontier. This is NameRTS's safety trick: use names, not resolved calls.
     - Cap fan-out for very common names (`get`, `run`) with the Aider-style penalty.
  3. **Safety net**: the file-level import closure (BabelRTS/Jest-like) for changed files whose symbols could not be mapped, such as config, data or template files.
  4. **Ordering signals**: the naming convention (`foo.ts` ↔ `foo.test.ts`, near-100% precision) and test↔source co-change.
- **Hand-off format.** Return three tiers:
  - "must run": direct name hits plus naming-convention pairs.
  - "should run": transitive hits within depth ≤ 3.
  - "consider": the co-change or file-closure fallback.
  
  Each entry gets a one-line *reason* (for example, "uses `parseConfig`, changed in src/config.ts:42") and a count. Then give **one command per detected runner**:
  - Jest: `npx jest --findRelatedTests <changed files>`, which delegates to Jest's own graph, or `npx jest <test files> -t "<name>"`.
  - Vitest: `npx vitest related --run <changed files>` or `npx vitest run <test files>`.
  - pytest: `pytest tests/test_x.py::TestC::test_m …` or `-k "<expr>"`.
  - Go: `go test ./pkg/foo -run '^(TestA|TestB)$'`. Go tests are selected per package.
  - Rust: `cargo test -p <crate> <substring>`.
  - Maven: `mvn -Dtest='FooTest#bar+baz' test`.
  - Gradle `test --tests '<pattern>'` and `dotnet test --filter FullyQualifiedName~X` are standard, but I did **not** re-verify them this session.
- **Delegate when possible.** For Jest and Vitest, the runner's own resolver is authoritative for module resolution. graph-indexer's value there is the *symbol-level* narrowing (`-t` names) and the explanation.
- **Cost.** Everything is computed from the existing graph plus a base-ref snapshot, on demand. The per-symbol body hash is cheap to store (one hash per definition). No dependencies.
- **Pitfalls:**
  - Shared fixtures (`conftest.py`, test utilities, `setupTests`), snapshot and golden files, and data-driven tests.
  - Integration tests that reach code over HTTP or CLI. These need route edges (§6).
  - Dynamic imports, reflection and DI containers.
  - Go's package granularity.
  - Monorepo workspaces, where the correct runner command depends on the workspace root.
  - Always say "selection is best-effort; run the full suite before merge".

### Gaps
- NameRTS results are for Python only. I found no accuracy numbers for name-reachability RTS in JS/TS, Java or Go on tree-sitter-level graphs.
- No study was found on how "which tests to run" hints change agent success or cost. The only related agent evidence is that agents benefit from lint and test feedback (SWE-agent).
- The NameRTS readme in the repo does not restate the headline numbers. They come from the arXiv abstract via search summary.
- The Gradle and .NET filter syntaxes were not verified this session.

---

## 4. Repo maps: Aider's PageRank map and newer variants; best token budget; when session-start injection helps or hurts

### Takeaway
A **query-personalized** Aider-style repo map is one of the best-evidenced cheap retrievers of 2026. On Agent Retrieval Bench (ARB) it gets the best budgeted context yield (BCY@8k **0.3788**) and leads `trace2code`. Fused by RRF with an embedding model it rises further (BCY@8k **0.4884** vs 0.3828; MRR 0.2296→0.2713).

But the value is *query-conditioned*:
- **Static session-start context does not reliably help.** The AGENTS.md study found LLM-generated context files cut success by ~3% and raised cost by >20%, and "repository overviews… are not helpful".
- In a controlled seed-injection pilot, retrieval-derived seeds of ~3.1–3.3k tokens improved final file F1 by only ~0.05–0.076 and **worsened 29–36% of individual samples**.

Recommendation: an on-demand, query-personalized map of about 1–4k tokens, not an always-injected map.

### Cited Findings
- **Aider `repomap.py` ranking details**, from the code:
  - `map_mul_no_files=8` (the budget grows ×8 when no files are in chat).
  - Personalization comes from chat files, mentioned file names, and path components that match mentioned identifiers.
  - Identifier edge multipliers:
    - ×10 if the identifier is mentioned in the conversation.
    - ×10 if it is snake/kebab/camel case and at least 8 characters long.
    - ×0.1 if it starts with `_`.
    - ×0.1 if more than 5 files define it.
    - ×50 for edges from files in the chat.
  - Reference counts are dampened with `sqrt(num_refs)`.
  
  — [aider repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py). The default budget is 1,024 tokens (see `notes/context_engineering_mcp.md`).
- **Agent Retrieval Bench** (Qin & Xie, arXiv 2607.24882, July 2026; MIT):
  - Size: 427 samples in 25 repositories (13 Python, 3 Go, 3 Rust, 3 TypeScript, 2 Java, 1 JavaScript). There are 345 positive samples across four tasks: `code2test` 106, `comment2context` 80, `trace2code` 101 and `edit2ripple` 58.
  - The sample is unbalanced: Gin supplies 88 of the 345 positive samples, and the top four repositories supply 58.8%.
  - Gold labels are "the file an agent needs to read next", evaluated at the base commit.
  
  — [ARB README](https://github.com/eyuansu62/agent-retrieval-bench/blob/main/README.md), [arXiv 2607.24882](https://arxiv.org/abs/2607.24882)
- **ARB headline results** (all 345 positive samples):

  | Method | Recall@20 | MRR | BCY@8k |
  | --- | ---: | ---: | ---: |
  | Qwen3-Embedding-8B | **0.7029** | 0.2336 | 0.3732 |
  | Qwen3-Embedding-4B | 0.6306 | **0.2379** | 0.3409 |
  | RepoMap | 0.6333 | 0.2158 | **0.3788** |
  | nomic-embed-code | 0.5244 | 0.1986 | 0.2781 |
  | Lexical | 0.4940 | 0.1574 | 0.2650 |
  | BM25 | 0.4452 | 0.1520 | 0.2051 |

  RepoMap "leads both MRR and Recall@20 on `trace2code`". Thresholding on retrieval confidence does **not** improve selective success (abstention) on the 50 natural no-gold cases. — [ARB README](https://github.com/eyuansu62/agent-retrieval-bench/blob/main/README.md)
- **ARB's RepoMap is query-conditioned and Aider-style:**
  - Final score = 0.65 × query + 0.25 × personalized PageRank + 0.10 × affinity.
  - Graph edges: imports, symbol references (at most 80 per file), and source↔test edges (weight 2.0).
  - PageRank is personalized by query and path-mention scores.
  - Query score = Σ idf × (3 for path tokens, 2 for symbol tokens) × (1 + log count). It adds +20 if the full path appears in the query and +7 if the basename does.
  
  — [repomap_eval.py](https://github.com/eyuansu62/agent-retrieval-bench/blob/main/src/agent_retrieval_bench/repomap_eval.py)
- **Complementarity** (287-sample positive core):
  - BCY@8k: RepoMap **0.3828** vs Qwen3-Embedding-4B 0.3079 vs **RRF(Qwen3-8B + RepoMap) 0.4884**.
  - The fusion improves MRR 0.2296→**0.2713** and R@20 0.7070→**0.7331**. On `trace2code`, R@20 reaches **0.8795**, versus 0.8366 for RepoMap and 0.7970 for Qwen3-8B alone.
  
  — [ARB paper source](https://github.com/eyuansu62/agent-retrieval-bench/blob/main/paper/main.tex)
- **Budget sweep on `edit2ripple`** (58 samples), BCY at 4k / 8k / 16k / 32k tokens:
  - RepoMap: 0.2040 / 0.3592 / 0.5187 / 0.5848
  - Qwen3-Embedding-8B: 0.3333 / 0.5129 / 0.5963 / 0.6767
  - Lexical: 0.3218 / 0.4468 / 0.5187 / 0.5876
  - BM25: 0.1221 / 0.2428 / 0.3103 / 0.4641
  
  "The budget winner changes as context grows". — [ARB paper source](https://github.com/eyuansu62/agent-retrieval-bench/blob/main/paper/main.tex)
- **Failure mode, the "given-file trap"**: in `comment2context`, "RepoMap ranks the given test file first and misses the gold files at depth 20". — [ARB paper source](https://github.com/eyuansu62/agent-retrieval-bench/blob/main/paper/main.tex)
- **Agents vs static lists.** At about 3 final files, the GPT-5.4-mini strict-context agent reaches final file F1 **0.3113**, versus RepoMap@3 0.1102, RepoMap@4 0.1198 and lexical@3 0.0721. The authors add that "RepoMap@20 still has strong recall as a candidate generator". — [ARB v1.4 claims](https://github.com/eyuansu62/agent-retrieval-bench/blob/main/docs/v1_4_paper_claims.md)
- **Seed-injection pilot.** Setup: 45 samples, Docker-isolated Codex GPT-5.5 restricted to `list_dir`/`grep`/`read_file`/`submit`; only the initial seed changes. Absolute results:

  | Arm | Final F1 | ΔF1 | Any-gold | Tool calls | Post-seed tokens | Seed tokens |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: |
  | No seed | 0.3222 | 0 | 0.5111 | 3.71 | 2137 | 0 |
  | Random | 0.3437 | +0.0215 | 0.7333 | 8.49 | 3682 | 2428 |
  | Lexical | 0.3981 | +0.0759 | 0.8000 | 6.24 | 2244 | 3061 |
  | Qwen8B | 0.3726 | +0.0504 | 0.7556 | 5.51 | 2048 | 3204 |
  | RRF | 0.3967 | +0.0744 | 0.8000 | 5.42 | 1857 | 3299 |
  | Oracle | 0.6337 | +0.3115 | 1.0000 | 4.18 | 1736 | 1781 |

  Paired against no seed, the share of samples improved / worsened:

  | Seed | Improved | Worsened |
  | --- | ---: | ---: |
  | Random | 0.2667 | 0.3333 |
  | Lexical | 0.3333 | 0.2889 |
  | Qwen3-8B | 0.2889 | 0.3556 |
  | RRF(Qwen3-8B+RepoMap) | 0.4222 | 0.3333 |
  | Oracle | 0.6444 | 0.1778 |

  Authors: "seeded runs can worsen some samples. The result is therefore not that retrieval always improves an agent." — [ARB paper source](https://github.com/eyuansu62/agent-retrieval-bench/blob/main/paper/main.tex)
- **AGENTS.md study** (Gloaguen et al., ETH Zurich / LogicStar, Feb 2026):
  - Setup: AGENTbench (138 Python tasks from niche repositories) plus SWE-bench tasks. Agents were Claude Code (Sonnet 4.5), Codex (GPT-5.2, GPT-5.1 mini) and Qwen Code (Qwen3-30B).
  - Context files "tend to reduce task success rates compared to providing no repository context, while also increasing inference cost by over 20%".
  - LLM-generated files: about **−3%** success. Developer-written files: about **+4%** on AGENTbench, with cost up by up to 19%.
  - "Repository overviews, although popular… are not helpful". Instructions *are* followed.
  
  — [arXiv 2602.11988](https://arxiv.org/abs/2602.11988); [InfoQ](https://www.infoq.com/news/2026/03/agents-context-file-value-review/); [Upsun](https://developer.upsun.com/posts/ai/agents-md-less-is-more) (search summaries). The harness is at [eth-sri/agentbench](https://github.com/eth-sri/agentbench/blob/main/README.md).
- **Context rot** (Chroma, 2025): "model performance varies significantly as input length changes". — [chroma-core/context-rot README](https://github.com/chroma-core/context-rot/blob/master/README.md)

### Inferences
- **Token budget:**
  - For a *seed or map handed to the agent*, 1–4k tokens is the evidence-backed range. ARB's retrieval-derived seeds were 3.1–3.3k tokens (the random arm was 2.4k), and Aider's default is 1k (8k only when no files are in context).
  - BCY keeps rising to 16–32k, but ARB's own agent analysis shows the final context is about 3 files, so large packed maps mostly add cost.
  - Offer `budget` as a tool parameter (default ~1,024, maximum ~4,096). Render signatures only, grouped by file.
- **Do not inject by default at session start.** Static overviews show no benefit and cost at least 20% more. If injected at all, keep it at ≤1k tokens and restrict it to cases with no task text or mentioned files (Aider's no-files case), such as a cold start in an unfamiliar repo.
- **Make the map query-personalized, as a tool.** The personalization vector should come from the task or query: identifier and path matches plus mentioned files. Reuse Aider's multipliers (mentioned ×10, long compound identifiers ×10, private ×0.1, defined in more than 5 files ×0.1, chat files ×50, sqrt of reference counts). Add test↔source edges as ARB does. **Exclude files already in the agent's context** to avoid the given-file trap.
- **Fuse, don't choose.** ARB shows the structural (PageRank) and semantic channels are complementary (BCY@8k 0.4884 vs 0.3828). graph-indexer already has PageRank, so an RRF of `repo_map(query)` with BM25F and the dense channel is a near-zero-cost gain.
- **Pitfalls.** Any seed can mislead: 29–36% of seeded samples got worse. Label the map as "candidates to inspect", not as answers. Keep it fresh after edits, and truncate mega-files.

### Gaps
- No controlled study was found comparing a static session-start repo map against none on end-to-end agent success. ARB's seed pilot measures file F1, not patch success.
- Aider still publishes no ablation of its repo map.
- ARB is file-level. No span-level repo-map evidence exists (`edit2ripple` has no span gold).
- The best budget per model or context size is unknown.

---

## 5. Static embeddings on CPU (potion-code-16M-v2 / model2vec) and lexical–dense routing and fusion

### Takeaway
potion-code-16M-v2 is **MIT-licensed**. It is a single **32.49 MB float16 table** ([63,457 × 256]) plus a **1.02 MB BERT-WordPiece tokenizer**, so inference is exactly tokenize → drop `[UNK]` → row lookup → mean → L2-normalize.

A **zero-dependency JS port is ~100 lines**. In my measurement it loads in ~150 ms and embeds **3,790 code chunks/s (4.1 MB/s) on one core**, with 2–5 ms brute-force queries over 3.4k chunks.

Quality is modest on its own. The static model *alone* is **below BM25** on CoIR (39.08 vs 42.31) and on Semble's benchmark (0.650 vs 0.675 raw). Most of Semble's 0.854 comes from **code-aware ranking signals** (BM25 0.675→0.834), and the dense channel adds **+0.020** on top, all of it on NL and architecture queries (≈0 on symbol queries). Route it to NL queries with a low weight: Semble uses weighted RRF with α=0.3 for symbol-like queries and 0.5 for NL. Guard against the "weakest-link" effect, where hybrid RRF falls below BM25 on 5 of 10 CoIR tasks.

### Cited Findings

**License, files, format (verified)**
- The potion-code-16M-v2 model card front matter has `license: mit` and `library_name: model2vec`. It lists datasets `minishlab/tokenlearn-cornstack-{queries,docs}-coderankembed` and `nomic-ai/cornstack-{python,java,php,go,javascript,ruby}-v1`.
- Pipeline from the card:
  1. Mine code tokens: "43k extra tokens → ~63.5k total" added to CodeRankEmbed's tokenizer.
  2. Distill with Model2Vec (256 dimensions, PCA).
  3. Fine-tune with Tokenlearn on 1.2M (query, doc) pairs.
  4. Train contrastively with MultipleNegativesRankingLoss on 1.2M CornStack pairs.
- Training corpus: 6 languages (Python, Java, JavaScript, Go, PHP, Ruby).

— Canonical: [HF minishlab/potion-code-16M-v2](https://huggingface.co/minishlab/potion-code-16M-v2) (blocked here). Read from a vendored copy: [satori MODEL_CARD.md](https://github.com/ham-zax/satori/blob/master/packages/mcp/assets/potion/linux-x64/MODEL_CARD.md), whose [manifest.json](https://github.com/ham-zax/satori/blob/master/packages/mcp/assets/potion/linux-x64/manifest.json) pins revision `e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b` with `"license": "MIT"`.
- Artifacts at that revision:
  - `model.safetensors`: **32,490,072 bytes**, sha256 `75cf7a6c…d227623c`.
  - `tokenizer.json`: **1,024,340 bytes**, sha256 `107bbdcb…c4f3d45`.
  
  — [zvec-grep catalog.ts](https://github.com/zvec-ai/zvec-grep/blob/main/src/engine/models/catalog.ts). The vendored copy's hashes match exactly (own check).
- `config.json` is `{"normalize": true, "embedding_dtype": "float16"}` (59 bytes). — [satori model dir](https://github.com/ham-zax/satori/tree/master/packages/mcp/assets/potion/linux-x64/model)
- **Own inspection** of the safetensors header (80 bytes): a single tensor `embeddings`, dtype **F16**, shape **[63457, 256]**, data 32,489,984 bytes. There are **no `weights` or `mapping` tensors**, so no per-token weighting or vocabulary quantization applies.
- **Tokenizer, own inspection of tokenizer.json:**
  - Model: `WordPiece` (`unk_token` `[UNK]`, `continuing_subword_prefix` `##`, `max_input_chars_per_word` 100), with **63,457** vocabulary entries.
  - Normalizer: `BertNormalizer{clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true}`.
  - Pre-tokenizer: `BertPreTokenizer`. There is no post-processor.
  - Added tokens: only `[PAD]` and `[UNK]`. The tokenizer's own truncation is 512.
  - Mined vocabulary includes whole lowercased identifiers, for example id 63456 = `getparametertypes`.
- **model2vec inference algorithm** (source, `model2vec/model.py`, commit 2026-09-21):
  1. `tokenizer.encode_batch_fast(..., add_special_tokens=False)`.
  2. **Remove `unk_token_id`** ("necessary for word-level models").
  3. Pre-truncate strings to `max_length × median_token_length` characters, with default `max_length = 512` tokens.
  4. Optionally remap ids through `token_mapping`, and multiply by per-token `weights` if present.
  5. Take `mean(axis=0)`.
  6. If `normalize`, apply L2 normalization with `norm + 1e-32`.
  
  Tensors are stored as `"embeddings"` with optional `"weights"` and `"mapping"`. — [model.py](https://github.com/MinishLab/model2vec/blob/main/model2vec/model.py), [persistence.py](https://github.com/MinishLab/model2vec/blob/main/model2vec/persistence/persistence.py). model2vec, Semble and model2vec-rs are MIT — [model2vec LICENSE](https://github.com/MinishLab/model2vec/blob/main/LICENSE), [Semble README](https://github.com/MinishLab/semble/blob/main/README.md)

**JS feasibility**
- **zvec-grep** (Apache-2.0, Node ≥22) already runs potion-code-16M-v2 in Node:
  - It has a hand-written safetensors parser (8-byte little-endian header length, JSON header, F16/F32 tensors), a worker pool, and `normalize: true`, `maxInputTokens: 1024` for this model.
  - Tokenization uses `@huggingface/tokenizers` `^0.1.3`, loaded from `tokenizer.json`. The package is **Apache-2.0 with zero dependencies and no install script**, per the lockfile.
  - zvec-grep itself also depends on the native `@zvec/zvec` (install script plus platform bindings) and `@vscode/ripgrep`.
  
  — [model2vec.ts](https://github.com/zvec-ai/zvec-grep/blob/main/src/engine/models/backends/model2vec.ts), [model2vec-tokenizer.ts](https://github.com/zvec-ai/zvec-grep/blob/main/src/engine/models/backends/model2vec-tokenizer.ts), [package.json](https://github.com/zvec-ai/zvec-grep/blob/main/package.json), [package-lock.json](https://github.com/zvec-ai/zvec-grep/blob/main/package-lock.json)
- Other projects adopting potion-code-16M(-v2) in 2026 include ast-bro, semble_rs, VeraTools/vera, codesynapse, ken, Marksman, CALM (weights embedded with `include_bytes!`), columbus, corpus-forge and satori. Third-party READMEs describe **v1** as "~60 MB" or "~64 MB". — [GitHub code search results](https://github.com/search?q=%22potion-code-16M%22&type=code) (e.g. [ast-bro](https://github.com/aeroxy/ast-bro), [CALM](https://github.com/Eilodon/CALM))
- **Own measurement** of a zero-dependency JS port (~100 lines): BertNormalizer, BertPreTokenizer, greedy WordPiece, a Uint16 table with a 64K-entry half→float lookup, mean, L2. Corpus: 435 files and 3,417 chunks of 40 lines (3.70M chars, 1.07M tokens).
  - Model load: **145–157 ms**; process RSS about 150 MB in the naive prototype, which holds both the file buffer and a copy.
  - Naive version: 1,825 ms total, i.e. **1,872 chunks/s, 2.03 MB/s**, tokenizing at 0.97M tokens/s.
  - With a **word-level cache and ASCII fast paths**: **901 ms, i.e. 3,790 chunks/s, 4.10 MB/s**, tokenizing at 2.24M tokens/s. Token IDs are identical to the naive version.
  - Query embedding plus brute-force cosine over 3,417 × 256-d float32 (3.5 MB): **2–5 ms**.
  - Sanity check: six NL queries returned the expected function top-1. For example, "parse safetensors header length and tensor offsets" returned zvec-grep `model2vec.ts:401` (cos 0.719), and "split camelCase identifier into sub tokens" returned Semble `tokens.py:1` (0.739).
  - **Not verified**: token-ID parity against HF `tokenizers`, because PyPI, npm and crates.io were blocked.

**Quality evidence**
- **Semble benchmark** (1,251 queries, 63 repositories, 19 languages, CPU only, NDCG@10). Queries and labels were generated by Claude Sonnet 4.6, which also judged label quality.

  | Method | NDCG@10 | Index time | Query p50 |
  | --- | ---: | ---: | ---: |
  | semble | **0.854** | 306 ms | 0.91 ms |
  | CodeRankEmbed (137M, semantic-only) | 0.839 | 116 s | 16 ms |
  | ColGREP | 0.693 | 5.4 s | 122 ms |
  | BM25 | 0.673 | 47 ms | 0.17 ms |
  | zvec-grep (same potion model, "direct" mode) | 0.670 | 3.4 s | 391 ms |
  | ck | 0.642 | 96 s | 187 ms |
  | codebase-memory-mcp | 0.630 | 454 ms | 46 ms |
  | grepai | 0.561 | 35 s | 48 ms |
  | probe | 0.387 | — | 207 ms |
  | cs | 0.200 | — | 22 ms |
  | ripgrep | 0.126 | — | 14 ms |

  — [Semble benchmarks README](https://github.com/MinishLab/semble/blob/main/benchmarks/README.md) (commit 2026-09-18)
- **Semble ablation (NDCG@10)**:

  | Retriever | Raw | With Semble's ranking signals |
  | --- | ---: | ---: |
  | BM25 | 0.675 | **0.834** |
  | potion-code-16M-v2 | 0.650 | 0.821 |
  | Hybrid (both) | — | **0.854** |

  By query category (architecture 343 / semantic 711 / symbol 204 queries):

  | Mode | Architecture | Semantic | Symbol |
  | --- | ---: | ---: | ---: |
  | BM25 raw | 0.628 | 0.676 | 0.719 |
  | potion raw | 0.626 | 0.666 | 0.629 |
  | Semble BM25 + ranking | 0.770 | 0.819 | 0.957 |
  | Semble potion + ranking | 0.757 | 0.808 | 0.943 |
  | Semble hybrid | **0.802** | **0.846** | **0.958** |

  The category table labels the static row "potion-code-16M raw" and does not say v1 or v2. — [Semble benchmarks README](https://github.com/MinishLab/semble/blob/main/benchmarks/README.md)
- **Per language** (semble vs CodeRankEmbed): lowest on TypeScript (0.706 vs 0.671); Go 0.895 vs 0.713; Rust 0.856 vs 0.754; Python 0.867 vs 0.878; JavaScript 0.917 vs 0.925. — [Semble benchmarks README](https://github.com/MinishLab/semble/blob/main/benchmarks/README.md)
- **CoIR (NDCG@10, `mteb>=2.10`), from the model card.** Averages: CodeRankEmbed **59.14**; potion-code-16M-v2 + BM25 hybrid (RRF k=60) **43.36**; BM25 **42.31**; potion-code-16M-v2 **39.08**; potion-code-16M (v1) 37.05; potion-retrieval-32M 32.10; potion-base-32M 31.42. Per task, v2 / BM25 / hybrid:

  | Task | v2 | BM25 | Hybrid |
  | --- | ---: | ---: | ---: |
  | CosQA | 24.36 | 18.75 | 21.39 |
  | CodeFeedbackST | 53.22 | **68.15** | 61.10 |
  | CodeFeedbackMT | 38.02 | **59.19** | 45.38 |
  | StackOverflow | 59.57 | **70.26** | 66.73 |
  | CodeSearchNetCC | 43.66 | **53.97** | 51.68 |
  | CodeTransDL | 32.64 | **34.42** | 33.42 |
  | Text2SQL | 44.07 | 24.94 | **46.29** |
  | CodeTransContest | 43.66 | 47.78 | **53.80** |
  | COIRCodeSearchNet | 46.37 | 40.86 | **47.71** |
  | AppsRetrieval | 5.19 | 4.76 | **6.08** |

  The card notes CosQA and CodeFeedback are the most relevant tasks for NL→code search. — [vendored model card](https://github.com/ham-zax/satori/blob/master/packages/mcp/assets/potion/linux-x64/MODEL_CARD.md)
- **Conflicts to note:**
  - ColGREP's README reports **0.846** (LateOn-Code-edge) and **0.859** (LateOn-Code) on the *same* Semble benchmark, run on an H100 GPU at FP32, while Semble's CPU run lists ColGREP at **0.693**. — [ColGREP README](https://github.com/lightonai/next-plaid/blob/main/colgrep/README.md) vs [Semble benchmarks](https://github.com/MinishLab/semble/blob/main/benchmarks/README.md)
  - The earlier Semble figure "CodeRankEmbed Hybrid 0.862" cited in `notes/local_models_and_ranking.md` has been replaced in the September 2026 table by "CodeRankEmbed 0.839" (semantic-only).
  - Semble's main table lists ck at 0.642, but its per-language "overall" row says 0.634.

**Alternatives (permissive or small, runnable without Python)**
- LateOn-Code-edge (17M, multi-vector) through ColGREP needs ONNX Runtime and about 300 × 128-d vectors per unit, i.e. much larger indexes. The ColGREP/next-plaid code is Apache-2.0; **the model weights' license was not verified** (HF blocked). — [next-plaid README](https://github.com/lightonai/next-plaid/blob/main/README.md)
- codebase-memory-mcp bundles "Nomic `nomic-embed-code` embeddings (40K tokens, 768d int8) compiled into the binary" and combines them with an "11-signal combined scoring". Read literally, this is a static token table distilled from a large code embedder, which is the same idea as potion but with 768-d int8 vectors (my reading). — [codebase-memory-mcp README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)
- ck defaults to bge-small-en-v1.5 (0.642 in ck's pipeline on Semble's benchmark). — [Semble benchmarks](https://github.com/MinishLab/semble/blob/main/benchmarks/README.md)
- The prior round already covers CodeRankEmbed (MIT), Qwen3-Embedding-0.6B (Apache-2.0, ONNX), granite-r2 and the non-commercial jina and SFR models. — `notes/local_models_and_ranking.md`

**Routing and fusion**
- **Semble's fusion:**
  - Each channel's scores are turned into RRF scores 1/(60+rank), then combined as `alpha·semantic + (1−alpha)·bm25`.
  - `alpha = 0.3` for symbol-like queries ("lean BM25"), 0.5 for NL.
  - `_SYMBOL_QUERY_RE` treats as symbolic any query that is namespace-qualified (`::`, `\`, `->`, `.`), starts with `_`, contains uppercase or `_`, or starts with uppercase. Plain lowercase words count as NL.
  - camelCase or PascalCase identifiers embedded in an NL query get a half-strength definition boost.
  
  — [search.py](https://github.com/MinishLab/semble/blob/main/src/semble/search.py), [weighting.py](https://github.com/MinishLab/semble/blob/main/src/semble/ranking/weighting.py), [boosting.py](https://github.com/MinishLab/semble/blob/main/src/semble/ranking/boosting.py)
- Semble's BM25 tokenizer emits the **lowercased compound identifier plus its camelCase and snake_case parts** ("HandlerStack" → `handlerstack, handler, stack`). — [tokens.py](https://github.com/MinishLab/semble/blob/main/src/semble/tokens.py)
- **"Balancing the Blend"** (11 datasets; full-text, sparse, dense and tensor search):
  - The "weakest link" phenomenon: "a weak path can substantially degrade overall accuracy".
  - There is no one-size-fits-all configuration.
  - Tensor re-ranking fusion beats RRF and weighted sum. For example, on DBPE(en) FTS+DVS, RRF scores 0.668 NDCG@10 and TRF 0.722 (+8.1%).
  
  — [arXiv 2508.01405](https://arxiv.org/abs/2508.01405) (search summary)
- The convex-combination-vs-RRF evidence (Bruch et al.) is in `notes/local_models_and_ranking.md` Q5.

### Inferences
- **Implementation recipe, zero dependencies.** Parity-critical details:
  1. **Safetensors**: read the u64 little-endian header length, parse the JSON header, and copy tensor bytes into an aligned `Uint16Array`. Decode with a 65,536-entry half→float table (256 KB), or `Float16Array` where the runtime supports it.
  2. **BertNormalizer**: drop U+0000, U+FFFD and control characters; map whitespace (including `\t\n\r`) to a space; pad CJK ideographs with spaces; lowercase; NFD and strip `\p{Mn}` (accents are stripped because `strip_accents=null` follows `lowercase=true`).
  3. **BertPreTokenizer**: split on whitespace and **isolate punctuation**, defined as ASCII 33–47, 58–64, 91–96, 123–126 plus Unicode `P*`. Consequences: `_` splits `snake_case`; camelCase is only lowercased and relies on mined whole-identifier tokens or `##` subwords.
  4. **WordPiece**: greedy longest-match-first with a `##` prefix after the first piece. A word longer than 100 characters, or one with no match, becomes `[UNK]`.
  5. **model2vec post-steps**: drop `[UNK]`, truncate at 512 tokens (model2vec default; zvec-grep uses 1,024), mean, then L2.
  6. **Speed**: a word→ids cache is the main speed lever (~2x measured). Use `worker_threads` for the initial index build.
  7. **Parity**: test token-ID parity against HF `tokenizers` once, offline, on a golden set of 1,000 files before shipping. Alternatively vendor `@huggingface/tokenizers` (Apache-2.0, no dependencies).
- **Cost (my arithmetic and extrapolation):**
  - Model files: 33.5 MB. Ship them as an optional download with a pinned revision and sha256, or as a separate vendored package; MIT permits this with attribution. Support a local path for air-gapped use, as Semble's `SEMBLE_MODEL_NAME` does.
  - Index: 256-d float32 is 1 KB per chunk, so 100k chunks take 102 MB (int8: 25.6 MB).
  - Embedding 100k chunks takes about 26–53 s single-threaded at the measured 1.9–3.8k chunks/s, and incremental updates are per file.
  - Query: under 5 ms brute force at ~3k chunks, and roughly linear, so about 100 ms at ~100k chunks (int8 or SIMD-friendly loops help).
- **Expected return is modest.** Semble's ablation implies graph-indexer should **first port Semble's ranking signals** (definition boost, identifier stems, file coherence, path penalties, compound + sub-token BM25). graph-indexer already has BM25F and a definition-aware name channel, so part of that +0.159 may already be captured.
  - Then add potion as a **routed** channel (NL, architecture and behaviour queries) at α≈0.3–0.5 in weighted RRF, replacing the weak MiniLM channel noted in the prior round.
  - Measure on graph-indexer's own benchmark. Expect gains on NL queries (Semble: +0.027 semantic, +0.032 architecture) and none on symbol queries (+0.001).
- **Fusion guardrails** (weakest link):
  - Keep BM25 dominant when the dense channel's top-k barely overlaps lexical top-k on symbol routes.
  - Hide dense-only hits from symbol routes unless they are definitions.
  - Tune α per route on a labelled set; a convex combination per Bruch et al. is the next step.
  - On CoIR, the hybrid falls below BM25 on 5 of 10 tasks, so unrouted fusion can hurt.
- **Pitfalls:**
  - Lowercasing merges `Get`/`get`.
  - Order-blind embeddings: "a calls b" equals "b calls a".
  - Long chunks dilute the mean, so chunk per symbol as in cAST.
  - The training corpus covers 6 languages; TypeScript is Semble's weakest language at 0.706.
  - Non-English comments.
  - The Semble benchmark's labels are LLM-generated, a possible bias.

### Gaps
- **Tokenizer parity**: no parity test against HF `tokenizers` was possible (PyPI, crates.io and npm blocked).
- **Licenses and sizes still unverified**:
  - potion-code-16M **v1** license and exact file size (READMEs disagree: "~60 MB", "~64 MB", "~16 MB").
  - CornStack dataset licenses and whether they constrain the derived weights.
  - The LateOn-Code-edge weights license.
- **Evaluations missing**:
  - No controlled comparison of RRF vs convex combination **on code**.
  - No query-routing study beyond Semble's regex heuristic and its category ablation.
  - No independent (non-vendor) evaluation of potion-code-16M-v2 in agent loops.

---

## 6. Other cheap techniques with evidence of agent benefit (framework-aware edges, dead code, API usage examples, symbol-level co-change) and overall ranking

### Takeaway
Three cheap additions have the best evidence-to-cost ratio:
1. **API usage examples** from reverse edges: "how is X called here". Project-dependency context cut API hallucinations by 57–74% in MARIN.
2. **Framework-aware edges** (HTTP routes ↔ handlers ↔ client call sites, event emit/listen, ORM models, DI). These close the largest known class of missing static edges; static call graphs miss about 11% of reachable methods, with dynamic property access, reflection and frameworks among the root causes. Popular 2026 agent tools (codebase-memory-mcp, GitNexus) ship them.
3. **Dead-code flags used as a ranking penalty** rather than as a report. LLMs are easily misled by irrelevant code.

Symbol-level co-change is a useful *tie-breaker* for impact and test selection. Its standalone precision is low, and it needs a per-commit symbol mapping; git's `-L :funcname:` and hunk headers help.

### Cited Findings
- **Framework and cross-service edges in codebase-memory-mcp** (MIT):
  - "HTTP route ↔ call-site matching with confidence scoring".
  - "gRPC, GraphQL, tRPC service detection with protobuf Route extraction".
  - "Channel detection (`EMITS` / `LISTENS_ON`) for Socket.IO, EventEmitter, and generic pub-sub patterns across 8 languages with constant resolution".
  - "Route nodes: REST endpoints are first-class graph entities". `get_architecture` returns entry points, routes, hotspots, layers and clusters.
  - Python type resolution covers SQLAlchemy 2.0 `Mapped[T]` and Pydantic `BaseModel`.
  - Edge types include `HTTP_CALLS`, `ASYNC_CALLS`, `DATA_FLOWS` (argument-to-parameter mapping), `SIMILAR_TO` (MinHash + LSH near-clones) and `SEMANTICALLY_RELATED` (score ≥ 0.80).
  
  — [codebase-memory-mcp README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)
- **GitNexus** ships:
  - `route_map`: "which components fetch which endpoints, and handlers".
  - `api_impact`: a "pre-change impact report for an API route handler".
  - `rename`: "multi-file coordinated rename with graph + text search".
  - An opt-in `--spring-actuator` that ingests local Spring Boot Actuator JSON (`mappings`, `beans`, `conditions`, `configprops`, `env`) to confirm routes and beans.
  
  Its license is **PolyForm Noncommercial**, so its code cannot be reused in an MIT tool. — [GitNexus README](https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md)
- **Why framework edges matter:**
  - Static call graphs miss about 11% of reachable methods (median recall 0.884) in Java. — [ICSE 2020](https://dl.acm.org/doi/pdf/10.1145/3377811.3380441) (search summary)
  - In JS, "dynamic property accesses were the most common root cause of missed edges". — [Dagstuhl DARTS](https://drops.dagstuhl.de/entities/document/10.4230/DARTS.8.2.7) (search summary)
  - A 2026 study of Soot, SootUp, WALA and Doop finds precision orderings break because of lambdas, reflection and native modelling. — [arXiv 2604.00885](https://arxiv.org/html/2604.00885) (search summary)
- **Dead code:**
  - codebase-memory-mcp's dead-code detection "finds functions with zero callers, excluding entry points". — [README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)
  - vulture gives each finding a confidence of 60–100%. It is 100% for unused function arguments and unreachable code, and 60% for attributes, classes, functions, methods, properties and variables ("*very rough* estimates"). False positives are handled with whitelists (`--make-whitelist`). — [vulture README](https://github.com/jendrikseipp/vulture/blob/main/README.md)
  - Knip "finds and fixes unused dependencies, exports and files" in JS/TS projects. — [knip README](https://github.com/webpro-nl/knip/blob/main/packages/knip/README.md)
  - Semble down-weights compat/legacy/examples paths (×0.3) and `.d.ts` stubs (×0.7) so "canonical implementations surface first". — [Semble README](https://github.com/MinishLab/semble/blob/main/README.md), [penalties.py](https://github.com/MinishLab/semble/blob/main/src/semble/ranking/penalties.py)
  - LLM fragility: with semantic-preserving mutations, including dead-code insertion, LLMs failed to debug the same bug in about 78–81% of programs they had previously handled, with an accuracy drop of 83%. The search summaries report slightly different framings. — ["How Accurately Do Large Language Models Understand Code?" (2025)](https://tahakhan.net/files/haroon_arxiv_25.pdf) (search summary)
- **API usage examples and project context.** MARIN (FSE 2025 Companion) mines hierarchical project dependencies and adds dependency-constrained decoding. Compared with plain RAG it cut API hallucinations by an average of **67.52% (MiHN)** and **73.56% (MaHR)**, and raised exact match by **107.3%** and edit similarity by **44.79%**, across six LLMs. On Huawei internal projects the reductions were **57.33% / 59.41%**. — [arXiv 2505.05057](https://arxiv.org/abs/2505.05057), [ACM](https://dl.acm.org/doi/10.1145/3696630.3728569) (search summary)
- **Symbol-level co-change:**
  - A learning-to-rank approach to co-changed *methods* at pull-request level was evaluated on 150 Java projects (41.5M LOC, 634,216 PRs). Random Forest beat other models by 2.5–12.8% NDCG@5. — [arXiv 2411.19099](https://arxiv.org/abs/2411.19099) (search summary)
  - `git log -L :<funcname>:<file>` traces the evolution of a function selected by a name regex. It walks from a single starting revision. — [git line-range-options](https://github.com/git/git/blob/master/Documentation/line-range-options.adoc)
  - Hunk headers name the enclosing function for built-in diff drivers: `ada, bash, bibtex, cpp, csharp, css, dts, elixir, fortran, fountain, golang, html, java, kotlin, markdown, matlab, objc, pascal, perl, php, python, ruby, rust, scheme, swift, tex`. They need `.gitattributes` `diff=<lang>`. **There is no built-in JavaScript or TypeScript driver**; by default the hunk header is a preceding line that "begins with an alphabet, an underscore or a dollar sign" (GNU `diff -p` style). — [gitattributes.adoc](https://github.com/git/git/blob/master/Documentation/gitattributes.adoc)
  - File-level co-change precision and recall (ROSE and similar) are in `notes/static_analysis_incremental.md` §4.
- **Structured multi-signal code descriptions.** ColGREP embeds `Calls`, `Uses` and `Parameters` headers per unit. Semble's `find_related` returns chunks related to a given chunk. — [ColGREP README](https://github.com/lightonai/next-plaid/blob/main/colgrep/README.md), [Semble](https://github.com/MinishLab/semble/blob/main/README.md)

### Inferences
- **API usage examples (`usages(symbol, k=3)`).** From reverse reference edges, pick 2–3 *diverse* call sites:
  - Prefer different files, and non-test code before tests.
  - Show the call line plus ±3 lines and how the result is consumed.
  - Include the definition's signature and docstring.
  
  This costs almost nothing given the existing graph and directly targets the API-misuse and hallucination class that MARIN quantifies. It also makes "callers not updated" checks (§2) actionable.
- **Framework edges, done incrementally:**
  - Start with HTTP route extraction for the top frameworks: Express, Fastify, Nest decorators, Next.js file routes, Flask/FastAPI decorators, Django `urls.py`, Spring `@*Mapping`, Gin/Echo, Rails routes. Use tree-sitter queries over decorators and call patterns.
  - Match client call sites (`fetch`, `axios`, `requests`, `http.Get`) by normalized path template with a confidence tier.
  - Then add event emit/listen pairs and ORM model↔table edges.
  - Per-framework query packs are the main maintenance cost. Keep them declarative (`.scm` files), as the tree-sitter tags approach does.
- **Dead-code signals.** Compute "zero incoming edges, excluding entry points": exports of package entry files, `main`, CLI registrations, route handlers, test functions, framework hooks, `__all__`, reflection or registry decorators.
  - Use it mainly as a **ranking penalty and an annotation** ("possibly unused") in search and repo-map results.
  - Do not use it as a deletion recommendation, because precision is limited; vulture itself rates most classes at 60% confidence.
- **Symbol-level co-change.** Mine the last N commits (N ≈ 500–2,000) with `git log --name-only -U0` and map hunks to symbols by parsing the file at that commit. graph-indexer already parses with tree-sitter, so this is feasible as a background job.
  - Cost estimate: 1,000 commits × ~5 files ≈ 5k parses, roughly a few to tens of seconds in WASM (my estimate).
  - Filter mega-commits (e.g. more than 30 files).
  - Use it only as a tie-breaker in `impact_of` and test selection, not as an independent signal. Its measured precision is modest.

**Overall ranking across all six questions.** This is my inference. Criteria: agent-benefit evidence, marginal gain over graph-indexer's current capabilities, cost and dependencies, and risk.

| Rank | Technique | Evidence of agent value | Build cost / deps | Main risk |
| --- | --- | --- | --- | --- |
| 1 | Structure-aware grep (FTS5-trigram prefilter; hits grouped by enclosing symbol; role labels; resolved targets; Zoekt-style scoring) | Medium: vendor token savings; ACI evidence; agents already use grep | Low: built-in SQLite trigram, ~0.6x raw extra disk at `detail=none` | Regex fallback scans; ambiguity on common names |
| 2 | Post-edit `check_changes` (syntax, broken named imports, stale refs after rename or delete, optional arity) | Medium-high: SWE-agent lint +3 pts; RefactorBench 22% vs 87% gap | Low: reuses incremental graph | False positives; must be precision-tiered |
| 3 | Test selection with reasons and runner commands (NameRTS-style name reachability, naming conventions, file-closure fallback, Jest/Vitest delegation) | Medium: NameRTS 69.9% skipped, 99.6% of commits safe (Python) | Low | Misses from dynamic code; fixtures |
| 4 | Query-personalized repo map tool (1–4k tokens) fused with lexical and dense | Medium: ARB best BCY@8k; RRF fusion BCY@8k 0.3828→0.4884; seeds +0.075 F1 but 29–36% worse | Very low (PageRank exists) | Session-start injection can hurt; given-file trap |
| 5 | Semble-style ranking signals first, then potion-code-16M-v2 routed dense channel (pure JS) | Medium on NL queries: +0.020 overall, +0.027–0.032 NL/architecture, ≈0 symbol; ranking signals worth +0.159 | Medium: 33.5 MB model (MIT), ~1 KB/chunk, seconds to index | Weakest-link fusion; parity; distribution |
| 6 | API usage examples from reverse edges | Medium (indirect): MARIN −57–74% API hallucination | Very low | Picking representative examples |
| 7 | Framework-aware edges (routes, events, ORM, DI) | Medium for web and backend repos: closes known missing-edge classes | Medium: per-framework query packs | Maintenance; false matches of path templates |
| 8 | Symbol-level co-change | Low-medium: modest precision; learning-to-rank gains 2.5–12.8% NDCG@5 | Medium: history mining job | Noise from mega-commits and renames |
| 9 | Dead-code annotations and penalties | Low-medium: LLM distraction evidence is indirect | Low | Entry points and reflection produce false "unused" |

### Gaps
- No study quantifies the agent-level benefit of framework-aware edges, dead-code flags or usage-example tools specifically. The evidence is indirect: code-completion or hallucination studies and static-analysis recall studies.
- The MARIN, LLM-fragility, call-graph-recall and co-change figures come from search summaries. The primary PDFs (arXiv, ACM) were blocked or unread.
- No numbers were found for symbol-level (method-level) co-change precision or recall comparable to ROSE's file-level figures. The learning-to-rank paper reports only relative NDCG gains in the accessible summary.
- These leads were identified but not read, because of blocking or the exhausted budget:
  - "When Retrieval Hurts Code Completion: A Diagnostic Study of Stale Repository Context" ([arXiv 2605.14478](https://arxiv.org/pdf/2605.14478))
  - "How Does Chunking Affect Retrieval-Augmented Code Completion?" ([arXiv 2605.04763](https://arxiv.org/pdf/2605.04763))
  - "Exploration Structure in LLM Agents for Multi-File Change Localization" ([arXiv 2606.11976](https://arxiv.org/pdf/2606.11976))
  - REDO, "Execution-Free Runtime Error Detection for Coding Agents" ([arXiv 2410.09117](https://arxiv.org/pdf/2410.09117))
