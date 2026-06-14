#!/usr/bin/env node
/**
 * test/agent/parse-eval.mjs — print the headline retrieval metrics from an
 * evaluate.mjs --json report (or the newest report in test/reports). Keeps the
 * weight/rerank sweeps readable: one line of the numbers that matter for the
 * semantic-precision goal, plus the symbolic channel as a regression guard.
 *
 * Usage: node test/agent/parse-eval.mjs [report.json] [--label "tag"]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS = path.join(HERE, '..', 'reports');
const argv = process.argv.slice(2);
const label = argv.includes('--label') ? argv[argv.indexOf('--label') + 1] : '';
let file = argv.find(a => a.endsWith('.json'));
if (!file) {
    const reports = fs.readdirSync(REPORTS).filter(f => f.startsWith('eval-') && f.endsWith('.json'))
        .map(f => path.join(REPORTS, f)).sort();
    file = reports[reports.length - 1];
}
const { results } = JSON.parse(fs.readFileSync(file, 'utf-8'));
const ok = results.filter(r => !r.error);
const rows = ok.flatMap(r => r.rows || []);
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

const sem = rows.filter(r => r.difficulty === 'semantic');
const sym = rows.filter(r => r.difficulty !== 'semantic');
const overallS5 = mean(ok.map(r => r.aggregate.strictSuccess[5]));
const overallMRR = mean(ok.map(r => r.aggregate.mrrStrict));

const f = (x) => x.toFixed(3);
console.log(
    `${(label || path.basename(file)).padEnd(26)} | ` +
    `overall s@5 ${f(overallS5)} MRR ${f(overallMRR)} | ` +
    `SEM s@5 ${f(mean(sem.map(r => r.strictSuccess[5])))} ` +
    `MRR ${f(mean(sem.map(r => r.mrrStrict)))} ` +
    `r1 ${f(mean(sem.map(r => r.rank1Strict)))} | ` +
    `sym MRR ${f(mean(sym.map(r => r.mrrStrict)))} r1 ${f(mean(sym.map(r => r.rank1Strict)))}`
);
