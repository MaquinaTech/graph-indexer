#!/usr/bin/env node
/**
 * The real-session round in one command: Claude Code as shipped (`cc`), with graph-indexer as
 * `init --no-helper` installs it (`cc+gi`) and as `init` installs it (`cc+gi+helper`), on 12 new
 * questions (qa-nestjs-r6) and 8 refactors (2 new, refactor-nestjs-r5, and the 6 held-out ones of
 * round 2, refactor-nestjs-held). It measures what sub-agents
 * cannot: whether a main agent hands structural questions to the helper on its own, and what that
 * does to the cost of the whole session (every model), its time, its results and the main agent's
 * context.
 *
 *   node bench/agentic/session-round.mjs [--label rt1] [--model M] [--concurrency 3] [--max-budget 5] [--pilot]
 *        [--arms cc,cc+gi,cc+gi+helper] [--tasks qa-nestjs-r6.json,refactor-nestjs-r5.json,refactor-nestjs-held.json]
 *        [--claude-bin claude] [--reps 1]
 *
 * Steps: check what it needs (the claude CLI, the nestjs fixture, TypeScript for grading) →
 * freeze this graph-indexer → prepare the runs → one one-turn session per arm to check its setup →
 * run → grade → report (dollars, since the helper runs on a smaller model). --pilot runs one
 * question and one refactor per arm first. It is safe to re-run: runs already launched are not
 * launched again and graded runs are not graded again.
 *
 * It needs an authenticated `claude` CLI (a login, or ANTHROPIC_API_KEY): the runs are billed to
 * that account. The report goes to WORK/reports/<label>.md; results to WORK/results/<label>.jsonl.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { argv, WORK, GI_ROOT, HERE, readJson } from './lib.mjs';

const { opt, list, flag } = argv();
const label = opt('--label', 'rt1');
const model = opt('--model', null);
const concurrency = opt('--concurrency', '3');
const claude = opt('--claude-bin', 'claude');
const arms = list('--arms', ['cc', 'cc+gi', 'cc+gi+helper']);
// 12 new questions, 2 new refactors, and the 6 held-out refactors of round 2 (there are few new targets left)
const taskFiles = list('--tasks', ['qa-nestjs-r6.json', 'refactor-nestjs-r5.json', 'refactor-nestjs-held.json']);
const pilot = flag('--pilot');
// dollars one session may spend at most (a run that reaches it stops, unsolved; runs cost far less)
const maxBudget = opt('--max-budget', '5');
// runs per task and arm (issues vary more from run to run than questions)
const reps = Number(opt('--reps', '1'));
const repIds = Array.from({ length: reps }, (_, i) => `r${i + 1}`);

const node = process.execPath;
const step = (title) => console.error(`\n── ${title}`);
function run(args, { allowFail = false } = {}) {
    const r = spawnSync(node, args, { cwd: GI_ROOT, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', env: process.env, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0 && !allowFail) { process.stdout.write(r.stdout ?? ''); throw new Error(`failed: node ${args.join(' ')}`); }
    return r;
}

// ── what it needs ──────────────────────────────────────────────────────────────
step('checking what the round needs');
const version = spawnSync(claude, ['--version'], { encoding: 'utf8' });
if (version.status !== 0) throw new Error(`the claude CLI is not available as "${claude}" (install Claude Code, or pass --claude-bin PATH)`);
console.error(`claude ${version.stdout.trim()}`);
if (!fs.existsSync(path.join(GI_ROOT, 'test/fixtures/nestjs/.git'))) throw new Error('the nestjs fixture is missing: node bench/fixtures.mjs --only nestjs');
if (!process.env.TYPESCRIPT_PATH || !fs.existsSync(process.env.TYPESCRIPT_PATH)) {
    // refactors are graded by the TypeScript compiler (tsdiag.mjs, tsstruct.mjs)
    const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout?.trim();
    const found = ['/opt/node22/lib/node_modules/typescript', globalRoot && path.join(globalRoot, 'typescript')].find(p => p && fs.existsSync(path.join(p, 'package.json')));
    if (!found) throw new Error('TypeScript is needed to grade the refactors: npm install -g typescript (or set TYPESCRIPT_PATH)');
    process.env.TYPESCRIPT_PATH = found;
}
console.error(`TypeScript at ${process.env.TYPESCRIPT_PATH}`);

// ── prepare ────────────────────────────────────────────────────────────────────
step(`freezing this graph-indexer as "${label}"`);
run([path.join(HERE, 'prepare.mjs'), 'snapshot', '--label', label]);
const runsDir = path.join(WORK, 'runs', label);
const tasks = taskFiles.flatMap(f => readJson(path.join(HERE, 'tasks', f), []));
const chosen = pilot ? [tasks.find(t => t.family === 'qa'), tasks.find(t => t.family !== 'qa')].filter(Boolean) : tasks;
// runs already prepared are left as they are (their checkout may hold a finished run's changes)
const toPrepare = chosen.flatMap(t => arms.flatMap(a => repIds.map((r, i) => ({ t, a, rep: i + 1 }))))
    .filter(({ t, a, rep }) => !fs.existsSync(path.join(runsDir, `${t.id}__${a}__r${rep}`, 'meta.json')));
step(`preparing ${chosen.length} task(s) × ${arms.length} arm(s) × ${reps} run(s) (${toPrepare.length} run(s) not prepared yet)`);
for (const { t, a, rep } of toPrepare) run([path.join(HERE, 'prepare.mjs'), 'run', '--task', t.id, '--arm', a, '--rep', String(rep), '--gi', label]);
const runIds = chosen.flatMap(t => arms.flatMap(a => repIds.map(r => `${t.id}__${a}__${r}`)));

// ── check each arm's session, then run ────────────────────────────────────────
const headless = [path.join(HERE, 'run-headless.mjs'), '--gi', label, '--claude-bin', claude, '--max-budget', maxBudget, ...(model ? ['--model', model] : [])];
step('one one-turn session per arm, to check its setup');
const pre = run([...headless, '--runs', runIds.join(','), '--preflight'], { allowFail: true });
process.stdout.write(pre.stdout);
if (pre.status !== 0) throw new Error('an arm is not set up as it should be (above): nothing else was run');
step(`running ${runIds.length} session(s), ${concurrency} at a time`);
const r = run([...headless, '--runs', runIds.join(','), '--concurrency', concurrency], { allowFail: true });
process.stdout.write(r.stdout);

// ── grade and report ───────────────────────────────────────────────────────────
step('grading');
const transcripts = path.join(WORK, 'transcripts', label);
const g = run([path.join(HERE, 'grade-batch.mjs'), '--gi', label, '--agents', 'all', '--transcripts', transcripts, '--min-idle', '0'], { allowFail: true });
process.stdout.write(g.stdout);
step('report');
fs.mkdirSync(path.join(WORK, 'reports'), { recursive: true });
const md = path.join(WORK, 'reports', `${label}.md`);
const rep = run([path.join(HERE, 'report.mjs'), '--gi', label, '--baseline', arms[0], '--integrated', arms[arms.length - 1], '--cost', 'usd', '--md', md], { allowFail: true });
process.stdout.write(rep.stdout);
console.error(`\nreport: ${md}\nresults: ${path.join(WORK, 'results', `${label}.jsonl`)}\ntranscripts: ${transcripts}`);
