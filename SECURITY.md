# Security Policy

## Reporting a vulnerability

We take the security and privacy of this project seriously. If you discover a
security vulnerability, please do **not** open a public issue. Instead, report it
privately by emailing the maintainer at **nicolopezdelerma@gmail.com**.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal proof of concept if possible).
- The affected version (`graph-indexer status` prints it, or see the `version` field in `package.json`).

You can expect an initial acknowledgement within **5 business days**. Coordinated
disclosure is appreciated — we will work with you on a fix and credit before any
public discussion.

## Supported versions

Security fixes are applied to the latest published `3.x` release. Older versions
are not maintained; please upgrade to the latest version.

## Security posture

graph-indexer is a local developer tool. Its threat model follows from a few deliberate choices:

- **No network.** graph-indexer makes no outbound connections: no telemetry, no grammar
  installs. The tree-sitter runtime and all grammars ship inside the package as WebAssembly
  (versions and SHA-256 checksums in `vendor/grammars/manifest.json`), so there is no install-time
  or first-run download and no native build step. The one exception is explicit and opt-in:
  `graph-indexer semantic install` downloads the optional embedding model from huggingface.co at a
  pinned revision and installs it only if every file's SHA-256 matches the digest in the source.
- **No dependencies.** The package has no npm dependencies; it uses only Node.js built-ins
  (`node:sqlite`, `node:fs`, `node:child_process`, …) and the vendored WebAssembly runtime.
- **No code execution.** Source files are parsed into syntax trees; the indexed code is never
  imported, evaluated or run. The only subprocesses are read-only git commands
  (`git rev-parse`, `git ls-files`, `git status`, `git diff`, `git log`, `git show`) run in the
  indexed repository with fixed arguments, all through one function (`src/util/git.mjs`). The only
  tool input they take is the `base` revision of `check_changes`, which is refused when git could
  read it as an option. Every git call switches off what the repository's own git config could
  run: `core.fsmonitor`, hooks, signature verification, clean/smudge/process filters, `diff.external`
  and textconv drivers. The overrides are passed through git's environment (`GIT_CONFIG_COUNT`), which
  holds any driver name verbatim, including one containing `=`; with a git older than 2.31 that
  cannot, a repository naming such a driver gets no git call at all. git does not descend into
  submodules (`--ignore-submodules=all`), whose own config the overrides do not cover. On Windows,
  `git` and `npx` are looked up on PATH only, never in the repository (the working directory).
- **No code from the repository through npx.** Every `npx` command graph-indexer runs or writes into
  an agent's configuration passes `--prefix`, so a `node_modules/graph-indexer` that the repository
  ships is never run in place of the published package.
- **Stays inside the repository.** Only files listed by git (or found by a `.gitignore`-aware
  walk) under the repository root are indexed. Every component of a file's path is resolved, so
  neither a symbolic link to a file elsewhere on the machine nor a file under a linked directory is
  read, indexed or served; devices and FIFOs are skipped. Paths given to the tools
  (`read_code "file.ts:42"`, `outline`, `change_impact`) are resolved the same way and must stay
  inside the repository; `.git/` and `.graph-indexer/` are never served, in any letter case on a
  case-insensitive file system. Manifests and other files read outside the index (`package.json`,
  `tsconfig.json`, `go.mod`, `Cargo.toml`, `svelte.config.*`, `pom.xml`, `build.gradle`, `.gitignore`,
  Prisma schemas, migrations) are read only as small regular files inside the repository.
- **Bounded work.** A regular expression given to `search_text` and a glob given to `find_files`
  run under a 5 s budget, `.gitignore` patterns are matched without backtracking, `search_text`
  annotates at most 50,000 matching lines, and a file whose syntax makes the structural queries
  super-linear is given up after 15 s, so none of them can block the server. Tool arguments are held
  to the bounds their schema declares (depths, limits, list lengths) whatever the client sends.
- **Read-only tools.** All MCP tools are read-only (`readOnlyHint: true`) and never modify
  the repository.
- **stdio transport.** The MCP server talks to the local client over stdin/stdout. It does not
  open a network socket.
- **Local socket for hooks and the CLI.** The MCP server, or `graph-indexer daemon` started by the
  hooks, also answers hook and CLI queries over a Unix domain socket (a named pipe on Windows),
  never TCP. The socket lives in `<repo>/.graph-indexer/` with mode 0600; when that path is too
  long for a socket, in a per-user directory in the temp dir with mode 0700 whose owner and mode
  both sides check before using it. On Windows the pipe's name carries a random id that each
  resident writes to `.graph-indexer/`, so another user of the machine cannot create the pipe first
  and answer in its place. It answers the same read-only queries as the CLI.
  `GRAPH_INDEXER_RESIDENT=0` disables it.
- **Local artifacts.** The index is a SQLite database in `<repo>/.graph-indexer/` (git-ignored by
  `init`, mode 0700; a `.graph-indexer` that is a symbolic link is refused, symbolic links inside it
  are removed before anything is written there, and an index committed to the repository is not
  opened). It contains excerpts of your source code — treat it with the same sensitivity as the
  repository itself and do not commit or share it. Deleting the directory is always safe; it is
  rebuilt on the next run.

## Runtime

graph-indexer runs in the Node.js the user installs. It requires a release that includes the
October 2026 Node.js security fixes (22.23.4+, 24.22.1+ or 26.12.1+; CVE-2026-111497 and others).
Keep Node.js updated to the latest patch release of a supported line.

## Operational guidance

- Run the server only on repositories you trust and intend to index.
- Keep secrets out of indexed source files (graph-indexer indexes what git tracks or what a
  `.gitignore`-aware walk finds; ignored paths, `node_modules`, build output and dot-directories
  are skipped).
