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

Security fixes are applied to the latest published `2.x` release. Older versions
are not maintained; please upgrade to the latest version.

## Security posture

graph-indexer is designed to run locally as a developer tool. Its threat model is
shaped by a few deliberate choices:

- **Air-gapped by default.** In normal operation the only outbound network call is to
  a *local* Ollama endpoint (`OLLAMA_HOST`, default `http://localhost:11434`) for
  embeddings. With `INDEXER_EMBEDDINGS=off`, even that call is skipped and the tool is
  fully offline. There are no analytics, telemetry, crash reporters, or third-party API
  calls. **One exception:** the optional in-process embedding provider
  (`embedProvider: "local"`, or `"auto"` when no Ollama is found) downloads its model
  weights from the Hugging Face CDN **once** on first index, then runs fully offline
  from the local cache. Your source code is never sent anywhere — only model weights
  are fetched. For strictly air-gapped installs, set `embedProvider` to `"ollama"` or
  `"off"`, or pre-populate the model cache on a connected machine.
- **Sealed mode (opt-in, fail-closed enforcement).** For regulated or strictly
  air-gapped installs, `--sealed strict` (`INDEXER_SEALED`) enforces **zero** network
  egress (lexical-only), and `--sealed local` permits **loopback only** (a local
  Ollama/MLX on this box is allowed, nothing leaves it). It is *fail-closed*: the build
  refuses to start if any enabled feature (embeddings/enrichment/rerank/HyDE) would
  egress beyond the tier, and it installs a **deny-by-default runtime egress guard** on
  the in-process network paths (`net`/`tls` sockets, `http(s)`, `fetch`) so even an
  accidental call is blocked — turning "we don't call out" into "we *can't*."
  `idx-index --attest` prints a deterministic attestation manifest (optionally
  Ed25519/RSA-**signed** and CI-verifiable) of the egress posture. See `seal.mjs`.
- **No code execution.** Source files are parsed into ASTs with Tree-sitter. The
  indexer never imports, evaluates, or runs the code it indexes. The one subprocess
  it spawns is a local, read-only `git log` (see "git signals" below) — never the
  indexed code.
- **Local git signals.** At index time the indexer optionally reads the repository's
  *local* commit log (`git log` on `MCP_PROJECT_ROOT`) to derive churn / recency /
  co-change ranking hints. No remote is contacted and no source content leaves the
  machine — only commit metadata (paths, timestamps) is read locally. Disable it
  entirely with `INDEXER_GIT_SIGNALS=off`, `--no-git-signals`, or
  `"gitSignals": false`.
- **Path-traversal guard.** The `get_file_skeleton` MCP tool resolves and normalizes
  the requested path and rejects anything outside `MCP_PROJECT_ROOT`. Beyond the
  textual check it also resolves symlinks with `realpath` on both the root and the
  target and re-verifies containment, so a symlink *inside* the project that points
  outside it cannot be used to read arbitrary files on the host.
- **Local artifacts only.** The index (`code-index.json`) and embeddings
  (`code-index.embeddings.bin`) are written inside the project and are git-ignored by
  `init`. They contain snippets of your source code — treat them with the same
  sensitivity as the repository itself and do not commit or share them.
- **MCP transport.** The server communicates over stdio with the local MCP client
  (your IDE/agent). It does not open a network socket.
- **Taint analysis is advisory, not a guarantee.** The opt-in `trace_taint` /
  `find_tainted_sinks` MCP tools statically trace untrusted sources to dangerous sinks
  over the call graph using pure regex catalogs + graph traversal (no model, no network,
  read-only). They are a **finder, not a verifier**: they favour precision and miss flows
  through dynamic dispatch, reflection, ORM/query-builder indirection, and untyped
  collections — **"0 findings" is not proof of safety.** Use them for orientation, not as
  a security gate.

## Operational guidance

- Point `MCP_PROJECT_ROOT` only at repositories you trust and intend to index.
- If you set `OLLAMA_HOST` to a remote host, that host will receive code snippets as
  embedding input — only do so on a network and host you control.
- The background watch daemon respects `.gitignore` and skips `node_modules`, build
  output, and dot-directories, so secrets in ignored paths are not indexed. Keep
  sensitive files git-ignored.
