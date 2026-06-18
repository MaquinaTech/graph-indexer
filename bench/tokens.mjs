#!/usr/bin/env node
/**
 * bench/tokens.mjs <fixture...> — token footprint of search_code vs naive readFile.
 *
 * For each ground-truth query: rank top-5 (lexical L1), then compute the token
 * cost of the top-5 chunk payloads vs reading the full source files they live in
 * (the naive "open the files grep would point you at" baseline), and the honest
 * amortized cost (net of ONE get_chunk full-body expansion). Per-task, NOT
 * session-amortized. Reads whatever index exists; run AFTER the matrix.
 * Writes bench/results/tokens.json.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { artifactPaths } from '../layout.mjs';
import { MemoryGraphIndex } from '../core-engine.mjs';
import { computeTokenSavings, amortizedTokenSavings, mean } from '../test/metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(__dirname, 'results', 'tokens.json');
const prior = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, 'utf8')) : {};

for (const fx of process.argv.slice(2)) {
    const dir = path.join(ROOT, 'test', 'fixtures', fx);
    const A = artifactPaths(dir);
    if (!fs.existsSync(A.indexPath)) { console.log(`${fx}: no index — skip`); continue; }
    let queries = [];
    try { queries = (await import(`../test/suites/${fx}.mjs`)).QUERIES || []; } catch { console.log(`${fx}: no suite — skip`); continue; }
    const db = new MemoryGraphIndex(A.indexPath); db.load();

    const sav = [], amort = [];
    for (const q of queries) {
        const res = db.searchHybrid(q.query, null, Math.max(q.topK ?? 10, 5)).slice(0, 5);
        const s = computeTokenSavings(res, dir);
        const a = amortizedTokenSavings(res, dir);
        sav.push(s.savingsPct); amort.push(a.savingsPct);
    }
    prior[fx] = {
        queries: queries.length,
        avgSavingsPct: +mean(sav).toFixed(1),
        avgAmortizedSavingsPct: +mean(amort).toFixed(1),
    };
    console.log(`${fx.padEnd(12)} top-5 vs full-file: ${prior[fx].avgSavingsPct}% saved · amortized (net 1 get_chunk): ${prior[fx].avgAmortizedSavingsPct}%`);
}
fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
fs.writeFileSync(RESULTS, JSON.stringify(prior, null, 2));
