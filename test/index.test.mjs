import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CodeIntel } from '../src/query/intel.mjs';
import { makeRepo, writeFile, rmrf } from './helpers.mjs';

const FILES = {
    // TypeScript: DI through constructor parameter properties + barrel re-export + inheritance
    'src/users/user.repository.ts': `export class UserRepository {\n  findById(id: string) { return null; }\n  save(u: User) { return u; }\n}\nexport interface User { id: string }\n`,
    'src/users/index.ts': `export { UserRepository } from './user.repository';\n`,
    'src/users/base.service.ts': `export abstract class BaseService {\n  audit(msg: string) { console.log(msg); }\n}\n`,
    'src/users/user.service.ts': `import { UserRepository } from './index';\nimport { BaseService } from './base.service';\n\n/** Application service for users. */\nexport class UserService extends BaseService {\n  constructor(private readonly repo: UserRepository) { super(); }\n  getUser(id: string) {\n    this.audit('get');\n    return this.repo.findById(id);\n  }\n}\n`,
    'src/users/user.controller.ts': `import { UserService } from './user.service';\nexport class UserController {\n  constructor(private users: UserService) {}\n  show(id: string) { return this.users.getUser(id); }\n}\n`,
    'src/users/user.service.spec.ts': `import { UserService } from './user.service';\nimport { UserRepository } from './user.repository';\ndescribe('UserService', () => { it('gets', () => { const s = new UserService(new UserRepository()); s.getUser('1'); }); });\n`,
    // Python: module import + self.field typing
    'pkg/store.py': `class Store:\n    def put(self, key, value):\n        return None\n\n\ndef make_store():\n    return Store()\n`,
    'pkg/cache.py': `from pkg.store import Store\n\n\nclass Cache:\n    """Write-through cache."""\n    def __init__(self, store: Store):\n        self.store = store\n\n    def set(self, key, value):\n        self.store.put(key, value)\n`,
    // Go: methods by receiver type across files of one package
    'go.mod': 'module example.com/app\n\ngo 1.21\n',
    'server/engine.go': `package server\n\ntype Engine struct {\n\trouter *Router\n}\n\nfunc New() *Engine { return &Engine{router: &Router{}} }\n\nfunc (e *Engine) Run() {\n\te.router.Handle("/")\n}\n`,
    'server/router.go': `package server\n\n// Router dispatches requests.\ntype Router struct{}\n\n// Handle registers a path.\nfunc (r *Router) Handle(path string) {}\n`,
    'cmd/main.go': `package main\n\nimport "example.com/app/server"\n\nfunc main() {\n\te := server.New()\n\te.Run()\n}\n`,
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
    assert.ok(s, `symbol ${target} not found`);
    const r = intel.references(s.id);
    return [...r.groups.values()].flat();
};

test('indexes every language and nests members under their types', () => {
    const st = intel.stats();
    assert.equal(st.files, Object.keys(FILES).length - 1); // go.mod is not source
    const svc = intel.findSymbols('UserService.getUser').matches[0];
    assert.equal(svc.kind, 'method');
    assert.equal(svc.qname, 'UserService.getUser');
    const run = intel.findSymbols('Engine.Run').matches[0];
    assert.equal(run.path, 'server/engine.go');
    assert.equal(intel.findSymbols('UserService').matches[0].doc, 'Application service for users.');
});

test('binds calls through constructor-injected fields (TypeScript DI)', () => {
    const refs = refsTo('UserRepository.findById');
    assert.ok(refs.some(r => r.path === 'src/users/user.service.ts' && r.line === 9 && r.confidence === 'exact'), JSON.stringify(refs));
    const viaCtl = refsTo('UserService.getUser');
    assert.ok(viaCtl.some(r => r.path === 'src/users/user.controller.ts' && r.confidence === 'exact'));
});

test('follows barrel re-exports and inheritance (this.audit → BaseService.audit)', () => {
    const typeRefs = refsTo('UserRepository');
    assert.ok(typeRefs.some(r => r.path === 'src/users/user.service.ts'));
    const audit = refsTo('BaseService.audit');
    assert.ok(audit.some(r => r.path === 'src/users/user.service.ts' && r.line === 8));
});

test('types Python receivers through annotated __init__ parameters', () => {
    const refs = refsTo('Store.put');
    assert.ok(refs.some(r => r.path === 'pkg/cache.py' && r.line === 10 && r.confidence === 'exact'), JSON.stringify(refs));
});

test('resolves Go methods through package imports, factories and struct fields', () => {
    const run = refsTo('Engine.Run');
    assert.ok(run.some(r => r.path === 'cmd/main.go' && r.line === 7));
    const handle = refsTo('Router.Handle');
    assert.ok(handle.some(r => r.path === 'server/engine.go' && r.line === 10), JSON.stringify(handle));
});

test('change impact reaches transitive dependents and tests', () => {
    const repo = intel.findSymbols('UserRepository.findById').matches[0];
    const { nodes } = intel.dependents([repo.id], { depth: 3 });
    const names = [...nodes.keys()].map(id => intel.sym(id).qname);
    assert.ok(names.includes('UserService.getUser'));
    assert.ok(names.includes('UserController.show'));
});

test('incremental update keeps ids stable and refreshes references', async () => {
    const before = intel.findSymbols('UserRepository.findById').matches[0];
    // add a new caller and shift lines in the repository file
    writeFile(root, 'src/users/user.repository.ts', `// moved down\n` + FILES['src/users/user.repository.ts']);
    writeFile(root, 'src/users/admin.ts', `import { UserRepository } from './user.repository';\nexport function purge(r: UserRepository) { return r.findById('x'); }\n`);
    await intel.ix.syncPaths(['src/users/user.repository.ts', 'src/users/admin.ts']);
    const after = intel.findSymbols('UserRepository.findById').matches[0];
    assert.equal(after.id, before.id, 'symbol id must survive re-indexing');
    assert.equal(after.start_line, before.start_line + 1, 'line numbers must be fresh');
    const refs = refsTo('UserRepository.findById');
    assert.ok(refs.some(r => r.path === 'src/users/user.service.ts'), 'old reference still bound');
    assert.ok(refs.some(r => r.path === 'src/users/admin.ts' && r.line === 2), 'new reference bound');
    // deleting a file removes its symbols and the references into it become unbound
    fs.unlinkSync(path.join(root, 'src/users/admin.ts'));
    await intel.ix.syncPaths(['src/users/admin.ts']);
    assert.equal(intel.findSymbols('purge').matches.length, 0);
});

test('ensureFresh picks up edits made on disk without an explicit sync', async () => {
    intel.lastSweep = 0; // force the periodic sweep path
    writeFile(root, 'pkg/extra.py', `from pkg.cache import Cache\n\n\ndef warm(c: Cache):\n    c.set('a', 1)\n`);
    await intel.ensureFresh();
    const refs = refsTo('Cache.set');
    assert.ok(refs.some(r => r.path === 'pkg/extra.py' && r.line === 5));
});

test('an index written by another extractor version is rebuilt; an interrupted run is re-resolved', async () => {
    const dbPath = intel.dbPath;
    intel.close();
    // simulate an upgrade: facts on disk were produced by a different extractor
    const { Store } = await import('../src/store/db.mjs');
    let s = new Store(dbPath);
    s.setMeta('fingerprint', 'older-extractor');
    s.run("UPDATE symbols SET name = 'stale', name_lc = 'stale' WHERE qname = 'UserService.getUser'");
    s.close();
    intel = new CodeIntel({ root });
    await intel.open();
    assert.equal(intel.findSymbols('stale').matches.length, 0, 'stale facts dropped');
    assert.ok(intel.findSymbols('UserService.getUser').matches.length, 'facts re-extracted');
    // simulate a crash between writing facts and resolving references
    intel.close();
    s = new Store(dbPath);
    s.run('UPDATE refs SET dst_id = NULL, conf = 0');
    s.setMeta('resolve_pending', '1');
    s.close();
    intel = new CodeIntel({ root });
    await intel.open();
    assert.ok(refsTo('UserRepository.findById').some(r => r.path === 'src/users/user.service.ts'), 'references re-resolved after an interrupted run');
});
