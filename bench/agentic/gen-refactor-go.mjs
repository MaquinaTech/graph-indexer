#!/usr/bin/env node
/**
 * Generate multi-site change tasks on a Go repository, graded by the Go type checker (the
 * counterpart of gen-refactor-ts.mjs):
 *
 *   add-param   add a last parameter `strict bool` to a method and pass `false` at every call
 *   rename      rename a method whose name methods of other types share (those keep their name)
 *
 * Targets are methods with 4–15 (--min-calls, --max-calls) type-checked call sites in at least two
 * files, no use other than calls, no interface relating them to other methods (a change could
 * then compile and still break who implements what) and a name that methods of other types share,
 * so a text search over-matches. Grading: the module, tests included, type-checks
 * (bench/oracle-go -mode typecheck; the base commit has no error), and a structural check that the
 * target changed while the same-name methods did not (-mode struct).
 *
 *   node bench/agentic/gen-refactor-go.mjs --repo ~/.gi-agentic/go/caddy --name caddy [--seed 5] [--n 6] [--set NAME]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodeIntel } from '../../src/query/intel.mjs';
import { goRefs, goTypeErrors, goParamCount } from './oracle-go.mjs';
import { argv, git, writeJson, GI_ROOT, HERE } from './lib.mjs';
import { rng } from './stats.mjs';

const { opt } = argv();
const repo = path.resolve(GI_ROOT, opt('--repo'));
const name = opt('--name', path.basename(repo));
const seed = Number(opt('--seed', 5));
const n = Number(opt('--n', 6));
const set = opt('--set', null);
const minCalls = Number(opt('--min-calls', 4)), maxCalls = Number(opt('--max-calls', 15));
const prefix = set ? `${name}-${set}` : name;
const out = path.join(HERE, 'tasks', `refactor-${prefix}.json`);
const taken = new Set(fs.readdirSync(path.join(HERE, 'tasks'))
    .filter(f => f.startsWith(`refactor-${name}`) && f.endsWith('.json') && path.join(HERE, 'tasks', f) !== out)
    .flatMap(f => JSON.parse(fs.readFileSync(path.join(HERE, 'tasks', f), 'utf8')).map(t => t.meta.target.split('.').pop())));
const specDir = path.join(HERE, 'tasks', 'refactor');
// methods a library interface may expect (fmt.Stringer, io.Writer, json.Marshaler…): renaming one
// type-checks and still changes what the program does
const LIBRARY_METHODS = new Set(['String', 'Error', 'Close', 'Read', 'Write', 'ServeHTTP', 'Len', 'Less', 'Swap', 'MarshalJSON',
    'UnmarshalJSON', 'MarshalText', 'UnmarshalText', 'Unwrap', 'Is', 'As', 'Format', 'GoString', 'Seek', 'Flush', 'Hijack', 'Push',
    'ReadFrom', 'WriteTo', 'Accept', 'Addr', 'Network', 'Timeout', 'Temporary', 'Header', 'WriteHeader', 'Value', 'Deadline', 'Done', 'Err']);

const base = git(repo, 'rev-parse', 'HEAD').trim();
const errors = goTypeErrors(repo);
if (errors.length) throw new Error(`the base commit does not type-check:\n${errors.slice(0, 5).join('\n')}`);
const intel = new CodeIntel({ root: repo, dbPath: path.join(os.tmpdir(), 'gi-agentic-gen', `${name}.db`) });
await intel.open();

function shuffle(arr) {
    const r = rng(seed), a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

const all = intel.store.all(`SELECT s.name, s.qname, s.sig, s.name_line, s.name_col, s.start_line, f.path, f.is_test FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE f.lang = 'go' AND s.kind = 'method' AND s.parent_id IS NULL AND length(s.name) >= 4`);
const cands = shuffle(all.filter(m => !m.is_test && !LIBRARY_METHODS.has(m.name)));
const { files: built, answers } = goRefs(repo, cands.map(m => ({ path: m.path, line: m.name_line, col: m.name_col + 1 })));
const inBuild = new Set(built);
const ans = new Map(cands.map((m, i) => [m, answers[i]]));
const clsOf = (m) => m.qname.split('.')[0];

fs.mkdirSync(specDir, { recursive: true });
const tasks = [];
const used = new Set();
for (const m of cands) {
    if (tasks.length >= n) break;
    const a = ans.get(m);
    if (!a || a.related || used.has(m.name) || taken.has(m.name) || !inBuild.has(m.path)) continue;
    const params = goParamCount(m.sig, m.name);
    if (params == null || /\.\.\.\s*[\w.*[\]]+\s*\)/.test(m.sig ?? '')) continue; // variadic: nothing can follow
    const uses = a.uses ?? [];
    const files = new Set(uses.map(u => u.path));
    if (uses.some(u => !u.call) || uses.length < minCalls || uses.length > maxCalls || files.size < 2) continue;
    // same-name methods of other types, in files the build includes
    const decoys = all.filter(d => d.name === m.name && clsOf(d) !== clsOf(m) && inBuild.has(d.path))
        .map(d => ({ file: d.path, cls: clsOf(d), name: d.name, params: goParamCount(d.sig, d.name) })).filter(d => d.params != null).slice(0, 6);
    if (!decoys.length) continue;
    const kind = tasks.length % 2 === 0 ? 'add-param' : 'rename';
    used.add(m.name);
    const id = `refactor-${prefix}-${String(tasks.length + 1).padStart(2, '0')}-${kind}`;
    const cls = clsOf(m);
    let statement, spec;
    if (kind === 'add-param') {
        statement = `Add a parameter \`strict bool\` as the last parameter of the method \`${cls}.${m.name}\` (declared in \`${m.path}\`), and update every place in the repository that calls it (including _test.go files) to pass \`false\` for it. The method's behaviour does not need to change. Methods of other types that happen to be called \`${m.name}\` must not be modified.`;
        spec = { target: { file: m.path, cls, name: m.name, params: params + 1, lastType: 'bool' }, decoys };
    } else {
        const newName = m.name + 'Checked';
        statement = `Rename the method \`${cls}.${m.name}\` (declared in \`${m.path}\`) to \`${newName}\`, and update every place in the repository that uses it (including _test.go files). Methods of other types that are also called \`${m.name}\` must keep their name.`;
        spec = { target: { file: m.path, cls, name: m.name, newName, params }, decoys };
    }
    writeJson(path.join(specDir, `${id}.spec.json`), spec);
    tasks.push({
        id, family: 'edit', kind, repo: name, base, statement,
        testHint: 'Go is installed and the modules are downloaded: `go build ./...` compiles the module and `go vet ./...` also compiles the tests.',
        grade: {
            checks: [
                { name: 'the module type-checks, tests included', cmd: `"$HOME/.gi-agentic/oracle-go" -mode typecheck -dir .`, timeoutSec: 600 },
                { name: 'target changed, same-name methods untouched', cmd: `"$HOME/.gi-agentic/oracle-go" -mode struct -dir . -spec {GI}/bench/agentic/tasks/refactor/${id}.spec.json`, timeoutSec: 120 },
            ],
        },
        gold: { callSites: uses.map(u => `${u.path}:${u.line}`), files: [...files, m.path] },
        meta: { target: `${cls}.${m.name}`, path: m.path, line: m.start_line, callSites: uses.length, files: files.size, decoys: decoys.map(d => `${d.cls}.${d.name} (${d.file})`) },
    });
    console.error(`${id}: ${cls}.${m.name} calls=${uses.length} files=${files.size} decoys=${decoys.length}`);
}
writeJson(out, tasks);
console.error(`${tasks.length} tasks → ${path.relative(process.cwd(), out)}`);
intel.close();
