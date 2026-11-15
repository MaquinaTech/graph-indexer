/**
 * Java references the way javac binds them (bench/eval-graph-java.mjs): overloads of one arity told
 * apart by their argument types, library imports, qualified `this`, constructions inside a class,
 * and nested types named through their outer class. Each case is one the oracle found.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

async function repo(t, files) {
    const root = makeRepo(files);
    const intel = new CodeIntel({ root });
    await intel.open();
    t.after(() => { intel.close(); rmrf(root); });
    /** Lines in `file` that reference the definition named `q` in `p` (by line, when overloaded). */
    return (p, q, file, line = null) => {
        const s = intel.findSymbols(q).matches.find(m => m.path === p && (line == null || m.start_line === line));
        assert.ok(s, `symbol ${p}:${q}${line ? '@' + line : ''} not found`);
        return [...intel.references(s.id).groups.values()].flat().filter(r => r.path === file && r.kind !== 'import').map(r => r.line).sort((a, b) => a - b);
    };
}

test('java: overloads of one arity bind by the argument types the source shows', async (t) => {
    const at = await repo(t, {
        'src/p/Tok.java': [
            'package p;',                                                  // 1
            'class Tok {',                                                 // 2
            '    static final char replacement = 0;',                      // 3
            '    void append(char c) {}',                                  // 4
            '    void append(String s) {}',                                // 5
            '    void put(int[] cps, int a) {}',                           // 6
            '    void put(String s, int a) {}',                            // 7
            '    void g(String x, char[] cs, int[] ints) {',               // 8
            '        char r = 0;',                                         // 9
            '        append(r);',                                          // 10
            '        append("x");',                                        // 11
            "        append('-');",                                        // 12
            '        append(cs[0]);',                                      // 13
            '        append(replacement);',                                // 14
            '        append("a" + x);',                                    // 15
            '        put(ints, 1);',                                       // 16
            '        put(x, 2);',                                          // 17
            '    }',
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/p/Tok.java', 'Tok.append', 'src/p/Tok.java', 4), [10, 12, 13, 14]);
    assert.deepEqual(at('src/p/Tok.java', 'Tok.append', 'src/p/Tok.java', 5), [11, 15]);
    assert.deepEqual(at('src/p/Tok.java', 'Tok.put', 'src/p/Tok.java', 6), [16]);
    assert.deepEqual(at('src/p/Tok.java', 'Tok.put', 'src/p/Tok.java', 7), [17]);
});

test('java: a library import, Outer.this, `new` inside the class and nested types through their outer class', async (t) => {
    const at = await repo(t, {
        'src/org/acme/UncheckedIOException.java': 'package org.acme;\npublic class UncheckedIOException extends RuntimeException {}\n',
        'src/org/acme/io/Data.java': [
            'package org.acme.io;',                                        // 1
            'import java.io.UncheckedIOException;',                        // 2
            'class Data {',                                                // 3
            '    void f() { try { g(); } catch (UncheckedIOException e) {} }', // 4
            '    void g() {}',                                             // 5
            '}',
            '',
        ].join('\n'),
        'src/org/acme/Map.java': [
            'package org.acme;',                                           // 1
            'public class Map {',                                          // 2
            '    int size() { return 0; }',                                // 3
            '    class Keys { int n() { return Map.this.size(); } }',      // 4
            '    static class Node {',                                     // 5
            '        Node(int a) { Node n = new Node(1); }',               // 6
            '    }',                                                       // 7
            '    enum Kind { A, B }',                                      // 8
            '    boolean is(Kind k) { return k == Map.Kind.A || Map.Kind.valueOf("B") == k; }', // 9
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/org/acme/UncheckedIOException.java', 'UncheckedIOException', 'src/org/acme/io/Data.java'), [], "java.io's class, not the repository's");
    assert.deepEqual(at('src/org/acme/Map.java', 'Map.size', 'src/org/acme/Map.java'), [4]);
    assert.ok(at('src/org/acme/Map.java', 'Map.Node', 'src/org/acme/Map.java').includes(6), 'new Node(1) inside Node names the class');
    assert.deepEqual(at('src/org/acme/Map.java', 'Map.Kind', 'src/org/acme/Map.java'), [9, 9, 9]);
});

test('java: a varargs parameter is an array, a call inside an overload picks by it, a long signature keeps its parameters', async (t) => {
    const at = await repo(t, {
        'src/p/It.java': [
            'package p;',                                                  // 1
            'class It {',                                                  // 2
            '    static void check(Iterable<?> one) {}',                   // 3
            '    static void check(Iterable<?>... many) {',                // 4
            '        for (Iterable<?> x : many) check(x);',                // 5
            '    }',                                                       // 6
            '    static void chain(Iterable<String>... its) { check(its); }', // 7
            '    @SuppressWarnings("unchecked") @Deprecated public static <I, O> void sw(final java.util.List<? super I> predicate,',
            '            final java.util.Map<? super I, ? extends O> trueTransformer, final java.util.Map<? super I, ? extends O> falseTransformer, final long a, final long b) {}', // 9
            '    static void sw(java.util.List<String>[] ps, java.util.Map<String, String>[] ts, java.util.Map<String, String> d, long a, long b) {}', // 10
            '    void use(java.util.List<String>[] ps, java.util.Map<String, String>[] ts, java.util.Map<String, String> d) { sw(ps, ts, d, 1L, 2L); }', // 11
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/p/It.java', 'It.check', 'src/p/It.java', 3), [5], 'a single Iterable is the fixed overload, also inside the variadic one');
    assert.deepEqual(at('src/p/It.java', 'It.check', 'src/p/It.java', 4), [7], 'an array of Iterable is the variadic one taken as it is');
    assert.deepEqual(at('src/p/It.java', 'It.sw', 'src/p/It.java', 8), []);
    assert.deepEqual(at('src/p/It.java', 'It.sw', 'src/p/It.java', 10), [11]);
});

test('java: static imports name the static members of a type, inherited ones included', async (t) => {
    const at = await repo(t, {
        'src/p/Fu.java': [
            'package p;',                                                  // 1
            'class Fu {',                                                  // 2
            '    static void validate(Object... xs) {}',                   // 3
            '    static void validate(java.util.List<String> xs) {}',      // 4
            '    static int coerce(int x) { return x; }',                  // 5
            '}',
            '',
        ].join('\n'),
        'src/q/All.java': [
            'package q;',                                                  // 1
            'import static p.Fu.validate;',                                // 2
            'import static p.Fu.*;',                                       // 3
            'class All {',                                                 // 4
            '    void f(String[] a, int n) { validate(a); coerce(n); }',   // 5
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/p/Fu.java', 'Fu.validate', 'src/q/All.java', 3), [5]);
    assert.deepEqual(at('src/p/Fu.java', 'Fu.coerce', 'src/q/All.java'), [5]);
});

test('java: an inner class calls the method of its outer class; an enum constant is a value of the enum', async (t) => {
    const at = await repo(t, {
        'src/p/Outer.java': [
            'package p;',                                                  // 1
            'abstract class Outer {',                                      // 2
            '    abstract Object make();',                                 // 3
            '    class Inner { Object g() { return make(); } }',           // 4
            '    int make(int n) { return n; }',                           // 5
            '}',
            '',
        ].join('\n'),
        'src/p/St.java': [
            'package p;',                                                  // 1
            'enum St {',                                                   // 2
            '    A { boolean go(int t) { return B.go(t); } },',            // 3
            '    B { boolean go(int t) { return true; } };',               // 4
            '    abstract boolean go(int t);',                             // 5
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/p/Outer.java', 'Outer.make', 'src/p/Outer.java', 3), [4]);
    assert.deepEqual(at('src/p/St.java', 'St.go', 'src/p/St.java', 5), [3], 'B.go(t) is a call of the enum\'s go');
});

test('java: members of a type are told by what they are: a field is no override of a method; an override beats what another base inherits', async (t) => {
    const at = await repo(t, {
        'src/p/Fam.java': [
            'package p;',                                                  // 1
            'interface Get { int size(); Object it(); }',                  // 2
            'interface Ord extends Get { @Override Object it(); }',        // 3
            'interface Bidi extends Get { }',                              // 4
            'interface OrdBidi extends Bidi, Ord { }',                     // 5
            'class Impl implements Get {',                                 // 6
            '    private final Object size = null;',                      // 7
            '    public int size() { return 0; }',                         // 8
            '    public Object it() { return size; }',                     // 9
            '}',
            'class Use { Object f(OrdBidi o) { return o.it(); } }',        // 11
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/p/Fam.java', 'Impl.size', 'src/p/Fam.java', 8), [], 'the field `size` is not a call of size()');
    assert.deepEqual(at('src/p/Fam.java', 'Ord.it', 'src/p/Fam.java'), [11], 'OrdBidi inherits Ord.it, which overrides Get.it');
});

test('java: overloads of one arity are not one family; an annotation line above a bodyless method is no signature', async (t) => {
    const at = await repo(t, {
        'src/p/Multi.java': [
            'package p;',                                                  // 1
            'interface Multi {',                                              // 2
            '    @Override',                                               // 3
            '    boolean add(String e);',                                  // 4
            '    boolean put(java.util.Map<String, String> m);',           // 5
            '    boolean put(Multi m);',                                      // 6
            '}',
            'class Dec { Multi d; boolean f(java.util.Map<String, String> m) { d.add("a"); return d.put(m); } }', // 8
            'abstract class Impl implements Multi { public boolean put(Multi m) { return true; } boolean g(Impl i) { return add("a", 1); } boolean add(String e, int n) { return true; } }',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/p/Multi.java', 'Impl.put', 'src/p/Multi.java'), [], 'put(Multi) does not override put(Map)');
    assert.deepEqual(at('src/p/Multi.java', 'Multi.add', 'src/p/Multi.java'), [8], 'add(String, int) is not an override of add(String)');
});
