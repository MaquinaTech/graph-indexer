/**
 * @file test/taint.mjs
 * @description Tests taint analysis (C2): the source/sink/sanitizer scan, intra-procedural
 *              (direct) and inter-procedural (reachable) flow construction over the call graph,
 *              category filtering, sanitizer down-weighting, determinism, and the two MCP tools
 *              (trace_taint / find_tainted_sinks). Parser-independent — chunks are fabricated and
 *              served by a minimal fake store, so it runs without tree-sitter grammars.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'node:path';
import fs from 'node:fs';
import { scanChunk, buildTaintGraph, traceTaint, findTaintedSinks, computeTaintCache } from '../mcp/taint.mjs';
import { langKeyForExt } from '../parse/taint-patterns.mjs';
import { registerTools } from '../mcp/tools.mjs';
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { SqliteGraphStore } from '../engine/sqlite.mjs';

const tmp = (ext) => path.join(os.tmpdir(), `taint-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`);
const rm = (p) => { for (const s of ['', '-wal', '-shm']) fs.rmSync(`${p}${s}`, { force: true }); };

const C = (id, name, file, startLine, code, calls = []) => ({
    id, name, file_path: file, start_line: startLine,
    end_line: startLine + code.split('\n').length, code_snippet: code, calls,
});

// c1: direct rce (req.body → eval, same fn).  c2: same but sanitized (Number()).  c3→c4: reachable
// sqli (handleLogin reads req.body, calls query() which concatenates SQL).  c5: clean.  c6: a
// genuinely UNSUPPORTED language (Ruby) → scans to null.
const CHUNKS = [
    C('c1', 'runUserCode', 'handler.js', 1, 'function runUserCode(req){\n const code = req.body.code;\n return eval(code);\n}'),
    C('c2', 'safeRun', 'safe.js', 1, 'function safeRun(req){\n const n = Number(req.query.n);\n return eval(String(n));\n}'),
    C('c3', 'handleLogin', 'service.js', 1, 'function handleLogin(req){\n const u = req.body.user;\n return query(u);\n}', ['query']),
    C('c4', 'query', 'service.js', 20, 'function query(u){\n return db.query("SELECT * FROM users WHERE u="+u);\n}'),
    C('c5', 'helper', 'util.js', 1, 'function helper(x){ return x+1; }'),
    C('c6', 'ruby_thing', 'main.rb', 1, 'def ruby_thing\n system(params[:cmd])\nend'),
];

// Java + Go fixtures (direct rce: an untrusted source and a dangerous sink in one function).
const JAVA = C('j1', 'handle', 'Ctl.java', 1,
    'void handle(HttpServletRequest request){\n String cmd = request.getParameter("c");\n Runtime.getRuntime().exec(cmd);\n}');
const JAVA_SAFE = C('j2', 'safe', 'S.java', 1,
    'void safe(HttpServletRequest request){\n int n = Integer.parseInt(request.getParameter("n"));\n Runtime.getRuntime().exec("id "+n);\n}');
const GO = C('g1', 'Handler', 'h.go', 1,
    'func Handler(w http.ResponseWriter, r *http.Request){\n q := r.URL.Query().Get("q")\n exec.Command(q)\n}');

function fakeDb(chunks = CHUNKS) {
    const byId = new Map(chunks.map(c => [c.id, c]));
    const byName = new Map();
    for (const c of chunks) { if (!byName.has(c.name)) byName.set(c.name, []); byName.get(c.name).push(c); }
    return {
        iterateChunks: () => chunks,
        getChunk: (id) => byId.get(id) || null,
        resolveSymbol: (name) => byName.get(name) || [],
        hasSymbolGraph: () => false,
    };
}

test('taint: langKeyForExt maps the supported families', () => {
    for (const e of ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']) assert.equal(langKeyForExt(e), 'js');
    assert.equal(langKeyForExt('.py'), 'py');
    assert.equal(langKeyForExt('.java'), 'java');
    assert.equal(langKeyForExt('.go'), 'go');
    assert.equal(langKeyForExt('.rb'), null, 'unsupported language → null');
});

test('taint: Java sources / sinks / sanitizers + a direct rce flow', () => {
    const s = scanChunk(JAVA);
    assert.equal(s.lang, 'java');
    assert.equal(s.sources[0].kind, 'http-request', 'request.getParameter is a source');
    assert.equal(s.sinks[0].category, 'rce', 'Runtime.exec is an rce sink');
    assert.equal(s.sanitized, false);
    assert.equal(scanChunk(JAVA_SAFE).sanitized, true, 'Integer.parseInt is a sanitizer');
    const { flows } = buildTaintGraph(fakeDb([JAVA]));
    assert.ok(flows.some(f => f.sink.category === 'rce' && f.confidence === 'high'), 'direct java rce flow');
    assert.equal(buildTaintGraph(fakeDb([JAVA_SAFE])).flows[0].confidence, 'low', 'sanitized java flow is low');
});

test('taint: Go sources / sinks + a direct rce flow', () => {
    const s = scanChunk(GO);
    assert.equal(s.lang, 'go');
    assert.equal(s.sources[0].kind, 'http-request', 'r.URL.Query().Get is a source');
    assert.equal(s.sinks[0].category, 'rce', 'exec.Command is an rce sink');
    const { flows } = buildTaintGraph(fakeDb([GO]));
    assert.ok(flows.some(f => f.sink.category === 'rce' && f.confidence === 'high'), 'direct go rce flow');
});

test('taint: Go SQLi lookbehind excludes only x.URL.Query(), not real db handles', () => {
    const onlyUrl = scanChunk(C('gu', 'f', 'u.go', 1, 'func f(r *http.Request){ q := r.URL.Query() }'));
    assert.ok(!onlyUrl.sinks.some(s => s.category === 'sqli'), 'r.URL.Query() is NOT a db sink');
    // a db handle whose name ends in URL must still be detected (no over-exclusion)
    const dbUrl = scanChunk(C('gd', 'g', 'd.go', 1, 'func g(){ dbURL.Query("SELECT 1") }'));
    assert.ok(dbUrl.sinks.some(s => s.category === 'sqli'), 'dbURL.Query() IS a db sink');
    const plain = scanChunk(C('gp', 'h', 'p.go', 1, 'func h(){ db.Exec("DELETE") ; conn.QueryRow("x") }'));
    assert.equal(plain.sinks.filter(s => s.category === 'sqli').length, 2, 'Exec + QueryRow both detected');
});

test('taint: scanChunk detects sources, sinks, and sanitizers', () => {
    const s1 = scanChunk(CHUNKS[0]);
    assert.equal(s1.sources[0].kind, 'http-request');
    assert.equal(s1.sinks[0].category, 'rce');
    assert.equal(s1.sanitized, false);
    const s2 = scanChunk(CHUNKS[1]);
    assert.equal(s2.sanitized, true, 'Number() is a sanitizer');
    const s4 = scanChunk(CHUNKS[3]);
    assert.equal(s4.sinks[0].category, 'sqli');
    assert.equal(scanChunk(CHUNKS[5]), null, 'unsupported language → null');
    assert.equal(scanChunk(CHUNKS[4]).sources.length + scanChunk(CHUNKS[4]).sinks.length, 0, 'clean chunk has neither');
});

test('taint: buildTaintGraph finds the direct rce flow (high) and the reachable sqli flow (medium)', () => {
    const { flows } = buildTaintGraph(fakeDb());
    const direct = flows.find(f => f.source.chunk_id === 'c1' && f.sink.chunk_id === 'c1');
    assert.ok(direct, 'direct flow present');
    assert.equal(direct.sink.category, 'rce');
    assert.equal(direct.via, 'direct');
    assert.equal(direct.confidence, 'high');

    const reach = flows.find(f => f.source.chunk_id === 'c3' && f.sink.chunk_id === 'c4');
    assert.ok(reach, 'reachable flow present');
    assert.equal(reach.sink.category, 'sqli');
    assert.equal(reach.via, 'reachable');
    assert.equal(reach.depth, 1);
    assert.equal(reach.confidence, 'medium');
});

test('taint: a sanitizer on the flow lowers confidence', () => {
    const { flows } = buildTaintGraph(fakeDb());
    const safe = flows.find(f => f.source.chunk_id === 'c2');
    assert.ok(safe && safe.sanitized === true && safe.confidence === 'low', 'sanitized direct flow is low confidence');
});

test('taint: category filter restricts to one sink category', () => {
    const { flows } = buildTaintGraph(fakeDb(), { category: 'sqli' });
    assert.ok(flows.length > 0 && flows.every(f => f.sink.category === 'sqli'));
});

test('taint: deterministic output', () => {
    const a = buildTaintGraph(fakeDb()).flows.map(f => `${f.source.chunk_id}->${f.sink.chunk_id}:${f.sink.category}`);
    const b = buildTaintGraph(fakeDb()).flows.map(f => `${f.source.chunk_id}->${f.sink.chunk_id}:${f.sink.category}`);
    assert.deepEqual(a, b);
    // rce (more severe) sorts before sqli.
    assert.ok(a.indexOf('c1->c1:rce') < a.indexOf('c3->c4:sqli'), 'severity-ordered');
});

test('taint: traceTaint filters by source kind', () => {
    const all = traceTaint(fakeDb(), {});
    assert.ok(all.flows.length >= 3);
    const http = traceTaint(fakeDb(), { sourceKind: 'http-request' });
    assert.ok(http.flows.every(f => f.source.kind === 'http-request'));
});

test('taint: findTaintedSinks groups by category and flags reachability', () => {
    const { byCategory } = findTaintedSinks(fakeDb());
    assert.ok(byCategory.rce && byCategory.rce.length >= 2, 'eval sinks grouped under rce');
    const sqli = byCategory.sqli.find(s => s.chunk_id === 'c4');
    assert.equal(sqli.reached_by_source, true, 'the SQL sink is reachable from req.body');
    const onlyReached = findTaintedSinks(fakeDb(), { reachableOnly: true });
    assert.ok(Object.values(onlyReached.byCategory).flat().every(s => s.reached_by_source));
});

test('taint (C2 serialize): computeTaintCache == live, and the fast path filters by category/depth', () => {
    const live = buildTaintGraph(fakeDb(), { maxFlows: Infinity }).flows;
    const cache = computeTaintCache(fakeDb(), { maxDepth: 4 });
    assert.deepEqual(cache.flows, live, 'cache is the full live flow set');
    assert.equal(cache.meta.maxDepth, 4);

    // A store that serves from the cache (hasTaint) returns the same flows, filtered in-envelope.
    const cachedDb = { ...fakeDb(), hasTaint: () => true, getTaintFlows: () => cache };
    const served = buildTaintGraph(cachedDb);
    assert.ok(served.cached, 'served from cache');
    assert.deepEqual(served.flows, live, 'cached path == live for the default query');
    assert.ok(buildTaintGraph(cachedDb, { category: 'sqli' }).flows.every(f => f.sink.category === 'sqli'));
    assert.ok(buildTaintGraph(cachedDb, { maxDepth: 0 }).flows.every(f => f.depth === 0), 'depth filter applied');
    // includeReachable:false (out of envelope) → recompute, NOT the cache.
    assert.ok(!buildTaintGraph(cachedDb, { includeReachable: false }).cached, 'direct-only recomputes');
});

test('taint (C2 serialize): memory ↔ sqlite serve byte-identical flows (parity)', () => {
    const cache = computeTaintCache(fakeDb(), { maxDepth: 4 });
    const graph = { dependencies: {}, importedBy: {} };

    const memPath = tmp('.json');
    fs.writeFileSync(memPath, JSON.stringify({ chunks: CHUNKS, graph, taint: cache }));
    const mem = new MemoryGraphIndex(memPath); mem.load();

    const dbPath = tmp('.db');
    new SqliteGraphStore(dbPath).buildFrom({ chunks: CHUNKS, graph, embeddingCache: new Map(), taint: cache });
    const sq = new SqliteGraphStore(dbPath); sq.load();

    assert.ok(mem.hasTaint() && sq.hasTaint(), 'both backends report taint present');
    assert.deepEqual(sq.getTaintFlows(), mem.getTaintFlows(), 'getTaintFlows byte-identical across backends');
    // Both serve the tools from their cache → identical flows.
    const memFlows = buildTaintGraph(mem).flows.map(f => `${f.source.chunk_id}->${f.sink.chunk_id}:${f.sink.category}`);
    const sqFlows = buildTaintGraph(sq).flows.map(f => `${f.source.chunk_id}->${f.sink.chunk_id}:${f.sink.category}`);
    assert.deepEqual(sqFlows, memFlows, 'tool flows identical across backends');
    assert.deepEqual(memFlows, cache.flows.map(f => `${f.source.chunk_id}->${f.sink.chunk_id}:${f.sink.category}`));

    sq.close?.();
    rm(dbPath); rm(memPath);
});

test('taint (C2 serialize): an incremental file update clears the serialized cache', () => {
    const cache = computeTaintCache(fakeDb(), { maxDepth: 4 });
    const memPath = tmp('.json');
    fs.writeFileSync(memPath, JSON.stringify({ chunks: CHUNKS, graph: { dependencies: {}, importedBy: {} }, taint: cache }));
    const mem = new MemoryGraphIndex(memPath); mem.load();
    assert.ok(mem.hasTaint(), 'cache present after load');
    mem.applyFileUpdate('handler.js', { chunks: [CHUNKS[0]], imports: [] });
    if (mem._saveTimer) { clearTimeout(mem._saveTimer); mem._saveTimer = null; }
    assert.equal(mem.hasTaint(), false, 'an incremental update invalidates + clears the cache');
    rm(memPath);
});

test('taint: trace_taint + find_tainted_sinks MCP tools', async () => {
    const db = fakeDb();
    const handlers = new Map();
    registerTools({ tool: (n, _d, _s, fn) => handlers.set(n, fn) }, db, {
        projectRoot: os.tmpdir(), artifactPath: '/nonexistent', pidFile: null, embeddingsEnabled: false, embedder: null,
    });
    assert.ok(handlers.has('trace_taint') && handlers.has('find_tainted_sinks'), 'tools registered');

    const tt = await handlers.get('trace_taint')({ response_format: 'json' });
    assert.ok(tt.structuredContent.flow_count >= 3);
    assert.ok(tt.structuredContent.flows.some(f => f.sink.category === 'rce' && f.confidence === 'high'));
    assert.deepEqual(JSON.parse(tt.content[0].text), tt.structuredContent, 'json text matches structuredContent');

    const ttRce = await handlers.get('trace_taint')({ category: 'rce', response_format: 'json' });
    assert.ok(ttRce.structuredContent.flows.every(f => f.sink.category === 'rce'));

    const fs = await handlers.get('find_tainted_sinks')({ response_format: 'json' });
    assert.ok(fs.structuredContent.sink_count >= 3);
    assert.ok(fs.structuredContent.sinks_by_category.sqli.some(s => s.reached_by_source));

    const md = await handlers.get('find_tainted_sinks')({ response_format: 'markdown' });
    assert.match(md.content[0].text, /RCE|SQLI/, 'markdown groups by category');
});
