/**
 * @file test/colbert.mjs
 * @description B4 — ColBERT-style late-interaction reranker tests. No model/network: deterministic
 *              vectors are written into a real `.embeddings.bin` and a fake embedder injects query
 *              multi-vectors. Covers: the MaxSim math; loadChunkVectors reading a chunk's base/
 *              summary/window sub-vectors from the bin (and memory↔sqlite reading the SAME bytes →
 *              parity); rerankLateInteraction rescuing a deep-but-relevant candidate, preserving the
 *              tail, never mutating scores; and the best-effort no-ops (no query vectors / no bin /
 *              <2 candidates with vectors) that keep the default path byte-identical.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { cosine, maxSimScore, loadChunkVectors, encodeMultiVector, rerankLateInteraction } from '../colbert.mjs';
import { writeEmbeddingBinary } from '../engine/binary.mjs';
import { SUMMARY_VEC_SUFFIX, WINDOW_VEC_SUFFIX } from '../search-core.mjs';

const tmp = (ext) => path.join(os.tmpdir(), `colbert-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`);
const v = (...xs) => new Float32Array(xs);

// ── MaxSim math ───────────────────────────────────────────────────────────────────────────────
test('colbert (B4): cosine + maxSimScore are correct and order-independent', () => {
    assert.ok(Math.abs(cosine(v(1, 0), v(1, 0)) - 1) < 1e-9, 'identical → 1');
    assert.ok(Math.abs(cosine(v(1, 0), v(0, 1))) < 1e-9, 'orthogonal → 0');
    assert.equal(cosine(v(0, 0), v(1, 0)), 0, 'degenerate → 0');
    // two query vectors, three doc vectors: each query takes its best doc match, summed.
    const q = [v(1, 0, 0), v(0, 1, 0)];
    const d = [v(1, 0, 0), v(0, 0, 1)];          // q0 matches d0 (1.0); q1 matches nothing well (0)
    assert.ok(Math.abs(maxSimScore(q, d) - 1) < 1e-9, 'Σ max: 1 + 0');
    const d2 = [v(0.9, 0.1, 0), v(0.1, 0.9, 0)]; // q0→d2[0]≈.99, q1→d2[1]≈.99
    assert.ok(maxSimScore(q, d2) > 1.9, 'both queries find a near-match');
    assert.equal(maxSimScore(q, d2), maxSimScore(q, [...d2].reverse()), 'order-independent');
    assert.equal(maxSimScore([], d), 0); assert.equal(maxSimScore(q, []), 0);
});

// ── loadChunkVectors reads a chunk's base/summary/window sub-vectors from the bin ───────────────
test('colbert (B4): loadChunkVectors gathers a chunk\'s stored sub-vectors (base + summary + windows)', () => {
    const chunk = { id: 'c1', content_hash: 'h1' };          // embeddingKeyFor → content_hash (no enrichment)
    const cache = new Map([
        ['h1', v(1, 0, 0)],
        ['h1' + SUMMARY_VEC_SUFFIX, v(0, 1, 0)],
        ['h1' + WINDOW_VEC_SUFFIX + '1', v(0, 0, 1)],
        ['other', v(9, 9, 9)],                                // must NOT be picked up
    ]);
    const bin = tmp('.bin');
    fs.writeFileSync(bin, writeEmbeddingBinary(cache));
    const got = loadChunkVectors(bin, [chunk]);
    fs.rmSync(bin, { force: true });
    const vecs = got.get('c1');
    assert.equal(vecs.length, 3, 'base + summary + 1 window');
    assert.deepEqual([...vecs[0]], [1, 0, 0], 'base first');
    assert.deepEqual([...vecs[1]], [0, 1, 0], 'summary second');
    assert.deepEqual([...vecs[2]], [0, 0, 1], 'window third');
    // a chunk with no content_hash → []
    assert.deepEqual(loadChunkVectors(bin, [{ id: 'x' }]).get('x'), []);
    // missing bin → empty (never throws)
    assert.deepEqual(loadChunkVectors(tmp('.bin'), [chunk]).get('c1'), []);
});

// ── rerankLateInteraction: rescue + tail + score-immutability + best-effort no-ops ─────────────
function fixtureBin() {
    // Three candidates. The query will be [ (1,0,0), (0,1,0) ]. c3 (deep) matches both query vectors
    // best → MaxSim should rescue it to the top; c1 matches only the first; c2 matches neither.
    const cache = new Map([
        ['ha', v(1, 0, 0)],
        ['hb', v(0, 0, 1)],
        ['hc', v(0.95, 0.05, 0)], ['hc' + SUMMARY_VEC_SUFFIX, v(0.05, 0.95, 0)],
    ]);
    const bin = tmp('.bin');
    fs.writeFileSync(bin, writeEmbeddingBinary(cache));
    return bin;
}
const RESULTS = () => [
    { chunk: { id: 'c1', content_hash: 'ha' }, score: 0.9 },
    { chunk: { id: 'c2', content_hash: 'hb' }, score: 0.8 },
    { chunk: { id: 'c3', content_hash: 'hc' }, score: 0.1 },   // deep, but the best late-interaction match
];
const Q = [v(1, 0, 0), v(0, 1, 0)];

test('colbert (B4): rerankLateInteraction rescues the deep best-MaxSim candidate to the top', () => {
    const bin = fixtureBin();
    const out = rerankLateInteraction(RESULTS(), { qVecs: Q, binPath: bin, topM: 12 });
    fs.rmSync(bin, { force: true });
    assert.equal(out[0].chunk.id, 'c3', 'c3 (matches both query vectors via base+summary) rises to #1');
    assert.deepEqual(out.map(r => r.score), [0.1, 0.9, 0.8], 'fused scores are NEVER mutated by the reranker');
});

test('colbert (B4): best-effort no-ops keep the original order (default-path safety)', () => {
    const bin = fixtureBin();
    const base = RESULTS();
    assert.deepEqual(rerankLateInteraction(base, { qVecs: [], binPath: bin }).map(r => r.chunk.id),
        ['c1', 'c2', 'c3'], 'no query vectors → original order');
    assert.deepEqual(rerankLateInteraction(base, { qVecs: Q, binPath: null }).map(r => r.chunk.id),
        ['c1', 'c2', 'c3'], 'no bin path → original order');
    assert.deepEqual(rerankLateInteraction([base[0]], { qVecs: Q, binPath: bin }).map(r => r.chunk.id),
        ['c1'], '<2 candidates → original order');
    // candidates whose chunks have no vectors in the bin → fewer than 2 scorable → original order
    const noVecs = [{ chunk: { id: 'z1', content_hash: 'none1' }, score: 1 }, { chunk: { id: 'z2', content_hash: 'none2' }, score: 1 }];
    assert.deepEqual(rerankLateInteraction(noVecs, { qVecs: Q, binPath: bin }).map(r => r.chunk.id),
        ['z1', 'z2'], 'no doc vectors → original order (no-op)');
    fs.rmSync(bin, { force: true });
});

test('colbert (B4): no-signal (dim mismatch / all-equal MaxSim) preserves original order, never id-scrambles', () => {
    const bin = fixtureBin();
    // A 4-dim query against 3-dim doc vectors → cosine length-guard returns 0 for every pair → every
    // candidate gets an identical MaxSim of 0. The fix must keep the ORIGINAL order, not re-sort to id.
    const wrongDim = [v(1, 0, 0, 0), v(0, 1, 0, 0)];
    const out = rerankLateInteraction(RESULTS(), { qVecs: wrongDim, binPath: bin, topM: 12 });
    fs.rmSync(bin, { force: true });
    assert.deepEqual(out.map(r => r.chunk.id), ['c1', 'c2', 'c3'],
        'undifferentiated/zero MaxSim → original order (no corruption)');
});

test('colbert (B4): rerankLateInteraction preserves the tail beyond topM', () => {
    const bin = fixtureBin();
    const tail = { chunk: { id: 'c9', content_hash: 'ha' }, score: 0.05 };
    const out = rerankLateInteraction([...RESULTS(), tail], { qVecs: Q, binPath: bin, topM: 3 });
    fs.rmSync(bin, { force: true });
    assert.equal(out.length, 4);
    assert.equal(out[3].chunk.id, 'c9', 'the beyond-topM tail is preserved in place');
});

// ── encodeMultiVector (fake embedder — no model) ───────────────────────────────────────────────
test('colbert (B4): encodeMultiVector emits the holistic query vector + content sub-units', async () => {
    const calls = [];
    const fakeEmbedder = { embedDocuments: async (texts) => { calls.push(texts); return texts.map((_, i) => v(i, i + 1)); } };
    const vecs = await encodeMultiVector(fakeEmbedder, 'how does the parser tokenize input');
    assert.ok(vecs.length >= 2, 'multiple vectors produced');
    assert.equal(calls[0][0], 'how does the parser tokenize input', 'the whole query leads');
    assert.ok(calls[0].includes('parser') && calls[0].includes('tokenize'), 'content words become sub-units');
    assert.ok(!calls[0].includes('the') && !calls[0].includes('how'), 'stopwords are dropped');
    // no embedder / failure → [] (best-effort)
    assert.deepEqual(await encodeMultiVector(null, 'x'), []);
    assert.deepEqual(await encodeMultiVector({ embedDocuments: async () => { throw new Error('boom'); } }, 'x y z'), []);
});
