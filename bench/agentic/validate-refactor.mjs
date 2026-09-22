#!/usr/bin/env node
/**
 * Validate generated refactor tasks the way SWE-bench validates gold patches: in a fresh worktree,
 *
 *   1. the unmodified checkout must fail the task's checks (nothing to do = not solved);
 *   2. a reference solution computed with the TypeScript language service must pass them;
 *   3. a naive textual solution (change every `.name(` call) should fail them — otherwise the
 *      task does not measure telling the target apart from same-name methods.
 *
 *   node bench/agentic/validate-refactor.mjs [--tasks bench/agentic/tasks/refactor-nestjs.json] [--only id,id]
 *
 * Writes the outcome to each task's `validation` field (and prints a table).
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, git, tryGit, sh, readJson, writeJson, HERE, WORK, GI_ROOT } from './lib.mjs';
import { createTsOracle } from './oracle-ts.mjs';
import { REPOS } from './repos.mjs';

const { opt, list } = argv();
const tasksFile = path.resolve(opt('--tasks', path.join(HERE, 'tasks', 'refactor-nestjs.json')));
const only = new Set(list('--only'));
const tasks = readJson(tasksFile, []);

function tsFilesOf(root) {
    return sh('git ls-files -co --exclude-standard -- "*.ts" "*.tsx"', { cwd: root }).stdout.split('\n').filter(f => f && !f.includes('node_modules'));
}

function runChecks(task, cwd) {
    return task.grade.checks.map(c => {
        const r = sh(c.cmd.replaceAll('{GI}', GI_ROOT), { cwd, timeout: (c.timeoutSec ?? 600) * 1000 });
        return { name: c.name, pass: r.code === 0, out: (r.stdout + r.stderr).trim().split('\n').slice(0, 4).join(' | ') };
    });
}

/** Apply [{file, pos, del, text}] edits (absolute file paths), last position first. */
function applyEdits(edits) {
    const byFile = Map.groupBy(edits, e => e.file);
    for (const [file, es] of byFile) {
        let text = fs.readFileSync(file, 'utf8');
        for (const e of es.sort((a, b) => b.pos - a.pos)) text = text.slice(0, e.pos) + e.text + text.slice(e.pos + (e.del ?? 0));
        fs.writeFileSync(file, text);
    }
}

/** The method declaration of the task's target, from the compiler. */
function targetDecl(oracle, root, t) {
    const { ts, program } = oracle;
    const sf = program.getSourceFile(path.join(root, t.path));
    let found = null;
    const visit = (n) => {
        if (found) return;
        if (ts.isClassDeclaration(n) && n.name?.text === t.cls) {
            found = n.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(sf) === t.name && m.body) ?? null;
            return;
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return found && { sf, decl: found };
}

/** Compiler-driven solution. */
function referenceSolution(task, spec, root) {
    const oracle = createTsOracle(root, tsFilesOf(root));
    const { ts, ls, program } = oracle;
    const t = { ...spec.target, path: spec.target.file };
    const d = targetDecl(oracle, root, t);
    if (!d) throw new Error(`target ${t.cls}.${t.name} not found`);
    const namePos = d.decl.name.getStart(d.sf);
    const edits = [];
    if (task.kind === 'rename') {
        for (const loc of ls.findRenameLocations(d.sf.fileName, namePos, false, false, false) ?? []) {
            edits.push({ file: loc.fileName, pos: loc.textSpan.start, del: loc.textSpan.length, text: spec.target.newName });
        }
    } else {
        const ps = d.decl.parameters;
        edits.push(ps.length ? { file: d.sf.fileName, pos: ps.at(-1).end, text: `, ${spec.target.lastParam}: boolean` } : { file: d.sf.fileName, pos: ps.pos, text: `${spec.target.lastParam}: boolean` });
        for (const g of ls.findReferences(d.sf.fileName, namePos) ?? []) {
            for (const r of g.references) {
                if (r.isDefinition) continue;
                const sf = program.getSourceFile(r.fileName);
                const tok = ts.getTokenAtPosition(sf, r.textSpan.start);
                const pae = tok.parent;
                const call = pae && ts.isPropertyAccessExpression(pae) && pae.name === tok ? pae.parent : null;
                if (!call || !ts.isCallExpression(call) || call.expression !== pae) continue;
                const args = call.arguments;
                edits.push(args.length ? { file: sf.fileName, pos: args.at(-1).end, text: ', false' } : { file: sf.fileName, pos: args.pos, text: 'false' });
            }
        }
    }
    applyEdits(edits);
    return edits.length;
}

/** What `sed` over every grep hit would do: every `.name(…)` call changes, whatever its receiver. */
function naiveSolution(task, spec, root) {
    const oracle = createTsOracle(root, tsFilesOf(root));
    const { ts, program } = oracle;
    const t = { ...spec.target, path: spec.target.file };
    const d = targetDecl(oracle, root, t);
    const edits = [];
    if (task.kind === 'rename') edits.push({ file: d.sf.fileName, pos: d.decl.name.getStart(d.sf), del: t.name.length, text: t.newName });
    else {
        const ps = d.decl.parameters;
        edits.push(ps.length ? { file: d.sf.fileName, pos: ps.at(-1).end, text: `, ${t.lastParam}: boolean` } : { file: d.sf.fileName, pos: ps.pos, text: `${t.lastParam}: boolean` });
    }
    for (const sf of program.getSourceFiles()) {
        const rel = path.relative(root, sf.fileName);
        if (rel.startsWith('..') || rel.includes('node_modules')) continue;
        const visit = (n) => {
            if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === t.name) {
                if (task.kind === 'rename') edits.push({ file: sf.fileName, pos: n.expression.name.getStart(sf), del: t.name.length, text: t.newName });
                else {
                    const args = n.arguments;
                    edits.push(args.length ? { file: sf.fileName, pos: args.at(-1).end, text: ', false' } : { file: sf.fileName, pos: args.pos, text: 'false' });
                }
            }
            ts.forEachChild(n, visit);
        };
        visit(sf);
    }
    applyEdits(edits);
    return edits.length - 1;
}

const src = path.resolve(GI_ROOT, REPOS[tasks[0]?.repo]?.source ?? '.');
const wt = path.join(WORK, 'validate', path.basename(tasksFile, '.json'));
if (!fs.existsSync(path.join(wt, '.git'))) {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    tryGit(src, 'worktree', 'prune');
    git(src, 'worktree', 'add', '-q', '--detach', wt, tasks[0].base);
}
const reset = (rev) => { git(wt, 'checkout', '-q', '-f', '--detach', rev); git(wt, 'clean', '-fdqx'); };

const rows = [];
for (const task of tasks) {
    if (only.size && !only.has(task.id)) continue;
    const spec = readJson(path.join(HERE, 'tasks', 'refactor', `${task.id}.spec.json`));
    reset(task.base);
    const unmodified = runChecks(task, wt);
    reset(task.base);
    const refEdits = referenceSolution(task, spec, wt);
    const reference = runChecks(task, wt);
    reset(task.base);
    const naiveEdits = naiveSolution(task, spec, wt);
    const naive = runChecks(task, wt);
    reset(task.base);
    const ok = !unmodified.every(c => c.pass) && reference.every(c => c.pass);
    task.validation = {
        ok, unmodifiedFails: !unmodified.every(c => c.pass), referencePasses: reference.every(c => c.pass),
        naiveFails: !naive.every(c => c.pass), referenceEdits: refEdits, naiveCallEdits: naiveEdits,
        naiveFailure: naive.filter(c => !c.pass).map(c => `${c.name}: ${c.out}`),
    };
    rows.push({ id: task.id, ok, ref: reference.map(c => c.pass ? 'pass' : `FAIL(${c.out})`).join(' '), naive: naive.map(c => c.pass ? 'pass' : 'fail').join('/'), refEdits, naiveEdits });
    console.error(`${task.id}: ${ok ? 'OK' : 'INVALID'} ref=[${rows.at(-1).ref}] naive=${rows.at(-1).naive} edits ref=${refEdits} naive=${naiveEdits}`);
}
writeJson(tasksFile, tasks);
const bad = rows.filter(r => !r.ok);
console.error(`${rows.length - bad.length}/${rows.length} valid; naive solution fails on ${tasks.filter(t => t.validation?.naiveFails).length}/${rows.length}`);
tryGit(src, 'worktree', 'remove', '--force', wt);
process.exitCode = bad.length ? 1 : 0;
