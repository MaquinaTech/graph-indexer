# End-to-end evidence (2025 – Sep 2026): do code-intelligence tools and context interventions improve AI coding agents' outcomes?

*Research date: 2026-09-22.*

*Method note: this session's egress policy blocked direct fetching of arxiv.org, huggingface.co, alphaxiv.org, pith.science, bytez.com and most vendor sites (cursor.com, augmentcode.com, blog.jetbrains.com, github.blog, morphllm.com, cognition.com, sourcegraph.com). Figures from those pages come from search-engine extracts of the named page and are marked "(extract)". Spot-check them against the PDF or page before quoting them externally. GitHub issue bodies (Serena #1491, codebase-memory-mcp #1382, woods #280) were read in full through the GitHub API and are marked "(read)". Statistics marked "(computed here)" are my own arithmetic on published numbers.*

*Classification used:*
- ***Independent**: no commercial stake in the tool.*
- ***Method-author**: academics evaluating their own technique.*
- ***Tool-author**: the open-source maintainer evaluating their own server.*
- ***Vendor**: a company selling the tool.*

*Scope note: older work (RepoGraph, LocAgent) appears only as background and is flagged. The earlier landscape notes (`docs/research/notes/industry_agent_retrieval.md`, `graph_localization_papers.md`) are not repeated except where end-to-end numbers matter.*

---

## 1. Independent and academic controlled studies: what changes when a code-intelligence tool is added to the same agent and model?

### Takeaway
Few 2025–2026 studies run a true "same agent, same model, with vs without the tool" ablation on end-to-end outcomes. The ones that do agree on a pattern:
- **Localization gains are large and robust**, from +20 to +40 pp.
- **Resolve-rate gains are small to moderate**, from +2 to +8.5 pp. They show up only with seeds or large samples.
- **Cost per solved task is flat or lower.**

The strongest single result is "Code Isn't Memory": Claude Opus 4.7, 3 seeds, 50.4% vs 41.9% resolve, and $2.30 vs $2.92 per solve. Its sample is small, roughly 82 tasks per seed (computed here), and the gains concentrate in multi-file changes.

Most other "evidence" does not measure resolve rate with vs without a tool:
- retrieval-only benchmarks: ContextBench, SWE-Explore, Agent Retrieval Bench;
- question answering: the SWE-QA study, Codebase-Memory;
- a single repository: CodeCompass;
- method papers: FastContext, TDAD.

### Cited Findings

**A. End-to-end controlled comparisons at a glance (2025 – Sep 2026)**

| Study (date; type) | Intervention and integration | Model(s) | Benchmark and N | Runs | Outcome delta | Cost / turn / token delta | Source |
|---|---|---|---|---|---|---|---|
| Code Isn't Memory (Jun 2026; academic, affiliation unverified) | Structural codebase index exposed as tools inside a fixed harness (SC-ON vs SC-OFF), plus the OpenCode agentic-grep harness as comparator | Claude Opus 4.7 (fixed) | SWE-PolyBench Verified + SWE-bench Pro; per-seed rates imply ≈82 cells per arm per seed (computed here) | 3 seeds | Resolve 50.4% vs 41.9% (+8.5 pp); Acc@5 84.5% vs 44.3% (+39.6 pp) | $/solve $2.30 vs $2.92 (−21%); turns 28.3 vs 36.0 (vs OpenCode) | [arXiv 2606.22417](https://arxiv.org/abs/2606.22417) (extract) |
| CodeCompass / "Navigation Paradox" (Feb 2026; method-author) | MCP tool giving Claude Code the 1-hop IMPORTS/INHERITS/INSTANTIATES neighbourhood of a file | Claude Code (model not in extract) | 30 tasks on one FastAPI repo, 258 trials | ≈3 per task per arm (computed here: 258/30/3) | Hidden-dependency tasks: 99.4% vs 76.2% (vanilla) and 78.2% (BM25) task completion | not reported in extract | [arXiv 2602.20048](https://arxiv.org/abs/2602.20048) (extract) |
| FastContext (Jun 2026; Microsoft, method-author) | 4B–30B SFT/RL explorer subagent returning file and line citations, plugged into Mini-SWE-Agent | GPT-5.4, others | SWE-bench Multilingual, SWE-bench Pro, SWE-QA | not in extract | "up to +5.5%" resolve; GPT-5.4 on SWE-bench Pro 46.0 → 51.5 | main-agent tokens "up to −60%" | [arXiv 2606.14066](https://arxiv.org/abs/2606.14066) (extract) |
| TDAD (Mar 2026; method-author, master's thesis) | AST code–test graph with weighted impact analysis, delivered as an agent skill | Qwen3-Coder 30B; Qwen3.5-35B-A3B | SWE-bench Verified: 100 + 25 instances | not in extract | Regressions 6.08% → 1.82%; resolve 24% → 32% | n/a | [arXiv 2603.17973](https://arxiv.org/abs/2603.17973v2) (extract) |
| "Does a Language Server Save Tokens for Coding Agents?" (Aug 2026; measurement study) | LSP navigation vs grep, five-arm ablation | Claude Opus 4.8, Sonnet 4.6, Haiku 4.5 | Python and TS repos; reference-heavy SWE-bench-series tasks | not in extract | Forcing semantic-first on localization: success 100% → 89%; no gain on reference tasks | tokens +6% to +118% on localization; −12% on the noisiest repo | [arXiv 2608.13568](https://arxiv.org/abs/2608.13568), [AgentConnect blog](https://www.agentconnect.md/blog/grep-beat-lsp-harness/) (extract) |
| Deep agentic search vs semantic search (Aug 2026; independent) | Pre-built vector index vs planner plus grep subagent | 4 models | SWE-QA, 15 Python repos | n/a | 65.2% vs 46.2% correct answers | "less than half the cost" per correct answer | [arXiv 2608.01507](https://arxiv.org/abs/2608.01507) (extract) |
| Codebase-Memory (Mar 2026; tool-author) | Tree-sitter knowledge graph with 14 MCP tools vs a file-exploration agent | not in extract | 31 repos, structural questions | n/a | Answer quality 83% vs 92% (**lower**) | 10× fewer tokens, 2.1× fewer tool calls | [arXiv 2603.27277](https://arxiv.org/html/2603.27277v1) (extract) |
| VibeMemBench (Sep 2026; independent) | Memory systems vs injected "verified experience" | 5 held-out solvers | 111 targets from 90 SWE-rebench V2 repos | paired | Verified experience: +1.1 to +4.5 pts on 4/5 solvers. Memory systems: 11/12 pairings ≤ memory-off | fewer steps on all 5 (verified experience) | [arXiv 2609.23570](https://arxiv.org/abs/2609.23570) (extract) |

**B. "Code Isn't Memory: A Structural Codebase Index Inside a Coding Agent" (arXiv 2606.22417, 21 June 2026)**
- Authors: Ishaan Bhola, Adithyan Krishnan, Sravanth Kurmala and Mukunda NS. Affiliation and any vendor tie were not verifiable (extract). — [arXiv 2606.22417](https://arxiv.org/abs/2606.22417)
- Design (extract) — [arXiv 2606.22417](https://arxiv.org/abs/2606.22417), [PDF](https://arxiv.org/pdf/2606.22417):
  - Three arms: the harness with the index (SC-ON), the same harness without it (SC-OFF), and an agentic-grep comparator (OpenCode).
  - Run on SWE-PolyBench Verified and SWE-bench Pro, with Claude Opus 4.7 held fixed, across three seeds.
  - Every task runs inside a leak-audited per-task sandbox.
- Resolve rate per seed (seeds 0, 1, 2) (extract) — [arXiv HTML](https://arxiv.org/html/2606.22417v1):
  - SC-ON: 48.8 / 53.6 / 48.8% (mean 50.4, SD 2.75)
  - SC-OFF: 43.9 / 41.5 / 40.2% (mean 41.9, SD 1.86)
  - OpenCode: 44.4 / 45.7 / 45.7% (mean 45.3, SD 0.71)
- Localization, Acc@5 on "View B" (extract) — [arXiv HTML](https://arxiv.org/html/2606.22417v1), [PDF](https://arxiv.org/pdf/2606.22417):
  - 44.3% → 84.5% (+39.6 pp).
  - By language: Go 95.4% vs 44.8%, Python 82.9% vs 42.4%.
  - The within-harness gap is largest on multi-file tasks.
- Cost (extract) — [arXiv 2606.22417](https://arxiv.org/abs/2606.22417):
  - $/solved was $2.30 vs $2.92 for the baseline (about 21% lower).
  - "No cost penalty per cell".
- Against OpenCode (extract): SC-ON "converges with fewer turns and fewer tokens". Mean turns per cell were 28.3 vs 36.0, and mean tokens 10.1k vs 14.0k. The token unit (total vs output) is unclear from the extract. — [arXiv 2606.22417](https://arxiv.org/abs/2606.22417)
- Authors' framing: "a large localization gain and a statistically separated resolve gain" within the harness. Across harnesses, the index "does not regress against an agentic-grep baseline". — [arXiv 2606.22417](https://arxiv.org/abs/2606.22417)
- Authors' conclusion: "The deployment question… is thus not whether it is too expensive to run but whether the workload includes multi-file changes where structural ranking pays off." (extract) — [arXiv 2606.22417](https://arxiv.org/abs/2606.22417)
- Reproducibility artifacts released: the per-cell exclusion ledger, the leak-audit script, the dual-view localization extractor and the full results database (extract). — [arXiv 2606.22417](https://arxiv.org/abs/2606.22417)
- A third-party reading (read): it "ran a causal on/off ablation of a structural index inside one agent harness and found gains concentrated in multi-file changes". — [lost-in-the/woods#280](https://github.com/lost-in-the/woods/issues/280)

**C. CodeCompass: "Navigating the Navigation Paradox in Agentic Code Intelligence" (arXiv 2602.20048, Feb 2026)**
- Tool: an MCP server exposing IMPORTS, INHERITS and INSTANTIATES edges from static AST analysis to Claude Code. For any file it returns the 1-hop structural neighbourhood (extract). — [arXiv HTML](https://arxiv.org/html/2602.20048v1), [code](https://github.com/tpaip607/research-codecompass)
- Setup (extract) — [arXiv 2602.20048](https://arxiv.org/abs/2602.20048):
  - 258 automated trials over 30 tasks on one production FastAPI repository.
  - Arms: vanilla Claude Code, BM25-augmented prompting, and CodeCompass.
  - Task groups:
    - G1, semantic: keyword-findable.
    - G2, structural: reachable through import chains.
    - G3, hidden: non-semantic architectural dependencies, invisible to keyword and vector search.
- Results (extract) — [arXiv 2602.20048](https://arxiv.org/abs/2602.20048), [arXiv HTML](https://arxiv.org/html/2602.20048):
  - G3: CodeCompass 99.4% task completion vs 76.2% vanilla (+23.2 pp) and 78.2% BM25 (+21.2 pp).
  - G1: BM25 is best, 100% vs 90% vanilla.
  - On G3, BM25 gives no advantage over vanilla (78.2% vs 76.2%).
- Adoption failure (extract): "58% of trials with graph access made zero tool calls". Agents needed explicit prompt engineering to use the tool consistently. — [arXiv 2602.20048](https://arxiv.org/abs/2602.20048)
- The "navigation paradox" (extract): larger context windows "shift the failure mode from retrieval capacity to navigational salience". The model fails "because it never discovers that the file is relevant", not because it lacks the budget to read it. — [arXiv HTML](https://arxiv.org/html/2602.20048v1)

**D. FastContext: "Training Efficient Repository Explorer for Coding Agents" (arXiv 2606.14066, Microsoft, June 2026)**
- A dedicated exploration subagent (extract) — [arXiv 2606.14066](https://arxiv.org/abs/2606.14066):
  - Issues parallel read-only tool calls.
  - Returns "concise file paths and line ranges as focused context".
  - Runs on 4B–30B models trained with SFT and task-grounded RL.
- Integrated into Mini-SWE-Agent across SWE-bench Multilingual, SWE-bench Pro and SWE-QA, it improves "end-to-end resolution rates up to 5.5% while reducing coding-agent token consumption up to 60%, with marginal overhead" (extract). — [arXiv 2606.14066](https://arxiv.org/abs/2606.14066)
- On SWE-bench Pro, GPT-5.4 goes from 46.0 to 51.5 (extract). — [arXiv HTML](https://arxiv.org/html/2606.14066v1)
- The RL-trained 4B explorer (FC-4B-RL) "often" beats the 30B SFT variant on localization and end-to-end score (extract). — [arXiv 2606.14066](https://arxiv.org/abs/2606.14066)

**E. TDAD: graph-based impact analysis against regressions (arXiv 2603.17973, Mar 2026)**
- Builds an AST-based code–test graph with weighted impact analysis, so the agent knows which tests to verify before committing (extract). — [arXiv 2603.17973](https://arxiv.org/abs/2603.17973v2), [code](https://github.com/pepealonso95/TDAD)
- Results on SWE-bench Verified, using Qwen3-Coder 30B (100 instances) and Qwen3.5-35B-A3B (25 instances) on consumer hardware (extract) — [arXiv 2603.17973](https://arxiv.org/abs/2603.17973v2):
  - Regressions 6.08% → 1.82% (−70%).
  - Resolution 24% → 32% when deployed as an agent skill.
- Negative control (extract): "TDD prompting alone increased regressions to 9.94%". Instructions without graph context were worse than vanilla. — [arXiv 2603.17973](https://arxiv.org/abs/2603.17973v2)
- Seeds and confidence intervals were not in the extracts.

**F. Process and retrieval benchmarks that tie retrieval to resolve (no with/without-tool ablation)**
- **SWE-Explore** (arXiv 2606.07297, 5 June 2026). Benchmark (extract) — [arXiv 2606.07297](https://arxiv.org/abs/2606.07297), [repo](https://github.com/Qiushao-E/SWE-Explore-Bench):
  - 848 issues, 10 languages, 203 repos.
  - Explorers return ranked code regions under a fixed line budget.
  - Gold "core/optional context" comes from independent successful repair trajectories.
- SWE-Explore explorers compared (extract) — [arXiv PDF](https://arxiv.org/pdf/2606.07297):
  - BM25, TF-IDF and embedding retrievers;
  - Claude Code and Cursor;
  - AutoCodeRover, CoSIL, LocAgent, OrcaLoca, Mini-SWE-Agent and AweAgent.
- SWE-Explore downstream protocol (extract): each explorer's K=5 regions go to a fixed Mini-SWE-Agent patcher backed by GPT-5.4 and Gemini-3-Pro, with resolve averaged over the two patchers. — [arXiv PDF](https://arxiv.org/pdf/2606.07297)
- SWE-Explore correlations at explorer level, with resolve (extract): "Context Efficiency" has Pearson r = 0.950, and Rec@100 has Spearman ρ = 0.845 ("early coverage under a tight line budget is especially predictive of repair"). — [arXiv PDF](https://arxiv.org/pdf/2606.07297)
- SWE-Explore explorer findings (extract) — [arXiv HTML](https://arxiv.org/html/2606.07297v1):
  - Agentic explorers significantly outperform one-shot retrieval.
  - CoSIL (iterative code-graph search) has the highest non-oracle line-level recall and F1.
  - LocAgent "resembles the general-agent profile rather than changing the recall frontier".
  - Most top-tier agents' line-level recall stays below 20%.
- **ContextBench** (arXiv 2602.05892, Feb 2026; Nanjing University and UCL). Setup (extract) — [arXiv 2602.05892](https://arxiv.org/abs/2602.05892), [repo](https://github.com/EuniAI/ContextBench):
  - 1,136 issue-resolution tasks from 66 repos in 8 languages, with human-annotated gold contexts.
  - Evaluates 4 frontier LLMs and 5 agents: mini-SWE-agent, SWE-agent, OpenHands, Agentless and others.
- ContextBench results (extract) — [arXiv HTML v2](https://arxiv.org/html/2602.05892v2), [arXiv HTML v3](https://arxiv.org/html/2602.05892v3):
  - "Sophisticated agent scaffolding yields only marginal gains in context retrieval" ("The Bitter Lesson" of coding agents).
  - Block-level F1 stays below 0.45 and line-level F1 below 0.35.
  - File level: mini-SWE-agent recall 0.682 / precision 0.709, vs OpenHands 0.733 / 0.400.
  - Context recall correlates positively with Pass@1.
  - Claude Sonnet 4.5 leads GPT-5 by 5.8 Pass@1 points.
  - Much retrieved context is inspected but unused in the final patch ("evidence drop").
- **Agent Retrieval Bench** (arXiv 2607.24882, July 2026). Composition (extract):
  - 427 samples across 25 repos.
  - 345 positive samples: code2test 106, comment2context 80, trace2code 101, edit2ripple 58.
  - 50 natural no-gold samples and 32 counterfactual controls.
  - Baselines: lexical, BM25, Aider-style RepoMap, and embeddings (Qwen3-Embedding 4B/8B, nomic-code, jina-code, pplx-embed).

  — [arXiv 2607.24882](https://arxiv.org/abs/2607.24882), [arXiv HTML](https://arxiv.org/html/2607.24882v1)
- Agent Retrieval Bench results: the earlier notes recorded "no single retrieval family dominates", and that logged agent trajectories "miss every gold file on 27–35 percent of samples". — [arXiv 2607.24882](https://arxiv.org/abs/2607.24882)
- **Deterministic anchoring** (arXiv 2606.26979, ISSTA 2026): static structure is injected as plain-text comments or "tags" (extract) — [arXiv 2606.26979](https://arxiv.org/abs/2606.26979), [artifact](https://zenodo.org/records/21787482):
  - Lightweight topology gives +2.2 pp Func@5 and −1.6 rounds.
  - Tags "roughly halve run-to-run variance on medium-scale repositories".
  - Hub-heavy large repos favour inverse-only links.
  - Authors' summary: structure helps "less by making agents smarter and more by making their navigation disciplined and reproducible".
- **Formal Architecture Descriptors** (arXiv 2604.13108, Apr 2026) (extract) — [arXiv 2604.13108](https://arxiv.org/abs/2604.13108):
  - Controlled experiment, 24 localization tasks, Claude Sonnet 4.6: 33–44% fewer navigation steps, with no significant difference between formats (S-expression, JSON, YAML, Markdown).
  - Artifact-vs-process experiment, 15 tasks × 3 conditions: an auto-generated descriptor reached 100% accuracy vs 80% blind.
  - Observational field study, 7,012 Claude Code sessions: 52% lower behavioural variance.
- **Coherence Collapse** (arXiv 2603.24631, Mar 2026) bounds how much localization tools can help (extract) — [arXiv 2603.24631](https://arxiv.org/abs/2603.24631):
  - TRAJEVAL was applied to 16,758 trajectories across 3 architectures and 7 models.
  - "60–69% of failures on SWE-Agent and OpenHands reach and edit the correct functions yet still produce incorrect patches".
  - An edit-commit checkpoint gave a directional +3.0 pp Pass@1 on GPT-5.

**G. Question-answering-level studies**
- **Deep agentic search for repository-level code QA** (arXiv 2608.01507, Aug 2026). Arms (extract) — [arXiv 2608.01507](https://arxiv.org/abs/2608.01507), [arXiv HTML](https://arxiv.org/html/2608.01507v1):
  - Semantic search: the agent retrieves code blocks from a vector index built in advance.
  - Deep agentic search: a planner delegates to a grep subagent that runs in an isolated context.
- SWE-QA results (extract) — [arXiv 2608.01507](https://arxiv.org/abs/2608.01507):
  - 65.2% vs 46.2% correct answers, with each correct answer at less than half the cost.
  - 41.8% of agentic-search failures happen at the planner-to-subagent hand-off.
  - The earlier notes recorded 4 models and 15 Python repos, with semantic search matching or beating agentic search for every model.
- **Codebase-Memory** (arXiv 2603.27277, Mar 2026; the tool-author's paper). System (extract):
  - Tree-sitter parsing into SQLite, 66 languages, 14 MCP tools.
  - Incremental re-indexing via file-watching and content hashes.
- Codebase-Memory results over 31 real repos (extract):
  - 83% answer quality vs 92% for a file-exploration agent, at 10× fewer tokens and 2.1× fewer tool calls.
  - On graph-native queries (hub detection, caller ranking) it "matches or exceeds the explorer on 19 of 31 languages".

  — [arXiv HTML](https://arxiv.org/html/2603.27277v1)

**H. Background: pre-2025 / early-2025 plug-in results (older, SWE-bench Lite)**
- RepoGraph (ICLR 2025), resolve before → after on SWE-bench Lite (earlier notes):
  - Agentless 27.33 → 29.67%
  - AutoCodeRover 19.00 → 21.33%
  - SWE-agent 18.33 → 20.33%
  - 2-hop context (~10.5K tokens) underperformed the baseline.

  — [arXiv 2410.14684](https://arxiv.org/abs/2410.14684), [ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/hash/4a4a3c197deac042461c677219efd36c-Abstract-Conference.html)
- LocAgent (ACL 2025): +12% downstream Pass@10. — [ACL Anthology](https://aclanthology.org/2025.acl-long.426/), [README](https://github.com/gersteinlab/LocAgent)

### Inferences
- **"Code Isn't Memory" can be checked from its own numbers** (Welch t-test on the 3 seed means, computed here):
  - SC-ON vs SC-OFF: +8.5 pp, SE 1.92, t = 4.43, df ≈ 3.5, p ≈ 0.015. This is consistent with "statistically separated".
  - SC-ON vs OpenCode: +5.1 pp, p ≈ 0.08. This is not separated at α = 0.05, which fits the authors' careful "does not regress" wording.
  - The index beat its own harness without the index, but its advantage over a good grep-based harness is not established.
- **Sample size is the main weakness of the best study.** The per-seed rates match integer fractions of about 82 (36/82 = 43.9%, 34/82 = 41.5%, 33/82 = 40.2%; OpenCode 36/81 and 37/81) (computed here). A single seed on about 82 tasks has a binomial SE of about 5.5 pp, so replicating on 300+ tasks matters before generalizing.
- **Consistent across studies: localization improves a lot; resolve improves a little.** Examples:
  - Acc@5 +39.6 pp vs resolve +8.5 pp (Code Isn't Memory).
  - File precision@5 up 3.4× vs pass rate +3.5 pp (Sourcegraph, section 2).
  - Coherence Collapse explains the gap: for capable models, 60–69% of failures happen after the right code is found.
  - Expect end-to-end resolve gains of the order of +2 to +8 pp from better navigation. Anything claiming +20 pp resolve on a general benchmark should be treated as suspect unless the task mix is navigation-bound, as CodeCompass G3 is.
- **Integration mode matters as much as retrieval quality.**
  - Optional tools that compete with grep go unused: CodeCompass's tool in 58% of trials, and LSP in 0–6% of localization runs.
  - The larger measured gains come from designs where structure sits in the harness's own search path or is injected: Code Isn't Memory's in-harness index with "structural ranking", the FastContext explorer subagent, and deterministic-anchoring tags.
  - The exact invocation policy (model-chosen vs always-on) of Code Isn't Memory and FastContext could not be verified.
  - Subagent designs add a hand-off, which was the largest failure point (41.8%) in the SWE-QA study.
- **Regressions are the least-measured outcome** and the one where graph context has the clearest reported effect: TDAD's −70% regressions. That result comes from 125 instances with small open models in a thesis, so it needs replication.

### Gaps
- I could not read the full text of any of the 2026 arXiv papers (arXiv was blocked). Missing details:
  - For "Code Isn't Memory": per-benchmark task counts, the exact statistical test, confidence intervals, the index's tool list, how it is exposed (harness-native tools vs MCP), and author affiliation.
  - For CodeCompass: the model used, and results for G1/G2 with CodeCompass.
  - For FastContext: per-benchmark tables and seeds.
  - For the LSP study: task counts and rollouts per arm.
- No independent replication of any with/without resolve result was found. Each result comes from a single group.
- No study found measures bug fix vs feature vs refactor separately in a with/without-tool ablation. The task-type evidence is indirect; see section 4.
- Leads not examined:
  - "LLM Agents Can See Code Repositories" — [arXiv 2606.14061](https://arxiv.org/html/2606.14061v1)
  - "What Resolve Rate Hides" — [arXiv 2607.06184](https://arxiv.org/pdf/2607.06184)
  - "Beyond Resolution Rates" — [arXiv 2604.02547](https://arxiv.org/pdf/2604.02547)
  - "One Tool Is Enough" — [arXiv 2512.20957](https://arxiv.org/pdf/2512.20957)
  - CodeScout — [arXiv 2603.17829](https://arxiv.org/pdf/2603.17829)
  - SWE-Adept — [arXiv 2603.01327](https://arxiv.org/pdf/2603.01327)
  - "Improving Code Localization with Repository Memory" — [arXiv 2510.01003](https://arxiv.org/pdf/2510.01003)

---

## 2. What vendors report, and how credible their methodology is

### Takeaway
Vendor numbers split into three groups:
- **Large rubric-scored quality gains.** Augment reports +30% to +80% on 900 PR attempts, graded on criteria it chose.
- **"Up to" efficiency ranges.** JetBrains reports up to −68% turns and −48% cost.
- **Small benchmark resolve deltas.** Morph WarpGrep +2.1 to +3.7 pts on SWE-bench Pro; Auggie +2.05 to +2.33 pp vs same-model harnesses; Sourcegraph +3.5 pp overall.

The most informative vendor results are also the least flattering:
- GitHub: semantic search made Copilot's agent "2% faster … without any change in quality".
- Sourcegraph: its own 370-task benchmark gave an overall pass-rate gain it calls "meh" (+3.5 pp), even though retrieval precision rose 2–3×.

None of the vendor claims retrieved report seeds, confidence intervals or per-task paired statistics, except Cursor's statement that its dynamic-context token cut was statistically significant.

### Cited Findings

**Augment Context Engine MCP (GA 6 Feb 2026) — vendor**
- Benchmark (extract): 300 Elasticsearch PRs × 3 prompts = 900 attempts at "taking a natural language prompt and shipping a complete PR". — [Augment blog](https://www.augmentcode.com/blog/context-engine-mcp-now-live), [Augment changelog](https://www.augmentcode.com/changelog/context-engine-mcp-in-ga)
- Scoring dimensions (extract): correctness, completeness, best practices, code reuse, and unsolicited documentation. — [Augment blog](https://www.augmentcode.com/blog/context-engine-mcp-now-live)
- Reported improvements (extract) — [Augment blog](https://www.augmentcode.com/blog/context-engine-mcp-now-live), [SiliconANGLE](https://siliconangle.com/2026/02/06/augment-code-makes-semantic-coding-capability-available-ai-agent/):
  - Claude Code + Opus 4.5: +80% quality.
  - Cursor + Opus 4.5: +71% (completeness +60%, correctness "+5x").
  - Cursor + Composer-1: +30%.
  - MCP-enabled runs "consistently required fewer tool calls and conversation turns".
- Credibility: the grader (human, LLM judge or tests) and the baseline tool configuration were not in any extract. Percentages are relative gains on a vendor-defined rubric, not resolve rates.
- **Auggie on SWE-bench Pro** (vendor; harness vs harness, not a tool ablation), from extracts:
  - Auggie solved 51.80% of 731 tasks: "15 more problems than Cursor and 17 more than Claude Code", with the same Claude Opus 4.5.
  - SWE-Agent scored 45.89%.
  - Augment attributes the gap to its Context Engine: "the only variable was context quality".

  — [Augment blog](https://www.augmentcode.com/blog/auggie-tops-swe-bench-pro), [Morph comparison](https://www.morphllm.com/comparisons/augment-code-vs-cursor)
- A later post, "Opus 4.7 for 33% less: How Auggie beats Claude Code on cost and quality", exists; its content was not retrieved. — [Augment blog](https://www.augmentcode.com/blog/auggie-beats-claude-code-on-cost-and-quality)

**JetBrains Context (July 2026, early access) — vendor**
- Validated on 205 open-source SWE-bench tasks, 175 production-monorepo tasks and 1,953 code-localization tasks. It "reduced agent turns by up to 68%, latency by up to 59%, and execution cost by up to 48%" (extract). — [JetBrains blog](https://blog.jetbrains.com/ai/2026/07/introducing-jetbrains-context-repository-intelligence-for-coding-agents/)
- Design (extract): a semantic index agents query "by concept instead of by keyword". It integrates with Claude Code, Codex CLI and Junie CLI. The evaluation "account[s] for the fact that modern coding agents are inherently probabilistic". — [JetBrains blog](https://blog.jetbrains.com/ai/2026/07/introducing-jetbrains-context-repository-intelligence-for-coding-agents/)
- Credibility: every figure is an "up to" maximum. No resolve-rate or quality delta, number of runs, or per-agent breakdown appeared in any extract.

**Sourcegraph MCP / CodeScaleBench (2026) — vendor, open benchmark**
- Design (extract):
  - 370 tasks from 40+ repos in 9 languages.
  - Same agent in two conditions: a baseline with local source and grep/file/read tools, and an MCP arm "in which the agent calls Sourcegraph's 13 retrieval tools instead of holding the source locally".

  — [Sourcegraph blog](https://webflow.sourcegraph.com/blog/codescalebench-testing-coding-agents-on-large-codebases-and-multi-repo-software-engineering-tasks), [repo](https://github.com/sourcegraph/CodeScaleBench)
- Headline (extract): "the headline as a single number is meh; the average overall MCP effect is positive but small, with a three-and-a-half percentage point gain". — [Sourcegraph blog](https://webflow.sourcegraph.com/blog/codescalebench-testing-coding-agents-on-large-codebases-and-multi-repo-software-engineering-tasks)
- Retrieval and efficiency (extract) — [Sourcegraph blog](https://webflow.sourcegraph.com/blog/codescalebench-testing-coding-agents-on-large-codebases-and-multi-repo-software-engineering-tasks):
  - File recall 0.127 → 0.277; Precision@5 0.140 → 0.478; F1@5 0.099 → 0.262.
  - Cost per task about −30%; execution about 38% faster.
  - The largest gain by software-lifecycle suite is "Understand" (+0.115).
- Haiku 4.5 on 371 tasks: mean reward 0.536 (baseline) vs 0.565 (MCP), +0.029 (extract). This may be a different run from the +3.5 pp headline. — [repo](https://github.com/sourcegraph/CodeScaleBench)
- A follow-up post (extract), on 9 "discovery-heavy" tasks:
  - Sonnet 4.6 with Sourcegraph MCP and no source on disk scored 0.698.
  - "Claude Fable 5" with the whole repo local and no retrieval scored 0.568, at almost twice the cost per point.

  — [Sourcegraph blog](https://sourcegraph.com/blog/sourcegraph-mcp-and-a-cheaper-model-beat-a-mythos-class-model-alone)
- "Code Finder" (an agentic search tool inside the MCP server) "reached comparable result quality while finishing faster and costing less" than the agent searching itself. No numbers were in the extract. — [Sourcegraph MCP](https://sourcegraph.com/mcp)
- Credibility:
  - The benchmark and trajectories are public, which is unusually transparent.
  - The arms differ in environment (source on disk vs remote-only), not only in tools.
  - The 9-task result is cherry-picked by design.

**Cursor — vendor**
- Semantic search (Nov 2025) (extract) — [Cursor blog](https://cursor.com/blog/semsearch):
  - Offline, on "Cursor Context Bench" (retrieval questions with known answers): +12.5% average accuracy, ranging from 6.5% to 23.5% by model.
  - Online A/B with the same model, one arm with and one without semantic search: code retention +0.3% overall and +2.6% on large codebases (1,000+ files); 2.2% more dissatisfied follow-ups without it.
  - The embedding model is trained on agent-session traces.
- Dynamic context discovery (Jan 2026) (extract) — [Cursor blog](https://cursor.com/blog/dynamic-context-discovery), [InfoQ](https://www.infoq.com/news/2026/01/cursor-dynamic-context-discovery/):
  - Tool descriptions are synced to files and loaded on demand.
  - Result: −46.9% total agent tokens "in A/B tests for runs that called an MCP tool (statistically significant, with high variance based on the number of MCPs installed)".
- Instant Grep: regex latency fell from 16.8 s (ripgrep) to 13 ms. This is latency only; no agent-outcome delta was published. — [Cursor blog](https://cursor.com/blog/fast-regex-search) (earlier notes)
- Credibility: this is the only vendor running production A/B tests. The effect sizes are small (+0.3% retention), and the benchmark is private.

**GitHub Copilot coding agent — vendor**
- Semantic code search (17 Mar 2026): "complete tasks in 2% less time without any change in quality". It is used automatically "when the agent doesn't know the precise names or patterns to search for". — [GitHub changelog](https://github.blog/changelog/2026-03-17-copilot-coding-agent-works-faster-with-semantic-code-search/)

**Morph WarpGrep v2 (2 Mar 2026) — vendor (RL-trained search subagent)**
- SWE-bench Pro results — [X/@morphllm](https://x.com/morphllm/status/2028558718485541075), [Morph blog](https://www.morphllm.com/blog/warpgrep-v2):
  - Opus 4.6: 55.4 → 57.5 (+2.1)
  - Codex 5.3 (CLI): → 59.1 (+3.1)
  - MiniMax 2.5: → 57.6 (+3.7)
- Opus cost and speed (extract): "15.6% cheaper (opus) 28% faster (opus)"; Opus per-task cost $3.06 → $2.51. — [X/@tejasybhakta](https://x.com/tejasybhakta/status/2028565576801775842)
- Conflicting token and turn figures:
  - One extract gives −17% input tokens, −13% output tokens, −13% turns — [Morph blog](https://www.morphllm.com/blog/warpgrep-v2).
  - The earlier notes recorded −39% input tokens and −26% turns from the same blog.
  - The two sets may refer to different models or aggregations; unresolved.
- Credibility: seeds, CIs and whether the baseline is the vendor's own run were not reported in extracts. A +2.1 pp gain on 731 tasks is inside single-run noise (section 5).

**Cognition SWE-grep / Windsurf Fast Context (Oct 2025) — vendor**
- Training reward: "an average of weighted F1 scores over file retrieval and line retrieval tasks, with precision weighted higher than recall". The reason given: "polluting the context of the main agent was more detrimental than leaving some context out" (extract). — [Cognition blog](https://cognition.com/blog/swe-grep)
- Evaluated in Windsurf's Cascade on "a randomly selected subset of difficult SWE-Bench Verified tasks". End-to-end retrieval runs "~5x faster"; retrieval is "up to 20 times faster" than competitors (extract). No resolve-rate delta was retrieved. — [Cognition blog](https://cognition.com/blog/swe-grep), [Cerebras](https://x.com/CerebrasSystems/status/1978874694825840679)

**Factory (Droid) — vendor; harness-level only**
- Factory claims #1 on Terminal-Bench, ahead of Claude Code and Codex CLI. — [X/@FactoryAI](https://x.com/FactoryAI/status/1971271087855186128)
- A secondary wiki gives 58.8% (Droid + Opus) vs 43.2% (Claude Code + Opus). That is a 15.6 pp same-model harness gap, not attributable to retrieval (HyperCode/ByteRank) alone. — [ai.miraheze wiki](https://ai.miraheze.org/wiki/Droid), [Factory report (2024 background)](https://factory.ai/news/code-droid-technical-report)

**Anthropic — vendor**
- Agentic search vs RAG: "agentic search generally works better" than early RAG with a local vector DB. It "outperformed everything by a lot". No numbers were ever published. — [X/@bcherny](https://x.com/bcherny/status/2017824286489383315), [Latent Space](https://www.latent.space/p/claude-code) (earlier notes)
- Tool Search Tool (Nov 2025): on internal MCP evaluations with large tool libraries, accuracy rose when tools were deferred instead of loaded upfront:
  - Opus 4: 49% → 74%
  - Opus 4.5: 79.5% → 88.1%
  - with an 85% token reduction.

  This is indirect evidence that tool-definition bloat costs accuracy. — [Anthropic engineering](https://www.anthropic.com/engineering/advanced-tool-use)
- Claude Code LSP tool (v2.0.74, Dec 2025): Anthropic has published no end-to-end numbers.
  - The widely repeated "900x faster" claim (~50 ms vs ~45 s to find call sites) and "~75% fewer tokens" come from third-party blogs, not agent-outcome measurements. — [YingTu blog](https://yingtu.ai/en/blog/claude-code-lsp), [note.com](https://note.com/snake_dragon/n/n36f2c1f023fd?hl=en)
  - The only controlled LSP study found (section 1) is largely negative on tokens.
- Explore subagent: no quantitative outcome published (earlier notes).

**Zed, Windsurf (beyond SWE-grep) and Amp**
- No quantitative with/without-index outcome claims were found in this round.

### Inferences
- **Credibility ranking** (my assessment), from most to least credible:
  1. **Cursor** — online A/B with significance for dynamic context, and a disclosed per-model range.
  2. **Sourcegraph** — public benchmark and trajectories, honest "meh" headline, but confounded arms.
  3. **Morph / Auggie** — public benchmark, single numbers, no seeds, deltas at noise level.
  4. **JetBrains** — "up to" maxima, no quality delta.
  5. **Augment's MCP study** — vendor rubric, relative percentages, grader undisclosed.
- **Vendors converge on efficiency, not resolve, as the defensible claim.** Reported cost cuts of −15% to −48%, turn cuts of −13% to −68%, and GitHub's null quality change all fit the independent pattern in section 1.
- **Same-model harness gaps are as large as tool effects.** Auggie vs Claude Code is about 2 pp; Factory vs Claude Code is 15.6 pp on Terminal-Bench (vendor); Code Isn't Memory's SC-OFF vs OpenCode is 3.4 pp. Cross-harness comparisons ("our agent with our index beats Claude Code") cannot isolate the index.

### Gaps
- Primary vendor pages could not be fetched. Still missing:
  - Augment's grader and baseline;
  - JetBrains' per-benchmark tables and quality metrics;
  - Morph's token and turn figures (conflict unresolved);
  - SWE-grep's end-to-end numbers;
  - CodeScaleBench's per-suite losses (tasks where MCP hurt) and number of runs.
- No vendor claim was independently replicated.

---

## 3. Open-source MCP code-graph and LSP servers: measured agent outcomes (not stars)

### Takeaway
No open server found has a published, controlled, end-to-end resolve-rate evaluation. What exists:
- tool-author token and tool-call reductions (claude-context −39.4% tokens at equal retrieval F1; Codebase-Memory 10× fewer tokens at lower answer quality);
- single-question anecdotes (GitNexus);
- two careful user-run studies, both mainly negative:
  - **Serena**: telemetry shows the agent used it in only 35.4% of sessions and re-read files after 18.4% of symbol queries.
  - **codebase-memory-mcp**: a 300-run benchmark in which silently paginated graph results cut recall from 0.723 to 0.525 at equal precision.

### Cited Findings

**Serena (LSP over MCP)**
- No controlled benchmark of resolve rate or tokens was found. A maintainer issue, "Evaluation: check tokens saved due to serena on selected tasks" (#189, June 2025), is closed with no public numbers found. — [oraios/serena#189](https://github.com/oraios/serena/issues/189)
- User telemetry (read):
  - Scale: 21 days, a single user, 13 repos, 21,089 tool calls, 192 sessions, Serena v1.2.2/v1.3.0, Claude Code CLI.
  - Adoption: Serena was used in only 35.4% of sessions (68/192). The 124 plain-only sessions made 1,046 Read/Grep/Glob calls.
  - Serena's share of read-class operations was 20.3% (626/3,080), ranging from 0.8% to 58.5% by repo.
  - Fallback: 18.4% of resolved symbol queries (102/554) were followed by a `Read` of the same file (`find_symbol` 11.5%, `get_symbols_overview` 29.6%).
  - Of the `find_symbol` fallbacks, 80.8% had `include_body=true`, and 83.3% of those Reads sliced the file with offset/limit. The model wanted the surrounding lines, not the body.

  — [oraios/serena#1491](https://github.com/oraios/serena/issues/1491)
- Silent incompleteness (Sept 2026): `find_symbol` with `include_info` drops info once `symbol_info_budget` (default 10 s) is spent. The result is indistinguishable from "no docstring". — [oraios/serena#2006](https://github.com/oraios/serena/issues/2006)

**codebase-memory-mcp (DeusData)**
- Paper (tool-author): 83% vs 92% answer quality, 10× fewer tokens and 2.1× fewer tool calls on 31 repos (section 1G). — [arXiv 2603.27277](https://arxiv.org/html/2603.27277v1)
- User benchmark (read):
  - Setup: v0.9.0+338, Claude Code, Claude Haiku 4.5, 300 runs, two Java repos (apache/kafka, 184k nodes; jackrabbit-oak, 132k nodes).
  - Task: "which files declare a method whose shortest call chain to X is exactly 2 calls long".
  - Five repetitions per task, grep-only vs grep + graph.
  - On jackrabbit-oak: precision 0.455 vs 0.453, recall 0.723 vs 0.525, files listed 34.0 vs 20.0 (true answer 6.5 files).
  - 429 responses carried `has_more`, and agents often did not page.
  - Example: the grep agent found 5/5 files, while the graph agent found 1/5 even though `trace_path` had reported `callers_total: 4`.

  — [DeusData/codebase-memory-mcp#1382](https://github.com/DeusData/codebase-memory-mcp/issues/1382)
- Operational and adoption issues:
  - "search_graph MCP call hangs >476s while identical CLI call is instant" (v0.9.0, Linux/Codex) — [#1418](https://github.com/DeusData/codebase-memory-mcp/issues/1418)
  - "Force agent to use CMM?" — [#34](https://github.com/DeusData/codebase-memory-mcp/issues/34)

**GitNexus**
- Third-party blog (extract), one architectural question on a mid-sized Flutter project, Claude Code's Explore subagent vs GitNexus:
  - Cost $0.52 vs $0.39 (−25%).
  - About 38 vs 12 tool calls (−68%).
  - 43% fewer tokens.
  - A single `gitnexus_query` returned 9 relevant files.
  - N = 1 question, with no quality scoring beyond the author's judgement.

  — [ilzam.dev](https://ilzam.dev/notes/gitnexus-codebase-rag-benchmark/)

**claude-context (Zilliz) — tool-author**
- Setup (extract): 30 SWE-bench Verified instances (15–60 min difficulty, exactly 2 files modified), each method run 3 times. The baseline agent had read, grep and edit; the treatment added the claude-context MCP.
- Result (extract): tokens −39.4% and tool calls −36.1% "while preserving retrieval quality" (precision, recall and F1).
- No resolve rate was measured.

  — [evaluation dir](https://github.com/zilliztech/claude-context/tree/master/evaluation), [Milvus blog](https://milvus.io/blog/claude-context-reduce-claude-code-token-usage.md)

**jCodeMunch — tool-author**
- 99.6% average token reduction over 15 task-runs on express, fastapi and gin (5,122,105 → 19,406 tokens), against a "read all indexed source files" baseline.
- The README states it "does not measure answer quality, latency, or end-to-end task completion" (extract).

  — [benchmarks README](https://github.com/jgravelle/jcodemunch-mcp/blob/main/benchmarks/README.md), [METHODOLOGY](https://github.com/jgravelle/jcodemunch-mcp/blob/main/benchmarks/METHODOLOGY.md)

**Others (claims found, not verified)**
- mgrep (Mixedbread, vendor), 50-task benchmark: about 2× fewer tokens than grep workflows; $0.23 vs $0.49 and 82 s vs 158 s per task; 76% LLM-judge win rate. — [mgrep README](https://github.com/mixedbread-ai/mgrep) (earlier notes)
- A competitor's comparison page relays "codegraph" as "88% fewer tool calls, 62% fewer tokens, 44% lower cost and 53% faster across seven repositories". A search extract also attributes "~62% fewer tool-response tokens" with a "GCF" output format to CodeGraphContext. Attribution is uncertain. — [trace-mcp](https://trace-mcp.com/vs/codegraph.html) (extract)
- Gortex (tool-author): BM25 R@5 of 55.1% vs ripgrep 17.3%, at 3–50× fewer tokens per response (extract). — [zzet.org](https://zzet.org/gortex/grep-replacement-for-ai-agents/)
- Shopify Rubydex (static Ruby index with an experimental MCP) "claims 15 to 80 percent token reduction" (secondary, read). — [lost-in-the/woods#280](https://github.com/lost-in-the/woods/issues/280)
- Codanna and CodeGraphContext: no measured agent outcomes (resolve, tokens per task, turns) were found.
- Agent Retrieval Bench user submissions exist, with retrieval-level numbers not retrieved. — [Oko results issue](https://github.com/eyuansu62/agent-retrieval-bench/issues/1), [diffctx edit2ripple validation](https://github.com/nikolay-e/diffctx/issues/270)

### Inferences
- The two most careful user measurements (Serena #1491, CMM #1382) both find the failure in the **interface**, not the index:
  - The agent does not call the tool.
  - It re-reads because the output lacks surrounding context.
  - It trusts a truncated page.
- The design properties with measured consequences:
  - Make truncation impossible to miss, in the rendered text and not only in JSON flags.
  - Include enclosing context (signature, imports, neighbours) with symbol bodies.
  - Make the tool the default path through hooks or harness integration.
- Token-reduction claims against "read every file" baselines (jCodeMunch) or on 30 tasks without resolve (claude-context) measure efficiency, not outcome. Only paired runs with outcomes (as in #1382) can show the "fewer tokens, worse answer" failure mode.

### Gaps
- No end-to-end (resolve-rate) evaluation was found for Serena, GitNexus, Codanna, CodeGraphContext, claude-context or codebase-memory-mcp on SWE-bench-style tasks.
- The results of Serena's internal evaluation (#189) were not found.
- The GitNexus, Codanna and CodeGraphContext issue trackers were not exhaustively searched for user benchmarks. Only targeted searches were run.

---

## 4. Where tools do not help or hurt, and how the effect depends on model strength, repository size and task type

### Takeaway
Null and negative results are common and mechanistically consistent:
- **Agents ignore the tool.** Graph tools went unused in 58% of CodeCompass trials, and LSP was used in 0–6% of localization runs.
- **Forcing the tool can lower success** (100% → 89%).
- **Tools add tokens on easy lookups** (LSP +6% to +118%).
- **Truncated or partial outputs cut recall** (0.723 → 0.525).
- **Memory and context systems often land at or below baseline** (11 of 12 pairings).
- **Delegating to subagents fails at the hand-off** (41.8% of failures).

Gains depend on three moderators:
- **Task type:** hidden or structural dependencies, multi-file edits, "who calls / what breaks" questions, and read-only QA.
- **Repository noise and scale:** gains are larger where grep floods with false positives, and in 1,000+ file repos.
- **Model strength:** no consistent pattern. Gains appear for both weak and frontier models.

### Cited Findings

**Null or negative end-to-end results**
- Copilot's semantic search: 2% less time, "without any change in quality". — [GitHub changelog](https://github.blog/changelog/2026-03-17-copilot-coding-agent-works-faster-with-semantic-code-search/)
- The LSP study, with Opus 4.8, Sonnet 4.6 and Haiku 4.5 (extract) — [arXiv 2608.13568](https://arxiv.org/abs/2608.13568), [AgentConnect blog](https://www.agentconnect.md/blog/grep-beat-lsp-harness/):
  - Symbol-named localization: LSP "costs tokens (+6% to +118%) and the agent ignores it when free", using semantic navigation in 0–6% of free-choice runs.
  - Forcing semantic-first "lowered success from 100% to 89%", and the agent still made only 4 semantic calls vs 51 grep calls.
  - The authors: "Adding a sophisticated tool without measuring the full agent loop can raise token use, add tool calls and reduce success".
- The same study on reference-critical tasks (change-signature/fix-callers, who-calls-X, cross-file refactor, dead code) (extract):
  - "Grep-only leads show a pass@1 of 0.83; adding or forcing the LSP does not help, and the LSP again carries a token premium".
  - The exact task subset behind the 0.83 is unclear from the extract.

  — [arXiv PDF](https://arxiv.org/pdf/2608.13568)
- CodeCompass (extract) — [arXiv 2602.20048](https://arxiv.org/abs/2602.20048):
  - Agents made zero graph calls in 58% of trials where the graph was available.
  - BM25 context added nothing on hidden-dependency tasks (78.2% vs 76.2%).
- Codebase-Memory's graph agent scored lower answer quality than file exploration (83% vs 92%). — [arXiv 2603.27277](https://arxiv.org/html/2603.27277v1)
- Pagination truncation: graph-arm recall fell from 0.723 to 0.525 at equal precision (0.455 vs 0.453), with Haiku 4.5 on large Java repos. — [codebase-memory-mcp#1382](https://github.com/DeusData/codebase-memory-mcp/issues/1382)
- Subagent hand-off (extract):
  - Deep agentic search was 46.2% vs 65.2% for semantic search.
  - 41.8% of its failures happened at the planner-to-subagent hand-off.
  - The earlier notes quote the paper: these failures were "usually silent, ending in a fluent and confident answer that was wrong".

  — [arXiv 2608.01507](https://arxiv.org/abs/2608.01507)
- Memory and context systems (extract):
  - Mem0, SimpleMem, MemoryOS and A-MEM: "11 of 12 pairings land at or below the memory-off baseline". 69.3% of losses were "form degradation", i.e. raw transcript volume. — [arXiv 2609.23570](https://arxiv.org/abs/2609.23570)
  - A critique argues VibeMemBench's two arms are not comparable. — [research-issues#1670](https://github.com/jjakimoto/research-issues/issues/1670)
  - A preregistered, execution-graded benchmark for Claude Code memory layers found placebo 0.672 vs recall and bare 0.659 each; "no arm's 95% interval excludes zero". — [agent-memory-bench](https://github.com/GiulioDER/agent-memory-bench)
- Instructions without context can hurt: TDD prompting alone raised regressions from 6.08% to 9.94% (TDAD). — [arXiv 2603.17973](https://arxiv.org/abs/2603.17973v2)
- Context pollution:
  - Cognition weights precision above recall because "polluting the context of the main agent was more detrimental than leaving some context out" (extract). — [Cognition blog](https://cognition.com/blog/swe-grep)
  - RepoGraph's 2-hop context (~10.5K tokens) underperformed its baseline (background). — [arXiv 2410.14684](https://arxiv.org/abs/2410.14684)
  - ContextBench documents "evidence drop": retrieved context that is inspected but unused. — [arXiv 2602.05892](https://arxiv.org/abs/2602.05892)
- Tool-definition bloat: deferring tool definitions raised Anthropic's MCP-eval accuracy from 49% to 74% (Opus 4) and from 79.5% to 88.1% (Opus 4.5). — [Anthropic engineering](https://www.anthropic.com/engineering/advanced-tool-use)
- Scaffolding: "sophisticated agent scaffolding yields only marginal gains in context retrieval". A bash-only mini-SWE-agent had higher file-level precision than OpenHands (0.709 vs 0.400) (extract). — [arXiv 2602.05892](https://arxiv.org/abs/2602.05892), [arXiv HTML v2](https://arxiv.org/html/2602.05892v2)
- Non-code corroboration: on 116 LongMemEval questions, "grep generally yields higher accuracy than vector retrieval" across Claude Code, Codex, Gemini CLI and a custom harness, and scores "depend strongly on which harness and tool-calling style is used" (extract). — [arXiv 2605.15184](https://arxiv.org/abs/2605.15184)
- Localization is not the main failure for capable models: 60–69% of SWE-agent/OpenHands failures had already reached and edited the correct functions. — [arXiv 2603.24631](https://arxiv.org/abs/2603.24631)

**Moderator: task type**
- Hidden or architectural dependencies:
  - Graph navigation gives +23.2 pp on G3 in CodeCompass.
  - Keyword-findable G1 tasks favour BM25 (100% vs 90% vanilla).

  — [arXiv 2602.20048](https://arxiv.org/abs/2602.20048)
- Multi-file edits: the gains in Code Isn't Memory are "largest in multi-file scenarios". — [arXiv HTML](https://arxiv.org/html/2606.22417v1), [woods#280](https://github.com/lost-in-the/woods/issues/280)
- Reference tasks vs localization: models "reach for the LSP about half the time on reference tasks, unprompted", vs 0–6% on localization. — [arXiv 2608.13568](https://arxiv.org/abs/2608.13568)
- Ripple and impact:
  - RepoMap "helps identify ripple-effect files through repository structure" (edit2ripple). — [arXiv 2607.24882](https://arxiv.org/abs/2607.24882) (earlier notes)
  - Graph impact analysis cut regressions by 70%. — [arXiv 2603.17973](https://arxiv.org/abs/2603.17973v2)
- Read-only QA: a pre-built semantic index beat agentic search (65.2% vs 46.2%). — [arXiv 2608.01507](https://arxiv.org/abs/2608.01507)
- Comprehension: CodeScaleBench's largest gain was in the "Understand" suite (+0.115) (extract). — [Sourcegraph blog](https://webflow.sourcegraph.com/blog/codescalebench-testing-coding-agents-on-large-codebases-and-multi-repo-software-engineering-tasks)
- Feature PRs: Augment's gains (+30% to +80%, vendor rubric) come from "ship a complete PR" tasks, which are closer to feature work than to bug fixes. — [Augment blog](https://www.augmentcode.com/blog/context-engine-mcp-now-live)

**Moderator: repository size, noise and unfamiliarity**
- Cursor: code retention rose +0.3% overall but +2.6% on 1,000+ file codebases (extract). — [Cursor blog](https://cursor.com/blog/semsearch)
- LSP saved tokens (−12%) and gave the largest F1 gain only "on the noisiest repo… when grep is flooded with false positives". — [arXiv 2608.13568](https://arxiv.org/abs/2608.13568)
- Deterministic anchoring:
  - Optimal granularity and directionality "depend on scale".
  - Hub-heavy projects favour inverse-only links.
  - Tags halve variance on medium repos.

  — [arXiv 2606.26979](https://arxiv.org/abs/2606.26979)
- Cognition (vendor) measured that coding agents spend "over 60% of their first turn retrieving context". Separately, it claims that on ~1M-line codebases (React, Vercel, PyTorch) SWE-grep finds relevant snippets "in a few seconds, compared to minutes on Claude and Cursor" (extract). — [Cognition blog](https://cognition.com/blog/swe-grep), [Cerebras](https://x.com/CerebrasSystems/status/1978874694825840679)
- Very large repos (Kafka at 184k graph nodes) are also where silent graph truncation hurt recall. — [codebase-memory-mcp#1382](https://github.com/DeusData/codebase-memory-mcp/issues/1382)

**Moderator: model strength (mixed evidence)**
- Cursor: gains ranged from 6.5% to 23.5% by model; which models gained most was not in the extract. — [Cursor blog](https://cursor.com/blog/semsearch)
- WarpGrep: +2.1 on Opus 4.6, +3.1 on Codex 5.3, +3.7 on MiniMax 2.5. The weaker or open model gained slightly more. — [X/@morphllm](https://x.com/morphllm/status/2028558718485541075)
- Augment: Opus 4.5 gained +71–80%, while Cursor's Composer-1 gained +30%. Here the stronger model gained more. — [Augment blog](https://www.augmentcode.com/blog/context-engine-mcp-now-live)
- Code Isn't Memory: a frontier model (Opus 4.7) still gained +8.5 pp resolve. — [arXiv 2606.22417](https://arxiv.org/abs/2606.22417)
- FastContext: GPT-5.4 gained +5.5 on SWE-bench Pro. — [arXiv 2606.14066](https://arxiv.org/abs/2606.14066)
- TDAD: "smaller models benefit more from contextual information… than from procedural instructions" (Qwen 30–35B). — [arXiv 2603.17973](https://arxiv.org/abs/2603.17973v2)
- Sourcegraph: a cheaper model with MCP (Sonnet 4.6, 0.698) beat a stronger model without it (0.568) on 9 tasks (vendor). — [Sourcegraph blog](https://sourcegraph.com/blog/sourcegraph-mcp-and-a-cheaper-model-beat-a-mythos-class-model-alone)
- The LSP study: all three Claude tiers (Opus 4.8, Sonnet 4.6, Haiku 4.5) ignored LSP on localization. — [AgentConnect blog](https://www.agentconnect.md/blog/grep-beat-lsp-harness/)

### Inferences
- The failure modes cluster into four controllable design properties:
  1. **Adoption.** The tool must sit on the default path, through harness integration, hooks or mandatory subagents, not an optional MCP tool that competes with grep.
  2. **Completeness signalling.** Truncation, budget cuts and "not found" vs "tool failed" must be explicit in the rendered text.
  3. **Output shape.** Return enclosing context and file:line spans, and keep outputs small and precise (precision over recall).
  4. **Routing.** Serve structural queries (callers, impact, hidden dependencies, multi-file) with the index, and leave named-symbol lookups to grep.
- Neither "tools only help weak models" nor "strong models don't need tools" is supported. The effect tracks **task structure and repository noise** more than model tier. Frontier models still gain on multi-file and hidden-dependency work, and all tiers ignore structure on trivial lookups.
- Strongest bets, by evidence:
  - (a) regression-oriented impact analysis (TDAD: large effect, small N);
  - (b) multi-file and structural navigation inside the harness (Code Isn't Memory);
  - (c) read-only QA through a pre-built index (SWE-QA study).

  Weakest bet: an LSP or graph tool offered as optional MCP tools for general bug fixing on small or clean repos.

### Gaps
- No controlled with/without-tool study reports results split into bug fix, feature and refactor.
- No study systematically varies repository size with the same tool and model. The evidence is cross-study.
- Direct evidence on "unfamiliar" repos (post-cutoff, private) versus memorized public ones is thin. Code Isn't Memory's leak audit is the only relevant control found, and its effect on the size of the gain was not retrievable.

---

## 5. Run-to-run variance in agent evaluations and what effect sizes are detectable

### Takeaway
Seed-to-seed standard deviations on SWE-style benchmarks are typically 0.5–3 pp (median 1.2 pp), and infrastructure configuration alone can move scores by about 6 pp. Most claimed tool effects on resolve rate (+2 to +4 pp) are therefore at or below what a single run per arm on a few hundred tasks can detect.

Only large effects have been cleanly detected:
- localization (+20 to +40 pp);
- CodeCompass G3 (+23 pp);
- SWE-QA (+19 pp);
- Code Isn't Memory's +8.5 pp (3 seeds, p ≈ 0.015, computed here).

Everything else needs paired, multi-seed designs.

### Cited Findings
- **SERA** (arXiv 2601.20789, Jan 2026) (extract) — [arXiv 2601.20789](https://arxiv.org/abs/2601.20789), [arXiv HTML](https://arxiv.org/html/2601.20789v1):
  - 78 experimental conditions × 3 seeds = 234 runs; standard deviations "range from 0.5% to 3.0%, with a median of 1.2%".
  - "The magnitude of improvement in coding agent research is typically also 1–3%", so many reported gains "fall within one standard deviation".
  - Proposed rule: seeds needed for SNR = 2 are n ≈ (2·std/δ)². Improvements below 2–3% with only 3 seeds "require skepticism".
- **Anthropic, "Quantifying infrastructure noise in agentic coding evals"** (Feb 2026):
  - Terminal-Bench 2.0 was run across six resource configurations on GKE, giving a 6 pp gap between the most- and least-resourced setups.
  - This "sometimes [exceeds] the leaderboard gap between top models".
  - Time limits, cluster health, concurrency and API latency are other noise sources.

  — [X/@AnthropicAI](https://x.com/AnthropicAI/status/2019501512200974686), [GIGAZINE](https://gigazine.net/gsc_news/en/20260206-quantifying-infrastructure-noise-agentic-coding/), [ZenML summary](https://www.zenml.io/llmops-database/infrastructure-noise-in-agentic-coding-evaluations)
- **Seed SDs in Code Isn't Memory**: 2.75 pp (SC-ON), 1.86 pp (SC-OFF) and 0.71 pp (OpenCode) on about 82 tasks per seed (extract; task count computed here). — [arXiv HTML](https://arxiv.org/html/2606.22417v1)
- **Epoch AI** runs most models 8 times on SWE-bench Verified and plots ±1 standard error. — [Epoch AI](https://epoch.ai/benchmarks/about)
- **Within-task inconsistency**: on MCPMark, gpt-5-medium scored 52.56% pass@1 but 33.86% pass^4. — [arXiv 2509.24002](https://arxiv.org/abs/2509.24002) (earlier notes)
- **Tools can reduce variance itself**:
  - Deterministic anchoring tags "roughly halve run-to-run variance" on medium repos. — [arXiv 2606.26979](https://arxiv.org/abs/2606.26979)
  - Architecture descriptors: 52% lower behavioural variance across 7,012 Claude Code sessions (observational). — [arXiv 2604.13108](https://arxiv.org/abs/2604.13108)
- **Resolve rate is itself a noisy proxy for quality**: maintainers reviewed 296 AI PRs that passed SWE-bench Verified tests. They would merge about 24 pp fewer than the automated grader passes (roughly 48% vs 72%). — [METR](https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/)
- **Statistics in the with/without studies found**:
  - Code Isn't Memory: 3 seeds, "statistically separated".
  - claude-context: 3 runs.
  - codebase-memory-mcp #1382: 5 repetitions.
  - CodeCompass: 258 trials over 30 tasks.
  - agent-memory-bench: preregistered 95% intervals.
  - Cursor: A/B "statistically significant" for dynamic context.
  - No seeds or intervals were visible in extracts for WarpGrep, Auggie, Augment MCP, JetBrains Context, CodeScaleBench or FastContext.

  — sources as cited in sections 1–3.

**Minimum detectable effects** (computed here; binomial, p ≈ 0.5, two-sided α = 0.05, 80% power)

| Tasks per arm (1 run) | SE of one run | SE of an unpaired difference | Detectable difference (unpaired) | Detectable difference (paired, 20% discordant tasks) |
|---|---|---|---|---|
| 82 | 5.5 pp | 7.8 pp | ≈ 22 pp | — |
| 300 | 2.9 pp | 4.1 pp | ≈ 11 pp | ≈ 7.2 pp |
| 500 (SWE-bench Verified) | 2.2 pp | 3.2 pp | ≈ 9 pp | ≈ 5.6 pp |
| 731 (SWE-bench Pro public) | 1.85 pp | 2.6 pp | ≈ 7.3 pp | ≈ 4.6 pp (≈ 3.3 pp at 10% discordant) |

- Auggie's "15 more than Cursor / 17 more than Claude Code" on 731 tasks is +2.05 / +2.33 pp (computed here). This is below the single-run unpaired detectable difference (≈ 7.3 pp) and below the paired one (≈ 3.3–4.6 pp). — [Augment blog](https://www.augmentcode.com/blog/auggie-tops-swe-bench-pro)
- WarpGrep's +2.1 pp (Opus 4.6) is in the same range. — [X/@morphllm](https://x.com/morphllm/status/2028558718485541075)
- Using SERA's rule n ≈ (2·std/δ)² with median std = 1.2 pp (computed here):
  - A 1 pp effect needs about 6 seeds; 2 pp needs about 1.4; 3 pp needs 1.
  - With std = 3 pp, a 2 pp effect needs about 9 seeds and a 3 pp effect about 4.

  — [arXiv 2601.20789](https://arxiv.org/abs/2601.20789)
- Code Isn't Memory (Welch t on seed means, computed here):
  - SC-ON vs SC-OFF: Δ = 8.5 pp, p ≈ 0.015.
  - SC-ON vs OpenCode: Δ = 5.1 pp, p ≈ 0.08.
  - OpenCode vs SC-OFF (a harness difference): Δ = 3.4 pp, p ≈ 0.07.

### Inferences
- **What was actually detectable:**
  - Localization and retrieval metrics: +20 to +40 pp, visible with tens of tasks.
  - Navigation-bound task subsets: +19 to +23 pp.
  - Regression rates: TDAD −4.3 pp absolute on a 6% base, borderline with 125 instances.
  - General resolve rate: +2 to +8.5 pp, detectable only with 3+ seeds or 700+ paired tasks.
- **Efficiency metrics are easier to detect.** Tokens, turns, cost and latency have larger relative effects (−15% to −60%) and lower relative variance, which explains why vendors lead with them.
- **An evaluation design that would be credible**, from these sources:
  - Paired tasks, same model snapshot and same harness, differing only in tool availability.
  - At least 3 seeds per arm; 5–6 if the expected effect is 1–2 pp.
  - At least 300 tasks, stratified by task type: single- vs multi-file, hidden dependency, QA.
  - Fixed and recorded infrastructure resources (Anthropic's 6 pp).
  - Report McNemar or paired-bootstrap intervals, cost per solve (not only per task), tool-adoption rate, and regressions (PASS_TO_PASS).
  - Include a "tool available but unused" diagnostic (CodeCompass's 58%) and a truncation audit (CMM #1382).

### Gaps
- No variance figures specific to "with-tool" arms were found, beyond Code Isn't Memory's three SDs and the claim that deterministic anchoring halves variance. It is unknown whether code-intelligence tools generally reduce or increase run-to-run variance.
- Per-task discordance rates (needed for exact paired detectable differences) were not available for any with/without study. The paired figures above assume 10–30% discordance.
- Anthropic's full infrastructure-noise post (per-configuration numbers, SWE-bench results if any) could not be fetched. Only the headline 6 pp is confirmed.
