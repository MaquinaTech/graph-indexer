/**
 * Python references found while measuring against pyright (bench/eval-graph-python.mjs): each case
 * is a pattern that was missed or bound to the wrong definition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const FILES = {
    'pkg/__init__.py': 'from .functions import File as File\nfrom . import json as json\n',
    'pkg/params.py': 'class File:\n    pass\n\nclass Missing(Exception):\n    pass\n',
    'pkg/functions.py': [
        'from pkg import params',
        'def File():',
        '    return params.File()',
        '',
        'def request(method):',
        '    return method',
        '',
        'def make():',
        '    def decorator(func):',
        '        return func',
        '    return decorator',
        '',
    ].join('\n'),
    'pkg/json/__init__.py': 'def dumps(obj):\n    return str(obj)\n',
    'pkg/models.py': [
        'from __future__ import annotations',
        'from pkg.params import File, Missing',
        '__all__ = ["Holder"]',
        'class Holder:',
        '    def keep(self, f: File | None, g: list[File | int]) -> File | None:',
        '        try:',
        '            return f',
        '        except (Missing, ValueError):',
        '            return None',
        '        except Missing as e:',
        '            raise',
        '',
        'class Base:',
        '    @property',
        '    def debug(self):',
        '        return True',
        '    @debug.setter',
        '    def debug(self, v):',
        '        pass',
        '',
        'class App(Base):',
        '    def __init__(self):',
        '        self.debug = False',
        '    def show(self):',
        '        return self.debug',
        '',
    ].join('\n'),
    'pkg/adapters.py': 'class Adapter:\n    def send(self, request, *args, **kwargs):\n        log(request)\n        return request()\n\ndef log(x):\n    return x\n',
    'pkg/use.py': 'import pkg\nfrom pkg.models import Holder\n\ndef go():\n    return pkg.json.dumps(Holder)\n',
};

let root, intel;
test.before(async () => { root = makeRepo(FILES); intel = new CodeIntel({ root }); await intel.open(); });
test.after(() => { intel?.close(); rmrf(root); });

const uses = (file, qname) => {
    const s = intel.store.get('SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.qname = ? ORDER BY s.start_line LIMIT 1', file, qname);
    return [...intel.references(s.id).groups.values()].flat().map(r => `${r.path}:${r.line}`);
};

test('`from pkg import submodule; submodule.X` is the submodule\'s X, not what pkg/__init__ re-exports as X', () => {
    assert.ok(uses('pkg/params.py', 'File').includes('pkg/functions.py:3'));
    assert.ok(!uses('pkg/functions.py', 'File').includes('pkg/functions.py:3'));
});

test('an untyped parameter is the parameter, never a same-name function elsewhere', () => {
    const r = uses('pkg/functions.py', 'request');
    assert.deepEqual(r.filter(x => x.startsWith('pkg/adapters.py')), []);
});

test('`return name` is a use of a nested function', () => {
    assert.ok(uses('pkg/functions.py', 'make.decorator').includes('pkg/functions.py:11'));
});

test('union annotations, except clauses and __all__ are uses of the class', () => {
    const file = uses('pkg/params.py', 'File');
    assert.ok(file.includes('pkg/models.py:5'), 'A | None and list[A | int]');
    const missing = uses('pkg/params.py', 'Missing');
    assert.ok(missing.includes('pkg/models.py:8') && missing.includes('pkg/models.py:10'), 'except (A, B) and except A as e');
    assert.ok(uses('pkg/models.py', 'Holder').includes('pkg/models.py:3'), '__all__');
});

test('self.x read in a class whose base declares x as a property is the property, not the hoisted field', () => {
    assert.ok(uses('pkg/models.py', 'Base.debug').includes('pkg/models.py:25'));
});

test('`import pkg; pkg.json.dumps(…)` follows the submodule chain', () => {
    assert.ok(uses('pkg/json/__init__.py', 'dumps').includes('pkg/use.py:5'));
});
