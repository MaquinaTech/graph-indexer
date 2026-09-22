# Agentic code localization and graph-based repository retrieval for AI coding agents (2023–2026)

> **How these notes were sourced, and how much to trust them.** arXiv, ACL Anthology, OpenReview, ICLR proceedings, Hugging Face, alphaXiv, aider.chat and most other sites were blocked for page fetching in this session. The shared web-search budget also ran out partway through. So the evidence comes from two places:
> 1. **Paper-reported numbers** come from search-engine extracts of the papers. Each one cites the paper URL the search returned. These are exact figures as they appeared in the extracts, but I did not read the full PDF. Where a number came from a secondary summary (a blog, liner.com, emergentmind, themoonlight), the note says so.
> 2. **Implementation details** such as schemas, tool signatures, parameters and constants come from reading each project's public source code. I shallow-cloned the official GitHub repositories. These are cited as GitHub file URLs and are primary evidence.
>
> Items tagged "(unverified)" or listed under Gaps should not be treated as facts.

## Q1. LocAgent (ACL 2025): graph schema, agent tools, hierarchical sparse index, measured gains, and ablations

### Takeaway
LocAgent parses a Python repository with the standard `ast` module into a directed heterogeneous graph. The graph has 4 node types (directory, file, class, function) and 4 edge types (contains, imports, invokes, inherits). The LLM gets three tools over it: **SearchEntity** (`search_code_snippets`), **TraverseGraph** (`explore_tree_structure`) and **RetrieveEntity** (`get_entity_contents`). SearchEntity runs a cascade of sparse lookups: exact entity ID, then a short-name dictionary, then BM25 over entity documents, then a fuzzy match, alongside BM25 over code chunks. The index is entirely static, with no LLM at index time.

The ablations say the **lexical entry point matters most**. Removing SearchEntity costs about 17 points of function-level Acc@10 compared with removing TraverseGraph (53.28 vs 66.06), and removing the BM25 index costs a lot too (60.22). Multi-hop, typed traversal adds a smaller but consistent gain at module and function level.

### Cited Findings
**Paper-level facts**
- Venue and authors: ACL 2025 long paper, pp. 8697–8727. Authors: Z. Chen, R. Tang, G. Deng, F. Wu, J. Wu, Z. Jiang, V. Prasanna, A. Cohan, X. Wang. — [ACL Anthology](https://aclanthology.org/2025.acl-long.426/); [arXiv 2503.09089](https://arxiv.org/abs/2503.09089)
- Headline claims from the abstract:
  - A fine-tuned Qwen-2.5-Coder-Instruct-32B matches state-of-the-art proprietary models at about 86% lower cost.
  - It reaches up to **92.7% file-level accuracy**.
  - It improves downstream GitHub issue resolution by **12% at Pass@10**.
  — [LocAgent README/BibTeX abstract](https://github.com/gersteinlab/LocAgent)
- Best reported localization on SWE-Bench-Lite: **94.16% file-level Acc@5** and **77.37% function-level Acc@10**. — [arXiv 2503.09089](https://arxiv.org/abs/2503.09089) (search extract)
- Cost per example — [arXiv 2503.09089](https://arxiv.org/abs/2503.09089) (search extract):
  - Fine-tuned Qwen2.5-32B: **$0.09**, versus **$0.66** for Claude-3.5 (the "86% reduction").
  - 7B fine-tune: **$0.05**.
- Agent backbones used in the comparisons: GPT-4o-2024-0513 and Claude-3-5-sonnet-20241022. — [arXiv 2503.09089](https://arxiv.org/abs/2503.09089) (search extract)
- LocAgent and OpenHands with Claude-3.5 are reported at more than 80% / 70% / 60% Acc@5 at file / class / function level on SWE-Bench-Lite. — [OpenReview PDF](https://openreview.net/pdf/6bca564e2c8d27fe5cbbd5f1a08b84e87ba81574.pdf) (search extract; unclear whether this is the LocAgent submission or a later paper quoting it)
- Embedding baseline: CodeRankEmbed reported at **76.6% file Acc@3** and **50.0% function Acc@5**. — [arXiv 2503.09089](https://arxiv.org/abs/2503.09089) (search extract; which table this came from is uncertain)
- Loc-Bench collects issues from popular Python repositories created after known LLM training cutoffs, to reduce contamination. It is distributed as the Hugging Face dataset `czlll/Loc-Bench_V1`. — [arXiv 2503.09089](https://arxiv.org/abs/2503.09089); [LocAgent README](https://github.com/gersteinlab/LocAgent)
- The fine-tuned localization models are released as Qwen2.5-Coder-7B-CL and Qwen2.5-Coder-32B-CL. — [LocAgent README](https://github.com/gersteinlab/LocAgent)

**Ablation (paper Table 6; fine-tuned Qwen-2.5-7B; SWE-Bench-Lite; file Acc@5 / module Acc@10 / function Acc@10)** — [arXiv 2503.09089](https://arxiv.org/abs/2503.09089) (search extract of Table 6):

| Variant | File Acc@5 | Module Acc@10 | Function Acc@10 |
|---|---|---|---|
| w/o SearchEntity | 68.98 | 61.31 | 53.28 |
| w/o BM25 index | 75.18 | 68.98 | 60.22 |
| w/o TraverseGraph | 86.13 | 78.47 | 66.06 |
| relation types = contain only | 86.50 | 79.56 | 66.42 |
| traverse hops = 1 | 86.86 | 80.29 | 66.79 |
| w/o RetrieveEntity | 87.59 | 81.39 | 69.34 |

- The paper's summary: removing any tool degrades accuracy, most sharply SearchEntity, and mostly at module and function level. — [arXiv 2503.09089](https://arxiv.org/abs/2503.09089) (search extract)

**Graph schema (from the code, graph index version `v2.3`)**
- Node and edge constants — [build_graph.py](https://github.com/gersteinlab/LocAgent/blob/master/dependency_graph/build_graph.py):
  - Node types: `directory`, `file`, `class`, `function`.
  - Edge types: `contains`, `inherits`, `invokes`, `imports`.
  - Directories `.git` and `.github` are skipped.
  - The graph is a networkx multigraph that is pickled to disk.
- Hierarchy semantics as told to the LLM — [structure_tools.py](https://github.com/gersteinlab/LocAgent/blob/master/util/runtime/structure_tools.py):
  - Directories contain files and subdirectories; files contain classes and functions; classes contain inner classes and methods; functions can contain inner functions.
  - Files, classes and functions can import classes and functions.
  - Classes can inherit.
  - Classes and functions can invoke others. "Invocations in a class's `__init__` are attributed to the class."
- Entity IDs have the form `file_path:QualifiedName`, for example `interface/C.py:C.method_a.inner_func`. — [structure_tools.py](https://github.com/gersteinlab/LocAgent/blob/master/util/runtime/structure_tools.py)
- Call edges are extracted purely syntactically and without receiver types — [build_graph.py](https://github.com/gersteinlab/LocAgent/blob/master/dependency_graph/build_graph.py) (`analyze_invokes`):
  - `ast.Call` with an `ast.Name` callee records the identifier.
  - `ast.Attribute` callees record only the attribute name (`obj.method` becomes `method`).
  - Decorators count as invocations.
  - Nested function and class definitions are skipped.
- Callee resolution is scope-aware but over-approximating — [build_graph.py](https://github.com/gersteinlab/LocAgent/blob/master/dependency_graph/build_graph.py) (`find_all_possible_callee`, `build_graph`):
  - Candidates are the entities visible along the caller's containment chain up to its file, plus entities imported by that file. This includes recursive re-exports through `__init__.py` and import aliases.
  - With `fuzzy_search=True` (the default), **every** candidate with the same short name gets an `invokes` edge. Otherwise only the nearest one does.
  - An optional `global_import` fallback links to any same-named entity anywhere in the repository.

**Tools (from the code)**
- **TraverseGraph = `explore_tree_structure`**. Parameters — [structure_tools.py](https://github.com/gersteinlab/LocAgent/blob/master/util/runtime/structure_tools.py); [traverse_graph.py](https://github.com/gersteinlab/LocAgent/blob/master/dependency_graph/traverse_graph.py):
  - `start_entities`: list of entity IDs.
  - `direction`: `upstream` (what the entities rely on), `downstream` (what they impact) or `both`. Default `downstream`.
  - `traversal_depth`: default **2**; `-1` means unlimited.
  - `entity_type_filter` and `dependency_type_filter`.
  - The traversal is rendered as a **tree-structured text** view. There are also graph and JSON renderers.
- **RetrieveEntity = `get_entity_contents(entity_names)`** returns complete code for `file:Qualified.Name` IDs or for whole files. — [content_tools.py](https://github.com/gersteinlab/LocAgent/blob/master/util/runtime/content_tools.py)
- **SearchEntity = `search_code_snippets(search_terms=[...] | line_nums=[...], file_path_or_pattern=...)`**. — [content_tools.py](https://github.com/gersteinlab/LocAgent/blob/master/util/runtime/content_tools.py)
- SearchEntity runs this cascade — [repo_ops.py](https://github.com/gersteinlab/LocAgent/blob/master/plugins/location_tools/repo_ops/repo_ops.py):
  1. Exact entity-ID match in the graph, returned as `complete` code.
  2. A global short-name dictionary, with a retry on the last segment of `Class.method` using the prefix as a filter. Results come back as `preview` or `fold` depending on how many there are.
  3. BM25 over **entity-level documents**, built from the non-test graph nodes.
  4. If BM25 finds nothing, a fuzzy match (rapidfuzz `token_set_ratio`, top 3).
  5. Separately, BM25 over **content chunks**.
- Result rendering and merging — [repo_ops.py](https://github.com/gersteinlab/LocAgent/blob/master/plugins/location_tools/repo_ops/repo_ops.py):
  - Priority order is `complete` > `code_snippet` > `preview` > `fold`.
  - Line-number queries return a ±20-line window (`context_window=20`).
  - Test files are excluded from the entity index.
- BM25 implementation — [bm25_retriever.py](https://github.com/gersteinlab/LocAgent/blob/master/plugins/location_tools/retriever/bm25_retriever.py):
  - llama-index `BM25Retriever` with an English `Stemmer`.
  - Content is chunked with `EpicSplitter`: `min_chunk_size=100`, `chunk_size=500`, `max_chunk_size=2000`, `hard_token_limit=2000`, `max_chunks=200` per file.
  - `similarity_top_k=10`.
- Fuzzy matcher: rapidfuzz `token_set_ratio` with a custom tokenizer. — [fuzzy_retriever.py](https://github.com/gersteinlab/LocAgent/blob/master/plugins/location_tools/retriever/fuzzy_retriever.py)
- Metric definitions — [eval_metric.py](https://github.com/gersteinlab/LocAgent/blob/master/evaluation/eval_metric.py):
  - **Acc@k** counts an instance as correct only if the number of gold locations in the top-k equals the number of gold items that fit in the top-k (all gold found, capped at k).
  - **Recall@k** is the fraction of gold items found in the top-k, averaged over instances.
  - NDCG, Precision@k and MAP are also computed.
  - Levels are `file`, `module` (class) and `function`.
- Downstream tools already reuse this contract. CodeNib, an open-source tool with no model, serves LocAgent's search and graph-navigation tools from "reusable, manifest-backed symbol-graph and BM25 indexes". — [LocAgent README note](https://github.com/gersteinlab/LocAgent); [CodeNib](https://github.com/sysevol-ai/CodeNib)

### Inferences
- **Lexical search is the entry point.** The biggest losses come from removing SearchEntity (function Acc@10 of 53.28) or the BM25 index (60.22). Removing TraverseGraph leaves 66.06.
  - For graph-indexer, fast, identifier-aware search that returns canonical entity IDs matters more than graph tools.
  - The graph pays off after good seeds are found, mainly at module and function granularity.
- **Typed, multi-hop traversal is worth keeping, but depth 2 is enough.** Contain-only relations (66.42) and 1-hop traversal (66.79) both score below the full system, per the paper's statement that every ablation degrades accuracy.
  - The full-system row of this ablation was not recovered, so the size of the gain is unknown. The ordering implies it is a few points.
- **The whole LocAgent index is static and CPU-friendly:** an AST pass, networkx, and llama-index BM25. It maps directly onto a Node.js server using Tree-sitter plus a BM25 library. The LLM is only needed at query time, and in an MCP setting the client agent (Claude Code or Cursor) supplies it.
- **Concrete things to copy:**
  - Stable entity IDs of the form `path:Qualified.Name`, accepted by every tool.
  - The lookup cascade: exact ID, then short name, then `Class.method` split, then BM25 over entity documents, then fuzzy, then content BM25.
  - `direction` + `traversal_depth` + type filters on traversal.
  - Tree-structured traversal output.
  - Folded or preview rendering when many hits come back, and full code only for exact hits.
  - Excluding tests from default search.
  - Attributing `__init__` calls to the class.
  - Import-scoped call resolution, plus a flag on edges that were resolved only by name (fuzzy).
- **LocAgent's call graph is deliberately over-approximate.** Attribute calls are matched by name only, and all same-named candidates are kept. The results show this is good enough for localization.
  - For impact analysis, graph-indexer should store a confidence per edge: import-resolved vs name-only. Agents can then filter noisy fan-out.

### Gaps
- Not recovered:
  - The full LocAgent row in the ablation table (baseline for computing deltas).
  - Per-baseline main-table numbers (Agentless, SWE-agent, MoatlessTools, OpenHands, the embedding models) at matching k.
  - GPT-4o numbers.
  - Downstream Pass@1.
- Loc-Bench size and category breakdown were not verified. I recall 560 issues in 4 categories (bug, feature, security, performance), but that is from memory and unconfirmed.
- The attribution of the CodeRankEmbed 76.6/50.0 numbers (the k differs from the other rows) is uncertain.

## Q2. Other graph and retrieval localization systems: RepoGraph, CodexGraph, CGM, OrcaLoca, CoSIL, KGCompass, SweRank, CoRNStack/CodeRankEmbed, CoRet (plus LingmaAgent, MarsCode, Prometheus, BugCerberus)

### Takeaway
2024–2025 work splits into two families.
- **(a) Agentic navigation over a static code graph:** RepoGraph as a tool, CodexGraph, LocAgent, OrcaLoca, and CoSIL (which builds its graph lazily at query time).
- **(b) Trained retrieve-and-rerank:** CodeRankEmbed, SweRank, CoRet.

By mid-2025 family (b) had the best function-level numbers, at far lower cost: SweRankEmbed-Large 82.12% and SweRankLLM-Large 88.69% function Acc@10 on SWE-Bench-Lite, beating LocAgent with Claude-3.5.

Structural signals help, but in modest, bounded doses:
- Call-graph context adds about 6 recall points to a dense retriever (CoRet).
- A 1-hop ego-graph lifts resolve rates by about 2 points (RepoGraph), while a naive 2-hop expansion (about 10.5K tokens) *hurts*.
- Priority scheduling and distance-aware pruning of graph context each matter (OrcaLoca).

Every static graph in this group needs no LLM at index time. CGM and trained retrievers need an embedding model at index time. HippoRAG, GraphRAG and LightRAG (Q5) are the ones that need a generative LLM at index time.

### Cited Findings
**RepoGraph (ICLR 2025)**
- A plug-in repository-level graph. Each node is a code line (definition or reference). Edges encode definition–reference dependencies. Ego-graphs centred on search keywords are retrieved and fed to procedural or agent frameworks. — [ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/hash/4a4a3c197deac042461c677219efd36c-Abstract-Conference.html); [arXiv 2410.14684](https://arxiv.org/abs/2410.14684)
- Resolve rates on SWE-bench Lite, before → after RepoGraph — [search extract of paper](https://arxiv.org/abs/2410.14684); [review](https://liner.com/review/repograph-enhancing-ai-software-engineering-with-repositorylevel-code-graph):
  - Agentless: **27.33 → 29.67%** (open-source SOTA at the time).
  - AutoCodeRover: **19.00 → 21.33%**.
  - SWE-agent: **18.33 → 20.33%**.
  - Average relative improvement **32.8%**, which includes the RAG baseline.
- Context size (secondary source; treat as unverified) — [blog summary](https://haohoang.is-a.dev/post/repo-graph/); [review](https://liner.com/review/repograph-enhancing-ai-software-engineering-with-repositorylevel-code-graph):
  - 1-hop flattened ego-graphs averaged **11.6 nodes, 37.1 edges, 2,310.7 tokens**.
  - 2-hop grew to **54.5 nodes and 10,505.3 tokens** and **underperformed the baseline** (context overload).
  - RepoGraph reportedly improved file-, function- and line-level localization for every baseline.
- Implementation — [construct_graph.py](https://github.com/ozyyshr/RepoGraph/blob/main/repograph/construct_graph.py):
  - Tree-sitter "tags" with `kind ∈ {def, ref}` and `category ∈ {class, function}`.
  - Graph nodes are keyed by **bare identifier name** (not qualified).
  - Edges run class → its methods, and ref → def whenever names match.
  - Built-in names (`dir(builtins)` plus list/dict/set/str/tuple methods) and third-party calls are filtered out.
  - Output: a `tags_{instance}.jsonl` file (line-level) and a networkx `.pkl`.
- Search helpers: `one_hop_neighbors`, `two_hop_neighbors`, depth-limited `dfs` and `bfs`. — [graph_searcher.py](https://github.com/ozyyshr/RepoGraph/blob/main/repograph/graph_searcher.py)
- Agent integration adds a single action: `search_repo(search_term)`, which "returns the def and ref relations for the search term". — [RepoGraph README](https://github.com/ozyyshr/RepoGraph)

**CodexGraph (2024)**
- Indexes a repository with static analysis into a graph database (Neo4j). The LLM agent queries it in Cypher. A primary agent decomposes the task into natural-language queries and a translation agent writes the Cypher. — [arXiv 2408.03910](https://arxiv.org/abs/2408.03910) (search extract)
- Schema — [emergentmind summary](https://www.emergentmind.com/topics/codexgraph) (secondary):
  - Nodes: MODULE, CLASS, FUNCTION, METHOD, FIELD, GLOBAL_VARIABLE.
  - Edges: CONTAINS, HAS_METHOD, INHERITS, USES, CALLS.
- Evaluated on CrossCodeEval, SWE-bench and EvoCodeBench. On CrossCodeEval Lite (Python) with GPT-4o, retrieval-augmented code-graph methods improved exact match by **10.4–17.1%** over no-RAG. — [arXiv 2408.03910](https://arxiv.org/abs/2408.03910) (search extract)

**Code Graph Model, CGM (NeurIPS 2025)**
- Pipeline: Rewriter → Retriever → Reranker → Reader.
  - The Rewriter uses LLM "Extractor" and "Inferer" prompts to pull out files, classes and functions mentioned in the issue and to infer the characteristics of the code to change.
  - The Retriever builds a connected subgraph from lexical plus semantic anchor hits.
  - The Reranker picks the top-K files.
  - The Reader, a graph-integrated LLM, generates the patch.
  — [arXiv 2505.16901](https://arxiv.org/abs/2505.16901); [CodeFuse-CGM README](https://github.com/codefuse-ai/CodeFuse-CGM)
- Graph schema — [arXiv 2505.16901](https://arxiv.org/abs/2505.16901) (search extract):
  - Nodes: REPO, PACKAGE, FILE, TEXTFILE, CLASS, FUNCTION, ATTRIBUTE.
  - Edges: contains, calls, extends, imports, implements.
- Node embeddings come from the CGE-large encoder, precomputed per repository at index time. — [CodeFuse-CGM README](https://github.com/codefuse-ai/CodeFuse-CGM)
- Results:
  - **43.00%** on SWE-bench Lite with Qwen2.5-72B. As of May 2025 that was first among open-model methods and eighth overall. — [arXiv 2505.16901](https://arxiv.org/abs/2505.16901)
  - Leaderboard entries of CGM-72B: 35.67% (Oct 2024), 41.67% (v1.1), **44.00% (v1.2, Jan 2025)**. — [CodeFuse-CGM README](https://github.com/codefuse-ai/CodeFuse-CGM)

**OrcaLoca (ICML 2025)**
- Three mechanisms: priority-based scheduling of LLM-proposed actions, action decomposition with relevance scoring, and distance-aware context pruning. Reaches a **65.33% function match rate on SWE-bench Lite** (open-source SOTA at publication). — [arXiv 2502.00350](https://arxiv.org/abs/2502.00350); [ICML poster](https://icml.cc/virtual/2025/poster/45561)
- Ablation (function match): w/o priority scheduling **73.12%**; w/o file & class decomposition **72.04%**; w/o disambiguation decomposition **70.97%**; w/o context pruning **72.04%**. — [arXiv 2502.00350](https://arxiv.org/abs/2502.00350) (search extract)
- Code — [search_tool.py](https://github.com/fishmingyu/OrcaLoca/blob/main/Orcar/search/search_tool.py); [types.py](https://github.com/fishmingyu/OrcaLoca/blob/main/Orcar/types.py):
  - Search APIs: `search_file_contents`, `search_class`, `search_method_in_class`, `search_callable`, `search_source_code`, `search_file_tree`.
  - Context distance is `kg.get_hops_between_nodes(q1, q2)`, i.e. hop distance in its code knowledge graph.
  - Actions sit in a `heapq` priority queue keyed by LLM-assigned priority and are re-sorted by how often each action recurs in the history.
- An April 2025 update added a "top-K retrieval mode inspired from LocAgent and CoSIL". — [OrcaLoca README](https://github.com/fishmingyu/OrcaLoca)

**CoSIL (ASE 2025)**
- Two-phase search — [arXiv 2503.22424](https://arxiv.org/abs/2503.22424):
  - File-level broad exploration over a **module call graph**.
  - Function-level deep search that expands that into a **function call graph** and searches it iteratively.
  - A pruner filters irrelevant directions and context.
  - The call graph is **built dynamically by the LLM during search** ("no pre-parsing", "without training or indexing").
- Results — [arXiv 2503.22424](https://arxiv.org/abs/2503.22424):
  - Top-1 function localization of **43.3% (SWE-bench Lite)** and **44.6% (Verified)** with Qwen2.5-Coder-32B, reported as **+96.04%** on average over prior SOTA.
  - Plugged into Agentless, it raises resolution by **2.98–30.5%**.
- Ablation with Qwen2.5-Coder-32B on Lite: removing iterative search costs about **20%**; removing the module call graph about **10%** (it mainly serves reflection); removing pruning about **3%**. — [arXiv 2503.22424](https://arxiv.org/abs/2503.22424) (search extract)
- Reuses Agentless's cached repository-structure files. — [CoSIL README](https://github.com/ZhonghaoJiang/CoSIL)

**KGCompass (2025)**
- Builds a repository-aware knowledge graph linking **issues, pull requests, files, classes and functions**. It mines ranked multi-hop "entity paths" from the issue to candidate functions, narrowing the search to the **20 most relevant functions**, which then guide the LLM. — [arXiv 2503.21710](https://arxiv.org/abs/2503.21710); [v2 HTML](https://arxiv.org/html/2503.21710v2)
- Results on SWE-bench Lite: **58.3%** repair (single LLM) and **56.0% function-level fault-localization accuracy**, at about **$0.20 per repair**. Relative to pure-LLM baselines it lifts DeepSeek-V3 by 115.7% and Qwen2.5-Max by 156.4%. — [arXiv 2503.21710](https://arxiv.org/abs/2503.21710) (search extract of v2; the backbone behind 58.3% was not confirmed)

**SweRank (2025) and CoRNStack / CodeRankEmbed (ICLR 2025)**
- Two stages: **SweRankEmbed** (bi-encoder; Small = 137M, Large = 7B) and **SweRankLLM** (listwise LLM reranker; Large = 32B). — [arXiv 2505.07849](https://arxiv.org/abs/2505.07849)
- Results — [arXiv 2505.07849](https://arxiv.org/abs/2505.07849); [MarkTechPost](https://www.marktechpost.com/2025/05/13/agent-based-debugging-gets-a-cost-effective-alternative-salesforce-ai-presents-swerank-for-accurate-and-scalable-software-issue-localization/):
  - Function-level Acc@10 on SWE-Bench-Lite: **82.12%** for SweRankEmbed-Large alone, **88.69%** with the SweRankLLM-Large reranker.
  - This beats LocAgent with Claude-3.5 and all evaluated agent systems.
  - SweRankEmbed-Small (137M) outperforms earlier 7B embedders.
  - It also sets SOTA on LocBench and generalizes beyond the bug reports it was mostly trained on.
- Training data, **SweLoc** — [SweRank README](https://github.com/SalesforceAIResearch/SweRank):
  - Built from GitHub issues and PRs of popular Python repositories, following the SWE-bench collection pipeline.
  - Positives are the functions modified by the patch.
  - Hard negatives are mined from **other functions in the same repository**, then quality-filtered.
  - Reranker data is derived from the same set.
- Superseded (not reviewed): **SweRank+** (multilingual, multi-turn), Dec 2025. — [arXiv 2512.20482](https://arxiv.org/abs/2512.20482)
- CoRNStack is a large filtered (text, code) contrastive dataset with curriculum-based hard-negative mining. — [CoRNStack README](https://github.com/gangiswag/cornstack)
  - It trains **CodeRankEmbed (137M bi-encoder)** and **CodeRankLLM (7B reranker)**, described as the first LLM code rerankers fine-tuned this way.
  - Reranking defaults: `top_k=100`, sliding `window_size=10`, `step_size=5`.

**CoRet (ACL 2025 short)**
- A dense retriever for code editing. It combines code semantics, **repository structure (file paths)** and **call-graph dependencies**, trained with a loss designed for repository-level retrieval. — [ACL Anthology](https://aclanthology.org/2025.acl-short.62/); [arXiv 2505.24715](https://arxiv.org/abs/2505.24715)
- Results — [ACL Anthology](https://aclanthology.org/2025.acl-short.62/) (search extract):
  - At least **+15 recall points** over existing models on SWE-bench and Long Code Arena bug localization.
  - On SWE-bench Verified, "perfect recall" is **0.53 at chunk level and 0.47 at file level**, versus 0.35 and 0.28 for CodeSage-S.
  - **Call-graph context adds 0.41 → 0.47 (+6 points) on LCA @20** compared with no call-graph context.

**Closest existing open-source analog to graph-indexer: CodeNib**
- Local and open source, with "no model or cloud". It builds BM25 plus a source-linked symbol graph (SCIP/LSP-backed, typed edges) and registers an MCP server with Codex and Claude Code. — [CodeNib README](https://github.com/sysevol-ai/CodeNib)
  - MCP tools: ranked BM25, regex, definition, reference, route and bounded source-read.
  - A per-view manifest records a source fingerprint; affected views are rebuilt atomically. File- and symbol-level delta repair is still disabled.
  - It serves the LocAgent, Agentless, CoSIL and OrcaLoca tool contracts from one manifest.
- Its self-reported evaluation (not peer-reviewed) gives file-recall@10 = 0.92 and symbol-recall@10 = 0.73 on 96 synthesized behavioural queries. — [CodeNib docs](https://github.com/sysevol-ai/CodeNib/tree/main/docs)

### Inferences
**Which techniques need an LLM at index time**

| Technique | Needs an LLM at index time? |
|---|---|
| LocAgent graph + BM25; RepoGraph tags graph; OrcaLoca graph; CodexGraph static analysis; Aider repo map; CodeNib | **No.** Purely static. |
| CGM node embeddings; SweRankEmbed; CodeRankEmbed; CoRet | Needs an **embedding model** at index time, but not a generative LLM. A 137M model is plausibly CPU-feasible (inference, not measured here). |
| CoSIL, OrcaLoca, LocAgent, CGM Rewriter/Reranker/Reader, SweRankLLM | Use an LLM at **query** time only. |
| KGCompass | Needs **repository history** (issues/PRs) at index time. Whether an LLM is used for linking was not verified. |

**Graph neighbours vs lexical/dense retrieval**
- In none of the papers above does graph traversal replace a good lexical or dense entry point.
- Graph information helps as bounded context around seeds: 1-hop in RepoGraph; depth 2 with type filters in LocAgent; call-graph context appended to embeddings in CoRet; hop-distance pruning in OrcaLoca.
- Unbounded expansion hurts: RepoGraph's 2-hop result.

**What this means for graph-indexer**
1. Keep BM25 over entity documents and chunks as the primary entry point.
2. Add an optional small code embedder (CodeRankEmbed or SweRankEmbed-Small class, 137M) for hybrid retrieval on CPU.
3. Expose typed traversal with depth ≤ 2 and hop-distance-based pruning or ranking of neighbours.
4. Consider enriching each entity's indexed text with its file path and 1-hop call-graph context (callers' and callees' names/signatures), CoRet-style. That is a static, index-time operation.

**Name-keyed graphs are a trap for impact analysis.** RepoGraph keys nodes by bare identifier, so all same-named functions merge. LocAgent and CGM use qualified IDs. graph-indexer should key nodes by qualified ID and store the name only as an attribute.

### Gaps
- No primary data retrieved (search budget exhausted, sites blocked) for:
  - **LingmaAgent / RepoUnderstander** (MCTS over a repository knowledge graph).
  - **MarsCode Agent**.
  - **Prometheus** (it only appears as one of three agents studied in the trajectory paper in Q6).
  - **BugCerberus** (hierarchical file → function → statement localization).
- Not retrieved: the exact SweLoc size; SweRank file- and module-level numbers; SweRank cost figures; SweRankEmbed license terms (relevant for bundling).
- CodexGraph's exact SWE-bench numbers; CGM's retrieval hyperparameters (anchor count, hop expansion).
- 2026 work identified but not reviewed. Several look directly relevant:
  - "Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP" — [arXiv 2603.27277](https://arxiv.org/abs/2603.27277)
  - "Neurosymbolic Repo-level Code Localization" — [arXiv 2604.16021](https://arxiv.org/abs/2604.16021)
  - "LLM Agents Can See Code Repositories" — [arXiv 2606.14061](https://arxiv.org/abs/2606.14061)
  - "Learning Adaptive Parallel Execution for Efficient Code Localization" — [arXiv 2601.19568](https://arxiv.org/abs/2601.19568)
  - "SpIDER: Spatially Informed Dense Embedding Retrieval for Software Issue Localization" — [arXiv 2512.16956](https://arxiv.org/abs/2512.16956)
  - "GREPO: GNN benchmark for repository-level bug localization" — [arXiv 2602.13921](https://arxiv.org/abs/2602.13921)
  - "RPG-Encoder" — [arXiv 2602.02084](https://arxiv.org/abs/2602.02084)
  - "Improving Code Localization with Repository Memory" — [arXiv 2510.01003](https://arxiv.org/abs/2510.01003)
  - "ARISE: repository-level graph representation and toolset for agentic program repair and fault localization" — [arXiv 2605.03117](https://arxiv.org/abs/2605.03117)
  - "SWE-Pruner" — [arXiv 2601.16746](https://arxiv.org/abs/2601.16746)
- **Recommendation to the report writer:** treat 2024-era SWE-bench Lite resolve rates (RepoGraph 29.67%, Agentless 27.3%, AutoCodeRover 19%) as **superseded** baselines. They show relative gains only.

## Q3. Agent interfaces (Agentless, AutoCodeRover, SWE-agent ACI, Moatless Tools, OpenHands): which search and localization designs measurably helped

### Takeaway
Interface design has measurable effects comparable to model changes. In the SWE-agent ablations on SWE-bench Lite with GPT-4 Turbo:
- A purpose-built agent-computer interface beats a shell-only agent by **10.7 points**.
- **Summarized search** (list only the matching files) beats iterative search by **6.0 points**.
- A **100-line** file window is best.
- **Lint-gated edits** add **3.0 points**.

AutoCodeRover showed that AST-aware lookup APIs (class/method, optionally scoped to a file) with capped output work well. Agentless showed that a fixed hierarchical pipeline (files → classes/functions → edit lines), with LLM and embedding **hybrid file retrieval**, is competitive at low cost.

### Cited Findings
**SWE-agent**
- Results and ablations — [arXiv 2405.15793](https://arxiv.org/abs/2405.15793) (search extract):
  - Solves **12.47%** of the 2,294 SWE-bench test tasks with GPT-4 Turbo, versus 3.8% previous best.
  - Ablations on SWE-bench Lite (300): summarized > iterative search by **6.0 pp**; the 100-line viewer beats 30 lines; integrated linting **+3.0 pp**; SWE-agent **+10.7 pp** over the default-shell baseline.
- ACI principles in the official docs — [aci.md](https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md):
  1. A linter runs on every edit and **rejects syntactically invalid edits**.
  2. The file viewer "works best when displaying just 100 lines in each turn", with scroll and in-file search.
  3. The directory search command succinctly lists **each file with at least one match**. "Showing the model more context about each match proved to be too confusing for the model."
  4. Empty output returns "Your command ran successfully and did not produce any output."
- Hard caps in code — [search_dir](https://github.com/SWE-agent/SWE-agent/blob/main/tools/search/bin/search_dir); [windowed/install.sh](https://github.com/SWE-agent/SWE-agent/blob/main/tools/windowed/install.sh):
  - `search_dir` refuses with "More than N files matched … Please narrow your search" when **more than 100 files** match.
  - `search_file` does the same for too many matching lines.
  - Default `WINDOW=100`.

**AutoCodeRover**
- Program-structure-aware (AST) context retrieval via stratified search APIs, plus **spectrum-based fault localization (SBFL)** when tests exist. SBFL-flagged methods are handed to the agent as hints. — [arXiv 2404.05427](https://arxiv.org/abs/2404.05427); [ISSTA 2024 PDF](https://zhiyufan.github.io/files/ISSTA2024a.pdf)
- Results: 19% on SWE-bench Lite in the original paper. The repository later reports **37.3% Lite / 46.2% Verified pass@1** at under $0.70 per task. — [arXiv 2404.05427](https://arxiv.org/abs/2404.05427); [GitHub](https://github.com/AutoCodeRoverSG/auto-code-rover)
- The complete API set in code: `search_class`, `search_class_in_file`, `search_method`, `search_method_in_class`, `search_method_in_file`, `search_code`, `search_code_in_file`. — [search_backend.py](https://github.com/AutoCodeRoverSG/auto-code-rover/blob/main/app/search/search_backend.py)
  - It also defines `RESULT_SHOW_LIMIT = 3` for displayed results.

**Agentless**
- Three phases: localization, repair, patch validation. Localization is hierarchical: files → classes/functions → fine-grained edit locations, with the last step sampled several times. — [Agentless README](https://github.com/OpenAutoCoder/Agentless); [arXiv 2407.01489](https://arxiv.org/abs/2407.01489)
- File localization merges two sources — [README_swebench.md](https://github.com/OpenAutoCoder/Agentless/blob/main/README_swebench.md):
  - LLM-predicted files.
  - Embedding retrieval (OpenAI `text-embedding-3-small`) run after an LLM prunes **irrelevant folders**.
- Results — [Agentless README](https://github.com/OpenAutoCoder/Agentless):
  - v1.0 (July 2024): 27.3% (82/300) on Lite at **$0.34 per issue**.
  - With Claude 3.5 Sonnet (Dec 2024): **40.7% Lite / 50.8% Verified**.
  - It also provides a manually filtered SWE-bench Lite-S subset.

**Moatless Tools**
- Action set includes `find_class`, `find_function`, `find_code_snippet`, `semantic_search`, `grep_tool`, `glob`, `list_files`, `read_file(s)`, `string_replace`, `run_tests`. — [moatless/actions](https://github.com/aorwall/moatless-tools/tree/main/moatless/actions)
- The index's default embedding model is `text-embedding-3-small`. — [moatless index settings](https://github.com/aorwall/moatless-tools/blob/main/moatless/index/settings.py)
- The README cites SWE-Search. — [arXiv 2410.20285](https://arxiv.org/abs/2410.20285)
- LocAgent's `repo_index` package has the same module layout as Moatless's index: `code_index.py`, `epic_split.py`, `simple_faiss.py`, `code_node.py`, `settings.py`. — [LocAgent repo_index](https://github.com/gersteinlab/LocAgent/tree/master/repo_index); [moatless index](https://github.com/aorwall/moatless-tools/tree/main/moatless/index)

**OpenHands**
- Used as a localization baseline in LocAgent: OpenHands with Claude-3.5 reached more than 80/70/60% Acc@5 at file/class/function level on SWE-Bench-Lite, per the extract. — [OpenReview PDF](https://openreview.net/pdf/6bca564e2c8d27fe5cbbd5f1a08b84e87ba81574.pdf) (search extract)

### Inferences
Design rules for graph-indexer's MCP tool outputs, supported by the ablations above:
1. **Summarize by default.** Return files or entities with counts and short signatures, not full match context. Offer a follow-up tool for bodies (SWE-agent's +6.0 pp; LocAgent's fold/preview/complete modes).
2. **Refuse over-broad queries** with a "narrow your search" hint instead of dumping hundreds of hits. SWE-agent uses a 100-file cap; AutoCodeRover uses a display limit of 3.
3. **Windowed reads of about 100 lines**, with explicit line numbers.
4. **Never return empty output silently.** State "no results" and suggest alternatives, such as fuzzy name matches.
5. **Offer AST-scoped lookups** such as `class in file` and `method in class`, taking qualified names.
6. **Validate syntax on edit.** Out of scope for an index server, but tree-sitter could provide a cheap `check_syntax` tool.

**Hybrid file retrieval is standard.** Agentless (LLM plus embeddings, after folder pruning) and SweRank (embeddings plus reranker) both combine sources. An offline server can supply the non-LLM half, BM25 plus an optional embedder, and leave the pruning and reranking to the client agent.

### Gaps
- Not retrieved: the exact SWE-agent ablation table values (absolute rates per variant, e.g. no-search or full-file viewer); AutoCodeRover ablations with and without SBFL; Moatless SWE-bench numbers; OpenHands' own localization analysis.
- Agentless per-stage localization accuracy (file/function/line), which the paper reports, was not recovered.

## Q4. Repository-level code-completion retrieval: RepoCoder, RepoHyper, GraphCoder, DraCo, RLCoder, Repoformer, CodeRAG, cAST — chunking granularity and context-graph signals

### Takeaway
The completion-retrieval line moved through several stages:
1. Fixed sliding windows plus lexical or iterative similarity retrieval (RepoCoder, 2023).
2. Structure-aware context: code-property and semantic graphs with call edges plus graph expansion and GNN reranking (RepoHyper), and type-sensitive dataflow graphs (DraCo).
3. **Learned or selective retrieval:** an RL-trained retriever that discards useless snippets (RLCoder), and a model that decides whether to retrieve at all (Repoformer).
4. **AST-aligned chunking** (cAST).

The primary repositories confirm the designs. The numeric results could not be retrieved in this session.

### Cited Findings
- **RepoCoder** — [RepoCoder README](https://github.com/microsoft/CodeT/tree/main/RepoCoder):
  - A similarity-based retriever plus a code LM, run as **iterative retrieval-generation**: the first-round completion becomes part of the next retrieval query.
  - Introduces **RepoEval** with line, API-invocation and function-body completion, scored by Exact Match and Edit Similarity.
- **RepoHyper** — [RepoHyper README](https://github.com/FSoft-AI4Code/RepoHyper); [arXiv 2403.06095](https://arxiv.org/abs/2403.06095):
  - Builds a Repo-level Semantic Graph / code property graph by **aligning tree-sitter functions, classes and methods with a PyCG call graph**, with call and import edges.
  - Retrieval is **search-then-expand**: KNN over node embeddings, then graph expansion framed as link prediction, then a **GNN link predictor** that reranks candidates. Evaluated on RepoBench.
  - Preprocessing is heavy: PyCG over RepoBench repositories used 60 processes and **about 350 GB peak RAM**.
- **DraCo** (ACL 2024) — [DraCo README](https://github.com/nju-websoft/DraCo):
  - Dataflow-guided retrieval: extends dataflow analysis with **type-sensitive dependency relations**.
  - Builds a repository-specific context graph offline, then retrieves "relevant background knowledge rather than similar code snippets".
  - New dataset **ReccEval** from PyPI. Reports "generally superior accuracy and efficiency" over baselines.
- **RLCoder** (ICSE 2025) — [RLCoder README](https://github.com/DeepSoftwareAnalytics/RLCoder):
  - The `RLRetriever` learns, via RL feedback from the generator, to "disregard seemingly useful yet ultimately useless reference code snippets".
  - Evaluated with **512 in-file + 1,536 cross-file context tokens** on 5 backbones, against BM25, UniXcoder and UniXcoder-SFT.
  - Follow-up: AlignCoder. — [arXiv 2601.19697](https://arxiv.org/abs/2601.19697)
- **Repoformer** (ICML 2024) — [Repoformer README](https://github.com/amazon-science/Repoformer):
  - **Selective retrieval.** The model learns when retrieval helps. Labels come from running inference **with and without** retrieved context ("RAG simulation").
  - Default retriever is Jaccard similarity. Data is built at both chunk and function granularity.
- **cAST** (EMNLP 2025 Findings) and **astchunk** — [astchunk README](https://github.com/yilinjz/astchunk):
  - AST-based chunking that respects syntactic boundaries.
  - `max_chunk_size` is measured in **non-whitespace characters**.
  - Optional `chunk_overlap` counted in **AST nodes**.
  - `chunk_expansion` prepends a metadata header; `repo_level_metadata` adds repository name and file path.
- **Chunking in the localization systems**:
  - LocAgent's content BM25 uses Moatless's `EpicSplitter`: 100–2,000 tokens, target 500. — [bm25_retriever.py](https://github.com/gersteinlab/LocAgent/blob/master/plugins/location_tools/retriever/bm25_retriever.py)
  - SweRank retrieves at **function granularity** (positives are the functions modified by the patch). — [SweRank README](https://github.com/SalesforceAIResearch/SweRank)
  - CoRet adds **file path + call-graph context** to what it embeds, worth +6 recall points. — [ACL Anthology](https://aclanthology.org/2025.acl-short.62/)

### Inferences
**Chunking for graph-indexer.** The convergent practice is:
- Chunk at function or class boundaries (the entity is the retrieval unit).
- Split oversize entities by grouping sibling AST nodes under a non-whitespace size budget (cAST-style).
- Prepend a header with path, qualified name and signature before BM25 or embedding (cAST expansion; CoRet's path signal).
- Keep module-level code, such as top-level statements and constants, as its own chunk.

**Graph signals to add, statically:**
- Call and import edges (RepoHyper, LocAgent).
- Type-sensitive "uses/defines" dataflow edges (DraCo, CodexGraph's USES). This is feasible with Tree-sitter for assignments, imports and attribute access within a file, with cross-file resolution by import.

**Carry Repoformer and RLCoder over as behaviour, not models.** The server should return a small high-precision set and explicitly say when nothing is confident, because irrelevant context hurts (the same pattern as RepoGraph's 2-hop result).

**Avoid RepoHyper-style whole-program call-graph construction.** PyCG's memory footprint is unsuitable for a CPU-only local server. Prefer LocAgent-style scoped name resolution.

### Gaps
- No numbers retrieved for RepoCoder, RepoHyper, DraCo, RLCoder, Repoformer or cAST: EM/ES gains, Recall@5 on RepoEval or SWE-bench, pass@k.
- **GraphCoder** (code context graph with control-flow and data-dependence edges) and **CodeRAG (2025, requirement/code bigraph)**: no data could be retrieved. The repositories were not located and search was exhausted.
- cAST's reported gains over line-based chunking are unconfirmed. From memory they are in single-digit points of Recall@5 and Pass@1; do not use this without verification.

## Q5. Graph-based RAG relevant to code: HippoRAG / HippoRAG 2, GraphRAG, LightRAG, Aider's repo map, and evidence for personalized PageRank from seed hits

### Takeaway
Personalized PageRank (PPR) seeded from query hits is the shared core of HippoRAG and Aider's repo map.
- **HippoRAG 2** (ICML 2025) seeds PPR from query-linked entity/fact nodes and passage nodes. Its main settings are damping **0.5**, passage-node weight **0.05**, and top-5 linked nodes.
- **Aider** runs weighted PageRank over a file-level definition/reference graph built from Tree-sitter tags. It personalizes toward files in the chat and identifiers the user mentioned, then fits the rendered map into a token budget with a binary search.

Aider's graph is fully static. HippoRAG, GraphRAG and LightRAG need a **generative LLM at index time** (OpenIE or entity/relation extraction), so only HippoRAG's PPR idea, not its indexing, fits an offline server.

I found no paper measuring PPR expansion on a *code-localization* benchmark. The evidence for PPR is multi-hop QA (HippoRAG) and practical adoption (Aider). The code evidence (RepoGraph 2-hop, OrcaLoca pruning) says expansion must be ranked and bounded.

### Cited Findings
**Aider repo map (from the code)** — [repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)
- Graph construction:
  - A networkx `MultiDiGraph` whose nodes are files.
  - For each identifier that is both defined and referenced, an edge runs **referencer file → definer file**, with `weight = mul × sqrt(num_refs)`.
  - Definitions with no references get a self-edge of weight 0.1.
- Multipliers on `mul`:
  - ×10 if the identifier is mentioned in the chat.
  - ×10 if it is snake, kebab or camel case **and** at least 8 characters long.
  - ×0.1 if it starts with `_`.
  - ×0.1 if it is defined in more than 5 files (generic names).
  - ×50 when the referencer is a file already in the chat.
- Personalization:
  - Each file in the chat, each mentioned file, and each file whose path components match a mentioned identifier gets `100/len(fnames)`.
  - PageRank is `nx.pagerank(G, weight="weight", personalization=p, dangling=p)`, with no `alpha` argument (so networkx's default applies).
- Ranking and rendering:
  - Each file's rank is split across its out-edges in proportion to weight, which yields a rank per `(file, identifier)` definition.
  - Files already in the chat are excluded from the output.
- Token budget:
  - `map_tokens=1024` by default. It is multiplied by `map_mul_no_files=8` when no files are in the chat, capped by the context window.
  - A **binary search** over the number of ranked tags renders the tree and counts tokens, accepting results within **15%** of the budget (`ok_err = 0.15`). The initial guess is `max_map_tokens // 25` tags.
- Aider's docs: the map lists files with their key symbols and "the critical lines of code for each definition". The 2023 post "Building a better repository map with tree sitter" describes "a graph ranking algorithm, computed on a graph" of the repository. — [repomap.md](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/repomap.md); [2023-10-22 post](https://github.com/Aider-AI/aider/blob/main/aider/website/_posts/2023-10-22-repomap.md)
- RepoGraph's construction code reuses the same Tree-sitter tag pipeline and method names as Aider's RepoMap (`get_ranked_tags`, `render_tree`, `to_tree`). — [RepoGraph construct_graph.py](https://github.com/ozyyshr/RepoGraph/blob/main/repograph/construct_graph.py)

**HippoRAG / HippoRAG 2** — [config_utils.py](https://github.com/OSU-NLP-Group/HippoRAG/blob/main/src/hipporag/utils/config_utils.py); [HippoRAG.py](https://github.com/OSU-NLP-Group/HippoRAG/blob/main/src/hipporag/HippoRAG.py)
- Default settings:
  - `damping=0.5` ("Damping factor for ppr algorithm").
  - `passage_node_weight=0.05` ("multiplicative factor that modified the passage node weights in PPR").
  - `linking_top_k=5`.
  - `retrieval_top_k=200`.
  - Synonymy edges via KNN (`synonymy_edge_topk=2047`, similarity threshold **0.8**).
  - `qa_top_k=5`.
  - Default embedder: `nvidia/NV-Embed-v2`.
- PPR is `run_ppr(reset_prob, damping=0.5)`, where the reset vector comes from query-linked node weights.
- Claims (ICML 2025): HippoRAG 2 improves "associativity (multi-hop retrieval) and sense-making" without sacrificing simpler factual tasks. Evaluated on NQ, PopQA, NarrativeQA, MuSiQue, 2Wiki, HotpotQA and LV-Eval. — [HippoRAG README](https://github.com/OSU-NLP-Group/HippoRAG); [arXiv 2502.14802](https://arxiv.org/abs/2502.14802); HippoRAG v1: [arXiv 2405.14831](https://arxiv.org/abs/2405.14831)
- Indexing needs an LLM for OpenIE (triple extraction). The repository ships OpenIE outputs from `gpt-4o-mini` and `Llama-3.3-70B-Instruct`. — [HippoRAG README](https://github.com/OSU-NLP-Group/HippoRAG)

**LightRAG / GraphRAG**
- LightRAG exists and is cited. — [arXiv 2410.05779](https://arxiv.org/abs/2410.05779); [LightRAG repo](https://github.com/HKUDS/LightRAG)
- No numbers were retrieved for either. See Gaps.

### Inferences
**PPR for graph-indexer** (a static, CPU-cheap `repo_map` or `expand` tool):
- Nodes are *entities*, not files, which is finer than Aider.
- Seeds are the top BM25/embedding hits (weighted by normalized score), plus identifiers and paths found in the query, plus files the agent has open or has edited.
- Edges are weighted by type. Invokes and imports should be heavier than contains; generic, short or private names should be down-weighted with Aider's multipliers; use `sqrt(ref_count)`.
- Output is ranked entities rendered under a token budget with Aider's binary search.

**Damping.** HippoRAG uses 0.5, a strong restart that keeps mass near the seeds, while Aider uses networkx's default. For localization, where neighbours beyond 2 hops rarely help (RepoGraph 2-hop, LocAgent depth-2 default), a restart probability around 0.3–0.5 is the better-supported prior. **This is an inference to validate on SWE-bench Lite / Loc-Bench.**

**Don't copy GraphRAG, LightRAG or HippoRAG *indexing*.** Their LLM extraction violates the offline/CPU constraint. For code, the Tree-sitter symbol graph already provides the entity and relation layer that OpenIE builds for text.

### Gaps
- No direct evidence found for "PPR expansion from seed hits improves code-localization recall". This is a clear opportunity for graph-indexer's own evaluation.
- HippoRAG (v1/v2) recall numbers were not retrieved: Recall@2/@5 on MuSiQue, 2Wiki, HotpotQA, and the gains over ColBERTv2 or NV-Embed-v2.
- GraphRAG (community summaries, global queries) and LightRAG (dual-level retrieval) evaluation numbers were not retrieved.
- Aider has published no quantitative ablation of its repo map, as far as the code and docs show.

## Q6. Empirical studies of where agents fail on SWE tasks: how much is wrong or incomplete localization, and missing impact awareness

### Takeaway
2025 trajectory studies suggest file-level localization is **mostly not** the binding constraint for strong agents. 72–81% of trajectories identify the right files even when they fail. Failures concentrate in finer-grained localization, repair correctness, and unproductive iteration loops.
- **Pipeline** systems (Agentless-style) are brittle at localization.
- **Agentic** systems localize better but get trapped in "iteration anomalies".

I found no study that quantifies "edited a function without updating its callers" (missing impact awareness) as a share of failures. That remains a gap.

### Cited Findings
- **"An Empirical Study on Failures in Automated Issue Solving"** (2025) — [arXiv 2509.13941](https://arxiv.org/abs/2509.13941) (search extract):
  - Manual analysis of **150 failed instances**.
  - Taxonomy of **3 phases** (Localization; Repair; Iteration & Validation), **9 categories** and **25 subcategories**.
  - Pipeline tools are brittle during localization. Agentic tools find bugs more reliably but often fall into "Iteration Anomalies".
- **"Understanding Code Agent Behaviour: An Empirical Study of Success and Failure Trajectories"** (2025), studying OpenHands, SWE-agent and Prometheus on SWE-Bench — [arXiv 2511.00197](https://arxiv.org/abs/2511.00197) (search extract):
  - Failed trajectories are longer and more variable.
  - **72–81% of trajectories correctly identify the problematic files even in failures.**
  - Success depends on approximate rather than exact code modifications.
  - Context gathering and defensive programming characterize successful strategies.
- **Supporting signals from system papers**:
  - RepoGraph's 2-hop context (about 10.5K tokens) underperformed the baseline: too much context hurts. — [secondary summary](https://haohoang.is-a.dev/post/repo-graph/)
  - KGCompass narrows the search space to 20 candidate functions. — [arXiv 2503.21710](https://arxiv.org/abs/2503.21710)
  - CoSIL's iterative graph search is its most important component (about −20% when removed). — [arXiv 2503.22424](https://arxiv.org/abs/2503.22424)

### Inferences
**For graph-indexer, the high-leverage additions are:**
1. Function-level precision tools: ranking within the right file, disambiguating same-named symbols.
2. Bounded, high-precision context to shorten failing loops.
3. An **impact tool**: upstream traversal over invokes, imports and inherits, returning callers and overriders of a changed entity with a confidence per edge.
   - The literature did not measure point 3, but it directly targets the "approximate vs exact modification" failure mode and the long iteration loops.
   - Treat it as a hypothesis to evaluate. One way: measure, on SWE-bench gold patches, how often multi-hunk patches touch a caller or callee of another edited function.

**File-level Acc@5 above 90% is achievable** (LocAgent 94.16%). Improvement effort should target function and line level and the agent's use of results, not file recall.

### Gaps
- Not retrieved: the exact share of failures in the Localization phase in arXiv 2509.13941 (per-category percentages), and the per-tool breakdown.
- Not retrieved: "Beyond Final Code: A Process-Oriented Error Analysis of Software Development Agents" and "An Empirical Study on LLM-based Agents for Automated Bug Fixing" (which reports file- and line-level FL accuracy per system). The search budget ran out before these queries.
- No study found that quantifies failures from incomplete propagation (callers or overrides not updated). Candidate sources to check: "Dissecting the SWE-Bench Leaderboards" ([arXiv 2506.17208](https://arxiv.org/abs/2506.17208)) and "What's in a Benchmark? The Case of SWE-Bench in APR" ([arXiv 2602.04449](https://arxiv.org/abs/2602.04449)).

## Q7. File-level vs function-level vs line-level localization metrics (Acc@k, Recall@k) and typical SOTA numbers in 2025–2026

### Takeaway
There is no single standard metric. The common ones are:
- **Acc@k**: strict; all gold locations within the top-k. Used by LocAgent, SweRank and LocBench-style evaluation at file, module and function level.
- **Recall@k**: fractional.
- **Top-1 accuracy**: CoSIL.
- **"Match rate"**: OrcaLoca, function-level.
- **Fault-localization accuracy**: KGCompass.
- **"Perfect recall"**: CoRet.

Headline numbers are therefore not directly comparable across papers. Differences in k, granularity (class-as-module), benchmark (Lite, Verified, Loc-Bench) and subsets all matter.

The mid-2025 snapshot on SWE-bench Lite:
- About **94% file Acc@5** (LocAgent + Claude-3.5).
- About **88.7% function Acc@10** (SweRank retriever + 32B reranker).
- About **65% function match** (OrcaLoca).
- About **43–45% function Top-1** (CoSIL, 32B open model).
- About **56% function-level FL** (KGCompass).

Newer 2026 numbers (SweRank+, SpIDER, neurosymbolic and RL-trained localizers) exist but were not retrieved.

### Cited Findings
- **Metric definitions** in LocAgent's evaluation code. Acc@k counts an instance correct only if every gold location that fits in the top-k is retrieved. Recall@k averages the fraction of gold found. NDCG@k, P@k and MAP@k are also provided, at levels `file`, `module` and `function`. — [eval_metric.py](https://github.com/gersteinlab/LocAgent/blob/master/evaluation/eval_metric.py)
- Reported numbers (benchmark, metric, value):

| System | Benchmark | Metric | Value | Source |
|---|---|---|---|---|
| LocAgent | SWE-Bench-Lite | file Acc@5 | **94.16%** | [arXiv 2503.09089](https://arxiv.org/abs/2503.09089) |
| LocAgent | SWE-Bench-Lite | function Acc@10 | **77.37%** | same |
| LocAgent | not stated | file-level accuracy (abstract) | **92.7%** | [LocAgent README](https://github.com/gersteinlab/LocAgent) |
| LocAgent ablation (Qwen-7B-ft) | SWE-Bench-Lite | function Acc@10 | 53–69% across ablated variants | see Q1 |
| SweRankEmbed-Large (7B) | SWE-Bench-Lite | function Acc@10 | **82.12%** | [arXiv 2505.07849](https://arxiv.org/abs/2505.07849) |
| + SweRankLLM-Large (32B) | SWE-Bench-Lite | function Acc@10 | **88.69%** | same |
| OrcaLoca | SWE-bench Lite | function match rate | **65.33%** | [arXiv 2502.00350](https://arxiv.org/abs/2502.00350) |
| CoSIL (Qwen2.5-Coder-32B) | Lite / Verified | function Top-1 | **43.3% / 44.6%** | [arXiv 2503.22424](https://arxiv.org/abs/2503.22424) |
| KGCompass | SWE-bench Lite | function-level FL accuracy | **56.0%** | [arXiv 2503.21710](https://arxiv.org/abs/2503.21710) |
| CoRet | SWE-bench Verified | perfect recall (chunk / file) | **0.53 / 0.47** (CodeSage-S: 0.35 / 0.28) | [ACL Anthology](https://aclanthology.org/2025.acl-short.62/) |
| CodeRankEmbed baseline | SWE-Bench-Lite | file Acc@3 / function Acc@5 | 76.6% / 50.0% | [arXiv 2503.09089](https://arxiv.org/abs/2503.09089) (attribution uncertain) |

- Trajectory-level file identification by agents: **72–81%**, even in failed runs. — [arXiv 2511.00197](https://arxiv.org/abs/2511.00197)
- CodeNib (non-academic, self-reported) reports file-recall@10 = 0.92 and symbol-recall@10 = 0.73 on 96 synthesized behavioural queries. Its docs describe the score as "saturated relative to the same embedder" and show a drop to about 0.65 (file) and about 0.40 (symbol) under a condition whose exact definition I did not verify. — [CodeNib docs](https://github.com/sysevol-ai/CodeNib/tree/main/docs)

### Inferences
**Recommended evaluation protocol for the graph-indexer refactor:**
- Reuse LocAgent's `eval_metric.py` definitions: file, module and function Acc@k for k ∈ {1, 3, 5, 10}, plus Recall@k and NDCG@k.
- Run on SWE-bench Lite and Verified plus Loc-Bench (post-cutoff, less contaminated).
- Report both **retrieval-only** mode (BM25 / hybrid / PPR, no LLM) and **agent-in-the-loop** mode.
- Also measure **tokens returned per tool call**, since context bloat is a documented failure driver.

**Realistic targets for a purely static, CPU-only retriever without a reranker:**
- Function Acc@10 should land between plain BM25/CodeRankEmbed-class numbers and SweRankEmbed-Small.
- Beating agentic systems requires either a trained reranker or the client agent's multi-turn use of the tools.
- This is an inference; exact baselines for BM25 at function level were not retrieved.

**Line-level localization is rarely reported in 2025 localization papers.** Most stop at function level. Line-level matters mostly inside repair pipelines (Agentless edit locations, BugCerberus statements). An index server can support it cheaply with windowed line views, without separate indexing.

### Gaps
- 2026 SOTA numbers not retrieved:
  - SweRank+ ([arXiv 2512.20482](https://arxiv.org/abs/2512.20482))
  - SpIDER ([arXiv 2512.16956](https://arxiv.org/abs/2512.16956))
  - Neurosymbolic localization ([arXiv 2604.16021](https://arxiv.org/abs/2604.16021))
  - "LLM Agents Can See Code Repositories" ([arXiv 2606.14061](https://arxiv.org/abs/2606.14061))
  - Adaptive parallel localization ([arXiv 2601.19568](https://arxiv.org/abs/2601.19568))
  - RL-based repo deep search (ToolTrain; arXiv ID not verified)
- Plain BM25 function-level Acc@k on SWE-Bench-Lite and Loc-Bench (the key baseline for a static server) was not recovered.
- Line-level metric conventions (e.g. Agentless's line-level accuracy) were not recovered.
- Whether Loc-Bench v1 has been superseded by a later version was not verified.
