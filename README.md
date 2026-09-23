<div align="center">
  <img src="https://raw.githubusercontent.com/MaquinaTech/graph-indexer/main/assets/logo.jpg" alt="Graph Indexer Logo" width="250" />

  <h1>Graph Indexer</h1>

  <p>
    <em>A live code graph and search engine for AI coding agents, served locally over MCP.</em>
  </p>

  <a href="https://www.npmjs.com/package/graph-indexer"><img src="https://img.shields.io/npm/v/graph-indexer?color=007acc&style=for-the-badge" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/graph-indexer"><img src="https://img.shields.io/npm/dt/graph-indexer?color=4caf50&style=for-the-badge" alt="NPM Downloads"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.5-brightgreen?style=for-the-badge&logo=nodedotjs" alt="Node.js 22.5+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge" alt="License: MIT"></a>
</div>

<br />

## What it does

Graph Indexer parses your repository with tree-sitter and keeps a structural index of it:
every definition, every reference bound to the definition it actually points at, the call
graph, inheritance, imports, and which tests exercise what. Coding agents (Claude Code,
Cursor, VS Code Copilot, Codex, Gemini CLI, …) query it through six
[Model Context Protocol](https://modelcontextprotocol.io) tools instead of reading whole files
and grepping.

- **Answers are exact, not guesses.** `find_references` binds each use through scopes,
  imports and inferred receiver types, so it lists the callers of *this* `get` and not of every
  method named `get`. Measured against the TypeScript compiler it finds 89% of the real
  references at 98% precision; grep finds all of them buried among seven times as many false hits.
- **Answers are never stale.** The index re-syncs with the files on disk before every answer,
  including edits the agent made a second ago, so line numbers and call graphs are current.
- **Answers are small.** A tool reply is typically 400–1,500 tokens: the right function with
  line numbers, not a 2,000-line file.
- **Nothing to set up.** Zero dependencies, no native builds, no model downloads, no network,
  no daemon. The tree-sitter runtime and 16 grammars ship as WebAssembly inside the package.

## Quick start

Requires **Node.js 22.5+** (for the built-in `node:sqlite`).

```bash
cd your-repo
npx graph-indexer init      # wires the MCP server into the agents it detects
npx graph-indexer index     # optional: build the index now (the server also does it on start)
```

`init` writes project-level MCP configuration for the agents it finds (`.mcp.json` for Claude
Code, `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, and prints the Codex TOML),
merges instead of overwriting other servers, adds `.graph-indexer/` to `.gitignore`, and adds
a five-line block to `CLAUDE.md` / `AGENTS.md` telling the agent when to use which tool. Flags:
`--agents claude,cursor,vscode,gemini,codex`, `--all`, `--local` (use this checkout instead of
`npx`), `--dry-run`, `--no-instructions`.

<details>
<summary>Manual configuration</summary>

Any MCP client can run the server over stdio:

```json
{
  "mcpServers": {
    "graph-indexer": { "command": "npx", "args": ["-y", "graph-indexer@3", "serve", "--repo", "/path/to/repo"] }
  }
}
```

VS Code uses `"servers"` instead of `"mcpServers"` and `"type": "stdio"`. Codex CLI
(`~/.codex/config.toml`):

```toml
[mcp_servers.graph-indexer]
command = "npx"
args = ["-y", "graph-indexer@3", "serve", "--repo", "/path/to/repo"]
```

Without `--repo` the server indexes the git repository containing its working directory
(`GRAPH_INDEXER_REPO` also works).
</details>

## The tools

| Tool | Use it to | Typical reply |
|---|---|---|
| `search_code` | find where a behaviour or identifier lives (natural language or names) | ranked symbols with location, signature, doc line and matching lines |
| `get_symbol` | read one definition instead of a whole file | code with line numbers, members, what it calls, who uses it |
| `find_references` | see every use before renaming or changing a signature | uses grouped by file, enclosing function, confidence, calls through base types marked |
| `call_graph` | trace callers and callees across files | a tree with locations and confidence |
| `change_impact` | get the blast radius of a change, or of your uncommitted diff | transitive dependents by distance, tests to run, co-changed files, risk |
| `outline` | see a file's structure, or a ranked map of a directory or the repo | signatures and line ranges within a token budget |

All tools are read-only. Replies are plain text, capped, best result first, and end with a hint
for the next step. Example, on [gin](https://github.com/gin-gonic/gin):

```text
> search_code("where are trusted proxies checked")
3 results for "where are trusted proxies checked" (of 55 candidates):
1. Engine.isTrustedProxy — method · gin.go:445-455
   func (engine *Engine) isTrustedProxy(ip net.IP) bool
   isTrustedProxy will check whether the IP address is included in the trusted list according to Engine.trustedCIDRs
   446: if engine.trustedCIDRs == nil {
   449: for _, cidr := range engine.trustedCIDRs {
2. Engine.isUnsafeTrustedProxies — method · gin.go:433-435
…

> change_impact(symbols: ["Engine.isTrustedProxy"], depth: 2)
Impact of changing Engine.isTrustedProxy
dependents: 9 symbols in 3 files (non-test)
  distance 1 (3):
    Context.ClientIP  context.go:771-806
    Engine.isUnsafeTrustedProxies  gin.go:433-435
    Engine.validateHeader  gin.go:458-477
  distance 2 (6):
    LoggerWithConfig  logger.go:203-270  [high]
    Engine.Run  gin.go:376-388  [high]
…
tests to run (1 file):
    context_test.go: TestRemoteIPFail, TestContextClientIP
often changed together (git): context.go (14/42), context_test.go (10/42), …
risk: medium (9 dependents, 1 test files)
```

Every reference carries a confidence: **exact/high** means it was bound through a scope,
import or inferred receiver type; **likely/possible** means only the name matched. Footers
report same-name call sites that could not be bound, so an agent knows when to double-check
with grep.

## Measured results

All numbers come from scripts in [`bench/`](bench) on public repositories pinned to exact
commits; [docs/BENCHMARKS.md](docs/BENCHMARKS.md) has the methodology and how to reproduce them.

**References vs the TypeScript compiler.** For 400 randomly sampled functions, methods, classes
and interfaces of nestjs, the references each system reports are compared with the compiler's
own `findReferences` (import lines and declarations excluded):

| | precision | recall | F1 |
|---|---|---|---|
| graph-indexer `find_references` | **0.996** | **0.958** | **0.977** |
| same-name references (no binding) | 0.251 | 0.974 | 0.400 |
| grep for the name | 0.128 | 0.993 | 0.227 |

*Dispatch semantics: calls through a base class or interface count, calls to sibling overrides
do not. Against the compiler's full rename set (sibling overrides included) recall is 0.922. The
fixture has no `node_modules`, so library-typed values are invisible to the compiler: precision is
a lower bound.*

**Localization from real commits.** 169 focused commits of five repositories are replayed: the
commit subject is the query, the files and functions it changed are the answer, and the index is
rolled back to the parent commit first.

| | file Acc@1 | file Acc@5 | function Acc@5 | function MRR@10 |
|---|---|---|---|---|
| graph-indexer `search_code` | **0.544** | **0.805** | **0.528** | **0.432** |
| grep, files ranked by idf-weighted hits | 0.485 | 0.769 | 0.514 | 0.374 |
| BM25 over the same index | 0.373 | 0.722 | 0.401 | 0.290 |

**Symbol search.** 377 hand-written queries over nine repositories in eight languages, scored
strictly at symbol level: rank-1 0.700 and MRR 0.759, against 0.552 and 0.646 for graph-indexer
2.x on the same queries. On the 169 held-out queries (never used for tuning) MRR is 0.773 vs 0.632.

**Agents.** In a small paired test with the same model, agents with and without graph-indexer
answered five questions equally well; on the multi-hop impact question the graph-indexer agent
needed 20 tool calls instead of 44. On single-location questions grep alone was as good and
slightly cheaper. Details in [docs/BENCHMARKS.md](docs/BENCHMARKS.md#4-agents-with-and-without-graph-indexer).

**Speed.** A full index of nestjs (1,641 files, 96k lines) takes 3.7 s; afterwards only changed
files are re-parsed. Warm tool calls take 1–4 ms for the graph tools, about 30 ms for search and
18 ms for a repository outline.

## How it works

1. **Parse.** tree-sitter (WebAssembly) with one query per language extracts definitions,
   references (calls, instantiations, types, inheritance, decorators, values, member reads),
   imports and type evidence.
2. **Infer types locally.** Receiver types come from annotations, initialisers, `new`/casts,
   return types (declared or inferred from `return` statements), fields and constructor-injected
   dependencies, collections (`xs[i]`, `for x of xs`, `xs.forEach(x => …)`, `list.get(0)`),
   optionals and wrappers (`Foo | undefined`, `Optional[Foo]`, `Promise<Foo>`, `Arc<Mutex<Foo>>`),
   across closures and access chains.
3. **Resolve.** Each reference is bound by a ladder: lexical scope → enclosing type and its
   bases → same file → explicit import (barrels, tsconfig paths, workspaces, Go modules, Python
   packages, Rust crates, C includes) → package → global, and labelled with a confidence.
4. **Store.** SQLite (WAL) with per-file ownership of facts, stable symbol ids across edits,
   FTS5 indexes over symbols and files. The index rebuilds itself when graph-indexer is upgraded.
5. **Stay fresh.** A file watcher plus periodic stat sweeps re-index changed files before any
   answer, and files are re-validated right before their lines are rendered.
6. **Rank.** Search fuses exact/qualified name matches, BM25F over name, signature, doc, path and
   body, file-level relevance and a small concept thesaurus, then applies interpretable priors
   and PageRank centrality. Weights were tuned on a tuning split only.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes each part in detail.

## Languages

JavaScript, TypeScript/TSX, Python, Go, Java, Kotlin, Scala, C#, Rust, C, C++, Ruby, PHP, Bash
and CSS/SCSS/Less. Reference binding and type inference are deepest for TypeScript/JavaScript,
Python, Go, Java, C# and Rust.

## Command line

The CLI runs the same tools, which is handy for scripts and for checking what an agent sees:

```text
graph-indexer init [--repo DIR] [--agents …] [--all] [--local] [--dry-run] [--no-instructions]
graph-indexer serve [--repo DIR]            MCP server on stdio
graph-indexer index [--repo DIR]            build or update the index
graph-indexer status [--repo DIR]
graph-indexer search <query> [--path P] [--kind K] [--limit N]
graph-indexer symbol <name> [--no-code]
graph-indexer refs <name> [--kind call|type|inherit|new|value|decorator] [--no-tests]
graph-indexer callgraph <name> [--direction callers|callees|both] [--depth N]
graph-indexer impact [--symbols a,b] [--files x,y] [--diff] [--depth N]
graph-indexer outline [path] [--focus TEXT] [--max-tokens N]
```

The index lives in `<repo>/.graph-indexer/` (git-ignored). It contains excerpts of your code, so
treat it like the repository itself.

## Privacy and security

Everything runs locally. graph-indexer makes no network calls, runs no code from the repository
it indexes (the only subprocesses are read-only git commands: `rev-parse`, `ls-files`, `diff`
and `log`), talks
to the agent over stdio only, and never reads outside the repository: tool paths are resolved
through the index, and symlinks pointing outside the repository are ignored. See
[SECURITY.md](SECURITY.md).

## Upgrading from 2.x

Version 3 is a rewrite; see the [changelog](CHANGELOG.md). In short: the tools changed
(`search_code`, `get_symbol`, `find_references`, `call_graph`, `change_impact`, `outline`), the
embedding, Ollama, reranker and daemon options are gone (search is lexical plus graph and needs
no model), grammars are bundled instead of installed on first use, and Node.js 22.5+ is required.
Re-run `npx graph-indexer init` to update agent configuration; old `.graph-indexer/` contents are
replaced automatically.

## License

[MIT](LICENSE). "graph-indexer" and the logo are trademarks of MaquinaTech; see
[TRADEMARK.md](TRADEMARK.md).
