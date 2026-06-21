#!/usr/bin/env node
/**
 * bench/_confidence.mjs [--md]
 *
 * Quantifies the statistical-power gain from the held-out expansion. For every
 * fixture it reads the v2 result cells (bench/results/<fixture>__<cfg>.json), takes
 * the held-out strict success@5 and the held-out query count n, and computes the
 * 95% Wilson score interval — the honest uncertainty band on a binomial proportion.
 *
 * It prints, per fixture, the L1 (default) and the best-measured config with their
 * held-out s@5 ± Wilson half-width at the NEW n, and — for contrast — the half-width
 * the SAME proportion would have carried at the old n=3. The shrinking band is the
 * whole point of the task: at n=3 the 95% Cn on any proportion spans ~±0.5; at n≈18
 * it is roughly ±0.2, so a real 0.2–0.33 difference becomes detectable.
 *
 * Reads only on-disk JSON — no ranking, no rebuild. Run after the grid.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RES = path.join(__dirname, 'results');
const Z = 1.96;

const FIXTURES = [
  'axios', 'express-js', 'nestjs', 'fastapi', 'gin', 'react', 'django', 'rust',
  'spring', 'android', 'aspnet', 'rails', 'laravel', 'symfony', 'css', 'cjson',
  'nvm', 'alamofire',
];
const ALL_CFGS = ['L1', 'E0', 'O0', 'O0H', 'O0R', 'O0HR', 'O2', 'O2H', 'R0', 'O2HR', 'R1', 'R2'];

/** Wilson 95% score interval for k successes in n trials. Returns {lo, hi, half, center}. */
function wilson(p, n) {
  if (!n) return { lo: 0, hi: 1, half: 0.5, center: 0.5 };
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin), half: margin, center };
}

function readCell(fx, cfg) {
  const p = path.join(RES, `${fx}__${cfg}.json`);
  if (!fs.existsSync(p)) return null;
  let j; try { j = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
  if (!j.ok) return null;
  const r = j.repeat;
  const h = j.eval?.heldOutAggregate;
  const heldS5 = r ? r.stable.heldS5 : (h?.strictSuccess?.[5] ?? null);
  const heldN = h?.queryCount ?? null;
  return heldS5 === null ? null : { cfg, heldS5, heldN };
}

const f2 = (x) => (x === null || x === undefined ? ' -- ' : x.toFixed(2));
const rows = [];
for (const fx of FIXTURES) {
  const cells = ALL_CFGS.map(c => readCell(fx, c)).filter(Boolean);
  if (!cells.length) { rows.push({ fx, missing: true }); continue; }
  const l1 = cells.find(c => c.cfg === 'L1') || cells[0];
  const best = [...cells].sort((a, b) => b.heldS5 - a.heldS5)[0];
  const n = l1.heldN;
  const wL1 = wilson(l1.heldS5, n);
  const wBest = wilson(best.heldS5, best.heldN);
  const wOld = wilson(l1.heldS5, 3); // same proportion, old n=3
  rows.push({ fx, n, l1: l1.heldS5, wL1, best: best.cfg, bestS5: best.heldS5, wBest, wOld });
}

let out = '';
const line = (s) => { out += s + '\n'; console.log(s); };
line('\n=== HELD-OUT statistical power: 95% Wilson CI, new n vs old n=3 ===\n');
line(['fixture'.padEnd(12), 'n'.padEnd(4), 'L1 s@5'.padEnd(8), '95% CI (new n)'.padEnd(18), '±half'.padEnd(7), '±half@n=3', '  best'].join(' '));
for (const r of rows) {
  if (r.missing) { line(`${r.fx.padEnd(12)} (no v2 cells yet)`); continue; }
  line([
    r.fx.padEnd(12), String(r.n).padEnd(4), f2(r.l1).padEnd(8),
    `[${f2(r.wL1.lo)}, ${f2(r.wL1.hi)}]`.padEnd(18),
    ('±' + f2(r.wL1.half)).padEnd(7),
    ('±' + f2(r.wOld.half)).padEnd(9),
    ` ${r.best} ${f2(r.bestS5)} [${f2(r.wBest.lo)},${f2(r.wBest.hi)}]`,
  ].join(' '));
}
const measured = rows.filter(r => !r.missing);
if (measured.length) {
  const meanN = (measured.reduce((a, r) => a + r.n, 0) / measured.length);
  const meanHalfNew = measured.reduce((a, r) => a + r.wL1.half, 0) / measured.length;
  const meanHalfOld = measured.reduce((a, r) => a + r.wOld.half, 0) / measured.length;
  line(`\nmean held n: 3.06 (old) → ${meanN.toFixed(1)} (new)`);
  line(`mean L1 95%-CI half-width: ±${meanHalfOld.toFixed(2)} (at n=3) → ±${meanHalfNew.toFixed(2)} (at new n) — ${Math.round((1 - meanHalfNew / meanHalfOld) * 100)}% tighter`);
}
if (process.argv.includes('--md')) {
  fs.writeFileSync(path.join(RES, '_confidence.md'), out);
  console.log('\n📄 wrote bench/results/_confidence.md');
}
