/**
 * What the index cannot see must not be presented as seen (#5): a qualified name whose owner
 * declares nothing of that name is not answered with another owner's member, and a "Complete"
 * footer says so when the parser could not read code that mentions the symbol.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { extractFile } from '../src/parse/extract.mjs';
import { specForPath } from '../src/parse/languages.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const FILES = {
    'src/ports.ts': 'export class OtherPort {\n  execute(): void {}\n}\nexport function helper(): number { return 1; }\n',
    'src/use.ts': "import { OtherPort, helper } from './ports';\nexport function run(p: OtherPort) {\n  p.execute();\n  return helper();\n}\n",
    // a region the parser cannot read, around a mention of `execute`
    'src/broken.ts': "import { OtherPort } from './ports';\nexport function later(p: OtherPort) {\n  const x = ) p.execute(;\n}\n",
};

let root, intel;
test.before(async () => {
    root = makeRepo(FILES);
    intel = new CodeIntel({ root });
    await intel.open();
});
test.after(() => { intel?.close(); rmrf(root); });

test('an owner that declares nothing of that name is reported, not replaced by another owner', async () => {
    const text = await callTool(intel, 'find_references', { symbol: 'RefreshPort.execute' });
    assert.match(text, /^No definition of "execute" in "RefreshPort"/);
    assert.match(text, /src\/ports\.ts:OtherPort\.execute {2}method line 2/);
    assert.doesNotMatch(text, /^References to/m);
    assert.doesNotMatch(text, /Complete/);
    assert.match(await callTool(intel, 'call_graph', { symbol: 'RefreshPort.execute' }), /^No definition of "execute" in "RefreshPort"/);
});

test('a qualifier that names the file or a directory still finds a top-level definition', async () => {
    assert.match(await callTool(intel, 'find_references', { symbol: 'ports.helper' }), /^References to helper \(function\) src\/ports\.ts/);
    assert.match(await callTool(intel, 'find_references', { symbol: 'src.ports.helper' }), /^References to helper \(function\)/);
    assert.match(await callTool(intel, 'find_references', { symbol: 'OtherPort.execute' }), /^References to OtherPort\.execute \(method\)/);
});

test('"Complete" is limited to the files the parser read, and the unreadable lines are named', async () => {
    const text = await callTool(intel, 'find_references', { symbol: 'OtherPort.execute' });
    assert.match(text, /Complete in the files the parser read:/);
    assert.match(text, /Not fully parsed: 1 file that mentions "execute"[^\n]*\n {2}src\/broken\.ts:3/);
    const graph = await callTool(intel, 'call_graph', { symbol: 'OtherPort.execute', direction: 'callers' });
    assert.match(graph, /Complete in the files the parser read/);
    assert.match(graph, /src\/broken\.ts:3/);
    // a name only outside the unreadable region gets no note
    assert.doesNotMatch(await callTool(intel, 'find_references', { symbol: 'helper' }), /Not fully parsed/);
});

test('a receiver declared as a type the index lacks is not bound to another type\'s same-name member', async () => {
    const dir = makeRepo({
        'src/a.ts': [
            "import { RefreshPort } from 'external-lib';",
            'export class OtherPort { execute(): void {} }',
            'export function viaParam(p: RefreshPort) { p.execute(); }',
            'export function viaWrapper(p: InstanceType<typeof OtherPort>) { p.execute(); }',
            'export function viaOwn(p: OtherPort) { p.execute(); }',
            '',
        ].join('\n'),
    });
    const ix = new CodeIntel({ root: dir });
    try {
        await ix.open();
        const text = await callTool(ix, 'find_references', { symbol: 'OtherPort.execute' });
        assert.doesNotMatch(text, /^ +3 +call +in viaParam/m);
        assert.match(text, /^ +4 +call +in viaWrapper/m);
        assert.match(text, /^ +5 +call +in viaOwn {2}│/m);
        assert.match(text, /Possibly missed: 1 "execute\(…\)" call[^\n]*\n {2}src\/a\.ts:3 {2}\(p\.execute\)/);
        assert.doesNotMatch(text, /Complete/);
    } finally { ix.close(); rmrf(dir); }
});

test('Python 3.15 lazy imports (PEP 810) parse as imports, positions unchanged', async () => {
    const src = 'lazy import json\nlazy from pkg.mod import thing as t\nlazy = 1\n\ndef f():\n    return t.go(json.dumps(lazy))\n';
    const x = await extractFile(specForPath('m.py'), src, 'm.py');
    assert.equal(x.errors, 0);
    assert.deepEqual(x.imports.map(i => [i.source, i.imported, i.local ?? null, i.line]), [['json', '*', 'json', 1], ['pkg.mod', 'thing', 't', 2]].map(([s, n, l, ln]) => [s, n, l, ln]));
    assert.ok(x.symbols.some(s => s.name === 'f' && s.startLine === 5));
    assert.ok(x.symbols.some(s => s.name === 'lazy' && s.startLine === 3), 'a variable named lazy is untouched');
});

test('error regions count ERROR nodes only: an inserted (MISSING) token keeps the structure', async () => {
    const src = 'export const A = styled.div<{ x?: boolean }>`\n  color: red;\n`;\n';
    const styled = await extractFile(specForPath('a.tsx'), src, 'a.tsx');
    assert.equal(styled.errors, 0);
    assert.deepEqual(styled.errorLines, []);
    assert.ok(styled.symbols.some(s => s.name === 'A'));
    const broken = await extractFile(specForPath('b.ts'), FILES['src/broken.ts'], 'b.ts');
    assert.ok(broken.errors >= 1);
    assert.ok(broken.errorLines.some(([a, b]) => a <= 3 && b >= 3), JSON.stringify(broken.errorLines));
});
