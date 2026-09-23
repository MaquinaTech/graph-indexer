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
