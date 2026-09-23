# Papers and benchmarks (2025 – Sep 2026): how coding agents navigate, search, read and understand repositories, and what makes them faster, cheaper or more accurate

*Research date: 2026-09-23.*

*Scope: navigation tools, localization and retrieval, repository QA, agent efficiency (tokens, turns, time, reasoning) and 2026 benchmark methodology. Context compression and tool-output pruning are excluded; they are covered in [`docs/research/notes/output_rewriting_and_read_hooks.md`](../../notes/output_rewriting_and_read_hooks.md). Results already established in the report [Impacto real de indexación en agentes](<../../reports/Impacto real de indexación en agentes.md>) and its notes are only pointed to, not repeated, unless there is a newer result or a correction. Those results include Code Isn't Memory, FastContext, CodeCompass, TDAD, the LSP-vs-grep study, CodeScaleBench, Codebase-Memory, deep agentic search, ContextBench, SWE-Explore, Agent Retrieval Bench, SWE-Effi, NameRTS, TestPrune, and the variance and power analyses.*

*Access and evidence markers:*
- *The sandbox proxy blocked arxiv.org, alphaxiv, huggingface.co, openreview.net, aclanthology.org, proceedings.iclr.cc, microsoft.com, github.com (web pages and API) and the paper-mirror sites.*
- *The session's web-search budget ran out before the end, so some leads stay unread (see each "Gaps").*
- *Public GitHub repositories could be cloned with git and read locally.*
- ***[R]**: read in this session from the authors' repository (README, docs or result figures).*
- ***[X]**: a search-engine extract of the named paper page (abstract or HTML), not the full text. Spot-check it before quoting.*
- ***[S]**: a secondary summary (review site, social post, news). Lowest confidence.*
- *"≈" marks a value read off a plot.*

---

## 1. Code navigation and tools for agents: symbol, LSP and graph tools versus grep

### Takeaway
2026 results split by **how** structure reaches the agent:
- **It helps when added to the agent's own lexical loop or given up front as evidence-backed localization:**
  - LARGER attaches graph neighbours to the agent's own search output: +11.8–13.9 file Acc@5.
  - SHERLOC: +5.95 pp resolve rate with 23% fewer tokens.
  - ACQUIRE: +4.4 pp with 7–17% fewer rounds.
  - RepoAtlas: up to +3.0 pp with fewer model calls.
- **It hurts when the tool replaces the shell for a frontier model.** Claude Sonnet 4.5 scores ≈62 function-level F1 with plain bash versus ≈44 with a single go-to-definition tool. Bash-capable models do as well with a bare shell, at lower cost.

How the interface is organized changes steps, tokens and run-to-run consistency by 40–70% or more, even when the information it exposes is the same. Examples: code-as-action, parallel calls, structured low-level tools.

### Cited Findings

**Already established (not repeated here):**
- The index inside the harness (Code Isn't Memory): +8.5 pp and 28.3 vs 36.0 turns.
- The optional-tool adoption problem: 58% of runs with no graph call; 0–6% LSP use.
- Forced LSP: success falls from 100% to 89%.
- "Alongside grep it adds; instead of grep it needs completeness."
- Source: [report](<../../reports/Impacto real de indexación en agentes.md>).

**Go-to-definition as the navigation primitive**

- **RepoNavigator, "One Tool Is Enough"** (arXiv 2512.20957, Dec 2025; later versions retitled "…of LLM Agents for Repository-Level Code Navigation") [X]
  - Setup:
    - A localization agent with one tool, `jump`, which goes to the definition of an invoked symbol. It is implemented with a language server.
    - Trained end-to-end with RL (GRPO) from base Qwen2.5-Instruct 7B/14B/32B, with no distillation from closed models.
    - Evaluated on SWE-bench Verified.
  - Results:
    - SOTA on sample-F1 and IoU at file and function level.
    - The 7B model beats 14B baselines, 14B beats 32B systems, and 32B beats closed models run in the same scaffold.
    - Raising the allowed number of jumps (up to 12) improves results before and after RL.
    - Direct GRPO beats RFT-only and RFT+GRPO.
    - A hybrid reward that includes tool-call success beats an outcome-only reward.
    - It beats RepoSearcher (distilled from Claude-3.7-Sonnet, then GRPO) on every metric except recall.
    - As the front end of an Agentless repair back end (Qwen2.5-14B), function-level IoU rises from 5.28% to 14.58%.
  - Caveats:
    - Localization metrics only; no resolve rate.
    - Python.
    - The extracts disagree on which closed model is surpassed: "Claude-3.7-Sonnet" in one, "GPT-5 on most metrics" in the abstract extract.
  - Sources: [arXiv 2512.20957](https://arxiv.org/abs/2512.20957); [review](https://www.themoonlight.io/en/review/one-tool-is-enough-reinforcement-learning-for-repository-level-llm-agents) [S]; [topic page](https://www.emergentmind.com/topics/reponavigator) [S]
- **The same model with bash versus the jump-only scaffold** [R ≈], read off the CodeScout authors' main figures (SWE-bench Verified). This is the cleanest same-model comparison found. It shows that restricting a frontier model to go-to-definition costs function-level localization.
  - The CodeScout figure also resolves the RepoNavigator extract conflict above:
    - RepoNavigator-32B (≈34 function F1) beats Claude-3.7-Sonnet (≈32) and GPT-5-Chat (≈31) *inside its own scaffold*.
    - It stays far below Claude Sonnet 4.5 (≈62) or GPT-5 (≈55) with bash.
  - Source: [verified_function_main.png](https://github.com/OpenHands/codescout/blob/main/docs/verified_function_main.png); [verified_file_main.png](https://github.com/OpenHands/codescout/blob/main/docs/verified_file_main.png)

  | Model (scaffold) | File-level F1 | Function-level F1 |
  |---|---|---|
  | Claude Sonnet 4.5 (OpenHands-Bash) | ≈82 | ≈62 |
  | Claude Sonnet 4.5 (RepoNavigator, jump only) | ≈80 | ≈44 |
  | GPT-5 (OpenHands-Bash) | ≈78 | ≈55 |
  | GPT-5-Chat (RepoNavigator) | ≈59 | ≈31 |
  | Claude-3.7-Sonnet (RepoNavigator) | ≈73 | ≈32 |
  | CodeScout-14B (bash, RL) | ≈68.5 | ≈40 |
  | RepoNavigator-32B (jump, RL) | ≈68 | ≈34 |
  | Qwen3-32B (OpenHands-Bash) | ≈63 | ≈24 |
  | Qwen2.5-32B in OrcaLoca / LocAgent / Agentless / CoSIL | ≈58 / ≈44 / ≈35 / ≈31 | ≈29 / ≈21.5 / ≈27 / ≈22 |

  Caveats:
  - Values are read from plots (±1).
  - Localization F1 only, not resolve rate.
  - Seeds and step limits are unknown.
  - The graph-scaffold rows use Qwen2.5, the bash rows Qwen3.
- **CodeScout** (arXiv 2603.17829, 18 Mar 2026; OpenHands) [R + X]
  - Setup:
    - RL-trained code-search agents (1.7B, 4B, 14B) that use only a Unix terminal (`rg`, `sed`, `cat`).
    - Reward: the sum of file-, module- and function-level F1.
    - Evaluated on SWE-bench Verified, Pro and Lite, re-labelled in LocAgent format.
    - 14B training: 300 steps on 9.6K instances, batch 32, 4 rollouts each, 50K context with YaRN.
  - Results:
    - Beats base and post-trained models 2–18× larger, including RepoNavigator-32B and CoSIL-32B.
    - 8–33% higher function-level F1 than Qwen3-32B (thinking).
    - "Sometimes approaches" Claude Sonnet and GPT-5.
  - Models, data and evaluation trajectories (12 models × 3 benchmarks) are released.
  - The authors frame it as a *localization subagent*.
  - Sources: [README](https://github.com/OpenHands/codescout) [R]; [arXiv 2603.17829](https://arxiv.org/abs/2603.17829) [X]; [model card](https://huggingface.co/OpenHands/CodeScout-14B) [X]

**Structure delivered inside the agent's lexical loop**

- **LARGER** (arXiv 2605.16352, 8 May 2026) [X]
  - Setup:
    - "Lexically Anchored Structural Localization": the agent's *own* lexical search queries are matched to graph anchors.
    - A confidence-filtered local expansion adds structurally related evidence (imports, call chains, type hierarchies, code–test links) *within the same search output*. Graph evidence is "delivered within lexical observations rather than through a separate graph tool, database, or traversal loop".
    - It drops into existing CLI agents.
  - Results:
    - +13.9 pts file Acc@5 on LocBench with tuned hyperparameters, and +11.8 with fixed ones, over the strongest baseline.
    - Consistent gains on MuLocBench, SWE-Atlas Test Writing and SWE-Atlas Codebase QA.
  - Baselines: BM25, Agentless, SWE-agent, OpenHands, Codex, Claude Code, mini-swe-agent, CoSIL and LocAgent.
  - The in-house methods use GPT-5.2 while Claude Code uses Opus 4.6, so absolute numbers are not directly comparable.
  - Source: [arXiv 2605.16352](https://arxiv.org/abs/2605.16352)
- **CodeNib** (arXiv 2607.25431, 28 Jul 2026) [X]
  - Setup:
    - Lexical, dense and structural views per commit.
    - Outputs mapped to repository-relative source ranges.
    - Views maintained across edits.
    - Ranked search, symbol navigation and bounded context served through one runtime.
  - Results:
    - Graph and vector updates are 8.7× and 25.4× faster at the median than a rebuild, with identical outputs.
    - Static navigation matches the live language server on 63% of 1,000 requests; the median live/static latency ratio is 4.7×.
    - "Across five models, selected context policies preserve localization with **50–87% fewer trajectory tokens** than paired grep/read."
  - Caveat: localization, not resolve rate.
  - Sources: [arXiv 2607.25431](https://arxiv.org/abs/2607.25431); [repo](https://github.com/sysevol-ai/CodeNib) [R]
- **SeeRepo, "LLM Agents Can See Code Repositories"** (arXiv 2606.14061, 12 Jun 2026; ASE 2026) [R + X]
  - Setup:
    - Built on mini-swe-agent.
    - A pre-built AST graph (contains / imports / invokes / inherits), queried through a CLI that renders a Graphviz subgraph PNG next to text.
    - Two configurations: "always query graph first", and "smart: query graph only when the file path is not already known".
  - Results on SWE-bench Verified:
    - GPT-5-mini Pass@1 55.4% (+0.4 pp), with input tokens −25% and cost −26%.
    - Doubao-Seed-2.0-Lite +1.0 pp, cost −6%.
  - Caveat: the resolve deltas are within noise; the efficiency gain is the signal. Seeds unknown.
  - Sources: [README](https://github.com/cslsolow/SeeRepo) [R]; [arXiv 2606.14061](https://arxiv.org/abs/2606.14061) [X]
- **RepoAtlas** (arXiv 2609.16936, Sep 2026) [X]
  - Setup:
    - Training-free "select–project–refresh" loop over a code graph.
    - It selects a task-relevant connected subgraph (15 nodes / 20 edges) by fusing lexical, semantic and trajectory evidence (node-wise max plus personalized PageRank).
    - It projects the subgraph as a visual topology plus a source-grounded text index.
    - The view is refreshed **only when the agent's state (Localize / Edit / Test) makes it stale**.
  - Results: up to +3.0 pp on SWE-bench Verified "while cutting input tokens, model calls, and API cost".
  - Caveat: magnitudes of the savings not retrieved.
  - Source: [arXiv 2609.16936](https://arxiv.org/abs/2609.16936)

**Front-loaded localization and repository knowledge**

- **SHERLOC** (arXiv 2606.24820, Jun 2026) [X]
  - Motivation: agents "utilize half their budget on locating faults before editing".
  - Setup: training-free; a reasoning LLM with compact repository tools and self-recovery; no fine-tuning or multi-agent orchestration.
  - Results:
    - 84.33% Acc@1 on SWE-bench Lite and 81.27% recall@1 on Verified; ~30B models match other agentic methods.
    - Injecting SHERLOC's locations **plus its diagnostic findings** into repair agents gives an average **+5.95 pp** resolve rate on Verified, taking the best SHERLOC result per setting.
    - Cuts localization tokens by 36.7% and total tokens by 23.1% on average.
  - Caveat: "best result per setting" is an optimistic selection; method authors.
  - Source: [arXiv 2606.24820](https://arxiv.org/abs/2606.24820)
- **ACQUIRE, "Know Before Fix"** (arXiv 2607.11111, Jul 2026) [X]
  - Setup: a Questioner and an Answerer build evidence-grounded repository QA before a Resolver writes the patch.
  - Results on SWE-bench Verified:
    - Up to +4.4 pp single-attempt success over the shared base agent and other pre-repair methods.
    - QA injection cuts mean agent rounds by **7.1%** on all 500 instances and by **17.1%** on the 44 fail→pass instances.
  - Source: [arXiv 2607.11111](https://arxiv.org/abs/2607.11111)
- **SWE-Adept** (arXiv 2603.01327, 1 Mar 2026, v2 25 May 2026) [X]
  - Setup:
    - A localization agent doing "agent-directed depth-first search that selectively traverses code dependencies, minimizing issue-irrelevant content".
    - A resolution agent with Git-checkpoint tools.
  - Results on SWE-bench Lite and Pro: up to +4.7% resolve and up to +5.4% function-level localization.
  - Source: [arXiv 2603.01327](https://arxiv.org/abs/2603.01327)

**Interface and harness ablations**

- **"The Devil Is in the Interface"** (arXiv 2608.11386, Aug 2026; COLM 2026) [X]
  - Setup:
    - Six tool architectures that expose equivalent information and actions.
    - Three actor models, 11,700 trajectories.
    - SWE-bench Live, Verified and Pro.
  - Results:
    - Structured low-level interfaces raise **consistency across repeated attempts up to 4.7×** versus bash-only.
    - Natural-language search broadens exploration and raises access to relevant files by >11%.
    - A **Python CodeAct-style interface reaches similar task performance with 41.6% fewer steps and 56.3% fewer tokens**.
  - Source: [arXiv 2608.11386](https://arxiv.org/abs/2608.11386)
- **"An Empirical Study of Harness Design for Coding Agents"** (arXiv 2609.20804, Sep 2026) [X]
  - Setup:
    - 176 matched settings on SWE-bench Verified and Terminal-Bench 2.1 with four models.
    - Varies planning, action space and context management.
  - Results:
    - Predefined tools help models that are weak at bash.
    - **Bash-capable models work well with a bash-only interface at substantially lower cost.**
    - Planning is an accuracy scaffold for weaker models and a *cost saver* for stronger ones, with little change in accuracy.
  - Source: [arXiv 2609.20804](https://arxiv.org/abs/2609.20804)
- **"Exploration Structure in LLM Agents for Multi-File Change Localization"** (arXiv 2606.11976, 10 Jun 2026) [X]
  - Diagnosis: most agents explore linearly, one directory or file per step, which is a structural mismatch for changes that span subsystems.
  - Result: domain-scoped **parallel** agent spawning with a Haiku-class model gets the highest micro-F1 among Haiku-class systems "by a large margin", and matches or beats a Codex 5.5 High CLI baseline.
  - Also: unconstrained traversal drifts into large test hierarchies or stale paths.
  - Caveat: a single repository (ansible, from SWE-bench Pro) in a persistent-session setup.
  - Source: [arXiv 2606.11976](https://arxiv.org/abs/2606.11976)

### Inferences
- **Replace or augment:**
  - The same pattern appears in the CodeScout figure, the harness-design study and the prior LSP study. Replacing the shell with a structured tool helps weak or small models and hurts frontier ones.
  - Augmenting the shell's own observations (LARGER) or front-loading evidence (SHERLOC, ACQUIRE) helps both.
  - For graph-indexer this favours hooks that annotate searches and reads, and briefs given at task start. It argues against tool-only modes.
- **Go-to-definition is the right primitive; one-per-call is the wrong granularity:**
  - RepoNavigator shows a jump-only policy suffices when trained, and that more jumps help.
  - The Devil/CodeAct result shows that folding several actions into one step removes ~40% of steps.
  - Together they suggest graph-indexer's "71% of searches chase a name just seen" is a *call-granularity* cost, not a capability gap.
- **Measured resolve-rate gains from structure keep landing at +0.4 to +6 pp** (SeeRepo, RepoAtlas, ACQUIRE, SWE-Adept, SHERLOC). This is consistent with the report's "+2 to +8 pp" expectation.
- **Efficiency effects are larger and more consistent:** −7% to −87% of tokens or rounds.

### Gaps
- Not read this session (search budget exhausted or pages blocked):
  - SWE-Search (MCTS), CGM, OrcaLoca, CodeNav.
  - Lingxi ([arXiv 2510.11838](https://arxiv.org/abs/2510.11838)), SWE-Debate ([arXiv 2507.23348](https://arxiv.org/abs/2507.23348)).
  - CODESTRUCT ([arXiv 2604.05407](https://arxiv.org/abs/2604.05407)) and SWE-Edit ([arXiv 2604.26102](https://arxiv.org/abs/2604.26102)).
  - The rendered-code study ([arXiv 2608.09268](https://arxiv.org/abs/2608.09268)).
  - IssueExec ([arXiv 2607.17286](https://arxiv.org/abs/2607.17286)).
  - The 2024–25 localization systems are in `docs/research/notes/graph_localization_papers.md`.
- **No end-to-end resolve rate** was found for LARGER, RepoNavigator or CodeScout used as front ends of a frontier agent.
- RepoAtlas's token, call and cost magnitudes and SeeRepo's seeds were not retrieved.
- **Probable misattribution:** a search extract attached this to SWE-Adept: "36 task instances with insufficient tests, 345 erroneous patches labelled as passed, affecting 40.9% of SWE-bench Lite and 24.4% of Verified leaderboard entries". These figures appear to belong to UTBoost ([arXiv 2506.09289](https://arxiv.org/abs/2506.09289)), which the prior notes list as unread. Unverified, not used.

---

## 2. Localization and retrieval: trained localizers, rankers, embeddings, routing and SOTA numbers

### Takeaway
- **Trained small localizers now beat 32B graph scaffolds:**
  - CodeScout-4B/14B reach ≈37–40 function F1 on Verified.
  - FuseSearch-4B reaches 84.7 / 56.4 file / function F1 with 68% fewer turns.
  - A²Agent adds +8.55 F1 on Pro.
  - A frontier model with plain bash still leads (≈62 function F1).
- **Headline SOTA numbers use incompatible metrics** (Acc@1, Acc@5, recall@1, F1), so rankings across papers are not meaningful.
- **Retrieval metrics are poor proxies for outcomes.** A packing policy with *higher* file recall (87.8% vs 80.6%) resolved 7.6 pp *fewer* issues than one that spent the same budget on more chunks from fewer files.

### Cited Findings

**Localization SOTA, 2026**

| Benchmark | System (date, venue) | Metric | Result | Source |
|---|---|---|---|---|
| SWE-bench Lite | SHERLOC (Jun 2026) | Acc@1 | 84.33% | [arXiv 2606.24820](https://arxiv.org/abs/2606.24820) [X] |
| SWE-bench Verified | SHERLOC | recall@1 | 81.27% | [arXiv 2606.24820](https://arxiv.org/abs/2606.24820) [X] |
| SWE-bench Verified | FuseSearch-4B (Jan 2026; ACL 2026 Findings) | file / function F1 | 84.7 / 56.4 | [arXiv 2601.19568](https://arxiv.org/abs/2601.19568) [X] |
| SWE-bench Verified | Claude Sonnet 4.5 + OpenHands-Bash | file / function F1 | ≈82 / ≈62 | [CodeScout figures](https://github.com/OpenHands/codescout/tree/main/docs) [R ≈] |
| SWE-bench Verified | CodeScout-14B (Mar 2026) | file / function F1 | ≈68.5 / ≈40 | [CodeScout figures](https://github.com/OpenHands/codescout/tree/main/docs) [R ≈] |
| SWE-bench Verified / Pro | A²Agent (Aug 2026; EMNLP 2026 Main) | average F1 over prior SOTA | +1.58 / +8.55 | [arXiv 2608.29831](https://arxiv.org/abs/2608.29831) [X] |
| Loc-Bench | FastCode + Gemini-3-Flash (Mar 2026) | Acc@1 | 86.13% vs LocAgent 77.74% | [arXiv 2603.01012](https://arxiv.org/abs/2603.01012) [X] |
| LocBench | LARGER, GPT-5.2 (May 2026) | file Acc@5 over strongest baseline | +13.9 tuned, +11.8 fixed | [arXiv 2605.16352](https://arxiv.org/abs/2605.16352) [X] |
| SWE-bench Lite | SweRank, Llama-3.1-8B listwise reranker fine-tuned on SWELoc (2025, background) | function Acc@5 / Acc@10 | 77.01 / 85.77 | [arXiv 2505.07849](https://arxiv.org/abs/2505.07849) [X] |

The ground-truth definitions differ: gold functions parsed from the patch, LocAgent-format labels, recall@1 versus Acc@1. The FuseSearch and CodeScout F1 values may not be computed identically.

**Trained localization policies**

- **FuseSearch** (arXiv 2601.19568, Jan 2026; ACL 2026 Findings) [X]
  - Diagnosis: agents that run tools concurrently show a **34.9% redundant invocation rate**, which cancels the benefit of parallelism.
  - Setup:
    - Defines tool efficiency as unique information gain per invocation.
    - SFT then RL to learn *adaptive* search breadth: wide in exploration, narrow in refinement.
  - Results for FuseSearch-4B on SWE-bench Verified:
    - 84.7% file-level and 56.4% function-level F1.
    - "93.6% speedup".
    - **67.7% fewer turns and 68.9% fewer tokens.**
  - Sources: [arXiv 2601.19568](https://arxiv.org/abs/2601.19568); [ACL Anthology](https://aclanthology.org/2026.findings-acl.143/)
- **A²Agent** (arXiv 2608.29831, Aug 2026; EMNLP 2026 Main; Sungkyunkwan University) [X]
  - Diagnosis: existing localization agents "often discover correct code regions during exploration but fail to commit them".
  - Setup: a per-turn reward for discovery *and* commitment, plus action-level advantage estimation.
  - Results: +1.58 F1 on SWE-bench Verified and +8.55 F1 on SWE-bench Pro over SOTA.
  - Source: [arXiv 2608.29831](https://arxiv.org/abs/2608.29831)
- **CodeScout and RepoNavigator**: see §1. A bash-only RL policy (CodeScout) beats the jump-only RL policy (RepoNavigator) at every size compared (4B and 14B vs 32B). Source: [CodeScout figures](https://github.com/OpenHands/codescout/tree/main/docs) [R ≈]

**Rankers and embeddings**

- **SweRank+** (arXiv 2512.20482, Dec 2025) [X]
  - Setup:
    - SweRankMulti: an embedding retriever plus a listwise LLM reranker, trained on SweLocMulti (>155K PR-derived instances, 10 languages including Rust, Go, PHP, C/C++).
    - SweRankAgent: multi-turn search with a memory buffer.
    - Evaluated on SWE-PolyBench, SWE-bench Multilingual and Multi-SWE-bench.
  - Results: new SOTA; the agent loop improves over single-pass ranking. The numbers were not retrieved.
  - Source: [arXiv 2512.20482](https://arxiv.org/abs/2512.20482)
- **jina-code-embeddings** (2025; vendor) [X]
  - Average over 25 code-retrieval benchmarks: 78.41% (0.5B) and 79.04% (1.5B).
  - The 1.5B matches voyage-code-3 (79.23%) and beats gemini-embedding-001 (77.38%).
  - The 0.5B beats Qwen3-Embedding-0.6B by 5 pp.
  - The license (non-commercial) is noted in prior notes.
  - Source: [Jina](https://jina.ai/news/jina-code-embeddings-sota-code-retrieval-at-0-5b-and-1-5b/)
- **CORE-Bench** (arXiv 2606.11864, Jun 2026) [R + X]
  - Scale per level:
    - Level-1 code understanding: 172,961 queries over 2.41M corpus items.
    - Level-2 issue-to-edit localization: 632 repositories, 5,061 queries, 9.38M chunks. Built from SWE-bench Pro, Verified, Live, SWE-Bench++, SWE-bench+, Multi-SWE-bench and Multilingual.
    - Level-3 broader context (tests, docs, config): 97 repositories, 2,580 queries, 2.61M chunks.
  - Metrics: NDCG@10 and Recall@100.
  - Findings:
    - BM25 "remains useful for exact identifiers, APIs, file names, stack traces, and configuration keys".
    - In-domain SFT on PR-derived supervision "substantially improves" embedders.
  - Per-model scores were not retrieved.
  - Sources: [CORE-Bench-Eval README](https://github.com/zhangfw123/CORE-Bench-Eval) [R]; [arXiv 2606.11864](https://arxiv.org/abs/2606.11864) [X]
- **q-log BM25** (arXiv 2605.18561, May 2026) [R]
  - Setup: replaces BM25's RSJ log-odds IDF with a Box-Cox/q-log transform, to amplify rare identifiers when the tokenizer is generic and frozen.
  - Results: on CoIR CodeSearchNet-Go, NDCG@10 rises from 0.2575 to 0.4874 (q=0.05).
  - Crucially, "identifier-aware tokenization largely removes the incremental gain".
  - Sources: [README](https://github.com/santoshkumarradha/rarecode); [arXiv 2605.18561](https://arxiv.org/abs/2605.18561)

**Retrieval metrics versus outcomes (negative and cautionary results)**

- **"The Recall Trap"** (arXiv 2608.14838, Aug 2026) [X]
  - Setup:
    - A retriever's hits are injected as a fixed 12-slot context pack, with no search tools.
    - One flag is toggled: one-chunk-per-file deduplication.
  - Results:
    - With dedup ON (≈12 files, one shallow chunk each), the gold files are present in 87.8% of packs, versus 80.6% with dedup OFF (≈5 files with stacked chunks).
    - Yet dedup OFF raises single-shot resolve **from 39.2% to 46.8% (+7.6 pp, p = 0.0003)**.
  - Authors' rule: A/B-test packing policies against task resolution, not the retrieval metric they were tuned on.
  - Source: [arXiv 2608.14838](https://arxiv.org/abs/2608.14838)
- **"Does Fault Localization Beat a Fresh Attempt?"** (arXiv 2609.00854, Sep 2026) [X]
  - Setup:
    - Placebo-controlled, with a shipped analysis plan.
    - Three frozen 26–32B models plus one 24B model, three benchmarks, 488 failing candidates.
    - Arms: blind resampling, Ochiai SBFL plus fill-in-the-middle of the most suspicious span, and a random-span placebo.
  - Results:
    - Only 9.0% of failing candidates had a usable spectrum.
    - On 177 localizable candidates, localized infilling **lost** to blind resampling at matched attempts (3:40, p = 3.0×10⁻⁹).
    - Against the placebo it led pooled (11:1, Holm p = .019), but in no single model under the primary analysis.
  - Caveat: non-agentic, single-span repair; it says little about repository navigation, but warns that a localization signal is not automatically useful.
  - Source: [arXiv 2609.00854](https://arxiv.org/abs/2609.00854)
- **"What Resolve Rate Hides"** (arXiv 2607.06184, Jul 2026; 2,500 trajectories from five production settings on SWE-bench Verified) [X]
  - The prior notes cover its search-loop finding.
  - New here:
    - "File choice is too coarse to separate success from failure, whereas function selection and completion behavior localize it."
    - Even resolved runs differ in how quickly they reach relevant code.
  - Source: [arXiv 2607.06184](https://arxiv.org/abs/2607.06184)

### Inferences
- The frontier of localization quality is now a **trained policy** (bash- or jump-based), not a better static graph.
  - A local engine competes on what it hands such policies: exact identifiers, complete reference sets, bounded spans. It does not compete on ranking alone.
  - CORE-Bench's note on BM25 and the q-log result both say that identifier-aware lexical retrieval remains a strong, cheap baseline. graph-indexer's subtoken BM25 should keep that role, and q-IDF tricks are unnecessary once tokenization is identifier-aware.
- **File-level metrics saturate; function selection and commitment are where success separates** (What Resolve Rate Hides, A²Agent). A localization evaluation for graph-indexer should report function-level metrics and whether the agent *edits* what it found.
- **Depth beats breadth under a fixed budget** (Recall Trap). This matches ARB's "given file trap" and ContextBench's recall-over-precision bias (prior notes). Returned context should favour several spans of the top few files over one span per file.

### Gaps
- SweRank+ numbers, CORE-Bench per-model scores, and 2026 reranker evaluations for agent localization were not retrieved.
- No 2026 study of **query routing** (lexical vs dense by query type) for agent localization was found beyond the Semble/CoIR evidence already in the report.
- Static-embedding updates beyond potion-code (in the report) were not searched.
- Titles surfaced but not read:
  - "Beyond Retrieval: A Multitask Benchmark and Model for Code Search" ([arXiv 2605.04615](https://arxiv.org/abs/2605.04615))
  - CLARC ([arXiv 2603.04484](https://arxiv.org/abs/2603.04484))
  - SACL ([arXiv 2506.20081](https://arxiv.org/abs/2506.20081))
  - BLAgent (2605.17965), "Reformulate, Retrieve, Localize" (2512.07022) and PatchRecall (2604.10481), all flagged in `docs/research/notes/benchmarks_evaluation.md`.

---

## 3. Repository understanding and QA: what context agents need and how much of what they read is used

### Takeaway
- **Repository QA now needs agentic exploration** (a ~13-point gap over direct answering on SWE-QA-Pro).
- **Long-context dumping is not a substitute:** Claude 3.5 Sonnet falls from 29% to 3% on LongSWE-Bench between 32K and 256K tokens.
- **Front-loading answers to targeted questions shortens repair** (−7% to −17% rounds).
- **What agents read is mostly not what they use:**
  - They find the right file early and still fail at function selection or commitment.
  - Policies that preserve localization with 50–87% fewer tokens exist.
  - The most useful context is deeper, not broader.

### Cited Findings

**Already established (not repeated):**
- ContextBench's explored-versus-utilized gap and backbone table: [metodologia_de_benchmarks.md](<../Impacto real de indexación en agentes/metodologia_de_benchmarks.md>).
- SWE-Explore's context efficiency (r = 0.950) and Agent Retrieval Bench: [report](<../../reports/Impacto real de indexación en agentes.md>).
- Deep agentic search (65.2% vs 46.2%).

**Benchmarks and results**

- **SWE-QA-Pro** (arXiv 2603.16124, Mar 2026; ACL 2026 Findings; TIGER-AI-Lab) [R + X]
  - Construction:
    - Built from long-tail repositories with executable environments.
    - Topic balance through issue-driven clustering.
    - Difficulty calibration removes questions that direct-answer models can solve.
  - Results:
    - Agentic workflows beat direct answering by **~13 points** (Claude Sonnet 4.5).
    - Qwen3-8B trained with SFT then GRPO (LLM-judged rubric reward) beats GPT-4o by +2.3.
  - Caveat: the answers are graded by an LLM judge.
  - Sources: [README](https://github.com/TIGER-AI-Lab/SWE-QA-Pro) [R]; [ACL Anthology](https://aclanthology.org/2026.findings-acl.837/)
- **SWE Atlas** (arXiv 2605.08366, May 2026; Scale AI) [X]
  - Composition:
    - Codebase Q&A (124 tasks), Test Writing (90) and Refactoring (70).
    - 11 production repositories in Go, Python, C and TypeScript.
    - Under-specified, agentic task statements.
  - Grading: programmatic checks plus rubrics (completeness, maintainability, hygiene).
  - Results:
    - GPT-5.4 and Opus 4.7 lead; open-weight models score poorly.
    - On 28 Jul 2026 the mini-swe-agent step cap was raised from 250 to 500 "to allow more room for exploration".
  - Caveat: vendor-run leaderboard.
  - Sources: [arXiv 2605.08366](https://arxiv.org/abs/2605.08366); [leaderboard](https://labs.scale.com/leaderboard/sweatlas-qna)
- **LongCodeBench** (arXiv 2505.07897, May 2025) [X]
  - Tasks: LongCodeQA and LongSWE-Bench, up to 1M tokens.
  - Results:
    - Claude 3.5 Sonnet on LongSWE-Bench drops **from 29% to 3%** from 32K to 256K.
    - Qwen2.5 on LongCodeQA drops from 70.2% at 512K to 40% at 1M.
    - Gemini 1.5 and 2.5 Pro are more stable.
    - Short-context scores do not predict long-context scores.
  - Source: [arXiv 2505.07897](https://arxiv.org/abs/2505.07897)
- **FastCode** (arXiv 2603.01012, Mar 2026; HKUDS) [R + X]
  - Setup:
    - Separates repository exploration from content consumption.
    - "Structural scouting" over a lightweight semantic-structural map.
    - A cost-aware policy builds the context in "a single, optimized step".
  - Results:
    - Beats baselines on SWE-QA, LongCodeQA, LOC-BENCH and GitTaskBench with much lower token use.
    - Loc-Bench Acc@1 86.13%.
    - The README claims 44–55% lower cost than Claude Code and Cursor and "up to 10x" token savings.
  - Caveat: authors' claims; the comparison protocol for the product numbers was not read.
  - Sources: [arXiv 2603.01012](https://arxiv.org/abs/2603.01012); [README](https://github.com/HKUDS/FastCode) [R]
- **ACQUIRE** (QA before fixing): +4.4 pp; −7.1% and −17.1% rounds. See §1. Source: [arXiv 2607.11111](https://arxiv.org/abs/2607.11111) [X]

**How much of what agents find or read is used**

- **ICSE 2026 trajectory study** ("Understanding Code Agent Behaviour", arXiv 2511.00197; OpenHands, SWE-agent, Prometheus on SWE-bench) [X]
  - Extra steps in failed runs:
    - Lite: +~20 steps for OpenHands and SWE-agent, +49 for Prometheus.
    - Verified: +44 for OpenHands, +22 for SWE-agent, +74 for Prometheus.
  - "The majority of trajectories that fail are still able to locate the problematic file."
  - Source: [arXiv 2511.00197](https://arxiv.org/abs/2511.00197)
- **A²Agent**: agents "discover correct code regions during exploration but fail to commit them". Source: [arXiv 2608.29831](https://arxiv.org/abs/2608.29831) [X]
- **CodeNib**: selected context policies preserve localization with 50–87% fewer trajectory tokens than paired grep/read, across five models. Source: [arXiv 2607.25431](https://arxiv.org/abs/2607.25431) [X]
- **The Recall Trap**: breadth (one chunk per file) loses 7.6 pp of resolve rate against depth. Source: [arXiv 2608.14838](https://arxiv.org/abs/2608.14838) [X]
- **GitHub Copilot production traces**: `get_file` is **35.0%** of all tool invocations, ahead of `run_command` (17.0%) and `replace_string` (9.8%). Reading dominates real agent activity. See §4. Source: [arXiv 2608.00101](https://arxiv.org/abs/2608.00101) [X]

### Inferences
- graph-indexer's own **14% of read lines inside the changed functions** (21% with graph-indexer) is in line with every 2026 measurement: agents over-read by design.
  - The evidence says the damaging failure is *missing* or *uncommitted* evidence (SWE-Explore, A²Agent, ICSE'26), not redundant evidence.
  - Tool output is also a small share of cost (§4).
  - So raising read precision is a weak lever for cost. Its value is as a **mediator metric**, and as a way to reach the right function (depth) sooner.
- **"Reaches a file of the fix around call 4, first edits around call 15–19"** (graph-indexer B3) matches three findings: failing agents still locate the file, agents discover but do not commit, and function selection separates success.
  - The actionable gap is **from file to function to commitment**, not file discovery.
  - Tools that help there: callers and callees of a candidate function, the tests that exercise it, and "these N functions match the issue terms, ranked with reasons".

### Gaps
- Not read:
  - LoCoBench-Agent.
  - DeepRepoQA ([arXiv 2608.24221](https://arxiv.org/abs/2608.24221)).
  - RepoProbe ([arXiv 2608.04783](https://arxiv.org/abs/2608.04783)).
  - Code-QA-Bench ([arXiv 2605.29277](https://arxiv.org/abs/2605.29277)).
  - SWE-QA per-model numbers (in prior notes only as the README).
- No 2026 study reports **line-level read precision** for a frontier agent in a way directly comparable to graph-indexer's 14%. ContextBench's span-level F1 is the nearest (prior notes).

---

## 4. Agent efficiency: where tokens, turns and time go, and what reduces them

### Takeaway
2026 measurements in billed, production and controlled settings agree with graph-indexer's own anatomy:
- **Cost is re-reading context.** Cache traffic is ≈87% of reconstructed cost, and token reduction correlates with cost reduction at only r = 0.15.
- **Real agents make one LLM call per tool call** (Copilot: ~1:1 coupling; `get_file` is 35% of calls).
- **Reasoning effort is an independent, often wasted, multiplier:**
  - Higher effort lowered accuracy in 21 of 36 HAL runs.
  - Mid effort recovers most accuracy at under half the tokens.
  - Opus 4.5 at medium effort matched Sonnet 4.5 with 76% fewer output tokens (vendor).

The interventions with large measured cuts in calls are:
- **Adaptive parallel search:** −67.7% turns.
- **Code-as-action interfaces:** −41.6% steps, −56.3% tokens.
- **More parallel calls per turn:** 6 → 4 turns.
- **Front-loaded localization or knowledge:** −7% to −23% tokens or rounds.

### Cited Findings

**Where the cost goes**

- **"Token Reduction Is Not Cost Reduction"** (PointFive; arXiv 2607.12161, Jul 2026) [X]
  - Setup: a pre-specified, hash-frozen, paired campaign of 2,908 provider-billed Claude Code runs (2,848 analysed): 103 tasks, 7 repositories, 3 models.
  - Results:
    - **Prompt-cache traffic ≈87% of reconstructed four-component cost (≈80% of the actual bill).**
    - Token reduction correlates weakly with cost reduction (**Pearson r = 0.15**).
  - Its compressor and proxy results are in the parallel notes.
  - Sources: [arXiv 2607.12161](https://arxiv.org/abs/2607.12161); [output_rewriting_and_read_hooks.md](../../notes/output_rewriting_and_read_hooks.md)
- **"How Do AI Agents Spend Your Money?"** (arXiv 2604.22750, Apr 2026; Stanford Digital Economy Lab / Microsoft Research listings; 8 frontier LLMs on SWE-bench Verified) [X]
  - Already known (parallel notes and report): ~1000× the tokens of chat or code reasoning; input tokens drive cost; up to 30× run-to-run variance; accuracy peaks at intermediate cost.
  - New:
    - Cache-read input is the largest category "by a wide margin in every phase".
    - Trajectories split into Setup / Explore / Fix / Validate / Closeout, and **Explore and Fix are the most expensive phases**.
    - The study also tests whether models can predict their own token cost before running.
  - Source: [arXiv 2604.22750](https://arxiv.org/abs/2604.22750)
- **GitHub Copilot production traces** ("Agentic Coding in the Wild", arXiv 2608.00101, Aug 2026; Microsoft Azure Research and UIUC)
  - Sample (June 2026) [X]: 3.2M users, 13M sessions, 761M LLM calls, 95T tokens.
  - [X]:
    - Sessions are sparse user turns, each unfolding into an agent loop of LLM calls "coupled nearly 1:1 with tool execution".
    - KV-cache hit rate averages **90% within a turn but 55% across turn boundaries**, and collapses after model switches or compaction.
    - `get_file` 35.0%, `run_command` 17.0%, `replace_string` 9.8% of invocations; the top 11 tools cover >90%.
  - Secondary summaries [S]:
    - 87% of LLM calls are agent-initiated.
    - The median is ~15 LLM calls per user turn.
    - Compaction hits 7.8% of sessions and cuts cache hit rate by 67%.
  - Sources: [arXiv 2608.00101](https://arxiv.org/abs/2608.00101); [Microsoft Research](https://www.microsoft.com/en-us/research/publication/agentic-coding-in-the-wild-characterizing-github-copilot-at-production-scale/); [post](https://x.com/rohanpaul_ai/status/2086356354713985266) [S]
- **Tokenomics** (arXiv 2601.14470, Jan 2026; 30 ChatDev tasks) [X]
  - Code review consumes 59.4% of tokens, against 2.4% for design and 8.6% for coding.
  - Input is 53.9% of tokens on average.
  - The cost of agentic development is in refinement and verification, not generation.
  - Caveat: a waterfall multi-agent framework, not an issue-fixing agent.
  - Source: [arXiv 2601.14470](https://arxiv.org/abs/2601.14470)

**How much of the budget goes to exploration before editing**

- **SHERLOC**: agents spend "half their budget on locating faults before editing". Source: [arXiv 2606.24820](https://arxiv.org/abs/2606.24820) [X]
- **ICSE'26 study**: failed runs are 20–74 steps longer, and most failures had found the file. Source: [arXiv 2511.00197](https://arxiv.org/abs/2511.00197) [X]
- **Cognition**: ">60% of the first turn" goes to retrieving context. This is in the prior notes. Source: [Cognition](https://cognition.com/blog/swe-grep); [evidencia_extremo_a_extremo.md](<../Impacto real de indexación en agentes/evidencia_extremo_a_extremo.md>)

**Reasoning tokens and effort**

- **"The Danger of Overthinking"** (arXiv 2502.08235, Feb 2025) [X]
  - Data: 4,018 SWE-bench Verified trajectories.
  - Three patterns: Analysis Paralysis, Rogue Actions and Premature Disengagement.
  - Results:
    - A higher overthinking score correlates with a lower resolve rate.
    - Reasoning models overthink more.
    - Picking the run with the lower overthinking score raises performance by almost 30% and cuts compute by 43%.
  - Source: [arXiv 2502.08235](https://arxiv.org/abs/2502.08235)
- **HAL, the Holistic Agent Leaderboard** (arXiv 2510.11977; ICLR 2026; Princeton) [X]
  - Data: 21,730 rollouts, 9 models, 9 benchmarks including SWE-bench Verified Mini, ≈$40K.
  - **Higher reasoning effort reduced accuracy in 21 of 36 runs** (e.g., Claude Opus 4.1 with no vs high reasoning; o4-mini low vs high).
  - Sources: [arXiv 2510.11977](https://arxiv.org/abs/2510.11977); [ML Anthology](https://mlanthology.org/iclr/2026/kapoor2026iclr-holistic/)
- **DeepSeek-V4.1-Flash technical report** (arXiv 2609.19969, Sep 2026; vendor) [X]
  - Raising effort from 25 to 100:
    - DeepSWE v1.1 Pass@1 rises from 66.0% to 74.2%, and Terminal-Bench 2.1 from 82.4% to 90.6%.
    - Output tokens grow ~2.5×.
  - **Efforts of 60–80 recover most of the maximum accuracy at under half the token budget.**
  - The last step to 100 makes trajectories 1.6–1.8× longer.
  - Across scaffolds, effort lengthens trajectories while Pass@1 "tracks this growth only loosely". Claude Code is the flattest curve on DeepSWE.
  - A summary [S] adds that in long agent loops "the majority of the spend comes from re-reading the same context".
  - Source: [arXiv 2609.19969](https://arxiv.org/abs/2609.19969)
- **Claude Opus 4.5 effort parameter** (Anthropic, Nov 2025; vendor) [X]: at medium effort, Opus 4.5 matches Sonnet 4.5's best SWE-bench Verified score **with 76% fewer output tokens**. Source: [Anthropic](https://www.anthropic.com/news/claude-opus-4-5)
- **"The Best Programming Language for Tokenmaxxing"** (arXiv 2607.22807, Jul 2026) [X]
  - Data: 4 languages × 5 models × 100 LiveCodeBench problems, 2,000 trajectories.
  - Results:
    - Language changes output tokens significantly; Python is the most efficient and OCaml the least.
    - "What matters is not the number of tokens in the final solution, but the amount of reasoning and revision needed."
    - Agents revise solutions that already pass and distrust the provided tests.
  - Source: [arXiv 2607.22807](https://arxiv.org/abs/2607.22807)
- **Effort changes tool effects:** in the parallel notes, a JetBrains A/B found an output compressor +7.6% more expensive at low effort and neutral at high effort. Source: [output_rewriting_and_read_hooks.md](../../notes/output_rewriting_and_read_hooks.md)

**What cuts calls and turns**

- **SWE-grep** (Cognition, Oct 2025; vendor)
  - Already in prior notes: up to 8 parallel tool calls per turn and 4 turns at most.
  - New [X]: in ablations, raising parallelism **from 4 to 8 searches per turn cut the turns spent searching from 6 to 4 at the same performance**.
  - Source: [Cognition](https://cognition.com/blog/swe-grep)
- **FuseSearch**: 34.9% of invocations in current parallel agents are redundant; adaptive breadth gives −67.7% turns, −68.9% tokens and a 93.6% speedup at SOTA-level F1 (§2). Source: [arXiv 2601.19568](https://arxiv.org/abs/2601.19568) [X]
- **"The Devil Is in the Interface"**: a CodeAct-style Python interface gives similar performance with −41.6% steps and −56.3% tokens (§1). Source: [arXiv 2608.11386](https://arxiv.org/abs/2608.11386) [X]
  - This matches Anthropic's programmatic tool calling (−37% tokens). Source: [context_engineering_mcp.md](../../notes/context_engineering_mcp.md); [Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)
  - It also matches the `execute_code`-only arm (−19.9% to −24.6% cost). Source: [arXiv 2607.10569](https://arxiv.org/abs/2607.10569), via [metodologia_de_benchmarks.md](<../Impacto real de indexación en agentes/metodologia_de_benchmarks.md>)
- **Exploration Structure**: domain-scoped parallel subagents beat linear exploration for multi-file localization (§1). Source: [arXiv 2606.11976](https://arxiv.org/abs/2606.11976) [X]
- **Co-Coder, "When Parallelism Pays Off"** (arXiv 2606.00953, Jun 2026) [X]
  - Setup: partitions repository-level multi-agent coding by a cohesion graph and schedules it in dependency order.
  - DevEval: 68.1% pass (+11.3 over sequential), latency −45% (442 s vs 800 s), cost −28%.
  - CodeProjectEval: 34.1% vs 20.1%, latency −52%, cost −35%.
  - Up to a 2.10× speedup over 28 tasks.
  - Caveat: code generation, not issue fixing.
  - Source: [arXiv 2606.00953](https://arxiv.org/abs/2606.00953)
- **Front-loading**:
  - SHERLOC: −23.1% total tokens.
  - ACQUIRE: −7.1% rounds overall, −17.1% on fail→pass.
  - SeeRepo: −25% input tokens and −26% cost.
  - RepoAtlas: fewer model calls.
  - CodeNib: 50–87% fewer trajectory tokens.
  - All in §1 [X]. Code Isn't Memory's 28.3 vs 36.0 turns is in the report.
- **Planning**: it is a cost saver for strong models, with accuracy roughly unchanged (§1). Source: [arXiv 2609.20804](https://arxiv.org/abs/2609.20804) [X]

**Benchmarks that score efficiency**

- **HAL** is the cost-controlled leaderboard: it reports accuracy against cost across harnesses. Source: [arXiv 2510.11977](https://arxiv.org/abs/2510.11977) [X]
- **SWE-fficiency** (arXiv 2511.06090; ICML 2026) scores **code-performance optimization**, not agent efficiency.
  - 498 tasks in 9 repositories (numpy, pandas, scipy…).
  - LMs reach <0.23× the expert speedup, often breaking correctness.
  - Do not use it as an agent-cost benchmark.
  - Source: [arXiv 2511.06090](https://arxiv.org/abs/2511.06090) [X]
- **SWE-Effi, ContextBench's efficiency AUC and SWE-rebench's cost per problem** are in the prior notes and report.

### Inferences
- graph-indexer's anatomy is confirmed on every axis measured elsewhere:
  - In B3, 22% of cost is the fixed prefix, 29% writing and 28% re-reading the model's own output, and 21% tool results ([AGENTIC-BENCHMARK.md](../../../AGENTIC-BENCHMARK.md)).
  - PointFive (cache ≈87% of cost; r = 0.15) and the Copilot traces (1:1 calls; cache hit 90% within a turn) show the same structure in billed and production data.
  - Cost is roughly **number of LLM calls × context size, plus reasoning**. Trimming bytes moves little; removing calls or reasoning moves a lot.
- **The model's own output (29% + 28% in B3) is the largest single lever**, and it is governed by effort and by uncertainty:
  - Effort studies disagree on accuracy: DeepSeek gains; HAL mostly loses.
  - They agree that mid effort is nearly free of loss and far cheaper.
  - No study tests whether structural certainty — complete caller lists, "no more references" — **lets an agent run at lower effort without losing accuracy**. That is a testable hypothesis graph-indexer is well placed to measure.
- **Serial one-hop navigation is the cost pattern to break.**
  - Copilot's 1:1 call/tool coupling shows production agents rarely batch.
  - SWE-grep and FuseSearch show batched or parallel lookups cut turns by a third to two thirds.
  - FuseSearch also shows naive parallelism wastes a third of calls.
  - For a local engine the implementable forms are: multi-name or multi-hop queries in one call; CLI queries chained in one Bash invocation (code-as-action); and hooks that attach the next hop to the observation.
- **The Copilot cache data affects hook design.** Injected context that is *appended* after a tool result keeps the prefix cache. Anything that changes earlier context, or switches models (subagents), pays the cache miss.

### Gaps
- The phase percentages (Explore vs Fix) from arXiv 2604.22750 and its self-prediction results were not retrieved.
- No study measures **reasoning tokens as a function of tool information**: does a structural fact reduce thinking?
- No 2026 test-selection result for agents beyond NameRTS and TestPrune (prior notes) was found. Verification-tool studies (e.g., "Validation Evidence in LLM Repair Agents", [arXiv 2607.28871](https://arxiv.org/abs/2607.28871)) were not read.
- SWE-AGILE ([arXiv 2604.11716](https://arxiv.org/abs/2604.11716), managing reasoning context) and ContextPilot ([arXiv 2608.28476](https://arxiv.org/abs/2608.28476)) are adjacent to the excluded compression topic and were not read.
- Latency, as opposed to tokens, is rarely reported. Only SWE-grep, FuseSearch, Co-Coder and CodeNib give wall-clock figures.

---

## 5. Benchmark methodology updates in 2026

### Takeaway
- **SWE-bench Pro now has a "Verified" version** because leakage and reward hacking inflated scores.
- **New suites add QA, test-writing and refactoring tasks** (SWE Atlas) and original long-horizon tasks (DeepSWE).
- **Cheap-evaluation methods matured.** Mid-difficulty task selection cuts 44–70% of tasks for rankings. DeltaSelect makes A/B tests 27× cheaper, but in-sample. 10% trajectory-aware subsets keep median error under 5% for regression checks. None of them replaces a paired, repeated design for estimating a small effect.
- **Tool interfaces change run-to-run consistency** by up to 4.7×, so consistency is itself an outcome.

### Cited Findings
- **SWE-Bench Pro Verified** (arXiv 2609.08149, 8 Sep 2026, rev. 16 Sep; ECNU, Shanghai AI Lab, Fudan) [X]
  - Adds anti-hacking safeguards against leakage of gold solutions and hidden evaluation information.
  - Makes minimal fixes to misleading statements and mis-scoped tests.
  - "Some models perform substantially worse than previously evaluated". SWE-bench Pro results "may overestimate" capability.
  - Per-model deltas were not retrieved.
  - Source: [arXiv 2609.08149](https://arxiv.org/abs/2609.08149)
- **SWE Atlas**: Codebase QnA 124, Test Writing 90 and Refactoring 70 tasks; rubric plus programmatic grading (§3). Source: [arXiv 2605.08366](https://arxiv.org/abs/2605.08366) [X]
- **DeepSWE** (arXiv 2607.07946, Jul 2026; datacurve)
  - Original long-horizon tasks. The leaderboard runs mini-swe-agent through Pier on Modal; Pier can also drive Claude Code, Codex, Gemini CLI and OpenCode [R].
  - Structured failure analysis [X]:
    - 30 tasks each from DeepSWE and SWE-bench Pro.
    - 9 frontier configurations × 3 runs.
    - A GPT-5.5 judge in a fresh sandbox, with access to the trajectory, the patch, the verifier output and the hidden reference.
  - Sources: [README](https://github.com/datacurve-ai/deep-swe) [R]; [arXiv 2607.07946](https://arxiv.org/abs/2607.07946) [X]
- **"Efficient Benchmarking of AI Agents"** (arXiv 2603.23749, Mar 2026) [X]
  - Data: 8 benchmarks, 33 scaffolds, 70+ model configurations.
  - Absolute-score prediction degrades under scaffold shift, but rank order is stable.
  - Evaluating only tasks with a **30–70% historical pass rate** cuts the task count by 44–70% while keeping high rank fidelity.
  - Sources: [arXiv 2603.23749](https://arxiv.org/abs/2603.23749); [code](https://github.com/fsndzomga/efficient-benchmarking-ai-agents)
- **DeltaSelect** (arXiv 2609.19607, Sep 2026) [X]
  - Data: a DeepSWE v1.1 snapshot of 22,586 trials (22,417 usable), 18 models, 50 model–effort configurations, 113 tasks.
  - **Only 22 of 113 tasks (19.5%)** have a 5th-percentile Pearson correlation ≥0.50 with full-benchmark performance.
  - A baseline-versus-candidate A/B costs $113.08 instead of $3,063.63 (27.1×).
  - Intended for development A/Bs, not rankings.
  - A critique [S] notes the saving is an in-sample projection: reliability is ranked and calibrated on the same snapshot.
  - Sources: [arXiv 2609.19607](https://arxiv.org/abs/2609.19607); [critique](https://github.com/jjakimoto/research-issues/issues/1589) [S]
- **Trajectory-aware subset selection** (arXiv 2609.24928, Sep 2026) [X]
  - Data: 76 configurations over 31,779 public trajectories (58 runs, 5 frameworks).
  - **A 10% subset keeps the median estimation error under 5% while cutting token cost ~90%.**
  - Source: [arXiv 2609.24928](https://arxiv.org/abs/2609.24928)
- **Consistency as an outcome**:
  - The interface changes consistency across repeats by up to 4.7× (§1). Source: [arXiv 2608.11386](https://arxiv.org/abs/2608.11386) [X]
  - Deterministic topology comments halve variance (in the report). Source: [arXiv 2606.26979](https://arxiv.org/abs/2606.26979)
- **Model-specific behaviour** ("Agent trajectories as programs", arXiv 2606.16988, Jun 2026) [X]
  - A probe over procedural signatures attributes an unseen trajectory to the correct agent 85.7% of the time.
  - Behaviour is most similar between models from similar release periods or distilled from one another.
  - Source: [arXiv 2606.16988](https://arxiv.org/abs/2606.16988)
- **AWS "Dissecting model behavior through agent trajectories"** (arXiv 2606.17454, Jun 2026) [X]
  - 138k trajectories from a simple harness that reproduces or improves providers' pass@1 on SWE-Pro, SWE-Verified and Terminal-Bench-2.
  - Argues that the "intent–execution gap" between what the model means and what the harness executes matters as much as tools.
  - Source: [arXiv 2606.17454](https://arxiv.org/abs/2606.17454)
- **Contamination-free generation, multi-site tasks and statistical power**: SWE-rebench, SWE-bench-Live, SWE-smith, R2E-Gym, SWE-Gym, Multi-SWE-bench, SWE-PolyBench, RefactorBench, CodePlan, and the power table (~55–75 tasks for 10 pp with 3 runs). No newer result changes them. Sources: [report](<../../reports/Impacto real de indexación en agentes.md>); [metodologia_de_benchmarks.md](<../Impacto real de indexación en agentes/metodologia_de_benchmarks.md>)

### Inferences
- **Two evaluation needs call for different designs:**
  - *Estimating* graph-indexer's effect needs the paired, repeated, stratified design already specified.
  - *Guarding* against regressions between releases can use a cheap fixed subset (DeltaSelect-style or a trajectory-aware 10%), re-validated against a periodic full run.
- **Rankings do not transfer across scaffolds in absolute terms** (Efficient Benchmarking), and behaviour is model-specific (fingerprinting). Results should be reported per model and harness, not pooled.
- **Numbers reported on SWE-bench Pro before September 2026 may be inflated by leakage.** This includes several vendor and academic claims cited in the report. New runs should use Pro Verified or fresh tasks.

### Gaps
- Not read:
  - SWE-Bench ProMax (large-scale multilingual refactoring, [arXiv 2608.09802](https://arxiv.org/abs/2608.09802)): task size and results.
  - SWE-Touch ([arXiv 2608.02499](https://arxiv.org/abs/2608.02499)).
  - "Efficient SWE Agent Benchmarking via Trajectory-Aware Evaluation" ([arXiv 2609.01603](https://arxiv.org/abs/2609.01603)).
  - EarlyEval ([arXiv 2609.02783](https://arxiv.org/abs/2609.02783)).
  - "A Time-Consistent Benchmark for Repository-Level SE Evaluation" ([arXiv 2603.26137](https://arxiv.org/abs/2603.26137)).
  - "Position: Coding Benchmarks Are Misaligned with Agentic Software Engineering" ([arXiv 2606.17799](https://arxiv.org/abs/2606.17799)).
- The per-model score drops on SWE-Bench Pro Verified were not retrieved.

---

## Implications for graph-indexer

### What the evidence says about graph-indexer's own findings

| graph-indexer finding ([AGENTIC-BENCHMARK.md](../../../AGENTIC-BENCHMARK.md)) | External evidence (2025–Sep 2026) | Verdict |
|---|---|---|
| The fixed prefix plus the model's reasoning are 79–89% of cost; tool outputs are 11–21% | PointFive: cache ≈87% of cost, token cut vs cost r = 0.15. Copilot: calls ~1:1 with tools; cache hit 90% within a turn. Output tokens are driven by reasoning and revision (Tokenmaxxing) | **Confirmed.** Cost ≈ calls × context + reasoning. |
| B3: ~21 calls before the first edit; a fix file is reached at ~call 4, the first edit at ~15–19 | SHERLOC: half the budget goes to locating faults. ICSE'26: failed runs are 20–74 steps longer yet still find the file. A²Agent: agents discover but do not commit. What Resolve Rate Hides: function selection and completion separate success | **Confirmed and explained.** The gap is file → function → commitment, not discovery. |
| 71% of searches chase a name just seen (grep used as go-to-definition, one hop per call) | RepoNavigator: jump-to-definition is a sufficient primitive and more jumps help. CodeScout figure: restricting frontier models to it costs ≈18 function-F1 points. FuseSearch and SWE-grep: batched or parallel lookups cut turns by 33–68%. CodeAct: −41.6% steps | **Explained.** The cost is per-call granularity, not the tool. Batch the hops; do not replace grep. |
| 14% of lines read fall in the changed functions (21% with graph-indexer) | ContextBench: recall over precision (prior notes). CodeNib: localization preserved with 50–87% fewer tokens. Recall Trap: depth beats breadth by +7.6 pp | **Consistent.** Low precision is universal and is a weak cost lever. Measure it as a mediator. |
| B3 cost unchanged with graph-indexer as an optional tool, while B1/B2 fall 19–33% | Harness-level or front-loaded interventions cut rounds: Code Isn't Memory (report); SHERLOC −23% tokens; ACQUIRE −7% to −17% rounds. Optional tools do not (report) | **Consistent.** The structure of the loop, not the tool list, sets B3 cost. |

### Adopt (ranked by expected effect on calls and cost in B3)

1. **Batched navigation in one call.**
   - *What:*
     - A query that takes several names, or a `file:line-range`, and returns in one response the definitions, signatures, one-hop callers and callees, and the tests of every non-local name used there.
     - Each result carries completeness flags and a budget.
     - The docs and server instructions should show chaining several CLI queries in **one Bash call**.
   - *Why:*
     - The 71% chase-name pattern.
     - RepoNavigator: the jump primitive, and more jumps help.
     - FuseSearch (−67.7% turns) and SWE-grep (4→8 parallel calls per turn: 6→4 turns).
     - CodeAct (−41.6% steps).
     - Copilot shows agents do not batch on their own.
   - *Measure:* the chase-name search rate, LLM calls before the first edit, and tool calls per LLM call.
2. **Attach the next hop to the observation, on reads as well as greps** (LARGER-style).
   - *What:*
     - When the agent reads a span, a hook appends the resolved locations of the names it uses and the caller counts, with completeness.
     - Refresh or skip when nothing changed, as RepoAtlas does ("refresh only when stale") and SeeRepo's "smart" configuration does ("only when the path is not already known").
     - Append after the tool result so the prefix cache is kept (Copilot cache data).
   - *Why:*
     - LARGER: +11.8–13.9 file Acc@5 with graph evidence "within lexical observations".
     - The report's finding that tools on the default path beat optional tools.
   - *Measure:* the same metrics as item 1, plus cache-hit rate per arm and cost per resolved task.
3. **A start-of-task localization brief for issue tasks** (SHERLOC- or ACQUIRE-style), through a hook or skill.
   - *What:* 3–8 candidate *functions*, not files, each with evidence (issue term → symbol → callers or tests), framed as candidates to verify.
   - *Why:*
     - SHERLOC: +5.95 pp resolve and −23% tokens.
     - ACQUIRE: +4.4 pp and −7% to −17% rounds.
     - A²Agent and ICSE'26 place the gap at function selection and commitment.
     - Caution: ARB's seed pilot (report) made 29–36% of samples worse, so measure harm per task.
   - *Measure:* the index of the first edit, the share of tasks harmed in paired runs, and the resolve rate.
4. **Depth-first packing** in every response that returns code (search, context, map).
   - *What:* several spans from the top 3–5 files rather than one span per file.
   - *Why:* the Recall Trap's +7.6 pp for depth over breadth at equal budget.
5. **Keep bash and grep first-class; make the CLI the primary surface for frontier agents.** Keep MCP tools for weaker or IDE-hosted models.
   - *Why:*
     - Bash-capable models are as good and cheaper with a bare shell (harness-design study).
     - The same frontier model loses ≈18 function-F1 points when restricted to go-to-definition (CodeScout figure).
     - Predefined tools help weak models.

### Test (new arms or factors for `bench/agentic`)

- **Effort × structure factorial on B3.**
  - *Design:* {grep, grep+gi+} × {low or medium effort, high effort}, with effort fixed and recorded in every other experiment.
  - *Hypothesis:* complete structural facts let lower effort match higher effort, cutting the 57% of B3 cost that is the model's own output.
  - *Why:*
    - HAL: 21 of 36 runs worse at higher effort.
    - DeepSeek: 60–80 effort recovers most accuracy at under half the tokens.
    - The Opus 4.5 effort result (vendor).
    - Overthinking correlates with failure.
    - Effort also flips the sign of tool effects (the RTK result in the parallel notes).
- **A batching instruction arm.** One frozen line ("issue independent lookups together; one graph-indexer query can take several names") against none.
  - *Measure:* tool calls per LLM call and the redundant-lookup rate (the same symbol queried twice; FuseSearch's definition).
- **A localization subagent on a cheaper model**, backed by graph-indexer and returning spans. This follows FastContext (report), CodeScout (bash-only works for trained policies) and Exploration Structure (domain-scoped parallel subagents).
  - *Measure:* main-agent calls, subagent cost and handoff failures (41.8% of failures in deep agentic search, per the report).
- **Deprioritized:**
  - Visual repository views: +0.4 to +1.0 pp for SeeRepo, and they need a multimodal agent.
  - Trained search policies: out of scope for a local engine. graph-indexer can serve them as a fast backend.

### Drop or deprioritize

- **Shrinking tool output as the lever for issue fixing.** PointFive gives r = 0.15, and tool output is 11–21% of graph-indexer's B3 cost. The compressor evidence is in the parallel notes.
- **Tool-only or no-grep default modes.** Keep them only as a completeness stress test, as the report recommends. See the CodeScout figure and the harness-design study.
- **Recall-maximizing defaults**, such as one chunk per file or wide file lists (Recall Trap).
- **Whole-repository context dumps** (LongCodeBench: 29% → 3%).
- **Localization accuracy as a success criterion.** Keep it as a mediator: file choice does not separate success, function choice and commitment do, and higher recall can lower resolve rate.

### Measure: additions to the existing protocol (paired resolve rate plus billed cost per resolved task, with the cache controlled)

- **Calls:**
  - LLM calls per task and before the first edit.
  - Tool calls per LLM call (parallelism).
  - The chase-name search rate and the redundant-lookup rate.
  - The step at which a gold *function* is first read and first edited.
  - Gold functions read but never edited ("discovered, not committed").
- **Reasoning:**
  - Output tokens per call, with thinking and visible text separated where the transcript allows.
  - The share of cost spent re-reading the model's own output.
  - The effort setting as a recorded factor.
- **Cache:**
  - Cache-hit rate per arm, and cache-neutral cost.
  - Any hook that edits early context, or any model switch, shows up here (Copilot: 90% within a turn vs 55% across turns).
- **Consistency:** pass^k and the per-task variance across repeats, since the interface alone changes consistency up to 4.7×.
- **Evaluation economics:**
  - Use the full paired design for effect claims.
  - For release-to-release regression checks, use a fixed subset of reliable, mid-difficulty tasks (30–70% historical pass; DeltaSelect-style correlation screening, or a 10% trajectory-aware subset), re-validated against periodic full runs.
  - Report per model and harness.
- **Task sources:**
  - Fresh post-cutoff tasks (B3) remain primary.
  - Use SWE-Bench Pro Verified rather than Pro.
  - Add LocBench and MuLocBench for localization comparisons against LARGER, the closest published analogue of graph-indexer's hook design.
  - Add SWE Atlas-style QnA and refactoring tasks as multi-site and QA strata.
