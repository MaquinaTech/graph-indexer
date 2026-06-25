/**
 * @file test/edges.mjs
 * @description Tests the A4 persistent resolved symbol graph: the edge builder, getEdges,
 *              the edge-backed findCallers/findReferers, cross-backend parity, the
 *              undefined-name scan fallback, and the daemon edge-invalidation. Also covers
 *              C4 (impact_of_edit blast radius) and A5 (symbol-centrality PageRank, its
 *              serialization, store methods, parity, gating, and daemon invalidation).
 *
 *              The load-bearing safety property is SET-EQUIVALENCE: with the graph present,
 *              findCallers/findReferers must return exactly the same chunks as the name-match
 *              scan — otherwise migrating the readers to edges would silently change the call
 *              graph. No Ollama, no network.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { SqliteGraphStore } from '../engine/sqlite.mjs';
import { extractSemanticChunks } from '../parse/extractor.mjs';
import { getParserForFile } from '../parse/languages.mjs';
import { buildSymbolGraph, edgeOrder } from '../mcp/symbolgraph.mjs';
import { computeSymbolCentrality } from '../mcp/centrality.mjs';
import { buildImpact } from '../mcp/topology.mjs';
import { registerTools } from '../mcp/tools.mjs';

const GOD = Array.from({ length: 210 }, (_, i) => `  // pad ${i}`).join('\n');
const FILES = {
    // God-class so its method `getId` is its own chunk (a resolvable callee).
    'models.ts': `
export class User {
  getId() {
    return this.id;
  }
${GOD}
}
`,
    'helpers.ts': `
export function format(x) {
  return String(x);
}
`,
    // A SECOND format → the name is ambiguous, so confidence depends on the import graph
    // (a caller that imports helpers.ts is high; one that imports neither is name_only).
    'legacy.ts': `
export function format(y) {
  return y.toString();
}
`,
    'service.ts': `
import { User } from './models';
import { format } from './helpers';
export function handle(u) {
  const id = format(u.getId());
  return id;
}
export class Admin extends User {
  ban(u) {
    return format(u);
  }
}
`,
    // A SECOND User → the type name is ambiguous; a referer that does not import it is name_only.
    'legacy_models.ts': `
export class User {
  legacyId() {
    return this.legacy;
  }
}
`,
    // Uses User AS A TYPE but imports neither User module → name_only type reference.
    'report.ts': `
export function summarize(u: User) {
  const data = format(u);
  return data;
}
`,
};
const IMPORTS = { 'service.ts': ['models.ts', 'helpers.ts'] };
const ALL_NAMES = ['format', 'getId', 'User', 'handle', 'Admin', 'summarize', 'String', 'doesNotExist'];

function parseFixture() {
    const parser = getParserForFile('.ts');
    if (!parser) return null;
    const perFile = {};
    for (const [f, src] of Object.entries(FILES)) {
        const tree = parser.parse((o) => (o < src.length ? src.slice(o, o + 4096) : null));
        perFile[f] = extractSemanticChunks(tree.rootNode, f, src, '.ts');
    }
    return perFile;
}

function loadMem(perFile, { withEdges }) {
    const p = path.join(os.tmpdir(), `edges-mem-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const scan = new MemoryGraphIndex(p, { cacheEmbeddings: false });
    for (const [f, chunks] of Object.entries(perFile)) {
        scan.applyFileUpdate(f, { chunks, imports: IMPORTS[f] || [] });
        if (scan._saveTimer) { clearTimeout(scan._saveTimer); scan._saveTimer = null; }
    }
    const { edges } = buildSymbolGraph(scan);
    if (!withEdges) return { db: scan, edges };
    // A5: centrality is computed with the graph and serialized alongside the edges.
    const { centrality } = computeSymbolCentrality(edges);
    // Round-trip through disk so edges + centrality load exactly as production does.
    fs.writeFileSync(p, JSON.stringify({ chunks: [...scan.chunks.values()], graph: scan.graph, edges, centrality }));
    const db = new MemoryGraphIndex(p); db.load();
    return { db, edges, centrality, chunks: [...scan.chunks.values()], graph: scan.graph };
}

const names = (chunks) => chunks.map(c => c.name).sort();

test('symbol graph: edge-backed findCallers/findReferers EQUAL the name-match scan', () => {
    const perFile = parseFixture();
    if (!perFile) { console.log('  ⚠️  tree-sitter-typescript not installed — skipping'); return; }
    const { db: scan } = loadMem(perFile, { withEdges: false });
    const { db: edged } = loadMem(perFile, { withEdges: true });
    assert.ok(edged._edges && edged._edges.length > 0, 'edges loaded');
    for (const n of ALL_NAMES) {
        assert.deepEqual(names(edged.findCallers(n)), names(scan.findCallers(n)), `findCallers(${n}) set-equivalence`);
        assert.deepEqual(names(edged.findReferers(n)), names(scan.findReferers(n)), `findReferers(${n}) set-equivalence`);
    }
});

test('symbol graph: getEdges direction + kind + confidence', () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const { db } = loadMem(perFile, { withEdges: true });
    // 'calls' edges: every direct caller of the (ambiguous) free fn `format` is high.
    const fmt = db.resolveSymbol('format')[0];
    const inCalls = db.getEdges(fmt.id, { direction: 'in', kind: 'calls' });
    assert.deepEqual(inCalls.map(e => db.getChunk(e.from_chunk_id).name).sort(), ['Admin', 'handle', 'summarize'],
        'all direct callers of format');
    for (const e of inCalls) assert.ok(['high', 'name_only'].includes(e.confidence), 'valid confidence');
    // 'extends' edge: Admin extends User and imports models.ts → high.
    const user = db.resolveSymbol('User')[0];
    const ext = db.getEdges(user.id, { direction: 'in', kind: 'extends' });
    assert.deepEqual(ext.map(e => db.getChunk(e.from_chunk_id).name), ['Admin']);
    assert.equal(ext[0].confidence, 'high', 'Admin imports the User module → high');
    // 'type' edge: summarize uses User as a type but imports neither User module, and User
    // is ambiguous → name_only. This is the milestone's name_only edge.
    const typed = db.getEdges(user.id, { direction: 'in', kind: 'type' });
    assert.ok(typed.some(e => db.getChunk(e.from_chunk_id).name === 'summarize' && e.confidence === 'name_only'),
        'a non-importing user of an ambiguous type is name_only');
    // direction:out — what `handle` references.
    const handle = db.resolveSymbol('handle')[0];
    const out = db.getEdges(handle.id, { direction: 'out' }).map(e => `${db.getChunk(e.to_chunk_id).name}/${e.kind}`).sort();
    assert.ok(out.includes('getId/calls'), 'handle → getId (calls)');
    assert.ok(out.some(o => o.startsWith('format/calls')), 'handle → format (calls)');
});

test('symbol graph: undefined-name lookups fall back to the scan (never empty-by-edges)', () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const { db: scan } = loadMem(perFile, { withEdges: false });
    const { db: edged } = loadMem(perFile, { withEdges: true });
    // String / doesNotExist have no in-repo definition → no edges; must still match the scan.
    for (const n of ['String', 'doesNotExist']) {
        assert.deepEqual(names(edged.findCallers(n)), names(scan.findCallers(n)), `findCallers(${n}) falls back`);
    }
});

test('symbol graph: memory ↔ sqlite parity (getEdges + findCallers/findReferers)', () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const { db: mem, edges, chunks, graph } = loadMem(perFile, { withEdges: true });

    const dbPath = path.join(os.tmpdir(), `edges-sq-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    new SqliteGraphStore(dbPath).buildFrom({ chunks, graph, embeddingCache: new Map(), edges });
    const sq = new SqliteGraphStore(dbPath); sq.load();
    assert.equal(sq._hasEdges, true, 'sqlite detects the edge table');

    for (const n of ALL_NAMES) {
        assert.deepEqual(names(sq.findCallers(n)), names(mem.findCallers(n)), `findCallers(${n}) parity`);
        assert.deepEqual(names(sq.findReferers(n)), names(mem.findReferers(n)), `findReferers(${n}) parity`);
    }
    // getEdges tuples (ignoring the resolved chunk object) must be byte-identical, in order.
    const tuples = (db, id, dir) => db.getEdges(id, { direction: dir })
        .map(e => `${e.from_chunk_id}|${e.to_chunk_id}|${e.kind}|${e.confidence}`);
    for (const def of [mem.resolveSymbol('format')[0], mem.resolveSymbol('User')[0], mem.resolveSymbol('getId')[0]]) {
        for (const dir of ['in', 'out']) {
            assert.deepEqual(tuples(sq, def.id, dir), tuples(mem, def.id, dir), `getEdges(${def.name}, ${dir}) parity`);
        }
    }
    sq.close?.();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
});

test('symbol graph: an incremental update invalidates the edges (daemon staleness guard)', () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const { db } = loadMem(perFile, { withEdges: true });
    assert.ok(db._edges, 'edges present before update');
    // A daemon-style per-file update must drop the now-stale graph → scan fallback.
    db.applyFileUpdate('helpers.ts', { chunks: perFile['helpers.ts'], imports: [] });
    if (db._saveTimer) { clearTimeout(db._saveTimer); db._saveTimer = null; }
    assert.equal(db._edges, null, 'edges cleared after an incremental update');
    // findCallers still works (via the scan) — never empty-by-stale-edges.
    assert.deepEqual(names(db.findCallers('format')), ['Admin', 'handle', 'summarize'], 'scan fallback after invalidation');
});

test('symbol graph: edge list is deterministically ordered', () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const { edges } = loadMem(perFile, { withEdges: false });
    const sorted = edges.slice().sort(edgeOrder);
    assert.deepEqual(edges, sorted, 'buildSymbolGraph emits edges already in the parity order');
});

// ── C4: transitive blast radius. Chain validateToken ← login ← handleLogin, plus a test
//    that calls validateToken. Editing validateToken impacts login (d1), handleLogin (d2),
//    and the test (d1). ────────────────────────────────────────────────────────────────
const IMPACT_FILES = {
    'auth.ts': `
export function validateToken(token) {
  return verify(token);
}
`,
    'service.ts': `
import { validateToken } from './auth';
export function login(req) {
  return validateToken(req.t);
}
`,
    'api.ts': `
import { login } from './service';
export function handleLogin(req) {
  return login(req);
}
`,
    'auth.test.ts': `
import { validateToken } from './auth';
test('validates a token', () => {
  return validateToken('x');
});
`,
};
const IMPACT_IMPORTS = { 'service.ts': ['auth.ts'], 'api.ts': ['service.ts'], 'auth.test.ts': ['auth.ts'] };

function parseImpact() {
    const parser = getParserForFile('.ts');
    if (!parser) return null;
    const perFile = {};
    for (const [f, src] of Object.entries(IMPACT_FILES)) {
        const tree = parser.parse((o) => (o < src.length ? src.slice(o, o + 4096) : null));
        perFile[f] = extractSemanticChunks(tree.rootNode, f, src, '.ts');
    }
    return perFile;
}
function loadImpact(perFile, { withEdges }) {
    const p = path.join(os.tmpdir(), `impact-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const scan = new MemoryGraphIndex(p, { cacheEmbeddings: false });
    for (const [f, chunks] of Object.entries(perFile)) {
        scan.applyFileUpdate(f, { chunks, imports: IMPACT_IMPORTS[f] || [] });
        if (scan._saveTimer) { clearTimeout(scan._saveTimer); scan._saveTimer = null; }
    }
    if (!withEdges) return scan;
    const { edges } = buildSymbolGraph(scan);
    fs.writeFileSync(p, JSON.stringify({ chunks: [...scan.chunks.values()], graph: scan.graph, edges }));
    const db = new MemoryGraphIndex(p); db.load();
    return db;
}

for (const mode of ['symbol-graph', 'query-time-fallback']) {
    test(`impact (C4): transitive blast radius via ${mode}`, () => {
        const perFile = parseImpact();
        if (!perFile) { console.log('  ⚠️  tree-sitter-typescript not installed — skipping'); return; }
        const db = loadImpact(perFile, { withEdges: mode === 'symbol-graph' });
        assert.equal(db.hasSymbolGraph(), mode === 'symbol-graph', 'graph presence matches the mode');
        const seed = db.resolveSymbol('validateToken');
        const { impacted, usedGraph } = buildImpact(db, seed, { maxDepth: 3 });
        assert.equal(usedGraph, mode === 'symbol-graph');
        const byName = new Map(impacted.map(a => [a.chunk.name, a.depth]));
        assert.equal(byName.get('login'), 1, 'direct caller at depth 1');
        assert.equal(byName.get('handleLogin'), 2, 'transitive caller at depth 2');
        // the test chunk (expression_statement) is a depth-1 caller in the test file
        assert.ok(impacted.some(a => /auth\.test\.ts/.test(a.chunk.file_path) && a.depth === 1),
            'the exercising test is in the blast radius at depth 1');
    });
}

test('impact (C4): symbol-graph and query-time fallback agree on the impacted set', () => {
    const perFile = parseImpact();
    if (!perFile) return;
    const graphDb = loadImpact(perFile, { withEdges: true });
    const scanDb = loadImpact(perFile, { withEdges: false });
    const set = (db) => buildImpact(db, db.resolveSymbol('validateToken'), { maxDepth: 3 })
        .impacted.map(a => `${a.chunk.name}@${a.depth}`).sort();
    assert.deepEqual(set(graphDb), set(scanDb), 'graph and fallback produce the same blast radius');
});

test('impact_of_edit tool composes changed + impacted + tests + routes', async () => {
    const perFile = parseImpact();
    if (!perFile) return;
    const db = loadImpact(perFile, { withEdges: true });
    // Attach a route whose handler is the depth-2 caller, so it must surface as affected.
    const handler = db.resolveSymbol('handleLogin')[0];
    db.graph.routes = [{
        method: 'POST', path: '/login', handler_name: 'handleLogin',
        handler_chunk_id: handler.id, file_path: 'api.ts', line: handler.start_line, framework: 'express',
    }];
    const handlers = new Map();
    registerTools({ tool: (n, _d, _s, h) => handlers.set(n, h) }, db, {
        projectRoot: os.tmpdir(), artifactPath: '/nonexistent', pidFile: null,
        embeddingsEnabled: false, embedder: null,
    });

    const res = await handlers.get('impact_of_edit')({ symbols: ['validateToken'], response_format: 'json' });
    const sc = res.structuredContent;
    assert.equal(sc.resolution, 'symbol-graph', 'used the persistent graph');
    assert.deepEqual(sc.changed.map(c => c.name), ['validateToken']);
    const impactedNames = sc.impacted.map(c => c.name);
    assert.ok(impactedNames.includes('login') && impactedNames.includes('handleLogin'), 'transitive code impacted');
    assert.ok(sc.impacted.every(c => !/\.test\./.test(c.file_path)), 'tests are split out of impacted code');
    assert.equal(sc.tests.length, 1, 'the exercising test is surfaced');
    assert.match(sc.tests[0].file_path, /auth\.test\.ts/);
    assert.deepEqual(sc.routes.map(r => `${r.method} ${r.path}`), ['POST /login'], 'affected route surfaced');
    assert.deepEqual(JSON.parse(res.content[0].text), sc, 'json text block matches structuredContent');
});

// ── A5: symbol-centrality PageRank. The pure function tests run without tree-sitter
//    (synthetic edges); the store/parity/gating tests reuse the TS fixture above. ────────────
const E = (from, to, confidence = 'high', kind = 'calls') =>
    ({ from_chunk_id: from, to_chunk_id: to, kind, confidence });

test('centrality (A5): deterministic for identical input', () => {
    const edges = [E('a', 'hub'), E('b', 'hub'), E('c', 'hub'), E('a', 'leaf')];
    const r1 = computeSymbolCentrality(edges);
    const r2 = computeSymbolCentrality(edges);
    assert.deepEqual(r1.centrality, r2.centrality, 'same edges → byte-identical centrality');
    assert.equal(r1.total, r2.total);
    // Empty graph is a clean no-op (default path).
    const empty = computeSymbolCentrality([]);
    assert.deepEqual(empty, { centrality: {}, total: 0, iters: 0 });
});

test('centrality (A5): a hub outranks a leaf', () => {
    // hub is referenced by a, b, c; leaf only by a → hub must be more central.
    const edges = [E('a', 'hub'), E('b', 'hub'), E('c', 'hub'), E('a', 'leaf')];
    const { centrality, total } = computeSymbolCentrality(edges);
    assert.equal(total, 5, 'all five connected chunks are ranked');
    assert.ok(centrality['hub'].rank < centrality['leaf'].rank, 'hub ranks ahead of leaf');
    assert.ok(centrality['hub'].score > centrality['leaf'].score, 'hub scores higher than leaf');
    assert.equal(centrality['hub'].rank, 1, 'hub is the single most-central node');
});

test('centrality (A5): high-confidence edges confer more centrality than name_only', () => {
    // p and q have the SAME two referrers; p via high edges, q via name_only edges.
    const edges = [E('x', 'p', 'high'), E('y', 'p', 'high'), E('x', 'q', 'name_only'), E('y', 'q', 'name_only')];
    const { centrality } = computeSymbolCentrality(edges);
    assert.ok(centrality['p'].score > centrality['q'].score,
        'identical topology, but the high-confidence target is more central');
});

test('centrality (A5): serialization round-trips + store methods (memory)', () => {
    const perFile = parseFixture();
    if (!perFile) { console.log('  ⚠️  tree-sitter-typescript not installed — skipping'); return; }
    const { db } = loadMem(perFile, { withEdges: true });
    assert.ok(db.hasCentrality(), 'centrality loaded from disk');
    const fmt = db.resolveSymbol('format')[0];
    const gc = db.getCentrality(fmt.id);
    assert.ok(gc && gc.rank >= 1 && gc.rank <= gc.total && gc.total >= 1, 'getCentrality returns rank/total');
    assert.equal(typeof gc.score, 'number');
    const top = db.topCentral(5);
    assert.ok(top.length > 0 && top[0].rank === 1, 'topCentral is rank-ascending from #1');
    for (let i = 1; i < top.length; i++) assert.ok(top[i].rank >= top[i - 1].rank, 'monotonic ranks');
    // An unranked id (no such chunk in the graph) → null, never a throw.
    assert.equal(db.getCentrality('no-such-id'), null);
});

test('centrality (A5): memory ↔ sqlite parity (rank exact, score within 1e-9, topCentral order)', () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const { db: mem, edges, centrality, chunks, graph } = loadMem(perFile, { withEdges: true });

    const dbPath = path.join(os.tmpdir(), `cen-sq-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    new SqliteGraphStore(dbPath).buildFrom({ chunks, graph, embeddingCache: new Map(), edges, centrality });
    const sq = new SqliteGraphStore(dbPath); sq.load();
    assert.equal(sq.hasCentrality(), true, 'sqlite detects the centrality table');

    for (const c of chunks) {
        const m = mem.getCentrality(c.id);
        const s = sq.getCentrality(c.id);
        if (m === null) { assert.equal(s, null, `${c.name} unranked in both`); continue; }
        assert.equal(s.rank, m.rank, `rank parity for ${c.name}`);
        assert.equal(s.total, m.total, `total parity for ${c.name}`);
        assert.ok(Math.abs(s.score - m.score) < 1e-9, `score parity for ${c.name}`);
    }
    const order = (db) => db.topCentral(50).map(t => `${t.chunk.id}#${t.rank}`);
    assert.deepEqual(order(sq), order(mem), 'topCentral order parity');

    sq.close?.();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
});

test('centrality (A5): an incremental update invalidates it (daemon staleness guard)', () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const { db } = loadMem(perFile, { withEdges: true });
    assert.ok(db.hasCentrality(), 'centrality present before update');
    const fmtId = db.resolveSymbol('format')[0].id;
    db.applyFileUpdate('helpers.ts', { chunks: perFile['helpers.ts'], imports: [] });
    if (db._saveTimer) { clearTimeout(db._saveTimer); db._saveTimer = null; }
    assert.equal(db.hasCentrality(), false, 'centrality cleared after an incremental update');
    assert.equal(db.getCentrality(fmtId), null, 'getCentrality null once invalidated');
    assert.deepEqual(db.topCentral(5), [], 'topCentral empty once invalidated');
});

test('centrality (A5): absent on the default path (no symbol graph → gated off)', () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const { db: scan } = loadMem(perFile, { withEdges: false });
    assert.equal(scan.hasCentrality(), false, 'no centrality without --symbol-graph');
    assert.equal(scan.getCentrality(scan.resolveSymbol('format')[0].id), null);
    assert.deepEqual(scan.topCentral(5), []);
});

test('centrality (A5): explain_symbol + get_repo_map surface it (and omit it when off)', async () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const opts = { projectRoot: os.tmpdir(), artifactPath: '/nonexistent', pidFile: null, embeddingsEnabled: false, embedder: null };
    const wire = (db) => { const h = new Map(); registerTools({ tool: (n, _d, _s, fn) => h.set(n, fn) }, db, opts); return h; };

    // With the graph: explain_symbol attaches centrality; get_repo_map lists central symbols.
    const on = wire(loadMem(perFile, { withEdges: true }).db);
    const es = await on.get('explain_symbol')({ symbol: 'format', response_format: 'json' });
    const def = es.structuredContent.definitions[0];
    assert.ok(def.centrality && def.centrality.rank >= 1 && def.centrality.total >= 1, 'explain_symbol json carries centrality');
    const esMd = await on.get('explain_symbol')({ symbol: 'format', response_format: 'markdown' });
    assert.match(esMd.content[0].text, /centrality #\d+\/\d+/, 'explain_symbol markdown shows the centrality tag');
    const rm = await on.get('get_repo_map')({ response_format: 'json' });
    assert.ok(Array.isArray(rm.structuredContent.central_symbols) && rm.structuredContent.central_symbols.length > 0, 'central_symbols present');
    assert.equal(rm.structuredContent.central_symbols[0].rank, 1, 'central_symbols rank-ascending');
    assert.match((await on.get('get_repo_map')({ response_format: 'markdown' })).content[0].text, /Most central symbols/);

    // Without the graph: both tools omit centrality entirely (default path unchanged).
    const off = wire(loadMem(perFile, { withEdges: false }).db);
    assert.equal((await off.get('explain_symbol')({ symbol: 'format', response_format: 'json' })).structuredContent.definitions[0].centrality, undefined);
    assert.equal((await off.get('get_repo_map')({ response_format: 'json' })).structuredContent.central_symbols, undefined);
    assert.ok(!/Most central symbols/.test((await off.get('get_repo_map')({ response_format: 'markdown' })).content[0].text), 'no central block without the graph');
});
