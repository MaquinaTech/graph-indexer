/**
 * @file test/json-output.mjs
 * @description Tests the structured (JSON) output mode (#4). Every query/read tool
 *              accepts `response_format: 'json'` and returns typed fields both as a
 *              JSON text block (universally readable) and as MCP `structuredContent`
 *              (typed, no prose-parsing) — while markdown stays the default so the
 *              token-efficient agent view is unchanged.
 *
 *              Drives the real registerTools surface against an in-memory index via
 *              a fake McpServer that captures the handlers. No Ollama, no network.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { extractSemanticChunks } from '../parse/extractor.mjs';
import { getParserForFile } from '../parse/languages.mjs';
import { registerTools } from '../mcp/tools.mjs';

const FILES = {
    'math.ts': `
export function add(a, b) {
  const sum = a + b;
  return sum;
}
export function median(values) {
  const sorted = values.slice().sort();
  return sorted[Math.floor(sorted.length / 2)];
}
`,
    'stats.ts': `
import { add } from './math';
export function mean(values) {
  let total = 0;
  for (const v of values) total = add(total, v);
  return total / values.length;
}
`,
};
const IMPORTS = { 'stats.ts': ['math.ts'] };

function buildIndex() {
    const parser = getParserForFile('.ts');
    if (!parser) return null;
    const idx = new MemoryGraphIndex(path.join(os.tmpdir(), `json-${process.pid}.json`), { cacheEmbeddings: false });
    for (const [file, src] of Object.entries(FILES)) {
        const tree = parser.parse((offset) => (offset < src.length ? src.slice(offset, offset + 4096) : null));
        const chunks = extractSemanticChunks(tree.rootNode, file, src, '.ts');
        idx.applyFileUpdate(file, { chunks, imports: IMPORTS[file] || [] });
        if (idx._saveTimer) { clearTimeout(idx._saveTimer); idx._saveTimer = null; }
    }
    return idx;
}

function captureTools(db) {
    const handlers = new Map();
    const fakeServer = { tool: (name, _desc, _shape, handler) => handlers.set(name, handler) };
    registerTools(fakeServer, db, {
        projectRoot: os.tmpdir(), artifactPath: '/nonexistent', pidFile: null,
        embeddingsEnabled: false, embedder: null,
    });
    return handlers;
}

/** Every json result carries structuredContent AND a matching JSON text block. */
function structured(res) {
    assert.ok(res.structuredContent, 'structuredContent present');
    assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent, 'text block mirrors structuredContent');
    return res.structuredContent;
}

test('search_code json mode returns typed, scored results with topology + body', async () => {
    const idx = buildIndex();
    if (!idx) { console.log('  ⚠️  tree-sitter-typescript not installed — skipping'); return; }
    const tools = captureTools(idx);

    const res = await tools.get('search_code')({
        query: 'add two numbers sum', top_k: 5, min_score: 0, detail: 'smart',
        include_topology: true, response_format: 'json',
    });
    const sc = structured(res);
    assert.equal(typeof sc.query, 'string');
    assert.ok(Array.isArray(sc.results) && sc.results.length > 0, 'has results');
    const r = sc.results[0];
    for (const f of ['rank', 'score', 'id', 'name', 'node_type', 'file_path', 'start_line', 'end_line']) {
        assert.ok(f in r, `result has field ${f}`);
    }
    assert.equal(typeof r.score, 'number', 'score is numeric, not a formatted string');
    assert.ok(r.topology && Array.isArray(r.topology.used_by), 'topology included');
    assert.ok('body' in r, 'smart detail includes a body');
});

test('search_code markdown stays the default (no response_format)', async () => {
    const idx = buildIndex();
    if (!idx) return;
    const tools = captureTools(idx);
    const res = await tools.get('search_code')({
        query: 'add two numbers', top_k: 3, min_score: 0, detail: 'signatures', include_topology: true,
    });
    assert.equal(res.structuredContent, undefined, 'no structuredContent in markdown mode');
    assert.match(res.content[0].text, /QUERY:/, 'renders the markdown header');
});

test('resolve_symbol json mode lists typed definitions', async () => {
    const idx = buildIndex();
    if (!idx) return;
    const tools = captureTools(idx);
    const sc = structured(await tools.get('resolve_symbol')({ symbol: 'median', response_format: 'json' }));
    assert.equal(sc.symbol, 'median');
    assert.equal(sc.count, 1);
    assert.equal(sc.definitions[0].name, 'median');
    assert.ok(sc.definitions[0].signature.includes('median'), 'signature carried');
    assert.ok(sc.definitions[0].topology, 'topology carried');
});

test('get_chunk json mode returns the body and typed fields', async () => {
    const idx = buildIndex();
    if (!idx) return;
    const tools = captureTools(idx);
    const id = idx.resolveSymbol('mean')[0].id;
    const sc = structured(await tools.get('get_chunk')({ chunk_id: id, view: 'full', response_format: 'json' }));
    assert.equal(sc.id, id);
    assert.equal(sc.name, 'mean');
    assert.ok(sc.code.includes('total'), 'full code body returned');
    assert.ok(Array.isArray(sc.calls) && sc.calls.includes('add'), 'outgoing calls listed');
    assert.deepEqual(sc.topology.dependencies, ['math.ts'], 'file dependencies in topology');
});

test('get_call_graph json mode splits high-confidence from name-only', async () => {
    const idx = buildIndex();
    if (!idx) return;
    const tools = captureTools(idx);
    const sc = structured(await tools.get('get_call_graph')({ target_function: 'add', response_format: 'json' }));
    assert.equal(sc.target_function, 'add');
    assert.equal(sc.ambiguous, false, 'add is unique');
    assert.deepEqual(sc.high_confidence.map(c => c.name), ['mean'], 'mean is the high-confidence caller');
    assert.equal(sc.high_confidence[0].confidence, 'high');
    assert.equal(sc.name_only.length, 0);
});

test('get_repo_map json mode returns files with typed symbols', async () => {
    const idx = buildIndex();
    if (!idx) return;
    const tools = captureTools(idx);
    const sc = structured(await tools.get('get_repo_map')({ max_files: 80, sort_by: 'path', response_format: 'json' }));
    assert.equal(sc.total_files, 2);
    const files = sc.files.map(f => f.file_path).sort();
    assert.deepEqual(files, ['math.ts', 'stats.ts']);
    const math = sc.files.find(f => f.file_path === 'math.ts');
    assert.ok(math.symbols.some(s => s.name === 'add'), 'math.ts lists add');
});

test('list_index_stats json mode reports typed health fields', async () => {
    const idx = buildIndex();
    if (!idx) return;
    const tools = captureTools(idx);
    const sc = structured(await tools.get('list_index_stats')({ response_format: 'json' }));
    assert.equal(sc.backend, 'memory');
    assert.equal(typeof sc.chunks, 'number');
    assert.equal(sc.embeddings_enabled, false);
    assert.equal(sc.search_mode, 'lexical-only');
    assert.ok('ext_counts' in sc, 'extension breakdown included');
});
