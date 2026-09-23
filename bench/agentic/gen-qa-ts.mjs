#!/usr/bin/env node
/**
 * Generate code-understanding tasks whose answers are verified by the TypeScript compiler.
 *
 *   call-sites       every call of a method whose name is shared by other methods (grep noise):
 *                    the agent must separate the method's own call sites from same-name calls
 *   callers-2        functions/methods that call a method directly or through one intermediate
 *                    caller (a two-level impact question)
 *   implementations  classes implementing an interface, directly or through a base class
 *
 * Candidates are sampled with a seed; only symbols without overriding/overridden declarations are
 * used for call questions, so "the calls of X" has one unambiguous compiler answer.
 *
 *   node bench/agentic/gen-qa-ts.mjs --repo test/fixtures/nestjs --name nestjs --scope packages/ \
 *        [--seed 3] [--calls 8] [--callers 4] [--impls 3] [--set NAME]
 *
 * --set NAME writes a separate task set (tasks/qa-<name>-<set>.json, ids qa-<name>-<set>-…) whose
 * targets avoid every method and interface used by the repository's other question sets.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodeIntel } from '../../src/query/intel.mjs';
import { createTsOracle } from './oracle-ts.mjs';
import { argv, git, writeJson, GI_ROOT } from './lib.mjs';
import { rng } from './stats.mjs';

const { opt } = argv();
const repo = path.resolve(GI_ROOT, opt('--repo', 'test/fixtures/nestjs'));
const name = opt('--name', path.basename(repo));
const scope = opt('--scope', 'packages/');
const set = opt('--set', null);
const prefix = set ? `${name}-${set}` : name;
const out = path.resolve(GI_ROOT, opt('--out', `bench/agentic/tasks/qa-${prefix}.json`));
// targets taken by the repository's other question sets: method names, and interfaces by qualified name
const tasksDir = path.dirname(out);
const taken = new Set(fs.readdirSync(tasksDir)
    .filter(f => f.startsWith(`qa-${name}`) && f.endsWith('.json') && path.join(tasksDir, f) !== out)
    .flatMap(f => JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8')).flatMap(t => [t.meta.target, t.meta.target.split('.').pop()])));
const seed = Number(opt('--seed', 3));
const want = { calls: Number(opt('--calls', 8)), callers: Number(opt('--callers', 4)), impls: Number(opt('--impls', 3)) };

const base = git(repo, 'rev-parse', 'HEAD').trim();
const intel = new CodeIntel({ root: repo, dbPath: path.join(os.tmpdir(), 'gi-agentic-gen', `${name}.db`) });
await intel.open();
const tsFiles = intel.store.all("SELECT path FROM files WHERE lang IN ('typescript','tsx')").map(r => r.path).filter(p => !p.endsWith('.d.ts'));
const t0 = Date.now();
const oracle = createTsOracle(repo, tsFiles);
console.error(`TypeScript program: ${oracle.program.getSourceFiles().length} files (${Date.now() - t0} ms)`);

const inScope = (p) => p.startsWith(scope);
const isTest = (p) => intel.store.get('SELECT is_test FROM files WHERE path = ?', p)?.is_test === 1;
const fileText = new Map();
const linesOf = (p) => { if (!fileText.has(p)) fileText.set(p, fs.readFileSync(path.join(repo, p), 'utf8').split('\n')); return fileText.get(p); };

function shuffle(arr) {
    const r = rng(seed), a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

/** Lines in scope where `.name(` appears (what a grep for the method call finds). */
function grepCallLines(nm) {
    const re = new RegExp(`[.?]${nm.replace(/\$/g, '\\$')}\\s*\\(`);
    const hits = new Set();
    for (const f of tsFiles) {
        if (!inScope(f)) continue;
        const ls = linesOf(f);
        for (let i = 0; i < ls.length; i++) if (re.test(ls[i])) hits.add(`${f}:${i + 1}`);
    }
    return hits;
}

/** Position of the declared name of a function-like item found by the call hierarchy. */
function declPos(item) {
    const row = intel.store.get(`SELECT s.name_line, s.name_col FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.start_line = ? ORDER BY s.end_line DESC LIMIT 1`, item.path, item.start);
    return row ? { line: row.name_line, col: row.name_col } : {};
}

// accessors are left out: the compiler treats a get/set pair as one symbol, so "the callers of the
// setter" would include every reader of the getter
const methods = shuffle(intel.store.all(`SELECT s.name, s.qname, s.kind, s.name_line, s.name_col, s.start_line, s.is_static, f.path FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE f.lang = 'typescript' AND f.is_test = 0 AND s.kind = 'method' AND length(s.name) >= 3 AND s.name <> 'constructor'
    AND s.sig NOT LIKE 'get %' AND s.sig NOT LIKE 'set %' AND s.sig NOT LIKE 'static get %' AND s.sig NOT LIKE 'static set %'`).filter(s => inScope(s.path)));

const tasks = [];
const used = new Set();

// ── call sites with same-name noise ─────────────────────────────────────────────
for (const m of methods) {
    if (tasks.filter(t => t.kind === 'call-sites').length >= want.calls) break;
    if (used.has(m.name) || taken.has(m.name)) continue;
    const r = oracle.references(m.path, m.name_line, m.name_col);
    if (!r || r.groups !== 1) continue;
    const calls = [...new Map(r.refs.filter(x => x.call && inScope(x.path)).map(x => [`${x.path}:${x.line}`, x])).values()];
    const files = new Set(calls.map(c => c.path));
    if (calls.length < 3 || calls.length > 20 || files.size < 2) continue;
    const grep = grepCallLines(m.name);
    const gold = new Set(calls.map(c => `${c.path}:${c.line}`));
    const noise = [...grep].filter(x => !gold.has(x)).length;
    if (noise < 3) continue;
    used.add(m.name);
    const n = tasks.filter(t => t.kind === 'call-sites').length + 1;
    tasks.push({
        id: `qa-${prefix}-calls-${String(n).padStart(2, '0')}`,
        family: 'qa', kind: 'call-sites', repo: name, base,
        statement: `Find every place under \`${scope}\` where the ${m.is_static ? 'static ' : ''}method \`${m.qname}\` (declared in \`${m.path}\`, line ${m.start_line}) is called — including calls in test/spec files. Other methods in the codebase share the name \`${m.name}\`; calls to those must not be listed.`,
        answerFormat: 'One call site per line as `path:LINE`, where path is relative to the repository root and LINE is the line containing the method name of the call. Nothing else.',
        gold: { type: 'lines', tolerance: 1, items: calls.map(c => ({ path: c.path, line: c.line })) },
        meta: { target: m.qname, path: m.path, line: m.start_line, grepCallLines: grep.size, sameNameNoise: noise, testCalls: calls.filter(c => isTest(c.path)).length },
    });
    console.error(`call-sites: ${m.qname} gold=${calls.length} (${files.size} files) grep=${grep.size} noise=${noise}`);
}

// ── two-level callers ───────────────────────────────────────────────────────────
for (const m of methods) {
    if (tasks.filter(t => t.kind === 'callers-2').length >= want.callers) break;
    if (used.has(m.name) || taken.has(m.name)) continue;
    const r = oracle.references(m.path, m.name_line, m.name_col);
    if (!r || r.groups !== 1) continue;
    // the second level is the callers of the direct callers in scope, as the statement says
    const items = oracle.incomingCalls(m.path, m.name_line, m.name_col, 2, c => inScope(c.path) && !isTest(c.path) && c.kind !== 'script' && c.kind !== 'module');
    const l1 = items.filter(c => c.level === 1).length;
    if (l1 < 2 || l1 > 8 || items.length < 8 || items.length > 40) continue;
    // functions that pass a caller along as a value (`xs.map(loadOne)`) instead of calling it are a
    // judgement call: listing them is neither required nor penalised
    const optional = [];
    const known = new Set(items.map(c => `${c.path}:${c.start}`));
    for (const c of [{ path: m.path, line: m.name_line, col: m.name_col, level: 0 }, ...items.filter(x => x.level === 1).map(x => ({ ...x, ...declPos(x) }))]) {
        if (!c.line) continue;
        const r = oracle.references(c.path, c.line, c.col);
        for (const ref of r?.refs ?? []) {
            if (ref.call || !ref.fn || !inScope(ref.path) || isTest(ref.path)) continue;
            const key = `${ref.path}:${ref.fn.start}`;
            if (known.has(key)) continue;
            known.add(key);
            optional.push({ path: ref.path, start: ref.fn.start, end: ref.fn.end, name: ref.fn.name, level: c.level + 1, optional: true });
        }
    }
    used.add(m.name);
    const n = tasks.filter(t => t.kind === 'callers-2').length + 1;
    tasks.push({
        id: `qa-${prefix}-callers-${String(n).padStart(2, '0')}`,
        family: 'qa', kind: 'callers-2', repo: name, base,
        statement: `I plan to change the behaviour of the ${m.is_static ? 'static ' : ''}method \`${m.qname}\` (declared in \`${m.path}\`, line ${m.start_line}). List every function or method under \`${scope}\` that calls it directly, plus every function or method that calls one of those direct callers (two levels up the call chain). Exclude test/spec files.`,
        answerFormat: 'One function or method per line as `path:LINE`, where LINE is the line on which that function or method is declared. Nothing else.',
        // a function that only mentions a caller without calling it is a judgement call too
        gold: { type: 'spans', items: [...items.map(c => ({ path: c.path, start: c.start, end: c.end, name: c.name, level: c.level, ...(c.call ? {} : { optional: true }) })), ...optional] },
        meta: { target: m.qname, path: m.path, line: m.start_line, level1: l1, total: items.length },
    });
    console.error(`callers-2: ${m.qname} level1=${l1} total=${items.length}`);
}

// ── implementations ─────────────────────────────────────────────────────────────
const ifaces = shuffle(intel.store.all(`SELECT s.name, s.qname, s.name_line, s.name_col, s.start_line, f.path FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE f.lang = 'typescript' AND f.is_test = 0 AND s.kind = 'interface' AND length(s.name) >= 4`).filter(s => inScope(s.path)));
for (const it of ifaces) {
    if (tasks.filter(t => t.kind === 'implementations').length >= want.impls) break;
    if (taken.has(it.qname)) continue;
    const impls = oracle.implementations(it.path, it.name_line, it.name_col).filter(c => inScope(c.path) && !isTest(c.path));
    const uniq = [...new Map(impls.map(c => [`${c.path}:${c.start}`, c])).values()];
    if (uniq.length < 3 || uniq.length > 15) continue;
    const n = tasks.filter(t => t.kind === 'implementations').length + 1;
    tasks.push({
        id: `qa-${prefix}-impls-${String(n).padStart(2, '0')}`,
        family: 'qa', kind: 'implementations', repo: name, base,
        statement: `List every class under \`${scope}\` (excluding test/spec files) that implements the interface \`${it.qname}\` declared in \`${it.path}\`, line ${it.start_line} — directly or by extending a class that implements it.`,
        answerFormat: 'One class per line as `path:LINE`, where LINE is the line of the class declaration. Nothing else.',
        gold: { type: 'spans', items: uniq.map(c => ({ path: c.path, start: c.start, end: c.end, name: c.name })) },
        meta: { target: it.qname, path: it.path, line: it.start_line, total: uniq.length },
    });
    console.error(`implementations: ${it.qname} total=${uniq.length}`);
}

writeJson(out, tasks);
console.error(`${tasks.length} tasks → ${path.relative(process.cwd(), out)}`);
intel.close?.();
