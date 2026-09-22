import test from 'node:test';
import assert from 'node:assert/strict';
import { splitIdentifier, codeTokens, analyzeQuery } from '../src/search/tokenize.mjs';

test('splitIdentifier handles camel, Pascal, snake, acronyms and digits', () => {
    assert.deepEqual(splitIdentifier('getUserById'), ['get', 'user', 'by', 'id']);
    assert.deepEqual(splitIdentifier('parseHTTPHeader'), ['parse', 'http', 'header']);
    assert.deepEqual(splitIdentifier('snake_case_name'), ['snake', 'case', 'name']);
    assert.deepEqual(splitIdentifier('utf8Decode'), ['utf', '8', 'decode']);
    assert.deepEqual(splitIdentifier('APIRoute'), ['api', 'route']);
});

test('codeTokens keeps the full identifier and its parts', () => {
    const t = codeTokens('return this.userRepo.findByEmail(email)');
    for (const w of ['userrepo', 'user', 'repo', 'findbyemail', 'find', 'email', 'return', 'this']) assert.ok(t.includes(w), w);
});

test('analyzeQuery separates identifiers, drops stopwords for natural language, expands concepts', () => {
    const a = analyzeQuery('where is the JWT token validated before the request handler');
    assert.equal(a.natural, true);
    assert.ok(!a.terms.includes('the'));
    assert.ok(a.terms.includes('jwt') && a.terms.includes('token'));
    assert.ok(a.expansions.includes('session') || a.expansions.includes('bearer'));
    const b = analyzeQuery('UserService.findAll');
    assert.deepEqual(b.identifiers, ['UserService.findAll']);
    assert.equal(b.natural, false);
    const c = analyzeQuery('APIRoute endpoint path');
    assert.ok(c.identifiers.includes('APIRoute'));
    const d = analyzeQuery('retry logic path:src/net');
    assert.deepEqual(d.filters.path, ['src/net']);
});
