# Integration surfaces for a local code-intelligence MCP server ("graph-indexer" + CLI) in AI coding agents, and the evidence on tool adoption (state as of 2026-09-22)

Verification legend (research done 2026-09-22):

- **[V]** Verified in this session against a primary artifact, dated below:
  - Claude Code docs, read from the mirror `github.com/ericbuess/claude-code-docs` (commit of 2026-09-22 18:25 UTC). The mirror copies code.claude.com, which the sandbox proxy blocks, so all citations use the official code.claude.com URLs.
  - `anthropics/claude-code` CHANGELOG (current version **2.1.280**, 2026-09-22).
  - `openai/codex` main (2026-09-22) and `google-gemini/gemini-cli` main (2026-09-21).
  - `microsoft/vscode-docs` (2026-09-22; hooks pages carry DateApproved 9/16/2026).
  - `cline/cline`, `zed-industries/zed` and `cursor/plugins` (all 2026-09-22), and `agentplugins/agent-plugins-spec` (2026-08-19).
  - Tool repos: `oraios/serena`, `abhigyanpatwari/GitNexus`, `DeusData/codebase-memory-mcp` (all 2026-09-22) and `nizos/tdd-guard` (2026-09-14).
  - GitHub issue search results.
- **[V2]** Seen only in a web-search result summary or snippet. The proxy blocks fetching arXiv, cursor.com, docs.windsurf.com, docs.github.com, github.blog, jetbrains.com and ethz.ch.
- **[R]** Carried over from the earlier notes (`docs/research/notes/context_engineering_mcp.md`) and not re-verified here. Those notes also cover the MCP spec details, tool-design guidance, long-context evidence and output-format benchmarks. This file focuses on what is new or was missing.

---

## 1. Claude Code (2.1.x): hooks, plugins, skills, subagents, LSP, tool search, limits, and which tools steer the agent with hooks

### Takeaway
Claude Code 2.1.280 has the richest integration surface of any agent. Four facts in it change how graph-indexer should integrate:

1. **Deferred MCP tools.** MCP tools are now deferred by default through tool search. At session start the model sees only tool *names* and the server *instructions* (capped at 2,048 chars). A server can pin individual tools with `_meta["anthropic/alwaysLoad"]`.
2. **No Grep or Glob tools on native builds.** On macOS, Linux and WSL native builds, since v2.1.117, the dedicated `Grep`/`Glob` tools are gone. Searches run as `Bash` calls to embedded `ugrep`/`bfs`. A hook meant to "enrich grep" must match `Bash` and parse the command.
3. **Hooks can add context and rewrite tool traffic.** Hooks can inject `additionalContext` next to any tool result (values over 10,000 chars are spilled to a file). They can rewrite inputs (`updatedInput`) and outputs (`updatedToolOutput`, all tools since v2.1.121). They fire inside subagents too (`agent_id`/`agent_type`). A new `mcp_tool` handler type lets a hook call an MCP tool directly. Anthropic warns that imperative "system-command" phrasing in injected context can trip prompt-injection defenses.
4. **Plugins bundle everything.** A plugin can ship MCP server, skills, agents, hooks, LSP servers and monitors in one install. A CLI can advertise its official-marketplace plugin through a stderr hint tag. `claude plugin eval` measures adoption with and without the plugin.

Code-intelligence servers already use these hooks in production: GitNexus and codebase-memory-mcp augment searches with graph context, and Serena denies repeated greps as a nudge. None of them publishes a controlled measurement of the effect.

### Cited Findings

**Hook events and handler types (docs, v2.1.280) [V]**
- The docs list 33 events: `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `SessionEnd`. — [Hooks reference](https://code.claude.com/docs/en/hooks)
- There are five handler types:
  - `command`
  - `http`
  - `mcp_tool`, which calls a tool on an already-connected MCP server; its text output is parsed like stdout. Added in v2.1.118.
  - `prompt`
  - `agent`, which is experimental.

  All matching hooks run in parallel. Default timeouts are 600 s for command/http/mcp_tool, 30 s for prompt and 60 s for agent, lowered to 30 s on `UserPromptSubmit`. — [Hooks reference](https://code.claude.com/docs/en/hooks); [CHANGELOG 2.1.118](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- `mcp_tool` hooks are skipped on `SessionStart` at launch, with the debug message "no MCP client context", because MCP servers are not yet available. They run only after `/clear` or compaction. The docs recommend a `command` hook for anything needed on the first turn. — [Hooks reference](https://code.claude.com/docs/en/hooks)
- Matchers:
  - A matcher is an exact string or `|`/`,` list when it contains only letters, digits, `_`, `-`, spaces, `,` and `|`. Otherwise it is an unanchored JS regex.
  - MCP tools are named `mcp__<server>__<tool>`. The bare prefix `mcp__memory` matches nothing, so write `mcp__memory__.*`.
  - Tools of **plugin-bundled** MCP servers are named `mcp__plugin_<plugin-name>_<server-name>__<tool>`. A matcher written against the bare server key never fires for them.
  - Since v2.1.274, MCP hook input carries `mcp_server: {name, source}`.
  - An `if` field takes a single permission-rule filter such as `"Bash(git *)"`. For Bash it is best-effort.

  — [Hooks reference](https://code.claude.com/docs/en/hooks)

**Context injection and rewriting contracts [V]** — [Hooks reference](https://code.claude.com/docs/en/hooks)
- **`additionalContext`**:
  - It is wrapped in a system reminder. For PreToolUse, PostToolUse, PostToolUseFailure and PostToolBatch it is inserted "next to the tool result". For SessionStart and SubagentStart it goes at the start of the conversation.
  - All values from multiple hooks are delivered.
  - "If a value exceeds 10,000 characters, Claude Code writes the text to a file… and passes Claude the file path with a preview of up to the first 2,000 characters". This has applied since v2.1.89.
  - Plain stdout is added as context only for `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart` and `PostModelSwitch`. Stderr on exit 0 is never shown to Claude.
- Phrasing guidance: "Write the text as factual statements rather than imperative system instructions… Text framed as out-of-band system commands can trigger Claude's prompt-injection defenses, which causes Claude to surface the text to you instead of treating it as context."
- Resume behavior: on `--resume`, the saved `PostToolUse` and `UserPromptSubmit` context is *replayed*, so values can go stale. `SessionStart` re-runs with `source: "resume"`.
- **PreToolUse** (`hookSpecificOutput`):
  - `permissionDecision` is `allow`, `deny`, `ask` or `defer`. When hooks disagree, precedence is deny > defer > ask > allow.
  - `permissionDecisionReason` is shown to Claude only for `deny`.
  - `updatedInput` "Replaces the entire input object". Permission rules are re-evaluated on the new input.
  - `additionalContext` is also available.
  - Exit 2 routes the same way as deny.
- **PostToolUse**:
  - `decision: "block"` with a `reason` adds the reason next to the result; the original output stays.
  - `additionalContext` is available.
  - `updatedToolOutput` replaces what Claude sees, for all tools since v2.1.121. For built-in tools the value "must match the tool's output shape", e.g. Bash `{stdout, stderr, interrupted, isImage}`, and a mismatching value is ignored. MCP output "is passed through without schema validation".
  - `updatedMCPToolOutput` is the legacy MCP-only field.
  - `classifierContext` requires v2.1.236.
  - `continueOnBlock` was added in v2.1.139.
- **PostToolBatch**:
  - Fires once after a batch of parallel tool calls, before the next model call, with no matcher.
  - Its `tool_response` is the serialized `tool_result` the model saw. For Read this is line-number-prefixed text.
  - Its `additionalContext` is "injected once before the next model call".
- **SessionStart**:
  - `source` is one of `startup`, `resume`, `clear`, `compact`, `fork`.
  - Output fields: `additionalContext`, `initialUserMessage`, `sessionTitle`, `watchPaths` (which feed `FileChanged`), and `reloadSkills: true`, which re-scans skills installed by the hook in the same session.
- CHANGELOG milestones (versions are not dated) — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md):
  - 1.0.59: UserPromptSubmit `additionalContext`.
  - 1.0.62: SessionStart.
  - 2.0.10: PreToolUse can modify inputs.
  - 2.1.0: hooks in agent frontmatter.
  - 2.1.9: PreToolUse `additionalContext`.
  - 2.1.69: `agent_id`/`agent_type` in hook input.
  - 2.1.89: `defer`, and the 10,000-char spill-to-file rule.
  - 2.1.110: fixed PreToolUse `additionalContext` "being dropped when the tool call fails".
  - 2.1.121: `updatedToolOutput` for all tools.
  - 2.1.163: Stop/SubagentStop `additionalContext`.
- An open bug report, anthropics/claude-code#24788 (2026-02-10), says PostToolUse hooks returning `additionalContext` for **MCP** tool calls produced no injected context. I found no CHANGELOG entry that explicitly fixes it, and the current docs make no MCP exception. — [Issue #24788](https://github.com/anthropics/claude-code/issues/24788) [V2]; [Hooks reference](https://code.claude.com/docs/en/hooks) [V]

**Hooks and subagents [V]**
- Settings hooks fire for tool calls made inside subagents. The input then includes `agent_id` ("Present only when the hook fires inside a subagent call") and `agent_type`. — [Hooks reference](https://code.claude.com/docs/en/hooks)
- SubagentStart:
  - Its matcher is the agent type: `Explore`, `Plan`, `general-purpose`, a custom name, or a plugin-scoped name like `^my-plugin:reviewer$`.
  - It "can't block subagent creation, but can inject context into the subagent".
  - Re-runs don't duplicate the injected context, which keeps the prompt cache intact.

  — [Hooks reference](https://code.claude.com/docs/en/hooks)
- Frontmatter hooks:
  - Subagent frontmatter hooks run only while that subagent runs, and `Stop` becomes `SubagentStop`.
  - Skill frontmatter hooks stay registered "for the rest of the session" once the skill is invoked. `once: true` removes a hook after its first success.
  - Project-subagent frontmatter hooks run only after the folder is trusted (since v2.1.218).

  — [Hooks reference](https://code.claude.com/docs/en/hooks); [Sub-agents](https://code.claude.com/docs/en/sub-agents)

**Built-in search reality: no Grep/Glob tools on native macOS/Linux builds [V]**
- "On macOS, Linux, and WSL, Claude Code leaves Glob and Grep out of the default tool set, and Claude searches with `find` and `grep` through the Bash tool instead… those two commands run embedded versions of `bfs` and `ugrep`, and the searches reach your hooks and permission rules as `Bash` calls." — [Tools reference](https://code.claude.com/docs/en/tools-reference)
- The change came in v2.1.117: "Native builds on macOS and Linux: the `Glob` and `Grep` tools are replaced by embedded `bfs` and `ugrep` available through the Bash tool". Windows and npm-installed builds are unchanged. — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- The tools come back when any of these holds:
  - They are named in `--tools`/`--allowedTools` (effective since 2.1.162).
  - Bash is removed.
  - A subagent lists `Glob`/`Grep` in `tools` without `Bash`.

  — [Tools reference](https://code.claude.com/docs/en/tools-reference)
- Grep conventions, where the tool exists:
  - Default `output_mode` is `files_with_matches`; `content` gives lines with file and line number.
  - An offset past the end returns "`No entries at this offset`" so Claude "widens or resets the offset instead of concluding the pattern doesn't match".
  - Rejected regexes return ripgrep's diagnostic. Before v2.1.208 they returned `No files found`.
- Glob caps results at 100 files with a truncation flag.
- Read returns a "`PARTIAL view` notice" on oversized files.

  — [Tools reference](https://code.claude.com/docs/en/tools-reference)
- Downstream effect: Serena's issue "serena-hooks remind --client=claude-code is blind to grep/read on native macOS/Linux builds (Claude Code 2.1.117+)" (#1845, opened 2026-08-12, open). — [oraios/serena#1845](https://github.com/oraios/serena/issues/1845)

**MCP presentation, tool search and limits [V]** — [MCP docs](https://code.claude.com/docs/en/mcp)
- "Tool search is enabled by default: MCP tools are deferred and discovered on demand… Only tool names and server instructions load at session start."
- `ENABLE_TOOL_SEARCH` values:
  - unset: defer everything.
  - `true`
  - `auto`: 10% threshold.
  - `auto:N`
  - `false`
- Tool search falls back to upfront loading on non-first-party `ANTHROPIC_BASE_URL`, on pre-4.5 models on Google's platform, and on Azure-hosted Foundry. It requires `tool_reference`-capable models (Sonnet/Haiku/Opus 4.5+).
- **Exemptions from deferral:**
  - `alwaysLoad: true` in the server config (added v2.1.121). It makes startup wait up to the 5 s connect timeout.
  - Per tool, `"_meta": {"anthropic/alwaysLoad": true}`.
- For server authors: "the server instructions field becomes more useful with tool search enabled. Server instructions help Claude understand when to search for your tools, similar to how skills work." Explain "What category of tasks your tools handle; When Claude should search for your tools; Key capabilities". "Claude Code truncates tool descriptions and server instructions at 2KB each… put critical details near the start". Since v2.1.280 the 2,048-char cap is configurable via `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`. — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Output limits:
  - A warning appears above 10,000 tokens. The default limit is 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`).
  - `_meta["anthropic/maxResultSizeChars"]` raises one tool's persist-to-disk threshold "up to a hard ceiling of 500,000 characters".
  - `_meta["anthropic/requiresUserInteraction"]: true` forces approval on every call (v2.1.199).
- "Claude Code automatically provides tools to list and read MCP resources when servers support them", which gives model-driven resource reads. This session's own tool list shows `ListMcpResourcesTool`, `ReadMcpResourceTool` and `ReadMcpResourceDirTool`, resolving the conflict noted in the earlier round.
- ToolSearch fixes:
  - v2.1.113: ranking fixed so "pasted MCP tool names surface the actual tool instead of description-matching siblings".
  - v2.1.271: fixed search returning nothing when Claude used a bare tool name.
  - v2.1.267/2.1.268: late-connecting tools arrive as deferred definitions, keeping the tool list byte-stable for prompt caching.

  — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Protocol: v2.1.274 moved Bedrock, Vertex, Foundry and telemetry-disabled installs to "the v2 MCP client and MCP 2026-07-28 negotiation with direct HTTP servers by default, as other installs already do". — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

**LSP tool and code-intelligence plugins [V]**
- The LSP tool was added in v2.0.74. It can:
  - jump to a definition
  - find all references
  - get type information
  - list symbols in a file
  - search for a symbol across the workspace
  - find implementations
  - trace call hierarchies

  "After each file edit, it automatically reports type errors and warnings". It is inactive until a "code intelligence plugin" is installed, and inactive in cloud sessions. — [Tools reference](https://code.claude.com/docs/en/tools-reference); [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Plugins declare servers via `lspServers` or `.lsp.json`. The official marketplace ships `clangd-lsp`, `csharp-lsp`, `gopls-lsp`, `jdtls-lsp`, `kotlin-lsp`, `lua-lsp`, `php-lsp`, `pyright-lsp`, `ruby-lsp`, `rust-analyzer-lsp`, `swift-lsp` and `typescript-lsp`. — [Plugins reference](https://code.claude.com/docs/en/plugins-reference); [claude-plugins-official](https://github.com/anthropics/claude-plugins-official)
- Relevant fixes:
  - 2.1.47: `findReferences` no longer returns gitignored files.
  - 2.1.111: stale pre-edit diagnostics caused "the model to re-read files it just edited".
  - 2.1.162: `workspaceSymbol` had returned no results.
  - 2.1.208: LSP documents are kept in an LRU capped at 50.
  - 2.1.280: background subagents can use LSP.

  — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

**Plugins, marketplaces, CLI hints, evals [V]**
- Plugin manifest `.claude-plugin/plugin.json` component fields: `skills`, `commands`, `agents`, `workflows`, `hooks`, `mcpServers`, `outputStyles`, `lspServers`, `experimental.themes`, `experimental.monitors`, `experimental.evals`, `userConfig`, `channels`, `dependencies` (semver). — [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- Plugin subagents: the `permissionMode`, `mcpServers`, `hooks` and `initialPrompt` fields are "Ignored for plugin subagents". A plugin must put its hooks in the plugin's `hooks` config, not in agent frontmatter. — [Sub-agents](https://code.claude.com/docs/en/sub-agents)
- **CLI → plugin hint:**
  - When `CLAUDECODE` (or `CLAUDE_CODE_CHILD_SESSION`, v2.1.172+) is set, a CLI can print `<claude-code-hint v="1" type="plugin" value="<name>@claude-plugins-official" />` to stderr.
  - Claude Code strips the line before the model sees it and prompts the user to install. This works only for plugins in the official Anthropic marketplace.
  - Limits: once per plugin, at most once per session, main interactive session only (never for subagent commands, `-p` or the SDK). The prompt times out after 30 s. It is disabled when telemetry is off.
  - Suggested placements: `--help`, unknown-subcommand errors, auth success, first run.

  — [Plugin hints](https://code.claude.com/docs/en/plugin-hints)
- Org marketplaces can add `relevance` signals (`cli`, `filesRead`, `cwd`) to surface install suggestions. These need an admin allowlist. — [Plugin relevance](https://code.claude.com/docs/en/plugin-relevance)
- **`claude plugin eval`**:
  - Each case runs 3× with the plugin and 3× without it, reporting `WITH`, `W/OUT` and `Δ`.
  - Graders include regex, "whether a particular tool was called", and LLM rubric.
  - "The most common first finding is a `Δ` near zero with the case's `tool_used: Skill` grader failing, which means Claude isn't choosing your skill on natural phrasing."

  — [Plugin evals](https://code.claude.com/docs/en/plugin-evals)

**Skills [V]** — [Skills](https://code.claude.com/docs/en/skills)
- Frontmatter fields: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `background`, `hooks`, `paths` (globs that limit auto-activation), `shell`, `metadata`, `license`, `compatibility`.
- Listing caps:
  - "the combined `description` and `when_to_use` text is truncated at 1,536 characters".
  - The listing budget "scales at 1% of the model's context window". On overflow, descriptions of the least-invoked skills are dropped first.
- After compaction, each skill's first 5,000 tokens are re-attached, with a combined 25,000-token budget.
- "If a skill seems to stop influencing behavior… the model is choosing other tools… Strengthen the skill's `description`… or use hooks to enforce behavior deterministically."

**Subagents [V]** — [Sub-agents](https://code.claude.com/docs/en/sub-agents)
- Frontmatter fields:
  - `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`
  - `skills`: preloads the *full* skill content.
  - `mcpServers`: an inline definition that is "connected when the subagent starts… disconnected when it finishes", or a string reference that shares the parent connection.
  - `hooks`, `memory`, `background`
  - `omitClaudeMd` (v2.1.271)
  - `effort`, `isolation: worktree`, `color`, `initialPrompt`, `experimental.cacheTtl`
- Subagents inherit built-in and MCP tools. A background subagent (the default) "keeps every MCP tool" plus a fixed built-in subset: `Read`, `Grep`, `Glob`, `LSP`, `Bash`, `Edit`, `Write` and others.
- "Explore and Plan skip your CLAUDE.md files and the git status snapshot". Since v2.1.198, Explore inherits the main model, capped at Opus. `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` removes both agents.

**Instruction files [V]**
- Claude Code reads `AGENTS.md` directly when no `CLAUDE.md`/`CLAUDE.local.md` exists (requires v2.1.277). With both present it reads only CLAUDE.md unless CLAUDE.md imports AGENTS.md. — [Memory](https://code.claude.com/docs/en/memory)
- "target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence". Auto-memory loads "first 200 lines or 25KB". — [Memory](https://code.claude.com/docs/en/memory)

**Popular tools that steer the agent with hooks, and reported effects**
- **Serena** (`serena-hooks`; clients `claude-code`, `codebuddy`, `vscode`, `codex`, `grok`) [V]:
  - `remind` is a PreToolUse hook. It emits `permissionDecision: "deny"` plus `additionalContext` after **3 consecutive greps**, **3 code-file reads**, or **4 mixed grep/read calls** with no Serena symbolic tool in between. It fires at most once per **120 s**, and the counter resets after a deny.
  - The deny text: "Too many consecutive grep calls without using symbolic tools. You can continue using grep now if needed, the counter was reset." The context adds "Consider using Serena's symbolic mcp tools instead for more code-centric search."
  - `activate` is a SessionStart hook injecting "**IMPORTANT**: … activate it using Serena's activate_project tool… read Serena Instructions Manual… Follow this instruction before doing anything else."
  - `auto-approve` allows Serena tools in `acceptEdits`/`auto` modes. `cleanup` runs at SessionEnd.

  — [serena/src/serena/hooks.py](https://github.com/oraios/serena/blob/main/src/serena/hooks.py); [Serena clients docs](https://github.com/oraios/serena/blob/main/docs/02-usage/030_clients.md)
- Serena's integration problems, from its issues [V]:
  - #1394: Codex grep inside `exec_command` was missed.
  - #1845: native-build blindness.
  - #1932: "Serena is incompatible with the 'tool search' pattern", closed 2026-08-25.
  - #2046: a Codex PostToolUse hook failed.

  — [issue search](https://github.com/oraios/serena/issues?q=hooks)
- Serena's reported effect: none quantitative. The README "evaluation" is agent self-assessment. One quote: GPT-5.4 says it "still lean[s] on built-ins for tiny text edits". — [Serena README](https://github.com/oraios/serena) [V]
- **GitNexus** Claude plugin [V]:
  - PreToolUse on `Grep|Glob|Bash` runs `gitnexus augment -- <pattern>`, with a 10 s hook timeout and a 7 s CLI timeout. It returns `additionalContext` listing callers, callees and "process participation" for the top 5 BM25 symbol matches, capped at 3 neighbours per symbol. Patterns shorter than 3 chars are skipped.
  - The engine targets "<500ms cold start, <200ms warm" and fails to an empty string.
  - PostToolUse on `Bash` "detects stale index after git mutations and notifies the agent to reindex".
  - The Cursor version uses `postToolUse` with matcher `Shell|Read|Grep` and returns `{additional_context}`.
  - No measured effect is published.

  — [hooks.json](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus-claude-plugin/hooks/hooks.json); [gitnexus-hook.js](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus-claude-plugin/hooks/gitnexus-hook.js); [augmentation engine](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/src/core/augmentation/engine.ts)
- **codebase-memory-mcp** `hook-augment` [V]:
  - "this NEVER blocks a tool call… This is what makes issue #362 structurally impossible to recur — the hook cannot deny a tool."
  - PreToolUse on `Grep`/`Glob`/`Bash` injects matching graph symbols as `additionalContext`. It uses a pure-SQLite `search_graph` query, a **300 ms deadline**, a minimum token of 4 chars and 5 results. PostToolUse on `Read` adds "coverage context when the graph could not fully parse or index that file".
  - The installer writes per-agent skills, three read-only "graph" subagents, and SessionStart/SubagentStart context where supported.

  — [hook_augment.c](https://github.com/DeusData/codebase-memory-mcp/blob/main/src/cli/hook_augment.c); [README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)
- **TDD Guard / Probity** [V]: PreToolUse on `Write|Edit|MultiEdit|TodoWrite` blocks implementation without a failing test, with UserPromptSubmit and SessionStart hooks alongside. It has "grew into Probity" for Claude Code, Codex and Copilot CLI. No quantitative effect is published. — [tdd-guard](https://github.com/nizos/tdd-guard)
- The official-marketplace Serena plugin is MCP-only: `.mcp.json` launching `uvx … serena start-mcp-server`, with no hooks or skills. — [claude-plugins-official/external_plugins/serena](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/serena) [V]

### Inferences
- **Hook matchers:** graph-indexer's Claude Code hooks must match `Bash` (with `if: "Bash(grep *)"`/`"Bash(rg *)"`/`"Bash(find *)"` or in-script parsing) as well as `Grep|Glob|Read`. On the default native builds, `Grep`/`Glob` do not exist.
- **Discovery under default tool search:**
  - Assume the model starts with only tool names plus ≤2,048 chars of server instructions.
  - Write the instructions as a "when to search for these tools" statement.
  - Make tool names self-describing for ToolSearch, e.g. `find_references`, `call_graph`, `impact_of_change`.
  - Mark 1–3 core tools with `_meta["anthropic/alwaysLoad"]: true` so they are callable without a search round-trip.
- **Hook design:** the robust pattern, used by GitNexus and codebase-memory-mcp, is fail-open, context-only and fast (≤300–500 ms). `additionalContext` should be phrased as facts, e.g. "`parseConfig` is defined at src/cfg.ts:41; 12 callers; graph-indexer `find_references` returns them". Imperatives can trigger injection defenses. A deny-based nudge (Serena) adds friction, and no data shows it helps.
- **Packaging:** ship one Claude Code plugin bundling:
  - the MCP server
  - a skill: the long workflow, with `paths`/`when_to_use`
  - a read-only "graph explorer" subagent whose `tools` list includes the plugin MCP tools
  - hooks: SessionStart (command type) for index status; PreToolUse/PostToolBatch for grep enrichment; PostToolUse on edits to mark the index stale

  Plugin agents cannot declare `mcpServers` or `hooks`, so those belong to the plugin itself.
- **Explore/Plan:** these agents skip CLAUDE.md. Reach them with a `SubagentStart` hook (matcher `Explore|Plan`) that injects a one-line graph-indexer pointer, rather than relying on CLAUDE.md.
- **CLI:** once listed in the official marketplace, the graph-indexer CLI should emit the `<claude-code-hint>` on `--help` and on first run when `CLAUDECODE` is set. Measure adoption with `claude plugin eval` using `tool_used` graders against the W/OUT baseline.

### Gaps
- Could not confirm whether anthropics/claude-code#24788 (PostToolUse `additionalContext` not injected for MCP tools) is fixed. The GitHub MCP tool was restricted to the user's repo and no CHANGELOG entry mentions a fix.
- Found no document stating whether MCP **server instructions** reach subagents (Explore, custom agents) or only the main thread.
- No quantitative data (A/B, adoption rate, success rate) for any hook-based steering: Serena remind, GitNexus augment, codebase-memory augment, TDD Guard.
- Could not measure the current Grep/Glob split across install types (native vs npm vs Windows).

---

## 2. Other agents: hooks, plugins/extensions, skills, subagents, MCP support, instruction files, presentation of MCP tools, truncation limits

### Takeaway
By September 2026 the Claude-Code-style hook contract has become a de facto standard:

- **Same contract, JSON-compatible fields:** Codex CLI (stable, default-on) and VS Code's Local harness use `PreToolUse`/`PostToolUse`/`SessionStart`/`SubagentStart` with `additionalContext`/`updatedInput`.
- **Same idea, different names:** Gemini CLI (`BeforeTool`/`AfterTool` + `tailToolCallRequest`), Cursor (`postToolUse` + `additional_context`, 2.4+), Windsurf (`pre_/post_*` events), Copilot CLI (`preToolUse`/`postToolUse`/`sessionStart`), Cline (now SDK TypeScript plugin hooks) and OpenHands (`.openhands/hooks.json`).
- **No hooks for their own agent:** Zed, Aider and (as of May 2026) Junie.

Packaging is converging on **Agent Plugins 1.0** (skills + MCP, TSC from Amazon, Cursor, Microsoft, OpenAI and Vercel; supported by VS Code and Codex) alongside the Claude, Cursor and Gemini-extension formats. Skills are converging on `SKILL.md` in `.agents/skills/`.

MCP presentation differs in ways that matter:
- **Deferred behind search:** Claude Code (names only) and Codex (BM25 `tool_search`; server instructions become the namespace description).
- **Eager:** Gemini (instructions appended to the system prompt; 63-char names) and VS Code (128-tool cap).
- **Capped:** Windsurf (100 tools).
- **Tools and prompts only, no instructions:** Zed.

### Cited Findings

**OpenAI Codex CLI (openai/codex main, 2026-09-22) [V]**
- Hooks:
  - Feature key `hooks` (legacy `codex_hooks`) is at `Stage::Stable`, `default_enabled: true`. The code comment reads: "Enable Claude-style lifecycle hooks loaded from hooks.json files."
  - Sources are `hooks.json` in Codex config folders and `[hooks]` in `config.toml`.

  — [features/src/lib.rs](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs); [hooks discovery](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs)
- Events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`. Handler types: `command`, `mcp_tool`, `prompt`, `agent`, run sync or async. — [protocol.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)
- Output schemas:
  - PreToolUse `hookSpecificOutput`: `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `additionalContext`.
  - PostToolUse: `additionalContext`, `updatedMCPToolOutput`, plus top-level `decision`/`reason`.
  - SessionStart and SubagentStart: `additionalContext`.
- Deviations from Claude Code: `"allow"` without `updatedInput` → "PreToolUse hook returned unsupported permissionDecision:allow" (fails open). `"ask"` is also unsupported.

  — [hooks/schema/generated](https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated); [pre_tool_use.rs](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/pre_tool_use.rs)
- Hook tool names:
  - Shell tools arrive as `Bash` with `tool_input {command}`.
  - `apply_patch` also answers the matcher aliases `Write` and `Edit`.
  - `spawn_agent` answers the alias `Agent`.
  - MCP tools arrive as `mcp__<server>__<tool>` with their JSON arguments.
  - Subagent calls carry `agent_id`/`agent_type`.
  - Codex has no Grep or Read tool, so search happens inside shell commands.

  — [hook_names.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/hook_names.rs); [pre_tool_use.rs](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/pre_tool_use.rs)
- Installed hooks "must [be] review[ed] and trust[ed]… through `/hooks`; changing a hook definition changes its trust hash". — [codebase-memory-mcp README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)
- Plugins:
  - `.codex-plugin/plugin.json` with `name`, `version`, `description`, `keywords`, `skills`, `mcpServers`, `apps`, `hooks`, `interface`.
  - Codex also reads the Agent Plugins format under extension namespace `com.openai`.
  - MCP tools from Agent-Plugin servers get descriptions capped at **1,000 bytes**, per-tool specs at 8,000 bytes and a 64,000-byte total.

  — [core-plugins/manifest.rs](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/manifest.rs); [agent_plugin_manifest.rs](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/agent_plugin_manifest.rs); [tools/mcp_tool.rs](https://github.com/openai/codex/blob/main/codex-rs/tools/src/mcp_tool.rs); [mcp_tool_exposure.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_exposure.rs)
- Skills live in `.agents/skills/<name>/SKILL.md` (per tests), with docs at developers.openai.com/codex/skills. Subagents: `multi_agent` is Stable and default-on, via the `spawn_agent` tool. Agent roles are TOML files under a config folder's `agents/`, with `developer_instructions` and `nickname_candidates`. — [docs/skills.md](https://github.com/openai/codex/blob/main/docs/skills.md); [agent-roles](https://github.com/openai/codex/tree/main/codex-rs/agent-roles/src)
- MCP presentation:
  - Each server's tools form a namespace. **Server instructions become the namespace description**, capped at 512 KiB, or 1,000 bytes for agent-plugin servers.
  - When the model `supports_search_tool` (true for every model in `models.json`: gpt-6-astra/sol/luna, gpt-5.6-*, gpt-5.5, gpt-5.4…) and the provider supports namespaces, **all MCP tools are exposed as `Deferred`**. The model finds them with `tool_search`: "Searches over deferred tool metadata with BM25 and exposes matching tools for the next model call", which lists "sources" with their descriptions.

  — [rmcp_client.rs](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/rmcp_client.rs); [handlers/mcp.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/mcp.rs); [mcp_tool_exposure.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_exposure.rs); [tool_search_spec.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/tool_search_spec.rs); [models.json](https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json)
- Limits and flags:
  - Tool output truncation is `{mode: tokens, limit: 10000}` for every listed model.
  - `readOnlyHint` feeds approval and "guardian" metadata.
  - MCP `2026-07-28` support exists as `McpProtocolMode::V20260728`, behind the `mcp_2026_07_28` feature, which is `UnderDevelopment` and off by default.
  - [R] When both are present, Codex shows `structuredContent` instead of `content`. AGENTS.md is capped at 32 KiB.

  — [models.json](https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json); [mcp_tool_call.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs); [features](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs)

**Google Gemini CLI (main, 2026-09-21) [V]**
- Hook events: `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `BeforeToolSelection`, `AfterModel`, `SessionStart`, `SessionEnd`, `Notification`, `PreCompress`. — [hooks/reference.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md)
- Mechanics: exit 0 means stdout is JSON ("Silence is Mandatory"); exit 2 blocks. Matchers are regexes over tool names: `grep_search` (legacy `search_file_content`), `read_file`, `glob`, `run_shell_command`, and MCP `mcp_<server>_<tool>`.
- `BeforeTool`: `decision: "deny"` with `reason` goes "to the agent as a tool error"; `hookSpecificOutput.tool_input` "merges with and overrides" the arguments.
- `AfterTool`:
  - `hookSpecificOutput.additionalContext` "is **appended** to the tool result".
  - `decision: "deny"` replaces the result with `reason`.
  - **`hookSpecificOutput.tailToolCallRequest: {name, args}`** runs another tool right away, and "The result of this 'tail call' will replace the original tool's response. Ideal for programmatic tool routing."
- `BeforeToolSelection`: `toolConfig.mode` AUTO/ANY/NONE and an `allowedFunctionNames` whitelist.
- `SessionStart` (`startup`/`resume`/`clear`): `additionalContext` becomes the first turn, or is prepended to the prompt in non-interactive mode.

  — [hooks/reference.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md); [reference/tools.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/tools.md)
- Extensions: `gemini-extension.json` with `mcpServers`, `contextFileName`, `excludeTools`, `plan`, `settings`, `themes`, plus `commands/`, `hooks/hooks.json`, `skills/`, `agents/` (preview) and policies. — [extensions/reference.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md)
- Skills live in `.gemini/skills/` or `.agents/skills/` (the alias takes precedence), plus user-level `~/.gemini/skills/` and `~/.agents/skills/`. They load via the `activate_skill` tool with progressive disclosure. — [cli/skills.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md)
- Subagents: the built-in `codebase_investigator` is auto-delegated for codebase questions. Custom agents live in `.gemini/agents/*.md` and `~/.gemini/agents/*.md`, with frontmatter including `tools` and an agent-isolated inline `mcpServers`. — [core/subagents.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md)
- MCP:
  - Server instructions "will be appended to the system instructions".
  - Supports `resource_link`.
  - Names are `mcp_{server}_{tool}`, truncated above 63 chars.
  - Truncation: `tools.truncateToolOutputThreshold` defaults to **40,000 characters**, and `contextManagement.tools.distillation.maxOutputTokens` defaults to **10,000**.

  — [tools/mcp-server.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md); [configuration.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)

**VS Code / GitHub Copilot (vscode-docs, pages approved 2026-09-16) [V]**
- The **Session Target** picks the agent harness:
  - Local (extension host)
  - Copilot (Agent Host; same SDK hook implementation as Copilot CLI)
  - Claude (Claude Agent SDK; uses Claude hooks)
  - Codex (Codex runtime)
  - Cloud

  "Some harnesses discover the same hook files, such as `.github/hooks/*.json` or `.claude/settings.json`… Supported events… tool names, payloads, and output decisions can differ." — [agent-customization/hooks.md](https://github.com/microsoft/vscode-docs/blob/main/docs/agent-customization/hooks.md)
- Local hooks (Preview):
  - Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart` (source "Currently always `"new"`"), `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`.
  - Command props: `windows`/`linux`/`osx`/`cwd`/`env`/`timeout`, with a default timeout of 30 s.
  - PreToolUse output: `permissionDecision` allow/deny/ask, `updatedInput` (must match the Local tool schema), `additionalContext`.
  - PostToolUse output: `decision: "block"`, `reason`, `additionalContext`. SubagentStart output: `additionalContext`.

  — [hooks-reference.md](https://github.com/microsoft/vscode-docs/blob/main/docs/agents/reference/hooks-reference.md)
- Agent plugins:
  - Accepted formats: Agent Plugins 1.0 (`plugin.json` with `$schema` `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`), Copilot (`plugin.json`), Claude (`.claude-plugin/plugin.json`) and Legacy OpenPlugin (`.plugin/plugin.json`).
  - Root tokens: `${PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_ROOT}`, and `${PLUGIN_DATA}` for persistent writable state.

  — [agent-plugins.md](https://github.com/microsoft/vscode-docs/blob/main/docs/agent-customization/agent-plugins.md)
- Skills live in `.github/skills/`, `.claude/skills/` and `.agents/skills/`, plus personal `~/.copilot/skills/`, `~/.claude/skills/` and `~/.agents/skills/`. `description` is limited to 1024 chars. — [agent-skills.md](https://github.com/microsoft/vscode-docs/blob/main/docs/agent-customization/agent-skills.md)
- MCP:
  - Supports server instructions.
  - "The confirmation dialog will be shown for all tools that are not marked with the `readOnlyHint` annotation".
  - [R] Requests are capped at 128 tools, with virtual tools above a threshold.

  — [VS Code MCP extension guide](https://github.com/microsoft/vscode-docs/blob/main/api/extension-guides/ai/mcp.md)
- Copilot CLI hooks: `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse` (can approve or deny), `postToolUse` and `errorOccurred`. Session-start hooks can return `additionalContext`. — [GitHub hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) [V2]

**Cursor (closed source)**
- Plugins: `.cursor-plugin/plugin.json` schema fields `name`, `displayName`, `description`, `version`, `minClientVersions`, `author`, `publisher`, `homepage`, `repository`, `license`, `logo`, `keywords`, `category`, `tags`, `commands`, `agents`, `skills`, `rules` (`.mdc`), `hooks`, `variables`, `mcpServers`. Marketplace manifest `.cursor-plugin/marketplace.json`, `${CURSOR_PLUGIN_ROOT}`, and `hooks/hooks.json` `{"version": 1, "hooks": {…}}` with events such as `stop`, `afterFileEdit`, `subagentStop`. — [cursor/plugins](https://github.com/cursor/plugins) (schemas/plugin.schema.json) [V]
- `.cursor/hooks.json` `postToolUse` requires Cursor 2.4+. A hook returns `{ additional_context: "..." }`; tool names include `Shell`, `Read`, `Grep`. — [GitNexus Cursor integration](https://github.com/abhigyanpatwari/GitNexus/tree/main/gitnexus-cursor-integration) [V]
- Other events include `beforeMCPExecution` and `afterMCPExecution`. — [Cursor hooks docs](https://cursor.com/docs/hooks) [V2]
- Several 2026 forum reports say `postToolUse` `additional_context` "is not surfaced to the model". — [forum 155689](https://forum.cursor.com/t/native-posttooluse-hooks-accept-and-log-additional-context-successfully-but-the-injected-context-is-not-surfaced-to-the-model/155689), [forum 158168](https://forum.cursor.com/t/posttooluse-hooks-additional-context-not-injected-into-agent-model-context/158168) [V2]
- codebase-memory-mcp withholds its Cursor context hooks "because session injection races and `readonly` blocks MCP". — [README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md) [V]
- Cursor 2.4 (Jan 2026) added subagents and skills. 2.5 added plugins and async subagents. Personal skills live in `~/.cursor/skills/`. — [changelog 2.4](https://cursor.com/changelog/2-4), [2.5](https://cursor.com/changelog/2-5), [skills docs](https://cursor.com/docs/skills) [V2]

**Windsurf / Cascade (closed source) [V2]**
- Hooks include `pre_read_code`, `post_read_code`, `pre_write_code`, `pre_run_command`, `pre_mcp_tool_use`, `post_mcp_tool_use` and a `post_cascade_response(_with_transcript)` variant. "Only pre-hooks can block actions using exit code 2". Post results are "informational". — [Cascade Hooks](https://docs.windsurf.com/windsurf/cascade/hooks); [Checkmarx hooks package](https://pkg.go.dev/github.com/Checkmarx/ast-cx-hooks/windsurf)
- "Cascade supports a maximum of 100 MCP tools total across all servers". Skills live in `.windsurf/skills/<name>/SKILL.md`. Rules have trigger modes (always_on, glob, model_decision, manual). AGENTS.md is supported. — [MCPBundles](https://www.mcpbundles.com/blog/windsurf-mcp-tools); [microsoft/apm#1520](https://github.com/microsoft/apm/issues/1520)
- codebase-memory-mcp installs only "Always-on `global_rules.md`" for Windsurf. — [README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md) [V]

**Cline [V]**
- Hooks are now "SDK Plugins": a TypeScript `AgentPlugin` with hooks `beforeRun`, `afterRun`, `beforeModel`, `afterModel`, `beforeTool`, `afterTool`, `onEvent`, stages such as `tool_call_before`/`tool_call_after`, and policies (`timeoutMs`, `maxConcurrency`, `fail_closed`). — [docs/sdk/plugins.mdx](https://github.com/cline/cline/blob/main/docs/sdk/plugins.mdx); [customization/hooks.mdx](https://github.com/cline/cline/blob/main/docs/customization/hooks.mdx)
- Subagents are read-only, default-on and parallel. They "Cannot edit files, use the browser, **access MCP servers**, or spawn nested subagents". — [features/subagents.mdx](https://github.com/cline/cline/blob/main/docs/features/subagents.mdx)
- Skills live in `.cline/skills/` and `~/.cline/skills/`, loaded via `use_skill`; metadata costs "~100 tokens per skill"; `description` max 1024 chars. — [customization/skills.mdx](https://github.com/cline/cline/blob/main/docs/customization/skills.mdx)
- codebase-memory-mcp: "automatic file hooks withheld because they auto-activate and their output is not reliably consumed; child agents cannot use MCP". — [README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)

**Roo Code**
- The last commit on main is 2026-05-15. codebase-memory-mcp treats it as "Conditional… MCP only". I found no hooks, skills or plugin mechanism in this session. — [Roo-Code repo](https://github.com/RooCodeInc/Roo-Code) [V]

**Zed [V]**
- "Zed currently supports MCP's Tools and Prompts features". Discovery, sampling, elicitation and server instructions are not listed. It handles `notifications/tools/list_changed`. Permission keys take the form `mcp:<server>:<tool>`. — [docs/src/ai/mcp.md](https://github.com/zed-industries/zed/blob/main/docs/src/ai/mcp.md)
- On adoption, Zed's docs say: "How reliably MCP tools get called can vary from model to model. Mentioning the MCP server by name can help… if you want to _ensure_ a given MCP server will be used, you can create a custom profile where all built-in tools (or the ones that could cause conflicts…) are turned off". — [mcp.md](https://github.com/zed-industries/zed/blob/main/docs/src/ai/mcp.md)
- Instruction files: the first match among `.rules` … `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`. Skills live in `~/.agents/skills/` and `.agents/skills/`, loaded via the `skill` tool. There are no agent hooks, only task hooks for worktree creation. External agents (Claude, Codex, OpenCode, Copilot, Cursor, Pi) run via ACP. — [rules.md](https://github.com/zed-industries/zed/blob/main/docs/src/ai/rules.md); [skills.md](https://github.com/zed-industries/zed/blob/main/docs/src/ai/skills.md); [external-agents.md](https://github.com/zed-industries/zed/blob/main/docs/src/ai/external-agents.md)

**OpenHands, Aider, JetBrains Junie**
- OpenHands uses skills in `.agents/skills/`. "The Agent Server loads `.openhands/hooks.json` from the workspace", with an `on_conversation_end` example. — [OpenHands docs/DefenseClaw.md](https://github.com/OpenHands/OpenHands/blob/main/docs/DefenseClaw.md) [V]. The full event list is unverified.
- Aider: no MCP support found in the `aider/*.py` sources or HISTORY (last commit 2026-05-22). Conventions are loaded via `CONVENTIONS.md`/`.aider.conf.yml`. — [Aider repo](https://github.com/Aider-AI/aider) [V]; [codebase-memory-mcp README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)
- Junie [V2]:
  - Reads `AGENTS.md`, both project-level and `~/.junie/AGENTS.md`.
  - Supports Agent Skills, MCP (`.junie/mcp/mcp.json`), custom agents and a CLI with extension marketplaces.
  - "Junie does not have hook support as of May 2026".

  — [Junie guidelines](https://junie.jetbrains.com/docs/guidelines-and-memory.html); [Junie skills](https://junie.jetbrains.com/docs/agent-skills.html); [ai-guardian#637](https://github.com/RedHatProductSecurity/ai-guardian/issues/637)

**Cross-agent packaging standard [V]**
- Agent Plugins 1.0.0 is "Published"; 1.1.0 is a working draft (started 2026-08-19).
  - The required `plugin.json` has `$schema` and `name`. Optional parts are `skills/` and `mcp.json`.
  - Client-specific parts such as hooks and agents go in reverse-domain "extension namespaces".
  - Package paths must stay inside the plugin root.
- The TSC: Amazon, Cursor, Microsoft, OpenAI and Vercel. Anthropic and Google are not TSC members, although a Google Developers Blog post announces support [V2].

  — [spec 1.0.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md); [MAINTAINERS.md](https://github.com/agentplugins/agent-plugins-spec/blob/main/MAINTAINERS.md); [Google Developers Blog](https://developers.googleblog.com/agent-plugins-package-your-skills-tools-and-more/)

### Inferences
One integration kit can cover most agents with three portable layers plus per-agent adapters:

1. **Portable layers:**
   - the MCP server, with server instructions of ≤2,048 chars
   - a `SKILL.md` in `.agents/skills/graph-indexer/`
   - an Agent Plugins 1.0 `plugin.json` + `mcp.json`
2. **Hooks in the Claude-compatible JSON contract.** One script can serve Claude Code, Codex, VS Code-Local and Copilot with light translation:
   - SessionStart/SubagentStart: index status line.
   - PreToolUse on shell/grep: fail-open `additionalContext` with symbol hits.
   - PostToolUse on edits: staleness.
   - Codex-specific: never return `allow` without `updatedInput`, and never return `ask`.
3. **Per-agent adapters:**
   - Gemini: extension with `hooks/hooks.json` and `AfterTool` on `grep_search|run_shell_command`. `tailToolCallRequest` is a unique lever to route a grep into a graph query.
   - Cursor: `postToolUse` `additional_context`, noting the reports that it is not injected.
   - Zed and Aider: rules/AGENTS.md pointer only.
   - Windsurf: rules plus the 100-tool budget.
   - Cline: no MCP inside subagents.
4. **Discovery under deferral.** Claude Code and Codex both hide MCP tool schemas behind search. Server instructions matter more than ever: in Codex they become the BM25-searchable namespace description, in Claude Code the "when to search" hint. So do keyword-rich tool names and descriptions.
5. **Search tool names differ by agent:** Claude native builds `Bash` (ugrep/bfs), Claude npm/Windows `Grep`/`Glob`, Codex `Bash`/`exec_command` (rg), Gemini `grep_search`/`run_shell_command`, Cursor `Grep`/`Shell`. Hook matchers must list all variants.

### Gaps
- The full event list and output contract of Cursor hooks (and whether the `additional_context` bug is fixed), Windsurf hooks (whether any hook can inject model context), Copilot CLI hook outputs, OpenHands hook events and Junie hooks were not verifiable from primary docs (fetch blocked).
- Cursor's current MCP tool cap and truncation limits, and VS Code's tool-output truncation limit, were not found.
- Roo Code's product status in 2026 is unclear (repo quiet since May 2026).
- Whether VS Code's Claude/Codex harnesses honour `.github/hooks` or only their native files was not verified beyond the docs' warning that behaviours differ.

---

## 3. MCP specification features relevant to a code-intelligence server (2025-11-25 → 2026-07-28) and ecosystem adoption

### Takeaway
The spec facts are in the earlier notes [R/V there]:
- 2025-06-18: `structuredContent`/`outputSchema`, `resource_link`, `title`.
- 2025-11-25: tool-name rules, validation errors as tool errors, tasks (experimental).
- 2026-07-28: stateless core with `server/discover` carrying `instructions`, explicit handles instead of sessions, deterministic `tools/list` order and TTL caching, tasks moved to an extension, and Roots, Sampling and Logging deprecated.

Adoption in September 2026:
- Claude Code negotiates 2026-07-28 by default for direct HTTP servers.
- Codex has a 2026-07-28 protocol mode behind an off-by-default flag.
- Zed implements only tools and prompts.
- Vendor `_meta` keys (Anthropic's `alwaysLoad`, `maxResultSizeChars`, `requiresUserInteraction`) now matter more to model-facing behaviour than the optional spec features.

### Cited Findings
- Spec features, from the earlier notes [R]:
  - 2026-07-28: stateless, `server/discover` MUST, `DiscoverResult.instructions`, handles as tool arguments, deterministic order SHOULD, `ttlMs`/`cacheScope`, tasks → `io.modelcontextprotocol/tasks`, Roots/Sampling/Logging deprecated.
  - 2025-11-25: SEP-986 names, SEP-1303 validation-as-tool-error, SEP-1686 tasks.
  - Annotations default to `readOnlyHint` false, `destructiveHint` true, `idempotentHint` false, `openWorldHint` true.

  — [2026-07-28 changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx); [schema 2025-11-25](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-11-25/schema.ts)
- Claude Code:
  - "v2 MCP client and MCP 2026-07-28 negotiation with direct HTTP servers by default" (v2.1.274). A v2.1.238 fix mentions stdio servers receiving `server/discover` before `initialize`.
  - Supported since: `structuredContent` 2.0.21, `resource_link` 1.0.44, instructions 1.0.52, `list_changed` 2.1.0.
  - v2.1.128 fixed "MCP tool results dropping images when the server returns both structured content and content blocks".

  — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) [V]
- Codex:
  - `McpProtocolMode::V20260728` is paginated with `next_cursor`. The `mcp_2026_07_28` and `codex_apps_mcp_2026_07_28` features are `UnderDevelopment`.
  - `readOnlyHint` is read into approval and guardian metadata.
  - Server `instructions` (from `initialize`) become the tool-namespace description.

  — [rmcp_client.rs](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/rmcp_client.rs); [features](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs); [mcp_tool_call.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs) [V]
- Gemini CLI appends instructions to the system instructions (it links the 2025-06-18 schema) and supports `resource_link`. VS Code auto-approves `readOnlyHint` tools and supports instructions. Zed supports tools and prompts only. — [Gemini mcp-server.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md); [VS Code MCP guide](https://github.com/microsoft/vscode-docs/blob/main/api/extension-guides/ai/mcp.md); [Zed mcp.md](https://github.com/zed-industries/zed/blob/main/docs/src/ai/mcp.md) [V]
- Anthropic `_meta` extensions honoured by Claude Code: `anthropic/alwaysLoad` (per tool, defers nothing), `anthropic/maxResultSizeChars` (≤500,000), `anthropic/requiresUserInteraction` (v2.1.199+). — [MCP docs](https://code.claude.com/docs/en/mcp) [V]
- Skills over MCP (SEP-2640, `skill://`), from the earlier notes [R]: client support is partial (ChatGPT, fast-agent, Inspector), and Claude Code does not load MCP-served skills. The packaging answer that emerged in 2026 is Agent Plugins (skills + MCP in one package), not MCP-served skills. — [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md); [Agent Plugins spec](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md)
- Claude Code's `mcp_tool` hook type (v2.1.118) and Codex's `McpTool` hook handler turn an MCP tool into a hook endpoint. A server can answer a PostToolUse on Edit, or a SessionStart after `/clear`, without a separate script. — [Hooks reference](https://code.claude.com/docs/en/hooks); [protocol.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) [V]

### Inferences
- **Support both handshakes.** Implement `server/discover` and `initialize`. Put the same ≤2,048-char `instructions` in both.
- **Keep `tools/list` stable and deterministic**, which protects the caches of Claude Code, Codex and Bedrock and their byte-stable tool lists.
- **Use explicit cursor/handle arguments** for paging large result sets, not sessions.
- **Mark all query tools** `readOnlyHint: true`, `openWorldHint: false`. Add `_meta` `anthropic/alwaysLoad` on 1–3 core tools, and `anthropic/maxResultSizeChars` only if a tool truly needs more than 50K chars. Better: paginate instead.
- **Expose a hook-friendly MCP tool**, e.g. `augment_search(pattern)` returning ≤1–2K chars of plain text. Then `mcp_tool` hooks in Claude Code and Codex can call the server directly without a CLI round trip. Keep a CLI `hook` subcommand for SessionStart at launch, where `mcp_tool` hooks are skipped.

### Gaps
- No usage statistics on how many servers or clients have actually moved to 2026-07-28.
- Could not verify whether Codex, Gemini or VS Code show `outputSchema`/`structuredContent` or `content` to the model when both are present. Only Codex's behaviour is known, and it is [R].

---

## 4. Evidence on tool adoption and tool design: what increases correct tool use, what causes overuse or misuse, and which output formats work

### Takeaway
The evidence consistently shows **under-adoption by default**:
- MCPGAUGE: MCP integration lowered accuracy by 9.5% on average, with a "cognitive warm-up" of poor tool invocation in early turns.
- Anthropic's own eval docs: "Δ near zero… Claude isn't choosing your skill".
- Studies of real repositories: 2,853 repos, where hooks and MCP are the least adopted configuration mechanisms.
- Zed's docs: tool use "can vary from model to model".

What measurably helps:
- Fewer, non-overlapping tools (GitHub: +2–5 pp after cutting 40→13 tools).
- Retrieval or deferral of tool schemas.
- Explicit trigger conditions in descriptions and short workflow-style server instructions (MCP blog: GPT-5-mini 2/10→8/10).
- Integrated retrieval that the agent gets "for free" (Cursor semantic search: +12.5% accuracy on average).
- Deterministic hooks, per Anthropic's own advice when instructions don't stick.

What hurts:
- Bloated or overlapping toolsets, which lead to ignoring instructions and unnecessary calls.
- LLM-generated context files (ETH: −3% success, +20% cost).
- Long sessions, where instruction compliance decays about 5.6% per generated function.
- Imperative injected text, which can trip injection defenses.

On formats, compact line-oriented text with explicit counts, truncation and "no results" notices matches both the production harnesses and the benchmark evidence (details in the earlier notes).

### Cited Findings

**Under-adoption and overhead**
- **MCPGAUGE** ("Help or Hurdle?", arXiv 2508.12566):
  - Design: 160-prompt suite, 25 datasets, six commercial LLMs, 30 MCP tool suites, one- and two-turn settings, ~20,000 API calls, >USD 6,000.
  - Four dimensions: proactivity, compliance, effectiveness, overhead.
  - "Integration of external context via MCP often leads to a performance degradation—averaging 9.5%". Models show a "cognitive warm-up" effect with "poor tool invocation in initial turns".
  - [R] Input tokens rose 3.25× to 236.5×, and models showed low proactivity without explicit instruction.

  — [arXiv 2508.12566](https://arxiv.org/abs/2508.12566) [V2]
- Anthropic's plugin-eval docs: "The most common first finding is a `Δ` near zero with the case's `tool_used: Skill` grader failing, which means Claude isn't choosing your skill on natural phrasing." The skills docs add that when a skill stops influencing behaviour, "the model is choosing other tools". — [Plugin evals](https://code.claude.com/docs/en/plugin-evals); [Skills](https://code.claude.com/docs/en/skills) [V]
- Zed docs: "How reliably MCP tools get called can vary from model to model. Mentioning the MCP server by name can help". To guarantee use, disable conflicting built-in tools in a profile. — [Zed mcp.md](https://github.com/zed-industries/zed/blob/main/docs/src/ai/mcp.md) [V]
- **Galster et al., "Configuring Agentic AI Coding Tools: An Exploratory Study"** (arXiv 2602.14690, ACM AIware '26):
  - 2,853 GitHub repositories; eight mechanisms (Context Files, Skills, Subagents, Commands, Rules, Settings, Hooks, MCP servers).
  - "Context Files dominate… often the sole mechanism", with AGENTS.md converging as the cross-tool standard. "Few repositories adopt advanced mechanisms such as Skills and Subagents". Hooks and MCP are adopted less frequently.
  - Claude Code users employ the broadest range of mechanisms.

  — [arXiv 2602.14690](https://arxiv.org/html/2602.14690v5) [V2]
- Serena needed a PreToolUse deny hook that fires after 3 greps or reads to push agents toward its symbolic tools. Its own README quotes an agent that "still lean[s] on built-ins for tiny text edits". This is a practitioner signal, not a measurement. — [serena hooks.py](https://github.com/oraios/serena/blob/main/src/serena/hooks.py); [README](https://github.com/oraios/serena) [V]

**What increases correct use**
- **GitHub Copilot, "smarter with fewer tools"** (Nov 2025):
  - The default built-in toolset went from 40 to 13 core tools, with embedding-guided tool routing and "virtual tool groups".
  - Success rose 2–5 percentage points (SWE-Lancer, SWE-bench Verified) and latency fell by 400 ms.
  - With the full toolset, "the agent ends up ignoring explicit instructions, using tools incorrectly, and calling tools that are unnecessary to the task".

  — [GitHub Blog](https://github.blog/ai-and-ml/github-copilot/how-were-making-github-copilot-smarter-with-fewer-tools/) [V2]
- **MCP blog on server instructions** (2025-11-03): 10 runs per cell in VS Code. GPT-5-mini went 8/10 with instructions vs 2/10 without; Claude Sonnet 4 went 9/10 vs 10/10; overall 17/20 vs 12/20. Guidance: "Don't write a manual"; use "deterministic rules or hooks" for critical actions. — [MCP blog](https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/) [R, V in earlier notes]
- Anthropic's 2026 guidance, in Claude Code's MCP docs: with tool search on, server instructions should say "What category of tasks your tools handle; When Claude should search for your tools; Key capabilities". The bundled API guidance adds: "On recent Opus models… trigger conditions in the description give measurable lift in should-call rate". Remove MUST/CRITICAL boosters, because "triggering boosters written against under-triggering models now cause over-triggering". — [MCP docs](https://code.claude.com/docs/en/mcp) [V]; earlier notes [R/V]
- Anthropic's numbers from the earlier notes [R]:
  - Tool search: 49→74% (Opus 4) and 79.5→88.1% (Opus 4.5) on MCP evals.
  - Tool-use examples: 72→90%.
  - Code execution with MCP: ~150K→~2K tokens (−98.7%).
  - Concise vs detailed responses: 72 vs 206 tokens.

  — [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use); [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents); [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- **Cursor semantic search** (Nov 2025): "on average 12.5% higher accuracy in answering questions (6.5%–23.5% depending on the model)" vs grep alone on "Cursor Context Bench". It also produced more-retained code changes and fewer user iterations. It is a vendor evaluation with an in-house embedding model. — [Cursor blog](https://cursor.com/blog/semsearch) [V2]
- **Codebase-Memory** paper (arXiv 2603.27277, authors of codebase-memory-mcp): across 31 real repositories, a knowledge graph served over MCP reached "83% answer quality, 10× fewer tokens, 2.1× fewer tool calls vs. file-by-file exploration". Five structural queries took "~3,400 tokens vs ~412,000" via grep and read. This is self-reported. — [README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md) [V]; [arXiv 2603.27277](https://arxiv.org/abs/2603.27277)
- "MCP Tool Descriptions Are Smelly!" (arXiv 2602.14878), from the earlier notes [R]: 97% of 856 tools had smells. Augmented descriptions gave +5.85 pp median success but ~67% more steps, and regressed in ~17% of cases. — [arXiv 2602.14878](https://arxiv.org/html/2602.14878v1)

**Instruction/context files**
- **ETH Zurich, "Evaluating AGENTS.md"** (Gloaguen et al., arXiv 2602.11988, Feb 2026):
  - "Providing context files does not generally improve task success rates, while increasing inference cost by over 20%".
  - Secondary summaries report −3% success for LLM-generated files and +4% for developer-written ones.
  - Conclusion: "human-written context files should describe only minimal requirements".
  - [R] Agents follow the files' instructions, which broadens exploration and testing.
  - The model list in secondary summaries (Sonnet 4.5, GPT-4.1, o4-mini, Qwen 3) is unverified.

  — [arXiv 2602.11988](https://arxiv.org/abs/2602.11988); [InfoQ](https://infoq.com/news/2026/03/agents-context-file-value-review/) [V2]
- **McMillan, "Instruction Adherence in Coding Agent Configuration Files"** (arXiv 2605.10039, May 2026):
  - 1,650 Claude Code sessions and 16,050 function-level observations; mostly Sonnet 4.6, with Opus 4.6 and 4.7.
  - File size (25–500 lines), instruction position, architecture and conflicting instructions had no detectable effect after correction.
  - Within a session, "each additional function the agent generates is associated with approximately 5.6% lower odds of compliance per step (OR = 0.944)".

  — [arXiv 2605.10039](https://arxiv.org/abs/2605.10039) [V2]
- Claude Code docs: "target under 200 lines per CLAUDE.md… Longer files… reduce adherence". Hook text should be "factual statements rather than imperative system instructions", because out-of-band commands "can trigger Claude's prompt-injection defenses". — [Memory](https://code.claude.com/docs/en/memory); [Hooks reference](https://code.claude.com/docs/en/hooks) [V]

**Selection errors and misuse in MCP benchmarks**
- **MCPMark** (arXiv 2509.24002):
  - 127 CRUD-heavy tasks on 5 MCP servers, more than 30 models.
  - Best result: gpt-5-medium at 52.6% pass@1 and 33.9% pass^4. claude-sonnet-4 and o3 score below 30% pass@1 and below 15% pass^4.
  - Averages of 16.2 turns and 17.4 tool calls per task.
  - Failures split into implicit ones (task finished but wrong) and explicit ones (context overflow, turn limit, abandoned runs, premature stop, malformed calls).

  — [arXiv 2509.24002](https://arxiv.org/pdf/2509.24002); [MCPMark leaderboard](https://mcpmark.ai/leaderboard) [V2]
- From the earlier notes [R]:
  - MCP-Universe (GPT-5 43.72%) names "long-context" and "unknown-tools" challenges.
  - LiveMCPBench: 95 tasks, 527 tools, Claude Sonnet 4 ~78.95%.
  - MCP-Bench: 28 servers/250 tools; models struggle when instructions don't name tools.
  - RAG-MCP: selection 13.62%→43.13% with retrieval.

  — [arXiv 2508.14704](https://arxiv.org/abs/2508.14704); [arXiv 2508.01780](https://arxiv.org/abs/2508.01780); [arXiv 2508.20453](https://arxiv.org/abs/2508.20453); [arXiv 2505.03275](https://arxiv.org/abs/2505.03275)

**Output formats: production conventions (new) plus earlier evidence**
- Claude Code built-in conventions [V]:
  - Grep defaults to a file list (`files_with_matches`).
  - `content` mode shows "matching lines with file and line number".
  - An explicit "`No entries at this offset`" message keeps the model from concluding there are no matches.
  - Invalid patterns return the ripgrep diagnostic instead of "No files found" (fixed in v2.1.208).
  - Glob caps at 100 files "with a truncation flag".
  - Read is line-numbered and returns a "`PARTIAL view` notice" telling Claude how to page with `offset`/`limit`.
  - Empty files get an explicit notice.

  — [Tools reference](https://code.claude.com/docs/en/tools-reference)
- Client truncation thresholds that outputs must stay under:

  | Client | Threshold |
  |---|---|
  | Claude Code MCP | warning above 10,000 tokens, limit 25,000 tokens, persist to file above 50K chars [R] |
  | Claude Code hook `additionalContext` | above 10,000 chars → file plus 2,000-char preview |
  | Codex | 10,000 tokens |
  | Gemini CLI | 40,000 chars truncation threshold; 10,000-token distillation |

  — [MCP docs](https://code.claude.com/docs/en/mcp); [Hooks reference](https://code.claude.com/docs/en/hooks); [Codex models.json](https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json); [Gemini configuration.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md) [V]
- From the earlier notes [R/V]:
  - Formats (JSON/YAML/XML/TOON) show near-flat accuracy but large token differences: pretty JSON is ~1.5–1.7× compact.
  - SWE-agent: a 100-line window works best, and search should list files rather than show context.
  - Anthropic: avoid JSON-escaped code and line counting.
  - Codex shows `structuredContent` to the model when present.

### Inferences
- **Default adoption will be low without help.** Graph-indexer should combine:
  1. a ≤2 KB "when to search/use" server instruction
  2. 5–7 non-overlapping, keyword-rich tools (consolidation from the earlier notes)
  3. hooks that bring graph facts to the agent inside its existing grep/read loop, rather than hoping it calls the tools itself (the "for free" integration Cursor measured)
  4. a small, human-written AGENTS.md/CLAUDE.md pointer, not a generated manual
- **Avoid MUST/IMPORTANT prose in every channel.** Serena's SessionStart text is exactly what Anthropic's hook docs warn against.
- **Measure with a WITH/W/OUT harness** (`claude plugin eval`, or an equivalent for Codex/Gemini). Track should-call rate, over-call rate, tokens and success, because richer descriptions can raise step counts (the "smelly" study) and forced deny nudges can add turns.
- **Keep hook-injected context tiny** (≤1–2K chars), factual and pointer-rich (`path:line`, symbol, counts, the tool to call next). Keep tool outputs compact, with explicit totals, truncation and empty notices, under the lowest common threshold (~10K tokens, Codex).

### Gaps
- No controlled study measures adoption of code-intelligence MCP tools (vs built-in grep and read) in Claude Code, Codex or Cursor, or the effect of adoption hooks (augment vs deny-nudge) on success, tokens or turns.
- MCPGAUGE, ETH, McMillan, MCPMark, GitHub and Cursor figures come from search summaries or abstracts. The PDFs could not be fetched, so their exact tables are unverified.
- "Notation Matters: A Benchmark Study of Token-Optimized Formats in Agentic AI Systems" (arXiv 2605.29676) appeared in search but was not read. It is a lead for format evidence.

---

## 5. What "grep and graph integrated" looks like in practice today

### Takeaway
In 2026 the working pattern is **hook-level augmentation of the agent's own search calls**. The agent keeps its built-in grep/find/read habit. A fast (≤0.3–0.5 s), fail-open hook looks up the pattern in the code graph and attaches a few lines of symbol facts next to the grep result: definition location, top callers and callees, process membership. A post-edit or post-git hook flags index staleness.

GitNexus (Claude Code and Cursor) and codebase-memory-mcp (Claude Code, Gemini, OpenCode and others) ship this. Serena instead nudges by denying repeated greps.

Complementary patterns:
- IDE-style find-usages exposed as a tool: Claude Code's LSP tool with references, call hierarchy and post-edit diagnostics.
- Programmatic re-routing of a tool call: Gemini `tailToolCallRequest`.
- Output rewriting: Claude Code `updatedToolOutput`.
- Always-on semantic retrieval inside the agent: Cursor.

### Cited Findings
- **GitNexus** [V]:
  - PreToolUse on `Grep|Glob|Bash` extracts the search pattern, skipping those under 3 chars, and runs `gitnexus augment -- <pattern>`.
  - Status message: "Enriching with GitNexus graph context...".
  - The engine uses "only BM25 search (no semantic/embedding) for speed". Output "is pure relationships: callers, callees, process participation": the top 5 symbols, 3 neighbours each. "Graceful failure: any error → return empty string".
  - If the DB is locked, it falls back to an `additionalContext` hint to run the MCP `search_query` instead.
  - PostToolUse on `Bash`: "Checking GitNexus index freshness..." after git mutations.
  - The Cursor variant uses `postToolUse` on `Shell|Read|Grep`.

  — [gitnexus-claude-plugin/hooks](https://github.com/abhigyanpatwari/GitNexus/tree/main/gitnexus-claude-plugin/hooks); [augmentation engine](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/src/core/augmentation/engine.ts); [Cursor integration](https://github.com/abhigyanpatwari/GitNexus/tree/main/gitnexus-cursor-integration)
- **codebase-memory-mcp** [V]:
  - `hook-augment` is "a non-blocking lifecycle, search, and post-read context augmenter". It emits "graph symbols for supported searches, tier routing at lifecycle boundaries, and targeted index-coverage warnings after supported file reads".
  - It uses `search_graph` ("pure SQLite, shell-free") rather than `search_code` (grep|xargs) "so the hook stays cheap enough to run before every Grep/Glob/Bash call".
  - Limits: `HA_DEADLINE_MS 300`, `HA_RESULT_LIMIT 5`, `HA_MIN_TOKEN 4`.
  - Coverage per agent:

    | Agent | Hooks installed |
    |---|---|
    | Claude Code | SessionStart, SubagentStart, PreToolUse on Grep/Glob/Bash, post-Read coverage |
    | Codex | SessionStart and SubagentStart only |
    | Gemini | BeforeTool, AfterTool `read_file` coverage, SessionStart |
    | OpenCode | plugin with grep/glob graph lookup and post-compaction reinjection |

  — [hook_augment.c](https://github.com/DeusData/codebase-memory-mcp/blob/main/src/cli/hook_augment.c); [README](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)
- **Serena** [V]:
  - Serena's own grep-like `search_for_pattern` sits alongside symbolic tools (`find_symbol`, references, `replace_symbol_body`, `rename_symbol`).
  - Its hooks do not annotate grep output. They count grep and read calls, and deny the fourth mixed or third same-kind call with a reminder to use the symbolic tools.

  — [serena hooks.py](https://github.com/oraios/serena/blob/main/src/serena/hooks.py); [clients docs](https://github.com/oraios/serena/blob/main/docs/02-usage/030_clients.md)
- **Claude Code LSP tool** [V]: IDE-style definition, references, hover, document/workspace symbols, implementations and call hierarchy exposed as a model tool. Diagnostics are pushed "After each file edit". It needs a per-language plugin (12 official LSP plugins). — [Tools reference](https://code.claude.com/docs/en/tools-reference); [claude-plugins-official](https://github.com/anthropics/claude-plugins-official)
- **Gemini CLI `AfterTool.tailToolCallRequest`** [V]: "A request to execute another tool immediately after this one. The result of this 'tail call' will replace the original tool's response. Ideal for programmatic tool routing." Example: after a `grep_search`, call `mcp_graph_find_references`. — [Gemini hooks reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md)
- **Claude Code `updatedToolOutput`** (v2.1.121+) [V]:
  - It can replace a Bash grep's `stdout` with an annotated version. The value must keep the Bash output shape `{stdout, stderr, interrupted, isImage}`, or it is ignored.
  - `PostToolBatch` can add one combined `additionalContext` after several parallel greps or reads.
  - Anthropic warns: "Stripping error details that Claude needs can cause it to proceed on a false assumption."

  — [Hooks reference](https://code.claude.com/docs/en/hooks)
- **Cursor**: semantic search is built into the agent. Cursor measured +12.5% average QA accuracy over grep alone, which is evidence for "graph/semantic retrieval integrated into the loop" rather than an optional separate tool. — [Cursor blog](https://cursor.com/blog/semsearch) [V2]
- **Search tool names per agent** [V]:

  | Agent | Search tools the hooks see |
  |---|---|
  | Claude Code native (macOS/Linux/WSL) | `Bash` running embedded `grep`=ugrep and `find`=bfs |
  | Claude Code npm/Windows | `Grep`/`Glob` |
  | Codex | `Bash` (shell/`exec_command`) |
  | Gemini | `grep_search`, `run_shell_command` |
  | Cursor | `Grep`, `Shell` |

  — [Tools reference](https://code.claude.com/docs/en/tools-reference); [Codex hook_names.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/hook_names.rs); [Gemini tools](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/tools.md); [GitNexus Cursor hooks.json](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus-cursor-integration/hooks/hooks.json)

### Inferences
Recommended "grep + graph" design for graph-indexer. Each point extrapolates from the implementations above, not from a measured result:

1. **A `graph-indexer hook` CLI subcommand.**
   - Reads the vendor payload.
   - Recognises grep/rg/ugrep/find/`grep_search`/`Grep` patterns, extracting identifier-like tokens of at least 4 chars.
   - Queries the local index under a hard ~300 ms deadline.
   - On success, prints ≤1–2K chars of factual context, e.g. `Symbol parseConfig — def src/cfg.ts:41 (function); 12 callers (top: loadApp src/app.ts:88, …); graph-indexer find_references/call_graph give the full list.`
   - Prints nothing on any miss or error (fail-open, never deny).
2. **Post-edit and post-git freshness hooks.** On Edit/Write/apply_patch, and on Bash git checkout/merge/rebase, trigger an incremental reindex, or inject "index stale for N files" as a fact.
3. **SessionStart and SubagentStart** injecting a one-line index status and capability statement. This is the only reliable way to reach Claude's Explore/Plan agents, which skip CLAUDE.md.
4. **Output rewriting (`updatedToolOutput`) or Gemini tail calls as opt-in modes only.** They are more intrusive, and a wrong annotation corrupts the agent's view of search results.
5. **An MCP tool mirroring the hook** (`augment_search`) so `mcp_tool` hooks in Claude Code and Codex can call the server directly. Keep the CLI path for launch-time SessionStart.
6. **Evaluate augmentation vs no-augmentation vs deny-nudge** on the same task set before shipping a default. No public data exists.

### Gaps
- No public measurement of grep-augmentation hooks (GitNexus or codebase-memory) on success rate, tokens or tool-call counts. The Codebase-Memory paper measures MCP graph queries vs file-by-file exploration, not the hooks.
- Unknown how often augmentation context is ignored, or misleads when the pattern is not a symbol (log strings, config keys).
- Cursor's `additional_context` delivery bug and Windsurf's informational post-hooks may make hook augmentation ineffective on those clients. This was not verified.
