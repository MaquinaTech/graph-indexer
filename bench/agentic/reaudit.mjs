#!/usr/bin/env node
/**
 * Re-read the transcripts of graded runs with the current audit rules (tool policy, leaks, call
 * counts) without grading them again: the checks' outcome does not change, the audit may.
 *
 *   node bench/agentic/reaudit.mjs --gi LABEL[,LABEL…] [--transcripts DIR] [--dry-run]
 *
 * For each run, the graded transcript is the last registered agent whose transcript ended before
 * the grading. Changed runs get a new result row (same gradedAt, plus reauditedAt). With --usage the
 * token usage, cost and timing fields are recomputed too (e.g. after a change in how output tokens are
 * recovered from a transcript).
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, readJsonl, WORK } from './lib.mjs';
import { parseTranscript } from './transcript.mjs';

const { opt, list, flag } = argv();
const dir = opt('--transcripts', process.env.GI_TRANSCRIPTS);
if (!dir) throw new Error('--transcripts DIR (or GI_TRANSCRIPTS) is required');

function lastEventAt(file) {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) { try { const t = JSON.parse(lines[i]).timestamp; if (t) return t; } catch { /* partial */ } }
    return null;
}

for (const label of list('--gi')) {
    const resFile = path.join(WORK, 'results', `${label}.jsonl`);
    const latest = new Map(readJsonl(resFile).map(r => [r.runId, r]));
    const tsv = path.join(WORK, 'runs', label, 'agents.tsv');
    const agentsOf = new Map();
    for (const l of fs.readFileSync(tsv, 'utf8').split('\n').filter(Boolean)) { const [a, run] = l.split('\t'); (agentsOf.get(run) ?? agentsOf.set(run, []).get(run)).push(a); }
    let changed = 0;
    for (const [run, row] of latest) {
        if (!row.agent) continue;
        const transcript = (agentsOf.get(run) ?? []).map(a => ['.output', '.jsonl'].map(e => path.join(dir, a + e)).find(f => fs.existsSync(f)))
            .filter(Boolean).filter(f => (lastEventAt(f) ?? '') <= row.gradedAt).at(-1);
        if (!transcript) continue;
        const meta = JSON.parse(fs.readFileSync(path.join(WORK, 'runs', label, run, 'meta.json'), 'utf8'));
        const a = parseTranscript(transcript, { arm: row.arm, repo: meta.checkout, own: [meta.runDir, meta.checkout], work: WORK });
        const keys = ['violations', 'benign', 'leaks', 'giCalls', 'grepCalls',
            ...(flag('--usage') ? ['usage', 'costUnits', 'outputRecorded', 'firstEditTurn', 'modelMs', 'toolMs'] : [])];
        // rows graded before a field existed lack it: that alone is not a change
        if (keys.every(k => JSON.stringify(a[k]) === JSON.stringify(row.agent[k] ?? (Array.isArray(a[k]) ? [] : a[k])))) continue;
        changed++;
        console.log(`${label} ${run}: violations ${row.agent.violations.length}→${a.violations.length}, leaks ${row.agent.leaks?.length ?? 0}→${a.leaks.length}, gi ${row.agent.giCalls}→${a.giCalls}, grep ${row.agent.grepCalls}→${a.grepCalls}, cost ${row.agent.costUnits}→${a.costUnits}`);
        if (!flag('--dry-run')) fs.appendFileSync(resFile, JSON.stringify({ ...row, agent: { ...row.agent, ...Object.fromEntries(keys.map(k => [k, a[k]])) }, reauditedAt: new Date().toISOString() }) + '\n');
    }
    console.log(`${label}: ${changed} run(s) ${flag('--dry-run') ? 'would change' : 'updated'}`);
}
