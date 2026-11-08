/** Parsing on worker threads gives the same index as parsing inline. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { poolSize, POOL_MIN_FILES } from '../src/index/parsepool.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const files = {};
for (let i = 0; i < POOL_MIN_FILES + 12; i++) {
    files[`src/m${i}.ts`] = `import { helper } from './util';\nexport class C${i} { run(x: number) { return helper(x) + ${i}; } }\nexport function make${i}() { return new C${i}().run(${i}); }\n`;
}
files['src/util.ts'] = 'export function helper(n: number) { return n * 2; }\n';
files['src/broken.py'] = 'def f(:\n    return 1\n';

async function snapshot(workers) {
    const prev = process.env.GRAPH_INDEXER_WORKERS;
    process.env.GRAPH_INDEXER_WORKERS = workers;
    const root = makeRepo(files, { git: false });
    const intel = new CodeIntel({ root });
    try {
        await intel.open();
        return {
            symbols: intel.store.all('SELECT f.path, s.qname, s.kind, s.start_line FROM symbols s JOIN files f ON f.id = s.file_id ORDER BY 1, 4, 2'),
            refs: intel.store.all('SELECT f.path, r.line, r.name, r.kind, r.conf, d.qname AS dst FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols d ON d.id = r.dst_id ORDER BY 1, 2, 3, 4'),
        };
    } finally {
        intel.close(); rmrf(root);
        if (prev == null) delete process.env.GRAPH_INDEXER_WORKERS; else process.env.GRAPH_INDEXER_WORKERS = prev;
    }
}

test('the pool is used only for many files, and can be turned off', () => {
    const prev = process.env.GRAPH_INDEXER_WORKERS;
    process.env.GRAPH_INDEXER_WORKERS = '3';
    assert.equal(poolSize(POOL_MIN_FILES - 1), 0);
    assert.ok(poolSize(1000) === 3);
    process.env.GRAPH_INDEXER_WORKERS = '0';
    assert.equal(poolSize(1000), 0);
    if (prev == null) delete process.env.GRAPH_INDEXER_WORKERS; else process.env.GRAPH_INDEXER_WORKERS = prev;
});

test('worker threads and inline parsing write the same symbols and references', async () => {
    const pooled = await snapshot('2');
    const inline = await snapshot('0');
    assert.ok(pooled.refs.some(r => r.name === 'helper' && r.dst === 'helper'), 'cross-file calls are bound');
    assert.deepEqual(pooled.symbols, inline.symbols);
    assert.deepEqual(pooled.refs, inline.refs);
});
