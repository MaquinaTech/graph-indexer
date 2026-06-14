#!/usr/bin/env node
// se-mrr.mjs <search-eval.json> [label] — print semantic MRR + by-kind for a
// search-eval --json report (my-harness). Keeps the weight sweeps readable.
import fs from 'fs';
const file = process.argv[2];
const label = process.argv[3] || file;
const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
const mrr = (r) => r.length ? r.reduce((s, x) => s + (x > 0 ? 1 / x : 0), 0) / r.length : 0;
const hit = (r, k) => r.filter(x => x > 0 && x <= k).length;
const sem = [], lex = [], byk = {};
for (const fx of d) {
    for (const S of fx.sem) { sem.push(S.rank); (byk[S.kind] ||= []).push(S.rank); }
    for (const L of fx.lex) lex.push(L.rank);
}
const bk = ['nl', 'kw', 'xc'].map(k => `${k} ${mrr(byk[k] || []).toFixed(3)}`).join(' ');
console.log(`${label.padEnd(24)} | SEM MRR ${mrr(sem).toFixed(3)} hit@1 ${hit(sem,1)} hit@3 ${hit(sem,3)} | ${bk} | lex ${mrr(lex).toFixed(3)}`);
