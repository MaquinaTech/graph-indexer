/**
 * An index that was updated holds the facts of one built from scratch.
 *
 * Each scenario edits a small repository the way an agent or a branch switch does, syncs after
 * every step, and compares the whole index (symbols, imports, field types, every reference with
 * its target and confidence) with a fresh index of the same tree. It also names the one binding
 * the scenario is about, so a failure reads as what went stale. bench/eval-incremental.mjs runs the
 * same comparison over real history.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.mjs';
import { Indexer } from '../src/index/indexer.mjs';
import { dump, compare, divergent } from '../bench/eval-incremental.mjs';
import { makeRepo, writeFile, rmrf } from './helpers.mjs';

/** Open (or reopen) an index of `root` kept in `dir`. */
function open(root, dir) {
    const store = new Store(path.join(dir, 'updated.db'));
    return { store, ix: new Indexer({ root, store }) };
}

async function fresh(root, dir) {
    const db = path.join(dir, 'fresh.db');
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(db + suffix, { force: true });
    const store = new Store(db);
    await new Indexer({ root, store }).sync();
    const d = dump(store);
    store.close();
    return d;
}

/** What the reference to `name` on `file:line` is bound to (`path:qname`), or null. */
function target(store, file, line, name) {
    const r = store.get(`SELECT d.qname, df.path FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols d ON d.id = r.dst_id LEFT JOIN files df ON df.id = d.file_id
        WHERE f.path = ? AND r.line = ? AND r.name = ? ORDER BY r.dst_id IS NULL`, file, line, name);
    return r?.qname ? `${r.path}:${r.qname}` : null;
}

function describeDiff(d) {
    const out = [];
    for (const t of ['files', 'symbols', 'imports', 'fields']) for (const x of d[t].slice(0, 4)) out.push(`${t} ${x.key} ${x.how}`);
    for (const [k, l] of Object.entries(d.refs)) for (const x of l.slice(0, 6)) out.push(`ref ${k} ${x.key}: fresh ${x.fresh} / updated ${x.updated}`);
    return out.join('\n');
}

/**
 * Run a scenario: index `files`, then apply each step (a function that edits the tree and returns
 * the paths it touched, or `{ paths, expect }`), syncing those paths and comparing with a fresh
 * index after each one. With `restart`, the index is closed and reopened before every step, as when
 * each agent command is a new process.
 */
async function scenario(files, steps, { restart = false, git = false } = {}) {
    const root = makeRepo(files, { git });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-inc-'));
    let { store, ix } = open(root, dir);
    try {
        await ix.sync();
        let n = 0;
        for (const step of steps) {
            n++;
            if (restart) { store.close(); ({ store, ix } = open(root, dir)); }
            const res = await step({ root, store, write: (rel, text) => writeFile(root, rel, text), remove: (rel) => fs.rmSync(path.join(root, rel), { force: true }) });
            const paths = Array.isArray(res) ? res : res.paths;
            if (paths === 'sweep') await ix.sync(); else await ix.syncPaths(paths);
            const d = compare(dump(store), await fresh(root, dir));
            assert.equal(divergent(d), 0, `step ${n}${restart ? ' (reopened)' : ''}: the updated index differs from a fresh one\n${describeDiff(d)}`);
            if (res.expect) for (const [file, line, name, want] of res.expect) assert.equal(target(store, file, line, name), want, `step ${n}: ${file}:${line} ${name}`);
        }
    } finally { store.close(); rmrf(root); rmrf(dir); }
}

/** Every scenario runs twice: with one long-lived index, and reopening it before each step. */
function both(name, files, steps, opts = {}) {
    test(name, () => scenario(files, steps, opts));
    test(`${name} — index reopened before each step`, () => scenario(files, steps, { ...opts, restart: true }));
}

both('a call written before its definition binds once the definition exists', {
    'src/app.ts': `import { helper } from './util';\nexport function run() {\n  return helper(1);\n}\n`,
    'src/other.ts': `export const one = 1;\n`,
}, [
    ({ write }) => { write('src/util.ts', `export function helper(n: number) { return n; }\n`); return { paths: ['src/util.ts'], expect: [['src/app.ts', 3, 'helper', 'src/util.ts:helper']] }; },
    ({ remove }) => { remove('src/util.ts'); return { paths: ['src/util.ts'], expect: [['src/app.ts', 3, 'helper', null]] }; },
    ({ write }) => { write('src/util.ts', `export function helper(n: number) { return n + 1; }\n`); return { paths: ['src/util.ts'], expect: [['src/app.ts', 3, 'helper', 'src/util.ts:helper']] }; },
]);

both('a type named before it is declared, and a value read before it is exported', {
    'src/view.ts': `import { Widget, LIMIT } from './model';\nexport function draw(w: Widget) {\n  return LIMIT;\n}\n`,
    'src/model.ts': `export const other = 2;\n`,
}, [
    ({ write }) => { write('src/model.ts', `export const other = 2;\nexport class Widget { size = 1; }\nexport const LIMIT = 3;\n`); return { paths: ['src/model.ts'], expect: [['src/view.ts', 2, 'Widget', 'src/model.ts:Widget'], ['src/view.ts', 3, 'LIMIT', 'src/model.ts:LIMIT']] }; },
]);

both('a changed return type moves the calls made on the result', {
    'src/types.ts': `export class Foo { run() { return 1; } }\nexport class Bar { run() { return 2; } }\n`,
    'src/factory.ts': `import { Foo, Bar } from './types';\nexport function make(): Foo { return new Foo(); }\n`,
    'src/use.ts': `import { make } from './factory';\nexport function go() {\n  return make().run();\n}\n`,
}, [
    ({ write }) => { write('src/factory.ts', `import { Foo, Bar } from './types';\nexport function make(): Bar { return new Bar(); }\n`); return { paths: ['src/factory.ts'], expect: [['src/use.ts', 3, 'run', 'src/types.ts:Bar.run']] }; },
    ({ write }) => { write('src/factory.ts', `import { Foo, Bar } from './types';\nexport function make(): Foo { return new Foo(); }\n`); return { paths: ['src/factory.ts'], expect: [['src/use.ts', 3, 'run', 'src/types.ts:Foo.run']] }; },
]);

both('a changed base class moves inherited calls, and an override added in between takes them', {
    'src/bases.ts': `export class A { hello() { return 'a'; } }\nexport class B { hello() { return 'b'; } }\n`,
    'src/x.ts': `import { A, B } from './bases';\nexport class X extends A {\n  other() { return 0; }\n}\n`,
    'src/use.ts': `import { X } from './x';\nexport function go(x: X) {\n  return x.hello();\n}\n`,
}, [
    ({ write }) => { write('src/x.ts', `import { A, B } from './bases';\nexport class X extends B {\n  other() { return 0; }\n}\n`); return { paths: ['src/x.ts'], expect: [['src/use.ts', 3, 'hello', 'src/bases.ts:B.hello']] }; },
    ({ write }) => { write('src/x.ts', `import { A, B } from './bases';\nexport class X extends B {\n  other() { return 0; }\n  hello() { return 'x'; }\n}\n`); return { paths: ['src/x.ts'], expect: [['src/use.ts', 3, 'hello', 'src/x.ts:X.hello']] }; },
    ({ write }) => { write('src/bases.ts', `export class A { hello() { return 'a'; } }\nexport class B { hi() { return 'b'; } }\n`); return { paths: ['src/bases.ts'] }; },
]);

both('the first member an empty type gains reaches the calls that were waiting for it', {
    'src/shape.ts': `export class Shape {}\nexport interface Drawable {}\n`,
    'src/use.ts': `import { Shape, Drawable } from './shape';\nexport function go(s: Shape, d: Drawable) {\n  s.area();\n  d.draw();\n}\n`,
}, [
    ({ write }) => { write('src/shape.ts', `export class Shape {\n  area() { return 0; }\n}\nexport interface Drawable {}\n`); return { paths: ['src/shape.ts'], expect: [['src/use.ts', 3, 'area', 'src/shape.ts:Shape.area']] }; },
    ({ write }) => { write('src/shape.ts', `export class Shape {\n  area() { return 0; }\n}\nexport interface Drawable {\n  draw(): void;\n}\n`); return { paths: ['src/shape.ts'], expect: [['src/use.ts', 4, 'draw', 'src/shape.ts:Drawable.draw']] }; },
]);

both('Go and Python: a method added to a type that had none', {
    'go.mod': 'module example.com/app\n\ngo 1.21\n',
    'geo/point.go': `package geo\n\ntype Point struct{ X, Y int }\n`,
    'geo/use.go': `package geo\n\nfunc Norm(p Point) int {\n\treturn p.Len()\n}\n`,
    'py/__init__.py': '',
    'py/model.py': `class Model:\n    pass\n`,
    'py/use.py': `from py.model import Model\n\n\ndef go(m: Model):\n    return m.save()\n`,
}, [
    ({ write }) => { write('geo/len.go', `package geo\n\nfunc (p Point) Len() int { return p.X + p.Y }\n`); return { paths: ['geo/len.go'], expect: [['geo/use.go', 4, 'Len', 'geo/len.go:Point.Len']] }; },
    ({ write }) => { write('py/model.py', `class Model:\n    def save(self):\n        return 1\n`); return { paths: ['py/model.py'], expect: [['py/use.py', 5, 'save', 'py/model.py:Model.save']] }; },
]);

both('two definitions of one name that swap places in their file move the calls that took the first', {
    'a.ts': `namespace A { export function f() { return 1; } }\nnamespace B { export function f() { return 2; } }\n`,
    'b.js': `function g() { f(); }\n`,
}, [
    ({ write }) => { write('a.ts', `namespace B { export function f() { return 2; } }\nnamespace A { export function f() { return 1; } }\n`); return ['a.ts']; },
    ({ write }) => { write('a.ts', `namespace A { export function f() { return 1; } }\nnamespace B { export function f() { return 2; } }\n`); return ['a.ts']; },
]);

both('a barrel that re-exports from another module moves its importers', {
    'src/a.ts': `export function pick() { return 'a'; }\n`,
    'src/a2.ts': `export function pick() { return 'a2'; }\n`,
    'src/index.ts': `export { pick } from './a';\n`,
    'src/use.ts': `import { pick } from './index';\nexport const v = pick();\n`,
}, [
    ({ write }) => { write('src/index.ts', `export { pick } from './a2';\n`); return { paths: ['src/index.ts'], expect: [['src/use.ts', 2, 'pick', 'src/a2.ts:pick']] }; },
    ({ write }) => { write('src/index.ts', `export * from './a';\n`); return { paths: ['src/index.ts'], expect: [['src/use.ts', 2, 'pick', 'src/a.ts:pick']] }; },
]);

both('Python: a field assigned another type in __init__ moves the calls through it in other files', {
    'pkg/__init__.py': ``,
    'pkg/repos.py': `class RepoA:\n    def find(self):\n        return 1\n\n\nclass RepoB:\n    def find(self):\n        return 2\n`,
    'pkg/service.py': `from pkg.repos import RepoA, RepoB\n\n\nclass Service:\n    def __init__(self):\n        self.repo = RepoA()\n`,
    'pkg/use.py': `from pkg.service import Service\n\n\ndef go(svc: Service):\n    return svc.repo.find()\n`,
}, [
    ({ write }) => { write('pkg/service.py', `from pkg.repos import RepoA, RepoB\n\n\nclass Service:\n    def __init__(self):\n        self.repo = RepoB()\n`); return { paths: ['pkg/service.py'], expect: [['pkg/use.py', 5, 'find', 'pkg/repos.py:RepoB.find']] }; },
]);

both('Python: a package that starts importing a submodule binds `pkg.sub.X` in the files that name it', {
    'pkg/__init__.py': ``,
    'pkg/cookies.py': `class Jar:\n    pass\n`,
    'use.py': `import pkg\n\n\ndef go():\n    return pkg.cookies.Jar()\n`,
}, [
    ({ write }) => { write('pkg/__init__.py', `from . import cookies\n`); return { paths: ['pkg/__init__.py'], expect: [['use.py', 5, 'Jar', 'pkg/cookies.py:Jar']] }; },
]);

both('Python: a base class that gains a property moves `self.x = v` in its subclasses', {
    'pkg/__init__.py': ``,
    'pkg/base.py': `class Base:\n    pass\n`,
    'pkg/child.py': `from pkg.base import Base\n\n\nclass Child(Base):\n    def __init__(self):\n        self.size = 1\n`,
}, [
    ({ write }) => { write('pkg/base.py', `class Base:\n    @property\n    def size(self):\n        return 0\n\n    @size.setter\n    def size(self, v):\n        pass\n`); return { paths: ['pkg/base.py'], expect: [['pkg/child.py', 6, 'size', 'pkg/base.py:Base.size']] }; },
]);

both('Python: a module written after the test that imports it', {
    'tests/test_app.py': `from docs_src.tutorial001 import app\n\n\ndef test_it():\n    return app\n`,
    'docs_src/__init__.py': ``,
}, [
    ({ write }) => { write('docs_src/tutorial001.py', `app = object()\n`); return { paths: ['docs_src/tutorial001.py'], expect: [['tests/test_app.py', 5, 'app', 'docs_src/tutorial001.py:app']] }; },
]);

both('a file deleted and written again (a branch switch) leaves its importers bound', {
    'src/dep.ts': `export function dep() { return 1; }\n`,
    'src/use.ts': `import { dep } from './dep';\nexport const v = dep();\n`,
}, [
    ({ remove }) => { remove('src/dep.ts'); return ['src/dep.ts']; },
    ({ write }) => { write('src/dep.ts', `export function dep() { return 1; }\n`); return { paths: ['src/dep.ts'], expect: [['src/use.ts', 2, 'dep', 'src/dep.ts:dep']] }; },
]);

both('a tsconfig path alias that moves takes its imports along, with no source file touched', {
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['old/*'] } } }),
    'old/tool.ts': `export function tool() { return 'old'; }\n`,
    'next/tool.ts': `export function tool() { return 'next'; }\n`,
    'src/use.ts': `import { tool } from '@lib/tool';\nexport const v = tool();\n`,
}, [
    ({ write }) => { write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['next/*'] } } })); return { paths: ['tsconfig.json'], expect: [['src/use.ts', 2, 'tool', 'next/tool.ts:tool']] }; },
    // the same through a sweep, as when the watcher missed the event
    ({ write }) => { write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['old/*'] } } })); return { paths: 'sweep', expect: [['src/use.ts', 2, 'tool', 'old/tool.ts:tool']] }; },
]);

both('Go: a package whose last file is removed is no import target, and a method added makes a type implement an interface', {
    'go.mod': 'module example.com/app\n\ngo 1.21\n',
    'shape/shape.go': `package shape\n\ntype Shape interface {\n\tArea() float64\n\tName() string\n}\n\nfunc Describe(s Shape) string { return s.Name() }\n`,
    'shape/square.go': `package shape\n\ntype Square struct{ side float64 }\n\nfunc (s Square) Area() float64 { return s.side * s.side }\n`,
    'extra/extra.go': `package extra\n\nfunc Help() int { return 1 }\n`,
    'cmd/main.go': `package main\n\nimport (\n\t"example.com/app/extra"\n\t"example.com/app/shape"\n)\n\nfunc main() {\n\textra.Help()\n\tshape.Describe(shape.Square{})\n}\n`,
}, [
    ({ write }) => { write('shape/square.go', `package shape\n\ntype Square struct{ side float64 }\n\nfunc (s Square) Area() float64 { return s.side * s.side }\n\nfunc (s Square) Name() string { return "square" }\n`); return ['shape/square.go']; },
    ({ remove }) => { remove('extra/extra.go'); return { paths: ['extra/extra.go'], expect: [['cmd/main.go', 9, 'Help', null]] }; },
    ({ write }) => { write('extra/extra.go', `package extra\n\nfunc Help() int { return 2 }\n`); return { paths: ['extra/extra.go'], expect: [['cmd/main.go', 9, 'Help', 'extra/extra.go:Help']] }; },
]);

both('Java: a class that moves to another package is no longer what a same-package name means', {
    'src/main/java/app/Util.java': `package app;\n\npublic class Util {\n    public static int one() { return 1; }\n}\n`,
    'src/main/java/app/Main.java': `package app;\n\npublic class Main {\n    int run() { return Util.one(); }\n}\n`,
}, [
    ({ write }) => { write('src/main/java/app/Util.java', `package other;\n\npublic class Util {\n    public static int one() { return 1; }\n}\n`); return ['src/main/java/app/Util.java']; },
    ({ write }) => { write('src/main/java/app/Util.java', `package app;\n\npublic class Util {\n    public static int one() { return 1; }\n}\n`); return { paths: ['src/main/java/app/Util.java'], expect: [['src/main/java/app/Main.java', 4, 'one', 'src/main/java/app/Util.java:Util.one']] }; },
]);

both('Java: a static import names a member of a type in another file, and an inner class one inherited by its outer class', {
    'src/main/java/app/Fu.java': `package app;\n\npublic class Fu {\n    static void validate(Object... xs) {}\n}\n`,
    'src/main/java/app/Base.java': `package app;\n\npublic class Base {\n    void make() {}\n}\n`,
    'src/main/java/use/All.java': `package use;\n\nimport static app.Fu.validate;\n\nclass All extends app.Base {\n    void f() { validate(1); }\n    class In { void g() { make(); } }\n}\n`,
}, [
    ({ write }) => { write('src/main/java/app/Fu.java', `package app;\n\npublic class Fu {\n    static void check(Object... xs) {}\n}\n`); return { paths: ['src/main/java/app/Fu.java'], expect: [['src/main/java/use/All.java', 6, 'validate', null]] }; },
    ({ write }) => { write('src/main/java/app/Fu.java', `package app;\n\npublic class Fu {\n    static void validate(Object... xs) {}\n}\n`); return { paths: ['src/main/java/app/Fu.java'], expect: [['src/main/java/use/All.java', 6, 'validate', 'src/main/java/app/Fu.java:Fu.validate'], ['src/main/java/use/All.java', 7, 'make', 'src/main/java/app/Base.java:Base.make']] }; },
    ({ write }) => { write('src/main/java/app/Base.java', `package app;\n\npublic class Base {\n    void other() {}\n}\n`); return { paths: ['src/main/java/app/Base.java'], expect: [['src/main/java/use/All.java', 7, 'make', null]] }; },
]);

both('a second definition of a name changes what an unqualified call elsewhere can claim', {
    'lib/a.js': `function shared() { return 1; }\nmodule.exports = { shared };\n`,
    'lib/use.js': `function go() { return shared(); }\n`,
}, [
    ({ write }) => { write('lib/b.js', `function shared() { return 2; }\nfunction more() { return shared(); }\n`); return ['lib/b.js']; },
    ({ write }) => { write('lib/b.js', `function shared() {\n  // longer now\n  return 2;\n}\nfunction more() { return shared(); }\n`); return ['lib/b.js']; },
    ({ remove }) => { remove('lib/b.js'); return ['lib/b.js']; },
]);

both('Rust: an impl written in another file, and a module added later', {
    'Cargo.toml': `[package]\nname = "demo"\nversion = "0.1.0"\n`,
    'src/lib.rs': `pub mod shape;\npub mod draw;\n`,
    'src/shape.rs': `pub struct Circle { pub r: f64 }\n`,
    'src/draw.rs': `use crate::shape::Circle;\n\npub fn draw(c: &Circle) -> f64 {\n    c.area()\n}\n`,
}, [
    ({ write }) => { write('src/shape.rs', `pub struct Circle { pub r: f64 }\n\nimpl Circle {\n    pub fn area(&self) -> f64 { self.r * self.r }\n}\n`); return { paths: ['src/shape.rs'], expect: [['src/draw.rs', 4, 'area', 'src/shape.rs:Circle.area']] }; },
    ({ write }) => { write('src/util.rs', `pub fn twice(x: f64) -> f64 { x * 2.0 }\n`); write('src/lib.rs', `pub mod shape;\npub mod draw;\npub mod util;\n`); return ['src/util.rs', 'src/lib.rs']; },
]);

test('the order in which files are indexed does not change the index', async () => {
    const files = {
        'src/a.ts': `export class Node { next() { return this; } }\nexport function build() { return new Node(); }\n`,
        'src/b.ts': `export class Node { next() { return this; } }\nexport function build() { return new Node(); }\n`,
        'src/c.ts': `import { build } from './a';\nexport const n = build().next();\nexport function helper() { return n; }\n`,
        'src/d.js': `function helper() { return 1; }\nfunction go() { return helper() + build(); }\n`,
        'src/e.ts': `import { Node } from './b';\nexport class Leaf extends Node { leaf() { return this.next(); } }\n`,
    };
    const root = makeRepo(files, { git: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-inc-'));
    try {
        const want = await fresh(root, dir);
        const names = Object.keys(files);
        // each rotation and its reverse: every file is first once and last once, in both directions
        for (let k = 0; k < names.length * 2; k++) {
            const order = names.slice(k % names.length).concat(names.slice(0, k % names.length));
            if (k >= names.length) order.reverse();
            fs.rmSync(path.join(dir, 'updated.db'), { force: true });
            for (const suffix of ['-wal', '-shm']) fs.rmSync(path.join(dir, 'updated.db' + suffix), { force: true });
            const { store, ix } = open(root, dir);
            ix.include = ['__nothing__/'];
            ix.load();
            for (const rel of order) await ix.syncPaths([rel]);
            const d = compare(dump(store), want);
            store.close();
            assert.equal(divergent(d), 0, `indexed in the order ${order.join(', ')}:\n${describeDiff(d)}`);
        }
    } finally { rmrf(root); rmrf(dir); }
});

both('Rust: a second `impl From<_> for Type` in another file changes which impl a call binds to', {
    'Cargo.toml': '[package]\nname = "app"\n',
    'src/lib.rs': `pub mod model;\npub mod extra;\nuse model::Value;\npub fn t(flag: bool) {\n    Value::from(1.0);\n    Value::from(flag);\n}\n`,
    'src/model.rs': `pub struct Value;\nimpl From<f32> for Value {\n    fn from(f: f32) -> Self { Value }\n}\nimpl From<bool> for Value {\n    fn from(f: bool) -> Self { Value }\n}\n`,
    'src/extra.rs': `use crate::model::Value;\n`,
}, [
    // a float literal fits the one float impl; a second one (f64) makes it the context's choice
    ({ write }) => { write('src/extra.rs', `use crate::model::Value;\nimpl From<f64> for Value {\n    fn from(f: f64) -> Self { Value }\n}\n`); return { paths: ['src/extra.rs'], expect: [['src/lib.rs', 5, 'from', null], ['src/lib.rs', 6, 'from', 'src/model.rs:Value.from']] }; },
    // the impl changes its parameter: the call fits the impl that is left
    ({ write }) => { write('src/extra.rs', `use crate::model::Value;\nimpl From<char> for Value {\n    fn from(f: char) -> Self { Value }\n}\n`); return { paths: ['src/extra.rs'], expect: [['src/lib.rs', 5, 'from', 'src/model.rs:Value.from']] }; },
    ({ write }) => { write('src/extra.rs', `use crate::model::Value;\n`); return { paths: ['src/extra.rs'], expect: [['src/lib.rs', 5, 'from', 'src/model.rs:Value.from']] }; },
]);

test('a body edit that changes nothing others read resolves no other file again', async () => {
    const root = makeRepo({
        'src/lib.ts': `export function compute(n: number) {\n  return n;\n}\n`,
        'src/a.ts': `import { compute } from './lib';\nexport const a = compute(1);\n`,
        'src/b.ts': `import { compute } from './lib';\nexport const b = compute(2);\n`,
    }, { git: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-inc-'));
    const { store, ix } = open(root, dir);
    try {
        await ix.sync();
        writeFile(root, 'src/lib.ts', `export function compute(n: number) {\n  // two lines longer,\n  // the same signature and result\n  return n;\n}\n`);
        await ix.syncPaths(['src/lib.ts']);
        assert.equal(ix.lastFanout.dependents, 0, 'a longer body with the same signature reaches no importer');
        writeFile(root, 'src/lib.ts', `export function compute(n: number): string {\n  return String(n);\n}\n`);
        await ix.syncPaths(['src/lib.ts']);
        assert.equal(ix.lastFanout.dependents, 2, 'a changed signature reaches the two files that call it');
    } finally { store.close(); rmrf(root); rmrf(dir); }
});

test('a manifest edited while the index was closed is noticed by the next update of any file', async () => {
    const root = makeRepo({
        'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['old/*'] } } }),
        'old/tool.ts': `export function tool() { return 'old'; }\n`,
        'next/tool.ts': `export function tool() { return 'next'; }\n`,
        'src/use.ts': `import { tool } from '@lib/tool';\nexport const v = tool();\n`,
        'src/other.ts': `export const o = 1;\n`,
    }, { git: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-inc-'));
    let { store, ix } = open(root, dir);
    try {
        await ix.sync();
        assert.equal(target(store, 'src/use.ts', 2, 'tool'), 'old/tool.ts:tool');
        store.close();
        writeFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['next/*'] } } }));
        writeFile(root, 'src/other.ts', `export const o = 2;\n`);
        ({ store, ix } = open(root, dir));
        await ix.syncPaths(['src/other.ts']); // the manifest is not among the paths: only its fingerprint tells
        assert.equal(target(store, 'src/use.ts', 2, 'tool'), 'next/tool.ts:tool');
        const d = compare(dump(store), await fresh(root, dir));
        assert.equal(divergent(d), 0, describeDiff(d));
    } finally { store.close(); rmrf(root); rmrf(dir); }
});

// ── found by an independent reading of the code (2026-11-15) ─────────────────────────────────────

test('updates asked for at once run one after the other', async () => {
    // a branch switch seen by three tool calls: a full sweep and two targeted updates, not awaited
    const files = {};
    for (let i = 0; i < 40; i++) files[`src/m${i}.ts`] = `export function f${i}() { return ${i}; }\n`;
    files['src/r.js'] = `export function fr() { return 1; }\n`;
    files['src/c.js'] = `export function c() { return fr(); }\n`;
    const root = makeRepo(files, { git: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-inc-'));
    const { store, ix } = open(root, dir);
    try {
        await ix.sync();
        for (let i = 0; i < 40; i++) writeFile(root, `src/n${i}.ts`, `import { f${i} } from './m${i}';\nexport const v${i} = f${i}();\n`);
        fs.rmSync(path.join(root, 'src/r.js'));
        const results = await Promise.allSettled([ix.sync(), ix.syncPaths(['src/n0.ts', 'src/r.js']), ix.sync()]);
        assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'fulfilled'], results.map(r => r.reason?.message ?? 'ok').join(' | '));
        const d = compare(dump(store), await fresh(root, dir));
        assert.equal(divergent(d), 0, describeDiff(d));
        assert.equal(store.getMeta('resolve_pending'), '0');
    } finally { store.close(); rmrf(root); rmrf(dir); }
});

test('an update that fails after its removals were written is made good by the next one', async () => {
    const root = makeRepo({
        'src/a.ts': `export function fa() { return 1; }\n`,
        'src/u.ts': `import { fa } from './a';\nexport const v = fa();\n`,
        'src/other.ts': `export const o = 1;\n`,
    }, { git: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-inc-'));
    const { store, ix } = open(root, dir);
    try {
        await ix.sync();
        fs.rmSync(path.join(root, 'src/a.ts'));
        // the disk fails once, after the removal has been committed
        const run = store.run.bind(store);
        let failed = false;
        store.run = (sql, ...params) => {
            if (!failed && /^DELETE FROM imports WHERE file_id/.test(sql) && !store.get('SELECT 1 AS x FROM files WHERE path = ?', 'src/a.ts')) { failed = true; throw new Error('SQLITE_IOERR (simulated)'); }
            return run(sql, ...params);
        };
        await assert.rejects(ix.syncPaths(['src/a.ts']), /simulated/);
        assert.ok(failed);
        assert.equal(store.getMeta('resolve_pending'), '1');
        store.run = run;
        writeFile(root, 'src/other.ts', `export const o = 2;\n`);
        await ix.syncPaths(['src/other.ts']);
        const d = compare(dump(store), await fresh(root, dir));
        assert.equal(divergent(d), 0, describeDiff(d));
    } finally { store.close(); rmrf(root); rmrf(dir); }
});

test('an index another process updated is read again before the next update', async () => {
    const root = makeRepo({
        'src/f.ts': `export function one() { return 1; }\n`,
        'src/g.ts': `import { one } from './f';\nexport const v = one();\n`,
    }, { git: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-inc-'));
    const a = open(root, dir);          // the resident
    try {
        await a.ix.sync();
        writeFile(root, 'src/f.ts', `export function one() { return 1; }\nexport function two() { return 2; }\n`);
        const b = open(root, dir);      // the edit hook's own index, opened because the resident was busy
        try { await b.ix.sync(); } finally { b.store.close(); }
        // the file is as the store says: the resident has nothing to parse, and must still learn of `two`
        writeFile(root, 'src/g.ts', `import { one, two } from './f';\nexport const v = one() + two();\n`);
        await a.ix.syncPaths(['src/g.ts']);
        assert.equal(target(a.store, 'src/g.ts', 2, 'two'), 'src/f.ts:two');
        const d = compare(dump(a.store), await fresh(root, dir));
        assert.equal(divergent(d), 0, describeDiff(d));
    } finally { a.store.close(); rmrf(root); rmrf(dir); }
});

test('a file rewritten alone in its directory, or a new document, sends no other file through resolution', async () => {
    // Java: files that import a library type ask which packages the repository has
    const java = { 'notes/todo.md': '# todo\n', 'solo/Only.java': `package solo;\n\npublic class Only {\n    public int v() { return 1; }\n}\n` };
    for (let i = 0; i < 6; i++) java[`app/C${i}.java`] = `package app;\n\nimport java.util.List;\n\npublic class C${i} {\n    List<String> xs;\n    int n() { return xs.size(); }\n}\n`;
    let root = makeRepo(java, { git: false });
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-inc-'));
    let { store, ix } = open(root, dir);
    try {
        await ix.sync();
        writeFile(root, 'solo/Only.java', `package solo;\n\npublic class Only {\n    public int v() {\n        return 2;\n    }\n}\n`);
        await ix.syncPaths(['solo/Only.java']);
        assert.equal(ix.lastFanout.dependents, 0, 'a body edit of a file alone in its package');
        writeFile(root, 'notes/todo.md', '# todo\n\nmore\n');
        await ix.syncPaths(['notes/todo.md']);
        assert.equal(ix.lastFanout.dependents, 0, 'an edit of a document alone in its directory');
        // a package that appears is another matter: the files that asked are resolved again
        writeFile(root, 'fresh/New.java', `package fresh;\n\npublic class New {}\n`);
        await ix.syncPaths(['fresh/New.java']);
        assert.ok(ix.lastFanout.dependents > 0, 'a new package reaches the files that asked which packages there are');
        const d = compare(dump(store), await fresh(root, dir));
        assert.equal(divergent(d), 0, describeDiff(d));
    } finally { store.close(); rmrf(root); rmrf(dir); }
    // Rust: paths are walked through the module map
    const rust = { 'Cargo.toml': `[package]\nname = "demo"\nversion = "0.1.0"\n`, 'src/lib.rs': `pub mod a;\npub mod b;\n`,
        'src/a.rs': `pub struct A;\nimpl A { pub fn new() -> A { A } }\n`, 'src/b.rs': `use crate::a::A;\npub fn make() -> A { crate::a::A::new() }\n` };
    root = makeRepo(rust, { git: false });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-inc-'));
    ({ store, ix } = open(root, dir));
    try {
        await ix.sync();
        writeFile(root, 'docs/notes.md', '# notes\n');
        await ix.syncPaths(['docs/notes.md']);
        assert.equal(ix.lastFanout.dependents, 0, 'a new document in a Rust repository');
        writeFile(root, 'src/c.rs', `pub fn c() {}\n`);
        await ix.syncPaths(['src/c.rs']);
        const d = compare(dump(store), await fresh(root, dir));
        assert.equal(divergent(d), 0, describeDiff(d));
    } finally { store.close(); rmrf(root); rmrf(dir); }
});

test('a receiver is typed from where the reference stands, whichever reference of the file is resolved first', async () => {
    const files = {
        'src/l.ts': `export class Local {\n  pong = 1;\n}\n`,
        'src/r.ts': `export class Remote {\n  pong = 2;\n}\nexport function make(): Remote { return new Remote(); }\n`,
        'src/u.ts': `import { make } from './r';\nimport { Local } from './l';\nexport function A() {\n  function make(): Local { return new Local(); }\n  return make().ping;\n}\nexport function B() {\n  return make().pong;\n}\n`,
    };
    for (const restart of [false, true]) {
        await scenario(files, [
            ({ write }) => {
                write('src/l.ts', `export class Local {\n  pong = 1;\n  ping = 3;\n}\n`);
                // `make()` in A is the function declared in A (a Local); in B it is the imported one (a Remote)
                return { paths: ['src/l.ts'], expect: [['src/u.ts', 5, 'ping', 'src/l.ts:Local.ping'], ['src/u.ts', 8, 'pong', 'src/r.ts:Remote.pong']] };
            },
        ], { restart });
    }
});

test('paths handed over one by one: a renamed directory, an ignored file, a name that changed only its case, a config that is also source', async () => {
    const { spawnSync } = await import('node:child_process');
    const root = makeRepo({
        '.gitignore': 'gen/\n',
        'src/lib/helper.ts': `export function helper() { return 1; }\n`,
        'src/app.ts': `import { helper } from './lib/helper';\nexport const v = helper();\n`,
        'src/foo.ts': `export function foo() { return 1; }\n`,
        'svelte.config.js': `export const cfgA = 1;\nexport default {};\n`,
        'configs/base.json': JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '@m/*': ['src/a/*'] } } }),
        'tsconfig.json': JSON.stringify({ extends: './configs/base.json' }),
        'src/a/m.ts': `export function m() { return 'a'; }\n`,
        'src/b/m.ts': `export function m() { return 'b'; }\n`,
        'src/use.ts': `import { m } from '@m/m';\nexport const w = m();\n`,
    }, { git: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-inc-'));
    const { store, ix } = open(root, dir);
    const same = async (what) => { const d = compare(dump(store), await fresh(root, dir)); assert.equal(divergent(d), 0, `${what}\n${describeDiff(d)}`); };
    try {
        await ix.sync();
        assert.equal(target(store, 'src/use.ts', 2, 'm'), 'src/a/m.ts:m');
        // a directory renamed: the watcher names the two directories, not their files
        fs.renameSync(path.join(root, 'src/lib'), path.join(root, 'src/core'));
        writeFile(root, 'src/app.ts', `import { helper } from './core/helper';\nexport const v = helper();\n`);
        await ix.syncPaths(['src/lib', 'src/core', 'src/app.ts']);
        assert.equal(target(store, 'src/app.ts', 2, 'helper'), 'src/core/helper.ts:helper');
        await same('directory rename');
        // a file the repository ignores (generated code) is not indexed because the watcher saw it
        writeFile(root, 'gen/api.ts', `export function mk() { return 1; }\n`);
        await ix.syncPaths(['gen/api.ts']);
        assert.equal(store.get('SELECT 1 AS x FROM files WHERE path = ?', 'gen/api.ts'), undefined);
        await same('ignored file');
        // a config file that is source too is parsed again when it changes
        writeFile(root, 'svelte.config.js', `export const cfgB = 2;\nexport default {};\n`);
        await ix.syncPaths(['svelte.config.js']);
        assert.ok(store.get("SELECT 1 AS x FROM symbols WHERE name = 'cfgB'"));
        await same('svelte.config.js');
        // the base a tsconfig extends moves the alias
        writeFile(root, 'configs/base.json', JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '@m/*': ['src/b/*'] } } }));
        await ix.syncPaths(['configs/base.json']);
        assert.equal(target(store, 'src/use.ts', 2, 'm'), 'src/b/m.ts:m');
        await same('extended tsconfig');
        // a rename that changes only the letter case (on a file system that ignores case both names answer)
        spawnSync('git', ['mv', 'src/foo.ts', 'src/Foo.ts'], { cwd: root });
        if (fs.readdirSync(path.join(root, 'src')).includes('Foo.ts')) {
            await ix.syncPaths(['src/foo.ts', 'src/Foo.ts']);
            assert.deepEqual(store.all("SELECT path FROM files WHERE lower(path) = 'src/foo.ts'").map(r => r.path), ['src/Foo.ts']);
            await same('case-only rename');
        }
    } finally { store.close(); rmrf(root); rmrf(dir); }
});

test('Python: `pkg.sub.f()` binds once any module imports `pkg.sub`, and stops when none does', async () => {
    const files = {
        'pkg/__init__.py': `from .core import run\n`,
        'pkg/core.py': `def run():\n    return 1\n`,
        'pkg/sub.py': `def f():\n    return 2\n`,
        'app.py': `import pkg\n\n\ndef main():\n    return pkg.sub.f()\n`,
    };
    for (const restart of [false, true]) {
        await scenario(files, [
            // nobody imports pkg.sub: `pkg.sub` is an AttributeError, the call names nothing
            () => ({ paths: [], expect: [['app.py', 5, 'f', null]] }),
            // a module the package loads imports it (as requests.sessions imports requests.adapters)
            ({ write }) => { write('pkg/core.py', `from .sub import f\n\n\ndef run():\n    return f()\n`); return { paths: ['pkg/core.py'], expect: [['app.py', 5, 'f', 'pkg/sub.py:f']] }; },
            ({ write }) => { write('pkg/core.py', `def run():\n    return 1\n`); return { paths: ['pkg/core.py'], expect: [['app.py', 5, 'f', null]] }; },
        ], { restart });
    }
});

test('a file written while the repository ignored it is indexed once the rule is gone, and the other way round', async () => {
    const root = makeRepo({
        '.gitignore': 'typings/\n',
        'src/app.ts': `import { shape } from '../typings/shape';\nexport const s = shape();\n`,
    }, { git: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-inc-'));
    const { store, ix } = open(root, dir);
    const same = async (what) => { const d = compare(dump(store), await fresh(root, dir)); assert.equal(divergent(d), 0, `${what}\n${describeDiff(d)}`); };
    try {
        await ix.sync();
        // the order a commit's files arrive in when they are written last to first (axios 7a2f901:
        // new files under typings/, then the .gitignore that stops ignoring typings/)
        writeFile(root, 'typings/shape.ts', `export function shape() { return 1; }\n`);
        await ix.syncPaths(['typings/shape.ts']);
        assert.equal(store.get('SELECT 1 AS x FROM files WHERE path = ?', 'typings/shape.ts'), undefined, 'ignored: not indexed');
        await same('while ignored');
        writeFile(root, '.gitignore', 'coverage/\n');
        await ix.syncPaths(['.gitignore']);
        assert.equal(target(store, 'src/app.ts', 2, 'shape'), 'typings/shape.ts:shape');
        await same('rule removed');
        writeFile(root, '.gitignore', 'coverage/\ntypings/\n');
        await ix.syncPaths(['.gitignore']);
        assert.equal(store.get('SELECT 1 AS x FROM files WHERE path = ?', 'typings/shape.ts'), undefined, 'ignored again: gone');
        await same('rule back');
    } finally { store.close(); rmrf(root); rmrf(dir); }
});

test('a file renamed only in its letter case, git not told, has the name on disk in a full update as in a targeted one', async () => {
    const { spawnSync } = await import('node:child_process');
    const root = makeRepo({
        '.gitignore': 'Gen/\n',
        'readme.md': '# Old title\n\n## Section\n',
        'src/util.ts': `export function util() { return 1; }\n`,
        'src/app.ts': `import { util } from './Util';\nexport const v = util();\n`,
    }, { git: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-inc-'));
    const { store, ix } = open(root, dir);
    const same = async (what) => { const d = compare(dump(store), await fresh(root, dir)); assert.equal(divergent(d), 0, `${what}\n${describeDiff(d)}`); };
    const named = (lower) => store.all('SELECT path FROM files WHERE lower(path) = ?', lower).map(r => r.path);
    // where the file system answers for a name in any case, git goes on listing the old one
    const folds = fs.existsSync(path.join(root, 'SRC'));
    const rename = (from, to) => { fs.renameSync(path.join(root, from), path.join(root, from + '.tmp')); fs.renameSync(path.join(root, from + '.tmp'), path.join(root, to)); };
    try {
        await ix.sync();
        // the order a commit's files arrive in when they are written last to first (spring a50bfb65bb:
        // `readme.md` gone, `README.md` written, then the .gitignore, which looks at everything again)
        rename('src/util.ts', 'src/Util.ts');
        await ix.syncPaths(['src/util.ts']);
        await ix.syncPaths(['src/Util.ts']);
        rename('readme.md', 'README.md');
        writeFile(root, 'README.md', '# New title\n\n## Section\n');
        await ix.syncPaths(['readme.md']);
        await ix.syncPaths(['README.md']);
        assert.deepEqual(named('src/util.ts'), ['src/Util.ts']);
        assert.equal(target(store, 'src/app.ts', 2, 'util'), 'src/Util.ts:util');
        await same('renamed, one path at a time');
        writeFile(root, '.gitignore', 'Gen/\ncoverage/\n');
        await ix.syncPaths(['.gitignore']);
        assert.deepEqual(named('readme.md'), ['README.md']);
        assert.deepEqual(named('src/util.ts'), ['src/Util.ts']);
        assert.equal(target(store, 'src/app.ts', 2, 'util'), 'src/Util.ts:util');
        await same('everything looked at again');
        // a rule written in another case ignores what git says it ignores here
        writeFile(root, 'gen/out.ts', `export const out = 1;\n`);
        await ix.sync();
        assert.equal(named('gen/out.ts').length, folds ? 0 : 1);
        await same('rule in another case');
        // git is told: nothing changes
        spawnSync('git', ['add', '-A'], { cwd: root });
        await ix.sync();
        assert.deepEqual(named('readme.md'), ['README.md']);
        await same('git told');
    } finally { store.close(); rmrf(root); rmrf(dir); }
});

// ── found by the independent review of 3.2.0 ─────────────────────────────────────

/** A git repository indexed once; `step(root)` returns the paths to hand over; the updated index must equal a fresh one. */
async function handedOver(files, steps, { reopen = false } = {}) {
    const root = makeRepo(files, { git: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-inc-'));
    let { store, ix } = open(root, dir);
    try {
        await ix.sync();
        for (const [what, step] of steps) {
            const paths = step(root);
            if (reopen) { store.close(); ({ store, ix } = open(root, dir)); }
            await ix.syncPaths(paths);
            const d = compare(dump(store), await fresh(root, dir));
            assert.equal(divergent(d), 0, `${what}\n${describeDiff(d)}`);
        }
    } finally { store.close(); rmrf(root); rmrf(dir); }
}

test('review: paths git does not list (a nested repository, beyond a link) are not indexed one by one either', async () => {
    const { spawnSync } = await import('node:child_process');
    await handedOver({ '.gitignore': 'gen/\n', 'src/a.ts': `export function a() { return 1; }\n` }, [
        ['nested repository', (root) => {
            writeFile(root, 'inner/x.ts', `export function a() { return 2; }\n`);
            spawnSync('git', ['init', '-q'], { cwd: path.join(root, 'inner') });
            return ['inner/x.ts', 'inner'];
        }],
        ['a path beyond a link, with an ignored one', (root) => {
            fs.symlinkSync('src', path.join(root, 'lnk'));
            writeFile(root, 'gen/out.ts', `export const g = 1;\n`);
            writeFile(root, 'src/a.ts', `export function a() { return 3; }\n`);
            return ['lnk/a.ts', 'src/a.ts', 'gen/out.ts'];
        }],
    ]);
});

test('review: odd spellings, a directory named like a file, a link in a new directory and an oversize file update as a full sync does', async () => {
    await handedOver({
        'src/a.ts': `export function a() { return 1; }\n`,
        'src/m.ts/inner.ts': `export const i = 1;\n`,
        'src/use.ts': `import { d } from './data';\nexport const x = d;\n`,
        'src/data.ts': `export const d = 1;\n`,
    }, [
        ['spellings', (root) => { writeFile(root, 'src/a.ts', `export function a() { return 2; }\n`); return ['./src/a.ts', 'src//a.ts', 'src/./a.ts', 'src/']; }],
        ['directory replaced by a file', (root) => { fs.rmSync(path.join(root, 'src/m.ts'), { recursive: true }); writeFile(root, 'src/m.ts', `export const m = 1;\n`); return ['src/m.ts']; }],
        ['a link in a new directory', (root) => { fs.mkdirSync(path.join(root, 'pkg')); fs.symlinkSync('../src/a.ts', path.join(root, 'pkg/alias.ts')); return ['pkg']; }],
        ['oversize', (root) => { writeFile(root, 'src/data.ts', `export const d = 1;\n// ${'x'.repeat(1_600_000)}\n`); return ['src/data.ts']; }],
    ]);
});

test('review: an index reopened and handed paths before any full update gets them right', async () => {
    await handedOver({ '.gitignore': 'gen/\n', 'src/a.ts': `export function a() { return 1; }\n` }, [
        ['reopened', (root) => { writeFile(root, 'src/a.ts', `export function a() { return 2; }\n`); writeFile(root, 'gen/x.ts', `export const x = 1;\n`); return ['src/a.ts', 'gen/x.ts']; }],
    ], { reopen: true });
});

test('review: a decomposed Unicode name from the watcher, or only the new name of a case rename, leaves one row per file', async () => {
    const nfc = 'src/útil.ts', nfd = nfc.normalize('NFD');
    await handedOver({ [nfc]: `export function u() { return 1; }\n`, 'src/b.ts': `import { u } from './útil';\nexport const v = u();\n`, 'src/foo.ts': `export const f = 1;\n` }, [
        ['decomposed name', (root) => { writeFile(root, nfc, `export function u() { return 2; }\n`); return process.platform === 'darwin' ? [nfd] : [nfc]; }],
        ['new name only', (root) => {
            const folds = fs.existsSync(path.join(root, 'SRC'));
            if (!folds) return [];
            fs.renameSync(path.join(root, 'src/foo.ts'), path.join(root, 'src/x.tmp')); fs.renameSync(path.join(root, 'src/x.tmp'), path.join(root, 'src/Foo.ts'));
            return ['src/Foo.ts'];
        }],
    ]);
});

test('review 2: an ignored oversize file, or one ignored by a rule in another letter case, stays out when handed over', async () => {
    await handedOver({
        '.gitignore': 'src/big.ts\n*.GEN.ts\n',
        'src/use.ts': `import { d } from './big';\nexport const x = d;\n`,
    }, [
        ['ignored oversize', (root) => { writeFile(root, 'src/big.ts', `export const d = 1;\n// ${'x'.repeat(1_600_000)}\n`); return ['src/big.ts']; }],
        ['its importer edited', (root) => { writeFile(root, 'src/use.ts', `import { d } from './big';\nexport const x = d + 1;\n`); return ['src/use.ts']; }],
        ['rule in another case', (root) => { writeFile(root, 'src/y.gen.ts', `export const y = 1;\n`); return ['src/y.gen.ts']; }],
    ]);
});
