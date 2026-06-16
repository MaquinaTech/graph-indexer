/**
 * @file test/embeddings.mjs
 * @description Tests the embedding-provider abstraction that makes semantic search
 *              work with no Ollama daemon: the auto policy (Ollama → in-process
 *              local → lexical), forced providers, graceful failure, the embed-meta
 *              sidecar, and model-switch detection. Provider selection and the
 *              embedder are exercised with injected backends (deterministic, no
 *              network); a final gated test embeds with the REAL local model when
 *              the optional dependency is installed.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    resolveEmbedProvider, createEmbedder, localEmbedAvailable,
    readEmbedMeta, writeEmbedMeta, embedMetaPath, describeEmbedder,
    LOCAL_EMBED_DIM, _resetLocalPipeline,
} from '../embeddings.mjs';

const baseConfig = {
    embeddingsEnabled: true,
    embedProvider: 'auto',
    embedModel: 'nomic-embed-text',
    localEmbedModel: 'Xenova/all-MiniLM-L6-v2',
    ollamaHost: 'http://localhost:11434',
};
const up = async () => true;
const down = async () => false;

test('auto prefers Ollama when reachable', async () => {
    const r = await resolveEmbedProvider(baseConfig, { probe: up, hasLocal: up });
    assert.deepEqual(r, { provider: 'ollama', model: 'nomic-embed-text' });
});

test('auto falls back to the in-process local model when Ollama is down', async () => {
    const r = await resolveEmbedProvider(baseConfig, { probe: down, hasLocal: up });
    assert.deepEqual(r, { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2' });
});

test('auto falls back to lexical when neither is available', async () => {
    const r = await resolveEmbedProvider(baseConfig, { probe: down, hasLocal: down });
    assert.equal(r.provider, 'off');
});

test('embeddings disabled forces off regardless of policy', async () => {
    const r = await resolveEmbedProvider({ ...baseConfig, embeddingsEnabled: false }, { probe: up, hasLocal: up });
    assert.equal(r.provider, 'off');
});

test('forced providers skip probing', async () => {
    assert.equal((await resolveEmbedProvider({ ...baseConfig, embedProvider: 'ollama' }, { probe: down, hasLocal: down })).provider, 'ollama');
    assert.equal((await resolveEmbedProvider({ ...baseConfig, embedProvider: 'local' }, { probe: up, hasLocal: down })).provider, 'local');
    assert.equal((await resolveEmbedProvider({ ...baseConfig, embedProvider: 'off' }, { probe: up, hasLocal: up })).provider, 'off');
});

test('createEmbedder routes to the resolved backend and learns dim', async () => {
    const calls = { q: 0, d: 0 };
    const backends = {
        ollamaEmbedOne: async () => { calls.q++; return [1, 2, 3]; },
        ollamaEmbedMany: async (h, m, texts) => { calls.d++; return texts.map(() => [1, 2, 3, 4]); },
        localEmbedMany: async () => { throw new Error('should not be called'); },
    };
    const e = await createEmbedder(baseConfig, { provider: 'ollama', backends });
    assert.equal((await e.embedQuery('hi')).length, 3);
    const docs = await e.embedDocuments(['a', 'b']);
    assert.equal(docs.length, 2);
    assert.equal(e.dim, 4, 'dim learned from the first document batch');
    assert.equal(calls.q, 1); assert.equal(calls.d, 1);
});

test('embedQuery degrades to null on backend failure (lexical fallback)', async () => {
    const backends = { ollamaEmbedOne: async () => { throw new Error('connrefused'); } };
    const e = await createEmbedder(baseConfig, { provider: 'ollama', backends });
    assert.equal(await e.embedQuery('hi'), null);
});

test('off provider returns null without touching any backend', async () => {
    const e = await createEmbedder(baseConfig, { provider: 'off' });
    assert.equal(await e.embedQuery('hi'), null);
    assert.equal(await e.embedDocuments(['a']), null);
});

test('embed-meta sidecar round-trips next to the bin', () => {
    const tmp = path.join(os.tmpdir(), `embmeta-${process.pid}.bin`);
    assert.equal(readEmbedMeta(tmp), null, 'missing meta reads as null');
    writeEmbedMeta(tmp, { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dim: 384 });
    assert.equal(embedMetaPath(tmp), tmp + '.meta.json');
    assert.deepEqual(readEmbedMeta(tmp), { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dim: 384 });
    fs.rmSync(tmp + '.meta.json', { force: true });
});

test('describeEmbedder labels each provider', () => {
    assert.match(describeEmbedder({ provider: 'ollama', model: 'nomic-embed-text' }), /Ollama/);
    assert.match(describeEmbedder({ provider: 'local', model: 'x' }), /Local/);
    assert.match(describeEmbedder({ provider: 'off' }), /Lexical/);
});

// ── Real local model (gated on the optional dependency) ──────────────────────
test('real local model embeds with the expected dim and sane geometry', async () => {
    if (!(await localEmbedAvailable())) { console.log('  ⚠️  @huggingface/transformers not installed — skipping real-model test'); return; }
    _resetLocalPipeline();
    const e = await createEmbedder(baseConfig, { provider: 'local' });
    const q = await e.embedQuery('validate a JWT bearer token');
    assert.equal(q.length, LOCAL_EMBED_DIM, 'local model produces 384-dim vectors');
    assert.equal(e.dim, LOCAL_EMBED_DIM);

    const [related, unrelated] = await e.embedDocuments([
        'refresh an expired authentication session for a request',
        'compute the median of a list of integers',
    ]);
    const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };
    assert.ok(cos(q, related) > cos(q, unrelated), 'auth query is closer to the auth doc than the math doc');
});
