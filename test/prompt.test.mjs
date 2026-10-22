/**
 * The UserPromptSubmit hook: the code names a request mentions, resolved before the first turn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { promptNames, promptContext } from '../src/cli/prompt.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const FILES = {
    'src/Port.kt': 'package probe\n\nfun interface RefreshPort {\n    fun execute()\n}\n\ninterface OtherPort {\n    fun execute()\n}\n',
    'src/Use.kt': [
        'package probe',
        '',
        'class RefreshUseCase : RefreshPort {',
        '    override fun execute() {}',
        '}',
        '',
        'class Controller(private val refresh: RefreshPort, private val other: OtherPort) {',
        '    fun post() {',
        '        refresh.execute()',
        '        other.execute()',
        '    }',
        '}',
        '',
        'class Scheduler(private val controller: Controller) {',
        '    fun tick() { controller.post() }',
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

test('names: code spans, qualified names, CamelCase types and snake_case functions, in order', () => {
    assert.deepEqual(
        promptNames('¿Quién llama a `execute` de `RefreshPort`? Mira también OtherPort.execute, record_episode y src/Use.kt.'),
        ['execute', 'RefreshPort', 'OtherPort.execute', 'record_episode'],
    );
    assert.deepEqual(promptNames('Explain the architecture of this project.'), []);
});

test('a type and a member named apart resolve together, with implementations and exact callers', () => {
    const text = promptContext(intel, '¿Qué código llama a `execute` de `RefreshPort`?');
    assert.match(text, /RefreshPort\.execute \(method, src\/Port\.kt:4\)/);
    assert.match(text, /implemented by: RefreshUseCase/);
    assert.match(text, /src\/Use\.kt:9 in Controller\.post: refresh\.execute\(\)/, 'each call with its code');
    assert.doesNotMatch(text, /Use\.kt:10/, 'other.execute() is OtherPort, not RefreshPort');
    assert.match(text, /This list is complete/);
    assert.match(text, /RefreshPort itself, every reference in production code/);
    assert.match(text, /Use\.kt:7 in Controller\.refresh \(type\): class Controller\(private val refresh: RefreshPort/, 'where the port is injected');
    assert.doesNotMatch(text, /one level up/, 'no path asked for');
});

test('a request for paths adds who calls each caller', () => {
    const text = promptContext(intel, '¿Qué puntos de entrada acaban llamando a `RefreshPort.execute`?');
    assert.match(text, /Controller\.post ← Scheduler\.tick \(Use\.kt:15\)/);
});

test('a bare name several definitions share is not guessed, and unknown names say nothing', () => {
    assert.equal(promptContext(intel, '¿Quién llama a `execute`?'), null);
    assert.equal(promptContext(intel, '¿Dónde se usa `NoSuchThing`?'), null);
});
