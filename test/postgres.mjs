#!/usr/bin/env node
/**
 * test/postgres.mjs
 *
 * PostgresGraphStore tests. The store's SQL surface is exercised against an
 * in-process fake pool (no server needed), covering:
 *   - buildFrom → load round-trip (chunks, graph, vectors, meta)
 *   - EXACT ranking parity with MemoryGraphIndex (same dataset, same queries)
 *   - applyFileUpdate / removeFile incremental writes + reload visibility
 *
 * When a real PostgreSQL is reachable (GRAPH_INDEXER_PG_TEST_URL set and the
 * `pg` package installed), the round-trip additionally runs against it in a
 * throwaway schema.
 *
 *   node test/postgres.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryGraphIndex, writeEmbeddingBinary } from '../core-engine.mjs';
import { PostgresGraphStore, vectorToBytes, bytesToVector } from '../postgres-store.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ✗ ${name}\n      ${err.stack?.split('\n').slice(0, 3).join('\n      ')}`);
    }
}

// ─── Fake pg pool ─────────────────────────────────────────────────────────────
// Implements exactly the SQL surface postgres-store.mjs uses, backed by Maps.
// Statements are matched by table + verb; anything unexpected throws so the
// store cannot silently drift away from what the fake covers.

function createFakePool() {
    const t = { chunks: new Map(), vectors: new Map(), deps: [], meta: new Map() };
    const tableOf = (sql) => /"(chunks|vectors|deps|meta)"/.exec(sql)?.[1];

    async function query(sql, params = []) {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (/^(BEGIN|COMMIT|ROLLBACK|NOTIFY|LISTEN|CREATE)/i.test(s)) return { rows: [] };

        if (/^SELECT key, value FROM/.test(s)) {
            return { rows: Array.from(t.meta, ([key, value]) => ({ key, value })) };
        }
        if (/^SELECT file, dep FROM/.test(s)) {
            return { rows: t.deps.map(([file, dep]) => ({ file, dep })) };
        }
        if (/^SELECT key, dim, data FROM/.test(s)) {
            return { rows: Array.from(t.vectors.values()) };
        }
        if (/^SELECT data FROM .* ORDER BY id$/.test(s)) {
            return {
                rows: Array.from(t.chunks.values())
                    .sort((a, b) => (a.id < b.id ? -1 : 1))
                    .map(r => ({ data: r.data })),
            };
        }
        if (/^DELETE FROM/.test(s)) {
            const table = tableOf(s);
            if (/WHERE file_path = \$1/.test(s)) {
                for (const [id, r] of t.chunks) if (r.file_path === params[0]) t.chunks.delete(id);
            } else if (/WHERE file = \$1/.test(s)) {
                t.deps = t.deps.filter(([file]) => file !== params[0]);
            } else if (table === 'deps') {
                t.deps = [];
            } else {
                t[table].clear();
            }
            return { rows: [] };
        }
        if (/^INSERT INTO/.test(s)) {
            const table = tableOf(s);
            if (table === 'chunks') {
                for (let i = 0; i < params.length; i += 3) {
                    t.chunks.set(params[i], { id: params[i], file_path: params[i + 1], data: JSON.parse(params[i + 2]) });
                }
            } else if (table === 'vectors') {
                for (let i = 0; i < params.length; i += 3) {
                    t.vectors.set(params[i], { key: params[i], dim: params[i + 1], data: params[i + 2] });
                }
            } else if (table === 'deps') {
                for (let i = 0; i < params.length; i += 2) t.deps.push([params[i], params[i + 1]]);
            } else if (table === 'meta') {
                if (/VALUES \('built_at', \$1\)/.test(s)) t.meta.set('built_at', params[0]);
                else t.meta.set(params[0], params[1]);
            }
            return { rows: [] };
        }
        throw new Error(`fake pool: unhandled SQL — ${s}`);
    }

    return {
        query,
        connect: async () => ({ query, release() {} }),
        end: async () => {},
        _tables: t,
    };
}

// ─── Dataset ──────────────────────────────────────────────────────────────────

function vec(...vals) { return new Float32Array(vals); }

const CHUNKS = [
    {
        id: 'c1', file_path: 'src/auth/token.ts', node_type: 'function_declaration', name: 'validateToken',
        docstring: 'Validates a JWT token and refreshes expired sessions.',
        code_snippet: 'function validateToken(token) { return jwt.verify(token); }',
        content_hash: 'h1', start_line: 1, end_line: 12, calls: ['verify'], params: ['token'],
        return_type: 'boolean', class_context: '', type_refs: ['Token'], decorators: [], extends: [],
    },
    {
        id: 'c2', file_path: 'src/auth/session.ts', node_type: 'class_declaration', name: 'SessionStore',
        docstring: 'Persists user sessions.',
        code_snippet: 'class SessionStore { save(session) { this.db.put(session); } }',
        content_hash: 'h2', start_line: 1, end_line: 20, calls: ['put'], params: [],
        return_type: '', class_context: '', type_refs: ['Session'], decorators: [], extends: [],
    },
    {
        id: 'c3', file_path: 'src/http/router.ts', node_type: 'function_declaration', name: 'dispatchRequest',
        docstring: 'Routes an incoming HTTP request to its handler.',
        code_snippet: 'function dispatchRequest(req) { return routes.match(req.path)(req); }',
        content_hash: 'h3', start_line: 1, end_line: 15, calls: ['match', 'validateToken'], params: ['req'],
        return_type: 'Response', class_context: '', type_refs: ['Request'], decorators: [], extends: [],
    },
    {
        id: 'c4', file_path: 'test/token.test.ts', node_type: 'function_declaration', name: 'testValidateToken',
        docstring: '', code_snippet: 'it("validates", () => expect(validateToken(t)).toBe(true));',
        content_hash: 'h4', start_line: 1, end_line: 8, calls: ['validateToken'], params: [],
        return_type: '', class_context: '', type_refs: [], decorators: [], extends: [],
    },
];

const GRAPH = {
    dependencies: {
        'src/auth/token.ts': [],
        'src/auth/session.ts': ['src/auth/token.ts'],
        'src/http/router.ts': ['src/auth/token.ts'],
        'test/token.test.ts': ['src/auth/token.ts'],
    },
};

const EMBEDDINGS = new Map([
    ['h1', vec(0.9, 0.1, 0.05)],
    ['h2', vec(0.2, 0.9, 0.1)],
    ['h3', vec(0.1, 0.2, 0.9)],
    ['h4', vec(0.8, 0.15, 0.1)],
]);

const QUERIES = [
    { text: 'validate JWT token authentication', vec: vec(0.85, 0.2, 0.1) },
    { text: 'dispatch incoming http request to handler', vec: vec(0.1, 0.25, 0.85) },
    { text: 'SessionStore', vec: null },
    { text: 'how does the app persist user sessions between requests', vec: vec(0.25, 0.85, 0.15) },
];

function loadMemoryReference() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-pg-ref-'));
    fs.writeFileSync(path.join(dir, 'code-index.json'), JSON.stringify({ chunks: CHUNKS, graph: GRAPH }));
    fs.writeFileSync(path.join(dir, 'code-index.embeddings.bin'), writeEmbeddingBinary(EMBEDDINGS));
    const db = new MemoryGraphIndex(path.join(dir, 'code-index.json'));
    db.load();
    return db;
}

// ─── Shared round-trip assertions (fake pool + optional real server) ──────────

async function roundTrip(store) {
    await store.buildFrom({
        chunks: CHUNKS, graph: GRAPH, embeddingCache: EMBEDDINGS,
        meta: { embed_provider: 'ollama', embed_model: 'nomic-embed-text' },
    });
    await store.load();

    assert.equal(store.backend, 'postgres');
    assert.equal(store.chunkCount(), 4);
    assert.equal(store.fileCount(), 4);
    assert.equal(store.vectorCount(), 4);
    assert.equal(store.getMeta('embed_provider'), 'ollama');
    assert.ok(Number(store.getMeta('built_at')) > 0);

    const chunk = store.getChunk('c1');
    assert.equal(chunk.name, 'validateToken');
    assert.deepEqual(chunk.calls, ['verify']);
    assert.equal(store.resolveSymbol('sessionstore')[0]?.id, 'c2');
    assert.equal(store.getChunksByFile('src/auth/token.ts')[0]?.id, 'c1');
    assert.deepEqual(store.getDependencies('src/http/router.ts'), ['src/auth/token.ts']);
    assert.deepEqual([...store.getImportedBy('src/auth/token.ts')].sort(), [
        'src/auth/session.ts', 'src/http/router.ts', 'test/token.test.ts',
    ]);
    assert.equal(store.findCallers('validateToken').length, 2);
    assert.deepEqual(Array.from(store.embeddingCache.get('h1')), Array.from(EMBEDDINGS.get('h1')));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\nPOSTGRES STORE TESTS (fake pool)\n');

await test('buildFrom → load round-trip preserves chunks, graph, vectors and meta', async () => {
    const store = new PostgresGraphStore({}, { poolFactory: async () => createFakePool() });
    await roundTrip(store);
});

await test('ranking parity: searchHybrid is identical to MemoryGraphIndex', async () => {
    const memory = loadMemoryReference();
    const store = new PostgresGraphStore({}, { poolFactory: async () => createFakePool() });
    await store.buildFrom({ chunks: CHUNKS, graph: GRAPH, embeddingCache: EMBEDDINGS });
    await store.load();

    for (const q of QUERIES) {
        const a = memory.searchHybrid(q.text, q.vec, 5);
        const b = store.searchHybrid(q.text, q.vec, 5);
        assert.deepEqual(
            b.map(r => r.chunk.id), a.map(r => r.chunk.id),
            `result ids diverged for "${q.text}"`
        );
        for (let i = 0; i < a.length; i++) {
            assert.equal(b[i].score, a[i].score, `score diverged at rank ${i + 1} for "${q.text}"`);
        }
    }
});

await test('applyFileUpdate commits incrementally and is visible after reload', async () => {
    const pool = createFakePool();
    const store = new PostgresGraphStore({}, { poolFactory: async () => pool });
    await store.buildFrom({ chunks: CHUNKS, graph: GRAPH, embeddingCache: EMBEDDINGS });
    await store.load();

    const updated = {
        ...CHUNKS[0],
        id: 'c1b', name: 'validateAccessToken', content_hash: 'h1b',
        code_snippet: 'function validateAccessToken(token) { return jwt.verify(token, key); }',
    };
    await store.applyFileUpdate('src/auth/token.ts', {
        chunks: [updated],
        imports: ['src/auth/session.ts'],
        embeddings: new Map([['h1b', vec(0.88, 0.12, 0.08)]]),
    });

    // In-RAM state updated synchronously…
    assert.equal(store.getChunk('c1'), null);
    assert.equal(store.resolveSymbol('validateAccessToken')[0]?.id, 'c1b');
    assert.deepEqual(store.getDependencies('src/auth/token.ts'), ['src/auth/session.ts']);

    // …and a second store over the same database sees the committed state.
    const reader = new PostgresGraphStore({}, { poolFactory: async () => pool });
    await reader.load();
    assert.equal(reader.getChunk('c1'), null);
    assert.equal(reader.getChunk('c1b')?.name, 'validateAccessToken');
    assert.equal(reader.vectorCount(), 4);
    assert.deepEqual(reader.getDependencies('src/auth/token.ts'), ['src/auth/session.ts']);

    // Searching for the new symbol works against the updated vector set.
    const hits = reader.searchHybrid('validateAccessToken', vec(0.88, 0.12, 0.08), 3);
    assert.equal(hits[0]?.chunk.id, 'c1b');
});

await test('removeFile deletes the chunks and the dependency-graph node', async () => {
    const pool = createFakePool();
    const store = new PostgresGraphStore({}, { poolFactory: async () => pool });
    await store.buildFrom({ chunks: CHUNKS, graph: GRAPH, embeddingCache: EMBEDDINGS });
    await store.load();

    await store.removeFile('test/token.test.ts');
    assert.equal(store.getChunk('c4'), null);
    assert.equal(store.getChunksByFile('test/token.test.ts').length, 0);
    assert.equal(store.graph.dependencies['test/token.test.ts'], undefined);

    const reader = new PostgresGraphStore({}, { poolFactory: async () => pool });
    await reader.load();
    assert.equal(reader.chunkCount(), 3);
    assert.equal(reader.graph.dependencies['test/token.test.ts'], undefined);
});

await test('vector byte codec round-trips float32 exactly', () => {
    const v = vec(0.1, -2.5, 3.75, 0);
    assert.deepEqual(Array.from(bytesToVector(vectorToBytes(v), 4)), Array.from(v));
});

await test('invalid schema names are rejected', () => {
    assert.throws(() => new PostgresGraphStore({ schema: 'bad"; DROP TABLE x;--' }));
});

// ─── Optional: real PostgreSQL round-trip ─────────────────────────────────────

const realUrl = process.env.GRAPH_INDEXER_PG_TEST_URL;
if (realUrl) {
    console.log('\nPOSTGRES STORE TESTS (live server)\n');
    await test('round-trip against a live PostgreSQL server', async () => {
        const schema = `gi_test_${process.pid}`;
        const store = new PostgresGraphStore({ url: realUrl, schema });
        try {
            await roundTrip(store);
        } finally {
            try { await store._pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch { /* best effort */ }
            await store.close();
        }
    });
} else {
    console.log('\n  (live-server tests skipped — set GRAPH_INDEXER_PG_TEST_URL to enable)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
