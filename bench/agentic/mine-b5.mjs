#!/usr/bin/env node
/**
 * Mine B5 "silent errors" tasks: real commits whose plausible partial fix — the change to a
 * definition without the updates its existing users needed elsewhere — breaks tests. The criterion
 * was fixed before mining (docs/PLAN-IDE-AGENTE.md §4, "Criterio de B5"); no rule uses graph-indexer:
 *
 *   1. fresh and focused: after --since, no merges, mine-fresh's subject filter, 2–8 modified source
 *      files, at most 16 files in all, with test changes;
 *   2. ripple: a name N (function, method, class) defined at the base in a source file A whose
 *      definition line the commit changes or removes, and another source file B that already used N
 *      at the base and in which the commit changes a line containing N;
 *   3. the partial fix breaks something: with the commit's tests applied, the commit limited to the
 *      A files fails tests R that the full commit passes (whole test suite, or with `--scope package`
 *      the test files of A's and B's packages), confirmed by a second run of each side; no test of R
 *      is an import error (that one is loud: any test run shows it);
 *   4. validated as fresh tasks are: FAIL_TO_PASS non-empty, flaky tests left out, and the commit's
 *      tests take at most 180 s of CPU time (user + sys, not the wall clock: the verdict must not
 *      depend on the machine's load).
 *
 * Tests run sandboxed (lib.mjs `sandboxed`), as many at once as the idle cores allow.
 *
 * Every candidate that passes rules 1–2 is logged with the rule that dropped it (WORK/mine/b5-<name>.log.json).
 *
 *   node bench/agentic/mine-b5.mjs --name sqlglot [--since 2026-06-15] [--max 30] [--scope all|package] [--jobs 6]
 *   node bench/agentic/mine-b5.mjs --name X --repo DIR --src PREFIX --tests-re RE --count   (rules 1–2 only, no tests run)
 *
 * Writes bench/agentic/tasks/b5-<name>.json (kind "fresh", bench "b5"): the grade's FAIL_TO_PASS and
 * PASS_TO_PASS checks decide "solved", as in B3; RIPPLE (R, kind info) counts the silent errors left.
 * Statements start as the commit message; statements.mjs puts in the reviewed ones, which name
 * neither A's nor B's code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, git, tryGit, sh, writeJson, readJson, HERE, WORK } from './lib.mjs';
import { runTests, runFiles } from './pytests.mjs';
import { REPOS } from './repos.mjs';

const { opt, flag } = argv();
const name = opt('--name');
const R = REPOS[name];
// a repository with its own virtualenv: the miner's runs, and later the task's checks, use it
// (and its `env`, such as a telemetry switch)
const repoEnv = { ...(R?.python ? { GI_PYTHON: R.python, GI_PYTEST: `${R.python} -m pytest` } : {}), ...(R?.env ?? {}) };
Object.assign(process.env, repoEnv);
const pyEnv = Object.keys(repoEnv).length ? { env: repoEnv } : {};
const repo = path.resolve(opt('--repo', R?.source ?? path.join(WORK, 'repos', name)));
const runner = opt('--runner', R?.runner ?? 'pytest');
const srcPrefix = opt('--src', R?.srcPrefix ?? '');
const testRe = new RegExp(opt('--tests-re', R?.testRe ?? '(^|/)tests?/'));
const since = opt('--since', '2026-06-15');
const max = Number(opt('--max', 30));
const scope = opt('--scope', 'all');
const jobs = Number(opt('--jobs', 6));
const skipSubject = /^(\[?Backport|Merge|Revert|Sync|Update CHANGELOG|Cleanup|chore|docs?|ci|build|style|test|tests|bump|release)\b/i;
const out = path.join(HERE, 'tasks', `b5-${name}.json`);
const logFile = path.join(WORK, 'mine', `b5-${name}.log.json`);
const idsDir = path.join(HERE, 'tasks', 'fresh');
const used = new Set(fs.readdirSync(path.join(HERE, 'tasks')).filter(f => /^fresh-.*\.json$/.test(f))
    .flatMap(f => readJson(path.join(HERE, 'tasks', f), []).map(t => t.meta?.sha)).filter(Boolean));
const log = (...a) => console.error(...a);
// the test modules (a repository can name them its own way: REPOS[repo].testFileRe)
const testFileRe = new RegExp(R?.testFileRe ?? '(^|/)(test_[^/]*|[^/]*_test)\\.py$');
const isTestFile = (f) => testRe.test(f) && testFileRe.test(f);

/** Rules 1 and 2 from git alone: the commits, with their A → B ripples. */
function candidates() {
    const lines = git(repo, 'log', '--no-merges', `--since=${since}`, '--format=%H%x1f%P%x1f%ad%x1f%s', '--date=short').trim().split('\n').filter(Boolean);
    const res = [];
    for (const l of lines) {
        const [sha, parent, date, subject] = l.split('\x1f');
        if (!parent || parent.includes(' ') || skipSubject.test(subject)) continue;
        const files = git(repo, 'diff', '--name-status', '--no-renames', parent, sha).trim().split('\n').filter(Boolean).map(x => x.split('\t'));
        const src = files.filter(([st, p]) => st === 'M' && p.endsWith('.py') && p.startsWith(srcPrefix) && !testRe.test(p)).map(x => x[1]);
        const testFiles = files.filter(([st, p]) => (st === 'M' || st === 'A') && testRe.test(p)).map(x => x[1]);
        if (src.length < 2 || src.length > 8 || files.length > 16 || !testFiles.length) continue;
        // other Python changes (new modules, helpers outside the test tree) would leak or break
        if (files.some(([, p]) => p.endsWith('.py') && !src.includes(p) && !testFiles.includes(p))) continue;
        const diffs = Object.fromEntries(src.map(f => [f, git(repo, 'diff', '-U0', '--no-color', parent, sha, '--', f)]));
        const ripples = [];
        for (const a of src) {
            const names = new Set([...diffs[a].matchAll(/^-\s*(?:async\s+)?(?:def|class)\s+(\w+)/gm)].map(m => m[1]));
            for (const N of names) {
                if (/^__\w+__$/.test(N)) continue; // dunder methods: every class has them
                const re = new RegExp(`\\b${N}\\b`);
                for (const b of src) {
                    if (b === a) continue;
                    if (!diffs[b].split('\n').some(x => /^[-+](?![-+])/.test(x) && re.test(x))) continue;
                    if (re.test(git(repo, 'show', `${parent}:${b}`))) ripples.push({ name: N, a, b });
                }
            }
        }
        if (!ripples.length) continue;
        // data files (a fixture, pylint's functional cases) run through the test module that reads them
        const fixtureRes = Object.keys(R?.fixtureTests ?? {}).map(re => new RegExp(re));
        const isData = (p) => fixtureRes.some(re => re.test(p));
        const readers = Object.entries(R?.fixtureTests ?? {}).filter(([re]) => testFiles.some(p => new RegExp(re).test(p))).map(([, t]) => t);
        const tests = [...new Set([...testFiles.filter(p => p.endsWith('.py') && !isData(p)), ...readers])];
        res.push({ sha, parent, date, subject, src, testFiles, tests, ripples });
    }
    return res;
}

// --count: only rules 1–2, from git alone (no test runs, nothing written): to size up a repository
if (flag('--count')) {
    const cands = candidates();
    console.log(`${name}: ${cands.length} commits pass rules 1–2 since ${since}`);
    for (const c of cands) console.log(`  ${c.sha.slice(0, 8)}  ${c.src.length} files, ${c.ripples.length} ripples  ${c.subject.slice(0, 80)}`);
    process.exit(0);
}

const wt = path.join(WORK, 'mine', name);
if (!fs.existsSync(path.join(wt, '.git'))) {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    tryGit(repo, 'worktree', 'prune');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
}
const reset = (rev) => { git(wt, 'checkout', '-q', '-f', '--detach', rev); git(wt, 'clean', '-fdqx', '-e', '.graph-indexer'); };
const apply = (patch) => {
    if (!patch.trim()) return true;
    const f = path.join(WORK, 'mine', `b5-${name}.patch`);
    fs.writeFileSync(f, patch);
    const r = sh(`git apply --whitespace=nowarn ${JSON.stringify(f)}`, { cwd: wt });
    fs.rmSync(f, { force: true });
    return r.code === 0;
};
// "too slow" is judged on CPU time, which does not depend on what else loads the machine
const TOO_SLOW = 180_000;
const cost = (r) => r.cpuMs ?? r.ms;
function runTwice(tests) {
    const a = runTests(wt, runner, tests, { timeoutSec: 600 });
    if (cost(a) > TOO_SLOW) return { outcomes: a.outcomes, flaky: [], ms: cost(a) };
    const b = runTests(wt, runner, tests, { timeoutSec: 600 });
    const outcomes = new Map(), flaky = [];
    for (const id of new Set([...a.outcomes.keys(), ...b.outcomes.keys()])) {
        const x = a.outcomes.get(id), y = b.outcomes.get(id);
        if (x === y) outcomes.set(id, x); else { outcomes.set(id, 'flaky'); flaky.push(id); }
    }
    return { outcomes, flaky, ms: Math.max(cost(a), cost(b)) };
}
const loud = (id) => /::<(import|run)>$/.test(id) || id.startsWith('::');
const broke = (full, part) => Object.keys(full).filter(id => full[id] === 'pass' && part[id] !== 'pass');
/** The suite rule 3 runs: every test file, or (scope package) those of the packages of A and B. */
function suiteFiles(c) {
    const all = git(wt, 'ls-files').split('\n').filter(isTestFile);
    if (scope === 'all') return all;
    const pkgs = [...new Set(c.src.map(f => f.split('/').slice(0, 2).join('/') + '/'))];
    return all.filter(f => pkgs.some(p => f.startsWith(p)));
}

const tasks = readJson(out, []);
const done = new Set(tasks.map(t => t.meta?.sha));
const verdicts = readJson(logFile, []);
const judged = new Set(verdicts.map(v => v.sha));
fs.mkdirSync(idsDir, { recursive: true });
const cands = candidates();
log(`${name}: ${cands.length} commits pass rules 1–2 since ${since}`);
const verdict = (c, rule, detail) => {
    verdicts.push({ sha: c.sha, subject: c.subject, ripples: c.ripples.map(r => `${r.name}: ${r.a} → ${r.b}`), rule, ...detail });
    writeJson(logFile, verdicts);
    log(`  ${c.sha.slice(0, 8)} ${rule}  ${c.subject.slice(0, 70)}`);
};
for (const c of cands) {
    if (tasks.length >= max) break;
    if (done.has(c.sha) || judged.has(c.sha)) continue;
    if (used.has(c.sha)) { verdict(c, 'skip: already a B3 task'); continue; }
    const t0 = Date.now();
    const A = [...new Set(c.ripples.map(r => r.a))];
    const B = [...new Set(c.ripples.map(r => r.b))].filter(f => !A.includes(f));
    if (!B.length) { verdict(c, 'rule 2: every user of a changed name is itself a defining file'); continue; }
    reset(c.parent);
    const testPatch = git(repo, 'diff', '--no-color', '--binary', c.parent, c.sha, '--', ...c.testFiles);
    const srcPatch = git(repo, 'diff', '--no-color', c.parent, c.sha, '--', ...c.src);
    const partialPatch = git(repo, 'diff', '--no-color', c.parent, c.sha, '--', ...A);
    if (!apply(testPatch)) { verdict(c, 'rule 4: test patch does not apply'); continue; }
    // rule 4 first (cheap): the commit's own tests, before and after the full fix
    const before = runTwice(c.tests);
    if (before.ms > TOO_SLOW) { verdict(c, 'rule 4: tests too slow'); continue; }
    if (!apply(srcPatch)) { verdict(c, 'rule 4: source patch does not apply'); continue; }
    const after = runTwice(c.tests);
    const f2p = [...after.outcomes].filter(([id, s]) => s === 'pass' && before.outcomes.get(id) === 'fail').map(([id]) => id);
    const importBroken = [...before.outcomes.keys()].some(k => k.endsWith('::<import>'));
    const f2pAll = [...new Set(importBroken ? [...after.outcomes].filter(([id, s]) => s === 'pass' && !before.outcomes.has(id)).map(([id]) => id).concat(f2p) : f2p)].sort();
    const p2p = [...after.outcomes].filter(([id, s]) => s === 'pass' && before.outcomes.get(id) === 'pass').map(([id]) => id).sort();
    const flaky = [...new Set([...before.flaky, ...after.flaky])];
    if (!f2pAll.length || f2pAll.length > 40) { verdict(c, `rule 4: FAIL_TO_PASS ${f2pAll.length}`); continue; }
    // rule 3: the suite with the full fix, then with the partial one
    const files = suiteFiles(c);
    const full = await runFiles(wt, runner, files, { jobs });
    reset(c.parent);
    apply(testPatch);
    if (!apply(partialPatch)) { verdict(c, 'rule 3: partial patch does not apply'); continue; }
    const part = await runFiles(wt, runner, files, { jobs });
    let ripple = broke(full, part);
    if (ripple.length) {
        // confirm on a second run of the files involved
        const again = [...new Set(ripple.map(id => id.split('::')[0]))];
        const part2 = await runFiles(wt, runner, again, { jobs });
        reset(c.parent); apply(testPatch); apply(srcPatch);
        const full2 = await runFiles(wt, runner, again, { jobs });
        const twice = new Set(broke(full2, part2));
        ripple = ripple.filter(id => twice.has(id) && !flaky.includes(id)).sort();
    }
    const detail = { A, B, suite: files.length, ripple: ripple.length, loud: ripple.filter(loud).length, secs: Math.round((Date.now() - t0) / 1000) };
    if (!ripple.length) { verdict(c, 'rule 3: the partial fix breaks no test', detail); continue; }
    if (ripple.some(loud)) { verdict(c, 'rule 3: the partial fix breaks an import', { ...detail, loudIds: ripple.filter(loud).slice(0, 5) }); continue; }
    const id = `b5-${name}-${c.sha.slice(0, 8)}`;
    writeJson(path.join(idsDir, `${id}.f2p.json`), f2pAll);
    writeJson(path.join(idsDir, `${id}.p2p.json`), p2p);
    writeJson(path.join(idsDir, `${id}.ripple.json`), ripple);
    const body = git(repo, 'log', '-1', '--format=%b', c.sha).trim();
    const check = (n, k, extra = {}) => ({ name: n, cmd: `node {GI}/bench/agentic/pytests.mjs --runner ${runner} --expect-pass {GI}/bench/agentic/tasks/fresh/${id}.${k}.json`, timeoutSec: 900, ...pyEnv, ...extra });
    tasks.push({
        id, family: 'edit', kind: 'fresh', bench: 'b5', repo: name, base: c.parent,
        statement: `${c.subject}${body ? `\n\n${body}` : ''}`,
        needsStatement: true,
        testHint: R?.testHint ?? null,
        grade: { testPatch, checks: [check('FAIL_TO_PASS', 'f2p'), check('PASS_TO_PASS', 'p2p'), check('RIPPLE', 'ripple', { kind: 'info' })] },
        gold: { files: c.src, patch: srcPatch, partial: A, ripple: B },
        meta: { sha: c.sha, date: c.date, subject: c.subject, tests: c.tests, testFiles: c.testFiles, ripples: c.ripples, f2p: f2pAll.length, p2p: p2p.length, ripple: ripple.length, flaky: flaky.length, suite: files.length },
    });
    writeJson(out, tasks);
    verdict(c, 'kept', { ...detail, id, f2p: f2pAll.length, p2p: p2p.length });
}
reset('HEAD');
log(`${tasks.length} tasks → ${path.relative(process.cwd(), out)} · verdicts → ${logFile}`);
