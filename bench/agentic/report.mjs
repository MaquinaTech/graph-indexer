#!/usr/bin/env node
/**
 * Aggregate graded runs into comparison tables.
 *
 *   node bench/agentic/report.mjs --gi LABEL[,LABEL…] [--baseline grep] [--family qa|edit] [--json out.json] [--md out.md]
 *
 * Per arm: runs, solve rate (Wilson 95% CI), mean score (F1 for questions, share of checks passed
 * for edits), and median/mean agent cost (input-equivalent tokens), turns, tool calls and wall
 * time. Each arm is then compared with the baseline arm task by task (runs of a task are averaged
 * first): difference in solve rate and score with a bootstrap 95% CI and an exact McNemar /
 * sign-flip p-value, and the cost ratio with its CI. Runs with tool-policy violations are listed
 * and excluded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, readJsonl, WORK } from './lib.mjs';
import { compare, wilson, mean, median, holm } from './stats.mjs';

const { opt, list } = argv();
const labels = list('--gi');
const baseline = opt('--baseline', 'grep');
const family = opt('--family', null);

let rows = labels.flatMap(l => readJsonl(path.join(WORK, 'results', `${l}.jsonl`)));
// keep the latest grading of each run
rows = [...new Map(rows.map(r => [`${r.giLabel}|${r.runId}`, r])).values()];
if (family) rows = rows.filter(r => r.family === family);
const violating = rows.filter(r => r.agent?.violations?.length);
rows = rows.filter(r => !r.agent?.violations?.length);

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
const groups = family ? [family] : [...new Set(rows.map(r => r.family))];
for (const fam of groups) {
    const rs = rows.filter(r => r.family === fam);
    const tasks = new Set(rs.map(r => r.taskId));
    out.push(`\n### ${fam === 'qa' ? 'Code questions' : 'Code changes'} — ${tasks.size} tasks, labels ${labels.join(', ')}\n`);
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
if (violating.length) {
    out.push(`\nExcluded for tool-policy violations (${violating.length}): ${violating.map(r => `${r.runId} (${r.agent.violations.slice(0, 2).join('; ')})`).join(', ')}`);
}
const text = out.join('\n');
console.log(text);
if (opt('--md')) fs.writeFileSync(opt('--md'), text + '\n');
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(json, null, 2));
