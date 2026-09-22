import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { normalizeType } from '../src/parse/extract.mjs';
import { typescript } from '../src/parse/lang/ecma.mjs';
import { python } from '../src/parse/lang/python.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

test('normalizeType: optional unions, wrappers, collections, qualifiers', () => {
    const n = (t, spec = typescript) => normalizeType(t, spec);
    assert.equal(n('Foo | undefined'), 'Foo');
    assert.equal(n('null | ns.Foo'), 'Foo');
    assert.equal(n('Foo | Bar'), null);
    assert.equal(n('Promise<Foo>'), 'Foo');
    assert.equal(n('Promise<Foo[]>'), 'Foo[]');
    assert.equal(n('ReadonlyArray<Foo>'), 'Foo[]');
    assert.equal(n('Foo[]'), 'Foo[]');
    assert.equal(n('Map<string, Foo>'), 'Map');
    assert.equal(n('(a: Foo) => Bar'), null);
    assert.equal(n('Optional[Foo]', python), 'Foo');
    assert.equal(n('list[Foo]', python), 'Foo[]');
    assert.equal(n('"Foo"', python), 'Foo');
});

const FILES = {
    'src/logger.ts': `export class Logger {\n  error(msg: string) {}\n  static create(): Logger { return new Logger(); }\n}\n`,
    'src/item.ts': `export class Item {\n  price = 0;\n  total(): number { return this.price; }\n}\n`,
    'src/repo.ts': `import { Item } from './item';\nexport class Repo {\n  items: Item[] = [];\n  async findAll(): Promise<Item[]> { return this.items; }\n  first(): Item | undefined { return this.items[0]; }\n}\n`,
    'src/service.ts': [
        `import { Logger } from './logger';`,
        `import { Repo } from './repo';`,
        `import { Item } from './item';`,
        `export class Service {`,
        `  private static readonly logger = new Logger();`,
        `  private local?: Logger;`,
        `  constructor(private readonly repo: Repo) {}`,
        `  async run(x: unknown) {`,
        `    Service.logger.error('a');`,             // 9: static field chain
        `    this.local?.error('b');`,                // 10: optional field
        `    (x as Logger).error('c');`,              // 11: cast
        `    const all = await this.repo.findAll();`, // 12
        `    all[0].total();`,                        // 13: element of awaited Promise<Item[]>
        `    for (const it of all) it.total();`,      // 14: for-of
        `    all.forEach(i => i.total());`,           // 15: callback element
        `    this.repo.first()?.total();`,            // 16: call chain with optional result
        `    all.map(v => v);`,                       // 17: array method — never a repo member
        `    const n = 'x'; n.includes('y');`,        // 18: primitive receiver
        `  }`,
        `}`,
        `export function map() {}`,
        `export function includes() {}`,
        ``,
    ].join('\n'),
};

let root, intel;
test.before(async () => {
    root = makeRepo(FILES);
    intel = new CodeIntel({ root });
    await intel.open();
});
test.after(() => { intel?.close(); rmrf(root); });

const lines = (target, file) => {
    const s = intel.findSymbols(target).matches[0];
    assert.ok(s, `symbol ${target} not found`);
    return [...intel.references(s.id).groups.values()].flat().filter(r => !file || r.path === file).map(r => r.line).sort((a, b) => a - b);
};

test('types receivers through static fields, optional fields and casts', () => {
    assert.deepEqual(lines('Logger.error', 'src/service.ts'), [9, 10, 11]);
});

test('types elements of awaited collections, loop variables and callback parameters', () => {
    assert.deepEqual(lines('Item.total', 'src/service.ts'), [13, 14, 15, 16]);
});

test('members of arrays and primitives never bind to same-named repository functions', () => {
    assert.deepEqual(lines('map', 'src/service.ts'), []);
    assert.deepEqual(lines('includes', 'src/service.ts'), []);
});

// ── other languages ─────────────────────────────────────────────────────────
const POLY = {
    // Python: Optional/list annotations, for-loops, comprehensions, inferred return types
    'py/models.py': `class Item:\n    def total(self):\n        return 0\n\n\nclass Repo:\n    def all(self) -> list[Item]:\n        return []\n\n    def first(self):\n        return Item()\n`,
    'py/svc.py': [
        'from typing import Optional',
        'from py.models import Item, Repo',
        '',
        '',
        'def run(repo: Repo, maybe: Optional[Item]):',
        '    for x in repo.all():',
        '        x.total()',            // 7
        '    repo.first().total()',      // 8 (inferred return type)
        '    maybe.total()',             // 9
        '    [y.total() for y in repo.all()]', // 10
        '',
    ].join('\n'),
    // Go: slices, range loops, (T, error) results
    'go.mod': 'module example.com/m\n\ngo 1.21\n',
    'eng/route.go': 'package eng\n\ntype Route struct{}\n\nfunc (r *Route) Handle() {}\n',
    'eng/engine.go': [
        'package eng',
        '',
        'type Engine struct{ routes []*Route }',
        '',
        'func (e *Engine) Find(n string) (*Route, error) { return nil, nil }',
        '',
        'func (e *Engine) Run() {',
        '\tfor _, r := range e.routes {',
        '\t\tr.Handle()',              // 9
        '\t}',
        '\te.routes[0].Handle()',     // 11
        '\trt, _ := e.Find("x")',
        '\trt.Handle()',              // 13
        '}',
        '',
    ].join('\n'),
    // Rust: Vec<T>, iter(), Option/Arc/Mutex unwrapping, Self
    'rs/lib.rs': [
        'pub struct Item;',
        'impl Item { pub fn total(&self) -> u32 { 0 } }',
        'pub struct Inner;',
        'impl Inner { pub fn flush(&self) {} }',
        'pub struct Store { items: Vec<Item>, inner: Arc<Mutex<Inner>> }',
        'impl Store {',
        '    pub fn new() -> Self { Store { items: vec![], inner: todo!() } }',
        '    pub fn first(&self) -> Option<&Item> { self.items.first() }',
        '    pub fn run(&self) {',
        '        for it in self.items.iter() { it.total(); }', // 10
        '        self.inner.lock().unwrap().flush();',        // 11
        '        self.first().unwrap().total();',             // 12
        '        Store::new().run();',                        // 13
        '    }',
        '}',
        '',
    ].join('\n'),
    // Java: List<T>, var, enhanced for, list.get(i)
    'jv/Item.java': 'package jv;\n\npublic class Item {\n  public int total() { return 0; }\n}\n',
    'jv/Cart.java': [
        'package jv;',
        '',
        'import java.util.List;',
        '',
        'public class Cart {',
        '  private List<Item> items;',
        '  void run() {',
        '    for (var it : items) { it.total(); }', // 8
        '    items.get(0).total();',                // 9
        '    var c = new Cart();',
        '    c.run();',                             // 11
        '  }',
        '}',
        '',
    ].join('\n'),
};

let polyRoot, poly;
test('multi-language receiver typing', async (t) => {
    polyRoot = makeRepo(POLY);
    poly = new CodeIntel({ root: polyRoot });
    await poly.open();
    t.after(() => { poly.close(); rmrf(polyRoot); });
    const at = (target, file) => {
        const s = poly.findSymbols(target).matches[0];
        assert.ok(s, `symbol ${target} not found`);
        return [...poly.references(s.id).groups.values()].flat().filter(r => r.path === file).map(r => r.line).sort((a, b) => a - b);
    };
    assert.deepEqual(at('py/models.py:Item.total', 'py/svc.py'), [7, 8, 9, 10], 'python');
    assert.deepEqual(at('eng/route.go:Route.Handle', 'eng/engine.go'), [9, 11, 13], 'go');
    assert.deepEqual(at('rs/lib.rs:Item.total', 'rs/lib.rs'), [10, 12], 'rust Item.total');
    assert.deepEqual(at('rs/lib.rs:Inner.flush', 'rs/lib.rs'), [11], 'rust Arc<Mutex<Inner>>');
    assert.deepEqual(at('rs/lib.rs:Store.run', 'rs/lib.rs'), [13], 'rust Self');
    assert.deepEqual(at('jv/Item.java:Item.total', 'jv/Cart.java'), [8, 9], 'java');
    assert.deepEqual(at('jv/Cart.java:Cart.run', 'jv/Cart.java'), [11], 'java var');
});
