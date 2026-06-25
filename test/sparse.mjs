/**
 * @file test/sparse.mjs
 * @description B3 — learned-sparse vocabulary-expansion channel tests. Four layers:
 *                1. model build: buildSparseModel learns positive-PMI associations from a synthetic
 *                   corpus, deterministically (order-independent, byte-stable).
 *                2. query expansion: expandSparseQuery turns a query into the WEIGHTED associate set,
 *                   and returns null when nothing fires (→ inert channel).
 *                3. engine integration: on a real in-memory index, an NL query surfaces a chunk that
 *                   shares NONE of the query's literal terms but matches the learned vocabulary (the
 *                   recall win) — while a symbolic/exact query is byte-identical with and without the
 *                   model (the sacred-default / NL-asymmetry guarantee).
 *                4. parity + staleness: memory ↔ sqlite return identical top-5 with the model present;
 *                   a default index carries no model; an incremental edit drops the stale model.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { buildSparseModel, expandSparseQuery } from '../search-sparse.mjs';
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { SqliteGraphStore } from '../engine/sqlite.mjs';

const tmp = (ext) => path.join(os.tmpdir(), `sparse-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`);
const rm = (p) => { for (const s of ['', '-wal', '-shm']) fs.rmSync(`${p}${s}`, { force: true }); };

let CID = 0;
const chunk = (name, body) => ({
    id: `c${String(++CID).padStart(3, '0')}`, file_path: `src/${name}.js`, node_type: 'function_declaration',
    name, code_snippet: `function ${name}() { ${body} }`, docstring: '', content_hash: null,
    start_line: 1, end_line: 5, calls: [], params: [], type_refs: [], extends: [], decorators: [], class_context: '',
});

// A synthetic corpus where {authenticate, credential, token} co-occur across THREE chunks, plus a
// target that carries credential+token but NOT authenticate (the expansion-only recall case), plus
// filler so the cluster terms stay inside the df band [2, 0.3·N]. (N = 15 → maxDf = 4.)
function corpus() {
    CID = 0;
    return [
        chunk('loginUser', 'authenticate credential token session validate'),
        chunk('verifyLogin', 'authenticate credential token validate session'),
        chunk('checkAuth', 'authenticate credential token guard middleware'),
        chunk('rotateCredential', 'credential token refresh storage vault rotate'), // ← sparse-only target
        chunk('computeSum', 'compute sum total accumulate reduce numbers'),
        chunk('renderView', 'render view template html markup paint'),
        chunk('parseConfig', 'parse config yaml settings options load'),
        chunk('serializeJson', 'serialize json encode stringify payload'),
        chunk('openSocket', 'socket connect network stream bytes'),
        chunk('readFile', 'read file disk buffer stream path'),
        chunk('writeQueue', 'queue enqueue dequeue buffer worker'),
        chunk('hashBytes', 'hash digest checksum bytes crypto'),
        chunk('formatDate', 'format date time calendar locale'),
        chunk('sortList', 'sort list order compare swap elements'),
        chunk('mapReduce', 'map reduce transform iterate collection'),
    ];
}

const GRAPH = { dependencies: {}, routes: [] };

/** Load chunks + an optional sparse model into BOTH backends. */
function loadBoth(chunks, sparseModel) {
    const memPath = tmp('.json');
    fs.writeFileSync(memPath, JSON.stringify({ chunks, graph: GRAPH, ...(sparseModel ? { sparse_model: sparseModel } : {}) }));
    const mem = new MemoryGraphIndex(memPath); mem.load();
    const dbPath = tmp('.db');
    new SqliteGraphStore(dbPath).buildFrom({ chunks, graph: GRAPH, embeddingCache: new Map(), sparseModel });
    const sq = new SqliteGraphStore(dbPath); sq.load();
    return { mem, sq, memPath, dbPath };
}

const ids = (res) => res.map(r => r.chunk.id);

// A real natural-language query (≥5 words, ≥2 stopwords) mentioning `authenticate` but NOT
// `credential`/`token` — so the literal lexical channel never reaches the rotateCredential target.
const NL_QUERY = 'how does the service authenticate an incoming user request';
// An exact symbolic lookup (short, no stopwords) — must bypass the sparse channel entirely.
const SYMBOLIC_QUERY = 'rotateCredential';

// ── Layer 1: model build ─────────────────────────────────────────────────────────────────────
test('sparse (B3): buildSparseModel learns positive-PMI associations, deterministically', () => {
    const model = buildSparseModel(corpus());
    assert.ok(model && model.assoc, 'a model is produced for a corpus with co-occurrence signal');
    assert.equal(model.meta.metric, 'pmi');
    // authenticate co-occurs with credential & token (3 chunks each) → both are learned associates.
    const assoc = model.assoc['authenticate'] || [];
    const terms = assoc.map(([t]) => t);
    assert.ok(terms.includes('credential'), 'authenticate → credential association learned');
    assert.ok(terms.includes('token'), 'authenticate → token association learned');
    assert.ok(assoc.every(([, w]) => w > 0 && w <= 1), 'weights are normalised to (0, 1]');
    // determinism: a fresh build over a shuffled corpus is byte-identical.
    const shuffled = corpus().reverse();
    assert.equal(JSON.stringify(buildSparseModel(shuffled)), JSON.stringify(model), 'model is order-independent');
    // unrelated singleton vocabulary yields no model (no signal).
    assert.equal(buildSparseModel([chunk('lonely', 'xyzzy plugh frobnicate')]), null);
});

// ── Layer 2: query expansion ──────────────────────────────────────────────────────────────────
test('sparse (B3): expandSparseQuery weights associates and is null when nothing fires', () => {
    const model = buildSparseModel(corpus());
    const exp = expandSparseQuery('authenticate the user somehow', model);
    assert.ok(exp instanceof Map && exp.size > 0, 'a query containing `authenticate` expands');
    assert.ok(exp.has('credential') && exp.has('token'), 'expansion includes the learned associates');
    assert.ok(![...exp.keys()].includes('authenticate'), 'a literal query term is never re-added as an expansion');
    assert.ok([...exp.values()].every(w => w > 0 && w < 1), 'expansion weights are scaled below 1');
    // a query whose terms have no learned associates → null (inert channel).
    assert.equal(expandSparseQuery('frobnicate the doohickey', model), null);
    assert.equal(expandSparseQuery('anything', null), null, 'no model → null');
});

// ── Layer 3: engine integration (recall win + NL-asymmetry) ────────────────────────────────────
test('sparse (B3): an NL query surfaces a vocabulary-matched chunk the literal query misses', () => {
    const chunks = corpus();
    const model = buildSparseModel(chunks);
    const target = chunks.find(c => c.name === 'rotateCredential').id;

    const withModel = loadBoth(chunks, model);
    const without = loadBoth(chunks, null);

    const hitWith = ids(withModel.mem.searchHybrid(NL_QUERY, null, 8));
    const hitWithout = ids(without.mem.searchHybrid(NL_QUERY, null, 8));
    assert.ok(!hitWithout.includes(target),
        'WITHOUT the model: rotateCredential (no literal query term) is NOT retrieved');
    assert.ok(hitWith.includes(target),
        'WITH the model: the learned credential/token expansion surfaces rotateCredential (recall win)');

    for (const k of ['mem', 'sq']) { withModel[k].close?.(); without[k].close?.(); }
    rm(withModel.memPath); rm(withModel.dbPath); rm(without.memPath); rm(without.dbPath);
});

test('sparse (B3): SACRED DEFAULT — a symbolic/exact query is byte-identical with and without the model', () => {
    const chunks = corpus();
    const model = buildSparseModel(chunks);
    const withModel = loadBoth(chunks, model);
    const without = loadBoth(chunks, null);

    // exact symbolic lookup is < 5 words → NOT an NL query → the sparse channel never fires.
    const a = withModel.mem.searchHybrid(SYMBOLIC_QUERY, null, 8);
    const b = without.mem.searchHybrid(SYMBOLIC_QUERY, null, 8);
    assert.deepEqual(a.map(r => [r.chunk.id, r.score]), b.map(r => [r.chunk.id, r.score]),
        'symbolic query: identical ids AND scores whether or not the model is present');
    assert.equal(withModel.mem.hasSparseModel(), true);
    assert.equal(without.mem.hasSparseModel(), false, 'default index carries no model');

    for (const k of ['mem', 'sq']) { withModel[k].close?.(); without[k].close?.(); }
    rm(withModel.memPath); rm(withModel.dbPath); rm(without.memPath); rm(without.dbPath);
});

// ── Layer 4: parity + serialization + staleness ────────────────────────────────────────────────
test('sparse (B3): the learned-sparse channel is byte-identical across memory ↔ sqlite (parity)', () => {
    const chunks = corpus();
    const model = buildSparseModel(chunks);
    const { mem, sq, memPath, dbPath } = loadBoth(chunks, model);

    assert.ok(mem.hasSparseModel() && sq.hasSparseModel());
    const m = mem.searchHybrid(NL_QUERY, null, 5);
    const s = sq.searchHybrid(NL_QUERY, null, 5);
    assert.deepEqual(s.map(r => r.chunk.id), m.map(r => r.chunk.id), 'top-5 ids identical');
    assert.deepEqual(s.map(r => r.score.toFixed(9)), m.map(r => r.score.toFixed(9)), 'top-5 scores identical');

    sq.close?.(); rm(memPath); rm(dbPath);
});

test('sparse (B3): default index has no sparse_model key (sacred-default byte-identity)', () => {
    const chunks = corpus();
    const { mem, sq, memPath, dbPath } = loadBoth(chunks, null);
    assert.ok(!('sparse_model' in JSON.parse(fs.readFileSync(memPath, 'utf8'))), 'no sparse_model key when off');
    assert.equal(mem.hasSparseModel(), false);
    assert.equal(sq.hasSparseModel(), false);
    sq.close?.(); rm(memPath); rm(dbPath);
});

test('sparse (B3): an incremental file update drops the now-stale whole-program model', () => {
    const chunks = corpus();
    const model = buildSparseModel(chunks);
    const { mem, sq, memPath, dbPath } = loadBoth(chunks, model);
    assert.ok(mem.hasSparseModel() && sq.hasSparseModel());

    const edited = [chunk('loginUser', 'authenticate credential token session validate')];
    mem.applyFileUpdate('src/loginUser.js', { chunks: edited, imports: [] });
    if (mem._saveTimer) { clearTimeout(mem._saveTimer); mem._saveTimer = null; }
    sq.applyFileUpdate('src/loginUser.js', { chunks: edited, imports: [] });
    assert.equal(mem.hasSparseModel(), false, 'memory: per-file edit makes the whole-program model stale → cleared');
    assert.equal(sq.hasSparseModel(), false, 'sqlite: DELETE FROM sparse_model on incremental update');

    sq.close?.(); rm(memPath); rm(dbPath);
});
