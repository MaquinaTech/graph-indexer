/**
 * Java references measured against the Java compiler (bench/eval-graph-java.mjs): each case here is
 * one javac answered differently before it was fixed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const P = 'src/main/java/org/x/';
const FILES = {
    [P + 'Node.java']: [
        'package org.x;',
        '',
        'public class Node {',
        '    Node parentNode;',
        '    public String attr(String key) { return key; }',
        '    public Node parentNode() { return parentNode; }',
        '    static boolean keep(Node n) { return n != null; }',
        '    boolean check() { return keep(parentNode); }',
        '}',
        '',
    ].join('\n'),
    [P + 'Element.java']: [
        'package org.x;',
        '',
        'public class Element extends Node {',
        '    public Element attr(String key, String value) { return this; }',
        '    String first() { return attr("a"); }',
        '}',
        '',
    ].join('\n'),
    [P + 'Util.java']: [
        'package org.x;',
        '',
        'public class Util {',
        '    public static String clean(String html) { return clean(html, ""); }',
        '    public static String clean(String html, String base) { return html + base; }',
        '    static void check(Object o) { }',
        '    static void check(Object... os) { }',
        '    static void use(Element e) {',
        '        clean("x");',
        '        check(e);',
        '        e.attr("k");',
        '    }',
        '}',
        '',
    ].join('\n'),
    [P + 'Token.java']: [
        'package org.x;',
        '',
        'abstract class Token {',
        '    static void reset(StringBuilder sb) { }',
        '    static final class Comment extends Token {',
        '        Comment append(String s) { return this; }',
        '    }',
        '    enum Kind { A, B }',
        '}',
        '',
    ].join('\n'),
    [P + 'Comment.java']: 'package org.x;\n\npublic class Comment {\n    Comment append(String s) { return this; }\n}\n',
    [P + 'Tokeniser.java']: [
        'package org.x;',
        '',
        'class Tokeniser {',
        '    Token.Comment pending = new Token.Comment();',
        '    void emit() {',
        '        pending.append("-");',
        '        Token.reset(new StringBuilder());',
        '        Token.Kind k = Token.Kind.A;',
        '    }',
        '}',
        '',
    ].join('\n'),
    [P + 'State.java']: [
        'package org.x;',
        '',
        'enum State {',
        '    Initial {',
        '        boolean process(String t) { return true; }',
        '    },',
        '    Done {',
        '        boolean process(String t) { return false; }',
        '    };',
        '    abstract boolean process(String t);',
        '    static boolean run(State s) { return s.process("x"); }',
        '}',
        '',
    ].join('\n'),
    [P + 'Transformer.java']: 'package org.x;\n\npublic interface Transformer {\n    Object transform(Object in);\n}\n',
    [P + 'Chains.java']: [
        'package org.x;',
        '',
        'class Chains {',
        '    Transformer first() {',
        '        return new Transformer() {',
        '            public Object transform(Object in) { return in; }',
        '        };',
        '    }',
        '    Transformer second() {',
        '        return new Transformer() {',
        '            public Object transform(Object in) { return null; }',
        '        };',
        '    }',
        '    static Object apply(Transformer t) { return t.transform(1); }',
        '}',
        '',
    ].join('\n'),
    [P + 'Base.java']: 'package org.x;\n\nclass Base {\n    protected Tokeniser tokeniser;\n}\n',
    [P + 'Builder.java']: 'package org.x;\n\nclass Builder extends Base {\n    void go() { tokeniser.emit(); }\n}\n',
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
const at = (refs, file, line) => refs.some(r => r.path === P + file && r.line === line);
const sym = (qname, line) => intel.store.get('SELECT s.id FROM symbols s WHERE s.qname = ? AND s.start_line = ?', qname, line)?.id;
const refsOf = (qname, line) => [...intel.references(sym(qname, line)).groups.values()].flat();

test('Java: overloads are methods of their own, and a call reaches the one its arguments fit', () => {
    const one = refsOf('Util.clean', 4), two = refsOf('Util.clean', 5);
    assert.ok(at(one, 'Util.java', 9) && !at(two, 'Util.java', 9), 'clean("x") takes one argument');
    assert.ok(at(two, 'Util.java', 4) && !at(one, 'Util.java', 4), 'clean(html, "") inside clean(html) is not recursion');
    assert.ok(at(refsOf('Util.check', 6), 'Util.java', 10) && !at(refsOf('Util.check', 7), 'Util.java', 10), 'the fixed-arity overload wins over the variadic one');
});

test('Java: a call none of the receiver type\'s overloads fit reaches an inherited one', () => {
    assert.ok(at(refsTo('Node.attr'), 'Util.java', 11), 'e.attr("k") on an Element runs Node.attr(key)');
    assert.ok(at(refsTo('Node.attr'), 'Element.java', 5), 'attr("a") inside Element');
    assert.ok(!at(refsTo('Element.attr'), 'Util.java', 11));
});

test('Java: an argument is a variable, never the method of the same name', () => {
    assert.ok(at(refsOf('Node.parentNode', 4), 'Node.java', 8), 'keep(parentNode) passes the field');
    assert.ok(!at(refsOf('Node.parentNode', 6), 'Node.java', 8), 'not the method parentNode()');
});

test('Java: nested types keep their enclosing type, and static access names the class', () => {
    assert.ok(at(refsTo('Token.Comment.append'), 'Tokeniser.java', 6), 'pending is a Token.Comment');
    assert.ok(!at(refsTo(P + 'Comment.java:Comment.append'), 'Tokeniser.java', 6), 'not the top-level Comment');
    const token = refsTo(P + 'Token.java:Token');
    assert.ok(at(token, 'Tokeniser.java', 7) && at(token, 'Tokeniser.java', 8), 'Token.reset(…) and Token.Kind.A use the class');
});

test('Java: enum constant bodies and anonymous classes override what they extend', () => {
    assert.ok(at(refsTo('State.Initial.process'), 'State.java', 11), 's.process() may run a constant\'s body');
    const second = intel.store.get("SELECT s.id FROM symbols s WHERE s.qname LIKE 'Chains.second.%.transform'")?.id;
    assert.ok(second, 'the method of the second anonymous class');
    assert.ok(at([...intel.references(second).groups.values()].flat(), 'Chains.java', 14), 't.transform(1) may run it');
});

test('Java: a field inherited from a base types its receiver', () => {
    assert.ok(at(refsTo('Tokeniser.emit'), 'Builder.java', 4));
});
