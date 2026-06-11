#!/usr/bin/env node
/**
 * test/enrichment.mjs
 *
 * Validates the LLM enrichment pipeline with a deterministic (injected) generator
 * — no live model required.
 *
 * The headline test proves the concept-tag approach works: a chunk whose code and
 * name share NO lexical tokens with a conceptual query is NOT retrievable beforehand,
 * but becomes the rank-1 result after enrichment attaches high-IDF domain keywords
 * via chunk.hyde = concepts.join(' '). This is the exact scenario standard
 * embeddings/BM25 fail, and where questions-based HyDE produced stopword noise.
 *
 *   node test/enrichment.mjs
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemoryGraphIndex } from '../core-engine.mjs';
import { buildEmbeddingPayload } from '../parser-utils.mjs';
import {
    parseEnrichResponse, selectCoreChunks, enrichCoreChunks,
    loadEnrichmentCache, saveEnrichmentCache, attachEnrichment,
} from '../enrichment.mjs';

let passed = 0, failed = 0;
const tmp = [];
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

function loadFromChunks(chunks, graph) {
    const p = path.join(os.tmpdir(), `gi-enrich-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    tmp.push(p, p.replace(/\.json$/, '.embeddings.bin'));
    fs.writeFileSync(p, JSON.stringify({ chunks, graph }));
    const db = new MemoryGraphIndex(p);
    db.load();
    return db;
}

const chunk = (o) => ({
    docstring: '', calls: [], params: [], return_type: '', class_context: '',
    type_refs: [], decorators: [], extends: [], start_line: 1, end_line: 10, ...o,
});

// The conceptual query shares NO tokens with the target's code or name.
const QUERY = 'process incoming payment webhook from stripe and update subscription billing status';

// Target: lexically disjoint from the query (path 'src/svc/core_handler.ts' too).
const target = chunk({
    id: 't1', file_path: 'src/svc/core_handler.ts', node_type: 'function_declaration',
    name: 'chargeCustomer', content_hash: 't1',
    code_snippet: 'function chargeCustomer(evt, store){ const id = evt.data.id; const amt = evt.data.total; return store.persist(id, amt); }',
    calls: ['persist'],
});
// Distractor that DOES share the generic token "update" with the query.
const distractor = chunk({
    id: 'd1', file_path: 'src/db.ts', node_type: 'function_declaration',
    name: 'updateRecord', content_hash: 'd1',
    code_snippet: 'function updateRecord(table, row){ return table.update(row); }',
    calls: ['update'],
});
const GRAPH = { dependencies: { 'src/svc/core_handler.ts': [], 'src/db.ts': [] }, importedBy: {} };

// SUMMARY + TAGS format: small model produces declarative summary + domain keywords.
const ENRICH_RESPONSE =
    'SUMMARY: processes incoming Stripe payment webhooks and updates subscription billing status\n'
    + 'TAGS: payment, webhook, stripe, subscription, billing, payment gateway';

console.log('\nLLM ENRICHMENT TESTS\n');

await test('parseEnrichResponse extracts summary and concept tags', () => {
    const r = parseEnrichResponse(ENRICH_RESPONSE);
    assert.ok(r, 'parse returned null');
    assert.match(r.summary, /Stripe payment webhooks/);
    assert.ok(Array.isArray(r.concepts), 'concepts should be an array');
    assert.ok(r.concepts.includes('webhook'), 'expected "webhook" in concepts');
    assert.ok(r.concepts.includes('subscription'), 'expected "subscription" in concepts');
    // hyde = concepts joined for BM25 (no stopword noise from question sentences)
    assert.match(r.hyde, /payment/);
    assert.match(r.hyde, /stripe/);
    assert.ok(!/how|what|does|this/.test(r.hyde), 'hyde should contain no question stopwords');
});

await test('parseEnrichResponse falls back to summary keywords when TAGS line is absent', () => {
    const r = parseEnrichResponse('SUMMARY: JWT token validation middleware for bearer auth');
    assert.ok(r, 'parse returned null on summary-only input');
    assert.match(r.summary, /JWT/);
    assert.ok(r.concepts.length > 0, 'should extract fallback concepts from summary');
    assert.ok(r.concepts.some(c => c === 'jwt' || c === 'token' || c === 'validation'),
        `expected domain terms in concepts, got: ${r.concepts.join(', ')}`);
});

await test('selectCoreChunks picks chunks in the highest-PageRank files', () => {
    const chunks = [
        chunk({ id: 'a', file_path: 'src/core.ts', name: 'Core', node_type: 'class_declaration', content_hash: 'a' }),
        chunk({ id: 'b', file_path: 'src/leaf.ts', name: 'Leaf', node_type: 'function_declaration', content_hash: 'b' }),
    ];
    // core.ts is imported by two others → most central.
    const graph = { dependencies: { 'src/x.ts': ['src/core.ts'], 'src/y.ts': ['src/core.ts'], 'src/core.ts': [], 'src/leaf.ts': [] }, importedBy: {} };
    const core = selectCoreChunks(chunks, graph, { coreRatio: 0.25, maxChunks: 50 });
    assert.ok(core.some(c => c.id === 'a'), 'central chunk not selected');
});

await test('enrichCoreChunks attaches summary, concepts, and hyde via an injected generator', async () => {
    const chunks = [chunk({ id: 'a', file_path: 'src/core.ts', name: 'Core', node_type: 'class_declaration', content_hash: 'a' })];
    const graph = { dependencies: { 'src/x.ts': ['src/core.ts'], 'src/core.ts': [] }, importedBy: {} };
    const config = { ollamaHost: 'http://unused', enrichment: { model: 'fake', coreRatio: 1, maxChunks: 10 } };
    const res = await enrichCoreChunks(chunks, graph, config, { generate: async () => ENRICH_RESPONSE });
    assert.equal(res.enriched, 1);
    assert.ok(Array.isArray(chunks[0].concepts), 'concepts should be an array');
    assert.ok(chunks[0].concepts.includes('stripe') || chunks[0].concepts.includes('webhook'),
        `expected stripe/webhook in concepts, got: ${chunks[0].concepts?.join(', ')}`);
    assert.match(chunks[0].summary, /Stripe payment webhooks/);
    assert.match(chunks[0].hyde, /subscription billing/);
});

await test('buildEmbeddingPayload leads with summary, not with questions', () => {
    const withSummary = buildEmbeddingPayload({ ...target, summary: 'processes Stripe payment webhooks and updates billing' }, []);
    // Summary must be the very first field — anchors the vector toward query vocabulary.
    assert.ok(withSummary.startsWith('processes Stripe payment webhooks'),
        `expected summary to lead the payload, got: ${withSummary.slice(0, 80)}`);
    // Hyde/questions must NOT appear in the vector payload (they go to BM25 only).
    assert.ok(!/Answers Questions/.test(withSummary), 'Answers Questions must not appear in vector payload');
    // Without a summary, first field falls through to File Location.
    const noSummary = buildEmbeddingPayload(target, []);
    assert.ok(noSummary.startsWith('File Location:'),
        `expected File Location to lead when no summary, got: ${noSummary.slice(0, 60)}`);
});

await test('concept-tag enrichment makes a lexically-disjoint chunk rank-1 (BM25 flip)', () => {
    // Before enrichment: target shares no tokens with the query; distractor matches
    // the generic word "update" → target is NOT rank-1.
    const before = loadFromChunks([{ ...target }, { ...distractor }], GRAPH);
    const r1 = before.searchHybrid(QUERY, null, 5);
    assert.notEqual(r1[0]?.chunk?.id, 't1', `target should not be rank-1 before enrichment (got ${r1[0]?.chunk?.id})`);

    // After enrichment: concept tags (payment/webhook/stripe/subscription/billing)
    // join the target's BM25 lexical document as high-IDF domain terms, lifting it
    // to rank-1. Unlike questions-based HyDE, no stopword noise is introduced.
    const parsed = parseEnrichResponse(ENRICH_RESPONSE);
    const enrichedTarget = { ...target, hyde: parsed.hyde, concepts: parsed.concepts, summary: parsed.summary };
    const after = loadFromChunks([enrichedTarget, { ...distractor }], GRAPH);
    const r2 = after.searchHybrid(QUERY, null, 5);
    assert.equal(r2[0]?.chunk?.id, 't1', `target should be rank-1 after enrichment (got ${r2[0]?.chunk?.id})`);
});

// ─── Persistent enrichment cache ────────────────────────────────────────────────

await test('enrichment cache round-trips and re-attaches without an LLM call', () => {
    const cachePath = path.join(os.tmpdir(), `gi-ecache-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    tmp.push(cachePath);
    const cache = new Map([['hashA', { summary: 'parses webhooks', concepts: ['stripe', 'webhook'], model: 'fake' }]]);
    saveEnrichmentCache(cachePath, cache);
    const loaded = loadEnrichmentCache(cachePath);
    assert.equal(loaded.get('hashA').summary, 'parses webhooks');

    const c = { content_hash: 'hashA' };
    assert.ok(attachEnrichment(c, loaded.get('hashA')));
    assert.equal(c.summary, 'parses webhooks');
    assert.equal(c.hyde, 'stripe webhook');
});

await test('enrichCoreChunks serves a second run entirely from cache (0 new LLM calls)', async () => {
    const cachePath = path.join(os.tmpdir(), `gi-ecache2-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    tmp.push(cachePath);
    const mkChunks = () => [chunk({
        id: 'p1', file_path: 'src/core.ts', name: 'processPayment',
        node_type: 'function_declaration', content_hash: 'hP',
    })];
    const graph = { dependencies: { 'src/x.ts': ['src/core.ts'], 'src/core.ts': [] }, importedBy: {} };
    const config = {
        ollamaHost: 'http://unused', enrichmentCachePath: cachePath,
        enrichment: { model: 'fake', coreRatio: 1, maxChunks: 10, concurrency: 2 },
    };
    let llmCalls = 0;
    const generate = async () => { llmCalls++; return 'SUMMARY: charges a card\nTAGS: payment, billing'; };

    const first = await enrichCoreChunks(mkChunks(), graph, config, { generate });
    assert.equal(first.enriched, 1);
    assert.equal(llmCalls, 1);

    const chunks2 = mkChunks();
    const second = await enrichCoreChunks(chunks2, graph, config, { generate });
    assert.equal(second.cached, 1, 'second run should hit the cache');
    assert.equal(llmCalls, 1, 'no further LLM calls expected');
    assert.equal(chunks2[0].summary, 'charges a card');
    assert.deepEqual(chunks2[0].concepts, ['payment', 'billing']);
});

for (const f of tmp) { try { fs.unlinkSync(f); } catch { } }
console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
