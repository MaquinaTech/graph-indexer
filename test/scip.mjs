/**
 * @file test/scip.mjs
 * @description A2 — SCIP resolver provider tests. Three layers, the first three parser-free:
 *                1. wire reader: a tiny in-test SCIP protobuf encoder round-trips through loadScip
 *                   (real bytes, real decode); the JSON convenience path parses too.
 *                2. alignment: buildScipBindings places occurrences into the containing chunk by
 *                   1-based line range and derives the fromChunk → defChunk relation.
 *                3. resolver: createScipResolver promotes a confirmed target, suppresses the
 *                   wrong-target siblings, and falls through (null) when SCIP has no evidence.
 *              The end-to-end + parity tests parse a real ambiguous-name TS fixture (guarded-skip
 *              if tree-sitter-typescript is absent) and prove buildSymbolGraph, under the scip
 *              resolver, marks the confirmed edge `resolved` and DROPS the wrong-target edge —
 *              byte-identically across memory ↔ sqlite.
 *
 *              A2 v2 adds a fourth layer: buildScipReferers inverts the same binding relation into
 *              the precise cross-file "referenced-by" map find_references consumes (a `resolved`
 *              tier), serialized as an isolated artifact. Tests cover the inversion, the new
 *              find_references dimension (precise + correctly attributed), memory↔sqlite parity, the
 *              sacred-default byte-identity when no SCIP index is present, and incremental staleness.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { loadScip, buildScipBindings, buildScipReferers, normalizeScipPath } from '../parse/scip.mjs';
import { createScipResolver, getResolver } from '../mcp/resolver.mjs';
import { buildSymbolGraph } from '../mcp/symbolgraph.mjs';
import { findReferences } from '../mcp/topology.mjs';
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { SqliteGraphStore } from '../engine/sqlite.mjs';
import { getParserForFile } from '../parse/languages.mjs';
import { extractSemanticChunks } from '../parse/extractor.mjs';

const tmp = (ext) => path.join(os.tmpdir(), `scip-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`);
const rm = (p) => { for (const s of ['', '-wal', '-shm']) fs.rmSync(`${p}${s}`, { force: true }); };

// ── A tiny SCIP protobuf encoder (test-only fixture builder) ────────────────────────────────
function writeVarint(n) {
    const bytes = [];
    let v = n;
    for (;;) { const b = v % 128; v = Math.floor(v / 128); if (v) bytes.push(b | 0x80); else { bytes.push(b); break; } }
    return Buffer.from(bytes);
}
const protoTag = (field, wire) => writeVarint(field * 8 + wire);
const lenDelim = (field, payload) => Buffer.concat([protoTag(field, 2), writeVarint(payload.length), payload]);
const strField = (field, s) => lenDelim(field, Buffer.from(s, 'utf8'));
const varintField = (field, n) => Buffer.concat([protoTag(field, 0), writeVarint(n)]);
const packedRange = (field, ints) => lenDelim(field, Buffer.concat(ints.map(writeVarint)));
function encOccurrence(o) {
    const parts = [packedRange(1, o.range), strField(2, o.symbol)];
    if (o.roles) parts.push(varintField(3, o.roles));
    return Buffer.concat(parts);
}
function encDocument(d) {
    const parts = [strField(1, d.relativePath)];
    for (const o of (d.occurrences || [])) parts.push(lenDelim(2, encOccurrence(o)));
    return Buffer.concat(parts);
}
const encodeScip = (documents) => Buffer.concat(documents.map(d => lenDelim(2, encDocument(d))));

// ── Layer 1: wire reader ────────────────────────────────────────────────────────────────────
test('scip (A2): protobuf wire round-trips documents / occurrences / Definition role', () => {
    const docs = [
        { relativePath: 'a.ts', occurrences: [
            { range: [0, 16, 22], symbol: 'pkg a.ts/format().', roles: 1 }, // definition (role bit 0x1)
            { range: [3, 9, 15], symbol: 'pkg a.ts/format().', roles: 0 },  // reference
        ] },
        { relativePath: 'sub/b.ts', occurrences: [
            { range: [5, 0, 6], symbol: 'pkg b.ts/handle().', roles: 1 },
        ] },
    ];
    const p = tmp('.scip');
    fs.writeFileSync(p, encodeScip(docs));
    const got = loadScip(p);
    rm(p);

    assert.equal(got.documents.length, 2);
    assert.equal(got.documents[0].relativePath, 'a.ts');
    assert.equal(got.documents[1].relativePath, 'sub/b.ts');
    const occ = got.documents[0].occurrences;
    assert.equal(occ.length, 2);
    assert.equal(occ[0].startLine, 0);
    assert.equal(occ[0].symbol, 'pkg a.ts/format().');
    assert.equal(occ[0].isDefinition, true, 'role 0x1 → definition');
    assert.equal(occ[1].isDefinition, false, 'role 0 → reference');
});

test('scip (A2): JSON-shaped index parses (snake_case + camelCase keys)', () => {
    const p = tmp('.json');
    fs.writeFileSync(p, JSON.stringify({ documents: [
        { relative_path: 'a.ts', occurrences: [{ range: [2, 1, 9], symbol: 'S', symbol_roles: 1 }] },
        { relativePath: 'b.ts', occurrences: [{ range: [4, 0, 5], Symbol: 'S', symbolRoles: 0 }] },
    ] }));
    const got = loadScip(p);
    rm(p);
    assert.equal(got.documents.length, 2);
    assert.equal(got.documents[0].occurrences[0].isDefinition, true);
    assert.equal(got.documents[1].occurrences[0].symbol, 'S');
    assert.equal(got.documents[1].occurrences[0].isDefinition, false);
});

test('scip (A2): normalizeScipPath → repo-relative POSIX (strips ./, /, file://, backslashes)', () => {
    assert.equal(normalizeScipPath('./src/a.ts'), 'src/a.ts');
    assert.equal(normalizeScipPath('/src/a.ts'), 'src/a.ts');
    assert.equal(normalizeScipPath('src\\a.ts'), 'src/a.ts');
    assert.equal(normalizeScipPath('file:///src/a.ts'), 'src/a.ts');
    assert.equal(normalizeScipPath('src/a.ts'), 'src/a.ts');
});

// ── Layer 2: alignment ──────────────────────────────────────────────────────────────────────
const fakeDb = (chunks) => ({ * iterateChunks() { yield* chunks; } });

test('scip (A2): buildScipBindings aligns occurrences to the containing chunk by 1-based line', () => {
    const chunks = [
        { id: 'fmtA', file_path: 'a.ts', start_line: 1, end_line: 3, name: 'format' },
        { id: 'fmtB', file_path: 'b.ts', start_line: 1, end_line: 3, name: 'format' },
        { id: 'handle', file_path: 'c.ts', start_line: 2, end_line: 4, name: 'handle' },
    ];
    const scip = { documents: [
        { relativePath: 'a.ts', occurrences: [{ startLine: 0, symbol: 'S#format', isDefinition: true }] },     // line 1 ∈ fmtA
        { relativePath: 'c.ts', occurrences: [{ startLine: 2, symbol: 'S#format', isDefinition: false }] },    // line 3 ∈ handle
        { relativePath: 'zzz.ts', occurrences: [{ startLine: 0, symbol: 'S#x', isDefinition: true }] },        // unmatched doc
    ] };
    const { bindings, definedChunks, stats } = buildScipBindings(fakeDb(chunks), scip);
    assert.deepEqual([...(bindings.get('handle') || [])], ['fmtA'], 'handle binds only to the SCIP-defined fmtA');
    assert.ok(!bindings.has('fmtA'), 'fmtA has no outbound references');
    assert.deepEqual([...definedChunks], ['fmtA'], 'only fmtA was recorded as a SCIP definition');
    assert.equal(stats.matchedDocs, 2, 'a.ts + c.ts matched; zzz.ts did not');
    assert.equal(stats.definedSymbols, 1, 'only S#format had a placed definition');
    assert.equal(stats.bindingPairs, 1);
});

test('scip (A2): chunkContaining picks the most specific (smallest-span) enclosing chunk', () => {
    const chunks = [
        { id: 'cls', file_path: 'a.ts', start_line: 1, end_line: 20, name: 'Big' },
        { id: 'm', file_path: 'a.ts', start_line: 5, end_line: 8, name: 'method' },
        { id: 'def', file_path: 'a.ts', start_line: 6, end_line: 6, name: 'target' },
    ];
    const scip = { documents: [
        { relativePath: 'a.ts', occurrences: [{ startLine: 5, symbol: 'S#target', isDefinition: true }] },  // line 6
        // a reference on line 7 (∈ method 5-8 and class 1-20) must attribute to the method, not the class
        { relativePath: 'a.ts', occurrences: [{ startLine: 6, symbol: 'S#target', isDefinition: false }] },
    ] };
    const { bindings } = buildScipBindings(fakeDb(chunks), scip);
    assert.deepEqual([...(bindings.get('m') || [])], ['def'], 'reference attributed to innermost chunk');
    assert.ok(!bindings.has('cls'), 'not attributed to the enclosing god-class');
});

// ── Layer 3: resolver provider ──────────────────────────────────────────────────────────────
test('scip (A2): resolver promotes confirmed, suppresses SCIP-known siblings, keeps uncovered defs', () => {
    // SCIP saw defA and defB as definitions; caller binds defA.
    const r = createScipResolver(new Map([['caller', new Set(['defA'])]]), new Set(['defA', 'defB']));
    const d = r.resolveEdges({ fromId: 'caller', defIds: ['defA', 'defB'] });
    assert.ok(d && d.resolved.has('defA'), 'confirms defA');
    assert.ok(d.suppressed.has('defB'), 'suppresses defB (SCIP saw it, caller bound elsewhere)');
    // SOUNDNESS: defC is NOT SCIP-known → must NOT be suppressed (partial coverage → fall through).
    const d2 = r.resolveEdges({ fromId: 'caller', defIds: ['defA', 'defC'] });
    assert.ok(d2.resolved.has('defA') && !d2.suppressed.has('defC'), 'uncovered def kept at heuristic');
    // uncovered caller → null (heuristic fall-through)
    assert.equal(r.resolveEdges({ fromId: 'other', defIds: ['defA'] }), null);
    // covered caller, but none of these defIds is a SCIP target → null (absence ≠ refutation)
    assert.equal(r.resolveEdges({ fromId: 'caller', defIds: ['defZ'] }), null);
    // confidenceFor is identity (uncovered edges keep base confidence)
    assert.equal(r.confidenceFor('high', true), 'high');
    assert.equal(r.confidenceFor('name_only', false), 'name_only');
    // empty/garbage bindings → inert
    assert.equal(createScipResolver(null, null).resolveEdges({ fromId: 'x', defIds: ['y'] }), null);
});

// ── End-to-end + parity over a real ambiguous-name fixture ──────────────────────────────────
const FILES = {
    'a.ts': 'export function format(x) {\n    return String(x);\n}\n',
    'b.ts': 'export function format(y) {\n    return y.trim();\n}\n',
    'c.ts': "import { format } from './a.js';\nexport function handle(v) {\n    return format(v);\n}\n",
};

function parseFiles(files) {
    const parser = getParserForFile('.ts');
    if (!parser) return null;
    const perFile = {};
    for (const [f, src] of Object.entries(files)) {
        const tree = parser.parse((o) => (o < src.length ? src.slice(o, o + 4096) : null));
        perFile[f] = extractSemanticChunks(tree.rootNode, f, src, '.ts');
    }
    return perFile;
}
const parseFixture = () => parseFiles(FILES);

function buildScan(perFile) {
    const p = tmp('.json');
    const scan = new MemoryGraphIndex(p, { cacheEmbeddings: false });
    for (const [f, chunks] of Object.entries(perFile)) {
        scan.applyFileUpdate(f, { chunks, imports: [] });
        if (scan._saveTimer) { clearTimeout(scan._saveTimer); scan._saveTimer = null; }
    }
    return { scan, path: p };
}

// SCIP fixture in raw SCIP-JSON shape (range = [startLine, startChar, endChar], symbol_roles bit
// 0x1 = Definition), aligned to the real fixture lines. SCIP sees BOTH format definitions (a.ts and
// b.ts — distinct symbols) and the reference in c.ts (line 3, startLine 2) binding to a.ts/format.
// Because SCIP recorded b.ts/format as a definition, suppressing handle→format@b is SOUND.
const SCIP_FIXTURE = { documents: [
    { relative_path: 'a.ts', occurrences: [{ range: [0, 16, 22], symbol: 'scip ts . . a.ts/format().', symbol_roles: 1 }] },
    { relative_path: 'b.ts', occurrences: [{ range: [0, 16, 22], symbol: 'scip ts . . b.ts/format().', symbol_roles: 1 }] },
    { relative_path: 'c.ts', occurrences: [{ range: [2, 11, 17], symbol: 'scip ts . . a.ts/format().', symbol_roles: 0 }] },
] };

// PARTIAL-coverage fixture: SCIP never recorded b.ts (a .ts-only run that missed it / a stale index).
// b.ts/format is therefore NOT a SCIP-known def, so handle→format@b must NOT be suppressed.
const SCIP_FIXTURE_PARTIAL = { documents: [
    { relative_path: 'a.ts', occurrences: [{ range: [0, 16, 22], symbol: 'scip ts . . a.ts/format().', symbol_roles: 1 }] },
    { relative_path: 'c.ts', occurrences: [{ range: [2, 11, 17], symbol: 'scip ts . . a.ts/format().', symbol_roles: 0 }] },
] };

function callsEdge(edges, fromId, toId) {
    return edges.find(e => e.from_chunk_id === fromId && e.to_chunk_id === toId && e.kind === 'calls');
}

test('scip (A2): end-to-end — confirmed binding → `resolved`, wrong-target fan-out SUPPRESSED', () => {
    const perFile = parseFixture();
    if (!perFile) { console.log('  ⚠️  tree-sitter-typescript not installed — skipping'); return; }
    const { scan, path: p } = buildScan(perFile);

    const fmts = scan.resolveSymbol('format');
    assert.equal(fmts.length, 2, 'format is ambiguous (two defs) — the case SCIP disambiguates');
    const fmtA = fmts.find(c => c.file_path === 'a.ts').id;
    const fmtB = fmts.find(c => c.file_path === 'b.ts').id;
    const handle = scan.resolveSymbol('handle')[0].id;

    // Heuristic: handle fans out to BOTH format defs (it cannot tell which).
    const heur = buildSymbolGraph(scan, { resolver: getResolver('heuristic') }).edges;
    assert.ok(callsEdge(heur, handle, fmtA), 'heuristic: handle→format@a present');
    assert.ok(callsEdge(heur, handle, fmtB), 'heuristic: handle→format@b present (the false fan-out edge)');

    // SCIP: align a real .scip-shaped index, then resolve.
    const sp = tmp('.json');
    fs.writeFileSync(sp, JSON.stringify(SCIP_FIXTURE));
    const { bindings, definedChunks, stats } = buildScipBindings(scan, loadScip(sp));
    rm(sp);
    assert.equal(stats.matchedDocs, 3);
    assert.deepEqual([...(bindings.get(handle) || [])], [fmtA], 'SCIP binds handle → format@a only');
    assert.ok(definedChunks.has(fmtA) && definedChunks.has(fmtB), 'SCIP recorded BOTH format defs');

    const scip = buildSymbolGraph(scan, { resolver: createScipResolver(bindings, definedChunks) }).edges;
    const eA = callsEdge(scip, handle, fmtA);
    assert.ok(eA, 'scip: confirmed handle→format@a kept');
    assert.equal(eA.confidence, 'resolved', 'scip: confirmed edge is `resolved`');
    assert.equal(callsEdge(scip, handle, fmtB), undefined, 'scip: wrong-target handle→format@b SUPPRESSED');

    // Same (from,to,kind) skeleton minus the suppressed edge — never adds an edge.
    const tup = (es) => es.map(e => `${e.from_chunk_id}|${e.to_chunk_id}|${e.kind}`);
    const suppressed = `${handle}|${fmtB}|calls`;
    assert.deepEqual(tup(scip).sort(), tup(heur).filter(t => t !== suppressed).sort(),
        'scip edge set == heuristic minus the suppressed wrong-target edge');

    rm(p);
});

test('scip (A2): SOUND under partial coverage — an uncovered def is NOT suppressed', () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const { scan, path: p } = buildScan(perFile);
    const fmts = scan.resolveSymbol('format');
    const fmtA = fmts.find(c => c.file_path === 'a.ts').id;
    const fmtB = fmts.find(c => c.file_path === 'b.ts').id;
    const handle = scan.resolveSymbol('handle')[0].id;

    // SCIP never saw b.ts → format@b is not a SCIP-known def.
    const sp = tmp('.json');
    fs.writeFileSync(sp, JSON.stringify(SCIP_FIXTURE_PARTIAL));
    const { bindings, definedChunks } = buildScipBindings(scan, loadScip(sp));
    rm(sp);
    assert.ok(definedChunks.has(fmtA) && !definedChunks.has(fmtB), 'b.ts/format is NOT SCIP-known');

    const scip = buildSymbolGraph(scan, { resolver: createScipResolver(bindings, definedChunks) }).edges;
    const eA = callsEdge(scip, handle, fmtA);
    assert.equal(eA?.confidence, 'resolved', 'covered binding handle→format@a still promoted');
    const eB = callsEdge(scip, handle, fmtB);
    assert.ok(eB, 'uncovered handle→format@b is KEPT (not dropped) — the soundness guarantee');
    assert.notEqual(eB.confidence, 'resolved', 'and it stays at heuristic confidence, not resolved');
    rm(p);
});

test('scip (A2): the resolved+suppressed graph round-trips memory ↔ sqlite identically', () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const { scan, path: p } = buildScan(perFile);
    const fmts = scan.resolveSymbol('format');
    const fmtA = fmts.find(c => c.file_path === 'a.ts').id;
    const fmtB = fmts.find(c => c.file_path === 'b.ts').id;
    const handle = scan.resolveSymbol('handle')[0].id;
    const bindings = new Map([[handle, new Set([fmtA])]]);
    const definedChunks = new Set([fmtA, fmtB]); // SCIP saw both → handle→fmtB is soundly suppressed
    const edges = buildSymbolGraph(scan, { resolver: createScipResolver(bindings, definedChunks) }).edges;
    const chunks = [...scan.chunks.values()];
    const graph = scan.graph;

    // memory
    const memPath = tmp('.json');
    fs.writeFileSync(memPath, JSON.stringify({ chunks, graph, edges }));
    const mem = new MemoryGraphIndex(memPath); mem.load();
    // sqlite
    const dbPath = tmp('.db');
    new SqliteGraphStore(dbPath).buildFrom({ chunks, graph, embeddingCache: new Map(), edges });
    const sq = new SqliteGraphStore(dbPath); sq.load();

    const inEdges = (db, id) => db.getEdges(id, { direction: 'in', kind: 'calls' })
        .map(e => `${e.from_chunk_id}|${e.confidence}`).sort();
    // fmtA: a single `resolved` inbound edge; fmtB: NONE (suppressed) — identical in both backends.
    assert.deepEqual(inEdges(sq, fmtA), inEdges(mem, fmtA), 'getEdges(format@a) parity');
    assert.deepEqual(inEdges(sq, fmtB), inEdges(mem, fmtB), 'getEdges(format@b) parity');
    assert.ok(inEdges(mem, fmtA).some(s => s.endsWith('|resolved')), 'format@a carries the resolved tier');
    assert.equal(inEdges(mem, fmtB).length, 0, 'format@b has no inbound calls edge (suppressed)');
    // findCallers membership parity (handle is still a real caller of format via the resolved edge).
    const names = (cs) => cs.map(c => c.name).sort();
    assert.deepEqual(names(sq.findCallers('format')), names(mem.findCallers('format')), 'findCallers parity');

    sq.close?.();
    rm(dbPath); rm(memPath); rm(p);
});

// Cross-kind: an ambiguous CLASS used in `extends`. SCIP's binding relation is kind-agnostic, so a
// naive resolver would let it leak into heritage edges — A2 scopes resolution to `calls` only.
const HERITAGE_FILES = {
    'svc1.ts': 'export class Service {\n    run() { return 1; }\n}\n',
    'svc2.ts': 'export class Service {\n    run() { return 2; }\n}\n',
    'use.ts': "import { Service } from './svc1.js';\nexport class Worker extends Service {\n    go() { return this.run(); }\n}\n",
};

test('scip (A2): calls-only scope — extends/type edges are byte-identical to heuristic (no cross-kind leak)', () => {
    const perFile = parseFiles(HERITAGE_FILES);
    if (!perFile) { console.log('  ⚠️  tree-sitter-typescript not installed — skipping'); return; }
    const { scan, path: p } = buildScan(perFile);
    const svcs = scan.resolveSymbol('Service');
    assert.equal(svcs.length, 2, 'Service is ambiguous (two class defs)');
    const worker = scan.resolveSymbol('Worker')[0].id;
    const svc1 = svcs.find(c => c.file_path === 'svc1.ts').id;

    // A SCIP binding Worker→Service@svc1 exists and BOTH Service defs are SCIP-known — exactly the
    // setup that, if SCIP touched heritage edges, would wrongly suppress Worker→Service@svc2.
    const bindings = new Map([[worker, new Set([svc1])]]);
    const defined = new Set(svcs.map(c => c.id));

    const refEdges = (es) => es.filter(e => e.kind === 'extends' || e.kind === 'type')
        .map(e => `${e.from_chunk_id}|${e.to_chunk_id}|${e.kind}|${e.confidence}`).sort();
    const heur = buildSymbolGraph(scan, { resolver: getResolver('heuristic') }).edges;
    const scip = buildSymbolGraph(scan, { resolver: createScipResolver(bindings, defined) }).edges;

    assert.ok(refEdges(heur).length > 0, 'fixture produces extends/type edges');
    assert.deepEqual(refEdges(scip), refEdges(heur),
        'scip leaves extends/type edges byte-identical to heuristic — no promotion, no suppression');
    rm(p);
});

// ── A2 v2: SCIP-backed precise cross-file references (find_references) ───────────────────────

test('scip (A2 v2): buildScipReferers inverts the binding relation deterministically', () => {
    // bindings: two callers reference a def in D; a third references E.
    const bindings = new Map([
        ['callerB', new Set(['D'])],
        ['callerA', new Set(['D', 'E'])],
    ]);
    const refs = buildScipReferers(bindings);
    assert.deepEqual(Object.keys(refs).sort(), ['D', 'E'], 'keys are the definition chunks');
    assert.deepEqual(refs.D, ['callerA', 'callerB'], 'referers sorted, both callers of D');
    assert.deepEqual(refs.E, ['callerA']);
    // determinism: rebuilt from a differently-ordered map → identical bytes
    const refs2 = buildScipReferers(new Map([['callerA', new Set(['E', 'D'])], ['callerB', new Set(['D'])]]));
    assert.equal(JSON.stringify(refs2), JSON.stringify(refs), 'serialization is order-independent');
    // garbage in → empty (never throws)
    assert.deepEqual(buildScipReferers(null), {});
});

/** Load chunks + an optional scip_refs payload into BOTH backends; return { mem, sq, dbPath, memPath }. */
function loadBothWithScipRefs(scan, scipRefs) {
    const chunks = [...scan.chunks.values()];
    const graph = scan.graph;
    const memPath = tmp('.json');
    fs.writeFileSync(memPath, JSON.stringify({ chunks, graph, ...(scipRefs ? { scip_refs: scipRefs } : {}) }));
    const mem = new MemoryGraphIndex(memPath); mem.load();
    const dbPath = tmp('.db');
    new SqliteGraphStore(dbPath).buildFrom({ chunks, graph, embeddingCache: new Map(), scipRefs });
    const sq = new SqliteGraphStore(dbPath); sq.load();
    return { mem, sq, dbPath, memPath };
}

test('scip (A2 v2): find_references gains a precise `resolved` reference, attributed to the right def', () => {
    const perFile = parseFixture();
    if (!perFile) { console.log('  ⚠️  tree-sitter-typescript not installed — skipping'); return; }
    const { scan, path: p } = buildScan(perFile);
    const fmts = scan.resolveSymbol('format');           // ambiguous: format@a and format@b
    const fmtA = fmts.find(c => c.file_path === 'a.ts').id;
    const fmtB = fmts.find(c => c.file_path === 'b.ts').id;
    const handle = scan.resolveSymbol('handle')[0].id;

    // SCIP binds handle → format@a only; invert to the referenced-by map find_references consumes.
    const sp = tmp('.json');
    fs.writeFileSync(sp, JSON.stringify(SCIP_FIXTURE));
    const { bindings } = buildScipBindings(scan, loadScip(sp));
    rm(sp);
    const scipRefs = buildScipReferers(bindings);
    assert.deepEqual(scipRefs[fmtA], [handle], 'format@a is referenced by handle (precise)');
    assert.ok(!scipRefs[fmtB], 'format@b has no SCIP referer — disambiguated away');

    const { mem, sq, dbPath, memPath } = loadBothWithScipRefs(scan, scipRefs);
    assert.ok(mem.hasScipRefs() && sq.hasScipRefs(), 'both backends report SCIP refs present');

    const refs = findReferences(mem, 'format').references;
    assert.equal(refs.length, 1, 'exactly one precise referer (handle → format@a); format@b contributes none');
    assert.equal(refs[0].chunk.id, handle);
    assert.equal(refs[0].confidence, 'resolved', 'SCIP reference is the trustworthy resolved tier');

    sq.close?.(); rm(dbPath); rm(memPath); rm(p);
});

test('scip (A2 v2): SCIP references round-trip memory ↔ sqlite identically (parity)', () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const { scan, path: p } = buildScan(perFile);
    const fmtA = scan.resolveSymbol('format').find(c => c.file_path === 'a.ts').id;
    const handle = scan.resolveSymbol('handle')[0].id;
    const scipRefs = { [fmtA]: [handle] };
    const { mem, sq, dbPath, memPath } = loadBothWithScipRefs(scan, scipRefs);

    assert.equal(sq.scipRefCount(), mem.scipRefCount(), 'scipRefCount parity');
    assert.deepEqual(sq.getScipReferers(fmtA), mem.getScipReferers(fmtA), 'getScipReferers parity');
    const ids = (db) => findReferences(db, 'format').references.map(r => r.chunk.id);
    assert.deepEqual(ids(sq), ids(mem), 'find_references precise dimension is byte-identical across backends');

    sq.close?.(); rm(dbPath); rm(memPath); rm(p);
});

test('scip (A2 v2): SACRED DEFAULT — no SCIP index → no scip_refs key, empty references, byte-identical', () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const { scan, path: p } = buildScan(perFile);
    const { mem, sq, dbPath, memPath } = loadBothWithScipRefs(scan, null);   // ← no scip refs

    assert.equal(mem.hasScipRefs(), false, 'memory: absent on a default index');
    assert.equal(sq.hasScipRefs(), false, 'sqlite: absent on a default index');
    assert.equal(mem.scipRefCount(), 0);
    assert.deepEqual(findReferences(mem, 'format').references, [], 'references dimension is empty (default path)');
    assert.deepEqual(findReferences(sq, 'format').references, []);
    // the serialized JSON must NOT carry a scip_refs key (sacred-default byte-identity)
    assert.ok(!('scip_refs' in JSON.parse(fs.readFileSync(memPath, 'utf8'))), 'no scip_refs key when feature is off');

    sq.close?.(); rm(dbPath); rm(memPath); rm(p);
});

test('scip (A2 v2): an incremental file update drops the now-stale SCIP references', () => {
    const perFile = parseFixture();
    if (!perFile) return;
    const { scan, path: p } = buildScan(perFile);
    const fmtA = scan.resolveSymbol('format').find(c => c.file_path === 'a.ts').id;
    const handle = scan.resolveSymbol('handle')[0].id;
    const { mem, sq, dbPath, memPath } = loadBothWithScipRefs(scan, { [fmtA]: [handle] });
    assert.ok(mem.hasScipRefs() && sq.hasScipRefs());

    mem.applyFileUpdate('c.ts', { chunks: perFile['c.ts'], imports: [] });
    if (mem._saveTimer) { clearTimeout(mem._saveTimer); mem._saveTimer = null; }
    sq.applyFileUpdate('c.ts', { chunks: perFile['c.ts'], imports: [] });
    assert.equal(mem.hasScipRefs(), false, 'memory: a per-file edit makes whole-program refs stale → cleared');
    assert.equal(sq.hasScipRefs(), false, 'sqlite: same — DELETE FROM scip_refs on incremental update');
    assert.deepEqual(findReferences(mem, 'format').references, [], 'no stale precise references served');

    sq.close?.(); rm(dbPath); rm(memPath); rm(p);
});
