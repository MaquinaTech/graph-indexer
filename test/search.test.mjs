import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const REPO = {
    'src/auth/jwt.ts': `/** Verify a JSON Web Token signature and expiry. */\nexport function verifyToken(token: string, secret: string): boolean {\n  const [h, p, s] = token.split('.');\n  return checkSignature(h + '.' + p, s, secret) && !isExpired(p);\n}\nfunction checkSignature(data: string, sig: string, secret: string) { return true; }\nfunction isExpired(payload: string) { return false; }\n`,
    'src/http/retry.ts': `/** Retry a request with exponential backoff. */\nexport async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {\n  let delay = 100;\n  for (let i = 0; ; i++) {\n    try { return await fn(); } catch (e) { if (i >= attempts) throw e; await sleep(delay); delay *= 2; }\n  }\n}\nfunction sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }\n`,
    'src/http/retry.test.ts': `import { withRetry } from './retry';\ntest('retries', async () => { await withRetry(async () => 1); });\n`,
    'examples/demo.ts': `export function verifyTokenDemo() { return 1; }\n`,
};

let root, intel;
test.before(async () => { root = makeRepo(REPO); intel = new CodeIntel({ root }); await intel.open(); });
test.after(() => { intel.close(); rmrf(root); });

const top = (q, opts) => intel.search.search(q, opts).results.map(r => intel.sym(r.id).qname);

test('identifier queries rank the exact symbol first', () => {
    assert.equal(top('verifyToken')[0], 'verifyToken');
    assert.equal(top('withRetry')[0], 'withRetry');
});

test('natural-language queries find behaviour through docs, bodies and concepts', () => {
    assert.equal(top('validate a jwt')[0], 'verifyToken');
    assert.ok(top('validate a jwt signature').slice(0, 2).includes('verifyToken'));
    assert.equal(top('exponential backoff when a request fails')[0], 'withRetry');
});

test('tests and examples are demoted unless asked for', () => {
    assert.notEqual(top('verify token')[0], 'verifyTokenDemo');
    assert.ok(top('retry test').some(q => q.startsWith('test') || q === 'withRetry'));
});

test('path and kind filters narrow results', () => {
    assert.deepEqual([...new Set(intel.search.search('function', { path: 'src/http/' }).results.map(r => intel.sym(r.id).path))].every(p => p.startsWith('src/http/')), true);
});

test('search_code tool output lists location, signature and matching lines', async () => {
    const text = await callTool(intel, 'search_code', { query: 'retry with backoff', limit: 3 });
    assert.match(text, /withRetry — function · src\/http\/retry\.ts:2-7/);
    assert.match(text, /async function withRetry<T>/);
});

test('outline renders a file and a repository map within budget', async () => {
    const file = await callTool(intel, 'outline', { path: 'src/auth/jwt.ts' });
    assert.match(file, /2-5 +function verifyToken\(token: string, secret: string\): boolean/);
    const map = await callTool(intel, 'outline', { max_tokens: 300 });
    assert.ok(map.length <= 300 * 4 + 200);
    assert.match(map, /Repository map/);
});
