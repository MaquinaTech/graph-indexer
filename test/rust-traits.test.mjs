/**
 * Rust calls through traits, typed the way rust-analyzer types them (bench/eval-graph-rust.mjs):
 * several bounds on a type parameter, trait-path calls (`Trait::m(x)`, `<T as Trait>::m(x)`),
 * `dyn Trait` / `impl Trait` values, blanket impls over a type parameter, and a type with two
 * traits that declare a method of one name. Each case is a reference the oracle counted and the
 * index missed or misplaced (tokio, serde_json, ripgrep).
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
    /** Lines in `file` that reference the definition at `path:line` (exact references, no family). */
    return (target, file) => {
        const [p, l] = target.split(':');
        const s = intel.store.get('SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.name_line = ?', p, Number(l));
        assert.ok(s, `no symbol at ${target}`);
        return [...intel.references(s.id, { family: false }).groups.values()].flat().filter(r => r.path === file && r.kind !== 'import').map(r => r.line).sort((a, b) => a - b);
    };
}

test('rust: a type parameter with several bounds has the methods of each', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'pub trait AsyncWrite {',                                                      // 1
            '    fn poll_write(&mut self);',                                               // 2
            '}',                                                                           // 3
            'pub trait AsyncSeek {',                                                       // 4
            '    fn poll_complete(&mut self);',                                            // 5
            '}',                                                                           // 6
            'pub struct BufWriter<W> { inner: W }',                                        // 7
            'impl<W: AsyncWrite + AsyncSeek> BufWriter<W> {',                              // 8
            '    fn f(&mut self) { self.inner.poll_complete(); }',                         // 9
            '    fn g(&mut self) { self.inner.poll_write(); }',                            // 10
            '}',                                                                           // 11
            'fn a<S: AsyncWrite + Send + AsyncSeek>(s: &mut S) { s.poll_complete(); }',    // 12
            'fn b<S>(s: &mut S) where S: AsyncWrite, S: AsyncSeek + Unpin { s.poll_complete(); }', // 13
            'fn c(s: &mut (dyn AsyncSeek + Send)) { s.poll_complete(); }',                 // 14
            'fn d(s: impl AsyncSeek + Unpin) { let mut s = s; s.poll_complete(); }',       // 15
            'fn e(s: Box<dyn AsyncWrite + AsyncSeek>) { s.poll_complete(); }',             // 16
            'impl<W: AsyncSeek> BufWriter<W> {',                                           // 17
            '    fn h(self: Pin<&mut Self>) { let me = self.project(); me.inner.poll_complete(); }', // 18 (pin-project)
            '}',                                                                           // 19
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/lib.rs:5', 'src/lib.rs'), [9, 12, 13, 14, 15, 16, 18]);
    assert.deepEqual(at('src/lib.rs:2', 'src/lib.rs'), [10]);
});

test('rust: a trait-path call reaches the impl for its first argument\'s type', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'use std::fmt::{self, Debug, Display};',                                       // 1
            'pub trait SerializeSeq {} pub trait SerializeTuple {}',                       // 2
            '',                                                                            // 3
            'pub struct Compound;',                                                        // 4
            'impl SerializeSeq for Compound {',                                            // 5
            '    fn serialize_element(&mut self, v: u8) {}',                               // 6
            '}',                                                                           // 7
            'impl SerializeTuple for Compound {',                                          // 8
            '    fn serialize_element(&mut self, v: u8) { SerializeSeq::serialize_element(self, v) }', // 9
            '}',                                                                           // 10
            'fn k(c: &mut Compound) {',                                                    // 11
            '    SerializeTuple::serialize_element(c, 1);',                                // 12
            '    <Compound as SerializeSeq>::serialize_element(c, 2);',                    // 13
            '    crate::SerializeSeq::serialize_element(&mut *c, 3);',                     // 14
            '}',                                                                           // 15
            'pub struct Number;',                                                          // 16
            'impl Debug for Number { fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { Ok(()) } }',   // 17
            'impl Display for Number { fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { Ok(()) } }', // 18
            'fn show(n: &Number, f: &mut fmt::Formatter) { Debug::fmt(n, f); fmt::Display::fmt(n, f); }',  // 19
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/lib.rs:6', 'src/lib.rs'), [9, 13, 14]);
    assert.deepEqual(at('src/lib.rs:9', 'src/lib.rs'), [12]);
    assert.deepEqual(at('src/lib.rs:17', 'src/lib.rs'), [19]);
    assert.deepEqual(at('src/lib.rs:18', 'src/lib.rs'), [19]);
});

test('rust: a blanket impl over a type parameter calls the trait through it', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'pub trait Matcher {',                                                         // 1
            '    fn find_at(&self, at: usize) -> bool;',                                   // 2
            '}',                                                                           // 3
            "impl<'a, M: Matcher> Matcher for &'a M {",                                    // 4
            '    fn find_at(&self, at: usize) -> bool { (*self).find_at(at) }',            // 5
            '}',                                                                           // 6
            'impl<M: Matcher + ?Sized> Matcher for Box<M> {',                              // 7
            '    fn find_at(&self, at: usize) -> bool { (**self).find_at(at) }',           // 8
            '}',                                                                           // 9
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/lib.rs:2', 'src/lib.rs'), [5, 8]);
});

test('rust: calls of a trait\'s implementations are uses of its method; impls of one type stay apart', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'pub trait ToAddrs {',                                                         // 1
            '    fn to_addrs(&self) -> u8;',                                               // 2
            '}',                                                                           // 3
            'pub struct V4; pub struct V6;',                                               // 4
            'impl ToAddrs for V4 { fn to_addrs(&self) -> u8 { 4 } }',                      // 5
            'impl ToAddrs for V6 { fn to_addrs(&self) -> u8 { 6 } }',                      // 6
            'fn f(a: V4, b: V6) -> u8 { a.to_addrs() + b.to_addrs() }',                    // 7
            'pub trait Write {',                                                           // 8
            '    fn flush(&mut self);',                                                    // 9
            '    fn shutdown(&mut self);',                                                 // 10
            '}',                                                                           // 11
            'pub struct Cursor<T>(T);',                                                    // 12
            'impl Write for Cursor<Vec<u8>> {',                                            // 13
            '    fn flush(&mut self) {}',                                                  // 14
            '    fn shutdown(&mut self) { self.flush() }',                                 // 15
            '}',                                                                           // 16
            'impl Write for Cursor<Box<[u8]>> {',                                          // 17
            '    fn flush(&mut self) {}',                                                  // 18
            '    fn shutdown(&mut self) { self.flush() }',                                 // 19
            '}',                                                                           // 20
            'pub struct Map;',                                                             // 21
            'pub trait IntoIter { fn into_iter(self) -> u8; }',                            // 22
            'impl IntoIter for Map { fn into_iter(self) -> u8 { 0 } }',                    // 23
            "impl<'a> IntoIter for &'a Map { fn into_iter(self) -> u8 { 1 } }",            // 24
            'fn g(m: Map) -> u8 { m.into_iter() }',                                        // 25
            'pub trait Float { fn to_bits(self) -> u32; }',                                // 26
            'impl Float for f32 {',                                                        // 27
            '    fn to_bits(self) -> u32 { f32::to_bits(self) }',                          // 28
            '}',                                                                           // 29
            '',
        ].join('\n'),
    });
    // the trait's method: through each implementation (rust-analyzer's references), both calls on line 7
    assert.deepEqual(at('src/lib.rs:2', 'src/lib.rs'), [7, 7]);
    assert.deepEqual(at('src/lib.rs:5', 'src/lib.rs'), [7]);
    // `self.flush()` is the flush of its own impl block, and each impl's flush is a method of its own
    assert.deepEqual(at('src/lib.rs:14', 'src/lib.rs'), [15]);
    assert.deepEqual(at('src/lib.rs:18', 'src/lib.rs'), [19]);
    // a call on the value reaches the impl for the value, not the one for `&Map`
    assert.deepEqual(at('src/lib.rs:23', 'src/lib.rs'), [25]);
    assert.deepEqual(at('src/lib.rs:24', 'src/lib.rs'), []);
    // `f32::to_bits(self)` inside `to_bits` is the primitive's own method
    assert.deepEqual(at('src/lib.rs:28', 'src/lib.rs'), []);
});

test('rust: `Type::from(x)` with several `impl From<_> for Type` stays unbound without the argument\'s type', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'pub struct Value;',                                         // 1
            'impl From<f32> for Value {',                                // 2
            '    fn from(f: f32) -> Self { Value }',                     // 3
            '}',                                                         // 4
            'impl From<bool> for Value {',                               // 5
            '    fn from(f: bool) -> Self { Value }',                    // 6
            '}',                                                         // 7
            'fn t() { Value::from(make()); }',                           // 8
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/lib.rs:3', 'src/lib.rs'), []);
    assert.deepEqual(at('src/lib.rs:6', 'src/lib.rs'), []);
});

test('rust: among `impl From<_> for Type` the call reaches the impl whose trait argument is its argument\'s type', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'pub struct Value;',                                         // 1
            'pub struct Other {}',                                        // 2
            "impl From<f32> for Value { fn from(f: f32) -> Self { Value } }",              // 3
            "impl From<bool> for Value { fn from(f: bool) -> Self { Value } }",            // 4
            "impl<'a> From<&'a [u8]> for Value { fn from(f: &'a [u8]) -> Self { Value } }", // 5
            'impl From<&str> for Value { fn from(f: &str) -> Self { Value } }',            // 6
            'impl From<Vec<u8>> for Value { fn from(f: Vec<u8>) -> Self { Value } }',      // 7
            'impl From<Other> for Value { fn from(f: Other) -> Self { Value } }',          // 8
            'impl From<&Other> for Value { fn from(f: &Other) -> Self { Value } }',        // 9
            'fn t(flag: bool, o: Other, r: &Other, bytes: &[u8]) {',                       // 10
            '    Value::from(1.0f32);',                                  // 11
            '    Value::from(flag);',                                    // 12
            '    Value::from(true);',                                    // 13
            '    Value::from(&b"abc"[..]);',                             // 14
            '    Value::from(bytes);',                                   // 15
            '    Value::from("s");',                                     // 16
            '    Value::from(vec![1u8, 2]);',                            // 17
            '    let v = Vec::new();',                                   // 18
            '    Value::from(v);',                                       // 19
            '    Value::from(Other {});',                                 // 20
            '    Value::from(o);',                                       // 21
            '    Value::from(&o);',                                      // 22
            '    Value::from(r);',                                       // 23
            '    Value::from(2.5);',                                     // 24 an unsuffixed float: f32, the only float impl
            '}',                                                         // 25
            '',
        ].join('\n'),
    });
    const lines = (def) => at('src/lib.rs:' + def, 'src/lib.rs');
    assert.deepEqual(lines(3), [11, 24]);
    assert.deepEqual(lines(4), [12, 13]);
    assert.deepEqual(lines(5), [14, 15]);
    assert.deepEqual(lines(6), [16]);
    assert.deepEqual(lines(7), [17, 19]);
    assert.deepEqual(lines(8), [20, 21]);
    assert.deepEqual(lines(9), [22, 23]);
});

test('rust: a method call picks among `impl Trait<_> for Type` by its argument, and an argument that fits several or none stays unbound', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'pub struct Buf;',                                           // 1
            'pub trait Put<T> { fn put(&mut self, x: T); }',             // 2
            'impl Put<u8> for Buf { fn put(&mut self, x: u8) {} }',      // 3
            'impl Put<&str> for Buf { fn put(&mut self, x: &str) {} }',  // 4
            'impl<T> Put<Vec<T>> for Buf { fn put(&mut self, x: Vec<T>) {} }', // 5
            'fn t(mut b: Buf, n: u8, s: String) {',                      // 6
            '    b.put(n);',                                             // 7
            '    b.put("x");',                                           // 8
            '    b.put(vec![1, 2]);',                                    // 9
            '    b.put(s.clone());',                                     // 10 a String is none of the three
            '    b.put(1);',                                             // 11 an integer literal fits u8 only here
            '    b.put(unknown());',                                     // 12
            '}',                                                         // 13
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/lib.rs:3', 'src/lib.rs'), [7, 11]);
    assert.deepEqual(at('src/lib.rs:4', 'src/lib.rs'), [8]);
    assert.deepEqual(at('src/lib.rs:5', 'src/lib.rs'), [9]);
});

test('rust: `format!`, `.to_string()` and `String::from` are Strings, `.clone()` of a reference is the value, `x.into_bytes()` of a String is a Vec<u8>', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'pub struct V;',                                             // 1
            'impl From<String> for V { fn from(s: String) -> V { V } }', // 2
            'impl From<&String> for V { fn from(s: &String) -> V { V } }', // 3
            'impl From<Vec<u8>> for V { fn from(s: Vec<u8>) -> V { V } }', // 4
            'fn t(r: &String, n: i32) {',                                // 5
            '    V::from(format!("{}", n));',                            // 6
            '    V::from(n.to_string());',                               // 7
            '    V::from(String::from("a"));',                           // 8
            '    V::from(r.clone());',                                   // 9
            '    V::from(r);',                                           // 10
            '    let s = String::new();',                                // 11
            '    V::from(s.into_bytes());',                              // 12
            '}',                                                         // 13
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/lib.rs:2', 'src/lib.rs'), [6, 7, 8, 9]);
    assert.deepEqual(at('src/lib.rs:3', 'src/lib.rs'), [10]);
    assert.deepEqual(at('src/lib.rs:4', 'src/lib.rs'), [12]);
});
