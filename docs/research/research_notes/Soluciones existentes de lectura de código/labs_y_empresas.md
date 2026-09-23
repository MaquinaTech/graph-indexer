# How AI labs and coding-tool companies make agents read and search code (state as of 2026-09-23)

Verification legend (research done 2026-09-23):

- **[V]** Verified in this session against a primary artifact: source code or docs cloned from GitHub on 2026-09-22/23. These are `openai/codex` (HEAD 2026-09-23) and `google-gemini/gemini-cli` (2026-09-22). Also the `anthropics/claude-code` CHANGELOG (v2.1.280, 2026-09-22) and the code.claude.com docs mirror `ericbuess/claude-code-docs` (2026-09-23), whose changelog page carries the release dates. Also `Piebald-AI/claude-code-system-prompts` (Claude Code's extracted prompts, 2026-09-22) and `microsoft/vscode-docs` (blogs and docs, 2026-09-23). Also `github/docs`, `QwenLM/qwen-code`, `MoonshotAI/kimi-cli`, `mistralai/mistral-vibe`, `bytedance/trae-agent`, `Kilo-Org/kilocode`, `RooCodeInc/Roo-Code`, `cline/cline`, `zed-industries/zed` (docs), `xai-org/grok-build`, `google-antigravity/antigravity-cli`, `JetBrains/benjamin-plus-skill` and `JetBrains-Research/the-complexity-trap`. Where the product has an official URL (for example code.claude.com), that URL is cited even when it was read through the mirror.
- **[S]** Seen only in web-search result summaries of the primary page. The sandbox proxy blocks anthropic.com, claude.com, openai.com, cursor.com, cognition.com, morphllm.com, augmentcode.com, sourcegraph.com, jetbrains.com, github.blog, docs.github.com (web), factory.ai, kiro.dev and simonwillison.net. Numbers can be paraphrased by the search summarizer.
- **[3P]** Third-party report, aggregator or curated list, not the vendor's own page. Two are used heavily: the dated source notes in `VILA-Lab/Dive-into-Claude-Code` (docs/agent-design-space-source-notes.md) and `QuesmaOrg/awesome-ai-tokenomics`.
- Dates of X/LinkedIn posts were decoded from their snowflake IDs.

Scope note: this file does not repeat what `Indexación de código para agentes IA.md` and `reports/Impacto real de indexación en agentes.md` already cover, unless newer data or a correction exists. That covered material includes the Voyage RAG abandonment tweet, the LSP tool in 2.0.74, Cursor semsearch +12.5% / +0.3% / +2.6%, Instant Grep 16.8 s→13 ms and Merkle >4 h→21 s. It also includes Copilot's +37.6% embedding gain, its 2%-faster semantic search and 40→13 tools, SWE-grep 8×4, WarpGrep v2's +2.1–3.7, Augment's +70–80%, JetBrains' "up to" −68% and Sourcegraph's curated tools. The client limits table and hook surfaces are covered there as well. Corrections are flagged **CORRECTION**.

## 1. Anthropic (Claude Code, Claude Developer Platform)

### Takeaway
Claude Code still has no semantic index. Its 2026 changes cut what the agent reads and how many tool round trips it makes, not how it retrieves:
- Search moved into the shell: embedded ugrep and bfs replace the Grep and Glob tools on native builds.
- Read now deduplicates unchanged re-reads and returns PARTIAL views.
- Explore now inherits the main model instead of Haiku.
- MCP tools are deferred behind tool search.
- A five-stage context pipeline (microcompact, tool-result clearing, auto-compact) plus server-side compaction handles long sessions.
- Since July 2026 an explicit prompt tells Claude not to over-delegate to subagents.

Anthropic publishes measured numbers for its API context tools (84% fewer tokens, +29% and +39%, 98.7%, 37%) and model-level token savings. It has never published a number for agentic search against indexing.

### Cited Findings
**Search and read primitives (Claude Code)**
- On macOS, Linux and WSL native builds, v2.1.117 (2026-04-22) replaced the `Glob` and `Grep` tools with embedded `bfs` and `ugrep` run through the Bash tool. The changelog calls this "faster searches without a separate tool round-trip". Windows and npm installs are unchanged, and listing Grep or Glob in `--tools` brings the dedicated tools back (v2.1.162, 2026-06-03). [V] — [Claude Code changelog](https://code.claude.com/docs/en/changelog); [Tools reference](https://code.claude.com/docs/en/tools-reference)
- The team's stated rationale is "we removed our grep and other search tools — glob tools — in favor of native bash" (Thariq Shihipar, fireside chat, 2026-07-21). They argue for low tool cardinality. [S] — [Simon Willison transcript](https://simonwillison.net/2026/Jul/21/cat-and-thariq/)
- The Grep tool (where it exists) is ripgrep-based and skips gitignored files; Glob does not respect `.gitignore` by default. In `content` mode an offset past the last match returns `No entries at this offset`, so Claude widens the offset instead of concluding there is no match. [V] — [Tools reference](https://code.claude.com/docs/en/tools-reference)
- Search that silently returns nothing has been a recurring bug class:
  - ripgrep timeouts returned empty results instead of errors until v2.1.23 (2026-01-29).
  - Rejected patterns were reported as "No files found" until v2.1.208 (2026-07-14).
  - System ripgrep reported "no matches" after a flood of warnings until v2.1.275 (2026-09-17), which also added a 20 MB output cap.

  [V] — [changelog](https://code.claude.com/docs/en/changelog)
- Read changes:
  - v2.1.86 (2026-03-27): compact line-number format and deduplication of unchanged re-reads, "reducing token usage".
  - v2.1.145 (2026-05-19): a whole-file read over the token limit returns a first page with a `PARTIAL view` notice instead of an error.
  - v2.1.0 (2026-01-07): `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` overrides the limit.

  A "file already in context" system reminder tells the model to reuse content that has not changed on disk. [V] — [changelog](https://code.claude.com/docs/en/changelog); [Tools reference](https://code.claude.com/docs/en/tools-reference); [Piebald prompt](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/system-reminder-file-already-in-context.md)
- Read-before-edit accepts a Read, or a single-file `cat`, `sed -n`, `grep` or `rg` command without pipes, as proof of reading. Other tool outputs, MCP results included, do not count. Since v2.1.208, models newer than Opus 4.6 and Haiku 4.5 may edit an unread file when reading it would not trigger a prompt. [V] — [Tools reference](https://code.claude.com/docs/en/tools-reference)
- The system prompt tells Claude to "maximize use of parallel tool calls"; this fragment dates from v2.1.30. [V] — [Piebald prompt](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/system-prompt-parallel-tool-call-note-part-of-tool-usage-policy.md)
- Since v2.1.51 (2026-02-24), tool results over 50K characters are written to disk (previously 100K). Since 2.1.265 (2026-09-08) files saved to disk are capped at 1 GB. [V] — [changelog](https://code.claude.com/docs/en/changelog)

**Explore and Plan subagents**
- Explore arrived in v2.0.17 (2025-10-15) "powered by Haiku" to "save context". The Plan subagent followed in v2.0.28 (2025-10-27). [V] — [changelog](https://code.claude.com/docs/en/changelog)
- **CORRECTION** to the earlier doc, which says Explore runs on Haiku. Since v2.1.198 (2026-07-01), Explore inherits the main session's model, capped at Opus on the Claude API. A user or project subagent named `Explore` with `model: haiku` restores the old behaviour. `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` removes both built-ins. [V] — [Sub-agents docs](https://code.claude.com/docs/en/sub-agents); [changelog](https://code.claude.com/docs/en/changelog)
- Explore and Plan skip CLAUDE.md and the git-status snapshot "to keep research fast and inexpensive". They are one-shot and cannot be resumed. Claude passes a thoroughness level: quick, medium or very thorough. [V] — [Sub-agents docs](https://code.claude.com/docs/en/sub-agents)
- The Explore prompt says it is "meant to be a fast agent": strictly read-only, and it should "spawn multiple parallel tool calls for grepping and reading files". [V] — [Piebald: agent-prompt-explore.md](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/agent-prompt-explore.md)
- Third-party telemetry reports "at least 36%" of Explore invocations on Haiku. [3P] — [mirin.pro](https://mirin.pro/blog/claude-code-subagents-haiku-telemetry/)
- **Delegation restraint (new, 2026-07-19, v2.1.215).** A new system-prompt section says:
  - "Subagents multiply cost and time: each one re-establishes context, re-explores, and reports back."
  - Do not spawn a subagent for "a handful of tool calls".
  - "Keep spawn counts low."

  A companion cost guidance adds that "both handoffs drop detail" and that "an agent handed your hypothesis tends to return it confirmed". [V] — [Piebald: subagent-delegation-restraint](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/system-prompt-subagent-delegation-restraint.md); [cost guidance](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/system-prompt-subagent-delegation-cost-guidance.md)
- Other subagent changes:
  - Subagents run in the background by default (week of 2026-07-03).
  - Nested subagents: depth 3 by default since v2.1.219 (2026-07-24), capped at 5.
  - The `fork` subagent, which inherits the full conversation and prompt cache, is on by default (week of 2026-08-10).

  [V] — [changelog](https://code.claude.com/docs/en/changelog); [digest w33](https://github.com/ericbuess/claude-code-docs/blob/main/docs/whats-new__2026-w33.md)
- A third-party proxy measurement (2026-07-12, Claude Code 2.1.207 against OpenCode 1.17.18, same model) found:
  - About 33,000 tokens of system prompt and scaffolding before the user prompt, against about 7,000 for OpenCode.
  - A task that cost 121,000 tokens done directly cost 513,000 when fanned out to two subagents, with identical completion.

  [3P] — [Systima](https://systima.ai/blog/claude-code-vs-opencode-token-overhead) (via [Dive-into-Claude-Code notes](https://github.com/VILA-Lab/Dive-into-Claude-Code/blob/main/docs/agent-design-space-source-notes.md))

**LSP / code intelligence**
- The LSP tool supports goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation and call hierarchy. It is inactive until a code-intelligence plugin is installed, and inactive in cloud sessions. After each edit it reports type errors automatically. [V] — [Tools reference](https://code.claude.com/docs/en/tools-reference); [Piebald LSP description](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-lsp.md)
- Notable fixes:
  - v2.1.47 (2026-02-18): `findReferences` returned results from gitignored `node_modules/` and `venv/`.
  - v2.1.111 (2026-04-16): diagnostics from before an edit appeared after it, "causing the model to re-read files it just edited".
  - v2.1.162 (2026-06-03): `workspaceSymbol` returned no results until it accepted a `query`.
  - v2.1.208: open LSP documents are now kept in an LRU capped at 50.
  - v2.1.274: fixed a per-turn slowdown when a server publishes diagnostics for thousands of files.

  [V] — [changelog](https://code.claude.com/docs/en/changelog)
- Anthropic's docs recommend code-intelligence plugins for large codebases: "A single 'go to definition' call replaces what might otherwise be a grep followed by reading multiple candidate files." No measurement is given. [V] — [Costs](https://code.claude.com/docs/en/costs); [Large codebases](https://code.claude.com/docs/en/large-codebases)

**Tool search / deferred MCP tools**
- MCP tool search was auto-enabled on 2026-01-14 (v2.1.7) at a 10% threshold; `auto:N` has been configurable since v2.1.9. Global system-prompt caching has worked with ToolSearch since v2.1.84 (2026-03-26). Servers can opt out with `alwaysLoad: true` (week of 2026-05-01). Since v2.1.267/268 (2026-09-09/10), late-connecting tools arrive as deferred definitions so the tool list stays byte-stable for the prompt cache. [V] — [changelog](https://code.claude.com/docs/en/changelog); [digest w18](https://github.com/ericbuess/claude-code-docs/blob/main/docs/whats-new__2026-w18.md)
- API-level numbers from Nov 2025 go beyond the tool-search accuracy numbers already covered:
  - Programmatic tool calling cut average tokens from 43,588 to 27,297 (−37%) because intermediate results never enter context.
  - "Code execution with MCP" cut a Drive→Salesforce workflow from 150,000 to 2,000 tokens (−98.7%).

  [S] — [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use); [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)

**Context management**
- A third-party source analysis of Claude Code's query loop lists five pre-model stages: Budget reduction (per-message tool-result caps) → Snip → Microcompact (clear older tool results) → Context Collapse (read-time projection) → Auto-Compact (model summary). Several stages are feature-gated. [3P] — [Dive-into-Claude-Code architecture](https://github.com/VILA-Lab/Dive-into-Claude-Code/blob/main/docs/architecture.md) (paper [arXiv 2604.14228](https://arxiv.org/abs/2604.14228))
- Official docs confirm the harness "clear[s] old tool results from context" and counts that as an "expected rebuild" of the prompt cache. After `/compact`, Claude Code re-reads up to five recently modified files and re-injects invoked skills, capped at 5,000 tokens each. [V] — [Costs](https://code.claude.com/docs/en/costs); [Context window](https://code.claude.com/docs/en/context-window)
- Auto-compact tuning for 1M windows: Sonnet 5 compacts at about 967K. Opus and Fable compact "shortly before the 1M-token limit". A thrash loop that compacted three times in a row now stops. A compaction circuit breaker stops after 3 failures. [V] — [changelog](https://code.claude.com/docs/en/changelog)
- Platform context editing and memory tool (2025-09-29):
  - In a 100-turn web-search eval, context editing let agents finish workflows that otherwise failed, with 84% fewer tokens.
  - Context editing alone improved performance by 29%.
  - Adding the memory tool raised that to 39%.

  [S] — [Managing context on the Claude Developer Platform](https://claude.com/blog/context-management); [docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- Server-side compaction (`compact_20260112`, beta header `compact-2026-01-12`) shipped on 2026-01-12, and Anthropic recommends it over SDK compaction. A later `compact-2026-09-04` beta lets developers compact on demand. [S] — [Compaction docs](https://platform.claude.com/docs/en/build-with-claude/compaction); [Big Hat Group weekly](https://www.bighatgroup.com/blog/claude-weekly-2026-09-21/) [3P]
- Auto-memory: Claude saves useful context automatically since v2.1.59 (2026-02-26), and memory has been shared across git worktrees since v2.1.63. [V] — [changelog](https://code.claude.com/docs/en/changelog)

**Prompt and instructions**
- "The new rules of context engineering for Claude 5 generation models" (2026-07-24) removed "over 80%" of Claude Code's system prompt for Opus 5 and Fable 5 "with no measurable loss on coding evals". It moved verification guidance into skills and deferred tools, favoured judgment over rules, and argued that expressive tool interfaces beat usage examples. [S] — [Claude blog](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models); [Thariq on X](https://x.com/trq212/status/2080710971228918066); [3P summary](https://github.com/VILA-Lab/Dive-into-Claude-Code/blob/main/docs/agent-design-space-source-notes.md)
- Model-level efficiency:
  - Opus 5 (2026-07-24) reportedly reached similar performance with 26% fewer generated tokens than Opus 4.8. This is from search summaries and aggregators, not the primary page.
  - Opus 5.5 (2026-09-22) cut prices to $4/$20 per MTok and cache reads to $0.20.

  [S/3P] — [Anthropic](https://www.anthropic.com/news/claude-opus-5); [datanorth](https://datanorth.ai/news/claude-opus-5-by-anthropic); [changelog 2.1.280](https://code.claude.com/docs/en/changelog)

**Agentic search vs indexing, and CI**
- Boris Cherny (2026-02-01): "Early versions of Claude Code used RAG + a local vector db, but we found pretty quickly that agentic search generally works better. It is also simpler and doesn't have the same issues around security, privacy, staleness, and reliability." No data was published. [S] — [X](https://x.com/bcherny/status/2017824286489383315)
- "Agentic coding is straining CI" (2026-09-14):
  - Anthropic's CI jobs grew 25× in six months: about 8× more code per engineer and 10× more tests.
  - Anthropic runs a deterministic test impact analysis. A "listener" journals every CI result and a "selector" picks tests per PR from package relevance and per-test history.
  - Earlier patches lasted 70 days, then 29 days, then under a day.
  - No skipped-test percentage was found.

  [S] — [Claude blog](https://claude.com/blog/agentic-coding-is-straining-ci-heres-how-we-scaled-test-impact-analysis-at-anthropic); [3P summary](https://www.digitalapplied.com/blog/anthropic-ci-25x-growth-test-impact-analysis)

### Inferences
- Anthropic is moving search toward fewer, more generic primitives: shell plus embedded fast binaries plus optional LSP. It is not moving toward a retrieval index. A tool that wants to be used by Claude Code must either sit in the Bash path (hooks, CLI) or be an MCP server whose name and first sentence survive tool-search deferral.
- Silent empty search results have been fixed at least three times in 2026. That shows false negatives from search tools are a real, recurring failure worth guarding against in any index.
- The July 2026 delegation-restraint prompt, together with the 121K vs 513K fan-out measurement, suggests subagent exploration is now reserved for broad sweeps. That leaves room for one-call precise answers in the main loop.
- Explore and Plan skip CLAUDE.md, and MCP output does not satisfy read-before-edit. So an index answer is usually followed by a narrow Read. Including exact line ranges makes that Read cheap.

### Gaps
- No Anthropic number exists for agentic search against RAG, or for LSP against grep inside Claude Code. The primary TIA post was not readable, so how often tests are skipped and how safe the selection is are unknown.
- Microcompact trigger thresholds and the exact default Read token limit could not be confirmed from primary sources in this session.

## 2. OpenAI (Codex CLI, cloud and app; codex models)

### Takeaway
Codex has no code index, verified in current source. It searches with `rg` through the shell, parallelizes reads, truncates tool output to 10,000 tokens and auto-compacts at 90% of the window, with remote compaction. The multi-agent feature ships a built-in `explorer` role. OpenAI pushes efficiency through model training rather than retrieval:
- GPT-5-Codex adapts its thinking to the task.
- GPT-5.1-Codex-Max was trained on compaction.
- GPT-5.6 added programmatic tool calling.

A September 2026 experiment replaces summaries with notes plus searchable history. Published numbers are model-level and vendor-measured.

### Cited Findings
- Base instructions (current `default.md` and every gpt-5.x prompt) say: "When searching for text or files, prefer using `rg` or `rg --files`… because `rg` is much faster than alternatives like `grep`." The GPT-5.2 prompt adds "Parallelize tool calls whenever possible - especially file reads, such as `cat`, `rg`, `sed`, `ls`, `git show`, `nl`, `wc`. Use `multi_tool_use.parallel`." [V] — [default.md](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md); [gpt_5_2_prompt.md](https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_2_prompt.md)
- Current tool handlers (2026-09-23) include shell and unified exec, apply_patch, `tool_search`, MCP and resources, multi-agents v1/v2, `get_context_remaining` and `new_context_window`. There is no dedicated grep, read or list tool. The earlier experimental `grep_files`, `read_file` (with an indentation-aware block mode) and `list_dir` survive only as a "codex" tool dialect copied into xAI's grok-build. [V] — [codex handlers dir](https://github.com/openai/codex/tree/main/codex-rs/core/src/tools/handlers); [grok-build codex/read_file](https://github.com/xai-org/grok-build/tree/main/crates/codegen/xai-grok-tools/src/implementations/codex)
- Model catalog (bundled `models.json`, 2026-09-23): gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol/terra/luna, gpt-5.5 and gpt-5.4. All have a 272K window, `truncation_policy` = 10,000 tokens and parallel tool calls. [V] — [models.json](https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json)
- The auto-compact limit is `context_window * 9 / 10`, capped by any configured limit, and `effective_context_window_percent` defaults to 95. The local compaction prompt asks for a "CONTEXT CHECKPOINT COMPACTION… handoff summary for another LLM". Remote compaction V2 runs server-side when the provider supports it. [V] — [openai_models.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs); [compact prompt](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/prompt.md); [tasks/compact.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/compact.rs)
- The built-in `explorer` role (multi_agent is stable and on by default) is described as: "Use `explorer` for specific codebase questions. Explorers are fast and authoritative… you should trust the explorer results without additional verification… spawn multiple explorers in parallel." Its `explorer.toml` is empty, so it inherits the session model. [V] — [role.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/role.rs); [features lib.rs](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs)
- `tool_search` ranks deferred tool metadata with BM25. [V] — [tool_search_spec.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/tool_search_spec.rs)
- **Experimental context management.** Codex 0.153.0 (2026-09-03) added `features.context_management.experimental_mode`, off by default, on ChatGPT plans with Astra. When the window resets, the model keeps private "notes" and can list, read and search the normalized history of earlier windows, including tool outputs its notes missed. The tools involved are `new_context_window` and `get_context_remaining`. [V/S] — [history-notes tools.rs](https://github.com/openai/codex/blob/main/codex-rs/ext/history-notes/src/tools.rs); [VB Srivastav, 2026-09-06](https://x.com/reach_vb/status/2096657879411384638); [3P notes](https://github.com/VILA-Lab/Dive-into-Claude-Code/blob/main/docs/agent-design-space-source-notes.md)
- "Unrolling the Codex agent loop" (early 2026, before 2026-03-28) explains:
  - Each prompt must be an exact prefix of the next.
  - Changed tools or instructions are appended as new messages rather than edited in place, to keep the prompt cache valid.
  - Compaction replaces the input with a smaller representative list once a token threshold is crossed.

  [S] — [OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop/)
- A compaction regression (v0.116→v0.118) made compaction fire about twice as often: 4 compactions per session became 12–26 and 89M tokens became 160–185M on the same task, "via a file-re-read amplification loop". [3P] — [codex issue #16812](https://github.com/openai/codex/issues/16812) (as summarized in [awesome-ai-tokenomics](https://github.com/QuesmaOrg/awesome-ai-tokenomics/blob/main/concepts/compaction-economics.md))
- Model efficiency claims:
  - GPT-5-Codex (2025-09-15): on employee traffic, the bottom 10% of turns by tokens used 93.7% fewer tokens than GPT-5, while the top 10% reasoned about twice as long.
  - GPT-5.1-Codex-Max (2025-11-19): "first model natively trained to operate across multiple context windows through… compaction". It was 30% fewer thinking tokens at medium effort on SWE-bench Verified, and ran internal sessions of over 24 h.
  - GPT-5.3-Codex: 56.8% vs 56.4% on SWE-Bench Pro, "with fewer output tokens than any prior model", and about 25% faster.
  - GPT-5.6 (2026-07-09): programmatic tool calling "matched quality while using 24% fewer output tokens and completing tasks 28% faster".
  - GPT-6 Sol and Luna reached Codex on 2026-09-22.

  [S] — [GPT-5-Codex](https://openai.com/index/introducing-upgrades-to-codex/); [GPT-5.1-Codex-Max](https://openai.com/index/gpt-5-1-codex-max/); [GPT-5.3-Codex](https://openai.com/index/introducing-gpt-5-3-codex/); [GPT-5.6](https://openai.com/index/gpt-5-6/); [9to5Mac](https://9to5mac.com/2026/09/22/openai-upgrading-chatgpt-and-codex-with-two-more-gpt-6-models/)
- "Harness engineering" (2026-02-11) describes a product of about 1M lines written entirely by Codex agents. The repo was optimized for agent legibility: a roughly 100-line AGENTS.md "map" pointing to versioned design docs, linters and CI validating the knowledge base, and a "doc-gardening" agent. [S] — [OpenAI](https://openai.com/index/harness-engineering/)
- A hosted Codex harness (Agents API) entered public beta on 2026-09-10. [3P] — [awesome-ai-tokenomics](https://github.com/QuesmaOrg/awesome-ai-tokenomics/blob/main/README.md)

### Inferences
- OpenAI's bet is model-side efficiency: adaptive thinking, compaction-aware training and programmatic tool calling. Retrieval is not part of it. For an external index this means `rg`-compatible CLI output and MCP tools with short, BM25-matchable names and descriptions.
- The explorer role is told to be "trusted without additional verification". Any index Codex agents consult is therefore effectively authoritative, which raises the cost of silent incompleteness.
- The history-notes experiment implies agents will re-query rather than remember. Cheap, deterministic, re-askable answers suit that pattern.

### Gaps
- No OpenAI publication measures search quality, turns or tokens spent on navigation in Codex.
- Why the grep_files, read_file and list_dir tools were dropped (and when) is undocumented.
- Explorer usage statistics are not published.

## 3. Google (Gemini CLI, Antigravity, Jules, Gemini Code Assist)

### Takeaway
Gemini CLI has one built-in exploration subagent, `codebase_investigator` (Oct 2025). It runs on Flash, is limited to 10 minutes and 50 turns, and returns a structured report (file, reasoning, key symbols). The CLI compresses history at 50% of the window and is adding off-by-default tool-output masking and distillation. Antigravity CLI dropped its dedicated grep and find tools from the default toolset. The only Google product with a real code index is Gemini Code Assist Enterprise's private-repo index, reindexed daily. No quantitative results on search efficiency were found for any Google product.

### Cited Findings
- `codebase_investigator`, as defined in source:
  - Model: `gemini-3-flash-preview` when the main model "supports modern features", otherwise `gemini-2.5-pro`.
  - Settings: temperature 0.1, thinking HIGH, `maxTimeMinutes: 10`, `maxTurns: 50`.
  - Tools: ls, read_file, glob and grep only.
  - Output schema: `SummaryOfFindings`, `ExplorationTrace[]` and `RelevantLocations[{FilePath, Reasoning, KeySymbols[]}]`.

  [V] — [codebase-investigator.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/agents/codebase-investigator.ts); [models.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/models.ts)
- Release history:
  - v0.12.0 (2025-10-27) announced the investigator "to improve overall performance", with no numbers.
  - v0.33.0 (2026-03-11) added research subagents to Plan Mode.
  - v0.36.0 (2026-04-01) added JIT context for subagents.
  - v0.38.0 (2026-04-14) added a "Context Compression Service".
  - v0.40.0 (2026-04-28) bundled ripgrep for offline search.

  [V] — [changelog](https://github.com/google-gemini/gemini-cli/blob/main/docs/changelogs/index.md)
- Compression and truncation defaults:
  - History compression triggers at 0.5 of the model token limit and keeps the last 30%, with a 50,000-token budget for function responses.
  - Tool output is truncated at 40,000.
  - The new `contextManagement` block (off by default) keeps a 150K-token history window and retains 40K. It caps messages at 2,500 tokens (12,000 retained), distills tool outputs over 20,000 tokens to at most 10,000, and masks old tool outputs with a 50,000-token protection threshold and a 30,000 minimum prunable size.

  [V] — [chatCompressionService.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/context/chatCompressionService.ts); [config.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/config.ts); [toolOutputMaskingService.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/context/toolOutputMaskingService.ts)
- The behavioral evals `frugalReads` and `frugalSearch` require ranged reads (1–3 ranges per turn, fewer than 1,000 lines) and grep or ranged reads on large files. Google tests for frugal reading as intended behaviour but publishes no pass rates. [V] — [frugalReads.eval.ts](https://github.com/google-gemini/gemini-cli/blob/main/evals/frugalReads.eval.ts); [frugalSearch.eval.ts](https://github.com/google-gemini/gemini-cli/blob/main/evals/frugalSearch.eval.ts)
- Antigravity CLI (closed-source engine, public changelog):
  - v1.2.7 "retir[ed] the legacy `find_by_name`, `grep_search`, and `list_dir` tools from the default baseline", keeping them for custom agents that list them.
  - It switched code search to an embedded `ripgrep`.
  - It gives rules a dedicated 20,000-token budget.
  - v1.1.5 added per-subagent model tiers (flash or pro).
  - The changelog is undated; the repo HEAD is 2026-09-23.

  [V] — [Antigravity CLI CHANGELOG](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md); [3P](https://github.com/QuesmaOrg/awesome-ai-tokenomics/blob/main/research/optimize.md)
- **Conflict.** A curated list says Google "retired the open-source Gemini CLI on 2026-06-18" in favour of Antigravity CLI. But the gemini-cli repo kept shipping releases through v0.60.0 on 2026-09-15. [3P] — [awesome-ai-tokenomics](https://github.com/QuesmaOrg/awesome-ai-tokenomics/blob/main/research/understand.md) citing [Google Developers Blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/); contradicted by [gemini-cli changelog](https://github.com/google-gemini/gemini-cli/blob/main/docs/changelogs/index.md) [V]
- Gemini Code Assist Enterprise "code customization" searches a private index of org repos and adds similar code to the prompt. It reindexes every 24 h, allows one index per project or org, up to 20,000 repositories and 500 repository groups, and supports `@repo` context in chat. [S] — [Google Cloud docs](https://docs.cloud.google.com/gemini/docs/codeassist/code-customization-overview)
- Jules runs each task in a cloud VM (Gemini Pro and Flash). A third-party page says it handles "entire codebases without retrieval augmentation" through large context. Its milestones are inconsistent across third-party sources: out of beta in Aug 2025, or GA at I/O on 2026-05-19. [3P] — [Morph comparison](https://www.morphllm.com/comparisons/jules-google-coding-agent)
- Gemini 3.6 Flash (2026-07-21) is marketed as using 17% fewer output tokens on the same work. [3P] — [awesome-ai-tokenomics](https://github.com/QuesmaOrg/awesome-ai-tokenomics/blob/main/README.md)

### Inferences
- Google's code agents rely on long context plus grep and read, with a read-only investigator that returns a machine-readable relevance list. That output schema is the most explicit exploration-result contract published by any lab. It maps directly onto what an index can return deterministically.
- Antigravity and Claude Code both dropping dedicated grep and find tools in 2026 is a cross-vendor signal: search is converging on the shell and embedded ripgrep.

### Gaps
- There are no published Google measurements of the investigator's effect on tokens, turns or success, and none for Code Assist customization's effect on agents. Whether Gemini CLI is truly being retired could not be confirmed; the primary blog is blocked.

## 4. Cursor

### Takeaway
Since the semantic-search and Merkle posts already covered, Cursor's 2026 work has focused on four things:
- A local regex index, Instant Grep (2026-03-23).
- Training its own agent model, Composer 2 (Mar 2026), inside the production harness with grep and semantic search.
- RL-trained self-summarization, reported as 50% less compaction error at one fifth of the tokens.
- Subagents, compaction hooks, persistent Projects and swarms.

Cursor remains the vendor with the most A/B-style numbers, but the 2026 figures are not independently replicated.

### Cited Findings
- Instant Grep (launched about 2026-03-23) is a client-side regex index with an inverted index over "sparse n-grams" and bloom filters. It uses deterministic pair weights to keep only substrings whose ends outweigh their insides, narrows candidate files, then runs the real regex. Regex latency fell from 16.8 s with ripgrep to 13 ms in Cursor's benchmark. The index stays local "for freshness and latency". [S] — [Cursor blog](https://cursor.com/blog/fast-regex-search); [Rohan Paul on X](https://x.com/rohanpaul_ai/status/2036150628712587449)
- Composer 2 technical report (arXiv 2603.24477, Mar 2026):
  - Tools are "read and edit files, run shell commands, search the codebase using grep or semantic search, and search the web".
  - Training runs inside the production harness, with a "shadow deployment of the Cursor backend" so semantic search behaves as in production.
  - On CursorBench-3 it scores 61.3%, against 44.2% for Composer 1.5 and 38.0% for Composer 1. CursorBench tasks change a median of 181 lines, against 7–10 in SWE-bench.
  - Composer 2.5 is also listed in the docs.

  [S] — [arXiv](https://arxiv.org/abs/2603.24477); [Cursor blog](https://cursor.com/blog/composer-2-technical-report); [Composer 2.5 docs](https://cursor.com/docs/models/cursor-composer-2-5)
- Self-summarization ("Training Composer for longer horizons"):
  - Compaction is part of the RL loop: the final reward credits summaries that led to success.
  - "Self-summary consistently reduces the error from compaction by 50%, while using one-fifth of the tokens and reusing the KV cache".
  - It was tested with 80K and 40K triggers.
  - A secondary source says summaries go from 5,000+ to about 1,000 tokens.

  [S] — [Cursor blog](https://cursor.com/blog/self-summarization); [TestingCatalog](https://www.testingcatalog.com/cursor-trained-composer-to-self-summarize-through-rl/)
- "Continually improving our agent harness" (2026-04-30) lists harness metrics: latency, token efficiency, tool-call count and cache-hit rate. It says these "don't get at… whether the agent actually did a good job", so Cursor pairs them with CursorBench and online instrumentation. No figures were found. [S] — [Cursor blog](https://cursor.com/blog/continually-improving-agent-harness)
- Other product changes:
  - Cursor 2.4 (Jan 2026) added subagents, with defaults for "researching your codebase", running terminal commands and parallel work.
  - Cursor 3.11 (2026-07-10) added side chats and cloud hooks on compaction and turn completion.
  - On 2026-08-19, cloud subagents moved to separate VMs.
  - On 2026-09-10, Cursor launched "Projects", coordinator agents with shared context. This is a third-party report.

  [S/3P] — [changelog 2.4](https://cursor.com/changelog/2-4); [side chat](https://cursor.com/changelog/side-chat); [08-19-26](https://cursor.com/changelog/08-19-26); [explainx](https://www.explainx.ai/blog/cursor-projects-persistent-agents-september-2026)
- In a swarm experiment (2026-07-20), a "Field Guide" `index.md` owned by the agents is auto-injected into every agent under a line budget. [3P] — [Cursor blog via Dive notes](https://github.com/VILA-Lab/Dive-into-Claude-Code/blob/main/docs/agent-design-space-source-notes.md)

### Inferences
- Cursor treats grep speed and semantic retrieval as complements. It indexes regex locally because agents issue many greps, and it trains its model with both tools present. This is the strongest vendor evidence that a fast local text index plus a semantic channel belongs in an agent's inner loop.
- Self-summarization shows that compaction quality is improving model-side. External tools should not try to solve it; they should make re-fetching facts cheap.

### Gaps
- There is no public CursorBench ablation of grep-only against grep plus semantic search for Composer 2.
- Instant Grep's effect on end-to-end agent time is not reported. The primary blog posts could not be read in full.

## 5. Cognition / Windsurf (now Devin Desktop)

### Takeaway
Cognition's answer is a fast RL-trained retrieval subagent: SWE-grep and SWE-grep-mini behind "Fast Context" (2025-10-16), served on Cerebras. The motivation was that agents spent ">60% of their first turn just retrieving context". 2026 work shifted to fast general models (SWE-1.6 and 1.7) and to lead/sidekick delegation, where handing off exploration early cut input tokens roughly 3×. Windsurf was renamed Devin Desktop on 2026-06-02.

### Cited Findings
- Fast Context. SWE-grep runs at over 650 tok/s and SWE-grep-mini at over 2,800 tok/s: 4.5× and 20× faster than Haiku 4.5. They use up to 8 parallel calls per turn over at most 4 turns, with a weighted F1 that prioritizes precision. Cognition claims they "match the retrieval accuracy of frontier models in a tenth of the time". Fast Context triggers automatically for code-search queries. [S] — [Cognition](https://cognition.com/blog/swe-grep); [Fast Context docs](https://docs.windsurf.com/context-awareness/fast-context); [Cerebras, 2025-10-16](https://x.com/cerebras/status/1978874694825840679)
- Fast models:
  - SWE-1.5 (Oct 2025): "hundreds of billions of parameters" served at up to 950 tok/s, 6× Haiku 4.5 and 13× Sonnet 4.5.
  - SWE-1.6 (2026-04-07): also on Cerebras at 950 tok/s.
  - SWE-1.7: its free window closed on 2026-08-08.

  [S/3P] — [SWE-1.5](https://cognition.ai/blog/swe-1-5); [SWE-1.6](https://cognition.com/blog/swe-1-6); [tokenomics list](https://github.com/QuesmaOrg/awesome-ai-tokenomics/blob/main/README.md)
- "Making Fable Cheaper Than Opus" (2026-07-13):
  - A Fable-5-led agent with a sidekick came out 9% cheaper and 11% better-scoring than an Opus-4.8-led one.
  - The reason is that "Fable hands off exploration early while Opus delegates only the mechanical tail".
  - Input tokens were 545K against 1,679K, and lead turns 11.5 against 26.5.
  - Briefs specify constraints.

  [3P] — [Cognition via Dive notes](https://github.com/VILA-Lab/Dive-into-Claude-Code/blob/main/docs/agent-design-space-source-notes.md) (primary: [cognition.com](https://cognition.com/blog/making-fable-cheaper-than-opus))
- Windsurf became Devin Desktop on 2026-06-02; Fast Context documentation is now under Devin Docs. [3P/S] — [tokenomics list](https://github.com/QuesmaOrg/awesome-ai-tokenomics/blob/main/README.md); [Devin blog](https://devin.ai/blog/windsurf-is-now-devin-desktop)

### Inferences
- Cognition's data point is about when to delegate. Early, well-briefed exploration hand-off saved about 68% of lead input tokens. That fits an index that front-loads "where is X / who calls X" answers at the start of a task.
- The weighted-F1, precision-first objective is a metric graph-indexer can copy for its own evaluation of span lists.

### Gaps
- SWE-grep has no end-to-end resolve-rate or cost ablation. Cognition's 2025 retrieval eval set is not public. No 2026 update to SWE-grep was found.

## 6. Morph (WarpGrep, Fast Apply)

### Takeaway
Morph productized the Cognition idea as an MCP-installable RL search subagent: WarpGrep v1 (2025-11-28) and v2 (2026-03-02). It returns `(file, [start, end])` spans. v2 reports +2.1 to +3.7 points on SWE-Bench Pro, but Morph's efficiency numbers conflict between sources.

### Cited Findings
- WarpGrep v1 (launched 2025-11-28) claimed tasks 40% faster, "context rot" reduced 70% on long-horizon tasks, about 0.73 F1 in about 4 steps, and about 5× faster than standard search. [S] — [Morph on X](https://x.com/morphllm/status/1994484969050444103); [Morph blog](https://www.morphllm.com/blog/fast-context-rl-retrieval)
- WarpGrep v2 (2026-03-02):
  - It runs up to 36 grep and read calls per search, usually in under 6 s, averaging 3.8 steps, and returns precise spans.
  - SWE-Bench Pro gains are +2.1 with Opus and +3.7 with MiniMax.
  - Efficiency in one extract: about 17% fewer input tokens, 13% fewer turns, 12% faster and 15.6% cheaper (Opus 4.6 from $3.06 to $2.51 per task).
  - **Conflict:** the earlier doc cites 39% fewer input tokens and 26% fewer turns from the same post.

  [S] — [Morph blog](https://www.morphllm.com/blog/warpgrep-v2); [YC launch](https://www.ycombinator.com/launches/PZx-warpgrep-v2-code-search-subagent-1-on-swe-bench-pro)
- Fast Apply merges edits at about 10,500 tok/s with about 98% accuracy. [S] — [Morph](https://www.morphllm.com/products/warpgrep)

### Inferences
- The span-list contract (path plus line range, no prose) is the common denominator of WarpGrep, SWE-grep and FastContext. It is the right output shape for any index result consumed by a planner.

### Gaps
- Independent replication of the +2.1–3.7 points is missing, the run-to-run variance is not reported, and the efficiency figures conflict between extracts.

## 7. Augment Code

### Takeaway
Nothing new found beyond the Context Engine MCP GA (Feb 2026) and the SWE-bench Pro claims already covered. Augment's pitch is still a cloud semantic index served over MCP, with gains measured on its own rubric.

### Cited Findings
- Context Engine MCP GA (Feb 2026): "30–80% quality improvements" and "70%+" across Claude Code, Cursor and Codex, measured on 300 Elasticsearch PRs with 900 attempts. "MCP-enabled runs consistently required fewer tool calls and conversation turns", with no numbers. [S] — [Augment blog](https://www.augmentcode.com/blog/context-engine-mcp-now-live); [changelog](https://www.augmentcode.com/changelog/context-engine-mcp-in-ga)

### Inferences
- Augment's claims remain vendor-rubric numbers without variance. They should not be used as expected-gain targets.

### Gaps
- No 2026 post after February with new measurements was found; searches for later posts ran out of budget.

## 8. Sourcegraph and Amp

### Takeaway
Sourcegraph's MCP server moved to a curated default toolset on 2026-03-30; the full set, including deep search and precise navigation, sits behind a separate endpoint. Amp uses subagents for search: a local search agent on a fast model, and "Librarian" for remote GitHub code over Sourcegraph infrastructure. No new quantitative results were found beyond CodeScaleBench, already covered.

### Cited Findings
- The default endpoint `/.api/mcp` now serves "a curated set of tools focused on common context gathering" to "reduce tool-list noise… and avoid spending context window budget on lower-frequency tools". `deepsearch`, `go_to_definition`, `find_references`, `compare_revisions` and `get_contributor_repos` require `/.api/mcp/all`. [S] — [Sourcegraph changelog](https://sourcegraph.com/changelog/mcp-all); [curated tools](https://sourcegraph.com/changelog/mcp-curated-default-tools)
- Amp's search subagent has read-only tools and its own context. The Librarian searches all public GitHub and connected private repos. A third party reports the search agent runs on Gemini 3 Flash and the Librarian on Claude Sonnet 4.6. [S/3P] — [Librarian](https://ampcode.com/news/librarian); [Agents for the Agent](https://ampcode.com/notes/agents-for-the-agent); [Alex Dunlop](https://www.alexdunlop.com/writing/amp-vs-claude-code-worth-switching-2026)

### Inferences
- Even the company whose business is precise code navigation hides `find_references` and `go_to_definition` from its default MCP surface to save context. Precise-navigation tools must earn their slot by being consolidated.

### Gaps
- Amp has published no measurements of its search subagent or Librarian. The primary pages were not readable.

## 9. JetBrains (Junie, JetBrains Context, Mellum, JetBrains Research)

### Takeaway
JetBrains released three relevant things in 2025–26:
- JetBrains Context (2026-07-21), a semantic repository index for Claude Code, Codex CLI and Junie CLI. Its "up to" −68% turns, −59% latency and −48% cost are maxima over 205 SWE-bench, 175 monorepo and 1,953 localization tasks.
- A carefully measured instruction skill, benjamin-plus (−17.9% median cost, quality unchanged). It showed that injected guidance works and discoverable skills do not.
- The Complexity Trap paper: masking old tool outputs halves cost as well as LLM summaries do.

JetBrains also published an independent A/B showing two popular token-saving tools underdeliver.

### Cited Findings
- JetBrains Context (2026-07-21):
  - It "builds a semantic index of repositories and lets agents query it by concept instead of by keyword".
  - It supports multi-repo search, including repos not checked out locally.
  - It is early access, included with JetBrains AI.
  - The benchmark report gives only "up to" figures: −68% turns, −59% latency and −48% execution cost, "validated on 205 open-source SWE-bench tasks, 175 production-monorepo tasks, and 1,953 code-localization tasks". No per-benchmark breakdown, variance or resolve-rate effect was found.

  [S] — [JetBrains blog](https://blog.jetbrains.com/ai/2026/07/introducing-jetbrains-context-repository-intelligence-for-coding-agents/); [Air Context](https://www.jetbrains.com/air/context/); [JetBrains on X, 2026-07-21](https://x.com/jetbrains/status/2079568056066425167)
- benjamin-plus skill (2026-08):
  - A 745-token ruleset: "recon in one pass", "keyhole reads" (read 50 lines, not the whole file), probe the environment once, stop when the task's check passes, and poll every 30 s.
  - Paired A/B on 80 SkillsBench tasks (Claude Code 2.1.201, Sonnet 5, low effort): −17.9% median cost and up to −22% tokens. Quality: 7 better, 5 worse, 68 ties (sign test p=0.77).
  - On Java SWE-bench with Codex CLI and gpt-5.6-luna (675 paired replicas): −4.4% cost [−7.5, −1.5], p=0.003; solve rate unchanged; tool calls −20%.
  - Delivered as a discoverable skill folder it saved nothing (−0.5%, not significant), because "agents burned steps just finding SKILL.md".

  [V] — [benjamin-plus README](https://github.com/JetBrains/benjamin-plus-skill)
- The Complexity Trap (NeurIPS 2025 DL4Code; JetBrains blog Dec 2025):
  - Observation masking and LLM summaries both cut cost about 50% "without significantly degrading" solve rate, and summaries do not beat masking.
  - Masking scored 54.8% against 53.8% for summaries with Qwen3-Coder-480B, and was 5 points better with Gemini 2.5 Flash.
  - A hybrid of the two costs 7% less than masking and 11% less than summaries.

  [V/S] — [repo README](https://github.com/JetBrains-Research/the-complexity-trap); [arXiv 2508.21433](https://arxiv.org/abs/2508.21433); [JetBrains blog](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)
- JetBrains' independent A/B of token-saving tools (Jul 2026): rtk was +7.6% more expensive at low effort (claimed −60–90%), and "Caveman" saved about 8.5% (claimed 65%). [3P] — [JetBrains blog via tokenomics list](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/)
- Junie CLI, an LLM-agnostic agent, entered beta in March 2026. [S] — [JetBrains blog](https://blog.jetbrains.com/junie/2026/03/junie-cli-the-llm-agnostic-coding-agent-is-now-in-beta/)

### Inferences
- JetBrains' own careful A/B work shows realistic harness-level effects of −4% to −18% cost with quality flat. That is an order of magnitude smaller than its product headline (−48% "up to"). graph-indexer should budget for 5–20% savings and treat 50%+ claims as maxima.
- "Injected beats discoverable" is directly relevant to how graph-indexer ships its usage guidance.

### Gaps
- There is no public methodology for JetBrains Context: which agent, how many runs, and median against max. Nothing new on Mellum (a completion model) relevant to agent search was found.

## 10. GitHub / Microsoft (Copilot, VS Code, Copilot CLI)

### Takeaway
Microsoft publishes the most granular production A/B data of any vendor. It shows a semantic index is standard but small in effect. The larger, statistically significant wins come from:
- tool search and deferral: about −9% to −18% tokens;
- prompt caching and transport;
- a prompt that tells the model to "explore less, validate sooner": −8.5% tool calls, −9.3% p95 time-to-first-edit, quality flat.

VS Code exposes semantic, text, grep, file and "usages" (LSP) search tools over automatic remote or local indexes. Copilot CLI ships a read-only `explore` agent. Microsoft says custom-trained search subagents are next.

### Cited Findings
- VS Code's `How Copilot understands your workspace` page (approved 2026-09-16) lists the search tools:
  - Semantic search (`#codebase`, which needs an index).
  - Text search.
  - Grep (works without an index).
  - File search.
  - Usages, which "combines Find All References, Find Implementation, and Go to Definition".
  - List directory and read file.
  - Cross-repo `#githubRepo` (semantic) and `#githubTextSearch`.

  Index sources are a remote GitHub or Azure DevOps index ("built once per repository… often instantly available") or a local index (on by default for personal accounts, off for org and enterprise). "These same general approaches are used on all codebases, from those with five files to those with 500,000 files." [V] — [VS Code docs](https://code.visualstudio.com/docs/agents/reference/workspace-context)
- GitHub repository indexing: initial indexing takes up to 60 s for a large repo and updates "within seconds" of a new conversation. The cloud agent (renamed from coding agent) uses semantic code search "when the agent doesn't know the precise names". [V] — [GitHub docs](https://docs.github.com/en/copilot/concepts/context/repository-indexing)
- Copilot CLI's built-in `explore` agent is "a fast, lightweight codebase exploration agent. It uses code intelligence, grep, glob, view, and shell tools". It is read-only and parallel-safe. Other built-ins are `task`, `research`, `code-review`, `rubber-duck` and `general-purpose`. [V] — [GitHub docs](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-custom-agents)
- Token efficiency (VS Code blog, 2026-06-17; A/B tests in production):
  - OpenAI tool search, 4-day experiment: p50 tokens per turn −9.81% (GPT-5.4) and −8.61% (GPT-5.5); TTFT −6.9% and −7.3%; time to complete −5.3% and −5.4%; session total −8.97% and −10.92%.
  - Anthropic server-side tool search, 7 days: p50 prompt tokens per turn −11.30%, and by user −18.32%.
  - Client-side tool search with the Copilot embedding model, 2-week rollout: time to complete −1.3% to −3.35%, user error −4.01% (Sonnet 4.6).
  - Anthropic cache hit rate is about 94% after reworking breakpoints (tool definitions end, system prompt end, two rolling anchors).
  - Extended 24-hour prompt caching raised cache hit rates +13% to +919%, relative, depending on the gap between requests.
  - WebSockets cut TTFT p50 by 16–19%.
  - "Next… specialized subagents, and exploring custom-trained ones, for narrow tasks like searching the workspace".

  [V] — [VS Code blog](https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot)
- GPT-5.5 prompt experiment (2026-07-06; 2 weeks, 25/25/25 split):
  - Treatment B restructured the prompt around "Before the first edit": start from a concrete anchor, gather only enough nearby evidence for one falsifiable hypothesis, and treat further searching as "drift". It is followed by "After the first edit" validation.
  - Results: average tool calls −8.54% (2.04 fewer, p=1e-12); p95 tokens per turn −7.64% (p=0.0003); p95 time to first edit −9.30% (38.8 s, p=1e-10); p50 time to first edit −5.68%; p50 tokens per user −3.25% (not significant).
  - Quality: commit survival +0.68% (not significant); 10-minute survival −0.44% (p=0.049).
  - It shipped as the default.
  - The lighter Treatment A ("prefer one targeted search or nearby read over broad repo exploration… do not re-read unchanged context") gave −3.19% tool calls and −5.19% p95 tokens.

  [V] — [VS Code blog](https://code.visualstudio.com/blogs/2026/07/06/optimizing-vscode-coding-harness-model-providers)
- VSC-Bench, Microsoft's offline suite: at xhigh effort, models use more tokens than at high but resolve slightly fewer tasks. A 50,000-run smoke test found some models list or search an empty workspace in 56–96% of runs before writing one file. [V] — [Harness post, 2026-05-15](https://code.visualstudio.com/blogs/2026/05/15/agent-harnesses-github-copilot-vscode); [50,000 runs, 2026-06-19](https://code.visualstudio.com/blogs/2026/06/19/what-50000-runs-taught-us)
- MAI-Code-1-Flash (2026-07-29), Microsoft's own model: GPT-5.6 Luna and Kimi K2.7 Code reach slightly higher quality but use 67–94% more tokens per turn. [V] — [VS Code blog](https://code.visualstudio.com/blogs/2026/07/29/mai-code-1-flash)
- Copilot embedding model details beyond +37.6%: the average score rose from 0.362 to 0.498, and code-acceptance ratios rose +110.7% for C# and +113.1% for Java. [S] — [GitHub blog](https://github.blog/news-insights/product-news/copilot-new-embedding-model-vs-code/)
- Fewer tools (40→13) details: +2–5 points were measured on SWE-Lancer and SWE-bench Verified with GPT-5 and Sonnet 4.5, and embedding-guided tool routing reached 94.5% coverage. [S] — [GitHub blog](https://github.blog/ai-and-ml/github-copilot/how-were-making-github-copilot-smarter-with-fewer-tools/)
- GitHub published an offline ablation of harness efficiency, resolution against $/task across 5 benchmarks and 4 models; no figures were retrieved. [3P] — [GitHub blog](https://github.blog/ai-and-ml/github-copilot/evaluating-performance-and-efficiency-of-the-github-copilot-agentic-harness-across-models-and-tasks/)

### Inferences
- In Microsoft's data, how the agent is told to search (anchor first, stop exploring) moved tool calls and tail latency more than semantic retrieval did (−2% time). A tool that hands the agent a concrete anchor (definition plus callers plus tests) in one call is aligned with that best-performing change.
- Deferral and cache stability are worth about 10–18% tokens on their own. An MCP server that breaks cache stability can erase its own savings.

### Gaps
- There is no Microsoft ablation of the "usages" LSP tool or of index availability on agent success. The GitHub harness-efficiency figures could not be read.

## 11. Other companies

### Takeaway
Open-source and second-tier agents mostly clone Claude Code's design:
- A read-only `Explore` subagent with quick, medium or thorough levels: Kimi CLI, Qwen Code, Mistral Vibe and Copilot CLI.
- Shell or ripgrep search plus optional LSP.
- Threshold compaction.

Structural indexes appear in four places: Trae's tree-sitter "CKG" in SQLite, Kiro's tree-sitter code intelligence, Kilo's opt-in embedding index and Qodo's cloud context engine. Only Factory published a measured context-compression evaluation. Roo Code shut down on 2026-05-15.

### Cited Findings
- **Factory.** "Evaluating Context Compression" used over 36,000 production messages and probe-based scoring. Factory's "anchored iterative summarization" keeps a structured summary (intent, file modifications, decisions, next steps) and merges only the newly truncated span. It scored 3.70, against 3.44 for Anthropic's and 3.35 for OpenAI's compaction. The failure mode it highlights is losing exact file paths, endpoints and error codes. [S] — [Factory](https://factory.ai/news/evaluating-compression)
- **Amazon Kiro.** CLI code intelligence (around 2025-12-18, CLI 1.22 "Code Intelligence and Knowledge Index") is built on tree-sitter for 18 languages with optional LSP. `/code init` provides semantic search, go-to-definition and find-references; `/code overview` summarizes a workspace. CLI 1.24 added conversation compaction. [S] — [Kiro docs](https://kiro.dev/docs/tools/code-intelligence/); [CLI 1.22](https://kiro.dev/changelog/cli/1-22/); [CLI 1.24](https://kiro.dev/changelog/cli/1-24/)
- **Qodo.** The Context Engine (formerly Qodo Aware) is served over MCP and combines "RAG with agentic reasoning" over pre-indexed repos. It offers Deep Research, Ask and Issue Finder agents, plus an internal DeepCodeBench. No agent-efficiency numbers were found. [S] — [Qodo blog](https://www.qodo.ai/blog/introducing-qodo-aware-deep-codebase-intelligence-for-enterprise-development/); [docs](https://docs.qodo.ai/qodo-aware/usage/usage-guide)
- **ByteDance Trae Agent.** Its `ckg` tool builds a tree-sitter code knowledge graph in SQLite, keyed by a snapshot hash: `git-clean-<commit>`, `git-dirty-<commit>-<md5 of status>`, or a metadata hash for non-git trees. Commands are `search_function`, `search_class` and `search_class_method`, with optional bodies. Its description warns: "The CKG is not completely accurate, and may not be able to find all functions or classes." [V] — [ckg_tool.py](https://github.com/bytedance/trae-agent/blob/main/trae_agent/tools/ckg_tool.py); [ckg_database.py](https://github.com/bytedance/trae-agent/blob/main/trae_agent/tools/ckg/ckg_database.py)
- **Alibaba Qwen Code.** It is a Gemini CLI fork that now mirrors Claude Code. Its built-in `Explore` agent copies Claude's Explore prompt nearly verbatim and adds an `LSP` tool to its toolset. It has `tool-search`, `priorReadEnforcement`, `grepReadTracking` and tool-result retention (30,000-char fallback budget), and can delegate to `claude-code` or `codex`. [V] — [builtin-agents.ts](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/subagents/builtin-agents.ts); [tool-result-retention.ts](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/tools/tool-result-retention.ts)
- **Moonshot Kimi CLI.** Its `explore` subagent prompt is Claude-like: "Use this agent for any read-only exploration that will clearly require more than 3 tool calls. Prefer launching multiple explore agents concurrently". Auto-compaction triggers at 0.85 of the window or when fewer than 50,000 tokens remain. [V] — [explore.yaml](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/agents/default/explore.yaml); [compaction.py](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/soul/compaction.py); [config.py](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/config.py)
- **Mistral Vibe.** It has an `Explore` subagent limited to `grep`, `read_file` and `skill`. `grep` caps output at 64,000 bytes, 100 matches by default and a 60 s timeout, and honours a `.vibeignore` file. `read_file` caps at 50 KB. Auto-compaction triggers at 200,000 tokens by default. [V] — [agents/models.py](https://github.com/mistralai/mistral-vibe/blob/main/vibe/core/agents/models.py); [grep.py](https://github.com/mistralai/mistral-vibe/blob/main/vibe/core/tools/builtins/grep.py); [_defaults.py](https://github.com/mistralai/mistral-vibe/blob/main/vibe/core/config/_defaults.py)
- **Kilo Code.** The current monorepo embeds an OpenCode fork (`packages/opencode`). Codebase indexing is opt-in and off by default: tree-sitter blocks are embedded with OpenAI, Ollama and other providers into LanceDB or Qdrant, and exposed as a `semantic_search` tool. [V] — [codebase-indexing.md](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/customize/context/codebase-indexing.md)
- **Roo Code** (which had Qdrant embedding indexing): "The Roo Code Extension was shut down on May 15th." Users are pointed to ZooCode (a community fork) and Cline. [V] — [Roo Code README](https://github.com/RooCodeInc/Roo-Code/blob/main/README.md)
- **Cline.** There is no index. The 4.1.x changelog is about compaction reliability, for example "Long tasks now compact when they actually need to" after a chars/3 estimate misfired. Subagents were "temporarily disabled" in VS Code during the SDK migration. [V] — [Cline CHANGELOG](https://github.com/cline/cline/blob/main/CHANGELOG.md)
- **Zed.** The agent's read and search tools are `grep`, `find_path`, `read_file`, `list_directory` and `diagnostics`, plus `spawn_agent`. There is no semantic index. [V] — [Zed tools docs](https://github.com/zed-industries/zed/blob/main/docs/src/ai/tools.md)
- **xAI grok-build** (open-sourced 2026-07-14). It ships several tool "dialects" matched to model training: Codex's `grep_files`, `list_dir` and indentation-aware `read_file`; an OpenCode set; and native grep, read_file and list_dir. It also has an LSP manager with diagnostics reminders and a tool-search tool. [V] — [xai-grok-tools implementations](https://github.com/xai-org/grok-build/tree/main/crates/codegen/xai-grok-tools/src/implementations); [3P date](https://github.com/VILA-Lab/Dive-into-Claude-Code/blob/main/docs/agent-design-space-source-notes.md)
- **Replit, Tabnine, Zhipu (GLM/Z.ai).** Nothing published on code search or context efficiency was found; the Tabnine and Zhipu searches could not run (budget). Kimi K2.7-Code and GLM-5.2 are priced at $0.95/$4.00 and $1.40/$4.40 per MTok. [3P] — [tokenomics list](https://github.com/QuesmaOrg/awesome-ai-tokenomics/blob/main/README.md)

### Inferences
- The Claude Code Explore pattern has become a de facto standard: read-only, parallel greps, thoroughness levels, and a final report only. A graph-indexer subagent definition written in that shape would port across Claude Code, Kimi CLI, Qwen Code and Mistral Vibe with minor renaming.
- Trae's CKG is the closest industrial analogue to graph-indexer: tree-sitter plus SQLite plus git-state keys. It rebuilds per snapshot, and it discloses its incompleteness in the tool description.

### Gaps
- There is no data for Replit, Tabnine or Zhipu. Kiro's and Qodo's effects are unmeasured. The Cline "why we don't index" position could not be re-verified in this session.

## 12. Across companies: measured gains against claims, converged patterns, what was abandoned

### Takeaway
Measured, controlled effects in 2025–26 are mostly efficiency effects of 5–20%, with quality flat. They come from harness changes: tool deferral, caching, "anchor-first" prompting, injected rules and masking. Retrieval indexes show small end-to-end effects: +2 to +4 points of resolve rate, 2% faster, or +2.6% retention in large repos. Bigger numbers (−48% to −68%, +70%) are vendor maxima on vendor rubrics. The industry converged on shell-native fast search, a read-only exploration subagent that returns spans, deferred tools, and compaction pushed into model or server. It abandoned vector RAG as the default search path, dedicated grep and find tools, cheap-model-only exploration, discoverable-only guidance, and unbounded fan-out.

### Cited Findings
| Company | How the agent searches (2026-09) | Index | Exploration subagent | Best published measurement (date, type) |
|---|---|---|---|---|
| Anthropic | Bash + embedded ugrep/bfs; Read with PARTIAL view and dedup; optional LSP ([tools ref](https://code.claude.com/docs/en/tools-reference)) | none | Explore/Plan (inherit model since 2026-07-01) ([docs](https://code.claude.com/docs/en/sub-agents)) | API context editing −84% tokens (2025-09-29, internal eval) ([S](https://claude.com/blog/context-management)); PTC −37% tokens ([S](https://www.anthropic.com/engineering/advanced-tool-use)) |
| OpenAI | shell `rg`, parallel reads ([default.md](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md)) | none | `explorer` role ([role.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/role.rs)) | GPT-5.6 PTC −24% output tokens and −28% time (2026-07-09, vendor) ([S](https://openai.com/index/gpt-5-6/)) |
| Google | grep/glob/read tools; bundled ripgrep ([changelog](https://github.com/google-gemini/gemini-cli/blob/main/docs/changelogs/index.md)) | Code Assist Enterprise only (24 h reindex) ([S](https://docs.cloud.google.com/gemini/docs/codeassist/code-customization-overview)) | codebase_investigator (Flash, 50 turns) ([V](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/agents/codebase-investigator.ts)) | none published |
| Cursor | grep + Instant Grep index + semantic search ([S](https://cursor.com/blog/fast-regex-search)) | local n-gram + cloud embeddings | research subagent (2.4) | self-summary −50% compaction error at 1/5 tokens ([S](https://cursor.com/blog/self-summarization)); dynamic context −46.9% (A/B, covered) |
| Cognition | Fast Context (SWE-grep, 8×4) ([S](https://cognition.com/blog/swe-grep)) | none | Fast Context | Fable-led exploration hand-off: 545K vs 1,679K input tokens (2026-07-13) ([3P](https://github.com/VILA-Lab/Dive-into-Claude-Code/blob/main/docs/agent-design-space-source-notes.md)) |
| Morph | WarpGrep RL subagent over MCP ([S](https://www.morphllm.com/blog/warpgrep-v2)) | none | WarpGrep | +2.1–3.7 SWE-Bench Pro; efficiency figures conflict |
| GitHub/Microsoft | semantic + text + grep + usages (LSP) ([V](https://code.visualstudio.com/docs/agents/reference/workspace-context)) | remote/local embeddings | Copilot CLI `explore` ([V](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-custom-agents)) | tool search −9 to −18% tokens; anchor-first prompt −8.5% tool calls (2026-06/07, production A/B) ([V](https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot)) |
| JetBrains | Junie + JetBrains Context semantic index ([S](https://blog.jetbrains.com/ai/2026/07/introducing-jetbrains-context-repository-intelligence-for-coding-agents/)) | cloud semantic, multi-repo | — | benjamin-plus −17.9% median cost, paired (2026-08) ([V](https://github.com/JetBrains/benjamin-plus-skill)); masking ≈ summaries at about −50% cost ([V](https://github.com/JetBrains-Research/the-complexity-trap)) |

- Controlled or A/B measurements with the same model:
  - VS Code tool search, caching and anchor-first prompt (production A/B, p-values reported). [V] — [VS Code blog](https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot); [GPT-5.5 experiment](https://code.visualstudio.com/blogs/2026/07/06/optimizing-vscode-coding-harness-model-providers)
  - benjamin-plus (paired A/B, Wilcoxon and sign tests). [V] — [README](https://github.com/JetBrains/benjamin-plus-skill)
  - Complexity Trap (SWE-bench Verified, several models). [V] — [repo](https://github.com/JetBrains-Research/the-complexity-trap)
  - Cursor semsearch and dynamic context (online A/B, already covered).
  - Copilot 40→13 tools (+2–5 points). [S] — [GitHub blog](https://github.blog/ai-and-ml/github-copilot/how-were-making-github-copilot-smarter-with-fewer-tools/)
  - Copilot semantic search (−2% time, no quality change, already covered).
- Vendor claims without variance or methodology: JetBrains Context "up to" figures, Augment +70–80%, SWE-grep "10×/20× faster", WarpGrep efficiency, Qodo and Kiro (no numbers), Gemini's investigator (no numbers), and Anthropic's "agentic search generally works better" (no numbers). [S] — sources in sections 1, 3, 5, 6, 7 and 9.
- Evidence that token cuts can raise cost: a compression arm that removed 38% of tool-output tokens cost 6.8% more because it broke the cached prefix. [3P] — [arXiv 2607.12161 via tokenomics list](https://github.com/QuesmaOrg/awesome-ai-tokenomics/blob/main/practices/retrieval-boundary-compression.md). Codex's compaction regression roughly doubled token use. [3P] — [#16812](https://github.com/openai/codex/issues/16812)
- Converged patterns:
  1. Read-only exploration subagents that return conclusions or spans: Claude Explore, Codex explorer, Gemini investigator, Copilot CLI explore, Kimi, Qwen and Vibe Explore, Cursor, Fast Context, Amp and WarpGrep. [V/S] — sections 1–11.
  2. Search through the shell and embedded ripgrep-class binaries. Claude Code 2.1.117 dropped Grep and Glob, Antigravity retired `grep_search`, `find_by_name` and `list_dir`, and Codex's base prompt says "prefer `rg`". [V] — [changelog](https://code.claude.com/docs/en/changelog); [Antigravity CHANGELOG](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)
  3. Deferred tools behind tool search: Claude Code, Codex (BM25), VS Code (embeddings) and Cursor (files). [V] — sections 1, 2 and 10.
  4. Semantic index as an optional extra tool, never replacing grep: Cursor, Copilot, Kilo opt-in, JetBrains, Augment and Gemini Code Assist. [V/S]
  5. LSP as an optional precision layer: Claude Code plugins (inactive by default and in cloud), Copilot "usages", Qwen Explore with LSP, Kiro, grok-build and Zed diagnostics. [V]
  6. Compaction moved into the model (GPT-5.1-Codex-Max, Composer self-summary) or the server (Anthropic compaction API, Codex remote compaction), plus cheaper masking (JetBrains, Gemini CLI masking, Claude microcompact) and notes with searchable history (Codex Astra). [V/S]
  7. Frugal-read discipline: Claude Read dedup and PARTIAL view, Gemini `frugalReads` evals, benjamin "keyhole reads", VS Code "do not re-read unchanged context", and Qwen's `priorReadEnforcement`. [V]
- Abandoned or reversed:
  - Anthropic's early RAG plus local vector DB. [S] — [Cherny](https://x.com/bcherny/status/2017824286489383315)
  - Dedicated Grep and Glob tools in Claude Code native builds (2026-04-22) and legacy search tools in Antigravity. [V]
  - Codex's experimental `grep_files`, `read_file` and `list_dir`, absent from current source. [V]
  - Explore-on-Haiku as a default (reverted 2026-07-01). [V]
  - Roo Code, whose product included embedding indexing, shut down on 2026-05-15. [V]
  - Unbounded fan-out: Claude Code added delegation restraint (2026-07-19) and removed, then capped, nesting. [V]
  - Discoverable-only skill delivery: −0.5% (not significant) against −17.9% when injected. [V]
  - Aggressive compaction thresholds: the Codex regression. [3P]

### Inferences
- Harness-level efficiency levers produce repeatable 5–20% savings with quality flat, and they are cheap to adopt. Retrieval-index levers produce small, task-dependent quality gains. graph-indexer's credible value proposition is therefore "fewer calls, fewer tokens, the same or better answer, especially for structural questions". It is not "higher resolve rate".
- The exploration-subagent pattern is ubiquitous but pays handoff costs: detail loss, confirmation bias, and 4× tokens when fanned out. A deterministic index that answers "where / who calls / what breaks / which tests" in one call can replace many small delegations. Claude Code's own delegation-restraint prompt now discourages those small delegations.

### Gaps
- No vendor has published a same-model ablation of "exploration subagent against index tool against grep-only" on resolve rate with variance. No vendor measures false-negative rates of its search tools, though Claude Code's changelog shows they happen.

## Implications for graph-indexer

### Takeaway
graph-indexer should copy the harness-level patterns with measured payoffs:
- few, deferral-friendly tools;
- cache-stable output;
- anchor-first, span-list answers;
- injected (not discoverable) usage rules;
- frugal-read support.

It should integrate with the converged host mechanisms: the Bash search path through a CLI and hooks, and exploration subagents through agent definitions and SubagentStart. It should ignore model training, cloud indexes and compaction, which belong to the hosts. Expect 5–20% efficiency gains; do not promise resolve-rate gains.

### Cited Findings
| # | Technique (who) | Decision | Why (evidence) |
|---|---|---|---|
| 1 | Read-only exploration subagent returning structured spans (Claude Explore, Codex explorer, Gemini investigator, Copilot CLI explore, Kimi, Qwen and Vibe Explore) | **Integrate.** Ship a ready-made subagent or agent file per host (Claude Code agents, Codex role, Kimi and Qwen YAML/TS) whose tools are graph-indexer plus grep and read. Its return contract should be Gemini's `RelevantLocations{FilePath, Reasoning, KeySymbols}` plus line ranges. Do not train a model. | Universal pattern ([investigator schema](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/agents/codebase-investigator.ts); [Kimi explore](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/agents/default/explore.yaml)). Codex tells the parent to trust explorers "without additional verification" ([role.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/role.rs)), so completeness notes must travel inside the span list. |
| 2 | One-call answers in the main loop instead of delegation (Claude delegation restraint, Systima fan-out cost, Cognition early hand-off) | **Copy.** Make "where is X / who calls X / what breaks / which tests" one bounded call (300–2,000 tokens) usable without a subagent. | Delegation "multipl[ies] cost… both handoffs drop detail" ([Piebald](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/system-prompt-subagent-delegation-cost-guidance.md)). 121K vs 513K tokens when fanned out ([3P](https://systima.ai/blog/claude-code-vs-opencode-token-overhead)). |
| 3 | Shell-native search (Claude Code ugrep/bfs through Bash, Codex `rg`, Antigravity retiring grep tools) | **Integrate.** Offer an `rg`-compatible CLI mode with structure-annotated hits. Hooks must match Bash commands (`rg`, `grep`, `ugrep`, `find`, `bfs`) as well as Grep and Glob tool names. | Search now arrives as Bash calls in Claude Code native builds ([Tools reference](https://code.claude.com/docs/en/tools-reference)) and Codex ([default.md](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md)). |
| 4 | Local regex index (Cursor Instant Grep) | **Copy, scaled down and only for large repos.** Use an SQLite FTS5 trigram prefilter; skip bloom filters and the sparse-weights design unless above about 1M LOC. | 16.8 s→13 ms matters in monorepos ([S](https://cursor.com/blog/fast-regex-search)), but hosts already embed ripgrep ([Gemini v0.40.0](https://github.com/google-gemini/gemini-cli/blob/main/docs/changelogs/index.md); [Antigravity](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)). |
| 5 | Semantic embedding channel (Cursor, Copilot, Kilo, JetBrains Context, Augment) | **Integrate modestly.** Keep an optional local static-embedding channel for natural-language queries; never make it the default path or the headline. | Copilot semantic search: 2% faster, no quality change ([GitHub changelog](https://github.blog/changelog/2026-03-17-copilot-coding-agent-works-faster-with-semantic-code-search/)). Kilo keeps indexing opt-in ([V](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/customize/context/codebase-indexing.md)). |
| 6 | Tool minimalism and curated defaults (GitHub 40→13, Sourcegraph curated MCP, "low tool cardinality") | **Copy.** Keep about 6 tools, with a self-explanatory name and first sentence for each. Consider marking one core tool `alwaysLoad`. | +2–5 points and −400 ms ([S](https://github.blog/ai-and-ml/github-copilot/how-were-making-github-copilot-smarter-with-fewer-tools/)). Sourcegraph hides even find_references by default ([S](https://sourcegraph.com/changelog/mcp-all)). Claude Code defers MCP tools ([changelog](https://code.claude.com/docs/en/changelog)). |
| 7 | Deferral-friendly metadata (tool search: Claude, Codex BM25, VS Code embeddings) | **Copy.** Put the query vocabulary the agent will use ("callers", "references", "impact", "tests") in tool names and descriptions, because Codex matches with BM25 and VS Code with embeddings. | [tool_search_spec.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/tool_search_spec.rs); tool search saves 9–18% tokens ([VS Code](https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot)). |
| 8 | Prompt-cache stability (Codex exact-prefix, VS Code 94% hits, Claude byte-stable tool lists) | **Copy.** Emit deterministic `tools/list`, stable result ordering and no volatile fields (timestamps or elapsed ms in text). Hook output should only append. | Cache reads cost about 10% of input ([VS Code](https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot)). Breaking the prefix turned −38% tokens into +6.8% cost ([3P](https://github.com/QuesmaOrg/awesome-ai-tokenomics/blob/main/practices/retrieval-boundary-compression.md)). |
| 9 | Frugal reads (Claude Read dedup and PARTIAL view, Gemini frugalReads eval, benjamin keyhole reads, VS Code "don't re-read unchanged context") | **Copy.** Serve symbol-scoped spans with line numbers. Return an "unchanged since last served (hash)" marker instead of re-sending, and add `offset`/`limit` hints so the follow-up Read before Edit stays narrow. | MCP output does not satisfy read-before-edit ([Tools reference](https://code.claude.com/docs/en/tools-reference)). Anthropic, Google and Microsoft all optimize this ([changelog 2.1.86](https://code.claude.com/docs/en/changelog); [frugalReads](https://github.com/google-gemini/gemini-cli/blob/main/evals/frugalReads.eval.ts)). |
| 10 | Anchor-first workflow (VS Code GPT-5.5 Treatment B) | **Copy into guidance and output design.** The first answer gives the anchor (definition + direct callers + likely tests) and the next step is "edit, then run these tests". | −8.54% tool calls, −9.30% p95 time to first edit, quality flat ([V](https://code.visualstudio.com/blogs/2026/07/06/optimizing-vscode-coding-harness-model-providers)). |
| 11 | Injected short policy over discoverable skill (benjamin-plus; Claude 5's 80% prompt cut) | **Copy.** Ship a policy of 750 tokens or less, injected through SessionStart, SubagentStart or AGENTS.md. Do not rely on a skill being found, and avoid "CRITICAL/ALWAYS" wording. | Injected −17.9% against discoverable −0.5% (not significant) ([V](https://github.com/JetBrains/benjamin-plus-skill)); Claude 5 guidance favours judgment over rules ([S](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)). |
| 12 | LSP precision layer (Claude LSP plugins, Copilot usages, Qwen Explore with LSP, Kiro) | **Integrate as complement.** Position graph-indexer's no-build references as the fallback where LSP is absent (cloud sessions, no plugin, unsupported languages). Report post-edit diagnostics as deltas only. | Claude LSP is inactive without a plugin and in cloud sessions ([Tools reference](https://code.claude.com/docs/en/tools-reference)). Stale pre-edit diagnostics caused re-reads (fixed in 2.1.111) ([changelog](https://code.claude.com/docs/en/changelog)). |
| 13 | Test impact analysis (Anthropic TIA: history + package relevance) | **Copy selectively.** Add an optional history signal (last results, flaky, duration) and package-level relevance to graph-based test selection, and state reasons. | CI jobs 25× in 6 months at Anthropic; its selector is deterministic and history-driven ([S](https://claude.com/blog/agentic-coding-is-straining-ci-heres-how-we-scaled-test-impact-analysis-at-anthropic)). |
| 14 | Programmatic tool calling and code execution (Anthropic PTC −37%, MCP code execution −98.7%, GPT-5.6 PTC −24% output tokens) | **Integrate.** Offer batch forms (many symbols per call) and machine-readable CLI JSON so agents that write code can query in loops without round trips. | [S](https://www.anthropic.com/engineering/advanced-tool-use); [S](https://openai.com/index/gpt-5-6/) |
| 15 | Survive compaction and masking (Claude microcompact and tool-result clearing, Gemini masking, JetBrains masking, Codex history-notes, Factory anchored summaries) | **Ignore implementing compaction; design for it.** Every answer carries canonical `path:line` and symbol IDs so a cleared result can be re-fetched in milliseconds. Keep results small so hosts do not persist them to disk. | Summaries lose "file paths… error codes" ([S](https://factory.ai/news/evaluating-compression)). Masking is as good as summaries at about −50% cost ([V](https://github.com/JetBrains-Research/the-complexity-trap)). Claude persists results over 50K chars ([changelog](https://code.claude.com/docs/en/changelog)). |
| 16 | Honest completeness in search (Claude Code's recurring silent-empty bugs; Trae's "CKG is not completely accurate") | **Copy.** Distinguish "0 results" from "search failed or index stale", and state unresolved counts in text. | Three 2026 Claude Code fixes for false "no matches" ([changelog](https://code.claude.com/docs/en/changelog)); [Trae ckg_tool.py](https://github.com/bytedance/trae-agent/blob/main/trae_agent/tools/ckg_tool.py) |
| 17 | Snapshot-keyed index (Trae git-clean/git-dirty hash) | **Ignore as primary design** in favour of per-file freshness; **copy the key idea** for reusing whole-index caches across worktrees and branches. | Trae rebuilds per snapshot ([ckg_database.py](https://github.com/bytedance/trae-agent/blob/main/trae_agent/tools/ckg/ckg_database.py)). |
| 18 | RL-trained retrieval models (SWE-grep, WarpGrep, FastContext, Composer) | **Ignore training; copy the metric.** Evaluate graph-indexer span lists with a precision-weighted F1 over files and line ranges. Optionally expose graph-indexer as a tool these subagents can call over MCP. | Precision-first reward ([S](https://cognition.com/blog/swe-grep)); WarpGrep is shipped as an MCP subagent ([S](https://www.morphllm.com/blog/warpgrep-v2)). |
| 19 | Cloud or shared indexes (Copilot remote index, Gemini Code Assist customization, JetBrains multi-repo, Augment, Qodo) | **Ignore for now**: out of scope for a local-first, free tool. Keep multi-repo as a future local feature (`--add-dir` style). | [GitHub docs](https://docs.github.com/en/copilot/concepts/context/repository-indexing); [Google](https://docs.cloud.google.com/gemini/docs/codeassist/code-customization-overview); [JetBrains](https://blog.jetbrains.com/ai/2026/07/introducing-jetbrains-context-repository-intelligence-for-coding-agents/) |
| 20 | Model-side compaction and self-summarization (GPT-5.1-Codex-Max, Composer) | **Ignore.** This is host and model territory. | [S](https://openai.com/index/gpt-5-1-codex-max/); [S](https://cursor.com/blog/self-summarization) |

### Inferences
- Priority by evidence per unit of effort:
  1. Cache-stable, deterministic, small outputs, with honest completeness (rows 8, 15, 16).
  2. Bash-path integration (CLI plus hooks that recognize shell search) and an injected policy of about 750 tokens (rows 3, 11).
  3. Anchor-first one-call answers with span lists and read hints (rows 2, 9, 10).
  4. Exploration-subagent definitions for Claude Code, Codex, Kimi and Qwen (row 1).
  5. Batch and JSON interfaces (row 14).
  6. Optional history-aware test selection (row 13).
  7. Optional semantic channel and trigram prefilter (rows 4, 5).
- Expected effect size, from the only rigorous vendor A/Bs, is 5–20% fewer tokens or tool calls with flat quality. graph-indexer's own benchmark should be designed to detect effects of that size: paired runs, medians and p95s, with cache hits recorded.

### Gaps
- No published data isolates an index-backed exploration subagent against the built-in grep-based Explore on the same host and model. graph-indexer will have to run that experiment itself; Claude Code's `claude plugin eval` (three runs with and three without) is the cheapest harness, as covered in the earlier report.
- Whether MCP answers can satisfy Claude Code's read-before-edit in the future is unknown. For now they do not.
