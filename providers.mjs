/**
 * @file providers.mjs
 * @description AI provider abstraction for embeddings and text generation.
 *              One registry serves the local default (Ollama) and the optional
 *              cloud providers (OpenAI, Google Gemini for embeddings +
 *              generation; Anthropic for generation only — it offers no
 *              embeddings API, so `init` asks for a separate embedding
 *              provider and the embedder reports itself unusable rather than
 *              silently substituting one).
 *
 *              API keys are read from standard environment variables only
 *              (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY) and are
 *              never written to `.graph-indexer.json`.
 *
 *              Request building and response parsing are pure functions keyed
 *              by provider id so they are unit-testable without network access;
 *              createEmbedder / createGenerator wrap them with fetch, retries
 *              and graceful degradation (a provider failure returns null and
 *              search falls back to the lexical channel — never fatal).
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */

export const PROVIDER_IDS = Object.freeze(['ollama', 'openai', 'anthropic', 'gemini']);

// Default models per provider. Generation defaults favour the small/fast tier:
// enrichment routes hundreds of chunks per index run through the model, so the
// economical tier is the sensible default — both are overridable per channel.
export const PROVIDER_DEFAULTS = Object.freeze({
    ollama: Object.freeze({
        label: 'Ollama (local)',
        embedModel: 'nomic-embed-text',
        enrichModel: 'qwen2.5-coder:1.5b',
        rerankModel: 'qwen2.5-coder:7b',
        apiKeyEnv: null,
    }),
    openai: Object.freeze({
        label: 'OpenAI',
        embedModel: 'text-embedding-3-small',
        enrichModel: 'gpt-4o-mini',
        rerankModel: 'gpt-4o-mini',
        apiKeyEnv: 'OPENAI_API_KEY',
    }),
    anthropic: Object.freeze({
        label: 'Anthropic',
        embedModel: null, // no embeddings API — config falls back to another provider
        enrichModel: 'claude-haiku-4-5',
        rerankModel: 'claude-haiku-4-5',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
    }),
    gemini: Object.freeze({
        label: 'Google Gemini',
        embedModel: 'gemini-embedding-001',
        enrichModel: 'gemini-2.5-flash-lite',
        rerankModel: 'gemini-2.5-flash',
        apiKeyEnv: 'GEMINI_API_KEY',
    }),
});

/** Resolve the API key for a provider from the environment (null when local). */
export function resolveApiKey(provider, env = process.env) {
    if (provider === 'openai') return env.OPENAI_API_KEY || null;
    if (provider === 'anthropic') return env.ANTHROPIC_API_KEY || null;
    if (provider === 'gemini') return env.GEMINI_API_KEY || env.GOOGLE_API_KEY || null;
    return null;
}

function baseUrl(provider, env = process.env) {
    if (provider === 'openai') return (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    if (provider === 'anthropic') return (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
    if (provider === 'gemini') return (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    return null;
}

// Per-provider input cap for one embedded document, in characters.
// gemini-embedding-001 accepts 2048 tokens — dense code at ~3 chars/token
// makes 6000 the safe ceiling; the others comfortably take 8000.
const EMBED_MAX_CHARS = { ollama: 8000, openai: 8000, gemini: 6000 };

/** Clamp one text to the provider's embedding input limit. */
export function clampForEmbedding(provider, text) {
    const max = EMBED_MAX_CHARS[provider] || 8000;
    return text.length > max ? text.slice(0, max) : text;
}

// ─── Embedding requests (pure) ──────────────────────────────────────────────────

/**
 * Build the HTTP request for a batch embedding call.
 *
 * @param {string} provider  'ollama' | 'openai' | 'gemini'
 * @param {object} p
 * @param {string}   p.model
 * @param {string}   [p.ollamaHost]
 * @param {string}   [p.apiKey]
 * @param {string[]} p.texts   Already clamped to the provider's input limit.
 * @param {'query'|'document'} p.kind  Retrieval role — Ollama (nomic) encodes it
 *                                     as a text prefix, Gemini as taskType,
 *                                     OpenAI needs no distinction.
 * @param {object} [env]
 * @returns {{url: string, headers: object, body: object}}
 */
export function buildEmbedRequest(provider, { model, ollamaHost, apiKey, texts, kind }, env = process.env) {
    if (provider === 'ollama') {
        const prefix = kind === 'query' ? 'search_query: ' : 'search_document: ';
        return {
            url: `${ollamaHost}/api/embed`,
            headers: { 'Content-Type': 'application/json' },
            body: { model, input: texts.map(t => prefix + t) },
        };
    }
    if (provider === 'openai') {
        return {
            url: `${baseUrl('openai', env)}/embeddings`,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: { model, input: texts },
        };
    }
    if (provider === 'gemini') {
        const taskType = kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
        return {
            url: `${baseUrl('gemini', env)}/models/${model}:batchEmbedContents`,
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: {
                requests: texts.map(t => ({
                    model: `models/${model}`,
                    content: { parts: [{ text: t }] },
                    taskType,
                })),
            },
        };
    }
    throw new Error(`Provider '${provider}' does not support embeddings.`);
}

/**
 * Extract the vectors from an embedding response, in input order.
 * @returns {number[][]|null} null when the response carries no usable vectors.
 */
export function parseEmbedResponse(provider, json) {
    if (!json) return null;
    if (provider === 'ollama') {
        return Array.isArray(json.embeddings) ? json.embeddings : null;
    }
    if (provider === 'openai') {
        if (!Array.isArray(json.data)) return null;
        return [...json.data].sort((a, b) => a.index - b.index).map(d => d.embedding);
    }
    if (provider === 'gemini') {
        if (!Array.isArray(json.embeddings)) return null;
        return json.embeddings.map(e => e.values);
    }
    return null;
}

// ─── Generation requests (pure) ─────────────────────────────────────────────────

/**
 * Build the HTTP request for one non-streaming generation call.
 *
 * Sampling parameters are passed only to Ollama: the cloud providers disagree
 * on which parameters their current models accept (several reject an explicit
 * temperature), and the enrichment/rerank prompts steer format by instruction.
 *
 * @param {string} provider
 * @param {object} p  { model, ollamaHost, apiKey, prompt, maxTokens, temperature }
 * @returns {{url: string, headers: object, body: object}}
 */
export function buildGenerateRequest(provider, { model, ollamaHost, apiKey, prompt, maxTokens = 256, temperature = 0.1 }, env = process.env) {
    if (provider === 'ollama') {
        return {
            url: `${ollamaHost}/api/generate`,
            headers: { 'Content-Type': 'application/json' },
            body: { model, prompt, stream: false, options: { temperature, num_predict: maxTokens } },
        };
    }
    if (provider === 'openai') {
        return {
            url: `${baseUrl('openai', env)}/chat/completions`,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: { model, messages: [{ role: 'user', content: prompt }], max_completion_tokens: maxTokens },
        };
    }
    if (provider === 'anthropic') {
        return {
            url: `${baseUrl('anthropic', env)}/v1/messages`,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
        };
    }
    if (provider === 'gemini') {
        return {
            url: `${baseUrl('gemini', env)}/models/${model}:generateContent`,
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
        };
    }
    throw new Error(`Unknown generation provider '${provider}'.`);
}

/** Extract the generated text from a generation response. @returns {string|null} */
export function parseGenerateResponse(provider, json) {
    if (!json) return null;
    let text = null;
    if (provider === 'ollama') {
        text = json.response;
    } else if (provider === 'openai') {
        text = json.choices?.[0]?.message?.content;
    } else if (provider === 'anthropic') {
        text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    } else if (provider === 'gemini') {
        text = (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    }
    text = typeof text === 'string' ? text.trim() : '';
    return text || null;
}

// ─── Runtime wrappers ───────────────────────────────────────────────────────────

// One stderr warning per provider per process — a dead endpoint during a batch
// run would otherwise print thousands of identical lines.
const _warned = new Set();
function warnOnce(key, message) {
    if (_warned.has(key)) return;
    _warned.add(key);
    process.stderr.write(`[providers] ⚠️ ${message}\n`);
}

async function postJson({ url, headers, body }, timeoutMs) {
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 200); } catch { /* body unavailable */ }
        throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    }
    return res.json();
}

/**
 * Build the embedding client for the resolved configuration.
 *
 * @param {object} config  Resolved config (uses embedProvider, embedModel, ollamaHost).
 * @param {object} [opts]
 * @param {object} [opts.env]  Defaults to process.env.
 * @returns {{
 *   provider: string, model: string,
 *   available: () => {ok: boolean, reason?: string},
 *   embedQuery: (text: string) => Promise<number[]|null>,
 *   embedDocuments: (texts: string[]) => Promise<number[][]|null>,
 * }}
 */
export function createEmbedder(config, { env = process.env } = {}) {
    const provider = config.embedProvider;
    const model = config.embedModel;
    const apiKey = resolveApiKey(provider, env);

    const available = () => {
        if (!PROVIDER_DEFAULTS[provider]) return { ok: false, reason: `unknown provider '${provider}'` };
        if (!PROVIDER_DEFAULTS[provider].embedModel) {
            return {
                ok: false,
                reason: `${PROVIDER_DEFAULTS[provider].label} offers no embeddings API — set "embedProvider" to ollama, openai or gemini`,
            };
        }
        if (provider !== 'ollama' && !apiKey) {
            return { ok: false, reason: `${PROVIDER_DEFAULTS[provider].apiKeyEnv} is not set` };
        }
        return { ok: true };
    };

    const MAX_RETRIES = 3;
    async function embed(texts, kind, timeoutMs) {
        if (env.INDEXER_EMBEDDINGS === 'off') return null; // lexical-only mode
        if (texts.length === 0) return [];
        const ready = available();
        if (!ready.ok) {
            warnOnce(`embed:${provider}`, `${provider} embeddings unavailable (${ready.reason}) — running lexical-only.`);
            return null;
        }
        const clamped = texts.map(t => clampForEmbedding(provider, t));
        const request = buildEmbedRequest(provider, {
            model, ollamaHost: config.ollamaHost, apiKey, texts: clamped, kind,
        }, env);
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const vectors = parseEmbedResponse(provider, await postJson(request, timeoutMs));
                if (vectors && vectors.length === texts.length) return vectors;
                throw new Error('response carried no usable vectors');
            } catch (err) {
                if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
                else warnOnce(`embed:${provider}:fail`, `${provider} embedding request failed (${err.message}).`);
            }
        }
        return null;
    }

    return {
        provider,
        model,
        available,
        embedQuery: async (text) => (await embed([text], 'query', 15000))?.[0] ?? null,
        embedDocuments: (texts) => embed(texts, 'document', 60000),
    };
}

/**
 * Build a best-effort generation function for one channel of the resolved
 * configuration. Any failure (missing key, unreachable endpoint, malformed
 * response) returns null — enrichment and rerank treat that as "no result".
 *
 * @param {object} config   Resolved config.
 * @param {'enrichment'|'rerank'} [channel]
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @returns {(prompt: string, opts?: {timeoutMs?: number, maxTokens?: number, temperature?: number}) => Promise<string|null>}
 */
export function createGenerator(config, channel = 'enrichment', { env = process.env } = {}) {
    const { provider, model } = config[channel];
    const apiKey = resolveApiKey(provider, env);

    return async (prompt, { timeoutMs = 30000, maxTokens = 256, temperature = 0.1 } = {}) => {
        if (provider !== 'ollama' && !apiKey) {
            warnOnce(`gen:${provider}`, `${provider} generation unavailable (${PROVIDER_DEFAULTS[provider]?.apiKeyEnv} is not set).`);
            return null;
        }
        try {
            const request = buildGenerateRequest(provider, {
                model, ollamaHost: config.ollamaHost, apiKey, prompt, maxTokens, temperature,
            }, env);
            return parseGenerateResponse(provider, await postJson(request, timeoutMs));
        } catch (err) {
            warnOnce(`gen:${provider}:fail`, `${provider} generation request failed (${err.message}).`);
            return null;
        }
    };
}

/**
 * Single non-streaming Ollama generation call. Kept as a named export for the
 * evaluation harness, which measures the local-rerank pipeline specifically.
 * @returns {Promise<string|null>}
 */
export async function ollamaGenerate(prompt, { model, ollamaHost, timeoutMs = 30000, options = null } = {}) {
    try {
        const json = await postJson({
            url: `${ollamaHost}/api/generate`,
            headers: { 'Content-Type': 'application/json' },
            body: { model, prompt, stream: false, options: options || { temperature: 0.1, num_predict: 150 } },
        }, timeoutMs);
        return (json.response || '').trim() || null;
    } catch {
        return null;
    }
}
