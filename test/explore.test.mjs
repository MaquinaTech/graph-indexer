/**
 * explore: one call that opens a task — the relevant definitions with their code, callers,
 * overrides, the definitions their code uses and the tests to run — inside a token budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const FILES = {
    'package.json': '{"name":"auth","devDependencies":{"vitest":"1.0.0"}}\n',
    'src/token.ts': [
        'import { now } from "./clock";',
        '/** Decoded token claims. */',
        'export interface Claims { sub: string; exp: number }',
        'export function decodeToken(raw: string): Claims {',
        '  const [sub, exp] = raw.split(".");',
        '  return { sub, exp: Number(exp) };',
        '}',
        '/** Rejects expired tokens. */',
        'export function validateExpiry(claims: Claims): boolean {',
        '  return claims.exp > now();',
        '}',
        '',
    ].join('\n'),
    'src/clock.ts': 'export function now(): number { return Date.now() / 1000; }\nexport const max = 10;\n',
    'src/session.ts': [
        'import { decodeToken, validateExpiry } from "./token";',
        'export class Session {',
        '  open(raw: string) {',
        '    const claims = decodeToken(raw);',
        '    if (!validateExpiry(claims)) throw new Error("expired");',
        '    return Math.max(claims.exp, 0);',
        '  }',
        '}',
        'export class AdminSession extends Session {',
        '  open(raw: string) { return super.open(raw) + 1; }',
        '}',
        '',
    ].join('\n'),
    'src/list.mjs': 'export function paths(cases) {\n  const py = cases.filter(c => c.path.endsWith(".py"));\n  const classes = py.map(c => c.cls);\n  return classes;\n}\n',
    'src/names.mjs': 'export const c = { id: "c" };\nconst classes = [];\nexport function f() { return classes; }\n',
    'src/token.test.ts': 'import { validateExpiry } from "./token";\ndescribe("expiry", () => { it("rejects", () => { validateExpiry({ sub: "a", exp: 0 }); }); });\n',
};

let root, intel;
test.before(async () => {
    root = makeRepo(FILES);
    intel = new CodeIntel({ root });
    await intel.open();
});
test.after(() => { intel?.close(); rmrf(root); });

test('a task in words: the relevant code, its callers, what it uses and the tests to run', async () => {
    const text = await callTool(intel, 'explore', { query: 'where are expired tokens rejected' });
    assert.match(text, /^Exploring "where are expired tokens rejected": \d+ definitions? shown/);
    assert.match(text, /## 1\. validateExpiry — function, exported · src\/token\.ts:9-11/);
    assert.match(text, /10\s+return claims\.exp > now\(\);/, 'its code, with line numbers');
    assert.match(text, /called by \(1\): Session\.open src\/session\.ts:5/);
    assert.match(text, /Defined elsewhere \(used by the code above\):\n(?: {2}.*\n)* {2}now {2}src\/clock\.ts:1/);
    assert.match(text, /Tests \(1 file\): .*src\/token\.test\.ts/);
    assert.match(text, /run: npx vitest run src\/token\.test\.ts/);
});

test('named symbols: a method with its override and the definitions it calls', async () => {
    const text = await callTool(intel, 'explore', { symbols: ['Session.open'] });
    assert.match(text, /## 1\. Session\.open — method.*\(named\)/);
    assert.match(text, /member of Session \(class\)/);
    assert.match(text, /overridden by \(1\): AdminSession\.open \(src\/session\.ts:10\)/);
    assert.match(text, /decodeToken {2}src\/token\.ts:4/);
    // `Math.max(…)` is not a call to the constant `max` in clock.ts
    assert.doesNotMatch(text, /src\/clock\.ts:2/);
});

test('identifiers in the query are looked up exactly; file names are not identifiers', async () => {
    const text = await callTool(intel, 'explore', { query: 'why does decodeToken split the raw string in token.ts' });
    assert.match(text, /## 1\. decodeToken — function.*\(named in the query\)/);
    assert.doesNotMatch(text, /\(named in the query\)[\s\S]*\(named in the query\)/, 'token.ts names no definition');
});

test('the budget is kept, and what did not fit is named', async () => {
    const small = await callTool(intel, 'explore', { query: 'session open decode token expiry', max_tokens: 500 });
    const large = await callTool(intel, 'explore', { query: 'session open decode token expiry', max_tokens: 6000 });
    assert.ok(small.length <= 500 * 3.5 + 400, `small answer is ${small.length} chars`);
    assert.ok(large.length > small.length);
    assert.match(small, /Also relevant \(not shown\):|Left out to fit the budget:/);
});

test('nothing to explore, or nothing found, says what to try', async () => {
    assert.match(await callTool(intel, 'explore', {}), /Provide a query/);
    assert.match(await callTool(intel, 'explore', { symbols: ['NoSuchThing'] }), /Nothing in the index matches "NoSuchThing"/);
});

test('the CLI names the commands to run next', async () => {
    const text = await callTool(intel, 'explore', { query: 'decodeToken' }, { cli: true });
    assert.match(text, /`read <name>…`|`read /);
    assert.doesNotMatch(text, /read_code/);
});

test('lambda parameters and block-scoped locals are not bound to another module\'s top-level names', async () => {
    const refs = intel.store.all(`SELECT r.name, r.dst_id FROM refs r JOIN files f ON f.id = r.file_id WHERE f.path = 'src/list.mjs' AND r.name IN ('c', 'classes')`);
    assert.deepEqual(refs.filter(r => r.dst_id != null && intel.sym(r.dst_id)?.path === 'src/names.mjs'), []);
});
