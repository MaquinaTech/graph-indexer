#!/usr/bin/env node
/**
 * test/providers.mjs
 *
 * Unit tests for the AI provider abstraction (providers.mjs) and the provider
 * facets of config resolution (config.mjs). Pure request-building and
 * response-parsing — no network, no fixtures.
 *
 *   node test/providers.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    PROVIDER_DEFAULTS, PROVIDER_IDS, resolveApiKey, clampForEmbedding, createEmbedder,
    buildEmbedRequest, parseEmbedResponse, buildGenerateRequest, parseGenerateResponse,
} from '../providers.mjs';
import { resolveConfig } from '../config.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ✗ ${name}\n      ${err.message}`);
    }
}

console.log('\nPROVIDER TESTS\n');

// ─── Registry / keys ─────────────────────────────────────────────────────────

test('every provider id has defaults and a generation model', () => {
    for (const id of PROVIDER_IDS) {
        assert.ok(PROVIDER_DEFAULTS[id], `missing defaults for ${id}`);
        assert.ok(PROVIDER_DEFAULTS[id].enrichModel, `missing enrichModel for ${id}`);
        assert.ok(PROVIDER_DEFAULTS[id].rerankModel, `missing rerankModel for ${id}`);
    }
});

test('resolveApiKey reads the standard env vars (GOOGLE_API_KEY fallback for gemini)', () => {
    assert.equal(resolveApiKey('openai', { OPENAI_API_KEY: 'sk-1' }), 'sk-1');
    assert.equal(resolveApiKey('anthropic', { ANTHROPIC_API_KEY: 'sk-2' }), 'sk-2');
    assert.equal(resolveApiKey('gemini', { GEMINI_API_KEY: 'g-1' }), 'g-1');
    assert.equal(resolveApiKey('gemini', { GOOGLE_API_KEY: 'g-2' }), 'g-2');
    assert.equal(resolveApiKey('ollama', { OPENAI_API_KEY: 'sk-1' }), null);
    assert.equal(resolveApiKey('openai', {}), null);
});

test('clampForEmbedding enforces per-provider input limits', () => {
    const long = 'x'.repeat(20000);
    assert.equal(clampForEmbedding('ollama', long).length, 8000);
    assert.equal(clampForEmbedding('openai', long).length, 8000);
    assert.equal(clampForEmbedding('gemini', long).length, 6000);
    assert.equal(clampForEmbedding('ollama', 'short'), 'short');
});

// ─── Embedding requests ──────────────────────────────────────────────────────

test('ollama embed request keeps the nomic search prefixes per kind', () => {
    const doc = buildEmbedRequest('ollama', {
        model: 'nomic-embed-text', ollamaHost: 'http://localhost:11434', texts: ['a', 'b'], kind: 'document',
    });
    assert.equal(doc.url, 'http://localhost:11434/api/embed');
    assert.deepEqual(doc.body.input, ['search_document: a', 'search_document: b']);

    const q = buildEmbedRequest('ollama', {
        model: 'nomic-embed-text', ollamaHost: 'http://localhost:11434', texts: ['find auth'], kind: 'query',
    });
    assert.deepEqual(q.body.input, ['search_query: find auth']);
});

test('openai embed request carries bearer auth and raw texts', () => {
    const r = buildEmbedRequest('openai', {
        model: 'text-embedding-3-small', apiKey: 'sk-test', texts: ['hello'], kind: 'query',
    }, {});
    assert.equal(r.url, 'https://api.openai.com/v1/embeddings');
    assert.equal(r.headers.Authorization, 'Bearer sk-test');
    assert.deepEqual(r.body, { model: 'text-embedding-3-small', input: ['hello'] });
});

test('gemini embed request batches with retrieval taskType', () => {
    const r = buildEmbedRequest('gemini', {
        model: 'gemini-embedding-001', apiKey: 'g-test', texts: ['a', 'b'], kind: 'document',
    }, {});
    assert.match(r.url, /models\/gemini-embedding-001:batchEmbedContents$/);
    assert.equal(r.headers['x-goog-api-key'], 'g-test');
    assert.equal(r.body.requests.length, 2);
    assert.equal(r.body.requests[0].taskType, 'RETRIEVAL_DOCUMENT');
    assert.equal(r.body.requests[1].content.parts[0].text, 'b');
});

test('anthropic embed request throws (no embeddings API)', () => {
    assert.throws(() => buildEmbedRequest('anthropic', { model: 'x', texts: ['a'], kind: 'query' }));
});

test('parseEmbedResponse handles each provider shape (openai re-ordered by index)', () => {
    assert.deepEqual(parseEmbedResponse('ollama', { embeddings: [[1], [2]] }), [[1], [2]]);
    assert.deepEqual(
        parseEmbedResponse('openai', { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }),
        [[1], [2]]
    );
    assert.deepEqual(parseEmbedResponse('gemini', { embeddings: [{ values: [3] }] }), [[3]]);
    assert.equal(parseEmbedResponse('ollama', {}), null);
    assert.equal(parseEmbedResponse('openai', null), null);
});

// ─── Generation requests ─────────────────────────────────────────────────────

test('ollama generate request keeps sampling options', () => {
    const r = buildGenerateRequest('ollama', {
        model: 'qwen2.5-coder:1.5b', ollamaHost: 'http://localhost:11434',
        prompt: 'p', maxTokens: 150, temperature: 0.1,
    });
    assert.equal(r.url, 'http://localhost:11434/api/generate');
    assert.deepEqual(r.body.options, { temperature: 0.1, num_predict: 150 });
    assert.equal(r.body.stream, false);
});

test('openai generate request uses chat completions with max_completion_tokens', () => {
    const r = buildGenerateRequest('openai', { model: 'gpt-4o-mini', apiKey: 'sk', prompt: 'p', maxTokens: 40 }, {});
    assert.equal(r.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(r.body.max_completion_tokens, 40);
    assert.deepEqual(r.body.messages, [{ role: 'user', content: 'p' }]);
    assert.equal(r.body.temperature, undefined); // sampling params are Ollama-only
});

test('anthropic generate request uses the Messages API with versioned headers', () => {
    const r = buildGenerateRequest('anthropic', { model: 'claude-haiku-4-5', apiKey: 'sk', prompt: 'p', maxTokens: 150 }, {});
    assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(r.headers['x-api-key'], 'sk');
    assert.equal(r.headers['anthropic-version'], '2023-06-01');
    assert.equal(r.body.max_tokens, 150);
    assert.deepEqual(r.body.messages, [{ role: 'user', content: 'p' }]);
});

test('gemini generate request shapes contents correctly', () => {
    const r = buildGenerateRequest('gemini', { model: 'gemini-2.5-flash-lite', apiKey: 'g', prompt: 'p' }, {});
    assert.match(r.url, /models\/gemini-2.5-flash-lite:generateContent$/);
    assert.deepEqual(r.body.contents, [{ role: 'user', parts: [{ text: 'p' }] }]);
});

test('parseGenerateResponse extracts text from each provider shape', () => {
    assert.equal(parseGenerateResponse('ollama', { response: ' hi ' }), 'hi');
    assert.equal(parseGenerateResponse('openai', { choices: [{ message: { content: 'hi' } }] }), 'hi');
    assert.equal(
        parseGenerateResponse('anthropic', { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
        'ab'
    );
    assert.equal(
        parseGenerateResponse('gemini', { candidates: [{ content: { parts: [{ text: 'hi' }] } }] }),
        'hi'
    );
    assert.equal(parseGenerateResponse('openai', { choices: [] }), null);
    assert.equal(parseGenerateResponse('anthropic', { content: [] }), null);
    assert.equal(parseGenerateResponse('ollama', null), null);
});

// ─── Config resolution (provider + storage facets) ───────────────────────────

const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-config-'));
const resolve = (argv = [], env = {}, cwd = emptyDir) => resolveConfig({ argv, env, cwd });

test('defaults: ollama provider, memory storage, nomic embeddings', () => {
    const c = resolve();
    assert.equal(c.provider, 'ollama');
    assert.equal(c.embedProvider, 'ollama');
    assert.equal(c.embedModel, 'nomic-embed-text');
    assert.equal(c.storage, 'memory');
    assert.equal(c.enrichment.model, 'qwen2.5-coder:1.5b');
    assert.equal(c.rerank.model, 'qwen2.5-coder:7b');
});

test('--provider openai switches every channel to OpenAI defaults', () => {
    const c = resolve(['--provider', 'openai']);
    assert.equal(c.embedProvider, 'openai');
    assert.equal(c.embedModel, 'text-embedding-3-small');
    assert.equal(c.enrichment.provider, 'openai');
    assert.equal(c.enrichment.model, 'gpt-4o-mini');
    assert.equal(c.rerank.provider, 'openai');
});

test('anthropic provider does NOT silently fall back for embeddings', () => {
    const c = resolve(['--provider', 'anthropic']);
    assert.equal(c.provider, 'anthropic');
    assert.equal(c.embedProvider, 'anthropic');     // resolved as-is …
    assert.equal(c.embedModel, null);
    assert.equal(c.enrichment.model, 'claude-haiku-4-5');
    const ready = createEmbedder(c, { env: { ANTHROPIC_API_KEY: 'sk' } }).available();
    assert.equal(ready.ok, false);                  // … and reported unusable, never substituted
    assert.match(ready.reason, /no embeddings API/);
});

test('--embed-provider routes the embedding channel explicitly', () => {
    const c = resolve(['--provider', 'anthropic', '--embed-provider', 'gemini']);
    assert.equal(c.embedProvider, 'gemini');
    assert.equal(c.embedModel, 'gemini-embedding-001');
    assert.equal(c.enrichment.provider, 'anthropic');
});

test('per-channel overrides win over the top-level provider', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-config-'));
    fs.writeFileSync(path.join(dir, '.graph-indexer.json'), JSON.stringify({
        provider: 'openai',
        embedProvider: 'gemini',
        enrichment: { provider: 'anthropic' },
    }));
    const c = resolve([], {}, dir);
    assert.equal(c.embedProvider, 'gemini');
    assert.equal(c.embedModel, 'gemini-embedding-001');
    assert.equal(c.enrichment.provider, 'anthropic');
    assert.equal(c.enrichment.model, 'claude-haiku-4-5');
    assert.equal(c.rerank.provider, 'openai');
});

test('invalid provider values fall back to the default', () => {
    const c = resolve(['--provider', 'skynet']);
    assert.equal(c.provider, 'ollama');
});

test('storage flags and config keys select the backend (memory default)', () => {
    assert.equal(resolve().storage, 'memory');
    assert.equal(resolve(['--use-sqlite']).storage, 'sqlite');
    assert.equal(resolve(['--use-postgres']).storage, 'postgres');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-config-'));
    fs.writeFileSync(path.join(dir, '.graph-indexer.json'), JSON.stringify({ storage: 'postgres' }));
    assert.equal(resolve([], {}, dir).storage, 'postgres');
});

test('postgres url: env beats the config file; schema defaults to graph_indexer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-config-'));
    fs.writeFileSync(path.join(dir, '.graph-indexer.json'), JSON.stringify({
        storage: 'postgres', postgres: { url: 'postgres://file/db' },
    }));
    assert.equal(resolve([], {}, dir).postgres.url, 'postgres://file/db');
    assert.equal(resolve([], { GRAPH_INDEXER_PG_URL: 'postgres://env/db' }, dir).postgres.url, 'postgres://env/db');
    assert.equal(resolve([], { DATABASE_URL: 'postgres://dburl/db' }, dir).postgres.url, 'postgres://dburl/db');
    assert.equal(resolve([], {}, dir).postgres.schema, 'graph_indexer');
});

test('OLLAMA_HOST binding addresses are normalised to client URLs', () => {
    assert.equal(resolve([], { OLLAMA_HOST: '0.0.0.0:11435' }).ollamaHost, 'http://localhost:11435');
    assert.equal(resolve([], { OLLAMA_HOST: 'http://gpu-box:11434' }).ollamaHost, 'http://gpu-box:11434');
});

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
