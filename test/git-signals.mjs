/**
 * @file test/git-signals.mjs
 * @description Tests the air-gapped git-signal feature (#5): churn / recency /
 *              co-change collected from a *local* commit log, the co-change
 *              blast-radius hint surfaced by get_call_graph + find_references, and
 *              the OPT-IN ranking boost in search_code (default off = ranking
 *              unchanged, which is what keeps the retrieval eval untouched).
 *
 *              Builds a throwaway git repo with a controlled commit history; no
 *              network, no remote. Skips cleanly if git is unavailable.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { extractSemanticChunks } from '../parse/extractor.mjs';
import { getParserForFile } from '../parse/languages.mjs';
import { registerTools } from '../mcp/tools.mjs';
import { collectGitSignals, coChangesFor, gitBoostScore } from '../git-signals.mjs';

function gitAvailable() {
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; }
    catch { return false; }
}

/** Build a temp git repo with a deterministic co-change history. */
function buildRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-git-'));
    const g = (...args) => execFileSync('git', ['-C', root, ...args], {
        stdio: 'ignore',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
    g('init', '-q');
    g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    const write = (f, s) => fs.writeFileSync(path.join(root, f), s);
    const commit = (files, msg) => { for (const f of files) write(f, `// ${msg}\n${Math.random()}\n`); g('add', '-A'); g('commit', '-q', '-m', msg); };

    commit(['a.ts', 'b.ts'], 'c1');   // a–b co-change
    commit(['a.ts', 'b.ts'], 'c2');   // a–b again
    commit(['a.ts', 'c.ts'], 'c3');   // a–c, and a is most recent
    return root;
}

test('collectGitSignals derives churn, recency and co-change from local history', () => {
    if (!gitAvailable()) { console.log('  ⚠️  git not available — skipping'); return; }
    const root = buildRepo();
    try {
        const s = collectGitSignals(root);
        assert.ok(s, 'signals collected');
        assert.equal(s.commits, 3);
        assert.equal(s.churn['a.ts'], 3, 'a touched in all 3 commits');
        assert.equal(s.churn['b.ts'], 2);
        assert.equal(s.churn['c.ts'], 1);
        assert.equal(s.maxChurn, 3);

        const co = coChangesFor(s, 'a.ts');
        assert.deepEqual(co, [{ file: 'b.ts', count: 2 }, { file: 'c.ts', count: 1 }], 'co-change ranked by strength');

        // a.ts is both hottest and most recent → strictly highest boost.
        assert.ok(gitBoostScore(s, 'a.ts') > gitBoostScore(s, 'c.ts'), 'hotter/newer file scores higher');
        assert.equal(gitBoostScore(s, 'unknown.ts'), 0, 'no signal → zero boost (no perturbation)');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('collectGitSignals is a silent no-op outside a git repo', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-nogit-'));
    try { assert.equal(collectGitSignals(tmp), null); }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('collectGitSignals scopes to a subdirectory and never leaks the parent repo', () => {
    if (!gitAvailable()) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-sub-'));
    const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    try {
        g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
        fs.mkdirSync(path.join(root, 'pkg'));
        fs.writeFileSync(path.join(root, 'rootfile.ts'), 'export const a = 1;\n');
        fs.writeFileSync(path.join(root, 'pkg', 'inner.ts'), 'export const b = 2;\n');
        g('add', '-A'); g('commit', '-q', '-m', 'c1');

        // Indexing the subdir must yield SUBDIR-RELATIVE paths only — never the
        // parent's rootfile.ts, and never a 'pkg/'-prefixed path.
        const sub = collectGitSignals(path.join(root, 'pkg'));
        assert.ok(sub, 'subdir with tracked history yields signals');
        const files = Object.keys(sub.churn);
        assert.deepEqual(files, ['inner.ts'], 'only the subtree, prefix stripped');
        assert.ok(!files.includes('rootfile.ts'), 'parent-root file excluded');

        // An untracked nested dir (no tracked history) must NOT leak the parent.
        fs.mkdirSync(path.join(root, 'untracked'));
        fs.writeFileSync(path.join(root, 'untracked', 'x.ts'), 'export const c = 3;\n');
        assert.equal(collectGitSignals(path.join(root, 'untracked')), null, 'untracked subtree → null, no parent leak');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// ── Tool-layer wiring with an injected (synthetic) signals object ───────────────

const FILES = {
    'orders.ts': `
export function processOrder(o) {
  const v = validate(o);
  return v;
}
`,
    'billing.ts': `
export function processOrder(o) {
  const c = charge(o);
  return c;
}
`,
};
const SIGNALS = {
    generated: 0, commits: 10, maxChurn: 10,
    churn: { 'orders.ts': 2, 'billing.ts': 10 },
    lastCommit: { 'orders.ts': Math.floor(Date.now() / 1000) - 86400 * 200, 'billing.ts': Math.floor(Date.now() / 1000) },
    coChange: { 'orders.ts': [['payments.ts', 7], ['ledger.ts', 3]], 'billing.ts': [['ledger.ts', 4]] },
};

function buildIndex() {
    const parser = getParserForFile('.ts');
    if (!parser) return null;
    const idx = new MemoryGraphIndex(path.join(os.tmpdir(), `gi-gx-${process.pid}.json`), { cacheEmbeddings: false });
    for (const [file, src] of Object.entries(FILES)) {
        const tree = parser.parse((o) => (o < src.length ? src.slice(o, o + 4096) : null));
        idx.applyFileUpdate(file, { chunks: extractSemanticChunks(tree.rootNode, file, src, '.ts'), imports: [] });
        if (idx._saveTimer) { clearTimeout(idx._saveTimer); idx._saveTimer = null; }
    }
    return idx;
}

function captureTools(db, opts = {}) {
    const handlers = new Map();
    const fakeServer = { tool: (name, _d, _s, h) => handlers.set(name, h) };
    registerTools(fakeServer, db, {
        projectRoot: os.tmpdir(), artifactPath: '/nonexistent', pidFile: null,
        embeddingsEnabled: false, embedder: null, ...opts,
    });
    return handlers;
}

test('get_call_graph surfaces the co-change blast-radius hint', async () => {
    const idx = buildIndex();
    if (!idx) { console.log('  ⚠️  tree-sitter-typescript not installed — skipping'); return; }
    const tools = captureTools(idx, { gitSignals: SIGNALS });

    const md = await tools.get('get_call_graph')({ target_function: 'processOrder', target_class: undefined });
    assert.match(md.content[0].text, /Historically changes with/, 'markdown shows the co-change hint');
    assert.match(md.content[0].text, /payments\.ts/, 'lists the strongest co-change partner');

    const js = await tools.get('get_call_graph')({ target_function: 'processOrder', response_format: 'json' });
    assert.ok(Array.isArray(js.structuredContent.co_changes), 'json carries co_changes');
    assert.ok(js.structuredContent.co_changes.some(c => c.file === 'payments.ts'));
});

test('find_references surfaces the co-change hint too', async () => {
    const idx = buildIndex();
    if (!idx) return;
    const tools = captureTools(idx, { gitSignals: SIGNALS });
    const js = await tools.get('find_references')({ symbol: 'processOrder', response_format: 'json' });
    assert.ok(js.structuredContent.co_changes.some(c => c.file === 'payments.ts'));
});

test('git rank boost is opt-in: default off leaves scores untouched, on reorders', async () => {
    const idx = buildIndex();
    if (!idx) return;
    const q = { query: 'process order', top_k: 2, min_score: 0, detail: 'signatures', include_topology: false, response_format: 'json' };

    // Default (no boost): both functions match; scores are the raw RRF.
    const base = (await captureTools(idx, { gitSignals: SIGNALS, gitRankBoost: 0 }).get('search_code')(q)).structuredContent;
    const baseBilling = base.results.find(r => r.file_path === 'billing.ts');
    assert.ok(baseBilling, 'billing.ts present in baseline');

    // Boosted: billing.ts is the hottest/newest file → its score is lifted and it ranks #1.
    const boosted = (await captureTools(idx, { gitSignals: SIGNALS, gitRankBoost: 1 }).get('search_code')(q)).structuredContent;
    const boostBilling = boosted.results.find(r => r.file_path === 'billing.ts');
    assert.ok(boostBilling.score > baseBilling.score, 'boost lifts the hot file score');
    assert.equal(boosted.results[0].file_path, 'billing.ts', 'hot file ranks first under boost');
});
