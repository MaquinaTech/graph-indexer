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
    MLX_EMBED_MODEL,
} from '../embeddings.mjs';
import {
    embeddingWindows, baseEmbeddingKey, EMBEDDING_CONTEXT_LIMIT, EMBEDDING_MAX_WINDOWS,
    WINDOW_VEC_SUFFIX,
} from '../search-core.mjs';
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { writeEmbeddingBinary } from '../engine/binary.mjs';
import { buildEmbeddingPayload, fullBodyForEmbedding } from '../parse/imports.mjs';

const baseConfig = {
    embeddingsEnabled: true,
    embedProvider: 'auto',
    embedModel: 'nomic-embed-text',
    localEmbedModel: 'Xenova/all-MiniLM-L6-v2',
    ollamaHost: 'http://localhost:11434',
};
const up = async () => true;
const down = async () => false;

test('auto prefers Ollama when reachable AND the embed model is pulled', async () => {
    const r = await resolveEmbedProvider(baseConfig, { probe: up, hasLocal: up, hasModel: up });
    assert.deepEqual(r, { provider: 'ollama', model: 'nomic-embed-text' });
});

test('auto falls back to the in-process local model when Ollama is up but the embed model is NOT pulled', async () => {
    // The configured embedModel was never `ollama pull`-ed — don't crash the indexer.
    const r = await resolveEmbedProvider(baseConfig, { probe: up, hasLocal: up, hasModel: down });
    assert.deepEqual(r, { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2' });
});

test('auto falls back to the in-process local model when Ollama is down', async () => {
    const r = await resolveEmbedProvider(baseConfig, { probe: down, hasLocal: up, hasModel: down });
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

// ── Native Python embedder: mlx (Apple Metal) ─────────────────────────────────
// Deterministic, no Python: only provider resolution, the model id, and the platform
// guard are exercised here (the subprocess path needs the venv deps).
const _withPlatform = async (p, fn) => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
    try { return await fn(); } finally { Object.defineProperty(process, 'platform', real); }
};

test('forced mlx resolves to its model id (default + user override)', async () => {
    // The resolved model is passed to the Python server AND stamped into the .meta.json
    // sidecar, so switching it must trigger a clean re-embed.
    await _withPlatform('darwin', async () => {
        assert.deepEqual(
            await resolveEmbedProvider({ ...baseConfig, embedProvider: 'mlx' }, { probe: down, hasLocal: down }),
            { provider: 'mlx', model: MLX_EMBED_MODEL });
        // A user-supplied mlxEmbedModel wins over the pinned default.
        assert.deepEqual(
            await resolveEmbedProvider({ ...baseConfig, embedProvider: 'mlx', mlxEmbedModel: 'mlx-community/custom' }, { probe: down, hasLocal: down }),
            { provider: 'mlx', model: 'mlx-community/custom' });
    });
});

test('platform guard: mlx is macOS-only', async () => {
    await _withPlatform('linux', async () => {
        await assert.rejects(() => resolveEmbedProvider({ ...baseConfig, embedProvider: 'mlx' }), /macOS/);
    });
    await _withPlatform('win32', async () => {
        await assert.rejects(() => resolveEmbedProvider({ ...baseConfig, embedProvider: 'mlx' }), /macOS/);
    });
});

test('embeddings disabled forces off even for mlx (before the platform guard)', async () => {
    // off short-circuits first, so this holds on every platform without an override.
    assert.equal((await resolveEmbedProvider({ ...baseConfig, embeddingsEnabled: false, embedProvider: 'mlx' })).provider, 'off');
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
    assert.match(describeEmbedder({ provider: 'mlx', model: 'x' }), /MLX/);
    assert.match(describeEmbedder({ provider: 'off' }), /Lexical/);
});

// ── Window-and-pool sub-chunking for the dense channel ───────────────────────

test('embeddingWindows: small payloads keep one vector; oversized split with bounded, overlapping windows', () => {
    assert.deepEqual(embeddingWindows('short payload'), []);
    assert.deepEqual(embeddingWindows('x'.repeat(EMBEDDING_CONTEXT_LIMIT)), []);

    const payload = 'HEAD_' + 'a'.repeat(EMBEDDING_CONTEXT_LIMIT) + '_TAIL';
    const w = embeddingWindows(payload);
    assert.ok(w.length >= 2, 'oversized payload splits');
    assert.equal(w[0], payload.slice(0, EMBEDDING_CONTEXT_LIMIT), 'window 0 == the old truncated head');
    assert.ok(w.every(s => s.length <= EMBEDDING_CONTEXT_LIMIT), 'every window respects the context limit');
    assert.ok(w[1].endsWith('_TAIL'), 'a later window reaches the tail the single vector dropped');

    const huge = embeddingWindows('z'.repeat(EMBEDDING_CONTEXT_LIMIT * 50));
    assert.equal(huge.length, EMBEDDING_MAX_WINDOWS, 'window count is capped');

    assert.equal(baseEmbeddingKey('h1' + WINDOW_VEC_SUFFIX + 2), 'h1');
    assert.equal(baseEmbeddingKey('h1|s'), 'h1');
    assert.equal(baseEmbeddingKey('h1'), 'h1');
});

test('fullBodyForEmbedding: returns the full body only for truncated, non-skeleton chunks', () => {
    const lines = [];
    for (let i = 0; i < 200; i++) lines.push(`  doThing_${i}(); // line ${i} of a large function body well past the snippet cap`);
    const content = `function big() {\n${lines.join('\n')}\n}\n`;
    const end = content.split('\n').length;

    const body = fullBodyForEmbedding({ code_snippet: 'x'.repeat(3000), start_line: 1, end_line: end }, content);
    assert.ok(body && body.length > 3000, 'truncated chunk yields its full body for windowing');

    assert.equal(fullBodyForEmbedding({ code_snippet: 'short body', start_line: 1, end_line: 3 }, content), null);
    assert.equal(
        fullBodyForEmbedding({ code_snippet: 'x'.repeat(3000) + ' // Large class: 999 lines', start_line: 1, end_line: end }, content),
        null, 'god-class skeleton is not windowed over the whole class');
});

// A large free function: only its tail matches the query. Without windowing the tail
// is past EMBEDDING_CONTEXT_LIMIT and invisible to the dense channel; with windowing
// the chunk is retrieved by the MAX cosine over its windows. Deterministic vectors,
// no network — exercises the real eager-load fold (core-engine load path).
function buildWindowedIndex(includeWindowVector) {
    const HEAD = 'HEADNEEDLE';
    const TAIL = 'TAILNEEDLE';
    const bigSnippet = HEAD + 'x'.repeat(9000) + TAIL + 'y'.repeat(2000);
    const bigChunk = {
        id: 'big1', file_path: 'src/big.ts', node_type: 'function_declaration',
        name: 'processEverything', docstring: '', code_snippet: bigSnippet, content_hash: 'big',
        start_line: 1, end_line: 400, calls: [], params: [], return_type: '',
        class_context: '', type_refs: [], decorators: [], extends: [], call_sites: [],
    };
    const distractor = {
        id: 'small1', file_path: 'src/other.ts', node_type: 'function_declaration',
        name: 'helper', docstring: '', code_snippet: 'function helper(){ return 1; }', content_hash: 'small',
        start_line: 1, end_line: 3, calls: [], params: [], return_type: '',
        class_context: '', type_refs: [], decorators: [], extends: [], call_sites: [],
    };

    const payload = buildEmbeddingPayload(bigChunk, []);
    const windows = embeddingWindows(payload);
    assert.equal(windows.length, 2, 'fixture payload is exactly two windows');
    assert.ok(!windows[0].includes('TAILNEEDLE'), 'tail marker is past window 0');
    assert.ok(windows[1].includes('TAILNEEDLE'), 'window 1 covers the tail');

    const headVec = new Float32Array([1, 0, 0, 0]);
    const tailVec = new Float32Array([0, 1, 0, 0]);
    const distVec = new Float32Array([0, 0, 1, 0]);
    const cache = new Map([['big', headVec], ['small', distVec]]);
    if (includeWindowVector) cache.set('big' + WINDOW_VEC_SUFFIX + 1, tailVec);

    const memJson = path.join(os.tmpdir(), `winemb-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const memBin = memJson.replace(/\.json$/, '.embeddings.bin');
    fs.writeFileSync(memJson, JSON.stringify({
        chunks: [bigChunk, distractor],
        graph: { dependencies: { 'src/big.ts': [], 'src/other.ts': [] }, importedBy: {} },
    }));
    fs.writeFileSync(memBin, writeEmbeddingBinary(cache));
    const mem = new MemoryGraphIndex(memJson);
    mem.load();
    return { mem, cleanup: () => { for (const f of [memJson, memBin]) try { fs.unlinkSync(f); } catch {} } };
}

test('oversized definition: a tail-only query retrieves it via a window vector (max-sim)', () => {
    const queryVec = new Float32Array([0, 1, 0, 0]);
    const win = buildWindowedIndex(true);
    try {
        const hits = win.mem.searchHybrid('completely unrelated query text', queryVec, 5, 0.0).map(r => r.chunk.id);
        assert.ok(hits.includes('big1'), 'windowed: tail-only query reaches the oversized function');
    } finally { win.cleanup(); }

    const base = buildWindowedIndex(false);
    try {
        const hits = base.mem.searchHybrid('completely unrelated query text', queryVec, 5, 0.0).map(r => r.chunk.id);
        assert.ok(!hits.includes('big1'), 'baseline: the tail is invisible without windowing');
    } finally { base.cleanup(); }
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
