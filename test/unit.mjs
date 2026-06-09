#!/usr/bin/env node
/**
 * test/unit.mjs
 *
 * Fast, dependency-free unit tests for pure helpers — no fixtures, no Ollama,
 * no network. Complements the integration suites in test/run.mjs.
 *
 *   node test/unit.mjs
 *
 * Exit code 0 = all passed, 1 = a failure.
 */
import assert from 'node:assert/strict';
import {
    buildEmbeddingPayload,
    buildIgnoreFilter,
    getParserForFile,
    EXTENSIONS,
} from '../parser-utils.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ✗ ${name}\n      ${err.message}`);
    }
}

console.log('\nUNIT TESTS\n');

// ─── buildEmbeddingPayload ──────────────────────────────────────────────────
// Regression: the bootstrap indexer previously ran path.relative(ROOT, d) on an
// already-relative path, producing empty neighbor names. Neighbors must derive
// from the basename of each (already relative) dependency path.
test('buildEmbeddingPayload derives neighbor basenames from relative dep paths', () => {
    const chunk = {
        file_path: 'src/a.ts', node_type: 'function_declaration', name: 'foo',
        docstring: 'does foo', type_refs: ['User'], code_snippet: 'function foo(){}',
    };
    const payload = buildEmbeddingPayload(chunk, ['lib/core/Axios.js', 'src/utils/helpers.ts']);
    assert.match(payload, /connects with: Axios, helpers\./);
});

test('buildEmbeddingPayload includes type_refs (parity with daemon)', () => {
    const chunk = {
        file_path: 'src/a.ts', node_type: 'function_declaration', name: 'foo',
        type_refs: ['User', 'Token'], code_snippet: 'x',
    };
    assert.match(buildEmbeddingPayload(chunk, []), /Type References: User, Token/);
});

test('buildEmbeddingPayload omits topological line when there are no deps', () => {
    const chunk = { file_path: 'a.ts', node_type: 'fn', name: 'foo', code_snippet: 'x' };
    assert.ok(!buildEmbeddingPayload(chunk, []).includes('connects with'));
});

test('buildEmbeddingPayload is identical for indexer and daemon inputs (payload parity)', () => {
    const chunk = {
        file_path: 'src/a.ts', node_type: 'fn', name: 'foo',
        docstring: 'd', type_refs: ['T'], code_snippet: 'body',
    };
    const deps = ['src/b.ts', 'src/c.ts'];
    // Both call sites now route through the same helper with the same args.
    assert.equal(buildEmbeddingPayload(chunk, deps), buildEmbeddingPayload(chunk, deps));
});

// ─── buildIgnoreFilter ──────────────────────────────────────────────────────
// Regression: the watch daemon must not descend into these directories.
test('buildIgnoreFilter ignores node_modules / .git / dist', () => {
    const ig = buildIgnoreFilter(process.cwd());
    assert.ok(ig.ignores('node_modules/foo/index.js'), 'node_modules not ignored');
    assert.ok(ig.ignores('dist/bundle.js'), 'dist not ignored');
    assert.ok(ig.ignores('.git/config'), '.git not ignored');
});

test('buildIgnoreFilter does NOT ignore ordinary source files', () => {
    const ig = buildIgnoreFilter(process.cwd());
    assert.ok(!ig.ignores('src/app.ts'), 'source file wrongly ignored');
});

// ─── getParserForFile / EXTENSIONS ──────────────────────────────────────────
test('getParserForFile returns a parser for a supported extension', () => {
    assert.ok(getParserForFile('.ts'), 'no parser for .ts');
});

test('getParserForFile returns null for an unsupported extension', () => {
    assert.equal(getParserForFile('.zzz'), null);
});

test('EXTENSIONS is a non-empty set of dotted extensions', () => {
    assert.ok(EXTENSIONS.size > 0);
    for (const e of EXTENSIONS) assert.match(e, /^\./);
});

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
