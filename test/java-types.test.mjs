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
