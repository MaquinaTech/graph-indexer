import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, rmrf } from './helpers.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'graph-indexer.mjs');

function startServer(root, flags = []) {
    const child = spawn(process.execPath, [BIN, 'serve', '--repo', root, ...flags], { stdio: ['pipe', 'pipe', 'pipe'] });
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

test('tools/list exposes the read-only tools and the one that edits, with short descriptions', async () => {
    const r = await srv.request('tools/list', {});
    const names = r.result.tools.map(t => t.name);
    assert.deepEqual(names, ['explore', 'search_code', 'search_text', 'read_code', 'find_references', 'call_graph', 'change_impact', 'check_changes', 'outline', 'rename_symbol']);
    // loaded up front by clients that defer MCP tools: the call that opens a task, and exact uses
    assert.deepEqual(r.result.tools.filter(t => t._meta?.['anthropic/alwaysLoad']).map(t => t.name), ['explore', 'find_references']);
    for (const t of r.result.tools) {
        // a client asks before it runs a tool that is not read-only: only the rename is declared so
        assert.equal(t.annotations.readOnlyHint, t.name !== 'rename_symbol', t.name);
        assert.equal(t.annotations.destructiveHint, t.name === 'rename_symbol', t.name);
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
    // results of that version say they are complete; Claude Code ignores tools listed without it
    assert.equal(d.result.resultType, 'complete');
    assert.equal(l.result.resultType, 'complete');
    const c = await srv.request('tools/call', { _meta: meta, name: 'find_references', arguments: { symbol: 'add' } });
    assert.equal(c.result.resultType, 'complete');
    // the handshake generation is unchanged
    const h = await srv.request('tools/list', {});
    assert.equal(h.result.resultType, undefined);
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
    // read_code: a definition and a range in one call, each with where the names it uses are defined
    const rd = await srv.request('tools/call', { name: 'read_code', arguments: { targets: ['twice', 'lib/app.js:2-2'] } });
    const rt = rd.result.content[0].text;
    assert.match(rt, /twice — function/);
    assert.match(rt, /Defined elsewhere \(used above\):\n {2}add {2}lib\/math\.js:2 {2}function add\(a, b\) — Adds two numbers\./);
    assert.match(rt, /lib\/app\.js:2-2 — in main/);
    assert.doesNotMatch(rt.slice(rt.indexOf('lib/app.js:2-2')), /Defined elsewhere/, 'twice was read above in the same answer');
    const range = await srv.request('tools/call', { name: 'read_code', arguments: { targets: ['lib/app.js:2-2'] } });
    assert.match(range.result.content[0].text, /twice {2}lib\/math\.js:3 {2}function twice\(x\)/);
});

test('unknown methods yield JSON-RPC errors and nothing else is written to stdout', async () => {
    const r = await srv.request('does/not/exist', {});
    assert.equal(r.error.code, -32601);
    const p = await srv.request('ping', {});
    assert.deepEqual(p.result, {});
    assert.deepEqual(srv.stray, []);
});

const RENAME_REPO = {
    'src/cart.ts': `export class Cart {\n  total(): number { return 0; }\n}\n`,
    'src/checkout.ts': `import { Cart } from './cart';\nexport function checkout(c: Cart) { return c.total(); }\n`,
    'src/other.ts': `export class Invoice {\n  total(): number { return 1; }\n}\nexport class Bill {}\nexport const due = (i: Invoice) => i.total();\n`,
};
const text = (r) => r.result.content[0].text;

test('rename_symbol lists the edits, and writes them only when asked to apply', async () => {
    const dir = makeRepo(RENAME_REPO);
    const s = startServer(dir);
    const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
    try {
        await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
        const listed = text(await s.request('tools/call', { name: 'rename_symbol', arguments: { symbol: 'Cart.total', new_name: 'sum' } }));
        assert.match(listed, /Rename Cart\.total → sum: 2 edits in 2 files, not written \(call rename_symbol again with apply: true to write them\)/, listed);
        assert.equal(read('src/cart.ts'), RENAME_REPO['src/cart.ts']);
        assert.equal(read('src/checkout.ts'), RENAME_REPO['src/checkout.ts']);
        // only the boolean asks for the edits to be written: the string a careless client sends does not
        for (const apply of ['false', 'true', 1]) {
            const unsure = text(await s.request('tools/call', { name: 'rename_symbol', arguments: { symbol: 'Cart.total', new_name: 'sum', apply } }));
            assert.match(unsure, /not written/, unsure);
            assert.equal(read('src/cart.ts'), RENAME_REPO['src/cart.ts']);
        }
        const done = text(await s.request('tools/call', { name: 'rename_symbol', arguments: { symbol: 'Cart.total', new_name: 'sum', apply: true } }));
        assert.match(done, /Renamed Cart\.total → sum: 2 edits written in 2 files\./, done);
        assert.match(read('src/cart.ts'), /sum\(\): number/);
        assert.match(read('src/checkout.ts'), /return c\.sum\(\);/);
        // the method of the same name on another class is not this one
        assert.equal(read('src/other.ts'), RENAME_REPO['src/other.ts']);
        // the next answer comes from the index of the files as written
        const refs = text(await s.request('tools/call', { name: 'find_references', arguments: { symbol: 'Cart.sum' } }));
        assert.match(refs, /src\/checkout\.ts[\s\S]*2\s+call\s+in checkout/, refs);
        // a name that is taken is refused, and nothing is written
        const taken = text(await s.request('tools/call', { name: 'rename_symbol', arguments: { symbol: 'Invoice', new_name: 'Bill', apply: true } }));
        assert.match(taken, /Not renamed: Bill is already taken/, taken);
        assert.equal(read('src/other.ts'), RENAME_REPO['src/other.ts']);
        const missing = await s.request('tools/call', { name: 'rename_symbol', arguments: { symbol: 'Cart.sum' } });
        assert.equal(missing.result.isError, true);
        assert.deepEqual(s.stray, []);
    } finally { s.close(); s.child.kill(); rmrf(dir); }
});

test('a server started read-only lists the edits of a rename and writes none', async () => {
    const dir = makeRepo(RENAME_REPO);
    const s = startServer(dir, ['--read-only']);
    try {
        await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
        const tool = (await s.request('tools/list', {})).result.tools.find(t => t.name === 'rename_symbol');
        assert.equal(tool.annotations.readOnlyHint, true);
        assert.equal(tool.annotations.destructiveHint, false);
        assert.deepEqual(Object.keys(tool.inputSchema.properties), ['symbol', 'new_name', 'min_confidence']);
        assert.match(tool.description, /without writing them \(this server is read-only\)/);
        const out = text(await s.request('tools/call', { name: 'rename_symbol', arguments: { symbol: 'Cart.total', new_name: 'sum', apply: true } }));
        assert.match(out, /2 edits in 2 files, not written \(this server is read-only, so nothing was written\)/, out);
        for (const [rel, src] of Object.entries(RENAME_REPO)) assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), src);
    } finally { s.close(); s.child.kill(); rmrf(dir); }
});
