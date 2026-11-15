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

test('a field assigned an element of itself (`self.impl = self.impl[0]`) does not loop the resolver', async () => {
    const r = makeRepo({
        'bench.py': [
            'class Case:',
            '    def __init__(self, impl):',
            '        self.impl = impl',
            '    def setup(self):',
            '        self.impl = self.impl[0]',
            '    def run(self, obj):',
            '        return self.impl(obj).key',
            '',
        ].join('\n'),
    });
    const ci = new CodeIntel({ root: r });
    try {
        await ci.open();
        const s = ci.store.get("SELECT s.id FROM symbols s WHERE s.qname = 'Case.run'");
        assert.ok(s, 'indexed');
    } finally { ci.close(); rmrf(r); }
});

// ── what pyright's own typing rules add (flask, requests, httpx, click) ────────────────────────────

const RULES = {
    'lib/__init__.py': 'from .models import Response\nfrom . import session\n',
    'lib/models.py': [
        'class Response:',
        '    def read(self):',
        '        return 1',
        '    @property',
        '    def elapsed(self):',
        '        return 0',
        '    @elapsed.setter',
        '    def elapsed(self, v):',
        '        pass',
        '',
        'class Child(Response):',
        '    def __init__(self):',
        '        self.elapsed = 5',
        '        self.fresh = 1',
        '',
        'def get() -> Response:',
        '    return Response()',
        '',
        'def pair() -> tuple[int, Response]:',
        '    return 1, Response()',
        '',
        'def helper():',
        '    return 1',
        '',
    ].join('\n'),
    'lib/session.py': 'class Session:\n    def send(self):\n        return 1\n',
    'lib/cookies.py': 'class Jar:\n    def refill(self):\n        return 1\n',
    'lib/app.py': [
        'import lib',
        'from lib.models import Response, get, pair',
        '',
        'def local_import():',
        '    from lib import session',
        '    return session.Session()',
        '',
        'def elsewhere():',
        '    return session.Session()',
        '',
        'def reassigned(r):',
        '    r.read()',
        '    r = get()',
        '    r.read()',
        '',
        'def declared(r: Response):',
        '    r = get()',
        '    return r.read()',
        '',
        'def unpack():',
        '    n, resp = pair()',
        '    return resp.read()',
        '',
        'def submodules():',
        '    return lib.session.Session(), lib.cookies.Jar()',
        '',
        'FUNCS = (lib.models.helper,)',
        '',
        'def fixture_like(thing):',
        '    return thing.refill()',
        '',
    ].join('\n'),
    'tests/test_app.py': 'def test_x(thing):\n    return thing.refill()\n',
};

test('Python typing rules', async (t) => {
    const r = makeRepo(RULES);
    const ci = new CodeIntel({ root: r });
    await ci.open();
    const refs = (file, qname) => {
        const s = ci.store.get('SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.qname = ? ORDER BY s.start_line LIMIT 1', file, qname);
        return [...ci.references(s.id).groups.values()].flat().map(x => `${x.path}:${x.line}`);
    };
    try {
        await t.test('an import inside a function binds its names in that function only', () => {
            const u = refs('lib/session.py', 'Session');
            assert.ok(u.includes('lib/app.py:6'));
            assert.ok(!u.includes('lib/app.py:9'));
        });
        await t.test('an untyped parameter later assigned a typed value has that type from the assignment on', () => {
            const u = refs('lib/models.py', 'Response.read');
            assert.ok(u.includes('lib/app.py:14'));
        });
        await t.test('an annotated parameter keeps its declared type through a later assignment', () => {
            assert.ok(refs('lib/models.py', 'Response.read').includes('lib/app.py:18'));
        });
        await t.test('`a, b = f()` types each name from the tuple the function returns', () => {
            assert.ok(refs('lib/models.py', 'Response.read').includes('lib/app.py:22'));
        });
        await t.test('`@x.setter` and `self.x = v` through a base class property are uses of the property', () => {
            const u = refs('lib/models.py', 'Response.elapsed');
            assert.ok(u.includes('lib/models.py:7'), 'the setter decorator');
            assert.ok(u.includes('lib/models.py:13'), 'the assignment that runs the setter');
            assert.ok(!u.includes('lib/models.py:14'), 'a new attribute is not a use');
        });
        await t.test('`pkg.sub` is an attribute of a package only once something imported it', () => {
            assert.ok(refs('lib/session.py', 'Session').includes('lib/app.py:25'), 'imported by lib/__init__');
            assert.ok(!refs('lib/cookies.py', 'Jar').includes('lib/app.py:25'), 'never imported');
        });
        await t.test('a module function named as a value is a use', () => {
            assert.ok(refs('lib/models.py', 'helper').includes('lib/app.py:27'));
        });
        await t.test('a member of an object nothing types is not bound by name: pytest fills test parameters', () => {
            const u = refs('lib/cookies.py', 'Jar.refill');
            assert.ok(!u.includes('tests/test_app.py:2'));
            // outside test code the guess by a unique name stays, at its low confidence
            assert.ok(u.includes('lib/app.py:30'));
        });
    } finally { ci.close(); rmrf(r); }
});
