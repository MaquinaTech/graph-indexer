/**
 * @file embeddings.mjs
 * @description Embedding-provider abstraction. graph-indexer's semantic channel
 *              historically required a running Ollama daemon plus a pulled model,
 *              so out of the box the index was lexical-only. This module adds a
 *              second, **in-process** provider (a small sentence-transformer model via
 *              the optional `@huggingface/transformers` dependency) so conceptual
 *              search works with no external daemon — and an `auto` policy that
 *              prefers a running Ollama (the user's higher-quality choice) and
 *              transparently falls back to the bundled local model, then to
 *              lexical-only, with nothing to configure.
 *
 *              Index time and query time MUST embed with the same model, so the
 *              indexer stamps the resolved { provider, model, dim } into the index
 *              meta and the server reads it back (see indexer.mjs / mcp-server.mjs).
 *
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { truncateForEmbedding } from './search-core.mjs';
import { mlxVenvPython, mlxEnvReady } from './embedders/setup-mlx.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_DIR = join(__dirname, 'embedders', 'python');

export const LOCAL_EMBED_MODEL_DEFAULT = 'Xenova/all-MiniLM-L6-v2';
export const LOCAL_EMBED_DIM = 384;
// Code-specialized in-process embedder (provider 'code-local'). Same optional
// @huggingface/transformers feature-extraction path as the general-purpose 'local'
// MiniLM, but a model trained on code semantics (identifiers, call patterns, type
// names) where MiniLM is weakest. jina-embeddings-v2-base-code is 768-dim, MIT, ships
// first-party ONNX (transformers.js reads it directly, no trust_remote_code), supports
// an 8192-token context, and is ~160 MB (q8 quantized) on first download (air-gapped thereafter).
// Override with --code-embed-model / INDEXER_CODE_EMBED_MODEL (e.g. the Xenova mirror
// `Xenova/jina-embeddings-v2-base-code`, or `Xenova/codet5p-110m-embedding`).
export const CODE_EMBED_MODEL_DEFAULT = 'jinaai/jina-embeddings-v2-base-code';
export const CODE_EMBED_DIM = 768; // informational only — dim is derived lazily from the first vector.
// Passed to the Python server at spawn time (argv) AND stamped into the .meta.json
// sidecar so index time and query time always agree; the indexer's model-change
// detection forces a clean re-embed when this differs. Override via config.mlxEmbedModel.
export const MLX_EMBED_MODEL = 'mlx-community/all-MiniLM-L6-v2-4bit';
const DOC_CHAR_LIMIT = 8000;

// A larger model (e.g. qwen3-embedding:4b) embeds a 64-chunk batch far slower than
// nomic; the old hard 60s cap silently aborted every batch and produced no vectors.
// Raised to 120s and overridable for very large models / slow hardware.
const EMBED_DOC_TIMEOUT_MS = Number(process.env.INDEXER_EMBED_TIMEOUT_MS) > 0
    ? Number(process.env.INDEXER_EMBED_TIMEOUT_MS) : 120000;

// ─── Availability probes ─────────────────────────────────────────────────────

/** Is a local Ollama reachable? A fast, cheap GET so `auto` can decide quickly. */
export async function probeOllama(host, timeoutMs = 1500) {
    try {
        const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok;
    } catch { return false; }
}

/**
 * Does the reachable Ollama actually have `model` pulled? `auto` uses this so a
 * configured embed model that was never `ollama pull`-ed doesn't crash the indexer
 * (embedDocuments would throw on every batch) — instead `auto` falls back to the
 * bundled in-process model. Matches an untagged name against any tag and the
 * implicit `:latest`. Returns false (not throwing) on any error.
 */
export async function ollamaHasModel(host, model, timeoutMs = 1500) {
    if (!model) return false;
    try {
        const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return false;
        const names = ((await res.json()).models || []).map(m => m.name);
        return names.some(n => n === model || n === `${model}:latest`
            || (!model.includes(':') && n.startsWith(`${model}:`)));
    } catch { return false; }
}

/** Is the optional in-process embedding backend installed? */
export async function localEmbedAvailable() {
    try { await import('@huggingface/transformers'); return true; }
    catch { return false; }
}

/**
 * Decide which provider to use for THIS index/run.
 *   • INDEXER_EMBEDDINGS=off / embedProvider 'off' → no vectors (lexical-only).
 *   • 'ollama' / 'local' / 'code-local' / 'mlx'     → forced (code-local is the
 *     in-process code-specialized embedder; mlx is a native Python embedder on the
 *     Apple Metal GPU, macOS-only).
 *   • 'auto' (default) → running Ollama, else the bundled local model, else off.
 * Probes are injectable for deterministic tests.
 *
 * @returns {Promise<{provider:'ollama'|'local'|'code-local'|'mlx'|'off', model:(string|null)}>}
 */
export async function resolveEmbedProvider(config, { probe = probeOllama, hasLocal = localEmbedAvailable, hasModel = ollamaHasModel } = {}) {
    if (config.embeddingsEnabled === false) return { provider: 'off', model: null };
    const want = config.embedProvider || 'auto';
    const localModel = config.localEmbedModel || LOCAL_EMBED_MODEL_DEFAULT;
    if (want === 'off') return { provider: 'off', model: null };
    if (want === 'ollama') return { provider: 'ollama', model: config.embedModel };
    if (want === 'local') return { provider: 'local', model: localModel };
    // code-local: forced, in-process, code-specialized. Never reached by `auto` (it
    // is an explicit opt-in — `auto` stays MiniLM so the no-config path is unchanged).
    if (want === 'code-local') return { provider: 'code-local', model: config.codeEmbedModel || CODE_EMBED_MODEL_DEFAULT };
    if (want === 'mlx') { assertProviderPlatform('mlx'); return { provider: 'mlx', model: config.mlxEmbedModel || MLX_EMBED_MODEL }; }
    // Prefer Ollama only when it actually HAS the configured model pulled — otherwise
    // the indexer would crash on the first batch. Fall back to in-process, then off.
    if (await probe(config.ollamaHost)) {
        if (await hasModel(config.ollamaHost, config.embedModel)) {
            return { provider: 'ollama', model: config.embedModel };
        }
        if (await hasLocal()) return { provider: 'local', model: localModel };
        return { provider: 'off', model: null };
    }
    if (await hasLocal()) return { provider: 'local', model: localModel };
    return { provider: 'off', model: null };
}

// ─── Low-level backends (injectable for tests) ───────────────────────────────

async function _withRetry(fn, tries = 3) {
    for (let a = 0; a <= tries; a++) {
        try { return await fn(); }
        catch (e) { if (a === tries) throw e; await new Promise(r => setTimeout(r, 500 * 2 ** a)); } // exponential backoff
    }
}

// nomic-style models are ASYMMETRIC and require `search_query:` / `search_document:`
// prefixes. Other embedders (qwen3-embedding, mxbai, …) are trained on raw text —
// injecting nomic's prefix tokens into them adds noise and degrades retrieval — so
// the prefix is gated on the model family. Index time and query time MUST agree on
// the prefix, which they do because both derive it from the same model name.
export function needsNomicPrefix(model) { return /nomic/i.test(model || ''); }

async function _ollamaEmbedOne(host, model, text) {
    const prompt = needsNomicPrefix(model) ? 'search_query: ' + truncateForEmbedding(text) : truncateForEmbedding(text);
    const res = await fetch(`${host}/api/embeddings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt }),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).embedding;
}
async function _ollamaEmbedMany(host, model, texts) {
    const pfx = needsNomicPrefix(model) ? 'search_document: ' : '';
    const res = await fetch(`${host}/api/embed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts.map(t => pfx + (t.length > DOC_CHAR_LIMIT ? t.slice(0, DOC_CHAR_LIMIT) : t)) }),
        signal: AbortSignal.timeout(EMBED_DOC_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).embeddings;
}

// all-MiniLM is symmetric (unlike nomic), so query and document text need no prefixes.
let _pipe = null, _pipeModel = null;
async function _localPipeline(model) {
    if (_pipe && _pipeModel === model) return _pipe;
    let mod;
    try { mod = await import('@huggingface/transformers'); }
    catch {
        throw new Error(
            "Local embeddings need the optional '@huggingface/transformers' package. "
            + "Install it (`npm run embed:setup:local`, or `npm i @huggingface/transformers`) "
            + "or set embedProvider to 'ollama'/'off'."
        );
    }
    _pipe = await mod.pipeline('feature-extraction', model);
    _pipeModel = model;
    return _pipe;
}
async function _localEmbedMany(model, texts) {
    const pipe = await _localPipeline(model);
    const out = await pipe(
        texts.map(t => (t.length > DOC_CHAR_LIMIT ? t.slice(0, DOC_CHAR_LIMIT) : t)),
        { pooling: 'mean', normalize: true }
    );
    return out.tolist();
}

/** Reset the cached local pipeline (tests). */
export function _resetLocalPipeline() { _pipe = null; _pipeModel = null; }

// Code-specialized in-process embedder (provider 'code-local'). A SEPARATE lazy
// singleton from _localPipeline so a code-local and a plain-local run in the same
// process don't evict each other's model. The import lives inside the function, so
// the default path (lexical / `auto` → MiniLM) NEVER loads the code model — it is
// pulled only when 'code-local' is actually selected and a vector is requested.
// `_codeLoads` lets tests prove that lazy-load contract without a network call.
let _codePipe = null, _codePipeModel = null, _codeLoads = 0;
async function _codeLocalPipeline(model) {
    if (_codePipe && _codePipeModel === model) return _codePipe;
    let mod;
    try { mod = await import('@huggingface/transformers'); }
    catch {
        throw new Error(
            "The code-local embedder needs the optional '@huggingface/transformers' package. "
            + "Install it (`npm run embed:setup:local`, or `npm i @huggingface/transformers`) "
            + "or set embedProvider to 'ollama'/'local'/'off'."
        );
    }
    // q8 quantized weights: a 161M-param code model is ~4× faster on CPU at q8 with
    // negligible recall loss (the same quantized-ONNX choice the cross-encoder makes),
    // which is what makes an in-process code embedder practical on a laptop. transformers.js
    // falls back to fp32 automatically if a model ships no quantized ONNX.
    _codePipe = await mod.pipeline('feature-extraction', model, { dtype: 'q8' });
    _codePipeModel = model;
    _codeLoads++;
    return _codePipe;
}
async function _codeLocalEmbedMany(model, texts) {
    const pipe = await _codeLocalPipeline(model);
    // jina-code is symmetric (no nomic-style query/document prefixes); mean-pool +
    // normalize, identical handling to the MiniLM path, so cache keys / windowing are
    // unchanged. The 8000-char cap matches search-core's EMBEDDING_CONTEXT_LIMIT.
    const out = await pipe(
        texts.map(t => (t.length > DOC_CHAR_LIMIT ? t.slice(0, DOC_CHAR_LIMIT) : t)),
        { pooling: 'mean', normalize: true }
    );
    return out.tolist();
}
/** Reset the cached code-local pipeline (tests). */
export function _resetCodeLocalPipeline() { _codePipe = null; _codePipeModel = null; }
/** Number of times the code-local model has been lazy-loaded (tests: lazy-load contract). */
export function _codeLocalPipelineLoads() { return _codeLoads; }

/**
 * Should the cached vectors be discarded before this run? True only when the previous
 * build's embed-meta records a DIFFERENT model than the embedder about to run. Vectors
 * of different models/dims must never be mixed in one `.bin` — a 768-dim code-local
 * vector and a 384-dim MiniLM vector under the same cache would silently no-op the
 * dense channel for the mismatched dim (scan/sketch skip a wrong-dim entry). Model name
 * is the pre-embed signal (the actual dim is unknown until the first vector returns), so
 * switching `--embed-provider local` → `code-local` forces a clean re-embed rather than a
 * silent half-empty index.
 *
 * @param {object|null} prevMeta  The prior `.embeddings.bin.meta.json` ({ provider, model, dim }).
 * @param {string|null} model     The model the current embedder will use.
 * @returns {boolean}
 */
export function embedModelChanged(prevMeta, model) {
    return Boolean(prevMeta?.model && model && prevMeta.model !== model);
}

// ─── Native Python embedder (mlx) ────────────────────────────────────────────
// MLX (Apple Metal) is Python-first with no Node bindings, so it runs as a long-lived
// child process speaking newline-delimited JSON:
//     Node → Python: {"texts": ["t1", …, "t32"]}\n
//     Python → Node: {"embeddings": [[…], …]}\n
// The process is a module-level singleton, started lazily on first use and reused
// for the lifetime of this process (matching the _localPipeline lazy-cache idea). It
// runs under the dedicated embedders/venv-mlx interpreter (see embedders/setup-mlx.mjs)
// so MLX deps never pollute the system Python.

// We memoize the in-flight SPAWN PROMISE (not just the resolved proc) so concurrent
// first callers share ONE spawn instead of each launching its own model server.
const _procState = {
    mlx: { proc: null, promise: null },
};
// Tracked so the process-exit handler can reap all children on shutdown.
const _liveProcs = new Set();
let _cleanupInstalled = false;
function _installProcessCleanup() {
    if (_cleanupInstalled) return;
    _cleanupInstalled = true;
    // Deliberately NOT trapping SIGINT/SIGTERM: a no-op listener would suppress Node's
    // default termination and break Ctrl-C. On Ctrl-C, children get the same group
    // signal directly; on any parent death their stdin closes (EOF) and the Python
    // `for line in sys.stdin` loop self-terminates.
    process.on('exit', () => {
        for (const p of _liveProcs) { try { if (!p.killed) p.kill(); } catch { /* best effort */ } }
    });
}

// MLX Metal benefits from large batches (GPU parallelism); sending one text at a time
// drowns the Metal win in IPC overhead.
const MLX_BATCH_SIZE = Number(process.env.INDEXER_MLX_BATCH_SIZE) || 32;
// The server downloads ~90MB and loads the model before printing READY, so a slow
// first build must not be killed. Distinct from the dep pre-check, which fails fast.
const EMBED_STARTUP_TIMEOUT_MS = Number(process.env.INDEXER_EMBED_STARTUP_TIMEOUT_MS) > 0
    ? Number(process.env.INDEXER_EMBED_STARTUP_TIMEOUT_MS) : 120000;

/** mlx is macOS-only. Throw a clear, actionable error elsewhere. */
function assertProviderPlatform(provider) {
    if (provider === 'mlx' && process.platform !== 'darwin') {
        throw new Error(
            `MLX embedder requires macOS Apple Silicon. Current platform: ${process.platform}. `
            + `Use --embed-provider local (any) or --embed-provider ollama.`
        );
    }
}

// Fast-fails before spawning: a missing venv or package raises near-instantly with
// the one command that fixes it.
function checkPythonDeps(provider) {
    // Runs under embedders/venv-mlx so its deps never touch system Python.
    if (!mlxEnvReady()) {
        throw new Error(
            `The MLX embedder environment is not ready (missing embedders/venv-mlx or its deps).\n`
            + `Run:  npm run embed:setup:mlx\n`
            + `Then restart the indexer.`
        );
    }
}

/** True for a never-spawned, killed, or self-exited (crashed/OOM) process. */
function _isProcDead(proc) {
    return !proc || proc.killed || proc.exitCode !== null || proc.signalCode != null;
}

/** Kill a provider's subprocess (if any) and clear its cached state so it respawns. */
function _killProc(provider) {
    const st = _procState[provider];
    const proc = st.proc;
    st.proc = null;
    st.promise = null;
    if (proc && !proc.killed) {
        // Reject in-flight batches now so siblings degrade immediately instead of
        // waiting out their own per-batch timeout (close() would also drain, later).
        const pending = proc._pending || [];
        proc._pending = [];
        for (const r of pending) r.reject(new Error(`${provider} subprocess killed`));
        try { proc.kill(); } catch { /* best effort */ }
    }
}

/** Spawn an embed server, await its "READY" line, and wire up the response demux. */
async function spawnEmbedServer(provider, model) {
    assertProviderPlatform(provider);
    checkPythonDeps(provider); // fast-fail before spawning
    _installProcessCleanup();

    const scripts = {
        mlx: join(PYTHON_DIR, 'mlx_embed_server.py'),
    };
    // Pass the resolved model id as argv so the server loads exactly what the meta
    // sidecar stamps. mlxVenvPython() falls back to bare 'python3' only if venv is absent.
    const proc = spawn(mlxVenvPython(), [scripts[provider], model || MLX_EMBED_MODEL], { stdio: ['pipe', 'pipe', 'pipe'] });
    _liveProcs.add(proc);
    proc.stderr.on('data', (d) => process.stderr.write(`[${provider}] ${d}`));

    // FIFO of pending {resolve,reject}: the Python server answers in order, so each
    // response line resolves the oldest pending entry.
    proc._pending = [];
    proc._ready = false;

    let onReady, onReadyErr;
    const ready = new Promise((resolve, reject) => { onReady = resolve; onReadyErr = reject; });

    // On close / stdin error, rejects all in-flight requests so awaiters degrade to
    // lexical instead of hanging forever.
    const drainPending = (err) => {
        const pending = proc._pending;
        proc._pending = [];
        for (const r of pending) r.reject(err);
    };

    // Single persistent readline: one interface avoids dropping buffered bytes that a
    // closed-then-reopened interface could lose.
    proc._rl = createInterface({ input: proc.stdout });
    proc._rl.on('line', (line) => {
        if (!proc._ready) {
            const t = line.trim();
            if (t === 'READY') { proc._ready = true; onReady(); return; }
            // Server prints {"error":...} then exits if the model fails to load; surface
            // that specific error rather than a generic unexpected-line message.
            let parsed = null; try { parsed = JSON.parse(t); } catch { /* not JSON */ }
            proc.kill();
            onReadyErr(new Error(parsed?.error
                ? `${provider} failed to start: ${parsed.error}`
                : `${provider} subprocess sent unexpected first line: ${line}`));
            return;
        }
        const resolver = proc._pending.shift();
        if (!resolver) return;
        try {
            const msg = JSON.parse(line);
            if (msg.error) resolver.reject(new Error(`${provider}: ${msg.error}`));
            else resolver.resolve(msg.embeddings);
        } catch {
            resolver.reject(new Error(`${provider}: bad JSON: ${line}`));
        }
    });

    const timeout = setTimeout(() => {
        proc.kill();
        onReadyErr(new Error(
            `${provider} embedder subprocess did not print READY within ${EMBED_STARTUP_TIMEOUT_MS}ms `
            + `(first run downloads the model — raise INDEXER_EMBED_STARTUP_TIMEOUT_MS if needed).`));
    }, EMBED_STARTUP_TIMEOUT_MS);

    proc.on('error', (err) => { clearTimeout(timeout); onReadyErr(err); drainPending(err); });
    // A broken pipe (subprocess died mid-write) emits an async 'error' on stdin; an
    // unhandled stream 'error' is FATAL to the whole Node process — swallow it here
    // and fail the in-flight batch so the indexer/server degrades gracefully.
    proc.stdin.on('error', (err) => drainPending(new Error(`${provider} stdin error: ${err.message}`)));
    proc.on('close', (code, signal) => {
        clearTimeout(timeout);
        _liveProcs.delete(proc);
        // Guard: only clear the singleton if it still points at THIS proc, not a fresh respawn.
        if (_procState[provider].proc === proc) _procState[provider].proc = null;
        const why = `${provider} subprocess exited (code ${code}${signal ? `, signal ${signal}` : ''})`;
        if (!proc._ready) onReadyErr(new Error(`${why} before READY`));
        drainPending(new Error(why));
    });

    await ready;
    clearTimeout(timeout);
    return proc;
}

/**
 * Resolve the provider's live subprocess, spawning lazily. Memoizes the in-flight
 * spawn PROMISE so concurrent first callers share one spawn (no duplicate servers).
 * The model is fixed for the lifetime of an index/query run, so the first spawn's
 * model wins for the reused singleton.
 */
function _getEmbedProc(provider, model) {
    const st = _procState[provider];
    if (!_isProcDead(st.proc)) return Promise.resolve(st.proc);
    if (!st.promise) {
        st.promise = spawnEmbedServer(provider, model).then(
            (proc) => { st.proc = proc; st.promise = null; return proc; },
            (err) => { st.proc = null; st.promise = null; throw err; },
        );
    }
    return st.promise;
}

/** Embed `texts` via the provider's subprocess, batching to keep IPC efficient. */
async function _subprocessEmbedMany(provider, texts, model) {
    const proc = await _getEmbedProc(provider, model);
    const batchSize = MLX_BATCH_SIZE;

    const results = [];
    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const embeddings = await new Promise((resolve, reject) => {
            let settled = false;
            // A hung inference (no crash, no exit) must not hang the indexer forever;
            // mirrors the Ollama path's EMBED_DOC_TIMEOUT_MS guard.
            const to = setTimeout(() => {
                if (settled) return; settled = true;
                _killProc(provider); // unrecoverable: kill so the next call respawns
                reject(new Error(`${provider}: embedding batch timed out after ${EMBED_DOC_TIMEOUT_MS}ms`));
            }, EMBED_DOC_TIMEOUT_MS);
            const entry = {
                resolve: (v) => { if (settled) return; settled = true; clearTimeout(to); resolve(v); },
                reject: (e) => { if (settled) return; settled = true; clearTimeout(to); reject(e); },
            };
            // Write FIRST, enqueue only on success: a synchronous write throw (broken
            // pipe) must not leave a phantom entry in the FIFO — that would desync the
            // demux and assign every later batch the wrong vectors.
            try {
                proc.stdin.write(JSON.stringify({ texts: batch }) + '\n');
                proc._pending.push(entry);
            } catch (e) { entry.reject(e); }
        });
        results.push(...embeddings);
    }
    return results; // number[][]
}

/** Reset (kill) the cached embed subprocesses (tests / clean shutdown). */
export function _resetSubprocesses() {
    _killProc('mlx');
}

/** Canonical model id for a forced provider when no explicit model is supplied. */
function defaultModelForProvider(provider, config) {
    if (provider === 'local') return config.localEmbedModel || LOCAL_EMBED_MODEL_DEFAULT;
    if (provider === 'code-local') return config.codeEmbedModel || CODE_EMBED_MODEL_DEFAULT;
    if (provider === 'mlx') return config.mlxEmbedModel || MLX_EMBED_MODEL;
    return config.embedModel;
}

// ─── Public embedder ─────────────────────────────────────────────────────────

/**
 * Build an embedder bound to a resolved provider/model.
 *
 * @param {object} config
 * @param {object} [opts]
 * @param {'ollama'|'local'|'code-local'|'mlx'|'off'} [opts.provider]  Force a provider
 *        (e.g. the one stamped in the index meta). When omitted, resolveEmbedProvider decides.
 * @param {string} [opts.model]
 * @param {object} [opts.backends]  Inject { ollamaEmbedOne, ollamaEmbedMany, localEmbedMany,
 *        codeLocalEmbedMany } (tests).
 * @returns {Promise<{provider:string, model:(string|null), dim:(number|null),
 *                     embedQuery:(t:string)=>Promise<number[]|null>,
 *                     embedDocuments:(t:string[])=>Promise<number[][]|null>}>}
 */
export async function createEmbedder(config, opts = {}) {
    const resolved = opts.provider
        ? { provider: opts.provider, model: opts.model ?? defaultModelForProvider(opts.provider, config) }
        : await resolveEmbedProvider(config, opts);
    const { provider, model } = resolved;
    const host = config.ollamaHost;
    const b = opts.backends || {};
    const ollamaOne = b.ollamaEmbedOne || _ollamaEmbedOne;
    const ollamaMany = b.ollamaEmbedMany || _ollamaEmbedMany;
    const localMany = b.localEmbedMany || _localEmbedMany;
    const codeLocalMany = b.codeLocalEmbedMany || _codeLocalEmbedMany;
    // Derive dim lazily from the first returned vector. Pre-setting LOCAL_EMBED_DIM=384
    // mis-stamps models whose dim isn't 384 (e.g. jina-embeddings-v2-base-code = 768)
    // into the .meta.json before the first embed call.
    let dim = null;

    async function embedQuery(text) {
        if (provider === 'off' || !text) return null;
        try {
            if (provider === 'ollama') return await _withRetry(() => ollamaOne(host, model, text));
            if (provider === 'mlx') {
                const [v] = await _subprocessEmbedMany(provider, [text], model);
                if (v && dim == null) dim = v.length;
                return v ?? null;
            }
            const many = provider === 'code-local' ? codeLocalMany : localMany;
            const [v] = await many(model, [text]);
            if (v && dim == null) dim = v.length;
            return v ?? null;
        } catch { return null; } // graceful: caller drops to lexical
    }

    async function embedDocuments(texts) {
        if (provider === 'off' || !texts || texts.length === 0) return null;
        let vecs;
        if (provider === 'ollama') vecs = await _withRetry(() => ollamaMany(host, model, texts));
        else if (provider === 'mlx') vecs = await _subprocessEmbedMany(provider, texts, model);
        else if (provider === 'code-local') vecs = await codeLocalMany(model, texts);
        else vecs = await localMany(model, texts);
        if (vecs && vecs[0] && dim == null) dim = vecs[0].length;
        return vecs;
    }

    return { provider, model, get dim() { return dim; }, embedQuery, embedDocuments };
}

// ─── Sidecar embed-meta (provider/model/dim that produced the shared bin) ─────
// Both backends share `code-index.embeddings.bin`; this records which model wrote
// it so (a) the indexer re-embeds from scratch when the model changes (vectors of
// different models/dims must not be mixed), and (b) the server queries with the
// same provider the index was built with.

export function embedMetaPath(embeddingPath) { return `${embeddingPath}.meta.json`; }

export function readEmbedMeta(embeddingPath) {
    try { return JSON.parse(fs.readFileSync(embedMetaPath(embeddingPath), 'utf8')); }
    catch { return null; }
}

export function writeEmbedMeta(embeddingPath, meta) {
    try { fs.writeFileSync(embedMetaPath(embeddingPath), JSON.stringify(meta)); }
    catch { /* best-effort: server falls back to config */ }
}

/** One-line, human-readable provider label for logs / list_index_stats. */
export function describeEmbedder({ provider, model } = {}) {
    if (provider === 'ollama') return `🧠 Ollama · ${model}`;
    if (provider === 'local') return `🧠 Local (in-process) · ${model}`;
    if (provider === 'code-local') return `🧠 Code-local (in-process, code-specialized) · ${model}`;
    if (provider === 'mlx') return `🧠 MLX (Apple Metal) · ${model}`;
    return '🔤 Lexical only';
}
