#!/usr/bin/env node
/**
 * Free the disk a graded round holds: its edit tasks' worktrees (WORK/wt/<label>__*), the shared
 * question checkouts made for it (WORK/checkouts/<repo>@<sha>/<variant ending in -<label>>), and
 * the indexes other tools keep outside the checkout for it. What grading produced stays: each run's
 * agent.patch, its graded result (WORK/graded/<label>) and transcript.
 *
 *   node bench/agentic/cleanup.mjs --gi LABEL [--force]
 *
 * Without --force it leaves everything in place unless every prepared run of the label is graded
 * (a run still to grade needs its checkout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, git, tryGit, WORK } from './lib.mjs';

function removeTree(dir) {
    if (!fs.existsSync(dir)) return;
    // a worktree is removed through its repository, so the repository forgets it too
    const common = fs.statSync(path.join(dir, '.git'), { throwIfNoEntry: false })?.isFile() ? tryGit(dir, 'rev-parse', '--git-common-dir')?.trim() : null;
    if (common) { try { git(path.resolve(dir, common), 'worktree', 'remove', '--force', dir); } catch { /* removed below */ } }
    fs.rmSync(dir, { recursive: true, force: true });
}

const size = (dir) => {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) n += size(p); else if (e.isFile()) n += fs.statSync(p).size;
    }
    return n;
};

export function cleanRound(label, { force = false } = {}) {
    const runsDir = path.join(WORK, 'runs', label);
    const prepared = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(r => fs.existsSync(path.join(runsDir, r, 'meta.json'))) : [];
    // grading moves each run's result out of its run directory (grade-batch.mjs)
    const graded = prepared.filter(r => fs.existsSync(path.join(WORK, 'graded', label, r, 'result.json')) || fs.existsSync(path.join(runsDir, r, 'result.json')));
    if (!force && graded.length < prepared.length) return { skipped: `${prepared.length - graded.length} of ${prepared.length} run(s) not graded yet`, freed: 0 };
    const dirs = [];
    const wt = path.join(WORK, 'wt');
    if (fs.existsSync(wt)) for (const d of fs.readdirSync(wt)) if (d.startsWith(`${label}__`)) dirs.push(path.join(wt, d));
    const co = path.join(WORK, 'checkouts');
    if (fs.existsSync(co)) for (const repo of fs.readdirSync(co)) for (const v of fs.readdirSync(path.join(co, repo)))
        if (v.endsWith(`-${label}`) && !v.endsWith('.install.json')) dirs.push(path.join(co, repo, v));
    let freed = 0;
    for (const d of dirs) { try { freed += size(d); } catch { /* counted as 0 */ } removeTree(d); fs.rmSync(`${d}.install.json`, { force: true }); }
    // codebase-memory-mcp keeps one database per indexed path, named after it
    const cache = path.join(WORK, 'tools', 'cbm-cache');
    const tag = label.replace(/[^\w.-]/g, '_');
    if (fs.existsSync(cache)) for (const f of fs.readdirSync(cache)) if (f.includes(`-${tag}__`) || f.endsWith(`-${tag}.db`)) { freed += fs.statSync(path.join(cache, f)).size; fs.rmSync(path.join(cache, f), { force: true }); }
    return { removed: dirs.length, freed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
    const { opt, flag } = argv();
    const label = opt('--gi');
    if (!label) throw new Error('--gi LABEL is required');
    const r = cleanRound(label, { force: flag('--force') });
    console.log(r.skipped ? `left in place: ${r.skipped}` : `removed ${r.removed} checkout(s), ${(r.freed / 1e9).toFixed(1)} GB`);
}
