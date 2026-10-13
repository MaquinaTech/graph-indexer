/**
 * escapeRegExp (src/util/regex.mjs): a symbol name as a literal inside the regular expressions that
 * find its uses in source lines.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeRegExp } from '../src/util/regex.mjs';

test('escapeRegExp makes every metacharacter literal, backslash included', () => {
    for (const s of ['$el', 'a\\b', 'x.y', 'f(n)', 'a+b*c?', '[x]{2}', 'a|b^c', 'plain_name']) {
        const re = new RegExp(`^${escapeRegExp(s)}$`);
        assert.ok(re.test(s), s);
        assert.ok(!re.test(`${s}x`), s);
    }
    // an identifier is unchanged apart from $, so name matching behaves as before
    assert.equal(escapeRegExp('get_user2'), 'get_user2');
    assert.equal(escapeRegExp('$scope'), '\\$scope');
});
