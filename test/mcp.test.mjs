import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, rmrf } from './helpers.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'graph-indexer.mjs');

function startServer(root) {
    const child = spawn(process.execPath, [BIN, 'serve', '--repo', root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const pending = new Map();
    const stray = [];
    child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            const msg = JSON.parse(line); // every stdout line must be valid JSON-RPC
            if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else stray.push(msg);
        }
    });
    let id = 0;
    const request = (method, params) => new Promise((resolve) => {
        const rid = ++id;
        pending.set(rid, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
    });
    const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    return { child, request, notify, stray, close: () => child.stdin.end() };
}

const REPO = {
    'lib/math.js': `/** Adds two numbers. */\nfunction add(a, b) { return a + b; }\nfunction twice(x) { return add(x, x); }\nmodule.exports = { add, twice };\n`,
    'lib/app.js': `const { twice } = require('./math');\nfunction main() { return twice(21); }\nmain();\n`,
};

let root, srv;
test.before(() => { root = makeRepo(REPO); srv = startServer(root); });
test.after(() => { srv.close(); srv.child.kill(); rmrf(root); });

test('handshake negotiates a supported version and carries instructions', async () => {
    const r = await srv.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(r.result.protocolVersion, '2025-06-18');
    assert.ok(r.result.capabilities.tools);
    assert.ok(r.result.instructions.length > 100 && r.result.instructions.length <= 2048);
    srv.notify('notifications/initialized');
    const unknownVersion = await srv.request('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
    assert.equal(unknownVersion.result.protocolVersion, '2025-11-25');
});

test('tools/list exposes six read-only tools with short descriptions', async () => {
    const r = await srv.request('tools/list', {});
    const names = r.result.tools.map(t => t.name);
    assert.deepEqual(names, ['search_code', 'get_symbol', 'find_references', 'call_graph', 'change_impact', 'outline']);
    for (const t of r.result.tools) {
        assert.equal(t.annotations.readOnlyHint, true);
        assert.ok(t.description.length <= 2048, t.name);
        assert.equal(t.inputSchema.type, 'object');
    }
});

test('stateless 2026-07-28 discovery and per-request version checks', async () => {
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
    const d = await srv.request('server/discover', { _meta: meta });
    assert.ok(d.result.supportedVersions.includes('2026-07-28'));
    assert.ok(d.result.instructions);
    assert.equal(typeof d.result.ttlMs, 'number');
    const l = await srv.request('tools/list', { _meta: meta });
    assert.equal(l.result.cacheScope, 'private');
    const bad = await srv.request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2030-01-01' } });
    assert.equal(bad.error.code, -32022);
    assert.deepEqual(bad.error.data.requested, '2030-01-01');
});

test('tools/call returns text results and reports errors in-band', async () => {
    const refs = await srv.request('tools/call', { name: 'find_references', arguments: { symbol: 'add' } });
    const text = refs.result.content[0].text;
    assert.match(text, /References to add \(function\) lib\/math\.js:2/);
    assert.match(text, /lib\/math\.js[\s\S]*3\s+call\s+in twice/);
    const cg = await srv.request('tools/call', { name: 'call_graph', arguments: { symbol: 'twice', direction: 'callers' } });
    assert.match(cg.result.content[0].text, /← main {2}lib\/app\.js:2/);
    const missing = await srv.request('tools/call', { name: 'get_symbol', arguments: {} });
    assert.equal(missing.result.isError, true);
    const unknown = await srv.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.error.code, -32602);
    const nf = await srv.request('tools/call', { name: 'get_symbol', arguments: { symbol: 'doesNotExist' } });
    assert.match(nf.result.content[0].text, /No symbol named "doesNotExist"/);
});

test('unknown methods yield JSON-RPC errors and nothing else is written to stdout', async () => {
    const r = await srv.request('does/not/exist', {});
    assert.equal(r.error.code, -32601);
    const p = await srv.request('ping', {});
    assert.deepEqual(p.result, {});
    assert.deepEqual(srv.stray, []);
});
