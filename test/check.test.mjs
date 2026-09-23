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
