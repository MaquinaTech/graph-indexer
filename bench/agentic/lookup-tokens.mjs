#!/usr/bin/env node
/**
 * Tokens a session spends looking code up, from the transcripts of graded real-session rounds:
 * the text the main agent's reads (Read, cat/sed/head/…), searches (Grep, Glob, grep/rg/find/ls)
 * and graph-indexer answers (MCP tools or CLI) put into its context. Test runs, edits and the rest
 * are left out. Each arm is compared with `--baseline` on the tasks both ran:
 *
 *   lookup     tokens of those results (as they enter the context once)
 *   fixed      the context of the first model call (system prompt, tools, CLAUDE.md, instructions)
 *   input      every input token of the main agent (cache reads included)
 *   cost       dollars of the whole session
 *
 *   node bench/agentic/lookup-tokens.mjs --gi LABEL[,LABEL…] [--baseline cc] [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, readJsonl, WORK } from './lib.mjs';

const { opt, list } = argv();
const labels = list('--gi');
const baseline = opt('--baseline', 'cc');
const CHARS_PER_TOKEN = 2.63; // tool results (anatomy.mjs)
const GI = /(^|[\s/])(gi|graph-indexer(\.mjs)?)\s+\w/;
const strip = (c) => c.replace(/^\s*cd\s+\S+\s*&&\s*/, '');

function kindOf(name, input = {}) {
    if (name === 'Read') return /INSTRUCTIONS\.md$/.test(input.file_path ?? '') ? null : 'read';
    if (name === 'Grep' || name === 'Glob') return 'search';
    if (/^mcp__.*graph-indexer/.test(name)) return 'gi';
    if (name !== 'Bash') return null;
    const c = strip(input.command ?? '');
    if (GI.test(c)) return 'gi';
    if (/\b(go (build|vet|test)|tsc|tsdiag|pytest|npm (run )?test|jest|vitest)\b/.test(c)) return null;
    if (/^(ls|find|tree)\b/.test(c) || /\b(grep|rg|ag|ack)\b/.test(c)) return 'search';
    if (/^(cat|sed|head|tail|nl|awk)\b/.test(c)) return 'read';
    return null;
}
const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x.text ?? '').join('') : '');

const runs = [];
for (const label of labels) {
    const tsv = path.join(WORK, 'runs', label, 'agents.tsv');
    const agentOf = new Map(fs.readFileSync(tsv, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t')).map(([a, r]) => [r, a]));
    for (const r of readJsonl(path.join(WORK, 'results', `${label}.jsonl`))) {
        const a = agentOf.get(r.runId);
        const file = a && path.join(WORK, 'transcripts', label, a + '.jsonl');
        if (!file || !fs.existsSync(file)) continue;
        const kinds = new Map();
        const tok = { read: 0, search: 0, gi: 0 };
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            let d; try { d = JSON.parse(line); } catch { continue; }
            if (d.parent_tool_use_id) continue; // the main agent's context only
            const content = d.message?.content;
            if (!Array.isArray(content)) continue;
            if (d.type === 'assistant') for (const x of content) if (x.type === 'tool_use') kinds.set(x.id, kindOf(x.name, x.input));
            if (d.type === 'user') for (const x of content) if (x.type === 'tool_result' && kinds.get(x.tool_use_id)) tok[kinds.get(x.tool_use_id)] += text(x.content).length / CHARS_PER_TOKEN;
        }
        const u = r.agent?.session?.main?.usage ?? r.agent?.usage;
        runs.push({ label, task: r.taskId, family: r.family, arm: r.arm, solved: r.solved, ...tok, lookup: tok.read + tok.search + tok.gi,
            fixed: r.agent?.contextFirst ?? null, input: u ? u.input + u.cacheRead + u.cacheWrite : null, cost: r.agent?.costUsd ?? 0 });
    }
}

const key = (x) => `${x.label}|${x.task}`;
const mean = (xs, f) => xs.reduce((s, x) => s + f(x), 0) / Math.max(1, xs.length);
const out = {};
for (const family of [...new Set(runs.map(r => r.family))]) {
    const base = new Map(runs.filter(r => r.family === family && r.arm === baseline).map(r => [key(r), r]));
    out[family] = {};
    console.log(`\n${family}  (ratios to ${baseline} on the same tasks)`);
    console.log('arm            n  solved  lookup tok/run (read/search/gi)   lookup  fixed ctx  input   cost');
    for (const arm of [...new Set(runs.map(r => r.arm))]) {
        const xs = runs.filter(r => r.family === family && r.arm === arm && base.has(key(r)));
        if (!xs.length) continue;
        const bs = xs.map(x => base.get(key(x)));
        const ratio = (f) => mean(xs, f) / Math.max(1e-9, mean(bs, f));
        const row = { n: xs.length, solved: xs.filter(x => x.solved).length, lookup: mean(xs, x => x.lookup), read: mean(xs, x => x.read), search: mean(xs, x => x.search), gi: mean(xs, x => x.gi),
            fixed: mean(xs, x => x.fixed ?? 0), lookupRatio: ratio(x => x.lookup), fixedRatio: ratio(x => x.fixed ?? 0), inputRatio: ratio(x => x.input ?? 0), costRatio: ratio(x => x.cost) };
        out[family][arm] = row;
        console.log(`${arm.padEnd(13)} ${String(row.n).padStart(2)}  ${String(row.solved).padStart(6)}  ${String(Math.round(row.lookup)).padStart(6)} (${Math.round(row.read)}/${Math.round(row.search)}/${Math.round(row.gi)})`.padEnd(66)
            + `${row.lookupRatio.toFixed(2)}    ${Math.round(row.fixed)}  ${row.inputRatio.toFixed(2)}   ${row.costRatio.toFixed(2)}`);
    }
}
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(out, null, 2));
