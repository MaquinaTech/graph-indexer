import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const vendor = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor');
const manifest = JSON.parse(fs.readFileSync(path.join(vendor, 'grammars', 'manifest.json'), 'utf8'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('vendored grammars match their pinned release checksums', () => {
    const names = Object.keys(manifest.grammars);
    assert.equal(names.length, 16);
    for (const name of names) {
        const wasm = zlib.gunzipSync(fs.readFileSync(path.join(vendor, 'grammars', `${name}.wasm.gz`)));
        assert.equal(sha256(wasm), manifest.grammars[name].sha256, `${name}.wasm checksum`);
        assert.equal(wasm.length, manifest.grammars[name].bytes, `${name}.wasm size`);
    }
});

test('vendored tree-sitter runtime matches its recorded checksums', () => {
    for (const [file, meta] of Object.entries(manifest.runtime.files)) {
        const buf = fs.readFileSync(path.join(vendor, 'web-tree-sitter', file));
        assert.equal(sha256(buf), meta.sha256, `${file} checksum`);
        assert.equal(buf.length, meta.bytes, `${file} size`);
    }
});

test('the package has no runtime dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(vendor, '..', 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
    assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}), []);
});
