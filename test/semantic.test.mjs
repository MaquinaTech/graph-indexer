import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preTokenize, StaticModel, MODEL, quantize } from '../src/search/semantic.mjs';
import { VectorIndex } from '../src/search/vectors.mjs';
import { CodeIntel } from '../src/query/intel.mjs';
import { makeRepo, writeFile, rmrf } from './helpers.mjs';

// A tiny static model in the real on-disk format (WordPiece tokenizer.json + F16 safetensors):
// dimension 0 means "retry/backoff", dimension 1 "token/verify", dimension 2 everything else.
const VOCAB = ['[PAD]', '[UNK]', 'retry', 'backoff', 'wait', 'token', 'verify', 'sign', '##ature', 'cache', 'the', 'a', 'when', 'fails', 'request'];
const DIRS = { retry: 0, backoff: 0, wait: 0, fails: 0, token: 1, verify: 1, sign: 1, '##ature': 1 };

function f16bits(x) { // enough for 0 and 1
    return x === 0 ? 0 : x === 1 ? 0x3c00 : (() => { throw new Error('only 0/1'); })();
}

function writeFakeModel(base) {
    const dir = path.join(base, MODEL.id);
    fs.mkdirSync(dir, { recursive: true });
    const vocab = Object.fromEntries(VOCAB.map((t, i) => [t, i]));
    fs.writeFileSync(path.join(dir, 'tokenizer.json'), JSON.stringify({ model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', vocab } }));
    const dim = 3;
    const data = Buffer.alloc(VOCAB.length * dim * 2);
    VOCAB.forEach((t, i) => { const d = DIRS[t] ?? 2; data.writeUInt16LE(f16bits(1), (i * dim + d) * 2); });
    const header = Buffer.from(JSON.stringify({ embeddings: { dtype: 'F16', shape: [VOCAB.length, dim], data_offsets: [0, data.length] } }));
    const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(header.length));
    fs.writeFileSync(path.join(dir, 'model.safetensors'), Buffer.concat([len, header, data]));
    return dir;
}

test('the pre-tokenizer lowercases, strips accents and splits punctuation like BERT', () => {
    assert.deepEqual(preTokenize('Café, résumé!'), ['cafe', ',', 'resume', '!']);
    assert.deepEqual(preTokenize('a.b(c)'), ['a', '.', 'b', '(', 'c', ')']);
    assert.deepEqual(preTokenize('中文x'), ['中', '文', 'x']);
});

test('WordPiece takes the longest match, continues with ##, drops unknown words; vectors are unit length', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-model-'));
    try {
        const m = new StaticModel(writeFakeModel(base));
        assert.deepEqual(m.tokenize('signature retry zzz'), [7, 8, 2]);
        const v = m.embed('retry backoff');
        assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6);
        assert.ok(v[0] > 0.99);
        assert.equal(m.embed('zzz qqq'), null);
        const { q, scale } = quantize(Float32Array.from([0.5, -0.25, 0]));
        assert.deepEqual([...q], [127, -63, 0]);
        assert.ok(Math.abs(q[0] * scale - 0.5) < 1e-6);
    } finally { rmrf(base); }
});

test('the semantic channel finds a definition by meaning, re-embeds only edited files, and stays off without GRAPH_INDEXER_SEMANTIC=1', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-model-'));
    writeFakeModel(base);
    const prev = { dir: process.env.GRAPH_INDEXER_MODEL_DIR, on: process.env.GRAPH_INDEXER_SEMANTIC };
    process.env.GRAPH_INDEXER_MODEL_DIR = base;
    const root = makeRepo({
        'src/a.ts': 'export function attemptAgain(fn: () => void) { /* backoff, wait */ fn(); }\n',
        'src/b.ts': 'export function checkSignature(token: string) { return token.length > 0; }\n',
    });
    try {
        delete process.env.GRAPH_INDEXER_SEMANTIC;
        assert.equal(VectorIndex.maybe({ store: null }), null, 'opt-in: a model on disk alone does not turn it on');
        process.env.GRAPH_INDEXER_SEMANTIC = '1';
        const intel = new CodeIntel({ root });
        await intel.open();
        try {
            assert.ok(intel.search.semantic, 'on with the model and GRAPH_INDEXER_SEMANTIC=1');
            // "retry when the request fails" shares no word with attemptAgain's name or code but its meaning
            const r = intel.search.search('retry when the request fails', { limit: 3 }).results.map(x => intel.sym(x.id).qname);
            assert.equal(r[0], 'attemptAgain');
            assert.equal(intel.store.get('SELECT COUNT(*) AS n FROM vec_files').n, 2);
            const before = intel.store.get("SELECT v.hash FROM vec_files v JOIN files f ON f.id = v.file_id WHERE f.path = 'src/a.ts'").hash;
            writeFile(root, 'src/b.ts', 'export function checkSignature(token: string) { return token.length > 1; }\n');
            await intel.ix.syncPaths(['src/b.ts']);
            assert.equal(intel.search.semantic.fill(), 1, 'only the edited file is embedded again');
            assert.equal(intel.store.get("SELECT v.hash FROM vec_files v JOIN files f ON f.id = v.file_id WHERE f.path = 'src/a.ts'").hash, before);
        } finally { intel.close(); }
    } finally {
        for (const [k, v] of [['GRAPH_INDEXER_MODEL_DIR', prev.dir], ['GRAPH_INDEXER_SEMANTIC', prev.on]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        rmrf(root); rmrf(base);
    }
});
