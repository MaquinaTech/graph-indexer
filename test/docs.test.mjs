import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMarkdown } from '../src/parse/lang/markdown.mjs';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

test('Markdown headings become nested sections that end at the next heading of their level, ignoring fenced code', () => {
    const md = '# Guide\nIntro text.\n\n## Install\nRun `npm i`.\n\n```sh\n# not a heading\n```\n\n## Usage\nCall **run**.\n\nSetext title\n============\nBody.\n';
    const { symbols } = extractMarkdown(md);
    assert.deepEqual(symbols.map(s => [s.qname, s.kind, s.startLine, s.endLine]), [
        ['Guide', 'section', 1, 12],
        ['Guide › Install', 'section', 4, 9],
        ['Guide › Usage', 'section', 11, 12],
        ['Setext title', 'section', 14, 16],
    ]);
    assert.equal(symbols[1].doc, 'Run npm i.');
    assert.equal(symbols[1].parentIdx, 0);
});

const REPO = {
    'src/cache.ts': '/** Store a computed value under its key. */\nexport function putCache(key: string, value: unknown) { store.set(key, value); }\nconst store = new Map();\n',
    'docs/ARCHITECTURE.md': '# Architecture\n\n## Cache eviction\nWe evict least recently used entries because memory is bounded; the design keeps eviction out of the request path.\n',
    'README.md': '# Demo\n\nA demo.\n',
};

let root, intel;
test.before(async () => { root = makeRepo(REPO); intel = new CodeIntel({ root }); await intel.open(); });
test.after(() => { intel.close(); rmrf(root); });

const top = (q) => intel.search.search(q, { limit: 5 }).results.map(r => intel.sym(r.id)).map(s => `${s.kind}:${s.qname}`);

test('documentation answers questions about design, and stays out of code searches', () => {
    assert.equal(top('why is the cache eviction designed this way')[0], 'section:Architecture › Cache eviction');
    assert.ok(!top('cache eviction').some(x => x.startsWith('section:')), 'a code query returns code only');
    assert.equal(top('store a value in the cache')[0], 'function:putCache');
});

test('search_code fuses several phrasings; read_code reads a documentation section by its heading', async () => {
    const out = await callTool(intel, 'search_code', { query: 'put a value under a key', queries: ['putCache', 'cache write'] });
    assert.match(out, /for "put a value under a key" \+ "putCache" \+ "cache write"/);
    assert.match(out.split('\n')[1], /putCache/);
    const md = await callTool(intel, 'read_code', { targets: ['docs/ARCHITECTURE.md:Cache eviction'] });
    assert.match(md, /least recently used/);
});
