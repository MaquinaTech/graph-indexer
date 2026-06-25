# Phase 3 — F1: Sealed Mode

> **Status: IMPLEMENTED** (`seal.mjs`, `config.mjs`, `indexer.mjs`, `mcp-server.mjs`,
> `mcp/tools.mjs`; `test/seal.mjs`). This doc is the original design; it matches what shipped.
> Two notes vs the first sketch: (1) the `local` tier forbids the cross-encoder and local-MiniLM
> embedders because both reach a model CDN off-box on first run; (2) `--attest` is implemented as
> an `idx-index` flag (no separate binary).

## One line

Turn graph-indexer's strongest differentiator — *air-gapped by default* — from a behaviour you
**trust** into a guarantee you can **verify and enforce**: a fail-closed mode that provably makes
zero network egress and emits an attestable manifest.

## Why this is the #1 Phase 3 item

The default path already makes no network calls — but a user in a regulated/classified environment
cannot *prove* that, and a single opt-in (embeddings via Ollama, generative rerank, enrichment,
HyDE, a git remote) silently opens egress to localhost or beyond. "It doesn't call out" is a
property of the *current config*, re-established on every run. Sealed mode makes it a property of
the *process*: it **cannot** call out, it refuses to start if any enabled feature would, and it
hands an auditor a signed statement of that fact. For banking / defense / health deployments this
converts a marketing claim into a compliance artifact.

It is also the cheapest moonshot to make load-bearing: the default path is *already*
strict-sealed-compatible, so the feature is mostly enforcement + attestation, not new capability.

## Two tiers

| tier | egress allowed | enabled features |
|------|----------------|------------------|
| `strict` | **none** (no sockets, no child egress) | lexical-only — the zero-dependency default path |
| `local` | **loopback only** (127.0.0.0/8, ::1) | + Ollama / MLX / mlx_lm on localhost; still no off-box |
| `off` (default today) | unrestricted | everything |

`strict` is the "this box has no network and we prove it" tier. `local` is "models run on this box,
nothing leaves it" — the common air-gapped-with-local-LLM posture.

## Behaviour

1. **Fail-closed validation at startup** (`assertSealCompatible`): resolveConfig rejects any
   feature whose provider would egress beyond the tier — e.g. `strict` + `embedProvider=ollama`
   throws a `SealViolation` that *names* the offending feature and how to fix it (drop it, or move
   to `local`). No silent downgrade.
2. **Runtime egress guard** (`installEgressGuard`): deny-by-default hooks on every egress path so an
   *accidental* call (a new dependency, a stray `fetch`) is caught, not just the known ones:
   - `node:net` `Socket.connect` / `node:tls` `connect` → throw unless the destination resolves to
     an allowed address (none for `strict`, loopback for `local`).
   - `node:http(s)` `request`, `globalThis.fetch`, and the bundled `undici` Agent → routed through
     the same check.
   - `node:child_process` (`spawn`/`exec`) → block known egress tools (`curl`, `wget`, `git fetch/
     pull/push`, `npm`/`pip` install) under `strict`; under `local` allow only loopback-bound ones.
   - DNS (`node:dns`) lookups to non-loopback names → blocked (defence in depth).
3. **Attestable manifest** (`sealManifest`): a deterministic JSON document — tier (`sealed`), an
   explicit `egress: "none" | "loopback-only"`, the per-channel `providers`
   (`{ embeddings, enrichment, rerank, llm }`), and any `egressing_features`
   (`[{ feature, reach, target }]`) — printable via `idx-index --attest` and surfaced in
   `list_index_stats`. An auditor (or CI in the regulated environment) diffs the manifest against
   policy. It can be **cryptographically signed** (Ed25519/RSA/EC) via `signManifest` and verified
   with `verifySignedManifest` (F1 hardening — `node:crypto` only, air-gapped).
4. **MCP server honours it too**: `idx-mcp --sealed strict` installs the guard before any tool is
   registered and omits/【refuses】tools whose providers egress; `list_index_stats` reports
   `sealed: "strict"`, `egress_guard: "active"`.

## Seams in the current codebase

- **`config.mjs`** — `DEFAULTS.sealed: 'off'`; resolve `--sealed [strict|local]` / `INDEXER_SEALED`;
  `assertSealCompatible(config)` runs inside `resolveConfig` (after providers resolve);
  `describeConfig`/`configNotices` print the tier + what it forbids. This reuses the exact opt-in
  pattern every Phase 1/2 flag already follows.
- **`seal.mjs`** (new) — the guard + manifest (below).
- **`indexer.mjs` / `mcp-server.mjs`** — call `installEgressGuard()` immediately after config
  resolution, before any provider loads, so even provider init cannot egress.
- **`embeddings.mjs` / `enrichment.mjs`** — already centralise the network providers; sealed-mode
  validation enumerates them. No change to their logic — sealed mode only *gates* them.

## Interface (as built)

```js
// seal.mjs  (the tier is resolved in config.mjs, not a seal.mjs export)
export class SealViolation { /* { feature, reason, remedy } */ }
export function isLoopbackHost(host); export function isLoopbackUrl(url);
export function egressingFeatures(config);     // → [{ feature, reach, target }]

// Throws SealViolation if any enabled feature egresses beyond the tier.
export function assertSealCompatible(config) { /* ... */ }
export function commandWouldEgress(cmd, args, tier);  // child_process denylist helper

// Installs deny-by-default hooks on net/tls/http(s)/fetch (+ best-effort child_process).
export function installEgressGuard({ allow }) { /* → restore() */ }
export function egressGuardActive();

// Deterministic attestation document (stamp timestamps outside the signed body).
export function sealManifest(config) {
  // → { sealed, egress, providers: { embeddings, enrichment, rerank, llm },
  //     egressing_features: [{ feature, reach, target }] }
}

// F1 hardening — cryptographic attestation (node:crypto only):
export function canonicalJson(value); export function publicKeyFingerprint(key);
export function signManifest(manifest, privateKey);         // → { manifest, signature }
export function verifySignedManifest(envelope, publicKey);  // → { valid, reason }
export function generateAttestationKeyPair();
```

```
# CLI / MCP surface (DESIGN)
idx-index --sealed strict            # fail-closed build; lexical-only
idx-index --sealed local             # loopback-only (Ollama/MLX on this box OK)
idx-index --attest                   # print the seal manifest and exit
idx-mcp   --sealed strict            # guarded server
list_index_stats → { ..., sealed: 'strict', egress_guard: 'active' }
```

## Invariant compliance

- **Opt-in** — `sealed: 'off'` default; turning it on only *removes* capability (fail-closed),
  never changes ranking. The default path is already `strict`-compatible, so sealing the default is
  functionally a no-op plus a guarantee.
- **Parity / eval** — sealed mode touches neither the store nor the ranker; `test:eval` and
  memory↔sqlite parity are unaffected by construction.
- **Measured, not silent** — the whole point: it *prints and attests* exactly what is and isn't
  reachable; a violation is a loud refusal, never a quiet fallback.

## Risks & open questions

- **Guard completeness** — the hook set must cover every egress path Node exposes (net, tls, http,
  https, http2, dns, fetch/undici, child_process). A deny-by-default socket-layer hook is the
  backstop: anything that ultimately opens a socket is caught even if a higher-level API is missed.
- **Native addons** — a native module could egress below the JS layer. The shipped natives
  (tree-sitter grammars, node:sqlite, optional hnswlib) don't; `@huggingface/transformers` *does*
  download models — blocked under `strict`, and under `local` only if the model cache is already
  warm (first-run download fails closed, which is correct). Document this explicitly.
- **Signing** — ✅ **IMPLEMENTED (v2.1).** The manifest is now cryptographically signable. `seal.mjs`
  adds `signManifest(manifest, privateKeyPem)` (Ed25519 / RSA / EC, via `node:crypto` — zero
  dependency, sealed-compatible) → a `{ manifest, signature: { alg, keyType, publicKeyFingerprint,
  value } }` envelope, with the signature taken over a `canonicalJson` (recursively key-sorted) form
  so it survives a file round-trip and any future key-order change. `verifySignedManifest(envelope,
  publicKeyPem)` returns `{ valid, reason }` (never throws). CLI: `idx-index --gen-attestation-key
  <prefix>` writes an Ed25519 keypair; `idx-index --attest --sign-key <path>` prints the signed
  envelope; `idx-index --verify-attestation <file> --pub-key <path>` verifies the signature AND
  reports whether the attested manifest still matches the current effective config (policy drift →
  exit 3). `test/seal.mjs` covers Ed25519 + RSA sign/verify, tamper rejection, wrong-key rejection,
  algorithm-mismatch, and JSON-round-trip.

## Effort

Medium. The enforcement + manifest is a few focused modules; the bulk of the work is *test
coverage* of the guard (assert each egress path throws under `strict`, loopback passes under
`local`) and the per-provider violation messages. No new heavy dependency.
