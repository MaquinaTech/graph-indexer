#!/usr/bin/env node
/**
 * Does `rename` alone do the rename tasks of the agent benchmark?
 *
 * The B2 rename tasks (bench/agentic/tasks/refactor-*.json) ask to rename one method that shares
 * its name with methods of other classes, and are graded by the compiler: no new type errors
 * (TypeScript: `tsdiag`; Go: the type checker over the module, tests included) and the target
 * renamed with the same-name methods left alone (`tsstruct` / the Go oracle's `struct` mode). Each
 * task records that the unmodified checkout fails, that a reference solution computed with the
 * compiler's own rename passes, and that renaming every `.name(` call fails.
 *
 * Here no agent takes part: in a worktree at the task's base, `renameSymbol(…, { apply: true })`
 * runs once and the task's own checks grade what it wrote.
 *
 *   node bench/eval-rename.mjs [--tasks refactor-nestjs,refactor-nestjs-held,refactor-nestjs-r3,refactor-nestjs-r5,refactor-twenty,refactor-caddy]
 *        [--fixtures-root DIR] [--typescript DIR] [--work-dir DIR] [--json out.json]
 *
 * Needs what the tasks' checks need: the `typescript` package (TYPESCRIPT_PATH), and for caddy Go
 * with the oracle built (see docs/BENCHMARKS.md).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeIntel } from '../src/query/intel.mjs';
import { renameSymbol } from '../src/query/rename.mjs';
import { git, tryGit, sh, readJson, GI_ROOT } from './agentic/lib.mjs';
import { REPOS } from './agentic/repos.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FILES = opt('--tasks', 'refactor-nestjs,refactor-nestjs-held,refactor-nestjs-r3,refactor-nestjs-r5,refactor-twenty,refactor-caddy').split(',');
const FIXROOT = path.resolve(opt('--fixtures-root', GI_ROOT));
const WORK = path.resolve(opt('--work-dir', path.join(os.tmpdir(), 'gi-rename')));
const TS = path.resolve(opt('--typescript', process.env.TYPESCRIPT_PATH ?? path.join(os.homedir(), '.gi-agentic/tools/node_modules/typescript')));
const verbose = args.includes('--verbose');

const rows = [];
const byRepo = new Map();
for (const f of FILES) for (const t of readJson(path.join(here, 'agentic/tasks', f + '.json'), [])) if (t.kind === 'rename') (byRepo.get(t.repo) ?? byRepo.set(t.repo, []).get(t.repo)).push({ ...t, set: f });

for (const [repo, tasks] of byRepo) {
    const source = [path.resolve(GI_ROOT, REPOS[repo].source), path.resolve(FIXROOT, REPOS[repo].source)].find(p => fs.existsSync(path.join(p, '.git'))) ?? null;
    if (!source) { console.log(`${repo}: no checkout (${REPOS[repo].fetch})`); continue; }
    const wt = path.join(WORK, repo);
    tryGit(source, 'worktree', 'remove', '--force', wt);
    fs.rmSync(wt, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    git(source, 'worktree', 'add', '-q', '--detach', '--force', wt, tasks[0].base);
    const dbPath = path.join(WORK, `${repo}.db`);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    const intel = new CodeIntel({ root: wt, dbPath });
    const env = { TYPESCRIPT_PATH: TS, ...(repo === 'twenty' ? { GI_TSCONFIG: path.join(here, 'agentic/tsconfig/twenty.json') } : {}) };
    try {
        await intel.open();
        for (const t of tasks) {
            git(wt, 'checkout', '-q', '-f', '--detach', t.base);
            git(wt, 'clean', '-fdq');
            await intel.ix.sync();
            const spec = readJson(path.join(here, 'agentic/tasks/refactor', `${t.id}.spec.json`), null);
            const target = spec?.target ?? {};
            const symbol = `${target.file ?? t.meta.path}:${target.cls ? `${target.cls}.` : ''}${target.name ?? t.meta.target.split('.').pop()}`;
            const newName = target.newName ?? /to `(\w+)`/.exec(t.statement)?.[1];
            const t0 = Date.now();
            const r = await renameSymbol(intel, { symbol, newName, apply: true });
            const ms = Date.now() - t0;
            const checks = r.error ? [] : t.grade.checks.map(c => {
                const out = sh(c.cmd.replaceAll('{GI}', GI_ROOT), { cwd: wt, timeout: (c.timeoutSec ?? 600) * 1000, env });
                return { name: c.name, pass: out.code === 0, out: (out.stdout + out.stderr).trim().split('\n').slice(0, 3).join(' | ') };
            });
            const solved = !r.error && checks.every(c => c.pass);
            const row = { id: t.id, repo, set: t.set, solved, ms, edits: r.edits?.length ?? 0, files: r.files ?? 0, skipped: r.skipped?.length ?? 0, plausible: r.unbound?.plausible.length ?? 0, strings: r.strings?.length ?? 0,
                gold: t.gold?.callSites?.length ?? t.meta?.callSites ?? null, error: r.error ?? null, failed: checks.filter(c => !c.pass).map(c => `${c.name}: ${c.out}`) };
            rows.push(row);
            console.log(`${solved ? 'solved' : 'FAILED'}  ${t.id}  ${row.edits} edits in ${row.files} files (${row.gold} call sites in the task), ${row.skipped} bound less surely, ${row.plausible} same-name calls and ${row.strings} strings listed, ${ms} ms${row.error ? `  — ${row.error}` : ''}`);
            if (!solved && (verbose || true)) for (const f of row.failed) console.log(`        ${f.slice(0, 600)}`);
        }
    } finally {
        intel.close();
        tryGit(source, 'worktree', 'remove', '--force', wt);
        fs.rmSync(wt, { recursive: true, force: true });
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    }
}
const by = (f) => { const m = new Map(); for (const r of rows) { const k = f(r); const e = m.get(k) ?? m.set(k, [0, 0]).get(k); e[1]++; if (r.solved) e[0]++; } return [...m].map(([k, [a, b]]) => `${k} ${a}/${b}`).join(', '); };
console.log(`\nrename alone: ${rows.filter(r => r.solved).length} of ${rows.length} tasks solved (${by(r => r.repo)}); by task set: ${by(r => r.set)}`);
const out = opt('--json', null);
if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));
