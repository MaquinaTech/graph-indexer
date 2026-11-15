/**
 * Rust receivers typed the way rust-analyzer types them (bench/eval-graph-rust.mjs): the impl
 * blocks of the right type, tuples, wrappers, generic bounds, enum patterns, shadowing and 2018
 * module paths. Each case is a reference the oracle counted and the index missed or misplaced.
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
    /** Lines in `file` that reference the definition `target` (`path:Qual.name`). */
    return (target, file) => {
        const [p, q] = target.split(':');
        const s = intel.findSymbols(q).matches.find(m => m.path === p);
        assert.ok(s, `symbol ${target} not found`);
        return [...intel.references(s.id).groups.values()].flat().filter(r => r.path === file && r.kind !== 'import').map(r => r.line).sort((a, b) => a - b);
    };
}

test('rust: methods belong to the impl of the type their file sees, among same-name types of a workspace', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[workspace]\nmembers = ["regex", "pcre2", "printer"]\n',
        'regex/Cargo.toml': '[package]\nname = "grep-regex"\n',
        'regex/src/lib.rs': 'mod matcher;\npub use crate::matcher::RegexMatcher;\n',
        'regex/src/matcher.rs': 'pub struct RegexMatcher;\nimpl RegexMatcher {\n    pub fn new(p: &str) -> RegexMatcher { RegexMatcher }\n}\n',
        'pcre2/Cargo.toml': '[package]\nname = "grep-pcre2"\n',
        'pcre2/src/lib.rs': 'pub struct RegexMatcher;\nimpl RegexMatcher {\n    pub fn new(p: &str) -> RegexMatcher { RegexMatcher }\n}\n',
        'printer/Cargo.toml': '[package]\nname = "grep-printer"\n',
        'printer/src/lib.rs': [
            'use grep_regex::RegexMatcher;',                 // 1
            'fn t() {',                                      // 2
            '    let m = RegexMatcher::new("x");',           // 3
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('regex/src/matcher.rs:RegexMatcher.new', 'printer/src/lib.rs'), [3]);
    assert.deepEqual(at('pcre2/src/lib.rs:RegexMatcher.new', 'printer/src/lib.rs'), []);
});

test('rust: a bare name is never a method; tuples, tuple structs and wrappers keep their types', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'pub struct Gitignore;',                                          // 1
            'impl Gitignore {',                                               // 2
            '    pub fn path(&self) -> u8 { 0 }',                             // 3
            '    pub fn add(&self, path: u8) { let x = path; }',              // 4
            '}',                                                              // 5
            'pub struct Override(Gitignore);',                                // 6
            'impl Override { fn p(&self) -> u8 { self.0.path() } }',          // 7
            'pub struct Sender; pub struct Receiver;',                        // 8
            'impl Sender { pub fn send(&self) {} }',                          // 9
            'impl Receiver { pub fn recv(&self) {} }',                        // 10
            'pub fn channel() -> (Sender, Receiver) { (Sender, Receiver) }',  // 11
            'fn t() {',                                                       // 12
            '    let (tx, mut rx) = channel();',                              // 13
            '    tx.send(); rx.recv();',                                      // 14
            '    let s = std::sync::Arc::new(Sender);',                       // 15
            '    s.clone().send();',                                          // 16
            '    std::pin::Pin::new(&mut rx).recv();',                        // 17
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/lib.rs:Gitignore.path', 'src/lib.rs'), [7], 'not the parameter `path` (line 4), but self.0.path()');
    assert.deepEqual(at('src/lib.rs:Sender.send', 'src/lib.rs'), [14, 16]);
    assert.deepEqual(at('src/lib.rs:Receiver.recv', 'src/lib.rs'), [14, 17]);
});

test('rust: generic bounds, enum variant patterns, `impl … for &mut T`, `Self::` and sequential shadowing', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'pub trait Read { fn decode(&mut self) -> u8; }',                                     // 1
            'pub trait Formatter { fn begin(&mut self); }',                                       // 2
            'pub struct Map;',                                                                    // 3
            'impl Map { pub fn get_mut(&mut self) {} }',                                          // 4
            'pub enum Value { Null, Object(Map) }',                                               // 5
            'impl Value { pub fn unexpected(&self) {} }',                                         // 6
            'pub struct Ser<W, F> { w: W, formatter: F }',                                        // 7
            'impl<W, F: Formatter> Ser<W, F> {',                                                  // 8
            '    fn s(&mut self) { self.formatter.begin(); }',                                    // 9
            '}',                                                                                  // 10
            'pub fn parse<R: Read>(r: &mut R) -> u8 { r.decode() + R::decode(r) }',              // 11
            'impl Value {',                                                                       // 12
            '    fn g(&mut self) { match self { Value::Object(map) => map.get_mut(), other => other.unexpected() } }', // 13
            '    pub fn new() -> Value { Value::Null }',                                          // 14
            '    fn h() -> Value { Self::new() }',                                                // 15
            '}',                                                                                  // 16
            'pub struct De;',                                                                     // 17
            'impl<\'a> Read for &\'a mut De { fn decode(&mut self) -> u8 { self.fix() } }',     // 18
            'impl De { fn fix(&self) -> u8 { 0 } pub fn to_map(&self) -> Map { Map } }',          // 19
            'fn t(de: De) {',                                                                     // 20
            '    let x = de;',                                                                    // 21
            '    let x = x.to_map();',                                                            // 22
            '    x.get_mut();',                                                                   // 23
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/lib.rs:Formatter.begin', 'src/lib.rs'), [9], 'a field typed by a bounded type parameter');
    assert.deepEqual(at('src/lib.rs:Read.decode', 'src/lib.rs'), [11, 11], 'a parameter of type R: Read, and R::decode');
    assert.deepEqual(at('src/lib.rs:Map.get_mut', 'src/lib.rs'), [13, 23], 'Value::Object(map), and x rebound by a later let');
    assert.deepEqual(at('src/lib.rs:Value.unexpected', 'src/lib.rs'), [13], 'a catch-all arm binds the matched value');
    assert.deepEqual(at('src/lib.rs:Value.new', 'src/lib.rs'), [15], 'Self::new()');
    assert.deepEqual(at('src/lib.rs:De.fix', 'src/lib.rs'), [18], 'self in `impl Trait for &mut De`');
});

test('rust: 2018 child-module paths, a crate type that shadows a std wrapper, and associated types', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "tokio"\n',
        'src/lib.rs': 'pub mod runtime;\npub mod sync;\n',
        'src/runtime/mod.rs': 'mod runtime;\npub use runtime::Runtime;\n',
        'src/runtime/runtime.rs': 'pub struct Runtime;\nimpl Runtime {\n    pub fn metrics(&self) -> u8 { 0 }\n}\n',
        'src/sync.rs': [
            'pub struct Mutex<T>(T);',                                    // 1
            'impl<T> Mutex<T> { pub fn get_mut(&mut self) -> &mut T { &mut self.0 } }', // 2
            'pub struct Weak;',                                           // 3
            'impl Weak { pub fn upgrade(&self) -> Option<Strong> { None } }', // 4
            'pub struct Strong;',                                         // 5
            'impl Strong { pub fn send(&self) {} }',                      // 6
            '',
        ].join('\n'),
        'src/fs.rs': [
            'use crate::sync::{Mutex, Weak};',                            // 1
            'pub struct File { inner: Mutex<u8> }',                       // 2
            'impl File { fn f(&mut self, w: Weak) { self.inner.get_mut(); w.upgrade().unwrap().send(); } }', // 3
            '',
        ].join('\n'),
        'tests/rt.rs': [
            'use tokio::runtime::Runtime;',                               // 1
            'fn rt() -> Runtime { Runtime }',                             // 2
            'fn t() {',                                                   // 3
            '    let r = rt();',                                          // 4
            '    r.metrics();',                                           // 5
            '    struct V;',                                              // 6
            '    impl V { type Runtime = u8; }',                          // 7
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/runtime/runtime.rs:Runtime.metrics', 'tests/rt.rs'), [5]);
    assert.deepEqual(at('src/sync.rs:Mutex.get_mut', 'src/fs.rs'), [3], "the crate's Mutex, not a view of u8");
    assert.deepEqual(at('src/sync.rs:Strong.send', 'src/fs.rs'), [3], "Weak's own upgrade(), then unwrap()");
});

test('rust: a module brought in by a glob starts a path, and a builder chain keeps its type', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[workspace]\nmembers = ["lib", "app"]\n',
        'lib/Cargo.toml': '[package]\nname = "lib"\n',
        'lib/src/lib.rs': 'pub mod codec;\n',
        'lib/src/codec/mod.rs': 'pub mod framing;\n',
        'lib/src/codec/framing.rs': [
            'pub struct Builder {',                                            // 1
            '    n: u32,',
            '    num: Other,',
            '}',
            'impl Builder {',                                                 // 2
            '    pub fn new() -> Builder { Builder { n: 0, num: Other } }',               // 3
            '    pub fn num(&mut self, n: u32) -> &mut Self { self.n = n; self }', // 4
            '    pub fn done(&self) -> u32 { self.n }',
            '}',
            'pub struct Other;',
            'impl Other { pub fn done(&self) -> u32 { 0 } pub fn num(&self) {} }',
            '',
        ].join('\n'),
        'app/Cargo.toml': '[package]\nname = "app"\n',
        'app/src/main.rs': [
            'use lib::codec::*;',                                             // 1
            'fn main() {',                                                    // 2
            '    let n = framing::Builder::new()',                            // 3
            '        .num(2)',                                                // 4
            '        .num(3).num(4).num(5).num(6)',                          // 5
            '        .done();',                                               // 6
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('lib/src/codec/framing.rs:Builder.new', 'app/src/main.rs'), [3]);
    assert.deepEqual(at('lib/src/codec/framing.rs:Builder.num', 'app/src/main.rs'), [4, 5, 5, 5, 5]);
    assert.deepEqual(at('lib/src/codec/framing.rs:Builder.done', 'app/src/main.rs'), [6]);
});

test('rust: a Mutex imported from another crate of the workspace is that crate\'s type, not a view of its contents', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[workspace]\nmembers = ["sync", "app"]\n',
        'sync/Cargo.toml': '[package]\nname = "sync"\n',
        'sync/src/lib.rs': [
            'pub struct Mutex<T> { v: T }',                                  // 1
            'impl<T> Mutex<T> {',                                            // 2
            '    pub fn try_lock_owned(self: Arc<Self>) -> u32 { 0 }',       // 3
            '}',
            '',
        ].join('\n'),
        'app/Cargo.toml': '[package]\nname = "app"\n',
        'app/tests/t.rs': [
            'use std::sync::Arc;',                                           // 1
            'use sync::Mutex;',                                              // 2
            'fn t() {',                                                      // 3
            '    let m: Arc<Mutex<usize>> = Arc::new(Mutex::new(0));',       // 4
            '    m.clone().try_lock_owned();',                               // 5
            '    m.try_lock_owned();',                                       // 6
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('sync/src/lib.rs:Mutex.try_lock_owned', 'app/tests/t.rs'), [5, 6]);
});

test('rust: a bound imported from a crate outside the repository is not the repository\'s type of that name', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': 'mod blocking;\nmod budget;\nmod user;\n',
        'src/blocking.rs': 'pub(crate) struct Buf { n: usize }\n',
        'src/budget.rs': 'pub struct Budget;\nimpl Budget {\n    pub fn has_remaining(&self) -> bool { true }\n}\n',
        'src/user.rs': [
            'use bytes::Buf;',                                       // 1
            'fn f<B: Buf>(buf: &mut B) -> bool {',                   // 2
            '    buf.has_remaining()',                               // 3
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/budget.rs:Budget.has_remaining', 'src/user.rs'), []);
});

test('rust: a std path names the standard library\'s type, not a repository type of the same last name', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'pub struct DirEntry { std: Arc<std::fs::DirEntry> }',    // 1
            'impl DirEntry {',                                        // 2
            '    pub fn file_name(&self) -> u32 { 0 }',               // 3
            '    pub fn name2(&self) -> u32 { self.std.file_name() }', // 4
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/lib.rs:DirEntry.file_name', 'src/lib.rs'), []);
});

test('rust: an Arc reached through a re-exporting path of the crate is still a pointer to its contents', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'mod loom { pub use std::sync::Arc; }',                  // 1
            'use crate::loom::Arc;',                                 // 2
            'struct Shared;',                                        // 3
            'impl Shared { fn notify(&self) {} }',                   // 4
            'struct Sender { shared: Arc<Shared> }',                 // 5
            'impl Sender { fn f(&self) { self.shared.notify(); } }', // 6
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/lib.rs:Shared.notify', 'src/lib.rs'), [6]);
});

test('rust: `fs::f()` is the crate\'s `fs` when the file imports one, std\'s otherwise', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[workspace]\nmembers = ["rt", "app"]\n',
        'rt/Cargo.toml': '[package]\nname = "rt"\n',
        'rt/src/lib.rs': 'pub mod fs;\n',
        'rt/src/fs.rs': 'pub fn symlink(a: u32) {}\n',
        'app/Cargo.toml': '[package]\nname = "app"\n',
        'app/src/a.rs': 'use rt::fs;\nfn f() {\n    fs::symlink(1);\n}\n',
        'app/src/b.rs': 'use std::fs;\nfn f() {\n    fs::symlink(1);\n}\n',
    });
    assert.deepEqual(at('rt/src/fs.rs:symlink', 'app/src/a.rs'), [3]);
    assert.deepEqual(at('rt/src/fs.rs:symlink', 'app/src/b.rs'), []);
});

test('rust: a parameter typed Self (also behind a pointer) is of the type of its impl', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'pub struct Owned;',                                         // 1
            'impl Owned { fn bind(&self) {} }',                          // 2
            'pub struct Handle { owned: Owned }',                        // 3
            'impl Handle {',                                             // 4
            '    fn spawn(me: &Arc<Self>) { me.owned.bind(); }',         // 5
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/lib.rs:Owned.bind', 'src/lib.rs'), [5]);
});

test('rust: a turbofish call types the value like the plain call', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'pub struct Sender;',                                                    // 1
            'pub struct Receiver;',                                                  // 2
            'impl Sender { pub fn send(&self) {} }',                                 // 3
            'impl Receiver { pub fn recv_many(&mut self) {} }',                      // 4
            'pub fn channel<T>(n: usize) -> (Sender, Receiver) { (Sender, Receiver) }', // 5
            'fn t() {',                                                              // 6
            '    let (tx, mut rx) = channel::<u8>(1);',                              // 7
            '    tx.send();',                                                        // 8
            '    rx.recv_many();',                                                   // 9
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/lib.rs:Sender.send', 'src/lib.rs'), [8]);
    assert.deepEqual(at('src/lib.rs:Receiver.recv_many', 'src/lib.rs'), [9]);
});

test('rust: a LinkedList imported from the crate is the crate\'s, not a std collection of its elements', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': 'mod list;\nmod user;\n',
        'src/list.rs': 'pub struct LinkedList<L, T> { head: Option<L>, t: T }\nimpl<L, T> LinkedList<L, T> {\n    pub fn remove(&mut self, x: u32) {}\n}\n',
        'src/user.rs': [
            'use crate::list::LinkedList;',                                  // 1
            'struct Waiter;',                                                // 2
            'struct Waitlist { queue: LinkedList<Waiter, u8> }',             // 3
            'fn f(w: &mut Waitlist) { w.queue.remove(1); }',                 // 4
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/list.rs:LinkedList.remove', 'src/user.rs'), [4]);
});

test('rust: a method of a primitive parameter is not a repository method of that name', async (t) => {
    const at = await repo(t, {
        'Cargo.toml': '[package]\nname = "app"\n',
        'src/lib.rs': [
            'pub struct Error;',                                                // 1
            'impl Error { pub fn classify(&self) -> u8 { 0 } }',                // 2
            'fn f(value: f32) -> u8 {',                                         // 3
            '    match value.classify() {',                                     // 4
            '        FpCategory::Nan => 0,',                                    // 5
            '        _ => 1,',                                                  // 6
            '    }',
            '}',
            '',
        ].join('\n'),
    });
    assert.deepEqual(at('src/lib.rs:Error.classify', 'src/lib.rs'), []);
});
