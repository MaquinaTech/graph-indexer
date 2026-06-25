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
import { scanChunk, buildTaintGraph, traceTaint, findTaintedSinks } from '../mcp/taint.mjs';
import { langKeyForExt } from '../parse/taint-patterns.mjs';
import { registerTools } from '../mcp/tools.mjs';

const C = (id, name, file, startLine, code, calls = []) => ({
    id, name, file_path: file, start_line: startLine,
    end_line: startLine + code.split('\n').length, code_snippet: code, calls,
});

// c1: direct rce (req.body → eval, same fn).  c2: same but sanitized (Number()).  c3→c4: reachable
// sqli (handleLogin reads req.body, calls query() which concatenates SQL).  c5: clean.  c6: non-JS.
const CHUNKS = [
    C('c1', 'runUserCode', 'handler.js', 1, 'function runUserCode(req){\n const code = req.body.code;\n return eval(code);\n}'),
    C('c2', 'safeRun', 'safe.js', 1, 'function safeRun(req){\n const n = Number(req.query.n);\n return eval(String(n));\n}'),
    C('c3', 'handleLogin', 'service.js', 1, 'function handleLogin(req){\n const u = req.body.user;\n return query(u);\n}', ['query']),
    C('c4', 'query', 'service.js', 20, 'function query(u){\n return db.query("SELECT * FROM users WHERE u="+u);\n}'),
    C('c5', 'helper', 'util.js', 1, 'function helper(x){ return x+1; }'),
    C('c6', 'GoThing', 'main.go', 1, 'func GoThing(r *http.Request){ exec.Command(r.URL.Query()) }'),
];

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
    assert.equal(langKeyForExt('.go'), null);
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
