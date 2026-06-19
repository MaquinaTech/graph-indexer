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
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { extractSemanticChunks } from '../parse/extractor.mjs';
import { getParserForFile } from '../parse/languages.mjs';
import { classifyCallers, buildSubgraph } from '../mcp/topology.mjs';

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

test('buildSubgraph returns a bounded, deterministic connected subgraph', () => {
    const idx = parseFixture();
    if (!idx) return;
    const g = buildSubgraph(idx, 'checkout', { maxNodes: 12, maxDepth: 2 });
    assert.equal(g.found, true, 'seed resolves');
    const ids = new Map(g.nodes.map(n => [n.id, n.name]));
    const names = new Set(g.nodes.map(n => n.name));
    assert.ok(names.has('checkout'), 'seed is in the subgraph');
    assert.ok(g.nodes.length <= 12, 'respects max_nodes');
    // checkout calls save → an outgoing calls-edge from the seed.
    assert.ok(g.edges.some(e => ids.get(e.from) === 'checkout' && e.kind === 'calls'), 'seed has an outgoing calls edge');
    // run() calls checkout() → run is pulled in as a high-confidence caller.
    assert.ok(names.has('run'), 'high-confidence caller run() is included');
    assert.ok(g.edges.some(e => ids.get(e.from) === 'run' && ids.get(e.to) === 'checkout' && e.kind === 'calls'), 'run → checkout edge present');
    // Fully deterministic.
    assert.deepEqual(buildSubgraph(idx, 'checkout', { maxNodes: 12, maxDepth: 2 }), g, 'subgraph is reproducible');
    // Token budget bounds it and flags truncation.
    const tiny = buildSubgraph(idx, 'checkout', { maxNodes: 12, maxDepth: 2, tokenBudget: 15 });
    assert.ok(tiny.nodes.length < g.nodes.length, 'a tiny token budget shrinks the subgraph');
    assert.ok(tiny.truncated, 'truncation is flagged when the budget bites');
    // A missing seed is handled, not thrown.
    assert.equal(buildSubgraph(idx, 'doesNotExistXYZ', {}).found, false, 'missing seed → found:false');
});

// ── Fixture 2: scope-aware receiver TYPE inference. The dynamically-typed receiver
//    `const s = getStore(); s.save()` (and `new Repo()`, typed params) used to land in
//    the name-only bucket because the receiver hint is a *variable*, not a type. We now
//    resolve the local binding to a type and promote the caller when that type is the
//    class defining the target method. `OrderRepo` is padded past the 200-line god-class
//    threshold so its `save` method becomes its own chunk with class_context='OrderRepo'
//    (the only way a method is a resolvable symbol); a second free `save` keeps the name
//    ambiguous so promotion is meaningful (a unique name is trivially credited). ───────
const GOD_PADDING = Array.from({ length: 210 }, (_, i) => `  // padding ${i} to exceed the 200-line god-class threshold`).join('\n');
const TYPE_FILES = {
    // God-class: OrderRepo.save() is a real, resolvable symbol (class_context set).
    'orderRepo.ts': `
export class OrderRepo {
  save(order) {
    writeRow(order);
    return order;
  }
${GOD_PADDING}
}
`,
    // A second, free `save` → the name is ambiguous (otherwise every caller is the
    // trivially-credited "sole definition").
    'freeStore.ts': `
export function save(thing) {
  writeRow(thing);
  return thing;
}
`,
    // A factory whose recorded return_type is OrderRepo (non-exported so the chunk is the
    // function_declaration that carries the return_type field).
    'factory.ts': `
function makeRepo(): OrderRepo {
  const r = new OrderRepo();
  return r;
}
`,
    // Four callers of `.save()`. None imports a definition, so ONLY receiver-type
    // inference can promote them — isolating the new signal from the import-graph one.
    'callers.ts': `
export function withNew(o) {
  const r = new OrderRepo();
  r.save(o);
  return r;
}
export function withParam(repo: OrderRepo) {
  repo.save(repo);
  return repo;
}
export function withFactory(o) {
  const m = makeRepo();
  m.save(o);
  return m;
}
export function withUnknown(o) {
  const x = getUnknown();
  x.save(o);
  return x;
}
`,
};

// withNew (new OrderRepo), withParam (typed param), withFactory (makeRepo(): OrderRepo)
// all dispatch on an OrderRepo. withUnknown hits a save on an unresolvable receiver.
const TRUE_TYPED_CALLERS = new Set(['withNew', 'withParam', 'withFactory']);

function parseTypeFixture() {
    const parser = getParserForFile('.ts');
    if (!parser) return null;
    const idx = new MemoryGraphIndex(path.join(os.tmpdir(), `cgt-${process.pid}.json`), { cacheEmbeddings: false });
    for (const [file, src] of Object.entries(TYPE_FILES)) {
        const tree = parser.parse((offset) => (offset < src.length ? src.slice(offset, offset + 4096) : null));
        const chunks = extractSemanticChunks(tree.rootNode, file, src, '.ts');
        idx.applyFileUpdate(file, { chunks, imports: [] }); // no import edges — type inference only
        if (idx._saveTimer) { clearTimeout(idx._saveTimer); idx._saveTimer = null; }
    }
    return idx;
}

test('scope-aware receiver types promote dynamic-receiver callers (new / factory / typed param)', () => {
    const idx = parseTypeFixture();
    if (!idx) { console.log('  ⚠️  tree-sitter-typescript not installed — skipping'); return; }

    // Precondition: the god-class split made OrderRepo.save its own chunk, and the
    // factory recorded its return type. Without these the test would be vacuous.
    const saveDefs = idx.resolveSymbol('save');
    const orderRepoSave = saveDefs.find(d => (d.class_context || '').toLowerCase() === 'orderrepo');
    assert.ok(orderRepoSave, 'OrderRepo.save() is a resolvable method symbol (god-class split fired)');
    assert.equal(saveDefs.length, 2, 'save is ambiguous: OrderRepo.save + a free save');
    assert.equal(idx.resolveSymbol('makeRepo')[0]?.return_type, 'OrderRepo', 'factory return type recorded');

    const baseline = idx.findCallers('save');               // name-only: every `save` caller
    const base = pr(baseline, TRUE_TYPED_CALLERS);
    const { high, nameOnly, ambiguous } = classifyCallers(idx, 'save');
    const hi = pr(high, TRUE_TYPED_CALLERS);

    console.log(`\n  call-graph precision (callers reached through a typed/inferred receiver)`);
    console.log(`    name-only baseline : P=${base.precision.toFixed(2)} R=${base.recall.toFixed(2)}  [${base.names.join(', ')}]`);
    console.log(`    receiver-type aware: P=${hi.precision.toFixed(2)} R=${hi.recall.toFixed(2)}  [${hi.names.join(', ')}]`);
    console.log(`    name-only bucket   : [${nameOnly.map(n => n.chunk.name).join(', ')}]`);

    assert.equal(ambiguous, true, 'save is ambiguous (a god-class method + a free function)');
    assert.equal(hi.recall, 1, 'receiver-type inference keeps full recall');
    assert.equal(hi.precision, 1, 'receiver-type inference is fully precise');
    assert.ok(hi.precision > base.precision, 'precision strictly improves over name-only');
    assert.deepEqual(high.map(h => h.chunk.name).sort(), ['withFactory', 'withNew', 'withParam'],
        'new / factory-return / typed-param receivers are all high-confidence');
    // Every promotion is justified by the resolved type, naming the right class.
    for (const h of high) assert.equal(h.reason, 'OrderRepo.save()', `${h.chunk.name} promoted via the resolved receiver type`);
    // The genuinely ambiguous receiver (unresolvable factory) stays name-only.
    assert.deepEqual(nameOnly.map(n => n.chunk.name), ['withUnknown'],
        'an unresolvable receiver type is NOT fabricated into confidence');
});
