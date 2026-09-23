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
    // an implementation reached through a base class, declared over two lines
    'src/shapes.ts': `export interface Shape {\n  area(): number;\n}\nexport class Polygon implements Shape {\n  area() { return 0; }\n}\nexport class Square\n  extends Polygon {\n  area() { return 1; }\n}\n`,
    // Python: super(), string annotations, class calls reach __init__, package re-exports
    'aaa_docs/example.py': `from lib import Depends\n\n\ndef handler(dep=Depends()):\n    return dep\n`,
    'lib/__init__.py': `from .functions import Depends as Depends\n`,
    'lib/functions.py': `def Depends():\n    return None\n`,
    'lib/params.py': `class Depends:\n    pass\n`,
    'lib/base.py': `class Base:\n    def run(self):\n        return 1\n\n\nclass Child(Base):\n    def __init__(self, n):\n        self.n = n\n\n    def run(self):\n        return super().run()\n\n\ndef build() -> "Child":\n    return Child(1)\n`,
    // Go: implicit interface satisfaction, factories through a package
    'go.mod': 'module example.com/app\n\ngo 1.21\n',
    // narrowing by type tests, and members named by string in stubs
    'src/errors.ts': `export class WsError {\n  getError() { return 1; }\n}\nexport class RpcError {\n  getError() { return 2; }\n}\nexport function handle(e: unknown) {\n  if (!(e instanceof WsError)) {\n    return 0;\n  }\n  return e.getError();\n}\n`,
    'src/creator.ts': `export class ContextCreator {\n  createContext() { return []; }\n}\nexport class FiltersContext extends ContextCreator {\n  create() { return this.createContext(); }\n}\n`,
    'test/filters.spec.ts': `import { FiltersContext } from '../src/creator';\ndescribe('createContext', () => {\n  const f = new FiltersContext();\n  sinon.stub(f, 'createContext').returns([]);\n});\n`,
    // a method inherited by a subclass, called on a callback parameter of unknown type
    'src/sockets.ts': `export class TcpSocket {\n  sendMessage(m: object) { return m; }\n}\nexport class JsonSocket extends TcpSocket {}\nexport class KafkaServer {\n  sendMessage(m: object) { return m; }\n}\n`,
    'test/connection.spec.ts': `import { JsonSocket } from '../src/sockets';\nexport function withSocket(cb: (s: JsonSocket) => void) { cb(new JsonSocket()); }\nwithSocket(socket => {\n  socket.sendMessage({ type: 'ping' });\n});\n`,
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

test('unknown receivers in files that use a subclass inheriting the member are worth checking', async () => {
    const out = await callTool(intel, 'find_references', { symbol: 'TcpSocket.sendMessage' });
    assert.match(out, /Possibly missed[\s\S]*test\/connection\.spec\.ts:4/);
    const other = await callTool(intel, 'find_references', { symbol: 'KafkaServer.sendMessage' });
    assert.doesNotMatch(other, /connection\.spec\.ts:4/);
});

test('instanceof narrows the receiver, also after an early return', async () => {
    const out = await callTool(intel, 'find_references', { symbol: 'WsError.getError' });
    assert.match(out, /src\/errors\.ts[\s\S]*return e\.getError\(\)/);
    assert.doesNotMatch(out, /Possibly missed/);
});

test('members named by string in stubs are reported for renames', async () => {
    const out = await callTool(intel, 'find_references', { symbol: 'ContextCreator.createContext' });
    assert.match(out, /named as a string/);
    assert.match(out, /test\/filters\.spec\.ts:4 .*sinon\.stub\(f, 'createContext'\)/);
    assert.doesNotMatch(out, /filters\.spec\.ts:2 /); // a describe() title is not a use
});

test('a type lists what inherits it indirectly, and through which type', async () => {
    const out = await callTool(intel, 'find_references', { symbol: 'Shape', kind: 'inherit' });
    assert.match(out, /in Polygon/);
    assert.match(out, /Indirect subtypes \(1\)[\s\S]*src\/shapes\.ts:7 +class Square +via Polygon/);
    const poly = await callTool(intel, 'find_references', { symbol: 'Polygon', kind: 'inherit' });
    assert.match(poly, /in Square \(class at line 7\)/);
    assert.match(poly, /No indirect subtypes: nothing extends or implements/);
    const sym = await callTool(intel, 'get_symbol', { symbol: 'Shape', include_code: false });
    assert.match(sym, /indirect, through one of those \(1\): Square via Polygon/);
});

test('find_references keeps to a path', async () => {
    const all = await callTool(intel, 'find_references', { symbol: 'PipeTransform', kind: 'inherit' });
    assert.match(all, /sample\/app\/pipe\.ts/);
    const src = await callTool(intel, 'find_references', { symbol: 'PipeTransform', kind: 'inherit', path: 'src/' });
    assert.doesNotMatch(src, /sample\/app\/pipe\.ts/);
    assert.match(src, /1 in 1 file under src\/ \(of 2\)/);
});

test('a call list with nothing left unbound says it is complete', async () => {
    const out = await callTool(intel, 'find_references', { symbol: 'Injector.loadInstance' });
    assert.match(out, /Complete: every "loadInstance\(…\)" call in the indexed files is bound to this definition/);
    const set = await callTool(intel, 'find_references', { symbol: 'HandlerStorage.set' });
    assert.doesNotMatch(set, /Complete:/);
});
