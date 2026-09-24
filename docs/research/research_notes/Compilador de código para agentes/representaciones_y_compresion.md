# AI-oriented code representations and code compression for LLM reading (state as of Sept 2026)

> **Verification note (read first).** During this session the egress proxy blocked direct fetches of arxiv.org, huggingface.co, github.com and author pages (HTTP 403, organization policy). So **every number below comes from search-engine extracts of the primary source** (arXiv abstract/HTML, ACL/ACM/AAAI pages, OpenReview), not from a manual read of the paper tables. Treat per-table figures (model-by-model breakdowns) as "abstract-level verified, table not checked". Licenses were checked through the GitHub API (repo `license` field) via the GitHub MCP connector. "No license" means GitHub reports no license file, so by default all rights are reserved.
>
> Record format per item: **What**: the representation or transformation. **Tokens**: the measured reduction. **Accuracy**: the measured effect, with model and benchmark. **Code/License**. **graph-indexer**: whether it is usable here, and how.

---

## 1. AI-oriented grammars, AI-native syntaxes and bidirectional source<->AI-form converters

### Takeaway
The SimPy line of work (Monash/SMU group of Zhensu Sun and Xiaoning Du) is the only sustained research line on "AI-oriented grammar". It includes SimPy (ISSTA 2024), Token Sugar (ASE 2025) and the formatting study "Hidden Cost of Readability" (2025). A separate paper, ShortCoder (2026), comes from another group. All report lossless or AST-preserving transformations with **10–22% token savings**. But the gains **need fine-tuning** so the model can read and write the new syntax, and they are measured only on single-function benchmarks (HumanEval, LeetCode, McEval). No work evaluates a novel AI grammar in an agentic or SWE-bench setting. The only variant that works zero-shot on frontier models is plain formatting removal (section 2).

### Cited Findings
- **SimPy: "AI Coders Are Among Us: Rethinking Programming Language Grammar Towards Efficient Code Generation"** (Sun, Du et al., ISSTA 2024). [arXiv 2404.16333](https://arxiv.org/abs/2404.16333), [ACM DL](https://dl.acm.org/doi/10.1145/3650212.3680347)
  - What: a revised Python grammar ("AI-oriented grammar"). NEWLINE/INDENT/DEDENT are replaced by anchor tokens, and keywords and compound symbols are removed or replaced by placeholders. SimPy programs keep an **identical AST** to Python, so a modified AST parser can convert both ways and execute them — [arXiv](https://arxiv.org/abs/2404.16333); [ISSTA page](https://2024.issta.org/details/issta-2024-papers/90/AI-Coders-Are-among-Us-Rethinking-Programming-Language-Grammar-towards-Efficient-Cod)
  - Tokens: **−13.5% (CodeLlama tokenizer) and −10.4% (GPT-4 tokenizer)** for the same set of code tasks — [arXiv](https://arxiv.org/abs/2404.16333)
  - Accuracy: models must be trained or fine-tuned on SimPy. Example: a CodeGen model trained on Python scored 7.32% Pass@10 on HumanEval, and 9.15% after fine-tuning on SimPy. The abstract claims that performance is maintained or improved — [search extract of arXiv](https://arxiv.org/abs/2404.16333)
  - Code/License: [v587su/SimPy](https://github.com/v587su/SimPy) (C, modified CPython parser). GitHub reports **no license**.
  - graph-indexer: **not directly usable.** Claude and GPT are not trained on SimPy, and it covers Python only. The useful idea to borrow is the design principle: an AST-identical, reversible rendering.
- **Token Sugar: "Making Source Code Sweeter for LLMs through Token-Efficient Shorthand"** (ASE 2025; same group). [arXiv 2512.08266](https://arxiv.org/html/2512.08266v1), [ASE 2025](https://conf.researchr.org/details/ase-2025/ase-2025-papers/92/Token-Sugar-Making-Source-Code-Sweeter-for-LLMs-through-Token-Efficient-Shorthand)
  - What: mines frequent, token-heavy code patterns (boilerplate) from a corpus and maps each one to a unique, **reversible shorthand**. This yields **799 (pattern, shorthand) pairs**. It complements syntax-level methods such as SimPy.
  - Tokens: **up to −15.1%** of source tokens. With SimPy combined: **−22.4% (LeetCode), −20.0% (HumanEval)**.
  - Accuracy: LLMs pretrained on Token-Sugar-augmented data save **up to 11.2% of generated tokens**, with Pass@1 near-identical to baselines. Requires pretraining or augmentation — [arXiv HTML](https://arxiv.org/html/2512.08266v1)
  - Code/License: [v587su/TokenSugar](https://github.com/v587su/TokenSugar). GitHub reports **no license**.
  - graph-indexer: not usable zero-shot, because it needs model training. The pattern-mining idea could inform a later "macro dictionary" experiment. That is untested for in-context use, where the model would learn the shorthands from the prompt.
- **ShortCoder: "Knowledge-Augmented Syntax Optimization for Token-Efficient Code Generation"** (arXiv 2601.09703, Jan 2026). [arXiv](https://arxiv.org/abs/2601.09703)
  - What: **10 AST-preserving syntax-simplification rules for Python** (semantically equivalent, still readable Python, not a new language). Adds the ShorterCodeBench corpus and fine-tuning for "conciseness awareness".
  - Tokens: the rules give **−18.1%** without functional compromise. The paper claims **18.1–37.8% better generation efficiency** than prior methods on HumanEval, "while ensuring" generation performance.
  - Code/License: not verified (ShorterCodeBench is listed on [awesomepapers](https://awesomepapers.io/ai-for-code/datasets/shortercodebench)).
  - graph-indexer: partly usable. Because the output stays valid Python, a model can read it zero-shot. But the rules rewrite code, so line and byte offsets back to the real source are lost unless a source map is kept.
- **"The Hidden Cost of Readability: How Code Formatting Silently Consumes Your LLM Budget"** (Pan et al., Xiaoning Du's group; arXiv 2508.13666, 2025). This is the bidirectional converter that works zero-shot. Details are in section 2 — [arXiv](https://arxiv.org/pdf/2508.13666)
- **"Beyond Human-Readable: Rethinking Software Engineering Conventions for the Agentic Development Era"** (D. Ustynov, arXiv 2604.07502, Apr 2026). A position paper plus one small experiment. It proposes "semantic density optimization", which removes zero-information tokens and keeps high-value ones. It also proposes a "program skeleton" concept for agent navigation and argues for "decoupling semantic intent from human-readable representation". **Controlled experiment (log formats, not code):** aggressive compression cut input tokens by 17% but **raised total session cost by 67%**, because the model spent more reasoning tokens decoding it — [arXiv](https://arxiv.org/abs/2604.07502)
- Related pseudocode-as-agent-language work, **CodeAgents** (arXiv 2507.03254), rewrites agent *plans and prompts* (not source code) as typed pseudocode and reports higher accuracy with fewer tokens on GAIA, HotpotQA and VirtualHome — [arXiv](https://arxiv.org/html/2507.03254v1). Tangential to this topic.

### Inferences
- The evidence base for "novel AI grammar" means gains of about 10–20% that only appear after training. A tool like graph-indexer serves closed frontier models it cannot fine-tune, so a new syntax such as SimPy or Token Sugar is a poor bet. It would likely also raise reasoning cost, as in the Ustynov result (+67% total cost with −17% input).
- The part of this line that transfers is **lossless, AST-preserving, zero-shot-readable lowering**: stripping formatting, and possibly "sugar-free" normalizations that are still valid source. Every lowered view should keep a source map back to real file and line, so edits land in the real source.
- None of these grammar papers tests PHP, TypeScript or Java beyond formatting removal, and none tests repository-level or agentic tasks.

### Gaps
- No SimPy-style grammar for Java, TypeScript or PHP was found. No evaluation of SimPy or Token Sugar with Claude or GPT-4-class models *reading* (rather than generating) the AI form zero-shot was found.
- No peer-reviewed "AI-native language" (designed for agents to read and write) with measured accuracy was found. Blog-level proposals exist but were not researched.
- Table-level numbers (per model and per task) for SimPy and Token Sugar were not checked, because arXiv was blocked.

---

## 2. Token cost of human-oriented formatting, comments, names, and what removing each does

### Takeaway
Formatting (newlines, indentation, whitespace) costs about **a quarter of input tokens (24.5% on average, up to 42% for Java)**. Removing it is essentially free for accuracy on code completion across 10 LLMs, including Claude 3.7 and GPT-4o. Everything beyond formatting is *not* free. **Identifier obfuscation costs 10–29 pp**, and **full minification in an agentic SWE-bench setting cost 12 pp of resolution rate** for 42% fewer tokens. Comments help bug fixing (up to 3x), though misleading comments hurt.

### Cited Findings
- **Hidden Cost of Readability** (arXiv [2508.13666](https://arxiv.org/pdf/2508.13666); [project PDF](https://xiaoningdu.github.io/assets/pdf/format.pdf)):
  - Setup: fill-in-the-middle code completion on **McEval**, 4 languages (**Java, Python, C++, C#**), 10 LLMs (GPT-3.5-turbo, GPT-4o-mini, GPT-4o, Gemini-1.5, **Claude-3.7**, Phi-3.5, Qwen-2.5, MagiCoder, DeepSeek-V3, DeepSeek-Coder-1.3B) — [Moonlight review summarising the paper](https://www.themoonlight.io/en/review/the-hidden-cost-of-readability-how-code-formatting-silently-consumes-your-llm-budget)
  - Tokens: removing all formatting cuts input by **24.5% on average**, and by **up to 42% for Java** on some models. **Newlines** are the largest share for Claude-3.7 (**14.6%** of input tokens on average) and Gemini-1.5 (**17.5%**). For GPT-4o, **whitespace** matters more (**10.7%**) than newlines (**7.5%**) — [arXiv](https://arxiv.org/pdf/2508.13666)
  - Accuracy: Pass@1 "remarkably stable", described as a negligible change across nearly all models and languages. Output tokens barely shrink unless the model is prompted or fine-tuned. Prompting plus fine-tuning gives **up to −36.1% output length**. Fine-tuning on only **50 unformatted Java samples** gives **−35.9% (Gemini-1.5) and −24.8% (GPT-4o)** output tokens, with statistically insignificant accuracy impact — [arXiv](https://arxiv.org/pdf/2508.13666)
  - Tool: a bidirectional converter that minifies before the LLM and re-beautifies the LLM output — [arXiv](https://arxiv.org/pdf/2508.13666). Code URL and license **not verified**.
  - graph-indexer: **directly usable and the strongest zero-shot lever.** The views graph-indexer serves (for example a `read_symbol`) can be emitted with formatting stripped but keep a line map. Caveat: the evidence is FIM completion, not agentic editing. The agent must still produce edits against the formatted source, so emit line anchors.
- **"Reducing Token Usage of State-in-Context Agents using Minification"** (arXiv [2606.01326](https://arxiv.org/abs/2606.01326), May 2026). Re-implements the DirectSolve state-in-context agent on **SWE-bench Verified**. It finds source code is the dominant token consumer and applies minification ("remove or shorten non-essential lexical elements while preserving semantics"). Result: **−42% input tokens but −12 pp resolution rate** — [arXiv](https://arxiv.org/html/2606.01326v1). The implementation is described as public on GitHub (repo and license not verified). A related TU Wien thesis: [Hrubec 2025, "Reducing Token Usage of Software Engineering Agents"](https://repositum.tuwien.at/bitstream/20.500.12708/224666/1/Hrubec%20Nicolas%20-%202025%20-%20Reducing%20Token%20Usage%20of%20Software%20Engineering%20Agents.pdf).
  - graph-indexer: this is the key **counter-evidence**. Aggressive minification that shortens identifiers or removes comments hurts in agentic repair. Keep lowering to formatting only, unless an ablation proves otherwise. Which minification steps caused the 12 pp loss was not checked, because the table was unavailable.
- **"When Names Disappear: Revealing What LLMs Actually Understand About Code"** (arXiv [2510.03178](https://www.arxiv.org/pdf/2510.03178), [OpenReview](https://openreview.net/forum?id=8t5TlFzUAU)). Semantics-preserving obfuscation that removes naming cues. GPT-4o **class-level summarization on ClassEval: 87.3% → 58.7%**. Even *execution prediction* drops: ClassEval Pass@1 **85.7 → 76.1**, LiveCodeBench Pass@1 **85.4 → 71.2** (Pass@3 97.9 → 80.1). Releases the **ClassEval-Obf** benchmark — [search extract of arXiv/emergentmind](https://www.emergentmind.com/topics/classeval-obf)
- **"Do Machines Struggle Where Humans Do? LLM and Human Comprehension of Obfuscated Code"** (arXiv [2606.31725](https://arxiv.org/abs/2606.31725)). Adversarial identifier renaming disrupts comprehension through "semantic displacement". Control-flow flattening degrades performance in proportion to state-space complexity — [arXiv](https://arxiv.org/pdf/2606.31725)
- **"On the Impact of Code Comments for Automated Bug-Fixing: An Empirical Study"** (arXiv [2601.23059](https://arxiv.org/abs/2601.23059), Jan 2026). Comments raise bug-fixing accuracy **up to 3x** when present in training and inference. Comments given only at inference already help. Comments describing the *implementation* help most. Missing comments were LLM-generated for the study — [arXiv HTML](https://arxiv.org/html/2601.23059)
- **"Assessing the Impact of Code Changes on the Fault Localizability of LLMs"** (arXiv [2504.04372](https://arxiv.org/html/2504.04372v3)). **Misleading comments and dead code** cause most of the robustness loss in LLM fault localization. Dead code alone cuts average accuracy to **20.38%** — [arXiv](https://arxiv.org/html/2504.04372v3)
- **"Inside Out: Uncovering How Comment Internalization Steers LLMs for Better or Worse"** (Imani et al., ICSE 2026; arXiv [2512.16790](https://arxiv.org/abs/2512.16790)). LLMs encode comments, and comment subtypes (Javadoc, inline, multiline), as distinct latent concepts. Steering those concepts shifts performance **from −90% to +67%** depending on model and task. Summarization is most sensitive and completion least.
- **"Code Needs Comments: Enhancing Code LLMs with Comment Augmentation"** (ACL 2024 Findings; [ACL Anthology](https://aclanthology.org/2024.findings-acl.809/)). Adding LLM-generated comments to training code gives consistent gains on two programming benchmarks for Llama 2, Code Llama and InternLM2. This is training-time evidence that comments carry useful signal.
- A mixed result is reported in the search summary of the same comment literature: in one long-context understanding evaluation, removing comments *improved* most LLMs (not Gemini). The primary source for this claim **could not be identified**, so treat it as unverified.
- Readability versus cost at the language level: see section 4 (Dan Luu; Tokenmaxxing).

### Inferences
- A safe "compiler" pass order, by evidence strength:
  1. Strip formatting: free, about 25% saved.
  2. Drop dead code, and possibly flag misleading or outdated comments: dead code is actively harmful.
  3. Keep identifiers verbatim: renaming costs 10–29 pp.
  4. Keep or summarize implementation comments: they help repair, up to 3x.
- Docstrings are a candidate for *summarizing* rather than dropping. No study was found that isolates docstrings in agentic tasks.
- The Ustynov (+67% total cost) and minification (−12 pp) results together suggest a ceiling. Beyond about 25–40% lexical compression, the saved input tokens are paid back through reasoning tokens or failures.

### Gaps
- **No study found that measures the token share of comments, docstrings, imports or type annotations separately** in real repositories, per tokenizer. The Hidden Cost study covers only whitespace, indentation and newlines.
- No study was found that removes type annotations or import blocks and measures accuracy (only Dan Luu's informal claim about dynamic versus static languages; see section 4).
- No formatting study was found for PHP or TypeScript. The Hidden Cost study covers Java, Python, C++ and C#.
- The exact mix of minification operations in 2606.01326, and which one caused the −12 pp, was not verified.

---

## 3. Code-specific prompt and context compression (pruning, skeletons, summaries)

### Takeaway
Task-conditioned pruning is where the best measured agentic results are. **SWEzze** gives a 6x compression rate, **−51.8% to −71.3% tokens and +5.0–9.2% resolution on SWE-bench Verified**. **SWE-Pruner** gives **−23% to −54% tokens, and −39% with Claude Sonnet 4.5**, while improving success. For single-turn long-code tasks, **LongCodeZip** reaches 5.6x with no loss. Generic text compressors (LLMLingua-2) break code syntax. Structure-aware pruning that keeps signatures and drops bodies (HCP) keeps accuracy for completion. But a 2026 study finds skeletons and NL summaries **useless at the edit site**: the code being edited must be shown raw.

### Cited Findings
- **LongCodeZip: "Compress Long Context for Code Language Models"** (Shi et al., ASE 2025; [arXiv 2510.00446](https://arxiv.org/abs/2510.00446)). Two-stage method. (1) Function-level chunks are ranked by conditional perplexity, approximating mutual information with the instruction. (2) Kept functions are split into blocks via perplexity boundaries, then selected by a knapsack algorithm under a token budget. **Up to 5.6x compression without degrading performance** on code completion, summarization and RepoQA question answering. Compressor models range from 0.5B to 8B. With Claude-3.7-Sonnet it matches the uncompressed baseline (ES 66.27 vs 66.24 reported) and reaches 90.7 on RepoQA. Baselines: RAG, LLMLingua, DietCode, SlimCode — [arXiv](https://arxiv.org/abs/2510.00446); [Liner review](https://liner.com/review/longcodezip-compress-long-context-for-code-language-models). Code: [YerbaPage/LongCodeZip](https://github.com/YerbaPage/LongCodeZip), **MIT**.
  - graph-indexer: usable as an optional stage. Its first stage (rank functions by relevance) maps onto graph-indexer's symbol graph. The second stage needs a small local LM, which conflicts with a pure Node.js tool, but could run as an optional sidecar.
- **LLMLingua-2 applied to code** (baseline results reported in the LongCodeZip paper): at **4.4x compression**, long-code-completion Exact Match falls from **34.40 → 15.00 (DeepSeek-Coder-6.7B)**, **31.80 → 12.20 (Qwen2.5-Coder-7B)** and **40.20 → 15.40 (Seed-Coder-8B)**. Edit similarity falls less. The paper attributes this to the loss of syntax and structure — [LongCodeZip PDF, via search extract](https://arxiv.org/pdf/2510.00446). *Conflict:* the same extract also says LLMLingua-2 "is unable to achieve even 1% EM", which does not match the EM of 12–15 above. Check the table before citing. LLMLingua code: [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua), **MIT**.
  - graph-indexer: avoid token-level generic compressors on code.
- **SWE-Pruner: "Self-Adaptive Context Pruning for Coding Agents"** (arXiv [2601.16746](https://arxiv.org/abs/2601.16746), Jan 2026; also on [OpenReview](https://openreview.net/pdf/70c8654781be52c592fca8ca7fd2aa924f7231c1.pdf)). The agent writes an explicit goal hint (for example "focus on error handling"). A **0.6B "neural skimmer"** then selects relevant *lines* from tool outputs. Results: **−23% to −54% tokens on SWE-bench Verified with success rates even improved; −39% with Claude Sonnet 4.5**; up to **14.84x** compression on single-turn LongCodeQA with minimal loss. The authors claim **20–40% savings in Claude Code cost** — [arXiv](https://arxiv.org/abs/2601.16746); [PDF](https://www.arxiv.org/pdf/2601.16746). Code: [Ayanami1314/swe-pruner](https://github.com/Ayanami1314/swe-pruner), **MIT**.
  - graph-indexer: **highly relevant pattern.** A read tool could take a `focus`/`goal` argument and return line-pruned, graph-scoped output. graph-indexer could do this deterministically (keeping lines that reference the queried symbols and their dataflow) before trying a neural skimmer.
- **SWE-Pruner Pro: "The Coder LLM Already Knows What to Prune"** (arXiv [2607.18213](https://arxiv.org/abs/2607.18213), Jul 2026). A small head on the *agent's own* hidden states predicts line-level keep or prune masks for each tool response, which is replaced by a "compact skeleton" in the next turn. **Up to −39% prompt+completion tokens.** On MiMo-V2-Flash: **+3.8% SWE-bench Verified resolve rate**, +2.2 on Oolong. Code: [Ayanami1314/swe-pruner-pro](https://github.com/Ayanami1314/swe-pruner-pro), **no license** reported by GitHub.
  - graph-indexer: not usable with closed models, since it needs hidden states. It confirms that *line-level* pruning of tool output is the right granularity.
- **SWEzze / OCD: "Compressing Code Context for LLM-based Issue Resolution"** (Jia, Barr, Mechtaev; arXiv [2603.28119](https://arxiv.org/abs/2603.28119), Mar 2026). Oracle-guided Code Distillation, combining genetic search and delta debugging, finds the *minimal sufficient* context for a fix. A lightweight model (SWEzze) is trained on it. On **SWE-bench Verified across three frontier LLMs**: about **6x compression**, **−51.8% to −71.3% total tokens**, **+5.0 to +9.2% resolution**. Code availability and license **not verified**.
  - graph-indexer: strong evidence that *less but right* context improves repair. OCD's "minimal sufficient context" is a good target definition for graph-indexer's slicing.
- **Hierarchical Context Pruning (HCP)** (Zhang et al., AAAI 2025; [arXiv 2406.18294](https://arxiv.org/abs/2406.18294), [AAAI](https://ojs.aaai.org/index.php/AAAI/article/view/34782)). For repository-level completion, most function and method bodies in dependent files and all non-dependency files can be pruned, keeping signatures, **with no significant accuracy loss**. Prompts go from about **50k to about 8k tokens (−84%)**, with **higher accuracy than prior methods on 5 of 6 code LLMs** — [arXiv HTML](https://arxiv.org/html/2406.18294v2). Code: [Hambaobao/HCP-Coder](https://github.com/Hambaobao/HCP-Coder), **MIT**.
  - graph-indexer: **directly implementable** with tree-sitter and the dependency graph: full body for the current file, signatures for dependencies, nothing for unrelated files.
- **Agentless skeleton format** (Xia et al., FSE 2025; [arXiv 2407.01489](https://arxiv.org/pdf/2407.01489v2), [FSE PDF](https://lingming.cs.illinois.edu/publications/fse2025.pdf)). A compressed file view that lists class, function and variable declarations with headers only, used for hierarchical localization (file → class/function → edit location). The paper ablates each localization step (containing the ground truth, lines of code, and cost). Agentless solved **32.00% (96) of SWE-bench Lite at $0.70 per issue** — [arXiv](https://arxiv.org/pdf/2407.01489v2). Code: [OpenAutoCoder/Agentless](https://github.com/OpenAutoCoder/Agentless), **MIT**.
  - graph-indexer: **directly implementable** as a `skeleton(file)` view, which is exactly tree-sitter's strength. Use it for *localization*, not editing (see the next item).
- **"What Context Does a Coding Agent Actually Need to Act?"** (B. Sam-Bodden, arXiv [2607.09691](https://arxiv.org/abs/2607.09691), Jun/Jul 2026). Holds localization fixed with an oracle and varies only how code is represented at edit time. Findings:
  - **NL summaries answered 4/45 behavioral questions versus 27/45 for source** (held-out repositories, independent judges).
  - **Rendering the rest of the file as UML skeletons and signatures resolved no more issues than deleting it.**
  - **Compressed context matched whole files at about one third of the tokens.**

  Code: [integrallis/act-context](https://github.com/integrallis/act-context), **MIT**.
  - graph-indexer: **critical design constraint.** At the edit site, serve raw (formatting-stripped at most) source of the target and its immediate dependencies. Skeletons and summaries are for navigation only.
- **"Retrieval-Oriented Code Representations in Agentic Bug Localization"** (Caumartin, Chen, Costa; arXiv [2607.11046](https://arxiv.org/abs/2607.11046), Jul 2026). Compares 5 representations for file-level localization on Long Code Arena and SWE-bench Verified: file paths, raw source, and three LLM-generated text forms. **Role-aware summaries beat file paths by up to 40% Hit@5** while being **10.4–20.9x smaller than raw source**. Combining representations adds up to 31.9%, and LLM reranking up to 42.0%. Plugged into Agentless: **94% Hit@6 (+4.7%)** — [arXiv](https://arxiv.org/abs/2607.11046). Code and license not verified.
  - graph-indexer: supports **precomputed per-file "role summaries" as an index layer** for localization, complementary to the act-context finding (summaries help find, not edit).
- **NL summarization for localization.** "Natural Language Summarization Enables Multi-Repository Bug Localization by LLMs in Microservice Architectures" ([arXiv 2512.05908](https://arxiv.org/abs/2512.05908)) builds file-, directory- and repository-level NL summaries and does NL-to-NL search. Also: hierarchical repository summarization with local LLMs ([arXiv 2501.07857](https://arxiv.org/abs/2501.07857), LLM4Code 2025) and ICCSA 2025 workshop work ([Springer](https://link.springer.com/chapter/10.1007/978-3-031-97576-9_6)). Numbers not retrieved.
- **DietCode** (Zhang et al., FSE 2022; [arXiv 2206.14390](https://arxiv.org/abs/2206.14390)). Attention-guided statement and token dropping for CodeBERT: **comparable results with 40% less computation** in fine-tuning and testing. Foundational, but for encoder models. Code: [9erxis/DietCode](https://github.com/9erxis/DietCode) (license not verified).
- **SlimCode: "Natural Is The Best: Model-Agnostic Code Simplification"** (Wang et al., FSE 2024; [arXiv 2405.11196](https://arxiv.org/abs/2405.11196)). Drops tokens by lexical category. Improves on DietCode by **+9.46% MRR (code search)** and **+5.15% BLEU (summarization)**, runs **133x faster**, and cuts **GPT-4 API cost up to 24%** with comparable results. It finds token-category impact is task-specific but model-agnostic.
- **LeanCode** (ACL 2025; [ACL Anthology](https://aclanthology.org/2025.acl-long.78/)). Context-aware attention for selecting tokens to drop. Beats DietCode and SlimCode by 60% and 16% (code search) and by 29% and 27% (summarization).
- **CodePromptZip** (arXiv [2502.14925](https://arxiv.org/abs/2502.14925); **ACL 2026 Findings**, [Anthology](https://aclanthology.org/2026.findings-acl.1384/)). A type-aware, priority-driven compressor for RAG code examples. Program analysis finds token types, and ablation ranks their removal priority. A small LM with a copy mechanism is trained on these samples. It beats the best entropy- or distillation-based baseline by **+23.4% (assertion generation), +28.7% (Bugs2Fix), +8.7% (code suggestion)**. Code and license not verified.
  - graph-indexer: its *removal-priority ranking by token type* is exactly the kind of table graph-indexer needs for deciding which lexical classes to drop. The ranking itself was not retrieved.
- **Codebase-Memory: "Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP"** (arXiv [2603.27277](https://arxiv.org/abs/2603.27277v1), Mar 2026). The closest analogue to graph-indexer: a tree-sitter knowledge graph in SQLite exposed through 14 typed MCP tools. Across **31 real repositories: 83% answer quality versus 92% for a file-exploration agent, at 10x fewer tokens and 2.1x fewer tool calls**. The README claims five structural queries use about 3,400 versus about 412,000 tokens (−99.2%), a vendor claim. Code: [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp), **MIT**, C.
  - graph-indexer: a benchmark to beat. Note the **9-point quality gap**: graph answers alone lose accuracy against reading files.
- **Repository Intelligence Graph (RIG)** (Cherny-Shahar and Yehudai; arXiv [2601.10112](https://arxiv.org/abs/2601.10112)). A deterministic build- and test-centred graph (components, tests, dependencies), extracted from CMake and CTest and served as LLM-friendly JSON. With Claude Code, Cursor and Codex on 8 repositories × 30 questions: **+12.2% mean accuracy, −53.9% completion time, −57.8% seconds per correct answer**. In multilingual repositories: **+17.7% accuracy, +69.5% efficiency** — [arXiv PDF via search](https://www.arxiv.org/pdf/2601.10112). Code and license not verified.
  - graph-indexer: evidence that a *compact, deterministic structural map* raises accuracy, not just efficiency.

### Inferences
- Across agentic studies (SWE-Pruner, SWE-Pruner Pro, SWEzze, RIG), **task-conditioned reduction of context raises success**, while **task-agnostic lexical reduction (minification) lowers it**. For graph-indexer, the "compiler" should be mainly a *slicer* (what to show), and only secondarily a *lowerer* (how to render it).
- A layered design fits the evidence:
  - (a) Role summaries and skeletons for localization: 10–20x smaller, better Hit@k.
  - (b) An HCP-style signatures-only view of dependencies.
  - (c) Raw, formatting-stripped source of the edit target and the lines selected by a goal hint. Skeletons and summaries must not replace the target's code.
- Deterministic, graph-based line selection (dataflow and call slices) has not been benchmarked against SWE-Pruner's neural skimmer. This is an open niche graph-indexer could fill and measure.

### Gaps
- SWEzze and CodePromptZip code availability and licenses could not be checked.
- No head-to-head was found between graph-based deterministic slicing and neural pruners on SWE-bench.
- The exact per-model SWE-Pruner deltas (which models, and resolution rate changes) were not retrieved beyond "−39% with Claude Sonnet 4.5; success improved".

---

## 4. Alternative encodings: ASTs and graphs as text, IR, pseudocode, images, and tokenizer efficiency by language

### Takeaway
Serialized ASTs give **no accuracy gain over raw code for modern LLMs** (summarization), though they can be shorter. **Graph representations (AST+PDG) beat raw source by about 30 pp** in one vulnerability-reasoning study while using fewer tokens. **Adding raw source back hurt** in that study ("context dilution"). LLVM IR helps only as a *training* signal (IRCoder). **Rendering code as images** is a real compression channel (4–8x) for multimodal models. By language, BPE token cost varies about **2.6x** (Clojure to C), but correctness and iteration count dominate total agent cost.

### Cited Findings
- **"Code vs Serialized AST Inputs for LLM-Based Code Summarization: An Empirical Study"** (Dong, Zhao, Harvey; LLM4Code 2026; [arXiv 2602.06671](https://arxiv.org/abs/2602.06671), [ACM](https://doi.org/10.1145/3786181.3788712)). The AST(NIT) serialization keeps lexical details and encodes structure. With **LLaMA-3.1-8B on CodeXGLUE Python**, serialized ASTs **shorten inputs** and training time and reach summary quality **comparable** to raw code. SBT-style ASTs, which helped encoder-decoder models, no longer give an advantage under LLM fine-tuning.
- **"Representation Matters: An Empirical Study of Program Representations for LLM Vulnerability Reasoning"** (arXiv [2606.25356](https://arxiv.org/abs/2606.25356), Jun 2026). The RepBench benchmark (C/C++) compares raw source, AST, CFG, PDG, combinations and enriched PDGs. **AST+PDG: 83.2% curated accuracy versus 53.5% for raw source (+29.7 pp)**, with **7,980 versus 10,767 input tokens**. Every graph variant beats raw source. **Graph-only prompts beat source+graph prompts** ("context dilution") — [arXiv HTML](https://arxiv.org/html/2606.25356v1). Models used not retrieved.
  - graph-indexer: supports serving *dependence and flow slices* as text for reasoning-heavy questions (security, data flow), not just skeletons. Domain is limited to vulnerability detection.
- **IRCoder: "Intermediate Representations Make Language Models Robust Multilingual Code Generators"** (Paul et al., ACL 2024; [ACL Anthology](https://aclanthology.org/2024.acl-long.802/), [arXiv 2403.03894](https://arxiv.org/abs/2403.03894)). The SLTrans dataset has about **4M source files paired with LLVM IR**. Continued pretraining of 1.1B–7.3B Code-LMs gives consistent gains in prompt robustness, multilingual completion, code understanding and instruction following. This is a *training-time* alignment, not an inference-time representation. Code: [UKPLab/acl2024-ircoder](https://github.com/UKPLab/acl2024-ircoder), license "Other" (NOASSERTION on GitHub).
  - graph-indexer: not usable at inference. IR is also much longer than source, and no token-reduction claim exists.
- **CodeOCR / "Seeing is Coding: On the Effectiveness of Vision Language Models in Code Understanding"** (ISSTA 2026; [arXiv 2602.01785](https://arxiv.org/abs/2602.01785)). Code is rendered as images for multimodal LLMs. **Up to 8x token compression** while still understood. **Syntax highlighting improves code completion under 4x compression.** Clone detection is very robust, and some compression ratios slightly beat raw text. Code: [YerbaPage/CodeOCR](https://github.com/YerbaPage/CodeOCR), **no license** reported.
- **CodeShrink: "Adaptive Visual Compression for Efficient Multimodal Code Understanding"** (arXiv [2607.29637](https://arxiv.org/abs/2607.29637), Jul 2026). Combines blank-free rendering with explicit structure markers, a reinforcement-learning agent that picks the compression configuration, and instruction-aware visual-token pruning. **Up to −71.2% visual tokens** while matching or beating uncompressed text. Python code QA: **82.3% versus 81.0% for uncompressed text at about −40% visual tokens**.
  - graph-indexer: an exotic path. Edits need exact text, so images could only serve "overview" reading. Not recommended as a primary lowering.
- **Tokenizer efficiency by language (measured, informal):**
  - Martin Alderson, ["Which programming languages are most token-efficient?"](https://martinalderson.com/posts/which-programming-languages-are-most-token-efficient/) (Jan 2026). Rosetta Code tasks. **Clojure is most compact; C is least, about 2.6x more tokens.** Secondary coverage gives normalized values of **Clojure 1.00, Python 1.12, Java 1.35, C 2.59** and says Haskell and F# are near the dynamic languages — [WebProNews](https://www.webpronews.com/clojure-tops-ai-token-efficiency-ranking-among-programming-languages/). *Conflict:* sources disagree on the tokenizer used (one says the GPT-4 tokenizer across 19 languages, another says the Llama 3 tokenizer on 100 tasks). The original post could not be fetched. A claim that "J averages 70 tokens per task, APL 110" appears only in secondary aggregation and is unverified.
  - Dan Luu, ["How does programming language affect token efficiency and correctness?"](https://danluu.com/pl-tokens/). Language popularity correlates weakly to moderately with **both correctness and lower cost**. Ruby and Python match or beat Rust, Go and TypeScript. Iteration count likely swamps conciseness.
  - **"The Best Programming Language for Tokenmaxxing"** (arXiv [2607.22807](https://arxiv.org/abs/2607.22807), Jul 2026). 5 recent models on Python, Java, Rust and OCaml tasks controlled for difficulty. **Token consumption varies starkly by language, consistently across models.** Agents produce non-compiling code in unfamiliar languages, revise solutions that already pass, plan in comments, and prototype in Python first — [arXiv HTML](https://arxiv.org/html/2607.22807v1).
  - Claude's tokenizer is reported to be roughly equally dense on English and Rust (blog-level claim, source unclear; unverified).
- **Cross-Lingual Token Arbitrage** (arXiv [2606.03618](https://arxiv.org/abs/2606.03618)). A local Llama 3.2 3B model rewrites non-English, verbose task prompts into compact English before the cloud agent: **−34% to −47% prompt tokens, up to −18.8% total**, with accuracy preserved or improved across 3 commercial backends. This applies to prompt text, not code, but shows that local pre-lowering by a small model works.

### Inferences
- For graph-indexer's "target language", the evidence favours **the original language, formatting-stripped**, over ASTs, IR or new grammars. Models read their training distribution best. AST serialization gives no gain, and IR is only a training aid.
- Structured *graph facts* (call edges, def-use, control dependence) rendered compactly are the one "alternative encoding" with a measured accuracy gain, of +29.7 pp in one domain. They should be served *instead of* redundant raw code for reasoning questions, but *alongside* raw code for edit targets.
- Tokenizer differences between languages are a fact of the repository, not something graph-indexer controls. Per-language lowering rules should be tuned per tokenizer. For example, the Hidden Cost study found newlines dominate for Claude and whitespace for GPT-4o.

### Gaps
- **No public measurements with Claude's current tokenizer** on code formatting or language comparisons beyond Claude-3.7 in the Hidden Cost study. Anthropic's tokenizer is only reachable via the token-counting API. graph-indexer should measure this itself.
- No study was found on "semantic diffs" (AST-level diffs) as LLM input with accuracy numbers.
- No study was found on type-signature-only views across a whole repository beyond HCP (completion) and act-context (editing: no better than deletion).

---

## 5. Work treating "code for LLMs" as a compilation or lowering target, and agentic (SWE-bench-style) evaluations of transformed code

### Takeaway
The explicit "compile human code into an LLM form and back" framing appears in SimPy/Token Sugar ("AI-oriented grammar", with the human and AI forms interconvertible), in the Hidden Cost bidirectional minify/re-beautify tool, and in Ustynov's "decoupling semantic intent from human-readable representation". **None of these was evaluated agentically.** The agentic evidence (SWE-bench Verified) comes instead from compression and pruning work: SWE-Pruner, SWE-Pruner Pro, SWEzze, the minification replication, act-context, retrieval-oriented representations, RIG and Codebase-Memory. It shows **relevance-driven reduction helps (+4 to +9 pp) and blanket lexical reduction hurts (−12 pp)**.

### Cited Findings
- Agentic results summary (all SWE-bench Verified unless noted):
  - SWE-Pruner: −23% to −54% tokens, success improved; −39% with Claude Sonnet 4.5 — [arXiv](https://arxiv.org/abs/2601.16746)
  - SWE-Pruner Pro: up to −39% tokens, +3.8% resolve rate (MiMo-V2-Flash) — [arXiv](https://arxiv.org/abs/2607.18213)
  - SWEzze: about 6x compression, −51.8% to −71.3% tokens, +5.0% to +9.2% resolution (3 frontier LLMs) — [arXiv](https://arxiv.org/abs/2603.28119)
  - Minification (DirectSolve): −42% input, −12 pp resolution — [arXiv](https://arxiv.org/abs/2606.01326)
  - act-context: skeletons of the rest of the file equal deletion; summaries 4/45 versus source 27/45; compressed context equals whole files at one third of the tokens — [arXiv](https://arxiv.org/abs/2607.09691)
  - Retrieval-oriented representations with Agentless: 94% Hit@6 (+4.7%) — [arXiv](https://arxiv.org/abs/2607.11046)
  - RIG with Claude Code, Cursor and Codex: +12.2% accuracy, −53.9% time — [arXiv](https://arxiv.org/abs/2601.10112)
  - Codebase-Memory: 83% versus 92% quality at 10x fewer tokens — [arXiv](https://arxiv.org/abs/2603.27277v1)
- Compilation framing: SimPy is "AI-oriented grammar" with the same AST, so humans use Python and LLMs use SimPy — [arXiv](https://arxiv.org/abs/2404.16333). Hidden Cost has LLMs working on unformatted code and humans on formatted code via an automatic converter — [arXiv](https://arxiv.org/pdf/2508.13666). Ustynov proposes "semantic density optimization" and warns about decoding overhead (+67% cost) — [arXiv](https://arxiv.org/abs/2604.07502).
- Related survey resources: [YerbaPage/Awesome-Agent-Context-Compression](https://github.com/YerbaPage/Awesome-Agent-Context-Compression) (MIT) and [Awesome-Repo-Level-Code-Generation](https://github.com/YerbaPage/Awesome-Repo-Level-Code-Generation) (MIT). These are paper lists maintained by the LongCodeZip and CodeOCR authors.

### Inferences
- A "compiler for AI" in graph-indexer has an empirically backed architecture. It should:
  1. **Front end**: tree-sitter parse, symbol graph and dependence edges (graph-indexer already has this).
  2. **Middle end (slicing)**: given a task or goal hint, select the minimal sufficient set. Evidence: SWEzze/OCD, SWE-Pruner, HCP.
  3. **Back end (lowering)** by role:
     - Localization view: role summaries or skeletons (Agentless; Caumartin et al.).
     - Dependency view: signatures only (HCP).
     - Edit-target view: exact source with formatting stripped and a line map (Hidden Cost; act-context).
     - Reasoning view: compact graph facts (AST+PDG study).
  4. **Never** rename identifiers or drop implementation comments by default.
- Avoid: new grammars (they need training), identifier minification (−12 pp), token-level generic compressors (LLMLingua-2 breaks syntax), and over-compression that moves cost into reasoning (+67%).
- graph-indexer's own evaluation should report **total session cost (input + reasoning + output) and resolve rate**, not input tokens alone.

### Gaps
- No agentic (SWE-bench) evaluation of the SimPy, Token Sugar or Hidden Cost style lossless lowering was found. Whether formatting stripping keeps SWE-bench resolve rates is **unmeasured** and would be a novel contribution.
- No study was found that measures edit-application accuracy (patch-apply failure rate) when the agent reads a lowered view but must edit the original.

---

## 6. What is lost: evidence that comments, docstrings, names or formatting matter

### Takeaway
**Names matter most** (−9.6 to −28.6 pp when removed). **Implementation comments matter for repair** (up to 3x). **Misleading comments and dead code hurt.** **Raw code at the edit site cannot be replaced by summaries or skeletons.** **Formatting does not matter** (single-function completion; agentic effect unmeasured). A compiler must therefore keep names verbatim, keep or summarize comments (flagging stale ones), drop dead code, and keep exact source for the code being edited.

### Cited Findings
- Names: GPT-4o ClassEval summarization 87.3% → 58.7%; execution prediction on ClassEval 85.7 → 76.1 and on LiveCodeBench 85.4 → 71.2 under obfuscation — [When Names Disappear, arXiv 2510.03178](https://www.arxiv.org/pdf/2510.03178). Adversarial renaming causes "semantic displacement" — [arXiv 2606.31725](https://arxiv.org/abs/2606.31725).
- Comments: up to 3x bug-fixing accuracy; comments at inference alone help — [arXiv 2601.23059](https://arxiv.org/abs/2601.23059). The internal comment concept swings performance from −90% to +67% — [Inside Out, ICSE 2026](https://arxiv.org/abs/2512.16790). Comment-augmented training improves code LLMs — [ACL 2024 Findings](https://aclanthology.org/2024.findings-acl.809/).
- Harmful content: misleading comments and dead code cause most robustness loss in LLM fault localization; dead code drops accuracy to 20.38% — [arXiv 2504.04372](https://arxiv.org/html/2504.04372v3).
- Source over summaries at edit time: 27/45 versus 4/45 behavioral questions answered; skeletons equal deletion — [arXiv 2607.09691](https://arxiv.org/abs/2607.09691).
- Aggregate lexical loss: minification cost 12 pp on SWE-bench Verified — [arXiv 2606.01326](https://arxiv.org/abs/2606.01326). A graph-only answer path lost 9 pp of answer quality versus file exploration — [Codebase-Memory](https://arxiv.org/abs/2603.27277v1).
- Formatting: negligible Pass@1 change when removed (10 LLMs, McEval FIM) — [arXiv 2508.13666](https://arxiv.org/pdf/2508.13666).

### Inferences
- The "lossy" budget of a code compiler should be spent on **selection** (which code) rather than **lexical** content (which tokens inside kept code). The only lexical removal with strong zero-cost evidence is formatting.
- Comments are double-edged. The graph-indexer compiler could keep comments but annotate possibly stale ones (for example docstring parameters that do not match the signature), turning a harmful signal into a flagged one. This is untested and a hypothesis only.

### Gaps
- No study was found that isolates **docstrings** (as opposed to inline comments) or **type annotations** in agentic tasks.
- No study was found on replacing comments with shorter LLM summaries of them (the "summarize, don't drop" option).
- Primary tables could not be read (arXiv blocked). Model lists and benchmark subsets for the comment and naming studies are partially unknown.
