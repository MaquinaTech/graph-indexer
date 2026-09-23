/**
 * The agent's working loop: structural grep, the edit checker, the hooks that run them inside the
 * agent, and `init --hooks`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { grepPattern } from '../src/cli/hook.mjs';
import { makeRepo, writeFile, rmrf } from './helpers.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'graph-indexer.mjs');
// hooks answered in-process, without starting a resident process (test/resident.test.mjs covers that)
const LOCAL = { ...process.env, GRAPH_INDEXER_RESIDENT: '0' };

const FILES = {
    'package.json': '{"name":"shop","devDependencies":{"vitest":"1.0.0"}}\n',
    'src/cart.ts': `export class Cart {\n  total(items: number[], tax: number) { return items.length * tax; }\n  sum(a: number) { return a; }\n}\nexport class Wishlist {\n  total() { return 0; }\n}\n`,
    'src/checkout.ts': `import { Cart } from './cart';\nexport function checkout(c: Cart) {\n  return c.total([1, 2], 0.2);\n}\n// Cart.total is also mentioned in this comment\nexport function report(c: Cart) {\n  return c.sum(1);\n}\n`,
    'src/wish.ts': `import { Wishlist } from './cart';\nexport function wished(w: Wishlist) {\n  return w.total();\n}\n`,
    'src/cart.test.ts': `import { Cart } from './cart';\ndescribe('cart', () => { it('totals', () => { new Cart().total([1], 1); }); });\n`,
    'config/app.yaml': 'total: 3\n',
};

let root, intel;
test.before(async () => {
    root = makeRepo(FILES);
    intel = new CodeIntel({ root });
    await intel.open();
});
test.after(() => { intel?.close(); rmrf(root); });

test('search_text: grep lines with the definition each identifier match refers to', async () => {
    const text = await callTool(intel, 'search_text', { pattern: '\\btotal\\b' });
    assert.match(text, /src\/checkout\.ts[\s\S]*3 → Cart\.total \(checkout\) │ return c\.total/);
    assert.match(text, /src\/wish\.ts[\s\S]*→ Wishlist\.total/);
    assert.match(text, /5 comment │/);
    assert.match(text, /config\/app\.yaml/);
    assert.match(text, /"total" across all \d+ matches: .*→ Cart\.total.*→ Wishlist\.total.*2 definitions.*1 in non-code files/);
});

test('find_files (CLI `files`): substring of the path, or a glob on file names or paths', async () => {
    assert.match(await callTool(intel, 'find_files', { pattern: 'CHECK' }), /^1 file with "CHECK" in the path:\nsrc\/checkout\.ts$/);
    const tests = await callTool(intel, 'find_files', { pattern: '*.test.ts' });
    assert.match(tests, /src\/cart\.test\.ts {2}\(test\)/);
    assert.match(await callTool(intel, 'find_files', { pattern: 'config/*.yaml' }), /config\/app\.yaml/);
    assert.match(await callTool(intel, 'find_files', { pattern: '**/*.{yaml,json}' }), /^2 files matching/);
    assert.match(await callTool(intel, 'find_files', { pattern: 'nope' }), /No file path contains "nope"/);
});

test('check_changes: broken calls, removed names, new syntax errors and the tests to run', async () => {
    writeFile(root, 'src/cart.ts', `export class Cart {\n  total(items: number[], tax: number, currency: string) { return items.length * tax; }\n}\nexport class Wishlist {\n  total() { return 0; }\n}\n`);
    writeFile(root, 'src/wish.ts', `import { Wishlist } from './cart';\nexport function wished(w: Wishlist) {\n  return w.total(1);\n}\nexport function broken( {\n`);
    const text = await callTool(intel, 'check_changes', {});
    assert.match(text, /Cart\.total \(src\/cart\.ts; now takes 3, was 2\)/);
    assert.match(text, /src\/checkout\.ts:3 {2}in checkout {2}passes 2/);
    assert.match(text, /Cart\.sum \(method, src\/cart\.ts\) was removed or renamed but is still used/);
    assert.match(text, /src\/checkout\.ts:7/);
    assert.match(text, /call does not fit Wishlist\.total[\s\S]*src\/wish\.ts:3/);
    assert.match(text, /syntax errors introduced[\s\S]*src\/wish\.ts:5/);
    assert.match(text, /run: npx vitest run src\/cart\.test\.ts/);
});

test('hook post-tool: edits get the checker; missed definition searches get the location; crawling gets the definitions', () => {
    const session = `t-${process.pid}-${Date.now()}`;
    const run = (payload) => spawnSync(process.execPath, [BIN, 'hook', 'post-tool'], { input: JSON.stringify({ cwd: root, session_id: session, ...payload }), encoding: 'utf8', env: LOCAL });
    const ctxOf = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.additionalContext : null);
    const edit = run({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/cart.ts') } });
    const ctx = JSON.parse(edit.stdout).hookSpecificOutput;
    assert.equal(ctx.hookEventName, 'PostToolUse');
    assert.match(ctx.additionalContext, /Cart\.total now takes 3 argument\(s\) \(was 2\)/);
    // a search for uses right after an edit: nothing to add yet
    const first = run({ tool_name: 'Bash', tool_input: { command: `grep -rn "total(" src | head` }, tool_response: { stdout: 'src/checkout.ts:3:  return c.total([1, 2], 0.2);' } });
    assert.equal(first.stdout, '');
    // a definition search that missed: where it is, at once
    const miss = run({ tool_name: 'Bash', tool_input: { command: `grep -n "class Wishlist" src/checkout.ts` }, tool_response: { stdout: '' } });
    assert.match(ctxOf(miss), /"Wishlist" is defined at:\n {2}Wishlist → src\/cart\.ts:\d+-\d+ {2}class Wishlist/);
    // third navigation call since the edit: crawling, so reads and greps get context
    const read = run({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'src/checkout.ts') } });
    assert.match(ctxOf(read), /Cart\.total → src\/cart\.ts:2/);
    const grep = run({ tool_name: 'Bash', tool_input: { command: `grep -rn "total(" src | head` }, tool_response: { stdout: 'src/checkout.ts:3:  return c.total([1, 2], 0.2);' } });
    assert.match(ctxOf(grep), /"total" names 2 different definitions/);
    // Cursor-style events get Cursor's field
    const cursor = run({ hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: { command: 'grep -n "class Wishlist" src/wish.ts' }, tool_response: '' });
    assert.match(JSON.parse(cursor.stdout).additional_context, /Wishlist → src\/cart\.ts:\d+/);
    const quietEdit = run({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'config/app.yaml') } });
    assert.equal(quietEdit.status, 0);
});

test('hook subagent-start: the index line and the lookup rules', () => {
    const r = spawnSync(process.execPath, [BIN, 'hook', 'subagent-start'], { input: JSON.stringify({ cwd: root, hook_event_name: 'SubagentStart' }), encoding: 'utf8', env: LOCAL });
    const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(text, /live index of this repository/);
    assert.match(text, /several targets/);
});

test('grep patterns are read from shell commands', () => {
    assert.equal(grepPattern(`cd x && grep -rn "addProvider(" packages | head`), 'addProvider(');
    assert.equal(grepPattern(`rg -t ts -e 'Foo\\.bar' src`), 'Foo\\.bar');
    assert.equal(grepPattern('ls -la'), null);
});

test('init --hooks merges Claude Code hooks idempotently and keeps foreign ones', () => {
    const dir = makeRepo({ '.claude/settings.json': '{"hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo mine"}]}]}}\n' });
    try {
        for (let i = 0; i < 2; i++) spawnSync(process.execPath, [BIN, 'init', '--repo', dir, '--hooks', '--agents', 'claude'], { encoding: 'utf8' });
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
        const post = cfg.hooks.PostToolUse.flatMap(e => e.hooks.map(h => h.command));
        assert.equal(post.filter(c => c === 'echo mine').length, 1);
        assert.equal(post.filter(c => /graph-indexer@3 hook post-tool$/.test(c)).length, 1);
        assert.ok(cfg.hooks.SubagentStart[0].hooks[0].command.endsWith('hook subagent-start'));
    } finally { rmrf(dir); }
});

test('init: OpenCode/Kilo Code, Junie and Zed configuration in their formats; Devin gets instructions and hooks', () => {
    const dir = makeRepo({ '.zed/settings.json': '{\n  "tab_size": 2\n}\n', 'kilo.json': '{"model":"x"}\n', '.junie/guidelines.md': 'x\n', '.cursor/mcp.json': '{\n  // mine\n  "mcpServers": {}\n}\n' });
    try {
        const r = spawnSync(process.execPath, [BIN, 'init', '--repo', dir, '--hooks', '--agents', 'opencode,junie,zed,devin'], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        const kilo = JSON.parse(fs.readFileSync(path.join(dir, 'kilo.json'), 'utf8'));
        assert.equal(kilo.model, 'x', 'keeps the existing Kilo config');
        assert.deepEqual(kilo.mcp['graph-indexer'], { type: 'local', command: ['npx', '-y', 'graph-indexer@3', 'serve'], enabled: true });
        assert.ok(!fs.existsSync(path.join(dir, 'opencode.json')), 'an existing kilo.json is used instead');
        const junie = JSON.parse(fs.readFileSync(path.join(dir, '.junie/mcp/mcp.json'), 'utf8'));
        assert.deepEqual(junie.mcpServers['graph-indexer'].args, ['-y', 'graph-indexer@3', 'serve']);
        const zed = JSON.parse(fs.readFileSync(path.join(dir, '.zed/settings.json'), 'utf8'));
        assert.equal(zed.tab_size, 2);
        assert.deepEqual(zed.context_servers['graph-indexer'], { command: 'npx', args: ['-y', 'graph-indexer@3', 'serve'], env: {} });
        assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /graph-indexer:start/);
        assert.ok(JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')).hooks.PostToolUse, 'Devin runs the Claude Code hooks');
        assert.match(r.stdout, /Devin: reads AGENTS\.md and the Claude Code hooks/);
        const cursor = spawnSync(process.execPath, [BIN, 'init', '--repo', dir, '--agents', 'cursor'], { encoding: 'utf8' });
        assert.match(cursor.stdout, /\.cursor\/mcp\.json has comments or is not plain JSON, so it was left as is/);
        assert.match(fs.readFileSync(path.join(dir, '.cursor/mcp.json'), 'utf8'), /\/\/ mine/, 'a commented config is not rewritten');
        const fresh = makeRepo({ '.opencode/.keep': '' });
        try {
            spawnSync(process.execPath, [BIN, 'init', '--repo', fresh], { encoding: 'utf8' });
            assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'opencode.json'), 'utf8')).mcp['graph-indexer'].type, 'local');
        } finally { rmrf(fresh); }
    } finally { rmrf(dir); }
});
