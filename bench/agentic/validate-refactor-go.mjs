#!/usr/bin/env node
/**
 * Validate generated Go refactor tasks as validate-refactor.mjs does the TypeScript ones: in a
 * fresh worktree,
 *
 *   1. the unmodified checkout must fail the task's checks (nothing to do = not solved);
 *   2. the reference solution written from the type checker's bindings (oracle-go -mode apply)
 *      must pass them;
 *   3. a naive textual solution (change every `.Name(` call on one line, and the declaration)
 *      should fail them — otherwise the task does not measure telling the target apart from
 *      same-name methods.
 *
 *   node bench/agentic/validate-refactor-go.mjs --tasks bench/agentic/tasks/refactor-caddy.json [--only id,id]
 *
 * Writes the outcome to each task's `validation` field (and prints a table).
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, git, sh, readJson, writeJson, HERE, WORK, GI_ROOT } from './lib.mjs';
import { ORACLE_GO } from './oracle-go.mjs';
import { REPOS } from './repos.mjs';

const { opt, list } = argv();
const tasksFile = path.resolve(opt('--tasks'));
const only = new Set(list('--only'));
const tasks = readJson(tasksFile, []);

const runChecks = (task, cwd) => task.grade.checks.map(c => {
    const r = sh(c.cmd.replaceAll('{GI}', GI_ROOT), { cwd, timeout: (c.timeoutSec ?? 900) * 1000 });
    return { name: c.name, ok: r.code === 0, tail: (r.stdout + r.stderr).trim().split('\n').slice(0, 3).join(' | ') };
});
const passed = (checks) => checks.every(c => c.ok);

/** Every `.Name(` call written on one line gets the change, and the declaration too. */
function naive(cwd, spec) {
    const t = spec.target;
    const files = sh('git ls-files -- "*.go"', { cwd }).stdout.split('\n').filter(Boolean);
    const call = new RegExp(`\\.${t.name}\\(`, 'g');
    for (const f of files) {
        const abs = path.join(cwd, f);
        const src = fs.readFileSync(abs, 'utf8');
        let out = src;
        if (t.newName) out = out.replace(call, `.${t.newName}(`);
        else out = out.split('\n').map(line => {
            let res = '', i = 0;
            for (const m of line.matchAll(call)) {
                const open = m.index + m[0].length - 1;
                let depth = 0, close = -1;
                for (let j = open; j < line.length; j++) { if (line[j] === '(') depth++; else if (line[j] === ')' && --depth === 0) { close = j; break; } }
                if (close < 0 || close < i) continue;
                const empty = line.slice(open + 1, close).trim() === '';
                res += line.slice(i, close) + (empty ? 'false' : ', false');
                i = close;
            }
            return res + line.slice(i);
        }).join('\n');
        if (f === t.file) {
            const decl = new RegExp(`(func \\([^)]*\\b${t.cls}(?:\\[[^\\]]*\\])?\\) )${t.name}\\(([^)]*)\\)`);
            out = t.newName ? out.replace(decl, `$1${t.newName}($2)`) : out.replace(decl, (_, a, p) => `${a}${t.name}(${p.trim() ? p + ', strict bool' : 'strict bool'})`);
        }
        if (out !== src) fs.writeFileSync(abs, out);
    }
}

const rows = [];
for (const task of tasks) {
    if (only.size && !only.has(task.id)) continue;
    const src = path.resolve(GI_ROOT, REPOS[task.repo].source);
    const dir = path.join(WORK, 'validate', task.id);
    if (fs.existsSync(dir)) { git(src, 'worktree', 'remove', '--force', dir); }
    git(src, 'worktree', 'prune');
    git(src, 'worktree', 'add', '-q', '--detach', dir, task.base);
    const specFile = path.join(HERE, 'tasks', 'refactor', `${task.id}.spec.json`);
    const spec = readJson(specFile);
    const base = runChecks(task, dir);
    const ap = sh(`${JSON.stringify(ORACLE_GO)} -mode apply -dir . -spec ${JSON.stringify(specFile)}`, { cwd: dir, timeout: 600_000 });
    const ref = ap.code === 0 ? runChecks(task, dir) : [{ name: 'apply', ok: false, tail: ap.stderr.slice(-300) }];
    const refDiff = git(dir, 'diff', '--stat').trim().split('\n').pop();
    git(dir, 'checkout', '-q', '--', '.');
    naive(dir, spec);
    const nai = runChecks(task, dir);
    git(src, 'worktree', 'remove', '--force', dir);
    const validation = { baseFails: !passed(base), referencePasses: passed(ref), naiveFails: !passed(nai), referenceDiff: refDiff, naive: nai.filter(c => !c.ok).map(c => `${c.name}: ${c.tail}`).slice(0, 2) };
    if (!validation.referencePasses) validation.reference = ref.filter(c => !c.ok).map(c => `${c.name}: ${c.tail}`);
    task.validation = validation;
    rows.push({ id: task.id, baseFails: validation.baseFails, refPasses: validation.referencePasses, naiveFails: validation.naiveFails, diff: refDiff });
}
writeJson(tasksFile, tasks);
console.table(rows);
for (const t of tasks) if (t.validation && !t.validation.referencePasses) console.log(t.id, t.validation.reference);
