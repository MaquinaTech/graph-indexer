# Precomputed semantic facts, edit formats and delivery channels for a "code compiler for AI agents" (state 2026-09-24)

Scope: what graph-indexer (tree-sitter code graph, Node.js, MCP + CLI + hooks, **no execution of the target repo's code**) could precompute, how edits should be expressed, and how a transformed view can reach today's agents. This note does not repeat the following earlier notes; it cites them where they already settle a point:
- `docs/research/notes/output_rewriting_and_read_hooks.md`: hook contracts, capability tables, RTK/trace-mcp evidence.
- `docs/research/notes/static_analysis_incremental.md` §4: Ekstazi/STARTS/TCTracer/naming conventions.
- `research_notes/Impacto real de indexación en agentes/*`: CodePlan, WarpGrep.

Verification legend (research done 2026-09-24):
- **[V]** Read this session in a primary source (a git clone of the authors' or vendor's repo). Snapshots:
  - `Aider-AI/aider` @5dc9490 (2026-05-22)
  - `can1357/oh-my-pi` @62bc57b (2026-09-24)
  - `nwyin/edit-bench` @a652e16 (2026-03-23)
  - `GeometricAGI/geometricagi.github.io` @2026-05-11
  - `d3ara1n/pi-extensions` @2026-09-24
  - `lkraider/pi-linehash-edit` @2026-08-01
  - `openai/codex` @29f056c (2026-09-24)
  - `openai/openai-cookbook` (2026-09-24)
  - `openai/tiktoken` @4e71bbe (2026-08-16)
  - `anthropics/claude-code` CHANGELOG @d78be94 (2.1.281, 2026-09-23)
  - `nus-apr/auto-code-rover` (2026-09-24)
- **[V2]** Seen only in a web-search snippet or a secondary page. The proxy blocked arxiv.org, dev.to, nwyin.com, blog.can.ac, stencil.so, relace.ai, morphllm.com, simonwillison.net, pypi and npm, so the papers themselves were not opened.
- **[U]** Background knowledge that was not re-verified this session.
- **[I]** Inference from the cited facts; not measured anywhere.

---

## 1. Function summaries, contracts, effects and types for LLMs: what helps, measured

### Takeaway
- **What has measured support:**
  - Out-of-file definitions and API signatures of the code being edited (i.e. "link tables").
  - *Selective* bug-relevant facts.
- **What measured badly:**
  - Retrieved "similar code" (up to −15%).
  - Dumping every fact: repair performance is **non-monotonic in the number of facts**.
  - LSP-style semantic lookups as a token saver: "conditional and usually negative".
- **No measured evidence** was found that static effect/purity/raises annotations improve LLM bug fixing or cut tokens. This is an open question, not a known win.
- LLM-generated specifications (SpecRover, nl2postcond) help, but they need an LLM, and usually test execution, to produce and validate. graph-indexer can host such facts but cannot generate or validate them under its policy.

### Cited Findings
- **Fact Selection Problem / MANIPLE** (Parasaram et al., ICSE 2025) [V2]
  - Technique: 19K prompts combining 7 facts on 314 BugsInPy bugs. Facts range from code context to "angelic values".
  - Effect:
    - "each fact … is beneficial", aiding bugs that would otherwise stay unfixed.
    - Effectiveness is "non-monotonic over the number of used facts; using too many facts leads to subpar outcomes"; "no one-size-fits-all set".
    - MANIPLE (random-forest fact selector) repairs **88 of 157 test bugs, 17% above the best fixed configuration**.
  - Availability: paper; artifact not checked.
  - Usable in graph-indexer? Yes, as a design rule. Serve facts per query (callee contracts, the types used, callers) with a small default budget, never a full dump. Angelic values need execution, so they are out.
  - Sources: [arXiv 2404.05520](https://arxiv.org/abs/2404.05520), [ICSE 2025](https://conf.researchr.org/details/icse-2025/icse-2025-research-track/131/The-Fact-Selection-Problem-in-LLM-Based-Program-Repair)
- **Static project map + out-of-file definitions/usages appended to the repair prompt** [V2, survey snippet]
  - Effect: GPT-3.5 top-1 fix rate **22.6% → 56.0%**; GPT-4 **41.1% → 81.5%**.
  - Caveat: the primary paper was not identified; the numbers come from a survey's summary.
  - Usable in graph-indexer? Yes. This is exactly the "link table" (the definitions an edited function touches), and it is buildable from the tree-sitter graph.
  - Source: [LLM-based APR survey, arXiv 2506.23749](https://arxiv.org/html/2506.23749v2)
- **What to Retrieve for Effective RAG Code Generation** (ICSE 2026) [V2]
  - Effect:
    - "in-context code and potential API information significantly enhance LLM performance, whereas retrieved similar code often introduces noise, degrading results by up to 15%".
    - AllianceCoder (retrieves APIs by semantic description) +10–20% Pass@1 over RepoCoder/RLCoder.
  - Usable in graph-indexer? Yes. Prioritize signatures/contracts of resolved callees; do not append "similar functions".
  - Source: [arXiv 2503.20589](https://arxiv.org/abs/2503.20589)
- **SpecRover / AutoCodeRover v2** (ICSE 2025)
  - Technique [V2]: iterative spec inference, i.e. function-level summaries of intended behavior gathered during retrieval, plus a reviewer agent that reconciles spec, tests and issue.
  - Effect [V2]: **$0.65 per issue** on SWE-bench Lite; ">50% improvement in efficacy over AutoCodeRover" on full SWE-bench (2,294 issues).
  - Earlier ACR, from its README [V]: v20240620 has 30.67% Lite at "less than $0.7" and ≤7 min per task; 46.20% Verified; 24.89% full.
  - License [V]: the ACR repo is now under the **"SONAR Source-Available License v1.0"** (not OSI open source).
  - Usable in graph-indexer? Only the idea. Summaries are LLM-generated at run time. graph-indexer could *store* agent-written summaries keyed by symbol and content hash, invalidated on change. Do not reuse the code.
  - Sources: [arXiv 2408.02232](https://arxiv.org/abs/2408.02232), [ACR README](https://github.com/nus-apr/auto-code-rover/blob/main/README.md)
- **nl2postcond** (Endres et al., FSE 2024) [V2]
  - Effect: LLM-written postconditions (as assertions) "were able to catch 64 real-world historical bugs from Defects4J"; GPT-4 postconditions are "generally correct".
  - Usable in graph-indexer? No as a generator (it needs an LLM plus execution to check discriminative power). It could hold agent-written assertions as facts.
  - Source: [arXiv 2310.01831](https://arxiv.org/abs/2310.01831), [project page](https://nl2postcond.github.io/)
- **"Does a Language Server Save Tokens for Coding Agents?"** (arXiv 2608.13568, Aug 2026) [V2]
  - Claim: "semantic retrieval is more token-efficient" is "asserted almost everywhere and measured almost nowhere". The answer is "conditional and usually negative".
  - Measured by task type:
    - Symbol-named localization: the LSP "costs tokens and the agent ignores it when free".
    - Reference completeness: it "buys precision but not token savings". It saves tokens only for the weakest model.
    - Noisiest repo: largest F1 gain, and tokens saved, "when grep is flooded with false positives".
  - Usable in graph-indexer? Yes, as expectation-setting. Precomputed reference/caller facts pay off mainly when text search is ambiguous (common names, many false matches). Gate delivery on that.
  - Source: [arXiv 2608.13568](https://arxiv.org/abs/2608.13568)
- **Hierarchical NL summaries for localization** (ICCSA 2025 workshop) [V2]
  - Effect: Pass@10 0.89 and Recall@10 0.33 on industrial Jira issues vs flat retrieval.
  - Caveat: low-tier venue, and summaries are LLM-generated.
  - Source: [Springer](https://link.springer.com/chapter/10.1007/978-3-031-97576-9_6)
- **Offline type inference for Python** [V2, secondary blogs]
  - Pyrefly (Meta, Rust) reached **1.0 in May 2026**; Astral's ty (Rust) is described as alpha/beta.
  - Reported timings: Django 5.2.1: ty 578 ms, pyrefly 911 ms, pyright 16.3 s. pandas: pyright 144 s vs pyrefly 1.9 s vs ty 1.5 s.
  - Conformance-suite snapshot 2026-09-11: pyrefly dev build 96.9% (140.5/145); ty 53.2%.
  - Licenses (pyright MIT, pyrefly MIT, ty MIT) [U].
  - Usable in graph-indexer? Optional sidecar. These are static checkers that parse the target code and do not execute it [I; confirm against the security policy]. They could fill `type` facts (hover/inferred return types) for Python. Pyright is Node, so it can be embedded in-process [U].
  - Sources: [pyrefly speed blog](https://pyrefly.org/blog/speed-and-memory-comparison/), [pydevtools comparison](https://pydevtools.com/handbook/explanation/how-do-mypy-pyright-and-ty-compare/), [danilchenko.dev](https://www.danilchenko.dev/posts/pyrefly-vs-mypy-vs-ty/)
- **Tool-returned code-intelligence claims without numbers** [V2]: Serena says symbolic tools are "much more token-efficient", but publishes no benchmark. — [Serena](https://github.com/oraios/serena)

### Inferences
- [I] Highest-value precomputed facts, ranked by evidence:
  1. Resolved definition + signature + docstring first line for every identifier in the viewed span (link table).
  2. Callers/references, only when the name is ambiguous in grep.
  3. Types for dynamic languages, from a checker sidecar or from annotations.
  4. Effects/raises/reads-writes: plausible but unmeasured. Ship them behind a flag and measure them.
- [I] Facts must be *budgeted and selectable* (MANIPLE's non-monotonicity). Default to around 5 facts per symbol and let the agent expand.
- [I] Invariant mining (Daikon-style) and angelic values need executions, so they fall outside the policy. Static effect analysis (assignments to `self.*`/globals, I/O calls, `raise` statements, `await`) is cheap from tree-sitter. Its precision is unknown.

### Gaps
- No study found that measures effect/purity/exception annotations given to an LLM for repair or localization. "Type-augmented prompting" for repair (as opposed to completion) was not found with numbers.
- RepoFuse and Monitor-Guided Decoding (types from a language server at decode time) were not re-verified [U]. They concern completion/decoding, not agentic repair.
- The primary paper behind the 22.6→56.0% number was not identified.

---

## 2. Change impact and static test selection: accuracy and how agents use tests

### Takeaway
- Classic static RTS evidence (STARTS vs Ekstazi: 68.28% vs 84.05% suite reduction, ~3–6% safety violations; naming conventions ~100% precision with low recall; TCTracer MAP 85%/92%) is already in `notes/static_analysis_incremental.md` §4.
- New for agents:
  - **Minimized regression-test subsets measurably raise resolution rates** (TestPrune: +8.0–12.9% relative).
  - Agent-written tests barely matter (≈3 points between a model that nearly always writes tests and one that almost never does).
- So a precomputed "tests that cover this symbol" list targets real post-edit cost. However, every published agent pipeline found selects tests *dynamically* (runs the suite first). No study measures static-only (no-exec) selection inside an agent loop.

### Cited Findings
- **TestPrune** ("When Old Meets New / Can Old Tests Do New Tricks for Resolving SWE Issues?", IBM, FSE 2026) [V2]
  - Technique: automatically minimizes the regression suite "to a small, highly relevant subset". Uses it both for reproduction-test generation and for patch validation.
  - Effect:
    - +6.2–9.0% relative issue reproduction (Otter).
    - **+8.0–12.9% relative resolution** in Agentless, SWE-Agent and Trae on SWE-bench Lite/Verified.
    - "1,000x shrinkage in test suite size"; "27x" less execution time; "<$0.05 per issue".
  - Usable in graph-indexer? The selection half, yes: rank tests by static reachability (imports, calls, naming) to the changed symbols. The agent runs them; graph-indexer does not.
  - Sources: [arXiv 2510.18270](https://arxiv.org/abs/2510.18270), [IBM Research](https://research.ibm.com/publications/can-old-tests-do-new-tricks-for-resolving-swe-issues)
- **Agentless regression selection** [V2]: "running all existing tests" to find the passing ones, then an LLM keeps those related to the edit. A candidate patch is rejected if it turns a selected passing test into a failure. This is dynamic.
  - Sources: [Agentless FSE 2025 PDF](https://lingming.cs.illinois.edu/publications/fse2025.pdf), [arXiv 2510.18270](https://arxiv.org/html/2510.18270v2)
- **Rethinking the Value of Agent-Generated Tests** (arXiv 2602.07900) [V2]
  - Setup: six LLMs on SWE-bench Verified.
  - Effect:
    - Resolved and unresolved tasks show "similar test-writing frequencies".
    - GPT-5.2 "writes almost no new tests" yet performs comparably.
    - Agent tests are mostly "observational feedback" (prints more than assertions).
    - A secondary summary gives Claude ≈83% test-writing vs GPT-5.2 almost never, "within ~3 points".
  - Usable in graph-indexer? Yes, as motivation. Pointing the agent at *existing* covering tests may replace ad-hoc test writing, a large post-edit cost.
  - Sources: [arXiv 2602.07900](https://arxiv.org/abs/2602.07900), [DevAssure summary](https://www.devassure.io/blog/agent-generated-tests-barely-help/)

### Inferences
- [I] A `tests_for(symbol|diff)` fact with tiers can serve the "after the first edit" phase with a one-line suggested command (`pytest path::test_x`) and no execution by graph-indexer. Tiers:
  - (a) naming-convention match (≈100% precision);
  - (b) the test file imports the changed module;
  - (c) a test function reaches the symbol through call edges within depth ≤3;
  - (d) co-change.
- [I] Emit the tier with each test, so the agent knows (a)/(b) are high-precision and (c)/(d) are "likely".

### Gaps
- TestPrune's minimization mechanism (static vs coverage-based vs LLM) was not read; the paper was blocked.
- No measurement of static-only test selection recall on SWE-bench-style tasks, or of agents consuming such a list.

---

## 3. Edit formats: measured comparisons, output tokens, failure rates, anchored and symbol edits

### Takeaway
- The format matters most for weaker models and large files:
  - GeometricAGI measured **o4-mini at 100% with AST (edit-by-name) edits vs 20.7% with unified diff** on the same 29 tasks.
  - Aider's leaderboard shows `whole` at a median 99.6% well-formed vs 94.2% for `diff` (min 64.4%).
- Frontier models are near-ceiling on search/replace (Opus 4.6 100%, GPT-5.4 96.6%).
- **Edit-by-symbol (AST) edits had zero format failures** across 4 models and cost ~621 output tokens/edit (Opus) vs 11,530 for whole-file on a 4,200-line file (**18×**).
- **Hashline (hash-anchored lines) results conflict:**
  - The author's benchmark: 14/16 models improve; Grok Code Fast 1 6.7% → 68.3%; −61% output tokens on Grok 4 Fast.
  - Independent replications: GPT-5.4-mini −32.8 pp; GPT-5.4 −10.3 pp; Opus −6.9 pp. Models mistype hashes.
  - Its robust benefit is *failure shape*: rejections return ground truth, so retries converge.
- Wrapping code in JSON hurts. Line numbers in the model's output are a known risk; OpenAI recommends formats "that do not use line numbers".

### Cited Findings

**Aider (Apache-2.0) [V]**
- **Unified diffs vs SEARCH/REPLACE** (2023-12-21): GPT-4 Turbo laziness benchmark **20% → 61%**; "lazy comments" on 12 → 4 tasks. June GPT-4 26% → 59%. "Experiments without 'high level diff' prompting produce a **30-50% increase in editing errors**." — [post](https://github.com/Aider-AI/aider/blob/main/aider/website/_posts/2023-12-21-unified-diffs.md)
- **Polyglot leaderboard data** (225 exercises; file `polyglot_leaderboard.yml`, 69 rows), computed this session:
  - `percent_cases_well_formed` median / min by format:
    - `whole`: 99.6 / 92.9 (n=15)
    - `diff` (search/replace): 94.2 / 64.4 (n=47)
    - `diff-fenced`: 98.45 / 92.4 (n=4)
    - `architect`: 100 (n=3)
  - Same model, two formats: Qwen2.5-Coder-32B `diff` 8.0% pass / 71.6% well-formed vs `whole` 16.4% / 99.6%.
  - Top row: gpt-5 (high), `diff`, 88.0% with 91.6% well-formed.
  - Source: [data](https://github.com/Aider-AI/aider/blob/main/aider/website/_data/polyglot_leaderboard.yml)
- **Code in JSON vs Markdown** (2024-08-14; means of 5 runs, pass@1, from `code-in-json.yml`):
  - gpt-4o-2024-08-06: 60.8 Markdown vs 57.6 JSON vs 56.9 strict JSON.
  - Claude 3.5 Sonnet: 60.5 vs 54.1.
  - DeepSeek Coder V2: 60.6 vs 51.1, with 5.0 syntax errors per run in JSON vs 0.
  - Source: [data](https://github.com/Aider-AI/aider/blob/main/aider/website/_data/code-in-json.yml)
- Usable in graph-indexer? Yes. If graph-indexer exposes an MCP edit tool, keep code bodies out of JSON-escaped strings where possible (freeform/grammar tools, or a fenced text parameter) [I].

**OpenAI apply_patch / V4A [V]**
- GPT-4.1 guide:
  - "GPT-4.1 … substantially improved diff capabilities"; the V4A format is one "on which the model has been extensively trained".
  - Context = 3 lines above and below, with `@@ class/def` scoping when that is not unique.
  - "SEARCH/REPLACE diff format used in Aider's polyglot benchmark, as well as a pseudo-XML format … both had high success rates". Shared traits: "(1) they do not use line numbers, and (2) they provide both the exact code to be replaced, and the exact code with which to replace it".
  - Source: [gpt4-1_prompting_guide.ipynb](https://github.com/openai/openai-cookbook/blob/main/examples/gpt4-1_prompting_guide.ipynb)
- GPT-5.1: the built-in `apply_patch` tool type "uses a freeform function call rather than a JSON format. In testing, the named function **decreased apply_patch failure rates by 35%**." — [gpt-5-1_prompting_guide.ipynb](https://github.com/openai/openai-cookbook/blob/main/examples/gpt-5/gpt-5-1_prompting_guide.ipynb)
- Codex (Apache-2.0) constrains the patch with a Lark grammar: `*** Begin Patch`, `*** Update File:`, `@@ context`, `+/-/ ` lines, `*** End of File`. The tool is "FREEFORM … do not wrap the patch in JSON". — [apply_patch.lark](https://github.com/openai/codex/blob/main/codex-rs/core/assets/tools/apply_patch.lark), [apply_patch_spec.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/apply_patch_spec.rs)

**GeometricAGI, "AST Edits: The Code Editing Format Nobody Uses"** (2026-04-02) [V]
- Setup: 29 Python tasks on files of 100–4,200 lines, checked by test suites; 4 models × 7 formats.
- AST edit: a JSON list of ops targeting `Class.method` by name (`replace_function_body`, `replace_function`, `add_method`, `add_before/after`, `delete`, `add_import`, `replace_imports`, `replace_global`), resolved with Python `ast` start/end lines.
- Correctness (Haiku 4.5 / o4-mini / GPT-5.4 / Opus 4.6):

  | Format | Haiku 4.5 | o4-mini | GPT-5.4 | Opus 4.6 |
  |---|---|---|---|---|
  | AST edit | 86.2 | 100 | 100 | 100 |
  | Whole file | 96.6 | 82.8 | 96.6 | 100 |
  | Hashline JSON ops | 82.8 | 79.3 | 100 | 89.7 |
  | Search/replace | 62.1 | 75.9 | 96.6 | 100 |
  | Hashline S/R | 65.5 | 75.9 | 86.2 | 93.1 |
  | Unified diff | 58.6 | 20.7 | 89.7 | 93.1 |
  | Hashline UD | 37.9 | 69.0 | 93.1 | 79.3 |

- Format vs logic failures (all models):

  | Format | Format failures | Logic failures |
  |---|---|---|
  | Unified diff | 31 | 9 |
  | Hashline UD | 9 | 26 |
  | Hashline S/R | 15 | 8 |
  | Search/replace | 11 | 8 |
  | Hashline JSON | 8 | 6 |
  | Whole file | 0 | 7 |
  | AST edit | **0** | 4 |

- Average output tokens (Opus):

  | Format | Tokens | Latency |
  |---|---|---|
  | Hashline S/R | 311 | 6.8 s |
  | Hashline UD | 346 | 6.9 s |
  | Hashline JSON | 394 | 7.3 s |
  | Unified diff | 432 | 7.9 s |
  | Search/replace | 543 | 11.2 s |
  | AST edit | 621 | 9.1 s |
  | Whole file | 11,530 | 113.4 s |

- Hash errors: "Hashline methods fail when the model gets a hash wrong. It sees `483:d4` … writes `483:3a` … Every model does this, including Opus."
- Caveats: small n (29 tasks), Python only, single run, blog (not peer-reviewed); license of the benchmark repo not checked.
- Source: [post source](https://github.com/GeometricAGI/geometricagi.github.io/blob/main/_posts/2026-04-02-ast-edits.md), [rendered](https://geometricagi.github.io/2026/04/02/ast-edits.html)
- Usable in graph-indexer? **Yes, directly.** graph-indexer already has tree-sitter symbol spans for about 12 languages. An MCP `edit_symbol(qualified_name, op, new_text, expected_hash)` would resolve spans from the index, re-parse to verify, and write the file. That is a file write, not code execution.

**Hashline / oh-my-pi** (Can Bölük; MIT, © Zechner, Bölük, Stencil Labs) [V repo; V2 for blog numbers]
- The benchmark as reported in the omp README and third-party summaries:
  - 16 models × 180 tasks × 3 runs.
  - Hashline ≥ patch on 14/16 models.
  - Grok Code Fast 1 **6.7% → 68.3%**; Gemini 3 Flash +5 pp over str_replace.
  - Grok 4 Fast **−61% output tokens** ("once the retry loop on bad diffs disappears"); MiniMax 2.1×.
  - One loser, DeepSeek V3.2, per a third-party investigation note [V2].
  - Sources: [omp README](https://github.com/can1357/oh-my-pi/blob/main/README.md), [pi-linehash-edit README](https://github.com/lkraider/pi-linehash-edit/blob/main/README.md), [blog](https://blog.can.ac/2026/02/12/the-harness-problem/)
- **The current omp format has evolved from per-line hashes** [V]:
  - A per-file 4-hex snapshot tag `[PATH#TAG]`, a "content-derived hash of the whole normalized file".
  - Plain original line numbers: `PUT N.=M:`, `PUT <N:`/`>N:`, `CUT`.
  - **Tree-sitter block anchors `PUT N*:`**: "resolve from the opening line through the tree-sitter node's end".
  - Named registers for cross-file moves.
  - Edits are rejected when they are "outside the recorded seen-line ranges, in an elided region, or based on a stale snapshot that cannot be recovered safely".
  - A "short model exclusion list" falls back to `replace`.
  - Sources: [docs/tools/edit.md](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/edit.md), [hashline prompt](https://github.com/can1357/oh-my-pi/blob/main/crates/pi-edit/prompts/hashline.md)
- Claude Code has an open feature request for hashline-style addressing [V2]. — [anthropics/claude-code#25775](https://github.com/anthropics/claude-code/issues/25775)

**Independent hashline replications**
- **edit-bench** (nwyin, 2026-03) [V]:

  | Benchmark | Model | Replace | Hashline |
  |---|---|---|---|
  | react-edit | Haiku 4.5 | 75.0% | 76.3% |
  | react-edit | Sonnet 4.6 | 82.5% | 85.0% |
  | edit-bench | Haiku 4.5 | 73.3% | 72.2% |
  | edit-bench | GPT-5.4-mini | 95.0% | **62.2%** |

  - react-edit forgives whitespace through Prettier normalization.
  - "Haiku hashline has a **24.4% patch failure rate**… Sonnet hashline has 0%".
  - "Neither benchmark has enough statistical power" at 1–3 pp margins.
  - A later issue is titled "unified tool names eliminate hashline performance gap" [V2].
  - No LICENSE file in the repo.
  - Sources: [benchmark-comparison.md](https://github.com/nwyin/edit-bench/blob/main/benchmark-comparison.md), [issue #13](https://github.com/nwyin/edit-bench/issues/13)
- **"The Shape of Edit Failures"** (d3ara1n, pi-hashline-edit) [V]
  - On DeepSeek V4 Flash, hashline fails on ~80% of edits vs ~50% for string replace, "yet every session finishes faster on hashline".
  - A failed string match returns only "oldText not found" (a *divergent* retry). A hashline mismatch returns "content shifted to line 14. Resend … { line: 14, hash: 9A2F }" (a *convergent* retry).
  - Source: [docs/shape-of-edit-failures.md](https://github.com/d3ara1n/pi-extensions/blob/main/docs/shape-of-edit-failures.md)
- **pi-linehash-edit** (lkraider, MIT, 2026-08) [V]
  - A `N│` line prefix costs **2.277 o200k tokens per line**; a per-line guarded (hashed) prefix costs **3.795**. So one checksum per response beats one per line.
  - Post-edit windows of ±32 lines: **−45.2% tokens** vs first-to-last-change output, with all 80 later-referenced rows kept.
  - Live pilot: 12/12 tasks in both arms, −11.37% total tokens; one model, and the CI did not establish ≥10%.
  - Source: [README](https://github.com/lkraider/pi-linehash-edit/blob/main/README.md)

**Other format studies [V2]**
- **Diff-XYZ** (JetBrains, arXiv 2510.12487): udiff formats are best for Apply/Anti-apply. **Search-replace is best for diff generation, especially for larger models.** Modified udiff variants (udiff-h without line numbers, udiff-l) help smaller models. Claude 4 Sonnet and GPT-4.1 score highest. — [arXiv 2510.12487](https://arxiv.org/abs/2510.12487)
- **Diffs vs Whole Files** (arXiv 2609.05779, Sept 2026): 100M and 0.5B models on Flutter/Dart (≈1,790 tasks per model). Whole-file beats iterative search/replace "on every metric"; diffs are competitive "on short, spatially local edits". Tiny models only, so transfer to frontier agents is weak. — [arXiv 2609.05779](https://arxiv.org/abs/2609.05779)
- **Fast-apply models** (vendor claims):
  - Morph Fast Apply: 7B, "10,500 tok/s", "98% accuracy"; "cuts token usage by 50-60%" vs whole-file rewrite.
  - Relace Apply 3: "10k tok/s", "state-of-the-art merge accuracy".
  - The model writes a lazy sketch (`// ... existing code ...`) and a remote model merges it.
  - Usable in graph-indexer? No. They are remote, paid, and model-based. A lazy sketch anchored by symbol name is what AST edits achieve deterministically [I].
  - Sources: [Morph](https://www.morphllm.com/fast-apply-model), [Relace](https://relace.ai/blog/relace-apply-3)
- Earlier note (Soluciones existentes…/labs_y_empresas.md §6) lists Morph Fast Apply at ~98% [S] — consistent.

### Inferences
- [I] Output tokens cost 5× input, so the ranking by output cost per successful edit favors symbol-addressed edits and search/replace, and whole-file is 18–20× worse on big files. Hashline is cheapest per attempt, but its correctness is model-dependent.
- [I] Recommended graph-indexer edit surface (MCP, works on every host):
  - (1) `replace_symbol` / `insert_after_symbol` / `delete_symbol`, addressed by a qualified name from the link table;
  - (2) a guard `expected_hash` (per-symbol content hash, not per line, since models mistype per-line hashes);
  - (3) on mismatch, return the current symbol text plus the fresh hash (convergent failure);
  - (4) re-parse with tree-sitter after the write and reject a new syntax error with the error location;
  - (5) keep the host's native str_replace as a fallback for sub-symbol edits.
- [I] Never expect the model to emit line numbers it must compute. Line numbers are fine only when copied from a view that is still fresh (oh-my-pi guards them with a file-snapshot tag).

### Gaps
- No peer-reviewed multi-language comparison of AST/symbol edits vs search/replace on agentic benchmarks (SWE-bench-style) was found. The GeometricAGI evidence is 29 Python tasks.
- The Anthropic text-editor tool (`str_replace`) failure rates are not published; the blocked vendor pages were not opened.
- Harness Problem per-model tables were not read in the primary blog (blocked).

---

## 4. Source maps and bidirectional views: transformed code with edits mapped back

### Takeaway
- Two families exist:
  - **Lossless re-renderings with a converter** (format stripping, AST-equivalent grammars): −10% to −42% tokens. All but the formatting study need model training, or only affect input.
  - **Elided views that keep real line numbers** (oh-my-pi's summarized `read`), where the edit tool enforces "you may only edit lines you have actually seen".
- The second is the only shipped design that handles the failure case explicitly (reject, then re-read). It is the pattern graph-indexer can copy without training.
- Replacing a first Read with a skeleton hurt recall in earlier measurements (see `notes/output_rewriting_and_read_hooks.md`: skeleton recall 34.8%).

### Cited Findings
- **"The Hidden Cost of Readability"** (arXiv 2508.13666, 2025) [V2]
  - Removing indentation, whitespace and newlines: **−24.5% input tokens on average** (Java up to −42%), with "negligible" performance loss.
  - Prompting for unformatted output: GPT-4o **−27.2% output tokens** in Java/C++/C#, performance maintained.
  - Ships a bidirectional tool (format → compact → LLM → reformat).
  - Usable in graph-indexer? Partly. It works for brace languages in *read-only* views (link tables, context packs). It must not be used for the text the agent will quote in `old_string`. It does not apply to Python/YAML (indentation is semantic).
  - Source: [arXiv 2508.13666](https://arxiv.org/abs/2508.13666), [PDF](https://xiaoningdu.github.io/assets/pdf/format.pdf)
- **SimPy** (ISSTA 2024) [V2]
  - An AST-equivalent Python grammar with a Python↔SimPy converter: −13.5% tokens (CodeLlama), −10.4% (GPT-4).
  - Needs models trained or fine-tuned to write SimPy.
  - Usable in graph-indexer? No for current agents.
  - Source: [arXiv 2404.16333](https://arxiv.org/abs/2404.16333)
- **Token Sugar** (ASE 2025) [V2]
  - 799 reversible shorthand pairs: up to −15.1% source tokens; −11.2% generation tokens after pretraining. With SimPy: −22.4% LeetCode, −20.0% HumanEval.
  - Needs pretraining.
  - Source: [arXiv 2512.08266](https://www.arxiv.org/pdf/2512.08266)
- **ShortCoder** (arXiv 2601.09703) [V2]: 10 AST-preserving Python simplification rules give −18.1% tokens; plus fine-tuning. — [arXiv 2601.09703](https://arxiv.org/abs/2601.09703)
- **oh-my-pi summarized `read`** (MIT) [V]
  - Defaults `read.summarize.enabled = true`; files under 100 lines stay verbatim; guards ≤2 MiB and ≤20,000 lines.
  - The summary "keeps selected declarations and replaces elided spans with `…` or merged brace-pair lines containing `{ … }`". A footer lists concrete ranges: "`[…NNln elided; re-read needed ranges, e.g. <path>:5-16,40-80]`".
  - Lines keep **original numbers** (`41:def alpha():`) under a `[path#TAG]` header.
  - The edit tool rejects anchors "outside the recorded seen-line ranges, in an elided region"; the snapshot store holds 256 paths × 4 versions.
  - Stale tags recover "only when the recorded snapshot chain proves a unique safe result".
  - Same pattern for profiles: `.cpuprofile` and `sample` reads return summaries, and `:raw` bypasses them.
  - No task-level measurement of summarized reads was found.
  - Sources: [docs/tools/read.md](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/read.md), [docs/tools/edit.md](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/edit.md), [CHANGELOG](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md)

### Inferences
- [I] Source-map contract for graph-indexer views:
  - (a) every emitted code line carries its real `path:line`, or sits inside a block headed `path:start-end`;
  - (b) elisions are explicit, with the exact range to re-read;
  - (c) views carry a content hash of each file or symbol;
  - (d) graph-indexer's own edit tool refuses edits to unseen or elided spans or to stale hashes, and returns the live text (convergent failure);
  - (e) views that change characters (whitespace stripping, shorthand) are marked read-only, since host-native `str_replace` matches disk bytes.
- [I] Claude Code's Edit matches `old_string` against the *disk* file. A reformatted view therefore produces failed edits unless the agent re-reads verbatim. Elision with verbatim kept lines is compatible; character-level compaction is not.

### Gaps
- No paper or tool found that measures *edit* success when the model saw a transformed view and a mapper translated its edit back. The formatting paper maps whole generated files, not partial edits.
- No published evaluation of oh-my-pi's summarize-on-read (tokens or solve rate).

---

## 5. Delivery channels: can a local tool substitute a Read result with a different rendering? (delta only)

### Takeaway
- Nothing changed in Claude Code between 2.1.280 and **2.1.281 (2026-09-23)** for `updatedToolOutput`, `updatedInput` or the Read shape. The earlier note's contracts stand.
- So the exact capability is:
  - A PostToolUse hook *can* substitute Read's text with any string, provided it keeps the envelope `{type:"text", file:{filePath, content, numLines, startLine, totalLines}}`.
  - The harness then prefixes line numbers counting from `startLine`. A non-contiguous rendering therefore shows **wrong line numbers**.
  - Later Edits match disk bytes, not what the model saw.
- Hosts where the Read tool can be *wholly replaced*:
  - OpenCode and Kilo: a custom tool with a built-in's name wins.
  - pi / oh-my-pi: extensions replace `read`/`edit` (pi-linehash-edit, pi-hashline-edit).
  - Copilot CLI (`modifiedResult`) and Cline SDK (`afterTool.result`) replace the result text.
- Cursor (MCP-only output replacement) and Codex (blocking only) cannot substitute a built-in read.

### Cited Findings
- Claude Code CHANGELOG 2.1.281 [V]: no hook-contract change. Relevant fix: "Improved the time to resume long sessions that read many files; the restored file cache now matches the files as they were read". The read cache tracks file state, but whether it records a *replaced* rendering remains undocumented. — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Envelope, schema validation, line numbering from `startLine`, dedup `file_unchanged` stub, read-before-edit rules, and the early-access `tool.call` function hook: see `notes/output_rewriting_and_read_hooks.md` §2 [V there].
- pi ecosystem [V]: `pi-linehash-edit` "gives pi two strict, token-efficient tools for changing files: `read` and `replace`". This is full replacement of the native read/edit pair, with per-response checksums. — [README](https://github.com/lkraider/pi-linehash-edit/blob/main/README.md)
- oh-my-pi [V]: a first-party example of Read and Edit designed together (summarized read + snapshot tags + seen-range enforcement), §4 above.

### Inferences
- [I] For Claude Code, a *safe* substitution is limited to:
  - (a) a single contiguous window, rendered verbatim, with a correct `startLine`;
  - (b) the same content with a short prepended header (link table / facts) placed in `additionalContext`, not in `content`. This keeps numbering and `old_string` fidelity.
  - Anything denser (elided outlines, compact formatting) should be an MCP tool result, where graph-indexer controls numbering and provides its own symbol-addressed edit tool.
- [I] Cross-host plan:
  - The MCP `view` + `edit_symbol` pair is the universal channel.
  - Hooks add pointers and facts.
  - Full Read replacement only on hosts that support tool override (OpenCode/Kilo, pi), behind opt-in.

### Gaps
- Whether Claude Code's Read dedup (`file_unchanged`) and resume cache key on the replaced or the original content: not documented.
- Whether bug #68951 (ignored `updatedToolOutput` for Bash) affects Read in 2.1.281: no statement found.

---

## 6. Tokenizer-level facts for token-efficient code rendering

### Takeaway
- OpenAI's public BPE pre-tokenizers:
  - group runs of whitespace (so deep indentation is cheap);
  - split digits into groups of 1–3;
  - in o200k, split words at lower→Upper case boundaries.
- Claude's tokenizer is not public. Anthropic states **Opus 4.7's new tokenizer uses ~1.0–1.35× the tokens** of earlier models, with code at the high end; third parties measured ~1.45×.
- Measured rendering costs: a line-number prefix costs ~2.3 o200k tokens per line; removing formatting saves ~24.5% input.
- No vendor guidance on token-efficient code rendering was found.

### Cited Findings
- **tiktoken pre-tokenizer patterns** (MIT) [V]
  - cl100k_base `pat_str` includes `\p{N}{1,3}+` (digits in 1–3 chunks), ` ?[^\s\p{L}\p{N}]++[\r\n]*+` (punctuation runs absorb trailing newlines), `\s*[\r\n]` and `\s+(?!\S)` (whitespace runs, excluding the last space before a word).
  - o200k_base adds case-aware letter chunks `[\p{Lu}…]*[\p{Ll}…]+`, so `parseConfig` pre-splits into `parse` + `Config` [I from regex], and punctuation absorbs `[\r\n/]*`.
  - Source: [openai_public.py](https://github.com/openai/tiktoken/blob/main/tiktoken_ext/openai_public.py)
- **Line-number prefixes** [V]: `N│` = 2.277 o200k tokens per displayed line; a hashed per-line prefix = 3.795 (pi-linehash-edit measurements). — [README](https://github.com/lkraider/pi-linehash-edit/blob/main/README.md)
- **Claude tokenizer change** [V2]: "Claude Opus 4.7 uses a new tokenizer … roughly 1x to 1.35x as many tokens"; code and structured data trend high; independent measures 1.45× (a CLAUDE.md) and 1.47× (technical docs); prices unchanged at $5/$25 per MTok.
  - Sources: [Anthropic: What's new in Claude Opus 4.7](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7), [claudecodecamp measurement](https://www.claudecodecamp.com/p/i-measured-claude-4-7-s-new-tokenizer-here-s-what-it-costs-you), [Simon Willison token counter](https://simonwillison.net/2026/apr/20/claude-token-counts/)
- **Formatting cost** [V2]: −24.5% input tokens average and up to −42% for Java when formatting is removed (§4). — [arXiv 2508.13666](https://arxiv.org/abs/2508.13666)

### Inferences
- [I] Rendering rules for dense views:
  - Keep the original indentation (cheap under whitespace-run tokens, needed for verbatim quoting).
  - Prefer one `path:start-end` header per block over per-line numbers when the agent does not need per-line anchors: that saves ~2.3 tokens × lines.
  - Use short stable symbol IDs in link tables instead of repeating fully qualified paths.
  - Avoid JSON-escaping code, which adds `\n` and `\"` tokens and costs correctness (Aider data).
- [I] Measure with Anthropic's token-counting endpoint per model, since Opus 4.7+ counts differ from 4.6 by up to ~35–47% on code-like text.

### Gaps
- How Claude's tokenizer handles indentation, long identifiers and punctuation is unpublished. No local measurement was possible (the proxy blocked the tiktoken rank files, pypi and npm, and the Claude counting API needs a key).
- No published guidance from Anthropic or OpenAI on token-efficient code rendering was found.
