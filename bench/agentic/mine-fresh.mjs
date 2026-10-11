#!/usr/bin/env node
/**
 * Mine "fresh" change tasks from a repository's recent history (after the models' training
 * cutoff), SWE-bench style, and validate each one by running its tests:
 *
 *   - a focused commit: 1–3 modified source files plus test changes, at most 8 files in total;
 *   - base = the commit's parent; the hidden test patch = the commit's test changes;
 *   - the test patch holds every file the commit changes under the test tree, data included
 *     (`tests/fixtures/*.sql`); a repository's `fixtureTests` names the test modules that read such
 *     data, and they run with the touched test files;
 *   - FAIL_TO_PASS = tests that fail at base + test patch and pass with the real fix;
 *     PASS_TO_PASS = tests of the touched test files that pass in both states;
 *   - each state runs twice: a test whose outcome changes between two runs of the same code is
 *     flaky and left out of both lists;
 *   - kept only when FAIL_TO_PASS is non-empty (the real fix passes, the unfixed code fails).
 *
 * `validate-fresh.mjs` then checks each task through the grader itself.
 *
 *   node bench/agentic/mine-fresh.mjs --name sqlglot --runner unittest --src sqlglot/ --tests tests/ \
 *        [--since 2026-06-15] [--max 15] [--skip-subject REGEX] [--out fresh-sqlglot-r4]
 *        [--min-src 1] [--max-src 3] [--min-lines 0] [--max-files 8] [--skip-sha SHA,…]
 *
 * --min-src / --max-src bound the source files the fix modifies, --min-lines the source lines it
 * adds and removes, --max-files the files of the whole commit: harder sets ask for fixes that span
 * several files (`--min-src 2 --max-src 6 --min-lines 40 --max-files 12`). --skip-sha leaves out
commits rejected on review (prefixes are enough).
 *
 * Writes bench/agentic/tasks/<out>.json (default fresh-<name>.json) plus test-id lists under
 * tasks/fresh/. Commits already used by another task file are skipped, so a new set is held out. Problem
 * statements start as the commit message and are rewritten separately (statements.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, git, tryGit, sh, writeJson, readJson, HERE, WORK } from './lib.mjs';
import { runTests } from './pytests.mjs';
import { REPOS } from './repos.mjs';

const { opt } = argv();
const name = opt('--name');
const repo = path.resolve(opt('--repo', REPOS[name]?.source ?? path.join(WORK, 'repos', name)));
const runner = opt('--runner', REPOS[name]?.runner ?? 'pytest');
const srcPrefix = opt('--src', REPOS[name]?.srcPrefix ?? '');
const testRe = new RegExp(opt('--tests-re', REPOS[name]?.testRe ?? '(^|/)tests?/'));
const since = opt('--since', '2026-06-15');
const max = Number(opt('--max', 15));
const minSrc = Number(opt('--min-src', 1)), maxSrc = Number(opt('--max-src', 3));
const minLines = Number(opt('--min-lines', 0)), maxFiles = Number(opt('--max-files', 8));
const skipSubject = new RegExp(opt('--skip-subject', '^(Merge|Revert|Sync|Update CHANGELOG|Cleanup|chore|docs?|ci|build|style|test|tests|bump|release)\\b'), 'i');
const skipSha = opt('--skip-sha', '').split(',').filter(Boolean);
const out = path.join(HERE, 'tasks', `${opt('--out', `fresh-${name}`)}.json`);
// commits that already back a task in another file (earlier rounds) stay out of a new set
const usedElsewhere = new Set(fs.readdirSync(path.join(HERE, 'tasks')).filter(f => /^fresh-.*\.json$/.test(f) && path.join(HERE, 'tasks', f) !== out)
    .flatMap(f => readJson(path.join(HERE, 'tasks', f), []).map(t => t.meta?.sha)).filter(Boolean));
const idsDir = path.join(HERE, 'tasks', 'fresh');

const log = (...a) => console.error(...a);

function candidates() {
    const lines = git(repo, 'log', '--no-merges', `--since=${since}`, '--format=%H%x1f%P%x1f%ad%x1f%s', '--date=short').trim().split('\n').filter(Boolean);
    const out = [];
    for (const l of lines) {
        const [sha, parents, date, subject] = l.split('\x1f');
        if (!parents || parents.includes(' ') || skipSubject.test(subject)) continue;
        const files = git(repo, 'diff', '--name-status', '--no-renames', parents, sha).trim().split('\n').filter(Boolean).map(x => x.split('\t'));
        if (files.length > maxFiles) continue;
        const src = files.filter(([st, p]) => st === 'M' && p.endsWith('.py') && p.startsWith(srcPrefix) && !testRe.test(p)).map(x => x[1]);
        const testFiles = files.filter(([st, p]) => (st === 'M' || st === 'A') && testRe.test(p)).map(x => x[1]);
        const readers = Object.entries(REPOS[name]?.fixtureTests ?? {}).filter(([re]) => testFiles.some(p => new RegExp(re).test(p))).map(([, t]) => t);
        const tests = [...new Set([...testFiles.filter(p => p.endsWith('.py')), ...readers])];
        const other = files.filter(([, p]) => !src.includes(p) && !testFiles.includes(p));
        if (src.length < minSrc || src.length > maxSrc || !tests.length) continue;
        if (other.some(([, p]) => p.endsWith('.py'))) continue; // other Python changes (helpers, fixtures) would leak or break
        if (minLines) {
            const changed = git(repo, 'diff', '--numstat', parents, sha, '--', ...src).trim().split('\n').reduce((n, l) => n + (Number(l.split('\t')[0]) || 0) + (Number(l.split('\t')[1]) || 0), 0);
            if (changed < minLines) continue;
        }
        out.push({ sha, parent: parents, date, subject, src, tests, testFiles });
    }
    return out;
}

/** Function / method names whose bodies the fix touched (from diff hunk headers and added defs). */
function touchedFunctions(parent, sha, files) {
    const names = new Set();
    const diff = git(repo, 'diff', '-U0', '--no-color', parent, sha, '--', ...files);
    for (const m of diff.matchAll(/^@@[^@]*@@\s*(?:async\s+)?(?:def|class)\s+(\w+)/gm)) names.add(m[1]);
    for (const m of diff.matchAll(/^[+-]\s*(?:async\s+)?def\s+(\w+)/gm)) names.add(m[1]);
    return [...names];
}

const wt = path.join(WORK, 'mine', name);
if (!fs.existsSync(path.join(wt, '.git'))) {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    tryGit(repo, 'worktree', 'prune');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
}
const reset = (rev) => { git(wt, 'checkout', '-q', '-f', '--detach', rev); git(wt, 'clean', '-fdqx', '-e', '.graph-indexer'); };
const apply = (patch) => {
    const f = path.join(WORK, 'mine', `${name}.patch`);
    fs.writeFileSync(f, patch);
    const r = sh(`git apply --whitespace=nowarn ${JSON.stringify(f)}`, { cwd: wt });
    return r.code === 0;
};

const TOO_SLOW = 180_000;

/** Run the tests twice: an outcome that differs between the runs becomes 'flaky'. */
function runTwice(tests) {
    const a = runTests(wt, runner, tests, { timeoutSec: 300 });
    // too slow to grade: no second run (the candidate is skipped)
    if (a.ms > TOO_SLOW) return { outcomes: a.outcomes, flaky: [], ms: a.ms };
    const b = runTests(wt, runner, tests, { timeoutSec: 300 });
    const outcomes = new Map(), flaky = [];
    for (const id of new Set([...a.outcomes.keys(), ...b.outcomes.keys()])) {
        const x = a.outcomes.get(id), y = b.outcomes.get(id);
        if (x === y) outcomes.set(id, x); else { outcomes.set(id, 'flaky'); flaky.push(id); }
    }
    return { outcomes, flaky, ms: Math.max(a.ms, b.ms) };
}

const existing = readJson(out, []);
const tasks = [...existing];
const done = new Set(existing.map(t => t.meta?.sha));
fs.mkdirSync(idsDir, { recursive: true });
const cands = candidates();
log(`${name}: ${cands.length} candidate commits since ${since}`);
for (const c of cands) {
    if (tasks.length >= max) break;
    if (done.has(c.sha) || usedElsewhere.has(c.sha) || skipSha.some(s => c.sha.startsWith(s))) continue;
    const t0 = Date.now();
    reset(c.parent);
    const testPatch = git(repo, 'diff', '--no-color', '--binary', c.parent, c.sha, '--', ...c.testFiles);
    const srcPatch = git(repo, 'diff', '--no-color', c.parent, c.sha, '--', ...c.src);
    if (!apply(testPatch)) { log(`  ${c.sha.slice(0, 8)} skip: test patch does not apply`); continue; }
    const before = runTwice(c.tests);
    if (before.ms > TOO_SLOW) { log(`  ${c.sha.slice(0, 8)} skip: tests take ${(before.ms / 1000).toFixed(0)}s (${c.subject.slice(0, 60)})`); continue; }
    if (!apply(srcPatch)) { log(`  ${c.sha.slice(0, 8)} skip: source patch does not apply`); continue; }
    const after = runTwice(c.tests);
    const f2p = [...after.outcomes].filter(([id, s]) => s === 'pass' && before.outcomes.get(id) === 'fail').map(([id]) => id);
    const p2p = [...after.outcomes].filter(([id, s]) => s === 'pass' && before.outcomes.get(id) === 'pass').map(([id]) => id);
    const flaky = [...new Set([...before.flaky, ...after.flaky])];
    // an import error before the fix hides individual tests: count them as failing-before
    const importBroken = [...before.outcomes.keys()].some(k => k.endsWith('::<import>'));
    const f2pAll = importBroken ? [...after.outcomes].filter(([id, s]) => s === 'pass' && !before.outcomes.has(id)).map(([id]) => id).concat(f2p) : f2p;
    if (flaky.length) log(`  ${c.sha.slice(0, 8)} ${flaky.length} flaky test(s) left out: ${flaky.slice(0, 3).join(' ')}`);
    const secs = (Date.now() - t0) / 1000;
    if (!f2pAll.length || f2pAll.length > 40 || after.ms > TOO_SLOW) { log(`  ${c.sha.slice(0, 8)} skip: f2p=${f2pAll.length} after=${(after.ms / 1000).toFixed(0)}s (${c.subject.slice(0, 60)})`); continue; }
    const id = `fresh-${name}-${c.sha.slice(0, 8)}`;
    const f2pFile = path.join(idsDir, `${id}.f2p.json`), p2pFile = path.join(idsDir, `${id}.p2p.json`);
    writeJson(f2pFile, [...new Set(f2pAll)].sort());
    writeJson(p2pFile, p2p.sort());
    const body = git(repo, 'log', '-1', '--format=%b', c.sha).trim();
    tasks.push({
        id, family: 'edit', kind: 'fresh', repo: name, base: c.parent,
        statement: `${c.subject}${body ? `\n\n${body}` : ''}`,
        needsStatement: true,
        testHint: REPOS[name]?.testHint ?? null,
        grade: {
            testPatch,
            checks: [
                { name: 'FAIL_TO_PASS', cmd: `node {GI}/bench/agentic/pytests.mjs --runner ${runner} --expect-pass {GI}/bench/agentic/tasks/fresh/${id}.f2p.json`, timeoutSec: 900 },
                { name: 'PASS_TO_PASS', cmd: `node {GI}/bench/agentic/pytests.mjs --runner ${runner} --expect-pass {GI}/bench/agentic/tasks/fresh/${id}.p2p.json`, timeoutSec: 900 },
            ],
        },
        gold: { files: c.src, functions: touchedFunctions(c.parent, c.sha, c.src), patch: srcPatch },
        meta: { sha: c.sha, date: c.date, subject: c.subject, tests: c.tests, testFiles: c.testFiles, f2p: f2pAll.length, p2p: p2p.length, flaky: flaky.length, testSeconds: Math.round(after.ms / 1000) },
    });
    writeJson(out, tasks);
    log(`  ${c.sha.slice(0, 8)} OK f2p=${f2pAll.length} p2p=${p2p.length} (${secs.toFixed(0)}s) ${c.subject.slice(0, 70)}`);
}
reset('HEAD');
log(`${tasks.length} tasks → ${path.relative(process.cwd(), out)}`);
