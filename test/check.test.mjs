/**
 * check_changes must not cry wolf: a finding the agent has to disprove costs more than it saves.
 */
import test from 'node:test';
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
        assert.match(impact, /inherited by \(these subclasses run the changed code too\): 2\n\s+DorisParser\s+dialects\/doris\.py:4-5\n\s+StarRocksParser\s+dialects\/starrocks\.py:4-5/, impact);
        assert.match(impact, /tests\/test_doris\.py: \(tests a subclass that inherits it\)/, impact);
        assert.doesNotMatch(impact, /inherited by[\s\S]*TSQLParser  /, impact);
    } finally { intel.close(); rmrf(root); }
});
