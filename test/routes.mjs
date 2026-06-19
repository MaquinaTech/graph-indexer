#!/usr/bin/env node
/**
 * test/routes.mjs
 *
 * End-to-end coverage for HTTP route detection (find_routes):
 *   1. Index a tiny synthetic Express fixture inline (no disk fixture, no Ollama)
 *      and resolve routes → handler chunks through both storage backends.
 *   2. Exercise the exported `findRoutes(db, …)` MCP helper (the tool's core).
 *   3. Prove the in-memory engine and SqliteGraphStore return byte-identical
 *      route records (the dual-backend parity contract).
 *   4. Smoke-test the registered `find_routes` MCP tool over a mock server.
 *
 * The SQLite half SKIPS gracefully when node:sqlite is unavailable (Node < 22.5),
 * mirroring test/sqlite.mjs — so this still passes on the CI Node matrix.
 *
 *   node test/routes.mjs        (exit 0 = pass, 1 = failure)
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractSemanticChunks } from '../parse/extractor.mjs';
import { getParserForFile } from '../parse/languages.mjs';
import { extractRoutes } from '../parse/routes.mjs';
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { findRoutes } from '../mcp/topology.mjs';
import { registerTools } from '../mcp/tools.mjs';

let passed = 0, failed = 0;
const tmpFiles = [];
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log('\nHTTP ROUTE TESTS\n');

// ── Synthetic Express fixture: 3 GET routes under /api, named multi-line
//    handlers (≥3 lines so each becomes its own searchable chunk). ─────────────
const SRC = [
    'function listUsers(req, res) {',
    '  const users = db.all();',
    '  res.json(users);',
    '}',
    'function getUser(req, res) {',
    '  const u = db.find(req.params.id);',
    '  res.json(u);',
    '}',
    'function getHealth(req, res) {',
    '  const s = check();',
    '  res.json({ ok: s });',
    '}',
    "router.get('/api/users', listUsers);",
    "router.get('/api/users/:id', getUser);",
    "router.get('/api/health', getHealth);",
].join('\n');

const jsParser = getParserForFile('.js');
if (!jsParser) {
    console.log('  ⊘ tree-sitter-javascript not built — route tests skipped');
    console.log(`\n${'─'.repeat(56)}\n  passed=${passed}  failed=${failed}  (skipped)\n`);
    process.exit(0);
}

const tree = jsParser.parse(SRC);
const CHUNKS = extractSemanticChunks(tree.rootNode, 'routes.js', SRC, '.js');
const ROUTES = extractRoutes(tree.rootNode, 'routes.js', CHUNKS, '.js');
const GRAPH = { dependencies: { 'routes.js': [] }, importedBy: {}, routes: ROUTES };
const idOf = (name) => CHUNKS.find(c => c.name === name)?.id;

// In-memory backend: persist {chunks, graph} as the indexer would, then load.
function loadMemory() {
    const p = path.join(os.tmpdir(), `gi-routes-${process.pid}-${passed}-${failed}.json`);
    tmpFiles.push(p, `${p.replace(/\.json$/, '')}.embeddings.bin`);
    fs.writeFileSync(p, JSON.stringify({ chunks: CHUNKS, graph: GRAPH }));
    const mem = new MemoryGraphIndex(p);
    mem.load();
    return mem;
}

test('extractRoutes produced 3 routes + 3 handler chunks from the fixture', () => {
    assert.equal(ROUTES.length, 3, `routes → ${JSON.stringify(ROUTES.map(r => r.method + ' ' + r.path))}`);
    for (const name of ['listUsers', 'getUser', 'getHealth']) {
        assert.ok(idOf(name), `handler chunk ${name} missing`);
    }
    // Each route resolved its handler_chunk_id at index time.
    for (const r of ROUTES) assert.ok(r.handler_chunk_id, `route ${r.path} did not resolve a handler chunk`);
});

test("find_routes('GET', '/api') returns the correct handler chunks (in-memory)", () => {
    const mem = loadMemory();
    const rows = findRoutes(mem, { method: 'GET', path: '/api' });
    assert.equal(rows.length, 3, `expected 3, got ${rows.length}`);
    const byPath = Object.fromEntries(rows.map(r => [r.path, r]));
    assert.equal(byPath['/api/users'].handler_name, 'listUsers');
    assert.equal(byPath['/api/users'].id, idOf('listUsers'), 'inlined handler chunk id');
    assert.equal(byPath['/api/users'].node_type, 'function_declaration');
    assert.equal(byPath['/api/users/:id'].handler_name, 'getUser');
    assert.equal(byPath['/api/health'].handler_name, 'getHealth');
    mem.close?.();
});

test('find_routes() with no filter returns all 3 routes (in-memory)', () => {
    const mem = loadMemory();
    assert.equal(findRoutes(mem, {}).length, 3);
    // method filter is case-insensitive; a non-matching method yields none.
    assert.equal(findRoutes(mem, { method: 'get' }).length, 3);
    assert.equal(findRoutes(mem, { method: 'POST' }).length, 0);
    // pattern hint (contains ':') → contains-match.
    assert.equal(findRoutes(mem, { path: ':id' }).length, 1);
    mem.close?.();
});

test('graph.routes defaults to [] for an index built without the feature', () => {
    const p = path.join(os.tmpdir(), `gi-routes-legacy-${process.pid}.json`);
    tmpFiles.push(p, `${p.replace(/\.json$/, '')}.embeddings.bin`);
    fs.writeFileSync(p, JSON.stringify({ chunks: CHUNKS, graph: { dependencies: {}, importedBy: {} } }));
    const mem = new MemoryGraphIndex(p);
    mem.load();
    assert.deepEqual(findRoutes(mem, {}), []);
    mem.close?.();
});

await (async () => {
    // ── SQLite parity (skips on Node < 22.5) ───────────────────────────────────
    let SqliteGraphStore;
    try { ({ SqliteGraphStore } = await import('../engine/sqlite.mjs')); }
    catch { console.log('  ⊘ node:sqlite unavailable — parity test skipped'); return; }

    let sq;
    try {
        const dbPath = path.join(os.tmpdir(), `gi-routes-${process.pid}.db`);
        tmpFiles.push(dbPath, `${dbPath}.embeddings.bin`, `${dbPath}-wal`, `${dbPath}-shm`);
        new SqliteGraphStore(dbPath).buildFrom({ chunks: CHUNKS, graph: GRAPH, embeddingCache: {} });
        sq = new SqliteGraphStore(dbPath);
        sq.load();
    } catch (err) {
        console.log(`  ⊘ SQLite backend unavailable — parity test skipped (${err.message})`);
        return;
    }

    test('memory ↔ sqlite: byte-identical find_routes records', () => {
        const mem = loadMemory();
        for (const filt of [{ method: 'GET', path: '/api' }, {}, { method: 'GET' }, { path: ':id' }, { path: '/api/health' }]) {
            assert.deepEqual(findRoutes(sq, filt), findRoutes(mem, filt),
                `route parity mismatch for ${JSON.stringify(filt)}`);
        }
        mem.close?.();
    });

    test('sqlite backend resolves handler chunks (round-trip)', () => {
        const rows = findRoutes(sq, { method: 'GET', path: '/api' });
        assert.equal(rows.length, 3);
        assert.equal(rows.find(r => r.path === '/api/users').id, idOf('listUsers'));
    });
    sq.close?.();
})();

// ── Registered MCP tool smoke test (mock server captures the handler) ──────────
await (async () => {
    const mem = loadMemory();
    const tools = new Map();
    const mockServer = { tool: (name, _desc, _schema, handler) => tools.set(name, handler) };
    registerTools(mockServer, mem, {
        projectRoot: process.cwd(), artifactPath: mem.indexPath, pidFile: null,
        embeddingsEnabled: false, embedder: null, rerank: false, hyde: false,
    });

    test("the 'find_routes' MCP tool is registered and returns structured routes", async () => {
        assert.ok(tools.has('find_routes'), 'find_routes tool not registered');
        const res = await tools.get('find_routes')({ method: 'GET', path: '/api', response_format: 'json' });
        assert.ok(!res.isError, `tool errored: ${JSON.stringify(res)}`);
        assert.equal(res.structuredContent.route_count, 3);
        assert.ok(res.structuredContent.routes.every(r => r.method === 'GET'));
        assert.ok(res.structuredContent.routes.some(r => r.handler_name === 'listUsers' && r.id));
    });

    test("the 'find_routes' MCP tool renders markdown", async () => {
        const res = await tools.get('find_routes')({ response_format: 'markdown' });
        const text = res.content.map(c => c.text).join('\n');
        assert.match(text, /HTTP routes — 3 total/);
        assert.match(text, /\*\*GET\*\* `\/api\/users`/);
    });
    mem.close?.();
})();

// ── cleanup ────────────────────────────────────────────────────────────────────
for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* none */ } }

console.log(`\n${'─'.repeat(56)}`);
console.log(`  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.log('\n✗ route tests FAILED\n'); process.exit(1); }
console.log('\n✓ route tests passed\n');
