#!/usr/bin/env node
/**
 * Aggregate graded runs into comparison tables.
 *
 *   node bench/agentic/report.mjs --gi LABEL[,LABEL…] [--baseline grep] [--integrated grep+gi+] [--nogrep gi]
 *                                 [--family qa|refactor|fresh] [--tasks ID,ID|file.json] [--json out.json] [--md out.md]
 *
 * Per arm: runs, solve rate (Wilson 95% CI), mean score (F1 for questions, share of checks passed
 * for edits), and median/mean agent cost (input-equivalent tokens), turns, tool calls and wall
 * time. Each arm is then compared with the baseline arm task by task (runs of a task are averaged
 * first): difference in solve rate and score with a bootstrap 95% CI and an exact McNemar /
 * sign-flip p-value, and the cost ratio with its CI. Runs that broke their arm's tool policy are
 * listed and kept (intention to treat); --exclude-violations drops them as a sensitivity check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, readJsonl, loadTasks, WORK } from './lib.mjs';
import { compare, wilson, mean, median, holm, bootstrap } from './stats.mjs';

const { opt, list, flag } = argv();
const labels = list('--gi');
const baseline = opt('--baseline', 'grep');
// the arms the SOTA gates compare with the baseline: graph-indexer integrated with grep, and without grep
const integrated = opt('--integrated', 'grep+gi+');
const nogrep = opt('--nogrep', 'gi');
const family = opt('--family', null);

let rows = labels.flatMap(l => readJsonl(path.join(WORK, 'results', `${l}.jsonl`)));
// gradings made before a run was discarded (runs/<label>/discarded.tsv: run id, time, reason) are void
const discardedAt = new Map(labels.flatMap(l => {
    const f = path.join(WORK, 'runs', l, 'discarded.tsv');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(line => { const [run, at] = line.split('\t'); return [`${l}|${run}`, at]; }) : [];
}));
rows = rows.filter(r => !(discardedAt.get(`${r.giLabel}|${r.runId}`) >= r.gradedAt));
// keep the latest grading of each run
rows = [...new Map(rows.map(r => [`${r.giLabel}|${r.runId}`, r])).values()];
if (family) rows = rows.filter(r => (r.family === 'qa' ? 'qa' : r.kind === 'fresh' ? 'fresh' : 'refactor') === family);
if (opt('--tasks')) {
    const spec = opt('--tasks');
    const ids = new Set(spec.endsWith('.json') ? loadTasks().filter(t => t._file === path.basename(spec)).map(t => t.id) : spec.split(','));
    rows = rows.filter(r => ids.has(r.taskId));
}
// dry runs (rep 0, graded without an agent) are harness checks, not observations
rows = rows.filter(r => r.agent && (r.rep ?? 1) >= 1);
// runs that looked the answer up outside the repository (web, upstream fetch, task files) are invalid
const leaked = rows.filter(r => r.agent?.leaks?.length);
rows = rows.filter(r => !r.agent?.leaks?.length);
// intention-to-treat: runs that broke their arm's tool policy stay in (dropping them would bias
// the arm towards the runs that happened to comply); --exclude-violations is the sensitivity check
const violating = rows.filter(r => r.agent?.violations?.length);
if (flag('--exclude-violations')) rows = rows.filter(r => !r.agent?.violations?.length);

const arms = [...new Set(rows.map(r => r.arm))].sort((a, b) => (a === baseline ? -1 : b === baseline ? 1 : a.localeCompare(b)));
const fmt = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '–';
const pct = (x) => Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : '–';
const k = (x) => Number.isFinite(x) ? `${(x / 1000).toFixed(0)}k` : '–';

function byTask(rs, f) {
    const m = new Map();
    for (const r of rs) { const v = f(r); if (v === null || v === undefined || !Number.isFinite(v)) continue; (m.get(r.taskId) ?? m.set(r.taskId, []).get(r.taskId)).push(v); }
    return m;
}

const out = [];
const json = { labels, baseline, arms: {}, comparisons: {} };
// task groups: B1 questions, B2 compiler-graded multi-site refactors, B3 fresh issues with hidden tests
const GROUP_TITLES = { qa: 'B1 · code questions (call sites, callers, implementations)', refactor: 'B2 · multi-site refactors (compiler-graded)', fresh: 'B3 · fresh issues after the training cutoff (hidden tests)' };
const groupOf = (r) => (r.family === 'qa' ? 'qa' : r.kind === 'fresh' ? 'fresh' : 'refactor');
for (const r of rows) r.group = groupOf(r);
const groups = family ? [family] : ['qa', 'refactor', 'fresh'].filter(g => rows.some(r => r.group === g));
for (const fam of groups) {
    const rs = rows.filter(r => r.group === fam);
    const tasks = new Set(rs.map(r => r.taskId));
    out.push(`\n### ${GROUP_TITLES[fam] ?? fam} — ${tasks.size} tasks, labels ${labels.join(', ')}\n`);
    out.push('| arm | runs | solved | 95% CI | mean score | median cost | mean cost | turns | tool calls | gi calls | grep calls | wall (s) |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const a of arms) {
        const x = rs.filter(r => r.arm === a);
        if (!x.length) continue;
        const solved = x.filter(r => r.solved).length;
        const [lo, hi] = wilson(solved, x.length);
        const cost = x.map(r => r.agent?.costUnits).filter(Number.isFinite);
        const row = {
            runs: x.length, solved: solved / x.length, ci: [lo, hi], score: mean(x.map(r => r.score ?? 0)),
            costMedian: median(cost), costMean: mean(cost),
            turns: mean(x.map(r => r.agent?.turns).filter(Number.isFinite)),
            tools: mean(x.map(r => r.agent?.toolCalls).filter(Number.isFinite)),
            gi: mean(x.map(r => r.agent?.giCalls).filter(Number.isFinite)),
            grep: mean(x.map(r => r.agent?.grepCalls).filter(Number.isFinite)),
            wall: mean(x.map(r => r.agent?.wallMs).filter(Number.isFinite)) / 1000,
        };
        (json.arms[fam] ??= {})[a] = row;
        out.push(`| ${a} | ${row.runs} | ${pct(row.solved)} | ${pct(lo)}–${pct(hi)} | ${fmt(row.score)} | ${k(row.costMedian)} | ${k(row.costMean)} | ${fmt(row.turns, 1)} | ${fmt(row.tools, 1)} | ${fmt(row.gi, 1)} | ${fmt(row.grep, 1)} | ${fmt(row.wall, 0)} |`);
    }
    const base = rs.filter(r => r.arm === baseline);
    if (!base.length) continue;
    const cmp = [];
    for (const a of arms.filter(x => x !== baseline)) {
        const x = rs.filter(r => r.arm === a);
        const solved = compare(byTask(base, r => r.solved ? 1 : 0), byTask(x, r => r.solved ? 1 : 0), { kind: 'binary' });
        const score = compare(byTask(base, r => r.score ?? 0), byTask(x, r => r.score ?? 0));
        const cost = compare(byTask(base, r => r.agent?.costUnits), byTask(x, r => r.agent?.costUnits), { ratio: true });
        const calls = compare(byTask(base, r => r.agent?.toolCalls), byTask(x, r => r.agent?.toolCalls), { ratio: true });
        const wall = compare(byTask(base, r => r.agent?.wallMs), byTask(x, r => r.agent?.wallMs), { ratio: true });
        cmp.push({ arm: a, solved, score, cost, calls, wall });
    }
    const adj = holm(cmp.map(c => c.solved.p));
    const adjScore = holm(cmp.map(c => c.score.p));
    out.push(`\nPaired by task against \`${baseline}\` (bootstrap 95% CI; p: exact McNemar for solved, sign-flip for the rest; Holm-adjusted across arms):\n`);
    out.push('| arm | tasks | Δ solved | CI | p | Δ score | CI | p | cost ratio | CI | tool-call ratio | wall ratio |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    cmp.forEach((c, i) => {
        (json.comparisons[fam] ??= {})[c.arm] = c;
        out.push(`| ${c.arm} | ${c.solved.n} | ${fmt(100 * c.solved.diff.est, 0)} pts | ${fmt(100 * c.solved.diff.lo, 0)}…${fmt(100 * c.solved.diff.hi, 0)} | ${fmt(adj[i], 3)} | ${fmt(c.score.diff.est)} | ${fmt(c.score.diff.lo)}…${fmt(c.score.diff.hi)} | ${fmt(adjScore[i], 3)} | ${fmt(c.cost.ratio?.est)} | ${fmt(c.cost.ratio?.lo)}…${fmt(c.cost.ratio?.hi)} | ${fmt(c.calls.ratio?.est)} | ${fmt(c.wall.ratio?.est)} |`);
    });
    // per-task detail
    out.push(`\nPer task (mean score / mean cost in k):\n`);
    out.push(`| task | ${arms.join(' | ')} |`);
    out.push(`|---|${arms.map(() => '---').join('|')}|`);
    for (const t of [...tasks].sort()) {
        const cells = arms.map(a => { const x = rs.filter(r => r.taskId === t && r.arm === a); return x.length ? `${fmt(mean(x.map(r => r.score ?? 0)))} / ${k(mean(x.map(r => r.agent?.costUnits).filter(Number.isFinite)))}` : '–'; });
        out.push(`| ${t} | ${cells.join(' | ')} |`);
    }
}
// ── SOTA gates (docs/PLAN-SOTA.md) ─────────────────────────────────────────────
const taskInfo = new Map(loadTasks().map(t => [t.id, t]));
/** Simple tasks: a fresh issue fixed in one file with a small patch (localisation is easy). */
const isSimple = (id) => { const t = taskInfo.get(id); return t?.kind === 'fresh' && t.gold?.files?.length === 1 && (t.gold.patch ?? '').split('\n').length <= 40; };
/** Paired over tasks: (Σcost / Σsolved) of arm b divided by that of arm a, bootstrap CI over tasks. */
function costPerSolved(rs, a, b) {
    const per = new Map();
    for (const r of rs) {
        if (r.arm !== a && r.arm !== b) continue;
        const e = per.get(r.taskId) ?? per.set(r.taskId, { a: [], b: [] }).get(r.taskId);
        e[r.arm === a ? 'a' : 'b'].push(r);
    }
    const pairs = [...per.values()].filter(e => e.a.length && e.b.length);
    const cps = (list) => { const cost = list.reduce((x, r) => x + (r.agent?.costUnits ?? 0), 0), solved = list.filter(r => r.solved).length; return solved ? cost / solved : NaN; };
    const stat = (ps) => cps(ps.flatMap(p => p.b)) / cps(ps.flatMap(p => p.a));
    return { n: pairs.length, ...bootstrap(pairs, stat) };
}
function gate(name, rs, a, b) {
    const sel = rs.filter(r => r.arm === a || r.arm === b);
    const solved = compare(byTask(sel.filter(r => r.arm === a), r => r.solved ? 1 : 0), byTask(sel.filter(r => r.arm === b), r => r.solved ? 1 : 0), { kind: 'binary' });
    const cost = compare(byTask(sel.filter(r => r.arm === a), r => r.agent?.costUnits), byTask(sel.filter(r => r.arm === b), r => r.agent?.costUnits), { ratio: true });
    return { name, tasks: solved.n, solved, cost, cps: costPerSolved(sel, a, b) };
}
if (!family && arms.includes(baseline)) {
    const multi = rows.filter(r => r.group === 'qa' || r.group === 'refactor');
    const simple = rows.filter(r => isSimple(r.taskId));
    const g = {
        G1: gate(`G1 multi-site & impact tasks (B1+B2): ${integrated} vs ${baseline}`, multi, baseline, integrated),
        G2: gate(`G2 all tasks: ${integrated} vs ${baseline}`, rows, baseline, integrated),
        G3: gate(`G3 all tasks: ${nogrep} (no grep) vs ${baseline}`, rows, baseline, nogrep),
        G4: gate(`G4 simple tasks (one-file fixes): ${integrated} vs ${baseline}`, simple, baseline, integrated),
    };
    const pts = (x) => `${fmt(100 * x, 0)}`;
    const verdict = {
        G1: g.G1.tasks && (g.G1.solved.diff.lo * 100 >= 0 && g.G1.solved.diff.est * 100 >= 10 || (g.G1.solved.diff.lo * 100 >= -3 && g.G1.cps.est <= 0.75)),
        G2: g.G2.tasks && g.G2.solved.diff.lo * 100 >= -3 && g.G2.cps.est <= 0.85,
        G3: g.G3.tasks && g.G3.solved.diff.lo * 100 >= -5 && g.G3.cost.ratio.est <= 1.0,
        G4: g.G4.tasks && g.G4.cost.ratio.est <= 1.10,
    };
    const adoptRuns = multi.filter(r => r.arm === integrated);
    const adoption = adoptRuns.length ? adoptRuns.filter(r => (r.agent?.giCalls ?? 0) > 0).length / adoptRuns.length : NaN;
    out.push(`\n### SOTA gates (docs/PLAN-SOTA.md)\n`);
    out.push('| gate | tasks | Δ solved (95% CI) | cost ratio (95% CI) | cost per solved task (95% CI) | target | met |');
    out.push('|---|---|---|---|---|---|---|');
    const target = { G1: '+10 pts (CI > 0), or ≥ −3 pts with cost/solved ≤ 0.75', G2: 'Δ ≥ −3 pts (CI) and cost/solved ≤ 0.85', G3: 'Δ ≥ −5 pts (CI) and cost ratio ≤ 1', G4: 'cost ratio ≤ 1.10' };
    for (const [k, v] of Object.entries(g)) {
        out.push(`| ${v.name} | ${v.tasks} | ${pts(v.solved.diff.est)} (${pts(v.solved.diff.lo)}…${pts(v.solved.diff.hi)}) | ${fmt(v.cost.ratio?.est)} (${fmt(v.cost.ratio?.lo)}…${fmt(v.cost.ratio?.hi)}) | ${fmt(v.cps.est)} (${fmt(v.cps.lo)}…${fmt(v.cps.hi)}) | ${target[k]} | ${v.tasks ? (verdict[k] ? 'yes' : 'no') : '–'} |`);
    }
    out.push(`| G6 adoption: ${integrated} runs on B1+B2 that used graph-indexer | ${adoptRuns.length} runs | | | | ≥ 80% | ${Number.isFinite(adoption) ? `${pct(adoption)} → ${adoption >= 0.8 ? 'yes' : 'no'}` : '–'} |`);
    out.push('\nG5 (graph accuracy against the TypeScript compiler) is measured by `node bench/eval-graph.mjs`, not by agent runs.');
    json.gates = { ...g, verdict, adoption };
}
if (leaked.length) out.push(`\nExcluded — the agent looked the answer up outside the repository (${leaked.length}): ${leaked.map(r => `${r.runId} (${r.agent.leaks.slice(0, 1).map(v => v.slice(0, 80)).join('')})`).join(', ')}`);
if (violating.length) {
    out.push(`\nRuns that broke their arm's tool policy (${violating.length}, ${flag('--exclude-violations') ? 'excluded' : 'included — intention to treat'}): ${violating.map(r => `${r.runId} (${r.agent.violations.slice(0, 2).map(v => v.slice(0, 90)).join('; ')})`).join(', ')}`);
}
const text = out.join('\n');
console.log(text);
if (opt('--md')) fs.writeFileSync(opt('--md'), text + '\n');
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(json, null, 2));
