#!/usr/bin/env node
/**
 * test/sqlite.mjs
 *
 * Validates the disk-backed SqliteGraphStore:
 *   1. Round-trips a synthetic index (build → reopen → query every contract method).
 *   2. Proves rank consistency with the in-memory engine: building a SQLite store
 *      from a real fixture's chunks must return the SAME rank-1 and the same
 *      top-5 set as MemoryGraphIndex for representative queries.
 *
 *   node test/sqlite.mjs
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemoryGraphIndex } from '../core-engine.mjs';
import { SqliteGraphStore } from '../sqlite-store.mjs';
import { FIXTURES_DIR } from './setup.mjs';

let passed = 0, failed = 0;
const tmpFiles = [];

function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

function tmpDbPath() {
    const p = path.join(os.tmpdir(), `gi-sqlite-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    tmpFiles.push(p, `${p}.embeddings.bin`, `${p}-wal`, `${p}-shm`);
    return p;
}

function buildAndReopen(chunks, graph, embeddingCache) {
    const dbPath = tmpDbPath();
    new SqliteGraphStore(dbPath).buildFrom({ chunks, graph, embeddingCache });
    const store = new SqliteGraphStore(dbPath);
    store.load();
    return store;
}

console.log('\nSQLITE STORE TESTS\n');

// ─── 1. Synthetic round-trip ────────────────────────────────────────────────────
test('SqliteGraphStore round-trips chunks, symbols, callers and topology', () => {
    const chunks = [
        {
            id: 'c1', file_path: 'src/auth.ts', node_type: 'function_declaration',
            name: 'validateToken', docstring: 'check jwt token validity',
            code_snippet: 'function validateToken(t){ return verify(t); }', content_hash: 'h1',
            start_line: 1, end_line: 3, calls: ['verify'], params: ['t'],
            return_type: 'boolean', class_context: '', type_refs: ['Token'], decorators: [], extends: [],
        },
        {
            id: 'c2', file_path: 'src/auth.ts', node_type: 'function_declaration',
            name: 'verify', docstring: '', code_snippet: 'function verify(t){ return true; }',
            content_hash: 'h2', start_line: 5, end_line: 7, calls: [], params: ['t'],
            return_type: 'boolean', class_context: '', type_refs: [], decorators: [], extends: [],
        },
        {
            id: 'c3', file_path: 'src/user.ts', node_type: 'class_declaration',
            name: 'UserService', docstring: 'manages users',
            code_snippet: 'class UserService { login(){ return validateToken(x); } }', content_hash: 'h3',
            start_line: 1, end_line: 10, calls: ['validateToken'], params: [],
            return_type: '', class_context: '', type_refs: ['User'], decorators: ['Injectable'], extends: ['Base'],
        },
    ];
    const graph = { dependencies: { 'src/user.ts': ['src/auth.ts'], 'src/auth.ts': [] }, importedBy: {} };
    const db = buildAndReopen(chunks, graph);

    assert.equal(db.getChunk('c1').name, 'validateToken');
    assert.equal(db.getChunk('c3').decorators[0], 'Injectable');
    assert.equal(db.getChunk('c3').extends[0], 'Base');           // extends_ column round-trips
    assert.equal(db.getChunksByFile('src/auth.ts').length, 2);
    assert.equal(db.resolveSymbol('VALIDATETOKEN')[0]?.id, 'c1'); // case-insensitive
    assert.deepEqual(db.findCallers('verify').map(c => c.id), ['c1']);
    assert.deepEqual(db.findCallers('validateToken').map(c => c.id), ['c3']);
    assert.equal([...db.iterateChunks()].length, 3);
    assert.equal(db.chunkCount(), 3);
    assert.equal(db.fileCount(), 2);
    assert.equal(db.symbolCount(), 3);
    assert.deepEqual(db.getDependencies('src/user.ts'), ['src/auth.ts']);
    assert.deepEqual(db.getImportedBy('src/auth.ts'), ['src/user.ts']);

    const hits = db.searchHybrid('validate jwt token', null, 3);
    assert.equal(hits[0]?.chunk.name, 'validateToken', `expected validateToken rank-1, got ${hits[0]?.chunk.name}`);
    db.close();
});

// ─── 2. Rank consistency with the in-memory engine ──────────────────────────────
test('SqliteGraphStore matches MemoryGraphIndex rank-1 + top-5 set on a real fixture', () => {
    const indexPath = path.join(FIXTURES_DIR, 'express-js', 'code-index.json');
    if (!fs.existsSync(indexPath)) { console.log('      (skipped — express-js fixture not indexed)'); return; }

    const mem = new MemoryGraphIndex(indexPath);
    mem.load();
    const chunks = [...mem.chunks.values()];
    const sq = buildAndReopen(chunks, mem.graph);

    const queries = [
        'response json serialize object',
        'router handle request next',
        'Layer match path',
        'application listen port server',
    ];
    for (const q of queries) {
        const m = mem.searchHybrid(q, null, 5).map(r => r.chunk.name);
        const s = sq.searchHybrid(q, null, 5).map(r => r.chunk.name);
        assert.equal(s[0], m[0], `rank-1 mismatch for "${q}": memory=${m[0]} sqlite=${s[0]}`);
        assert.deepEqual(new Set(s), new Set(m), `top-5 set mismatch for "${q}": memory=[${m}] sqlite=[${s}]`);
    }
    sq.close();
});

// ─── 3. Incremental updates (watch-daemon write path) ───────────────────────────

function syntheticCorpus() {
    const mk = (id, file, name, code, hash, calls = []) => ({
        id, file_path: file, node_type: 'function_declaration', name,
        docstring: '', code_snippet: code, content_hash: hash,
        start_line: 1, end_line: 6, calls, params: [], return_type: '',
        class_context: '', type_refs: [], decorators: [], extends: [],
    });
    return {
        chunks: [
            mk('a1', 'src/auth.ts', 'validateToken', 'function validateToken(t){ return verify(t); }', 'ha1', ['verify']),
            mk('a2', 'src/auth.ts', 'verify', 'function verify(t){ return true; }', 'ha2'),
            mk('u1', 'src/user.ts', 'loginUser', 'function loginUser(u){ return validateToken(u.token); }', 'hu1', ['validateToken']),
        ],
        graph: { dependencies: { 'src/auth.ts': [], 'src/user.ts': ['src/auth.ts'] }, importedBy: {} },
        mk,
    };
}

test('applyFileUpdate matches a full rebuild (chunks, symbols, BM25 stats, search)', () => {
    const { chunks, graph, mk } = syntheticCorpus();
    const vec = (a, b, c, d) => new Float32Array([a, b, c, d]);
    const cache = new Map([['ha1', vec(1, 0, 0, 0)], ['ha2', vec(0, 1, 0, 0)], ['hu1', vec(0, 0, 1, 0)]]);

    // Incremental path: build v1, then change src/user.ts (one chunk modified, one added).
    const incPath = tmpDbPath();
    tmpFiles.push(incPath.replace(/\.db$/, '.embeddings.bin'));
    new SqliteGraphStore(incPath).buildFrom({ chunks, graph, embeddingCache: cache });
    const inc = new SqliteGraphStore(incPath);
    inc.load();

    const newUserChunks = [
        mk('u1', 'src/user.ts', 'loginUser', 'function loginUser(u){ return validateToken(u.jwt); }', 'hu1b', ['validateToken']),
        mk('u2', 'src/user.ts', 'logoutUser', 'function logoutUser(u){ return revoke(u); }', 'hu2', ['revoke']),
    ];
    inc.applyFileUpdate('src/user.ts', {
        chunks: newUserChunks,
        imports: ['src/auth.ts'],
        embeddings: new Map([['hu1b', vec(0, 0, 1, 1)], ['hu2', vec(0, 0, 0, 1)]]),
    });

    // Rebuild path: the same final corpus built from scratch.
    const rebPath = tmpDbPath();
    tmpFiles.push(rebPath.replace(/\.db$/, '.embeddings.bin'));
    const finalChunks = [chunks[0], chunks[1], ...newUserChunks];
    const finalCache = new Map([...cache, ['hu1b', vec(0, 0, 1, 1)], ['hu2', vec(0, 0, 0, 1)]]);
    new SqliteGraphStore(rebPath).buildFrom({ chunks: finalChunks, graph, embeddingCache: finalCache });
    const reb = new SqliteGraphStore(rebPath);
    reb.load();

    // Same corpus statistics (BM25 bookkeeping must not drift).
    assert.equal(inc.chunkCount(), reb.chunkCount());
    assert.equal(inc.symbolCount(), reb.symbolCount());
    assert.equal(inc._docCount, reb._docCount, 'doc_count drift');
    assert.equal(inc._totalDocLen, reb._totalDocLen, 'total_doc_len drift');

    // Same contract answers.
    assert.equal(inc.resolveSymbol('logoutUser')[0]?.id, 'u2');
    assert.equal(inc.resolveSymbol('loginUser')[0]?.content_hash, 'hu1b');
    assert.deepEqual(inc.findCallers('revoke').map(c => c.id), ['u2']);

    // Same hybrid ranking, lexical and with a query vector.
    for (const q of ['login user validate token', 'logout revoke user', 'verify token']) {
        const a = inc.searchHybrid(q, null, 5).map(r => r.chunk.id);
        const b = reb.searchHybrid(q, null, 5).map(r => r.chunk.id);
        assert.deepEqual(a, b, `lexical ranking drift for "${q}"`);
    }
    const qv = vec(0, 0, 0.6, 0.8);
    const av = inc.searchHybrid('logout', qv, 3, 0.1).map(r => r.chunk.id);
    const bv = reb.searchHybrid('logout', qv, 3, 0.1).map(r => r.chunk.id);
    assert.deepEqual(av, bv, 'hybrid ranking drift with vectors');

    // Appended vector is readable from the bin at its recorded offset.
    const v = inc._readVector('u2');
    assert.ok(v && Math.abs(v[3] - 1) < 1e-6, 'appended vector not readable');

    inc.close(); reb.close();
});

test('removeFile purges chunks, postings, callers and the graph node', () => {
    const { chunks, graph } = syntheticCorpus();
    const p = tmpDbPath();
    new SqliteGraphStore(p).buildFrom({ chunks, graph, embeddingCache: new Map() });
    const db = new SqliteGraphStore(p);
    db.load();

    db.removeFile('src/user.ts');
    assert.equal(db.getChunksByFile('src/user.ts').length, 0);
    assert.equal(db.resolveSymbol('loginUser').length, 0);
    assert.deepEqual(db.findCallers('validateToken'), []);
    assert.equal(db.chunkCount(), 2);
    assert.ok(!('src/user.ts' in db.graph.dependencies), 'graph node not removed');
    assert.deepEqual(db.getImportedBy('src/auth.ts'), []);

    // BM25 still sane for the surviving file.
    const hits = db.searchHybrid('validate token', null, 3);
    assert.equal(hits[0]?.chunk.name, 'validateToken');
    db.close();
});

test('a reader connection picks up another connection\'s commit (data_version refresh)', () => {
    const { chunks, graph, mk } = syntheticCorpus();
    const p = tmpDbPath();
    tmpFiles.push(p.replace(/\.db$/, '.embeddings.bin'));
    new SqliteGraphStore(p).buildFrom({ chunks, graph, embeddingCache: new Map() });

    const reader = new SqliteGraphStore(p); reader.load();
    const writer = new SqliteGraphStore(p); writer.load();

    // Reader has answered a query (cached meta/graph) before the writer commits.
    assert.equal(reader.searchHybrid('logout revoke', null, 3).length, 0);

    writer.applyFileUpdate('src/session.ts', {
        chunks: [mk('s1', 'src/session.ts', 'revokeSession', 'function revokeSession(s){ return purge(s); }', 'hs1', ['purge'])],
        imports: ['src/auth.ts'],
    });

    // The reader must see the new chunk + graph edge without reopening.
    const hits = reader.searchHybrid('revoke session purge', null, 3);
    assert.equal(hits[0]?.chunk.name, 'revokeSession', 'reader did not refresh after external commit');
    assert.deepEqual(reader.getDependencies('src/session.ts'), ['src/auth.ts']);
    assert.equal(reader.chunkCount(), 4);

    reader.close(); writer.close();
});

// ─── Cleanup ────────────────────────────────────────────────────────────────────
for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
