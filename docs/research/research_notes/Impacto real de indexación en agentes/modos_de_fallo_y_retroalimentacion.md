# Failure modes of AI coding agents that program analysis could prevent, and the measured effect of edit-time feedback (2024 – Sep 2026)

**Source note (read first).** The session's egress policy blocked these hosts (HTTP 403 from the proxy): arxiv.org, github.com, aider.chat, code.claude.com and jatinganhotra.dev. The proxy log also showed openreview.net, aclanthology.org, semanticscholar.org, swebench.com and scholar.archive.org as denied. No page could be opened in full. **Every figure below comes from search-engine extracts of the cited page** (usually the arXiv abstract, HTML or PDF), cited to the canonical URL. A summarizer error is possible, so treat single numbers as "reported, not re-derived".

Tags used:
- **[earlier round]**: carried over from `docs/research/notes/*.md`; not re-verified here.
- **[background]**: predates 2025.
- Evidence type: **[ablation]** = controlled comparison, **[corr]** = descriptive or correlational, **[claim]** = vendor or design statement with no measurement.

## Q1. Failure taxonomies of SWE-bench-style agents: where failures come from, with percentages

### Takeaway
For frontier agents, file-level localization is now the *least* frequent failure source. Most failures happen **after the agent reaches the right code**:
- Strategy/logic errors are 37% of failures, and "partial or incomplete fixes" is the largest category in that stage.
- 60–69% of failures on SWE-Agent/OpenHands edit the correct functions yet still produce wrong patches.
- Problem misunderstanding is 29.2%.
- For agentic scaffolds, iteration loops add more failures as tasks get harder.

Mechanical failures that deterministic checks can catch (syntax errors, failed or cascading edits, tool errors, context overflow) still account for 17–39% of failures per model on SWE-Bench Pro. The share is highest for older or weaker models.

### Cited Findings
**Failure-taxonomy studies (2025–2026)**
- *An Empirical Study on Failures in Automated Issue Solving* (2025) — [arXiv 2509.13941](https://arxiv.org/abs/2509.13941)
  - Scope: 342 failure instances across 150 issues. The taxonomy has 3 phases (Localization; Repair; Iteration & Validation), 9 categories and 25 subcategories. Systems studied include OpenHands (agentic), Agentless (pipeline) and "Tools Claude".
  - On Easy tasks, a notable share of failures still occurs in Localization: **41% for OpenHands and 39% for Tools Claude**. On Medium and Hard tasks the localization share drops and the Iteration & Validation share "rises dramatically". — [arXiv 2509.13941 PDF](https://arxiv.org/pdf/2509.13941)
  - Pipeline tools are brittle at localization: if the first step fails, the run is doomed. Agentic tools find bugs better but fall into "Iteration Anomalies":
    - *Non-Progressive Iteration*: repeatedly editing the same fragment without progress.
    - *Blind Strategy Switching*.
    - *Validation Retreat*: modifying the test so it passes instead of fixing the code.
  - Localization subcategories include *Issue Misleading* and *Superficial Information Matching*. — [arXiv 2509.13941](https://arxiv.org/abs/2509.13941)
  - A search summary says "65% of failures were attributed to flawed reasoning rather than a lack of context". I could not confirm this in the paper text (see Gaps). — [arXiv 2509.13941 PDF](https://arxiv.org/pdf/2509.13941)
- *Characterizing the Failure Modes of LLMs in Resolving Real-World GitHub Issues* (May 2026) — [arXiv 2605.12270](https://arxiv.org/abs/2605.12270)
  - Setup: Claude 4.5 Sonnet, Gemini 3 Pro and GPT-5 on 100 SWE-bench Verified tasks × 3 runs = 900 attempts. 657 were resolved and **243 failed (27%)**. All failures were analysed manually into a five-stage taxonomy.
  - **Strategy & Logic: 90 failures (37%).** This is the most error-prone stage for every model, and its largest category is **S1 "Partial or incomplete fixes"**. The authors: agents "accurately localize faults" but "fail to synthesize comprehensive repair logic".
  - **Problem Understanding: 71 failures (29.2%)**: P1 misinterpretation or missing domain knowledge (44) and P2 distracted by hints/TODOs (27).
  - **Localization has the lowest failure rate** of all stages. The official harness occasionally misjudges correct patches.
- *Coherence Collapse: Diagnosing Why Code Agents Fail After Reaching the Right Code* (2026) — [arXiv 2603.24631](https://arxiv.org/abs/2603.24631)
  - Code agents resolve 65–70% of SWE-bench Verified, yet **60–69% of failures on SWE-Agent and OpenHands reach and edit the correct functions but still produce incorrect patches**.
  - TRAJEVAL splits 16,758 trajectories (3 architectures, 7 models) into search, read and edit stages aligned with the reference patch.
  - The largest theme among edit-quality failures is reaching correct code and then overwriting or thrashing it. In five cases a patch **bit-identical to the gold patch existed mid-trajectory and was later destroyed**.
- *Understanding Code Agent Behaviour: An Empirical Study of Success and Failure Trajectories* (ICSE 2026; OpenHands, SWE-agent, Prometheus) — [arXiv 2511.00197](https://arxiv.org/abs/2511.00197)
  - Failed trajectories are longer:

    | Agent | Lite | Verified |
    |---|---|---|
    | SWE-agent | +12.6% | +18.5% |
    | OpenHands | +31.0% | +82.5% |
    | Prometheus | +56.6% | +50.7% |

  - **[earlier round]** 72–81% of trajectories identify the right files even when they fail.
- *What Resolve Rate Hides: Trajectory Structure Diagnostics for Coding Agents* (TraceProbe, 2026) — [arXiv 2607.06184](https://arxiv.org/abs/2607.06184)
  - Based on 2,500 trajectories from five production settings on SWE-bench Verified.
  - "File choice is too coarse to separate success from failure, whereas function selection and completion behavior localize it."
  - Among rule-detected anti-patterns (search loops, verification skips), **search loops are the most stable**.
- *Beyond Resolution Rates: Behavioral Drivers of Coding Agent Success and Failure* (2026) [corr] — [arXiv 2604.02547](https://arxiv.org/abs/2604.02547)
  - Based on 9,374 trajectories from 19 agents (8 frameworks, 14 LLMs) on 500 tasks.
  - Top agents still fail more than 20% of problems. 12 never-solved tasks need only simple patches.
  - The LLM drives success more than the framework does. **Context gathering and validation effort are reliable predictors of success once difficulty is controlled.**
- *Confident and Wrong: Silent Semantic Failures in Coding Agents* (2026) — [arXiv 2603.25764](https://arxiv.org/abs/2603.25764)
  - Silent-failure patches are "far more alike than a cross-task baseline": the agent rebuilds the same wrong fix on every run, a fixed misreading rather than bad luck.
  - 16 tasks trap only one model. Silent failures therefore come from both hard tasks and over-eager models.

**Benchmark error analyses**
- **SWE-Bench Pro** (Scale AI, 2025), failure-mode analysis of failed trajectories — [arXiv 2509.16941](https://arxiv.org/abs/2509.16941); [Scale-hosted PDF](https://static.scale.com/uploads/654197dc94d34f66c0f5184e/SWEAP_Eval_Scale%20(9).pdf)

  | Model | Largest failure categories |
  |---|---|
  | Claude Opus 4.1 | wrong solution **35.9%**; syntax errors **24.2%** |
  | Claude Sonnet 4 | context overflow **35.6%**; endless file reading **17.0%** |
  | Gemini 2.5 | tool errors **38.8%**; syntax errors **30.5%**; wrong solution **18.0%** |

- **SWE-agent** (NeurIPS 2024; 2024 work) — [arXiv 2405.15793](https://arxiv.org/abs/2405.15793); [NeurIPS PDF](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf)
  - Of 248 unresolved SWE-bench Lite trajectories (categorised with GPT-4o), **52.0%** are Incorrect or Overly Specific Implementation, and **23.4%** are failed-edit recovery (cascading failed edits).
  - **1,185 of 2,294 trajectories (51.7%)** have at least one failed edit.
  - An edit attempt eventually succeeds **90.5%** of the time, but only **57.2%** after a single failed edit.
- *Beyond Final Code: A Process-Oriented Error Analysis of Software Development Agents* (ICSE 2026) — [arXiv 2503.12374](https://arxiv.org/abs/2503.12374); [ACM](https://dl.acm.org/doi/10.1145/3744916.3773140)
  - Covers 3,977 solving-phase trajectories and 3,931 testing-phase logs from 8 top agents on 500 SWE-bench issues.
  - The most prevalent errors are **1,053 ModuleNotFoundError** and **992 TypeError** instances.
  - Python execution errors during resolution correlate with lower resolution rates and higher reasoning overhead [corr].
  - OSError and IntegrityError recur. The study also found 3 bugs in the SWE-bench platform itself.

**Cost of failure: token snowball, loops, context**
- **SWE-Effi.** With SWE-agent + GPT-4o-mini, a failed attempt consumes **more than 8.8M tokens and 658 s**, versus 1.8M tokens and 167.2 s for a success. That is over 4× in both. The authors call this the **"token snowball"** effect and **"expensive failures"**: agents burn resources while stuck on unsolvable tasks. — [arXiv 2509.09853](https://arxiv.org/abs/2509.09853)
- **Fail-Fast, Restart-Smart** (Aug 2026). Failed runs are longer and "exhibit redundant exploration or looping".
  - A 0.6B monitor predicts failure from trajectory prefixes.
  - On an alarm, a fresh rollout restarts, with the interrupted diff available as an optional overlay.
  - Effect sizes were not retrieved.

  — [arXiv 2608.03222](https://arxiv.org/abs/2608.03222)

**Real-world usage (not benchmarks)**
- **How Coding Agents Fail Their Users** — [arXiv 2605.29442](https://arxiv.org/abs/2605.29442)
  - Based on 20,574 real sessions from 1,639 repositories, with seven misalignment types: wrong project diagnosis, misread developer intent, constraint violation, self-initiated overreach, faulty implementation, operational execution error, and inaccurate self-reporting.
  - 90.50% of episodes impose effort or trust costs rather than irreversible damage, yet **91.49% of visible resolutions need explicit user correction**.
  - After a misaligned session, the next session is misaligned with probability 0.519, versus 0.336 otherwise.
- **Where Do AI Coding Agents Fail?** (MSR 2026) — [arXiv 2601.15195](https://arxiv.org/abs/2601.15195)
  - Based on 33k agent PRs from Codex, Copilot, Devin, Cursor and Claude Code.
  - Each additional failed CI check-run cuts merge odds by about 15%.
  - Reviewer abandonment accounts for 38% of rejections. Code-level reasons account for 22%: CI/test failures 17%, incorrect implementation 3%, incomplete implementation 2%.

### Inferences
- **Approximate ranking of failure sources for current frontier agents on SWE-bench-style tasks:**
  1. Wrong or incomplete repair logic applied to the right code: about 37% by stage, and 60–69% of failures touch the correct functions.
  2. Misunderstanding the issue: about 29%.
  3. Iteration pathologies (loops, strategy thrash, validation retreat), which grow with difficulty.
  4. Mechanical failures (syntax or failed edits, tool errors, context overflow).
  5. File-level localization, the least frequent.

  Weaker models shift weight toward the mechanical classes.
- **Failure class → deterministic signal a code-intelligence engine could give.** This mapping is my inference; nobody has measured it end-to-end.

  | Failure class (measured share) | Deterministic signal |
  |---|---|
  | Syntax errors and failed edits: 24.2–30.5% of SWE-Bench Pro failures; 23.4% of SWE-agent's unresolved runs | Parse check on every edit |
  | TypeError-class call mismatches (992 occurrences) | Arity and signature checks |
  | ModuleNotFoundError (1,053 occurrences, many environment-related) | Unresolved-import checks |
  | "Partial or incomplete fixes" and "reached the right code, then wrecked it" | Change-impact lists (callers, overrides, tests) and edit checkpoints |
  | Endless reading and context overflow (Sonnet 4: 17.0% and 35.6%) | Bounded, precise navigation answers |
  | Search loops | Loop detection |

- Failures cost more than 4× the tokens of successes (SWE-Effi). A signal that converts or shortens failing runs therefore saves far more tokens than one that trims successful runs.
- Silent failures are convergent: the same wrong fix recurs. Re-sampling alone will not fix them. New *information* is needed, such as impacted callers or relevant tests, and that is what an index can supply.

### Gaps
- The per-category percentages of arXiv 2509.13941 were not retrieved (arxiv.org is blocked); only the Easy-task localization shares were. The "65% flawed reasoning" figure is unverified.
- The count inside 2605.12270's S1 "Partial or incomplete fixes" category was not retrieved. I could not check whether S1 includes "definition changed, call sites not updated".
- No failure-*type* breakdown was found for Multi-SWE-bench or SWE-PolyBench; they only report breakdowns by patch size.
- No 2026 statistics were found on loop prevalence (e.g., % of failed runs with N or more repeated identical actions). Fail-Fast-Restart-Smart's effect sizes were not retrieved.

## Q2. Patches that pass the target tests but break other tests or leave stale call sites; multi-site edit completeness

### Takeaway
Direct measurements of "passes the benchmark's tests but breaks something else" exist:
- **7.8%** of all SWE-bench Verified patches count as correct while failing the developer-written test suite.
- **6.08%** of instances regress with a 30B open model.
- Weaker CLI agents add **1–2 new failing tests per multi-hunk repair attempt**.

Success collapses as edits spread across files (**18% → 2%** from 1–2 to 7+ files on SWE-Bench Mobile), and multi-file refactors are solved at **22% vs 87%** for humans. **I still found no study that directly quantifies failures caused by editing a function without updating its callers.** The closest proxies are:
- "Partial or incomplete fixes" is the largest category of the most error-prone stage (2605.12270).
- Agents identify stale tests after a code change at only about **36% F1** (TEBench).
- CodePlan's may-impact analysis took 0/7 → 5/7 repositories to a valid state (2024 background).

### Cited Findings
- **PatchDiff: *Are "Solved Issues" in SWE-bench Really Solved Correctly?*** (ICSE 2026; plausible patches from three tools on SWE-bench Verified) — [arXiv 2503.15223](https://arxiv.org/abs/2503.15223); [authors' PDF](https://software-lab.org/publications/icse2026_SWE-bench-correctness.pdf)
  - **29.6%** of plausible patches behave differently from the ground-truth patch.
  - The divergences come from similar-but-divergent implementations (46.8%) and from patches that change more behaviour than the ground truth (27.3%).
  - 28.6% of the divergent patches are certainly incorrect.
  - SWE-bench's validation lets **7.8% of all patches count as correct while failing the developer-written test suite**.
  - Together these weaknesses inflate reported resolve rates by **6.2 absolute points**.
- **TDAD** (2026; SWE-bench Verified with Qwen3-Coder 30B on 100 instances and Qwen3.5-35B-A3B on 25) — [arXiv 2603.17973](https://arxiv.org/abs/2603.17973v2)

  | Condition | Regression rate |
  |---|---|
  | Vanilla agent | **6.08%** |
  | TDAD | **1.82%** |
  | "TDD prompting" alone | **9.94%** |

- **Beyond Accuracy: Behavioral Dynamics of Agentic Multi-Hunk Repair** (2025/2026). Claude Code, Codex, Gemini-cli and Qwen Code on 404 multi-hunk bugs (PolyHunk), for 1,616 trajectories. — [arXiv 2511.11012](https://arxiv.org/abs/2511.11012)
  - Localization success ranges from 75.3% (Codex) to 40.4% (Qwen Code).
  - Repair accuracy ranges from 26.98% (Qwen Code) to 92.82% (Claude Code) and falls as bug dispersion increases.
  - "Regression reduction" is +2.17 for Claude Code and +2.16 for Codex, versus −1.50 for Qwen Code and −2.10 for Gemini-cli. The weaker agents introduce **on average 1–2 new test failures per repair attempt**.
- **Hunk4J** (ASE 2025): 372 real multi-hunk defects, six LLMs. Success falls as hunk divergence and spatial dispersion rise, and fixed bugs show lower divergence than unfixed ones. — [arXiv 2506.04418](https://arxiv.org/abs/2506.04418)
- **Investigating Test Overfitting on SWE-bench** (FSE 2026 IVR). Here "overfitting" means passing the self-generated tests but failing the golden tests. — [arXiv 2511.16858](https://arxiv.org/abs/2511.16858)
  - Claude-3.7-Sonnet: **21.8%** (50 of 229 instances).
  - GPT-4o: **33.0%**.
- **RefactorBench** (ICLR 2025): 100 handcrafted multi-file refactoring tasks. — [arXiv 2503.07832](https://arxiv.org/abs/2503.07832); [Microsoft Research](https://www.microsoft.com/en-us/research/publication/refactorbench-evaluating-stateful-reasoning-in-language-agents-through-code/)
  - LM agents solve **22%** with base instructions; a human under short time limits solves **87%**.
  - A state-aware interface improves task completion by **43.9% relative** and subtask completion by **71%**.
  - The signature failure mode is losing track of past actions.
- **CodePlan** [background, FSE 2024] — [arXiv 2309.12499](https://arxiv.org/abs/2309.12499); [ACM](https://dl.acm.org/doi/10.1145/3643757)
  - Combines incremental dependency analysis, change may-impact analysis and adaptive planning with an LLM.
  - Tasks: C# package migration and Python temporal edits, needing inter-dependent changes in 2–97 files.
  - **5 of 7 repositories** pass validity checks (build without errors and correct edits). Baselines with the same context but no planning pass **0 of 7**.
- **Evidence that success falls as files per task grow**
  - **SWE-Bench Mobile:** success falls from **18% at 1–2 files to 2% at 7+ files**. — [arXiv 2602.09540](https://arxiv.org/abs/2602.09540)
  - **SWE-EVO:** 48 tasks averaging **21 files** and 874 tests per instance. GPT-5 resolves **21%**, versus 65% on SWE-bench Verified. The paper adds a Fix Rate metric that explicitly penalises regressions. — [arXiv 2512.18470](https://arxiv.org/abs/2512.18470)
    - Conflicting figure: a secondary article quotes "25% on tasks spanning an average of 21 files, versus over 70%" on single-file SWE-bench Verified tasks. — [Medium, Jun 2026](https://medium.com/@mehdibafdil/why-coding-agents-fail-when-bugs-span-more-than-20-files-9482f617dfa4)
  - **SWE-PolyBench:** tasks need 63% more edited files than SWE-bench. Performance declines consistently for multi-file edits and for issues needing changes to classes and functions at the same time. — [arXiv 2504.08703](https://arxiv.org/abs/2504.08703)
  - **FEA-Bench** (ACL 2025): 1,401 feature-implementation tasks from 83 repositories. The best model, DeepSeek-R1, resolves **about 10%**. — [arXiv 2503.06680](https://arxiv.org/abs/2503.06680)
- **TEBench: *Breaking, Stale, or Missing?*** (2026): 314 tasks from 10 Defects4J projects, each built from a code-changing commit. — [arXiv 2605.06125](https://arxiv.org/abs/2605.06125)
  - Composition: Test-Breaking 54.8%, Test-Stale 65.9%, Test-Missing 63.4%; 69.7% of tasks carry more than one label.
  - Systems identify which tests must change at only **45.7–49.4% F1**. Stale tests are the hardest, at **about 36% F1**.
- **LLM refactoring safety:** on 180 real refactorings, **13 of 176** ChatGPT solutions (7.4%) and **9 of 137** Gemini solutions (6.6%) were unsafe, meaning they changed functionality or introduced syntax errors. — [arXiv 2411.04444](https://arxiv.org/abs/2411.04444)
- **Agentic PRs:** CI/test failures explain 17% of rejections and incomplete implementations 2%. — [arXiv 2601.15195](https://arxiv.org/abs/2601.15195)
- **Coherence debt** (Aug 2026). When a fact an edit depends on (tests, imports, config, migration rules) is missing from context, agents produce *wrong* work rather than no work: they fabricate a file or guess a value. A stale convention file costs more than no file. The authors recommend checking fact availability "against what the agent produces rather than what it reads". No numbers were retrieved. — [arXiv 2608.16630](https://arxiv.org/abs/2608.16630)

### Inferences
- **"Passes target tests but breaks something else" is roughly 2–8% of instances** on SWE-bench-style tasks for current agents:
  - 7.8% of all patches fail the fuller developer suite (PatchDiff).
  - 6.08% regress with a small open model (TDAD).
  - Strong CLI agents achieve a *net reduction* of failing tests on multi-hunk bugs.

  The rate rises for weaker models and long-horizon, many-file tasks.
- **The multi-site problem is real but unattributed.** Success falls steeply with the number of files and hunks, and stale-test identification is poor (about 36% F1). Nobody has attributed failures specifically to call sites left un-updated.
- **A cheap in-house measurement would fill the gap**, using tree-sitter only:
  - For failed agent patches on SWE-bench Verified or Multi-SWE-bench, count cases where the gold patch edits a caller or override of a symbol the agent changed, but the agent patch does not.
  - Count agent patches that change a signature but leave call sites with a mismatched arity.
- CodePlan (0/7 → 5/7) is the only controlled evidence that may-impact propagation helps repository-wide edits. It predates agentic scaffolds and relied on build and type-checker oracles, so its effect size probably does not transfer directly to Claude Code-class agents.

### Gaps
- **Explicitly still missing:** a direct quantification of failures caused by editing a function without updating its callers, overrides or implementations. Nothing was found in the 2025–2026 taxonomies (2509.13941, 2511.00197, 2605.12270, 2603.24631), benchmark papers (SWE-Bench Pro, Multi-SWE-bench, SWE-PolyBench, FEA-Bench), refactoring studies (RefactorBench, 2411.04444) or multi-hunk studies (2506.04418, 2511.11012). The earlier round's conclusion stands.
- A search extract attributed to Multi-SWE-bench and J. Ganhotra's blog stated: "once a patch edits three or more files, or spans more than 100 lines, success falls below ten percent, and patches touching seven or more files are never solved". Both source hosts were blocked, so the attribution is unverified. Do not cite it.
- No leaderboard statistic was found for the share of unresolved submissions that fail *only* PASS_TO_PASS. It can be computed from the public SWE-bench evaluation logs, which report FAIL_TO_PASS and PASS_TO_PASS results per instance.
- Not retrieved: the size of 2605.12270's S1 category; AgentLens on "lucky passes" ([arXiv 2605.12925](https://arxiv.org/abs/2605.12925)); mutation-guided regression-suite strength ([arXiv 2604.01518](https://arxiv.org/abs/2604.01518)).

## Q3. Measured effect of feedback given at edit time (linters, type checkers, LSP diagnostics, impact checks, targeted tests)

### Takeaway
Only a handful of controlled numbers exist:

| Signal | Source | Effect |
|---|---|---|
| Edit-time syntax/undefined-name lint | SWE-agent | **+3.0 pp** (15.0% → 18.0% on SWE-bench Lite, about +20% relative) |
| Targeted regression-test reuse | TestPrune | **+8.0–12.9% relative** resolution across Agentless, SWE-agent and Trae |
| Static code→test impact map (small open models) | TDAD | **−70% regressions**; resolution 24% → 32% |
| Explicit state tracking | RefactorBench | **+43.9% relative** |
| May-impact planning (2024 background) | CodePlan | **0/7 → 5/7** repositories |

Generic procedural prompting ("do TDD") *increased* regressions. The 2026 LSP study found that LSP navigation buys precision (1.00 vs 0.76), not recall, and usually *costs* tokens. I found **no public ablation** of Claude Code's automatic post-edit LSP diagnostics, OpenHands' lint-on-edit, or Aider's lint/test loop.

### Cited Findings
- **SWE-agent linter** [ablation; earlier round for the numbers]. SWE-bench Lite, GPT-4 Turbo: **18.0% with linting vs 15.0% without**. — [arXiv 2405.15793](https://arxiv.org/abs/2405.15793)
  - The linter runs `flake8 --isolated --select=F821,F822,F831,E111,E112,E113,E999,E902`: undefined names, duplicate argument, indentation errors, syntax error, I/O error.
  - An edit that introduces an error is reverted. The agent then sees the error, what the edit would have looked like, and the original file.
  - Pre-existing errors are line-shifted, so only *newly introduced* errors trigger a rollback.

  — [arXiv 2405.15793 PDF](https://arxiv.org/pdf/2405.15793); [SWE-agent deep dive (dev.to)](https://dev.to/truongpx396/swe-agent-deep-dive-build-your-own-guide-ade)
  - Misquote to avoid: a GitHub issue summarises this as "+3 points on a 12.47% baseline". That mixes the full-SWE-bench headline score (12.47%) with the Lite ablation (15.0 → 18.0). — [no-human-ai/no_human #114](https://github.com/no-human-ai/no_human/issues/114)
- **Aider** [claim; no effect size retrieved]. Aider lints each file after every LLM edit and sends errors back for a fix round. — [aider: Linting code for LLMs with tree-sitter](https://aider.chat/2024/05/22/linting.html)
  - A language-agnostic tree-sitter pass flags AST nodes of type `ERROR`.
  - For Python, it adds flake8's "showstopper" codes E901, E999, F821, F822 and F823, which halt execution (SyntaxError, NameError).
- **Agentless** (FSE 2025) — [authors' PDF](https://lingming.cs.illinois.edu/publications/fse2025.pdf); [GitHub](https://github.com/openautocoder/agentless)
  - Resolves 96/300 (32.00%) on SWE-bench Lite.
  - Sampling 4 edit-location sets instead of 1 raises fixes from 80 to 96. Perfect patch selection would give 126 (42.0%).
  - Generated reproduction tests exist for 213/300 problems, but only 94 correctly verify the ground-truth patch.
- **TestPrune** [ablation] ("When Old Meets New" v1 → "Can Old Tests Do New Tricks for Resolving SWE Issues?", FSE 2026) — [arXiv 2510.18270](https://arxiv.org/abs/2510.18270); [ACM](https://doi.org/10.1145/3808148); [IBM Research](https://research.ibm.com/publications/can-old-tests-do-new-tricks-for-resolving-swe-issues); [Pith review](https://pith.science/paper/2510.18270) (source of the 1,000×/27× figures)
  - It minimises the regression suite to issue-relevant tests: **from thousands to an average of 9** (over 1,000×), with **27× less runtime**.
  - Issue reproduction: **+6.2–9.0% relative** in Otter.
  - Issue resolution: +9.4–12.9% relative in Agentless (v1). v2 reports **+8.0–12.9% relative across Agentless, SWE-Agent and Trae agent**, on SWE-bench Lite and Verified.
- **TDAD** [ablation; small models, small samples] — [arXiv 2603.17973](https://arxiv.org/abs/2603.17973v2); [GitHub](https://github.com/pepealonso95/TDAD)
  - An AST-based code-test graph plus weighted impact analysis, delivered as an agent skill: a static text file the agent queries at runtime.
  - Regressions **6.08% → 1.82% (−70%)**. The GraphRAG workflow raised resolution **24% → 32%**.
  - TDD prompting alone raised regressions to **9.94%**. The authors conclude that smaller models benefit more from context ("which tests to verify") than from procedural instructions.
- **Does a Language Server Save Tokens for Coding Agents?** (Aug 2026) [ablation] — [arXiv 2608.13568](https://arxiv.org/abs/2608.13568)
  - Setup: five-arm ablation; Claude Opus 4.8, Sonnet 4.6 and Haiku 4.5; Python and TypeScript repositories.
  - **Symbol-named localization:** the LSP *costs* **+6% to +118% tokens**. Models default to grep, using the LSP 0–6% of the time.
  - **Reference completeness:** LSP precision is **1.00 vs grep's 0.76**, with **identical recall** across arms. Models choose the LSP unprompted 45–57% of the time. It saves tokens only for the weakest model.
  - Per repository:

    | Repository | F1 change | Token change |
    |---|---|---|
    | remeda (clean TypeScript) | none | +16% |
    | hono (noisy TypeScript) | **+0.246** | **−12%** |
    | requests (Python) | +0.072 | +19% |

- **Claude Code** [claim]
  - With a code-intelligence (LSP) plugin installed, "after every file edit Claude makes, the language server reports errors and warnings back". Claude sees type errors, missing imports and syntax issues without running a compiler, and can fix them in the same turn. — [Claude Code docs: discover plugins](https://code.claude.com/docs/en/discover-plugins)
  - A secondary source lists official plugins for Python (Pyright), TypeScript, Go, Rust, Java, Kotlin, C/C++, C#, PHP, Lua and Swift. — [karanbansal.in](https://karanbansal.in/blog/claude-code-lsp/)
  - **[earlier round]** v2.1.111 fixed "LSP diagnostics from before an edit appearing after it, causing the model to re-read files it just edited". — [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
  - No effect size has been published.
- **Hermes Agent** [claim] implements post-edit LSP diagnostics as a *delta*: capture baseline diagnostics, write the file, re-query the server, drop diagnostics already in the baseline, and surface only new ones. — [Hermes Agent docs: LSP semantic diagnostics](https://hermes-agent.nousresearch.com/docs/user-guide/features/lsp)
- **Static Analysis as a Feedback Loop** [ablation; code quality, not agent resolve rate]. GPT-4o with Bandit and Pylint findings injected over iterations. — [arXiv 2508.14419](https://arxiv.org/abs/2508.14419)

  | Issue type | Before | After ten iterations |
  |---|---|---|
  | Security issues | >40% | **13%** |
  | Readability violations | >80% | **11%** |
  | Reliability warnings | >50% | **11%** |

- **Type-constrained decoding** (PLDI 2025) [ablation; generation-time constraint, not an agent loop]. Enforcing well-typedness during decoding "reduces compilation errors by more than half" and significantly increases functional correctness in synthesis, translation and repair (HumanEval/MBPP in TypeScript, models above 30B included). — [PLDI 2025](https://pldi25.sigplan.org/details/pldi-2025-papers/25/Type-Constrained-Code-Generation-with-Language-Models); [ETH SRI](https://www.sri.inf.ethz.ch/publications/muendler2025typeawareconstraint)
- **SWE-RM** (ICLR 2026) [ablation; context only, a *learned* execution-free signal rather than a deterministic one]. On SWE-bench Verified with test-time scaling: Qwen3-Coder-Flash 51.6% → 62.0% and Qwen3-Coder-Max 67.0% → 74.6%. In RL it adds +3 points over execution-based counterparts. — [arXiv 2512.21919](https://arxiv.org/abs/2512.21919)
- **Edit-state interventions**
  - An **edit-commit checkpoint** recovered all five cases where agents had produced, then destroyed, a gold-identical patch. — [arXiv 2603.24631](https://arxiv.org/abs/2603.24631)
  - RefactorBench's state-aware interface gave **+43.9% relative**. — [arXiv 2503.07832](https://arxiv.org/abs/2503.07832)

### Inferences
- The best-supported signals are **specific facts delivered at the moment of editing**, not generic instructions:
  - which tests to run (TestPrune, TDAD);
  - that *this* edit introduced a new undefined name or syntax error (SWE-agent);
  - what the agent has already changed (RefactorBench, checkpoints).

  TDAD's finding that TDD prompting made regressions *worse* is the cleanest contrast.
- **Report only the delta**, meaning new diagnostics caused by this edit, as SWE-agent and Hermes do. It avoids blaming the agent for pre-existing errors and keeps the feedback small, which matters given the context-overflow failure share.
- **LSP-grade precision pays mainly where grep is noisy** (common names, large or noisy repositories). A tree-sitter engine should expect the same: the value is precision on ambiguous symbols, not token savings on easy lookups. Agents also ignore an optional precise tool on easy localization, so the signal should be pushed at edit time rather than offered as a tool.
- **The measured effects are modest and come from older or smaller models** (+3 pp; +8–13% relative; TDAD on 30–35B models). Frontier agents already self-correct syntax, so the marginal value of parse and lint feedback is probably lower for them. Impact lists and test selection target the dominant semantic and completeness failures, but no frontier-model ablation exists for them.

### Gaps
- No controlled measurement was found for post-edit LSP diagnostics (Claude Code, Copilot agent mode, OpenCode/Kilo, Hermes) or for OpenHands' linting.
- Aider's SWE-bench lint/test retry statistics were not retrievable (aider.chat was blocked).
- Not retrieved in this round:
  - RepairAgent (ICSE 2025).
  - Compiler-feedback repository code generation (CoCoGen, ProCoder).
  - Agentless's regression-test-filtering ablation.
  - Structured or AST-level edit actions: CODESTRUCT ([arXiv 2604.05407](https://arxiv.org/abs/2604.05407)) and SWE-Edit ([arXiv 2604.26102](https://arxiv.org/abs/2604.26102)).
  - The scaffold taxonomy ([arXiv 2604.03515](https://arxiv.org/abs/2604.03515)), which may list which scaffolds lint on edit.
- An **unsourced** claim appears in a GitHub issue: "compiler feedback alone resolves ~35% on SWE-bench Verified; mixed with test feedback ~56%" ([no_human #114](https://github.com/no-human-ai/no_human/issues/114)). No primary source was found. Do not use it.
- TDAD's per-model split (which model produced 6.08% → 1.82%) and its test-selection precision were not retrieved.

## Q4. Test selection and regression test selection for agents; test-to-code traceability without coverage

### Takeaway
For agents, the measured wins come from giving them a **small, issue-relevant test set**:
- TestPrune: an average of 9 tests, 27× faster, +8–13% relative resolution.
- TDAD: a static AST code→test graph, −70% regressions on small models.

Agents are poor at choosing affected tests themselves (TEBench: 45.7–49.4% F1). Without coverage, the older evidence shows:
- Naming conventions are near-perfectly precise where the convention holds, but not always applicable.
- Static call graphs add recall but lose precision through helper methods.
- Multi-signal ensembles reach 85–92% MAP (background).

### Cited Findings
- **TestPrune** — [arXiv 2510.18270](https://arxiv.org/abs/2510.18270)
  - Pipeline: an LLM predicts "suspicious functions" from the issue; the test files related to those functions are retrieved; a greedy algorithm picks a minimal subset that maximises *coverage of the suspicious code*. The last step uses coverage, so TestPrune is not purely static.
  - Result: thousands of tests → average 9, 27× less runtime, +8.0–12.9% relative resolution.
  - Rationale given: large suites "exceed context limits, introduce noise, and inflate inference costs".
- **TDAD**: a static, AST-based code-test graph with weighted impact analysis, so that "before committing a patch, the agent knows which tests to verify". Regressions fell 6.08% → 1.82%. — [arXiv 2603.17973](https://arxiv.org/abs/2603.17973v2)
- **Agentless**: only 94 of 213 generated reproduction tests correctly verify the gold patch. — [FSE 2025 PDF](https://lingming.cs.illinois.edu/publications/fse2025.pdf)
- **Validation effort and test choice**
  - Validation effort predicts success once difficulty is controlled [corr]. — [arXiv 2604.02547](https://arxiv.org/abs/2604.02547)
  - "Verification skips" are a rule-detectable anti-pattern. — [arXiv 2607.06184](https://arxiv.org/abs/2607.06184)
  - Agents deciding which tests a commit affects reach 45.7–49.4% F1, and about 36% on stale tests. — [arXiv 2605.06125](https://arxiv.org/abs/2605.06125)
- **Test-to-code traceability without coverage** [background] — [Establishing Traceability Links between Unit Test Cases and Units under Test](https://www.researchgate.net/publication/221569791_Establishing_Traceability_Links_between_Unit_Test_Cases_and_Units_under_Test); [Automated Recovery and Visualization of Test-to-Code Traceability Links: An Evaluation](https://www.researchgate.net/publication/349741040_Automated_Recovery_and_Visualization_of_Test-to-Code_Traceability_TCT_Links_An_Evaluation). Which statement comes from which paper is unverified.
  - Six strategies have been evaluated: naming and design conventions, static call graphs, last call before assert (LCBA), lexical analysis, version-log (co-evolution) mining, and combinations.
  - Naming conventions were reported at **100% precision and recall "across all projects investigated"**, where the convention holds.
  - Static call graphs pull in irrelevant helper methods, which lowers precision.
  - Dynamic LCBA needs heavy tracing, with trace files up to 143 GB.
- **TCTracer** [earlier round; background]: naming conventions have 100% precision but low recall. A static plus dynamic ensemble reaches **MAP 85%** for test→function links and **92%** for test class→class links. — [TCTracer, EMSE 2022](https://discovery.ucl.ac.uk/10145439/1/f5f2e040-a6b9-4f07-a0b9-de73b6d60d76.pdf)
- **Classic regression test selection** [earlier round; background]
  - Static class-level STARTS versus dynamic Ekstazi: average suite reduction of 68.28% vs 84.05%, with safety violations for STARTS of roughly 3–6%. Attribution across the comparison papers is unverified. — [CEUR-WS case study](https://ceur-ws.org/Vol-2201/UYMS_YTM_2018_paper_87.pdf)
  - Meta's predictive test selection halves testing cost while still reporting over 95% of individual test failures and over 99.9% of faulty changes. — [arXiv 1810.05286](https://arxiv.org/abs/1810.05286)

### Inferences
- A tree-sitter engine can supply a **TDAD-like static test map**, the variant with a measured agent benefit. Suggested cascade:
  1. Naming convention, the highest precision.
  2. Import and reference edges from test files to the changed files.
  3. Transitive reverse-call reachability from the changed symbols to test functions.
  4. Optionally, co-change between test and source files.

  Return about 10 tests (TestPrune's average is 9) with a confidence for each. Separate "must run" (tiers 1–2) from "likely" (tiers 3–4).
- Present tests as **context, not procedure**. Say "these 7 tests exercise `foo`; run them before finishing", not "follow TDD". TDAD's prompting result argues against procedural instructions.
- Stale-test identification is the weakest agent skill (about 36% F1). A "tests that reference symbols you just changed" list targets it directly. I found no study that measured this.

### Gaps
- No 2025–2026 study was found that measures the precision and recall of *static-only* test selection inside agent loops against a coverage oracle. TDAD's selection accuracy was not retrieved.
- No study of co-change-based test selection for agents was found.
- A 2024 IEEE TSE paper, "Method-level test-to-code traceability link construction by semantic correlation learning", appeared in search results without a URL and was not retrieved.
- The effect of TDAD-style maps on frontier models (Claude or GPT-5 class) is unknown. TDAD used 30–35B open models on 100 + 25 instances.

## Q5. Signals computable without building the project (tree-sitter level), and their measured precision or usefulness for agents

### Takeaway
The only agent ablation of a no-build check is SWE-agent's flake8 subset: syntax errors plus undefined names (F821/F822), worth **+3.0 pp**. It bundles several checks, so the value of undefined-name detection alone is unknown. A non-executing AST checker for hallucinated identifiers and APIs reached **100% precision and 87.6% recall** on 200 Python snippets. The runtime error classes such checks target are frequent in agent trajectories: 992 TypeError and 1,053 ModuleNotFoundError. **I found no measurement of the precision or usefulness, for agents, of cross-file tree-sitter checks**: unresolved references after an edit, call-arity mismatches, callers not updated after a signature change, or removed symbols still referenced.

### Cited Findings
- **No-build checks already in production scaffolds**
  - SWE-agent runs `flake8 --select=F821,F822,F831,E111,E112,E113,E999,E902` on every edit and reverts edits that introduce new errors. The ablation gives +3.0 pp on SWE-bench Lite. — [arXiv 2405.15793](https://arxiv.org/abs/2405.15793)
  - Aider uses tree-sitter `ERROR` nodes (any language) plus flake8 E901/E999/F821/F822/F823. — [aider linting](https://aider.chat/2024/05/22/linting.html)
- **Detecting and Correcting Hallucinations in LLM-Generated Code via Deterministic AST Analysis** (2026) — [arXiv 2601.19106](https://arxiv.org/abs/2601.19106)
  - Method: parse the generated code to an AST and validate identifiers, API calls and parameters against a knowledge base built by library introspection. The generated code is never executed.
  - On 200 curated Python snippets: **100% precision, 87.6% recall (F1 0.934)**. It auto-corrected **77.0%** of the detected hallucinations.
  - It targets "knowledge-conflicting hallucinations", such as non-existent API parameters, which "evade linters".
- **How often these error classes occur**
  - 992 TypeError and 1,053 ModuleNotFoundError instances across 3,977 trajectories. — [arXiv 2503.12374](https://arxiv.org/abs/2503.12374)
  - Syntax errors are 24.2% (Opus 4.1) and 30.5% (Gemini 2.5) of SWE-Bench Pro failures. These are trajectory-level failure categories, not parser counts. — [arXiv 2509.16941](https://arxiv.org/abs/2509.16941)
  - 51.7% of SWE-agent trajectories contain a failed edit. — [arXiv 2405.15793](https://arxiv.org/abs/2405.15793)
- **Package hallucination** [earlier round]: across 576K samples from 16 models, commercial models hallucinate about 5.2% of packages and open models about 21.7%, yielding 205,474 unique fake package names. — [arXiv 2406.10279](https://arxiv.org/abs/2406.10279)
- **Precision matters when lookups are noisy**: LSP references reach precision 1.00 versus grep's 0.76, with equal recall. — [arXiv 2608.13568](https://arxiv.org/abs/2608.13568)
- **Heuristic call-graph precision** [earlier round; background]: PyCG reaches about 99% precision and about 70% recall against a ground-truth call graph. — [arXiv 2103.00587](https://arxiv.org/abs/2103.00587)
- **The false-zero hazard** [earlier round]: a tree-sitter graph MCP reported `callers_total: 0` as "exact" for calls through dependency injection. The reporter's mitigation was "confirm any zero with grep". — [codebase-memory-mcp #2265](https://github.com/DeusData/codebase-memory-mcp/issues/2265)

### Inferences
- **Candidate edit-time checks for a tree-sitter engine**, ordered by expected precision (my ranking; none measured for agents):
  1. **Parse errors** in the edited file. These are exact and cover the SWE-agent and Aider class.
  2. **Newly unresolved names** in the edited file: names that resolve to no local definition, import or indexed symbol (F821-like). Precision is high in static languages; Python and JS dynamics (`getattr`, `__all__`, globals injection) cause some false positives.
  3. **Removed or renamed top-level symbols that still have name-matched references** elsewhere. Precision is high for unique names and weak for common ones (e.g., `get`, `run`).
  4. **Arity mismatches** at call sites of a directly resolved function whose parameter list changed in the diff. Precision drops with defaults, `*args`/`**kwargs`, overloads, decorators and partials.
  5. **"Callers and overrides of a changed signature that the diff did not touch".** This is a recall aid, not an error.

  Report 1–2 as errors and 3–5 as warnings with a confidence. Never report "0 callers" as exact.
- **Unresolved-import checks** are justified by how common ModuleNotFoundError is. Many of those errors come from environment setup rather than agent edits, so flag only imports the edit newly introduced.
- **Validation experiment the engine team could run** (no such study exists):
  1. Replay public SWE-bench agent trajectories.
  2. Run checks 1–5 after each edit step.
  3. Measure precision: was the flag followed by a runtime error or test failure in the same symbol, or fixed by a later edit?
  4. Measure lead time: the steps and tokens the agent spent before discovering the error by execution.

### Gaps
- I found no published precision or recall for cross-file tree-sitter checks used as agent feedback (unresolved references, arity mismatches, stale callers, removed-but-referenced symbols), and no measurement of their effect on resolve rate or tokens.
- No ablation separates F821 (undefined name) from the syntax checks within SWE-agent's +3.0 pp.
- The AST hallucination detector (arXiv 2601.19106) was evaluated on isolated snippets, not in agent loops or on cross-file repository edits.
