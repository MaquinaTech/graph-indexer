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
    extractDecorators,
    extractHeritage,
    extractSemanticChunks,
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

// Decorators/heritage are deliberately kept OUT of the embedding payload: A/B
// measurement (test/evaluate.mjs --embeddings) showed them neutral on strict
// rank-1/MRR, and lexically they regress framework repos. They live as MCP result
// metadata only — so the payload must NOT leak them into the retrieval channel.
test('buildEmbeddingPayload excludes decorators/heritage from the retrieval channel', () => {
    const chunk = {
        file_path: 'cats.controller.ts', node_type: 'class_declaration', name: 'CatsController',
        decorators: ['Controller', 'UseGuards'], extends: ['BaseController'], code_snippet: 'x',
    };
    const payload = buildEmbeddingPayload(chunk, []);
    assert.ok(!/Decorators:/.test(payload), 'decorators leaked into embedding payload');
    assert.ok(!/Inherits From:/.test(payload), 'heritage leaked into embedding payload');
});

// ─── extractDecorators ──────────────────────────────────────────────────────
// Generalises across decorator grammars (TS/JS/Python) by node type alone.
test('extractDecorators captures class + method decorators (TypeScript)', () => {
    const parser = getParserForFile('.ts');
    if (!parser) { console.log('      (skipped — tree-sitter-typescript not installed)'); return; }
    const src = '@Controller("cats")\nexport class CatsController {\n  @Get(":id")\n  findOne() {}\n}';
    const tree = parser.parse(src);
    const exportStmt = tree.rootNode.namedChild(0);
    const decos = extractDecorators(exportStmt);
    assert.ok(decos.includes('Controller'), `class decorator missing: ${decos.join(',')}`);
    assert.ok(decos.includes('Get'), `method decorator missing: ${decos.join(',')}`);
});

test('extractDecorators strips call arguments to the bare callee name', () => {
    const parser = getParserForFile('.ts');
    if (!parser) return;
    const src = '@Injectable()\nexport class S {}';
    const tree = parser.parse(src);
    const decos = extractDecorators(tree.rootNode.namedChild(0));
    assert.deepEqual(decos, ['Injectable']);
});

// ─── extractHeritage (concept → implementation edge) ─────────────────────────
test('extractHeritage captures extends + implements (TypeScript)', () => {
    const parser = getParserForFile('.ts');
    if (!parser) { console.log('      (skipped — tree-sitter-typescript not installed)'); return; }
    const src = 'export class ValidationPipe extends BasePipe implements PipeTransform, OnInit {}';
    const tree = parser.parse(src);
    const bases = extractHeritage(tree.rootNode.namedChild(0), '.ts');
    for (const want of ['BasePipe', 'PipeTransform', 'OnInit']) {
        assert.ok(bases.includes(want), `missing ${want}: ${bases.join(',')}`);
    }
});

test('extractHeritage captures Python base classes', () => {
    const parser = getParserForFile('.py');
    if (!parser) { console.log('      (skipped — tree-sitter-python not installed)'); return; }
    const src = 'class UserService(BaseService, LoggerMixin):\n    pass';
    const tree = parser.parse(src);
    const bases = extractHeritage(tree.rootNode.namedChild(0), '.py');
    assert.ok(bases.includes('BaseService') && bases.includes('LoggerMixin'), bases.join(','));
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

// ─── God-class splitting ─────────────────────────────────────────────────────
// A Python class with > GOD_CLASS_LINES (200) lines must be split into:
//   1. One "skeleton" class chunk (truncated, includes ⚠ comment)
//   2. Multiple method sub-chunks (each method becomes independently searchable)
// This prevents a single get_chunk() call from blowing the agent's token budget
// while keeping every method individually reachable via search_code().
test('extractSemanticChunks splits oversized Python class into skeleton + method chunks', () => {
    const parser = getParserForFile('.py');
    if (!parser) { console.log('      (skipped — tree-sitter-python not installed)'); return; }

    // Build a class with 30 methods × 8 lines = 240 lines (> GOD_CLASS_LINES=200)
    const methods = Array.from({ length: 30 }, (_, i) =>
        `    def method_${i}(self, x):\n` +
        `        """Compute result for method ${i}"""\n` +
        `        a = x + ${i}\n` +
        `        b = a * 2\n` +
        `        c = b - ${i}\n` +
        `        return c\n` +
        `\n`
    ).join('');
    const src = `class GodService:\n    """Service with many methods"""\n\n${methods}`;

    const tree = parser.parse(src);
    const chunks = extractSemanticChunks(tree.rootNode, 'god_service.py', src, '.py');

    const classChunks  = chunks.filter(c => c.name === 'GodService');
    const methodChunks = chunks.filter(c => c.class_context === 'GodService');

    assert.ok(classChunks.length >= 1,   `expected class chunk, got ${classChunks.length}`);
    assert.ok(methodChunks.length >= 15, `expected ≥15 method chunks, got ${methodChunks.length}`);
    assert.ok(
        classChunks[0].code_snippet.includes('⚠'),
        `skeleton should contain ⚠ warning, got: ${classChunks[0].code_snippet.slice(0, 200)}`
    );
    // Skeleton must be shorter than the full class (which would be ~10k chars)
    assert.ok(
        classChunks[0].code_snippet.length < 2000,
        `skeleton too long: ${classChunks[0].code_snippet.length} chars`
    );
});

test('extractSemanticChunks does NOT split a normal-sized Python class', () => {
    const parser = getParserForFile('.py');
    if (!parser) { console.log('      (skipped — tree-sitter-python not installed)'); return; }

    // Small class: 3 methods × 5 lines = 15 lines (well under GOD_CLASS_LINES=200)
    const src = [
        'class SmallService:',
        '    """A small, normal service."""',
        '',
        '    def get(self, x):',
        '        return x',
        '',
        '    def set(self, x, v):',
        '        self.x = v',
        '        return self',
        '',
        '    def delete(self, x):',
        '        return None',
    ].join('\n');

    const tree = parser.parse(src);
    const chunks = extractSemanticChunks(tree.rootNode, 'small.py', src, '.py');

    const classChunks  = chunks.filter(c => c.name === 'SmallService');
    const methodChunks = chunks.filter(c => c.class_context === 'SmallService');

    assert.ok(classChunks.length === 1, `expected 1 class chunk, got ${classChunks.length}`);
    assert.ok(methodChunks.length === 0, `normal class should NOT split methods, got ${methodChunks.length}`);
    assert.ok(!classChunks[0].code_snippet.includes('⚠'), 'normal class should not have ⚠ skeleton marker');
});

test('extractSemanticChunks splits oversized TypeScript class into skeleton + method chunks', () => {
    const parser = getParserForFile('.ts');
    if (!parser) { console.log('      (skipped — tree-sitter-typescript not installed)'); return; }

    // Build a TS class with 30 methods × 8 lines = ~240 lines
    const methods = Array.from({ length: 30 }, (_, i) =>
        `  method${i}(x: number): number {\n` +
        `    const a = x + ${i};\n` +
        `    const b = a * 2;\n` +
        `    const c = b - ${i};\n` +
        `    return c;\n` +
        `  }\n` +
        `\n`
    ).join('');
    const src = `export class GodController {\n${methods}}\n`;

    const tree = parser.parse(src);
    const chunks = extractSemanticChunks(tree.rootNode, 'god.controller.ts', src, '.ts');

    const classChunks  = chunks.filter(c => c.name === 'GodController');
    const methodChunks = chunks.filter(c => c.class_context === 'GodController');

    assert.ok(classChunks.length >= 1,   `expected class chunk, got ${classChunks.length}`);
    assert.ok(methodChunks.length >= 15, `expected ≥15 method chunks, got ${methodChunks.length}`);
    assert.ok(
        classChunks[0].code_snippet.includes('⚠'),
        `TS skeleton should contain ⚠ warning, got: ${classChunks[0].code_snippet.slice(0, 200)}`
    );
});

// ─── Embedding binary append + full scan ─────────────────────────────────────
const { appendEmbeddingBinary, scanEmbeddingBinary, writeEmbeddingBinary, readEmbeddingBinary } =
    await import('../core-engine.mjs');
const { embeddingKeyFor, isNaturalLanguageQuery } = await import('../search-core.mjs');
const fsMod = await import('node:fs');
const osMod = await import('node:os');
const pathMod = await import('node:path');

test('appendEmbeddingBinary extends an existing bin and stays readable', () => {
    const p = pathMod.join(osMod.tmpdir(), `gi-bin-${process.pid}-${Math.random().toString(36).slice(2)}.bin`);
    try {
        fsMod.writeFileSync(p, writeEmbeddingBinary(new Map([['k1', new Float32Array([1, 2, 3])]])));
        const offsets = appendEmbeddingBinary(p, new Map([
            ['k2', new Float32Array([4, 5, 6])],
            ['k3|e:abc', new Float32Array([7, 8, 9])],
        ]));
        assert.equal(offsets.size, 2);
        const all = readEmbeddingBinary(p);            // header count was bumped
        assert.equal(all.size, 3);
        assert.deepEqual(Array.from(all.get('k3|e:abc')), [7, 8, 9]);
    } finally { try { fsMod.unlinkSync(p); } catch {} }
});

test('scanEmbeddingBinary streams the whole bin and ranks by cosine', () => {
    const p = pathMod.join(osMod.tmpdir(), `gi-scan-${process.pid}-${Math.random().toString(36).slice(2)}.bin`);
    try {
        const entries = new Map([
            ['near', new Float32Array([0.9, 0.1, 0])],
            ['far', new Float32Array([0, 0, 1])],
            ['mid', new Float32Array([0.5, 0.5, 0])],
        ]);
        fsMod.writeFileSync(p, writeEmbeddingBinary(entries));
        const fd = fsMod.openSync(p, 'r');
        try {
            const hits = scanEmbeddingBinary({ fd }, new Float32Array([1, 0, 0]), { topN: 2, minScore: 0 });
            assert.equal(hits[0]?.key, 'near');
            assert.equal(hits[1]?.key, 'mid');
            assert.equal(hits.length, 2);              // 'far' (cos 0) excluded + topN cap
        } finally { fsMod.closeSync(fd); }
        // Buffer source must agree with the fd source.
        const viaBuf = scanEmbeddingBinary({ buffer: fsMod.readFileSync(p) }, new Float32Array([1, 0, 0]), { topN: 2, minScore: 0 });
        assert.deepEqual(viaBuf.map(h => h.key), ['near', 'mid']);
    } finally { try { fsMod.unlinkSync(p); } catch {} }
});

// ─── Binary vector sketch ────────────────────────────────────────────────────
const { updateVectorSketch, searchVectorSketch, appendEmbeddingBinary: appendBin2 } =
    await import('../core-engine.mjs');

test('vector sketch matches the exact scan top results and survives appends', () => {
    const p = pathMod.join(osMod.tmpdir(), `gi-sketch-${process.pid}-${Math.random().toString(36).slice(2)}.bin`);
    try {
        // 3,000 vectors in 8 dims — small dims keep the test fast but exercise the
        // packing, Hamming pass, rescore and tail-append paths fully.
        const mk = (seed) => {
            const v = new Float32Array(8);
            let n = 0;
            for (let d = 0; d < 8; d++) { v[d] = Math.sin(seed * 13 + d * 7) + Math.cos(seed + d); n += v[d] * v[d]; }
            n = Math.sqrt(n);
            for (let d = 0; d < 8; d++) v[d] /= n;
            return v;
        };
        const cache = new Map();
        for (let i = 0; i < 3000; i++) cache.set('k' + i, mk(i));
        fsMod.writeFileSync(p, writeEmbeddingBinary(cache));

        const fd = fsMod.openSync(p, 'r');
        try {
            const sketch = updateVectorSketch(null, { fd });
            assert.equal(sketch.n, 3000);
            assert.equal(sketch.dim, 8);

            const q = mk(777);
            const exact = scanEmbeddingBinary({ fd }, q, { topN: 10, minScore: 0 });
            const approx = searchVectorSketch(sketch, { fd }, q, { topN: 10, minScore: 0, oversample: 8 });
            assert.equal(approx[0].key, exact[0].key, 'sketch must recover the exact best match');
            assert.ok(Math.abs(approx[0].score - exact[0].score) < 1e-6, 'rescore must be the exact cosine');

            // Append new entries (daemon path) → tail-only update must index them.
            // Use a vector OUTSIDE the mk() family so it can't tie with an old entry.
            const fresh = new Float32Array(8).fill(1 / Math.sqrt(8));
            appendBin2(p, new Map([['fresh', fresh]]));
            const extended = updateVectorSketch(sketch, { fd });
            assert.equal(extended.n, 3001);
            const hits2 = searchVectorSketch(extended, { fd }, fresh, { topN: 3, minScore: 0 });
            assert.equal(hits2[0].key, 'fresh', 'appended vector must be the new best match');
        } finally { fsMod.closeSync(fd); }
    } finally { try { fsMod.unlinkSync(p); } catch {} }
});

// ─── LLM rerank helpers ──────────────────────────────────────────────────────
const { buildRerankPrompt, parseRerankResponse, rerankResults } = await import('../enrichment.mjs');

test('parseRerankResponse extracts a clean permutation and rejects garbage', () => {
    assert.deepEqual(parseRerankResponse('3, 1, 2', 3), [2, 0, 1]);
    assert.deepEqual(parseRerankResponse('Answer: 2,2,9,1', 3), [1, 0]); // dedupe + out-of-range dropped
    assert.equal(parseRerankResponse('no numbers here', 3), null);
    assert.equal(parseRerankResponse(null, 3), null);
});

await test('rerankResults reorders the head and keeps the tail; failures preserve order', async () => {
    const results = ['a', 'b', 'c', 'd'].map((n, i) => ({
        score: 1 - i / 10,
        chunk: { name: n, node_type: 'function', file_path: `src/${n}.ts`, code_snippet: `function ${n}(){}` },
    }));
    const reranked = await rerankResults('find the c thing', results, {
        topM: 3, generate: async () => '3,1',
    });
    assert.deepEqual(reranked.map(r => r.chunk.name), ['c', 'a', 'b', 'd']);

    const unchanged = await rerankResults('q', results, { topM: 3, generate: async () => null });
    assert.deepEqual(unchanged.map(r => r.chunk.name), ['a', 'b', 'c', 'd']);
});

// ─── embeddingKeyFor ─────────────────────────────────────────────────────────
test('embeddingKeyFor separates enriched from plain vectors deterministically', () => {
    const plain = { content_hash: 'h1' };
    const enriched = { content_hash: 'h1', summary: 'validates JWT tokens', concepts: ['auth', 'jwt'] };
    assert.equal(embeddingKeyFor(plain), 'h1');
    assert.notEqual(embeddingKeyFor(enriched), 'h1');                  // enrichment changes the payload
    assert.equal(embeddingKeyFor(enriched), embeddingKeyFor({ ...enriched })); // deterministic
    const otherSummary = { ...enriched, summary: 'something else' };
    assert.notEqual(embeddingKeyFor(enriched), embeddingKeyFor(otherSummary));
});

// ─── pruneBodyByQuery (smart-detail body budget) ────────────────────────────
const { pruneBodyByQuery } = await import('../mcp-tools.mjs');

test('pruneBodyByQuery keeps signature + relevant lines within maxLines', () => {
    const body = [
        'function f(req) {',
        ...Array.from({ length: 50 }, (_, i) => `  noise_${i};`),
        ...Array.from({ length: 5 }, (_, i) => `  check(req, ${i});`),
        ...Array.from({ length: 50 }, (_, i) => `  more_${i};`),
        '  return out;',
        '}',
    ].join('\n');
    const out = pruneBodyByQuery(body, ['req'], 40);
    assert.ok(out.split('\n').length <= 41, `pruned body too long: ${out.split('\n').length} lines`);
    assert.match(out, /check\(req, 3\)/);
    assert.ok(!/noise_10;/.test(out), 'irrelevant noise lines must be pruned');
});

test('pruneBodyByQuery bounds bodies where a common token matches most lines', () => {
    // 200 lines all containing the query token must not bypass the budget.
    const body = ['function handle(req) {', ...Array.from({ length: 200 }, (_, i) => `  use(req, ${i});`), '}'].join('\n');
    const out = pruneBodyByQuery(body, ['req'], 40);
    assert.ok(out.split('\n').length <= 41, `matching lines bypassed budget: ${out.split('\n').length} lines`);
    assert.match(out, /more matching lines/);
});

// ─── isNaturalLanguageQuery ──────────────────────────────────────────────────
test('isNaturalLanguageQuery separates behavioural questions from symbol lookups', () => {
    assert.ok(isNaturalLanguageQuery('How does the application parse incoming JSON payloads from the client?'));
    assert.ok(isNaturalLanguageQuery('The global error handler that catches exceptions and sends a 500 status code'));
    assert.ok(!isNaturalLanguageQuery('ShouldBindJSON bind request body'));
    assert.ok(!isNaturalLanguageQuery('validateToken'));
    assert.ok(!isNaturalLanguageQuery('router handle request next'));
});

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
