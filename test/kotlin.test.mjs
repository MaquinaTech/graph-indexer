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
    // Kotlin 2.x syntax that grammar 0.3.8 and 5b7b9b7 could not read: each of these lines left an
    // ERROR region, and the members after it could be cut from their class
    'src/Modern.kt': [
        'package probe',
        '',
        'class Modern(private val port: RefreshPort) {',
        '    fun guard(x: Any, ok: Boolean) = when (x) {',
        '        is String if ok -> 1',
        '        else -> 0',
        '    }',
        '    fun until(n: Int) { for (i in 0..<n) port.execute() }',
        '    fun dollars() = $$"$name and $${1 + 1}"',
        '    fun bits() = 0b1010',
        '    context(scope: Any) fun inContext() = 1',
        '    fun later() = suspend { port.execute() }',
        '    fun last() = 2',
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
    const refresh = refsOf('RefreshPort.execute').filter(r => r.path === 'src/Callers.kt');
    assert.deepEqual(lines(refresh), [5, 13, 20]);
    assert.ok(refresh.every(r => r.confidence === 'exact'), refresh.map(r => `${r.line}:${r.confidence}`).join(' '));
    assert.deepEqual(lines(refsOf('OtherPort.execute')), [6]);
});

test('Kotlin 2.x syntax parses: guard conditions, ..<, $$ strings, binary literals, context parameters, suspend lambdas', () => {
    assert.equal(intel.store.get("SELECT parse_errors FROM files WHERE path = 'src/Modern.kt'").parse_errors, 0);
    for (const m of ['guard', 'until', 'dollars', 'bits', 'inContext', 'later', 'last']) assert.equal(sym(`Modern.${m}`)?.kind, 'method', m);
    const modern = refsOf('RefreshPort.execute').filter(r => r.path === 'src/Modern.kt');
    assert.deepEqual(lines(modern), [8, 12]);
});
