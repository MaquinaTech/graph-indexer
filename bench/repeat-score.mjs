#!/usr/bin/env node
/**
 * bench/repeat-score.mjs <fixture> <configId> [runs=3]
 *
 * Reproduces a NONDETERMINISTIC, query-time config (HyDE and/or LLM rerank) N
 * times against the index ALREADY ON DISK for <fixture> — it never rebuilds. The
 * caller (bench/run-focused.sh) is responsible for having built the matching base
 * embed index first (e.g. `node bench/cell.mjs laravel O0` leaves the nomic index
 * on disk; then `node bench/repeat-score.mjs laravel O0HR 3` scores it 3×).
 *
 * Why this exists: HyDE (hypothetical-document generation) and the LLM reranker run
 * at generation temperature > 0, so a single "perfect" score is often a lucky draw
 * (the Laravel investigation saw held-out rank-1 swing {1.0, 0.333, 1.0} across three
 * identical runs). Selecting a winner off one run would be dishonest. This tool runs
 * the SAME scoring N times and records every run, the MEDIAN run (the stable value),
 * and the min–max spread, so the README/prompt numbers report the value that
 * reproduces — not the best draw.
 *
 * Output: bench/results/<fixture>__<configId>.json
 *   - same shape as bench/cell.mjs (stats + eval) for the median run, PLUS
 *   - record.repeat = { runs, heldStrictSuccess5:[…], heldRank1:[…], heldMrr:[…],
 *                       tuningStrictSuccess5:[…], tuningRank1:[…], tuningMrr:[…],
 *                       stable: { heldS5, heldR1, heldMrr, … }, spread: {…} }
 *   - per-run files bench/results/<fixture>__<configId>__run<k>.json
 *
 * No ranking logic is touched — this only invokes the unmodified test/evaluate.mjs.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { CONFIGS } from './configs.mjs';
import { artifactPaths } from '../layout.mjs';
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { SqliteGraphStore } from '../engine/sqlite.mjs';
import { readEmbedMeta } from '../embeddings.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EVALUATE = path.join(ROOT, 'test', 'evaluate.mjs');
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const RESULTS_DIR = path.join(__dirname, 'results');

const fixtureDir = (fixture) => path.join(ROOT, 'test', 'fixtures', fixture);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const min = (xs) => (xs.length ? Math.min(...xs) : null);
const max = (xs) => (xs.length ? Math.max(...xs) : null);

function loadDb(dir, useSqlite) {
    const A = artifactPaths(dir);
    if (useSqlite) {
        if (!fs.existsSync(A.sqlitePath)) return null;
        const s = new SqliteGraphStore(A.sqlitePath, { embeddingPath: A.embeddingPath });
        s.load();
        return s;
    }
    if (!fs.existsSync(A.indexPath)) return null;
    const db = new MemoryGraphIndex(A.indexPath);
    db.load();
    return db;
}

function indexStats(dir, db) {
    const A = artifactPaths(dir);
    const chunks = Array.from(db.iterateChunks());
    const files = new Set(chunks.map(c => c.file_path));
    const meta = readEmbedMeta(A.embeddingPath);
    const jsonSize = fs.existsSync(A.indexPath) ? fs.statSync(A.indexPath).size : 0;
    const dbSize = fs.existsSync(A.sqlitePath) ? fs.statSync(A.sqlitePath).size : 0;
    const binSize = fs.existsSync(A.embeddingPath) ? fs.statSync(A.embeddingPath).size : 0;
    return {
        chunkCount: chunks.length,
        fileCount: files.size,
        vectorCount: db.vectorCount(),
        embedMeta: meta,
        sizeBytes: { json: jsonSize, db: dbSize, bin: binSize, total: jsonSize + dbSize + binSize },
    };
}

/** Run test/evaluate.mjs once with the config's score flags; return its results[0]. */
function scoreOnce(fixture, cfg, outPath) {
    const env = { ...process.env, OLLAMA_HOST };
    const args = [EVALUATE, '--suite', fixture, '--out', outPath];
    const s = cfg.score;
    if (s.embeddings) args.push('--embeddings');
    if (s.embedProvider) args.push('--embed-provider', s.embedProvider);
    if (s.hyde) args.push('--hyde');
    if (s.rerank) { args.push('--rerank'); if (s.rerankModel) env.RERANK_MODEL = s.rerankModel; }
    const res = spawnSync(process.execPath, args, { env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0 || !fs.existsSync(outPath)) {
        return { ok: false, exitCode: res.status, stderrTail: (res.stderr || '').split('\n').slice(-8).join('\n') };
    }
    const ev = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    fs.rmSync(outPath, { force: true });
    return { ok: true, eval: ev.results?.[0] || null };
}

// ─── main ────────────────────────────────────────────────────────────────────
const posArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const [fixture, configId, runsArg] = posArgs;
const RUNS = Number(runsArg) > 0 ? Number(runsArg) : 3;
if (!fixture || !configId || !CONFIGS[configId]) {
    console.error(`usage: node bench/repeat-score.mjs <fixture> <configId> [runs]\n  configs: ${Object.keys(CONFIGS).join(', ')}`);
    process.exit(2);
}
const cfg = CONFIGS[configId];
fs.mkdirSync(RESULTS_DIR, { recursive: true });
const outFile = path.join(RESULTS_DIR, `${fixture}__${configId}.json`);
const record = { fixture, configId, label: cfg.label, family: cfg.family, generatedAt: new Date().toISOString(), nondeterministic: true };

const dir = fixtureDir(fixture);
const usedSqlite = Boolean(cfg.build.sqlite);
const db = loadDb(dir, usedSqlite);
if (!db) {
    record.ok = false; record.reason = `index not on disk — build base config ${cfg.reuseBase || '(base)'} first`;
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
    console.error(`FAIL ${fixture} ${configId}: ${record.reason}`);
    process.exit(1);
}
record.stats = indexStats(dir, db);
record.build = { ok: true, reused: true, reuseBase: cfg.reuseBase || null, wallMs: 0, usedSqlite };

console.log(`\n▶ ${fixture} · ${configId} (${cfg.label}) — REUSE on-disk index, ${RUNS}× repeat…`);
const runs = [];
for (let k = 1; k <= RUNS; k++) {
    const tmp = path.join(RESULTS_DIR, `_repeat_${fixture}__${configId}_r${k}.json`);
    const r = scoreOnce(fixture, cfg, tmp);
    if (!r.ok) {
        record.ok = false; record.reason = `scoring run ${k} failed (exit ${r.exitCode})`; record.scoreStderr = r.stderrTail;
        fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
        console.error(`FAIL ${fixture} ${configId} run ${k}\n${r.stderrTail}`);
        process.exit(1);
    }
    runs.push(r.eval);
    // Persist the raw per-run record for the audit trail.
    fs.writeFileSync(path.join(RESULTS_DIR, `${fixture}__${configId}__run${k}.json`),
        JSON.stringify({ fixture, configId, run: k, generatedAt: new Date().toISOString(), eval: r.eval }, null, 2));
    const a = r.eval?.aggregate, h = r.eval?.heldOutAggregate;
    console.log(`   run ${k}: tuning s@5=${a?.strictSuccess[5]?.toFixed(2)} r1=${a?.rank1Strict?.toFixed(2)}`
        + ` | held s@5=${h?.strictSuccess[5]?.toFixed(2)} r1=${h?.rank1Strict?.toFixed(2)} mrr=${h?.mrrStrict?.toFixed(2)}`);
}

// Spread / stable value. The "stable" metric is the MEDIAN across runs — the value
// that reproduces. Winner selection (held s@5, then held MRR) is done on these.
const heldS5 = runs.map(r => r.heldOutAggregate?.strictSuccess[5] ?? null).filter(x => x !== null);
const heldR1 = runs.map(r => r.heldOutAggregate?.rank1Strict ?? null).filter(x => x !== null);
const heldMrr = runs.map(r => r.heldOutAggregate?.mrrStrict ?? null).filter(x => x !== null);
const tunS5 = runs.map(r => r.aggregate?.strictSuccess[5] ?? null).filter(x => x !== null);
const tunR1 = runs.map(r => r.aggregate?.rank1Strict ?? null).filter(x => x !== null);
const tunMrr = runs.map(r => r.aggregate?.mrrStrict ?? null).filter(x => x !== null);

record.repeat = {
    runs: RUNS,
    heldStrictSuccess5: heldS5, heldRank1: heldR1, heldMrr,
    tuningStrictSuccess5: tunS5, tuningRank1: tunR1, tuningMrr: tunMrr,
    stable: {
        heldS5: median(heldS5), heldR1: median(heldR1), heldMrr: median(heldMrr),
        tuningS5: median(tunS5), tuningR1: median(tunR1), tuningMrr: median(tunMrr),
    },
    spread: {
        heldS5: { min: min(heldS5), max: max(heldS5), mean: mean(heldS5) },
        heldR1: { min: min(heldR1), max: max(heldR1), mean: mean(heldR1) },
        tuningR1: { min: min(tunR1), max: max(tunR1), mean: mean(tunR1) },
    },
};

// Representative `eval` = the run whose held s@5 equals the median (stable) value;
// fall back to the median-by-tuning-s@5 run when held is degenerate.
const stableHeldS5 = record.repeat.stable.heldS5;
let repIdx = runs.findIndex(r => (r.heldOutAggregate?.strictSuccess[5] ?? null) === stableHeldS5);
if (repIdx < 0) repIdx = Math.floor(runs.length / 2);
record.eval = runs[repIdx];
record.representativeRun = repIdx + 1;
record.ok = true;

fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
const st = record.repeat.stable;
console.log(`✓ ${fixture} ${configId}: stable held s@5=${st.heldS5?.toFixed(2)} r1=${st.heldR1?.toFixed(2)} (r1 spread ${record.repeat.spread.heldR1.min?.toFixed(2)}–${record.repeat.spread.heldR1.max?.toFixed(2)}) mrr=${st.heldMrr?.toFixed(2)}`);
