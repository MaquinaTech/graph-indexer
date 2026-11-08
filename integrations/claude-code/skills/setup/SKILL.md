---
name: setup
description: Connect graph-indexer's MCP server to this repository so Claude Code can use exact references, call graphs and change impact. Use when the user installs this plugin, or when the graph-indexer tools (find_references, call_graph, change_impact) are not available.
---
# Connect graph-indexer

This plugin brings the `code-structure` sub-agent and these instructions. The graph-indexer tools
come from a local MCP server that the user adds to the repository once. The plugin directory does not
allow plugins to start local programs, so the user must approve this step.

1. Check that Node.js 22.23.4+, 24.22.1+ or 26.12.1+ is installed (`node --version`).
2. Ask the user to confirm, then run from the repository root:

   ```bash
   claude mcp add graph-indexer -- npx -y --prefix / graph-indexer@3.0.2 serve
   ```

   `--prefix /` makes npx run only the published package, never a copy shipped inside the repository.
   The version is pinned on purpose: update it by hand when a newer graph-indexer is released.

3. Optional, with the user's consent: `npx -y --prefix / graph-indexer@3.0.2 init --hooks` also writes the
   Claude Code hooks (an edit check after each edit, grep disambiguation) to `.claude/settings.json`.
4. Restart Claude Code, or run `/mcp`, and confirm `graph-indexer` is connected.

Then use `find_references`, `call_graph`, `change_impact`, `read_code` and `check_changes`, or delegate
structural questions to the `code-structure` sub-agent.
