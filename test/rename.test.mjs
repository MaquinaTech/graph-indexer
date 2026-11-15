/**
 * rename_symbol: the edits an IDE's rename makes, from the index — the definition, its family,
 * the references bound to them and the imports that name it; nothing that only shares the name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { renameSymbol } from '../src/query/rename.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

async function withRepo(files, fn) {
    const root = makeRepo(files);
    const intel = new CodeIntel({ root });
    await intel.open();
    try { return await fn({ root, intel, read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8') }); }
    finally { intel.close(); rmrf(root); }
}

const TS = {
    'src/sender.ts': `export interface Sender {\n  send(msg: string): void;\n}\n\nexport class TcpSender implements Sender {\n  send(msg: string) { console.log(msg); }\n}\n\nexport class UdpSender implements Sender {\n  send(msg: string) { console.log(msg); }\n}\n`,
    'src/mailer.ts': `export class Mailer {\n  send(to: string) { return to; }\n}\n`,
    'src/app.ts': `import { Sender, TcpSender } from './sender';\nimport { Mailer } from './mailer';\n\nexport function run(s: Sender, t: TcpSender, m: Mailer, anything: any) {\n  s.send('a');\n  t.send('b');\n  m.send('c');\n  anything.send('d');\n}\n`,
    'src/app.spec.ts': `import { TcpSender } from './sender';\n\ndescribe('TcpSender', () => {\n  it('sends', () => {\n    const t = new TcpSender();\n    jest.spyOn(t, 'send');\n    t.send('x');\n  });\n});\n`,
};

test('a method is renamed with the interface it implements and its sibling implementation; another class keeps its own', () => withRepo(TS, async ({ intel, read }) => {
    const text = await callTool(intel, 'rename_symbol', { symbol: 'TcpSender.send', new_name: 'transmit', apply: true }, { cli: true });
    assert.match(text, /Renamed TcpSender\.send → transmit: 6 edits written in 3 files/, text);
    assert.match(read('src/sender.ts'), /transmit\(msg: string\): void;[\s\S]*class TcpSender[\s\S]*transmit\(msg: string\) \{[\s\S]*class UdpSender[\s\S]*transmit\(msg: string\) \{/);
    assert.equal(read('src/mailer.ts'), TS['src/mailer.ts'], 'Mailer.send is another method');
    const app = read('src/app.ts');
    assert.match(app, /s\.transmit\('a'\);\n  t\.transmit\('b'\);\n  m\.send\('c'\);\n  anything\.send\('d'\);/, app);
    assert.match(read('src/app.spec.ts'), /t\.transmit\('x'\)/);
    // what it could not bind is named, not edited
    assert.match(text, /not edited — check these by hand:[\s\S]*src\/app\.ts:8[\s\S]*src\/app\.spec\.ts:6\s+names it in a string/, text);
    assert.match(text, /renamed with it, so overrides keep matching: .*Sender\.send.*UdpSender\.send/, text);
    // the index follows the files it wrote, and the checker finds nothing broken
    const check = await callTool(intel, 'check_changes', {});
    assert.match(check, /No problems found/, check);
    assert.equal(intel.findSymbols('TcpSender.transmit').matches.length, 1);
}));

test('without apply nothing is written; the edits are listed', () => withRepo(TS, async ({ intel, read }) => {
    const text = await callTool(intel, 'rename_symbol', { symbol: 'TcpSender.send', new_name: 'transmit' }, { cli: true });
    assert.match(text, /Rename TcpSender\.send → transmit: 6 edits in 3 files, not written \(`graph-indexer rename TcpSender\.send transmit --write` writes them\)/, text);
    assert.match(text, /src\/app\.ts \(2\)\n\s+5\s+call\s+│ s\.transmit\('a'\);/, text);
    for (const f of Object.keys(TS)) assert.equal(read(f), TS[f]);
}));

test('over MCP a rename is written only when asked to apply, and never by a server started read-only', () => withRepo(TS, async ({ intel, read }) => {
    const listed = await callTool(intel, 'rename_symbol', { symbol: 'TcpSender.send', new_name: 'transmit' });
    assert.match(listed, /6 edits in 3 files, not written \(call rename_symbol again with apply: true to write them\)/, listed);
    const refused = await callTool(intel, 'rename_symbol', { symbol: 'TcpSender.send', new_name: 'transmit', apply: true }, { readOnly: true });
    assert.match(refused, /6 edits in 3 files, not written \(this server is read-only, so nothing was written/, refused);
    for (const f of Object.keys(TS)) assert.equal(read(f), TS[f]);
    const done = await callTool(intel, 'rename_symbol', { symbol: 'TcpSender.send', new_name: 'transmit', apply: true });
    assert.match(done, /6 edits written in 3 files/, done);
    assert.notEqual(read(Object.keys(TS)[0]), TS[Object.keys(TS)[0]]);
}));

test('a function is renamed in its import statements, through a barrel and under an alias', () => withRepo({
    'lib/format.ts': `export function formatDate(d: Date) { return d.toISOString(); }\nexport const stamp = () => formatDate(new Date());\n`,
    'lib/index.ts': `export { formatDate } from './format';\n`,
    'src/a.ts': `import { formatDate } from '../lib';\nexport const a = formatDate(new Date());\n`,
    'src/b.ts': `import {\n  formatDate as fmt,\n} from '../lib/format';\nexport const b = fmt(new Date());\n`,
    'src/c.ts': `function formatDate(x: number) { return x; }\nexport const c = formatDate(1);\n`,
}, async ({ intel, read }) => {
    const r = await renameSymbol(intel, { symbol: 'lib/format.ts:formatDate', newName: 'toIsoDate', apply: true });
    assert.equal(r.error, undefined);
    assert.equal(read('lib/format.ts'), `export function toIsoDate(d: Date) { return d.toISOString(); }\nexport const stamp = () => toIsoDate(new Date());\n`);
    assert.equal(read('lib/index.ts'), `export { toIsoDate } from './format';\n`);
    assert.equal(read('src/a.ts'), `import { toIsoDate } from '../lib';\nexport const a = toIsoDate(new Date());\n`);
    assert.equal(read('src/b.ts'), `import {\n  toIsoDate as fmt,\n} from '../lib/format';\nexport const b = fmt(new Date());\n`);
    assert.equal(read('src/c.ts'), `function formatDate(x: number) { return x; }\nexport const c = formatDate(1);\n`, 'a local function of the same name is another definition');
    const check = await callTool(intel, 'check_changes', {});
    assert.match(check, /No problems found/, check);
}));

test('Python: a function renamed across modules; a method through the class that inherits it', () => withRepo({
    'pkg/__init__.py': '',
    'pkg/shapes.py': `class Shape:\n    def area(self):\n        return 0\n\n\nclass Square(Shape):\n    def __init__(self, side):\n        self.side = side\n\n    def area(self):\n        return self.side ** 2\n\n\ndef describe(shape: Shape):\n    return shape.area()\n`,
    'pkg/report.py': `from pkg.shapes import Square, describe\n\n\nclass Table:\n    def area(self):\n        return 1\n\n\ndef total(sq: Square, table: Table):\n    return sq.area() + table.area() + len(describe(sq))\n`,
}, async ({ intel, read }) => {
    let r = await renameSymbol(intel, { symbol: 'Square.area', newName: 'surface', apply: true });
    assert.equal(r.error, undefined);
    assert.match(read('pkg/shapes.py'), /class Shape:\n    def surface\(self\):[\s\S]*class Square\(Shape\):[\s\S]*    def surface\(self\):[\s\S]*return shape\.surface\(\)/);
    assert.match(read('pkg/report.py'), /def area\(self\):\n        return 1[\s\S]*return sq\.surface\(\) \+ table\.area\(\)/, read('pkg/report.py'));
    r = await renameSymbol(intel, { symbol: 'describe', newName: 'summarize', apply: true });
    assert.equal(r.error, undefined);
    assert.match(read('pkg/report.py'), /from pkg\.shapes import Square, summarize[\s\S]*len\(summarize\(sq\)\)/);
}));

test('a name already taken, an ambiguous target and a constructor are refused with the reason', () => withRepo(TS, async ({ intel, read }) => {
    let text = await callTool(intel, 'rename_symbol', { symbol: 'send', new_name: 'transmit', apply: true }, { cli: true });
    assert.match(text, /"send" names 4 definitions; say which one/, text);
    await withRepo({ 'a.ts': `export class Box {\n  open() {}\n  close() {}\n}\nnew Box().open();\n` }, async ({ intel: i2, read: r2 }) => {
        const t2 = await callTool(i2, 'rename_symbol', { symbol: 'Box.open', new_name: 'close', apply: true }, { cli: true });
        assert.match(t2, /Not renamed: close is already taken where Box\.open lives or is used/, t2);
        assert.match(r2('a.ts'), /open\(\) \{\}/);
    });
    for (const f of Object.keys(TS)) assert.equal(read(f), TS[f]);
}));

test('the module path of an import is a file name, not the definition: it is left alone', () => withRepo({
    'src/parse.ts': `export function parse(s: string) { return s; }\n`,
    'src/app.ts': `import { parse } from './parse';\nexport const v = parse('x');\n`,
    'pkg/__init__.py': '',
    'pkg/render.py': `def render(x):\n    return x\n`,
    'pkg/use.py': `from pkg.render import render\n\n\ndef go():\n    return render(1)\n`,
}, async ({ intel, read }) => {
    let r = await renameSymbol(intel, { symbol: 'src/parse.ts:parse', newName: 'parseText', apply: true });
    assert.equal(r.error, undefined);
    assert.equal(read('src/app.ts'), `import { parseText } from './parse';\nexport const v = parseText('x');\n`);
    r = await renameSymbol(intel, { symbol: 'pkg/render.py:render', newName: 'draw', apply: true });
    assert.equal(r.error, undefined);
    assert.equal(read('pkg/use.py'), `from pkg.render import draw\n\n\ndef go():\n    return draw(1)\n`);
}));

test('a new name already bound in a file that uses the definition is a conflict, not a second binding', () => withRepo({
    'a.ts': `export function foo() { return 1; }\n`,
    'b.ts': `import { foo } from './a';\nconst bar = 2;\nexport const y = foo() + bar;\n`,
    'c.ts': `import { foo } from './a';\nimport { baz } from './d';\nexport const z = foo() + baz;\n`,
    'd.ts': `export const baz = 3;\n`,
}, async ({ intel, read }) => {
    let text = await callTool(intel, 'rename_symbol', { symbol: 'a.ts:foo', new_name: 'bar', apply: true }, { cli: true });
    assert.match(text, /Not renamed: bar is already taken[^\n]*b\.ts:2/, text);
    text = await callTool(intel, 'rename_symbol', { symbol: 'a.ts:foo', new_name: 'baz', apply: true }, { cli: true });
    assert.match(text, /Not renamed: baz is already taken[^\n]*baz \(imported\), c\.ts:2/, text);
    assert.equal(read('b.ts'), `import { foo } from './a';\nconst bar = 2;\nexport const y = foo() + bar;\n`);
}));

// ── review fixes ─────────────────────────────────────────────────────────────────────────────

/** Like withRepo, but the index is not re-synced by itself: a file edited after `open` stays stale. */
async function withFrozenRepo(files, fn) {
    const root = makeRepo(files);
    const intel = new CodeIntel({ root, watch: false });
    await intel.open();
    intel.lastSweep = Date.now();
    try { return await fn({ root, intel, read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8') }); }
    finally { intel.close(); rmrf(root); }
}

test('R1: a file edited after the last sync is re-indexed before the edits are computed; the right call is renamed', () => withFrozenRepo({
    'src/s.ts': `export class Tcp { send(x: string) {} }\nexport class Mail { send(x: string) {} }\n`,
    'src/app.ts': `import { Tcp, Mail } from './s';\nexport function run(t: Tcp, m: Mail) {\n  m.send('mail');\n  t.send('tcp');\n}\n`,
}, async ({ root, intel, read }) => {
    const app = path.join(root, 'src/app.ts');
    fs.writeFileSync(app, `// a new first line\n` + fs.readFileSync(app, 'utf8'));
    const r = await renameSymbol(intel, { symbol: 'Tcp.send', newName: 'transmit', apply: true });
    assert.equal(r.error, undefined);
    assert.match(read('src/app.ts'), /m\.send\('mail'\);\n  t\.transmit\('tcp'\);/, read('src/app.ts'));
    assert.match(read('src/s.ts'), /class Tcp \{ transmit\(/);
    assert.match(read('src/s.ts'), /class Mail \{ send\(/);
}));

test('R1: a file that changes between the plan and the write is refused, nothing is written', () => withFrozenRepo({
    'a.ts': `export function foo() { return 1; }\n`,
    'b.ts': `import { foo } from './a';\nexport const y = foo();\n`,
}, async ({ root, intel, read }) => {
    const orig = intel.ix.staleAmong.bind(intel.ix);
    let calls = 0;
    // the file changes after the plan and before the write (the check of the files about to be written)
    intel.ix.staleAmong = (ps) => { if (++calls === 1) fs.writeFileSync(path.join(root, 'b.ts'), `// x\n` + read('b.ts')); return orig(ps); };
    const r = await renameSymbol(intel, { symbol: 'foo', newName: 'bar', apply: true });
    assert.equal(r.applied, false);
    assert.match(r.error ?? r.notWritten ?? '', /changed/);
    assert.equal(read('a.ts'), `export function foo() { return 1; }\n`);
}));

test('R10: an edit that does not verify against the file stops the write; nothing is written', () => withRepo({
    'a.ts': `export function foo() { return 1; }\n`,
    'b.ts': `import { foo } from './a';\nexport const y = foo();\n`,
}, async ({ intel, read }) => {
    intel.store.run('UPDATE refs SET col = col + 40, line = line + 5 WHERE kind = ?', 'call');
    const r = await renameSymbol(intel, { symbol: 'foo', newName: 'bar', apply: true });
    assert.equal(r.applied, false);
    assert.match(r.notWritten ?? '', /could not be verified/);
    assert.equal(read('a.ts'), `export function foo() { return 1; }\n`);
    assert.equal(read('b.ts'), `import { foo } from './a';\nexport const y = foo();\n`);
    const text = await callTool(intel, 'rename_symbol', { symbol: 'foo', new_name: 'bar', apply: true }, { cli: true });
    assert.match(text, /not written/i, text);
    assert.doesNotMatch(text, /^Renamed/m, text);
}));

test('R10: a file swapped for a symlink after the plan is not written through', () => withFrozenRepo({
    'a.ts': `export function foo() { return 1; }\n`,
    'b.ts': `import { foo } from './a';\nexport const y = foo();\n`,
}, async ({ root, intel, read }) => {
    const target = path.join(path.dirname(root), `gi-outside-${path.basename(root)}.ts`);
    fs.writeFileSync(target, `import { foo } from './a';\nexport const y = foo();\n`);
    try {
        const orig = intel.ix.staleAmong.bind(intel.ix);
        // the swap happens after the check that the index is current
        intel.ix.staleAmong = (ps) => { const r = orig(ps); fs.rmSync(path.join(root, 'b.ts')); fs.symlinkSync(target, path.join(root, 'b.ts')); return r; };
        const r = await renameSymbol(intel, { symbol: 'foo', newName: 'bar', apply: true });
        assert.equal(r.applied, false);
        assert.match(r.notWritten ?? '', /outside the repository root|not a regular file/);
        assert.equal(fs.readFileSync(target, 'utf8'), `import { foo } from './a';\nexport const y = foo();\n`);
        assert.equal(read('a.ts'), `export function foo() { return 1; }\n`);
    } finally { fs.rmSync(target, { force: true }); }
}));

test('R9: a read-only file among the ones to edit stops the write before any file is touched', () => withRepo({
    'a/def.ts': `export function foo() { return 1; }\n`,
    'b/u.ts': `import { foo } from '../a/def';\nexport const u = foo();\n`,
    'c/v.ts': `import { foo } from '../a/def';\nexport const v = foo();\n`,
}, async ({ root, intel, read }) => {
    fs.chmodSync(path.join(root, 'b/u.ts'), 0o444);
    try {
        const r = await renameSymbol(intel, { symbol: 'foo', newName: 'bar', apply: true });
        assert.equal(r.applied, false);
        assert.match(r.error ?? r.notWritten ?? '', /b\/u\.ts/);
        assert.equal(read('a/def.ts'), `export function foo() { return 1; }\n`);
        assert.equal(read('c/v.ts'), `import { foo } from '../a/def';\nexport const v = foo();\n`);
    } finally { fs.chmodSync(path.join(root, 'b/u.ts'), 0o644); }
}));

test('R2a: the closing tag of a JSX element follows its opening tag', () => withRepo({
    'Button.tsx': `export function Button(p: { label: string }) { return <button>{p.label}</button>; }\n`,
    'app.tsx': `import { Button } from './Button';\nexport const A = () => <div><Button label="b"></Button><Button label="c" /></div>;\n`,
}, async ({ intel, read }) => {
    const r = await renameSymbol(intel, { symbol: 'Button', newName: 'Btn', apply: true });
    assert.equal(r.error, undefined);
    assert.equal(read('app.tsx'), `import { Btn } from './Button';\nexport const A = () => <div><Btn label="b"></Btn><Btn label="c" /></div>;\n`);
}));

test('R2b: the setter and deleter decorators of a renamed Python property are renamed with it', () => withRepo({
    'pkg/__init__.py': '',
    'pkg/t.py': `class T:\n    @property\n    def value(self):\n        return self._v\n\n    @value.setter\n    def value(self, v):\n        self._v = v\n\n    @value.deleter\n    def value(self):\n        del self._v\n`,
    'pkg/use.py': `from pkg.t import T\n\n\ndef go(t: T):\n    t.value = 3\n    return t.value\n`,
}, async ({ intel, read }) => {
    const r = await renameSymbol(intel, { symbol: 'T.value', newName: 'amount', apply: true });
    assert.equal(r.error, undefined);
    const t = read('pkg/t.py');
    assert.match(t, /@amount\.setter\n    def amount\(self, v\)/, t);
    assert.match(t, /@amount\.deleter\n    def amount\(self\)/, t);
    assert.doesNotMatch(t, /value/, t);
}));

test('R2c: the exports of the defining file follow the rename; in `export { old as alias }` only old changes', async () => {
    await withRepo({ 'a.ts': `function formatDate() { return 1; }\nexport default formatDate;\n` }, async ({ intel, read }) => {
        const r = await renameSymbol(intel, { symbol: 'formatDate', newName: 'toIso', apply: true });
        assert.equal(r.error, undefined);
        assert.equal(read('a.ts'), `function toIso() { return 1; }\nexport default toIso;\n`);
    });
    await withRepo({ 'a.ts': `function formatDate() { return 1; }\nexport { formatDate };\n`, 'b.ts': `import { formatDate } from './a';\nexport const b = formatDate();\n` }, async ({ intel, read }) => {
        const r = await renameSymbol(intel, { symbol: 'a.ts:formatDate', newName: 'toIso', apply: true });
        assert.equal(r.error, undefined);
        assert.equal(read('a.ts'), `function toIso() { return 1; }\nexport { toIso };\n`);
        assert.equal(read('b.ts'), `import { toIso } from './a';\nexport const b = toIso();\n`);
    });
    await withRepo({ 'a.ts': `function formatDate() { return 1; }\nexport { formatDate as fmt };\n` }, async ({ intel, read }) => {
        const r = await renameSymbol(intel, { symbol: 'formatDate', newName: 'toIso', apply: true });
        assert.equal(r.error, undefined);
        assert.equal(read('a.ts'), `function toIso() { return 1; }\nexport { toIso as fmt };\n`);
    });
});

test('R2d: a shorthand property in an object expression keeps its key; the CommonJS export list follows the rename on both sides', async () => {
    await withRepo({ 'a.ts': `export function formatDate() { return 1; }\n`, 'b.ts': `import { formatDate } from './a';\nexport const api = { formatDate };\n` }, async ({ intel, read }) => {
        const r = await renameSymbol(intel, { symbol: 'formatDate', newName: 'toIso', apply: true });
        assert.equal(r.error, undefined);
        assert.equal(read('b.ts'), `import { toIso } from './a';\nexport const api = { formatDate: toIso };\n`);
    });
    await withRepo({
        'a.js': `function formatDate() { return 1; }\nmodule.exports = { formatDate };\n`,
        'b.js': `const { formatDate } = require('./a');\nexports.x = formatDate();\n`,
    }, async ({ intel, read }) => {
        const r = await renameSymbol(intel, { symbol: 'a.js:formatDate', newName: 'toIso', apply: true });
        assert.equal(r.error, undefined);
        assert.equal(read('a.js'), `function toIso() { return 1; }\nmodule.exports = { toIso };\n`);
        assert.equal(read('b.js'), `const { toIso } = require('./a');\nexports.x = toIso();\n`);
    });
});

test('R2e: Go: an exported name that would become unexported while another package uses it is a conflict', () => withRepo({
    'go.mod': `module ex\n\ngo 1.21\n`,
    'a/a.go': `package a\n\nfunc Sum(x int) int { return x }\n`,
    'main.go': `package main\n\nimport "ex/a"\n\nfunc main() { _ = a.Sum(1) }\n`,
}, async ({ intel, read }) => {
    let r = await renameSymbol(intel, { symbol: 'Sum', newName: 'sum', apply: true });
    assert.ok(r.error || r.conflicts.length, 'refused');
    assert.equal(r.applied, false);
    assert.equal(read('a/a.go'), `package a\n\nfunc Sum(x int) int { return x }\n`);
    r = await renameSymbol(intel, { symbol: 'Sum', newName: 'Total', apply: true });
    assert.equal(r.applied, true);
    assert.match(read('main.go'), /a\.Total\(1\)/);
}));

test('R3: a member renamed to a name declared in a supertype or subtype is a conflict', async () => {
    await withRepo({ 'a.ts': `export class Base { close() {} }\nexport class Sub extends Base { shut() {} }\nexport class Leaf extends Sub { open() {} }\n` }, async ({ intel, read }) => {
        let r = await renameSymbol(intel, { symbol: 'Sub.shut', newName: 'close', apply: true });
        assert.equal(r.applied, false);
        assert.ok(r.conflicts.length, 'supertype member');
        r = await renameSymbol(intel, { symbol: 'Base.close', newName: 'open', apply: true });
        assert.equal(r.applied, false);
        assert.ok(r.conflicts.length, 'subtype member');
        assert.match(read('a.ts'), /class Base \{ close\(\) \{\} \}/);
    });
});

test('R3: a new name that is a bare identifier inside the enclosing definition of an edit is a conflict; a member access is not', async () => {
    await withRepo({ 'pkg/__init__.py': '', 'pkg/h.py': `def helper(x):\n    return x\n\n\ndef run(fmt):\n    return helper(fmt)\n` }, async ({ intel, read }) => {
        const r = await renameSymbol(intel, { symbol: 'helper', newName: 'fmt', apply: true });
        assert.equal(r.applied, false);
        assert.ok(r.conflicts.length);
        assert.match(read('pkg/h.py'), /return helper\(fmt\)/);
    });
    await withRepo({ 'a.ts': `export class K { go() { return 1; } }\nexport function run(k: K, stop: number) { return k.go() + stop; }\n` }, async ({ intel, read }) => {
        const r = await renameSymbol(intel, { symbol: 'K.go', newName: 'stop', apply: true });
        assert.equal(r.applied, true, JSON.stringify(r.conflicts));
        assert.match(read('a.ts'), /k\.stop\(\) \+ stop/);
    });
});

test('R12: a reserved word or a name of the wrong shape for the language is refused', async () => {
    await withRepo({ 'pkg/__init__.py': '', 'pkg/h.py': `def helper(x):\n    return x\n` }, async ({ intel }) => {
        for (const n of ['class', 'def', 'None', 'ok?', '1x']) assert.ok((await renameSymbol(intel, { symbol: 'helper', newName: n })).error, n);
        assert.equal((await renameSymbol(intel, { symbol: 'helper', newName: 'assist' })).error, undefined);
    });
    await withRepo({ 'a.ts': `export function helper() {}\n` }, async ({ intel }) => {
        for (const n of ['ok?', 'bang!', 'delete', 'class', 'a-b']) assert.ok((await renameSymbol(intel, { symbol: 'helper', newName: n })).error, n);
        assert.equal((await renameSymbol(intel, { symbol: 'helper', newName: 'def' })).error, undefined);
    });
    await withRepo({ 'a.rb': `def helper\n  1\nend\n` }, async ({ intel }) => {
        assert.equal((await renameSymbol(intel, { symbol: 'helper', newName: 'ok?' })).error, undefined);
        assert.ok((await renameSymbol(intel, { symbol: 'helper', newName: 'end' })).error);
    });
});

test('R13a: a Python import continued with a backslash is edited on its continuation line', () => withRepo({
    'pkg/__init__.py': '',
    'pkg/m.py': `def other():\n    return 1\n\n\ndef helper():\n    return 2\n`,
    'pkg/use.py': `from pkg.m import other, \\\n    helper\n\n\ndef go():\n    return other() + helper()\n`,
}, async ({ intel, read }) => {
    const r = await renameSymbol(intel, { symbol: 'pkg/m.py:helper', newName: 'assist', apply: true });
    assert.equal(r.error, undefined);
    assert.equal(read('pkg/use.py'), `from pkg.m import other, \\\n    assist\n\n\ndef go():\n    return other() + assist()\n`);
}));

test('R13b: a position that is edited is not listed again as "not edited — names it in a string"', () => withRepo({
    'pkg/__init__.py': '',
    'pkg/m.py': `__all__ = ["helper"]\n\n\ndef helper():\n    return 2\n`,
}, async ({ intel, read }) => {
    const text = await callTool(intel, 'rename_symbol', { symbol: 'helper', new_name: 'assist', apply: true }, { cli: true });
    assert.equal(read('pkg/m.py'), `__all__ = ["assist"]\n\n\ndef assist():\n    return 2\n`);
    assert.doesNotMatch(text, /names it in a string/, text);
}));

test('nits: mixed line endings are kept line by line; the file count is the files written', () => withRepo({
    'a.ts': `export function foo() { return 1; }\r\nexport const a = 1;\n`,
    'b.ts': `import { foo } from './a';\nexport const y = foo();\r\nexport const z = 2;\r\n`,
}, async ({ intel, read }) => {
    const text = await callTool(intel, 'rename_symbol', { symbol: 'foo', new_name: 'bar', apply: true }, { cli: true });
    assert.equal(read('a.ts'), `export function bar() { return 1; }\r\nexport const a = 1;\n`);
    assert.equal(read('b.ts'), `import { bar } from './a';\nexport const y = bar();\r\nexport const z = 2;\r\n`);
    assert.match(text, /3 edits written in 2 files/, text);
}));

// ── found by the independent review of 3.2.0 ─────────────────────────────────────

test('review: a link planted at a temporary name the writer could use is never written through', () => withRepo({
    'src/a.ts': `export function greet(name: string) { return 'hi ' + name; }\n`,
    'src/b.ts': `import { greet } from './a';\nexport const x = greet('bob');\n`,
}, async ({ root, intel, read }) => {
    const outside = makeRepo({ 'victim.txt': 'VICTIM ORIGINAL' });
    try {
        const victim = path.join(outside, 'victim.txt');
        fs.chmodSync(victim, 0o600);
        // the names 3.2.0's first cut used (pid-based) and a spread of others
        for (const f of ['a.ts', 'b.ts']) fs.symlinkSync(victim, path.join(root, 'src', `.${f}.gi-rename-${process.pid}.tmp`));
        const text = await callTool(intel, 'rename_symbol', { symbol: 'greet', new_name: 'hello', apply: true }, { cli: true });
        assert.match(text, /3 edits written in 2 files/, text);
        assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM ORIGINAL');
        if (process.platform !== 'win32') assert.equal(fs.statSync(victim).mode & 0o777, 0o600); // Windows has no such modes
        for (const f of ['src/a.ts', 'src/b.ts']) assert.ok(fs.lstatSync(path.join(root, f)).isFile(), `${f} is still a regular file`);
        assert.match(read('src/b.ts'), /hello\('bob'\)/);
    } finally { rmrf(outside); }
}));

test('review: a CLI query answered by a read-only server writes nothing', () => withRepo(TS, async ({ intel, read }) => {
    const text = await callTool(intel, 'rename_symbol', { symbol: 'TcpSender.send', new_name: 'transmit', apply: true }, { cli: true, readOnly: true });
    assert.match(text, /not written \(the MCP server that answers for this repository was started read-only, so nothing was written; stop it, or run this with GRAPH_INDEXER_RESIDENT=0/, text);
    for (const f of Object.keys(TS)) assert.equal(read(f), TS[f]);
}));

test('review: a file that is not valid UTF-8 is refused, its bytes untouched', () => withRepo({
    'src/a.ts': `export function bar(n: number) { return n; }\n`,
    'src/b.ts': `import { bar } from './a';\nexport const t = bar(2);\n`,
}, async ({ root, intel }) => {
    const bytes = Buffer.concat([Buffer.from(`import { bar } from './a';\n// caf`), Buffer.from([0xe9]), Buffer.from(` latin-1\nexport const t = bar(2);\n`)]);
    fs.writeFileSync(path.join(root, 'src/b.ts'), bytes);
    const r = await renameSymbol(intel, { symbol: 'bar', newName: 'zz', apply: true });
    assert.equal(r.applied, false);
    assert.match(r.notWritten ?? '', /src\/b\.ts is not valid UTF-8/);
    assert.ok(fs.readFileSync(path.join(root, 'src/b.ts')).equals(bytes));
    assert.equal(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8'), `export function bar(n: number) { return n; }\n`);
}));

test('review: a Rust trait method is renamed with its impls, from either side', async () => {
    const files = { 'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n', 'src/lib.rs': `pub trait Speak { fn say(&self) -> u8; }\npub struct Dog;\nimpl Speak for Dog { fn say(&self) -> u8 { 1 } }\nfn run(d: &Dog) -> u8 { d.say() }\nfn gen<T: Speak>(t: &T) -> u8 { t.say() }\n` };
    const want = `pub trait Speak { fn talk(&self) -> u8; }\npub struct Dog;\nimpl Speak for Dog { fn talk(&self) -> u8 { 1 } }\nfn run(d: &Dog) -> u8 { d.talk() }\nfn gen<T: Speak>(t: &T) -> u8 { t.talk() }\n`;
    for (const symbol of ['Speak.say', 'Dog.say']) await withRepo(files, async ({ intel, read }) => {
        const r = await renameSymbol(intel, { symbol, newName: 'talk', apply: true });
        assert.equal(r.error, undefined, r.error);
        assert.equal(read('src/lib.rs'), want, symbol);
    });
});

test('review: a use of the name that is not a call (a namespace member as a value) is listed, not claimed bound', () => withRepo({
    'src/i.ts': `export function total(a: number) { return a; }\n`,
    'src/u.ts': `import * as I from './i';\nexport const f = I.total;\nexport const g = I.total(1);\n`,
}, async ({ intel }) => {
    const text = await callTool(intel, 'rename_symbol', { symbol: 'total', new_name: 'sum' }, { cli: true });
    assert.match(text, /check these by hand:[\s\S]*src\/u\.ts:2\s+the name, where the index binds nothing/, text);
    assert.doesNotMatch(text, /Every use/, text);
}));

test('review: a name taken in another file of the same Go package, or a Java class named after its file, is refused', async () => {
    await withRepo({
        'go.mod': 'module ex\n\ngo 1.22\n',
        'pkg/p.go': `package pkg\n\nfunc Use(a int) int { return a }\n`,
        'pkg/q.go': `package pkg\n\nfunc Apply() int { return Use(1) }\n`,
    }, async ({ intel, read }) => {
        const r = await renameSymbol(intel, { symbol: 'pkg/p.go:Use', newName: 'Apply', apply: true });
        assert.ok(r.conflicts.some(c => /same package/.test(c.why ?? '')), JSON.stringify(r.conflicts));
        assert.match(read('pkg/p.go'), /func Use/);
    });
    await withRepo({
        'src/p/Kid.java': `package p;\n\npublic class Kid { }\n`,
        'src/p/Other.java': `package p;\n\npublic class Other { Kid k; }\n`,
    }, async ({ intel }) => {
        const taken = await renameSymbol(intel, { symbol: 'Kid', newName: 'Other' });
        assert.ok(taken.conflicts.some(c => /same package/.test(c.why ?? '')), JSON.stringify(taken.conflicts));
        const file = await renameSymbol(intel, { symbol: 'Kid', newName: 'Child' });
        assert.ok(file.conflicts.some(c => /Child\.java/.test(c.why ?? '')), JSON.stringify(file.conflicts));
    });
});

test('review: a builtin the file already uses, or `_` in Go and Rust, is refused as the new name', async () => {
    await withRepo({
        'a.py': `def fetch(x):\n    return x\n\n\ndef size(x):\n    return len(x) + fetch(x)\n`,
    }, async ({ intel }) => {
        const r = await renameSymbol(intel, { symbol: 'fetch', newName: 'len' });
        assert.ok(r.conflicts.some(c => /builtin/.test(c.why ?? '')), JSON.stringify(r.conflicts));
        const ok = await renameSymbol(intel, { symbol: 'fetch', newName: 'grab' });
        assert.deepEqual(ok.conflicts, []);
    });
    await withRepo({ 'go.mod': 'module ex\n\ngo 1.22\n', 'm.go': `package main\n\nfunc helper() int { return 1 }\n\nfunc main() { helper() }\n` }, async ({ intel }) => {
        assert.match((await renameSymbol(intel, { symbol: 'helper', newName: '_' })).error ?? '', /reserved/);
    });
});

// ── found by the second review of 3.2.0 (of the fixes above) ─────────────────────

test('review 2: a Go method is no package-level name: no false refusal, and a clash on its receiver type is found', () => withRepo({
    'go.mod': 'module ex\n\ngo 1.22\n',
    'pkg/p.go': `package pkg\n\nfunc Use(a int) int { return a }\n\nfunc Name() string { return "n" }\n`,
    'pkg/q.go': `package pkg\n\ntype T struct{}\n\nfunc (t T) String() string { return "t" }\n\nfunc (t T) Len() int { return len("x") }\n\nfunc (t T) Size() int { return 1 }\n`,
    'pkg/r.go': `package pkg\n\ntype U struct{}\n\nfunc (u U) Name() string { return "u" }\n`,
}, async ({ intel }) => {
    for (const [symbol, newName] of [['pkg/p.go:Use', 'String'], ['T.String', 'Use'], ['T.String', 'Name'], ['T.Len', 'len']]) {
        const r = await renameSymbol(intel, { symbol, newName });
        assert.equal(r.error, undefined, `${symbol} → ${newName}: ${r.error}`);
        assert.deepEqual(r.conflicts, [], `${symbol} → ${newName}: ${JSON.stringify(r.conflicts)}`);
    }
    const taken = await renameSymbol(intel, { symbol: 'T.Size', newName: 'Len' });
    assert.ok(taken.conflicts.some(c => c.qname === 'T.Len'), JSON.stringify(taken.conflicts));
    // a package-level func called like a builtin another file of the package uses takes that use over
    const builtin = await renameSymbol(intel, { symbol: 'pkg/p.go:Use', newName: 'len' });
    assert.ok(builtin.conflicts.some(c => /builtin/.test(c.why ?? '') && c.path === 'pkg/q.go'), JSON.stringify(builtin.conflicts));
}));

test('review 2: calls of a member name on other receivers are not listed as mentions', () => withRepo({
    'src/cache.ts': `export class Cache {\n  get(k: string) { return k; }\n}\n`,
    'src/app.ts': `import { Cache } from './cache';\n\nexport function run(c: Cache, params: URLSearchParams, headers: Headers) {\n  const m = new Map<string, number>();\n  c.get('x');\n  params.get('q');\n  headers.get('h');\n  const f = c.get;\n  return m.get('z');\n}\n`,
}, async ({ intel }) => {
    const r = await renameSymbol(intel, { symbol: 'Cache.get', newName: 'lookup' });
    assert.deepEqual(r.mentions.map(m => m.line).filter(l => [6, 7, 9].includes(l)), [], JSON.stringify(r.mentions));
}));

test('review 2: the suggested command quotes the new name; Python keyword arguments and module-qualified uses are no builtin use', async () => {
    await withRepo({ 'src/a.ts': `export function foo() { return 1; }\n` }, async ({ intel }) => {
        const text = await callTool(intel, 'rename_symbol', { symbol: 'foo', new_name: '$store' }, { cli: true });
        assert.match(text, /`graph-indexer rename foo '\$store' --write`/, text);
    });
    await withRepo({
        'util.py': `def biggest(a, b):\n    return a\n`,
        'use.py': `import util\n\n\ndef run():\n    return util.biggest(1, 2) + max(1, 2)\n`,
        'kw.py': `def fetch(x, id=None):\n    return x\n\n\ndef go():\n    return fetch(1, id=2)\n`,
    }, async ({ intel }) => {
        assert.deepEqual((await renameSymbol(intel, { symbol: 'biggest', newName: 'max' })).conflicts, []);
        assert.deepEqual((await renameSymbol(intel, { symbol: 'fetch', newName: 'id' })).conflicts.filter(c => /builtin/.test(c.why ?? '')), []);
    });
});
