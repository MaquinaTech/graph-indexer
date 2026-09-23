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
