/**
 * Regression tests for answers an agent must be able to trust: no confident wrong edges, no
 * silent gaps, and footers that say where the index is blind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const FILES = {
    // TypeScript: generic calls under await, a local named like a CommonJS global, same-name methods
    'src/injector.ts': `export class Injector {\n  async loadInstance<T>(x: T): Promise<T> { return x; }\n  async loadProvider(x: string) {\n    await this.loadInstance<string>(x);\n  }\n}\n`,
    'src/module.ts': `export class Module {\n  addProvider(p: string) { return p; }\n}\nexport function register(module: Module) {\n  module.addProvider('a');\n}\n`,
    'src/storage.ts': `export class HandlerStorage {\n  set(key: string, value: number) { return value; }\n}\n`,
    'src/use-map.ts': `export function fill(m: any) {\n  m.set('a', 1);\n}\n`,
    'src/use-map2.js': `export function fill(m) {\n  m.set('b', 2);\n}\n`,
    'src/tokens.ts': `export const APP_GUARD = 'APP_GUARD';\n`,
    'src/providers.ts': `import { APP_GUARD } from './tokens';\nexport const providers = { [APP_GUARD]: 1 };\n`,
    // an interface with implementations, one of them in a sample app
    'src/pipe.ts': `export interface PipeTransform {\n  transform(value: string): string;\n}\nexport class TrimPipe implements PipeTransform {\n  transform(value: string) { return value.trim(); }\n}\n`,
    'sample/app/pipe.ts': `import { PipeTransform } from '../../src/pipe';\nexport class TrimPipe implements PipeTransform {\n  transform(value: string) { return value; }\n}\n`,
    // Python: super(), string annotations, class calls reach __init__, package re-exports
    'aaa_docs/example.py': `from lib import Depends\n\n\ndef handler(dep=Depends()):\n    return dep\n`,
    'lib/__init__.py': `from .functions import Depends as Depends\n`,
    'lib/functions.py': `def Depends():\n    return None\n`,
    'lib/params.py': `class Depends:\n    pass\n`,
    'lib/base.py': `class Base:\n    def run(self):\n        return 1\n\n\nclass Child(Base):\n    def __init__(self, n):\n        self.n = n\n\n    def run(self):\n        return super().run()\n\n\ndef build() -> "Child":\n    return Child(1)\n`,
    // Go: implicit interface satisfaction, factories through a package
    'go.mod': 'module example.com/app\n\ngo 1.21\n',
    'binding/binding.go': `package binding\n\ntype Binding interface {\n\tName() string\n\tBind(v any) error\n}\n\ntype jsonBinding struct{}\n\nfunc (jsonBinding) Name() string { return "json" }\n\nfunc (jsonBinding) Bind(v any) error { return nil }\n\ntype half struct{}\n\nfunc (half) Name() string { return "half" }\n`,
};

let root, intel;
test.before(async () => {
    root = makeRepo(FILES);
    intel = new CodeIntel({ root });
    await intel.open();
});
test.after(() => { intel?.close(); rmrf(root); });

const refsTo = (target) => {
    const s = intel.findSymbols(target).matches[0];
    assert.ok(s, `symbol ${target}`);
    return [...intel.references(s.id).groups.values()].flat();
};

test('a call with type arguments under await is a call, not a property read', () => {
    const refs = refsTo('Injector.loadInstance');
    assert.ok(refs.some(r => r.path === 'src/injector.ts' && r.line === 4 && r.kind === 'call'), JSON.stringify(refs));
});

test('a parameter named like a global (module) still binds its calls', () => {
    const refs = refsTo('Module.addProvider');
    assert.ok(refs.some(r => r.path === 'src/module.ts' && r.line === 5), JSON.stringify(refs));
});

test('library method names on unknown receivers are not bound by name', () => {
    const refs = refsTo('HandlerStorage.set');
    assert.equal(refs.filter(r => r.path === 'src/use-map.ts').length, 0, JSON.stringify(refs));
});

test('computed property keys reference the constant', () => {
    const refs = refsTo('APP_GUARD');
    assert.ok(refs.some(r => r.path === 'src/providers.ts' && r.line === 2), JSON.stringify(refs));
});

test('ambiguous names prefer library code over sample apps', () => {
    const s = intel.findSymbols('TrimPipe').matches[0];
    assert.equal(s.path, 'src/pipe.ts');
});

test('change_impact lists overrides of an interface method', async () => {
    const text = await callTool(intel, 'change_impact', { symbols: ['PipeTransform.transform'] });
    assert.match(text, /overrides \/ implementations[^\n]*: 2/);
    assert.match(text, /TrimPipe\.transform {2}src\/pipe\.ts/);
});

test('Python: super() binds to the base method and string annotations are type references', () => {
    assert.ok(refsTo('Base.run').some(r => r.path === 'lib/base.py' && r.line === 11 && r.confidence === 'exact'));
    assert.ok(refsTo('Child').some(r => r.path === 'lib/base.py' && r.line === 14 && r.kind === 'type'));
});

test('Python: calling a class counts as a use of its __init__', async () => {
    const text = await callTool(intel, 'change_impact', { symbols: ['Child.__init__'] });
    assert.match(text, /lib\/base\.py:15 {2}in build/);
});

test('Python: a package re-export is followed even when the importer was indexed first', () => {
    const refs = refsTo('lib/functions.py:Depends');
    assert.ok(refs.some(r => r.path === 'aaa_docs/example.py'), JSON.stringify(refs));
    assert.equal(refsTo('lib/params.py:Depends').filter(r => r.path === 'aaa_docs/example.py').length, 0);
});

test('Go: a type implements an interface when its method set covers it', () => {
    const impl = refsTo('Binding').filter(r => r.kind === 'inherit');
    assert.deepEqual(impl.map(r => r.src_qname), ['jsonBinding']);
});

test('the unbound footer says why unrelated same-name calls can be ignored', async () => {
    const text = await callTool(intel, 'find_references', { symbol: 'HandlerStorage.set' });
    assert.match(text, /none is in a file that mentions `HandlerStorage`/);
});
