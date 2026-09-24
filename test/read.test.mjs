/**
 * Reading code without searching for what it uses: read_code on symbols, ranges and files, the
 * "defined elsewhere" card, and the definition rescue of search_text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const long = Array.from({ length: 320 }, (_, i) => `export function f${i}(x: number) { return x + ${i}; }`).join('\n') + '\n';
const FILES = {
    'src/geometry.ts': `/** A point in the plane. */\nexport class Point {\n  constructor(public x: number, public y: number) {}\n  /** Distance to another point. */\n  distance(o: Point): number { return Math.hypot(this.x - o.x, this.y - o.y); }\n}\nexport function origin(): Point { return new Point(0, 0); }\n`,
    'src/route.ts': `import { Point, origin } from './geometry';\nexport function length(points: Point[]): number {\n  let total = 0;\n  for (let i = 1; i < points.length; i++) total += points[i - 1].distance(points[i]);\n  return total;\n}\nexport function fromOrigin(p: Point): number {\n  return origin().distance(p);\n}\n`,
    'src/route.test.ts': `import { length } from './route';\nimport { Point } from './geometry';\ntest('length', () => { expect(length([new Point(0, 0), new Point(3, 4)])).toBe(5); });\n`,
    'src/many.ts': long,
    // a Python package whose modules are reached as attributes of an alias (sqlglot's `exp.Column`)
    'pkg/__init__.py': 'from pkg import expressions as exp\n',
    'pkg/expressions/__init__.py': 'from pkg.expressions.core import *\nfrom pkg.expressions.more import *\n',
    'pkg/expressions/core.py': 'class Node:\n    """A tree node."""\n    def walk(self):\n        return []\n\nclass Column(Node):\n    pass\n',
    'pkg/expressions/more.py': 'class Column:\n    """Rebound by the later star import."""\n    pass\n',
    'pkg/parser.py': 'from pkg import exp\n\ndef parse(text):\n    node = exp.Node()\n    if isinstance(node, exp.Column):\n        return None\n    return node\n',
};

let root, intel;
test.before(async () => { root = makeRepo(FILES); intel = new CodeIntel({ root }); await intel.open(); });
test.after(() => { intel?.close(); rmrf(root); });

test('read_code on a symbol: its code, then where each name it uses is defined', async () => {
    const t = await callTool(intel, 'read_code', { targets: ['length'] });
    assert.match(t, /^length — function/);
    assert.match(t, /return total;/);
    const card = t.slice(t.indexOf('Defined elsewhere'));
    assert.match(card, /Point\.distance {2}src\/geometry\.ts:5 {2}distance\(o: Point\): number — Distance to another point\./);
    assert.match(card, /Point {2}src\/geometry\.ts:2 {2}(export )?class Point/);
    assert.doesNotMatch(card, /\blength\b/, 'the definition being read is not listed');
    assert.match(t, /tested in: \(module\) \(src\/route\.test\.ts:3\)|tested in: .*src\/route\.test\.ts:3/);
});

test('read_code on several targets does not list the same definition twice', async () => {
    const t = await callTool(intel, 'read_code', { targets: ['length', 'fromOrigin'] });
    const second = t.slice(t.indexOf('fromOrigin — function'));
    assert.match(second, /origin {2}src\/geometry\.ts:7/);
    assert.doesNotMatch(second, /Point\.distance {2}/, 'already listed for the first target');
});

test('read_code on a range names the enclosing definition; a long file comes back as its outline', async () => {
    const r = await callTool(intel, 'read_code', { targets: ['src/route.ts:3-4'] });
    assert.match(r, /^src\/route\.ts:3-4 — in length \(function, 2-6\)/);
    assert.match(r, /Point\.distance {2}src\/geometry\.ts:5/);
    const o = await callTool(intel, 'read_code', { targets: ['src/many.ts'] });
    assert.match(o, /src\/many\.ts — typescript, 32\d lines/);
    assert.match(o, /320 lines, so this is the outline/);
    const full = await callTool(intel, 'read_code', { targets: ['src/many.ts'], full: true });
    assert.match(full, /f319\(x: number\)/);
    const small = await callTool(intel, 'read_code', { targets: ['src/geometry.ts'] });
    assert.match(small, /^src\/geometry\.ts — 7 lines/);
});

test('Python: names reached through a package alias resolve through its star re-exports', async () => {
    const t = await callTool(intel, 'read_code', { targets: ['pkg/parser.py:parse'] });
    const card = t.slice(t.indexOf('Defined elsewhere'));
    assert.match(card, /Node {2}pkg\/expressions\/core\.py:1 {2}class Node/);
    // the later `from … import *` rebinds Column
    assert.match(card, /Column {2}pkg\/expressions\/more\.py:1/);
    const refs = await callTool(intel, 'find_references', { symbol: 'pkg/expressions/core.py:Node' });
    assert.match(refs, /pkg\/parser\.py/);
});

test('search_text says where a definition is when the search did not find it', async () => {
    const miss = await callTool(intel, 'search_text', { pattern: 'class Point', path: 'src/route.ts' });
    assert.match(miss, /No matches[\s\S]*Not found here, but "Point" is defined:\n {2}Point {2}src\/geometry\.ts:2/);
    const uses = await callTool(intel, 'search_text', { pattern: '\\bdistance\\(', path: 'src/route.ts' });
    assert.match(uses, /None of these matches is where "distance" is defined:\n {2}Point\.distance {2}src\/geometry\.ts:5/);
    const found = await callTool(intel, 'search_text', { pattern: 'class Point' });
    assert.doesNotMatch(found, /is defined:/);
});

test('call_graph: a constructor is reached through its class only in languages where it is one; a recursive function is its own caller', async () => {
    const dir = makeRepo({
        // TypeScript: `initialize` is an ordinary method, called here by the constructor only
        'src/box.ts': `export class Box {\n  constructor(v: number) { this.initialize(v); }\n  initialize(v: number) { return v; }\n}\nexport function make() { return new Box(1); }\n`,
        // Ruby: `initialize` is the constructor, run by `Box.new`
        'lib/box.rb': `class Crate\n  def initialize(v)\n    @v = v\n  end\nend\n\ndef build\n  Crate.new(1)\nend\n`,
        'src/walk.js': `function walk(n) { if (n) walk(n - 1); }\nfunction start() { walk(3); }\nmodule.exports = { start };\n`,
    });
    const i = new CodeIntel({ root: dir });
    await i.open();
    try {
        const ts = await callTool(i, 'call_graph', { symbol: 'Box.initialize', direction: 'callers', depth: 1 });
        assert.match(ts, /← Box\.constructor {2}src\/box\.ts:2/);
        assert.doesNotMatch(ts, /← make\b/, 'new Box() runs the constructor, not initialize');
        const rb = await callTool(i, 'call_graph', { symbol: 'Crate.initialize', direction: 'callers', depth: 1 });
        assert.match(rb, /← build {2}lib\/box\.rb:7/);
        const rec = await callTool(i, 'call_graph', { symbol: 'walk', direction: 'callers', depth: 1 });
        assert.match(rec, /callers \(2 distinct/);
        assert.match(rec, /\n {2}← walk {2}src\/walk\.js:1 {2}\(itself: recursive\)\n {2}← start {2}src\/walk\.js:2/);
    } finally { i.close(); rmrf(dir); }
});

test('a map built with type arguments hands back its values: `new Map<K, V>().get(k)` is a V', async () => {
    const dir = makeRepo({
        'src/registry.ts': `export class Wrapper {\n  merge(o: object) { return o; }\n}\nexport class Other {\n  merge(o: object) { return o; }\n}\nexport class Registry {\n  private readonly items = new Map<string, Wrapper>();\n  replace(key: string) {\n    const w = this.items.get(key);\n    return w.merge({});\n  }\n}\n`,
    });
    const i = new CodeIntel({ root: dir });
    await i.open();
    try {
        const refs = await callTool(i, 'find_references', { symbol: 'Wrapper.merge' });
        assert.match(refs, /11 {2}call +in Registry\.replace/);
        assert.doesNotMatch(await callTool(i, 'find_references', { symbol: 'Other.merge' }), /Registry\.replace/);
    } finally { i.close(); rmrf(dir); }
});

test('call_graph lists every caller of every node, expanding each at its shallowest level', async () => {
    const dir = makeRepo({
        'src/chain.js': `function target() {}\nfunction x() { target(); y(); }\nfunction y() { target(); }\nfunction z() { x(); }\nmodule.exports = { x, y, z };\n`,
        'test/chain.test.js': `const { x } = require('../src/chain');\ntest('x', () => { x(); });\n`,
    });
    const i = new CodeIntel({ root: dir });
    await i.open();
    try {
        const t = await callTool(i, 'call_graph', { symbol: 'target', direction: 'callers', depth: 2, include_tests: false });
        assert.match(t, /callers \(4 distinct, depth ≤ 2, tests left out/); // x, y, z and the module's exports
        // x is a direct caller (level 1) and also calls y: expanded under itself, marked under y
        assert.match(t, /\n {2}← x {2}src\/chain\.js:2\n {4}← z {2}src\/chain\.js:4\n/);
        assert.match(t, /\n {2}← y {2}src\/chain\.js:3\n {4}← x {2}src\/chain\.js:2 {2}\(also listed elsewhere\)/);
        assert.doesNotMatch(t, /chain\.test\.js/);
        assert.match(t, /Complete: every call the index binds is listed/);
    } finally { i.close(); rmrf(dir); }
});
