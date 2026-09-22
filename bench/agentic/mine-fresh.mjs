#!/usr/bin/env node
/**
 * Mine "fresh" change tasks from a repository's recent history (after the models' training
 * cutoff), SWE-bench style, and validate each one by running its tests:
 *
 *   - a focused commit: 1–3 modified source files plus test changes, at most 8 files in total;
 *   - base = the commit's parent; the hidden test patch = the commit's test changes;
 *   - FAIL_TO_PASS = tests that fail at base + test patch and pass with the real fix;
 *     PASS_TO_PASS = tests of the touched test files that pass in both states;
 *   - kept only when FAIL_TO_PASS is non-empty (the real fix passes, the unfixed code fails).
 *
 *   node bench/agentic/mine-fresh.mjs --name sqlglot --runner unittest --src sqlglot/ --tests tests/ \
 *        [--since 2026-06-15] [--max 15] [--skip-subject REGEX]
 *
 * Writes bench/agentic/tasks/fresh-<name>.json plus test-id lists under tasks/fresh/. Problem
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
const skipSubject = new RegExp(opt('--skip-subject', '^(Merge|Revert|Sync|Update CHANGELOG|Cleanup|chore|docs?|ci|build|style|test|tests|bump|release)\\b'), 'i');
const out = path.join(HERE, 'tasks', `fresh-${name}.json`);
const idsDir = path.join(HERE, 'tasks', 'fresh');

const log = (...a) => console.error(...a);

function candidates() {
    const lines = git(repo, 'log', '--no-merges', `--since=${since}`, '--format=%H%x1f%P%x1f%ad%x1f%s', '--date=short').trim().split('\n').filter(Boolean);
    const out = [];
    for (const l of lines) {
        const [sha, parents, date, subject] = l.split('\x1f');
        if (!parents || parents.includes(' ') || skipSubject.test(subject)) continue;
        const files = git(repo, 'diff', '--name-status', '--no-renames', parents, sha).trim().split('\n').filter(Boolean).map(x => x.split('\t'));
        if (files.length > 8) continue;
        const src = files.filter(([st, p]) => st === 'M' && p.endsWith('.py') && p.startsWith(srcPrefix) && !testRe.test(p)).map(x => x[1]);
        const tests = files.filter(([st, p]) => (st === 'M' || st === 'A') && p.endsWith('.py') && testRe.test(p)).map(x => x[1]);
        const other = files.filter(([, p]) => !src.includes(p) && !tests.includes(p));
        if (src.length < 1 || src.length > 3 || !tests.length) continue;
        if (other.some(([, p]) => p.endsWith('.py'))) continue; // other Python changes (helpers, fixtures) would leak or break
        out.push({ sha, parent: parents, date, subject, src, tests });
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

const existing = readJson(out, []);
const tasks = [...existing];
const done = new Set(existing.map(t => t.meta?.sha));
fs.mkdirSync(idsDir, { recursive: true });
const cands = candidates();
log(`${name}: ${cands.length} candidate commits since ${since}`);
for (const c of cands) {
    if (tasks.length >= max) break;
    if (done.has(c.sha)) continue;
    const t0 = Date.now();
    reset(c.parent);
    const testPatch = git(repo, 'diff', '--no-color', '--binary', c.parent, c.sha, '--', ...c.tests);
    const srcPatch = git(repo, 'diff', '--no-color', c.parent, c.sha, '--', ...c.src);
    if (!apply(testPatch)) { log(`  ${c.sha.slice(0, 8)} skip: test patch does not apply`); continue; }
    const before = runTests(wt, runner, c.tests, { timeoutSec: 300 });
    if (!apply(srcPatch)) { log(`  ${c.sha.slice(0, 8)} skip: source patch does not apply`); continue; }
    const after = runTests(wt, runner, c.tests, { timeoutSec: 300 });
    const f2p = [...after.outcomes].filter(([id, s]) => s === 'pass' && before.outcomes.get(id) !== 'pass' && before.outcomes.get(id) !== 'skip').map(([id]) => id);
    const p2p = [...after.outcomes].filter(([id, s]) => s === 'pass' && before.outcomes.get(id) === 'pass').map(([id]) => id);
    // an import error before the fix hides individual tests: count them as failing-before
    const importBroken = [...before.outcomes.keys()].some(k => k.endsWith('::<import>'));
    const f2pAll = importBroken ? [...after.outcomes].filter(([id, s]) => s === 'pass' && !before.outcomes.has(id)).map(([id]) => id).concat(f2p) : f2p;
    const secs = (Date.now() - t0) / 1000;
    if (!f2pAll.length || f2pAll.length > 40 || after.ms > 180_000) { log(`  ${c.sha.slice(0, 8)} skip: f2p=${f2pAll.length} after=${(after.ms / 1000).toFixed(0)}s (${c.subject.slice(0, 60)})`); continue; }
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
        meta: { sha: c.sha, date: c.date, subject: c.subject, tests: c.tests, f2p: f2pAll.length, p2p: p2p.length, testSeconds: Math.round(after.ms / 1000) },
    });
    writeJson(out, tasks);
    log(`  ${c.sha.slice(0, 8)} OK f2p=${f2pAll.length} p2p=${p2p.length} (${secs.toFixed(0)}s) ${c.subject.slice(0, 70)}`);
}
reset('HEAD');
log(`${tasks.length} tasks → ${path.relative(process.cwd(), out)}`);
