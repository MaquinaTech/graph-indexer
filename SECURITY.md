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

- **No network.** graph-indexer makes no outbound connections: no telemetry, no model
  downloads, no grammar installs. The tree-sitter runtime and all grammars ship inside the
  package as WebAssembly (versions and SHA-256 checksums in `vendor/grammars/manifest.json`),
  so there is no install-time or first-run download and no native build step.
- **No dependencies.** The package has no npm dependencies; it uses only Node.js built-ins
  (`node:sqlite`, `node:fs`, `node:child_process`, …) and the vendored WebAssembly runtime.
- **No code execution.** Source files are parsed into syntax trees; the indexed code is never
  imported, evaluated or run. The only subprocesses are read-only git commands
  (`git rev-parse`, `git ls-files`, `git diff`, `git log`, `git show`) run in the indexed repository
  with fixed arguments. The only tool input they take is the `base` revision of `check_changes`,
  which is refused when git could read it as an option. Every git call switches off what the
  repository's own git config could run: `core.fsmonitor`, hooks, signature verification,
  clean/smudge/process filters, `diff.external` and textconv drivers.
- **No code from the repository through npx.** Every `npx` command graph-indexer runs or writes into
  an agent's configuration passes `--prefix`, so a `node_modules/graph-indexer` that the repository
  ships is never run in place of the published package.
- **Stays inside the repository.** Only files listed by git (or found by a `.gitignore`-aware
  walk) under the repository root are indexed. Symlinks are followed only when their target
  resolves inside the repository, so a link to a file elsewhere on the machine is never read,
  indexed or served. Paths given to the tools (`read_code "file.ts:42"`, `outline`,
  `change_impact`) are resolved (`..` and symbolic links) and must stay inside the repository;
  `.git/` and `.graph-indexer/` are never served. Manifests (`package.json`, `tsconfig.json`,
  `go.mod`) are read only as small regular files inside the repository.
- **Bounded work.** A regular expression given to `search_text` runs under a 5 s budget, and a file
  whose syntax makes the structural queries super-linear is given up after 15 s, so neither can
  block the server.
- **Read-only tools.** All MCP tools are read-only (`readOnlyHint: true`) and never modify
  the repository.
- **stdio transport.** The MCP server talks to the local client over stdin/stdout. It does not
  open a network socket.
- **Local socket for hooks and the CLI.** The MCP server, or `graph-indexer daemon` started by the
  hooks, also answers hook and CLI queries over a Unix domain socket (a named pipe on Windows),
  never TCP. The socket lives in `<repo>/.graph-indexer/` with mode 0600; when that path is too
  long for a socket, in a per-user directory in the temp dir with mode 0700 whose owner and mode
  both sides check before using it. It answers the same read-only queries as the CLI.
  `GRAPH_INDEXER_RESIDENT=0` disables it.
- **Local artifacts.** The index is a SQLite database in `<repo>/.graph-indexer/` (git-ignored by
  `init`, mode 0700; a `.graph-indexer` that is a symbolic link is refused). It contains excerpts of your source code — treat it with the same sensitivity as the
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
