# Security Policy

## Reporting a vulnerability

We take the security and privacy of this project seriously. If you discover a
security vulnerability, please do **not** open a public issue. Instead, report it
privately by emailing the maintainer at **nicolopezdelerma@gmail.com**.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal proof of concept if possible).
- The affected version (`graph-indexer --version` or the `version` field in `package.json`).

You can expect an initial acknowledgement within **5 business days**. Coordinated
disclosure is appreciated — we will work with you on a fix and credit before any
public discussion.

## Supported versions

Security fixes are applied to the latest published `1.x` release. Older versions
are not maintained; please upgrade to the latest version.

## Security posture

graph-indexer is designed to run locally as a developer tool. Its threat model is
shaped by a few deliberate choices:

- **Air-gapped by default.** The only outbound network call is to a *local* Ollama
  endpoint (`OLLAMA_HOST`, default `http://localhost:11434`) for embeddings. With
  `INDEXER_EMBEDDINGS=off`, even that call is skipped and the tool is fully offline.
  There are no analytics, telemetry, crash reporters, or third-party API calls.
- **No code execution.** Source files are parsed into ASTs with Tree-sitter. The
  indexer never imports, evaluates, or runs the code it indexes.
- **Path-traversal guard.** The `get_file_skeleton` MCP tool resolves and normalizes
  the requested path and rejects anything outside `MCP_PROJECT_ROOT`, so a tool call
  cannot read arbitrary files on the host.
- **Local artifacts only.** The index (`code-index.json`) and embeddings
  (`code-index.embeddings.bin`) are written inside the project and are git-ignored by
  `init`. They contain snippets of your source code — treat them with the same
  sensitivity as the repository itself and do not commit or share them.
- **MCP transport.** The server communicates over stdio with the local MCP client
  (your IDE/agent). It does not open a network socket.

## Operational guidance

- Point `MCP_PROJECT_ROOT` only at repositories you trust and intend to index.
- If you set `OLLAMA_HOST` to a remote host, that host will receive code snippets as
  embedding input — only do so on a network and host you control.
- The background watch daemon respects `.gitignore` and skips `node_modules`, build
  output, and dot-directories, so secrets in ignored paths are not indexed. Keep
  sensitive files git-ignored.
