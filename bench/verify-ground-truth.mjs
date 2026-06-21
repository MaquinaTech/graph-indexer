#!/usr/bin/env node
/**
 * bench/verify-ground-truth.mjs [fixture ...]
 *
 * Deterministic ground-truth gate for the benchmark suites. For each fixture it
 * loads the on-disk index and replicates the EXACT strict / file relevance
 * semantics of test/evaluate.mjs, then checks that every query's expected_names
 * resolves to a real indexed chunk and every expected_files matches a real file.
 *
 * A query whose expected_names cannot resolve scores a permanent 0 on the strict
 * (winner-selection) metric — that is a bug in the query, not a ceiling. This gate
 * catches those BEFORE any scoring so a silently-zero query never deflates the
 * higher-powered metrics this task is producing.
 *
 *   strict token universe = for every chunk: lowercased name, its `.`/`#`/`:`
 *     split components, and its class_context (mirrors strictRelevant()).
 *   file universe         = lowercased file_path of every chunk; an expected_files
 *     entry resolves if it is a SUBSTRING of any file_path (mirrors fileRelevant()).
 *
 * Names are config-independent (embeddings/enrichment add vectors/fields, never
 * chunks or names), so whatever index is on disk is a valid universe.
 *
 * Output: prints a per-suite summary and writes bench/results/_ground-truth-check.json.
 * Exit code 0 always (it is a report, not a test); HARD failures are listed so the
 * caller can fix/drop them.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { artifactPaths } from '../layout.mjs';
import { MemoryGraphIndex } from '../engine/memory.mjs';
import { SqliteGraphStore } from '../engine/sqlite.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RES = path.join(__dirname, 'results');

const ALL = [
  'axios', 'express-js', 'nestjs', 'fastapi', 'gin', 'react', 'django', 'rust',
  'spring', 'android', 'aspnet', 'rails', 'laravel', 'symfony', 'css', 'cjson',
  'nvm', 'alamofire',
];

function loadDb(fixture) {
  const dir = path.join(ROOT, 'test', 'fixtures', fixture);
  const A = artifactPaths(dir);
  if (fs.existsSync(A.indexPath)) { const db = new MemoryGraphIndex(A.indexPath); db.load(); return db; }
  if (fs.existsSync(A.sqlitePath)) { const s = new SqliteGraphStore(A.sqlitePath, { embeddingPath: A.embeddingPath }); s.load(); return s; }
  return null;
}


function universe(db) {
  const strict = new Set();
  const files = [];
  for (const c of db.iterateChunks()) {
    const raw = (c.name || '').toLowerCase();
    if (raw) {
      strict.add(raw);
      for (const p of raw.split(/[.#:]/).filter(Boolean)) strict.add(p);
    }
    const ctx = (c.class_context || '').toLowerCase();
    if (ctx) strict.add(ctx);
    files.push((c.file_path || '').toLowerCase());
  }
  return { strict, files };
}

const nameResolves = (uni, n) => uni.strict.has(String(n).toLowerCase());
const fileResolves = (uni, f) => { const ff = String(f).toLowerCase(); return uni.files.some(fp => fp.includes(ff)); };

const fixtures = process.argv.slice(2).filter(a => !a.startsWith('--'));
const list = fixtures.length ? fixtures : ALL;

const report = { generatedAt: new Date().toISOString(), suites: {} };
let totalChecked = 0, totalHardFail = 0, totalFileWarn = 0;

for (const fx of list) {
  const db = loadDb(fx);
  if (!db) { report.suites[fx] = { error: 'no index on disk — build it first' }; console.log(`\n✗ ${fx}: no index on disk`); continue; }
  const uni = universe(db);
  let mod;
  try { mod = await import(`../test/suites/${fx}.mjs`); } catch (e) { report.suites[fx] = { error: `suite import failed: ${e.message}` }; continue; }
  const queries = mod.QUERIES || [];

  const hardFails = [];
  const fileWarns = [];
  const nameWarns = [];
  let tuning = 0, held = 0;

  for (const q of queries) {
    totalChecked++;
    if (q.heldOut) held++; else tuning++;
    const names = q.expected_names || [];
    const efiles = q.expected_files || [];
    const nameHits = names.map(n => ({ n, ok: nameResolves(uni, n) }));
    const anyName = nameHits.some(h => h.ok);
    const badNames = nameHits.filter(h => !h.ok).map(h => h.n);
    if (!anyName) hardFails.push({ id: q.id, query: q.query, expected_names: names, heldOut: !!q.heldOut });
    else if (badNames.length) nameWarns.push({ id: q.id, badNames, resolved: nameHits.filter(h => h.ok).map(h => h.n) });
    const badFiles = efiles.filter(f => !fileResolves(uni, f));
    if (badFiles.length) fileWarns.push({ id: q.id, badFiles });
  }

  totalHardFail += hardFails.length;
  totalFileWarn += fileWarns.length;
  report.suites[fx] = {
    chunkUniverse: uni.strict.size, fileCount: new Set(uni.files).size,
    tuning, held, total: queries.length,
    hardFails, nameWarns, fileWarns,
  };
  const mark = hardFails.length ? '✗' : '✓';
  console.log(`\n${mark} ${fx.padEnd(12)} tuning=${tuning} held=${held} total=${queries.length}` +
    `  HARD-FAIL=${hardFails.length} name-warn=${nameWarns.length} file-warn=${fileWarns.length}`);
  for (const h of hardFails) console.log(`    HARD ${h.id} [${h.heldOut ? 'held' : 'tun'}] "${h.query?.slice(0, 60)}" — none of [${h.expected_names.join(', ')}] in index`);
  for (const w of nameWarns) console.log(`    warn ${w.id} — unresolved names: [${w.badNames.join(', ')}] (ok: [${w.resolved.join(', ')}])`);
  for (const w of fileWarns) console.log(`    warn ${w.id} — unresolved files: [${w.badFiles.join(', ')}]`);
}

report.totals = { checked: totalChecked, hardFail: totalHardFail, fileWarn: totalFileWarn };
fs.mkdirSync(RES, { recursive: true });
fs.writeFileSync(path.join(RES, '_ground-truth-check.json'), JSON.stringify(report, null, 2));
console.log(`\n${'═'.repeat(60)}\nchecked=${totalChecked}  HARD-FAIL=${totalHardFail}  file-warn=${totalFileWarn}`);
console.log(`📄 wrote bench/results/_ground-truth-check.json`);
