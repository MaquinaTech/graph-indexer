/**
 * Kotlin: a `fun interface` (a SAM interface) is an interface like any other — its member is a
 * method, and a call through it binds to that method whatever holds the receiver (#5).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const FILES = {
    'src/Port.kt': [
        'package probe',
        '',
        'fun interface RefreshPort {',
        '    fun execute()',
        '}',
        '',
        'interface OtherPort {',
        '    fun execute()',
        '}',
        '',
    ].join('\n'),
    'src/Callers.kt': [
        'package probe',
        '',
        'class ViaConstructor(private val refresh: RefreshPort, private val other: OtherPort) {',
        '    fun run() {',
        '        refresh.execute()',
        '        other.execute()',
        '    }',
        '}',
        '',
        'class ViaBodyProperty(port: RefreshPort) {',
        '    private val refresh: RefreshPort = port',
        '    fun run() {',
        '        refresh.execute()',
        '    }',
        '}',
        '',
        'class ViaLocal {',
        '    fun run(port: RefreshPort) {',
        '        val refresh: RefreshPort = port',
        '        refresh.execute()',
        '    }',
        '}',
        '',
    ].join('\n'),
};

let root, intel;
test.before(async () => {
    root = makeRepo(FILES);
    intel = new CodeIntel({ root });
    await intel.open();
});
test.after(() => { intel?.close(); rmrf(root); });

const sym = (qname) => intel.store.get('SELECT s.id, s.kind FROM symbols s WHERE s.qname = ?', qname);
const refsOf = (qname) => [...intel.references(sym(qname).id).groups.values()].flat();
const lines = (refs) => refs.map(r => r.line).sort((a, b) => a - b);

test('Kotlin: a fun interface is an interface, and its member is a method', () => {
    assert.equal(sym('RefreshPort')?.kind, 'interface');
    assert.equal(sym('RefreshPort.execute')?.kind, 'method');
    assert.equal(sym('execute'), undefined, 'no top-level execute');
});

test('Kotlin: calls through a fun interface bind exactly, from a constructor property, a property or a local', () => {
    const refresh = refsOf('RefreshPort.execute');
    assert.deepEqual(lines(refresh), [5, 13, 20]);
    assert.ok(refresh.every(r => r.confidence === 'exact'), refresh.map(r => `${r.line}:${r.confidence}`).join(' '));
    assert.deepEqual(lines(refsOf('OtherPort.execute')), [6]);
});
