/** The first answer `init` shows: a method that shares its name, grep versus its exact uses. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

test('demo picks a method drowned in same-name text and states both counts', async () => {
    const root = makeRepo({
        'src/cart.ts': 'export class Cart {\n  total(): number { return 1; }\n}\nexport class Wishlist {\n  total(): number { return 0; }\n}\n',
        'src/use.ts': 'import { Cart, Wishlist } from "./cart";\nexport function a(c: Cart) { return c.total() + c.total() + c.total(); }\nexport function b(w: Wishlist) { return w.total(); }\n// total in a comment\nexport const total = 3;\n',
    });
    const intel = new CodeIntel({ root });
    try {
        await intel.open();
        const text = await callTool(intel, 'demo', {});
        assert.match(text, /Example from this repository: Cart\.total \(src\/cart\.ts:2\) is one of 2 definitions named "total"\./);
        assert.match(text, /grep -w total: \d+ lines in 2 files/);
        assert.match(text, /graph-indexer: +3 calls in 1 file, bound to this definition/);
        assert.match(text, /See them: npx graph-indexer refs Cart\.total/);
    } finally { intel.close(); rmrf(root); }
});

test('demo says so when no method shares its name', async () => {
    const root = makeRepo({ 'a.js': 'export function only() { return 1; }\nonly();\n' });
    const intel = new CodeIntel({ root });
    try {
        await intel.open();
        assert.match(await callTool(intel, 'demo', {}), /No method here shares its name/);
    } finally { intel.close(); rmrf(root); }
});

test('report: sizes, binding rates and latencies, and nothing from the code', async () => {
    const { reportText } = await import('../src/query/report.mjs');
    const root = makeRepo({ 'src/secretName.ts': 'export function hiddenThing() { return 1; }\nexport function caller() { return hiddenThing(); }\n' });
    const intel = new CodeIntel({ root });
    try {
        await intel.open();
        const text = await reportText(intel, { version: '9.9.9' });
        assert.match(text, /graph-indexer 9\.9\.9, Node\.js/);
        assert.match(text, /\| typescript \| 1 \| 1 \| 100% \| 100% \|/);
        assert.match(text, /find_references [\d.]+ ms/);
        assert.doesNotMatch(text, /secretName|hiddenThing|caller|src\//);
    } finally { intel.close(); rmrf(root); }
});
