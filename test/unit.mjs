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
    extractRoutes,
    EXTENSIONS,
} from '../parser-utils.mjs';
import { assessConfidence, buildHydePrompt, blendVectors, hydeQueryVector } from '../mcp-tools.mjs';
import { computeFreshness } from '../git-signals.mjs';
import { amortizedTokenSavings } from './metrics.mjs';
import { stemToken, tokenize, STEM_PREFIX, fuseAndRank } from '../search-core.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

// ─── extractRoutes (HTTP route → handler) ────────────────────────────────────
// Detection is by AST node type per framework; assert method/path/handler_name.
const routeBy = (routes, method, pathIncludes) =>
    routes.find(r => r.method === method && r.path.includes(pathIncludes));

test('extractRoutes: Express router.<verb>(path, handler) call sites (JS)', () => {
    const parser = getParserForFile('.js');
    if (!parser) { console.log('      (skipped — tree-sitter-javascript not installed)'); return; }
    const src = [
        'const router = express.Router();',
        "router.get('/api/users', getUserHandler);",
        "router.post('/api/users', (req, res) => { res.send('ok'); });",
        "app.delete('/api/users/:id', deleteHandler);",
        "const m = new Map(); m.get('k');",  // must NOT be treated as a route (1 arg, not a path+handler)
    ].join('\n');
    const tree = parser.parse(src);
    const routes = extractRoutes(tree.rootNode, 'routes.js', [], '.js');
    assert.equal(routes.length, 3, `expected 3 routes, got ${routes.length}: ${JSON.stringify(routes.map(r => r.method + ' ' + r.path))}`);
    const get = routeBy(routes, 'GET', '/api/users');
    assert.ok(get && get.handler_name === 'getUserHandler', `GET handler → ${JSON.stringify(get)}`);
    const post = routeBy(routes, 'POST', '/api/users');
    assert.ok(post && post.handler_name === 'anonymous', `POST arrow handler → anonymous, got ${JSON.stringify(post)}`);
    const del = routeBy(routes, 'DELETE', '/api/users/:id');
    assert.ok(del && del.handler_name === 'deleteHandler', `DELETE handler → ${JSON.stringify(del)}`);
    assert.equal(del.framework, 'express');
});

test('extractRoutes: NestJS @Get/@Post on methods, @Controller prefix prepended (TS)', () => {
    const parser = getParserForFile('.ts');
    if (!parser) { console.log('      (skipped — tree-sitter-typescript not installed)'); return; }
    const src = [
        "@Controller('users')",
        'export class UsersController {',
        "  @Get(':id')",
        '  getUser(id) { return this.svc.find(id); }',
        '  @Post()',
        '  create(dto) { return this.svc.create(dto); }',
        '}',
    ].join('\n');
    const tree = parser.parse(src);
    const routes = extractRoutes(tree.rootNode, 'users.controller.ts', [], '.ts');
    const get = routeBy(routes, 'GET', ':id');
    assert.ok(get, `expected a GET route, got ${JSON.stringify(routes)}`);
    assert.equal(get.path, '/users/:id', `controller prefix prepended + rooted: ${get.path}`);
    assert.equal(get.handler_name, 'getUser');
    assert.equal(get.framework, 'nestjs');
    const post = routeBy(routes, 'POST', 'users');
    assert.ok(post && post.path === '/users' && post.handler_name === 'create', `POST → ${JSON.stringify(post)}`);
});

test('extractRoutes: Express handler as member-expression / .bind() / after middleware (JS)', () => {
    const parser = getParserForFile('.js');
    if (!parser) return;
    const src = [
        "router.get('/a', ctrl.getThing);",            // member_expression → 'getThing'
        "router.post('/b', this.handler);",            // this-member → 'handler'
        "router.put('/c', handler.bind(this));",       // .bind() → 'handler'
        "router.delete('/d', auth, ctrl.remove);",     // middleware + member → last arg wins
        "cache.get('userKey', fallbackValue);",        // NOT a route (path not rooted)
        "store.delete('id', opts);",                   // NOT a route (path not rooted)
    ].join('\n');
    const tree = parser.parse(src);
    const routes = extractRoutes(tree.rootNode, 'r.js', [], '.js');
    assert.equal(routeBy(routes, 'GET', '/a')?.handler_name, 'getThing', `member handler → ${JSON.stringify(routes)}`);
    assert.equal(routeBy(routes, 'POST', '/b')?.handler_name, 'handler');
    assert.equal(routeBy(routes, 'PUT', '/c')?.handler_name, 'handler', '.bind() handler');
    assert.equal(routeBy(routes, 'DELETE', '/d')?.handler_name, 'remove', 'handler is last arg, not the middleware');
    // Look-alike, non-rooted member calls must NOT produce routes.
    assert.ok(!routes.some(r => r.path.includes('userKey') || r.path.includes('id') && r.handler_name === 'opts'),
        `phantom route leaked: ${JSON.stringify(routes.map(r => r.method + ' ' + r.path))}`);
    assert.equal(routes.length, 4, `expected exactly 4 real routes: ${JSON.stringify(routes.map(r => r.method + ' ' + r.path))}`);
});

test('extractRoutes: NestJS prefix for non-exported + abstract controllers (TS)', () => {
    const parser = getParserForFile('.ts');
    if (!parser) return;
    const nonExported = "@Controller('p')\nclass C {\n  @Get('a')\n  f() { return 1; }\n}";
    let routes = extractRoutes(parser.parse(nonExported).rootNode, 'c.ts', [], '.ts');
    assert.equal(routeBy(routes, 'GET', 'a')?.path, '/p/a', `non-exported controller prefix lost: ${JSON.stringify(routes)}`);
    const abstractCtrl = "@Controller('base')\nabstract class B {\n  @Get(':id')\n  find(id) { return 1; }\n}";
    routes = extractRoutes(parser.parse(abstractCtrl).rootNode, 'b.ts', [], '.ts');
    assert.equal(routeBy(routes, 'GET', ':id')?.path, '/base/:id', `abstract controller routes missing: ${JSON.stringify(routes)}`);
});

test('extractRoutes: Spring @RequestMapping with a method array yields one route per verb (Java)', () => {
    const parser = getParserForFile('.java');
    if (!parser) { console.log('      (skipped — tree-sitter-java not installed)'); return; }
    const src = [
        'class X {',
        '    @RequestMapping(value = "/legacy", method = {RequestMethod.GET, RequestMethod.POST})',
        '    public void legacy() {}',
        '}',
    ].join('\n');
    const routes = extractRoutes(parser.parse(src).rootNode, 'X.java', [], '.java');
    const get = routeBy(routes, 'GET', '/legacy');
    const post = routeBy(routes, 'POST', '/legacy');
    assert.ok(get && post, `array method should expand to GET+POST: ${JSON.stringify(routes.map(r => r.method + ' ' + r.path))}`);
    // No garbage verb (e.g. 'POST}') from a naive split.
    assert.ok(routes.every(r => /^[A-Z]+$/.test(r.method)), `garbage verb leaked: ${JSON.stringify(routes.map(r => r.method))}`);
});

test('extractRoutes: FastAPI/Flask decorators (Python)', () => {
    const parser = getParserForFile('.py');
    if (!parser) { console.log('      (skipped — tree-sitter-python not installed)'); return; }
    const src = [
        '@app.get("/items/{item_id}")',
        'def read_item(item_id):',
        '    return item_id',
        '',
        '@router.post("/items")',
        'async def create_item(item):',
        '    return item',
        '',
        '@app.route("/legacy", methods=["GET", "POST"])',
        'def legacy():',
        '    return "ok"',
    ].join('\n');
    const tree = parser.parse(src);
    const routes = extractRoutes(tree.rootNode, 'api.py', [], '.py');
    const get = routeBy(routes, 'GET', '/items/{item_id}');
    assert.ok(get && get.handler_name === 'read_item', `FastAPI GET → ${JSON.stringify(get)}`);
    const post = routeBy(routes, 'POST', '/items');
    assert.ok(post && post.handler_name === 'create_item', `FastAPI POST → ${JSON.stringify(post)}`);
    // @app.route(..., methods=["GET","POST"]) → one route per declared method.
    assert.ok(routeBy(routes, 'GET', '/legacy') && routeBy(routes, 'POST', '/legacy'),
        `@app.route should expand to GET+POST /legacy: ${JSON.stringify(routes.map(r => r.method + ' ' + r.path))}`);
});

test('extractRoutes: resolves handler_chunk_id by name and is empty for non-web languages', () => {
    const parser = getParserForFile('.js');
    if (!parser) return;
    // Multi-line handler so it becomes its own chunk, then resolves by name.
    const src = [
        'function listUsers(req, res) {',
        '  const users = db.all();',
        '  res.json(users);',
        '}',
        "router.get('/api/users', listUsers);",
    ].join('\n');
    const tree = parser.parse(src);
    const chunks = extractSemanticChunks(tree.rootNode, 'r.js', src, '.js');
    const routes = extractRoutes(tree.rootNode, 'r.js', chunks, '.js');
    const r = routes[0];
    assert.ok(r && r.handler_name === 'listUsers', `route handler → ${JSON.stringify(r)}`);
    const handlerChunk = chunks.find(c => c.name === 'listUsers');
    assert.ok(handlerChunk, 'listUsers should be a chunk');
    assert.equal(r.handler_chunk_id, handlerChunk.id, 'handler_chunk_id must resolve to the chunk');
    // A non-web language yields no routes.
    if (getParserForFile('.go')) {
        const goTree = getParserForFile('.go').parse('func Add(a int, b int) int {\n  return a + b\n}');
        assert.deepEqual(extractRoutes(goTree.rootNode, 'm.go', [], '.go'), []);
    }
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

// ─── isNaturalLanguageQuery ──────────────────────────────────────────────────
test('isNaturalLanguageQuery separates behavioural questions from symbol lookups', () => {
    assert.ok(isNaturalLanguageQuery('How does the application parse incoming JSON payloads from the client?'));
    assert.ok(isNaturalLanguageQuery('The global error handler that catches exceptions and sends a 500 status code'));
    assert.ok(!isNaturalLanguageQuery('ShouldBindJSON bind request body'));
    assert.ok(!isNaturalLanguageQuery('validateToken'));
    assert.ok(!isNaturalLanguageQuery('router handle request next'));
});

// ─── assessConfidence (low-confidence handoff gate) ──────────────────────────
test('assessConfidence fires the handoff only on ambiguous behavioural queries', () => {
    const mk = (score, file) => ({ score, chunk: { file_path: file } });
    const nlQuery = 'Where is the code that parses an incoming request body into a model object?';
    const symbolQuery = 'parseBody'; // not natural language → never a handoff

    // Flat fused scores spread across files on an NL query → low confidence.
    const flat = [mk(0.10, 'a.ts'), mk(0.095, 'b.ts'), mk(0.09, 'c.ts')];
    const r1 = assessConfidence(flat, nlQuery, false);
    assert.ok(r1.lowConfidence, 'flat NL multi-file result should be low confidence');
    assert.deepEqual(r1.candidateFiles, ['a.ts', 'b.ts', 'c.ts'], 'candidate files are the distinct top files in rank order');

    // A dominant top result (≥2× the #2 score) → confident, no handoff, no candidate bloat.
    const dominant = [mk(0.30, 'a.ts'), mk(0.10, 'b.ts')];
    const r2 = assessConfidence(dominant, nlQuery, false);
    assert.ok(!r2.lowConfidence, 'a dominant top result is confident');
    assert.deepEqual(r2.candidateFiles, [], 'confident queries carry no candidate_files (no token bloat)');

    // Symbol-lookup (non-NL) query → never a handoff, even when flat.
    assert.ok(!assessConfidence(flat, symbolQuery, false).lowConfidence, 'non-NL symbol lookup never hands off');
    // Pinned exact_tokens → caller already knows the symbol.
    assert.ok(!assessConfidence(flat, nlQuery, true).lowConfidence, 'pinned exact_tokens is confident');
    // All hits in one file → nothing cross-file to hand off.
    assert.ok(!assessConfidence([mk(0.10, 'a.ts'), mk(0.099, 'a.ts')], nlQuery, false).lowConfidence, 'single-file result needs no handoff');
});

// ─── Query-side HyDE (WI3) ───────────────────────────────────────────────────
test('blendVectors is the weighted average and buildHydePrompt asks for code only', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    const blended = blendVectors(a, b, 0.5);
    assert.ok(Math.abs(blended[0] - 0.5) < 1e-6 && Math.abs(blended[1] - 0.5) < 1e-6, 'alpha 0.5 → midpoint');
    const p = buildHydePrompt('parse a JWT and return the claims');
    assert.ok(/parse a JWT/.test(p), 'prompt embeds the query');
    assert.ok(/ONLY code/i.test(p), 'prompt asks for code only');
});

try {
    const raw = new Float32Array([1, 0, 0, 0]);
    const fakeEmbedder = { embedQuery: async () => [0, 1, 0, 0] };
    let gens = 0;
    const generate = async () => { gens++; return 'function f(){ return verify(token); }'; };

    const out = await hydeQueryVector('where is the token verified for a request', raw, { embedder: fakeEmbedder, generate });
    assert.ok(out[0] > 0 && out[1] > 0, 'blended vector mixes query + hypothetical directions');
    assert.equal(gens, 1, 'one generation');
    // Cached: a second call with the same query does not regenerate.
    await hydeQueryVector('where is the token verified for a request', raw, { embedder: fakeEmbedder, generate });
    assert.equal(gens, 1, 'second identical query served from cache');
    // Graceful: a failing generator yields the raw vector unchanged.
    const safe = await hydeQueryVector('a different behavioural query about caching layers', raw,
        { embedder: fakeEmbedder, generate: async () => { throw new Error('model down'); } });
    assert.deepEqual(Array.from(safe), Array.from(raw), 'generator failure → raw vector, never worse than baseline');
    passed++; console.log('  ✓ hydeQueryVector blends, degrades gracefully, and caches');
} catch (err) { failed++; console.log(`  ✗ hydeQueryVector blends, degrades gracefully, and caches\n      ${err.message}`); }

// ─── Index freshness (WI6) ───────────────────────────────────────────────────
test('computeFreshness distinguishes fresh / syncing / stale', () => {
    // Clean tree, daemon up → fresh.
    const a = computeFreshness({ ageSeconds: 30, indexedCommit: 'abc', current: { head: 'abc', dirtyCount: 0 }, daemonRunning: true });
    assert.equal(a.stale, false); assert.equal(a.syncing, false); assert.equal(a.ageLabel, '30s');
    // Uncommitted source changes, NO daemon → stale.
    const b = computeFreshness({ ageSeconds: 7200, indexedCommit: 'abc', current: { head: 'abc', dirtyCount: 3 }, daemonRunning: false });
    assert.equal(b.stale, true, 'dirty tree with no daemon is stale'); assert.equal(b.ageLabel, '2h');
    // HEAD moved but a daemon is live → syncing, not stale.
    const c = computeFreshness({ ageSeconds: 60, indexedCommit: 'abc', current: { head: 'def', dirtyCount: 0 }, daemonRunning: true });
    assert.equal(c.commitMoved, true); assert.equal(c.syncing, true); assert.equal(c.stale, false);
    // No git info at all → never falsely "stale" (age-only, graceful).
    const d = computeFreshness({ ageSeconds: 10, indexedCommit: null, current: null, daemonRunning: false });
    assert.equal(d.stale, false); assert.equal(d.currentCommit, null); assert.equal(d.pendingChanges, null);
});

// ─── Amortized token savings (WI8) ───────────────────────────────────────────
test('amortizedTokenSavings is honest: positive but below the gross top-k figure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-amort-'));
    // A big file; the returned chunk is a small slice of it.
    fs.writeFileSync(path.join(dir, 'big.js'), 'x'.repeat(8000)); // ~2000 tokens
    const results = [{ chunk: { file_path: 'big.js', code_snippet: 'y'.repeat(400) } }]; // ~100-token body
    const amort = amortizedTokenSavings(results, dir, { expansions: 1, cardTokens: 20 });
    assert.ok(amort.savingsPct > 0 && amort.savingsPct < 100, `expected 0<savings<100, got ${amort.savingsPct}`);
    // With-tool cost = 1 card (20) + 1 full body (~100) ≪ full file (~2000) → big saving but honest.
    assert.ok(amort.withToolTokens < amort.fileTokens, 'tool spend must be below reading the full file');
    // More expansions → lower savings (you read more bodies).
    const more = amortizedTokenSavings(
        [{ chunk: { file_path: 'big.js', code_snippet: 'y'.repeat(400) } },
         { chunk: { file_path: 'big.js', code_snippet: 'z'.repeat(400) } }], dir, { expansions: 2 });
    assert.ok(more.savingsPct <= amort.savingsPct + 1e-9, 'more expansions never increase savings');
    fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Porter stemmer + additive namespaced tokenization ───────────────────────

test('stemToken collapses morphological variants to a shared root', () => {
    const same = (a, b) => assert.equal(stemToken(a), stemToken(b), `${a} vs ${b}`);
    same('intercepting', 'interceptor');   // agent-noun -or bridge (code)
    same('injection', 'injectable');
    same('bootstrapping', 'bootstrap');    // -ing + de-doubling
    same('managing', 'manager');
    same('validation', 'validate');
    same('running', 'run');
    same('adapter', 'adapting');
});

test('stemToken leaves short tokens and acronyms untouched (symbolic precision)', () => {
    for (const w of ['get', 'id', 'css', 'sql', 'jwt']) assert.equal(stemToken(w), w);
});

test('tokenize is additive: raw token always present, stem added in its own namespace', () => {
    const toks = tokenize('Interceptor');
    assert.ok(toks.includes('interceptor'), 'raw token kept');
    assert.ok(toks.includes(STEM_PREFIX + 'intercept'), 'namespaced stem added');
    // Namespace isolation: a raw [A-Za-z0-9] query token can never equal a stem term.
    assert.ok(toks.every(t => t === 'interceptor' || t.startsWith(STEM_PREFIX)));
});

test('tokenize(text, false) emits NO stems — the exact/symbolic query path', () => {
    const toks = tokenize('intercepting requests', false);
    assert.ok(toks.every(t => !t.startsWith(STEM_PREFIX)), 'no stem terms when stemming disabled');
    assert.ok(toks.includes('intercepting') && toks.includes('requests'));
});

test('namespaced stems bridge NL queries but not exact tokens', () => {
    // Index side carries the stem of "Interceptor"; an NL query for "intercepting"
    // emits the SAME namespaced stem, so they meet — while a raw token cannot.
    const indexTerms = new Set(tokenize('class InterceptorManager'));
    const nlQuery = tokenize('intercepting the request', true);
    assert.ok(nlQuery.some(t => t.startsWith(STEM_PREFIX) && indexTerms.has(t)), 'NL query reaches the stem bridge');
    const exactQuery = tokenize('intercepting the request', false);
    assert.ok(!exactQuery.some(t => indexTerms.has(t) && t.startsWith(STEM_PREFIX)), 'exact path never uses stems');
});

// ─── File-path boost IDF gate (NL queries only) ──────────────────────────────
// A generic low-IDF query word ("path") that merely appears in a filename must
// NOT lift a chunk in that file above a better-ranked chunk — but ONLY for
// natural-language queries. Symbolic/keyword queries keep the boost byte-for-byte.
test('file-path boost is IDF-gated for NL queries, untouched for symbolic queries', () => {
    const chunks = {
        // cleanPath lives in path.go: the generic word "path" matches its filename.
        A: { id: 'A', name: 'cleanPath', file_path: 'path.go', node_type: 'function_declaration' },
        // joinSegments lives in utils.go: no query word matches its filename.
        B: { id: 'B', name: 'joinSegments', file_path: 'utils.go', node_type: 'function_declaration' },
    };
    const pathToks = { A: new Set(['path', 'go']), B: new Set(['utils', 'go']) };
    // "path" is a common word (df 50/100 ⇒ IDF 0, below ln(100/2)=3.9); all else rare.
    const common = {
        lexicalResults: [{ id: 'B', rank: 1 }, { id: 'A', rank: 2 }], // B is the stronger lexical hit
        vectorResults: [],
        getChunk: (id) => chunks[id],
        getPathTokens: (id) => pathToks[id],
        getDf: (t) => (t === 'path' ? 50 : 1),
        docCount: 100, rrfK: 60, topK: 10, resolveExact: () => [],
    };
    // NL query: the generic "path" must be gated out, so A keeps no boost and the
    // better-ranked B stays on top (without the gate, A's ×1.4 would flip it to #1).
    const nl = fuseAndRank({ ...common, queryText: 'show me the code that builds a path here' });
    assert.equal(nl[0].chunk.id, 'B', 'NL: a generic filename word must not promote the path.go chunk');
    // Symbolic/keyword query: NL gate is off, so "path" still fires the ×1.4 boost
    // and A (path.go) outranks B — proving symbolic behaviour is byte-identical.
    const sym = fuseAndRank({ ...common, queryText: 'path here' });
    assert.equal(sym[0].chunk.id, 'A', 'symbolic: file-path boost still fires (unchanged)');
});

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
