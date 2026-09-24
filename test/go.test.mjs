/**
 * Go references measured against the Go type checker (bench/eval-graph-go.mjs): each case here is
 * one the checker answered differently before it was fixed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const FILES = {
    'go.mod': 'module example.com/shop/v2\n\ngo 1.21\n',
    'shop.go': [
        'package shop',
        '',
        'type Module interface {',
        '\tID() string',
        '}',
        '',
        'type Handler interface {',
        '\tServe(w Writer) error',
        '}',
        '',
        'type AdminHandler interface {',
        '\tServe(w Writer, next Handler) error',
        '}',
        '',
        'type Writer struct{}',
        '',
        'type Pool struct{}',
        '',
        'func NewPool() *Pool { return &Pool{} }',
        '',
        'func (p *Pool) Delete(key string) {}',
        '',
        'type Base struct{}',
        '',
        'func (Base) Serve(w Writer) error { return nil }',
        '',
        'type Engine struct {',
        '\tBase',
        '}',
        '',
        'type Plain struct{}',
        '',
        'func (Plain) Serve(w Writer, next Handler) error { return nil }',
        '',
        'var _ Handler = (*Engine)(nil)',
        '',
    ].join('\n'),
    'store/store.go': [
        'package store',
        '',
        'import (',
        '\t"net/http"',
        '',
        '\t"example.com/shop/v2"',
        ')',
        '',
        'type Store struct{ origin shop.Module }',
        '',
        'var pool = shop.NewPool()',
        '',
        'func (s *Store) Name() string { return s.origin.ID() }',
        '',
        'func (s *Store) Drop() { pool.Delete("x") }',
        '',
        'func Form(req *http.Request) any { return req.PostForm }',
        '',
        'func stack() string { return "" }',
        '',
        'func dump() {',
        '\tstack := stack()',
        '\tprintln(stack)',
        '\tcheck := func() {}',
        '\tcheck()',
        '}',
        '',
        'func check() {}',
        '',
        'type Alias = shop.Base',
        '',
    ].join('\n'),
    'store/form.go': 'package store\n\nfunc (s *Store) PostForm() any { return nil }\n',
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
const at = (refs, path, line) => refs.some(r => r.path === path && r.line === line);

test('Go: a module at a major version (…/v2) is imported under its package name', () => {
    assert.ok(at(refsTo('Module.ID'), 'store/store.go', 13), 'field of type shop.Module');
    assert.ok(at(refsTo('Pool.Delete'), 'store/store.go', 15), 'package var initialised by shop.NewPool()');
});

test('Go: a conversion to a pointer type, (*T)(nil), references T', () => {
    assert.ok(at(refsTo('Engine'), 'shop.go', 35));
});

test("Go: a library type's members are not bound by name to the repository's", () => {
    assert.ok(!at(refsTo('Store.PostForm'), 'store/store.go', 17), 'req.PostForm is a field of *http.Request');
});

test('Go: a local shadows the package function of the same name from its declaration on', () => {
    const stack = refsTo('store/store.go:stack');
    assert.ok(at(stack, 'store/store.go', 22), 'the call that declares the local');
    assert.ok(!at(stack, 'store/store.go', 23), 'the local passed on');
    assert.ok(!at(refsTo('store/store.go:check'), 'store/store.go', 25), 'a local closure called');
});

test('Go: implicit implementations count promoted methods and aliases, and compare signatures', () => {
    const impl = (i) => refsTo(i).filter(r => r.kind === 'inherit').map(r => r.src_qname).sort();
    assert.deepEqual(impl('Handler'), ['Alias', 'Base', 'Engine']); // Alias = shop.Base
    assert.deepEqual(impl('AdminHandler'), ['Plain']);
});

test('Go: reopening the index keeps them', async () => {
    intel.close();
    intel = new CodeIntel({ root });
    await intel.open();
    const impl = refsTo('Handler').filter(r => r.kind === 'inherit').map(r => r.src_qname).sort();
    assert.deepEqual(impl, ['Alias', 'Base', 'Engine']);
});
