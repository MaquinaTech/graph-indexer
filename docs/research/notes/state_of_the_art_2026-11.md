# State of the art in code intelligence for agents, November 2026

Web research done on 2026-11-09 for [REPLANTEAMIENTO-2026-11.md](../../REPLANTEAMIENTO-2026-11.md).
Read directly: the Codebase-Memory paper, the MCP 2026-07-28 announcement and the Claude Code tools
reference. Everything else is at the level of search results and summaries; the last section lists
what was not verified. Vendor figures are marked as such and are not evidence.

## Tools

| Tool | Approach | What it offers | What is published about it |
|---|---|---|---|
| Claude Code LSP tool | runs a language server the user installs, through code-intelligence plugins | definition, references, type info, document and workspace symbols, implementations, call hierarchy; type errors and warnings reported after each edit | inactive until a plugin and the server binary are installed; not active in cloud sessions (tools reference, "LSP tool behavior") |
| GitHub Copilot | `vscode_renameSymbol` and a usages tool in VS Code (v0.38, March 2026); language servers in Copilot CLI through `lsp.json` (June 2026); semantic code search for the cloud agent (March 2026) | rename through the language server | no precision figures |
| Serena | MCP server over language servers; optional JetBrains backend | find symbol, references, rename; with JetBrains also move and inline | its own evaluation is anecdotal; its documentation says its tools are typically disabled in harnesses that already have file and search tools |
| JetBrains IDE MCP server | built into IntelliJ 2025.2+ | `rename_refactoring`, `get_symbol_info`, `get_file_problems`, `build_project` | needs a running IDE |
| CodeGraph | local tree-sitter graph over MCP | close to graph-indexer's design | vendor: 35 % lower cost and 71 % fewer tool calls on average |
| codebase-memory-mcp | tree-sitter graph in SQLite, one C binary, 66 languages, 14 tools | fast indexing (Django in about 6 s) | paper (arXiv 2603.27277, March 2026; one repository per language, author-graded): quality 0.83 against 0.92 for an explorer with grep and read, about ten times fewer tokens; weakest on macro-heavy C (0.58 against 1.00); the explorer wins on exhaustive call sites |
| Augment Context Engine | proprietary index, an MCP server since February 2026 | — | vendor: 51.8 % on SWE-bench Pro against about 50.2 % for Cursor with the same model |
| Cursor | its own embedding model and semantic search | — | vendor: offline accuracy +12.5 % on average; online A/B +0.3 % code retention overall, +2.6 % on repositories of 1,000+ files (secondary source) |
| stack-graphs | GitHub's name-resolution framework | — | repository archived on 2025-09-09 |
| SCIP | index format | still emitted by scip-typescript, scip-java, scip-python, rust-analyzer | no 2026 status found |
| Type checkers as backends | pyrefly 1.0.0 (Meta, 2026-05-12); ty still in beta; TypeScript 7 (the native port) generally available around July 2026 | fast oracles | TypeScript 7's stable programmatic API not expected before 7.1 |

## Evidence

1. **Agents now ship with a language server.** Claude Code reports type errors after each edit
   with no build step, where a plugin and a server are installed. graph-indexer's `check_changes`
   overlaps that for those languages; what it adds is working with nothing installed, across
   languages, and what a language server does not answer in one call: the uses left behind by a
   removal or a rename, a method's family, the tests to run.
2. **A language server can hurt an agent.** AgentConnect (arXiv 2608.13568, September 2026, one
   author, preliminary): agents default to grep for tasks that name a symbol, results that are
   bare locations trigger extra file reads, and forcing semantic navigation first lowered success
   from 100 % to 89 % in one setting. Lesson for tool design: return the definition and a line of
   context for each reference, not positions.
3. **grep is hard to beat inside the right harness.** "Is Grep All You Need?" (arXiv 2605.15184,
   through secondary summaries): grep beats vector retrieval, but the effect depends on the harness;
   Claude Code favours grep.
4. **Graph tools save tokens; their accuracy is unproven.** The one paper with a baseline shows
   ten times fewer tokens at about 90 % of the quality of exploring with grep. No independent
   benchmark of silent regressions was found.
5. **Static test selection for agents is an open gap.** A 2025 survey (arXiv 2512.22256) says
   agent scaffolds pick regression tests by the model's judgement. TestPrune (arXiv 2510.18270)
   reports a 9–13 % relative gain in resolved tasks on SWE-bench Lite from running the tests that
   execute suspect methods. Class-level static selection is classic and mostly safe in Java
   (Legunsen et al. 2016), with reflection the main source of unsafety; no Python figures found.
6. **Agents are weak at multi-file refactoring.** CodeTaste (arXiv 2603.04177): agents follow
   detailed refactoring instructions but fail to choose refactorings. RefactorBench (ICLR 2025):
   100 tasks verified by AST tests. None measures an incomplete rename or signature change.
7. **MCP 2026-07-28**: a stateless core (no `initialize`, protocol version and capabilities in
   `_meta`), optional `server/discover`, `ttlMs` and `cacheScope` on list and read results,
   tasks moved to an extension; roots, sampling, logging and the old SSE transport deprecated.
   graph-indexer's server already serves it.
8. **Tool search is the default in Claude Code**: definitions are deferred and only names load;
   results over 10,000 tokens are warned about and cut at 25,000. A small tool set with names and
   descriptions written to be found is what matters.

## Not verified

- CodeGraph's and Codemesh's figures and method; CodeCompass's results (the PDF could not be read).
- AgentConnect's sample size and models, and the arXiv numbers 2605.15184, 2608.13568, 2608.27969,
  which come from search results.
- Cursor's large-repository figure; the SWE-bench Pro figures for Cursor, Codex and Claude Code.
- The exact date of TypeScript 7's general availability, and whether ty has reached 1.0.
- The plugin configuration format and parameter names of Claude Code's LSP tool.
- Whether tool annotations and `outputSchema` changed in the latest MCP revision.
- Not researched: Kiro, Zed, Codex, Gemini CLI, Greptile, Qodo, CodeRabbit, Joern, Kythe, Glean,
  CodeQL, Moatless, RepoGraph, Codanna, Continue, grepai, probe, claude-context, Repomix.
