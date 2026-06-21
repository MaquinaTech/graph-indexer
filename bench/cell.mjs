#!/usr/bin/env node
/**
 * bench/cell.mjs <fixture> <configId>
 *
 * Measures ONE cell of the multi-language matrix from a COLD build:
 *   1. rm -rf <fixture>/.graph-indexer            (no warm state carries over)
 *   2. (optional) write .graph-indexer/config.json for file-only settings
 *   3. build the index under the config (clean), capturing wall-time + peak RSS
 *   4. load the index → operational stats (chunks, vectors, dim, size, backend)
 *   5. measure search latency in-process (median / p99 over the query set)
 *   6. score strict retrieval quality via test/evaluate.mjs --out <json>
 *   7. write bench/results/<fixture>__<configId>.json
 *
 * Every number is extracted, never estimated. A build/score failure is recorded
 * as { ok:false, reason } so the synthesis step can print "not run — <reason>".
 *
 * Usage:
 *   node bench/cell.mjs gin L1
 *   node bench/cell.mjs gin O2
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { CONFIGS } from './configs.mjs';
import { artifactPaths } from '../layout.mjs';
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { SqliteGraphStore } from '../engine/sqlite.mjs';
import { createEmbedder, readEmbedMeta, needsNomicPrefix } from '../embeddings.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEXER = path.join(ROOT, 'indexer.mjs');
const EVALUATE = path.join(ROOT, 'test', 'evaluate.mjs');
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const RESULTS_DIR = path.join(__dirname, 'results');

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

function fixtureDir(fixture) { return path.join(ROOT, 'test', 'fixtures', fixture); }

/** Wipe all generated state for a clean, cold build. */
function cleanState(dir) {
    const A = artifactPaths(dir);
    fs.rmSync(A.dataDir, { recursive: true, force: true });
}

/** Build the index for a config from cold. Returns build telemetry. */
function build(fixture, cfg) {
    const dir = fixtureDir(fixture);
    cleanState(dir);

    const b = cfg.build;
    const env = { ...process.env, OLLAMA_HOST };
    env.INDEXER_EMBEDDINGS = b.embeddings ? 'on' : 'off';
    if (b.embeddings) {
        env.INDEXER_EMBED_PROVIDER = b.provider;
        if (b.provider === 'ollama' && b.embedModel) env.EMBED_MODEL = b.embedModel;
        // Slow embedders (qwen3:4b) want a generous per-batch timeout and lower
        // concurrency so a single large batch doesn't abort and degrade to lexical.
        env.INDEXER_EMBED_TIMEOUT_MS = String(600000);
        env.INDEXER_EMBED_CONCURRENCY = b.provider === 'ollama' ? '2' : '4';
    }

    // File-only settings (local embed model) go through .graph-indexer/config.json.
    const A = artifactPaths(dir);
    const fileCfg = {};
    if (b.localModel) fileCfg.localEmbedModel = b.localModel;
    if (Object.keys(fileCfg).length) {
        fs.mkdirSync(A.dataDir, { recursive: true });
        fs.writeFileSync(A.configPath, JSON.stringify(fileCfg, null, 2));
    }

    const args = [INDEXER, '--repo', dir];
    if (b.sqlite) args.push('--use-sqlite');
    if (b.enrichment) { args.push('--enrichment'); if (b.enrichModel) args.push('--enrich-model', b.enrichModel); }

    const t0 = Date.now();
    const res = spawnSync('/usr/bin/time', ['-l', process.execPath, ...args], { env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    const wallMs = Date.now() - t0;

    let peakRssBytes = null;
    const m = (res.stderr || '').match(/(\d+)\s+maximum resident set size/);
    if (m) peakRssBytes = Number(m[1]);

    return {
        ok: res.status === 0,
        exitCode: res.status,
        wallMs,
        peakRssBytes,
        stderrTail: (res.stderr || '').split('\n').slice(-12).join('\n'),
        usedSqlite: Boolean(b.sqlite),
    };
}

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
        embedMeta: meta,           // { provider, model, dim }
        sizeBytes: { json: jsonSize, db: dbSize, bin: binSize, total: jsonSize + dbSize + binSize },
    };
}

/** Embed the query set with the SAME provider/model the index was built with. */
async function embedQueries(queries, meta) {
    if (!meta) return null;
    const map = new Map();
    if (meta.provider === 'ollama') {
        const pfx = needsNomicPrefix(meta.model) ? 'search_query: ' : '';
        const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: meta.model, input: queries.map(q => pfx + q.query) }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        queries.forEach((q, i) => map.set(q.id, new Float32Array(data.embeddings[i])));
        return map;
    }
    // Non-Ollama providers (local / mlx) embed in-process via createEmbedder,
    // routed by the provider stamped in the index meta — never assume 'local'.
    const embedder = await createEmbedder({ ollamaHost: OLLAMA_HOST, localEmbedModel: meta.model, embedModel: meta.model }, { provider: meta.provider, model: meta.model });
    for (const q of queries) { const v = await embedder.embedQuery(q.query); if (v) map.set(q.id, new Float32Array(v)); }
    return map;
}

/** Median / p99 search latency over the query set (ranking time, embedding excluded). */
async function measureLatency(dir, db, queries, useEmbeddings) {
    let qVecs = null;
    const A = artifactPaths(dir);
    if (useEmbeddings && db.vectorCount() > 0) {
        try { qVecs = await embedQueries(queries, readEmbedMeta(A.embeddingPath)); } catch { qVecs = null; }
    }
    const perQuery = [];
    for (const q of queries) {
        const topK = Math.max(q.topK ?? 10, 10);
        const qVec = qVecs ? (qVecs.get(q.id) ?? null) : null;
        let best = Infinity;
        for (let t = 0; t < 5; t++) {
            const s = process.hrtime.bigint();
            db.searchHybrid(q.query, qVec, topK);
            const ms = Number(process.hrtime.bigint() - s) / 1e6;
            if (ms < best) best = ms;
        }
        perQuery.push(best);
    }
    return { medianMs: median(perQuery), p99Ms: pct(perQuery, 99), n: perQuery.length };
}

function score(fixture, cfg, outPath) {
    const env = { ...process.env, OLLAMA_HOST };
    const args = [EVALUATE, '--suite', fixture, '--out', outPath];
    const s = cfg.score;
    if (s.embeddings) args.push('--embeddings');
    if (s.embedProvider) args.push('--embed-provider', s.embedProvider);
    if (s.hyde) args.push('--hyde');
    if (s.rerank) { args.push('--rerank'); if (s.rerankModel) env.RERANK_MODEL = s.rerankModel; }
    const res = spawnSync(process.execPath, args, { env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    return { ok: res.status === 0, exitCode: res.status, stderrTail: (res.stderr || '').split('\n').slice(-8).join('\n') };
}

// ─── main ────────────────────────────────────────────────────────────────────
const posArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const [fixture, configId] = posArgs;
// --reuse: score the index left on disk by a prior cell instead of rebuilding.
// Used for R0 (= O2 index + query-time rerank) and R2 (= R1 index + rerank), so
// the expensive qwen3:4b / enrichment build runs ONCE, not twice.
const reuse = process.argv.includes('--reuse');
if (!fixture || !configId || !CONFIGS[configId]) {
    console.error(`usage: node bench/cell.mjs <fixture> <configId> [--reuse]\n  configs: ${Object.keys(CONFIGS).join(', ')}`);
    process.exit(2);
}
const cfg = CONFIGS[configId];
fs.mkdirSync(RESULTS_DIR, { recursive: true });
const outFile = path.join(RESULTS_DIR, `${fixture}__${configId}.json`);

const record = { fixture, configId, label: cfg.label, family: cfg.family, generatedAt: new Date().toISOString() };

if (cfg.blocked && process.env.BENCH_FORCE_E1 !== '1') {
    record.ok = false; record.reason = `not run — ${cfg.blocked}`;
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
    console.log(`SKIP ${fixture} ${configId}: ${record.reason}`);
    process.exit(0);
}

// Skip platform-incompatible embedder configs (mlx = macOS only).
const _provGuard = cfg.build?.provider;
if (_provGuard === 'mlx' && process.platform !== 'darwin') {
    record.ok = false;
    record.reason = `not run — MLX requires macOS (current: ${process.platform})`;
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
    console.log(`⊘  Skipping ${fixture} ${configId} — ${record.reason}`);
    process.exit(0);
}

let buildInfo;
if (reuse) {
    console.log(`\n▶ ${fixture} · ${configId} (${cfg.label}) — REUSE existing index (no rebuild)…`);
    buildInfo = { ok: true, reused: true, wallMs: 0, peakRssBytes: null, usedSqlite: Boolean(cfg.build.sqlite) };
} else {
    console.log(`\n▶ ${fixture} · ${configId} (${cfg.label}) — cold build…`);
    buildInfo = build(fixture, cfg);
}
record.build = buildInfo;
if (!buildInfo.ok) {
    record.ok = false; record.reason = `build failed (exit ${buildInfo.exitCode})`;
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
    console.error(`FAIL build ${fixture} ${configId}\n${buildInfo.stderrTail}`);
    process.exit(1);
}

const dir = fixtureDir(fixture);
const db = loadDb(dir, buildInfo.usedSqlite);
if (!db) { record.ok = false; record.reason = 'index not found after build'; fs.writeFileSync(outFile, JSON.stringify(record, null, 2)); process.exit(1); }
const stats = indexStats(dir, db);
record.stats = stats;
record.throughputChunksPerSec = buildInfo.wallMs > 0 ? +(stats.chunkCount / (buildInfo.wallMs / 1000)).toFixed(2) : null;

let queries = [];
try { const mod = await import(`../test/suites/${fixture}.mjs`); queries = mod.QUERIES || []; } catch { /* no suite */ }
if (queries.length) {
    try { record.latency = await measureLatency(dir, db, queries, Boolean(cfg.score.embeddings)); }
    catch (e) { record.latency = { error: e.message }; }
}

const tmp = path.join(RESULTS_DIR, `_eval_${fixture}__${configId}.json`);
const sc = score(fixture, cfg, tmp);
if (sc.ok && fs.existsSync(tmp)) {
    const ev = JSON.parse(fs.readFileSync(tmp, 'utf-8'));
    record.eval = ev.results?.[0] || null;   // { META, aggregate, heldOutAggregate, rows, heldRows }
    fs.rmSync(tmp, { force: true });
    record.ok = true;
} else {
    record.ok = false; record.reason = `scoring failed (exit ${sc.exitCode})`; record.scoreStderr = sc.stderrTail;
}

fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
const a = record.eval?.aggregate;
console.log(`✓ ${fixture} ${configId}: chunks=${stats.chunkCount} vec=${stats.vectorCount} ${buildInfo.wallMs}ms (${record.throughputChunksPerSec} ch/s)`
    + (a ? ` | strict s@5=${a.strictSuccess[5].toFixed(2)} r1=${a.rank1Strict.toFixed(2)} MRR=${a.mrrStrict.toFixed(2)}` : ` | ${record.reason || ''}`));
