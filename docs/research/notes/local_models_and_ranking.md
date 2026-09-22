# Local code-retrieval models and ranking techniques for a CPU-only, in-process Node.js indexer (2024 – Sept 2026)

> **Method and reliability note (read first).** This session's egress policy blocked direct fetching of huggingface.co, arxiv.org, github.com, jina.ai, nomic.ai, salesforce.com, lighton.ai, qwenlm.github.io, minish.ai, alphaxiv.org and medium.com, and the shared web-search budget (200 calls) ran out before the last batch. All web numbers below therefore come from **search-engine extracts of the cited pages** (model cards, papers, vendor posts), not from full-page reads. Numbers that conflict, come from secondary aggregators, or whose conditions were unclear are flagged inline. Items I believe but could **not** verify here are listed only under **Gaps**, labelled "unverified recollection". graph-indexer's own measurements are cited by repo-relative path (bench host: Apple M2 Mac mini, per [BENCH_SUMMARY.md](../../docs/benchmarks/BENCH_SUMMARY.md)).
>
> **Score comparability warning.** "CoIR" (original `coir` harness, 10 datasets), "MTEB CoIR" (mteb implementation), "MTEB(Code, v1)" and vendor-picked "MTEB Code average" subsets are **different numbers and should not be compared across rows**. See Q1 findings on mteb issue #1861.

---

## Q1. Which code embedding models are best for CPU-local use? Specs, licenses, scores, ONNX/transformers.js availability, prefixes

### Takeaway
No permissively licensed, transformers.js-ready model is best everywhere. The strongest *verified* permissive small code retriever is **CodeRankEmbed** (137M, MIT; CoIR 60.1, CodeSearchNet MRR 77.9), but no official ONNX port turned up. At 0.3–0.6B, **Qwen3-Embedding-0.6B** (MTEB(code) 75.41) and **EmbeddingGemma-300m** (MTEB Code 68.76, Gemma license) both have `onnx-community` ONNX ports for transformers.js. The top small code specialists from 2025–26 (jina-code-embeddings 0.5b/1.5b, SFR-Embedding-Code 400M/2B) are non-commercial or likely non-commercial. Models of 1.5B–7B (bge-code-v1, nomic-embed-code, C2LLM-7B, SFR-7B) are too slow for in-process CPU indexing.

### Cited Findings

**Benchmark context and comparability**
- CoIR has 10 curated code datasets covering 8 retrieval tasks across 7 domains (~2M documents). No single model dominates all tasks. In its early evaluation, Voyage-Code-002 had a mean of 56.26 — [CoIR paper](https://arxiv.org/html/2407.02883v3)
- The `coir` library and `mteb` give very different CoIR scores. Maintainers could not reproduce gte-modernbert-base's CoIR results with the coir library, but mteb matched the authors' numbers. Discrepancies of similar size were seen for SFR and Voyage. The CoIR team acknowledges this ("Why the Results on the MTEB and CoIR Leaderboards Differ?") — [mteb issue #1861](https://github.com/embeddings-benchmark/mteb/issues/1861); [CoIR repo](https://github.com/coir-team/coir)

**CodeRankEmbed — `nomic-ai/CodeRankEmbed` (mirror: `cornstack/CodeRankEmbed`)**
- 137M bi-encoder with 8192-token context, built on Arctic-Embed-M-Long. It was fine-tuned with InfoNCE on the CoRNStack dataset (21M examples) — [HF cornstack/CodeRankEmbed](https://huggingface.co/cornstack/CodeRankEmbed)
- The query must carry the task-instruction prefix "Represent this query for searching relevant code" — [HF README](https://huggingface.co/nomic-ai/CodeRankEmbed/blob/1b6c1978d5308da3eb901b57d73cea914ebd6be8/README.md)
- License: MIT — [PromptLayer model page](https://www.promptlayer.com/models/coderankembed/)
- Scores 77.9 MRR on CodeSearchNet and 60.1 NDCG@10 on CoIR. It beats the 10x larger CodeSage-Large (1.3B) — [CoRNStack paper](https://arxiv.org/html/2412.01007v3)
- Paired with BM25 ("CodeRankEmbed Hybrid"), it reached NDCG@10 **0.862** on Semble's CPU-only benchmark (~1,250 queries, 63 repos, 19 languages). BM25 alone scored 0.673 — [Semble benchmarks](https://github.com/MinishLab/semble/blob/main/benchmarks/README.md)
- It is the teacher model distilled into the static potion-code-16M (see Q2) — [HF minishlab/potion-code-16M](https://huggingface.co/minishlab/potion-code-16M)

**nomic-embed-code — `nomic-ai/nomic-embed-code` (7B)**
- A 7B code embedder that outperforms Voyage Code 3 and OpenAI Embed 3 Large on CodeSearchNet — [Nomic announcement](https://www.nomic.ai/news/introducing-state-of-the-art-nomic-embed-code); [Simon Willison](https://simonwillison.net/2025/Mar/27/nomic-embed-code/)
- Training data, code and weights are all released under Apache-2.0 — [Nomic announcement](https://www.nomic.ai/news/introducing-state-of-the-art-nomic-embed-code)
- GGUF build: `nomic-ai/nomic-embed-code-GGUF` — [HF](https://huggingface.co/nomic-ai/nomic-embed-code-GGUF)
- Caution: one search extract credited nomic-embed-code with "+13.80% / +16.81% over OpenAI-v3-large / CodeSage-large on 32 datasets". Those figures belong to **voyage-code-3** (see API-only below).

**jina-embeddings-v2-base-code — `jinaai/jina-embeddings-v2-base-code`**
- Covers English plus 30 programming languages and is optimized for code and docstring search — [Zilliz model guide](https://zilliz.com/ai-models/jina-embeddings-v2-base-code)
- In CodeRAG-Bench, code-specific retrievers (Jina-v2-code, Voyage-code) consistently beat general-purpose embeddings, and dense retrievers often beat BM25 — [CodeRAG-Bench](https://arxiv.org/pdf/2406.14497) (via [review](https://www.themoonlight.io/en/review/coderag-bench-can-retrieval-augment-code-generation))
- graph-indexer already uses it as the in-process "code-local" default (768-d; a `Xenova/jina-embeddings-v2-base-code` port is referenced). The shipped pipeline loads it at fp32, at **~1–3 chunks/s** with no q8 option, so it was left out of the latest benchmark matrix — [embeddings.mjs](../../embeddings.mjs); [BENCH_SUMMARY.md](../../docs/benchmarks/BENCH_SUMMARY.md)

**jina-code-embeddings — `jinaai/jina-code-embeddings-0.5b`, `jinaai/jina-code-embeddings-1.5b` (2025)**
- The 0.5b has 494M parameters. It scores 78.41 overall average and **78.72 "MTEB Code" average**, with 85.73 on CoIR-CodeSearchNet, 95.98 on Doc2Code and 90.37 on CodeTransOceanContest. Jina reports it beating Qwen3-Embedding-0.6B, jina-embeddings-v4 (74.11) and gemini-embedding-001 (77.38) — [Jina announcement](https://jina.ai/news/jina-code-embeddings-sota-code-retrieval-at-0-5b-and-1-5b/); [EmergentMind summary](https://www.emergentmind.com/topics/jina-code-embeddings-0-5b)
- The models are built from code-generation LLM backbones. Evaluation covered MTEB-CoIR, CodeSearchNetRetrieval, CodeEditSearchRetrieval, MBPP, HumanEval, CoSQA+ and cross-language sets — [paper, arXiv 2508.21290](https://arxiv.org/html/2508.21290v1)

**Qwen3-Embedding-0.6B — `Qwen/Qwen3-Embedding-0.6B`**
- Scores **75.41 on MTEB(code, v1)** (Table 5) — [Qwen3 Embedding paper](https://arxiv.org/pdf/2506.05176)
- Transformers.js ONNX port: `onnx-community/Qwen3-Embedding-0.6B-ONNX`. Community ONNX ports: `zhiqing/Qwen3-Embedding-0.6B-ONNX` and `shawnw3i/Qwen3-Embedding-0.6B-ONNX`. Official GGUF: `Qwen/Qwen3-Embedding-0.6B-GGUF` — [HF onnx-community](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX); [HF zhiqing](https://huggingface.co/zhiqing/Qwen3-Embedding-0.6B-ONNX); [HF GGUF](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF)
- Agent Retrieval Bench (Jul 2026; 427 samples, 25 repos) found no single retrieval family dominates. Qwen3-Embedding-4B had the best sample-weighted MRR, 8B the best Recall@20, and RepoMap the best context yield within 8K tokens. Agent trajectories never touched a gold file in 27–35% of samples — [arXiv 2607.24882](https://arxiv.org/html/2607.24882v1)

**EmbeddingGemma-300m — `google/embeddinggemma-300m`**
- MTEB Code mean(task) = **68.76** — [HF model card](https://huggingface.co/google/embeddinggemma-300m); [CodeSOTA](https://www.codesota.com/model/embeddinggemma-300m)
- Query prompt format is `task: {task description} | query: {content}`, with a code-retrieval task variant — [HF model card](https://huggingface.co/google/embeddinggemma-300m)
- Outputs 768 dims, which can be truncated via MRL to 512/256/128. Quantization-aware-trained checkpoints exist (int4 per-block, int8 per-block, mixed), keeping RAM under 200 MB — [Google Developers Blog](https://developers.googleblog.com/en/introducing-embeddinggemma/); [ai.google.dev](https://ai.google.dev/gemma/docs/embeddinggemma)
- The paper reports large gains on NL→code tasks: AppsRetrieval (+37.6) and CosQA (+10.0). The extract does not say what the baseline was — [EmbeddingGemma paper](https://arxiv.org/pdf/2509.20354)
- Transformers.js ONNX: `onnx-community/embeddinggemma-300m-ONNX` — [HF](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX); usage thread: [transformers.js #1418](https://github.com/huggingface/transformers.js/issues/1418)

**Granite Embedding R2 (ModernBERT-based, Aug 2025)**
- Two English models: `ibm-granite/granite-embedding-english-r2` (149M, 768-d) and `ibm-granite/granite-embedding-small-english-r2` (47M, 384-d). New code training data raised CoIR by +5.0 (149M) and +6.8 (47M) over R1. Average retrieval NDCG@10 across MTEB v2, CoIR, TableIR, LongEmbed, MTRAG and MLDR is 59.5 (149M) and 55.6 (47M) — [Granite R2 paper](https://arxiv.org/pdf/2508.21085); [MarkTechPost](https://www.marktechpost.com/2025/09/12/ibm-ai-research-releases-two-english-granite-embedding-models-both-based-on-the-modernbert-architecture/)
- Encoding speed on an H100 (batch 128): small-r2 199 docs/s, english-r2 144 docs/s, e5-small-v2 and bge-small 138 docs/s. These are GPU numbers, and the document length was not given in the extract — [Granite R2 blog](https://huggingface.co/blog/hansolosan/granite-embedding-r2)
- Granite R1 already outperformed same-size models on CoIR without code-retrieval training data — [Granite R1 paper](https://arxiv.org/pdf/2502.20204)
- The Multilingual R2 models (May 2026) are 97M (~2,900 docs/s) and 311M (~2,000 docs/s), measured on an H100 at batch 1024 × 512 tokens — [arXiv 2605.13521](https://arxiv.org/html/2605.13521v2)
- LateOn-Code-edge-pretrain (17M) beats granite-embedding-small-english-r2 (48M) by 1.7 points on average — [LightOn HF blog](https://huggingface.co/blog/lightonai/colgrep-lateon-code)

**SFR-Embedding-Code / CodeXEmbed — `Salesforce/SFR-Embedding-Code-400M_R`, `Salesforce/SFR-Embedding-Code-2B_R`**
- CoIR NDCG@10: 61.9 (400M) and 67.4 (2B) — [HF 400M_R](https://huggingface.co/Salesforce/SFR-Embedding-Code-400M_R)
- License: cc-by-nc-4.0 (research only) — [HF 2B_R README](https://huggingface.co/Salesforce/SFR-Embedding-Code-2B_R/raw/8041ca86014930f5cde7da3f6614149530e85122/README.md)
- The 7B variant topped the CoIR leaderboard at release, more than 20% ahead of second place — [Salesforce blog](https://www.salesforce.com/blog/sfr-embedding-code/); [CodeXEmbed paper](https://arxiv.org/pdf/2411.12644)

**C2LLM — `codefuse-ai/C2LLM-0.5B` and C2LLM-7B (Dec 2025)**
- Built on Qwen2.5-Coder backbones with Pooling-by-Multihead-Attention and trained on 3M public examples. MTEB-Code: 7B **80.75** (#1), 0.5B **75.46** (best sub-1B at publication, ahead of INF-Retriever-7B at 69.70) — [C2LLM tech report](https://arxiv.org/abs/2512.21332); [HF](https://huggingface.co/codefuse-ai/C2LLM-0.5B)
- Conflict: C2LLM's "best sub-1B at 75.46" claim does not fit jina-code-embeddings-0.5b's "78.72 MTEB Code average". The two most likely use different task subsets or leaderboard entries.

**gte-modernbert-base — `Alibaba-NLP/gte-modernbert-base`**
- 149M parameters, 8192 tokens. The model card reports **CoIR 79.31** (MTEB 64.38) — [HF](https://huggingface.co/Alibaba-NLP/gte-modernbert-base). A secondary search extract gave "71.5", which conflicts. Numbers of this kind come from the mteb implementation, which the `coir` library could not reproduce — [mteb #1861](https://github.com/embeddings-benchmark/mteb/issues/1861). **Do not compare them with CodeRankEmbed's 60.1.**

**bge-code-v1 — `BAAI/bge-code-v1`**
- A 1.5B LLM-based code embedder: NL queries in English and Chinese, 20 programming languages. BAAI claims SOTA on CoIR and CodeRAG — [HF](https://huggingface.co/BAAI/bge-code-v1)
- Users report poor results on the Apps subset when reproducing it on CoIR — [evalscope #601](https://github.com/modelscope/evalscope/issues/601)

**mDenseOn / mLateOn (LightOn, Jul 2026) — `lightonai/mDenseOn`, `lightonai/mLateOn`**
- 307M multilingual models with 8192 context. MTEB Code: mLateOn **73.48**; mDenseOn **71.53** (second-best sub-350M dense), using code data only at the fine-tuning stage. The paper describes them as "fully open", and English counterparts (DenseOn/LateOn) exist — [HF blog](https://huggingface.co/blog/lightonai/mdenseon-mlateon); [paper arXiv 2607.27178](https://arxiv.org/html/2607.27178)

**API-only models (reference only, not local)**
- voyage-code-3: averages +13.80% over OpenAI-v3-large and +16.81% over CodeSage-large across 32 code-retrieval datasets. Offers 2048/1024/512/256 Matryoshka dims and float/int8/uint8/binary/ubinary outputs — [Slashdot product page (secondary)](https://slashdot.org/software/p/voyage-code-3/)
- Codestral Embed (Mistral, May 2025) claims to beat competitors on SWE-Bench-derived retrieval, even at 256 dims in int8. Its dimensions are ordered by relevance, so they can be truncated — [Simon Willison](https://simonwillison.net/2025/May/28/codestral-embed/); [VentureBeat](https://venturebeat.com/ai/mistral-launches-new-code-embedding-model-that-outperforms-openai-and-cohere-in-real-world-retrieval-tasks)

**2026 agentic code-retrieval benchmarks and tools**
- CORE-Bench (arXiv 2606.11864) has more than 180K queries and 106K broader-context labels, built from code-search tasks and SWE-bench-series instances. It has three levels: code understanding, issue-to-edit localization and broader-context retrieval. It reports NDCG@10/Recall@100, includes BM25 as the sparse baseline, and finds a large gap between classic code understanding and repo-level retrieval — [arXiv](https://arxiv.org/html/2606.11864); [eval repo](https://github.com/zhangfw123/CORE-Bench-Eval)
- contextmaxxer (self-reported) is a local MCP retrieval tool with a 161M encoder and ~1 s per tool call. On SWE-Explore (848 instances) it gets 2.4x the file coverage of the best classical retriever (BM25/TF-IDF) at 5 results. A fine-tune of its 161M encoder, trained only on SWE-Bench++, beats CORE-Bench's 7B specialized retriever on NDCG@10 — [GitHub](https://github.com/codeus-morbid/contextmaxxer)

### Inferences
- **Candidate matrix for graph-indexer.** Assembled from the findings above. "?" means not verified this session; see Gaps.

| Tier | Model (HF id) | Params | Dims | License | Best verified code signal | In-process route | Query prefix |
|---|---|---|---|---|---|---|---|
| Static | `minishlab/potion-code-16M-v2` | 16M | 256 | ? | Hybrid with BM25: 0.854 NDCG@10 (Semble) | ONNX `rxdtech/potion-code-16M-v2-onnx`, or pure JS (Q2) | ? |
| Late-interaction, tiny | `lightonai/LateOn-Code-edge` | 17M | multi-vector | ? | MTEB Code 66.64 | PyLate; ONNX ? | ? |
| Small dense | `ibm-granite/granite-embedding-small-english-r2` | 47M | 384 | ? | CoIR +6.8 vs R1 (absolute ?) | ONNX ? | ? |
| Base, code | `nomic-ai/CodeRankEmbed` | 137M | ? | MIT | CoIR 60.1; CSN MRR 77.9; hybrid 0.862 | No ONNX found (export needed) | "Represent this query for searching relevant code" |
| Base, code | `jinaai/jina-embeddings-v2-base-code` | ? | 768 | ? | Strong in CodeRAG-Bench | Already running (Xenova port, fp32) | ? |
| Base, general+code | `ibm-granite/granite-embedding-english-r2` / `Alibaba-NLP/gte-modernbert-base` | 149M | 768 / ? | ? | CoIR +5.0 vs R1 / 79.31 (mteb harness) | ONNX ? | ? |
| Late-interaction, base | `lightonai/LateOn-Code` | 130M | multi-vector | ? | "tops MTEB Code" for its size (number ?) | PyLate; ONNX ? | ? |
| 0.3B | `google/embeddinggemma-300m` | 300M class | 768 (MRL 512/256/128) | ? | MTEB Code 68.76 | `onnx-community/embeddinggemma-300m-ONNX` | `task: … \| query: …` |
| 0.3B | `lightonai/mDenseOn` | 307M | ? | "fully open" | MTEB Code 71.53 | ? | ? |
| 0.5–0.6B | `Qwen/Qwen3-Embedding-0.6B` | 0.6B | ? | ? | MTEB(code) 75.41 | `onnx-community/Qwen3-Embedding-0.6B-ONNX` | instruction (format ?) |
| 0.5–0.6B | `codefuse-ai/C2LLM-0.5B` | 0.5B | ? | ? | MTEB-Code 75.46 | None found | ? |
| 0.5B, NC? | `jinaai/jina-code-embeddings-0.5b` | 494M | ? | ? | "MTEB Code avg" 78.72 | ? | task prefixes |
| NC | `Salesforce/SFR-Embedding-Code-400M_R` | 400M | ? | CC-BY-NC-4.0 | CoIR 61.9 | ? | ? |
| Too big for CPU | nomic-embed-code 7B, C2LLM-7B, SFR-2B/7B, bge-code-v1 1.5B | ≥1.5B | – | mixed | – | GGUF (nomic) via llama.cpp/Ollama | – |

- **Why MiniLM underperforms on NL→code.** It is a general-purpose model. Every code-specialized entry above, even the 16M static potion-code, was trained on code/NL pairs (CoRNStack or CoIR train sets). The Semble result (BM25 0.673 → 0.854 once a code-trained static channel is fused) mirrors graph-indexer's setup (strong BM25 plus a weak dense channel), so replacing the dense channel is the lever the evidence best supports.
- **Best permissive quality-per-CPU picks:** (a) potion-code-16M-v2 as an always-on dense channel; (b) CodeRankEmbed, once exported to ONNX (its Arctic/Nomic-BERT base is likely convertible, but that is unverified), or granite-embedding-english-r2 / gte-modernbert-base for a base-size tier; (c) Qwen3-Embedding-0.6B or EmbeddingGemma for an opt-in "quality" tier, only if the user accepts much slower indexing (Q7). EmbeddingGemma's license terms need checking before it becomes a default.
- **Make prefixes config-driven per model.** CodeRankEmbed (query-only instruction), EmbeddingGemma (`task: … | query:` template) and Qwen3 (instruction) all need them. Wrong or missing prefixes are a common silent quality loss, and an embedding cache must be keyed by (model, prefix, dims).
- **Choose models on graph-indexer's own benchmark**, not leaderboard deltas. CoIR scores vary by harness (mteb #1861), and agentic benchmarks (Agent Retrieval Bench, CORE-Bench) show that no family dominates.

### Gaps
- **Unverified recollections; check on the model cards:**
  - CodeRankEmbed: 768 dims; the exact query prefix is probably `"Represent this query for searching relevant code: "` (with a trailing colon and space); documents take no prefix; NomicBERT architecture (trust_remote_code). No official ONNX folder.
  - jina-embeddings-v2-base-code: 161M, 768-d, 8192 context (ALiBi). I believe the license is Apache-2.0, **but graph-indexer's `embeddings.mjs` comment says MIT**. Resolve before shipping.
  - Qwen3-Embedding-0.6B: Apache-2.0; 1024-d with MRL (32–1024); 32K context; queries use `Instruct: {task}\nQuery:{q}` and documents take no instruction; last-token pooling.
  - EmbeddingGemma: about 100M transformer params plus ~200M embedding-table params; 2048 context; Gemma Terms of Use; document prompt `title: none | text: {content}`; MRL-truncated MTEB Code scores; the ONNX port may not support fp16.
  - jina-code-embeddings: CC-BY-NC-4.0; Qwen2.5-Coder backbones; 896/1536 dims with MRL; ~32K context; task-specific prefixes such as "Find the most relevant code snippet given the following query:".
  - Granite R2 and gte-modernbert-base: Apache-2.0, 8192 context, no prefixes.
- **Not found (search budget exhausted):**
  - Absolute CoIR numbers for the Granite R2 models.
  - bge-code-v1 CoIR/CodeRAG scores and license.
  - C2LLM license and dims.
  - LateOn-Code (130M) exact MTEB Code score and license.
  - CodeSearch-ModernBERT (Shuu12121) models.
  - snowflake-arctic-embed (m-v2.0 / l-v2.0) code-retrieval scores. The only link found is that CodeRankEmbed is built on Arctic-Embed-M-Long.
  - CoSQA/CoSQA+ numbers for most small models.
  - Any official ONNX port of CodeRankEmbed.
- **Identified but not read:** "One prompt is not enough: Instruction Sensitivity Undermines Embedding Model Evaluation" ([arXiv 2605.22544](https://arxiv.org/pdf/2605.22544)); "ExecRetrieval: Measuring the Functional-Correctness Gap in Code-Embedding Retrieval" ([arXiv 2609.01865](https://arxiv.org/html/2609.01865)); "Dense Retrievers Can Fail on Simple Queries" ([arXiv 2506.08592](https://arxiv.org/pdf/2506.08592)); CORE-Bench's per-model tables.

---

## Q2. Static / ultra-fast embeddings: quality vs speed on code, and can they run in pure JS without ONNX?

### Takeaway
A **code-specific static model**, `minishlab/potion-code-16M-v2` (16M params, 256-d, distilled from CodeRankEmbed), fused with BM25 via RRF, reaches **0.854 NDCG@10** on Semble's CPU-only benchmark. That is within 0.008 of CodeRankEmbed+BM25 (0.862) and far above BM25 alone (0.673), while indexing ~218x faster. Static inference is just tokenize → look up → mean-pool, so it can run in pure JS with no ONNX runtime.

### Cited Findings
- potion-code-16M was distilled from `nomic-ai/CodeRankEmbed` and trained on the CornStack corpus using Tokenlearn plus contrastive fine-tuning. It powers Semble, a code-search library for agents. Static embeddings compute "orders of magnitude faster than transformer-based models on both GPU and CPU" — [HF minishlab/potion-code-16M](https://huggingface.co/minishlab/potion-code-16M)
- potion-code-16M-v2 uses static lookup vectors, 256 dims and 16M params, and needs no GPU or model server — [HF minishlab/potion-code-16M-v2](https://huggingface.co/minishlab/potion-code-16M-v2)
- The ONNX export `rxdtech/potion-code-16M-v2-onnx` runs "with onnxruntime or transformers.js, without depending on the model2vec package" — [HF rxdtech/potion-code-16M-v2-onnx](https://huggingface.co/rxdtech/potion-code-16M-v2-onnx)
- Semble's method: tree-sitter code-aware chunks, scored by (1) potion-code-16M static embeddings and (2) BM25 "for lexical matches on identifiers and API names", fused with **Reciprocal Rank Fusion** — [Semble README](https://github.com/MinishLab/semble/blob/main/README.md)
- Semble's benchmark covers ~1,250 queries over 63 repos in 19 languages, CPU-only. NDCG@10: Semble **0.854**, CodeRankEmbed Hybrid **0.862**, BM25 **0.673**. Semble indexes **218x** faster and answers queries **11x** faster, reaching "99% of the retrieval quality" — [Semble benchmarks](https://github.com/MinishLab/semble/blob/main/benchmarks/README.md). Another version of the claim says "~220x index time, ~17x query latency" — [HF potion-code-16M-v2](https://huggingface.co/minishlab/potion-code-16M-v2). The speed ratios differ between versions.
- ivygrep made potion-code-16m-v2 its default. On CodeSearchNet-python (281,109 chunks, 300 queries), "hash-mode" nDCG@10 was 0.847. The meaning of "hash-mode" was not explained in the extract — [ivygrep PR #414](https://github.com/bvolpato/ivygrep/pull/414)
- Model2Vec takes the mean of all token embeddings in a sentence, so it is fully uncontextualized. It shrinks a Sentence Transformer by up to 50x, to models of ~8–30 MB on disk — [model2vec GitHub](https://github.com/MinishLab/model2vec)
- A pure-managed C# port (Model2Vec.Net) loads `model.safetensors` + `tokenizer.json` + `config.json` and computes embeddings "without Python, native libraries, or ONNX", using standard WordPiece/BPE tokenizers — [Model2Vec.Net](https://github.com/ericstj/Model2Vec.Net). The search surfaced no dedicated npm package.
- `sentence-transformers/static-retrieval-mrl-en-v1` (released 15 Jan 2025) runs 100x–400x faster on CPU than all-mpnet-base-v2 / multilingual-e5-small and keeps at least 85% of their quality. Halving the dimensions cost only 1.47% in quality for a 2x retrieval speed-up — [HF blog: static embeddings](https://huggingface.co/blog/static-embeddings); [model](https://huggingface.co/sentence-transformers/static-retrieval-mrl-en-v1)

### Inferences
- **Pure-JS feasibility is high.** Inference is: (1) tokenize with the model's `tokenizer.json`, using the pure-JS tokenizer already in `@huggingface/transformers` (`AutoTokenizer`) or a minimal WordPiece implementation; (2) gather rows from a `Float32Array` read out of `model.safetensors` (an 8-byte header length, then a JSON header, then raw little-endian tensors, which is trivial to parse); (3) mean-pool; (4) L2-normalize. That is ~100 lines with zero native dependencies, which suits graph-indexer's air-gapped, optional-dependency design. This follows the Model2Vec.Net design; it has not been tested in JS.
- **Expected cost.** At 256 dims, 500k chunks take 512 MB in float32, 128 MB in int8 and 16 MB in binary. Embedding cost is dominated by tokenization, likely thousands of chunks/s in Node, so re-indexing a monorepo takes seconds to minutes. This is an extrapolation from the "orders of magnitude" and 218x claims.
- **Quality caveat.** Static vectors ignore word order and context. Semble's numbers are for hybrid (BM25 + static) retrieval; the static channel alone is surely weaker. It fits graph-indexer's existing RRF architecture as a drop-in dense channel that is "never cold".
- A general static model (static-retrieval-mrl-en-v1) is not code-trained. For code, prefer potion-code-16M-v2, which is distilled from a code teacher.

### Gaps
- License of potion-code-16M/-v2 (believed MIT; unverified).
- Standalone NDCG of potion-code-16M-v2 without BM25, and any per-query-type breakdown (symbol vs NL) in Semble's benchmark. The page was blocked.
- Whether transformers.js's JS tokenizer reproduces the model's tokenizer exactly (normalization, lowercasing), and whether the potion-code tokenizer is WordPiece or BPE.
- Whether a Model2Vec distillation of a stronger or licensed teacher (e.g. Qwen3-Embedding-0.6B) exists for code. None was found.

---

## Q3. CPU rerankers and late-interaction models for code: measured gains and latency

### Takeaway
Code-aware rerankers exist, but the strongest ones are non-commercial: jina-reranker-v2 (CodeSearchNet MRR@10 71.36), jina-reranker-v3 (CoIR 70.64) and jina-reranker-v3.5 (Jul 2026) are all CC-BY-NC. The permissive, transformers.js-ready option is **Qwen3-Reranker-0.6B** (`onnx-community/Qwen3-Reranker-0.6B-ONNX`, MTEB-Code 73.42). However, 73.42 is *below* the 75.41 its own 0.6B embedder scores on MTEB(code). A small reranker pays off mainly on top of a weak first stage, which is graph-indexer's current situation. graph-indexer's own test: the general MS-MARCO MiniLM cross-encoder lifted pooled semantic rank-1 from 0.19 to 0.26, versus 0.42 for a 7B generative judge. Tiny late-interaction models (LateOn-Code-edge 17M, MTEB Code 66.64; mxbai-edge-colbert 17M/32M) are the most CPU-efficient contextual option.

### Cited Findings
**Cross-encoder and listwise rerankers**
- `jinaai/jina-reranker-v2-base-multilingual` is a cross-encoder scoring 71.36 MRR@10 on CodeSearchNet. It is available as ONNX, Safetensors and Transformers.js, with 6x the throughput of v1 thanks to Flash Attention 2 — [HF model card](https://huggingface.co/jinaai/jina-reranker-v2-base-multilingual); [Jina announcement](https://jina.ai/news/jina-reranker-v2-for-agentic-rag-ultra-fast-multilingual-function-calling-and-code-search/)
- `jinaai/jina-reranker-v3` is a 0.6B listwise "last but not late interaction" reranker: query and all candidates share one causal context. CoIR **70.64**; BEIR 61.94 (+4.88% over v2). License CC BY-NC 4.0 — [arXiv 2509.25085](https://arxiv.org/html/2509.25085v1); [Jina announcement](https://jina.ai/news/jina-reranker-v3-0-6b-listwise-reranker-for-sota-multilingual-retrieval/)
- `jinaai/jina-reranker-v3.5` (released 20 Jul 2026) is a 0.6B listwise reranker using hybrid attention (3 sliding-window layers plus 2 global layers) and self-distillation. BEIR 63.20, matching a 4B model with ~7x fewer params. License CC BY-NC 4.0; drop-in replacement for v3 — [arXiv 2607.18152](https://arxiv.org/abs/2607.18152); [HF](https://huggingface.co/jinaai/jina-reranker-v3.5)
- `Qwen/Qwen3-Reranker-0.6B` scores **MTEB-Code 73.42**. That was measured on the retrieval subsets of MTEB (Code), reranking the top-100 candidates from Qwen3-Embedding-0.6B — [HF model card](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B)
- `onnx-community/Qwen3-Reranker-0.6B-ONNX` targets **Transformers.js v4**, with ORT graph optimization (level 2) that fuses grouped-query attention into `com.microsoft.GroupQueryAttention`. Other ports: `zhiqing/Qwen3-Reranker-0.6B-ONNX` and a sequence-classification conversion `tomaarsen/Qwen3-Reranker-0.6B-seq-cls` — [HF onnx-community](https://huggingface.co/onnx-community/Qwen3-Reranker-0.6B-ONNX); [HF seq-cls](https://huggingface.co/tomaarsen/Qwen3-Reranker-0.6B-seq-cls)
- For comparison, Qwen3-Embedding-0.6B alone scores **75.41** on MTEB(code, v1) — [Qwen3 Embedding paper](https://arxiv.org/pdf/2506.05176)

**graph-indexer's own reranker measurements (small n, directional)**
- Setup: the lexical channel, with the reranker reordering the top-8 of the top-10 on NL queries, 31 pooled agent-style queries. Semantic rank-1 was **0.19 → 0.26** with the cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`) and **0.42** with a generative judge (qwen-coder-7b via Ollama). MRR went 0.35 → 0.41 / 0.53. Symbolic rank-1 wobbled from 0.80 to 0.76 with the cross-encoder. The cross-encoder costs "~tens of ms per query". Per suite it helped on Go/Python (gin 0.20→0.40, fastapi 0.14→0.29) and was mixed on JS/TS (express 0.43→0.29, nestjs flat) — [IMPROVEMENT_CROSS_ENCODER.md](../../docs/internals/IMPROVEMENT_CROSS_ENCODER.md)
- On express (JS), the Ollama nomic + rerank configuration raised held-out rank-1 (0.58→0.63) but regressed tuning rank-1 (0.65→0.57, "the rerank tax on JS"), so it was rejected — [BENCH_PER_FIXTURE.md](../../docs/benchmarks/BENCH_PER_FIXTURE.md)

**Late-interaction (ColBERT-style) models**
- LateOn-Code (LightOn) comes in two sizes: `lightonai/LateOn-Code-edge` (17M) and `lightonai/LateOn-Code` (130M). They are PyLate models pre-trained CoRNStack-style, then fine-tuned on CoIR train sets with NV-Retriever-style hard-negative mining. They are built on LateOn, a deeper-trained successor of GTE-ModernColBERT-v1 (ModernBERT-base) scoring above 57 on BEIR. The 17M model goes from 57.50 to **66.64 MTEB Code** after fine-tuning, "pretty close to EmbeddingGemma-300M while being 17 times smaller" — [LightOn HF blog](https://huggingface.co/blog/lightonai/colgrep-lateon-code); [LightOn blog](https://lighton.ai/lighton-blogs/lateon-code-colgrep-lighton)
- ColGrep is a Rust CLI with a grep-like interface that ranks semantically using LateOn-Code. It runs entirely locally and targets coding agents (Claude Code, OpenCode, Codex) — [LightOn HF blog](https://huggingface.co/blog/lightonai/colgrep-lateon-code); [crate](https://crates.io/crates/colgrep); [next-plaid/colgrep README](https://github.com/lightonai/next-plaid/blob/main/colgrep/README.md)
- `mixedbread-ai/mxbai-edge-colbert-v0-17m` / `-32m` (Oct 2025) are ModernBERT-based. BEIR NDCG@10: 0.490 (17M) and 0.521 (32M), versus ColBERTv2's 0.488 at 130M. The 17M uses **48-d** token vectors versus ColBERTv2's 128-d. On LongEmbed the 17M scores 0.847, almost 20 points above the sub-1B single-vector SOTA — [Mixedbread blog](https://www.mixedbread.com/blog/edge-v0); [tech report arXiv 2510.14880](https://arxiv.org/pdf/2510.14880)
- mLateOn (307M, multilingual) scores MTEB Code 73.48, versus 71.53 for its dense twin mDenseOn — [HF blog](https://huggingface.co/blog/lightonai/mdenseon-mlateon)

### Inferences
- **Reranker ROI depends on the first stage.** With a strong code embedder, a 0.6B reranker did not help on MTEB-Code (73.42 vs 75.41; the subsets are near-equivalent but not guaranteed identical). With graph-indexer's weak first stage (BM25 plus MiniLM), a code-aware reranker should add more than the MS-MARCO MiniLM's +0.07. Fix the first stage first (Q1/Q2), then re-measure the reranker.
- **Latency rule of thumb.** Cross-encoder cost scales with candidates × (query + candidate tokens) × model size. A 22M MiniLM costs tens of ms per query (local doc). A 0.6B model on the same top-10/top-20 would plausibly cost 25–30x more compute, likely around 1 s or more per query on a laptop CPU. This is an extrapolation, not measured. Limit candidate text (name + signature + docstring + first N lines) and top-M.
- **Late interaction fits graph-indexer's existing `colbert.mjs` channel.** LateOn-Code-edge (17M) is code-trained and roughly EmbeddingGemma-class on MTEB Code at ~1/17 the size. Storage is per-token: at 48-d and ~200 tokens per chunk, that is roughly 9.6k floats per chunk (~38 KB in fp32, ~10 KB in int8). That is fine for 10k–50k chunks but heavy at 500k without PLAID-style compression. This is my arithmetic; the per-token dimension of LateOn-Code-edge is unverified.
- **Licensing sorts the options.** Permissive and code-aware: Qwen3-Reranker-0.6B (Apache-2.0 per my recollection; verify). Non-commercial: all jina rerankers. For an MIT-licensed distributable tool, avoid defaulting to jina rerankers.
- Keep reranking gated to NL-like queries (graph-indexer already has an NL gate) because of the observed symbolic wobble.

### Gaps
- No code-benchmark numbers were gathered for `BAAI/bge-reranker-v2-m3`, `mixedbread-ai/mxbai-rerank-base-v2` / `-large-v2` or `cross-encoder/ms-marco-MiniLM-L6-v2`. **Unverified recollection** from the Qwen3-Reranker model-card table (same top-100 protocol, MTEB-Code): jina-multilingual-reranker-v2-base ≈ 58.98, gte-multilingual-reranker-base ≈ 54.18, bge-reranker-v2-m3 ≈ 41.38, Qwen3-Reranker-4B ≈ 81.20, 8B ≈ 81.22. If correct, small *general* rerankers **hurt** strong code first stages; verify before citing.
- Measured CPU latency for any 0.6B reranker in onnxruntime-node or transformers.js.
- Whether LateOn-Code models have ONNX weights usable from JS, and their licenses and token dimensions.
- jina-reranker-v2 license and size (believed CC-BY-NC-4.0, ~278M) are unverified this session.

---

## Q4. Lexical/sparse for code: BM25 best practices, BM25F, learned sparse, doc2query/LLM descriptions, HyDE; BM25 vs dense evidence

### Takeaway
BM25 stays essential for identifiers, APIs, file names, stack traces and config keys. It is clearly beaten on NL→code queries: 0.673 vs 0.854–0.862 NDCG@10 for hybrids in Semble's benchmark, and on SWE-bench BM25 finds all oracle files in only ~40% of tasks at a 27K-token budget. The best-supported BM25 upgrades are code-aware tokenization (emit the compound identifier **and** its sub-tokens) and BM25F field weighting (symbols and file names boosted). LLM-generated NL descriptions help when they are **added** as a field or queried jointly. 2026 evidence shows that *corpus-only rewriting* degrades retrieval in ~62% of configurations.

### Cited Findings
**BM25 on code: tokenization and fields**
- Sourcegraph (Zoekt) treats file contents, symbols and file names as separate BM25F "fields" and sums their BM25 scores, with symbol matches boosted about 2.5x and a fixed boost for file-name matches. The extract gives the formula as `score(file) = bm25(content) + 2.5 * bm25(symbols) + 5`; verify the exact form on the page. Symbols come from tree-sitter queries plus universal-ctags for the long tail. Sourcegraph also scores **lines** with BM25F, using the line's length in place of document length — [Sourcegraph blog "Keeping it boring (and relevant) with BM25F"](https://sourcegraph.com/blog/keeping-it-boring-and-relevant-with-bm25f)
- "Improving BM25 Code Retrieval Under Fixed Generic Tokenization" (May 2026) says that, when the analyzer is under the operator's control, the first fix is a code-aware tokenizer matched to each language's identifier morphology: camelCase splitting for Go/Java, whitespace-preserving for snake_case Python. With such a tokenizer, BM25 at q=1 already captures the rare-identifier signal. On the full CoIR-Go corpus, BM25 recalls the gold result within an 8K-token budget for 48.1% of queries; the paper's q-log variant (q=0.10) raises that to 68.8% (+20.7 pp) under generic tokenization — [arXiv 2605.18561](https://arxiv.org/html/2605.18561)
- Practitioner implementation note: identifier tokenizers should emit sub-tokens **alongside the lowercased compound**. A query for `validate_user` only gets a strong BM25 hit if the index also holds the rare compound term; otherwise the IDF weight is spread thinly over the common parts `validate` and `user` — [ripvec-core tokens.rs docs](https://docs.rs/ripvec-core/latest/src/ripvec_core/encoder/ripvec/tokens.rs.html)

**BM25 vs dense on code benchmarks**
- SWE-bench BM25 recall of oracle files. At 13K tokens: 29.58% average, 26.09% all files, 34.77% any file. At 27K: 44.41%, 39.83%, 51.27%. At 50K: 51.06%, 45.90%, 58.38%. Larger BM25 contexts *reduced* resolution rates for every model tested — [SWE-bench paper](https://arxiv.org/pdf/2310.06770)
- CodeRAG-Bench compared 10 retrievers (BM25; BGE, GIST, SFR-Mistral; CodeSage, Jina-v2-code; Voyage-code-2, OpenAI). Dense retrievers frequently beat BM25, and code-specific ones beat general models — [CodeRAG-Bench](https://arxiv.org/pdf/2406.14497) (via [review](https://www.themoonlight.io/en/review/coderag-bench-can-retrieval-augment-code-generation))
- Semble benchmark (63 repos, 19 languages): BM25 **0.673** vs BM25+potion-code **0.854** vs BM25+CodeRankEmbed **0.862** NDCG@10 — [Semble benchmarks](https://github.com/MinishLab/semble/blob/main/benchmarks/README.md)
- CORE-Bench notes that BM25, bag-of-words and SPLADE-style sparse expansion "remain useful for exact identifiers, APIs, file names, stack traces, and configuration keys" — [CORE-Bench](https://arxiv.org/html/2606.11864)
- contextmaxxer reports 2.4x the file coverage of the best classical retriever (BM25/TF-IDF) at 5 results on SWE-Explore. This is self-reported — [GitHub](https://github.com/codeus-morbid/contextmaxxer)

**Learned sparse (SPLADE)**
- SPLADE learns sparse query and document expansions through the BERT MLM head, keeping inverted-index efficiency and explicit lexical matching — [naver/splade](https://github.com/naver/splade); [Pinecone explainer](https://www.pinecone.io/learn/splade/). "Inference-free" learned sparse retrievers, which expand only on the document side, are an active line of work — [arXiv 2411.04403](https://arxiv.org/pdf/2411.04403). **No code-specific SPLADE evaluation (e.g., on CoIR) was found.**

**LLM-generated descriptions (doc2query-style) and query rewriting / HyDE**
- Greptile found that semantic search over a codebase works better if code is first translated to natural language. Query↔description similarity was **12% higher** than query↔code similarity. Greptile recursively generates docstrings for each AST node and embeds them, alongside keyword and agentic search — [Greptile blog](https://www.greptile.com/blog/semantic)
- TranCS (context-aware translation of code into NL descriptions) reported MRR gains of 49–66% over sequence-only baselines. The extract does not say whether these are relative or absolute gains — [arXiv 2202.08029](https://arxiv.org/pdf/2202.08029) (via [EmergentMind topic](https://www.emergentmind.com/topics/natural-language-code-search))
- Qodo notes that generating descriptions adds substantial computational overhead, indexing complexity and latency, which motivated its work on better code embedders instead — [Qodo blog](https://www.qodo.ai/blog/qodo-embed-1-code-embedding-code-retrieval/)
- "Do not copy and paste! Rewriting strategies for code retrieval" (May 2026) tested stylistic rephrasing, NL-enriched pseudocode and full NL transcription across 6 CoIR benchmarks × 5 encoders × 3 rewriter families (Qwen, DeepSeek, Mistral). **Full NL rewriting applied jointly to query and corpus gave the largest gains** (up to +0.51 absolute NDCG@10 on CT-Contest for the MoSE-18 encoder). **Corpus-only rewriting degraded retrieval in 56 of 90 configurations (~62%).** Rewriting is "most effective as a remediation layer for lightweight encoders on code-dominant queries, with diminishing returns for strong encoders or NL-heavy queries" — [arXiv 2605.08299](https://arxiv.org/html/2605.08299)
- ReCo (ACL 2024) rewrites codebase code to normalize its style toward LLM-generated exemplar code, building on generation-augmented retrieval (GAR). Gains were up to 35.7% for sparse retrieval, 27.6% for zero-shot dense and 23.6% for fine-tuned dense — [ACL Anthology](https://aclanthology.org/2024.acl-long.75/)
- Generation-augmented query expansion (Li et al.) adds LLM-generated code to the query. This is the HyDE idea applied to code — [survey arXiv 2410.13110](https://arxiv.org/pdf/2410.13110)
- graph-indexer's own HyDE test on express (JS): nomic + HyDE held-out rank-1 was **0.58**, the same as nomic alone (0.58), at 3x the cost — [BENCH_PER_FIXTURE.md](../../docs/benchmarks/BENCH_PER_FIXTURE.md)

### Inferences
- **BM25 recipe the evidence supports** for graph-indexer's chunk index:
  1. Index each identifier both as the full lowercased compound and as camelCase/snake_case/kebab sub-tokens, so both the rare compound and the parts match.
  2. Use BM25F fields with separate weights: name/qualified name (highest), signature/parameters, docstring/comments, body, file path/module. Sourcegraph's 2.5x symbol boost and file-name boost are a reasonable starting prior; then tune on graph-indexer's bench (`bench/train-ranker.mjs` already exists).
  3. Apply Porter stemming only to NL-ish fields (docstring/comments/description), not to the compound identifiers. This is standard IR practice, not measured on code in the sources above.
  4. Treat language keywords (`function`, `return`, `const`, `self`…) as stopwords in the body field only.
- **LLM descriptions should be additive.** graph-indexer's optional enrichment should index generated summaries as an **extra BM25F field and/or an extra vector**, never replace code text: corpus-only *rewriting* hurt in ~62% of configurations. Descriptions are likely most valuable while the dense channel is weak (the rewriting paper's "lightweight encoders" finding). Re-measure after upgrading the embedder.
- **HyDE / query rewriting needs an LLM per query.** That clashes with the no-Ollama goal and showed no gain locally. Keep it opt-in.
- **SPLADE-style sparse** has no code evidence. The more tractable "learned sparse" win is doc-side expansion with generated descriptions (a doc2query equivalent) placed in a BM25 field.

### Gaps
- CoIR's own BM25 baseline numbers per dataset were not retrieved.
- No study quantifying stemming's effect on code search specifically.
- No SPLADE / learned-sparse results on code benchmarks were found.
- Exact Sourcegraph BM25F formula and any reported quality lift. From recollection, the post reported roughly a 20% improvement on an internal eval (unverified).
- Not read: "Practical Code RAG at Scale: Task-Aware Retrieval Design Choices under Compute Budgets" ([arXiv 2510.20609](https://arxiv.org/pdf/2510.20609)), which likely has BM25-vs-dense guidance per task.

---

## Q5. Hybrid fusion (RRF vs weighted score fusion vs learned) and query-type routing

### Takeaway
The main controlled study (Bruch et al., TOIS 2023) finds a **tuned convex combination of normalized scores beats RRF** in-domain and out-of-domain. RRF is also sensitive to its parameter, and convex combination needs only a few labelled queries to tune its single weight. RRF still works well untuned (Semble's 0.854 uses it). No controlled study of symbol-vs-NL query routing for code was found. Indirect evidence (lexical wins on identifiers, LLM rewriting helps code-dominant queries, rerankers wobble on symbolic queries) supports a cheap heuristic router that shifts fusion weights rather than switching channels on or off.

### Cited Findings
- A convex combination (CC) of lexical and semantic scores outperforms RRF both in-domain and out-of-domain. RRF is sensitive to its parameters. CC is sample-efficient: its one parameter can be tuned to a target domain with a small set of examples — [Bruch et al., arXiv 2210.11934](https://arxiv.org/abs/2210.11934); [ACM TOIS](https://dl.acm.org/doi/10.1145/3596512)
- Semble fuses BM25 and static-embedding scores with RRF and reaches 0.854 NDCG@10 — [Semble README](https://github.com/MinishLab/semble/blob/main/README.md); [benchmarks](https://github.com/MinishLab/semble/blob/main/benchmarks/README.md)
- Sourcegraph uses a weighted sum of per-field BM25 scores (BM25F) for ranking — [Sourcegraph blog](https://sourcegraph.com/blog/keeping-it-boring-and-relevant-with-bm25f)
- Sparse/lexical signals remain decisive for exact identifiers, APIs, file names, stack traces and config keys — [CORE-Bench](https://arxiv.org/html/2606.11864)
- LLM query/corpus rewriting helps most for lightweight encoders on **code-dominant** queries and less for NL-heavy queries — [arXiv 2605.08299](https://arxiv.org/html/2605.08299)
- graph-indexer's cross-encoder is gated to NL queries. A few long symbolic queries still passed the gate and were reranked, which caused a small symbolic rank-1 wobble (0.80 → 0.76 pooled) — [IMPROVEMENT_CROSS_ENCODER.md](../../docs/internals/IMPROVEMENT_CROSS_ENCODER.md)

### Inferences
- **Recommended fusion design:** min-max or z-normalize each channel's scores per query, then take a convex combination `s = α·lex + (1−α)·dense` (plus small weights for the graph and git channels). Keep **separate α per query route**, tuned on graph-indexer's held-out bench. RRF stays as a robust fallback when a channel's scores are degenerate (e.g., the static channel returns near-ties).
- **Router features (no ML needed):** the presence of camelCase/snake_case/`::`/`.`/`()` tokens, path-like strings, quoted strings or error-message patterns means "symbolic", which raises lexical weight and turns off reranking. Several stopword-bearing English words with no identifier-shaped tokens means "behavioural", which raises dense weight and allows reranking. Mixed queries get middle weights. The existing `bench/train-ranker.mjs` could learn α per route or a small logistic-regression fusion over channel scores. That is "learned fusion", but no code-specific evidence for it was found.
- Graph-indexer's measured asymmetry (symbolic rank-1 ≈ 0.7 vs NL ≈ 0.2–0.4) is exactly the setting where fixed-weight RRF under-uses a good dense channel on NL queries and over-uses it on symbolic ones.

### Gaps
- No published controlled comparison of RRF vs CC vs learned fusion **on code retrieval** was found. Bruch et al. used text benchmarks.
- No study of query-type routing for code search was found (the search budget ran out before targeted queries). "Balancing the Blend: An Experimental Analysis of Trade-offs in Hybrid Search" ([arXiv 2508.01405](https://arxiv.org/pdf/2508.01405)) was identified but not read.
- The optimal RRF k for code, and the normalization choice for CC (min-max vs theoretical bounds), were not established.

---

## Q6. Vector search in JS/Node for 10k–500k chunks: brute force, int8/binary, HNSW libraries, Matryoshka

### Takeaway
At 10k–500k chunks, exact brute-force search over **int8** vectors, or **binary** vectors with an int8/float rescoring pass, is simple, dependency-free and good enough in Node. Binary quantization plus rescoring keeps ~96% of retrieval quality with 32x less memory, and int8 plus rescoring is near-lossless. An HNSW index (usearch was the fastest Node binding benchmarked) is worth adding only near the top of the range or for sub-10 ms latency targets. Matryoshka truncation (e.g., to 256-d) is a cheap further lever, costing ~1.5% quality per halving in one reported case.

### Cited Findings
- Binary quantization (threshold at 0) cuts memory and disk 32x and can speed up retrieval up to 32x. A rescoring step preserves up to ~96% of retrieval performance. Int8 scalar quantization maps values into 256 levels — [HF blog: embedding quantization](https://github.com/huggingface/blog/blob/main/embedding-quantization.md); [Sentence Transformers docs](https://sbert.net/examples/sentence_transformer/applications/embedding-quantization/README.html)
- A search extract added that rescoring brings int8 to "almost lossless (−0.09 points)" and binary to −0.93 points. The originating page is uncertain (possibly [HAKARI-Bench, arXiv 2606.22778](https://arxiv.org/pdf/2606.22778)), so treat it as indicative.
- Vespa describes combining Matryoshka truncation with binary quantization for further cost cuts — [Vespa blog](https://blog.vespa.ai/combining-matryoshka-with-binary-quantization-using-embedder/)
- Static-retrieval-MRL: halving the dimensions cost 1.47% in quality for a 2x retrieval speed-up — [HF blog: static embeddings](https://huggingface.co/blog/static-embeddings)
- EmbeddingGemma supports MRL truncation to 512/256/128, voyage-code-3 to 256–2048, and Codestral Embed has dimensions ordered by relevance — [Google Developers Blog](https://developers.googleblog.com/en/introducing-embeddinggemma/); [Slashdot/voyage-code-3](https://slashdot.org/software/p/voyage-code-3/); [Simon Willison](https://simonwillison.net/2025/May/28/codestral-embed/)
- The node-vector-bench benchmark (PhotoStructure, locally hosted engines with Node bindings) found at 100k vectors: **DuckDB VSS 39 QPS vs usearch 367 QPS**. The persisted HNSW index was ~2.5x larger (488 MB vs ~200 MB). USearch supports multi-threaded batch insertion; LanceDB and sqlite-vec insert single-threaded. zvec supported only Linux and macOS as of Feb 2026 — [photostructure/node-vector-bench](https://github.com/photostructure/node-vector-bench)
- sqlite-vec (v0.1.0, Aug 2024) is a brute-force vector-search SQLite extension that runs everywhere and supports binary quantization — [Alex Garcia's release post](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html); [MarkTechPost](https://www.marktechpost.com/2024/08/04/sqlite-vec-v0-1-0-released-portable-vector-database-extension-for-sqlite-with-support-for-1-million-128-dimensional-vectors-binary-quantization-and-extensive-sdks/)
- For scale, 1M × 768 float32 vectors take ~3.07 GB raw. A 4-bit quantized scan representation cuts that to ~13%. This comes from the separate `sqliteai/sqlite-vector` extension — [sqlite-vector README](https://github.com/sqliteai/sqlite-vector/blob/main/README.md)
- graph-indexer's current embedding `.bin` footprint is `vectors × dim × 4 B` (float32) — [BENCH_FULL_SUITE.md](../../docs/benchmarks/BENCH_FULL_SUITE.md)

### Inferences
- **Memory math (my arithmetic).** At 768-d, 10k / 100k / 500k chunks take 31 MB / 307 MB / 1.54 GB in float32; 7.7 / 77 / 384 MB in int8; 1 / 9.6 / 48 MB in binary. At 256-d (potion-code, or MRL-truncated), divide by 3.
- **Latency estimate (unmeasured, order of magnitude).** A float dot-product scan of 500k × 768 is ~384M multiply-adds per query. In a plain JS loop that is a few hundred ms; an int8 or `Int32Array`-packed binary Hamming scan (≈12M popcount words at 500k × 768 bits) is likely tens of ms. After that, rescoring the top ~200–1000 with int8/float takes microseconds to milliseconds. At ≤100k chunks, a float or int8 brute-force scan is likely under ~50–100 ms. **Benchmark this in graph-indexer before adding an ANN dependency.**
- **Recommended default:** store int8 (or float16) vectors plus a binary sign-bit copy. Query with a binary Hamming prefilter to get the top-K (e.g., 500), then rescore with int8 or float. Add optional `usearch` HNSW for more than ~300k chunks when latency matters. sqlite-vec fits the existing optional SQLite backend if a SQL-side KNN is wanted, but it is brute force as well.
- Quantization choices interact with the model choice. Retention figures were measured on general text models, so re-check on code with the chosen embedder.

### Gaps
- No Node-specific numbers were gathered for hnswlib-node or LanceDB-node, or for pure-JS brute-force scan throughput. The search budget was exhausted.
- Rescoring retention numbers specifically for code-embedding models.
- Whether WASM SIMD (e.g., via usearch-wasm or a hand-written kernel) would make brute force fast enough at 500k with no native module.

---

## Q7. CPU throughput estimates for in-process (transformers.js / onnxruntime-node) embedding

### Takeaway
On graph-indexer's bench host (Apple M2), in-process transformers.js MiniLM (22M) indexes about **17 chunks/s**, and jina-embeddings-v2-base-code (base-size, fp32) about **1–3 chunks/s**. Any ≥137M transformer embedder therefore needs quantized (q8) weights, batching and a token cap to be tolerable, and 0.3–0.6B models become hours-long for 10k+ chunks on CPU. Static embeddings are two or more orders of magnitude faster. Transformers.js v4 (Feb 2026) brings WebGPU to Node, a possible no-Ollama acceleration path.

### Cited Findings
- Local measurements (Apple M2, real indexing payloads):
  - In-process Xenova MiniLM: **~17 chunks/s (CPU)**, 384-d.
  - Ollama nomic-embed-text: ~13–32 chunks/s (Metal GPU).
  - Ollama qwen3-embedding:4b: **~1.4 chunks/s** on real payloads (~2.5 bare-text).
  - Source: [BENCH_FULL_SUITE.md](../../docs/benchmarks/BENCH_FULL_SUITE.md). An earlier single-suite run measured qwen3-embedding:4b at ~8 chunks/s — [BENCH_BASELINE.md](../../docs/benchmarks/BENCH_BASELINE.md)
- Local: jina-embeddings-v2-base-code loaded at fp32 runs ~1–3 chunks/s ("no q8 dtype option" in the shipped pipeline) — [BENCH_SUMMARY.md](../../docs/benchmarks/BENCH_SUMMARY.md)
- Semble indexes ~218x faster and queries ~11x faster than the CodeRankEmbed hybrid, on CPU — [Semble benchmarks](https://github.com/MinishLab/semble/blob/main/benchmarks/README.md)
- Static retrieval models run 100x–400x faster on CPU than all-mpnet-base-v2 / multilingual-e5-small — [HF blog: static embeddings](https://huggingface.co/blog/static-embeddings)
- contextmaxxer's 161M encoder answers at ~1 s per MCP tool call, locally — [GitHub](https://github.com/codeus-morbid/contextmaxxer)
- EmbeddingGemma's QAT checkpoints run in under 200 MB of RAM — [Google Developers Blog](https://developers.googleblog.com/en/introducing-embeddinggemma/)
- Transformers.js v4 (on NPM since Feb 2026) has a new WebGPU runtime rewritten in C++. Using `com.microsoft.MultiHeadAttention` gave ~4x speed-ups for BERT-based embedding models. The same code can use WebGPU in Node.js, Bun and Deno — [HF blog: Transformers.js v4](https://huggingface.co/blog/transformersjs-v4). graph-indexer currently pins `@huggingface/transformers` 3.8.1 ([package.json](../../package.json)), and the `onnx-community/Qwen3-Reranker-0.6B-ONNX` port targets v4 ([HF](https://huggingface.co/onnx-community/Qwen3-Reranker-0.6B-ONNX)).
- Weak or secondary sources: one blog claims all-MiniLM-L6-v2 runs ~5 ms per text on CPU and batching 64 texts raises throughput ~20x — [Markaicode](https://markaicode.com/benchmarks/sentence-transformers-production-benchmark-latency/). An int8-quantized MiniLM is ~75% smaller and keeps 95%+ embedding similarity — [HF community model](https://huggingface.co/Ayeshas21/sentence-transformers-all-MiniLM-L6-v2-quantized)
- GPU-only reference: on an H100, granite-embedding-english-r2 encodes 144 docs/s and small-r2 199 docs/s — [Granite R2 blog](https://huggingface.co/blog/hansolosan/granite-embedding-r2)

### Inferences
- **Rough CPU extrapolation** (fp32, graph-indexer's current unbatched-ish pipeline, M2-class laptop). These scale the local MiniLM and jina measurements by approximate per-token transformer compute. Treat them as ±2–3x guesses to validate.

| Model class | Examples | Est. chunks/s (fp32 now) | 10k chunks | 100k chunks |
|---|---|---|---|---|
| Static lookup | potion-code-16M-v2 | 1,000s | seconds | ~1–2 min |
| 17–47M transformer | LateOn-Code-edge, granite-small-r2 | ~10–25 | ~7–17 min | ~1–3 h |
| 22M (current) | all-MiniLM-L6-v2 | ~17 (measured) | ~10 min | ~1.6 h |
| 137–161M base | CodeRankEmbed, jina-v2-code, granite-r2, gte-modernbert | ~1–3 (jina measured) | ~1–3 h | ~9–28 h |
| ~300M | EmbeddingGemma, mDenseOn | ~0.5–2 | ~1.5–5 h | long |
| 0.5–0.6B | Qwen3-Embedding-0.6B, C2LLM-0.5B | ~0.3–1 | ~3–9 h | impractical |

- **Levers before switching model size:**
  - Load q8/int8 ONNX weights. Transformers.js v3 exposes a `dtype` option; graph-indexer's pipeline currently doesn't use it.
  - Batch 16–64 chunks per call instead of single calls.
  - Cap embedded text at ~256–512 tokens (name + signature + docstring + head of body). Code models accept 8K tokens, so long chunks silently multiply cost.
  - Run embedding in a worker pool that uses all cores.
  - These could plausibly bring base-size models to ~10+ chunks/s. That is **speculative** and should be benchmarked.
- **Practical architecture implied by the evidence:** static potion-code as the always-on dense channel (instant indexing, near-CodeRankEmbed hybrid quality). An optional background or opt-in "quality" re-embed with a base-size code model (CodeRankEmbed/granite/gte-modernbert, q8) or LateOn-Code-edge, applied lazily to hot or changed files. An optional code-aware reranker on NL-routed queries only.

### Gaps
- No measured CPU throughput was found for CodeRankEmbed, EmbeddingGemma, Qwen3-Embedding-0.6B or LateOn-Code in onnxruntime-node or transformers.js. Huggingface.co blocked local model downloads, so no local benchmark could be run in this session. The table above is extrapolation.
- Whether Transformers.js v4 also speeds up the **CPU** backend (the ~4x claim is for its WebGPU runtime), and whether WebGPU in Node works on typical Linux laptops without a discrete GPU.
- Unverified recollection: transformers.js v3 `dtype` options include `fp32`, `fp16`, `q8`, `int8`, `uint8`, `q4`, `bnb4`, `q4f16`, provided the model repo ships the matching ONNX files. all-MiniLM-L6-v2 truncates at 256 tokens, which partly explains its speed advantage over 8K-context code models.
