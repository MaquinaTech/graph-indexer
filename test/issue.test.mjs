/**
 * explore on an issue as written: the definitions where the names it uses meet, matched by their
 * words (`DATE_DIFF`, `DateDiff`, `_date_diff_sql`), the title's names first, tests left out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { issueTerms, issueSeeds, isIssueText } from '../src/query/issue.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const ISSUE = [
    '# Presto: `DATE_DIFF` from BigQuery `DATETIME_DIFF` ignores the week start',
    '',
    'Transpiling a week difference loses the start day:',
    '',
    '```python',
    'import sqlglot',
    'sqlglot.transpile("SELECT DATETIME_DIFF(a, b, WEEK(MONDAY))", read="bigquery", write="presto")',
    '```',
    '',
    '**Expected:** the week boundary is kept.',
].join('\n');

const FILES = {
    'sqlglot/__init__.py': 'def transpile(sql, read=None, write=None):\n    return [sql]\n',
    'sqlglot/generators/presto.py': [
        'from sqlglot import exp',
        '',
        'def _date_diff_sql(self, expression: exp.DateDiff | exp.DatetimeDiff):',
        '    unit = expression.unit',
        '    return self.func("DATE_DIFF", unit, expression.expression, expression.this)',
        '',
        'def _explode_sql(self, expression):',
        '    return self.func("UNNEST", expression.this)',
        '',
    ].join('\n'),
    'sqlglot/expressions.py': [
        'class DatetimeDiff:',
        '    arg_types = {"this": True, "unit": False}',
        '',
        'class DateDiff:',
        '    arg_types = {"this": True, "unit": False}',
        '',
    ].join('\n'),
    // a table of names carries many of the issue's words without combining them
    'sqlglot/keywords.py': 'RESERVED = {\n    "select", "week", "monday", "sunday",\n    "read", "write", "unit", "this",\n}\n',
    // a token enum: one entry per keyword of the language
    'sqlglot/tokens.py': 'class TokenType:\n' + ['ALTER', 'TABLE', ...Array.from({ length: 120 }, (_, i) => `KW${i}`)].map(k => `    ${k} = "${k}"\n`).join(''),
    'sqlglot/parser.py': 'def _parse_alter(self):\n    """ALTER TABLE: the actions after the table name."""\n    return self._parse_alter_table_actions()\n',
    'tests/test_presto.py': 'def test_date_diff():\n    assert _date_diff_sql and DatetimeDiff and "DATE_DIFF"\n',
};

let root, intel;
test.before(async () => {
    root = makeRepo(FILES);
    intel = new CodeIntel({ root });
    await intel.open();
});
test.after(() => { intel?.close(); rmrf(root); });

test('issue terms: one term per spelling of a name, the fence language left out, the title marked', () => {
    const terms = issueTerms(ISSUE);
    const keys = terms.map(t => t.key);
    assert.ok(keys.includes('date_diff') && keys.includes('datetime_diff'));
    assert.equal(keys.filter(k => k === 'date_diff').length, 1);
    assert.ok(!keys.includes('python'), 'the fence tag is not code');
    assert.ok(terms.find(t => t.key === 'date_diff').title);
    assert.ok(!terms.find(t => t.key === 'monday').title);
    assert.ok(isIssueText(ISSUE));
    assert.ok(!isIssueText('where are expired tokens rejected'));
});

test('issue seeds: the function where the names meet first, tests and tables of names behind', () => {
    const seeds = issueSeeds(intel, ISSUE).map(r => intel.sym(r.id));
    assert.equal(seeds[0].qname, '_date_diff_sql');
    assert.ok(seeds.every(s => !s.path.startsWith('tests/')), 'tests are left out');
    const rank = (q) => seeds.findIndex(s => s.qname === q);
    assert.ok(rank('RESERVED') === -1 || rank('RESERVED') > rank('_date_diff_sql'));
});

test('explore with an issue: the code to change shown first, with why it was picked', async () => {
    const text = await callTool(intel, 'explore', { query: ISSUE });
    assert.match(text, /## 1\. _date_diff_sql — function · sqlglot\/generators\/presto\.py:3-5 {2}\(issue terms: date_diff/);
    assert.match(text, /5\s+return self\.func\("DATE_DIFF"/);
});

test('a keyword in capitals is not a lookup of a token enum entry', async () => {
    const text = await callTool(intel, 'explore', { query: 'ALTER TABLE with mixed actions falls back to a command' });
    assert.doesNotMatch(text, /## \d+\. TokenType\.(ALTER|TABLE) /);
    assert.match(text, /## 1\. _parse_alter /);
});
