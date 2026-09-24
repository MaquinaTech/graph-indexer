/**
 * Resolved indirection (src/query/facts.mjs): the conclusions an agent otherwise derives by searching —
 * which override runs, which table entry handles a key, what reaches a method by a built name, what a
 * decorator is — and silence when the code has no indirection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { factsForRange, factsForSymbol, handlersOfKey } from '../src/query/facts.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const FILES = {
    'pkg/__init__.py': '',
    'pkg/exp.py': `class Expr:
    pass


class Concat(Expr):
    pass


class Upper(Expr):
    pass


class Lower(Expr):
    pass
`,
    'pkg/helpers.py': `def concat_to_pipes(self, e):
    return " || ".join(e.args)


def upper_fn(self, e):
    return "UPPER"


def lower_fn(self, e):
    return "LOWER"


def registered(fn):
    """Mark a generator method as registered with the plugin table."""
    return fn
`,
    'pkg/generator.py': `from pkg import exp
from pkg.helpers import upper_fn, lower_fn, registered


def _build_dispatch(cls):
    dispatch = dict(cls.TRANSFORMS)
    for name in dir(cls):
        if not name.endswith("_sql"):
            continue
        dispatch[name[:-4]] = getattr(cls, name)
    return dispatch


class Generator:
    TRANSFORMS = {
        exp.Upper: upper_fn,
        exp.Lower: lower_fn,
    }

    def sql(self, e):
        return self.render(e)

    def render(self, e):
        return str(e)

    def concat_sql(self, e):
        return "CONCAT(" + ", ".join(e.args) + ")"

    @registered
    def upper_sql(self, e):
        return "UPPER"
`,
    'pkg/sqlite.py': `from pkg import exp, generator
from pkg.helpers import concat_to_pipes


class SQLiteGenerator(generator.Generator):
    TRANSFORMS = {
        **generator.Generator.TRANSFORMS,
        exp.Concat: concat_to_pipes,
        exp.Upper: concat_to_pipes,
    }

    def render(self, e):
        return "sqlite:" + str(e)


class LiteGenerator(SQLiteGenerator):
    pass


class OtherGenerator(generator.Generator):
    pass
`,
    'pkg/plain.py': `def add(a, b):
    return a + b


def twice(a):
    return add(a, a)
`,
    'web/routes.ts': `import { listUsers, getUser } from './handlers';

export const ROUTES = {
  '/users': listUsers,
  '/users/:id': getUser,
};
`,
    'web/handlers.ts': `export function listUsers() { return []; }
export function getUser(id: string) { return id; }
`,
};

let root, intel;
test.before(async () => {
    root = makeRepo(FILES);
    intel = new CodeIntel({ root });
    await intel.open();
});
test.after(() => { intel?.close(); if (root) rmrf(root); });

const texts = (facts) => facts.map(f => f.text).join('\n');
const symbol = (q) => intel.findSymbols(q).matches[0];

test('facts: a method subclasses override or inherit — who runs which version', () => {
    const facts = factsForSymbol(intel, symbol('Generator.render').id);
    const t = texts(facts);
    assert.match(t, /Generator\.render: overridden in 1 subclass: SQLiteGenerator \(pkg\/sqlite\.py\)/);
    assert.match(t, /inherited unchanged by 1: OtherGenerator/);
    // a call through self to it: the base version or the override
    const sql = factsForSymbol(intel, symbol('Generator.sql').id);
    assert.match(texts(sql), /self\.render\(\) \(line \d+\) runs Generator\.render \(pkg\/generator\.py:\d+\) or one of 1 override: SQLiteGenerator\.render/);
});

test('facts: registration tables — the handler of a key, the keys of a class, what a subclass table replaces', () => {
    const handler = texts(factsForSymbol(intel, symbol('concat_to_pipes').id));
    assert.match(handler, /concat_to_pipes is registered as the handler of exp\.Concat in SQLiteGenerator\.TRANSFORMS \(pkg\/sqlite\.py:8\)/);
    const key = texts(factsForSymbol(intel, symbol('Upper').id));
    assert.match(key, /Upper is a key of 2 table entries: /);
    assert.match(key, /Generator\.TRANSFORMS → upper_fn/);
    assert.match(key, /SQLiteGenerator\.TRANSFORMS → concat_to_pipes/);
    const table = texts(factsForRange(intel, 'pkg/sqlite.py', 5, 10));
    assert.match(table, /SQLiteGenerator\.TRANSFORMS extends Generator\.TRANSFORMS \(pkg\/generator\.py:\d+\) with 2 entries, 1 replacing inherited ones \(exp\.Upper\)/);
    const rows = handlersOfKey(intel, symbol('Concat').id);
    assert.deepEqual(rows.map(r => [r.table, r.handlers.map(h => h.name)]), [['SQLiteGenerator.TRANSFORMS', ['concat_to_pipes']]]);
});

test('facts: a method reached by a name built at run time, and the class it handles', () => {
    const byName = texts(factsForSymbol(intel, symbol('Generator.concat_sql').id));
    assert.match(byName, /concat_sql is called by name from _build_dispatch \(pkg\/generator\.py:8: .*endswith\("_sql"\).*\) — for Concat \(pkg\/exp\.py:5\) \[name convention\]/);
    const cls = texts(factsForSymbol(intel, symbol('Concat').id));
    assert.match(cls, /Concat is handled by name \(pkg\/generator\.py:8\) by Generator\.concat_sql/);
});

test('facts: what a decorator applied in the lines is', () => {
    const t = texts(factsForSymbol(intel, symbol('Generator.upper_sql').id));
    assert.match(t, /@registered is registered \(pkg\/helpers\.py:13\): Mark a generator method as registered with the plugin table\./);
});

test('facts: an object literal of handlers in TypeScript is a table too', () => {
    const t = texts(factsForSymbol(intel, symbol('getUser').id));
    assert.match(t, /getUser is registered as the handler of '\/users\/:id' in ROUTES \(web\/routes\.ts:5\)/);
});

test('facts: code without indirection gets none (silence), and facts are not repeated', () => {
    assert.deepEqual(factsForRange(intel, 'pkg/plain.py', 1, 7), []);
    const first = factsForSymbol(intel, symbol('concat_to_pipes').id);
    assert.ok(first.length);
    assert.deepEqual(factsForSymbol(intel, symbol('concat_to_pipes').id, { shown: new Set(first.map(f => f.key)) }), []);
});

test('read_code and get_symbol carry the resolved facts', async () => {
    const read = await callTool(intel, 'read_code', { targets: ['pkg/sqlite.py:1-15'] });
    assert.match(read, /Resolved \(what runs, what reaches it\):/);
    assert.match(read, /SQLiteGenerator\.TRANSFORMS extends Generator\.TRANSFORMS/);
    const plain = await callTool(intel, 'read_code', { targets: ['pkg/plain.py:1-7'] });
    assert.doesNotMatch(plain, /Resolved/);
    const sym = await callTool(intel, 'get_symbol', { symbol: 'Generator.render' });
    assert.match(sym, /inherited unchanged by \(1, they run this code\): OtherGenerator/);
});
