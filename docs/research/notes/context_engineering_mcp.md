# Context engineering & MCP tool design for AI coding agents — evidence review (2024 → Sept 2026)

Verification legend (research done 2026-09-22). **[V]** = verified in this session against the primary artifact (spec source, schema, repo file, source code, changelog, published result files). **[V2]** = verified only through a secondary source in this session (search-engine summary or a third-party paraphrase). **[R]** = recalled from the named publication. The page could not be re-fetched here because the sandbox egress proxy blocked anthropic.com, arxiv.org, code.claude.com, modelcontextprotocol.io, cursor.com and similar sites, and the shared web-search budget ran out after one query. Re-verify exact [R] figures before quoting them. GitHub-hosted primary sources were read by cloning the repos (spec repo, anthropics/claude-code CHANGELOG, openai/codex source, gemini-cli docs, vscode-docs, SWE-agent, NoLiMa, RULER, Chroma context-rot, TOON, MCP benchmark repos). The measured Claude Code facts come from its CHANGELOG, whose entries are versioned but not dated. The current version is **2.1.280** (Sept 2026), the release that made Claude Opus 5.5 the default Opus.

---

## 1. Anthropic engineering guidance: concrete rules for tool surfaces and outputs

### Takeaway
Anthropic's guidance from 2024 to 2026 points one way. Build a **small, consolidated, namespaced set of workflow-shaped tools**. Return **high-signal, token-bounded responses**: paginate, filter or truncate with sensible defaults, offer a `response_format` concise/detailed switch, and use semantic IDs rather than UUIDs. Write **errors that steer**. Write **precise descriptions of 3–4+ sentences** that say when to use a tool and when not to, and move worked examples and long protocols out of descriptions into progressively disclosed skills. Anthropic's measured numbers: tool search raised MCP-eval accuracy from 49→74% (Opus 4) and 79.5→88.1% (Opus 4.5) [R]; tool-use examples raised accuracy from 72→90% [R]; code execution over MCP cut ~150K tokens to ~2K (−98.7%) [R, illustration also in MCP docs [V]]; in the Slack example, the concise response was 72 tokens against 206 for detailed [R].

### Cited Findings

**"Writing effective tools for agents — with agents" (Anthropic Engineering, Sep 11 2025)**
- [V2] Recommends a `response_format` enum parameter ("concise" vs "detailed") so agents control verbosity. For any response that could use up lots of context, implement "pagination, range selection, filtering, and/or truncation with sensible default parameter values". — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents) (via search summary; paraphrased in [ADR-0023, mcp-server-langgraph](https://github.com/vishnu2kmohan/mcp-server-langgraph/blob/main/adr/adr-0023-anthropic-tool-design-best-practices.md))
- [V2] Tool response structure (XML, JSON or Markdown) "can have an impact on evaluation performance". There is no one-size-fits-all format. LLMs tend to do better with formats that match their training data, and the optimal structure varies by task and agent. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [R] "Claude Code restricts tool responses to 25,000 tokens by default." The ADR paraphrases this as "Restrict responses to ~25,000 tokens" [V2]. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents); [ADR-0023](https://github.com/vishnu2kmohan/mcp-server-langgraph/blob/main/adr/adr-0023-anthropic-tool-design-best-practices.md)
- [R] Slack-thread example: the "detailed" response took ~206 tokens and the "concise" one ~72. The concise response still kept the thread ID needed for follow-up calls. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [R] Consolidation. "More tools don't always lead to better outcomes." Don't wrap every API endpoint. Examples of consolidated tools: `schedule_event` instead of `list_users` + `list_events` + `create_event`; `search_logs` instead of `read_logs`; `get_customer_context` instead of `get_customer_by_id` + `list_transactions` + `list_notes`. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [R] Namespacing. Group related tools under common prefixes, either by service (`asana_search`, `jira_search`) or by resource (`asana_projects_search`, `asana_users_search`). The choice between prefix and suffix namespacing had "non-trivial effects" on Anthropic's tool-use evals, and the effect varies by LLM. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [R] Semantic identifiers. Return high-signal fields (`name`, `image_url`, `file_type`) rather than `uuid`, `256px_image_url` or `mime_type`. Resolving arbitrary alphanumeric UUIDs into semantically meaningful language, "or even a 0-indexed ID scheme", significantly improved Claude's precision on retrieval tasks by reducing hallucinations. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [R] Truncated responses should steer the agent: encourage "many small and targeted searches instead of a single broad search". Errors should communicate "specific and actionable improvements, rather than opaque error codes or tracebacks". Parameter names should be unambiguous (`user_id`, not `user`). — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [R] "Even small refinements to tool descriptions can yield dramatic improvements." Claude Sonnet 3.5 reached state of the art on SWE-bench Verified after precise refinements to tool descriptions. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [R] Evaluation method: realistic multi-step tasks, a held-out test set, and tracking of runtime, number of tool calls, token consumption and tool errors. On held-out sets, Claude-optimized Slack and Asana tools beat the human-written versions. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents); the companion notebook exists at [claude-cookbooks/tool_evaluation](https://github.com/anthropics/claude-cookbooks/blob/main/tool_evaluation/tool_evaluation.ipynb) [V]

**"Effective context engineering for AI agents" (Sep 29 2025)**
- [R] Context rot: as the token count grows, recall accuracy falls. Attention over n tokens forms n² pairwise relationships, which gives the model a finite "attention budget". The goal is "the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome". Anthropic's cookbook restates the same framing [V]. — [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents); [cookbook](https://github.com/anthropics/claude-cookbooks/blob/main/tool_use/context_engineering/context_engineering_tools.ipynb)
- [R] On tools: "One of the most common failure modes we see is bloated tool sets that cover too much functionality or lead to ambiguous decision points about which tool to use. If a human engineer can't definitively say which tool should be used in a given situation, an AI agent can't be expected to do better." Curate a "minimal viable set of tools". — [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [R] Just-in-time retrieval: agents keep lightweight identifiers (file paths, stored queries, links) and load data through tools at runtime. Claude Code is a hybrid: CLAUDE.md goes into context up front, while glob and grep retrieve just in time, "effectively bypassing the issues of stale indexing and complicated syntax trees". — [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [R] Tool-result clearing is "one of the safest, lightest touch forms of compaction". Sub-agents return a "condensed, distilled summary" of their work, often 1,000–2,000 tokens. For few-shot, use diverse canonical examples rather than laundry lists of edge cases. — [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [V] Anthropic API context-editing defaults, from the official cookbook:
  - `clear_tool_uses_20250919`: `trigger` defaults to 100K tokens and `keep` to the 3 most recent tool uses, with `exclude_tools` and `clear_tool_inputs` options.
  - Compaction `compact_20260112`: trigger defaults to 150K (minimum 50K).
  - "clearing invalidates cached prompt prefixes".
  - "Clearing is lossless as long as the tool is re-callable".
  - Reading ~320K tokens of documents is "significantly into the range where model performance decays from context rot".
  — [anthropics/claude-cookbooks context_engineering_tools.ipynb](https://github.com/anthropics/claude-cookbooks/blob/main/tool_use/context_engineering/context_engineering_tools.ipynb)

**"Code execution with MCP" (Nov 4 2025)**
- [R] Two problems: tool definitions overload the context, and intermediate results flow through the model. A 2-hour meeting transcript, for example, costs ~50K extra tokens. Presenting MCP servers as code APIs on a filesystem, plus a `search_tools` tool with a detail-level parameter, cut one example from ~150,000 to ~2,000 tokens (98.7%). — [Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [V] The official MCP client best-practices page (2026-07-28 docs) uses the same illustration ("~150,000 tokens on definitions alone" vs "~2,000 tokens"). It recommends offering "multiple detail levels (name-only, name-and-description, or full-schema)". Its programmatic-tool-calling figure contrasts "~100K+ tokens" of direct calling with a "~200-token script" returning a "~15-token summary". — [MCP client best practices source](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/develop/clients/client-best-practices.mdx)

**"Introducing advanced tool use on the Claude Developer Platform" (Nov 24 2025)**
- [R] Scale of the definition problem: 58 tools across 5 servers take ~55K tokens, and Anthropic saw definitions reach 134K tokens before optimization.
- [R] Tool Search Tool: ~85% fewer tokens. MCP-eval accuracy went from 49%→74% on Opus 4 and 79.5%→88.1% on Opus 4.5. Use it when definitions exceed ~10K tokens, with 10+ tools, or when selection is a problem, and keep the 3–5 most-used tools always loaded. — [Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)
- [R] Programmatic Tool Calling: average tokens fell from 43,588 to 27,297 (−37%) on complex research tasks. Knowledge retrieval improved 25.6→28.5% and GIA 46.5→51.2%. — [Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)
- [R] Tool Use Examples (the `input_examples` field): 72%→90% accuracy on complex parameter handling. — [Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)
- [V] Tool search appends discovered schemas instead of swapping them, which "preserves the prompt cache". At least one tool must be non-deferred, otherwise the API returns 400. — Anthropic claude-api skill reference bundled with Claude Code 2.1.280, `shared/agent-design.md` and `SKILL.md` ([local copy](file:///tmp/claude-0/bundled-skills/2.1.280/b082d86fd4dccac5e9436bb07e998cbb/claude-api/shared/agent-design.md); public equivalent: [tool search docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool))

**"Building effective agents" (Dec 19 2024), Appendix 2 "Prompt engineering your tools"**
- [R] For the SWE-bench agent, "we actually spent more time optimizing our tools than the overall prompt".
- [R] Poka-yoke example: the model made mistakes with relative paths after changing directory. Requiring absolute paths fixed it, and the model then "used this method flawlessly".
- [R] Format advice: keep formats close to text found naturally on the internet, and avoid formatting overhead such as counting lines for diff headers or string-escaping code inside JSON. Invest as much in the agent-computer interface (ACI) as in the human-computer interface. — [Anthropic](https://www.anthropic.com/engineering/building-effective-agents)

**Anthropic's 2026 tool-description guidance (claude-api skill bundled with Claude Code 2.1.280)**
- [V] "The rubric for tool descriptions is precision and contract accuracy, not brevity… Detailed descriptions are by far the most important factor in tool performance, and the most common failure is *under*-description." The minimum is "3-4+ sentences", and "a contract/behavior mismatch sends the model down paths no prompt text can fix". A description is "a man page": what the tool does, when to use it and when not to, parameters, caveats, and "what it does not return". — [prompt-audit.md (bundled)](file:///tmp/claude-0/bundled-skills/2.1.280/b082d86fd4dccac5e9436bb07e998cbb/claude-api/shared/prompt-audit.md)
- [V] Replace "`CRITICAL: You MUST use this tool when...`" with a plain "`Use this tool when...`": "triggering boosters written against under-triggering models now cause over-triggering".
- [V] Move worked examples, fake dialogue and embedded protocols out of descriptions "in any quantity, even ones that 'measurably lift the call rate'". Reason: "Examples constrain the exploration space and cost tokens on every request". They belong in skills or progressive disclosure, and "well-named enums carry intent".
- [V] Don't name tools in the system prompt.
- [V] Structural smells: "Near-duplicate overlapping tools; bloated response payloads; full catalogs of 30+ always-loaded tools". The fix is "Fewer, clearly bounded tools with explicit boundaries in both descriptions; high-signal responses; past a few dozen tools use tool search / deferred loading". — [prompt-audit.md (bundled)](file:///tmp/claude-0/bundled-skills/2.1.280/b082d86fd4dccac5e9436bb07e998cbb/claude-api/shared/prompt-audit.md)
- [V] "Be **prescriptive about *when* to call it**… On recent Opus models, which reach for tools more conservatively, trigger conditions in the description give measurable lift in should-call rate." — [tool-use-concepts.md (bundled)](file:///tmp/claude-0/bundled-skills/2.1.280/b082d86fd4dccac5e9436bb07e998cbb/claude-api/shared/tool-use-concepts.md)
- [V] Promote an action to a dedicated tool for gating, for **staleness checks** ("A dedicated `edit` tool can reject writes if the file changed since Claude last read it"), for rendering, or for scheduling ("Read-only tools like `glob` and `grep` can be marked parallel-safe"). On failure, return `is_error: true` with an informative message. — [agent-design.md (bundled)](file:///tmp/claude-0/bundled-skills/2.1.280/b082d86fd4dccac5e9436bb07e998cbb/claude-api/shared/agent-design.md)

**Agent Skills and progressive disclosure (Oct 2025 onward)**
- [V] Skills load at three levels: "Metadata (name + description) — Always in context (~100 words)"; "SKILL.md body — In context whenever skill triggers (<500 lines ideal)"; "Bundled resources — As needed". Reference files over 300 lines should get a table of contents. "Claude has a tendency to 'undertrigger' skills", so make descriptions "a little bit 'pushy'". — [anthropics/skills skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md); [Anthropic, Agent Skills post](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) [R]

### Inferences
- **Consolidate the 16 tools into about 5–7 workflow-shaped tools**, following Anthropic's "minimal viable set" and "no ambiguous decision points" rules. The current surface has clear overlap clusters:
  - Read chunk/symbol: `get_chunk`, `get_chunk_summary`, `explain_symbol`, `resolve_symbol`.
  - Graph neighborhood: `get_call_graph`, `find_references`, `get_subgraph`, `tests_for`, `impact_of_edit`.
  - Taint: `trace_taint`, `find_tainted_sinks`.
  - Overview: `get_file_skeleton`, `get_repo_map`.

  One possible target, as a single-server namespace:
  - `search` for code/semantic/route search.
  - `symbol` to resolve, define and explain, with a `detail` enum.
  - `relations` with `direction: callers|callees|references|tests|routes` and depth/limit.
  - `impact` for edit/diff impact.
  - `outline` for a file skeleton, or a repo map with a token budget.
  - `taint` with `mode: trace|sinks`.
  - `index_status` for freshness and stats, with a reindex action.
- **Give every read tool a `detail`/`response_format` enum defaulting to concise, plus a `limit`/cursor.** Aim for a concise default of roughly 0.5–2K tokens. Detailed output should stay under about 8K tokens: Codex truncates at 10K tokens and Claude Code warns at 10K (see Q2). These budgets are my inference; no study fixes an exact number.
- **Use human-readable, stable, round-trippable identifiers** such as `src/auth/login.py::LoginService.authenticate` or `src/auth/login.py:120-148`, instead of opaque chunk hashes. Accept any of these forms as input (poka-yoke) and echo the canonical one.
- **Error and empty results should steer.** For example: not found → "did you mean X/Y (fuzzy matches)"; too many → "N matches in M files; narrow with path=/kind=".
- **Rewrite descriptions as contracts of 3–6 sentences** stating when to use the tool, when to use grep/Read instead, what it does not return, and what it costs. Remove MUST/CRITICAL boosters. Move the long prompt-file content into a skill (see Q7).

### Gaps
- anthropic.com could not be re-fetched in this sandbox, so every [R] figure above (25,000-token default, 206/72 tokens, 49→74%, 79.5→88.1%, 72→90%, 98.7%, 37%) needs a final check against the live pages.
- I found no Anthropic publication with measurements specific to code-navigation tools (symbol lookup, call graphs). All the numbers come from generic MCP, Slack/Asana or SWE-bench setups.

---

## 2. MCP specification features, client support, and client limits

### Takeaway
The spec now has what a code-intelligence server needs:
- `structuredContent`/`outputSchema` (2025-06-18).
- `resource_link` (2025-06-18).
- Read-only/open-world annotations (2025-03-26).
- Tool-name rules (2025-11-25).
- "Validation errors are tool errors, so the model self-corrects" (2025-11-25).
- A stateless core, as of **2026-07-28**: no `initialize`; `server/discover` carries `instructions`; explicit handles replace sessions; deterministic tool order; TTL caching. Roots, Sampling and Logging are deprecated, and tasks moved to an extension.

Client behavior diverges in ways that matter:
- Claude Code caps each tool description and the server instructions at **2,048 chars**, auto-defers MCP tools above 10% of the context window, and writes oversized results to disk.
- Codex truncates tool output at **10K tokens** and **shows `structuredContent` instead of the text content** whenever both are present.
- VS Code allows at most **128 tools per request** and auto-approves `readOnlyHint` tools.
- Gemini CLI truncates prefixed names longer than 63 chars.
- Cursor's current limits could not be verified.

### Cited Findings

**Spec evolution [V]** — [changelogs in the spec repo](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/docs/specification)
- **2025-03-26** added tool annotations ("whether it is read-only or destructive"), audio content, the `completions` capability, the `message` field on `ProgressNotification`, and Streamable HTTP. — [2025-03-26 changelog](https://modelcontextprotocol.io/specification/2025-03-26/changelog)
- **2025-06-18** added structured tool output (PR #371), elicitation, **resource links in tool results** (PR #603), and a `title` field so that `name` serves as the programmatic ID. It also added `_meta` on more types and removed JSON-RPC batching. — [2025-06-18 changelog](https://modelcontextprotocol.io/specification/2025-06-18/changelog)
- **2025-11-25** added:
  - Tool-name guidance (SEP-986).
  - Icons.
  - URL-mode elicitation.
  - Sampling with tools.
  - Experimental **tasks** (SEP-1686).
  - JSON Schema 2020-12 as the default dialect.
  - An `Implementation.description` field.
  - "input validation errors should be returned as Tool Execution Errors rather than Protocol Errors to enable model self-correction (SEP-1303)".

  — [2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)
- **2026-07-28** (GA 2026-07-28; RC announced 2026-05-21):
  - MCP is stateless. The `initialize` handshake is removed, and every request carries its version and capabilities in `_meta`.
  - New **`server/discover`** RPC (servers MUST implement it).
  - Protocol sessions and `Mcp-Session-Id` are removed. "Servers that need cross-call state use explicit, server-minted handles passed as ordinary tool arguments".
  - `subscriptions/listen` replaces `resources/subscribe`. `notifications/progress` still flows on the request's own response stream.
  - Tasks moved to the extension `io.modelcontextprotocol/tasks`.
  - Multi Round-Trip Requests (`InputRequiredResult`) replace server-initiated elicitation, sampling and `roots/list`.
  - "Servers **SHOULD** return tools from `tools/list` in a deterministic order to enable client-side caching and improve LLM prompt cache hit rates".
  - List results carry `ttlMs` and `cacheScope`.
  - `inputSchema`/`outputSchema` allow any JSON Schema 2020-12, and `structuredContent` may be any JSON value.
  - **Roots, Sampling and Logging are deprecated.** For Roots, the migration is to "pass directories or files via tool parameters, resource URIs, or server configuration". The deprecation window is at least 12 months.

  — [2026-07-28 changelog source](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx); [RC post](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-05-21-mcp-2026-07-28-rc.md)

**Tools spec details (2026-07-28 text) [V]** — [tools.mdx](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx)
- Tool names **SHOULD** be 1–128 chars and case-sensitive, using only `A–Z a–z 0–9 _ - .`, with no spaces, and unique within a server. Aggregating clients "SHOULD implement a disambiguation strategy such as prefixing tool names with a server identifier".
- With `outputSchema`, "Servers **MUST** provide structured results that conform to this schema". "For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block."
- A tool **MAY** return `resource_link` items. These "are not guaranteed to appear in the results of a `resources/list` request". All content types support annotations (audience, priority, modification time).
- Errors come in two kinds: protocol errors, and **tool execution errors** (`isError: true`), which carry "actionable feedback that language models can use to self-correct". "Clients **SHOULD** provide tool execution errors to language models."
- Stateful tools (non-normative guidance):
  - Handles should be **opaque**.
  - A handle's lifetime should be stated "in the creation tool's description".
  - Unauthenticated servers should use high-entropy handles (e.g. UUIDv4) with a bounded lifetime.
  - An expired handle should produce a tool execution error "so the model can recover".
- Annotations (2025-11-25 schema) [V]:
  - Defaults: `readOnlyHint` false, `destructiveHint` true, `idempotentHint` false, `openWorldHint` true.
  - `destructiveHint` and `idempotentHint` apply only when `readOnlyHint == false`.
  - Hints are untrusted unless the server is trusted.
  - `Tool.execution.taskSupport` takes forbidden (the default), optional or required.

  — [schema 2025-11-25](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-11-25/schema.ts)
- MCP blog (2026-03-16), "Tool Annotations as Risk Vocabulary":
  - Server authors should "set `readOnlyHint: true` on read-only tools… and `openWorldHint: false` on closed-domain tools".
  - "no MCP client lets users filter tools by annotation values, and none surface annotations as context in approval prompts".
  - GitHub's read-only mode is "enabled by about 17% of users".
  - Five SEPs propose new annotations (trust/sensitivity, `unsafeOutputHint`, `secretHint`, etc.).

  — [blog post](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) ([source](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-03-16-tool-annotations.md))
- [R] Pagination in the spec is cursor-based and applies to **list operations** (`tools/list`, `resources/list`, `prompts/list`, templates), not to tool results. Tool-level paging has to be designed into tool parameters. — [pagination](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination)

**Official MCP client best practices (2026-07-28 docs) [V]** — [source](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/develop/clients/client-best-practices.mdx)
- Switch to progressive discovery when definitions take a significant share of the context. "Implement a threshold as a percentage of the context window. For example, 1%-5%."
- Guidelines: offer multiple detail levels, cache definitions, refresh on `list_changed`, and group tools by server.
- "Adding or removing tool definitions mid-conversation invalidates that cache, and the resulting miss can cost more tokens than the definitions you removed." Append new tools after the cache breakpoint, or route all calls through one stable `call_tool({name, args})` meta-tool.

**Skills over MCP (SEP-2640, Status Final, created 2026-04-23) [V]** — [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md)
- Each skill file is exposed as a resource under `skill://<skill-path>/<file-path>`, with `skills/list`, `skills/get` and an optional `resources/directory/read`. The skill format and progressive disclosure are delegated to the Agent Skills spec.
- Motivation: server instructions "are practically bounded in size", and complex workflows (e.g. an 875-line skill) do not fit.
- Client matrix: ChatGPT **Partial**, fast-agent **Partial**, MCP Inspector **Partial**. No check mark for Claude, VS Code or Cursor. — [client-matrix](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/extensions/client-matrix.mdx)
- The working group's notes (June 2026) say Claude Code "does not discover or load MCP-served `skill://` resources as skills, and its MCP resource support is user-`@`-mention attachments, not model-driven `resources/read`". — [ext-skills experimental findings](https://github.com/modelcontextprotocol/ext-skills/blob/main/docs/archive/experimental-findings.md)

**Claude Code (CHANGELOG, current v2.1.280) [V unless marked]** — [anthropics/claude-code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Feature support by version:
  - 1.0.44: `resource_link` results; tool annotations and titles shown in `/mcp`.
  - 1.0.52: server instructions.
  - 2.0.21: `structuredContent`.
  - 2.1.0: `list_changed`.
  - 2.1.76: elicitation, as a form or browser URL.
  - Resources can be @-mentioned (user-driven).
- **Description/instructions cap.** v2.1.84: "MCP tool descriptions and server instructions are now capped at 2KB to prevent OpenAPI-generated servers from bloating context." v2.1.280 adds `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` to change "the 2,048-character cap".
- **Output handling:**
  - v2.1.2: "large tool outputs … persisted to disk instead of truncated, providing full output access via file references".
  - v2.1.51: "Tool results larger than 50K characters are now persisted to disk (previously 100K)".
  - v2.1.91: `_meta["anthropic/maxResultSizeChars"]` override "(up to 500K)"; v2.1.98 fixed it so the override bypasses the "token-based persist layer".
  - v2.1.105: the "MCP large-output truncation prompt [gives] format-specific recipes (e.g. `jq` for JSON, computed Read chunk sizes for text)".
- [R] Documented default: `MAX_MCP_OUTPUT_TOKENS` = 25,000 tokens, with a warning when an MCP output exceeds 10,000 tokens (code.claude.com/docs/en/mcp, not reachable from here). Consistent with Anthropic's "25,000 tokens by default" statement.
- **Tool search:**
  - v2.1.7: "When MCP tool descriptions exceed 10% of the context window, they are automatically deferred and discovered via the MCPSearch tool".
  - v2.1.9: `auto:N` threshold.
  - v2.1.267: mid-session MCP tools arrive "as deferred definitions" to protect prompt-cache reuse.
  - Observed in this very session: deferred MCP tools are announced to the model **by name only** until loaded, e.g. `mcp__github__search_code`.
- **Read tool:** v2.1.86 "uses compact line-number format and deduplicates unchanged re-reads". v2.1.145 returns "a truncated first page with a 'PARTIAL view' notice" instead of an error.
- Timeouts: `MCP_TIMEOUT` for startup and `MCP_TOOL_TIMEOUT` per tool. HTTP tool calls were previously capped at 60 s regardless of setting (since fixed).

**VS Code / GitHub Copilot [V]**
- Supported: tools, prompts (as `/<server>.<prompt>`), resources (the user attaches them via Add Context > MCP Resources), elicitation, sampling, OAuth, **server instructions**, roots, and MCP Apps. — [VS Code MCP extension guide](https://github.com/microsoft/vscode-docs/blob/main/api/extension-guides/ai/mcp.md); [mcp-servers.md](https://github.com/microsoft/vscode-docs/blob/main/docs/agent-customization/mcp-servers.md)
- "A chat request can have a maximum of 128 tools enabled at a time". The fix is to deselect tools or enable virtual tools with `github.copilot.chat.virtualTools.threshold`. — [tools.md](https://github.com/microsoft/vscode-docs/blob/main/docs/agents/run/tools.md)
- "The confirmation dialog will be shown for all tools that are not marked with the `readOnlyHint` annotation."
- Naming advice: tool names in snake_case as `{verb}_{noun}`; parameters in camelCase. — [VS Code MCP guide](https://github.com/microsoft/vscode-docs/blob/main/api/extension-guides/ai/mcp.md)
- [R] GitHub reduced Copilot's default built-in toolset from 40 to 13 core tools and added embedding-guided tool routing and "virtual tools". It reported a 2–5 point gain on SWE-Lancer and SWE-bench Verified and ~400 ms lower latency (GitHub Blog, Nov 2025). — [GitHub Blog](https://github.blog/ai-and-ml/github-copilot/how-were-making-github-copilot-smarter-with-fewer-tools/) (URL and figures not re-verified)

**OpenAI Codex CLI (openai/codex source, main branch, Sept 2026) [V]**
- MCP tools are exposed as `{namespace}__{name}` (`MCP_TOOL_NAME_DELIMITER = "__"`). — [handlers/mcp.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/mcp.rs)
- Tool-output truncation: every model in `models.json` sets `truncation_policy: {mode: tokens, limit: 10000}`. The fallback is 10,000 bytes, and `tool_output_token_limit` is configurable. MCP outputs are subject to the policy, as a test covering large `structuredContent` shows. — [models.json](https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json); [context_tests.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/context_tests.rs)
- **The model sees `structuredContent` when it is present.** The test `prefers_structured_content_when_present` says "Content present but should be ignored because structured_content is set". Codex falls back to `content` only when `structuredContent` is null. — [session/tests.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/tests.rs)
- The model has built-in list/read MCP-resource tools (`tools/handlers/mcp_resource.rs`). AGENTS.md is capped at **32 KiB** (`DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024`). — [config_toml.rs](https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs)

**Gemini CLI [V]** — [docs/tools/mcp-server.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)
- Naming:
  - Fully qualified names take the form `mcp_{serverName}_{toolName}`.
  - Characters outside `[A-Za-z0-9_.:-]` are replaced with underscores.
  - Names "longer than 63 characters are truncated with middle replacement (`...`)".
  - "Do not use underscores (`_`) in your MCP server names", because the parser splits on the first underscore.
- Configuration: `includeTools`/`excludeTools` filters; default timeout 600,000 ms.
- Features:
  - Resources can be referenced as `@server://…`.
  - Prompts become slash commands.
  - Server instructions "will be appended to the system instructions".
  - Supported result content types: text, image, audio, `resource`, `resource_link`.
  - Results split into `llmContent` (sent to the model) and `returnDisplay` (shown to the user).

**Cursor and OpenAI API**
- [R, low confidence] Cursor's 2025 docs stated a cap of about 40 MCP tools. Current (2026) status is unverified.
- [V] The client matrix lists Cursor as supporting MCP Apps. — [client-matrix](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/extensions/client-matrix.mdx)
- [V2] "OpenAI does not allow more than 128 tools in a single chat completion request, and recommends at most 20 tools". Microsoft's MCP Interviewer also checks function-name length (≤64 chars) and pattern (`a-zA-Z0-9_-`). — [microsoft/mcp-interviewer](https://github.com/microsoft/mcp-interviewer)

### Inferences
- **Names.** Pick a short server ID with no underscores (Gemini) and snake_case `[a-z0-9_]` tool names, keeping the fully prefixed name at or below ~40–50 characters. Claude Code produces `mcp__<server>__<tool>`, Codex `<server>__<tool>`, Gemini `mcp_<server>_<tool>` (63-char limit). Avoid dots even though MCP allows them, because OpenAI's function-name pattern forbids `.`.
- **Keep each tool description and the server instructions under 2,048 characters.** Claude Code silently caps both, and the graph-indexer's long guidance will be truncated there today.
- **Decide deliberately between text and structured output.** Codex shows `structuredContent` to the model, so the compact text rendering will not reach Codex models if `structuredContent` is also returned. Two options: (a) make text the default and omit `structuredContent`/`outputSchema` on model-facing tools, or add them only under a `format:"json"` option for code-mode/PTC callers; or (b) make `structuredContent` itself compact (short keys, no nulls, no redundant metadata).
- **Set `readOnlyHint: true` and `openWorldHint: false` on every indexing and query tool.** VS Code then skips confirmation, and policy engines can treat the server as closed-world.
- **Keep the tool list static and in deterministic order**, to protect clients' prompt caches. Avoid `list_changed` churn.
- **Page with opaque handles or cursors in tool arguments**, as the 2026-07-28 stateless model expects. Report expiry as a tool execution error that says how to recover.
- **Accept the repository path or ID as a tool parameter or in server config**, not via Roots (deprecated).
- **Don't rely on `resource_link` alone for critical content.** Model-driven resource reads differ by client: Codex has read tools, while Claude Code resources are documented as @-mention only in the working-group notes. Return the essential snippet inline and make the link an optional extra.
- MCP prompts are user-invoked slash commands in VS Code and Gemini, so they suit packaged workflows (e.g. "/security-review"), not automatic guidance.

### Gaps
- Could not verify Cursor's current tool cap or its support for instructions, resources, `structuredContent` and annotations.
- Could not verify Claude Code's exact `MAX_MCP_OUTPUT_TOKENS` default and 10K warning in its docs during this session.
- Unknown how Claude Code shows `content` vs `structuredContent` to the model when both are present.
- Unknown whether Codex injects server instructions. A source grep was inconclusive.
- Conflicting evidence on whether Claude Code has model-driven MCP resource-reading tools: the working-group notes say @-mention only, and I recall built-in resource tools.

---

## 3. Tool-count and tool-selection degradation research

### Takeaway
Selection accuracy falls as the tool catalog grows, and retrieving or deferring tool schemas restores much of it: RAG-MCP 13.62%→43.13% [R], Anthropic tool search 49→74% [R], MCP-Zero −98% tokens [R]. On realistic multi-server MCP benchmarks, frontier models still succeed on well under half of tasks (MCP-Universe: GPT-5 at 43.72% [R]), and the quality of tool descriptions measurably shifts outcomes [R]. For a single 16-tool server, the raw count sits under every hard cap (20 recommended by OpenAI, 128 in VS Code and OpenAI). The measurable risks are **overlap and ambiguity between tools**, plus the tokens their definitions and outputs consume.

### Cited Findings
- [R] **RAG-MCP** (Gan & Sun, May 2025): retrieving only the relevant MCP tool descriptions before prompting cut prompt tokens by more than 50% and raised tool-selection accuracy to 43.13%, from a 13.62% baseline. An "MCP stress test" showed accuracy falling as the candidate pool grows. — [arXiv 2505.03275](https://arxiv.org/abs/2505.03275)
- [R] **MCP-Zero** (Fei et al., Jun 2025): the agent requests tools itself instead of receiving every schema. Token use fell 98% on APIBank while accuracy stayed high. [V] It introduces the MCP-tools dataset: "308 servers and 2,797 tools". — [arXiv 2506.01056](https://arxiv.org/abs/2506.01056); [repo](https://github.com/xfey/MCP-Zero)
- [R] **LiveMCPBench** (Aug 2025): 95 tasks over LiveMCPTool (70 servers, 527 tools). The best model, Claude Sonnet 4, reached ~78.95% success, with large variance across models. — [arXiv 2508.01780](https://arxiv.org/abs/2508.01780); [repo](https://github.com/icip-cas/LiveMCPBench) [V exists]
- [R] **MCP-Universe** (Salesforce, Aug 2025): real MCP servers across six domains. Success rates: GPT-5 43.72%, Grok-4 33.33%, Claude-4.0-Sonnet 29.44%. The paper names a "long-context" challenge (tokens pile up across steps) and an "unknown-tools" challenge. [V] The same repo's "MCP+" wrapper claims "50-75% token savings on tool outputs" by post-filtering outputs (vendor claim). — [arXiv 2508.14704](https://arxiv.org/abs/2508.14704); [repo README](https://github.com/SalesforceAIResearch/MCP-Universe)
- **MCP-Bench** (Accenture, Aug 2025) [V]: "28 diverse MCP servers" and a leaderboard of overall scores, e.g. qwen3-235b-a22b-2507 0.678, qwen3-30b 0.627, mistral-small-2503 0.530, llama-3.1-8b 0.428. The overall score averages schema understanding, task completion judged by o4-mini, tool usage and planning. [R] 250 tools; models struggle with fuzzy instructions that don't name tools. — [repo](https://github.com/Accenture/mcp-bench); [arXiv 2508.20453](https://arxiv.org/abs/2508.20453)
- **MCPToolBench++** [V]: "over 4k+ MCP Servers from more than 45 categories". In its browser subset, 32 tools average **107.44 tokens per tool**, 3.4K tokens in total. — [repo](https://github.com/mcp-tool-bench/MCPToolBenchPP)
- [R] **MCPGAUGE, "Help or Hurdle? Rethinking MCP-Augmented LLMs"** (Aug 2025): MCP integration *lowered* accuracy by ~9.5% on average. It raised input tokens between 3.25× and 236.5×. Models showed low proactivity in calling tools without explicit instruction. — [arXiv 2508.12566](https://arxiv.org/abs/2508.12566)
- [R, medium confidence] **"MCP Tool Descriptions Are Smelly!"** (Hasan et al., Feb 2026):
  - About 97% of 856 tools across 103 servers had at least one description smell.
  - Augmented descriptions raised task success by a median of ~5.85 points.
  - The cost was ~67% more execution steps, and performance regressed in ~17% of cases.

  — [arXiv 2602.14878](https://arxiv.org/abs/2602.14878) (ID not re-verified)
- [R] **"Less is More"** (Paramanayakam et al., DATE 2025): dynamically cutting the set of available tools improved function-calling success and reduced execution time by up to ~70% on edge devices. — [arXiv 2411.15399](https://arxiv.org/abs/2411.15399)
- [V2] OpenAI allows at most 128 tools per request and recommends at most 20. — [microsoft/mcp-interviewer](https://github.com/microsoft/mcp-interviewer). [V] VS Code also caps requests at 128 tools. — [vscode-docs](https://github.com/microsoft/vscode-docs/blob/main/docs/agents/run/tools.md)
- [V] BFCL tests selection among multiple functions and abstention: `multiple`, `live_multiple`, `irrelevance`, `live_irrelevance`. V4 adds `format_sensitivity` (sensitivity to system-prompt formats) plus agentic web-search and memory categories. — [BFCL README / TEST_CATEGORIES](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard)
- [V] The GitHub MCP server:
  - Exposes `--toolsets` so users can enable only what they need, which the README says helps the LLM with tool choice.
  - Defaults a repository tool's `minimal_output` to true.
  - Ships an Insiders **CSV output mode** for `list_*` tools, "intended to reduce response context for agents".
  - Its live server instructions, observed in this session, say "Use pagination whenever possible with batches of 5-10 items" and "Use minimal_output … if the full information is not needed".

  — [github-mcp-server README](https://github.com/github/github-mcp-server); [insiders-features.md](https://github.com/github/github-mcp-server/blob/main/docs/insiders-features.md)
- [V] Anthropic's 2026 guidance: "past a few dozen tools use tool search / deferred loading". MCP's client guidance: focusing on a few relevant tools "can improve tool selection accuracy". — [prompt-audit.md (bundled)](file:///tmp/claude-0/bundled-skills/2.1.280/b082d86fd4dccac5e9436bb07e998cbb/claude-api/shared/prompt-audit.md); [MCP client best practices](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/develop/clients/client-best-practices.mdx)

### Inferences
- 16 tools is not a hard-cap problem. But groups such as `find_references`/`get_call_graph`/`get_subgraph`/`impact_of_edit`/`tests_for` and `get_chunk`/`get_chunk_summary`/`explain_symbol` create exactly the "ambiguous decision points" Anthropic warns about. Consolidating to about 5–7 tools with explicit boundaries ("use X for…, not for…") should matter more than the count itself.
- Graph-indexer sits alongside built-in tools (Read/Grep/Bash) and other servers such as GitHub's, so its definitions add to the user's total. Tight definitions keep it under Claude Code's 10% auto-defer threshold. If it is deferred anyway, the model initially sees names only, so names must be self-explanatory and descriptions keyword-rich.
- Build a held-out tool-use eval measuring selection accuracy, number of calls, tokens and success, and A/B each description rewrite, as Anthropic and the "smelly descriptions" study both do. Richer descriptions can raise step counts as well as success rates.

### Gaps
- Found no benchmark that isolates code-intelligence MCP tools (symbol graph vs grep) with controlled tool counts. The numbers above come from general MCP tasks.
- The primary papers could not be re-fetched, so the [R] figures need confirmation.

---

## 4. Long-context degradation → how much code to return per call, and in what order

### Takeaway
Measured effective context sits far below advertised windows:
- NoLiMa: GPT-4.1 is effective to only ~16K of a claimed 1M; Claude 3.5 Sonnet to ~4K of 200K.
- RULER: only half of the models tested hold up at 32K.
- Chroma Context Rot sample data: GPT-4.1 scores 87.3% on focused (~270-token) LongMemEval prompts versus 62.4% on the full ~113K-token prompts.

Tool outputs should therefore be **small, ranked (best first), de-duplicated and pointer-rich**, returning a window of code (SWE-agent: 100 lines is best) and file or symbol lists rather than whole files or long match dumps.

### Cited Findings
- [V] **NoLiMa** (ICML 2025) "effective length" is the longest context where a model keeps ≥85% of its short-context base score:

  | Model | Claimed | Effective | Base score | Score at 32K | Score at 128K |
  |---|---|---|---|---|---|
  | GPT-4.1 | 1M | 16K | 97.0 | 79.8 | 64.7 |
  | GPT-4o | 128K | 8K | 99.3 | 69.7 | 56.0 |
  | Claude 3.5 Sonnet | 200K | 4K | 87.6 | 29.8 | — |
  | Gemini 2.5 Flash (no thinking) | 1M | 2K | — | — | — |
  | Llama 4 Scout | 10M | 1K | — | — | — |

  On NoLiMa-Hard, even reasoning models degrade: o3 falls from 100 to 58.5 and Gemini 2.5 Pro from 99.1 to 58.6 at 32K. — [adobe-research/NoLiMa](https://github.com/adobe-research/NoLiMa)
- [V] **RULER**: "While all models claim context size of 32k tokens or greater, only half of them can effectively handle sequence length of 32K", measured against Llama-2-7B's 85.6% at 4K. "Almost all models fall below the threshold before reaching the claimed context lengths". GPT-4-1106 claims 128K and is effective to 64K; Qwen2-72B claims 128K and is effective to 32K. — [NVIDIA/RULER](https://github.com/NVIDIA/RULER)
- [V] **Chroma "Context Rot"** (Hong, Troynikov, Huber, July 2025) compares LongMemEval "Focused input, containing only the relevant parts" with "Full input … 113k token". From the published GPT-4.1 result files, **I computed** (n=306, LLM-judged): **87.3% accuracy on focused prompts (mean 269 tokens) vs 62.4% on full prompts (mean 112,673 tokens)**. — [chroma-core/context-rot](https://github.com/chroma-core/context-rot) (results/gpt_4_1_longmemeval_*_evaluated.csv); [report](https://research.trychroma.com/context-rot)
- [R] Other Context Rot findings, across 18 models:
  - Performance drops with input length even on simple tasks.
  - Lower needle–question similarity makes the drop faster.
  - Distractors hurt non-uniformly, and more at longer lengths.
  - Models did *better* on shuffled haystacks than on coherent ones.
  - Claude models tended to abstain when unsure, while GPT models hallucinated more.

  — [Chroma report](https://research.trychroma.com/context-rot)
- [R] **Lost in the Middle** (Liu et al., TACL 2024): accuracy follows a U-shape, highest when the relevant document comes first or last and significantly lower in the middle. For GPT-3.5-Turbo with 20 documents, mid-context accuracy fell below its closed-book accuracy (~56%). — [arXiv 2307.03172](https://arxiv.org/abs/2307.03172)
- [R, medium confidence] **LongCodeBench** (2025): long-context coding QA and bug fixing up to 1M tokens, with steep drops as context grows (e.g. Claude 3.5 Sonnet from ~29% to ~3%). [V] The repo builds "a tunable version of SWE-bench … in which each problem statement is repeated with a varying number of context files". — [arXiv 2505.07897](https://arxiv.org/abs/2505.07897); [repo](https://github.com/Zteefano/long-code-bench)
- [V] **SWE-agent ACI**:
  - "this file viewer works best when displaying just 100 lines in each turn."
  - For search, "it was important for this tool to succinctly list the matches — we simply list each file that had at least one match. Showing the model more context about each match proved to be too confusing for the model."
  - Empty outputs return "Your command ran successfully and did not produce any output."
  - Today's `search_dir` refuses more than 100 matching files with "Please narrow your search."

  — [SWE-agent docs/background/aci.md](https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md); [tools/search/bin/search_dir](https://github.com/SWE-agent/SWE-agent/blob/main/tools/search/bin/search_dir)
- [R] SWE-agent paper ablations (GPT-4 Turbo, SWE-bench Lite; the default setup resolves 18.0%):

  | Component | Variant | Resolved |
  |---|---|---|
  | Search | summarized (default) | 18.0% |
  | Search | iterative | 12.0% |
  | Search | none | 15.7% |
  | File viewer | 30 lines | 14.3% |
  | File viewer | 100 lines (default) | 18.0% |
  | File viewer | full file | 12.7% |
  | Editing | no edit command | 10.3% |
  | Editing | no linting | 15.0% |
  | History | last 5 observations (default) | 18.0% |
  | History | full history | 15.0% |

  — [arXiv 2405.15793](https://arxiv.org/abs/2405.15793)
- [V] Aider's repo map defaults to a **1,024-token budget** (`map_tokens=1024`). It is multiplied by 8 when no files are in the chat (`map_mul_no_files=8`) and uses "a PageRank based algorithm for prioritizing which files and identifiers to include". — [aider repomap.py / HISTORY](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)
- [V] In Anthropic's cookbook, reading ~320K tokens of documents lands "significantly into the range where model performance decays from context rot". Context clearing exists to drop "stale re-fetchable data". — [cookbook](https://github.com/anthropics/claude-cookbooks/blob/main/tool_use/context_engineering/context_engineering_tools.ipynb)

### Inferences
- **Per-call budgets** (my inference from NoLiMa, RULER, Context Rot, SWE-agent and aider; these are not established constants):
  - Concise results: about 300–2,000 tokens.
  - Detailed results: at most ~4–8K tokens.
  - Code windows: at most ~100 lines around the target, with the full span available on request.
  - Repo map or skeleton: about 1K tokens by default, grown only when asked.
  - Lists: 10–20 items plus "N more — refine with …".
- **Order**: the best match first (primacy), and a one-line summary or next-step hint last (recency). Never bury the answer in the middle of a long list.
- **Distractors**: near-duplicate chunks (overloads, generated code, vendored copies, test fixtures) are exactly the high-similarity distractors that Context Rot found most harmful. Dedupe and collapse them ("+3 similar in vendor/…").
- **Default to lists, then drill down**: return `path:line symbol` lists, SWE-agent-style, and let the agent pull code by ID. This keeps outputs re-fetchable, so context clearing stays lossless.

### Gaps
- The long-context benchmarks mostly predate Claude 4.x/5.x and GPT-5.x. I found no study of the best snippet size or result count for code-navigation tool outputs with current frontier models.
- LongCodeBench and Lost-in-the-Middle figures are [R].

---

## 5. Output formatting evidence (JSON vs Markdown vs compact text; line numbers; skeletons)

### Takeaway
Across JSON, YAML, XML and TOON, retrieval accuracy is roughly flat, with overlapping confidence intervals and different winners per model. **Token cost differs a lot**: pretty JSON is about 1.5–1.7× compact JSON or TOON. Anthropic advises formats that are close to natural text and match what the model saw in training, and warns against JSON-escaped code. The practical choice is compact, line-oriented text with line-numbered code blocks, and pretty-printed JSON only if a client needs it.

### Cited Findings
- [V] **TOON benchmark** (toon-format/toon, results as of Sept 2026; 244 retrieval questions on 4 models including claude-haiku-4-5, gemini-3.6-flash and gpt-5.4-nano). This is the format author's own benchmark.

  | Format | Accuracy | Avg tokens |
  |---|---|---|
  | TOON | 72.2% ±2.8 | 2,474 |
  | JSON (pretty) | 71.4% ±2.8 | 4,308 |
  | XML | 70.7% ±2.9 | 4,909 |
  | YAML | 70.1% ±2.9 | 3,487 |
  | JSON compact | 69.0% ±2.9 | 2,892 |

  - Compact JSON is **~33% fewer tokens** than pretty JSON, and TOON another ~14% fewer.
  - Per model the winner varies. On gpt-5.4-nano, XML scored 59.4% against TOON's 57.0%.
  - On flat tables, CSV scored 62.2% at 1,851 tokens and pretty JSON 60.3% at 3,950.

  — [TOON retrieval-accuracy results](https://github.com/toon-format/toon/blob/main/benchmarks/results/retrieval-accuracy.md)
- [V2] Anthropic: response structure (XML/JSON/Markdown) affects eval performance, with no one-size-fits-all; formats that match training data do better. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [R] Anthropic's "Building effective agents": avoid formats that make the model count lines (diff headers) or string-escape code, such as code inside JSON with escaped newlines and quotes. Prefer formats close to naturally occurring text. — [Anthropic](https://www.anthropic.com/engineering/building-effective-agents)
- [R] Tam et al. 2024, "Let Me Speak Freely?": format constraints such as JSON mode significantly degrade LLM reasoning, and stricter constraints degrade it more. This concerns model *outputs*, which supports keeping tool *inputs* simple. — [arXiv 2408.02442](https://arxiv.org/abs/2408.02442)
- [R] He et al. 2024, "Does Prompt Formatting Have Any Impact on LLM Performance?": GPT-3.5-turbo's performance varied by up to 40% on a code-translation task across plain-text, Markdown, JSON and YAML templates. GPT-4 was more robust. — [arXiv 2411.10541](https://arxiv.org/abs/2411.10541)
- [R] Sclar et al. 2023 (FormatSpread): spurious formatting changes moved few-shot accuracy by up to 76 points on LLaMA-2-13B. — [arXiv 2310.11324](https://arxiv.org/abs/2310.11324)
- [R, low–medium confidence] ImprovingAgents (2025) tested 11 table formats on GPT-4.1-nano. Markdown key-value lists were most accurate (~60.7%) and CSV least (~44.3%), but Markdown-KV used several times more tokens. This is a single-small-model vendor blog. — [improvingagents.com](https://www.improvingagents.com/blog/best-input-data-format-for-llms) (exact URL slug not re-verified)
- [V] Evidence from production harnesses:
  - Claude Code's Read tool switched to a "compact line-number format" (v2.1.86).
  - Claude Code's truncation prompt for oversized MCP output suggests `jq` for JSON and computed chunk sizes for text (v2.1.105).
  - Codex serializes `structuredContent` to JSON text for the model.
  - GitHub's MCP server added CSV output for list tools "to reduce response context".
  - SWE-agent lists files, not match context, and says explicitly when output is empty.

  — [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md); [codex tests](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/tests.rs); [github-mcp-server insiders](https://github.com/github/github-mcp-server/blob/main/docs/insiders-features.md); [SWE-agent ACI](https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md)
- [V] Signature-only skeletons are an established overview format: aider's tree-sitter repo map, 1,024-token default, PageRank-ranked. — [aider](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)

### Inferences
- **Default output should be compact text:**
  1. A header line: what was searched, total hits, how many shown, index freshness.
  2. One line per result, e.g. `src/a.py:120  def  LoginService.authenticate  (callers: 7)`.
  3. Fenced code windows with line numbers, e.g. `120│ def authenticate(...)`.
  4. A footer with the next step ("more: cursor=…"; "narrow with path=").

  No nested JSON and no JSON-escaped code.
- If JSON is offered (via `format:"json"`, `outputSchema` or `structuredContent`), make it compact: no indentation, short stable keys, nulls and defaults omitted. Remember that Codex models will see exactly this JSON (Q2).
- For uniform tables such as hit lists, CSV/TSV-like rows or TOON-style tabular arrays save tokens with no measured accuracy penalty. For nested graph output (call trees), indented text trees are a reasonable choice, though no study measured them (see Gaps).

### Gaps
- No controlled study compares output formats specifically for code-navigation results (call graphs, reference lists, taint paths) or for line-numbered vs plain snippets.
- The TOON evidence is a self-benchmark on data-retrieval questions, not code.

---

## 6. Agent failure modes relevant to code-navigation tools, and how to make agents actually call a tool

### Takeaway
The relevant failure modes are well documented:
- Hallucinated identifiers and packages.
- Stale reads after edits, including stale diagnostics that trigger re-reads.
- Repeated re-reads when outputs are missing or opaque.
- **Under-use of provided tools and skills.** Anthropic itself documents conservative tool-reaching on recent Opus models and skill undertriggering.

What measurably helps: trigger conditions in descriptions ("measurable lift in should-call rate"); concise server instructions that describe workflows (GPT-5-mini went from 2/10 to 8/10); semantic IDs; and steering errors. Over-forceful MUST/CRITICAL language now causes *over*-triggering.

### Cited Findings
- **Hallucinated symbols and APIs.**
  - [R] Package hallucination: across 576K samples from 16 models, commercial models hallucinated ~5.2% of packages and open-source models ~21.7%, yielding 205,474 unique fake package names. — [Spracklen et al., USENIX Security 2025, arXiv 2406.10279](https://arxiv.org/abs/2406.10279)
  - [R] Anthropic found semantic identifiers instead of UUIDs "significantly" reduced hallucinations in retrieval tasks. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- **Stale reads and staleness.**
  - [V] Claude Code:
    - v2.1.111 fixed "LSP diagnostics from before an edit appearing after it, causing the model to re-read files it just edited".
    - v2.1.260 fixed stale read-tracking that caused "'File unchanged since last read' stubs and full-file re-injection after external edits".
    - v2.1.86 deduplicates unchanged re-reads.
  - [V] Anthropic's harness guidance uses dedicated edit tools that "reject writes if the file changed since Claude last read it".
  - [R] Anthropic presents just-in-time grep/glob as "bypassing the issues of stale indexing".

  — [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md); [agent-design.md (bundled)](file:///tmp/claude-0/bundled-skills/2.1.280/b082d86fd4dccac5e9436bb07e998cbb/claude-api/shared/agent-design.md); [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Loops and repeated reads.**
  - [V] Claude Code v2.1.147 fixed "stripped images prompting the model to repeatedly re-read media that was no longer present". Missing or opaque results make agents re-fetch.
  - [V] SWE-agent returns an explicit message on empty output.
  - [V] The ext-skills notes report that Claude "initially ignored the skill … and only read it after failing to use the server tools".

  — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md); [SWE-agent ACI](https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md); [ext-skills findings](https://github.com/modelcontextprotocol/ext-skills/blob/main/docs/archive/experimental-findings.md)
- **Under-use of provided tools.**
  - [V] Anthropic: "On recent Opus models, which reach for tools more conservatively, trigger conditions in the description give measurable lift in should-call rate." — [tool-use-concepts.md (bundled)](file:///tmp/claude-0/bundled-skills/2.1.280/b082d86fd4dccac5e9436bb07e998cbb/claude-api/shared/tool-use-concepts.md)
  - [V] Anthropic: "Claude has a tendency to 'undertrigger' skills", and "simple, one-step queries … may not trigger a skill even if the description matches perfectly". — [skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md)
  - [V] Community reports, not controlled: "models do not reliably load or follow skill instructions, even when skills are preloaded"; adherence is "time-decaying" as context grows and compaction occurs; "Even Opus 4.6 needs to be constantly bugged to load skills". — [ext-skills findings](https://github.com/modelcontextprotocol/ext-skills/blob/main/docs/archive/experimental-findings.md)
  - [R] MCPGAUGE reports low proactivity in calling MCP tools without explicit instruction. — [arXiv 2508.12566](https://arxiv.org/abs/2508.12566)
  - [V, vendor testimonial, not a measurement] Serena's agent self-evaluations note agents "still lean on built-ins for tiny text edits and non-code work". — [oraios/serena README](https://github.com/oraios/serena)
- **Over-use from forceful prompting.**
  - [V] "inflated emphasis causes over-triggering and rigid behavior". `CRITICAL: You MUST use this tool` should become `Use this tool when...`. — [prompt-audit.md (bundled)](file:///tmp/claude-0/bundled-skills/2.1.280/b082d86fd4dccac5e9436bb07e998cbb/claude-api/shared/prompt-audit.md)
  - [R] This contrasts with Anthropic's 2025 Claude Code best practices, which suggested adding "IMPORTANT" or "YOU MUST" to improve adherence. — [Anthropic](https://www.anthropic.com/engineering/claude-code-best-practices)
- **Measured effect of server instructions.** In an MCP-maintainer experiment in VS Code on PR-review workflows, 10 runs per cell:

  | Model | With instructions | Without |
  |---|---|---|
  | GPT-5-mini | 8/10 | 2/10 |
  | Claude Sonnet 4 | 9/10 | 10/10 |
  | Overall | 17/20 (85%) | 12/20 (60%) |

  [V] "some models naturally gravitate toward optimal patterns, others benefit significantly from explicit guidance". — [MCP blog, 2025-11-03](https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/) ([source](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2025-11-03-using-server-instructions.md))
- [V] Community report: a single server instruction telling the agent to read the companion skill first "caused Claude to load it reliably". Client and model versions were not documented. — [ext-skills findings](https://github.com/modelcontextprotocol/ext-skills/blob/main/docs/archive/experimental-findings.md)
- [R] AGENTS.md effects on tool use (ETH, Feb 2026): agents tend to follow context-file instructions, and tools named in those files get used more, with broader exploration and testing. See Q7. — [arXiv 2602.11988](https://arxiv.org/abs/2602.11988)
- [V] Errors: MCP requires input-validation failures to be returned as tool execution errors "to enable model self-correction". Anthropic says to return `is_error: true` "with an informative error message". — [MCP 2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog); [tool-use-concepts.md (bundled)](file:///tmp/claude-0/bundled-skills/2.1.280/b082d86fd4dccac5e9436bb07e998cbb/claude-api/shared/tool-use-concepts.md)

### Inferences
- **Anti-hallucination.**
  - `symbol`/`resolve` should never return empty silently. Return "no exact match; closest: A (path:line), B (path:line)".
  - Every result should carry a verifiable `path:line` so the agent can confirm the symbol with Read.
  - The not-found path is exactly where agents invent APIs.
- **Anti-staleness.**
  - Every response header should state index freshness, e.g. "index current" or "2 files changed since index — re-indexed" or "stale: X".
  - Re-index touched files lazily before answering, or expose a cheap `index_status`/`reindex`.
  - After an edit, a stale graph is worse than no graph: stale call edges look exactly like distractors.
- **Anti-loop.**
  - Report explicit empty or no-op results.
  - Keep outputs under client thresholds. In Claude Code, oversize results go to a file, which costs extra Read turns and can itself start re-read loops.
  - Return stable IDs so re-fetching is cheap and deterministic.
- **Getting the tool called.**
  1. Description first sentence = the job, then explicit triggers phrased in agent-task terms: "Use when you need callers/callees/references of a symbol or the blast radius of an edit — faster and more complete than grep across files; use Grep for literal text".
  2. Put the workflow ("search → symbol → relations/impact → Read the exact lines") in the ≤2KB server instructions, not in every description.
  3. Add an optional short AGENTS.md/CLAUDE.md line naming the server's purpose.
  4. Drop MUST/ALWAYS boosters.
  5. Evaluate should-call and over-call rates on a held-out task set.

### Gaps
- Found no controlled study measuring adoption of MCP code-search tools versus built-in grep/Read in Claude Code, Codex or Cursor, or the effect of AGENTS.md mentions on MCP tool adoption specifically.
- Most under-use evidence is vendor guidance or community reports. MCPGAUGE is the main measured source and is [R].

---

## 7. Server-level "instructions" and AGENTS.md/CLAUDE.md length

### Takeaway
Server instructions are the sanctioned place for **cross-tool workflow and constraints**, and should not duplicate the tool descriptions. Until 2025-11-25 they lived in `InitializeResult.instructions`; from 2026-07-28 they are in `server/discover`'s `DiscoverResult.instructions`. They are injected into the system prompt by Claude Code (capped at 2,048 chars), VS Code and Gemini CLI. Keep them short: the MCP maintainers explicitly say "Don't write a manual". Long guidance belongs in skills. For repo context files the evidence favors minimal human-written content: hard caps are 32 KiB in Codex and 200 lines / 25KB for Claude Code's MEMORY index, and LLM-generated context files hurt success in the ETH study [R].

### Cited Findings
- [V] In spec 2025-11-25, `InitializeResult` carries `"instructions": "Optional instructions for the client"`. In spec 2026-07-28, `DiscoverResult.instructions` is "Natural-language guidance describing the server and its features… used by clients to improve an LLM's understanding of available tools (e.g., by including it in a system prompt). It should focus on information that helps the model use the server effectively and should not duplicate information already in tool descriptions." — [lifecycle 2025-11-25](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/lifecycle.mdx); [schema 2026-07-28](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts)
- [V] MCP maintainers' guidance (2025-11-03):
  - "No instructions are better than poorly written instructions".
  - Focus on "what tools and resources don't convey": cross-feature relationships, operational patterns, constraints and limits.
  - Keep instructions model-agnostic.
  - Anti-patterns: repeating tool descriptions, marketing, general behavioral instructions, and "Don't write a manual" (a 500-word example is labeled bad).
  - Instructions can't guarantee behavior, so critical actions need "deterministic rules or hooks".
  - Hosts decide how to inject instructions: "not always guaranteed that they will be injected into the system prompt".

  — [MCP blog](https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/)
- [V] Client support:
  - Claude Code supports server instructions (v1.0.52) and caps them at 2KB (v2.1.84). The cap can be changed with `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` (v2.1.280). v2.1.70 fixed a prompt-cache bust when a server with instructions connects late.
  - VS Code lists "Server instructions" as supported.
  - Gemini CLI appends them to the system instructions.

  — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md); [VS Code guide](https://github.com/microsoft/vscode-docs/blob/main/api/extension-guides/ai/mcp.md); [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)
- [V] SEP-2640 says instructions are "practically bounded in size" and uses Skills over MCP for long workflows. Client support is still partial (Q2). — [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md)
- [V] Context-file caps:
  - Codex reads AGENTS.md up to 32 KiB.
  - Claude Code's auto-memory `MEMORY.md` index "truncates at 25KB as well as 200 lines" (v2.1.83).
  - Gemini CLI supports `@file.md` imports to split large GEMINI.md files.

  — [codex config_toml.rs](https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs); [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md); [gemini-md.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md)
- [R] Claude Code memory docs: aim for CLAUDE.md files under ~200 lines, because longer files consume context and reduce adherence; split them with imports or `.claude/rules/`. — [Claude Code memory docs](https://code.claude.com/docs/en/memory)
- [R] **ETH Zurich, "Evaluating AGENTS.md"** (Gloaguen et al., Feb 2026; AGENTbench plus SWE-bench Lite):
  - Context files tended to *reduce* task success compared with no context.
  - Inference cost rose by more than 20%.
  - Developer-written files helped only marginally.
  - Agents followed the files' instructions, which led to broader exploration and testing.
  - Recommendation: context files should state only minimal requirements.
  - [V] The harness compares `NONE`, `LLM` and `HUMAN` context settings.

  — [arXiv 2602.11988](https://arxiv.org/abs/2602.11988); [eth-sri/agentbench](https://github.com/eth-sri/agentbench)
- [R] Lulla et al. (Jan 2026): in 124 PRs across 10 repos, AGENTS.md presence went with ~29% lower median agent runtime and ~17% fewer output tokens at similar completion rates. This measures efficiency, not correctness. — [arXiv 2601.20404](https://arxiv.org/abs/2601.20404)
- [R] "Agent READMEs" (Nov 2025): 2,303 context files from 1,925 repos. They are maintained like configuration code and focus on build/run commands, implementation details and architecture, rarely on security or performance. — [arXiv 2511.12884](https://arxiv.org/abs/2511.12884)
- [R] IFScale (Jul 2025): as instruction count grows to 500, even the best frontier models reach only ~68% accuracy, with a primacy bias. — [arXiv 2507.11538](https://arxiv.org/abs/2507.11538)
- [V] Anthropic's 2026 audit guidance on context and skill files: a "verbose SKILL.md explaining things the model already knows" is cruft, since "every paragraph must justify its token cost". But "Cruft != length": the problem is outdated instructions, not volume. — [prompt-audit.md (bundled)](file:///tmp/claude-0/bundled-skills/2.1.280/b082d86fd4dccac5e9436bb07e998cbb/claude-api/shared/prompt-audit.md)

### Inferences
- **Replace graph-indexer's long prompt files with four layers:**
  1. **Server instructions, ≤~1.5–2K chars.** A 3–5 step workflow, when to prefer each tool over grep/Read, index-freshness semantics, and output budgets or cursors. No duplication of the descriptions.
  2. **Tool descriptions of 3–6 sentences**, each a contract.
  3. **A skill** for deep procedures such as security or taint review and impact analysis for refactors. Serve it via `skill://` (SEP-2640) for clients that support it, and ship it as a Claude Code plugin or filesystem skill, since Claude Code does not load MCP-served skills.
  4. **An optional generated AGENTS.md/CLAUDE.md snippet of ≤5–10 lines** naming the server and its main use, per the ETH minimal-content finding. Never auto-dump a long generated guide.
- **Treat instructions as soft signals.** Critical invariants, such as re-indexing before answering, must be enforced in server code, not requested in prose.
- **Evaluate with and without instructions** per model family: the GPT-5-mini vs Sonnet-4 split shows the effect is model-dependent.

### Gaps
- Could not verify the exact CLAUDE.md size wording in the current Claude Code docs, nor Cursor's or Codex's handling of MCP server instructions.
- ETH, Lulla and IFScale figures are [R].
- No study measured how the *length* of MCP server instructions affects tool adoption. The only quantitative data point is the MCP blog's 40-session experiment.
