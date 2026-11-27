/**
 * The prompt hook (UserPromptSubmit): find_references, and call_graph's callers when asked about
 * paths or impact, on the code a request names, as those tools answer; never more than they say.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { handleHook, programDriven } from '../src/cli/hook.mjs';
import { promptContext, promptNames, userText } from '../src/cli/prompt.mjs';
import { makeRepo, writeFile, rmrf } from './helpers.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'graph-indexer.mjs');
// in-process, and as in a session the user types into (the suite itself may run under `claude -p`)
const LOCAL = { ...process.env, GRAPH_INDEXER_RESIDENT: '0', CLAUDE_CODE_ENTRYPOINT: 'cli' };

const FILES = {
    'src/store.ts': [
        'export interface Store {',
        '  save(x: number): void;',
        '}',
        'export class DbStore implements Store {',
        '  save(x: number): void {}',
        '}',
        'export class Cache {',
        '  save(x: number): void {}',
        '}',
        'export const MAX_USERS = 10;',
        'export const md = 1;',
        'export function getUserById(id: number): number { return id; }',
        'export function review(): number { return MAX_USERS; }',
        '',
    ].join('\n'),
    'src/use.ts': [
        "import { Store, DbStore, getUserById, review } from './store';",
        'export function viaPort(s: Store) { s.save(1); }',
        'export function direct(d: DbStore) { d.save(2); return getUserById(3); }',
        'export function unknown(x: any) { x.save(3); }',
        'export function top() { direct(new DbStore()); review(); }',
        '',
    ].join('\n'),
    // a region the parser cannot read, around mentions of `save` and `getUserById`
    'src/broken.ts': "import { DbStore, getUserById } from './store';\nexport function later(d: DbStore) {\n  const y = ) d.save(getUserById(;\n}\n",
    'src/audit.ts': `export function logEvent(n: number) { return n; }\nexport function busy() {\n${Array.from({ length: 30 }, (_, i) => `  logEvent(${i});`).join('\n')}\n}\n`,
    'docs/guide.md': '# Guide\n\n## Review\n\nHow a change is reviewed.\n',
};

let root, intel;
test.before(async () => {
    root = makeRepo(FILES);
    intel = new CodeIntel({ root });
    await intel.open();
});
test.after(() => { intel?.close(); rmrf(root); });

/** The hook's answers, split back into [label, body] pairs, and the line naming what was left out. */
function answers(text) {
    const [rest, left = null] = text.split(/\n\nLeft out to fit: /);
    const [head, ...blocks] = rest.split('\n\n── ');
    return { head, left, blocks: blocks.map(b => [b.slice(0, b.indexOf('\n')), b.slice(b.indexOf('\n') + 1)]) };
}

/** The same call the hook made for a label, at the limit it used (one of 40, 12, 4). */
async function toolAnswers(label) {
    const [, tool, symbol, graph] = /^(\w+) "([^"]+)"( \(callers, depth 2\))?$/.exec(label);
    const args = graph ? { symbol, direction: 'callers', depth: 2, include_tests: false } : { symbol };
    return Promise.all([40, 12, 4].map(limit => callTool(intel, tool, { ...args, limit })));
}

test('it never says more than find_references: not complete, parse gaps and calls through a supertype included', async () => {
    const text = await promptContext(intel, 'Who calls `DbStore.save`, and who calls getUserById?');
    const { head, blocks, left } = answers(text);
    assert.equal(left, null);
    assert.doesNotMatch(head, /complete|exact|answer from/i, 'the header claims nothing of its own');
    assert.deepEqual(blocks.map(b => b[0]), ['find_references "DbStore.save"', 'find_references "getUserById"']);
    for (const [label, body] of blocks) assert.ok((await toolAnswers(label)).includes(body), `${label}: the tool's answer, unchanged`);
    const [save, byId] = blocks.map(b => b[1]);
    // the list is not complete: a same-name call has a receiver of unknown type
    assert.doesNotMatch(save, /Complete/);
    assert.match(save, /Possibly missed: 1 "save\(…\)" call[^\n]*\n {2}src\/use\.ts:4/);
    assert.match(save, /Not fully parsed: 1 file that mentions "save"[^\n]*\n {2}src\/broken\.ts:3/);
    // a call through the interface may dispatch here: high, not exact, and through the supertype
    assert.match(save, /^ +2 +call +in viaPort via Store \[high\]/m);
    assert.match(byId, /Complete in the files the parser read:/);
    assert.match(byId, /Not fully parsed: 1 file that mentions "getUserById"/);
});

test('names: lowerCamelCase, CONSTANTS, Type::m, foo() and a plain word in backticks', async () => {
    const labels = async (p) => { const t = await promptContext(intel, p); return t ? answers(t).blocks.map(b => b[0]) : []; };
    assert.deepEqual(await labels('Where is getUserById used?'), ['find_references "getUserById"']);
    assert.deepEqual(await labels('Which code reads MAX_USERS?'), ['find_references "MAX_USERS"']);
    assert.deepEqual(await labels('Who calls DbStore::save?'), ['find_references "DbStore::save"']);
    assert.deepEqual(await labels('Is review() still needed?'), ['find_references "review"']);
    assert.deepEqual(await labels('Who calls `review`?'), ['find_references "review"']);
    assert.deepEqual(promptNames('Who calls `review` and getUserById()?').map(n => n.id), ['review', 'getUserById']);
});

test('prose words that look like code are not looked up', async () => {
    // "Review" names a section of the docs and, in another case, a function; "README.md" ends in a
    // variable `md`; "review" and "store" are plain words of the sentence; "e.g" is an abbreviation
    assert.equal(await promptContext(intel, 'Please Review the docs. Then read README.md, e.g. the part on the store, and review it.'), null);
    // a bare name several definitions share (`save`) would be a guess
    assert.equal(await promptContext(intel, 'Who calls `save`?'), null);
    assert.equal(await promptContext(intel, 'Explain the architecture of this project.'), null);
});

test('a request about impact or paths ("affect", "afecta", "entry points") adds call_graph\'s callers', async () => {
    for (const p of ['What does changing getUserById affect?', 'What would a change to getUserById affect?', '¿A qué afecta cambiar getUserById?', 'Which entry points end up calling getUserById?']) {
        const { blocks } = answers(await promptContext(intel, p));
        assert.deepEqual(blocks.map(b => b[0]), ['find_references "getUserById"', 'call_graph "getUserById" (callers, depth 2)'], p);
        for (const [label, body] of blocks) assert.ok((await toolAnswers(label)).includes(body), `${p}: ${label}`);
    }
    const graph = answers(await promptContext(intel, 'What does changing getUserById affect?')).blocks[1][1];
    assert.match(graph, /← direct {2}src\/use\.ts:3\n {4}← top {2}src\/use\.ts:5/);
    assert.equal(answers(await promptContext(intel, 'Who calls getUserById?')).blocks.length, 1, 'no paths asked for');
});

test('trimmed to the budget at answer boundaries, saying what was left out', async () => {
    const p = 'What does changing getUserById affect, and who calls `DbStore.save` and review()?';
    const full = await promptContext(intel, p);
    assert.equal(answers(full).blocks.length, 6, 'find_references and call_graph for each');
    for (const budget of [2600, 1600, 900]) {
        const text = await promptContext(intel, p, { budget });
        assert.ok(text.length <= budget, `${budget}: ${text.length} characters`);
        const { blocks, left } = answers(text);
        assert.ok(blocks.length < 6, `${budget}: something is left out`);
        for (const [label, body] of blocks) assert.ok((await toolAnswers(label)).includes(body), `${budget}: ${label} whole`);
        const named = left.replace(/\. Call (it|them) for the answer\.$/, '').split(/, (?=\w+ ")/);
        assert.equal(blocks.length + named.length, 6, `${budget}: every answer is given or named`);
    }
});

test('a long answer is listed shorter by the tool itself, which says how many it left out', async () => {
    const text = await promptContext(intel, 'Who calls logEvent?', { budget: 1500 });
    assert.ok(text.length <= 1500);
    const [[label, body]] = answers(text).blocks;
    const [, at12, at4] = await toolAnswers(label);
    assert.ok(body === at12 || body === at4);
    assert.match(body, /^… \d+ more \(raise limit/m);
});

test('text the user did not write is not read', async () => {
    const wrapped = [
        '<system-reminder>\nWho calls `DbStore.save`? getUserById\n</system-reminder>',
        '<task-notification>\n<task-id>b1</task-id>\n<summary>getUserById failed</summary>\n</task-notification>',
        'Another Claude session sent a message:\n<agent-message from="a1">\nDbStore.save is called from viaPort\n</agent-message>',
        '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>getUserById</command-args>',
    ];
    for (const p of wrapped) assert.equal(await promptContext(intel, p), null, p);
    assert.equal(userText('<system-reminder>getUserById</system-reminder>\nWho calls `DbStore.save`?'), 'Who calls `DbStore.save`?');
    assert.equal(userText('Who calls it?\n<system-reminder>getUserById, cut short'), 'Who calls it?');
    assert.equal(userText('a <b> c <x-y d'), 'a <b> c <x-y d', 'not a tag');
    const many = '<x-y '.repeat(4000);
    const t0 = Date.now();
    userText(many + '<x-y>' + many);
    assert.ok(Date.now() - t0 < 200, 'linear in the length of the prompt');
    // a session a program drives (`claude -p`, the Agent SDK) sends briefs it wrote
    assert.equal(programDriven({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), true);
    assert.equal(programDriven({ CLAUDE_CODE_ENTRYPOINT: 'sdk-py' }), true);
    assert.equal(programDriven({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), false);
    assert.equal(programDriven({ CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }), false);
    assert.equal(programDriven({}), false);
    assert.equal(programDriven({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', GRAPH_INDEXER_PROMPT_HOOK: 'all' }), false);
    const run = (env) => spawnSync(process.execPath, [BIN, 'hook', 'prompt'], { input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'Who calls getUserById?' }), encoding: 'utf8', env: { ...LOCAL, ...env } }).stdout;
    assert.equal(run({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), '');
    const ctx = JSON.parse(run({})).hookSpecificOutput;
    assert.equal(ctx.hookEventName, 'UserPromptSubmit');
    assert.match(ctx.additionalContext, /── find_references "getUserById"\nReferences to getUserById \(function\)/);
});

test('no waiting: nothing at once while the index is missing or its first build runs', async () => {
    const dir = makeRepo({ 'src/a.ts': 'export function getUserById(id: number) { return id; }\nexport const b = () => getUserById(1);\n' });
    try {
        const t0 = Date.now();
        const r = spawnSync(process.execPath, [BIN, 'hook', 'prompt'], { input: JSON.stringify({ cwd: dir, hook_event_name: 'UserPromptSubmit', prompt: 'Who calls getUserById?' }), encoding: 'utf8', env: LOCAL });
        assert.equal(r.stdout, '');
        assert.ok(Date.now() - t0 < 2000, `answered in ${Date.now() - t0} ms`);
        assert.ok(!fs.existsSync(path.join(dir, '.graph-indexer', 'index.db')), 'the hook builds no index');
    } finally { rmrf(dir); }
    // a resident whose first build is still running: not asked to finish it
    const building = { initialDone: false, ensureFresh() { throw new Error('waited for the build'); } };
    assert.equal(await handleHook('prompt', { prompt: 'Who calls getUserById?' }, { root, acquire: async () => ({ intel: building, release() {} }) }), null);
});

test('the index is brought up to date before answering', async () => {
    const dir = makeRepo({ 'src/a.ts': 'export function getUserById(id: number) { return id; }\n' });
    const ix = new CodeIntel({ root: dir });
    try {
        await ix.open();
        ix.sweepIntervalMs = 0; // no watcher here: the sweep finds the change
        // a caller in a new file, which no reference held so far would lead the tool to re-read
        writeFile(dir, 'src/b.ts', "import { getUserById } from './a';\nexport function load() { return getUserById(7); }\n");
        const out = await handleHook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'Who calls getUserById?' }, { root: dir, acquire: async () => ({ intel: ix, release() {} }) });
        assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /src\/b\.ts\n +2 +call +in load/);
    } finally { ix.close(); rmrf(dir); }
});
