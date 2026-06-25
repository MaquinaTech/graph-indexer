/**
 * @file seal.mjs
 * @description Sealed mode (F1): turn "air-gapped by default" from a behaviour you trust into a
 *              guarantee you can verify and enforce. Two opt-in tiers:
 *                • strict — zero network egress; lexical-only (the default path).
 *                • local  — loopback only; local LLM/embedders on this box are allowed, nothing
 *                           leaves it.
 *
 *              Three mechanisms:
 *                1. assertSealCompatible(config) — FAIL-CLOSED validation: refuse to start if any
 *                   enabled feature would egress beyond the tier, naming the feature + remedy.
 *                2. installEgressGuard({allow}) — a deny-by-default runtime hook on the in-process
 *                   network paths (net/tls sockets, http(s), fetch) so an *accidental* call is
 *                   caught, not just the known ones. A best-effort child_process denylist covers
 *                   the obvious out-of-process egress tools (documented limitation: a child
 *                   process has its own socket layer the parent cannot hook).
 *                3. sealManifest(config) — a deterministic attestation document (tier, providers,
 *                   egress posture) an auditor/CI can diff against policy.
 *
 *              Sealed mode is itself opt-in and can only REMOVE capability (fail-closed); it never
 *              changes ranking, the store, or parity. The default path is already strict-compatible.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import cp from 'node:child_process';
import crypto from 'node:crypto';

/** Thrown by the fail-closed validation and by the runtime guard. */
export class SealViolation extends Error {
    constructor(message) { super(message); this.name = 'SealViolation'; }
}

const LOOPBACK_RE = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|0:0:0:0:0:0:0:1)$/i;

/** Is a bare host string a loopback address? (IPv6 brackets tolerated.) */
export function isLoopbackHost(host) {
    if (!host) return false;
    const h = String(host).replace(/^\[|\]$/g, '').trim().toLowerCase();
    return LOOPBACK_RE.test(h);
}

/** Is a URL string loopback-bound? Unparseable → false (treated as non-loopback). */
export function isLoopbackUrl(url) {
    if (!url) return false;
    try { return isLoopbackHost(new URL(String(url)).hostname); } catch { return false; }
}

/** The LLM endpoint a feature would hit, given the active provider. */
function llmHost(config) {
    return config.llmProvider === 'mlx' ? config.mlxLmHost : config.ollamaHost;
}

/**
 * Enumerate the enabled features that make network calls, each tagged with its reach
 * ('loopback' = this box only, 'remote' = off-box) and a remedy. The default config (every
 * optional feature off) returns [].
 *
 * @param {object} config  Resolved config.
 * @returns {Array<{feature:string,reach:'loopback'|'remote',target:string,remedy:string}>}
 */
export function egressingFeatures(config) {
    const out = [];
    const reachOf = (host) => (isLoopbackHost(host) || isLoopbackUrl(host) ? 'loopback' : 'remote');

    if (config.embeddingsEnabled) {
        const p = config.embedProvider;
        if (p === 'ollama' || p === 'auto') {
            out.push({
                feature: `embeddings (${p === 'auto' ? 'auto→ollama' : 'ollama'})`,
                reach: reachOf(config.ollamaHost), target: config.ollamaHost,
                remedy: 'drop --embeddings, or point OLLAMA_HOST at loopback under --sealed local',
            });
        } else if (p === 'local') {
            out.push({
                feature: 'embeddings (local MiniLM)', reach: 'remote',
                target: 'model CDN (first-run download)',
                remedy: 'pre-warm the model cache offline, or drop --embeddings under sealed mode',
            });
        } else if (p === 'code-local') {
            // Same in-process @huggingface/transformers path as 'local' — the code model is
            // fetched from the model CDN on the FIRST run (air-gapped only once cached).
            out.push({
                feature: 'embeddings (code-local code-specialized)', reach: 'remote',
                target: 'model CDN (first-run download)',
                remedy: 'pre-warm the code model cache offline, or drop --embeddings under sealed mode',
            });
        } else if (p === 'mlx') {
            out.push({
                feature: 'embeddings (mlx subprocess)', reach: 'loopback',
                target: 'local mlx subprocess',
                remedy: 'drop --embeddings under --sealed strict (local compute only under --sealed local)',
            });
        }
    }
    if (config.enrichment?.enabled) {
        out.push({
            feature: 'enrichment (LLM)', reach: reachOf(llmHost(config)), target: llmHost(config),
            remedy: 'drop --enrichment under sealed mode',
        });
    }
    if (config.rerank?.enabled) {
        if (config.rerank.provider === 'cross-encoder') {
            out.push({
                feature: 'rerank (cross-encoder)', reach: 'remote',
                target: 'model CDN (first-run download)',
                remedy: 'pre-warm the model cache offline, or drop --rerank under sealed mode',
            });
        } else {
            out.push({
                feature: 'rerank (generative LLM)', reach: reachOf(llmHost(config)), target: llmHost(config),
                remedy: 'drop --rerank under sealed mode',
            });
        }
    }
    if (config.hyde?.enabled) {
        out.push({
            feature: 'hyde (LLM)', reach: reachOf(llmHost(config)), target: llmHost(config),
            remedy: 'disable hyde under sealed mode',
        });
    }
    return out;
}

/**
 * FAIL-CLOSED validation. Throws SealViolation (listing every offending feature) if the config
 * would egress beyond its tier. No-op when sealed is 'off'. Called from resolveConfig so a
 * sealed-incompatible config can never be constructed.
 *
 * @param {object} config  Resolved config (reads config.sealed ∈ {'off','local','strict'}).
 */
export function assertSealCompatible(config) {
    const tier = config.sealed || 'off';
    if (tier === 'off') return;
    const feats = egressingFeatures(config);
    // strict forbids ANY egress; local forbids only off-box ('remote') reach.
    const violations = tier === 'strict' ? feats : feats.filter(f => f.reach === 'remote');
    if (violations.length === 0) return;
    const detail = violations.map(v => `  • ${v.feature} → ${v.reach} (${v.target}); ${v.remedy}`).join('\n');
    throw new SealViolation(
        `--sealed ${tier} refuses to start — ${violations.length} enabled feature(s) would egress`
        + (tier === 'strict' ? ' (strict = lexical-only, zero network):\n' : ' beyond loopback:\n')
        + detail);
}

// ── Runtime egress guard ─────────────────────────────────────────────────────────────────────

function hostFromHttpArgs(args) {
    const a = args[0];
    if (typeof a === 'string') { try { return new URL(a).hostname; } catch { return 'localhost'; } }
    if (a && typeof a === 'object') {
        if (typeof a.href === 'string') { try { return new URL(a.href).hostname; } catch { /* fall through */ } }
        const h = a.hostname || a.host || 'localhost';
        return String(h).replace(/:\d+$/, '');
    }
    return 'localhost';
}

function hostFromNetArgs(args) {
    const a = args[0];
    if (a && typeof a === 'object') {
        if (a.path) return null;                 // IPC / unix socket — local, not network
        return a.host || 'localhost';
    }
    if (typeof a === 'number') return typeof args[1] === 'string' ? args[1] : 'localhost';
    if (typeof a === 'string') return null;      // IPC path
    return 'localhost';
}

function hostFromFetch(input) {
    if (typeof input === 'string') { try { return new URL(input).hostname; } catch { return null; } }
    if (input && typeof input === 'object') {
        if (typeof input.url === 'string') { try { return new URL(input.url).hostname; } catch { return null; } }
        try { return new URL(String(input)).hostname; } catch { return null; }
    }
    return null;
}

const EGRESS_BINS = /^(curl|wget|nc|ncat|telnet|ssh|scp|sftp|rsync)$/i;
const GIT_NET = /^(fetch|pull|push|clone|remote|ls-remote|submodule)$/i;
const PKG_MGRS = /^(npm|pnpm|yarn|pip|pip3|gem|cargo|go)$/i;
const PKG_NET = /\b(install|add|update|upgrade|ci|fetch|download|get)\b/i;

/** Best-effort: would this child process reach the network? (documented as not airtight.) */
export function commandWouldEgress(cmd, args = []) {
    const base = String(cmd || '').split(/[\\/]/).pop();
    if (EGRESS_BINS.test(base)) return true;
    if (/^git$/i.test(base) && args[0] && GIT_NET.test(String(args[0]))) return true;
    if (PKG_MGRS.test(base) && args.some(a => PKG_NET.test(String(a)))) return true;
    // shell strings (exec/execSync) arrive as the whole command in `cmd`.
    if (!args.length && /\b(curl|wget|nc|ncat|ssh|scp|rsync)\b/i.test(String(cmd))) return true;
    if (!args.length && /\bgit\s+(fetch|pull|push|clone|remote|ls-remote)\b/i.test(String(cmd))) return true;
    return false;
}

let _installed = null;

/**
 * Install the deny-by-default egress guard. Idempotent. The in-process socket/http/fetch hooks are
 * airtight for THIS process; the child_process denylist is best-effort (a child has its own socket
 * layer). Returns a handle with restore() (used by tests + an orderly shutdown).
 *
 * @param {object} [opts]
 * @param {Array<'loopback'>} [opts.allow]  [] (strict) → block all; ['loopback'] (local) → permit loopback.
 */
export function installEgressGuard({ allow = [] } = {}) {
    if (_installed) return _installed;
    const allowLoopback = allow.includes('loopback');
    const permit = (host) => host !== null && allowLoopback && isLoopbackHost(host);
    const block = (host, api) => {
        throw new SealViolation(`sealed mode blocked a network connection to ${host || '(unparseable host)'} via ${api}`);
    };
    // A null host from net means IPC/unix socket (local) → allow; from fetch means unparseable → block.
    const guardNet = (host, api, orig, ctx, args) => {
        if (host === null || permit(host)) return orig.apply(ctx, args);
        return block(host, api);
    };

    const orig = {
        httpRequest: http.request, httpGet: http.get,
        httpsRequest: https.request, httpsGet: https.get,
        netConnect: net.Socket.prototype.connect,
        fetch: globalThis.fetch,
        spawn: cp.spawn, spawnSync: cp.spawnSync,
        exec: cp.exec, execSync: cp.execSync,
        execFile: cp.execFile, execFileSync: cp.execFileSync,
    };

    http.request = function (...args) { const h = hostFromHttpArgs(args); return permit(h) ? orig.httpRequest.apply(this, args) : block(h, 'http.request'); };
    http.get = function (...args) { const h = hostFromHttpArgs(args); return permit(h) ? orig.httpGet.apply(this, args) : block(h, 'http.get'); };
    https.request = function (...args) { const h = hostFromHttpArgs(args); return permit(h) ? orig.httpsRequest.apply(this, args) : block(h, 'https.request'); };
    https.get = function (...args) { const h = hostFromHttpArgs(args); return permit(h) ? orig.httpsGet.apply(this, args) : block(h, 'https.get'); };
    net.Socket.prototype.connect = function (...args) { return guardNet(hostFromNetArgs(args), 'net.connect', orig.netConnect, this, args); };
    if (orig.fetch) globalThis.fetch = function (input, init) { const h = hostFromFetch(input); return permit(h) ? orig.fetch.call(this, input, init) : block(h, 'fetch'); };

    const guardChild = (name, origFn) => function (cmd, args, ...rest) {
        const argv = Array.isArray(args) ? args : [];
        if (commandWouldEgress(cmd, argv)) throw new SealViolation(`sealed mode blocked a network-reaching child process via ${name}: ${cmd}`);
        return origFn.call(this, cmd, args, ...rest);
    };
    cp.spawn = guardChild('spawn', orig.spawn);
    cp.spawnSync = guardChild('spawnSync', orig.spawnSync);
    cp.exec = guardChild('exec', orig.exec);
    cp.execSync = guardChild('execSync', orig.execSync);
    cp.execFile = guardChild('execFile', orig.execFile);
    cp.execFileSync = guardChild('execFileSync', orig.execFileSync);

    _installed = {
        allow,
        restore() {
            http.request = orig.httpRequest; http.get = orig.httpGet;
            https.request = orig.httpsRequest; https.get = orig.httpsGet;
            net.Socket.prototype.connect = orig.netConnect;
            if (orig.fetch) globalThis.fetch = orig.fetch;
            cp.spawn = orig.spawn; cp.spawnSync = orig.spawnSync;
            cp.exec = orig.exec; cp.execSync = orig.execSync;
            cp.execFile = orig.execFile; cp.execFileSync = orig.execFileSync;
            _installed = null;
        },
    };
    return _installed;
}

/** Whether the guard is currently installed (for stats / idempotency checks). */
export function egressGuardActive() { return _installed != null; }

/**
 * Deterministic attestation document — the effective sealed posture an auditor/CI can diff against
 * policy. No timestamps in the body (stamp outside if needed) so it is reproducible.
 *
 * @param {object} config  Resolved config.
 */
export function sealManifest(config) {
    const tier = config.sealed || 'off';
    return {
        sealed: tier,
        egress: tier === 'strict' ? 'none' : tier === 'local' ? 'loopback-only' : 'unrestricted',
        providers: {
            embeddings: config.embeddingsEnabled ? config.embedProvider : 'off',
            enrichment: config.enrichment?.enabled ? config.llmProvider : 'off',
            rerank: config.rerank?.enabled ? config.rerank.provider : 'off',
            llm: config.llmProvider || 'ollama',
        },
        egressing_features: egressingFeatures(config).map(f => ({ feature: f.feature, reach: f.reach, target: f.target })),
    };
}

// ── Attestation signing (F1 hardening) ───────────────────────────────────────────────────────
// Turn the manifest from a document you trust into one you can VERIFY: a detached signature over
// its canonical bytes, so an auditor/CI proves the attested posture is authentic and untampered.
// Pure local crypto (node:crypto) — no dependency, no network; works under --sealed strict.

/**
 * Deterministic JSON: object keys sorted recursively → stable bytes for signing/verifying. (The
 * manifest is already emitted in a fixed order, but signing over a canonical form makes the
 * signature robust to any future key-order change and to a round-trip through a file.)
 */
export function canonicalJson(value) {
    const norm = (v) => {
        if (Array.isArray(v)) return v.map(norm);
        if (v && typeof v === 'object') {
            const out = {};
            for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
            return out;
        }
        return v;
    };
    return JSON.stringify(norm(value));
}

/** Map an asymmetric key type to its (node digest, label) signing spec. Ed25519 uses a null digest. */
function signSpec(keyType) {
    switch (keyType) {
        case 'ed25519': return { digest: null, alg: 'ed25519' };
        case 'ed448': return { digest: null, alg: 'ed448' };
        case 'rsa':
        case 'rsa-pss': return { digest: 'sha256', alg: 'rsa-sha256' };
        case 'ec': return { digest: 'sha256', alg: 'ecdsa-sha256' };
        default: throw new Error(`unsupported attestation key type: ${keyType}`);
    }
}

/** SHA-256 fingerprint (first 16 bytes, hex) of a public key's SPKI/DER encoding — a stable key id. */
export function publicKeyFingerprint(publicKey) {
    const der = publicKey.export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
}

/**
 * Sign a seal manifest with a PEM private key (Ed25519 / RSA / EC). Returns a signed envelope
 * `{ manifest, signature: { alg, keyType, publicKeyFingerprint, value } }`. The signature covers the
 * CANONICAL JSON of the manifest, so it is reproducible and tamper-evident.
 *
 * @param {object} manifest  Output of sealManifest(config).
 * @param {string|Buffer} privateKeyPem  A PEM-encoded private key.
 */
export function signManifest(manifest, privateKeyPem) {
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const spec = signSpec(privateKey.asymmetricKeyType);
    const data = Buffer.from(canonicalJson(manifest), 'utf8');
    const value = crypto.sign(spec.digest, data, privateKey).toString('base64');
    const publicKey = crypto.createPublicKey(privateKey);
    return {
        manifest,
        signature: {
            alg: spec.alg,
            keyType: privateKey.asymmetricKeyType,
            publicKeyFingerprint: publicKeyFingerprint(publicKey),
            value,
        },
    };
}

/**
 * Verify a signed manifest envelope against a PEM public key. Returns `{ valid, reason }` (never
 * throws — a malformed envelope/key is a clean `valid:false`). `valid` is true only if the signature
 * matches the canonical JSON of `envelope.manifest` under the declared algorithm and key.
 *
 * @param {object} envelope  Output of signManifest().
 * @param {string|Buffer} publicKeyPem  A PEM-encoded public key.
 */
export function verifySignedManifest(envelope, publicKeyPem) {
    try {
        if (!envelope || !envelope.manifest || !envelope.signature || !envelope.signature.value) {
            return { valid: false, reason: 'not a signed manifest envelope (missing manifest/signature)' };
        }
        const publicKey = crypto.createPublicKey(publicKeyPem);
        const spec = signSpec(publicKey.asymmetricKeyType);
        if (spec.alg !== envelope.signature.alg) {
            return { valid: false, reason: `algorithm mismatch: envelope=${envelope.signature.alg}, key=${spec.alg}` };
        }
        const data = Buffer.from(canonicalJson(envelope.manifest), 'utf8');
        const ok = crypto.verify(spec.digest, data, publicKey, Buffer.from(envelope.signature.value, 'base64'));
        if (!ok) return { valid: false, reason: 'signature does not match (tampered manifest or wrong key)' };
        const fp = publicKeyFingerprint(publicKey);
        if (envelope.signature.publicKeyFingerprint && envelope.signature.publicKeyFingerprint !== fp) {
            return { valid: false, reason: 'public-key fingerprint mismatch' };
        }
        return { valid: true, reason: 'signature valid', publicKeyFingerprint: fp };
    } catch (e) {
        return { valid: false, reason: `verification error: ${e.message}` };
    }
}

/** Generate an Ed25519 attestation keypair as PEM strings (`idx-index --gen-attestation-key`). */
export function generateAttestationKeyPair() {
    return crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
}
