#!/usr/bin/env node
/**
 * bench/synth-best.mjs
 *
 * Reads every bench/results/<fixture>__<config>.json and, per fixture, selects the
 * BEST achievable config on the HELD-OUT strict metric (success@5, tie-broken by
 * held-out MRR, then by COST — the cheaper/lexical config wins a genuine tie). This
 * is the single source of truth for the README per-fixture table, the framework
 * prompts, and BENCH_PER_FIXTURE.md — every number printed here traces to a result
 * JSON on disk (no hand-edited values).
 *
 * For nondeterministic configs (HyDE / rerank) the metric used is the STABLE
 * (median) value across the 3× repeats, with the rank-1 min–max spread carried
 * through so the docs can show the range instead of a lucky single draw.
 *
 *   node bench/synth-best.mjs            # print matrix + winners to stdout
 *   node bench/synth-best.mjs --json     # also write bench/results/_best-config-matrix.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RES = path.join(__dirname, 'results');

// Cost rank — lower is cheaper; wins genuine held-out ties. Lexical first, then the
// query-time stacks ordered by added latency, then the index-time enrichment builds.
const COST = { L1: 0, E0: 1, O0: 2, O0H: 3, O0R: 4, O0HR: 5, O2: 6, O2H: 7, R0: 8, O2HR: 9, R1: 10, R2: 11, E1: 99 };
const LABEL = {
    L1: 'lexical + stemming (default)', E0: 'in-process MiniLM', O0: 'Ollama nomic-embed-text',
    O0H: 'nomic + HyDE', O0R: 'nomic + rerank', O0HR: 'nomic + HyDE + rerank',
    O2: 'Ollama qwen3-embedding:4b', O2H: 'qwen3 + HyDE', R0: 'qwen3 + rerank',
    O2HR: 'qwen3 + HyDE + rerank', R1: 'qwen3 + enrichment', R2: 'qwen3 + enrichment + rerank', E1: 'jina (blocked)',
};
const CHEAP = new Set(['L1', 'E0', 'O0']);
const NONDET = new Set(['O0H', 'O0R', 'O0HR', 'O2H', 'R0', 'O2HR', 'R2']);

// 18 measured fixtures (express-ts excluded — upstream repo 404, see notes).
const FIXTURES = [
    'axios', 'express-js', 'nestjs', 'fastapi', 'gin', 'react', 'django', 'rust',
    'spring', 'android', 'aspnet', 'rails', 'laravel', 'symfony', 'css', 'cjson',
    'nvm', 'alamofire',
];
const LANG = {
    axios: 'JavaScript', 'express-js': 'JavaScript', nestjs: 'TypeScript', fastapi: 'Python',
    gin: 'Go', react: 'TS/React', django: 'Python/Django', rust: 'Rust', spring: 'Java/Spring',
    android: 'Kotlin/Android', aspnet: 'C#/ASP.NET', rails: 'Ruby/Rails', laravel: 'PHP/Laravel',
    symfony: 'PHP/Symfony', css: 'SCSS', cjson: 'C', nvm: 'Bash', alamofire: 'Swift',
};

function readCell(fixture, cfg) {
    const p = path.join(RES, `${fixture}__${cfg}.json`);
    if (!fs.existsSync(p)) return null;
    let j; try { j = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
    if (!j.ok) return { cfg, ok: false, reason: j.reason || 'not ok' };
    const a = j.eval?.aggregate, h = j.eval?.heldOutAggregate, r = j.repeat;
    // Stable (median) values for nondeterministic cells; single value otherwise.
    const heldS5 = r ? r.stable.heldS5 : (h?.strictSuccess?.[5] ?? null);
    const heldR1 = r ? r.stable.heldR1 : (h?.rank1Strict ?? null);
    const heldMrr = r ? r.stable.heldMrr : (h?.mrrStrict ?? null);
    const tunS5 = r ? r.stable.tuningS5 : (a?.strictSuccess?.[5] ?? null);
    const tunR1 = r ? r.stable.tuningR1 : (a?.rank1Strict ?? null);
    const tunMrr = r ? r.stable.tuningMrr : (a?.mrrStrict ?? null);
    // Winner-eligibility: a nondeterministic config (HyDE/rerank) may only be
    // crowned if it was reproduced 3× (has a `repeat` block). A single-run
    // nondeterministic cell is recorded as supplementary evidence but never wins —
    // a lucky draw must not become a documented "best config".
    const reproduced = Boolean(r) && (r.runs >= 3);
    const nondetConfig = NONDET.has(cfg);          // config IS nondeterministic by type
    const eligible = !nondetConfig || reproduced;  // …and only eligible once reproduced 3×
    return {
        cfg, ok: true, nondet: Boolean(r), nondetConfig, reproduced, eligible,
        heldS5, heldR1, heldMrr, tunS5, tunR1, tunMrr,
        heldN: h?.queryCount ?? null,
        r1SpreadHeld: r ? [r.spread.heldR1.min, r.spread.heldR1.max] : null,
        s5SpreadHeld: r ? [r.spread.heldS5.min, r.spread.heldS5.max] : null,
        chunks: j.stats?.chunkCount ?? null,
        vectors: j.stats?.vectorCount ?? null,
        buildMs: j.build?.wallMs ?? null,
        chps: j.throughputChunksPerSec ?? null,
        sizeBytes: j.stats?.sizeBytes?.total ?? null,
        embedModel: j.stats?.embedMeta?.model ?? null,
        runsRaw: r ? { heldS5: r.heldStrictSuccess5, heldR1: r.heldRank1 } : null,
    };
}

const ALL_CFGS = Object.keys(COST).filter(c => c !== 'E1').concat(['R1', 'R2']).filter((v, i, a) => a.indexOf(v) === i);

function bestOf(cells, pool) {
    const cand = cells.filter(c => c.ok && c.eligible && pool.includes(c.cfg) && c.heldS5 !== null);
    if (!cand.length) return null;
    cand.sort((x, y) =>
        (y.heldS5 - x.heldS5) ||
        ((y.heldMrr ?? 0) - (x.heldMrr ?? 0)) ||
        (COST[x.cfg] - COST[y.cfg]));
    return cand[0];
}

// Curated winners (bench/results/_winners.json) are the single source of truth: they
// apply two honesty guards the pure rule can't (rerank tax on the tuning set; nondet
// spread overlap → cost). synth renders the CURATED winner and flags when it differs
// from the pure held-out optimum, so the audit trail stays transparent.
let CURATED = {};
try { CURATED = JSON.parse(fs.readFileSync(path.join(RES, '_winners.json'), 'utf-8')).fixtures || {}; } catch { /* none */ }

const matrix = [];
for (const fx of FIXTURES) {
    const cells = ALL_CFGS.map(c => readCell(fx, c)).filter(Boolean);
    const measured = cells.filter(c => c.ok);
    const l1 = cells.find(c => c.cfg === 'L1');
    const cheapWin = bestOf(cells, ['L1', 'E0', 'O0']);
    const pureOptimum = bestOf(cells, measured.map(c => c.cfg));
    const curatedCfg = CURATED[fx]?.best;
    const curatedCell = curatedCfg ? cells.find(c => c.cfg === curatedCfg && c.ok) : null;
    const overallWin = curatedCell || pureOptimum;
    const curatedDiffersFromPure = curatedCfg && pureOptimum && curatedCfg !== pureOptimum.cfg;
    // "Maxed by cheap" = the best cheap config ties the overall winner on held s@5.
    const maxedByCheap = cheapWin && overallWin && cheapWin.heldS5 >= overallWin.heldS5 - 1e-9;
    matrix.push({
        fixture: fx, language: LANG[fx],
        configsMeasured: measured.map(c => c.cfg),
        l1, cheapWin, overallWin, pureOptimum, curatedDiffersFromPure, maxedByCheap,
        why: CURATED[fx]?.why || null,
        cells,
    });
}

// ─── render ──────────────────────────────────────────────────────────────────
const f2 = (x) => (x === null || x === undefined ? ' -- ' : x.toFixed(2));
const pct = (x) => (x === null || x === undefined ? '--' : Math.round(x * 100) + '%');

console.log('\n=== PER-FIXTURE BEST CONFIG (winner = held s@5 ↓, then held MRR ↓, then cost ↓) ===\n');
console.log(['fixture'.padEnd(12), 'lang'.padEnd(14), 'L1 hS5/hR1', 'WINNER'.padEnd(6), 'win hS5/hR1', 'maxedByCheap', 'measured'].join('  '));
for (const m of matrix) {
    const w = m.overallWin;
    const winStr = w ? `${w.cfg}` : 'n/a';
    const winMetrics = w ? `${f2(w.heldS5)}/${f2(w.heldR1)}${w.nondet ? ` [r1 ${f2(w.r1SpreadHeld[0])}-${f2(w.r1SpreadHeld[1])}]` : ''}` : '';
    console.log([
        m.fixture.padEnd(12), (m.language || '').padEnd(14),
        `${f2(m.l1?.heldS5)}/${f2(m.l1?.heldR1)}`.padEnd(11),
        winStr.padEnd(6), winMetrics.padEnd(24),
        String(m.maxedByCheap).padEnd(12),
        m.configsMeasured.join(',')
    ].join('  '));
}

// Pending / missing cells (grid still running)
const expectedHeavy = {
    laravel: ['O0H','O0R','O0HR','O2','O2H','R0','O2HR','R1','R2'],
    symfony: ['O0H','O0R','O0HR','O2','O2H','R0','O2HR','R1','R2'],
    spring: ['O0H','O0R','O0HR','O2H','R0','O2HR'],
    rust: ['O0H','O0R','O0HR','O2H','R0','O2HR'],
    nestjs: ['O0H','O0R','O0HR','O2','O2H','R0','O2HR'],
    rails: ['O0H','O0R','O0HR','O2','O2H','R0','O2HR'],
    gin: ['O0H','O0R','O0HR'], django: ['O0H','O0R','O0HR'],
    'express-js': ['O0H','O0R','O0HR'], alamofire: ['O0H','O0R','O0HR'],
};
console.log('\n=== GRID PROGRESS (expected new cells present?) ===');
for (const [fx, cfgs] of Object.entries(expectedHeavy)) {
    const have = cfgs.filter(c => fs.existsSync(path.join(RES, `${fx}__${c}.json`)));
    console.log(`${fx.padEnd(12)} ${have.length}/${cfgs.length}  missing: ${cfgs.filter(c => !have.includes(c)).join(',') || '(none)'}`);
}

// ─── markdown emitters (--md writes bench/results/_matrix.md) ──────────────────
function mdRange(cell) {
    // "1.00" deterministic, or "1.00 [0.67–1.00]" with 3× spread for nondeterministic.
    if (!cell || cell.heldR1 === null) return '—';
    const v = f2(cell.heldR1);
    if (cell.nondet && cell.r1SpreadHeld && cell.r1SpreadHeld[0] !== cell.r1SpreadHeld[1])
        return `${v} [${f2(cell.r1SpreadHeld[0])}–${f2(cell.r1SpreadHeld[1])}]`;
    return v;
}
function emitMarkdown() {
    let md = `# Per-fixture config matrix (auto-generated by bench/synth-best.mjs)\n\n`;
    md += `Generated: ${new Date().toISOString()}\n\n`;
    md += `Metrics are STRICT (exact symbol, no file-path fallback). \`hS5\`/\`hR1\`/\`hMRR\` = held-out success@5 / rank-1 / MRR (n=3, symfony n=4 — coarse, directional). `;
    md += `\`tS5\`/\`tR1\` = tuning success@5 / rank-1. Nondeterministic configs (HyDE/rerank) show the median of 3× runs; rank-1 with a [min–max] spread reproduced 3×. ‡ = single-run legacy (not reproduced 3×, NOT winner-eligible).\n\n`;
    for (const m of matrix) {
        const w = m.overallWin, cw = m.cheapWin;
        md += `## ${m.fixture} (${m.language})\n\n`;
        md += `| config | label | hS5 | hR1 (spread) | hMRR | tS5 | tR1 | chunks | build | note |\n`;
        md += `|---|---|---|---|---|---|---|---|---|---|\n`;
        for (const c of m.cells) {
            if (!c.ok) { md += `| ${c.cfg} | ${LABEL[c.cfg] || ''} | — | — | — | — | — | — | — | ${c.reason} |\n`; continue; }
            const note = [];
            if (c.cfg === w?.cfg) note.push('**WINNER**');
            if (c.nondetConfig && !c.reproduced) note.push('‡1× (legacy single-run, not winner-eligible)');
            else if (c.nondetConfig) note.push('3×');
            const build = c.buildMs ? (c.buildMs >= 1000 ? `${Math.round(c.buildMs / 1000)}s` : `${c.buildMs}ms`) : (c.nondetConfig ? 'reuse' : '—');
            md += `| ${c.cfg} | ${LABEL[c.cfg] || ''} | ${f2(c.heldS5)} | ${mdRange(c)} | ${f2(c.heldMrr)} | ${f2(c.tunS5)} | ${f2(c.tunR1)} | ${c.chunks ?? '—'} | ${build} | ${note.join(' ')} |\n`;
        }
        md += `\n**Recommended winner: ${w ? `${w.cfg} (${LABEL[w.cfg]})` : 'n/a'}** — held s@5 ${f2(w?.heldS5)}, rank-1 ${mdRange(w)}. `;
        md += `Default L1: held s@5 ${f2(m.l1?.heldS5)}, rank-1 ${f2(m.l1?.heldR1)}. `;
        if (m.curatedDiffersFromPure)
            md += `(Pure held-out optimum would be **${m.pureOptimum.cfg}**, but it is not recommended — see why.) `;
        md += m.maxedByCheap ? `Cheap config saturates held s@5.\n\n` : `Heavy config strictly improves held s@5 over the cheap default.\n\n`;
        if (m.why) md += `_Why:_ ${m.why}\n\n`;
    }
    return md;
}

if (process.argv.includes('--json')) {
    fs.writeFileSync(path.join(RES, '_best-config-matrix.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), matrix, LABEL, COST }, null, 2));
    console.log('\n📄 wrote bench/results/_best-config-matrix.json');
}
if (process.argv.includes('--md')) {
    fs.writeFileSync(path.join(RES, '_matrix.md'), emitMarkdown());
    console.log('📄 wrote bench/results/_matrix.md');
}

export { matrix, LABEL, COST, LANG, readCell, FIXTURES, CHEAP, NONDET };
