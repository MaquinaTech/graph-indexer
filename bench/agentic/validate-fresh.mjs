#!/usr/bin/env node
/**
 * Validate mined tasks (mine-fresh.mjs) through the grader itself, the way SWE-bench validates its
 * instances, in the isolated checkout an agent gets:
 *
 *   - base: the hidden tests apply, every FAIL_TO_PASS test fails and PASS_TO_PASS passes;
 *   - gold: with the real fix applied, the task is solved — repeated --reps times (default 3), so a
 *     test that passes only sometimes shows up here rather than in a run;
 *   - B5 tasks: RIPPLE passes with the real fix and fails with the partial one (the fix limited to
 *     the files that define the changed names).
 *
 *   node bench/agentic/validate-fresh.mjs --tasks fresh-sqlglot-r5.json [--reps 3] [--json out.json]
 *
 * Exit code 0 only when every task passes every check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, sh, writeJson, loadTasks, WORK } from './lib.mjs';
import { isolatedCheckout } from './prepare.mjs';
import { gradeEdit } from './grade.mjs';
import { REPOS } from './repos.mjs';

const { opt } = argv();
const spec = opt('--tasks');
const reps = Number(opt('--reps', 3));
const all = loadTasks().filter(t => t.kind === 'fresh');
const tasks = !spec ? all : spec.endsWith('.json') ? all.filter(t => t._file === path.basename(spec))
    : all.filter(t => spec.split(',').some(i => i === t.id || (i.endsWith('*') && t.id.startsWith(i.slice(0, -1)))));
if (!tasks.length) throw new Error(`no fresh tasks match ${spec}`);

/** The part of a patch that touches the given files. */
const filePatch = (patch, files) => patch.split(/^(?=diff --git )/m).filter(p => files.some(f => p.startsWith(`diff --git a/${f} b/`))).join('');
const passed = (c) => /^(\d+)\/(\d+) expected tests passed/m.exec(c?.tail ?? '');
const report = [];
let bad = 0;
for (const t of tasks) {
    const dir = path.join(WORK, 'validate', t.id), runDir = path.join(WORK, 'validate', `${t.id}.run`);
    fs.mkdirSync(runDir, { recursive: true });
    const src = path.resolve(REPOS[t.repo].source);
    const fresh = () => {
        isolatedCheckout(src, dir, t.base);
        const setup = REPOS[t.repo].setupWorktree;
        if (setup && sh(setup, { cwd: dir, timeout: 1_800_000 }).code !== 0) throw new Error(`setup of ${dir} failed`);
    };
    const problems = [];
    // base: the unfixed code fails every FAIL_TO_PASS test and keeps PASS_TO_PASS green
    fresh();
    const base = gradeEdit(t, { checkout: dir, runDir });
    const ck = (r, n) => r.checks.find(c => c.name === n);
    if (!ck(base, 'apply hidden tests')?.ok) problems.push('base: hidden tests do not apply');
    const f2pBase = passed(ck(base, 'FAIL_TO_PASS'));
    if (!f2pBase) problems.push('base: FAIL_TO_PASS gave no test count');
    else if (f2pBase[1] !== '0') problems.push(`base: ${f2pBase[1]}/${f2pBase[2]} FAIL_TO_PASS tests already pass`);
    if (!ck(base, 'PASS_TO_PASS')?.ok) problems.push(`base: PASS_TO_PASS fails (${passed(ck(base, 'PASS_TO_PASS'))?.[0] ?? 'no count'})`);
    // gold: the real fix solves the task, every time
    const gold = [];
    for (let r = 0; r < reps; r++) {
        fresh();
        const p = path.join(runDir, 'gold.patch');
        fs.writeFileSync(p, t.gold.patch);
        if (sh(`git apply --whitespace=nowarn ${JSON.stringify(p)}`, { cwd: dir }).code !== 0) { problems.push('gold: patch does not apply'); break; }
        const g = gradeEdit(t, { checkout: dir, runDir });
        gold.push(g.solved);
        if (!g.solved) problems.push(`gold rep ${r + 1}: ${g.checks.filter(c => !c.ok).map(c => `${c.name} ${passed(c)?.[0] ?? ''}`).join('; ')}`);
        else if (ck(g, 'RIPPLE') && !ck(g, 'RIPPLE').ok) problems.push(`gold rep ${r + 1}: RIPPLE ${passed(ck(g, 'RIPPLE'))?.[0] ?? 'no count'}`);
    }
    // B5: the partial fix (the commit limited to the files that define the changed names) leaves
    // RIPPLE tests broken — the silent error the task is about
    if (t.bench === 'b5') {
        fresh();
        const p = path.join(runDir, 'partial.patch');
        fs.writeFileSync(p, filePatch(t.gold.patch, t.gold.partial));
        if (sh(`git apply --whitespace=nowarn ${JSON.stringify(p)}`, { cwd: dir }).code !== 0) problems.push('partial: patch does not apply');
        else {
            const r = ck(gradeEdit(t, { checkout: dir, runDir }), 'RIPPLE');
            if (!r || r.ok) problems.push(`partial: RIPPLE passes (${passed(r)?.[0] ?? 'no count'})`);
            else console.log(`     ${t.id} partial fix: RIPPLE ${passed(r)?.[0] ?? 'fails'}`);
        }
    }
    const secs = Math.round(Math.max(...base.checks.map(c => c.ms ?? 0)) / 1000);
    report.push({ id: t.id, ok: !problems.length, problems, goldSolved: `${gold.filter(Boolean).length}/${reps}`, testSeconds: secs });
    if (problems.length) bad++;
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${t.id}  gold ${gold.filter(Boolean).length}/${reps}  ${secs}s${problems.length ? `\n       ${problems.join('\n       ')}` : ''}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
}
if (opt('--json')) writeJson(opt('--json'), report);
console.log(`${tasks.length - bad}/${tasks.length} tasks valid`);
process.exitCode = bad ? 1 : 0;
