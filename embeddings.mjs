/**
 * @file embeddings.mjs
 * @description Embedding-provider abstraction. graph-indexer's semantic channel
 *              historically required a running Ollama daemon plus a pulled model,
 *              so out of the box the index was lexical-only. This module adds a
 *              second, **in-process** provider (a small ONNX sentence model via the
 *              optional `@huggingface/transformers` dependency) so conceptual
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
import { truncateForEmbedding } from './search-core.mjs';

export const LOCAL_EMBED_MODEL_DEFAULT = 'Xenova/all-MiniLM-L6-v2';
export const LOCAL_EMBED_DIM = 384;
const DOC_CHAR_LIMIT = 8000;

// Per-batch document-embedding timeout. A larger model (e.g. qwen3-embedding:4b)
// embeds a 64-chunk batch far slower than nomic, so the old hard 60s cap aborted
// every batch and the indexer silently produced no vectors. Default raised to 120s
// and overridable for very large models / slow hardware.
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
 *   • 'ollama' / 'local'                            → forced.
 *   • 'auto' (default) → running Ollama, else the bundled local model, else off.
 * Probes are injectable for deterministic tests.
 *
 * @returns {Promise<{provider:'ollama'|'local'|'off', model:(string|null)}>}
 */
export async function resolveEmbedProvider(config, { probe = probeOllama, hasLocal = localEmbedAvailable, hasModel = ollamaHasModel } = {}) {
    if (config.embeddingsEnabled === false) return { provider: 'off', model: null };
    const want = config.embedProvider || 'auto';
    const localModel = config.localEmbedModel || LOCAL_EMBED_MODEL_DEFAULT;
    if (want === 'off') return { provider: 'off', model: null };
    if (want === 'ollama') return { provider: 'ollama', model: config.embedModel };
    if (want === 'local') return { provider: 'local', model: localModel };
    // auto: prefer a running Ollama, but only when it actually HAS the configured
    // embed model pulled — otherwise the indexer would crash on the first batch.
    // Fall back to the bundled in-process model, then to lexical-only.
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
        catch (e) { if (a === tries) throw e; await new Promise(r => setTimeout(r, 500 * 2 ** a)); }
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

// Lazily-loaded, cached sentence-transformer pipeline. all-MiniLM is symmetric, so
// query and document text are embedded the same way (no prefixes).
let _pipe = null, _pipeModel = null;
async function _localPipeline(model) {
    if (_pipe && _pipeModel === model) return _pipe;
    let mod;
    try { mod = await import('@huggingface/transformers'); }
    catch {
        throw new Error(
            "Local embeddings need the optional '@huggingface/transformers' package. "
            + "Install it (`npm i @huggingface/transformers`) or set embedProvider to 'ollama'/'off'."
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

// ─── Public embedder ─────────────────────────────────────────────────────────

/**
 * Build an embedder bound to a resolved provider/model.
 *
 * @param {object} config
 * @param {object} [opts]
 * @param {'ollama'|'local'|'off'} [opts.provider]  Force a provider (e.g. the one
 *        stamped in the index meta). When omitted, resolveEmbedProvider decides.
 * @param {string} [opts.model]
 * @param {object} [opts.backends]  Inject { ollamaEmbedOne, ollamaEmbedMany, localEmbedMany } (tests).
 * @returns {Promise<{provider:string, model:(string|null), dim:(number|null),
 *                     embedQuery:(t:string)=>Promise<number[]|null>,
 *                     embedDocuments:(t:string[])=>Promise<number[][]|null>}>}
 */
export async function createEmbedder(config, opts = {}) {
    const resolved = opts.provider
        ? { provider: opts.provider, model: opts.model ?? (opts.provider === 'local' ? (config.localEmbedModel || LOCAL_EMBED_MODEL_DEFAULT) : config.embedModel) }
        : await resolveEmbedProvider(config, opts);
    const { provider, model } = resolved;
    const host = config.ollamaHost;
    const b = opts.backends || {};
    const ollamaOne = b.ollamaEmbedOne || _ollamaEmbedOne;
    const ollamaMany = b.ollamaEmbedMany || _ollamaEmbedMany;
    const localMany = b.localEmbedMany || _localEmbedMany;
    let dim = provider === 'local' ? LOCAL_EMBED_DIM : null;

    async function embedQuery(text) {
        if (provider === 'off' || !text) return null;
        try {
            if (provider === 'ollama') return await _withRetry(() => ollamaOne(host, model, text));
            const [v] = await localMany(model, [text]);
            if (v && dim == null) dim = v.length;
            return v ?? null;
        } catch { return null; } // graceful: caller drops to lexical
    }

    async function embedDocuments(texts) {
        if (provider === 'off' || !texts || texts.length === 0) return null;
        const vecs = provider === 'ollama'
            ? await _withRetry(() => ollamaMany(host, model, texts))
            : await localMany(model, texts);
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
    return '🔤 Lexical only';
}
