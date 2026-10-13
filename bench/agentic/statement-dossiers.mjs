#!/usr/bin/env node
/**
 * One dossier per B5 task that still needs a problem statement, for the statement writers and
 * reviewers (WORK/statements/b5/INSTRUCTIONS.md says what they do with it):
 *
 *   node bench/agentic/statement-dossiers.mjs --tasks b5-scrapy.json[,b5-haystack.json]
 *   node bench/agentic/statement-dossiers.mjs --tasks b5-scrapy.json --clean
 *
 * WORK/statements/b5/<id>/ holds `base/` (a worktree of the repository at the base commit),
 * commit.txt, gold.patch, test.patch, f2p.txt, forbidden.txt and task.json; statements go to
 * WORK/statements/b5/out/<id>.md (or <id>.WITHDRAW). --clean removes the dossiers and their
 * worktrees once statements.mjs has applied the statements.
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, WORK, HERE, git, tryGit, readJson } from './lib.mjs';
import { REPOS } from './repos.mjs';

const { list, flag } = argv();
const files = list('--tasks');
if (!files.length) {
    console.error('usage: statement-dossiers.mjs --tasks FILE[,FILE...] [--clean]');
    process.exit(2);
}
const root = path.join(WORK, 'statements', 'b5');
fs.mkdirSync(path.join(root, 'out'), { recursive: true });

for (const f of files) {
    const tasks = readJson(path.join(HERE, 'tasks', f));
    if (!tasks) throw new Error(`no task file ${f}`);
    for (const t of tasks) {
        const d = path.join(root, t.id), src = REPOS[t.repo].source;
        if (flag('--clean')) {
            if (fs.existsSync(path.join(d, 'base'))) tryGit(src, 'worktree', 'remove', '--force', path.join(d, 'base'));
            fs.rmSync(d, { recursive: true, force: true });
            tryGit(src, 'worktree', 'prune');
            console.log(`removed ${t.id}`);
            continue;
        }
        if (!t.needsStatement) continue;
        fs.mkdirSync(d, { recursive: true });
        if (!fs.existsSync(path.join(d, 'base', '.git'))) {
            tryGit(src, 'worktree', 'prune');
            git(src, 'worktree', 'add', '-q', '--detach', path.join(d, 'base'), t.base);
        }
        fs.writeFileSync(path.join(d, 'commit.txt'), git(src, 'log', '-1', '--format=%B', t.meta.sha));
        fs.writeFileSync(path.join(d, 'gold.patch'), t.gold.patch);
        fs.writeFileSync(path.join(d, 'test.patch'), t.grade.testPatch);
        fs.writeFileSync(path.join(d, 'f2p.txt'), readJson(path.join(HERE, 'tasks', 'fresh', `${t.id}.f2p.json`)).join('\n') + '\n');
        const changed = [...t.gold.patch.matchAll(/^@@[^@]*@@\s*(?:async\s+)?(?:def|class)\s+(\w+)/gm)].map(m => m[1]);
        fs.writeFileSync(path.join(d, 'forbidden.txt'), [
            '# Files the fix changes (A = partial, B = ripple):', ...t.gold.files,
            '# Names whose change ripples from A to B:', ...t.meta.ripples.map(r => r.name),
            '# Enclosing functions/classes of changed hunks (heuristic; also check the patch):', ...new Set(changed)].join('\n') + '\n');
        fs.writeFileSync(path.join(d, 'task.json'), JSON.stringify({ id: t.id, repo: t.repo, base: t.base, testHint: t.testHint, f2p: t.meta.f2p, ripple: t.meta.ripple }, null, 2));
        console.log(t.id);
    }
}
if (flag('--clean') && fs.existsSync(path.join(root, 'out'))) {
    const left = fs.readdirSync(root).filter(n => n.startsWith('b5-'));
    if (!left.length) fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
}
