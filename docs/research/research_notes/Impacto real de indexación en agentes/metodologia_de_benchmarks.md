# Methodology for measuring whether a code-intelligence tool improves AI coding agents end to end: benchmark designs, task-generation pipelines, metrics and statistics (state as of September 2026)

*Research date: 2026-09-22.*

**Source note (read first).** This session's egress proxy blocked arxiv.org, huggingface.co, openreview.net, openai.com, swe-rebench.com, code.claude.com and most academic hosts. GitHub was reachable through `git clone`, so many figures come from primary artifacts. The web-search budget ran out mid-session, which left some items as gaps. Each item carries one of three tags:

- **[R] Read in a primary artifact this session.** Examples:
  - Repository READMEs and docs.
  - Paper PDFs that ship inside repositories, converted to text here: the SWE-Factory `preprint.pdf`, R2E-Gym `assets/paper.pdf` and SWE-Gym `assets/paper.pdf`.
  - Sourcegraph CodeScaleBench's technical reports and result snapshots.
  - The Claude Code docs, read from the mirror `github.com/ericbuess/claude-code-docs` at a 2026-09-22 commit and cited by their official code.claude.com URLs.
- **[X] Search-engine extract of the cited page.** Usually the arXiv abstract or HTML. Spot-check against the original before quoting externally.
- **[C] Computed in this session.** The computation is described inline: pure-Python power analysis and re-analysis of published per-task data.

The earlier round covered retrieval-level evaluation (LocAgent Acc@k, Loc-Bench, CORE-Bench, contamination) in `docs/research/notes/benchmarks_evaluation.md`. It is referenced here only where needed.

---

## 1. Task generation from real repositories after the models' training cutoff: mining, problem statements, environments, FAIL_TO_PASS/PASS_TO_PASS validation, filtering, yields and pitfalls

### Takeaway
Every current pipeline follows the SWE-bench recipe:

1. Mine merged PRs (or raw commits).
2. Build an executable environment.
3. Keep instances where some tests fail before the reference patch and pass after it (F2P), while other tests keep passing (P2P).
4. Filter for statement quality.

The pipelines differ in two places:
- **How environments are built:** by hand in SWE-Gym (~200 annotator-hours); by LLM agents in SWE-rebench, RepoLaunch and SWE-Factory, with roughly 50–98% build success depending on the reuse strategy.
- **Where the problem statement comes from:** the human issue (SWE-rebench, SWE-bench-Live, Multi-SWE-bench); an issue rewritten and augmented by an expert (SWE-bench Pro); or LLM-written text (SWE-smith, R2E-Gym back-translation).

Yields after quality review are low. OpenAI kept 500 of 1,699 annotated SWE-bench tasks (29%) and Multi-SWE-bench kept 1,632 of 2,456 (66%). The dominant pitfalls are:
- flawed or over-narrow tests (59.4% of hard Verified failures);
- underspecified statements (38.3%);
- solution leakage in issue text (32.67% of "resolved" SWE-bench patches);
- machine- and time-dependent flaky tests;
- contamination (frontier models reproduce Verified gold patches verbatim).

### Cited Findings

**SWE-rebench (Nebius; NeurIPS 2025) and its leaderboard**
- **Scale:** a public dataset of over 21,000 interactive Python SWE tasks from 3,468 distinct GitHub repositories, collected by an automated, continuous pipeline. [X] — [SWE-rebench (arXiv 2505.20411)](https://arxiv.org/abs/2505.20411)
- **Pipeline stages:**
  - automated configuration of installation instructions;
  - execution-based installation verification (the target tests must fail before and pass after the solution patch);
  - automated quality assessment. [X] — [SWE-rebench PDF](https://arxiv.org/pdf/2505.20411); [emergentmind summary](https://www.emergentmind.com/papers/2505.20411)
- **Quality labels:** issue clarity, task complexity and test-patch correctness. A fine-tuned Qwen2.5-72B-Instruct predicts them, trained on the human annotations from SWE-bench Verified. [X] — [SWE-rebench PDF](https://arxiv.org/pdf/2505.20411); [review by A. Lukyanenko](https://artgor.medium.com/paper-review-swe-rebench-an-automated-pipeline-for-task-collection-and-decontaminated-evaluation-8741b3ebd712)
- **Benchmark size:** one reported version of the decontaminated benchmark was a curated subset of 294 executable tasks from 169 repositories, created in 2025. [X] — [SWE-rebench PDF](https://arxiv.org/pdf/2505.20411)
- **Contamination finding:** fresh-task results suggest some models' SWE-bench Verified scores are inflated by contamination. [X] — [SWE-rebench abs](https://arxiv.org/abs/2505.20411)
- **SWE-rebench V2 (arXiv 2602.23866):** over 32,000 containerized tasks from more than 3,600 repositories in 20 languages. [X] — [SWE-rebench V2](https://arxiv.org/pdf/2602.23866)
- **Leaderboard protocol:**
  - Each model runs 5 times on the full benchmark. The leaderboard reports the mean resolved rate with its standard error of the mean, plus pass@5.
  - It reports Cost per Problem and Tokens per Problem.
  - Context is standardized to 128K tokens unless the model supports less.
  
  [X] — [SWE-rebench About](https://swe-rebench.com/about); [SWE-rebench PDF](https://arxiv.org/pdf/2505.20411)
- **Aggregator (not primary):** in August 2026, Claude Opus 4.6 leads SWE-rebench at 65.3%, with the top five models within a 2.5-point spread. [X, aggregator] — [BenchLM SWE-rebench](https://benchlm.ai/benchmarks/swe-rebench)

**SWE-bench-Live and RepoLaunch (Microsoft; NeurIPS 2025 D&B; RepoLaunch arXiv 2603.05026)**
- **Initial release:** 1,319 tasks from GitHub issues created since 2024, across 93 repositories, each with its own Docker image.
- **Difficulty gap:** the same agent–model pair that resolves 43.20% of SWE-bench Verified resolves only 19.25% of SWE-bench-Live. Resolution is especially low on multi-file patches and large codebases.
- **Later release:** a later extract describes 1,890 tasks from 223 repositories.

[X] — [SWE-bench Goes Live (arXiv 2505.23419)](https://arxiv.org/abs/2505.23419); [OpenReview PDF](https://openreview.net/pdf?id=OGWkr7gXka)
- **Update policy:** since 2025-09-17 the Python dataset adds 50 newly verified issues per month to the test split, while the `lite` and `verified` splits stay frozen for leaderboard comparability. [R] — [SWE-bench-Live README](https://github.com/microsoft/SWE-bench-Live/blob/HEAD/README.md)
- **Other splits (2026-08-21):**
  - SWE-bench-Live/MultiLang: 1,077 instances, 431 repositories, 8 languages, more than 100 per language.
  - SWE-bench-Live/Windows: 66 instances, 48 repos, 9 languages.
  
  [R] — [SWE-bench-Live README](https://github.com/microsoft/SWE-bench-Live/blob/HEAD/README.md)
- **Curation recipe:**
  - Crawl repositories by star range (the example uses 10,000–100,000 stars).
  - Filter repositories: more than 200 PRs+issues, more than 200 forks, and more than 60% of code in the main language.
  - Crawl issue–PR pairs created after a `--cutoff-date` (example: 20250501).
  - Apply an LLM-judge filter in the spirit of SWE-bench Verified that removes (1) vague problem statements, (2) test patches requiring things the statement does not mention, and (3) statements that contain the answer. The example uses `gpt-5-20250807`.
  - Use an LLM to split Windows-specific from general tasks.
  
  [R] — [SWE-bench-Live Development.md](https://github.com/microsoft/SWE-bench-Live/blob/HEAD/Development.md)
- **RepoLaunch mechanics:**
  - An LLM agent installs dependencies, builds the repository into a Docker image, writes rebuild and test commands, and writes a parser from test output to per-test status.
  - Languages: C, C++, C#, Python, Java, JS/TS, Go and Rust, on Linux, Android and Windows images.
  - It uses a text Thought–Action format because "many smaller open-source LMs cannot handle tool call field well".
  
  [R] — [RepoLaunch README](https://github.com/microsoft/RepoLaunch/blob/HEAD/README.md)
- **Reuse strategy (2026-08-20):** build and test one commit per repository, then check out the other commits from that image and reuse the extracted commands and parsers. On 856 issues from 93 repos this gave ≥98% success, with 82% lower LM API cost and 78% less Docker storage. [R] — [RepoLaunch README](https://github.com/microsoft/RepoLaunch/blob/HEAD/README.md); [SWE-bench-Live README](https://github.com/microsoft/SWE-bench-Live/blob/HEAD/README.md)
- **Operational requirements:**
  - Example config: `max_trials` 2, `max_steps_setup` 60, `max_steps_verify` 20, `max_steps_organize` 40.
  - `cmd_timeout` 60 min on Linux, 90 min on Windows; each worker needs about 4 CPUs and 16 GB RAM.
  - Large repos like ClickHouse need 10 CPUs and 64 GB.
  - The docs warn that "the performance of your machine directly determines the success rate of task creation".
  
  [R] — [SWE-bench-Live Development.md](https://github.com/microsoft/SWE-bench-Live/blob/HEAD/Development.md)
- **Flakiness handling:**
  - Tests were run 3 times during task creation to filter unstable instances.
  - Tests "may become invalid over time", and users report different tests failing on different machines because "docker does not guarantee full isolation".
  - The maintainers therefore recommend running the gold patch three times on your own infrastructure to filter invalid instances, and allow success rates whose denominator is the number of instances the gold patch passes on your machine.
  - Resources: 4 CPUs and 16 GB per instance; some C++ repos need 50 GB RAM.
  
  [R] — [SWE-bench-Live evaluation README](https://github.com/microsoft/SWE-bench-Live/blob/HEAD/evaluation/README.md)

**SWE-smith (NeurIPS 2025 D&B spotlight): synthetic bugs plus LLM-written issues**
- **Recipe:**
  1. Create one execution environment per repository.
  2. Synthesize task instances.
  3. Keep only tasks that break at least one unit test.
  4. Generate issue text with an LM.
- **Resources:** about 52k instances, "250+ environments, one Docker image per repo", and 26k SWE-agent trajectories. SWE-agent-LM-32B, trained on this data, reaches 40.2% pass@1 on SWE-bench Verified.

[R] — [SWE-smith README](https://github.com/SWE-bench/SWE-smith/blob/HEAD/README.md)
- **Paper figures:**
  - 50,137 instances from 128 Python repositories, packaged as 125 Docker images totalling 295 GB.
  - Bug-generation strategies: LM Modify and LM Rewrite (function level), procedural modifications, bug combination, and PR Mirrors. PR Mirrors are the most expensive because they rewrite whole files.
  - Total cost about $1,360: $1,000 for bug generation, $160 for automatic installation with SWE-agent, and $200 for issue text for 10K bugs.
  
  [X] — [SWE-smith (arXiv 2504.21798)](https://arxiv.org/pdf/2504.21798); [SWE-smith blog](https://swesmith.com/blog.html)
- **Conflict:** the README counts ("52k", "250+ environments") differ from the paper extract (50,137 instances, 125 images, 128 repos). The README presumably reflects later expansion. — [SWE-smith README](https://github.com/SWE-bench/SWE-smith/blob/HEAD/README.md) vs [arXiv 2504.21798](https://arxiv.org/pdf/2504.21798)

**R2E-Gym / SWE-GEN: commits, generated tests and back-translated statements**
- **Pipeline:**
  - Select Python repositories with many commits (SEART GitHub search).
  - Filter "interesting" commits with rule-based plus LLM heuristics.
  - Collect build scripts "by semi-manually searching across dependency pins".
  - Identify F2P tests from existing tests. When a commit has no tests, supplement it with automatically generated F2P tests.
- **Problem statements:** written by back-translation from the commit. Naive back-translation "is quite noisy" (generic statements), so the prompt includes the F2P tests and execution traces, mimicking human bug reports.
- **Yield:** 8,135 problems (R2E-Gym), 4,578 after removing repositories that overlap with SWE-bench (R2E-Gym-Subset). That is "over 2.5 times more problems" than issue-based collection.

[R] — R2E-Gym paper PDF in the repo, [assets/paper.pdf](https://github.com/R2E-Gym/R2E-Gym/blob/HEAD/assets/paper.pdf); [R2E-Gym README](https://github.com/R2E-Gym/R2E-Gym/blob/HEAD/README.md)
- **Pitfall:** the paper reports that a large fraction of LLM-generated tests "either do not reproduce the bug … or do not even pass the correct solution". [R] — [R2E-Gym paper PDF](https://github.com/R2E-Gym/R2E-Gym/blob/HEAD/assets/paper.pdf)

**SWE-Gym (ICML 2025): human-configured environments**
- **Size:** 2,438 tasks from PRs in 11 Python repositories, for example pandas 737, MONAI 374, moto 343 and mypy 257.
- **Construction:** annotators set up environments from configuration files, CI scripts and docs, then ran the SWE-bench execution-based validation.
- **Effort:** "around 200 human annotation hours and 10k CPU core hours", yielding 2,479 unit-test-validated instances.
- **Images:** about 2.6 GB each on average, roughly 6.4 TB in total.

[R] — [SWE-Gym paper PDF](https://github.com/SWE-Gym/SWE-Gym/blob/HEAD/assets/paper.pdf); [arXiv 2412.21139](https://arxiv.org/abs/2412.21139)
- **Conflict:** the README gives a Lite split of 234 instances, but the per-repo counts in the paper's figure sum to 230. — [SWE-Gym README](https://github.com/SWE-Gym/SWE-Gym/blob/HEAD/README.md) vs [paper PDF](https://github.com/SWE-Gym/SWE-Gym/blob/HEAD/assets/paper.pdf)

**SWE-Factory (FSE 2026): LLM multi-agent environment building and exit-code validation**
- **SWE-Builder** is an LLM multi-agent system: Repository Explorer, Environment Manager (Dockerfile), Test Manager (eval script), Test Analyst (validation and refinement) and an environment memory pool that reuses setups from nearby versions of the same repo.
- **Environment-building results on SweSetupBench** (671 issues sampled from 2,441 issues in 12 repos across Python, Java, JS and TS; max 5 iterations; temperature 0.1):

| Base model | Valid instances (F2P rate) | Cost per instance | Time per instance |
|---|---|---|---|
| GPT-4.1-mini | 337/671 (50.2%) | $0.047 | 26.3 min |
| DeepSeek-v3 | 282/671 (42.0%) | $0.037 | 23.0 min |
| Kimi-K2 | 321/671 (47.8%) | $0.056 | 30.2 min |

[R] — [SWE-Factory README](https://github.com/DeepSoftwareAnalytics/swe-factory/blob/HEAD/README.md); [preprint PDF](https://github.com/DeepSoftwareAnalytics/swe-factory/blob/HEAD/preprint.pdf); [arXiv 2506.10954](https://arxiv.org/abs/2506.10954)
- **Validation:** F2P validation parses test-command exit codes instead of writing a log parser per repository. Against manual labels by three researchers it scores F1 = 0.99. The README still recommends manual checks to filter "error-to-pass" cases, where tests error rather than fail before the fix. [R] — [preprint PDF](https://github.com/DeepSoftwareAnalytics/swe-factory/blob/HEAD/preprint.pdf); [README](https://github.com/DeepSoftwareAnalytics/swe-factory/blob/HEAD/README.md)
- **Pitfall — binary test files:** when a PR modifies binary test files (.png, .tif, .zip), the GitHub-API patch contains no binary content. The instance then silently fails F2P validation and drops out. This affected Pillow (30.43% of instances), Manim (27.34%) and matplotlib (22.10%), which biases datasets away from image- and visualization-heavy tasks. [R] — [preprint PDF](https://github.com/DeepSoftwareAnalytics/swe-factory/blob/HEAD/preprint.pdf)

**Multi-SWE-bench (ByteDance Seed; NeurIPS 2025 D&B)**
- **Size:** 1,632 instances in 7 languages (Java, TS, JS, Go, Rust, C, C++), curated from 2,456 candidates by 68 expert annotators.
- **Variants and related data:** Multi-SWE-bench mini (400 instances, 8 languages) and flash (300); Multi-SWE-RL has 4,723 instances.
- **Hints field (2025-09-18):** a `hints` field was added to all instances describing newly defined variables in `test.patch` and `fix.patch`, "making the tasks more complete". This is a fix for interface underspecification.

[R] — [Multi-SWE-bench README](https://github.com/multi-swe-bench/multi-swe-bench/blob/HEAD/README.md)
- **Five-phase construction:**
  1. Repository selection by stars, maintenance and CI/CD support.
  2. Crawling of PRs that are linked to issues and modify test files.
  3. Docker environments derived from CI/CD workflows and docs.
  4. PR filtering by test outcomes across patch configurations, keeping clear bug-fix effects with no regressions.
  5. Manual verification.
  
  [X] — [Multi-SWE-bench (arXiv 2504.02605)](https://arxiv.org/html/2504.02605)

**SWE-bench Pro (Scale AI; arXiv 2509.16941)**
- **Size and splits** (from the earlier round): 1,865 human-verified problems from 41 repositories, in three splits:
  - public: 731 problems from 11 GPL/copyleft repos;
  - commercial: 276 problems from 18 private repos;
  - held-out: 858 problems from 12 repos.
  
  — [SWE-Bench Pro paper](https://arxiv.org/html/2509.16941v1)
- **Task size:** an average of 107.4 changed lines across 4.1 files. [X] — [SWE-Bench Pro PDF](https://arxiv.org/pdf/2509.16941); [Scale blog](https://scale.com/blog/swe-bench-pro)
- **Human augmentation:** each task statement has three parts — a problem statement, requirements and an interface — which "specify all the details necessary to pass the test suite". Experts rewrite the original commit messages and issues. [X] — [SWE-Bench Pro PDF](https://arxiv.org/pdf/2509.16941)
- **Augmentation matters:** removing the augmentations drops some models from over 25% to under 9%. [X] — [SWE-Bench Pro PDF](https://arxiv.org/pdf/2509.16941)
- **Maintenance log from the README:**
  - (2/9) Removed unit tests that "were outdated (e.g. required the year 2025)".
  - (1/7) Fixed instances that took a long time to evaluate.
  - (05/18) "identified some issues with the leaderboard".
  - (10/3) Published results "without cap limit".
  - (10/28) Added mini-swe-agent, with results comparable to SWE-agent for Sonnet 4.5.
  
  [R] — [SWE-bench Pro README](https://github.com/scaleapi/SWE-bench_Pro-os/blob/HEAD/README.md)

**Measured quality problems of mined tasks**
- **SWE-bench Verified annotation:**
  - 93 developers annotated 1,699 random SWE-bench test samples, 3 annotators per sample.
  - 38.3% had underspecified problem statements; 61.1% had unit tests that could unfairly reject valid solutions.
  - 68.3% were filtered out (any ensemble severity ≥2), leaving 500.
  
  [X] — [OpenAI, Introducing SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/)
- **SWE-bench+:**
  - 32.67% of successful patches benefited from "solution leakage" (the solution or strong hints were in the issue or comments).
  - In 31.08% of passed instances the patch was incorrect or incomplete yet passed weak tests.
  - Filtering these cut SWE-Agent+GPT-4 from 12.47% to 3.97%.
  
  [X] — [SWE-Bench+ (arXiv 2410.06992)](https://arxiv.org/abs/2410.06992)
- **OpenAI, February 2026:**
  - In an audit of 138 Verified problems that o3 consistently failed, 59.4% had flawed tests: too narrow (enforcing implementation details) or too wide (testing behaviour the statement does not describe).
  - GPT-5.2, Claude Opus 4.5 and Gemini 3 Flash can reproduce exact gold patches and verbatim problem details.
  - OpenAI recommends SWE-bench Pro and privately authored benchmarks.
  
  [X] — [OpenAI, Why SWE-bench Verified no longer measures frontier coding capabilities](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
- **Memorization (earlier round):** from issue text alone, models identify buggy file paths with up to 76% accuracy on SWE-bench Verified, versus up to 53% on repositories outside SWE-bench. — [SWE-Bench Illusion (arXiv 2506.12286)](https://arxiv.org/abs/2506.12286)
- **Leaderboard protocols that guard against leakage:**
  - SWE-bench submissions must be pass@1 and must not use `PASS_TO_PASS`/`FAIL_TO_PASS` or the `hints` field. Agents with web browsing must show they could not look up solutions.
  - SWE-bench-Live lets the agent see only `problem_statement` and the Docker image. The `test_patch` must not be applied before or during the rollout, prompts must not contain instance-specific solutions, and raw trajectories must be submitted for compliance review.
  
  [R] — [SWE-bench submission checklist](https://github.com/SWE-bench/experiments/blob/HEAD/checklist.md); [SWE-bench-Live README](https://github.com/microsoft/SWE-bench-Live/blob/HEAD/README.md)

### Inferences
- **Survival rates (computed from the cited counts):**

| Pipeline | Kept | Rate | What removed the rest |
|---|---|---|---|
| SWE-bench Verified | 500/1,699 | 29.4% | Human quality review |
| Multi-SWE-bench | 1,632/2,456 | 66.4% | Manual verification |
| SWE-Factory, GPT-4.1-mini | 337/671 | 50.2% | Automated environment build and F2P |
| R2E-Gym | 4,578/8,135 | 56.3% | Decontamination (overlap with SWE-bench repos) |
| SWE-bench-Live | 1,319 tasks / 93 repos | ≈14 tasks per repo | — |
| SWE-rebench | 21,000+ tasks / 3,468 repos | ≈6 tasks per repo | — |

  For a budget-limited benchmark, plan to mine roughly 3–5× the target number of tasks.
- **Recommended recipe for a contamination-safe, code-intelligence-focused task set:**
  1. **Choose repositories:** permissive or GPL repos with CI, more than 200 PRs, and languages the tool supports. Include at least 2–3 large repos, where search matters most (SWE-bench-Live found the lowest resolution on large codebases and multi-file patches).
  2. **Mine PRs** merged after the latest cutoff among the tested models, with a buffer of 1–2 months, and keep the merge date as metadata. If the models' cutoffs are unknown, use the most recent 3–6 months.
  3. **Build environments** with RepoLaunch's commit-reuse strategy or SWE-Factory's memory pool.
  4. **Validate:**
     - the gold patch passes F2P and P2P 3 times on your own hardware;
     - the null patch fails F2P;
     - exclude error-to-pass and binary-file tasks, or recover their binaries.
  5. **Screen statements with an LLM judge** using the SWE-bench-Live criteria (vague statement; tests require unmentioned behaviour; answer in the statement). Also run a string check that no gold identifier introduced by the patch appears in the statement unless it already existed in the repo.
  6. **Hand-review** the survivors, at about 5–10 minutes per task.
- **Problem-statement source:**
  - Human issues are the most realistic, but about 38% are underspecified and some leak the solution.
  - Expert-augmented statements (SWE-bench Pro's requirements plus interface) remove interface guessing. Without augmentation, scores fell from over 25% to under 9%, so augmentation changes difficulty.
  - LLM-written statements (SWE-smith, R2E-Gym) scale and are post-cutoff by construction. Their risk is statements that paraphrase the tests.
  - For a tool comparison the statement source is held constant across arms, so its main effect is on absolute difficulty and on how much localization the statement gives away. Statements that name files or functions shrink the room for a navigation tool to help.
  - Recommendation: stratify by, or at least tag, whether the statement names the gold file or symbol.

### Gaps
- The exact SWE-rebench yield per stage (PRs scanned → installable → F2P-valid → quality-filtered) and the precision of its LLM quality classifier were not retrieved (arXiv and HF were blocked).
- SWE-bench-Live's per-stage yields (issues crawled → environments built → validated) and RepoLaunch's standalone success rate before the reuse strategy were not retrieved. Only the ≥98% figure with reuse was read.
- SWE-smith per-strategy yields (the fraction of candidate bugs that break at least one test) and its issue-text quality ablation were not retrieved.
- UTBoost (arXiv 2506.09289) and SWE-ABS (arXiv 2603.00520) surfaced as studies of weak or insufficient tests on SWE-bench, but their numbers were not retrieved.
- It was not verified whether SWE-bench Pro's commercial and held-out results are refreshed after its 05/18 leaderboard issue.

---

## 2. Benchmarks that stress cross-file dependencies, multi-site edits and change impact, and how they are graded

### Takeaway
Multi-site benchmarks use four kinds of grader:
- **Hidden tests (F2P/P2P):** FEA-Bench, SWE-Dev, SWE-bench Pro.
- **Build, compile and test invariants:** MigrationBench.
- **AST-level structural checks:** RefactorBench.
- **Oracle-diff matching:** CodePlan's matched, missed and spurious edit blocks.

Newer retrieval-oriented benchmarks add set-valued gold for *impact*, such as Agent Retrieval Bench's `edit2ripple` (files affected by an anchored change). Multi-file tasks are consistently much harder:
- RefactorBench: 22% of tasks solved by an agent vs 87% by a human.
- SWE-Dev (hard split): 22–23%.
- FEA-Bench: about 10% resolved.

The only vendor study of a code-intelligence tool on multi-repo work (CodeScaleBench) found gains concentrated in cross-repository and retrieval-heavy tasks, with losses on debugging.

### Cited Findings
- **RefactorBench (ICLR 2025; Microsoft):**
  - 100 large, handcrafted, multi-file refactoring tasks, each editing 2–31 files (4 on average in the reference solutions).
  - Each task has 3 natural-language instructions of varying specificity. Tasks are mutually exclusive, so they can be chained into longer tasks.
  - Grading uses "unique abstract syntax tree (AST) based unit testing" that checks the sub-changes a refactor requires "without dependence on exact line match".
  - Results: a baseline agent solved at most 35% (easiest instruction set) and 22% with base instructions, versus 87% for a human developer under short time limits.
  
  [X] — [RefactorBench (ICLR 2025 proceedings)](https://proceedings.iclr.cc/paper_files/paper/2025/hash/6b44ee74539ea77d6a0d50d468724371-Abstract-Conference.html); [arXiv 2503.07832](https://arxiv.org/abs/2503.07832)
- **RefactorBench repository:** it ships exact copies of the 9 source repositories (Django, Salt, Flask, FastAPI, Celery, Ansible, Requests, Scrapy, Tornado) and recommends SWE-agent-style Docker images in which one repository copy persists across task instances. [R] — [RefactorBench README](https://github.com/microsoft/RefactorBench/blob/HEAD/README.md)
- **CodePlan (FSE 2024; Microsoft):**
  - The replication package contains, for each of 5 repository edits (`ext1`, `ext2`, `t1`, `t2`, `t3`), the source repo, the ground-truth target repo and each method's output.
  - Grading is oracle-diff based: DiffBLEU, Levenshtein distance, and matched, missed and spurious edit blocks against the target.
  
  [R] — [CodePlan replication README](https://github.com/microsoft/codeplan/blob/HEAD/README.md); [arXiv 2309.12499](https://arxiv.org/abs/2309.12499)
- **CodePlan block counts** [C], read from the package's `data/*/pred/*/metrics.json`:

| Repo edit | CodePlan: matched / missed / spurious | Repair baseline: matched / missed / spurious |
|---|---|---|
| ext1 | 64 / 0 / 0 | 34 / 30 / 27 |
| ext2 | 38 / 8 / 0 | 19 / 27 / 5 |
| t1 | 8 / 2 / 0 | 5 / 5 / 0 |
| t2 | 4 / 0 / 0 | 1 / 3 / 0 |
| t3 | 11 / 0 / 0 | 1 / 10 / 0 |

  — [CodePlan data](https://github.com/microsoft/codeplan/tree/HEAD/data)
- **FEA-Bench (ACL 2025):**
  - 1,401 task instances from 83 repositories, built from PRs with rule-based and intent-based filtering for new-feature development.
  - A task is kept only if its unit tests fail before the change and pass after the gold patch.
  - The best model, DeepSeek-R1, resolves about 10%.
  
  [X] — [FEA-Bench (arXiv 2503.06680)](https://arxiv.org/html/2503.06680v2)
- **FEA-Bench release:** only "essential attributes" are released for licensing reasons; users rebuild the full data by scraping GitHub. Lite, Standard and Oracle variants exist, and the Lite-Standard set uses the SWE-bench format for agents. [R] — [FEA-Bench README](https://github.com/microsoft/FEA-Bench/blob/HEAD/README.md)
- **SWE-Dev (feature-driven development):**
  - 14,000 training and 500 test tasks, each with a runnable environment and developer-written unit tests.
  - Claude-3.7-Sonnet reaches 22.45% Pass@3 on the hard split. Single-turn Pass@1 is 49.47% (easy) and 22.51% (hard).
  
  [X] — [SWE-Dev (arXiv 2505.16975)](https://arxiv.org/html/2505.16975v3)
- **MigrationBench (Amazon; Java 8 → 17):** grading approximates functional equivalence. A migration passes only if:
  1. the repository builds and all tests pass;
  2. compiled class major versions match the target (52 for Java 8, 61 for Java 17);
  3. test methods are invariant;
  4. the number of test cases does not decrease;
  5. for "maximal" (but not "minimal") migration, dependencies are at their latest major versions.
  
  Datasets: full 5,102 repos, selected 300, and a disjoint unit-test-generation set of 4,814; all MIT or Apache-2.0. [R] — [MigrationBench README](https://github.com/amazon-science/MigrationBench/blob/HEAD/README.md); [arXiv 2505.09569](https://arxiv.org/abs/2505.09569)
- **SWE-bench Pro** tasks average 4.1 files and 107.4 lines, so the set is multi-file by construction. [X] — [SWE-Bench Pro PDF](https://arxiv.org/pdf/2509.16941)
- **Agent Retrieval Bench (arXiv 2607.24882, July 2026):**
  - 427 file-level retrieval samples across 25 repositories: 345 positive, 50 natural no-gold cases, and 32 counterfactual wrong-repository controls.
  - Four positive tasks: `code2test`, `comment2context`, `trace2code`, and `edit2ripple`, which asks for the additional files affected by an anchored change.
  - Relevance is defined "by what an agent needs next" at a frozen base commit.
  
  [X] — [Agent Retrieval Bench](https://arxiv.org/abs/2607.24882)
- **CodeScaleBench (Sourcegraph; vendor):**
  - The 370-task analysis set (`csb-v1-mixed371`) has 151 SDLC and 220 "org" tasks over 40+ repositories in 9 languages.
  - 136 multi-repo tasks span 28 repo sets.
  - Verifiers: test execution for SDLC tasks, oracle evaluation for org tasks.
  - Each task verifier must pass a "calibration triad": an empty answer scores ≤0.1, the canonical oracle scores ≥0.9, and an adversarial keyword dump scores ≤0.5.
  
  [R] — [CodeScaleBench README](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/README.md)
- **CodeScaleBench V1 results** (251 pairs, Claude Haiku 4.5): the effect is strongly task-dependent.

| Slice | MCP effect | 95% CI | Note |
|---|---|---|---|
| Overall | +0.049 | [+0.010, +0.088] | Significant |
| SDLC (full local code) | −0.015 | [−0.059, +0.029] | Not significant |
| Org cross-repo | +0.183 | CI excludes 0 | — |
| Debug | −0.183 | CI excludes 0 | "MCP adds overhead without compensating retrieval benefit" |

  [R] — [CodeScaleBench Technical Report V1](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/docs/technical_reports/archive/TECHNICAL_REPORT_V1.md)
- **Using `find_references` for a security task:** in a comparison with Cursor, one vulnerability-remediation task gained +0.35 from Sourcegraph even on Cursor (0.29 → 0.64). The report attributes this to tracing a function's callers across files with `find_references`, which "neither Cursor's grep nor its semantic search can efficiently" do. [R, single task] — [CodeScaleBench MCP comparison report](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/docs/technical_reports/MCP_COMPARISON_REPORT.md)
- **Multi-file subset by selection:** Zilliz's claude-context evaluation picked 30 SWE-bench Verified instances with exactly 2 file modifications and 15–60-minute difficulty. [R] — [claude-context evaluation README](https://github.com/zilliztech/claude-context/blob/HEAD/evaluation/README.md)

### Inferences
- **Grader choice for a code-intelligence benchmark:**
  - **Hidden tests (F2P/P2P)** are the default: automatic, and robust to alternative correct solutions.
  - **Oracle-diff block matching** (CodePlan) penalizes valid alternative edits, so use it only as a secondary, diagnostic "edit-site recall".
  - **AST or static checks** (RefactorBench, MigrationBench invariants) are the right complement for rename, signature-change and API-migration tasks, where tests may not cover every call site:
    - no remaining references to the old symbol;
    - every call site updated;
    - the build or type check passes;
    - the test count does not decrease.
- **Task families to add**, where a graph or code-intelligence tool should help most:
  - **(a) Real multi-file issues:** mined PRs whose gold patch touches ≥2 files or ≥2 modules, stratified by gold file count and repository size.
  - **(b) Synthetic, post-cutoff "ripple" tasks:** change a signature, rename, or deprecate an API with N ≥ 5 call sites. Generate them automatically from a compiler- or SCIP-grade reference oracle and grade them with build, tests and a residual-reference check.
  - **(c) Impact questions with set answers:** for example, "which tests or files must change if X changes?" (edit2ripple-like), graded by set precision, recall and F1 against a static-analysis oracle, plus empirical co-change from git history.
  - **(d) A control stratum of single-file tasks,** to detect harm, since CodeScaleBench found debugging tasks got worse with MCP.
- **Stratify by task type.** Tool effects can have opposite signs across strata, as in CodeScaleBench (+0.183 org vs −0.183 debug). Pre-register task type as a stratification factor and report per-stratum effects with CIs. Do not rely only on a pooled mean.

### Gaps
- CodePlan's paper-level results for build and type-check validity, and which repositories are C# or Python and internal or external, were not re-verified. Only the block metrics in the replication package were read.
- No published list was found of which SWE-bench Verified or Pro instances are multi-file, with file-count distributions. The Verified dataset on Hugging Face was blocked. Compute it directly from the gold patches.
- API-migration and rename benchmarks beyond MigrationBench were not retrieved, e.g. TimeMachine-bench (arXiv 2601.22597), RepoMod-Bench (2602.22518), CodeTaste (2603.04177) and SmellBench (2606.05574).
- Agent Retrieval Bench's exact metrics and baseline numbers were not retrieved.

---

## 3. Code-understanding QA with verifiable answers, and context-retrieval metrics inside agent trajectories

### Takeaway
The QA benchmarks differ in how verifiable their answers are:
- **Strictly verifiable:** RepoQA (the retrieved function must match the needle by syntactic similarity, threshold 0.8) and CodeQueries (answer and supporting-fact spans).
- **LLM-judge graded:** SWE-QA, whose free-text answers are scored on 5 dimensions.

Trajectory-level context metrics are now standardized:
- **ContextBench:** human-annotated gold at file, symbol, span and edit-location level. It reports coverage, precision, F1, AUC-coverage and redundancy, computed by parsing `cat`, `view` and `grep` actions from trajectories.
- **SWE-Explore:** line-level "core" gold that *every* successful trajectory read, plus "optional" gold, with budgeted ranking metrics.

Two cautions:
- Retrieval quality correlated weakly with outcome in the one vendor study that measured it (Spearman ρ = 0.078, n = 26).
- ContextBench shows large gaps between explored and used context.

### Cited Findings
- **SWE-QA (ACL 2026 Findings):**
  - 720 questions over 15 Python repositories (v1: 12 projects; v2 adds conan, streamlink, reflex), for example 48 questions in `flask.jsonl`.
  - Answers are free text that cites files and line ranges.
  - Scoring uses an LLM-as-judge script (GPT-5 in the current script) on five dimensions, each 1–20: Correctness, Completeness, Relevance, Clarity, Reasoning. The judge is instructed to be strict and compare point by point with the reference.
  
  [R] — [SWE-QA README](https://github.com/peng-weihan/SWE-QA-Bench/blob/HEAD/README.md); [llm-as-a-judge.py](https://github.com/peng-weihan/SWE-QA-Bench/blob/HEAD/Benchmark%20construction/score/llm-as-a-judge.py); [arXiv 2509.14635](https://arxiv.org/abs/2509.14635)
- **RepoQA "Search Needle Function":**
  - 500 tests (5 languages × 10 repos × 10 needles).
  - The model receives a large dependency-ordered code context plus a description of the needle that avoids keywords such as its name.
  - A test passes if the returned function is syntactically closest to the ground truth among all tree-sitter-parsed functions and its similarity exceeds a threshold (default 0.8).
  
  [R] — [RepoQA README](https://github.com/evalplus/repoqa/blob/HEAD/README.md)
- **CodeQueries (ISEC 2024):** semantic queries over code, derived from CodeQL analyses. Given a query and a file, a "Span Predictor" must return answer spans and supporting-fact spans, going beyond yes/no or local-context QA. [R] — [CodeQueries README](https://github.com/thepurpleowl/codequeries-benchmark/blob/HEAD/README.md)
- **Long Code Arena (JetBrains):** six tasks — library-based code generation, CI builds repair, project-level code completion, commit message generation, bug localization and module summarization. [R] — [lca-baselines README](https://github.com/JetBrains-Research/lca-baselines/blob/HEAD/README.md)
- **LCA bug localization (earlier round):** built from 7,479 PRs, with 50 hand-labelled datapoints per language (Python, Java, Kotlin). — [Long Code Arena (arXiv 2406.11612)](https://arxiv.org/pdf/2406.11612)
- **ContextBench (arXiv 2602.05892):**
  - 1,136 issue-resolution tasks from 66 repositories in 8 languages, with human-annotated gold contexts. A "verified" subset has 500 instances.
  - The pipeline "extracts file views and spans from agent trajectories": it parses `.traj.json` and similar formats, identifies file-access commands (`cat`, `view`, `grep`) with line ranges, and tracks context per step.
  - It maps spans to tree-sitter symbols and compares them with gold at file, symbol, span and edit-location granularity.
  
  [R] — [ContextBench README](https://github.com/EuniAI/ContextBench/blob/HEAD/README.md); [ContextBench pipeline docs](https://github.com/EuniAI/ContextBench/blob/HEAD/docs/source/pipeline.rst)
- **ContextBench metric definitions:**
  - Coverage (recall) = |Gold ∩ Pred| / |Gold|.
  - Precision = |Gold ∩ Pred| / |Pred|.
  - F1 is their harmonic mean.
  - AUC-Coverage = the mean over steps of per-step coverage ("how quickly relevant context is found").
  - Redundancy = the re-examined share of viewed context.
  - Only definition nodes (classes, functions, methods) count as symbols.
  
  [R] — [ContextBench metrics.rst](https://github.com/EuniAI/ContextBench/blob/HEAD/docs/source/metrics.rst)
- **ContextBench leaderboard (Verified split, 500 instances):**

| Agent | File coverage | File precision | Symbol coverage | Symbol precision | AUC-Cov | Redundancy |
|---|---|---|---|---|---|---|
| Prometheus | 0.799 | 0.346 | 0.716 | 0.255 | 0.598 | 0.422 |
| Agentless | 0.656 | 0.398 | 0.357 | 0.393 | 0.056 | 0.000 |
| SWE-agent | 0.576 | 0.496 | 0.436 | 0.233 | 0.563 | 0.094 |

  With mini-SWE-agent across backbones:

| Backbone | Pass@1 | Context F1 | Efficiency |
|---|---|---|---|
| Claude Sonnet 4.5 | 53.0% | 0.344 | 0.658 |
| GPT-5 | 47.2% | 0.312 | 0.591 |
| Devstral 2 | 40.2% | 0.332 | 0.616 |
| Gemini 2.5 Pro | 36.4% | 0.311 | 0.529 |

  Submissions are ranked by Pass@1, then Context F1, AUC-Coverage efficiency and average cost per instance. [R] — [ContextBench leaderboard.rst](https://github.com/EuniAI/ContextBench/blob/HEAD/docs/source/leaderboard.rst)
- **ContextBench findings:**
  - "Sophisticated agent scaffolding yields only marginal gains in context retrieval"; backbone choice matters more.
  - LLMs favour recall over precision.
  - Explored context differs substantially from utilized context.
  
  [R] — [ContextBench leaderboard.rst](https://github.com/EuniAI/ContextBench/blob/HEAD/docs/source/leaderboard.rst); [README](https://github.com/EuniAI/ContextBench/blob/HEAD/README.md)
- **SWE-Explore (arXiv 2606.07297):**
  - 848 issues, 203 repositories, 10 languages. The gold is "distilled from successful repair trajectories": it extracts read actions, converts them to line regions, and aggregates **core** context (files and regions read by *every* successful trajectory) plus model-specific **optional** context.
  - Metrics: line-level precision, recall and F1; hit/noise file rate; hit/noise region rate; weighted core coverage; `context_efficiency` (core coverage divided by emitted context length); recall@K and nDCG@K over line budgets; `first_useful_hit`.
  - The registered explorers include Claude Code, Cursor and mini-SWE-agent.
  
  [R] — [SWE-Explore README (Qiushao-E)](https://github.com/Qiushao-E/SWE-Explore-Bench/blob/HEAD/README.md); [SWE-Explore README (mirror org)](https://github.com/Last-Humans-Coding-Under-White-Nights/SWE-Explore-Bench/blob/HEAD/README.md)
- **CodeScaleBench retrieval metrics in agent runs** (curated analysis set, baseline → MCP):

| Metric | Baseline | MCP |
|---|---|---|
| Precision@10 | 0.095 | 0.313 |
| Recall@10 | 0.120 | 0.272 |
| F1@10 | 0.091 | 0.240 |

  - The report also tracks "time to first relevant file" (TTFR) and tokens and cost before the first relevant file.
  - V1 found negligible correlation between retrieval MRR and reward: Spearman ρ = 0.078, p = 0.737, n = 26.
  
  [R] — [CodeScaleBench Technical Report](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/docs/technical_reports/TECHNICAL_REPORT.md); [Technical Report V1](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/docs/technical_reports/archive/TECHNICAL_REPORT_V1.md)

### Inferences
- **Context metrics to log in every run,** so that a tool's effect can be decomposed into "found more" versus "found faster":
  - For each tool call: the files, spans and line ranges returned to the model, whatever tool produced them (grep via Bash, Read, or the MCP tool).
  - Per-step coverage against two golds: the gold patch's edit locations, and ContextBench-style broader context where available.
  - AUC-coverage, TTFR in tokens and in dollars, redundancy, and precision.
  
  ContextBench's extractor already parses mini-SWE-agent, SWE-agent, OpenHands and Agentless trajectories. For Claude Code, extend it to the `stream-json` tool events.
- **Verifiable QA for a code-intelligence benchmark:** prefer questions whose answers are sets that an oracle can compute, over free text graded by an LLM judge. Examples:
  - callers of X;
  - implementations of interface Y;
  - tests exercising Z;
  - files affected by changing W.
  
  Suitable oracles are SCIP or LSP indexers at the pinned commit, CodeQL (the CodeQueries approach) and git co-change. Grade with set precision, recall and F1, and keep LLM-judged explanatory QA (SWE-QA style) as a secondary, low-weight track.
- **Retrieval metrics are mediators, not the endpoint.** The weak correlations (ρ = 0.078 in CodeScaleBench V1; the explored-vs-used gap in ContextBench) mean a tool can improve retrieval metrics without improving resolution. Keep end-to-end resolution as the primary outcome and treat retrieval metrics as mechanism.

### Gaps
- **CodeRepoQA:** no information could be retrieved this session (search budget exhausted).
- **CodeQueries:** dataset size and metric definitions (in `Codequeries_Statistics.pdf`) were not extracted.
- **SWE-QA:** the paper's human-agreement validation of the LLM judge was not retrieved.
- **SWE-Explore:** headline numbers were not retrieved, e.g. Claude Code vs BM25 line F1, and the correlation between exploration metrics and downstream repair.
- **ContextBench docs inconsistency:** the leaderboard doc lists a "Pro" variant with "2,294 instances, source SWE-bench Pro", which conflicts with SWE-bench Pro's 1,865 tasks. It is probably a doc error; not resolved.

---

## 4. Metrics beyond resolve rate: cost per resolved task, token split (uncached input, cached input, output), turns, wall time, tool-call counts and appropriate use, and prompt-caching accounting

### Takeaway
Measure cost and effort per *attempted* task and per *resolved* task, split into uncached input, cache writes, cache reads and output. Agentic runs are dominated by cached re-reads of the conversation:
- In CodeScaleBench's Haiku 4.5 snapshot, cache reads are about 99% of all tokens [C].
- Cache reads are billed at about 10% of the uncached input rate.
- Turning caching on cut SWE-rebench's Claude Sonnet 4 cost per problem from $5.29 to $0.91.

Raw "total tokens" is therefore misleading, and cost comparisons must fix the caching policy (including TTL) across arms. Token use is very noisy and stochastic:
- up to 30× between runs of the same task;
- "expensive failures" and a "token snowball" dominate spend;
- accuracy peaks at intermediate budgets.

Report medians, p90 and per-task paired ratios, not only means.

### Cited Findings
- **SWE-Effi (arXiv 2509.09853):**
  - Defines effectiveness as the balance between outcome (resolve rate) and resources (tokens, time).
  - Identifies the "token snowball" effect and "expensive failures", where agents burn resources while stuck on unsolvable tasks.
  - Finds a trade-off between effectiveness under a token budget and under a time budget.
  - Values are averaged over all instances, resolved and unresolved, on a curated SWE-bench Verified subset.
  
  [X] — [SWE-Effi](https://arxiv.org/abs/2509.09853); [HTML](https://arxiv.org/html/2509.09853)
- **Bai et al. 2026, token consumption on SWE-bench Verified** (eight frontier LLMs):
  - Agentic tasks consume about 1000× the tokens of code reasoning or chat.
  - Input tokens, not output, dominate cost "even when token caching is enabled".
  - Runs on the same task can differ by up to 30× in total tokens.
  - Higher token use does not buy accuracy: accuracy often peaks at intermediate cost.
  - Kimi-K2 and Claude-Sonnet-4.5 consume on average over 1.5M more tokens than GPT-5 on the same tasks.
  - Models predict their own token use poorly (correlation up to 0.39).
  - An extract also states that "even on the same problem, the most expensive run costs roughly 2× the cheapest across all models".
  
  [X] — [How Do AI Agents Spend Your Money? (arXiv 2604.22750)](https://arxiv.org/abs/2604.22750); [project page](https://longjubai.github.io/agent_token_consumption/)
- **SWE-rebench cost reporting:**
  - The leaderboard added Cost per Problem and Tokens per Problem.
  - Claude Sonnet 4's average cost per problem fell from $5.29 to $0.91 in September (2025) after caching was implemented.
  - Grok Code Fast 1 and gpt-oss-120b reach about 29–30% resolved at $0.03–$0.04 per problem.
  
  [X] — [SWE-rebench insight, Sep 2025](https://swe-rebench.com/?insight=sep_2025)
- **Claude Code headless accounting:**
  - `--output-format json` returns `total_cost_usd` plus a per-model breakdown.
  - Both figures are "client-side estimates" computed from a bundled price table and "can differ from your actual bill".
  - With `--continue` or `--resume`, the run reports the conversation's whole total, including earlier runs.
  
  [R] — [Claude Code: Run programmatically](https://code.claude.com/docs/en/headless); [Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- **Agent SDK usage-field semantics:**
  - `usage` counts only the top-level agent loop and excludes subagents; use `modelUsage` for whole-tree accounting.
  - Assistant messages from one turn share an ID, so deduplicate by ID.
  - Per-step `output_tokens` is a placeholder; read output tokens from the result message.
  - A crash emits `error_during_execution`, whose `usage`, `total_cost_usd` and `modelUsage` may be zeroed. Recover totals from earlier messages.
  
  [R] — [Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- **Cache fields and pricing:**
  - `cache_creation_input_tokens` is billed at the cache-write rate.
  - `cache_read_input_tokens` is billed at "roughly 10% of the standard input rate".
  - Default cache TTL is 5 minutes with an API key or cloud provider, and 1 hour for the main conversation on a subscription.
  - `ENABLE_PROMPT_CACHING_1H=1` requests 1-hour TTLs, whose writes are billed at a higher rate.
  - Subagents start their own cache.
  
  [R] — [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching); [Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- **Example cost line** from Claude Code's `/usage`: "claude-sonnet-4-6: 1.2k input, 5.3k output, 940.0k cache read, 50.0k cache write ($0.55)". [R] — [Claude Code costs](https://code.claude.com/docs/en/costs)
- **MCP tool definitions and context:**
  - By default Claude Code defers MCP tool schemas and loads them on demand through tool search.
  - `ENABLE_TOOL_SEARCH=auto` loads them upfront only while they fit within 10% of the context window.
  - A custom `ANTHROPIC_BASE_URL` disables tool search by default.
  
  So the context overhead of a code-intelligence tool depends on configuration. [R] — [Claude Code env vars](https://code.claude.com/docs/en/env-vars); [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- **CodeScaleBench cost accounting:**
  - It tracks cache reads ($1/Mtok) separately from output tokens ($5/Mtok), using model-aware pricing that includes cache reads and writes.
  - It measures TTFR and "Cost_before_first_relevant".
  - Its canonical Haiku paired estimate is −30.16% cost per task with MCP ($0.7333 → $0.5121, n = 392 valid pairs), −36.22 s wall clock and −101.06 s agent execution.
  
  [R] — [CodeScaleBench Technical Report](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/docs/technical_reports/TECHNICAL_REPORT.md)
- **Conflicting CodeScaleBench cost estimates:**
  - The earlier V1 report found MCP about 3.8% *more* expensive (+$0.013/task, 251 pairs), with the sign depending on the suite.
  - Re-analysing the published per-task cost file of snapshot `csb-v1-mixed371--haiku45--030326` (349 tasks with both arms) gives [C]:
    - MCP/baseline ratio of mean costs 1.085;
    - geometric-mean ratio 1.078 (95% paired bootstrap CI 1.026–1.133);
    - the snapshot's own aggregate shows mean cost $0.2994 (baseline) vs $0.3307 (MCP).
  - So the sign of the cost effect depends on which runs, pairing rules and exclusion filters are used. The canonical estimate pairs runs from `runs/official/_raw` and requires `output_tokens > 0` and `agent_execution_seconds ≥ 10`.
  
  [R/C] — [V1 report](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/docs/technical_reports/archive/TECHNICAL_REPORT_V1.md); [snapshot costs.json](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/runs/snapshots/csb-v1-mixed371--haiku45--030326/export/summary/costs.json); [aggregate.json](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/runs/snapshots/csb-v1-mixed371--haiku45--030326/export/summary/aggregate.json)
- **Token composition in the same snapshot** [C]:

| Arm | Uncached input | Output | Cache reads | Cache reads / uncached input |
|---|---|---|---|---|
| Baseline | 0.08% | 0.79% | 99.13% | ≈1,181× |
| MCP | 0.01% | 0.73% | 99.26% | — |

  Per-task baseline cost: median $0.244, p90 $0.547, maximum $1.75, between-task CV 0.76, SD of log cost 0.68. The export lists no cache-*write* field. — [snapshot costs.json](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/runs/snapshots/csb-v1-mixed371--haiku45--030326/export/summary/costs.json)
- **Tool-use and "appropriate-use" statistics (CodeScaleBench V1):**
  - The MCP-call ratio varies by suite: fix 0.350, document 0.839, mcp_unique 0.918.
  - The "near-total absence of Deep Search calls … confirms that agents default to keyword search and rarely invoke the more expensive semantic analysis tools without explicit preamble guidance".
  - MCP ratio vs reward: Spearman ρ = +0.293.
  - Output tokens vs reward: ρ = −0.187.
  
  [R] — [Technical Report V1](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/docs/technical_reports/archive/TECHNICAL_REPORT_V1.md)
- **Other process metrics in the literature:**
  - SWE-Gym: "Stuck in Loop (%)" (the same action repeated for the last three turns) and "Avg. Turn(s)". Its successful trajectories average 39.9 LM messages (about 19 turns) and 18,578 tokens. [R] — [SWE-Gym paper PDF](https://github.com/SWE-Gym/SWE-Gym/blob/HEAD/assets/paper.pdf)
  - SWE-Factory: interaction turns, empty-patch rate and tool-call failure rate. [R] — [SWE-Factory preprint](https://github.com/DeepSoftwareAnalytics/swe-factory/blob/HEAD/preprint.pdf)
  - TraceProbe, applied to 2,500 SWE-bench Verified trajectories from five production settings:
    - it normalizes runs into a nine-type action taxonomy and detects anti-patterns such as search loops and skipped verification;
    - file choice is too coarse to separate success from failure, whereas function selection and completion behaviour localize it;
    - among resolved runs, "avoidable effort" still differs.
    
    [X] — [What Resolve Rate Hides (arXiv 2607.06184)](https://arxiv.org/abs/2607.06184)
- **Reliability metrics:**
  - HAL's harness adds reliability evaluation along four dimensions — consistency, robustness, predictability and safety — and uses Weave for cost tracking. [R] — [HAL reliability_evaluation_changes.md](https://github.com/princeton-pli/hal-harness/blob/HEAD/reliability_eval/reliability_evaluation_changes.md); [HAL README](https://github.com/princeton-pli/hal-harness/blob/HEAD/README.md)
  - MCPMark reports pass@1 alongside pass^4: gpt-5-medium scores 52.56% pass@1 and 33.86% pass^4 (earlier round). — [MCPMark (arXiv 2509.24002)](https://arxiv.org/abs/2509.24002)

### Inferences
- **Metric set for the new benchmark,** all per run and aggregated per task and arm:
  1. **Outcome:** resolved (F2P and P2P pass), plus a partial-credit variant (fraction of F2P tests passing) as a secondary outcome.
  2. **Cost:** list-price cost from the raw usage fields, not the harness estimate. Record `uncached_in`, `cache_write_5m`, `cache_write_1h`, `cache_read` and `output` separately, including subagents (`modelUsage`).
  3. **Cache-neutral cost:** all input billed at the uncached rate. This separates "the tool reduced context" from "the tool changed cache hit rates"; for example, MCP results inserted mid-prefix, or schema loading, can invalidate the cache.
  4. **Effort:** turns, tool calls by kind (Bash-search, Read, Edit, MCP tool X), wall-clock and agent-execution time, and timeouts.
  5. **Process:** TTFR in tokens and dollars; AUC-coverage of the gold edit locations; redundancy; loops; empty patches.
  6. **Tool uptake / appropriate use:**
     - the share of navigation actions routed through the tool when available;
     - the share of tool calls whose results are later "used", i.e. a span from the result is read or edited again;
     - in tool-only arms, the leakage rate of Bash search commands.
- **Aggregation:**
  - Cost per resolved task = Σcost / Σresolved (a ratio of sums), with a task-level cluster-bootstrap CI.
  - Also report mean and median cost per attempted task, and cost on tasks both arms solved. Conditioning on success removes the "expensive failures" confound.
- **Caching controls:**
  - Run all arms with the same TTL setting (the 5-minute API-key default or a forced 1-hour TTL) and a fixed cache-warming policy. Either run tasks cold, or run arms interleaved so neither systematically benefits from a warm cache.
  - The SWE-rebench $5.29 → $0.91 drop shows that caching policy alone can move cost 5–6×, far more than any plausible tool effect.
- **MCP schema overhead:** report the tool-definition token overhead per arm, and fix `ENABLE_TOOL_SEARCH` across arms. A deferred-schema tool and an upfront-schema tool pay different overheads that are part of the "treatment".

### Gaps
- **Cache pricing multipliers:** the exact cache-write multipliers (e.g. relative to base input for 5-minute vs 1-hour TTL) were not read from a primary Anthropic pricing page. Only "roughly 10%" for reads and "higher rate" for writes were verified in the docs.
- **SWE-Effi:** the exact metric formulas (AUC-style effectiveness under token, cost and time budgets) and the size of its curated subset were not retrieved.
- **SWE-rebench:** it was not verified whether its cost column is computed with or without cache discounts. A search extract mentions per-run limits of "2M uncached read/write tokens … and 20M cached token reads", but the source was unclear, so it is not used.
- **Bai et al.:** the per-model cached versus uncached split was not retrieved.

---

## 5. Variance and statistics: run-to-run variance, runs per task, paired designs, power for 5–15-point and 20–30% cost differences with 30–150 tasks, and multiple comparisons

### Takeaway
Agent outcomes combine strong task heterogeneity with substantial within-task randomness:
- Published pass@k curves fit a Beta model with intra-task correlation (ICC) ≈ 0.63–0.65 [C].
- pass@1 of 20.6% rises to 42.8% at pass@16 (SWE-Gym).
- Within-task reward SD is 0.09–0.17 for Haiku 4.5 and 0.02–0.05 for Opus 4.6 (CodeScaleBench).
- Single-trial comparisons overstate differences, for example +0.10–0.15 versus +0.01–0.06 with ≥3 trials.

With a paired design (all arms on the same tasks), analysed on per-task mean differences, the power analysis [C] gives:
- **10-point resolve-rate difference:** about 55–60 tasks × 3 runs per arm at α = 0.05, or 75–80 tasks × 3 runs with a Holm correction over 3 contrasts.
- **5-point difference:** about 200 tasks × 3 runs, which is out of reach with 30–150 tasks unless k ≥ 5 and n = 150.
- **15-point difference:** about 30 tasks × 3 runs.
- **20–30% cost reduction:** only 15–40 tasks × 3 runs.
- **Concentrated effects:** if the tool only helps a subset of tasks, roughly double the task counts.

Use per-task paired analyses (paired t or permutation on per-task means, or cluster/hierarchical bootstrap), with a mixed-effects logistic model as confirmation. Exact McNemar applies to single runs only and is conservative.

### Cited Findings
- **SWE-rebench** runs each model 5 times and reports the mean with its SEM and pass@5. A "high pass@5 but lower mean resolution" (e.g. Llama-4-Maverick) signals inconsistency. [X] — [SWE-rebench PDF](https://arxiv.org/pdf/2505.20411); [BenchLM summary](https://benchlm.ai/benchmarks/swe-rebench)
- **Claude Sonnet 4.5** had the highest pass@5 on SWE-rebench at the time, 55.1%. [X] — [SWE-rebench leaderboard](https://swe-rebench.com/?insight=sep_2025)
- **SWE-Gym (OpenHands, fine-tuned 32B, SWE-bench Verified):**

| k | 1 | 2 | 3 | 4 | 5 | 8 | 16 |
|---|---|---|---|---|---|---|---|
| Pass@k | 20.6% | 24.8% | 28.8% | 31.6% | 33.6% | 37.8% | 42.8% |
| Best@k with verifier | 20.6% | — | — | — | — | — | 32.0% |

  Means and variances for Pass@N and Best@N come from 100 random subsamples of the M rollouts (following Lightman et al.). [R] — [SWE-Gym paper PDF](https://github.com/SWE-Gym/SWE-Gym/blob/HEAD/assets/paper.pdf)
- **R2E-Gym:** 1 trajectory at T = 0 plus 25 at T = 0.8 and T = 0.9 give pass@26 = 64.4%, against a pass@1 of 34.4% for the same 32B model. The paper's tables report resolve rates as mean (± spread), e.g. 34.4 (±1.2). [R] — [R2E-Gym paper PDF](https://github.com/R2E-Gym/R2E-Gym/blob/HEAD/assets/paper.pdf)
- **CodeScaleBench MCP comparison** (Claude Code; 20 tasks; 3+ trials per cell; 650+ runs):

| Model | Augment | GitHub MCP | Sourcegraph |
|---|---|---|---|
| Haiku 4.5, within-task stdev | 0.132 | 0.086 | 0.167 |
| Opus 4.6, within-task stdev | 0.039 | 0.019 | 0.048 |

  - "Opus reduces variance by 3–4x".
  - "Single-trial comparisons overstate differences. Best-of-1 showed Sourcegraph leading by +0.10–0.15 … with variance, the gap shrinks to +0.01–0.06".
  - The report recommends "a minimum of 3 trials per cell for MCP comparison studies".
  
  [R] — [CodeScaleBench MCP comparison report](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/docs/technical_reports/MCP_COMPARISON_REPORT.md)
- **CodeScaleBench statistics toolkit and main result:**
  - Percentile bootstrap CIs (10,000 resamples, seed 42) on the vector of per-task deltas of per-config mean reward (3+ runs per config averaged first), plus Welch's t, Cohen's d and McNemar for binary outcomes.
  - It suggests a "two-level hierarchical bootstrap" to separate task-level from run-level variance.
  - Overall paired delta +0.0349 over n = 370 (95% CI [+0.0130, +0.0579]); SDLC +0.0363 over n = 150 (CI [−0.0083, +0.0835]); Org +0.0339 over n = 220 (CI [+0.0133, +0.0571]).
  - Reward-delta variance 0.048985.
  
  [R] — [CodeScaleBench Technical Report](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/docs/technical_reports/TECHNICAL_REPORT.md)
- **Re-analysis of the Haiku snapshot rewards** [C]: the per-task reward delta has SD 0.190 (n = 349, one value per task and arm), and 34% of tasks have exactly zero delta. — [snapshot rewards.json](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/runs/snapshots/csb-v1-mixed371--haiku45--030326/export/summary/rewards.json)
- **Three-arm tool ablation (arXiv 2607.10569, July 2026):**
  - Arms: baseline, bash_only and code_only (a single `execute_code` MCP tool), on synthetic computation tasks and "SWE-bench Mini" modification tasks.
  - Model, harness and prompts were held fixed, and two agents were tested (Claude Code, Codex CLI).
  - Pass rates were "statistically tied within each cell".
  - code_only was cheaper than or tied with the cheapest tool-rich rival in 3 of 4 cells: significant for Artifact/Claude (−24.6%) and SWE-bench/Codex (−19.9%).
  
  [X] — [When Does Restricting a Coding Agent to execute_code Help?](https://arxiv.org/html/2607.10569)
- **Miller, "Adding Error Bars to Evals" (Anthropic, arXiv 2411.00640)** — five recommendations:
  1. CLT-based standard errors.
  2. Clustered standard errors when questions come in related groups.
  3. Reduce variance by resampling several answers per question and averaging.
  4. Paired, question-level difference analysis when comparing two models (a "free" SE reduction).
  5. Power analysis to size the evaluation.
  
  [X] — [arXiv 2411.00640](https://arxiv.org/abs/2411.00640); [Anthropic research post](https://www.anthropic.com/research/statistical-approach-to-model-evals)
- **"Signal and Noise" (AI2, NeurIPS 2025):**
  - Defines benchmark signal (ability to separate better from worse models) and noise (sensitivity to random variability); a higher signal-to-noise ratio gives more reliable decisions.
  - Interventions: better metrics, filtering noisy subtasks, and averaging checkpoints.
  - Based on 30 benchmarks, 375 models and 900K results.
  
  [X] — [arXiv 2508.13144](https://arxiv.org/abs/2508.13144)
- **IR significance-testing literature:**
  - Smucker, Allan & Carterette (CIKM 2007) found little practical difference among randomization, bootstrap and t-test. Wilcoxon and sign tests performed poorly (earlier round). — [ACM DL](https://dl.acm.org/doi/10.1145/1321440.1321528)
  - Urbano, Lima & Hanjalic (SIGIR 2019) studied type I, II and III errors of IR significance tests by stochastic simulation over more than 500 million p-values from simulated TREC runs. [X] — [arXiv 1905.11096](https://arxiv.org/abs/1905.11096); [code](https://github.com/julian-urbano/sigir2019-statistical)
- **Leaderboard definitions of repeated attempts (SWE-bench):**
  - Pass@k is "resolved in 1+ of k attempts" and is not allowed on the main board.
  - Best@k requires a distinct selector that does not use the tests.
  - "Best@1 / single attempt … across multiple runs, this is the # of instances solved in *every single run*".
  
  [R] — [SWE-bench checklist](https://github.com/SWE-bench/experiments/blob/HEAD/checklist.md)
- **Vendor example of a low-powered design:** the claude-context evaluation ran 30 instances × 3 runs per method with GPT-4o-mini and reported only averages:

| Metric | Grep-only baseline | With claude-context |
|---|---|---|
| F1 | 0.40 | 0.40 |
| Tokens | 73,373 | 44,449 (−39.4%) |
| Tool calls | 8.3 | 5.3 (−36.3%) |

  It reports no CIs and does not measure resolution. [R] — [claude-context evaluation README](https://github.com/zilliztech/claude-context/blob/HEAD/evaluation/README.md)

### Inferences
All inferences in this section are computations made here [C], with stated assumptions.

- **Calibrating task heterogeneity.** Model each task's success probability p as Beta(μκ, (1−μ)κ). Then pass@k = 1 − B(a, b+k)/B(a, b).
  - Fitting SWE-Gym's μ = 0.206 and pass@16 = 0.428 gives κ = 0.587 (ICC = 1/(κ+1) = 0.63). It reproduces the observed curve within ≤1.8 points (predicted pass@2/4/8 = 26.6/32.4/37.8 vs observed 24.8/31.6/37.8).
  - Fitting R2E-Gym's pass@1 = 0.344 and pass@26 = 0.644 gives κ = 0.544 (ICC = 0.65).
  - So per-task success is strongly bimodal: most tasks are almost always or almost never solved, and a minority are "coin flips".
- **Power for resolve rate, paired design, effect as a constant logit shift.** Setup: κ = 0.565, baseline μ = 0.5, per-task mean over k runs per arm, paired t-test on per-task differences, two-sided, 80% power. Required number of tasks:

| Δ | k = 1 | k = 2 | k = 3 | k = 5 |
|---|---|---|---|---|
| 5 pts, α = 0.05 | 573 | 291 | 197 | 122 |
| 5 pts, α = 0.0167 | 764 | 389 | 263 | 163 |
| 10 pts, α = 0.05 | 148 | 79 | 56 | 38 |
| 10 pts, α = 0.0167 | 198 | 105 | 75 | 50 |
| 15 pts, α = 0.05 | 69 | 40 | 30 | 22 |
| 15 pts, α = 0.0167 | 93 | 53 | 40 | 29 |

  Here α = 0.0167 is Bonferroni/Holm-first-step for 3 contrasts. Achieved power with k = 3 at n = 30/50/75/100/150 tasks:

| Δ | n = 30 | n = 50 | n = 75 | n = 100 | n = 150 |
|---|---|---|---|---|---|
| 5 pts | 0.17 | 0.28 | 0.40 | 0.51 | 0.68 |
| 10 pts | 0.52 | 0.76 | 0.91 | 0.97 | 1.00 |
| 15 pts | 0.81 | 0.96 | 1.00 | 1.00 | 1.00 |

  - Other baselines and heterogeneity barely change this: μ = 0.3 gives similar numbers (10 pts, k = 3: 53 tasks). Adding treatment-effect heterogeneity τ = 0.5 or 1.0 on the logit scale raises the requirement modestly (10 pts, k = 3: 59 and 66 tasks).
  - Under this model the *total runs per arm* matter most. For a 10-point effect the requirement is 148–190 runs per arm whatever k is.
  - Choosing k = 3 therefore mainly trades task-building cost against runs.
- **Power when the effect is concentrated.** Suppose a fraction q of tasks is "tool-sensitive" and the tool raises their success by 90% of the remaining headroom, all others unchanged (μ = 0.5, α = 0.05). Required number of tasks:

| Δ | q | k = 1 | k = 3 | k = 5 |
|---|---|---|---|---|
| 5 pts | 0.11 | 662 | 294 | 221 |
| 10 pts | 0.22 | 186 | 97 | 79 |
| 15 pts | 0.33 | 91 | 52 | 45 |

  With between-task variance of the effect this large, more *tasks* help more than more runs. This is the realistic case for a navigation tool that only matters for multi-file or large-repo tasks. Stratified sampling that over-represents such tasks raises power, at the cost of generalizability.
- **Simulation check** (1,500 replications, μ = 0.5, logit shift 1.13 ≈ 10 points):

| Design | Paired t, simulated | Exact McNemar | Analytic |
|---|---|---|---|
| n = 50, k = 1 | 0.31 | 0.22 | 0.36 |
| n = 100, k = 1 | 0.66 | 0.57 | 0.63 |
| n = 50, k = 3 | 0.80 | — | 0.76 |
| n = 30, k = 5 | 0.75 | — | 0.70 |

  The normal approximation is adequate, and exact McNemar (single run) is conservative.
- **Discordance.** With single runs, the discordant-pair fraction is about 0.18–0.22 for a 5–15-point effect at μ = 0.5 under this heterogeneity. Connor's formula gives McNemar sample sizes of 576 (5 points), 152 (10 points) and 73 (15 points), consistent with the earlier round's table.
- **Power for cost, paired log-cost design.** Take D_i = the mean over k runs of log(cost) in arm B minus that in arm A, so Var(D_i) = 2σ_w²/k + τ_c². Here σ_w is the within-task run-to-run SD of log cost and τ_c the task-by-arm interaction.
  - **Empirical calibration:** CodeScaleBench's single-run paired log-cost differences have SD 0.472 (n = 349). That implies σ_w ≈ 0.33 if τ_c = 0, consistent with Bai et al.'s "most expensive run ≈ 2× the cheapest" (σ ≈ 0.34–0.41 for 3–4 runs).
  - **At that SD with k = 1:** 80% power needs about 36 tasks for a 20% reduction and about 14 for 30%.
  - **Scenario grid** (tasks needed at α = 0.05, 80% power):

| Scenario | 20% reduction, k = 1 | 20% reduction, k = 3 | 30% reduction, k = 1 | 30% reduction, k = 3 |
|---|---|---|---|---|
| σ_w = 0.35, τ_c = 0 | 41 | 15 | 17 | 7 |
| σ_w = 0.6, τ_c = 0 | 116 | 40 | 47 | 17 |
| σ_w = 0.9, τ_c = 0 | 258 | 87 | 102 | 36 |
| σ_w = 0.35, τ_c = 0.5 (suite-dependent effect) | 80 | 55 | 33 | 23 |

  Cost effects of 20–30% are therefore detectable with 30–80 tasks × 3 runs, whereas 5-point resolve-rate effects are not.
- **Budget arithmetic.** Runs = n_tasks × k × n_arms.
  - 4 arms × 80 tasks × 3 runs = 960 runs. At CodeScaleBench-like Haiku costs ($0.30–0.73 per run) that is about $290–700; at Opus-class costs (several dollars per run on complex tasks) it is a few thousand dollars.
  - This budget gives about 0.8 power for 10 points under Holm over 3 contrasts, at least 0.95 for 15 points, about 0.3 for 5 points, and near-certain detection of 20–30% cost changes.
  - With about 500 runs (4 × 42 × 3), 10-point power drops to about 0.65 at α = 0.05. Either drop an arm or use a two-stage design.
- **Recommended analysis plan.** Pre-register all of it.
  1. **Primary endpoint:** the per-task mean resolve rate. Primary contrasts: "both" vs "built-in only", and "deep integration" vs "both". Use fixed-sequence gatekeeping (test the first at α = 0.05, the second only if the first is significant) or Holm over all pre-declared contrasts.
  2. **Estimation:** the difference in means with a 95% task-cluster bootstrap CI. Use a two-level bootstrap if runs are unbalanced, and resample repositories first if tasks cluster by repo, following Miller's clustered SEs.
  3. **Test:** a paired permutation test (sign-flip of per-task deltas) or a paired t-test.
  4. **Confirmatory model:** a GLMM, `resolved ~ arm + (1|task) + (1|repo)`, with the arm×task random slope if identifiable. Report odds ratios alongside the risk difference.
  5. **Secondary endpoints:** log-cost ratio (paired) and cost per resolved task (ratio of sums with bootstrap), tokens by type, turns and time. Correct them for multiplicity or label them exploratory.
  6. **Per-stratum effects** (task type, multi-file vs single-file, repo size) with CIs. No subgroup claims without an interaction test.
  7. **Report** pass@k and pass^k (consistency) curves per arm, and the share of "flip" tasks.
- **Pilot first.** Run about 20 tasks × 2 runs × all arms to estimate ICC, within-task SD and σ_w for the chosen model. Stronger models are far more deterministic (Opus about 3–4× lower within-task SD), which lowers the needed k. Then re-run the power calculation above.

### Gaps
- No peer-reviewed study was found that reports the run-to-run SD of *frontier* agents on SWE-bench-style resolve rates across many seeds, with per-task data. SWE-rebench's per-run data (the HF `nebius/SWE-rebench-leaderboard`) could calibrate ICC for current models but was not reachable.
- **Attribution unclear, not used:**
  - An extract mentioned a 5-run GLM-5.1 study (SD 0.94 on a 0–100 quality index; 16 of 32 scenario points flaky).
  - Another mentioned a cross-provider pass@1 gap of up to 1.2% for Claude Sonnet 4.5.
- **Miller:** the exact formulas (clustered SE, sample-size formula) were confirmed only at abstract level.
- **Urbano et al. 2019:** the conclusions (which tests keep type I error at α with best power) were not retrieved; only the design was confirmed.
- **GLMM precedent:** no published agent-evaluation paper using a GLMM with task random effects was found (search budget exhausted). The GLMM recommendation is standard practice, not a cited precedent.
- **Surfaced, not read:** OpenAI's "Separating signal from noise in coding evaluations" (openai.com blocked); "Position: Coding Benchmarks Are Misaligned with Agentic Software Engineering" (arXiv 2606.17799); AgentLens (arXiv 2607.06624).

---

## 6. Practical harness design for comparing tool configurations with the same model (mini-SWE-agent, OpenHands, Claude Code headless) and pitfalls (tool-restriction leaks, nondeterminism, timeouts, environment drift)

### Takeaway
A bash-only agent is a strong 2026 baseline:
- mini-SWE-agent scores above 74% on SWE-bench Verified.
- It is comparable to SWE-agent on SWE-bench Pro.
- ContextBench found that sophisticated scaffolds give only marginal context-retrieval gains over it.

Tool comparisons must therefore hold model, prompt, harness and budgets fixed and vary only the tool surface. The largest practical pitfall is *leakage between arms*. In Claude Code on Linux, Grep and Glob are not even in the default tool set: searches run as Bash `grep`/`find` (embedded ugrep and bfs), and Bash deny patterns are documented as fragile. Arms must therefore be enforced by tool removal, hooks or data removal, and audited from trajectories.

Other recurring failure sources:
- infrastructure errors misread as task failures;
- instruction contamination between arms;
- flaky or time-bombed tests;
- MCP servers that silently fail to load;
- cost fields that exclude subagents or are zeroed on crash.

### Cited Findings
- **mini-SWE-agent:**
  - No tools other than bash; it does not use the LM tool-calling interface.
  - Linear history (the trajectory is the message list); every action is an independent `subprocess.run`.
  - It "scores >74% on SWE-bench verified", and results appear on the SWE-bench "bash only" board.
  - Its docs note Gemini 3 Pro reaching 74% with mini (Nov 19).
  - Configs expose `step_limit` and `cost_limit`; the v2 migration example shows `step_limit: 0` and `cost_limit: 3.`; global limits are `MSWEA_GLOBAL_CALL_LIMIT` and `MSWEA_GLOBAL_COST_LIMIT`.
  
  [R] — [mini-swe-agent README](https://github.com/SWE-agent/mini-swe-agent/blob/HEAD/README.md); [docs index](https://github.com/SWE-agent/mini-swe-agent/blob/HEAD/docs/index.md); [v2 migration](https://github.com/SWE-agent/mini-swe-agent/blob/HEAD/docs/advanced/v2_migration.md); [SWE-bench usage](https://github.com/SWE-agent/mini-swe-agent/blob/HEAD/docs/usage/swebench.md)
- **Bash-only board:** the SWE-bench "Bash Only" view is now a filter on the Verified board. Since 2025-11-18, Verified and Multilingual accept only submissions from academic teams with open methods and publications. [R] — [SWE-bench experiments README](https://github.com/SWE-bench/experiments/blob/HEAD/README.md)
- **Interface design, 2024 precedent:** SWE-agent's custom agent-computer interface (ACI) solved 10.7 points more than the same model with only a Linux shell, in an ablation on 300 instances. SWE-agent with GPT-4 Turbo resolved 12.47% of full SWE-bench and 18.00% of Lite. [X] — [SWE-agent (NeurIPS 2024)](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf)
- **OpenHands harness:** `swebench-infer` with `--max-iterations` (100 in basic examples; 500 in the full-scale examples, "higher for complex tasks"), a remote runtime and up to 64 workers. Benchmark code depends on SDK versions; for example, the critic module changed at SDK commit `79868ae5`. [R] — [OpenHands benchmarks SWE-bench README](https://github.com/OpenHands/benchmarks/blob/HEAD/benchmarks/swebench/README.md); [OpenHands benchmarks README](https://github.com/OpenHands/benchmarks/blob/HEAD/README.md)
- **Claude Code headless: tool surface**
  - `--tools` restricts built-in tools, e.g. `"Bash,Edit,Read"`.
  - `--disallowedTools` with a bare name removes the tool from context; `"mcp__*"` removes all MCP tools. A scoped rule such as `Bash(rm *)` only denies matching calls "as written".
  - `--allowedTools` only auto-approves; it does not restrict.
  - `--strict-mcp-config` uses only the MCP servers given in `--mcp-config`.
  
  [R] — [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- **Claude Code headless: run control**
  - `--max-turns` and `--max-budget-usd` are print-mode caps. Subagent spend counts toward the budget cap.
  - `--bare` skips auto-discovery of hooks, skills, plugins, MCP servers, memory and CLAUDE.md. It is "recommended … for scripted and SDK calls". Without it, `-p` loads the working directory's `.claude/settings.json` hooks and `.mcp.json` servers without a trust dialog.
  
  [R] — [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference); [Run programmatically](https://code.claude.com/docs/en/headless)
- **Claude Code default search tools:** on macOS, Linux and WSL, Glob and Grep are *left out of the default tool set*; "Claude searches with `find` and `grep` through the Bash tool instead … embedded versions of `bfs` and `ugrep`, and the searches reach your hooks and permission rules as `Bash` calls". Glob and Grep come back if named in `--tools` or `--allowedTools`, or if Bash is removed. [R] — [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference)
- **Bash permission rules are fragile:**
  - The docs warn that "Bash permission patterns that try to constrain command arguments are fragile".
  - A deny rule "doesn't match the same program by path or inside `sh -c`".
  - `Bash(grep *)` matches `xargs grep pattern` but not `xargs -n1 grep pattern`.
  - Read deny rules "don't apply to a command that reads files without naming them, such as `grep -r pattern .`".
  - PreToolUse hooks or sandboxing are the suggested enforcement.
  
  [R] — [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- **Silent MCP failures:**
  - `-p` runs skip invalid `--mcp-config` entries and still "exit cleanly". Check `mcp_server_errors` in the init message.
  - Pending servers are awaited only up to `MCP_TIMEOUT` (30 s by default).
  - Without tool search, Claude Code does not tell Claude about servers that failed to connect.
  
  [R] — [Run programmatically](https://code.claude.com/docs/en/headless); [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- **CodeScaleBench harness:**
  - Harbor runner with a Claude Code harness in Daytona sandboxes; stdio or HTTP MCP transports; 3+ trials per task, configuration and model.
  - **Information parity:** the MCP arm gets truncated or absent local source, so the tool cannot be bypassed with local grep, and the agent is told the source is remote-only.
  - **Instruction contamination:** 30 of 156 baseline instructions contained Sourcegraph references and had to be cleaned.
  - **Run hygiene:** "ghost" 0-token runs; infrastructure errors (e.g. token-refresh failures) misclassified as task failures; zero scores validated as genuine (trajectory 100 KB–2.3 MB, execution >60 s, no exception, verifier ran); `trap EXIT` so `reward.txt` is written even on timeout.
  - **V1 scheduling:** both configurations ran simultaneously per task.
  
  [R] — [Technical Report](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/docs/technical_reports/TECHNICAL_REPORT.md); [Technical Report V1](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/docs/technical_reports/archive/TECHNICAL_REPORT_V1.md); [MCP comparison report](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/docs/technical_reports/MCP_COMPARISON_REPORT.md)
- **CodeScaleBench configurations:**
  - `baseline-local-direct`: full local code, built-in tools only.
  - `mcp-remote-direct`: Sourcegraph MCP only, remote code.
  - `augment-local-direct`: local code plus Augment's `codebase-retrieval`.
  - `github-remote-direct`.
  
  Keeping three MCP configurations "tripled compute cost without providing discriminative data", so the keyword-only one was dropped. [R] — [CodeScaleBench README](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/README.md); [Technical Report V1](https://github.com/sourcegraph/CodeScaleBench/blob/HEAD/docs/technical_reports/archive/TECHNICAL_REPORT_V1.md)
- **Environment drift and flakiness:**
  - SWE-bench-Live reran tests 3 times at creation, but still reports tests going invalid over time and differing across machines. It advises three gold-patch runs on your own hardware.
  - SWE-bench Pro removed tests that "required the year 2025".
  - SWE-bench Pro images run bash by default: "you should not manually invoke bash".
  
  [R] — [SWE-bench-Live evaluation README](https://github.com/microsoft/SWE-bench-Live/blob/HEAD/evaluation/README.md); [SWE-bench Pro README](https://github.com/scaleapi/SWE-bench_Pro-os/blob/HEAD/README.md)
- **Earlier-round evidence on end-to-end tool effects:** Cursor's online A/B (same model; semantic search vs grep-style tools only) found +0.3% code retention overall and +2.6% on codebases with ≥1,000 files. — [Cursor blog](https://cursor.com/blog/semsearch)

### Inferences
**Implementation-ready protocol for the four-arm comparison**

1. **Arms.** Same model snapshot, system prompt, task prompt, step, time and budget caps, temperature and harness version in all arms.
   - **A. Built-ins only:** `--tools "Bash,Read,Edit,Write,Grep,Glob"`, with the tool's MCP servers absent (`--strict-mcp-config` with an empty config). Name Grep and Glob explicitly, since the Linux default leaves them out; otherwise the "built-ins" arm is actually "bash search".
   - **B. Tool only:** the code-intelligence MCP plus Edit and Bash, but with no Grep, Glob or Read (`--tools "Bash,Edit,Write"`, since Edit needs file content). A PreToolUse hook on Bash then blocks or logs search and read commands: `grep|rg|ugrep|ag|ack|git grep|find|fd|bfs|cat|head|tail|less|sed -n|awk|python -c …open(`. Allow test, build and git-status commands. If the tool cannot return file bodies, arm B is not viable for editing tasks. In that case redefine it as "the tool replaces search, Read allowed" and say so.
   - **C. Both:** A's tools plus the MCP, with a neutral system prompt (no instruction to prefer either).
   - **D. Deeper integration:** C plus the integration being tested. Examples: a short CLAUDE.md or system-prompt preamble on when to use which tool (CodeScaleBench found agents rarely call advanced tools without preamble guidance); hooks that inject impact analysis after edits; a navigation subagent. Freeze D's prompt text before the run and count its tokens.
2. **Isolation.**
   - Run each task in a fresh container from a digest-pinned image, with the tool index built *before* the timer starts; record index-build time and cost separately.
   - Use `--bare` or a clean HOME so no host CLAUDE.md, hooks or MCP servers leak in.
   - Check that `mcp_server_errors` is empty and that the MCP server appears as connected in `system/init`. Otherwise mark the run as an infrastructure failure and rerun it; never score it as a task failure.
   - Disable web access, or allowlist nothing, so the agent cannot fetch upstream fixes.
   - Scrub the MCP server's name and tool mentions from arm-A prompts (the instruction-contamination check).
3. **Scheduling against nondeterminism and drift.**
   - Randomize the order of tasks and arms, and interleave arms in time so that API-side changes and provider load hit all arms equally.
   - Use k = 3 runs per task per arm by default; tune after the pilot.
   - Pin model IDs. Record provider, region and date per run, and the Claude Code version.
4. **Timeouts and failures.**
   - Count wall-clock or turn-cap timeouts as failures (intention-to-treat) and report them separately.
   - Exclude only runs where the agent never executed (infrastructure errors), and rerun them.
   - Detect ghost runs (0 tokens) and crash results with zeroed usage.
5. **Grading.**
   - Official F2P/P2P tests run in a *separate* fresh container on the agent's diff, applying the hidden test patch only at grading time.
   - Validate every task beforehand: gold patch passes 3/3 on your hardware; null patch fails; adversarial or trivial patch fails (a CodeScaleBench-style calibration triad).
6. **Logging schema** (per run):
   - model, arm, task and seed identifiers;
   - start and end time;
   - `num_turns`, `duration_ms`, `duration_api_ms`;
   - per-message usage deduplicated by message ID;
   - `modelUsage` (including subagents), with uncached, cache-write, cache-read and output tokens;
   - tool calls with name, arguments, returned byte and line count, and the files and spans returned;
   - hook-blocked attempts (leakage);
   - the final diff, the grader result, and the list of F2P tests passed.
7. **Leakage audit (manipulation check).** For each arm, report:
   - the fraction of runs whose trajectory used a disallowed search path;
   - the tool-uptake rate in C and D.
   
   Primary analyses are intention-to-treat by configured arm. A per-protocol sensitivity analysis excludes runs with leakage.
8. **Baselines to report alongside.** mini-SWE-agent (bash only) with the same model, as the external reference ContextBench and SWE-bench Pro show to be strong. Optionally, the tool's retrieval-only numbers on the Question 3 metrics.

### Gaps
- The Claude Code hook schema for PreToolUse blocking and logging was not re-read this session; the integration notes (`integracion_en_agentes.md`) cover it.
- No public study was found that measures *how often* agents bypass tool restrictions (e.g. grep via bash when a search MCP is present) in the wild. CodeScaleBench avoided the problem by removing local source rather than measuring it.
- The OpenHands evaluation-harness defaults for runs per instance and temperature, and whether OpenHands logs cache-token splits, were not verified.
- **Surfaced, not read:**
  - "Is Bash All You Need? An Empirical Study of Tool Interfaces for Enterprise Digital Worker Agents" (arXiv 2609.11999).
  - "Don't Blame the Large Language Model: How Scaffolding Evolution Shapes Coding Agent Quality" (arXiv 2607.03691).
  - "Inside the Scaffold: A Source-Code Taxonomy of Coding Agent Architectures" (arXiv 2604.03515).
  - "Does Code Cleanliness Affect Coding Agents? A Controlled Minimal-Pair Study" (arXiv 2605.20049), a possible paired-design precedent.
  - Sourcegraph's blog "Sourcegraph MCP server and a cheaper model beat a Mythos-class model alone" (sourcegraph.com blocked).
