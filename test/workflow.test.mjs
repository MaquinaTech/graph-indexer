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

test('hook post-tool: an edit gets the checker, a grep for a shared name gets the definitions', () => {
    const run = (payload) => spawnSync(process.execPath, [BIN, 'hook', 'post-tool'], { input: JSON.stringify({ cwd: root, ...payload }), encoding: 'utf8' });
    const edit = run({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/cart.ts') } });
    const ctx = JSON.parse(edit.stdout).hookSpecificOutput;
    assert.equal(ctx.hookEventName, 'PostToolUse');
    assert.match(ctx.additionalContext, /Cart\.total now takes 3 argument\(s\) \(was 2\)/);
    const grep = run({ tool_name: 'Bash', tool_input: { command: `grep -rn "total(" src | head` } });
    assert.match(JSON.parse(grep.stdout).hookSpecificOutput.additionalContext, /"total" names 2 different definitions/);
    const quiet = run({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'src/cart.ts') } });
    assert.equal(quiet.stdout, '');
    assert.equal(quiet.status, 0);
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
