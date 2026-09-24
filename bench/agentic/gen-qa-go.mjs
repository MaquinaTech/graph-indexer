#!/usr/bin/env node
/**
 * Generate code-understanding tasks on a Go repository whose answers come from the Go type checker
 * (bench/oracle-go), the counterpart of gen-qa-ts.mjs:
 *
 *   call-sites       every call of a method whose name other methods share (grep noise)
 *   callers-2        functions/methods that call a method directly or through one intermediate caller
 *   implementations  named types that implement an interface (Go has no `implements`: the type
 *                    checker decides, promoted methods and pointer receivers included)
 *
 * Call questions only use methods no interface relates to (no calls through an interface can reach
 * them), so "the calls of X" has one unambiguous answer; functions whose callers are closures at
 * package level are left out.
 *
 *   node bench/agentic/gen-qa-go.mjs --repo ~/.gi-agentic/go/caddy --name caddy [--seed 3] [--calls 8] [--callers 3] [--impls 3]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodeIntel } from '../../src/query/intel.mjs';
import { goRefs } from './oracle-go.mjs';
import { argv, git, writeJson, GI_ROOT } from './lib.mjs';
import { rng } from './stats.mjs';

const { opt } = argv();
const repo = path.resolve(GI_ROOT, opt('--repo'));
const name = opt('--name', path.basename(repo));
const set = opt('--set', null);
const prefix = set ? `${name}-${set}` : name;
const out = path.resolve(GI_ROOT, opt('--out', `bench/agentic/tasks/qa-${prefix}.json`));
const tasksDir = path.dirname(out);
const taken = new Set(fs.readdirSync(tasksDir)
    .filter(f => f.startsWith(`qa-${name}`) && f.endsWith('.json') && path.join(tasksDir, f) !== out)
    .flatMap(f => JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8')).flatMap(t => [t.meta.target, t.meta.target.split('.').pop()])));
const seed = Number(opt('--seed', 3));
const want = { calls: Number(opt('--calls', 8)), callers: Number(opt('--callers', 3)), impls: Number(opt('--impls', 3)) };
const implMax = Number(opt('--impl-max', 15));

const base = git(repo, 'rev-parse', 'HEAD').trim();
const intel = new CodeIntel({ root: repo, dbPath: path.join(os.tmpdir(), 'gi-agentic-gen', `${name}.db`) });
await intel.open();
const goFiles = intel.store.all("SELECT path FROM files WHERE lang = 'go'").map(r => r.path);
const isTest = (p) => /_test\.go$/.test(p);
const fileText = new Map();
const linesOf = (p) => { if (!fileText.has(p)) fileText.set(p, fs.readFileSync(path.join(repo, p), 'utf8').split('\n')); return fileText.get(p); };

function shuffle(arr) {
    const r = rng(seed), a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

/** Lines where `.name(` appears (what a grep for the method call finds). */
function grepCallLines(nm) {
    const re = new RegExp(`\\.${nm}\\s*\\(`);
    const hits = new Set();
    for (const f of goFiles) linesOf(f).forEach((l, i) => { if (re.test(l)) hits.add(`${f}:${i + 1}`); });
    return hits;
}

const methods = shuffle(intel.store.all(`SELECT s.name, s.qname, s.name_line, s.name_col, s.start_line, f.path FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE f.lang = 'go' AND f.is_test = 0 AND s.kind = 'method' AND s.parent_id IS NULL AND length(s.name) >= 3`));
const t0 = Date.now();
const { files: built, answers } = goRefs(repo, methods.map(m => ({ path: m.path, line: m.name_line, col: m.name_col + 1 })));
const inBuild = new Set(built);
// files the default build leaves out (build tags): the checker has no answer there, so what an agent
// lists in them is neither required nor penalised
const outOfBuild = goFiles.filter(f => !inBuild.has(f));
console.error(`go/types: ${answers.filter(Boolean).length}/${methods.length} methods (${Date.now() - t0} ms)`);
const ans = new Map(methods.map((m, i) => [m, answers[i]]));

const tasks = [];
const used = new Set();
const count = (k) => tasks.filter(t => t.kind === k).length;

// ── call sites with same-name noise ─────────────────────────────────────────────
for (const m of methods) {
    if (count('call-sites') >= want.calls) break;
    const a = ans.get(m);
    if (!a || a.related || used.has(m.name) || taken.has(m.name) || !inBuild.has(m.path)) continue;
    const uses = a.uses ?? [];
    if (uses.some(u => !u.call)) continue; // a method value passed around is a judgement call
    const files = new Set(uses.map(u => u.path));
    if (uses.length < 3 || uses.length > 20 || files.size < 2) continue;
    const grep = grepCallLines(m.name);
    const gold = new Set(uses.map(u => `${u.path}:${u.line}`));
    const noise = [...grep].filter(x => !gold.has(x)).length;
    if (noise < 3) continue;
    used.add(m.name);
    const n = count('call-sites') + 1;
    tasks.push({
        id: `qa-${prefix}-calls-${String(n).padStart(2, '0')}`,
        family: 'qa', kind: 'call-sites', repo: name, base,
        statement: `Find every place in the repository where the method \`${m.qname}\` (declared in \`${m.path}\`, line ${m.start_line}) is called — including calls in _test.go files. Methods of other types in the codebase share the name \`${m.name}\`; calls to those must not be listed.`,
        answerFormat: 'One call site per line as `path:LINE`, where path is relative to the repository root and LINE is the line containing the method name of the call. Nothing else.',
        gold: { type: 'lines', tolerance: 1, items: [...uses.map(u => ({ path: u.path, line: u.line })), ...[...grep].filter(x => outOfBuild.includes(x.slice(0, x.lastIndexOf(':')))).map(x => ({ path: x.slice(0, x.lastIndexOf(':')), line: Number(x.slice(x.lastIndexOf(':') + 1)), optional: true }))] },
        meta: { target: m.qname, path: m.path, line: m.start_line, grepCallLines: grep.size, sameNameNoise: noise, testCalls: uses.filter(u => isTest(u.path)).length },
    });
    console.error(`call-sites: ${m.qname} gold=${uses.length} (${files.size} files) grep=${grep.size} noise=${noise}`);
}

// ── two-level callers ───────────────────────────────────────────────────────────
const spanKey = (s) => `${s.path}:${s.start}`;
for (const m of methods) {
    if (count('callers-2') >= want.callers) break;
    const a = ans.get(m);
    if (!a || a.related || used.has(m.name) || taken.has(m.name) || !inBuild.has(m.path)) continue;
    const prod = (a.uses ?? []).filter(u => !isTest(u.path));
    if (prod.some(u => u.call && !u.fn)) continue; // called from a package-level closure
    const l1 = [...new Map(prod.filter(u => u.call).map(u => [spanKey(u.fn), u.fn])).values()];
    if (l1.length < 2 || l1.length > 8) continue;
    const second = goRefs(repo, l1.map(f => ({ path: f.path, line: f.nameLine, col: f.nameCol }))).answers;
    // a caller reached through an interface would make level 2 a judgement call
    if (second.some(x => !x || x.related)) continue;
    const items = new Map(l1.map(f => [spanKey(f), { ...f, level: 1 }]));
    const optional = new Map();
    for (const u of prod) if (!u.call && u.fn && !items.has(spanKey(u.fn))) optional.set(spanKey(u.fn), { ...u.fn, level: 1, optional: true });
    let closure = false;
    for (const x of second) for (const u of (x.uses ?? []).filter(u => !isTest(u.path))) {
        if (!u.fn) { if (u.call) closure = true; continue; }
        const k = spanKey(u.fn);
        if (items.has(k) || optional.has(k)) continue;
        if (u.call) items.set(k, { ...u.fn, level: 2 }); else optional.set(k, { ...u.fn, level: 2, optional: true });
    }
    if (closure || items.size < 8 || items.size > 40) continue;
    used.add(m.name);
    const n = count('callers-2') + 1;
    const strip = ({ path: p, start, end, name: nm, level, optional: o }) => ({ path: p, start, end, name: nm, level, ...(o ? { optional: true } : {}) });
    tasks.push({
        id: `qa-${prefix}-callers-${String(n).padStart(2, '0')}`,
        family: 'qa', kind: 'callers-2', repo: name, base,
        statement: `I plan to change the behaviour of the method \`${m.qname}\` (declared in \`${m.path}\`, line ${m.start_line}). List every function or method in the repository that calls it directly, plus every function or method that calls one of those direct callers (two levels up the call chain). Exclude _test.go files.`,
        answerFormat: 'One function or method per line as `path:LINE`, where LINE is the line on which that function or method is declared. Nothing else.',
        gold: { type: 'spans', items: [...[...items.values()].map(strip), ...[...optional.values()].map(strip)] },
        meta: { target: m.qname, path: m.path, line: m.start_line, level1: l1.length, total: items.size },
    });
    console.error(`callers-2: ${m.qname} level1=${l1.length} total=${items.size}`);
}

// ── implementations ─────────────────────────────────────────────────────────────
const ifaces = shuffle(intel.store.all(`SELECT s.name, s.qname, s.name_line, s.name_col, s.start_line, f.path FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE f.lang = 'go' AND f.is_test = 0 AND s.kind = 'interface' AND length(s.name) >= 4 AND s.parent_id IS NULL`));
const ifaceAns = goRefs(repo, ifaces.map(i => ({ path: i.path, line: i.name_line, col: i.name_col + 1 }))).answers;
ifaces.forEach((it, i) => {
    if (count('implementations') >= want.impls || taken.has(it.qname) || !inBuild.has(it.path)) return;
    const impls = (ifaceAns[i]?.implSpans ?? []).filter(s => !isTest(s.path));
    if (impls.length < 3 || impls.length > implMax) return;
    // types outside the build may implement it too, which the checker cannot tell: left out
    const need = intel.store.all(`SELECT s.name FROM symbols s WHERE s.parent_id = (SELECT s2.id FROM symbols s2 JOIN files f2 ON f2.id = s2.file_id WHERE f2.path = ? AND s2.name_line = ? AND s2.kind = 'interface') AND s.kind = 'method'`, it.path, it.name_line).map(r => r.name);
    if (need.some(nm => intel.store.all(`SELECT f.path FROM symbols m JOIN files f ON f.id = m.file_id WHERE m.kind = 'method' AND m.name = ?`, nm).some(r => outOfBuild.includes(r.path)))) return;
    const n = count('implementations') + 1;
    tasks.push({
        id: `qa-${prefix}-impls-${String(n).padStart(2, '0')}`,
        family: 'qa', kind: 'implementations', repo: name, base,
        statement: `List every named type in the repository (excluding _test.go files) that implements the interface \`${it.qname}\` declared in \`${it.path}\`, line ${it.start_line} — with value or pointer receivers, including methods promoted from embedded types.`,
        answerFormat: 'One type per line as `path:LINE`, where LINE is the line of the type declaration. Nothing else.',
        gold: { type: 'spans', items: impls.map(s => ({ path: s.path, start: s.start, end: s.end, name: s.name })) },
        meta: { target: it.qname, path: it.path, line: it.start_line, total: impls.length },
    });
    console.error(`implementations: ${it.qname} total=${impls.length}`);
});

writeJson(out, tasks);
console.error(`${tasks.length} tasks → ${path.relative(process.cwd(), out)}`);
intel.close?.();
