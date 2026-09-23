/**
 * The resident process: hooks and CLI queries answered by a long-lived graph-indexer over a local
 * socket, with the same output as when they open the index themselves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { socketPath, askResident, startResident } from '../src/cli/resident.mjs';
import * as pluginClient from '../integrations/claude-code/hooks/gi-hook.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'graph-indexer.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(BIN), '..', 'package.json'), 'utf8')).version;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('resident socket: requests, other versions, a second resident, a stale socket and the idle stop', async () => {
    const root = makeRepo({ 'a.js': 'export const a = 1;\n' }, { git: false });
    try {
        const file = socketPath(root);
        if (process.platform !== 'win32') { // what a killed resident leaves behind
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '');
        }
        let idle = false;
        const handle = async (req) => `${req.op}: ${JSON.stringify(req.calls ?? req.input)}`;
        const res = await startResident({ root, version: 'v1', handle, idleMs: 300, onIdle: () => { idle = true; } });
        assert.ok(res, 'listens despite the stale socket file');
        assert.equal((await askResident(root, { op: 'ping' }, { version: 'v1' })).pid, process.pid);
        assert.equal((await askResident(root, { op: 'tool', calls: [['read_code', { targets: ['a'] }]] }, { version: 'v1' })).out, 'tool: [["read_code",{"targets":["a"]}]]');
        assert.equal(await askResident(root, { op: 'ping' }, { version: 'v2' }), null, 'another version falls back');
        assert.equal(await startResident({ root, version: 'v1', handle }), null, 'a second resident steps aside');
        await sleep(1000);
        assert.ok(idle, 'stops after the idle time');
        assert.equal(await askResident(root, { op: 'ping' }, { version: 'v1' }), null);
        if (process.platform !== 'win32') assert.ok(!fs.existsSync(file), 'removes its socket');
    } finally { rmrf(root); }
});

test('daemon: hooks and CLI queries through the resident give the same output as without it', async () => {
    const root = makeRepo({
        'src/cart.ts': `export class Cart {\n  total(items: number[], tax: number) { return items.length * tax; }\n}\nexport class Wishlist {\n  total() { return 0; }\n}\n`,
        'src/checkout.ts': `import { Cart } from './cart';\nexport function checkout(c: Cart) {\n  return c.total([1, 2], 0.2);\n}\n`,
    });
    const LOCAL = { ...process.env, GRAPH_INDEXER_RESIDENT: '0' };
    const VIA = { ...process.env, GRAPH_INDEXER_RESIDENT: 'require' }; // no fallback: only the resident answers
    const cli = (args, env) => spawnSync(process.execPath, [BIN, ...args, '--repo', root], { encoding: 'utf8', env });
    const hook = (payload, env) => spawnSync(process.execPath, [BIN, 'hook', 'post-tool'], { input: JSON.stringify({ cwd: root, hook_event_name: 'PostToolUse', ...payload }), encoding: 'utf8', env }).stdout;
    const sid = (s) => `resident-${s}-${process.pid}-${Date.now()}`; // hook state is per session and outlives the test
    const rescue = { session_id: sid('r'), tool_name: 'Grep', tool_input: { pattern: 'class Wishlist' }, tool_response: { content: '' } };
    const reads = (sid, env) => [1, 1, 1].map(() => hook({ session_id: sid, tool_name: 'Read', tool_input: { file_path: path.join(root, 'src/checkout.ts') } }, env));
    let daemon = null;
    try {
        cli(['index'], LOCAL);
        const local = { symbol: cli(['symbol', 'Cart.total'], LOCAL).stdout, rescue: hook(rescue, LOCAL), reads: reads(sid('a'), LOCAL) };
        assert.match(local.rescue, /Wishlist → src\/cart\.ts:4/);
        assert.match(local.reads[2], /Cart\.total → src\/cart\.ts:2/);
        assert.equal(cli(['symbol', 'Cart.total'], VIA).status, 3, 'nothing answers before the daemon starts');

        daemon = spawn(process.execPath, [BIN, 'daemon', '--repo', root], { stdio: 'ignore' });
        for (let i = 0; i < 100 && !(await askResident(root, { op: 'ping' }, { version: VERSION })); i++) await sleep(100);
        const via = { symbol: cli(['symbol', 'Cart.total'], VIA).stdout, rescue: hook(rescue, VIA), reads: reads(sid('b'), VIA) };
        assert.deepEqual(via, local);
    } finally {
        if (daemon) {
            const gone = new Promise(r => daemon.once('exit', r));
            daemon.kill('SIGTERM');
            await gone;
            if (process.platform !== 'win32') assert.ok(!fs.existsSync(socketPath(root)), 'the daemon removes its socket');
        }
        rmrf(root);
    }
});

test("the Claude Code plugin's hook client finds the same socket and relays through any resident version", async () => {
    const root = makeRepo({ 'a.js': 'export const a = 1;\n' });
    const long = path.join(root, 'x'.repeat(90));
    fs.mkdirSync(path.join(long, '.git'), { recursive: true });
    try {
        for (const r of [root, long]) assert.equal(pluginClient.socketPath(r), socketPath(r));
        const handle = async (req) => (req.op === 'hook' ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `seen ${req.event} ${req.input.tool_name}` } }) : null);
        const res = await startResident({ root, version: 'some-other-version', handle });
        const client = path.join(path.dirname(BIN), '..', 'integrations', 'claude-code', 'hooks', 'gi-hook.mjs');
        const out = await new Promise((resolve) => {
            const c = spawn(process.execPath, [client, 'post-tool'], { stdio: ['pipe', 'pipe', 'ignore'] });
            let text = '';
            c.stdout.on('data', (d) => { text += d; });
            c.on('close', () => resolve(text));
            c.stdin.end(JSON.stringify({ cwd: path.join(root), tool_name: 'Read' }));
        });
        res.close();
        assert.equal(JSON.parse(out).hookSpecificOutput.additionalContext, 'seen post-tool Read');
    } finally { rmrf(root); }
});

test('OpenCode/Kilo Code plugin: maps tool calls to the hook and appends the resident answer to the output', async () => {
    const root = makeRepo({ 'a.ts': 'export const a = 1;\n' });
    try {
        const { GraphIndexer } = await import('../integrations/opencode/graph-indexer.js');
        const { hookPayload } = GraphIndexer;
        assert.deepEqual(hookPayload({ tool: 'read', sessionID: 's1', args: { filePath: '/x/a.ts', offset: 10, limit: 20 } }, { output: 'code' }, root).tool_input, { file_path: '/x/a.ts', offset: 10, limit: 20 });
        assert.equal(hookPayload({ tool: 'grep', args: { pattern: 'class Foo' } }, { output: 'No files found' }, root).tool_response, '', 'an empty search');
        assert.equal(hookPayload({ tool: 'bash', args: { command: 'grep -rn "def x" .' } }, { output: '' }, root).tool_name, 'Bash');
        assert.equal(hookPayload({ tool: 'glob', args: {} }, { output: '' }, root), null);
        const seen = [];
        const context = 'graph-indexer: where names used in these lines are defined (read them directly instead of searching):\n  A → a.ts:1';
        const handle = async (req) => { seen.push(req); return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }); };
        const res = await startResident({ root, version: 'resident-version', handle });
        delete globalThis.__graphIndexerPlugin;
        const hooks = await GraphIndexer({ directory: root, worktree: root });
        const output = { title: 'a.ts', output: '1: export const a = 1;', metadata: {} };
        await hooks['tool.execute.after']({ tool: 'read', sessionID: 's1', callID: 'c1', args: { filePath: path.join(root, 'a.ts') } }, output);
        res.close();
        assert.equal(output.output, `1: export const a = 1;\n\n${context}`);
        assert.equal(seen[0].input.tool_name, 'Read');
        assert.equal(seen[0].input.session_id, 'opencode-s1');
        assert.deepEqual(await GraphIndexer({ directory: root }), {}, 'registers once when loaded from two directories');
    } finally { delete globalThis.__graphIndexerPlugin; rmrf(root); }
});
