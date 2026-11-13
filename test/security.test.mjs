/**
 * Tool input that must not reach outside the repository or stall the server: a git revision that is
 * an option, paths that climb out of the root or through a symlink, and a catastrophic regex.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { makeRepo, rmrf } from './helpers.mjs';
import { handleHook } from '../src/cli/hook.mjs';
import { collectModels } from '../src/query/orm.mjs';
import { dataDir } from '../src/util/paths.mjs';

let root, outside, intel;
test.before(async () => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET-TOKEN\n');
    root = makeRepo({ 'src/a.ts': 'export function a() { return 1; }\n', 'slow.txt': 'a'.repeat(40) + '!\n', '.env': 'TOP-SECRET-TOKEN\n' });
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));
    intel = new CodeIntel({ root });
    await intel.open();
});
test.after(() => { intel?.close(); rmrf(root); rmrf(outside); });

test('check_changes: a base that is a git option is refused, and git writes nothing', async () => {
    const target = path.join(outside, 'pwned.txt');
    for (const base of [`--output=${target}`, '-p', 'HEAD --output=x']) {
        const t = await callTool(intel, 'check_changes', { base });
        assert.match(t, /Not a git revision/, base);
    }
    assert.equal(fs.existsSync(target), false);
    assert.match(intel.diffSeeds(`--output=${target}`).error, /Not a git revision/);
    assert.equal(fs.existsSync(target), false);
});

test('read_code: paths outside the root, through a symlink, or into .git are not read', async () => {
    const rel = path.relative(root, path.join(outside, 'secret.txt'));
    for (const target of [rel, `${rel}:1-1`, 'leak.txt', 'leak.txt:1-1', '.git/config', '.GIT/config', '.Git/config:1-3']) {
        const t = await callTool(intel, 'read_code', { targets: [target] });
        assert.doesNotMatch(t, /TOP-SECRET-TOKEN|repositoryformatversion/, target);
    }
    assert.match(await callTool(intel, 'read_code', { targets: ['src/a.ts'] }), /return 1/);
});

test('search_text: a symlink out of the repository is not searched', async () => {
    const t = await callTool(intel, 'search_text', { pattern: 'TOP-SECRET', literal: true });
    assert.doesNotMatch(t, /leak\.txt/);
});

test('search_text: catastrophic backtracking is stopped instead of blocking the server', async () => {
    const t0 = Date.now();
    const t = await callTool(intel, 'search_text', { pattern: '(a+)+$', path: 'slow.txt' });
    assert.match(t, /took more than/);
    assert.ok(Date.now() - t0 < 15000);
});

test('suggested test commands pass every file name to the runner as one quoted word', async () => {
    const { testCommands, testCaseCommands } = await import('../src/query/testcmd.mjs');
    const [cmd] = testCommands(root, ['src/ok.test.ts', 't$(touch${IFS}PWNED).test.ts', "it's.test.ts", 'app/[id]/page.test.ts', '-x.test.ts']);
    assert.equal(cmd, "npm test -- src/ok.test.ts 't$(touch${IFS}PWNED).test.ts' 'it'\\''s.test.ts' 'app/[id]/page.test.ts'");
    // the shell reads them back as the plain names
    const words = spawnSync('sh', ['-c', `printf '%s\\n' ${cmd.slice('npm test -- '.length)}`], { cwd: outside, encoding: 'utf8' }).stdout.trim().split('\n');
    assert.deepEqual(words, ['src/ok.test.ts', 't$(touch${IFS}PWNED).test.ts', "it's.test.ts", 'app/[id]/page.test.ts']);
    assert.equal(fs.existsSync(path.join(outside, 'PWNED')), false);
    assert.deepEqual(testCaseCommands(root, [{ path: 'pkg/x_test.go', name: 'Test$(id)' }]), []);
});

test("the indexed repository's git config runs nothing: fsmonitor, filters, external diff", async () => {
    const r = makeRepo({ 'src/b.ts': 'export function b() { return 2; }\n', '.gitattributes': '*.ts filter=evil diff=evil\n' });
    const marker = path.join(outside, 'git-ran');
    const set = (k, v) => spawnSync('git', ['config', k, v], { cwd: r });
    set('core.fsmonitor', `touch ${marker}; false`);
    set('filter.evil.clean', `touch ${marker}; cat`);
    set('filter.evil.process', `touch ${marker}`);
    set('diff.external', `touch ${marker}`);
    set('diff.evil.textconv', `touch ${marker}; cat`);
    fs.appendFileSync(path.join(r, 'src/b.ts'), 'export const c = 3;\n');
    const ci = new CodeIntel({ root: r });
    try {
        await ci.open();
        await callTool(ci, 'check_changes', {});
        await callTool(ci, 'search_text', { pattern: 'return' });
        ci.diffSeeds();
    } finally { ci.close(); rmrf(r); }
    assert.equal(fs.existsSync(marker), false);
});

test('a .graph-indexer committed as a symbolic link is refused, not written through', async () => {
    const r = makeRepo({ 'src/a.ts': 'export const a = 1;\n' });
    fs.symlinkSync(outside, path.join(r, '.graph-indexer'));
    try {
        await assert.rejects(async () => { const ci = new CodeIntel({ root: r }); await ci.open(); ci.close(); }, /not a directory/);
    } finally { rmrf(r); }
    assert.equal(fs.existsSync(path.join(outside, 'index.db')), false);
    assert.equal(fs.existsSync(path.join(outside, '.gitignore')), false);
});

test('a manifest linked to a device (tsconfig.json -> /dev/zero) is skipped, not read forever', { skip: process.platform === 'win32' }, async () => {
    const r = makeRepo({ 'src/a.ts': 'export const a = 1;\n' });
    fs.symlinkSync('/dev/zero', path.join(r, 'tsconfig.json'));
    fs.symlinkSync('/dev/zero', path.join(r, 'package.json'));
    const ci = new CodeIntel({ root: r });
    try {
        await ci.open();
        assert.ok(ci.store.get("SELECT id FROM files WHERE path = 'src/a.ts'"));
    } finally { ci.close(); rmrf(r); }
});

test('init does not write through links the repository committed (CLAUDE.md -> ~/.zshrc, .claude -> ~/.claude)', { skip: process.platform === 'win32' }, () => {
    const r = makeRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-victim-'));
    fs.writeFileSync(path.join(victim, 'zshrc'), '# rc\n');
    fs.symlinkSync(path.join(victim, 'zshrc'), path.join(r, 'CLAUDE.md'));
    fs.symlinkSync(victim, path.join(r, '.claude'));
    try {
        const bin = new URL('../bin/graph-indexer.mjs', import.meta.url).pathname;
        const res = spawnSync(process.execPath, [bin, 'init', '--repo', r, '--hooks'], { encoding: 'utf8' });
        assert.notEqual(res.status, 0);
        assert.match(res.stderr, /leads outside the repository/);
        assert.equal(fs.readFileSync(path.join(victim, 'zshrc'), 'utf8'), '# rc\n');
        assert.deepEqual(fs.readdirSync(victim), ['zshrc']);
    } finally { rmrf(r); rmrf(victim); }
});

test("git config of the repository runs no hook or signature program, and a required filter (LFS) does not fail the diff", { skip: process.platform === 'win32' }, async () => {
    const r = makeRepo({ 'src/b.ts': 'export function b() { return 2; }\n', 'a.bin': 'x\n', '.gitattributes': '*.bin filter=lfsish\n' });
    const marker = path.join(outside, 'git-ran-2');
    const run = (...a) => spawnSync('git', a, { cwd: r, encoding: 'utf8' });
    const hooks = path.join(r, '.git', 'evil-hooks');
    fs.mkdirSync(hooks);
    for (const h of ['post-index-change', 'post-checkout', 'pre-commit']) fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const gpg = path.join(r, '.git', 'evil-gpg.sh');
    fs.writeFileSync(gpg, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    run('config', 'core.hooksPath', hooks);
    run('config', 'log.showSignature', 'true');
    run('config', 'gpg.program', gpg);
    run('config', 'filter.lfsish.clean', 'cat');
    run('config', 'filter.lfsish.required', 'true');
    // a commit carrying a signature header, so `git log` has something to verify
    const head = run('cat-file', 'commit', 'HEAD').stdout;
    const signed = head.replace(/\n\n/, '\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\n');
    const sha = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: r, input: signed, encoding: 'utf8' }).stdout.trim();
    run('update-ref', 'HEAD', sha);
    fs.appendFileSync(path.join(r, 'src/b.ts'), 'export const c = 3;\n');
    fs.appendFileSync(path.join(r, 'a.bin'), 'y\n');
    // same content, new mtime: git refreshes the index and would run post-index-change
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(r, '.gitattributes'), later, later);
    const ci = new CodeIntel({ root: r });
    try {
        await ci.open();
        const d = ci.diffSeeds();
        assert.equal(d.error, undefined, d.error);
        assert.match(await callTool(ci, 'check_changes', {}), /Checked/);
        await callTool(ci, 'change_impact', { diff: true });
    } finally { ci.close(); rmrf(r); }
    assert.equal(fs.existsSync(marker), false);
});

test("hooks and the ORM view run git hardened too: a repository's core.fsmonitor runs nothing", { skip: process.platform === 'win32' }, async () => {
    const r = makeRepo({ 'src/b.ts': 'export function b() { return 2; }\n', 'prisma/schema.prisma': 'model User {\n  id Int @id\n}\n' });
    const marker = path.join(outside, 'fsmonitor-ran');
    spawnSync('git', ['config', 'core.fsmonitor', `touch ${marker}; false`], { cwd: r });
    fs.appendFileSync(path.join(r, 'src/b.ts'), 'export const c = 3;\n');
    const ci = new CodeIntel({ root: r });
    try {
        await ci.open();
        collectModels(ci);
        const input = { session_id: `sec-${process.pid}`, tool_name: 'Bash', tool_input: { command: 'make' }, cwd: r };
        await handleHook('post-tool', input, { root: r, acquire: async () => ({ intel: ci, release() {} }) });
    } finally { ci.close(); rmrf(r); }
    assert.equal(fs.existsSync(marker), false);
});

test('links committed inside .graph-indexer are removed, never written through (index.db-wal -> ~/.zshrc)', { skip: process.platform === 'win32' }, async () => {
    const r = makeRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const victim = path.join(outside, 'victim.txt');
    fs.writeFileSync(victim, 'precious\n');
    fs.mkdirSync(path.join(r, '.graph-indexer'));
    for (const name of ['index.db-wal', 'index.db-shm', 'resident.started', '.gitignore']) fs.symlinkSync(victim, path.join(r, '.graph-indexer', name));
    fs.symlinkSync(path.join(outside, 'not-there.db'), path.join(r, '.graph-indexer', 'index.db'));
    try {
        dataDir(r);
        assert.deepEqual(fs.readdirSync(path.join(r, '.graph-indexer')).filter(n => fs.lstatSync(path.join(r, '.graph-indexer', n)).isSymbolicLink()), []);
        const ci = new CodeIntel({ root: r });
        await ci.open();
        ci.close();
    } finally { rmrf(r); }
    assert.equal(fs.readFileSync(victim, 'utf8'), 'precious\n');
    assert.equal(fs.existsSync(path.join(outside, 'not-there.db')), false);
});

test('find_files: a glob that backtracks catastrophically is stopped by the budget', async () => {
    const r = makeRepo({ [`${'a'.repeat(120)}.txt`]: 'x\n', 'src/a.ts': 'export const a = 1;\n' });
    const ci = new CodeIntel({ root: r });
    try {
        await ci.open();
        const t0 = Date.now();
        const t = await callTool(ci, 'find_files', { pattern: '*a'.repeat(14) + '*b' }).catch(e => e.message);
        assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`);
        assert.match(String(t), /took more than/);
        assert.match(await callTool(ci, 'find_files', { pattern: 'src/*.ts' }), /src\/a\.ts/);
    } finally { ci.close(); rmrf(r); }
});

test('an index committed to the repository is not opened', async () => {
    const r = makeRepo({ 'src/a.ts': 'export const a = 1;\n', '.graph-indexer/index.db': 'not ours\n' });
    spawnSync('git', ['add', '-f', '.graph-indexer/index.db'], { cwd: r });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ship an index'], { cwd: r });
    try {
        await assert.rejects(async () => { const ci = new CodeIntel({ root: r }); await ci.open(); ci.close(); }, /is committed to this repository/);
    } finally { rmrf(r); }
});

test('filter and diff drivers named with "=" are switched off too (git splits -c at the first =)', { skip: process.platform === 'win32' }, async () => {
    const r = makeRepo({ 'src/b.ts': 'export function b() { return 2; }\n', '.gitattributes': '*.ts filter=x=y diff=x=y\n' });
    const marker = path.join(outside, 'eq-driver-ran');
    const set = (k, v) => spawnSync('git', ['config', k, v], { cwd: r });
    set('filter.x=y.clean', `touch ${marker}; cat`);
    set('diff.x=y.textconv', `touch ${marker}; cat`);
    fs.appendFileSync(path.join(r, 'src/b.ts'), 'export const c = 3;\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(r, 'src/b.ts'), later, later);
    const ci = new CodeIntel({ root: r });
    try {
        await ci.open();
        await callTool(ci, 'check_changes', {});
        ci.diffSeeds();
        const input = { session_id: `sec-eq-${process.pid}`, tool_name: 'Bash', tool_input: { command: 'make' }, cwd: r };
        await handleHook('post-tool', input, { root: r, acquire: async () => ({ intel: ci, release() {} }) });
    } finally { ci.close(); rmrf(r); }
    assert.equal(fs.existsSync(marker), false);
});

test('MCP arguments are bounded by the tool schema whatever the client sends', async () => {
    const { boundArgs } = await import('../src/mcp/server.mjs');
    const { TOOLS } = await import('../src/mcp/tools.mjs');
    const schema = (n) => TOOLS.find(t => t.name === n).inputSchema;
    assert.deepEqual(boundArgs(schema('call_graph'), { symbol: 'x', depth: 1e9, limit: -1 }), { symbol: 'x', depth: 4, limit: 5 });
    assert.equal(boundArgs(schema('explore'), { queries: Array(50).fill('q') }).queries.length, 6);
    assert.equal(boundArgs(schema('explore'), { symbols: Array(5000).fill('s') }).symbols.length, 100);
});
