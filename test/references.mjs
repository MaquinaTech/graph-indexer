/**
 * @file test/references.mjs
 * @description Deterministic, offline test for symbol-level references (#3) — the
 *              "find references" capability that sharpens file→file topology into
 *              symbol→symbol. It fuses three reference kinds the index records:
 *              callers (calls), subclasses/implementers (extends), and type users
 *              (type_refs), each split by confidence with the import graph — the
 *              same cheap signal the call graph uses, no type inference.
 *
 *              Mirrors test/callgraph.mjs: two modules export a same-named `User`,
 *              so a referer that imports one is high-confidence while a bare
 *              annotation against an unknown `User` is correctly demoted.
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
import { getParserForFile, ensureLanguagesReady } from '../parse/languages.mjs';
import { findReferences } from '../mcp/topology.mjs';
import { registerTools } from '../mcp/tools.mjs';

// Grammars load lazily now (installed on demand, not bundled) — this repo's own
// devDependencies satisfy ambient resolution, so no install is ever triggered here.
await ensureLanguagesReady({ enabledLangs: null, autoInstall: false });

// ── Fixture: two modules export a same-named class `User`. A referer that imports
//    one of them resolves to an indexed User (high-confidence); a referer that
//    annotates against an unknown `User` (no import) is genuinely ambiguous. Every
//    body spans ≥3 lines (extractSemanticChunks drops <2-row chunks). ───────────
const FILES = {
    'models.ts': `
export class User {
  getId() {
    return this.id;
  }
}
`,
    // Same name, different module → ambiguous symbol.
    'legacy.ts': `
export class User {
  legacyId() {
    return this.id;
  }
}
`,
    'helpers.ts': `
export function format(x) {
  return String(x);
}
`,
    // Imports the indexed User + calls the free function format → both high-confidence.
    'service.ts': `
import { User } from './models';
import { format } from './helpers';
export function handle(u: User) {
  const id = u.getId();
  return format(id);
}
`,
    // Annotates against a User it never imports → name-only (could be any User).
    'report.ts': `
export function summarize(u: User) {
  const data = u;
  return data;
}
`,
    // Subclasses the indexed User → high-confidence inheritance reference.
    'admin.ts': `
import { User } from './models';
export class Admin extends User {
  ban(u) {
    u.disable();
    return u;
  }
}
`,
};

const IMPORTS = {
    'service.ts': ['models.ts', 'helpers.ts'],
    'admin.ts': ['models.ts'],
};

function parseFixture() {
    const parser = getParserForFile('.ts');
    if (!parser) return null;
    const idx = new MemoryGraphIndex(path.join(os.tmpdir(), `refs-${process.pid}.json`), { cacheEmbeddings: false });
    for (const [file, src] of Object.entries(FILES)) {
        const tree = parser.parse((offset) => (offset < src.length ? src.slice(offset, offset + 4096) : null));
        const chunks = extractSemanticChunks(tree.rootNode, file, src, '.ts');
        idx.applyFileUpdate(file, { chunks, imports: IMPORTS[file] || [] });
        if (idx._saveTimer) { clearTimeout(idx._saveTimer); idx._saveTimer = null; }
    }
    return idx;
}

/** Capture the tool handlers registerTools wires onto an McpServer. */
function captureTools(db) {
    const handlers = new Map();
    const fakeServer = { tool: (name, _desc, _shape, handler) => handlers.set(name, handler) };
    registerTools(fakeServer, db, {
        projectRoot: os.tmpdir(), artifactPath: '/nonexistent', pidFile: null,
        embeddingsEnabled: false, embedder: null,
    });
    return handlers;
}

test('findReferers captures type_refs and extends matches (not just calls)', () => {
    const idx = parseFixture();
    if (!idx) { console.log('  ⚠️  tree-sitter-typescript not installed — skipping'); return; }

    const referers = idx.findReferers('User').map(c => c.name).sort();
    assert.deepEqual(referers, ['Admin', 'handle', 'summarize'], 'all type/extends referers found');

    // Case-insensitive, and no partial matches (a "UserProfile" must not match).
    assert.equal(idx.findReferers('user').length, 3, 'case-insensitive symbol match');
    assert.equal(idx.findReferers('Use').length, 0, 'no substring false positives');
});

test('findReferences splits high-confidence from name-only via the import graph', () => {
    const idx = parseFixture();
    if (!idx) return;

    const defs = idx.resolveSymbol('User');
    assert.equal(defs.length, 2, 'two modules define User (ambiguous)');

    const { ambiguous, inherits, types, calls } = findReferences(idx, 'User');
    assert.equal(ambiguous, true, 'User is ambiguous');

    assert.deepEqual(inherits.map(i => i.chunk.name), ['Admin']);
    assert.equal(inherits[0].confidence, 'high', 'subclass importing the def is high-confidence');

    const high = types.filter(t => t.confidence === 'high').map(t => t.chunk.name).sort();
    const nameOnly = types.filter(t => t.confidence === 'name-only').map(t => t.chunk.name).sort();
    assert.deepEqual(high, ['handle'], 'importing type-user is high-confidence');
    assert.deepEqual(nameOnly, ['summarize'], 'non-importing type-user is demoted to name-only');

    assert.equal(calls.high.length + calls.nameOnly.length, 0, 'User has no call-site references');

    console.log(`\n  references to ambiguous \`User\``);
    console.log(`    high-confidence : ${[...inherits.map(i => i.chunk.name), ...high].join(', ')}`);
    console.log(`    name-only       : ${nameOnly.join(', ')}`);
});

test('findReferences flows the call dimension through (broader than get_call_graph)', () => {
    const idx = parseFixture();
    if (!idx) return;
    const { calls, inherits, types } = findReferences(idx, 'format');
    assert.deepEqual(calls.high.map(h => h.chunk.name), ['handle'], 'caller of format found and credited');
    assert.equal(inherits.length, 0);
    assert.equal(types.length, 0);
});

test('find_references tool renders grouped markdown', async () => {
    const idx = parseFixture();
    if (!idx) return;
    const tools = captureTools(idx);
    assert.ok(tools.has('find_references'), 'find_references tool registered');

    const res = await tools.get('find_references')({ symbol: 'User' });
    const text = res.content[0].text;
    assert.match(text, /Subclassed \/ implemented by/, 'has an inheritance section');
    assert.match(text, /Admin/, 'lists the subclass');
    assert.match(text, /Used as a type by/, 'has a type-user section');
    assert.match(text, /handle/, 'lists the type user');
    assert.match(text, /unverified/, 'flags the name-only annotation');
});

test('find_references tool returns typed structuredContent for json format', async () => {
    const idx = parseFixture();
    if (!idx) return;
    const tools = captureTools(idx);

    const res = await tools.get('find_references')({ symbol: 'User', response_format: 'json' });
    const sc = res.structuredContent;
    assert.ok(sc, 'structuredContent present');
    assert.equal(sc.symbol, 'User');
    assert.equal(sc.ambiguous, true);
    assert.equal(sc.definition_count, 2);
    assert.deepEqual(sc.subclassed_by.map(r => r.name), ['Admin']);
    assert.equal(sc.subclassed_by[0].confidence, 'high');
    assert.ok(sc.used_as_type_by.some(r => r.name === 'handle' && r.confidence === 'high'));
    assert.ok(sc.used_as_type_by.some(r => r.name === 'summarize' && r.confidence === 'name-only'));
    assert.deepEqual(JSON.parse(res.content[0].text), sc, 'json text block matches structuredContent');
});

// ── Fixture (C5/D1): a symbol exercised by a test, called by a non-test, so the
//    test→code mapping must surface only the TEST chunk. The test body is an
//    `expression_statement` chunk (test('…', () => { … })) whose calls include the
//    symbol. ───────────────────────────────────────────────────────────────────────
const TC_FILES = {
    'auth.ts': `
export function validateToken(token) {
  const ok = verify(token);
  return ok;
}
`,
    'service.ts': `
import { validateToken } from './auth';
export function handleRequest(req) {
  const v = validateToken(req.token);
  return v;
}
`,
    'auth.test.ts': `
import { validateToken } from './auth';
test('validateToken accepts a good token', () => {
  const r = validateToken('good');
  expect(r).toBe(true);
});
`,
};
const TC_IMPORTS = { 'service.ts': ['auth.ts'], 'auth.test.ts': ['auth.ts'] };

function parseTCFixture() {
    const parser = getParserForFile('.ts');
    if (!parser) return null;
    const idx = new MemoryGraphIndex(path.join(os.tmpdir(), `tc-${process.pid}.json`), { cacheEmbeddings: false });
    for (const [file, src] of Object.entries(TC_FILES)) {
        const tree = parser.parse((offset) => (offset < src.length ? src.slice(offset, offset + 4096) : null));
        const chunks = extractSemanticChunks(tree.rootNode, file, src, '.ts');
        idx.applyFileUpdate(file, { chunks, imports: TC_IMPORTS[file] || [] });
        if (idx._saveTimer) { clearTimeout(idx._saveTimer); idx._saveTimer = null; }
    }
    return idx;
}

test('tests_for surfaces only the test chunks that exercise a symbol', async () => {
    const idx = parseTCFixture();
    if (!idx) { console.log('  ⚠️  tree-sitter-typescript not installed — skipping'); return; }
    const tools = captureTools(idx);

    const res = await tools.get('tests_for')({ symbol: 'validateToken', response_format: 'json' });
    const sc = res.structuredContent;
    assert.equal(sc.symbol, 'validateToken');
    assert.equal(sc.test_count, 1, 'only the auth.test.ts chunk — not the service.ts caller');
    assert.match(sc.tests[0].file_path, /auth\.test\.ts/, 'the mapped test is in the test file');
    assert.deepEqual(JSON.parse(res.content[0].text), sc, 'json text block matches structuredContent');

    const md = await tools.get('tests_for')({ symbol: 'validateToken' });
    assert.match(md.content[0].text, /auth\.test\.ts/, 'markdown lists the test');

    const none = await tools.get('tests_for')({ symbol: 'handleRequest', response_format: 'json' });
    assert.equal(none.structuredContent.test_count, 0, 'a symbol with no tests reports zero');
});

test('explain_symbol composes definition, callees, callers and tests in one call', async () => {
    const idx = parseTCFixture();
    if (!idx) return;
    const tools = captureTools(idx);

    const res = await tools.get('explain_symbol')({ symbol: 'validateToken', response_format: 'json' });
    const sc = res.structuredContent;
    assert.equal(sc.definition_count, 1, 'one definition');
    assert.ok(sc.callees.includes('verify'), 'callees = what the symbol calls');
    const callerNames = [...sc.called_by.high, ...sc.called_by.name_only].map(c => c.name);
    assert.ok(callerNames.includes('handleRequest'), 'the non-test caller is in the blast radius');
    assert.equal(sc.tests.length, 1, 'the exercising test is surfaced');
    assert.match(sc.tests[0].file_path, /auth\.test\.ts/);
    assert.deepEqual(JSON.parse(res.content[0].text), sc, 'json text block matches structuredContent');

    const md = await tools.get('explain_symbol')({ symbol: 'validateToken' });
    assert.match(md.content[0].text, /validateToken/);
    assert.match(md.content[0].text, /Tests/, 'markdown has a tests section');
});
