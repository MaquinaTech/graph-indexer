/**
 * @file test/callgraph.mjs
 * @description Deterministic, offline precision/recall harness for the call graph
 *              — the feature get_call_graph is sold on ("see every caller before
 *              you change a function"). The bare name-match call graph has perfect
 *              recall but leaks precision on ambiguous names: two modules each
 *              export a `save()`, and a caller through an unknown receiver looks
 *              identical to a real one. This builds a tiny fixture with that exact
 *              collision, labels the callers that truly hit an indexed `save`, and
 *              measures name-only vs receiver-/import-aware classification.
 *
 *              No Ollama, no network — pure parser + in-memory engine.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { MemoryGraphIndex } from '../core-engine.mjs';
import { getParserForFile, extractSemanticChunks } from '../parser-utils.mjs';
import { classifyCallers } from '../mcp-tools.mjs';

// ── Fixture: two modules export a same-named free function `save`. Callers that
//    import one of them are real callers of an indexed save; a caller that hits a
//    `save` through an unknown receiver (no import) is genuinely ambiguous. ──────
// NOTE: every function body spans ≥3 lines — extractSemanticChunks drops chunks
// shorter than 2 rows (one-liner stubs), so single-line bodies would not index.
const FILES = {
    'orderStore.ts': `
export function save(order) {
  writeRow(order);
  return order;
}
export function remove(order) {
  deleteRow(order);
  return order;
}
`,
    'userStore.ts': `
export function save(user) {
  writeRow(user);
  return user;
}
`,
    'checkout.ts': `
import { save } from './orderStore';
export function checkout(order) {
  validate(order);
  save(order);
  return order;
}
`,
    'signup.ts': `
import { save } from './userStore';
export function signup(user) {
  prepare(user);
  save(user);
  return user;
}
`,
    'audit.ts': `
export function audit() {
  const sink = getSink();
  sink.save();
  return sink;
}
`,
    // A class to prove this-receivers are captured on real parses.
    'repo.ts': `
export class Repo {
  update(x) {
    this.prepare(x);
    this.save(x);
  }
  save(x) {
    writeRow(x);
    return x;
  }
}
`,
    // A unique-name caller, to prove unambiguous symbols stay fully credited.
    'flow.ts': `
import { checkout } from './checkout';
export function run(order) {
  checkout(order);
  return order;
}
`,
};

// Resolved local import edges (file → files it imports), as the indexer would build.
const IMPORTS = {
    'checkout.ts': ['orderStore.ts'],
    'signup.ts': ['userStore.ts'],
    'flow.ts': ['checkout.ts'],
};

// Ground truth: callers that truly invoke an INDEXED `save` (checkout→orderStore,
// signup→userStore). `audit` calls a `save` on an unknown external object.
const TRUE_SAVE_CALLERS = new Set(['checkout', 'signup']);

function parseFixture() {
    const parser = getParserForFile('.ts');
    if (!parser) return null;
    const idx = new MemoryGraphIndex(path.join(os.tmpdir(), `cg-${process.pid}.json`), { cacheEmbeddings: false });
    for (const [file, src] of Object.entries(FILES)) {
        const tree = parser.parse((offset) => (offset < src.length ? src.slice(offset, offset + 4096) : null));
        const chunks = extractSemanticChunks(tree.rootNode, file, src, '.ts');
        idx.applyFileUpdate(file, { chunks, imports: IMPORTS[file] || [] });
        if (idx._saveTimer) { clearTimeout(idx._saveTimer); idx._saveTimer = null; } // no disk writes in test
    }
    return idx;
}

function pr(items, truth) {
    const names = new Set(items.map(c => (c.chunk || c).name));
    let tp = 0;
    for (const n of names) if (truth.has(n)) tp++;
    return { precision: names.size ? tp / names.size : 1, recall: truth.size ? tp / truth.size : 1, names: [...names] };
}

test('call sites carry receiver hints after parsing', () => {
    const idx = parseFixture();
    if (!idx) { console.log('  ⚠️  tree-sitter-typescript not installed — skipping'); return; }

    // this.save() inside a class chunk → recv 'this'.
    const repo = idx.resolveSymbol('Repo')[0];
    assert.ok(repo, 'Repo class chunk exists');
    const thisSave = (repo.call_sites || []).find(s => s.name === 'save');
    assert.ok(thisSave && thisSave.recv === 'this', 'this.save() captured as a this-receiver');

    // Direct save(order) → recv '' (unqualified).
    const checkout = idx.resolveSymbol('checkout')[0];
    const directSave = (checkout.call_sites || []).find(s => s.name === 'save');
    assert.ok(directSave && directSave.recv === '', 'direct save() captured as unqualified');

    // sink.save() → recv 'sink'.
    const audit = idx.resolveSymbol('audit')[0];
    const recvSave = (audit.call_sites || []).find(s => s.name === 'save');
    assert.ok(recvSave && recvSave.recv === 'sink', 'sink.save() captured with its receiver');
});

test('receiver/import-aware classification beats name-only precision', () => {
    const idx = parseFixture();
    if (!idx) return;

    const baseline = idx.findCallers('save');           // old behaviour: every `save` caller
    const base = pr(baseline, TRUE_SAVE_CALLERS);

    const { high, nameOnly, ambiguous } = classifyCallers(idx, 'save');
    const hi = pr(high, TRUE_SAVE_CALLERS);

    console.log(`\n  call-graph precision (callers of an indexed save)`);
    console.log(`    name-only baseline : P=${base.precision.toFixed(2)} R=${base.recall.toFixed(2)}  [${base.names.join(', ')}]`);
    console.log(`    receiver-aware     : P=${hi.precision.toFixed(2)} R=${hi.recall.toFixed(2)}  [${hi.names.join(', ')}]`);
    console.log(`    name-only bucket   : [${nameOnly.map(n => n.chunk.name).join(', ')}]`);

    assert.equal(ambiguous, true, 'save is ambiguous (two modules export it)');
    assert.equal(base.recall, 1, 'baseline finds both true callers (perfect recall)');
    assert.ok(base.precision < 1, 'baseline leaks precision (audit is a false positive)');
    assert.equal(hi.recall, 1, 'receiver-aware keeps full recall');
    assert.equal(hi.precision, 1, 'receiver-aware achieves full precision');
    assert.ok(hi.precision > base.precision, 'precision strictly improves');
    assert.deepEqual(high.map(h => h.chunk.name).sort(), ['checkout', 'signup'], 'only the true callers are high-confidence');
    // Both false positives (audit's external sink.save, Repo's own this.save) demoted.
    assert.deepEqual(nameOnly.map(n => n.chunk.name).sort(), ['Repo', 'audit'], 'false positives bucketed as name-only');
});

test('unambiguous names stay fully credited (no false demotion)', () => {
    const idx = parseFixture();
    if (!idx) return;
    const { high, nameOnly, ambiguous } = classifyCallers(idx, 'checkout');
    assert.equal(ambiguous, false, 'checkout is unambiguous');
    assert.deepEqual(high.map(h => h.chunk.name).sort(), ['run']);
    assert.equal(nameOnly.length, 0, 'no name-only matches for a unique symbol');
});
