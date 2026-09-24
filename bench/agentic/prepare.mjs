#!/usr/bin/env node
/**
 * Prepare benchmark runs.
 *
 *   node bench/agentic/prepare.mjs snapshot [--label L]
 *       copy the current graph-indexer (bin/, src/, vendor/) into the work area, so a benchmark
 *       phase runs one fixed version while development continues
 *   node bench/agentic/prepare.mjs run --task ID --arm ARM [--rep N] --gi LABEL
 *       create the run directory (instructions, graph-indexer wrapper) and the checkout it works
 *       in; prints {runId, runDir, checkout, prompt} as JSON
 *   node bench/agentic/prepare.mjs batch --tasks ID,ID|all|<file.json> --arms A,B --reps N [--first-rep K] --gi LABEL
 *       the same for many runs, one JSON object per line
 *
 * Read-only tasks (family "qa") share one checkout per repository/commit and variant ("plain" for
 * the grep arm, "indexed" for graph-indexer arms, so the grep arm never sees an index). Edit tasks
 * get a fresh worktree per run.
 *
 * Real-session arms (cc, cc+gi, cc+gi+helper) run in their run directory as a project: graph-indexer
 * arms get there the CLAUDE.md block and the helper arm the sub-agent file, as `init` writes them
 * into a repository (run-headless.mjs adds the MCP server).
 *
 * Delegated-question arms (ask-*) get, in their instructions file, the message a main agent sends
 * when it hands a question off (the helper arm's starts with the helper's instructions); they are
 * launched as the sub-agent type the run's meta names (agentType), and their reply is the answer
 * (deliver: "reply"). Every arm reads its file first, so that read costs all of them the same.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { argv, git, sh, readJson, writeJson, loadTasks, runId, WORK, GI_ROOT, HERE } from './lib.mjs';
import { toolSection, ARM_NAMES, usesIndex, VIEW_ARMS, ASK_ARMS, SESSION_ARMS, askMessage } from './arms.mjs';
import { managedBlock } from '../../src/cli/init.mjs';
import { HELPER_NAME, claudeAgentFile } from '../../src/cli/helper.mjs';
import { buildIndexV2, projectFilesV2 } from './v2.mjs';
import { REPOS } from './repos.mjs';

const { opt, list, args } = argv();

export function snapshot(label = null) {
    const sha = git(GI_ROOT, 'rev-parse', '--short', 'HEAD').trim();
    const dirty = git(GI_ROOT, 'status', '--porcelain', '--', 'bin', 'src', 'vendor').trim();
    const hash = dirty ? '-' + crypto.createHash('sha1').update(git(GI_ROOT, 'diff', 'HEAD', '--', 'bin', 'src', 'vendor')).update(dirty).digest('hex').slice(0, 8) : '';
    const pkg = readJson(path.join(GI_ROOT, 'package.json'));
    label ??= `v${pkg.version}-${sha}${hash}`;
    const dst = path.join(WORK, 'gi', label);
    if (!fs.existsSync(path.join(dst, 'bin'))) {
        fs.mkdirSync(dst, { recursive: true });
        for (const d of ['bin', 'src', 'vendor']) fs.cpSync(path.join(GI_ROOT, d), path.join(dst, d), { recursive: true });
        fs.copyFileSync(path.join(GI_ROOT, 'package.json'), path.join(dst, 'package.json'));
        writeJson(path.join(dst, 'SNAPSHOT.json'), { label, sha, dirty: !!dirty, createdAt: new Date().toISOString() });
    }
    return { label, dir: dst };
}

export function giBin(label) {
    const bin = path.join(WORK, 'gi', label, 'bin', 'graph-indexer.mjs');
    if (!fs.existsSync(bin)) throw new Error(`graph-indexer snapshot "${label}" not found — run: node bench/agentic/prepare.mjs snapshot --label ${label}`);
    return bin;
}

/** Capabilities of a snapshot (which optional commands it has), read from its CLI help. */
export function capabilities(label) {
    const help = sh(`node ${JSON.stringify(giBin(label))} --help`).stdout;
    return { grep: /\bgraph-indexer grep\b/.test(help), check: /\bgraph-indexer check\b/.test(help) };
}

function sourceRepo(name) {
    const r = REPOS[name];
    if (!r) throw new Error(`unknown repository "${name}" (bench/agentic/repos.mjs)`);
    const dir = path.resolve(GI_ROOT, r.source);
    if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`repository ${name} not found at ${dir}${r.fetch ? ` — ${r.fetch}` : ''}`);
    return dir;
}

function excludeIndex(src) {
    const common = git(src, 'rev-parse', '--git-common-dir').trim();
    const ex = path.resolve(src, common, 'info', 'exclude');
    const text = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
    if (!/^\.graph-indexer\/$/m.test(text)) { fs.mkdirSync(path.dirname(ex), { recursive: true }); fs.appendFileSync(ex, (text && !text.endsWith('\n') ? '\n' : '') + '.graph-indexer/\n'); }
}

function addWorktree(src, dir, base) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(src, 'worktree', 'prune');
    git(src, 'worktree', 'add', '-q', '--detach', dir, base);
    return dir;
}

function buildIndex(label, dir) {
    const r = sh(`node ${JSON.stringify(giBin(label))} index --repo ${JSON.stringify(dir)}`, { timeout: 1_800_000 });
    if (r.code !== 0) throw new Error(`indexing ${dir} failed: ${r.stderr.slice(-400)}`);
    return r.ms;
}

/** Checkout for a run: shared per repo/commit/variant for read-only tasks, fresh for edit tasks. */
function checkoutFor(task, arm, id, label) {
    const src = sourceRepo(task.repo);
    excludeIndex(src);
    const indexed = usesIndex(arm);
    let dir;
    if (task.family === 'qa') {
        dir = path.join(WORK, 'checkouts', `${task.repo}@${task.base.slice(0, 10)}`, SESSION_ARMS[arm]?.v2 ? 'indexed-v2' : indexed ? `indexed-${label}` : 'plain');
        addWorktree(src, dir, task.base);
    } else {
        dir = path.join(WORK, 'wt', id);
        if (fs.existsSync(dir)) { tryRemoveWorktree(src, dir); }
        // mined tasks come from clones that also hold the fix: export the snapshot alone
        if (task.kind === 'fresh') isolatedCheckout(src, dir, task.base);
        else addWorktree(src, dir, task.base);
        const setup = REPOS[task.repo].setupWorktree;
        if (setup) { const r = sh(setup, { cwd: dir, timeout: 1_800_000 }); if (r.code !== 0) throw new Error(`setup of ${dir} failed: ${r.stderr.slice(-400)}`); }
    }
    const indexMs = !indexed ? null : SESSION_ARMS[arm]?.v2 ? buildIndexV2(dir) : buildIndex(label, dir);
    return { dir, indexMs };
}

/**
 * A standalone repository holding only the base snapshot: one commit, no remote, none of the
 * source clone's later history (a worktree shares the clone's objects, so `git log --all` or
 * `git show <fix>` would reveal the real fix of a mined task).
 */
function isolatedCheckout(src, dir, base) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const index = path.join(WORK, `index-${process.pid}-${Date.now()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
        let r = sh(`git read-tree ${base}`, { cwd: src, env });
        if (r.code === 0) r = sh(`git checkout-index -a -f --prefix=${JSON.stringify(dir + '/')}`, { cwd: src, env, timeout: 1_800_000 });
        if (r.code !== 0) throw new Error(`exporting ${base} from ${src} failed: ${r.stderr.slice(-400)}`);
    } finally { fs.rmSync(index, { force: true }); }
    git(dir, 'init', '-q');
    fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.graph-indexer/\n');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=bench', '-c', 'user.email=bench@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', `base ${base.slice(0, 12)}`);
    return dir;
}

function tryRemoveWorktree(src, dir) {
    try { git(src, 'worktree', 'remove', '--force', dir); } catch { fs.rmSync(dir, { recursive: true, force: true }); }
}

function instructions(task, arm, runDir, checkout, gi, caps, view) {
    const repo = REPOS[task.repo];
    const deliver = task.family === 'qa'
        ? `# Deliverable\nWrite your answer to the file \`${path.join(runDir, 'answer.txt')}\`.\n${task.answerFormat}`
        : `# Deliverable\nMake the change directly in the repository working tree. Do not commit, and do not modify files outside the repository.${task.testHint ?? repo.testHint ? `\n\nRunning tests: ${task.testHint ?? repo.testHint}` : ''}`;
    return `# Task
${task.statement}

${deliver}

# Environment
- Repository root: \`${checkout}\`. Work only inside it${task.family === 'qa' ? ' (the answer file above is the only file you write)' : ''}; paths you report are relative to it.
- Your current working directory is NOT the repository: use absolute paths, and always pass the repository root as the path to search tools (tools without a path search an unrelated directory).
- Work offline: do not search the web, fetch web pages, or download code or packages (no WebSearch/WebFetch, curl, wget, git fetch/clone, pip install). Solve the task from the repository with the tools described here.
- Nobody is available to answer questions: make reasonable assumptions and finish the task.
- Be efficient, but the result must be complete and correct.
- When you are finished, your final reply must be just the word DONE — the ${task.family === 'qa' ? 'answer file' : 'changes in the repository'} are what count.

${toolSection(arm, gi, caps, view)}
`;
}

export function prepareRun(task, arm, rep, label) {
    if (!ARM_NAMES.includes(arm)) throw new Error(`unknown arm ${arm}`);
    const id = runId(task.id, arm, rep);
    const runDir = path.join(WORK, 'runs', label, id);
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });
    const { dir: checkout, indexMs } = checkoutFor(task, arm, `${label}__${id}`, label);
    let gi = null, caps = {};
    // a real session reaches graph-indexer through its MCP server alone, as users install it
    if (usesIndex(arm) && !SESSION_ARMS[arm]) {
        gi = path.join(runDir, 'gi');
        fs.writeFileSync(gi, `#!/bin/sh\nexec node ${JSON.stringify(giBin(label))} "$@" --repo ${JSON.stringify(checkout)}\n`, { mode: 0o755 });
        caps = capabilities(label);
    }
    let view = null;
    if (VIEW_ARMS.has(arm)) {
        view = path.join(runDir, 'view');
        fs.writeFileSync(view, `#!/bin/sh\nexec node ${JSON.stringify(path.join(HERE, 'view.mjs'))} --gi ${JSON.stringify(giBin(label))} --repo ${JSON.stringify(checkout)} --session ${JSON.stringify(`${label}__${id}`)} "$@"\n`, { mode: 0o755 });
    }
    const ask = ASK_ARMS[arm];
    if (ask && task.family !== 'qa') throw new Error(`${arm} answers questions; ${task.id} is an edit task`);
    const message = ask ? askMessage(arm, task, checkout, gi) : null;
    fs.writeFileSync(path.join(runDir, 'INSTRUCTIONS.md'), message ?? instructions(task, arm, runDir, checkout, gi, caps, view));
    // a real session in the run directory finds what `init` writes into a repository for Claude Code
    const session = SESSION_ARMS[arm];
    if (session?.v2) for (const [name, text] of Object.entries(projectFilesV2(task.repo))) fs.writeFileSync(path.join(runDir, name), text);
    else if (session?.index) fs.writeFileSync(path.join(runDir, 'CLAUDE.md'), managedBlock() + '\n');
    if (session?.helper) {
        fs.mkdirSync(path.join(runDir, '.claude', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(runDir, '.claude', 'agents', `${HELPER_NAME}.md`), claudeAgentFile());
    }
    const baseHead = git(checkout, 'rev-parse', 'HEAD').trim();
    const meta = { runId: id, taskId: task.id, family: task.family, arm, rep, giLabel: label, checkout, runDir, baseHead, indexMs, caps, preparedAt: new Date().toISOString(),
        ...(ask ? { deliver: 'reply', agentType: ask.agentType } : {}) };
    writeJson(path.join(runDir, 'meta.json'), meta);
    const prompt = ask
        ? `Your request is in ${path.join(runDir, 'INSTRUCTIONS.md')} — read that file first and do what it asks. Reply with the answer alone.`
        : `Your task instructions are in ${path.join(runDir, 'INSTRUCTIONS.md')} — read that file first and follow it exactly. The repository is at ${checkout}. When you have finished, reply with the single word DONE.`;
    return { ...meta, prompt };
}

function selectTasks(spec) {
    const all = loadTasks();
    if (!spec || spec === 'all') return all;
    if (spec.endsWith('.json')) return loadTasks(path.dirname(path.resolve(HERE, 'tasks', spec))).filter(t => t._file === path.basename(spec));
    const ids = spec.split(',');
    return all.filter(t => ids.includes(t.id) || ids.some(i => i.endsWith('*') && t.id.startsWith(i.slice(0, -1))));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const cmd = args[0];
    if (cmd === 'snapshot') {
        console.log(JSON.stringify(snapshot(opt('--label'))));
    } else if (cmd === 'run' || cmd === 'batch') {
        const label = opt('--gi');
        if (!label) throw new Error('--gi LABEL is required (see: prepare.mjs snapshot)');
        const tasks = selectTasks(cmd === 'run' ? opt('--task') : opt('--tasks', 'all'));
        if (!tasks.length) throw new Error('no matching tasks');
        const arms = cmd === 'run' ? [opt('--arm')] : list('--arms', ARM_NAMES);
        // --first-rep N adds repetitions after graded ones (preparing a run wipes its directory)
        const first = Number(opt('--first-rep', 1));
        const reps = cmd === 'run' ? [Number(opt('--rep', 1))] : Array.from({ length: Number(opt('--reps', 1)) }, (_, i) => first + i);
        for (const t of tasks) for (const a of arms) for (const r of reps) console.log(JSON.stringify(prepareRun(t, a, r, label)));
    } else {
        console.error('usage: prepare.mjs snapshot [--label L] | run --task ID --arm A [--rep N] --gi L | batch --tasks … --arms … --reps N --gi L');
        process.exitCode = 2;
    }
}
