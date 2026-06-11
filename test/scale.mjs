#!/usr/bin/env node
/**
 * test/scale.mjs
 *
 * Proves the OOM fix. Builds a synthetic "massive" index (default 50k chunks) and
 * measures resident memory of each backend in an ISOLATED subprocess:
 *
 *   - in-memory engine: loads every chunk + the full inverted index into the heap
 *     → RAM grows with corpus size.
 *   - SQLite store: keeps only the small file-level dependency graph resident;
 *     chunks/postings/vectors are touched on demand → RAM stays flat.
 *
 * The test asserts both backends return the same chunk count (correctness) and
 * that the SQLite resident set is materially smaller than the in-memory one.
 *
 *   node test/scale.mjs            # default 50,000 chunks
 *   node test/scale.mjs 120000     # stress
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { MemoryGraphIndex, writeEmbeddingBinary } from '../core-engine.mjs';
import { SqliteGraphStore } from '../sqlite-store.mjs';

const __filename = fileURLToPath(import.meta.url);
const MB = 1024 * 1024;
const VEC_DIM = 768; // nomic-embed-text dimensionality — realistic scan cost

// Deterministic synthetic corpus with a REALISTIC token distribution: identifiers
// are drawn from a large vocabulary so most terms are rare (Zipfian-like), exactly
// like real code. This is what lets the SQLite store's posting lookups touch only a
// handful of rows per query — the property that keeps its RAM flat. (A degenerate
// corpus where every chunk shares the same words would inflate every posting list
// and is not representative of any real repository.) ~500-char bodies keep the
// payload large enough that holding it all in the heap is visibly expensive.
const VOCAB = 20000;
const word = (k) => 'sym' + (((k % VOCAB) + VOCAB) % VOCAB).toString(36);

function genChunks(n) {
    const files = Math.max(1, Math.floor(n / 8));
    const filler = ' /* ' + 'x'.repeat(380) + ' */';
    const chunks = new Array(n);
    for (let i = 0; i < n; i++) {
        const toks = [];
        for (let j = 0; j < 18; j++) toks.push(word(i * 7 + j * 1301 + j * j));
        const name = `fn_${word(i)}_${i}`;
        chunks[i] = {
            id: `c${i}`, file_path: `src/mod${i % files}/file${i % files}.ts`,
            node_type: 'function_declaration', name,
            docstring: toks.slice(0, 6).join(' '),
            code_snippet: `function ${name}(a, b){ ${toks.map(t => `${t}(a)`).join('; ')}; return b; }${filler}`,
            content_hash: `h${i}`, start_line: 1, end_line: 6,
            calls: [toks[0]], params: ['a', 'b'], return_type: 'void',
            class_context: '', type_refs: [], decorators: [], extends: [],
        };
    }
    return chunks;
}
function genGraph(n) {
    const files = Math.max(1, Math.floor(n / 8));
    const dependencies = {};
    for (let f = 0; f < files; f++) dependencies[`src/mod${f}/file${f}.ts`] = [];
    return { dependencies, importedBy: {} };
}

/** Deterministic unit vector per seed — used for both the corpus and the query. */
function genVector(seed) {
    const v = new Float32Array(VEC_DIM);
    let norm = 0;
    for (let d = 0; d < VEC_DIM; d++) {
        v[d] = Math.sin(seed * 769 + d * 13) + Math.sin((seed % 50) * 100 + d * 0.7);
        norm += v[d] * v[d];
    }
    norm = Math.sqrt(norm);
    for (let d = 0; d < VEC_DIM; d++) v[d] /= norm;
    return v;
}
function genEmbeddings(n) {
    const cache = new Map();
    for (let i = 0; i < n; i++) cache.set(`h${i}`, genVector(i));
    return cache;
}

// Query of specific, in-vocabulary terms — present in only a small fraction of chunks.
const QUERY = `${word(11)} ${word(523)} ${word(9001)} ${word(14777)}`;
const QUERY_VEC = genVector(424242);

// ─── Child modes: load one backend, run queries, print RSS ──────────────────────

function timeHybridQueries(db) {
    db.searchHybrid(QUERY, QUERY_VEC, 5); // warm (page cache + lazy sketch build)
    let best = Infinity;
    for (let q = 0; q < 5; q++) {
        const t0 = process.hrtime.bigint();
        db.searchHybrid(QUERY, QUERY_VEC, 5);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms < best) best = ms;
    }
    return best;
}

if (process.argv[2] === '--sqlite-child') {
    const [, , , N, dbPath] = process.argv;
    const db = new SqliteGraphStore(dbPath);
    db.load();
    for (let q = 0; q < 25; q++) db.searchHybrid(QUERY, null, 5);
    const lat = timeHybridQueries(db);
    const count = db.chunkCount();
    db.close();
    process.stdout.write(`RSS=${process.memoryUsage().rss}\nCHUNKS=${count}\nLAT=${lat.toFixed(2)}\n`);
    process.exit(0);
}
if (process.argv[2] === '--mem-child') {
    const [, , , N, jsonPath] = process.argv;
    // cacheEmbeddings:false = the MCP server's own configuration → lazy vector
    // mode at this corpus size (sketch path), not the eager in-heap matrix.
    const db = new MemoryGraphIndex(jsonPath, { cacheEmbeddings: false });
    db.load();
    for (let q = 0; q < 25; q++) db.searchHybrid(QUERY, null, 5);
    const lat = timeHybridQueries(db);
    const count = db.chunks.size;
    process.stdout.write(`RSS=${process.memoryUsage().rss}\nCHUNKS=${count}\nLAT=${lat.toFixed(2)}\n`);
    process.exit(0);
}

// ─── Parent: build artifacts, measure both backends in isolation ────────────────

function runChild(mode, N, artifact) {
    const r = spawnSync(process.execPath, ['--no-warnings', __filename, mode, String(N), artifact],
        { encoding: 'utf-8', maxBuffer: 64 * MB });
    if (r.status !== 0) throw new Error(`${mode} exited ${r.status}: ${r.stderr?.slice(0, 400)}`);
    const rss = Number((r.stdout.match(/RSS=(\d+)/) || [])[1]);
    const chunks = Number((r.stdout.match(/CHUNKS=(\d+)/) || [])[1]);
    const lat = Number((r.stdout.match(/LAT=([\d.]+)/) || [])[1]);
    return { rss, chunks, lat };
}

async function main() {
    const N = Number(process.argv[2] || 50000);
    console.log(`\nSCALE / OOM TEST  (${N.toLocaleString()} synthetic chunks)\n`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-scale-'));
    const dbPath = path.join(tmpDir, 'code-index.db');
    const jsonPath = path.join(tmpDir, 'code-index.json');
    let passed = 0, failed = 0;
    const check = (name, fn) => {
        try { fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
    };

    try {
        const chunks = genChunks(N);
        const graph = genGraph(N);
        const embeddingCache = genEmbeddings(N);
        const rawBytes = chunks.reduce((s, c) => s + c.code_snippet.length, 0);

        // Build both artifacts on disk (shared embeddings bin next to each stem).
        const t0 = Date.now();
        new SqliteGraphStore(dbPath).buildFrom({ chunks, graph, embeddingCache });
        const sqliteBuildMs = Date.now() - t0;
        fs.writeFileSync(jsonPath, JSON.stringify({ chunks, graph }));
        fs.writeFileSync(path.join(tmpDir, 'code-index.embeddings.bin'), writeEmbeddingBinary(embeddingCache));

        const dbSize = fs.statSync(dbPath).size;
        const binSize = fs.statSync(path.join(tmpDir, 'code-index.embeddings.bin')).size;
        console.log(`  built: sqlite ${(dbSize / MB).toFixed(0)}MB in ${(sqliteBuildMs / 1000).toFixed(1)}s · raw bodies ${(rawBytes / MB).toFixed(0)}MB · vectors ${(binSize / MB).toFixed(0)}MB\n`);

        // Measure each backend in a clean subprocess.
        const mem = runChild('--mem-child', N, jsonPath);
        const sq = runChild('--sqlite-child', N, dbPath);

        console.log(`  in-memory backend : RSS ${(mem.rss / MB).toFixed(0)}MB  (${mem.chunks} chunks) · hybrid query ${mem.lat.toFixed(1)}ms`);
        console.log(`  sqlite   backend  : RSS ${(sq.rss / MB).toFixed(0)}MB  (${sq.chunks} chunks) · hybrid query ${sq.lat.toFixed(1)}ms`);
        console.log(`  → sqlite resident set is ${(100 * (1 - sq.rss / mem.rss)).toFixed(0)}% smaller\n`);

        check('both backends index the full corpus', () => {
            assert.equal(mem.chunks, N);
            assert.equal(sq.chunks, N);
        });
        check('sqlite resident set is materially smaller than in-memory', () => {
            assert.ok(sq.rss < mem.rss, `sqlite RSS ${sq.rss} not < memory RSS ${mem.rss}`);
            assert.ok(mem.rss - sq.rss > 25 * MB, `savings too small: ${(mem.rss - sq.rss) / MB}MB`);
        });
        check('sqlite resident set stays bounded (chunks not held in RAM)', () => {
            // The whole chunk payload is on disk; the resident set must be a fraction of it.
            assert.ok(sq.rss < 350 * MB, `sqlite RSS ${(sq.rss / MB).toFixed(0)}MB exceeds 350MB budget`);
        });
        check('hybrid query latency stays interactive at scale (binary sketch)', () => {
            // The exact streaming scan measured ~104ms at this corpus size; the
            // sketch must keep warm hybrid queries far below that on both backends.
            assert.ok(sq.lat < 60, `sqlite hybrid query ${sq.lat.toFixed(1)}ms exceeds 60ms budget`);
            assert.ok(mem.lat < 60, `memory(lazy) hybrid query ${mem.lat.toFixed(1)}ms exceeds 60ms budget`);
        });
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
    }

    console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
