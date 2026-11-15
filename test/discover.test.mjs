/**
 * Which files are the project's own. `bin/`, `build/`, `external/`, `env/`, `target/` name build
 * output in one project and source in another: what git tracks there is source, and skipping it by
 * name made a function called only from `bin/` a function with no callers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodeIntel } from '../src/query/intel.mjs';
import { discoverFiles, ownDirectories } from '../src/index/discover.mjs';
import { checkChanges } from '../src/query/check.mjs';
import { textSearch } from '../src/query/textsearch.mjs';
import { makeRepo, writeFile, rmrf } from './helpers.mjs';

const FILES = {
    'src/core.ts': `export function run(argv: string[]) { return argv.length; }\nexport function unused() { return 0; }\n`,
    // a CLI entry point: the only caller of run()
    'bin/cli.ts': `import { run } from '../src/core';\nrun(process.argv);\n`,
    // adapters to an external service, written here
    'packages/ms/external/redis.interface.ts': `export interface ClientOpts { host?: string }\nexport interface RetryOptions { attempt: number }\n`,
    'packages/ms/options.ts': `import { ClientOpts } from './external/redis.interface';\nexport interface RedisOptions { options?: { url?: string } & ClientOpts }\n`,
    // domain words
    'src/build/plan.ts': `import { run } from '../core';\nexport function planBuild() { return run([]); }\n`,
    'lib/env/data.ts': `export const VERSION = 'needle-in-env';\n`,
    // a copy of another project: it carries its licence
    'deps/hiredis/LICENSE': 'BSD\n',
    'deps/hiredis/hiredis.ts': `export function vendoredConnect() { return 1; }\n`,
    // dependencies and bundles stay out whatever git says
    'vendor/lib.ts': `export function vendored() { return 1; }\n`,
    'dist/core.js': `export function run(argv) { return argv.length; }\n`,
    'node_modules/x/index.js': `export function dep() {}\n`,
};

test('git-tracked source under bin/, external/, build/ and env/ is indexed; dependencies, bundles and licensed copies are not', async () => {
    const root = makeRepo(FILES);
    // what a build wrote and nobody ignored: untracked, in a directory git tracks no source in
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'out/core.js'), 'export function run(argv) { return argv.length; }\n');
    const intel = new CodeIntel({ root });
    try {
        await intel.open();
        const paths = intel.store.all('SELECT path FROM files ORDER BY path').map(r => r.path);
        assert.deepEqual(paths, ['bin/cli.ts', 'lib/env/data.ts', 'packages/ms/external/redis.interface.ts', 'packages/ms/options.ts', 'src/build/plan.ts', 'src/core.ts']);
        // the call from bin/ is a caller, and the import into external/ resolves
        const run = intel.findSymbols('src/core.ts:run').matches[0];
        const callers = [...intel.references(run.id, { kinds: ['call'] }).groups.values()].flat().map(r => r.path).sort();
        assert.deepEqual(callers, ['bin/cli.ts', 'src/build/plan.ts']);
        const opts = intel.findSymbols('ClientOpts').matches[0];
        assert.equal(opts.path, 'packages/ms/external/redis.interface.ts');
        assert.ok([...intel.references(opts.id).groups.values()].flat().some(r => r.path === 'packages/ms/options.ts'));
        // a file written later in a directory that is the project's own is picked up
        writeFile(root, 'bin/other.ts', `import { unused } from '../src/core';\nunused();\n`);
        await intel.ix.syncPaths(['bin/other.ts']);
        const unused = intel.findSymbols('src/core.ts:unused').matches[0];
        assert.ok([...intel.references(unused.id).groups.values()].flat().some(r => r.path === 'bin/other.ts'));
        // text search sees the same directories
        const hits = await textSearch(intel, { pattern: 'needle-in-env', literal: true });
        assert.ok(JSON.stringify(hits).includes('lib/env/data.ts'));
    } finally { intel.close(); rmrf(root); }
});

test('removing an interface another file imports from external/ is reported by check', async () => {
    const root = makeRepo(FILES);
    const intel = new CodeIntel({ root });
    try {
        await intel.open();
        writeFile(root, 'packages/ms/external/redis.interface.ts', `export interface IORedisOptions { host?: string }\n`);
        const report = await checkChanges(intel, {});
        const gone = report.removed.find(r => r.qname === 'ClientOpts');
        assert.ok(gone, 'ClientOpts is reported as removed and still used');
        assert.ok(gone.imports.some(i => i.path === 'packages/ms/options.ts') || gone.uses.some(u => u.path === 'packages/ms/options.ts'));
    } finally { intel.close(); rmrf(root); }
});

test('without git, output-like directories are skipped by name as before', () => {
    const root = makeRepo(FILES, { git: false });
    try {
        const { files, layout } = discoverFiles(root);
        assert.equal(layout, null);
        assert.deepEqual(files, ['packages/ms/options.ts', 'src/core.ts']);
    } finally { rmrf(root); }
});

test('a directory is the project\'s own through tracked code, not through a README or untracked files', () => {
    const { own, vendored } = ownDirectories(['build/README.md', 'build/.gitkeep', 'a/target/x.ts', 'a/target/sub/y.ts', 'external/gtest/LICENSE', 'external/gtest/src/g.cc', 'external/mine/m.ts', 'deps/COPYING', 'deps/z.c']);
    assert.deepEqual([...own].sort(), ['a/target', 'deps', 'external']);
    assert.deepEqual([...vendored].sort(), ['deps', 'external/gtest']);
    const root = makeRepo({ 'src/a.ts': 'export const a = 1;\n', 'build/README.md': '# output\n' });
    try {
        fs.writeFileSync(path.join(root, 'build/gen.ts'), 'export const gen = 1;\n'); // untracked
        assert.deepEqual(discoverFiles(root).files, ['src/a.ts']);
        spawnSync('git', ['add', '-A'], { cwd: root });
        assert.deepEqual(discoverFiles(root).files, ['build/README.md', 'build/gen.ts', 'src/a.ts']); // its documentation comes with it
    } finally { rmrf(root); }
});
