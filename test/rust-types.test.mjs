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
