#!/usr/bin/env node
/**
 * Does `explore`, given an issue as written, put the code the fix changes in front of the agent?
 * No agent involved: for every fresh issue task, a worktree at the task's base commit with its own
 * index, `explore <statement>` run through the CLI (the text an agent would get), and its definitions
 * scored against the lines the gold patch changes outside the tests.
 *
 *   node bench/agentic/localize.mjs prepare [--jobs 4]              worktrees + indexes (WORK/loc/<task>)
 *   node bench/agentic/localize.mjs run --label L [--split dev|held|all] [--max-tokens N] [--queries agent-queries.json]
 *   node bench/agentic/localize.mjs breaks [--split S]               existing tests the gold fix breaks, and whether check names them
 *   node bench/agentic/localize.mjs clean                           remove the worktrees
 *
 * Splits: `held` is the tasks of the rounds the agent benchmark still uses (fresh-*-r5, networkx r4),
 * kept for checking a change once; `dev` is the rest, for working on it.
 *
 * Per task: hit@shown (a definition shown with its code overlaps a changed hunk), hit@listed (one of
 * the definitions shown or listed does), file@shown (a shown definition is in a changed file), and the
 * answer's size. A definition longer than 400 lines (a whole parser class) does not count as a hit:
 * it points at a file, not at the code to change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { argv, git, loadTasks, writeJson, GI_ROOT, WORK } from './lib.mjs';
import { REPOS } from './repos.mjs';

const { args, opt, flag } = argv();
const cmd = args[0];
const LOC = path.join(WORK, 'loc');
// --cli: another build's CLI (a frozen copy), to compare versions on the same indexes
const CLI = opt('--cli') ? path.resolve(opt('--cli')) : path.join(GI_ROOT, 'bin', 'graph-indexer.mjs');
const HELD = /-r5\.json$|^fresh-networkx-r4\.json$/;
const MAX_SPAN = 400;

const tasks = loadTasks().filter(t => t.kind === 'fresh' && t.gold?.patch);
const split = opt('--split', 'all');
// --queries q.json: [{ task, input: { query, max_tokens } }] — the explore calls agents made, replayed
const agentQueries = opt('--queries') ? JSON.parse(fs.readFileSync(opt('--queries'), 'utf8')) : null;
const pick = tasks.filter(t => (split === 'all' || (split === 'held') === HELD.test(t._file)) && (!agentQueries || agentQueries.some(q => q.task === t.id)));

function run(argvs, cwd) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, argvs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
        p.on('close', code => resolve({ code, out, err }));
    });
}

async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/** Changed old-side line ranges per file, outside tests. */
function goldHunks(t) {
    const testRe = new RegExp(REPOS[t.repo]?.testRe ?? '(^|/)tests?/');
    const hunks = [];
    let file = null;
    for (const line of t.gold.patch.split('\n')) {
        const f = line.match(/^--- a\/(.+)$/);
        if (f) { file = testRe.test(f[1]) || /(^|\/)tests?\//.test(f[1]) ? null : f[1]; continue; }
        const h = line.match(/^@@ -(\d+)(?:,(\d+))? /);
        if (h && file) { const a = +h[1], n = h[2] == null ? 1 : +h[2]; hunks.push({ file, start: a, end: a + Math.max(n, 1) - 1 }); }
    }
    return hunks;
}

/** Definitions in an explore answer: shown (with code) and listed, in order. */
function parseExplore(text) {
    const [shownPart, rest = ''] = text.split(/\nAlso relevant \(not shown\):\n/);
    const defs = (s, re) => [...s.matchAll(re)].map(m => ({ qname: m[1], file: m[2], start: +m[3], end: +(m[4] ?? m[3]) }));
    const shown = defs(shownPart, /^## \d+\. (\S+) — .*?· (\S+?):(\d+)(?:-(\d+))?/gm);
    const listed = defs(rest.split(/\n(?:Not found|Left out|Next)/)[0], /^ {2}(\S+) — .*?· (\S+?):(\d+)(?:-(\d+))?/gm);
    return { shown, listed };
}

const overlaps = (d, h) => d.file === h.file && d.start <= h.end + 3 && h.start - 3 <= d.end && d.end - d.start < MAX_SPAN;

if (cmd === 'prepare') {
    fs.mkdirSync(LOC, { recursive: true });
    await pool(pick, Number(opt('--jobs', 4)), async (t) => {
        const wt = path.join(LOC, t.id);
        if (!fs.existsSync(wt)) git(REPOS[t.repo].source, 'worktree', 'add', '-q', '--detach', wt, t.base);
        if (fs.existsSync(path.join(wt, '.graph-indexer')) && !flag('--reindex')) return;
        const r = await run([CLI, 'index', '--repo', wt], wt);
        console.log(`${t.id} index ${r.code === 0 ? 'ok' : 'FAILED ' + r.err.slice(-300)}`);
    });
} else if (cmd === 'run') {
    const label = opt('--label');
    if (!label) throw new Error('--label is required');
    const outDir = path.join(WORK, 'loc-results', label);
    fs.mkdirSync(outDir, { recursive: true });
    const rows = [];
    await pool(pick, Number(opt('--jobs', 4)), async (t) => {
        const wt = path.join(LOC, t.id);
        if (!fs.existsSync(path.join(wt, '.graph-indexer'))) { console.log(`${t.id}: not prepared`); return; }
        const aq = agentQueries?.find(q => q.task === t.id)?.input;
        const maxTokens = opt('--max-tokens') ?? aq?.max_tokens;
        const extra = maxTokens ? ['--max-tokens', String(maxTokens)] : [];
        const r = await run([CLI, 'explore', aq?.query ?? t.statement, ...extra], wt);
        fs.writeFileSync(path.join(outDir, `${t.id}.txt`), r.out + (r.code ? `\n[exit ${r.code}] ${r.err}` : ''));
        const hunks = goldHunks(t), { shown, listed } = parseExplore(r.out);
        const hit = (ds) => ds.some(d => hunks.some(h => overlaps(d, h)));
        const files = new Set(hunks.map(h => h.file));
        rows.push({ id: t.id, split: HELD.test(t._file) ? 'held' : 'dev', hitShown: hit(shown), hitListed: hit([...shown, ...listed]),
            fileShown: shown.some(d => files.has(d.file)), chars: r.out.length, shown: shown.map(d => d.qname), gold: [...files] });
    });
    rows.sort((a, b) => a.id.localeCompare(b.id));
    for (const r of rows) console.log(`${r.id.padEnd(26)} ${r.hitShown ? 'HIT ' : r.hitListed ? 'list' : r.fileShown ? 'file' : '-   '}  ${String(r.chars).padStart(5)}  ${r.shown.join(', ').slice(0, 100)}`);
    for (const s of ['dev', 'held']) {
        const a = rows.filter(r => r.split === s);
        if (!a.length) continue;
        const n = (k) => a.filter(r => r[k]).length;
        console.log(`${s}: ${a.length} tasks · hit@shown ${n('hitShown')} · hit@listed ${n('hitListed')} · file@shown ${n('fileShown')} · mean ${Math.round(a.reduce((x, r) => x + r.chars, 0) / a.length / 2.63)} tokens`);
    }
    writeJson(path.join(outDir, 'summary.json'), rows);
} else if (cmd === 'tests') {
    // after the fix: do the tests `check` names cover the test files the fix's tests change?
    const rows = [];
    for (const t of pick) {
        const wt = path.join(LOC, t.id);
        if (!fs.existsSync(path.join(wt, '.graph-indexer'))) continue;
        const src = t.gold.patch;
        const want = [...new Set([...(t.grade?.testPatch ?? '').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]))];
        try {
            await new Promise((resolve, reject) => { const p = spawn('git', ['apply', '-'], { cwd: wt }); p.stdin.end(src); p.on('close', c => c ? reject(new Error(`git apply ${c}`)) : resolve()); });
            const r = await run([CLI, 'check'], wt);
            const named = new Set([...r.out.matchAll(/^test files that exercise the change \(\d+\): (.+)$/gm)].flatMap(m => m[1].split(', ').map(x => x.trim()).filter(x => x !== '…')));
            for (const m of r.out.matchAll(/test functions that reach[^:]*: (.+)$/gm)) for (const c of m[1].split(', ')) named.add(c.split('::')[0]);
            const problems = Number(r.out.match(/(\d+) problems? found/)?.[1] ?? 0);
            rows.push({ id: t.id, split: HELD.test(t._file) ? 'held' : 'dev', want, named: [...named], covered: want.filter(f => named.has(f)).length, problems });
        } finally { git(wt, 'checkout', '-q', '.'); git(wt, 'clean', '-fdq', '-e', '.graph-indexer'); }
    }
    for (const r of rows) console.log(`${r.id.padEnd(26)} ${r.covered}/${r.want.length} of the changed test files named (${r.named.length} named)${r.problems ? ` · ${r.problems} problem(s) reported` : ''}`);
    for (const s of ['dev', 'held']) {
        const a = rows.filter(r => r.split === s);
        if (!a.length) continue;
        const sum = (f) => a.reduce((x, r) => x + f(r), 0);
        console.log(`${s}: ${a.length} tasks · changed test files named ${sum(r => r.covered)}/${sum(r => r.want.length)} · all named in ${a.filter(r => r.covered === r.want.length).length} · mean ${(sum(r => r.named.length) / a.length).toFixed(1)} files named · problems reported on a correct fix: ${a.filter(r => r.problems).length} task(s)`);
    }
} else if (cmd === 'breaks') {
    // the existing tests a correct fix breaks (pass at the base, fail with the gold src patch): what
    // the agent finds out by running tests after its edit, and has to update
    const rows = [];
    const apply = (wt, patch) => new Promise((resolve, reject) => { const p = spawn('git', ['apply', '-'], { cwd: wt }); p.stdin.end(patch); p.on('close', c => c ? reject(new Error(`git apply ${c}`)) : resolve()); });
    await pool(pick, Number(opt('--jobs', 3)), async (t) => {
        const wt = path.join(LOC, t.id);
        if (!fs.existsSync(path.join(wt, '.graph-indexer'))) return;
        const repo = REPOS[t.repo];
        const touched = [...new Set([...(t.grade?.testPatch ?? '').matchAll(/^--- a\/(.+)$/gm)].map(m => m[1]))];
        const files = new Set();
        for (const f of touched) {
            if (f.endsWith('.py') && fs.existsSync(path.join(wt, f))) files.add(f);
            for (const [re, mod] of Object.entries(repo.fixtureTests ?? {})) if (new RegExp(re).test(f)) files.add(mod);
        }
        if (!files.size) { rows.push({ id: t.id, split: HELD.test(t._file) ? 'held' : 'dev', files: [], broken: [] }); return; }
        const runIt = async () => {
            const r = await run([path.join(GI_ROOT, 'bench/agentic/pytests.mjs'), '--runner', repo.runner, '--files', [...files].join(','), '--json', path.join(wt, '.graph-indexer', 'outcomes.json')], wt);
            try { return JSON.parse(fs.readFileSync(path.join(wt, '.graph-indexer', 'outcomes.json'), 'utf8')); } catch { return {}; } finally { void r; }
        };
        try {
            const before = await runIt();
            await apply(wt, t.gold.patch);
            const after = await runIt();
            const broken = Object.keys(before).filter(id => before[id] === 'pass' && after[id] !== 'pass');
            const r = await run([CLI, 'check'], wt);
            const cases = [...r.out.matchAll(/test functions that reach[^:]*: (.+)$/gm)].flatMap(m => m[1].split(', ').map(x => x.trim()));
            const named = new Set([...r.out.matchAll(/^test files that exercise the change \(\d+\): (.+)$/gm)].flatMap(m => m[1].split(', ').map(x => x.trim())));
            const caseName = (id) => { const [f, , n] = id.split('::'); return `${f}::${n}`; };
            const caseSet = new Set(cases.map(c => { const p = c.split('::'); return `${p[0]}::${p[p.length - 1]}`; }));
            rows.push({ id: t.id, split: HELD.test(t._file) ? 'held' : 'dev', files: [...files], broken,
                fileNamed: broken.filter(id => named.has(id.split('::')[0])).length, caseNamed: broken.filter(id => caseSet.has(caseName(id))).length,
                cases: cases.length, chars: r.out.length });
        } finally { git(wt, 'checkout', '-q', '.'); git(wt, 'clean', '-fdq', '-e', '.graph-indexer'); }
    });
    rows.sort((a, b) => a.id.localeCompare(b.id));
    for (const r of rows) console.log(`${r.id.padEnd(26)} ${String(r.broken.length).padStart(3)} broken${r.broken.length ? ` · file named ${r.fileNamed} · case named ${r.caseNamed} (${r.cases} cases listed)` : ''}  ${r.broken.slice(0, 3).join(' ')}`);
    for (const s of ['dev', 'held']) {
        const a = rows.filter(r => r.split === s);
        if (!a.length) continue;
        const sum = (f) => a.reduce((x, r) => x + f(r), 0);
        console.log(`${s}: ${a.length} tasks · ${a.filter(r => r.broken.length).length} with broken tests · broken ${sum(r => r.broken.length)} · in a named file ${sum(r => r.fileNamed ?? 0)} · named as a case ${sum(r => r.caseNamed ?? 0)}`);
    }
    writeJson(path.join(WORK, 'loc-results', 'breaks.json'), rows);
} else if (cmd === 'clean') {
    if (fs.existsSync(LOC)) for (const id of fs.readdirSync(LOC)) {
        const t = tasks.find(x => x.id === id);
        try { if (t) git(REPOS[t.repo].source, 'worktree', 'remove', '--force', path.join(LOC, id)); } catch { /* removed below */ }
        fs.rmSync(path.join(LOC, id), { recursive: true, force: true });
    }
    for (const r of new Set(tasks.map(t => t.repo))) try { git(REPOS[r].source, 'worktree', 'prune'); } catch { /* not cloned */ }
} else {
    throw new Error('usage: localize.mjs prepare|run|clean (see the header)');
}
