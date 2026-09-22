# How production coding agents and code-intelligence tools retrieve codebase context (2024–Sep 2026), and what goes wrong

*Research date: 2026-09-22. Method note: WebFetch was blocked by the session's egress policy for cursor.com, cognition.com, augmentcode.com, github.blog, arxiv.org, latent.space, docs.windsurf.com, code.claude.com, aider.chat and raw.githubusercontent.com. Numbers attributed to those pages come from search-engine extracts of those pages. They are marked "(extract)" and should be spot-checked before they are quoted verbatim. GitHub star counts and issue data were pulled directly from the GitHub API on 2026-09-22. Where a date is inferred from an X or LinkedIn post ID (snowflake timestamp), it is marked "(ID-dated)".*

---

## 1. Claude Code: why "agentic search" instead of RAG, the Explore subagent, the LSP tool, and reported pain points

### Takeaway
Anthropic dropped an early RAG/vector-DB prototype (Voyage embeddings) for plain glob/grep/read "agentic search". It gives four reasons: better results, simplicity, and fewer security, privacy, staleness and reliability problems. It has never published the comparison numbers. Since then it has added deterministic structure (the LSP tool, v2.0.74, Dec 2025) and context isolation (the Haiku-based Explore subagent), but no semantic index. Users' most common complaints are token burn, context filling and compaction loss, costly subagent fan-out, and flaky LSP wiring, not retrieval precision.

### Cited Findings
**Rationale (primary statements)**
- Boris Cherny (Claude Code lead), 2026-02-01 (ID-dated): "Early versions of Claude Code used RAG + a local vector db, but we found pretty quickly that agentic search generally works better. It is also simpler and doesn't have the same issues around security, privacy, staleness, and reliability." — [X/@bcherny](https://x.com/bcherny/status/2017824286489383315)
- The Latent Space podcast (May 2025) says early Claude Code used off-the-shelf RAG with Voyage embeddings. The switch to agentic search happened because it "outperformed everything by a lot", which the team found surprising (extract). — [Latent Space](https://www.latent.space/p/claude-code); secondary recap: [zenn.dev](https://zenn.dev/karamage/articles/2514cf04e0d1ac?locale=en), [vlad.build](https://vlad.build/cc-pod/)
- Anthropic engineering blog (Sept 2025, "Effective context engineering for AI agents"): Claude Code uses "a hybrid model". CLAUDE.md files are "naively dropped into context up front, while primitives like glob and grep allow it to navigate its environment and retrieve files just-in-time, effectively bypassing the issues of stale indexing and complex syntax trees". The post also lists the benefits of just-in-time loading: progressive disclosure, and file names, folder structure and timestamps acting as relevance signals (extract). — [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Practitioner corroboration (anecdotal), 2026-02-03 (ID-dated): "RAG + vector DB gives decent results, but agentic search over the repo (glob/grep/read, etc) consistently worked better on real-world codebases. We even pushed further: RAG + embeddings + AST + tree-sitter…" (truncated). — [X/@dani_avila7](https://x.com/dani_avila7/status/2018766464933613871)

**Explore subagent**
- Explore is a fast, read-only built-in subagent that runs on Haiku. Its tools are Glob, Grep, Read and read-only Bash; it has no Write or Edit. The caller picks a thoroughness level: "quick", "medium" or "very thorough". File discovery and reading happen in Explore's own context, not the main one (extract). — [Claude Code docs: sub-agents](https://code.claude.com/docs/en/sub-agents); [johnlindquist gist](https://gist.github.com/johnlindquist/d22c70fd70660b4f6fb4d0b05d0792d2)
- Third-party guides say Explore skips CLAUDE.md and git status to stay fast and cheap. This is not verified against the official docs. — [ComputingForGeeks](https://computingforgeeks.com/claude-code-subagents-guide/), [Tembo](https://www.tembo.io/blog/claude-code-subagents)
- A user asked for Explore to call project-specific semantic search tools (`pmat query`). The issue is closed. — [anthropics/claude-code#23267](https://github.com/anthropics/claude-code/issues/23267) (2026-02-05)

**LSP tool (first-party structural navigation)**
- v2.0.74 (≈2025-12-20, ID-dated from announcement posts) added an LSP tool for goToDefinition, findReferences, hover, documentSymbol and diagnostics. — [how2shout](https://www.how2shout.com/news/claude-code-v2-0-74-lsp-language-server-protocol-update.html), [petegypps.uk](https://www.petegypps.uk/blog/claude-code-2-0-74-lsp-chrome-integration-december-2025), [X/@oikon48](https://x.com/oikon48/status/2002180037190295769)
- A May 2026 issue also references `hover · incomingCalls · outgoingCalls` for the official typescript-lsp plugin. — [oraios/serena#1470](https://github.com/oraios/serena/issues/1470)
- Language servers arrive as plugins (14+ languages). A plugin only configures the connection and does not ship the server binary ("Executable not found in $PATH"). — [ClaudeLog](https://claudelog.com/faqs/what-is-lsp-tool-in-claude-code/), [claude.com TypeScript LSP plugin](https://claude.com/plugins/typescript-lsp)
- LSP reliability issues open as of 2026-09-22:
  - C# (csharp-ls) is missing the `workspace/configuration` handlers: 34 👍, 54 comments, open since 2026-01-05. — [#16360](https://github.com/anthropics/claude-code/issues/16360)
  - LSP plugins don't work with the native/standalone binary: 14 👍. — [#20050](https://github.com/anthropics/claude-code/issues/20050)
  - The LSP tool is pruned from all subagent tool sets in interactive sessions. — [#84125](https://github.com/anthropics/claude-code/issues/84125) (2026-08-05)
  - The LSP tool is silently stripped from background subagents. — [#80733](https://github.com/anthropics/claude-code/issues/80733)
  - The TypeScript LSP server "wedges silently, returning empty results instead of errors and never recovers after crash". — [#82416](https://github.com/anthropics/claude-code/issues/82416)
  - The gopls and clangd plugins never register an LSP tool (missing `lspServers` wiring). — [#91916](https://github.com/anthropics/claude-code/issues/91916), [#90114](https://github.com/anthropics/claude-code/issues/90114)

**Search backend changes**
- A secondary source says the built-in search moved from ripgrep to embedded ugrep and bfs binaries invoked through Bash around v2.1.117 (April 2026). It is not verified against the official changelog. — [ceaksan.com](https://ceaksan.com/en/grep-ripgrep-and-text-search-in-the-age-of-ai)
- A GitHub issue confirms that ugrep is bundled: "Bundled ugrep runs with no memory limit or timeout — model-generated regex consumed 13.6 GB and thrashed the host." — [#86238](https://github.com/anthropics/claude-code/issues/86238) (2026-08-13, 3 👍)
- In the VS Code extension, the ripgrep resolver falls back to bare `rg`, "silently degrading every @-mention search to a 100-result unranked fallback". — [#93079](https://github.com/anthropics/claude-code/issues/93079) (2026-09-09)

**Token and context pain points (GitHub, reactions as of 2026-09-22)**
- "Currently Claude Code can burn a lot of tokens when trying to review/search for something. Would be great if … Claude Code had a codebase indexing feature to help conserve the amount of tokens used." Open, 68 👍, 16 comments. — [#4556](https://github.com/anthropics/claude-code/issues/4556) (2025-07-27)
- Similar requests were all closed:
  - Semantic search to cut token use — [#20836](https://github.com/anthropics/claude-code/issues/20836) (2026-01)
  - Indexed code search tools — [#40702](https://github.com/anthropics/claude-code/issues/40702) (2026-03)
  - An opt-in local index "to reduce search time and token cost in large repositories" — [#75993](https://github.com/anthropics/claude-code/issues/75993) (2026-07)
- The Read tool has a hard per-file cap: "File content (28375 tokens) exceeds maximum allowed tokens (25000). Please use offset and limit … or use the GrepTool". 63 👍. — [#4002](https://github.com/anthropics/claude-code/issues/4002)
- "Cache read tokens consume 99.93% of usage quota — architectural scaling issue with CLAUDE.md re-reads." — [#24147](https://github.com/anthropics/claude-code/issues/24147) (2026-02)
- General token-rate complaints: 2.1.1 consumed tokens "4x+ faster" (71 👍, 73 comments). — [#16856](https://github.com/anthropics/claude-code/issues/16856)
- Compaction and lost context:
  - Request for "Enhanced /compact with file-backed summaries and selective restoration": 92 👍, 117 total reactions. — [#17428](https://github.com/anthropics/claude-code/issues/17428)
  - "Claude forgets everything in CLAUDE.md after compaction": 30 👍. — [#6354](https://github.com/anthropics/claude-code/issues/6354)
  - "Auto-Compact Erases Entire Chat History Without Warning": 36 👍. — [#7502](https://github.com/anthropics/claude-code/issues/7502)
- Subagent fan-out cost:
  - "general-purpose subagents recursively spawn: 3 requested → 24 ran, 80% of tokens wasted". — [#82565](https://github.com/anthropics/claude-code/issues/82565)
  - "three research agents consumed 1.7M tokens" with no cap. — [#94013](https://github.com/anthropics/claude-code/issues/94013)
  - One workflow invocation spawned "46 Opus subagents (~3M tokens)". — [#66023](https://github.com/anthropics/claude-code/issues/66023)
- A literal "grep storm" in another agent (OpenCode): one assistant step issued dozens of concurrent grep calls, and ripgrep allocations hit the Windows commit limit, followed by a crash. — [anomalyco/opencode#50596](https://github.com/anomalyco/opencode/issues/50596)

**Mitigations Anthropic shipped for tool and context overload**
- MCP Tool Search: when MCP tool definitions would exceed 10% of the context window (`ENABLE_TOOL_SEARCH=auto`), Claude Code defers them. Only tool names and server instructions load at session start, and full schemas load on demand. The source claims ~95% savings on tool-definition tokens. — [claudefa.st](https://claudefa.st/blog/tools/mcp-extensions/mcp-tool-search), [atcyrus](https://www.atcyrus.com/stories/mcp-tool-search-claude-code-context-pollution-guide); API-level Tool Search Tool: [Anthropic "advanced tool use"](https://www.anthropic.com/engineering/advanced-tool-use)
- Anthropic tool-design guidance ("Writing effective tools for agents", Sept 2025) (extract, via a mirror):
  - Claude Code limits tool responses to 25,000 tokens by default.
  - It recommends pagination, range selection, filtering and truncation with sensible defaults.
  - Truncated responses should tell the agent what to do next.
  - Tools can offer a `response_format` of "concise" or "detailed". The extract says concise responses "reduce token usage by approximately one-third". The original example may instead mean concise ≈ one-third of detailed; verify before quoting.
  - It prefers high-leverage tools over thin API wrappers.
  — [MCP docs mirror](https://modelcontextprotocol.info/docs/tutorials/writing-effective-tools/)

**Third-party measurement of Claude Code's retrieval waste (secondary)**
- Kuba Rogut (Turbopuffer) talk, 2026 (from a news summary; figures not checked against the video):
  - Stock Claude Code has about 65% "file precision": roughly one in three file reads is never needed.
  - Adding windowed grep brings waste down to about one in five.
  - Adding semantic search on top raises precision to nearly 90%.
  - Semantic search is "complementary to grep rather than a replacement". The hard part is teaching the agent when to use which tool: Cursor trains its model for this, while Claude Code only receives it as an optional tool.
  — [YouTube](https://www.youtube.com/watch?v=zKk7sDMGDEQ), [BigGo summary](https://finance.biggo.com/news/aed3a6d02a3f1d95), [StartupHub.ai](https://www.startuphub.ai/ai-news/ai-research/2026/claude-code-benchmarking-semantic-search-vs-grep)

### Inferences
- Anthropic's stated reasons (precision, freshness, privacy, simplicity) are about correctness and operations. Users' complaints are about cost: tokens, compaction, and time on large repos. A local index that is fresh, private and deterministic answers the complaints without violating the stated reasons.
- Anthropic added deterministic structure (LSP), not embeddings. That fits its preference for exact over fuzzy results. It also suggests reference and call-hierarchy queries are welcome, while "semantic" retrieval must prove its precision.
- LSP gaps inside subagents (#84125, #80733) and silent empty LSP results (#82416) leave room for an MCP server that works in any agent or subagent. Such a server should distinguish "no results" from "tool failed or incomplete".
- Tool Search deferral means an MCP server's tool names and server instructions are what the model sees first. Tool naming, and a small, obviously-useful default toolset, decide whether the tools get discovered at all.

### Gaps
- Anthropic has never published its RAG-versus-agentic-search numbers: no dataset, metrics or dates beyond "outperformed everything by a lot".
- I could not fetch the official Claude Code changelog to confirm the ugrep switch version or the exact LSP operation list.
- Whether MCP tools are reliably available to Explore and other built-in subagents in 2026 builds is not confirmed. There are LSP-specific pruning bugs, but I found no equivalent MCP data.

---

## 2. Cursor: codebase indexing (Merkle sync, embeddings, Turbopuffer), measured semantic-search gains, embeddings trained from agent traces, Instant Grep, privacy mode

### Takeaway
Cursor is the strongest published evidence that a semantic index helps agents. Its figures: +12.5% average question-answering accuracy (6.5–23.5% depending on the model), and online A/B gains that are small overall but larger on repos with 1,000 or more files. Cursor still pairs the index with grep, and in March 2026 it built a client-side n-gram index for regex because ripgrep took more than 15 seconds on big monorepos. Indexing infrastructure (Merkle sync, index reuse across teammates, obfuscated paths) is where most of the engineering effort went.

### Cited Findings
- Semantic search blog (≈2025-11-05, ID-dated from the announcement) (extract):
  - Semantic search gives "on average 12.5% higher accuracy in answering questions (6.5%–23.5% depending on the model)".
  - In online A/B tests, code retention rises 0.3%, and 2.6% on codebases with 1,000 or more files.
  - Without semantic search there were 2.2% more dissatisfied follow-up requests.
  - Cursor trained its own embedding model on agent session traces. Traces show which searches and file opens eventually led to the right code, so Cursor can "see in retrospect what should have been retrieved earlier".
  — [Cursor blog](https://cursor.com/blog/semsearch), [ZenML summary](https://www.zenml.io/llmops-database/enhancing-ai-coding-agent-performance-with-custom-semantic-search)
- Cursor's announcement: "Semantic search improves our agent's accuracy across all frontier models, especially in large codebases where grep alone falls short." — [X/@cursor_ai](https://x.com/cursor_ai/status/1986124270548709620)
- "Securely indexing large codebases" (≈late Jan 2026; commentary posts ID-dated 2026-02-01) (extract):
  - A Merkle tree of file hashes, with folder hashes derived from their children, detects exactly which files changed.
  - A 64-bit simhash of the codebase (file hashes plus sizes) finds the most similar existing index in the organization.
  - If similarity is above a threshold, the new user's namespace is seeded from that index and can be queried at once while a background sync reconciles differences.
  - The client sends a Merkle proof per file, and the server "only returns data for files the client can prove it has".
  - Time-to-first-query fell "from more than four hours to 21 seconds on the largest repositories".
  — [Cursor blog](https://cursor.com/blog/secure-codebase-indexing), [CTOL](https://www.ctol.digital/news/cursor-secure-shared-code-indexes-speed-up-enterprise-ai-search/), [LinkedIn commentary](https://www.linkedin.com/posts/chirag-patil-1336b3171_securely-indexing-large-codebases-activity-7423769373674192896-iYkM)
- Privacy (extract):
  - Embeddings and metadata (obfuscated file paths) are stored in Turbopuffer on Google Cloud in the US.
  - In privacy mode, no plaintext code is stored on Cursor's servers or in Turbopuffer.
  - Paths are obfuscated on the client, component by component, with a secret key and nonce, e.g. `src/payments/invoice_processor.py` becomes `a9f3/x72k/qp1m8d.f4`. This keeps directory structure so results can be filtered by path.
  — [Cursor security page](https://cursor.com/en-US/security), [Simon Willison, 2025-05-11](https://simonwillison.net/2025/May/11/cursor-security/)
- Instant Grep, "Fast regex search: indexing text for agent tools" (≈March 2026; social coverage ID-dated 2026-03-23) (extract):
  - ripgrep had to scan every file in large monorepos, and "some searches taking over 15 seconds" stalled agents.
  - The fix is a local, client-side sparse n-gram inverted index. Regex patterns are decomposed into n-grams weighted by character-pair frequency; coverage also mentions bloom filters.
  - Regex latency fell from 16.8 s with ripgrep to 13 ms in Cursor's internal benchmark.
  - The index works over raw character chunks, not language tokens, "because regex works on raw text".
  — [Cursor blog](https://cursor.com/blog/fast-regex-search), [ZenML](https://www.zenml.io/llmops-database/fast-regex-search-indexing-for-ai-agent-tool-performance), [Analytics India Mag](https://analyticsindiamag.com/ai-news/cursor-delivers-99-faster-ai-code-search-with-instant-grep), [X/@rohanpaul_ai](https://x.com/rohanpaul_ai/status/2036150628712587449)
- Turbopuffer's talk says Cursor's gain comes partly from training the model on when to use semantic search, not just from exposing a tool (secondary). — [BigGo summary](https://finance.biggo.com/news/aed3a6d02a3f1d95)

### Inferences
- Cursor's gains are largest on big repos (+2.6% retention at 1,000+ files versus +0.3% overall). Expected value is therefore concentrated in large, unfamiliar codebases, and small repos may see little benefit.
- Cursor built both a semantic index and a regex index. Even a grep-first agent benefits from indexing when repos are large. A fast lexical or regex index is a low-controversy addition, because it matches how agents already search.
- "Training embeddings from agent traces" is not available to an offline MCP server. The analogous move is to log which files the agent eventually edited or read after each query and use that for ranking or evaluation, locally and with consent.

### Gaps
- Chunking strategy (AST or size), embedding dimensions, reranking, and the name and size of Cursor's offline eval set were not retrieved.
- Whether plaintext chunks transit Cursor's servers for embedding computation in privacy mode was not verified this session. The policy text above only covers storage.
- The Instant Grep index build and update costs (memory, disk, incremental update latency) were not retrieved.

---

## 3. "Fast context" retrieval subagents: Cognition/Windsurf SWE-grep, Morph WarpGrep, Relace FAS, and similar

### Takeaway
From late 2025 the industry converged on small RL-trained retrieval subagents, run on fast inference. They fire many parallel grep, glob and read calls over a few turns in an isolated context and return only file and line ranges. The claimed gains are mostly latency (up to 20x) and context hygiene (fewer input tokens), with modest resolve-rate gains (+2 to +4 points on SWE-bench Pro). All numbers are vendor-reported. One independent 2026 study found that handing off between planner and subagent is a major silent-failure point.

### Cited Findings
- **SWE-grep and SWE-grep-mini** (Cognition/Windsurf, 2025-10-16, ID-dated) (extract):
  - RL-trained "fast agentic models specialized in highly parallel context retrieval" that "match the retrieval capabilities of frontier coding models while taking an order of magnitude less time".
  - Each episode allows up to 8 parallel tool calls per turn and at most 4 turns.
  - The reward is "an average of weighted F1 scores over file retrieval and line retrieval tasks" against ground truth.
  - SWE-grep-mini is served at more than 2,800 tok/s on Cerebras.
  - The Windsurf Fast Context subagent triggers automatically when Cascade needs code search and is "up to 20x faster".
  — [Cognition blog](https://cognition.com/blog/swe-grep), [Windsurf docs: Fast Context](https://docs.windsurf.com/context-awareness/fast-context), [Windsurf LinkedIn](https://www.linkedin.com/posts/windsurf_introducing-the-new-fast-context-subagent-activity-7384664960938758145-Z29u)
- Motivation: "When you ask an agent to work on a large codebase, it can spend 60% of its time just searching for relevant files" (Cerebras). Cognition says agents spent more than 60% of their first turn retrieving context, and that on ~1M-line repos (React, Vercel, PyTorch) SWE-grep finds snippets "in a few seconds, compared to minutes on Claude and Cursor" (vendor claim). — [X/@cerebras](https://x.com/cerebras/status/1978874694825840679), [Cerebras case study](https://www.cerebras.ai/blog/case-study-cognition-x-cerebras), [Cognition blog](https://cognition.com/blog/swe-grep)
- Academic critique (Jan 2026 arXiv, extract): SWE-grep "issue[s] fixed parallel calls, requiring expensive inference infrastructure (Cerebras at 2800+ tokens/s)". The paper proposes adaptive parallelism instead. — [arXiv 2601.19568](https://arxiv.org/pdf/2601.19568)
- **Morph WarpGrep v1** (2025-11-28, ID-dated): "speeds up coding tasks 40% and reduces context rot by 70% on long horizon tasks by treating context retrieval as its own RL trained system. Inspired by Cognition's SWE-Grep." — [X/@morphllm](https://x.com/morphllm/status/1994484969050444103)
- **WarpGrep v2** (2026-03-02, ID-dated), vendor figures:
  - SWE-bench Pro: Opus 4.6 goes from 55.4 to 57.5 (+2.1); Codex 5.3 CLI reaches 59.1 (+3.1); MiniMax 2.5 reaches 57.6 (+3.7).
  - Runs are "15.6% cheaper and 28% faster" than letting the coding model search on its own.
  - An isolated-context search subagent "cuts input tokens by 39%, reduces agent turns by 26%, and improves solve rate by 10% with Opus".
  — [Morph blog](https://www.morphllm.com/blog/warpgrep-v2), [X/@morphllm](https://x.com/morphllm/status/2028558718485541075), [Morph benchmarks](https://www.morphllm.com/benchmarks/warp-grep)
- OpenHands has an open proposal to integrate WarpGrep as a search subagent. — [OpenHands/software-agent-sdk#2411](https://github.com/OpenHands/software-agent-sdk/issues/2411)
- **Relace Fast Agentic Search (FAS)**, undated (extract):
  - An RL-trained subagent using parallel `view_file`, `grep` and `bash` calls, "4-12 tool calls per turn". A `report_back` tool packages results into a minimal set of files.
  - Parallel execution gave a 4x speedup, cutting turns from 12–24 s to 1–2 s. Each tool call takes about 1–2 s depending on repo size.
  - Available as `relace-search` on OpenRouter.
  — [Relace blog](https://relace.ai/blog/fast-agentic-search), [Relace docs](https://docs.relace.ai/docs/fast-agentic-search/agent), [OpenRouter](https://openrouter.ai/relace/relace-search)
- **Amp (spun out of Sourcegraph)**:
  - The main agent spawns a read-only Search subagent with its own context window. Per the extract, an investigation "might consume 30k+ tokens"; the exact source page is uncertain.
  - The Librarian subagent searches remote GitHub code, public and private.
  - The Oracle subagent gives a second opinion from a different model.
  — [Amp tools docs](https://ampcode.com/docs/tools), [Amp "Agents for the Agent"](https://ampcode.com/notes/agents-for-the-agent), [Amp Librarian](https://ampcode.com/news/librarian)
- **Gemini CLI `codebase_investigator`** (preview ≈Oct 2025): runs in a separate context loop and returns a structured report. The report has a summary, the steps and tools used, and "a list of relevant files with the key symbols within them". — [Gemini CLI docs](https://geminicli.com/docs/core/subagents/), [discussion #11375](https://github.com/google-gemini/gemini-cli/discussions/11375), [Google Developers Blog](https://developers.googleblog.com/subagents-have-arrived-in-gemini-cli/)
- Claude Code's Explore (Haiku, read-only, three thoroughness levels) follows the same pattern; see section 1.
- **Counter-evidence** (Aug 2026 empirical study, extract): 41.8% of "deep agentic search" failures happened "at the hand-off between the planner and its sub-agent". These failures were "usually silent, ending in a fluent and confident answer that was wrong". — [arXiv 2608.01507](https://arxiv.org/abs/2608.01507)

### Inferences
- The output contract of these subagents is small and precise: files plus line ranges, and optionally key symbols, never whole files. That is the shape an MCP index should return too, so its answers slot into the same place in the main agent's context.
- Speed matters as much as precision. The commercial pitch is "within the flow window" (seconds). An offline index answering in milliseconds can replace several rounds of parallel grep, a latency advantage that needs no custom model.
- A local MCP server cannot run an RL-tuned model at 2,800 tok/s, but it can offer the same outcome deterministically: a "locate" tool returning ranked file and line spans, used by whichever subagent the host agent spawns.

### Gaps
- SWE-grep's per-model F1 numbers, its eval dataset name and size, its exact tool whitelist, and its end-to-end task-time figures were not retrieved (Cognition page blocked).
- No independent replication of the WarpGrep, SWE-grep or Relace claims was found.
- Relace FAS's release date and accuracy metrics were not retrieved.

---

## 4. Other commercial systems: Augment, Sourcegraph/Amp, GitHub Copilot, Codex CLI, Gemini CLI/Jules, JetBrains, Continue, Tabby, Greptile, Aider

### Takeaway
The market has split in two:
- **Terminal agents stay index-free.** Codex CLI (rg), Gemini CLI (grep/glob plus an investigator subagent) and Claude Code rely on plain search.
- **Platforms sell context as a service, increasingly over MCP.** These are Augment's Context Engine MCP (GA Feb 2026), Sourcegraph MCP with precise SCIP navigation, JetBrains Context (Jul 2026), Copilot's embeddings plus a remote index, and Greptile's graph.

Vendor-reported gains range from large (Augment +70–80%, JetBrains −48% cost) to marginal: Copilot's coding agent completes tasks in 2% less time with semantic search and no quality change.

### Cited Findings
**Augment Code Context Engine (MCP GA 2026-02-06)** (extract)
- Two modes. Local mode runs Auggie CLI as a stdio MCP server with real-time indexing of the working directory. Remote mode is a hosted engine over HTTP with a GitHub App for cross-repo and CI context. — [Augment changelog](https://www.augmentcode.com/changelog/context-engine-mcp-in-ga), [docs](https://docs.augmentcode.com/context-services/mcp/overview)
- Vendor benchmark:
  - 300 Elasticsearch PRs × 3 prompts, 900 attempts; each task is "take a natural-language prompt and ship a complete PR".
  - "70%+" improvement across Claude Code, Cursor and Codex.
  - Cursor + Opus 4.5: +71% (completeness +60%, correctness 5x).
  - Claude Code: +80% (+41% pass rate).
  - Also "fewer tool calls and conversation turns" and lower token cost; no figures were retrieved for these.
  — [Augment blog](https://www.augmentcode.com/blog/context-engine-mcp-now-live)

**Sourcegraph / Amp**
- Cody Free and Pro were discontinued on 2025-07-23, with sign-ups closed from 2025-06-25. Amp entered research preview in May 2025 and was spun off as a separate company in December 2025. — [Sourcegraph blog](https://sourcegraph.com/blog/changes-to-cody-free-pro-and-enterprise-starter-plans), [Wikipedia](https://en.wikipedia.org/wiki/Sourcegraph)
- Sourcegraph now positions itself as the context layer for third-party agents. Its MCP server offers search, code navigation, Deep Search, file browsing and commit/diff search. Cross-repo go-to-definition and find-references work out of the box, and optional SCIP indexing makes them more precise. — [Sourcegraph MCP](https://sourcegraph.com/mcp)
- On 2026-03-30 the default `/.api/mcp` endpoint switched to "a curated set of tools focused on common context gathering". The full set (deepsearch, go_to_definition, find_references, compare_revisions, get_contributor_repos) moved to `/.api/mcp/all`. — [Sourcegraph changelog](https://sourcegraph.com/changelog/mcp-curated-default-tools)
- "Code Finder" is an agentic search tool inside the MCP server. It runs its own search loop and returns file paths and line ranges with a note on each (extract). — [Sourcegraph MCP](https://sourcegraph.com/mcp)
- Sourcegraph's position (extract): "Approximate retrieval is fine on a small repo. On Big Code, it returns plausible-looking results that miss cross-cutting impact, and the agent ships plausible-looking code with latent bugs". It favors deterministic answers: "exact symbol references, every callsite, every interface implementer". — [Sourcegraph: Agentic Coding in 2026](https://sourcegraph.com/blog/agentic-coding), [context tools compared](https://sourcegraph.com/resources/context-compare)
- SCIP moved to open governance in March 2026, with a steering committee that includes Uber, Meta and Sourcegraph (extract). — [scip-code.org](https://scip-code.org/)

**GitHub Copilot**
- New embedding model (announced ≈2025-10-24, ID-dated) (extract):
  - "37.6% lift in retrieval quality" (average score 0.362 to 0.498), "~2x higher throughput", and an "8x smaller index".
  - Code acceptance ratios rose 110.7% for C# and 113.1% for Java.
  - Trained with contrastive InfoNCE, Matryoshka representation learning and hard negatives.
  - Powers chat and the agent, edit and ask modes in VS Code.
  — [GitHub blog](https://github.blog/news-insights/product-news/copilot-new-embedding-model-vs-code/), [X/@github](https://x.com/github/status/1981727394663731598), [InfoQ](https://www.infoq.com/news/2025/10/github-embedding-model)
- Instant semantic code search indexing reached GA on 2025-03-12. Indexing time fell from about 5 minutes to seconds (at most 60 s). — [GitHub changelog](https://github.blog/changelog/2025-03-12-instant-semantic-code-search-indexing-now-generally-available-for-github-copilot/)
- In VS Code, the "remote index" queries GitHub's pre-built index and adds a targeted search of locally modified files (extract). — [VS Code docs](https://code.visualstudio.com/docs/agents/reference/workspace-context)
- Copilot coding agent semantic code search tool (2026-03-17): "Copilot completes tasks in 2% less time with the new semantic code search tool without any change in quality". It is used automatically "when the agent doesn't know the precise names or patterns to search for". — [GitHub changelog](https://github.blog/changelog/2026-03-17-copilot-coding-agent-works-faster-with-semantic-code-search/)

**OpenAI Codex CLI**
- No embeddings or index. The core prompt reportedly says "When searching for text or files, prefer `rg` / `rg --files` since rg is faster than grep" (secondary). — [yage.ai, 2026-03-27](https://yage.ai/share/why-coding-agents-still-use-grep-en-20260327.html)
- Related issues: "Codex assumes ripgrep is installed" — [openai/codex#1205](https://github.com/openai/codex/issues/1205); Codex Desktop doesn't detect its bundled ripgrep — [openai/codex#26905](https://github.com/openai/codex/issues/26905)

**Google Gemini CLI / Jules**
- Gemini CLI tools are `glob`, `search_file_content` (git grep, then system grep, then a JS fallback), `read_file` and `read_many_files`. There is no semantic index. — [Gemini CLI docs](https://geminicli.com/docs/tools/file-system/), [wietsevenema.eu (2025)](https://wietsevenema.eu/blog/2025/how-gemini-cli-builds-context/)
- Issue #17112, "Gemini CLI should avoid searches that fill up the main context window": `search_file_content` only truncates at 20,000 matches ("potentially 100k+ tokens"), and `glob` does not truncate at all ("50,000 file paths… all enter the context"). — [google-gemini/gemini-cli#17112](https://github.com/google-gemini/gemini-cli/issues/17112)
- The `codebase_investigator` subagent is covered in section 3.

**JetBrains**
- Junie CLI can connect to a running JetBrains IDE (April 2026) and use its indexing and semantic analysis. Renames use the IDE's semantic index "to find every usage". — [JetBrains blog](https://blog.jetbrains.com/junie/2026/04/junie-cli-inside-your-jb-ide/)
- A 2025 forum thread says Junie did not then fully use PSI for project-wide analysis. This is outdated relative to the April 2026 change. — [JetBrains support forum](https://intellij-support.jetbrains.com/hc/en-us/community/posts/28021743686802-Does-Junie-use-Jetbrains-IDEs-internal-codebase-knowledge-ie-PSI)
- JetBrains Context (July 2026, early access, included in a JetBrains AI subscription):
  - A semantic index plus cross-repo knowledge, code examples and conventions.
  - Wired into Claude Code, Codex CLI and Junie CLI through open skills, subagents, hooks, MCP config and AGENTS.md. The repo has 29 stars as of 2026-09-22.
  - Vendor benchmarks on SWE-bench and production monorepo tasks: "up to 68% reduction in agent turns, 59% lower latency, and 48% lower execution cost".
  - Multi-repo search reaches repos that are not checked out locally.
  — [JetBrains blog](https://blog.jetbrains.com/ai/2026/07/introducing-jetbrains-context-repository-intelligence-for-coding-agents/), [product page](https://www.jetbrains.com/context/), [JetBrains/context](https://github.com/JetBrains/context)

**Continue**
- The `@Codebase` context provider is deprecated. Agent mode now relies on built-in file-exploration and search tools, plus rules files and MCP servers. Continue still indexes with local embeddings (all-MiniLM-L6-v2 by default, stored in `~/.continue/index`) plus keyword search (extract). — [Continue docs: @Codebase (Deprecated)](https://docs.continue.dev/reference/deprecated-codebase), [Continue guide](https://docs.continue.dev/guides/codebase-documentation-awareness)

**Greptile**
- "Codebases are uniquely hard to search semantically":
  - The similarity between a query and a natural-language description of code is about 12% higher than between the query and the code itself.
  - Naive search for "Session management code" returned files that merely mention "management" or "session".
  - Per-file chunks add noise.
  - Greptile's fix: parse the AST, "recursively generate docstrings for each node", embed the docstrings, and combine semantic, keyword and "agentic" search.
  — [Greptile blog](https://www.greptile.com/blog/semantic)
- For PR review, Greptile builds a repo graph of files, functions and dependencies to check changes against the wider codebase (extract). — [Greptile docs](https://www.greptile.com/docs/introduction), [greptile.com](https://www.greptile.com/)
- Greptile v3 (late 2025) reportedly uses Anthropic's Claude Agent SDK for multi-hop investigation (third-party claim). — [DEV roundup](https://dev.to/heraldofsolace/the-best-ai-code-review-tools-of-2026-2mb3)

**Aider repo-map**
- Tree-sitter tag queries extract definitions and references. Files become graph nodes and references become weighted edges. Personalized PageRank, biased toward files in the chat, ranks the graph, and the result is packed into a token budget (`--map-tokens`, default 1k). The design dates from 2023 but is still current. — [Aider docs](https://aider.chat/docs/repomap.html), [Aider blog 2023-10-22](https://aider.chat/2023/10/22/repomap.html)
- An independent July 2026 benchmark found RepoMap gave the best "budgeted context yield at 8K tokens"; see section 6. — [arXiv 2607.24882](https://arxiv.org/abs/2607.24882)

### Inferences
- Productizing context over MCP (Augment Feb 2026, Sourcegraph curated tools Mar 2026, JetBrains Jul 2026) confirms that "context engine as an MCP server for Claude Code, Codex and Cursor" is a recognized category. Local-first, privacy-preserving and free is the space those cloud and paid offerings leave open.
- Sourcegraph and JetBrains shipping curated or default tool sets, plus skills and hooks, shows a lesson learned: a small default toolset plus agent-side instructions matter as much as retrieval quality.
- Copilot's 2% result is the clearest sign that when a strong grep-capable agent already exists, a semantic tool may add little on average. Gains concentrate in queries where names are unknown.

### Gaps
- Augment's grading method (human, LLM-judge or tests) and baseline configuration were not retrieved. No independent replication was found.
- Details on Zoekt (Sourcegraph's trigram engine), GitHub's Blackbird code search engine, Tabby's repository-context retrieval, Jules's retrieval, and JetBrains AI Assistant's codebase mode were not retrieved this session.
- The JetBrains Context benchmark methodology and baseline were not retrieved.

---

## 5. Open-source MCP code-intelligence servers: tools, architecture, adoption, and reported issues

### Takeaway
Adoption has exploded for graph-style MCP servers: GitNexus has about 47.5k stars and codebase-memory-mcp about 44.2k (it launched in Feb 2026), ahead of Serena (29.7k, LSP-based) and claude-context (12.6k, vector). Their issue trackers show the same failure modes again and again:
- Indexing is slow or crashes on very large repos.
- Results go stale after re-indexing or switching branches.
- Tools return empty or "no results" silently.
- Heuristic call graphs have false negatives (dependency injection, dynamic dispatch) that agents read as "dead code".
- Agents don't paginate truncated results.
- Agents keep using built-in grep and read unless hooks nudge them.

### Cited Findings
**Adoption snapshot (GitHub API, 2026-09-22):**

| Repo | Stars | Created | Language | Note |
|---|---|---|---|---|
| abhigyanpatwari/GitNexus | 47,519 | 2025-08-02 | TS | |
| DeusData/codebase-memory-mcp | 44,163 | 2026-02-24 | C | |
| oraios/serena | 29,715 | 2025-03-23 | Python | |
| zilliztech/claude-context | 12,562 | 2025-06-06 | TS | |
| vitali87/code-graph-rag | 5,167 | 2025-06-16 | Python | |
| mixedbread-ai/mgrep | 4,402 | 2025-11-06 | TS | |
| CodeGraphContext/CodeGraphContext | 4,220 | 2025-08-16 | Python | |
| BeaconBay/ck | 1,729 | 2025-08-30 | Rust | |
| isaacphi/mcp-language-server | 1,596 | 2024-12-30 | Go | |
| cased/kit | 1,311 | 2025-04-21 | Python | |
| johnhuang316/code-index-mcp | 1,002 | 2025-03-18 | Python | |
| bartolli/codanna | 743 | 2025-07-24 | Rust | |
| probelabs/probe | 714 | 2025-03-05 | Rust | |
| wrale/mcp-server-tree-sitter | 309 | 2025-03-16 | Python | archived |
| jonrad/lsp-mcp | 191 | 2025-02-23 | TS | |
| JetBrains/context | 29 | 2026-03-17 | Shell | |

— [GitHub search API results for these repos](https://github.com/abhigyanpatwari/GitNexus), [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp), [serena](https://github.com/oraios/serena), [claude-context](https://github.com/zilliztech/claude-context), [mcp-server-tree-sitter (archived)](https://github.com/wrale/mcp-server-tree-sitter)

**GitNexus** (knowledge graph with blast radius)
- Tools: `query`, `context` (callers, callees and processes for one symbol), `impact` (a depth-grouped dependency list with a confidence score per entry, i.e. "blast radius"), `detect_changes` (maps a git diff to affected execution flows with a risk level), `cypher`, and `group_query`. Dependency structure is precomputed at index time so one `impact` call replaces 10+ graph queries. — [ARCHITECTURE.md](https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md), [MarkTechPost 2026-04-24](https://www.marktechpost.com/2026/04/24/meet-gitnexus-an-open-source-mcp-native-knowledge-graph-engine-that-gives-claude-code-and-cursor-full-codebase-structural-awareness/)
- Issues:
  - "MCP server returns stale data after gitnexus analyze re-indexes the database" — [#297](https://github.com/abhigyanpatwari/GitNexus/issues/297)
  - "Full re-index required after branch switch or code changes is impractical for large projects" — [#76](https://github.com/abhigyanpatwari/GitNexus/issues/76)
  - Crashes on LLVM21, Chrome and the Linux kernel — [#65](https://github.com/abhigyanpatwari/GitNexus/issues/65)
  - "Maximum call stack size exceeded" on large repos — [#772](https://github.com/abhigyanpatwari/GitNexus/issues/772)
  - "large repo too slow, and nothing output for hours" — [#2031](https://github.com/abhigyanpatwari/GitNexus/issues/2031)
  - Full-text-search indexes fail on large repos and return empty results — [#1715](https://github.com/abhigyanpatwari/GitNexus/issues/1715)
  - Embeddings can leave the database locked — [#1216](https://github.com/abhigyanpatwari/GitNexus/issues/1216)

**codebase-memory-mcp** (C single binary, Tree-sitter knowledge graph)
- Tools include `search_graph`, `trace_path`, `get_architecture`, `detect_changes`, `query_graph` and `check_index_coverage`. The README claims 158 languages, sub-ms queries and "99% fewer tokens". — [README](https://github.com/DeusData/codebase-memory-mcp), [guide](https://www.aibuilderclub.com/blog/codebase-memory-mcp-guide)
- Its own paper (Mar 2026), across 31 real repos: "83% answer quality versus 92% for a file-exploration agent, at ten times fewer tokens and 2.1 times fewer tool calls". Five structural questions took about 3,400 tokens versus about 412,000 via grep exploration (extract). — [arXiv 2603.27277](https://arxiv.org/abs/2603.27277v1)
- Issue #1382, a user benchmark:
  - 300 runs on apache/kafka (184k nodes) and jackrabbit-oak (132k nodes), with Claude Code on Haiku 4.5.
  - "In practice agents frequently do not page, and nothing else in the payload signals that an answer is partial. The result is a confidently-worded but incomplete answer."
  - On jackrabbit-oak, grep-only reached recall 0.723 (precision 0.455, 34 files listed for a 6.5-file answer). Grep plus the graph reached recall 0.525 (precision 0.453, 20 files).
  - 429 responses carried `has_more`.
  — [#1382](https://github.com/DeusData/codebase-memory-mcp/issues/1382) (2026-07-31)
- Issue #2265:
  - `trace_path` reports `callers_total: 0` with relation `eq` (i.e. exact) for calls through injected receivers: destructured factory parameters, `this.dep`, and objects of functions. The resolver had recorded the unresolved site but dropped it.
  - The reporter: "'This function has no callers' is the answer that leads an agent to conclude code is dead. We currently mitigate with an operating rule ('confirm any zero with grep')."
  - Also seen on a 13k-node Node.js repo using `crearX({ dep })` factory injection.
  — [#2265](https://github.com/DeusData/codebase-memory-mcp/issues/2265) (2026-09-21)
- Other issues:
  - An MCP `search_graph` call hangs for more than 476 s under Codex while the same CLI call is instant — [#1418](https://github.com/DeusData/codebase-memory-mcp/issues/1418)
  - False-positive CALLS edges (builtins, framework calls) — [#476](https://github.com/DeusData/codebase-memory-mcp/issues/476)
  - "a change removed 11.4% of all CALLS edges with every suite green" — [#1890](https://github.com/DeusData/codebase-memory-mcp/issues/1890)
  - `trace_path` returns empty despite CALLS edges existing — [#1110](https://github.com/DeusData/codebase-memory-mcp/issues/1110)

**Serena** (LSP over MCP, with symbolic editing)
- Serena "does not parse code itself". It launches language servers (40+ languages), or a paid JetBrains plugin backend, and exposes tools such as `find_symbol`, `find_referencing_symbols`, `get_symbols_overview`, `replace_symbol_body`, `insert_after_symbol`, `rename` and `safe_delete`. — [Serena tools docs](https://oraios.github.io/serena/01-about/035_tools.html), [review](https://andrew.ooo/posts/serena-mcp-coding-agent-ide-review/)
- Issues:
  - Initial indexing timeouts — [#308](https://github.com/oraios/serena/issues/308)
  - Long indexing on LLVM — [#890](https://github.com/oraios/serena/issues/890)
  - Swift indexing timeouts — [#876](https://github.com/oraios/serena/issues/876)
  - File filtering needed for large repos — [#751](https://github.com/oraios/serena/issues/751)
  - "Consider trimming the output to make things more token efficient" — [#424](https://github.com/oraios/serena/issues/424)
  - `read_only` mode still advertises 14 tools when only 7 are callable — [#1938](https://github.com/oraios/serena/issues/1938)
  - Structured tool output investigation — [#1042](https://github.com/oraios/serena/issues/1042)
- Adoption hooks: Serena ships `serena-hooks remind`, which nudges the agent "after N consecutive raw reads/greps". A user built a hard-blocking "serena-guard" that blocks every Read or grep on code files and pre-fills the equivalent Serena call. The stated reason was wanting "every direct code-file access blocked up front". — [#1470](https://github.com/oraios/serena/issues/1470), [#1398](https://github.com/oraios/serena/issues/1398)

**claude-context (Zilliz)** (vector search over Milvus/Zilliz Cloud)
- Uses embeddings (OpenAI, Voyage, Ollama and others), Merkle-tree incremental sync, and a Milvus or Zilliz Cloud backend. — [README](https://github.com/zilliztech/claude-context)
- Vendor eval: 30 SWE-bench Verified instances (15–60 min difficulty, exactly 2 files modified). "Token usage dropped by over 40%, without any loss in recall" versus a baseline with read, grep and edit only. — [Zilliz blog](https://zilliz.com/blog/why-im-against-claude-codes-grep-only-retrieval-it-just-burns-too-many-tokens), [evaluation dir](https://github.com/zilliztech/claude-context/tree/master/evaluation)
- Issues:
  - "Indexing succeeds but then search_code right after that says code base is not indexed" (33 comments) — [#145](https://github.com/zilliztech/claude-context/issues/145)
  - search_code fails despite successful indexing (11 reactions) — [#226](https://github.com/zilliztech/claude-context/issues/226)
  - Collection creation errors — [#215](https://github.com/zilliztech/claude-context/issues/215)
  - Ollama batch errors — [#170](https://github.com/zilliztech/claude-context/issues/170)
  - gRPC DEADLINE_EXCEEDED during indexing — [#290](https://github.com/zilliztech/claude-context/issues/290)
  - Infinite force-reindex loop — [#295](https://github.com/zilliztech/claude-context/issues/295)
  - Snapshot file overwritten — [#276](https://github.com/zilliztech/claude-context/issues/276)
  - Indexing progress visibility — [#99](https://github.com/zilliztech/claude-context/issues/99)

**mgrep (Mixedbread)** (cloud-backed semantic grep, CLI-native)
- Vendor 50-task benchmark: "~2x fewer tokens than grep-based workflows at similar or better judged quality", $0.23 versus $0.49 per task, 82 s versus 158 s, and a 76% LLM-judge win rate. — [README](https://github.com/mixedbread-ai/mgrep)
- Open request "Fully Offline Use" (6 👍), showing the privacy and offline gap. — [#31](https://github.com/mixedbread-ai/mgrep/issues/31)

**CodeGraphContext**
- Parses with Tree-sitter or SCIP indexers into a property graph. Backends: FalkorDB Lite by default, or KuzuDB, LadybugDB or Neo4j. 23 languages. Runs as both CLI and MCP server. — [README](https://github.com/CodeGraphContext/CodeGraphContext), [PyPI](https://pypi.org/project/codegraphcontext/)
- Issues:
  - "The indexing code is too slow" — [#751](https://github.com/CodeGraphContext/CodeGraphContext/issues/751)
  - No progress feedback on large repos — [#1021](https://github.com/CodeGraphContext/CodeGraphContext/issues/1021), [#1050](https://github.com/CodeGraphContext/CodeGraphContext/issues/1050)
  - Incremental indexing to avoid full re-scans — [#310](https://github.com/CodeGraphContext/CodeGraphContext/issues/310)
  - Parallelized indexers — [#710](https://github.com/CodeGraphContext/CodeGraphContext/issues/710)
  - AST/parse cache — [#1288](https://github.com/CodeGraphContext/CodeGraphContext/issues/1288)
  - Duplicate repo entries for different path formats — [#1149](https://github.com/CodeGraphContext/CodeGraphContext/issues/1149)
  - Broken on macOS — [#576](https://github.com/CodeGraphContext/CodeGraphContext/issues/576)

**code-graph-rag**
- Builds a Tree-sitter graph in Memgraph that can be queried and edited in plain English. Includes cross-service tools using EXPOSES and RESOLVES_TO edges for endpoints. Needs an external graph DB. — [README](https://github.com/vitali87/code-graph-rag)

**ck (BeaconBay)** (local-first semantic plus hybrid BM25 grep, built-in MCP)
- Indexes are created and refreshed automatically before searches. Only changed chunks are re-embedded ("80-90% cache hit rate"). Around 1M lines of code index in under 2 minutes, with sub-500 ms queries. blake3-hash invalidation protects against model switches. Fully local. — [ck site](https://beaconbay.github.io/ck/), [GitHub](https://github.com/BeaconBay/ck)

**Probe (probelabs)** (no index)
- ripgrep scanning plus Tree-sitter returns whole functions and classes. Supports Elasticsearch-style boolean queries and BM25/TF-IDF ranking. "Zero indexing — no embedding models, no vector databases". Local only. — [GitHub](https://github.com/probelabs/probe), [probelabs.com](https://probelabs.com/features)

**codanna** (Rust, local)
- Tools: `find_callers`, `get_calls`, `analyze_impact`, and `semantic_search_with_context`. The last fuses symbol, signature, docstring, callees, callers and recursive impact into one response. "No source code leaves your machine." — [GitHub](https://github.com/bartolli/codanna), [docs](https://docs.codanna.sh/)

**Kit (cased)**
- A toolkit and MCP server ("kit-dev") for codebase mapping, symbol extraction and code search, plus doc research and package search. — [GitHub](https://github.com/cased/kit), [kit-mcp](https://kit-mcp.cased.com/)

**Octocode** (formerly octocode-mcp)
- 13 research tools: GitHub, GitLab and Bitbucket code search, local tools, LSP go-to-definition, find-references and call hierarchy, PR history, and package lookup. Available over MCP or as a CLI. — [GitHub](https://github.com/bgauryy/octocode), [octocode.ai](https://octocode.ai/)

**LSP-over-MCP bridges**
- mcp-language-server (Go): definition, references, rename and diagnostics. Issue: file descriptors from workspace indexing are never released, with 76k held by one idle server. — [README](https://github.com/isaacphi/mcp-language-server), [#149](https://github.com/isaacphi/mcp-language-server/issues/149)
- mcpls (Rust): a universal bridge for any LSP 3.17 server, zero-config for Rust. — [GitHub](https://github.com/bug-ops/mcpls), [lib.rs](https://lib.rs/crates/mcpls)
- agent-lsp (Go): "65 tools, 30 CI-verified languages". Keeps the index warm and adds skill workflows. `preview_edit` previews the diagnostic impact of an edit, and `simulate_chain` finds which step in a chain of edits first introduces an error. — [GitHub](https://github.com/blackwell-systems/agent-lsp), [agent-lsp.com](https://www.agent-lsp.com/)

### Inferences
- Stars don't mean the tools work reliably. The two most-starred graph servers have long issue lists about stale data, silent empty results and crashes on large repos, the exact failure classes a refactor should design against:
  - an explicit index freshness or version in every response;
  - "incomplete, N unresolved" markers instead of exact zeros;
  - bounded work with progress reporting;
  - branch-switch-aware incremental updates.
- The #1382 data is important. Adding a graph tool lowered recall because the agent treated a truncated page as complete. Tool outputs must say in the text itself that they are truncated, or auto-page small result sets. This matches Anthropic's guidance on helpful truncation messages.
- Heuristic call graphs in JS/TS miss dependency-injection and dynamic-dispatch calls. For a Node-focused indexer this is the main correctness risk in impact analysis. Returning confidence levels and unresolved-site counts, and suggesting a grep fallback, turns a silent error into a visible one.
- The existence of Serena's remind hooks and serena-guard is direct evidence that MCP tools are underused by default. Shipping hooks, skills or CLAUDE.md/AGENTS.md snippets is part of the product, not an extra.
- Heavy external dependencies (Milvus, Neo4j, Memgraph, cloud embedding APIs) generate a large share of the reported failures (#215, #290, #170). An embedded, zero-dependency store is an advantage.

### Gaps
- Star counts for mcpls, agent-lsp and Octocode were not retrieved.
- Top issues for code-graph-rag, ck, Probe, Kit, codanna and code-index-mcp were not reviewed.
- The reason mcp-server-tree-sitter was archived was not retrieved.
- No independent benchmark was found comparing Serena (LSP) with graph servers on the same tasks.

---

## 6. Cross-cutting: measured evidence that an index or graph beats pure grep (task success, tokens, latency), and where it does not

### Takeaway
The evidence is real but mostly vendor-reported, and it points to a complement-not-replacement conclusion:
- Indexes reliably cut tokens and tool calls (30–99% in vendor tests) and latency on large repos.
- Accuracy and resolve-rate gains are modest: Cursor +6.5–23.5% on question answering, WarpGrep +2–4 points on SWE-bench Pro, and one June 2026 ablation showing a statistically separated resolve gain with 21% lower cost per solve.
- They can be zero (Copilot's coding agent: 2% faster, same quality) or negative. Graph answers can lose to grep on recall when outputs truncate silently, and file-graph tools score lower on answer quality (83% vs 92%).
- Independent 2026 benchmarks find no single retrieval family dominates, and that agents' own grep exploration misses every gold file 27–35% of the time.

### Cited Findings
**Evidence that an index helps**
- Cursor (Nov 2025): +12.5% average question-answering accuracy (6.5–23.5% by model); +0.3% code retention overall and +2.6% on repos with 1,000+ files; 2.2% more dissatisfied follow-ups without the index (extract). — [Cursor](https://cursor.com/blog/semsearch)
- "Code Isn't Memory" (arXiv, June 2026) (extract):
  - Three arms: a harness with a structural index, the same harness without it, and an agentic-grep comparator.
  - Benchmarks: SWE-PolyBench Verified and SWE-bench Pro, with Claude Opus 4.7, three seeds, a leak-audited sandbox.
  - Adding the index gave "a large localization gain and a statistically separated resolve gain, with no cost penalty per cell". Cost per solved task was $2.30 versus $2.92, about 21% lower.
  - Against the agentic-grep baseline, the index "does not regress" on resolve or localization.
  — [arXiv 2606.22417](https://arxiv.org/abs/2606.22417), [Pith review](https://pith.science/paper/2606.22417)
- "Deep Agentic Search for Repository-Level Code QA: An Empirical Study" (arXiv, Aug 2026) (extract):
  - Run on SWE-QA with four models and 15 Python repos.
  - Semantic search answered 65.2% of questions correctly versus 46.2% for deep agentic search, matching or beating it for every model, at "less than half the cost" per correct answer.
  - 41.8% of agentic failures happened at the planner-to-subagent hand-off.
  - Conclusion: "for read-only questions over a repository that can be indexed, retrieval was the stronger and cheaper option".
  — [arXiv 2608.01507](https://arxiv.org/abs/2608.01507)
- Vendor and tool-author token and latency claims:
  - Augment: +70–80% on 900 PR attempts. — [Augment](https://www.augmentcode.com/blog/context-engine-mcp-now-live)
  - JetBrains Context: up to −68% turns, −59% latency, −48% cost. — [JetBrains](https://blog.jetbrains.com/ai/2026/07/introducing-jetbrains-context-repository-intelligence-for-coding-agents/)
  - WarpGrep v2: −39% input tokens, −26% turns, +2.1 to +3.7 points on SWE-bench Pro. — [Morph](https://www.morphllm.com/blog/warpgrep-v2)
  - mgrep: about 2x fewer tokens, −48% time. — [mgrep](https://github.com/mixedbread-ai/mgrep)
  - claude-context: −40% tokens on 30 SWE-bench Verified tasks. — [Zilliz](https://zilliz.com/blog/why-im-against-claude-codes-grep-only-retrieval-it-just-burns-too-many-tokens)
  - Codebase-Memory: 10x fewer tokens and 2.1x fewer tool calls. — [arXiv 2603.27277](https://arxiv.org/abs/2603.27277v1)
- Latency of a lexical index: Cursor's regex search went from 16.8 s (ripgrep) to 13 ms. — [Cursor](https://cursor.com/blog/fast-regex-search)
- Retrieval precision: file-read precision reportedly rose from ~65% (stock Claude Code) to ~90% with windowed grep plus semantic search (secondary). — [BigGo summary of the Turbopuffer talk](https://finance.biggo.com/news/aed3a6d02a3f1d95)

**Evidence that an index does not help, or hurts**
- Anthropic's internal finding that agentic search "outperformed everything by a lot" versus RAG. It is unpublished and unquantified. — [Latent Space](https://www.latent.space/p/claude-code), [X/@bcherny](https://x.com/bcherny/status/2017824286489383315)
- Copilot's coding agent with a semantic code search tool: "2% less time… without any change in quality". — [GitHub changelog](https://github.blog/changelog/2026-03-17-copilot-coding-agent-works-faster-with-semantic-code-search/)
- Codebase-Memory's own paper: 83% versus 92% answer quality against a file-exploration agent, trading quality for about 10x fewer tokens. — [arXiv 2603.27277](https://arxiv.org/abs/2603.27277v1)
- User benchmark (Claude Code on Haiku 4.5, 300 runs): grep plus graph recall 0.525 versus grep-only 0.723 at equal precision, caused by unpaged truncated graph results. — [codebase-memory-mcp#1382](https://github.com/DeusData/codebase-memory-mcp/issues/1382)
- False-negative call edges (dependency-injection receivers) reported as exact zeros lead agents to "conclude code is dead". — [codebase-memory-mcp#2265](https://github.com/DeusData/codebase-memory-mcp/issues/2265)
- Agent Retrieval Bench (arXiv, July 2026) (extract):
  - 427 samples across 25 repos, with tasks code2test, comment2context, trace2code and edit2ripple, plus no-gold and counterfactual controls.
  - "No single retrieval family dominates". Qwen3-Embedding-4B has the best MRR, Qwen3-Embedding-8B the best Recall@20, and RepoMap the best budgeted context yield at 8K tokens. Lexical and grep baselines are competitive on some categories.
  - RepoMap beats BM25 and "helps identify ripple-effect files through repository structure", but trails the strongest embedding models at packed 4k and 8k budgets.
  - Abstention thresholds calibrated on counterfactual controls don't help on natural no-gold cases.
  - "Logged trajectories also miss every gold file on 27-35 percent of samples."
  — [arXiv 2607.24882](https://arxiv.org/abs/2607.24882), [HF papers](https://huggingface.co/papers/2607.24882)
- Freshness and operational failures that erase index benefits in practice:
  - GitNexus: stale MCP data after re-index; full re-index after a branch switch — [#297](https://github.com/abhigyanpatwari/GitNexus/issues/297), [#76](https://github.com/abhigyanpatwari/GitNexus/issues/76)
  - claude-context: "indexed but search says not indexed" — [#145](https://github.com/zilliztech/claude-context/issues/145)
  - Claude Code's TypeScript LSP returns empty results silently — [#82416](https://github.com/anthropics/claude-code/issues/82416)

### Inferences
- The strongest consistent effects of indexes are fewer tokens, fewer turns and lower latency on large repos, and better localization. Resolve-rate gains are small and depend on the model and harness. A refactor should optimize for "same answer, fewer tokens and turns, fresher", not promise higher task success.
- Where indexes help most:
  - large or unfamiliar repos (Cursor's 1,000+ file effect);
  - questions where the agent does not know identifier names (Copilot's stated use case);
  - read-only questions and answers (Aug 2026 study);
  - ripple-effect and "who calls or depends on this" questions (RepoMap and edit2ripple; GitNexus and codanna impact tools).
- Where they hurt: when outputs are truncated or incomplete without saying so, when the index is stale, or when heuristic edges are presented as exact. All three are design-controllable. Always emit freshness (commit or mtime), completeness flags, confidence per edge, and "verify with grep" hints.
- Agent trajectories miss all gold files on 27–35% of samples, so there is room for an index to add recall. Getting agents to call the tool (hooks, skills, instructions) is a precondition for any of these benefits.
- The planner-to-subagent hand-off is a documented silent-failure point. A deterministic MCP tool whose output is a checkable list of file and line spans with reasons is less error-prone than a free-text subagent summary.

### Gaps
- No independent, public, head-to-head benchmark of Claude Code, Codex or Gemini CLI with versus without a local index (and specifically a lexical+structural index like graph-indexer) on resolve rate was found. Most numbers are vendor-run.
- I could not read the full text of the three key 2026 arXiv papers (arxiv.org blocked). Absolute resolve rates for "Code Isn't Memory" and author affiliations (possible vendor ties) are unverified.
- Leads not examined:
  - CORE-Bench, code retrieval for agentic coding (June 2026) — [arXiv 2606.11864](https://arxiv.org/html/2606.11864)
  - CodeScout, RL for code-search agents (Mar 2026) — [arXiv 2603.17829](https://arxiv.org/pdf/2603.17829)
  - SWE Context Bench (Feb 2026) — [arXiv 2602.08316](https://arxiv.org/pdf/2602.08316)
  - Harness-1 (June 2026) — [arXiv 2606.02373](https://arxiv.org/pdf/2606.02373)
