# graph-indexer: full Claude Code plugin (manual install)

This folder is the plugin with everything wired in: the MCP server (`.mcp.json`), the hooks
(`hooks/`) and the `code-structure` sub-agent. The plugin directory lists only plugins made of
Markdown and JSON (see `../claude-code`), so this one is not listed there. To use it, copy the
folder or point a local marketplace at it. `npx -y --prefix / graph-indexer@3.1.1 init --hooks`
gives the same result without a plugin.

Each release must update the version in `.mcp.json`, `hooks/gi-hook.mjs` and
`.claude-plugin/plugin.json`; `test/plugin-pins.test.mjs` checks that they equal `package.json`.
