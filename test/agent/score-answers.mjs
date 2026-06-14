#!/usr/bin/env node
/**
 * test/agent/score-answers.mjs
 *
 * Scores the CORRECTNESS of agent answers (the quality half of the
 * quality-vs-cost trade-off). Each benchmarked sub-agent writes its final
 * answers to test/agent/results/answers/<fixture>.json as { <task>: "answer" }.
 * We check, per task, what fraction of that task's `answerKeys` (the correct
 * symbols / files from benchmark.config.mjs) appear in the answer text.
 *
 * Usage: node test/agent/score-answers.mjs [--dir test/agent/results/answers] [--json]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BENCHMARKS } from './benchmark.config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const dirIdx = argv.indexOf('--dir');
const DIR = dirIdx >= 0 ? argv[dirIdx + 1] : path.join(HERE, 'results', 'answers');

const cfg = Object.fromEntries(BENCHMARKS.map(b => [b.fixture, b.tasks]));

function scoreAnswer(answer, keys) {
    // Agents sometimes write a structured value (object/array) instead of a string —
    // flatten any shape to searchable text.
    const text = typeof answer === 'string' ? answer : JSON.stringify(answer ?? '');
    const lc = text.toLowerCase();
    const hit = keys.filter(k => lc.includes(String(k).toLowerCase()));
    return { hit: hit.length, total: keys.length, missing: keys.filter(k => !lc.includes(String(k).toLowerCase())) };
}

if (!fs.existsSync(DIR)) { process.stderr.write(`no answers dir: ${DIR}\n`); process.exit(1); }
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
const report = [];
for (const f of files) {
    const fixture = f.replace(/\.json$/, '');
    const tasks = cfg[fixture]; if (!tasks) continue;
    let answers = {};
    try { answers = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8')); } catch { continue; }
    const perTask = {};
    for (const [task, t] of Object.entries(tasks)) {
        if (!(task in answers)) { perTask[task] = { hit: 0, total: t.answerKeys.length, missing: t.answerKeys, answered: false }; continue; }
        perTask[task] = { ...scoreAnswer(answers[task], t.answerKeys), answered: true };
    }
    report.push({ fixture, perTask });
}

if (asJson) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exit(0); }

let totHit = 0, totKeys = 0, answered = 0, totalTasks = 0;
for (const { fixture, perTask } of report) {
    console.log(`▸ ${fixture}`);
    for (const [task, s] of Object.entries(perTask)) {
        totalTasks++; if (s.answered) answered++;
        totHit += s.hit; totKeys += s.total;
        const bar = s.answered ? `${s.hit}/${s.total}` : 'NO ANSWER';
        console.log(`   ${task.padEnd(10)} keys ${bar}${s.missing.length ? `  (missing: ${s.missing.join(', ')})` : ''}`);
    }
}
console.log(`\n${'═'.repeat(56)}`);
console.log(`ANSWER QUALITY: ${answered}/${totalTasks} tasks answered · ` +
    `${totHit}/${totKeys} answer-keys covered (${(100 * totHit / (totKeys || 1)).toFixed(0)}%)`);
