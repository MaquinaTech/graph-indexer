#!/usr/bin/env node
/**
 * Generate multi-site change tasks on a TypeScript repository, graded by the compiler:
 *
 *   add-param   add a required last parameter to a method and pass a given value at every call
 *   rename      rename a method whose name other methods share (those keep their name)
 *
 * Targets are methods with 4–15 compiler-verified call sites in at least two files, no overriding
 * or overridden declarations, and same-name methods elsewhere (so a text search over-matches).
 * Grading: no TypeScript diagnostic that the base commit did not have (a missed call site is a
 * new "Expected N arguments" / "Property does not exist" error) and a structural check that the
 * target changed while the same-name methods did not.
 *
 *   node bench/agentic/gen-refactor-ts.mjs --repo test/fixtures/nestjs --name nestjs --scope packages/ [--seed 5] [--n 6] [--set NAME]
 *
 * --set NAME writes a separate task set (tasks/refactor-<name>-<set>.json, ids refactor-<name>-<set>-NN-…)
 * whose targets avoid every method name used by the repository's other refactor sets: a held-out set
 * for evaluating a version tuned on the first one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodeIntel } from '../../src/query/intel.mjs';
import { createTsOracle } from './oracle-ts.mjs';
import { argv, git, writeJson, GI_ROOT, HERE } from './lib.mjs';
import { rng } from './stats.mjs';

const { opt } = argv();
const repo = path.resolve(GI_ROOT, opt('--repo', 'test/fixtures/nestjs'));
const name = opt('--name', path.basename(repo));
const scope = opt('--scope', 'packages/');
const seed = Number(opt('--seed', 5));
const n = Number(opt('--n', 6));
const set = opt('--set', null);
const prefix = set ? `${name}-${set}` : name;
const out = path.join(HERE, 'tasks', `refactor-${prefix}.json`);
// method names taken by the repository's other task sets
const taken = new Set(fs.readdirSync(path.join(HERE, 'tasks'))
    .filter(f => f.startsWith(`refactor-${name}`) && f.endsWith('.json') && path.join(HERE, 'tasks', f) !== out)
    .flatMap(f => JSON.parse(fs.readFileSync(path.join(HERE, 'tasks', f), 'utf8')).map(t => t.meta.target.split('.').pop())));
const specDir = path.join(HERE, 'tasks', 'refactor');

const base = git(repo, 'rev-parse', 'HEAD').trim();
const intel = new CodeIntel({ root: repo, dbPath: path.join(os.tmpdir(), 'gi-agentic-gen', `${name}.db`) });
await intel.open();
const tsFiles = intel.store.all("SELECT path FROM files WHERE lang IN ('typescript','tsx')").map(r => r.path).filter(p => !p.endsWith('.d.ts'));
const oracle = createTsOracle(repo, tsFiles);
const ts = oracle.ts;

function shuffle(arr) {
    const r = rng(seed), a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

/** Declaration facts from the compiler: class name, parameter names, visibility, abstract/static. */
function declInfo(file, line, col) {
    const sf = oracle.program.getSourceFile(path.join(repo, file));
    if (!sf) return null;
    const pos = ts.getPositionOfLineAndCharacter(sf, line - 1, col);
    let n = ts.getTokenAtPosition(sf, pos);
    while (n && !ts.isMethodDeclaration(n)) n = n.parent;
    if (!n || !n.body || !n.parent || !ts.isClassDeclaration(n.parent) || !n.parent.name) return null;
    const mods = ts.getCombinedModifierFlags(n);
    if (mods & (ts.ModifierFlags.Abstract | ts.ModifierFlags.Static)) return null;
    const overloads = n.parent.members.filter(m => ts.isMethodDeclaration(m) && m.name?.getText(sf) === n.name.getText(sf)).length;
    if (overloads > 1) return null;
    return { cls: n.parent.name.text, params: n.parameters.map(p => p.name.getText(sf)), hasRest: n.parameters.some(p => !!p.dotDotDotToken), optionalTail: n.parameters.length && !!(n.parameters.at(-1).questionToken || n.parameters.at(-1).initializer) };
}

const cands = shuffle(intel.store.all(`SELECT s.name, s.qname, s.name_line, s.name_col, s.start_line, f.path FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE f.lang = 'typescript' AND f.is_test = 0 AND s.kind = 'method' AND length(s.name) >= 4 AND s.name NOT IN ('constructor')`).filter(s => s.path.startsWith(scope)));

/**
 * Files that may refer to the method by a string (`sinon.stub(obj, 'name')`, `keyof` lookups):
 * a string literal equal to the name in a file that names the class or already calls the method.
 * The type checker cannot see these uses, so rename tasks avoid them.
 */
function stringMentions(name, cls, callFiles) {
    const lit = new RegExp(`(['"\`])${name}\\1`), clsRe = new RegExp(`\\b${cls}\\b`);
    return tsFiles.filter(f => {
        const text = fs.readFileSync(path.join(repo, f), 'utf8');
        return lit.test(text) && (callFiles.has(f) || clsRe.test(text));
    });
}

fs.mkdirSync(specDir, { recursive: true });

const tasks = [];
const used = new Set();
for (const m of cands) {
    if (tasks.length >= n) break;
    if (used.has(m.name) || taken.has(m.name)) continue;
    const info = declInfo(m.path, m.name_line, m.name_col);
    if (!info || info.hasRest) continue;
    const r = oracle.references(m.path, m.name_line, m.name_col);
    if (!r || r.groups !== 1) continue;
    const calls = [...new Map(r.refs.filter(x => x.call).map(x => [`${x.path}:${x.line}`, x])).values()];
    const files = new Set(calls.map(c => c.path));
    // every use must be a call we can see (no method references passed around, no JS callers)
    if (calls.length < 4 || calls.length > 15 || files.size < 2 || r.refs.some(x => !x.call)) continue;
    const decoys = intel.store.all(`SELECT s.qname, s.name_line, s.name_col, f.path FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE s.name = ? AND s.kind = 'method' AND f.lang = 'typescript' AND f.path <> ? AND f.path LIKE ?`, m.name, m.path, scope + '%')
        .map(d => ({ ...d, info: declInfo(d.path, d.name_line, d.name_col) })).filter(d => d.info).slice(0, 6);
    if (!decoys.length) continue;
    const kind = tasks.length % 2 === 0 ? 'add-param' : 'rename';
    // a required parameter cannot follow optional ones
    if (kind === 'add-param' && info.optionalTail) continue;
    // string references (`sinon.stub(obj, 'name')`) are uses the type checker cannot see
    if (kind === 'rename' && stringMentions(m.name, info.cls, files).length) continue;
    used.add(m.name);
    const id = `refactor-${prefix}-${String(tasks.length + 1).padStart(2, '0')}-${kind}`;
    const decoySpec = decoys.map(d => ({ file: d.path, cls: d.info.cls, name: m.name, params: d.info.params.length }));
    let statement, spec;
    if (kind === 'add-param') {
        const pname = info.params.includes('strict') ? 'strictMode' : 'strict';
        statement = `Add a required parameter \`${pname}: boolean\` as the last parameter of the method \`${info.cls}.${m.name}\` (declared in \`${m.path}\`), and update every place in the repository that calls it (including tests) to pass \`false\` for it. The method's behaviour does not need to change. Methods of other classes that happen to be called \`${m.name}\` must not be modified.`;
        spec = { target: { file: m.path, cls: info.cls, name: m.name, params: info.params.length + 1, lastParam: pname }, decoys: decoySpec };
    } else {
        const newName = m.name.replace(/^(\w)/, (c) => c) + 'Checked';
        statement = `Rename the method \`${info.cls}.${m.name}\` (declared in \`${m.path}\`) to \`${newName}\`, and update every place in the repository that uses it (including tests). Methods of other classes that are also called \`${m.name}\` must keep their name.`;
        spec = { target: { file: m.path, cls: info.cls, name: m.name, newName, params: info.params.length }, decoys: decoySpec };
    }
    const specFile = path.join(specDir, `${id}.spec.json`);
    writeJson(specFile, spec);
    tasks.push({
        id, family: 'edit', kind, repo: name, base, statement,
        testHint: 'The TypeScript compiler is available as `tsc` (global); third-party packages are not installed, so a full type check reports many unrelated missing-module errors.',
        grade: {
            checks: [
                { name: 'no new type errors', cmd: `node {GI}/bench/agentic/tsdiag.mjs --baseline-rev ${base}`, timeoutSec: 600 },
                { name: 'target changed, same-name methods untouched', cmd: `node {GI}/bench/agentic/tsstruct.mjs --spec-file {GI}/bench/agentic/tasks/refactor/${id}.spec.json`, timeoutSec: 120 },
            ],
        },
        gold: { callSites: calls.map(c => `${c.path}:${c.line}`), files: [...files, m.path] },
        meta: { target: `${info.cls}.${m.name}`, path: m.path, line: m.start_line, callSites: calls.length, files: files.size, decoys: decoys.map(d => `${d.info.cls}.${m.name} (${d.path})`) },
    });
    console.error(`${id}: ${info.cls}.${m.name} calls=${calls.length} files=${files.size} decoys=${decoys.length}`);
}
writeJson(out, tasks);
console.error(`${tasks.length} tasks → ${path.relative(process.cwd(), out)}`);
intel.close();
