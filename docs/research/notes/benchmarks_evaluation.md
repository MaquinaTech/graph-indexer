# Evaluation benchmarks & methodology for code retrieval, localization and code-navigation tools used by AI coding agents (2023–2026)

> Research notes, 2026-09-22. **Access caveat:** in this session the egress proxy blocked arxiv.org, aclanthology.org, openreview.net, huggingface.co, github.com, swebench.com, cursor.com and most academic hosts, so primary PDFs could not be opened. Every number below comes from search-engine extracts of the cited pages (usually the arXiv/ACL page itself). Where the extract did not clearly attribute a number to a page, this is flagged. Exact-fraction checks (see §1 Inferences) were used to cross-validate several tables. Items not verified are listed under **Gaps**, and any recollections there are labelled as such.

---

## 1. Localization benchmarks: how gold locations are derived, metrics, and SOTA numbers (SWE-bench family, Loc-Bench, SWE-PolyBench, Multi-SWE-bench, SWE-Gym, LiveSWEBench, SWE-bench-java)

### Takeaway
The de-facto localization protocol (LocAgent, ACL 2025, then SweRank, ICLR 2026) turns each issue's gold patch into gold sets at file, module (class) and function level. It scores **Acc@k = success only if *all* gold locations are in the top-k**. On SWE-bench Lite (LocAgent's filtered subset; the 274-instance size is inferred from exact fractions, see Inferences), the reference points are:

| Method | File Acc@5 | Function Acc@10 |
|---|---|---|
| **BM25** | 61.68% | 36.86% |
| **CodeRankEmbed** | 84.67% | 58.76% |
| **LocAgent + Claude-3.5** (graph-guided agent) | 94.16% | 77.37% |
| **SweRankLLM-Large** (trained retrieve-and-rerank, ≈$0.015/issue) | — | 88.7% |

SWE-PolyBench takes a different approach: it scores the agent's *generated patch* with precision and recall at file level and at CST-node level. That is the template for multi-language, patch-based scoring.

### Cited Findings

**Dataset sizes / construction (SWE-bench family and relatives)**
- SWE-bench (ICLR 2024): 2,294 real GitHub issue–PR pairs from 12 Python repositories. — [SWE-bench paper](https://arxiv.org/pdf/2310.06770)
- SWE-bench Lite has 300 test instances. Papers report results out of 300, e.g. Agentless 82/300 and OrcaLoca 196/300 and 250/300. — [OrcaLoca](https://arxiv.org/abs/2502.00350); [emergentmind SWE-bench Lite](https://www.emergentmind.com/topics/swe-bench-lite-287687ae-2efa-4e10-b36b-2ea90e25ec7e)
- Official BM25-retrieval variants of the datasets are published on Hugging Face, e.g. `princeton-nlp/SWE-bench_Lite_bm25_27K` and `princeton-nlp/SWE-bench_bm25_27K`. — [HF Lite bm25 27K](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite_bm25_27K); [HF bm25 27K](https://huggingface.co/datasets/princeton-nlp/SWE-bench_bm25_27K)
- The original SWE-bench retrieval baseline: at a 27K-token limit, BM25 retrieves *all* oracle (gold) files in 39.83% of tasks and at least one oracle file in 51.27%. — [SWE-bench paper](https://arxiv.org/pdf/2310.06770)
- SWE-bench Multimodal: 617 task instances from 17 JavaScript libraries (web UI, diagramming, data visualization, syntax highlighting, interactive mapping). — [SWE-bench Multimodal (arXiv 2410.03859)](https://arxiv.org/abs/2410.03859); [swebench.com/multimodal](https://www.swebench.com/multimodal.html)
- SWE-bench Multilingual: 300 tasks from 42 repositories in 9 languages (C, C++, Go, Java, JavaScript, TypeScript, PHP, Ruby, Rust), derived from real GitHub PRs. — [swebench.com/multilingual](https://www.swebench.com/multilingual.html); [HF dataset](https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual)
- SWE-bench Pro (Scale AI; arXiv 2509.16941, v2 14 Nov 2025) has 1,865 human-verified problems from 41 repos, split into three sets:
  - **Public:** 731 problems from 11 repos, deliberately chosen with strong copyleft (GPL) licences to deter training inclusion.
  - **Commercial:** 276 problems from 18 proprietary startup repos, kept private with results published.
  - **Held-out:** 858 problems from 12 repos, kept private to detect overfitting.
  
  — [SWE-Bench Pro paper](https://arxiv.org/html/2509.16941v1); [Scale research page](https://scale.com/research/swe_bench_pro)
- Multi-SWE-bench (ByteDance Seed, Apr 2025): 1,632 instances in 7 languages (Java, TypeScript, JavaScript, Go, Rust, C, C++), curated from 2,456 candidates by 68 expert annotators. — [Multi-SWE-bench](https://arxiv.org/abs/2504.02605)
- SWE-Gym (ICML 2025): 2,438 real-world Python task instances, each with an executable runtime environment, unit tests and an NL task. It is a *training* environment that uses the tests as reward, not a localization benchmark. — [SWE-Gym](https://arxiv.org/abs/2412.21139); [Apple ML Research](https://machinelearning.apple.com/research/training-software)
- SWE-bench-java-verified: 91 issues across 6 GitHub repositories. — [SWE-bench-java](https://arxiv.org/pdf/2408.14354)
- SWE-bench-Live (Microsoft, arXiv 2505.23419): initial release of 1,319 tasks from issues created since 2024, spanning 93 repositories. Each task has its own Docker image. Curation is fully automated and the set is updated monthly for contamination-free evaluation. — [Microsoft Research](https://www.microsoft.com/en-us/research/publication/swe-bench-goes-live/); [HF paper page](https://huggingface.co/papers/2505.23419)
- SWE-rebench continuously scrapes fresh tasks tagged by issue/PR date. Contamination-free evaluation is restricted to instances that post-date a model's training cutoff. — [SWE-rebench (arXiv 2505.20411)](https://arxiv.org/pdf/2505.20411); summary in [emergentmind](https://www.emergentmind.com/topics/swe-bench-live)
- LiveSWEBench targets end-user assistants (Copilot, Cursor, Aider…) with three task types:
  - **Agentic:** only the GitHub issue is given.
  - **Targeted editing:** the file to modify is given, plus a high-level prompt.
  - **Autocomplete:** a specific file location is given.
  
  Tasks come from issue + merged-PR pairs, and the set is refreshed periodically against contamination. — [LiveSWEBench GitHub](https://github.com/livebench/liveswebench); [TechTarget overview](https://www.techtarget.com/searchSoftwareQuality/tip/How-effective-is-your-AI-agent-benchmarks-to-consider)

**Loc-Bench / LocAgent (ACL 2025)**
- Loc-Bench has 560 instances: Bug Reports 242, Feature Requests 150, Security Issues 29, Performance Issues 139. It was designed as a balanced alternative to bug-dominated SWE-bench. — [LocAgent (arXiv 2503.09089)](https://arxiv.org/html/2503.09089v1)
- Each instance is an NL problem statement plus a repository at a specific commit. Ground truth specifies the files, modules and functions that must be modified. A later paper describes Loc-Bench as drawn from GitHub issues across *five Python repositories*; this repo count is not confirmed against the LocAgent paper. — [MULocBench paper](https://arxiv.org/pdf/2509.25242)
- LocAgent parses the codebase offline into a graph of entities and relations and runs agent-guided search over it. Its tools include `SearchEntity` (hierarchical entity search, exact match plus fuzzy BM25). — [alphaXiv LocAgent](https://www.alphaxiv.org/abs/2503.09089); [ACL Anthology PDF](https://aclanthology.org/2025.acl-long.426.pdf)
- Results on SWE-Bench-Lite:
  - LocAgent (Claude-3.5): file-level Acc@5 **94.16%**, function-level Acc@10 **77.37%**.
  - A fine-tuned Qwen2.5-32B reaches **92.70%** file-level accuracy, cutting cost per issue from **$0.66 to $0.09 (−86%)**.
  
  — [LocAgent](https://arxiv.org/html/2503.09089v1); [ACL Anthology](https://aclanthology.org/2025.acl-long.426.pdf)
- Retrieval baselines in LocAgent's SWE-Bench-Lite table (percent):

| Baseline | File Acc@1 / @3 / @5 | Module Acc@5 / @10 | Function Acc@5 / @10 |
|---|---|---|---|
| **BM25** | 38.69 / 51.82 / 61.68 | 45.26 / 52.92 | 31.75 / 36.86 |
| **CodeRankEmbed** | 52.55 / 77.74 / 84.67 | 71.90 / 78.83 | 51.82 / 58.76 |

  — [LocAgent PDF](https://arxiv.org/pdf/2503.09089)

**SweRank (ICLR 2026) — retrieve + rerank, no agent**
- Acc@k counts a localization as successful only if **all relevant code locations are in the top-k**. — [SweRank](https://arxiv.org/html/2505.07849v2)
- SweLoc training data comes from GitHub issues and PRs of popular public Python repos, with consistency filtering and hard-negative mining.
  - SweRankEmbed is trained contrastively: issue = query, known localized functions = positives, same-repo snippets = hard negatives.
  - SweRankLLM is a listwise reranker over the embedder's top-K.
  
  — [SweRank](https://arxiv.org/html/2505.07849v2); [HF model card SweRankEmbed-Small](https://huggingface.co/Salesforce/SweRankEmbed-Small)
- Headline results:
  - SweRankEmbed-Small (137M parameters) outperforms prior 7B embedding models.
  - SweRankEmbed-Large beats LocAgent (Claude-3.5) on function-level Acc@10.
  - SweRankLLM-Large reaches **88.7% function-level Acc@10** on SWE-Bench-Lite.
  - SweRankLLM (32B) costs about **$0.015/issue**, versus **$0.66/issue** for a Claude-3.5 agent.
  
  — [SweRank](https://arxiv.org/html/2505.07849); [papernotes (ICLR 2026)](https://en.papernotes.org/ICLR2026/code_intelligence/swerank_software_issue_localization_with_code_ranking/)
- SweRankEmbed-Small on LocBench, as extracted (note the different k's at module and function level):

| Level | Acc@5 | Acc@10 | Acc@15 |
|---|---|---|---|
| File | 80.36% | 84.82% | — |
| Module | — | 71.43% | 75.00% |
| Function | — | 58.57% | 63.39% |

  — [SweRank PDF](https://arxiv.org/pdf/2505.07849)
- SweRank+ (Dec 2025) extends the approach to multilingual, multi-turn code ranking. — [SweRank+](https://arxiv.org/html/2512.20482)

**Other localization systems with published numbers**
- OrcaLoca (ICML 2025), SWE-bench Lite:
  - Function Match Rate **65.33% (196/300)**.
  - File Match Rate **83.33% (250/300)**.
  - Resolved **41.00% (123/300)**.
  
  It claimed open-source SOTA at the time, using priority-based action scheduling, action decomposition with relevance scoring and distance-aware context pruning. — [OrcaLoca](https://arxiv.org/html/2502.00350); [ICML poster](https://icml.cc/virtual/2025/poster/45561)
- Agentless localizes hierarchically: files → classes/functions → edit locations. It reported 27.33% resolved (82/300) with GPT-4o and 34.3% line-level localization accuracy on Lite. "Agentless-1.5" appears in follow-up comparison tables with file match 69.7% and function match 49.3%. **Attribution flagged:** the extract did not say which follow-up paper's table (OrcaLoca or CoSIL are likely). — [Agentless](https://arxiv.org/abs/2407.01489); [OrcaLoca PDF](https://arxiv.org/pdf/2502.00350); [CoSIL](https://arxiv.org/pdf/2503.22424)
- CoRet (ACL 2025, short paper) is a dense retriever for code editing that combines code semantics, repository structure (file paths) and call-graph neighbours concatenated with the target chunk.
  - It improves retrieval recall by **≥15 percentage points** over existing models on SWE-bench and on Long Code Arena bug localization.
  - Removing call-graph context lowers LCA recall@20 from **0.47 to 0.41**.
  
  — [CoRet (ACL Anthology)](https://aclanthology.org/2025.acl-short.62/); [papernotes](https://en.papernotes.org/ACL2025/code_intelligence/coret_improved_retriever_for_code_editing/)
- SpIDER (arXiv 2512.16956, Dec 2025) adds graph exploration on top of dense retrieval. The top-C hits serve as centres; a BFS runs along "contains" edges within d hops, keeping only neighbours that are also in the semantic top-N; an LLM then selects the relevant neighbours. It improves dense retrieval by **≥13%** across languages on SpIDER-Bench (Python, Java, JS, TS). Its premise is that buggy code is spatially close to the top dense hits. — [SpIDER](https://arxiv.org/abs/2512.16956)
- MULocBench (arXiv 2509.25242) has 1,100 issues from 46 Python projects. It adds non-code locations (configs, docs, comments, commits). Even at file level, SOTA methods stay **below 40% Acc@5/F1**. — [MULocBench](https://arxiv.org/abs/2509.25242)

**SWE-PolyBench (Amazon, arXiv 2504.08703)**
- 2,110 instances from 21 repositories in Java, JavaScript, TypeScript and Python.
- Metrics: pass rate, plus file-level retrieval precision/recall, plus new CST (concrete syntax tree) node-level retrieval metrics. The node metrics measure whether the agent identified the specific functions/classes that needed modification.

— [SWE-PolyBench](https://arxiv.org/abs/2504.08703); [AWS blog](https://aws.amazon.com/blogs/devops/amazon-introduces-swe-polybench-a-multi-lingual-benchmark-for-ai-coding-agents/)
- Reported file-retrieval results:
  - Agentless-PB (Sonnet 3.5), recall / precision: Java 29.5% / 49.7%, JavaScript 23.4% / 35.2%, TypeScript 17.5% / 27.7%.
  - SWE-agent-PB has the highest Java file recall, 65.1%.
  - Aider-PB is best on JS/TS for both precision and recall; Agentless-PB is best on Python.
  - Node-level results follow the same pattern.
  
  — [SWE-PolyBench (HTML v1)](https://arxiv.org/html/2504.08703v1)

**Contamination evidence specific to localization**
- "The SWE-Bench Illusion" (Microsoft; ICSE 2026 SEIP): SOTA models identify buggy file paths **from the issue text alone, without repo access, with up to 76% accuracy** on SWE-bench Verified. On repositories not in SWE-bench this drops to **up to 53%**, pointing to memorization. — [arXiv 2506.12286](https://arxiv.org/abs/2506.12286); [Microsoft Research](https://www.microsoft.com/en-us/research/publication/the-swe-bench-illusion-when-state-of-the-art-llms-remember-instead-of-reason/); [ICSE 2026 SEIP](https://conf.researchr.org/details/icse-2026/icse-2026-software-engineering-in-practice/29/The-SWE-Bench-Illusion-When-State-of-the-Art-LLMs-Remember-Instead-of-Reason)

### Inferences
- **Denominator check (useful for reproducing baselines):**
  - Every two-decimal LocAgent SWE-Bench-Lite percentage above is an exact fraction of **274**, not 300: 38.69% = 106/274, 61.68% = 169/274, 84.67% = 232/274, 94.16% = 258/274, 77.37% = 212/274, 92.70% = 254/274. None of these works with a denominator of 300 (e.g. 61.68% × 300 = 185.04).
  - SweRank's one-decimal 88.7% is ambiguous: it matches 243/274 and also 266/300. It is assumed to use the same 274 subset because SweRank compares directly against LocAgent's table. Unverified.
  - So these papers evaluate a 274-instance filtered subset of Lite, most likely excluding instances whose gold edits cannot be mapped to pre-existing functions. To compare against these numbers, graph-indexer must use the *same* converted subset (LocAgent's released data), not all 300.
  - The LocBench numbers are exact fractions of 560 (e.g. 80.36% = 450/560).
- **Two families of metrics exist:**
  - (a) *Ranked-list* metrics for retrievers: Acc@k = all gold in top-k (LocAgent/SweRank), Recall@k/MRR (LCA, CoRet).
  - (b) *Patch-derived set* metrics for end-to-end agents: file/node precision and recall from the generated patch (SWE-PolyBench), or "match rate" (OrcaLoca, Agentless).
  
  graph-indexer is a retriever, so (a) is its primary metric; (b) belongs in the agent-in-the-loop tier.
- **Metric mapping:**
  - graph-indexer's current `rank-1` ≈ Acc@1, and `success@5` ≈ "any gold in top-5".
  - For multi-gold issues, "any" ≠ "all": the published baselines use "all", which is stricter.
  - Report both, plus Recall@k for partial credit.
- **Where the signal is:** file-level Acc@5 is close to saturated for strong methods (≈85–94% on Lite-274), so function/module-level Acc@10 is where a code-navigation tool can show improvements over published baselines.
- **Which comparators are fair:** a local MCP search engine should first be compared with *retrieval-only* baselines (BM25, CodeRankEmbed, SweRankEmbed-Small 137M), because agent numbers depend on the backbone LLM. The agent numbers (LocAgent 94.16/77.37, OrcaLoca 83.33/65.33) are upper bounds for "tool + LLM" and belong in the agent tier.
- **Contamination:** the SWE-Bench Illusion result means LLM-in-the-loop localization on SWE-bench Verified/Lite can be inflated by memorized file paths. Retrieval-only (BM25/graph) evaluation is largely immune, except for embedding models trained on GitHub data that may include these repos. For agent-tier claims, post-cutoff sets (Loc-Bench, SWE-bench-Live, SWE-rebench, SWE-bench Pro public) are safer.

### Gaps
- **Not re-verified this session:**
  - SWE-bench Verified size (widely reported as 500 human-validated instances, OpenAI, Aug 2024) and the Lite dev split (recollection: 23).
  - SWE-PolyBench per-language counts (recollection, unverified: Java 165, JS 1,017, TS 729, Python 199), the size of the stratified "PB500" subset, and whether a "Verified" subset exists.
- **SWE-PolyBench node extraction:** the exact algorithm was not read. My understanding, unverified: tree-sitter CST of the modified files; gold nodes = class/function nodes whose spans contain changed lines; the retrieved set = nodes touched by the agent's generated patch; set precision and recall.
- **LocAgent / Loc-Bench details not retrieved:**
  - Loc-Bench collection dates and repositories.
  - The full LocAgent table (Agentless, OpenHands, SWE-agent, MoatlessTools rows; the other embedding baselines E5, Jina-Code, CodeSage).
  - Per-category Loc-Bench results.
  - The released HF dataset names for the LocAgent-converted SWE-bench-Lite and Loc-Bench.
- **SweRank details missing:** the size of SweLoc (repos and instances), and the SweRankEmbed-Large and SweRankLLM numbers on LocBench.
- **Missing baselines:** no published *retrieval-only* (BM25/dense) localization baselines were found for Multi-SWE-bench, SWE-bench Multilingual or SWE-bench Pro.
- **Unattributed claim:** a search extract said "BM25 … Acc@5 remaining below 10%" on some 2025–26 localization benchmark (probably MULocBench or LARGER); attribution unclear, so it is not used.
- SWE-Gym Lite size (recollection: 230) and LiveSWEBench task counts are unverified.
- **Relevant 2026 localization papers surfaced but not read:**
  - LARGER (arXiv 2605.16352)
  - BLAgent (2605.17965)
  - SHERLOC (2606.24820)
  - FastCode (2603.01012)
  - SWE-Adept (2603.01327)
  - "Gotta catch 'em all! File localisation from issues at large" (2507.18319)
  - "Reformulate, Retrieve, Localize" (2512.07022)
  - PatchRecall (2604.10481)

---

## 2. Code search / retrieval benchmarks — which ones test NL→function retrieval inside a single repository?

### Takeaway
Classic code-search benchmarks (CodeSearchNet, CoSQA/CoSQA+, CoIR, CodeRAG-Bench) do corpus-level docstring/snippet matching across many repositories. They do not test navigation inside one pinned repo with in-repo distractors, so they only sanity-check an embedder. The benchmarks that match graph-indexer's use case (an NL request → the right function/region inside one repo state) are:
- **RepoQA-SNF:** 500 needle functions across 50 repos in 5 languages.
- **SWE-QA:** 720 repository questions across 15 repos.
- **Long Code Arena bug localization.**
- **Loc-Bench / SWE-bench-derived localization sets.**
- **Three 2026 benchmarks:**
  - **CORE-Bench:** more than 180K queries, including issue-to-edit localization with dense in-repo distractors.
  - **ContextBench:** 1,136 tasks with human-annotated gold contexts, scored at block and line level.
  - **SWE-Explore:** 848 issues; explorers return ranked code regions under a line budget.

### Cited Findings
- **CoIR (ACL 2025 main):**
  - 10 curated datasets covering 8 retrieval tasks across 7 domains; metric NDCG@10.
  - Top model in the paper: Voyage-Code-002, mean **56.26**. No single model dominates, and E5-base/E5-Mistral win some sub-tasks.
  - Baselines include BM25, Contriever, E5-Base, BGE-Base, GTE-Base, UniXcoder, BGE-M3, E5-Mistral, OpenAI-Ada-002 and Voyage-Code-002.
  
  — [CoIR (arXiv 2407.02883)](https://arxiv.org/html/2407.02883v3); [CoIR GitHub](https://github.com/coir-team/coir)
- **CodeRAG-Bench (NAACL 2025 Findings):**
  - A 25M-document datastore from five sources: programming solutions, tutorials (GeeksforGeeks, W3Schools), Python library docs, StackOverflow and GitHub repos.
  - Canonical documents are manually annotated; metrics are NDCG@10, precision and recall, plus execution pass@k.
  - It uses the Python split of CodeSearchNet to measure retrieval quality directly.
  
  — [CodeRAG-Bench (ACL Anthology)](https://aclanthology.org/2025.findings-naacl.176.pdf); [alphaXiv](https://www.alphaxiv.org/abs/2406.14497)
- **RepoQA "Searching Needle Function" (SNF):**
  - 500 problems from 50 popular repositories in 5 languages (Python, C++, Java, TypeScript, Rust).
  - The LLM gets a large chunk of repository code plus an NL description of one function, and must return that exact function.
  
  — [RepoQA (arXiv 2406.06025)](https://arxiv.org/abs/2406.06025); [evalplus RepoQA page](https://evalplus.github.io/repoqa.html)
- **SWE-QA:**
  - 720 questions spanning 3.4M lines of code across 15 repositories, with answers averaging 266.6 words. v1 covers 12 popular Python projects such as Django and Flask; v2 adds conan, streamlink and reflex.
  - It introduces SWE-QA-Agent, an agentic answering framework.
  - Accepted to ACL 2026 Findings; arXiv Sep 2025.
  
  — [SWE-QA (arXiv 2509.14635)](https://arxiv.org/abs/2509.14635); [HF paper page](https://huggingface.co/papers/2509.14635)
- **Long Code Arena bug localization (JetBrains, Jun 2024):**
  - Task: given an issue and a repository snapshot where the bug reproduces, identify the files to modify.
  - Languages: Python, Java, Kotlin.
  - Built from an initial 7,479 PRs (median 1 changed file; half touch 1 file, half touch 2–10). Manual labelling selected 50 good datapoints per language.
  - Median repository has 331 files (average about 1K); files average about 1.5K tokens; issues are about 150 words (~400 tokens).
  - Follow-ups (e.g. CoRet) use recall@k and MRR on it.
  
  — [Long Code Arena (arXiv 2406.11612)](https://arxiv.org/pdf/2406.11612); [HF dataset](https://huggingface.co/datasets/JetBrains-Research/lca-bug-localization); [CoRet](https://aclanthology.org/2025.acl-short.62.pdf)
- **CORE-Bench (arXiv 2606.11864; v1 10 Jun 2026, latest 24 Aug 2026):**
  - Evaluates code retrieval at three levels: code understanding, issue-to-edit localization, and broader context retrieval.
  - More than 180K queries and 106K broader-context relevance labels.
  - Uses concrete repository states, multiple relevant locations, long code chunks and dense in-repository distractors.
  - Argues that docstring-to-function and snippet benchmarks miss "requirement-driven repository search".
  - Data and evaluation code are on HF and GitHub.
  
  — [CORE-Bench](https://arxiv.org/abs/2606.11864); [HF dataset](https://huggingface.co/datasets/zhangfw123/CORE-Bench); [eval code](https://github.com/zhangfw123/CORE-Bench-Eval)
- **ContextBench (arXiv 2602.05892, Feb 2026):**
  - 1,136 issue-resolution tasks from 66 repositories in 8 languages, each with human-annotated gold contexts.
  - An automated framework tracks agent trajectories and measures context recall, precision and efficiency.
  - Evaluated 4 LLMs (GPT-5, Claude Sonnet 4.5, Gemini 2.5 Pro, Devstral 2) with 5 agents (mini-SWE-agent, SWE-agent, OpenHands, Agentless, Prometheus).
  - Findings:
    - Block-level F1 stays below 0.45 and line-level F1 below 0.35.
    - GPT-5 and Prometheus exceed 0.60 line-level recall but seldom exceed 0.35 precision.
    - Sophisticated scaffolding gives only marginal gains and sometimes underperforms mini-SWE-agent, which uses basic shell commands.
    - There are large gaps between the context agents *explore* and the context they *use*.
    - Claude Sonnet 4.5 balances retrieval frequency and granularity for better line-level F1.
  
  — [ContextBench](https://arxiv.org/abs/2602.05892); [HTML v3](https://arxiv.org/html/2602.05892v3); [Moonlight review](https://www.themoonlight.io/en/review/contextbench-a-benchmark-for-context-retrieval-in-coding-agents); [GitHub](https://github.com/EuniAI/ContextBench); [leaderboard](https://contextbench.github.io/)
- **SWE-Explore (arXiv 2606.07297, Jun 2026):**
  - Given a repo and an issue, the explorer returns a **ranked list of relevant code regions under a fixed line budget**.
  - 848 issues, 10 programming languages, 203 repositories.
  - Line-level gold is distilled from independent agent trajectories that *successfully* solved the issue.
  - Findings: exploration metrics track downstream repair; agents are strong at finding files but recall-limited at line level; missing core evidence hurts more than moderate redundant context.
  
  — [SWE-Explore](https://arxiv.org/abs/2606.07297); [HF paper page](https://huggingface.co/papers/2606.07297)
- **Cursor Context Bench:** Cursor's internal evaluation set for retrieving information in codebases with known correct answers. It is not public. — [Cursor blog](https://cursor.com/blog/semsearch) (summarized by [ZenML LLMOps DB](https://www.zenml.io/llmops-database/enhancing-ai-coding-agent-performance-with-custom-semantic-search))

### Inferences
- **Selection criteria for graph-indexer's use case.** A benchmark should have:
  - (a) a single pinned repo state;
  - (b) queries not written from the target code (issues or questions, not docstrings);
  - (c) in-repo distractors;
  - (d) multi-location gold sets;
  - (e) permissive licences and a small enough size to run offline.

  How the candidates meet them:
  - Loc-Bench, SWE-bench-Lite-274, LCA bug localization, CORE-Bench (issue-to-edit subset) and SWE-Explore meet (a)–(d).
  - RepoQA-SNF meets (a) and (c), but its descriptions are generated *from* the needle function, so it is lexically easy. It maps well to graph-indexer's current single-gold "exact symbol" scoring and can be repurposed: index the repo, use the description as the query, and take the needle as gold for rank-1/MRR.
  - CoIR, CodeSearchNet and CoSQA only test the embedding model, not the tool.
- **What each benchmark family measures:**
  - ContextBench and SWE-Explore score *what enters the agent's context* (line/block recall and precision under a budget), which is the right way to quantify a token-saving claim.
  - Acc@k scores *ranking*.
  - A refactor claiming "better context per token" should report both.
- **CORE-Bench scale:** with 180K+ queries it is too large for CI. A stratified sample (e.g. 100–300 issue-to-edit queries from a few repos) is a practical nightly add-on, with the full benchmark reserved for releases.

### Gaps
- **Not verified; search budget exhausted:**
  - CodeSearchNet. Recollection: about 2M comment–code pairs in 6 languages, plus 99 NL queries with expert relevance annotations, scored with NDCG.
  - CoSQA (recollection: 20,604 web-query–code pairs) and CoSQA+ (multi-code-per-query; size unknown).
  - RepoBench (R/C/P tasks; Python and Java; retrieval scored with acc@k).
  - CrossCodeEval (recollection: about 10K examples in Python, Java, TypeScript, C#).
  - CodeQueries (CodeQL-derived semantic queries over Python).
- RepoQA's scoring rule (recollection: BLEU-similarity threshold against the needle) is unverified.
- CORE-Bench baseline scores (BM25, embedders, rerankers) and its languages/repos were not retrieved.
- Current CoIR SOTA after the paper (e.g. CodeXEmbed, arXiv 2411.12644; Nomic Embed Code; CodeRankEmbed) was not verified.
- Surfaced but not read: "SWE Context Bench" (context *learning*, arXiv 2602.08316), CoQuIR (quality-aware code retrieval, 2506.11066), "Evaluating Semantic and Quality-Aware Retrieval for Source Code Repositories" (2607.09161).

---

## 3. MCP / tool-use benchmarks, code-intelligence MCP evaluations, and how to measure token savings credibly

### Takeaway
The general MCP benchmarks (MCPMark, MCP-Universe, LiveMCPBench, MCP-Bench, MCP-Atlas) measure end-task success across mostly non-code servers; none isolates a code-intelligence server. The strongest public evidence that code-search tools help agents comes from Cursor:
- Semantic search raised offline QA accuracy by 12.5% on average (6.5–23.5% depending on model).
- In the online A/B test it raised code retention by 0.3%, and by 2.6% on repos with at least 1,000 files.

The rest is vendor claims (claude-context: −39.4% tokens, −36.1% tool calls; Anthropic code-execution: −98.7% on one workflow) plus 2026 research showing shell-only agents are hard to beat on context retrieval. Credible token claims need a paired design with outcomes measured, with cost-of-failure and per-task distributions reported.

### Cited Findings
- **MCPMark (ICLR 2026):**
  - 127 tasks co-created by experts and agents, across 5 MCP environments: Filesystem 30, Notion 28, Playwright 25, GitHub 23, PostgreSQL 21 (~50 tools); verification scripts check the outcomes.
  - Best model: gpt-5-medium, **52.56% pass@1 and 33.86% pass^4**. claude-sonnet-4 and o3 fall below 30% pass@1 and 15% pass^4.
  - An average task needs **16.2 turns and 17.4 tool calls**.
  - Higher cost does not buy higher accuracy.
  
  — [MCPMark (arXiv 2509.24002)](https://arxiv.org/abs/2509.24002); [ML Anthology ICLR 2026](https://mlanthology.org/iclr/2026/wu2026iclr-mcpmark/); [leaderboard](https://mcpmark.ai/leaderboard)
- **Sizes of the other MCP benchmarks**, as summarized from comparison tables (the MCP-Atlas paper and the originals):

| Benchmark | Servers | Tools | Tasks | Notes |
|---|---|---|---|---|
| MCP-Universe (Salesforce, Aug 2025) | 11 | 133 | 231 | — |
| LiveMCPBench | 70 | 527 | 95 | — |
| MCP-Bench | 28 | 250 | 104 | 11 functional domains |

  MCP-Atlas (Scale, arXiv 2602.00933) is a large-scale tool-use benchmark on real MCP servers. — [MCP-Universe](https://arxiv.org/pdf/2508.14704); [MCP-Bench](https://arxiv.org/pdf/2508.20453); [MCP-Atlas](https://arxiv.org/html/2602.00933v3)
- **Cursor, "Improving agent with semantic search" (≈Nov 2025, dated from the linked X post):**
  - Offline: on average **12.5% higher accuracy** answering questions, **6.5%–23.5%** depending on model, measured on their internal "Cursor Context Bench".
  - Online A/B: both groups used the same model; one agent had semantic search, the other had only grep-style tools.
    - Code retention was **+0.3%** with semantic search, **+2.6%** on codebases with ≥1,000 files.
    - Without semantic search, dissatisfied follow-up requests rose **+2.2%**.
  - Cursor trained its own embedding model for this.
  
  — [Cursor blog](https://cursor.com/blog/semsearch); [Cursor on X](https://x.com/cursor_ai/status/1986124270548709620); [ZenML summary](https://www.zenml.io/llmops-database/enhancing-ai-coding-agent-performance-with-custom-semantic-search)
- A Cursor engineer described optimizing the embeddings with signals from agent sessions (success/failure, accepts/rejects). — [Cheng Lou on X](https://x.com/_chenglou/status/1986289051226546448)
- **claude-context (Zilliz/Milvus; vendor benchmark):**
  - A code-search MCP using hybrid BM25 + dense vectors.
  - Reported **−39.4% tokens on average and −36.1% tool calls** "while preserving retrieval quality".
  - One code-navigation query dropped from 84,193 to 2,699 tokens (−96.8%).
  
  — [claude-context GitHub](https://github.com/zilliztech/claude-context); [Milvus blog](https://milvus.io/blog/claude-context-reduce-claude-code-token-usage.md); [Milvus: against grep-only retrieval](https://milvus.io/blog/why-im-against-claude-codes-grep-only-retrieval-it-just-burns-too-many-tokens.md)
- **Serena:** an MIT-licensed MCP server backed by language servers (40+ languages), with tools such as `find_symbol`, `find_referencing_symbols` and `insert_after_symbol`. Its token efficiency is claimed only qualitatively (it avoids whole-file reads and grep). **No quantitative benchmark was found.** — [mcp.directory guide](https://mcp.directory/blog/serena-mcp-complete-guide-2026); [Serena issue #802](https://github.com/oraios/serena/issues/802)
- **Anthropic, "code execution with MCP":** exposing MCP servers as code APIs, so that only the needed tool definitions are loaded, took one example workflow from about **150,000 to about 2,000 tokens (−98.7%)**. This is a single illustrative workflow, not a benchmark. — [kiadev summary](https://kiadev.net/news/2025-11-08-anthropic-mcp-code-execution); [brightbean summary](https://brightbean.xyz/blog/code-execution-mcp-efficient-ai-agents/); related: [Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- **ContextBench:** a simple shell-command agent (mini-SWE-agent) is often not beaten by sophisticated scaffolds on context retrieval, and LLMs favour recall over precision. — [ContextBench](https://arxiv.org/abs/2602.05892)
- **SWE-Effi:**
  - Defines *effectiveness* as the balance between outcome accuracy (resolve rate) and resources consumed (tokens and time).
  - Identifies a **"token snowball"** effect and **"expensive failures"**: agents burn resources when stuck on unsolvable tasks.
  - Shows a trade-off between effectiveness under a token budget and under a time budget.
  
  — [SWE-Effi (arXiv 2509.09853)](https://arxiv.org/abs/2509.09853)
- **SWE-Explore:** missing core evidence hurts downstream repair more than moderate redundant context. — [SWE-Explore](https://arxiv.org/abs/2606.07297)

### Inferences
- **Token savings are not a success metric on their own.** Missing evidence costs more than redundancy (SWE-Explore), and failures dominate token spend (SWE-Effi). A credible claim therefore reports:
  - (i) task outcome (resolve rate, or localization Acc@k/F1);
  - (ii) tokens per *solved* task and per attempted task;
  - (iii) medians and p90, not only means;
  - (iv) tool calls and wall time.
- **Protocol for an MCP A/B:**
  - Same model snapshot, temperature and system prompt; the only change is the MCP tool set.
  - Identical task list, at least 3 seeds per arm, randomized order.
  - Tokens split into uncached input, cached input and output, with the MCP tool-schema overhead counted.
  - A pre-registered primary metric.
  - Paired bootstrap CIs on per-task differences (see §4).
  - A shell-only baseline (mini-SWE-agent style, with grep/ripgrep) is mandatory, because ContextBench shows it is strong.
- **Tool schemas count against the budget.** graph-indexer's MCP tool definitions consume tokens on every turn (the lesson of Anthropic's code-execution post). Measure them as a fixed overhead and consider lazy or deferred tool loading.
- **Vendor claims are hypotheses, not baselines.** The claude-context and Cursor numbers have no published per-task data or significance tests. Cursor's online A/B is the only large-sample outcome evidence, and the effect it found is small (+0.3% retention overall).

### Gaps
- Metric definitions (execution-based vs LLM-judge) and best-model scores for MCP-Universe, LiveMCPBench, MCP-Bench and MCP-Atlas were not verified.
- No peer-reviewed or independently replicated evaluation of any code-intelligence MCP server (Serena, claude-context, Sourcegraph/Amp, Augment Context Engine, etc.) was found.
- A community report, "Final Comprehensive MCP vs Native Claude Code Performance Analysis" (Code-Index-MCP), exists but was not read. — [glama.ai](https://glama.ai/mcp/servers/@ViperJuice/Code-Index-MCP/blob/e3183d0106c586aec03535faabe632b4db4d6046/FINAL_COMPREHENSIVE_MCP_ANALYSIS.md)
- cursor.com was blocked, so Cursor Context Bench's composition and the post's exact date were not verified.

---

## 4. Methodology: ground truth from git history, leakage/contamination, held-out splits, significance testing for small query sets, and metrics for graph tools

### Takeaway
Four ways of building ground truth are established:
- **Issue/PR → changed code:** SWE-bench, SweLoc, LCA, Loc-Bench, MULocBench.
- **Human-annotated context:** ContextBench.
- **Regions consulted by successful agent trajectories:** SWE-Explore.
- **Tests:** SWE-bench, SWE-Gym.

Contamination is handled with post-cutoff or rolling sets (SWE-bench-Live, SWE-rebench, Loc-Bench), licence and held-out design (SWE-bench Pro), and memorization probes (SWE-Bench Illusion). For statistics:
- Treat queries as a sample, use paired comparisons, and use randomization, bootstrap or t-tests. Avoid Wilcoxon and sign tests (Smucker et al.; Miller 2024).
- Graph tools are scored by edge precision and recall against an oracle; PyCG's micro-benchmark is the classic template.
- graph-indexer's current semantic n = 2–7 per language is far too small to show improvements.

### Cited Findings

**Ground truth from history / patches**
- SWE-bench pairs real GitHub issues with the PRs that resolved them (2,294 pairs) and verifies with tests. — [SWE-bench](https://arxiv.org/pdf/2310.06770)
- SweLoc mines GitHub issues and PRs from popular public Python repos. Positives are the functions the PR modified; hard negatives are mined from the same repository; consistency filtering is applied. — [SweRank](https://arxiv.org/html/2505.07849v2)
- Long Code Arena starts from 7,479 PRs and manually keeps 50 good datapoints per language. — [Long Code Arena](https://arxiv.org/pdf/2406.11612)
- SWE-Explore derives *line-level* gold from independent agent trajectories that solved the issue, distilling the regions those solutions actually consulted, instead of taking only the lines the patch changed. — [SWE-Explore](https://arxiv.org/abs/2606.07297)
- ContextBench uses human-annotated gold contexts. — [ContextBench](https://arxiv.org/abs/2602.05892)
- MULocBench shows patch-only gold misses non-code locations (configs, docs, comments). — [MULocBench](https://arxiv.org/abs/2509.25242)

**Contamination / leakage controls**
- File paths are memorized: up to 76% file-path accuracy from issue text alone on SWE-bench Verified, versus up to 53% on repos outside SWE-bench. — [SWE-Bench Illusion](https://arxiv.org/abs/2506.12286)
- Time-based controls:
  - SWE-bench-Live uses issues created since 2024 with monthly refreshes. — [SWE-bench-Live](https://huggingface.co/papers/2505.23419)
  - SWE-rebench restricts evaluation to tasks that post-date a model's training cutoff. — [SWE-rebench](https://arxiv.org/pdf/2505.20411)
- Licence and held-out design: SWE-bench Pro's public set uses copyleft (GPL) repos, and an 858-task held-out set is kept private to detect overfitting. — [SWE-Bench Pro](https://arxiv.org/html/2509.16941v1)

**Statistics for small evaluation sets**
- Miller, "Adding Error Bars to Evals" (arXiv 2411.00640, 1 Nov 2024), treats eval questions as drawn from an unseen super-population. It gives formulas for analysing eval data, measuring the difference between two models, and planning an evaluation experiment (sample size/power), with recommendations for reporting results that minimize statistical noise. — [arXiv 2411.00640](https://arxiv.org/abs/2411.00640)
- `evalci` (arXiv 2607.04429) is an MIT-licensed, pip-installable Python library for statistically rigorous comparison of LM evaluations. — [evalci](https://arxiv.org/pdf/2607.04429)
- Smucker, Allan & Carterette (CIKM 2007) compared the paired t-test, Wilcoxon signed-rank, sign test, bootstrap and Fisher randomization on TREC runs.
  - They found **little practical difference between randomization, bootstrap and t-test**.
  - Wilcoxon and sign tests **detect significance poorly and can produce false detections**.
  - A 2009 SIGIR follow-up examined agreement at varying sample sizes.
  
  — [Smucker et al. 2007 (ACM)](https://dl.acm.org/doi/10.1145/1321440.1321528); [Semantic Scholar](https://www.semanticscholar.org/paper/A-comparison-of-statistical-significance-tests-for-Smucker-Allan/3bf42fdbe24fe5aaa491266006d89bae53e99552)
- Related IR work, titles only: "Statistical Significance Testing in IR: Type I, II and III errors" (arXiv 1905.11096) and "Stop Using the Wilcoxon Test: Myth, Misconception and Misuse in IR Research" (arXiv 2604.25349, 2026). — [1905.11096](https://arxiv.org/pdf/1905.11096); [2604.25349](https://arxiv.org/pdf/2604.25349)

**Metrics for call-graph / reference tools**
- PyCG (ICSE 2021) is a static Python call-graph generator.
  - Precision **~99.2%**, recall **~69.9%**.
  - Evaluated on a **micro-benchmark of 112 minimal programs** covering Python features, each with a ground-truth call graph, plus a macro-benchmark of real-world packages.
  - Speed: **0.38 s per 1K LoC** on average.
  
  This is the standard template: edge-level precision and recall against a ground-truth call graph. — [PyCG (arXiv 2103.00587)](https://arxiv.org/abs/2103.00587); [ICSE 2021](https://2021.icse-conferences.org/details/icse-2021-papers/39/PyCG-Practical-Call-Graph-Generation-in-Python)
- An empirical study evaluates LLMs on type and call-graph analysis for Python and JavaScript (title only; reuses call-graph micro-benchmarks). — [arXiv 2410.00603](https://arxiv.org/pdf/2410.00603)
- TDAD (arXiv 2603.17973) uses graph-based impact analysis to reduce code regressions in AI coding agents (title only; relevant to graph-indexer's impact tools). — [TDAD](https://arxiv.org/pdf/2603.17973)

**graph-indexer's current evaluation (local repository docs)**
- Semantic metrics use per-language query sets of **n = 2–7**, where "a single query shifts rank-1 by 14–50 points". Scoring is strict exact-symbol match, with a held-out split of about 20–25% per language. — [docs/benchmarks/BENCH_SUMMARY.md](/home/user/graph-indexer/docs/benchmarks/BENCH_SUMMARY.md)
- **9 of the 18 fixtures are commit-pinned; the other 9 are "unpinnable post-hoc"** (their `.git` was stripped). — [docs/benchmarks/FIXTURES.md](/home/user/graph-indexer/docs/benchmarks/FIXTURES.md)

### Inferences
- **Confidence intervals** (Wilson 95%, computed here) show how uninformative the current per-language numbers are:

| Observed | Rate | 95% CI |
|---|---|---|
| 3/7 | 42.9% | 15.8–75.0% |
| 1/2 | 50% | 9.5–90.5% |
| 11/14 | 78.6% | 52.4–92.4% |
| 169/274 (LocAgent's BM25 file Acc@5) | 61.7% | 55.8–67.2% |

  Even Lite-274 only resolves differences of roughly ±6 points for a single system.
- **Paired designs are much cheaper.** McNemar sample sizes at 80% power, α = 0.05 (Connor approximation, computed here):

| Target difference | Discordant fraction | Paired queries needed |
|---|---|---|
| 10 points | 20% | ≈155 |
| 10 points | 30% | ≈234 |
| 5 points | 10% | ≈312 |
| 5 points | 15% | ≈469 |

  An *unpaired* 50%→60% comparison needs about 388 queries *per arm*. Implication: run every configuration on the same queries and analyse per-query paired outcomes.
- **Recommended statistics:**
  - Binary metrics (Acc@k, rank-1): exact McNemar test or paired randomization.
  - Graded metrics (MRR, NDCG, Recall@k): Fisher paired randomization or paired bootstrap on per-query differences.
  - Report the 95% CI of the *difference*, not just two point estimates.
  - Cluster by repository (resample repos, then queries), because queries from one repo are correlated. This follows the clustered-error logic of the super-population framing.
  - Apply a Holm correction when many configurations are compared.
  - Avoid Wilcoxon and sign tests, per Smucker et al.
- **Leakage filters for mined queries:**
  - (1) Tag queries whose text contains the gold identifier (or its sub-tokens) as *lexical*, and report *semantic* (identifier-free) results separately. graph-indexer's kw/nl split already moves in this direction.
  - (2) Strip code blocks, stack traces and file paths from issue text in a "hard" variant.
  - (3) Time split: test queries only from commits after the pinned index commit and after the embedder's training cutoff.
  - (4) Leave-repo-out for anything learned. `bench/train-ranker.mjs` exists, so learned ranking weights must not see test repos.
- **Held-out discipline:**
  - Freeze the query suite and its hash before the refactor starts.
  - Keep a sealed held-out split, including time-held-out commits and at least one never-seen repo.
  - Tune only on the dev split.
- **Graph tools** (`get_call_graph`, references, impact): score per-edge precision and recall against an oracle.
  - **Primary oracles:** compiler-grade indexers (SCIP indexers or LSP `references`/`callHierarchy`, run offline at the pinned commit).
  - **Python call-graph micro-oracle:** PyCG's 112-program suite.
  - **Recall-only oracles:**
    - Dynamic call edges from running the fixture's own test suite.
    - Git co-change: for commits that change function f, how many of the other changed functions and tests fall inside graph-indexer's impact set for f. This gives recall, and the impact set's size gives a precision proxy.
  - Report results by edge type (direct, method dispatch, dynamic or unresolved) and by language, because the canonical structural gaps already differ by language.

### Gaps
- No published benchmark was found that scores an MCP server's callers/references/impact output against SCIP or LSP oracles. It must be built in-house, and no numbers are available.
- The detailed recommendations inside Miller 2024 (e.g. clustered SEs, resampling answers) were confirmed only at the level of the abstract. Specific formulas were not re-read.
- No study was found on the minimum query-set size for code-search MCP evaluations specifically. The numbers above are standard power calculations, not empirical results.
- Jarvis (Python call graphs) and Java/JS call-graph soundness studies (e.g. Judge/ISSTA 2019) were not verified this session.

---

## 5. Concretely: a minimal offline harness (CI-sized) and the published baselines to compare against

### Takeaway
A convincing yet small harness has four offline, deterministic, no-LLM parts:
- **(A) SWE-bench-Lite-274 plus Loc-Bench-560,** converted to (issue text, repo@base_commit, gold file/module/function sets) and scored with LocAgent/SweRank Acc@k, so BM25, CodeRankEmbed, SweRankEmbed and LocAgent numbers are directly comparable. Subsample these for CI.
- **(B) A self-mined "PR → changed functions" suite** from graph-indexer's re-pinned fixture repos, giving hundreds of paired queries per language group instead of 2–7.
- **(C) A graph-oracle suite** (SCIP/LSP/PyCG edges).
- **(D) A context-efficiency score:** tokens returned until the first/all gold, and line recall under a token budget in ContextBench/SWE-Explore style.

A small, nightly, LLM-in-the-loop paired A/B (shell-only vs +graph-indexer) on post-cutoff tasks then connects retrieval gains to task success, tokens and tool calls.

### Cited Findings
Published baselines worth pinning in the report:

| Benchmark / metric | Method | Number | Source |
|---|---|---|---|
| SWE-Bench-Lite (LocAgent subset) File Acc@1/3/5 | BM25 | 38.69 / 51.82 / 61.68 | [LocAgent](https://arxiv.org/pdf/2503.09089) |
| same, Module Acc@5/10; Function Acc@5/10 | BM25 | 45.26 / 52.92; 31.75 / 36.86 | [LocAgent](https://arxiv.org/pdf/2503.09089) |
| same, File Acc@1/3/5 | CodeRankEmbed | 52.55 / 77.74 / 84.67 | [LocAgent](https://arxiv.org/pdf/2503.09089) |
| same, Module Acc@5/10; Function Acc@5/10 | CodeRankEmbed | 71.90 / 78.83; 51.82 / 58.76 | [LocAgent](https://arxiv.org/pdf/2503.09089) |
| same, File Acc@5; Function Acc@10 | LocAgent (Claude-3.5) | 94.16; 77.37 | [LocAgent](https://arxiv.org/html/2503.09089v1) |
| same, File-level | LocAgent (Qwen2.5-32B fine-tuned) | 92.70 ($0.09/issue vs $0.66) | [LocAgent](https://arxiv.org/html/2503.09089v1) |
| same, Function Acc@10 | SweRankLLM-Large | 88.7 (≈$0.015/issue) | [SweRank](https://arxiv.org/html/2505.07849) |
| LocBench-560 File Acc@5/10; Module Acc@10/15; Function Acc@10/15 | SweRankEmbed-Small (137M) | 80.36/84.82; 71.43/75.00; 58.57/63.39 | [SweRank](https://arxiv.org/pdf/2505.07849) |
| SWE-bench Lite (300) File / Function match | OrcaLoca | 83.33 / 65.33 (resolved 41.00) | [OrcaLoca](https://arxiv.org/abs/2502.00350) |
| SWE-bench full, BM25 @27K tokens | BM25 | all-oracle-files 39.83%; ≥1 file 51.27% | [SWE-bench](https://arxiv.org/pdf/2310.06770) |
| LCA bug localization Recall@20 | CoRet (vs −call graph) | 0.47 (0.41 without call-graph context) | [CoRet](https://en.papernotes.org/ACL2025/code_intelligence/coret_improved_retriever_for_code_editing/) |
| SWE-PolyBench file retrieval R/P | Agentless-PB (Sonnet 3.5) | Java 29.5/49.7; JS 23.4/35.2; TS 17.5/27.7 | [SWE-PolyBench](https://arxiv.org/html/2504.08703v1) |
| ContextBench context F1 | frontier LLMs + agents | block F1 < 0.45; line F1 < 0.35 | [ContextBench](https://arxiv.org/abs/2602.05892) |
| CoIR mean NDCG@10 (embedder sanity only) | Voyage-Code-002 | 56.26 | [CoIR](https://arxiv.org/html/2407.02883v3) |

- Ready-made artifacts:
  - The official BM25-retrieved SWE-bench/Lite contexts on HF. — [princeton-nlp/SWE-bench_Lite_bm25_27K](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite_bm25_27K)
  - The LCA bug-localization dataset. — [JetBrains-Research/lca-bug-localization](https://huggingface.co/datasets/JetBrains-Research/lca-bug-localization)
  - CORE-Bench. — [zhangfw123/CORE-Bench](https://huggingface.co/datasets/zhangfw123/CORE-Bench)
  - ContextBench. — [EuniAI/ContextBench](https://github.com/EuniAI/ContextBench)
  - SWE-Explore. — [SWE-Explore-Bench](https://github.com/Last-Humans-Coding-Under-White-Nights/SWE-Explore-Bench)
  - SWE-PolyBench. — [amazon-science/SWE-PolyBench](https://github.com/amazon-science/SWE-PolyBench)
  - SWE-bench Multilingual. — [SWE-bench/SWE-bench_Multilingual](https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual)
- A simple shell-only agent is a strong context-retrieval baseline (ContextBench), so the agent tier must include it. — [ContextBench](https://arxiv.org/abs/2602.05892)
- Exploration metrics track downstream repair (SWE-Explore). This is the published evidence that offline retrieval metrics correlate with agent outcomes. — [SWE-Explore](https://arxiv.org/abs/2606.07297)

### Inferences
Proposed harness (all inferences / design recommendations):

**Tier A — CI, every PR, fully offline, deterministic, no LLM, target under 10 minutes**

1. **`loc-lite-mini` (Python):**
   - Queries: a fixed, seeded, stratified sample of about 60–80 instances from LocAgent's SWE-Bench-Lite-274 conversion. Prefer the smaller repos for clone and index time, and keep django/sympy for nightly.
   - Query text is the issue `problem_statement`; the corpus is the repo at `base_commit` (shallow-fetch by SHA and cache the tarballs).
   - Gold sets come from the patch, as follows:
     - Diff hunks are mapped to tree-sitter spans of pre-patch definitions.
     - Gold = {files}, {classes}, {functions} whose spans intersect removed or modified lines.
     - Test files are excluded, as are added-only definitions (tagged separately).
   - Metrics:
     - LocAgent-style Acc@k ("all gold"): file @1/3/5, module @5/10, function @5/10.
     - "Any-gold" success@k and MRR, for continuity with the current harness.
     - Recall@k.
   - Publish the per-instance JSON so Tier B can recompute the full-274 numbers that are directly comparable to BM25 61.68 / 36.86 and CodeRankEmbed 84.67 / 58.76.
2. **`fixtures-history` — the new core that fixes the n = 2–7 problem.** For each of the 18 fixtures:
   - Re-pin to a real commit, re-cloning the 9 unpinnable fixtures.
   - Mine about 20–40 merged PRs or commits *after* the pinned commit. Query = PR title + body (or the linked issue); gold = changed functions, computed as in step 1.
   - Filters:
     - 1–5 gold functions.
     - Non-test, non-doc changes only.
     - Drop bot and formatting commits.
     - Tag queries that contain a gold identifier as *lexical*; report *semantic* separately.
     - Time-split: the latest 30% of PRs are held out.

   This yields about 400–700 paired queries, enough for ~5–10-point paired effects (see §4). Hand-authored exact-symbol queries stay as a regression and smoke subset.
3. **`graph-oracle`.** For each fixture language with a SCIP/LSP indexer:
   - Sample about 50 symbols and compare graph-indexer callers, callees and references with the oracle.
   - Report edge precision/recall and F1 per language and edge kind.
   - For Python, add PyCG's 112-program micro-benchmark.
   - For impact analysis, measure co-change recall on the mined commits from step 2.
4. **`context-efficiency`.** For each Tier-A query, record:
   - tokens returned until the first gold, and until all gold;
   - gold-line recall at fixed token budgets (e.g. 2K, 8K);
   - precision of the returned lines.

   This is a ContextBench/SWE-Explore-style measure and turns "fewer tokens" into a measured quantity rather than an assertion.

**Tier B — nightly, offline, no LLM, 30–90 minutes**
- The full SWE-Bench-Lite-274 and Loc-Bench-560, with per-category breakdowns (bug, feature, security, performance). Compare with BM25, CodeRankEmbed and SweRankEmbed-Small, ideally re-run locally from their public checkpoints on the same subset.
- A multi-language slice of about 100–150 tasks from SWE-bench Multilingual or SWE-PolyBench, with gold nodes derived the same way. This covers C, C++, Go, Java, JS, TS, PHP, Ruby and Rust, matching the fixture languages.
- About 200 stratified CORE-Bench issue-to-edit queries.
- The ContextBench gold contexts reused as line-level targets.

**Tier C — weekly or release, LLM in the loop, paired A/B**
- **Arms:** a mini-SWE-agent-style shell-only agent vs the same agent with the graph-indexer MCP; same model snapshot; 3 seeds.
- **Tasks:** 50–100 post-cutoff tasks from SWE-bench-Live or SWE-rebench (or the SWE-bench Pro public set) to avoid SWE-Bench-Illusion memorization.
- **Metrics:**
  - Resolve rate (Docker).
  - Localization P/R from the generated patch (SWE-PolyBench style).
  - Context recall/precision from the trajectory (ContextBench style).
  - Tokens split into input, cached and output, plus MCP schema overhead.
  - Tool calls, wall time, and cost per resolved task.
- **Statistics:** paired bootstrap CIs, clustered by repo.
- **Optional:** an SWE-QA subset (Python repos) with an LLM judge, to mirror Cursor's offline QA evaluation.

**Acceptance criteria for "the refactor improved X"** (pre-register these):
- The 95% CI of the paired difference on the primary metric excludes 0 on the held-out Tier-A suite (function Acc@10 on `fixtures-history`, semantic subset), with no significant regression on the lexical subset or on Lite-mini.
- Tier-B numbers are reported against the published baselines above on the *identical* subsets.
- Tier-C shows non-inferior resolve rate with fewer tokens per resolved task, or a higher resolve rate.

### Gaps
- LocAgent's converted SWE-Bench-Lite-274 and Loc-Bench files (repo, HF dataset IDs, schema) could not be inspected (GitHub/HF blocked), so the exact filtering rule behind the 274 subset is inferred from the arithmetic, not read.
- No published numbers exist for graph-indexer-like *local* MCP tools on any of these benchmarks, so the first Tier-B run will be the baseline.
- Per-repository instance counts in SWE-bench Lite and Loc-Bench (needed to budget CI time) were not verified.
- It is unverified whether CodeRankEmbed or SweRankEmbed training data overlaps graph-indexer's fixture repos. This matters if these models are used as baselines on the history-mined suite.
