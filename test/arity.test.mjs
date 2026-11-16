/**
 * sigParamTypes (src/parse/arity.mjs): the parameter types of a stored Java-like signature, with
 * annotations and `final` removed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sigParamTypes } from '../src/parse/arity.mjs';

test('sigParamTypes drops annotations, their arguments and final', () => {
    assert.deepEqual(sigParamTypes('void f(@Nullable String a, final int[] xs)', 'f'), ['String', 'int[]']);
    assert.deepEqual(sigParamTypes('void g(@Size(min = 1) List<String> xs, @A("x") @B final int n)', 'g'), ['List<String>', 'int']);
    // a parameter list left open is unreadable
    assert.deepEqual(sigParamTypes('void k(@A(x T t)', 'k'), null);
    assert.deepEqual(sigParamTypes('void v(String... rest)', 'v'), ['String...']);
});

test('sigParamTypes takes linear time on a parameter made of unclosed annotations', () => {
    // CodeQL js/polynomial-redos: `@0(` repeated, with no `)`, made the old pattern quadratic
    // (240,000 characters took 8.6 s); stored signatures are cut to 800 characters, but the
    // function must not depend on that
    // (the `]`s close the `(`s for the parameter scan, so the text reaches the annotation pattern)
    const n = 80_000;
    const t0 = performance.now();
    const types = sigParamTypes(`void f(${'@0('.repeat(n)}${']'.repeat(n)} x)`, 'f');
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `took ${Math.round(ms)} ms`);
    assert.equal(types.length, 1);
});
