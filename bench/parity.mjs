#!/usr/bin/env node
/**
 * bench/parity.mjs <fixture...> — backend parity (P config).
 *
 * For each fixture: cold-build the MemoryGraphIndex and the SqliteGraphStore from
 * the same source (lexical L1 — deterministic, no embedding float noise), then
 * assert the top-5 ranking for every ground-truth query is byte-identical. This
 * is the "parity by construction" claim (both backends share fuseAndRank); a
 * mismatch is a DEFECT and is reported, not hidden.
 *
 * Writes bench/results/parity.json.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { artifactPaths } from '../layout.mjs';
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { SqliteGraphStore } from '../engine/sqlite.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEXER = path.join(ROOT, 'indexer.mjs');
const RESULTS = path.join(__dirname, 'results', 'parity.json');

function build(dir, sqlite) {
    fs.rmSync(artifactPaths(dir).dataDir, { recursive: true, force: true });
    const args = [INDEXER, '--repo', dir];
    if (sqlite) args.push('--use-sqlite');
    const r = spawnSync(process.execPath, args, { env: { ...process.env, INDEXER_EMBEDDINGS: 'off' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0;
}
const key = (res) => res.slice(0, 5).map(r => `${r.chunk?.name}@${r.chunk?.file_path}:${r.chunk?.start_line ?? r.chunk?.startLine ?? ''}`);

const prior = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, 'utf8')) : {};
for (const fx of process.argv.slice(2)) {
    const dir = path.join(ROOT, 'test', 'fixtures', fx);
    let queries = [];
    try { queries = (await import(`../test/suites/${fx}.mjs`)).QUERIES || []; } catch { console.log(`${fx}: no suite — skip`); continue; }

    if (!build(dir, false)) { prior[fx] = { ok: false, reason: 'memory build failed' }; continue; }
    const mem = new MemoryGraphIndex(artifactPaths(dir).indexPath); mem.load();
    const memTop = queries.map(q => key(mem.searchHybrid(q.query, null, Math.max(q.topK ?? 10, 5))));

    if (!build(dir, true)) { prior[fx] = { ok: false, reason: 'sqlite build failed' }; continue; }
    const sq = new SqliteGraphStore(artifactPaths(dir).sqlitePath, {}); sq.load();
    const sqTop = queries.map(q => key(sq.searchHybrid(q.query, null, Math.max(q.topK ?? 10, 5))));

    const mismatches = [];
    for (let i = 0; i < queries.length; i++) {
        if (JSON.stringify(memTop[i]) !== JSON.stringify(sqTop[i])) mismatches.push({ id: queries[i].id, mem: memTop[i], sqlite: sqTop[i] });
    }
    prior[fx] = { ok: mismatches.length === 0, queries: queries.length, mismatches };
    console.log(`${fx.padEnd(12)} ${mismatches.length === 0 ? `PARITY ✓ (${queries.length} queries, top-5 identical)` : `PARITY BROKEN ✗ ${mismatches.length}/${queries.length}`}`);
}
fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
fs.writeFileSync(RESULTS, JSON.stringify(prior, null, 2));
