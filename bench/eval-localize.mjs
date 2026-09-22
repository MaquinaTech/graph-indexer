#!/usr/bin/env node
/**
 * Localization from real history (SWE-bench-style, no hand labels).
 *
 * For recent focused commits of a fixture, the commit subject is the query (a stand-in for the
 * issue an agent is handed) and the source files / functions the commit modified are the answer.
 * Before each query the index is rolled back to the commit's parent (an incremental re-index of
 * a scratch worktree), so nothing from the fix itself is searchable.
 *
 * Systems, all over the same parent snapshot:
 *   graph-indexer  hybrid search (names + BM25F + concepts + priors + centrality), the MCP tool
 *   bm25           the same FTS5 index ranked by BM25F alone (no name channel, priors or graph)
 *   grep           what an agent gets from grepping the query words: files ranked by summed
 *                  idf-weighted term hits, functions by the best-matching line inside them
 * Metrics: file Acc@1/@5 (a changed file among the first k distinct files), function Acc@5/@10
 * and MRR@10 over changed functions/methods.
 *
 *   node bench/fixtures.mjs --history 400        # once: fetch history
 *   node bench/eval-localize.mjs [--fixtures express-js,gin,fastapi,nestjs,axios] [--n 40] [--json out.json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/db.mjs';
import { Indexer } from '../src/index/indexer.mjs';
import { SearchEngine, DEFAULT_WEIGHTS } from '../src/search/search.mjs';
import { computeCentrality } from '../src/index/graph.mjs';
import { specForPath } from '../src/parse/languages.mjs';
import { FIXTURES } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FX = opt('--fixtures', 'express-js,gin,fastapi,nestjs,axios').split(',');
const N = Number(opt('--n', 40));
const FIXDIR = path.resolve(opt('--fixture-dir', path.join(here, '../test/fixtures')));
const WORK = path.resolve(opt('--work-dir', path.join(os.tmpdir(), 'gi-localize')));
const verbose = args.includes('--verbose');
const WEIGHTS = opt('--weights', null) ? { ...DEFAULT_WEIGHTS, ...JSON.parse(opt('--weights')) } : DEFAULT_WEIGHTS;

const NOISE_SUBJECT = /^(merge|revert|release|bump|chore|docs?|test|tests|ci|build|style|lint|format|typo|deps|prepare|version|v?\d+\.\d+)\b/i;
const NOISE_WORDS = /\b(changelog|readme|typo|typos|dependabot|dependencies|lint|prettier|eslint|formatting|release|version bump|copyright)\b/i;
const NON_SOURCE = /(^|\/)(docs?|docs_src|examples?|samples?|benchmarks?|bench|scripts|test|tests|__tests__|spec|fixtures?|integration|e2e|\.github)\//i;
const STOP = new Set('a an the and or of to in on for with when while from by at as is are be been was were it its this that these those not no do does did into onto via use using used add adds added fix fixes fixed fixing support supports make makes should would could can will just also only more less than then else if but so up out all any some new old'.split(' '));

function git(cwd, ...a) {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${(r.stderr || '').trim()}`);
    return r.stdout;
}
const tryGit = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return null; } };

function isSource(p) {
    const spec = specForPath(p);
    return !!spec && spec.id !== 'css' && !spec.testFile?.test(p) && !NON_SOURCE.test(p) && !/\.d\.[cm]?ts$/.test(p);
}

/** Clean a commit subject into an issue-like query. */
function toQuery(subject) {
    return subject
        .replace(/^\w+(\([^)]*\))?!?:\s*/, '')      // conventional-commit prefix
        .replace(/\(#\d+\)|#\d+|\bgh-\d+\b/gi, '')    // PR / issue numbers
        .replace(/\b(closes?|fixes?|resolves?)\s*$/i, '')
        .replace(/\s+/g, ' ').trim();
}

/** Focused, descriptive commits whose changes touch 1–3 existing source files. */
function candidateCommits(repo, pinned, want) {
    const log = git(repo, 'log', '--no-merges', '--format=%H%x1f%P%x1f%s%x1e', '-n', '1500', pinned);
    const out = [];
    for (const rec of log.split('\x1e')) {
        const [sha, parents, subject] = rec.trim().split('\x1f');
        if (!sha || !parents || parents.includes(' ')) continue;
        if (!subject || subject.length < 20 || NOISE_SUBJECT.test(subject) || NOISE_WORDS.test(subject)) continue;
        const query = toQuery(subject);
        if (query.split(' ').length < 3) continue;
        if (tryGit(repo, 'cat-file', '-e', parents + '^{commit}') === null) continue; // beyond the shallow boundary
        const status = tryGit(repo, 'diff', '--name-status', '--no-renames', parents, sha);
        if (!status) continue;
        const rows = status.trim().split('\n').filter(Boolean).map(l => l.split('\t'));
        if (rows.length > 8) continue;
        const gold = rows.filter(([st, p]) => st === 'M' && isSource(p)).map(([, p]) => p);
        if (gold.length < 1 || gold.length > 3) continue;
        out.push({ sha, parent: parents, subject, query, goldFiles: gold });
        if (out.length >= want) break;
    }
    return out;
}

/** Old-side line ranges touched by the commit in one file. */
function touchedRanges(repo, parent, sha, file) {
    const diff = git(repo, 'diff', '-U0', '--no-color', parent, sha, '--', file);
    const ranges = [];
    for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
        const start = Number(m[1]), count = m[2] === undefined ? 1 : Number(m[2]);
        ranges.push(count === 0 ? [start, start + 1] : [start, start + count - 1]); // pure insertion: the lines around it
    }
    return ranges;
}

function goldFunctions(store, repo, c) {
    const ids = new Set();
    for (const file of c.goldFiles) {
        for (const [a, b] of touchedRanges(repo, c.parent, c.sha, file)) {
            const rows = store.all(`SELECT s.id, s.kind, s.start_line, s.end_line FROM symbols s JOIN files f ON f.id = s.file_id
                WHERE f.path = ? AND s.start_line <= ? AND s.end_line >= ? AND s.kind IN ('function','method','constructor')`, file, b, a);
            if (!rows.length) continue;
            // innermost callables only
            const inner = rows.filter(x => !rows.some(y => y.id !== x.id && y.start_line >= x.start_line && y.end_line <= x.end_line && (y.end_line - y.start_line) < (x.end_line - x.start_line)));
            for (const r of inner) ids.add(r.id);
        }
    }
    return ids;
}

// ── grep baseline ─────────────────────────────────────────────────────────────
function grepRank(store, root, query) {
    const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9_]+/).filter(w => w.length >= 3 && !STOP.has(w)))];
    if (!terms.length) return { files: [], syms: [] };
    const files = store.all('SELECT id, path FROM files WHERE is_test = 0').filter(f => isSource(f.path));
    const res = terms.map(t => new RegExp(`\\b${t.replace(/[^a-z0-9_]/g, '')}`, 'i'));
    const df = new Array(terms.length).fill(0);
    const perFile = [];
    for (const f of files) {
        let text;
        try { text = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
        const lines = text.split('\n');
        const tf = new Array(terms.length).fill(0);
        const lineHits = [];
        for (let i = 0; i < lines.length; i++) {
            let n = 0;
            for (let t = 0; t < terms.length; t++) if (res[t].test(lines[i])) { tf[t]++; n++; }
            if (n) lineHits.push([i + 1, n]);
        }
        tf.forEach((v, t) => { if (v) df[t]++; });
        if (lineHits.length) perFile.push({ f, tf, lineHits });
    }
    const idf = df.map(d => Math.log(1 + files.length / (1 + d)));
    for (const x of perFile) x.score = x.tf.reduce((s, v, t) => s + (v ? idf[t] * Math.log(1 + v) : 0), 0);
    perFile.sort((a, b) => b.score - a.score);
    // functions: best-matching line (most distinct terms) inside each function, ties by file rank
    const syms = [];
    for (const x of perFile.slice(0, 50)) {
        const fnRows = store.all("SELECT id, start_line, end_line FROM symbols WHERE file_id = ? AND kind IN ('function','method','constructor')", x.f.id);
        for (const [line, n] of x.lineHits) {
            const inner = fnRows.filter(r => r.start_line <= line && r.end_line >= line).sort((a, b) => (a.end_line - a.start_line) - (b.end_line - b.start_line))[0];
            if (inner) syms.push({ id: inner.id, score: n * 10 + x.score });
        }
    }
    syms.sort((a, b) => b.score - a.score);
    const seen = new Set();
    return { files: perFile.map(x => x.f.path), syms: syms.filter(s => !seen.has(s.id) && seen.add(s.id)).map(s => s.id) };
}

function score(rankedFiles, rankedSyms, c, goldSyms) {
    const fileRank = rankedFiles.findIndex(p => c.goldFiles.includes(p));
    const symRank = rankedSyms.findIndex(id => goldSyms.has(id));
    return {
        f1: fileRank === 0 ? 1 : 0, f5: fileRank >= 0 && fileRank < 5 ? 1 : 0,
        s5: symRank >= 0 && symRank < 5 ? 1 : 0, s10: symRank >= 0 && symRank < 10 ? 1 : 0,
        mrr: symRank >= 0 && symRank < 10 ? 1 / (symRank + 1) : 0,
        hasSyms: goldSyms.size > 0,
    };
}

function filesOf(store, ids) {
    const out = [];
    for (const id of ids) {
        const p = store.get('SELECT f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?', id)?.path;
        if (p && !out.includes(p)) out.push(p);
    }
    return out;
}

async function runFixture(fx) {
    const repo = path.join(FIXDIR, fx);
    const pinned = FIXTURES[fx].commit;
    const commits = candidateCommits(repo, pinned, N);
    if (!commits.length) { console.log(`${fx}: no usable commits (fetch history: node bench/fixtures.mjs --history 400)`); return null; }
    const wt = path.join(WORK, fx);
    tryGit(repo, 'worktree', 'remove', '--force', wt);
    fs.rmSync(wt, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    git(repo, 'worktree', 'add', '-q', '--detach', wt, commits[commits.length - 1].parent);
    const dbPath = path.join(WORK, fx + '.db');
    for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
    const store = new Store(dbPath);
    const ix = new Indexer({ root: wt, store });
    const systems = {
        'graph-indexer': (q) => new SearchEngine(ix, { weights: WEIGHTS, centrality: () => cen }).search(q, { limit: 100 }).results.map(r => r.id),
        'bm25': (q) => new SearchEngine(ix, { weights: Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map(k => [k, k === 'bm25' ? 1 : 0])), perFileCap: 100 }).search(q, { limit: 100 }).results.map(r => r.id),
    };
    let cen = null;
    const rows = [];
    const t0 = Date.now();
    for (const c of [...commits].reverse()) { // oldest first: checkouts move forward
        git(wt, 'checkout', '-q', '--detach', c.parent);
        await ix.sync();
        cen = computeCentrality(store);
        const goldSyms = goldFunctions(store, wt, c);
        const row = { sha: c.sha.slice(0, 10), query: c.query, goldFiles: c.goldFiles, goldSyms: goldSyms.size };
        for (const [name, fn] of Object.entries(systems)) {
            const ids = fn(c.query);
            row[name] = score(filesOf(store, ids), ids, c, goldSyms);
        }
        const g = grepRank(store, wt, c.query);
        row.grep = score(g.files, g.syms, c, goldSyms);
        rows.push(row);
        if (verbose) console.log(`  ${row.sha} f@5 gi=${row['graph-indexer'].f5} bm25=${row.bm25.f5} grep=${row.grep.f5} | ${c.query.slice(0, 80)}  → ${c.goldFiles.join(', ')}`);
    }
    store.close();
    tryGit(repo, 'worktree', 'remove', '--force', wt);
    return { fx, rows, ms: Date.now() - t0 };
}

const SYSTEMS = ['graph-indexer', 'bm25', 'grep'];
function aggregate(rows) {
    const out = {};
    for (const s of SYSTEMS) {
        const withSyms = rows.filter(r => r[s].hasSyms);
        const avg = (rs, k) => rs.length ? rs.reduce((a, r) => a + r[s][k], 0) / rs.length : 0;
        out[s] = { n: rows.length, nf: withSyms.length, f1: avg(rows, 'f1'), f5: avg(rows, 'f5'), s5: avg(withSyms, 's5'), s10: avg(withSyms, 's10'), mrr: avg(withSyms, 'mrr') };
    }
    return out;
}
const fmt = (a) => `file Acc@1 ${a.f1.toFixed(3)}  Acc@5 ${a.f5.toFixed(3)} | fn Acc@5 ${a.s5.toFixed(3)}  Acc@10 ${a.s10.toFixed(3)}  MRR@10 ${a.mrr.toFixed(3)}`;

const all = [];
const report = {};
for (const fx of FX) {
    const r = await runFixture(fx);
    if (!r) continue;
    all.push(...r.rows);
    const agg = aggregate(r.rows);
    report[fx] = { ...agg, rows: r.rows };
    console.log(`\n${fx}: ${r.rows.length} commits (${agg['graph-indexer'].nf} with changed functions), ${(r.ms / 1000).toFixed(1)} s`);
    for (const s of SYSTEMS) console.log(`  ${s.padEnd(14)} ${fmt(agg[s])}`);
}
if (all.length) {
    const agg = aggregate(all);
    console.log(`\nALL: ${all.length} commits`);
    for (const s of SYSTEMS) console.log(`  ${s.padEnd(14)} ${fmt(agg[s])}`);
    report.ALL = agg;
}
if (opt('--json', null)) fs.writeFileSync(opt('--json'), JSON.stringify(report, null, 2));
