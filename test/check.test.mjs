/**
 * check_changes must not cry wolf: a finding the agent has to disprove costs more than it saves.
 */
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { makeRepo, writeFile, rmrf } from './helpers.mjs';

const GRAPH = (decorator, extra = '') => `from functools import cached_property


class _WeakCached:
    def __init__(self, func):
        self.func = func

    def __get__(self, obj, cls=None):
        return self.func(obj)


class View:
    def __call__(self, nbunch=None, weight=None):
        return self


class Graph:
    @${decorator}
    def edges(self):
        return View()


def degree_of(G, node${extra}):
    return G.edges([node], weight="w")
`;

const FILES = {
    'graph.py': GRAPH('cached_property'),
    'algo.py': `from graph import Graph, degree_of\n\n\ndef run(G: Graph):\n    G.edges([1])\n    return degree_of(G, 1)\n`,
};

let root, intel;
test.before(async () => {
    root = makeRepo(FILES);
    intel = new CodeIntel({ root });
    await intel.open();
});
test.after(() => { intel?.close(); rmrf(root); });

test('Python: a def wrapped in a class-based descriptor is not checked against its own parameters', async () => {
    // cached_property → a custom caching descriptor, plus a real signature change elsewhere
    writeFile(root, 'graph.py', GRAPH('_WeakCached', ', weight'));
    const text = await callTool(intel, 'check_changes', {});
    assert.doesNotMatch(text, /Graph\.edges/, text);
    assert.match(text, /degree_of[\s\S]*algo\.py:6/, text);
});

test('check_changes names the test functions closest to the change and how to run just those', async () => {
    const files = {
        'pkg/__init__.py': '',
        'pkg/money.py': 'def to_cents(x):\n    return int(x * 100)\n\n\ndef fmt(x):\n    return str(to_cents(x))\n',
        'pkg/other.py': 'def unrelated():\n    return 1\n',
        'tests/__init__.py': '',
        'tests/test_money.py': 'import unittest\nfrom pkg.money import to_cents, fmt\n\n\nclass TestMoney(unittest.TestCase):\n    def test_cents(self):\n        self.assertEqual(to_cents(1), 100)\n\n    def test_fmt(self):\n        self.assertEqual(fmt(1), "100")\n',
        'tests/test_other.py': 'import unittest\nfrom pkg.other import unrelated\n\n\nclass TestOther(unittest.TestCase):\n    def test_unrelated(self):\n        self.assertEqual(unrelated(), 1)\n',
    };
    for (const [runner, extra] of [['unittest', {}], ['pytest', { 'pytest.ini': '[pytest]\n' }]]) {
        const root = makeRepo({ ...files, ...extra });
        const intel = new CodeIntel({ root });
        try {
            await intel.open();
            writeFile(root, 'pkg/money.py', 'def to_cents(x):\n    return round(x * 100)\n\n\ndef fmt(x):\n    return str(to_cents(x))\n');
            const text = await callTool(intel, 'check_changes', {});
            assert.match(text, /test functions that reach the changed code[^\n]*\(2\): tests\/test_money\.py::TestMoney::test_cents, tests\/test_money\.py::TestMoney::test_fmt/, runner);
            assert.match(text, runner === 'pytest'
                ? /run these first: python -m pytest -q tests\/test_money\.py::TestMoney::test_cents tests\/test_money\.py::TestMoney::test_fmt/
                : /run these first: python -m unittest tests\.test_money\.TestMoney\.test_cents tests\.test_money\.TestMoney\.test_fmt/, runner);
            assert.doesNotMatch(text, /test_unrelated/);
        } finally { intel.close(); rmrf(root); }
    }
});

test('check_changes and change_impact name the subclasses that inherit a changed method, and their tests', async () => {
    const root = makeRepo({
        'dialects/__init__.py': '',
        'dialects/base.py': 'class Parser:\n    def parse_unique(self, tokens):\n        return list(tokens)\n\n    def parse_key(self, tokens):\n        return self.parse_unique(tokens)\n',
        'dialects/mysql.py': 'from dialects.base import Parser\n\n\nclass MySQLParser(Parser):\n    def parse_unique(self, tokens):\n        return sorted(tokens)\n',
        'dialects/doris.py': 'from dialects.mysql import MySQLParser\n\n\nclass DorisParser(MySQLParser):\n    pass\n',
        'dialects/starrocks.py': 'from dialects.doris import DorisParser\n\n\nclass StarRocksParser(DorisParser):\n    LIMIT = 3\n',
        'dialects/tsql.py': 'from dialects.mysql import MySQLParser\n\n\nclass TSQLParser(MySQLParser):\n    def parse_unique(self, tokens):\n        return tokens[:1]\n',
        'tests/__init__.py': '',
        'tests/test_mysql.py': 'import unittest\n\n\nclass TestMySQL(unittest.TestCase):\n    def test_ddl(self):\n        self.assertTrue(True)\n',
        'tests/test_doris.py': 'import unittest\n\n\nclass TestDoris(unittest.TestCase):\n    def test_ddl(self):\n        self.assertTrue(True)\n',
        'tests/test_starrocks.py': 'import unittest\n\n\nclass TestStarRocks(unittest.TestCase):\n    def test_ddl(self):\n        self.assertTrue(True)\n',
        'tests/test_tsql.py': 'import unittest\n\n\nclass TestTSQL(unittest.TestCase):\n    def test_ddl(self):\n        self.assertTrue(True)\n',
    });
    const intel = new CodeIntel({ root });
    try {
        await intel.open();
        writeFile(root, 'dialects/mysql.py', 'from dialects.base import Parser\n\n\nclass MySQLParser(Parser):\n    def parse_unique(self, tokens):\n        return sorted(set(tokens))\n');
        const text = await callTool(intel, 'check_changes', {});
        assert.match(text, /subclasses of MySQLParser that inherit parse_unique run the changed code too \(2\): DorisParser \(dialects\/doris\.py\), StarRocksParser \(dialects\/starrocks\.py\)/, text);
        assert.match(text, /overridden, so not reached by the change: TSQLParser\.parse_unique \(dialects\/tsql\.py\)/, text);
        assert.match(text, /test files that exercise the change \(3\): tests\/test_doris\.py, tests\/test_mysql\.py, tests\/test_starrocks\.py/, text);
        const impact = await callTool(intel, 'change_impact', { symbols: ['MySQLParser.parse_unique'] });
        assert.match(impact, /inherited or extended by \(these subclasses run the changed code too\): 2\n\s+DorisParser\s+dialects\/doris\.py:4-5\n\s+StarRocksParser\s+dialects\/starrocks\.py:4-5/, impact);
        assert.match(impact, /tests\/test_doris\.py: \(tests a subclass that inherits it\)/, impact);
        assert.doesNotMatch(impact, /extended by[\s\S]*TSQLParser  /, impact);
    } finally { intel.close(); rmrf(root); }
});

test('a subclass whose own version uses the changed one is reached, not overridden', async () => {
    // TRANSFORMS = {**Base.TRANSFORMS, …} and super().m() extend the parent's member: a change to it
    // still runs in the subclass and in the subclasses that inherit the subclass's version
    const root = makeRepo({
        'gens/__init__.py': '',
        'gens/mysql.py': 'class MySQLGenerator:\n    TRANSFORMS = {"if": 1}\n\n    def cast_sql(self, e):\n        return str(e)\n',
        'gens/singlestore.py': 'from gens.mysql import MySQLGenerator\n\n\nclass SingleStoreGenerator(MySQLGenerator):\n    TRANSFORMS = {**MySQLGenerator.TRANSFORMS, "concat": 2}\n\n    def cast_sql(self, e):\n        return super().cast_sql(e).upper()\n',
        'gens/memsql.py': 'from gens.singlestore import SingleStoreGenerator\n\n\nclass MemSQLGenerator(SingleStoreGenerator):\n    pass\n',
        'gens/tsql.py': 'from gens.mysql import MySQLGenerator\n\n\nclass TSQLGenerator(MySQLGenerator):\n    TRANSFORMS = {"top": 3}\n',
        'tests/__init__.py': '',
        'tests/test_singlestore.py': 'import unittest\n\n\nclass TestSingleStore(unittest.TestCase):\n    def test_if(self):\n        self.assertTrue(True)\n',
        'tests/test_memsql.py': 'import unittest\n\n\nclass TestMemSQL(unittest.TestCase):\n    def test_if(self):\n        self.assertTrue(True)\n',
        'tests/test_tsql.py': 'import unittest\n\n\nclass TestTSQL(unittest.TestCase):\n    def test_top(self):\n        self.assertTrue(True)\n',
    });
    const intel = new CodeIntel({ root });
    try {
        await intel.open();
        writeFile(root, 'gens/mysql.py', 'class MySQLGenerator:\n    TRANSFORMS = {"if": 1, "nullif": 4}\n\n    def cast_sql(self, e):\n        return repr(e)\n');
        const text = await callTool(intel, 'check_changes', {});
        assert.match(text, /subclasses of MySQLGenerator whose own [\w, ]+ uses this one run the changed code too \(2\): SingleStoreGenerator \(gens\/singlestore\.py\), MemSQLGenerator \(gens\/memsql\.py\)/, text);
        assert.match(text, /that inherit TRANSFORMS, cast_sql run the changed code too \(1\): TSQLGenerator/, text); // its cast_sql is MySQL's
        assert.match(text, /overridden, so not reached by the change: TSQLGenerator\.TRANSFORMS \(gens\/tsql\.py\)/, text);
        assert.doesNotMatch(text, /overridden[^\n]*SingleStoreGenerator/, text);
        assert.match(text, /test files that exercise the change \(3\): tests\/test_memsql\.py, tests\/test_singlestore\.py, tests\/test_tsql\.py/, text);
    } finally { intel.close(); rmrf(root); }
});

test('on request, tests that reach a changed module by its name in a string are listed apart', async () => {
    // transpile(sql, write="presto") picks the generator by name: no reference shows it
    const root = makeRepo({
        'sqlx/__init__.py': 'def transpile(sql, write=None):\n    return sql\n',
        'sqlx/generators/__init__.py': '',
        'sqlx/generators/presto.py': 'def date_diff_sql(e):\n    return "DATE_DIFF"\n',
        'tests/__init__.py': '',
        'tests/test_presto.py': 'from sqlx.generators.presto import date_diff_sql\n\n\ndef test_diff():\n    assert date_diff_sql(1)\n',
        'tests/test_mysql.py': 'from sqlx import transpile\n\n\ndef test_to_presto():\n    assert transpile("x", write="presto")\n',
        'tests/test_other.py': 'def test_nothing():\n    assert "prestoish"\n',
    });
    const intel = new CodeIntel({ root });
    try {
        await intel.open();
        writeFile(root, 'sqlx/generators/presto.py', 'def date_diff_sql(e):\n    return "DATE_DIFF(x)"\n');
        // off by default: only the tests that reach the change by a reference
        const plain = await callTool(intel, 'check_changes', {});
        assert.match(plain, /test files that exercise the change \(1\): tests\/test_presto\.py/, plain);
        assert.doesNotMatch(plain, /name a changed module|test_mysql/, plain);
        const text = await callTool(intel, 'check_changes', { by_name: true });
        assert.match(text, /test files that exercise the change \(1\): tests\/test_presto\.py/, text);
        assert.match(text, /test files that name a changed module in a string [^\n]*\(1\): tests\/test_mysql\.py/, text);
        assert.doesNotMatch(text, /test_other/, text);
    } finally { intel.close(); rmrf(root); }
});

test('Python: a classmethod called through its class is not short of its cls argument', async () => {
    const files = {
        'lit.py': 'class Literal:\n    @classmethod\n    def string(cls, value):\n        return cls()\n\n    @staticmethod\n    def number(value):\n        return value\n',
        'use.py': 'from lit import Literal\n\n\ndef make():\n    return Literal.string("a")\n',
    };
    const root = makeRepo(files);
    const intel = new CodeIntel({ root });
    try {
        await intel.open();
        // a new call to each: neither is short of an argument
        writeFile(root, 'use.py', 'from lit import Literal\n\n\ndef make():\n    return Literal.string("a"), Literal.string("b"), Literal.number(1)\n');
        const text = await callTool(intel, 'check_changes', {});
        assert.doesNotMatch(text, /call does not fit|no longer fit/, text);
        // and a call that really is short still is
        writeFile(root, 'use.py', 'from lit import Literal\n\n\ndef make():\n    return Literal.string()\n');
        assert.match(await callTool(intel, 'check_changes', {}), /call does not fit Literal\.string/);
    } finally { intel.close(); rmrf(root); }
});

/** A repository, an edit to it, and what `check_changes` says about the edit. */
/** `edits`: path → new text, or null to delete the file; `act(root)` for anything else (a move). */
async function checked(files, edits, args = {}, act = null) {
    const root = makeRepo(files);
    const intel = new CodeIntel({ root });
    await intel.open();
    try {
        for (const [rel, text] of Object.entries(edits)) { if (text === null) fs.rmSync(path.join(root, rel)); else writeFile(root, rel, text); }
        act?.(root);
        return await callTool(intel, 'check_changes', args);
    } finally { intel.close(); rmrf(root); }
}

test('JavaScript: a call that passes fewer arguments than declared is not a problem, it is listed to look at', async () => {
    const text = await checked({
        'lib/merge.js': `export function merge(target, source) {\n  return Object.assign(target, source);\n}\n`,
        'lib/use.js': `import { merge } from './merge.js';\nexport const a = merge({}, { x: 1 });\nexport const b = merge({});\n`,
    }, { 'lib/merge.js': `export function merge(target, source, caseless) {\n  return Object.assign(target, source, { caseless });\n}\n` });
    assert.doesNotMatch(text, /✗/, text);
    assert.match(text, /No problems found/, text);
    assert.match(text, /• merge \(lib\/merge\.js\) now declares 3 parameters \(was 2\)[\s\S]*legal in JavaScript[\s\S]*lib\/use\.js:2/, text);
});

test('TypeScript: the same edit is a problem, as the compiler would say', async () => {
    const text = await checked({
        'lib/merge.ts': `export function merge(target: object, source: object) {\n  return Object.assign(target, source);\n}\n`,
        'lib/use.ts': `import { merge } from './merge';\nexport const a = merge({}, { x: 1 });\n`,
    }, { 'lib/merge.ts': `export function merge(target: object, source: object, caseless: boolean) {\n  return Object.assign(target, source, { caseless });\n}\n` });
    assert.match(text, /✗ 1 of 1 call site no longer fits merge[\s\S]*lib\/use\.ts:2/, text);
});

test('Python: a call that passes a keyword the definition no longer takes', async () => {
    const text = await checked({
        'pkg/__init__.py': '',
        'pkg/render.py': `def render(node, pretty=False, indent=2):\n    return str(node)\n`,
        'pkg/use.py': `from pkg.render import render\n\n\ndef show(n):\n    a = render(n, pretty=True)\n    b = render(n, indent=4)\n    return a + b\n`,
    }, { 'pkg/render.py': `def render(node, compact=False, indent=2):\n    return str(node)\n` });
    assert.match(text, /✗ 1 of 2 call sites passes a keyword render \(pkg\/render\.py\) no longer takes:\n\s+pkg\/use\.py:5.*passes pretty=/, text);
    assert.doesNotMatch(text, /use\.py:6[^\n]*passes/, text);
});

test('Python: a keyword the definition still takes through **kwargs is not flagged', async () => {
    const text = await checked({
        'pkg/__init__.py': '',
        'pkg/render.py': `def render(node, pretty=False):\n    return str(node)\n`,
        'pkg/use.py': `from pkg.render import render\n\n\ndef show(n):\n    return render(n, pretty=True)\n`,
    }, { 'pkg/render.py': `def render(node, **opts):\n    return str(node)\n` });
    assert.doesNotMatch(text, /✗/, text);
});

test('a removed type, constant or attribute still used elsewhere is found through its binding, not its name', async () => {
    // Go: a type renamed in one file of the package, still named in another (no import says so)
    let text = await checked({
        'go.mod': 'module example.com/app\n\ngo 1.21\n',
        'fs/fs.go': `package fs\n\ntype onlyfilesFS struct{ root string }\n\nfunc (o onlyfilesFS) Open(name string) string { return o.root + name }\n`,
        'fs/group.go': `package fs\n\nfunc Dir(root string) onlyfilesFS {\n\treturn onlyfilesFS{root: root}\n}\n`,
    }, { 'fs/fs.go': `package fs\n\ntype onlyFilesFS struct{ root string }\n\nfunc (o onlyFilesFS) Open(name string) string { return o.root + name }\n` });
    assert.match(text, /✗ onlyfilesFS \(struct, fs\/fs\.go\) was removed or renamed but is still used[\s\S]*fs\/group\.go:3/, text);

    // Python: a module constant read as `settings.LIMIT`, and an attribute read on a typed value
    text = await checked({
        'app/__init__.py': '',
        'app/settings.py': `LIMIT = 10\nNAME = "app"\n`,
        'app/model.py': `class User:\n    def __init__(self):\n        self.email = ""\n        self.name = ""\n`,
        'app/use.py': `from app import settings\nfrom app.model import User\n\n\ndef cap(u: User):\n    return settings.LIMIT, u.email\n`,
    }, { 'app/settings.py': `MAX_ITEMS = 10\nNAME = "app"\n`, 'app/model.py': `class User:\n    def __init__(self):\n        self.address = ""\n        self.name = ""\n` });
    assert.match(text, /✗ LIMIT \((variable|constant), app\/settings\.py\) was removed or renamed but is still used[\s\S]*app\/use\.py:6/, text);
    assert.match(text, /✗ User\.email \(field, app\/model\.py\) was removed or renamed but is still used[\s\S]*app\/use\.py:6/, text);
});

test('a removed function does not claim calls of a method that shares its name', async () => {
    const text = await checked({
        'lib/util.js': `export function map(xs, f) {\n  return xs.map(f);\n}\nexport function keep(x) { return x; }\n`,
        'lib/a.js': `import { keep } from './util.js';\nexport const doubled = [1, 2].map(x => keep(x) * 2);\nexport const names = new Map().get('a');\n`,
    }, { 'lib/util.js': `export function keep(x) { return x; }\n` });
    assert.doesNotMatch(text, /✗/, text);
    assert.match(text, /No problems found/, text);
});

test('a method removed from a class is still declared by the interface it implements, in a file not touched', async () => {
    const text = await checked({
        'src/app.interface.ts': `export interface INestApp {\n  listen(port: number): void;\n  listenAsync(port: number): Promise<void>;\n}\n`,
        'src/app.ts': `import { INestApp } from './app.interface';\nexport class NestApp implements INestApp {\n  listen(port: number) {}\n  listenAsync(port: number) { return Promise.resolve(); }\n}\n`,
    }, { 'src/app.ts': `import { INestApp } from './app.interface';\nexport class NestApp implements INestApp {\n  listen(port: number) {}\n}\n` });
    assert.match(text, /• NestApp\.listenAsync was removed or renamed; the same method is still declared as it was in a file you did not modify: INestApp\.listenAsync \(src\/app\.interface\.ts:3, declares it\)/, text);
});

test('a signature that changes without changing its argument count lists the callers in files not touched', async () => {
    const text = await checked({
        'go.mod': 'module example.com/app\n\ngo 1.21\n',
        'ctx/ctx.go': `package ctx\n\ntype Context struct{ ip string }\n\nfunc (c *Context) RemoteIP() (string, bool) {\n\treturn c.ip, true\n}\n`,
        'ctx/use.go': `package ctx\n\nfunc Client(c *Context) string {\n\tip, _ := c.RemoteIP()\n\treturn ip\n}\n`,
    }, { 'ctx/ctx.go': `package ctx\n\ntype Context struct{ ip string }\n\nfunc (c *Context) RemoteIP() string {\n\treturn c.ip\n}\n` });
    assert.match(text, /• Context\.RemoteIP changed its signature, not its argument count; 1 call site in files you did not modify \(review if a parameter or the result means something else now\): ctx\/use\.go:4/, text);
});

test('Python: a generator passed as the only argument is one argument, and a value named like a class is a value', async () => {
    const text = await checked({
        'pkg/__init__.py': '',
        'pkg/logic.py': `def fuzzy_or(args):\n    return any(args)\n\n\nclass Graph:\n    def add_edges_from(self, edges, weight=None):\n        return edges\n\n\nclass G(Graph):\n    pass\n`,
        'pkg/use.py': `from pkg.logic import fuzzy_or, Graph\n\n\ndef run(xs):\n    G = Graph()\n    G.add_edges_from([(0, 1)])\n    return fuzzy_or(x > 0 for x in xs)\n`,
    }, {
        'pkg/logic.py': `def fuzzy_or(args, strict=False):\n    return any(args)\n\n\nclass Graph:\n    def add_edges_from(self, edges, weight=None, check=False):\n        return edges\n\n\nclass G(Graph):\n    pass\n`,
    });
    assert.doesNotMatch(text, /✗/, text);
});

// ── found by an independent reading of the code (2026-11-15): none of these was in the benchmark ──

test('a file deleted or moved while others still import it by its old path', async () => {
    const files = {
        'src/util.ts': `export function helper(x: number) { return x + 1; }\n`,
        'src/main.ts': `import { helper } from './util';\nexport const one = helper(0);\n`,
        'pkg/__init__.py': '',
        'pkg/util.py': `def helper(x):\n    return x\n`,
        'pkg/app.py': `from pkg.util import helper\n\n\ndef run():\n    return helper(1)\n`,
    };
    const deleted = await checked(files, { 'src/util.ts': null, 'pkg/util.py': null });
    assert.match(deleted, /✗ src\/util\.ts was deleted but is still imported by its old path \(1\):\n    src\/main\.ts:1/);
    assert.match(deleted, /✗ pkg\/util\.py was deleted but is still imported by its old path \(1\):\n    pkg\/app\.py:1/);
    assert.match(deleted, /2 problems found/);
    // moved with a plain `mv` (a deletion and an untracked file with the same text) under another name
    const moved = await checked(files, {}, {}, (root) => fs.renameSync(path.join(root, 'src/util.ts'), path.join(root, 'src/helpers.ts')));
    assert.match(moved, /✗ src\/util\.ts was moved to src\/helpers\.ts but is still imported by its old path \(1\):\n    src\/main\.ts:1/);
    // moved and its importer updated: nothing to say
    const done = await checked(files, { 'src/main.ts': `import { helper } from './helpers';\nexport const one = helper(0);\n` }, {}, (root) => fs.renameSync(path.join(root, 'src/util.ts'), path.join(root, 'src/helpers.ts')));
    assert.doesNotMatch(done, /✗/, done);
});

test('a file renamed only in its letter case and edited, git not told: the import by the old name is reported', async () => {
    // where the file system answers for both names git says `src/util.ts` was modified; elsewhere, that
    // it was deleted and `src/Util.ts` is new. Either way the import no longer names the file.
    let folds = false;
    const recase = (root) => { folds = fs.existsSync(path.join(root, 'SRC')); fs.renameSync(path.join(root, 'src/util.ts'), path.join(root, 'src/x.tmp')); fs.renameSync(path.join(root, 'src/x.tmp'), path.join(root, 'src/Util.ts')); writeFile(root, 'src/Util.ts', `export function helper(x: number, y: number) { return x + y; }\n`); };
    const files = {
        'src/util.ts': `export function helper(x: number) { return x + 1; }\n`,
        'src/main.ts': `import { helper } from './util';\nexport const one = helper(0);\n`,
    };
    const text = await checked(files, {}, {}, recase);
    assert.match(text, /✗ src\/util\.ts was (moved to src\/Util\.ts|deleted) but is still imported by its old path \(1\):\n    src\/main\.ts:1/, text);
    // the importer follows the new name: what is left is the call with one argument (where git sees
    // one file that changed; a deleted file and a new one are not compared with each other)
    const followed = await checked(files, { 'src/main.ts': `import { helper } from './Util';\nexport const one = helper(0);\n` }, {}, recase);
    assert.doesNotMatch(followed, /imported by its old path/, followed);
    if (folds) assert.match(followed, /✗ 1 of 1 call site no longer fits helper \(src\/Util\.ts; now takes 2, was 1\):\n    src\/main\.ts:2/, followed);
});

test('a removed function is found although another file declares one of the same name; a moved one with its users updated is not', async () => {
    const files = {
        'pkg/__init__.py': '',
        'pkg/util.py': `def helper(x):\n    return x\n\n\ndef other():\n    return 0\n`,
        'pkg/misc.py': `def helper(y):\n    return y * 2\n`,
        'pkg/app.py': `from pkg.util import helper\n\n\ndef run():\n    return helper(1)\n`,
    };
    const removed = await checked(files, { 'pkg/util.py': `def other():\n    return 0\n` });
    assert.match(removed, /✗ helper \(function, pkg\/util\.py\) was removed or renamed but is still used/);
    assert.match(removed, /pkg\/app\.py/);
    // the definition moved to another module and the importer follows it there
    const moved = await checked(files, {
        'pkg/util.py': `def other():\n    return 0\n`,
        'pkg/more.py': `def helper(x):\n    return x\n`,
        'pkg/app.py': `from pkg.more import helper\n\n\ndef run():\n    return helper(1)\n`,
    });
    assert.doesNotMatch(moved, /✗/, moved);
    // …or the old module still serves it
    const reexported = await checked({
        'src/a.ts': `export function helper(x: number) { return x; }\n`,
        'src/use.ts': `import { helper } from './a';\nexport const v = helper(1);\n`,
    }, { 'src/a.ts': `export { helper } from './b';\n`, 'src/b.ts': `export function helper(x: number) { return x; }\n` });
    assert.doesNotMatch(reexported, /✗/, reexported);
});

test('changed files whose path holds a space or a non-ASCII letter are checked', async () => {
    const text = await checked({
        'src/my util.ts': `export function helper(x: number) { return x; }\nexport function keep() { return 0; }\n`,
        'src/app.ts': `import { helper } from './my util';\nexport const v = helper(1);\n`,
        'pkg/__init__.py': '',
        'pkg/útil.py': `def ayuda(x):\n    return x\n\n\ndef queda():\n    return 0\n`,
        'pkg/app.py': `from pkg.útil import ayuda\n\n\ndef run():\n    return ayuda(1)\n`,
    }, { 'src/my util.ts': `export function keep() { return 0; }\n`, 'pkg/útil.py': `def queda():\n    return 0\n` });
    assert.match(text, /Checked 2 changed files/);
    assert.match(text, /✗ helper \(function, src\/my util\.ts\) was removed or renamed but is still used/);
    assert.match(text, /✗ ayuda \(function, pkg\/útil\.py\) was removed or renamed but is still used/);
});

test('Python: a decorator that supplies arguments does not make a correct change a problem', async () => {
    // click hands `name` to the function; nobody passes it at the call site, before or after
    const click = await checked({
        'tool/cli.py': `import click\n\n\n@click.command()\n@click.option("--name")\ndef cli(name):\n    return name\n`,
        'tool/__main__.py': `from tool.cli import cli\n\ncli()\n`,
        'tool/__init__.py': '',
    }, { 'tool/cli.py': `import click\n\n\n@click.command()\n@click.option("--name")\n@click.option("--verbose", is_flag=True)\ndef cli(name, verbose):\n    return name\n` });
    assert.doesNotMatch(click, /✗/, click);
    // a call written now to a function whose decorator passes it its first argument
    const injected = await checked({
        'app/db.py': `def with_db(f):\n    def run(*a, **k):\n        return f(object(), *a, **k)\n    return run\n\n\n@with_db\ndef fetch(db, key):\n    return key\n`,
        'app/use.py': `from app.db import fetch\n\n\ndef run():\n    return 1\n`,
        'app/__init__.py': '',
    }, { 'app/use.py': `from app.db import fetch\n\n\ndef run():\n    return fetch("k")\n` });
    assert.doesNotMatch(injected, /✗/, injected);
    // without a decorator the same new call is one argument short
    const plain = await checked({
        'app/db.py': `def fetch(db, key):\n    return key\n`,
        'app/use.py': `from app.db import fetch\n\n\ndef run():\n    return 1\n`,
        'app/__init__.py': '',
    }, { 'app/use.py': `from app.db import fetch\n\n\ndef run():\n    return fetch("k")\n` });
    assert.match(plain, /✗ call does not fit fetch/);
});

test('Rust: a method called through its type passes its receiver by hand', async () => {
    const files = {
        'Cargo.toml': `[package]\nname = "demo"\nversion = "0.1.0"\n`,
        'src/lib.rs': `pub struct S;\n\nimpl S {\n    pub fn m(&self, a: i32) -> i32 { a }\n}\n\npub fn run(s: &S) -> i32 {\n    S::m(s, 1) + s.m(1)\n}\n`,
    };
    const done = await checked(files, { 'src/lib.rs': `pub struct S;\n\nimpl S {\n    pub fn m(&self, a: i32, b: i32) -> i32 { a + b }\n}\n\npub fn run(s: &S) -> i32 {\n    S::m(s, 1, 2) + s.m(1, 2)\n}\n` });
    assert.doesNotMatch(done, /✗/, done);
    const half = await checked(files, { 'src/lib.rs': `pub struct S;\n\nimpl S {\n    pub fn m(&self, a: i32, b: i32) -> i32 { a + b }\n}\n\npub fn run(s: &S) -> i32 {\n    S::m(s, 1) + s.m(1)\n}\n` });
    assert.match(half, /✗ 2 of 2 call sites no longer fit S\.m/);
});

test('what the caps leave out is said', async () => {
    const n = 45;
    const defs = (extra) => Array.from({ length: n }, (_, i) => `export function f${i}(a: number${extra}) { return a; }`).join('\n') + '\n';
    const text = await checked({
        'src/defs.ts': defs(''),
        'src/use.ts': `import { ${Array.from({ length: n }, (_, i) => `f${i}`).join(', ')} } from './defs';\n${Array.from({ length: n }, (_, i) => `export const v${i} = f${i}(1);`).join('\n')}\n`,
    }, { 'src/defs.ts': defs(', b: number') });
    assert.match(text, /not checked: 5 more definitions changed their parameters and were not checked against their call sites: f40, f41/);
});

// ── found by the independent review of 3.2.0 ─────────────────────────────────────

test('review: check works when the repository is a directory inside a git work tree', async () => {
    const root = makeRepo({
        'pkg/src/util.ts': `export function u(a: number) { return a; }\n`,
        'pkg/src/b.ts': `import { u } from './util';\nexport const x = u(1);\n`,
    });
    const intel = new CodeIntel({ root: path.join(root, 'pkg') });
    await intel.open();
    try {
        writeFile(root, 'pkg/src/util.ts', `export function u(a: number, b: number) { return a + b; }\n`);
        const text = await callTool(intel, 'check_changes', {});
        assert.match(text, /✗ 1 of 1 call site no longer fits u[\s\S]*src\/b\.ts:2/, text);
        fs.rmSync(path.join(root, 'pkg/src/util.ts'));
        const gone = await callTool(intel, 'check_changes', {});
        assert.match(gone, /src\/util\.ts was deleted but is still imported by its old path/, gone);
    } finally { intel.close(); rmrf(root); }
});

test('review: check reads the diff whatever prefixes the user configured for it', async () => {
    const { spawnSync } = await import('node:child_process');
    for (const key of ['diff.noprefix', 'diff.mnemonicPrefix']) {
        const text = await checked({
            'b/lib.ts': `export function f(a: number) { return a; }\n`,
            'main.ts': `import { f } from './b/lib';\nexport const y = f(1);\n`,
        }, { 'b/lib.ts': `export function f(a: number, b: number) { return a + b; }\n` }, {}, (root) => spawnSync('git', ['config', key, 'true'], { cwd: root }));
        assert.match(text, /✗ 1 of 1 call site no longer fits f/, `${key}\n${text}`);
    }
});

test('review: a file renamed only in its letter case, content unchanged, git not told: the import by the old name is reported', async () => {
    let folds = false;
    const text = await checked({
        'src/util.ts': `export function helper(x: number) { return x + 1; }\n`,
        'src/main.ts': `import { helper } from './util';\nexport const one = helper(0);\n`,
    }, {}, {}, (root) => { folds = fs.existsSync(path.join(root, 'SRC')); fs.renameSync(path.join(root, 'src/util.ts'), path.join(root, 'src/x.tmp')); fs.renameSync(path.join(root, 'src/x.tmp'), path.join(root, 'src/Util.ts')); });
    assert.match(text, /✗ src\/util\.ts was (moved to src\/Util\.ts|deleted) but is still imported by its old path \(1\)/, `${folds}\n${text}`);
});
