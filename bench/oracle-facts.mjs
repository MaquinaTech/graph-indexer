#!/usr/bin/env node
/**
 * Precision of the resolved-indirection facts (src/query/facts.mjs) against the running program: a
 * Python oracle imports the repository's modules (here, in the benchmark — never in the product) and
 * checks every claim the static passes make:
 *
 *   tables     for each class-level registration table, the keys its class really has (the class
 *              attribute at run time) against the keys the static pass says it has (its own entries
 *              plus those of the tables it extends with **Base.TABLE)
 *   overrides  for methods of classes with subclasses, which subclasses really redefine the method
 *              (in their own __dict__) and which inherit it, against inheritance() in the index
 *
 *   node bench/oracle-facts.mjs --repo DIR [--python python3] [--max-methods 400] [--json out.json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodeIntel } from '../src/query/intel.mjs';
import { tablesFor } from '../src/query/facts.mjs';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const root = path.resolve(opt('--repo') ?? '.');
const python = opt('--python', 'python3');
const maxMethods = Number(opt('--max-methods', 400));

const intel = new CodeIntel({ root });
await intel.open();
const modOf = (p) => p.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.');
const keyName = (k) => k.replace(/^["']|["']$/g, '').split('.').pop();

// ── claims ─────────────────────────────────────────────────────────────────────
const claims = { tables: [], methods: [] };
const T = tablesFor(intel);
for (const t of T.tables.values()) {
    if (!t.path.endsWith('.py') || t.owner == null) continue;
    const owner = intel.sym(t.owner);
    if (!owner || owner.kind !== 'class' || owner.parent_id != null) continue;
    const keys = new Set();
    const visit = (id, depth) => {
        const x = T.tables.get(id);
        if (!x || depth > 8) return;
        for (const e of x.entries) keys.add(keyName(e.key));
        for (const p of x.parents) visit(p, depth + 1);
    };
    visit(t.id, 0);
    claims.tables.push({ module: modOf(t.path), cls: owner.name, attr: t.name, keys: [...keys], parents: t.parents.length });
}
const methods = intel.store.all(`SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id JOIN symbols p ON p.id = s.parent_id
    WHERE s.kind = 'method' AND p.kind = 'class' AND p.parent_id IS NULL AND f.is_test = 0 AND f.path LIKE '%.py'
    AND EXISTS (SELECT 1 FROM refs r WHERE r.dst_id = p.id AND r.kind = 'inherit') ORDER BY s.id`);
for (const { id } of methods.slice(0, maxMethods)) {
    const m = intel.sym(id), cls = intel.sym(m.parent_id);
    const inh = intel.inheritance(id, { max: 100000 });
    claims.methods.push({ module: modOf(m.path), cls: cls.name, name: m.name,
        override: inh.override.filter(x => !x.is_test).map(x => x.name), inherit: inh.inherit.filter(x => !x.is_test).map(x => x.name) });
}
intel.close();

// ── oracle ─────────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-oracle-'));
fs.writeFileSync(path.join(tmp, 'claims.json'), JSON.stringify(claims));
fs.writeFileSync(path.join(tmp, 'oracle.py'), String.raw`
import importlib, json, sys, inspect
claims = json.load(open(sys.argv[1]))
def load(mod, cls):
    try:
        return getattr(importlib.import_module(mod), cls)
    except Exception:
        return None
def name_of(k):
    if isinstance(k, str): return k
    return getattr(k, '__name__', None) or getattr(k, 'name', None) or str(k)
def subclasses(c):
    out, todo = [], list(c.__subclasses__())
    while todo:
        s = todo.pop()
        if s in out: continue
        out.append(s); todo.extend(s.__subclasses__())
    return out
# subclasses register only when their modules are imported: import every module of the packages involved
import pkgutil
for top in sorted({c['module'].split('.')[0] for c in claims['tables'] + claims['methods']}):
    try:
        pkg = importlib.import_module(top)
    except Exception:
        continue
    for info in pkgutil.walk_packages(getattr(pkg, '__path__', []), top + '.'):
        if '.tests' in info.name or '.test_' in info.name: continue
        try: importlib.import_module(info.name)
        except Exception: pass
res = {'tables': [], 'methods': []}
for t in claims['tables']:
    c = load(t['module'], t['cls'])
    v = getattr(c, t['attr'], None) if c is not None else None
    if not isinstance(v, dict): res['tables'].append(None); continue
    res['tables'].append(sorted({name_of(k) for k in v.keys()}))
for m in claims['methods']:
    c = load(m['module'], m['cls'])
    if c is None or m['name'] not in c.__dict__: res['methods'].append(None); continue
    ov, inh = [], []
    for s in subclasses(c):
        if s.__module__.split('.')[0] in ('tests', 'test') or '.tests.' in s.__module__: continue
        # the class whose version s runs: the first in its MRO that defines the name
        owner = next((k for k in s.__mro__ if m['name'] in k.__dict__), None)
        if owner is c: inh.append(s.__name__)
        # the first redefinition below c (what the index lists; classes below it run that one)
        elif owner is s and any(next((k for k in b.__mro__ if m['name'] in k.__dict__), None) is c for b in s.__bases__): ov.append(s.__name__)
    res['methods'].append({'override': sorted(set(ov)), 'inherit': sorted(set(inh))})
# the classes the oracle can judge: those defined in a module it managed to import
tops = {c['module'].split('.')[0] for c in claims['tables'] + claims['methods']}
known = set()
for name, mod in list(sys.modules.items()):
    if mod is None or name.split('.')[0] not in tops: continue
    for v in list(vars(mod).values()):
        if inspect.isclass(v) and getattr(v, '__module__', '') == name: known.add(v.__name__)
res['known'] = sorted(known)
json.dump(res, sys.stdout)
`);
const run = spawnSync(python, [path.join(tmp, 'oracle.py'), path.join(tmp, 'claims.json')], { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20, env: { ...process.env, PYTHONPATH: root } });
fs.rmSync(tmp, { recursive: true, force: true });
if (run.status !== 0) throw new Error(run.stderr.slice(-2000));
const truth = JSON.parse(run.stdout);

// ── score ──────────────────────────────────────────────────────────────────────
const pr = (claimed, real) => { const R = new Set(real); const tp = claimed.filter(x => R.has(x)).length; return { tp, claimed: claimed.length, real: real.length }; };
const sum = (xs) => xs.reduce((a, x) => ({ tp: a.tp + x.tp, claimed: a.claimed + x.claimed, real: a.real + x.real }), { tp: 0, claimed: 0, real: 0 });
const tableScores = [], tableMiss = [];
claims.tables.forEach((t, i) => {
    const real = truth.tables[i];
    if (!real) return;
    const s = pr(t.keys, real); tableScores.push(s);
    if (s.tp < s.claimed) tableMiss.push(`${t.module}.${t.cls}.${t.attr}: claimed but absent ${t.keys.filter(k => !real.includes(k)).slice(0, 5).join(', ')}`);
});
// overrides: a subclass named as overriding (or as inheriting) is a claim; classes are compared by name
const ovS = [], inS = [], methodMiss = [];
const known = new Set(truth.known);
let unjudged = 0;
claims.methods.forEach((m, i) => {
    const real = truth.methods[i];
    if (!real) return;
    // classes the oracle could not import (examples, optional dependencies) cannot be judged
    const judge = (xs) => { const k = xs.filter(x => known.has(x)); unjudged += xs.length - k.length; return k; };
    const a = pr(judge(m.override), real.override), b = pr(judge(m.inherit), real.inherit);
    ovS.push(a); inS.push(b);
    if (a.tp < a.claimed || b.tp < b.claimed) methodMiss.push(`${m.module}.${m.cls}.${m.name}: override claimed ${m.override.filter(x => !real.override.includes(x)).join(',') || '-'} · inherit claimed ${m.inherit.filter(x => !real.inherit.includes(x)).slice(0, 6).join(',') || '-'}`);
});
const fmt = (s) => `precision ${(s.tp / Math.max(1, s.claimed)).toFixed(3)} (${s.tp}/${s.claimed}) · recall ${(s.tp / Math.max(1, s.real)).toFixed(3)} (${s.tp}/${s.real})`;
const T1 = sum(tableScores), O1 = sum(ovS), I1 = sum(inS);
console.log(`${root}`);
console.log(`tables (${tableScores.length} checked of ${claims.tables.length}): keys ${fmt(T1)}`);
console.log(`methods (${ovS.length} checked of ${claims.methods.length}): overriding subclasses ${fmt(O1)}`);
console.log(`  inheriting subclasses ${fmt(I1)}`);
console.log(`  (${unjudged} claimed subclasses not judged: their modules could not be imported)`);
for (const x of tableMiss.slice(0, 8)) console.log(`  table miss: ${x}`);
for (const x of methodMiss.slice(0, 8)) console.log(`  method miss: ${x}`);
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ tables: T1, overrides: O1, inherits: I1, tableMiss, methodMiss }, null, 2));
