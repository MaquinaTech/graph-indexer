#!/usr/bin/env node
/**
 * Grade finished agent runs by agent id: looks each id up in runs/<label>/agents.tsv (agent id →
 * run id, one pair per line, written when the agent is launched) and grades the run with the
 * agent's transcript from the transcripts directory (<dir>/<agent id>.output or .jsonl).
 *
 *   node bench/agentic/grade-batch.mjs --gi LABEL --agents id1,id2 [--transcripts DIR]
 *   node bench/agentic/grade-batch.mjs --gi LABEL --register "agentId runId" ...   append pairs to agents.tsv
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, WORK } from './lib.mjs';
import { gradeRun } from './grade.mjs';

const { opt, list, args, flag } = argv();

/**
 * Has the agent finished? Its transcript must end with an assistant message that asks for no
 * tool, and must not have changed for a minute. Grading applies the hidden tests to the checkout,
 * so grading a run that is still going would hand the agent the tests.
 */
function finished(transcript) {
    const lines = fs.readFileSync(transcript, 'utf8').trim().split('\n');
    let last = null;
    for (let i = lines.length - 1; i >= 0 && !last; i--) {
        try { const e = JSON.parse(lines[i]); if (e.type === 'assistant' || e.type === 'user') last = e; } catch { /* partial line */ }
    }
    const content = Array.isArray(last?.message?.content) ? last.message.content : [];
    const quiet = Date.now() - fs.statSync(transcript).mtimeMs > 60_000;
    return last?.type === 'assistant' && !content.some(c => c.type === 'tool_use') && quiet;
}
const label = opt('--gi');
if (!label) throw new Error('--gi LABEL is required');
const tsv = path.join(WORK, 'runs', label, 'agents.tsv');

if (args.includes('--register')) {
    const pairs = args.slice(args.indexOf('--register') + 1).filter(a => !a.startsWith('--'));
    fs.mkdirSync(path.dirname(tsv), { recursive: true });
    for (const p of pairs) {
        const [agent, run] = p.trim().split(/\s+/);
        if (!agent || !run) throw new Error(`bad pair "${p}"`);
        if (!fs.existsSync(path.join(WORK, 'runs', label, run, 'meta.json'))) throw new Error(`no prepared run ${run}`);
        fs.appendFileSync(tsv, `${agent}\t${run}\n`);
    }
    console.log(`registered ${pairs.length}`);
} else {
    const dir = opt('--transcripts', process.env.GI_TRANSCRIPTS);
    if (!dir) throw new Error('--transcripts DIR (or GI_TRANSCRIPTS) is required');
    const map = new Map(fs.readFileSync(tsv, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t')));
    for (const agent of list('--agents')) {
        const run = map.get(agent);
        if (!run) { console.log(`${agent}: not registered`); continue; }
        const transcript = ['.output', '.jsonl'].map(e => path.join(dir, agent + e)).find(f => fs.existsSync(f));
        if (transcript && !flag('--force') && !finished(transcript)) { console.log(`${run}: agent still running (or stopped less than a minute ago) — not graded`); continue; }
        try {
            const r = gradeRun(label, run, transcript);
            const a = r.agent;
            console.log(`${run}: ${r.solved ? 'SOLVED' : 'not solved'} score=${(r.score ?? 0).toFixed(2)}` +
                (a ? ` turns=${a.turns} tools=${a.toolCalls} gi=${a.giCalls} grep=${a.grepCalls} cost=${Math.round(a.costUnits / 1000)}k wall=${Math.round((a.wallMs ?? 0) / 1000)}s${a.violations.length ? ` VIOLATIONS=${a.violations.length}` : ''}` : ' (no transcript)'));
        } catch (e) { console.log(`${run}: grading failed: ${e.message.slice(0, 200)}`); }
    }
}
