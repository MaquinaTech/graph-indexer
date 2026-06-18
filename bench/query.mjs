#!/usr/bin/env node
/**
 * bench/query.mjs — read-only top-K probe for a fixture's existing index. The
 * per-cell result JSONs only store `top1`; investigations need the actual top-5
 * a query returns. This loads the built index (never rebuilds, never mutates) and
 * runs the SAME lexical search path as the harness (`db.searchHybrid(q, null, k)`),
 * then prints the ranked hits and marks which are strict-relevant to an expected
 * symbol — mirroring evaluate.mjs `strictRelevant` exactly.
 *
 * Usage:
 *   node bench/query.mjs <fixture> "<query text>" [--k 5] [--expect Name1,Name2]
 *   node bench/query.mjs <fixture> --suite <QID>     # pull the query+expected from the suite by id
 *
 * Lexical only by default (the shipped default path). No Ollama, no embeddings.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { artifactPaths } from '../layout.mjs';
import { MemoryGraphIndex } from '../core-engine.mjs';
import { isNaturalLanguageQuery } from '../search-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const fx = argv[0];
if (!fx) { console.error('usage: node bench/query.mjs <fixture> "<query>" [--k N] [--expect A,B] | <fixture> --suite <QID>'); process.exit(1); }

function flag(name, def) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; }
const k = parseInt(flag('--k', '8'), 10);

// strictRelevant — byte-identical to test/evaluate.mjs (whole name, dotted/::/#
// components, or class_context; no substring, no file fallback).
function strictRelevant(chunk, expectedNames) {
    if (!chunk) return false;
    const raw = (chunk.name || '').toLowerCase(); if (!raw) return false;
    const parts = new Set(raw.split(/[.#:]/).filter(Boolean)); parts.add(raw);
    const ctx = (chunk.class_context || '').toLowerCase(); if (ctx) parts.add(ctx);
    return (expectedNames || []).some(n => parts.has(n.toLowerCase()));
}

let query, expected = [], qid = null, kind = null, difficulty = null, expectedFiles = [];
const suiteId = flag('--suite', null);
if (suiteId) {
    const suite = await import(`../test/suites/${fx}.mjs`);
    const q = suite.QUERIES.find(q => q.id === suiteId);
    if (!q) { console.error(`query id ${suiteId} not found in suites/${fx}.mjs`); process.exit(1); }
    query = q.query; expected = q.expected_names || []; qid = q.id; kind = q.kind; difficulty = q.difficulty; expectedFiles = q.expected_files || [];
} else {
    query = argv[1];
    const exp = flag('--expect', '');
    expected = exp ? exp.split(',').map(s => s.trim()).filter(Boolean) : [];
}
if (!query) { console.error('no query'); process.exit(1); }

const A = artifactPaths(path.join(ROOT, 'test', 'fixtures', fx));
if (!fs.existsSync(A.indexPath)) { console.error(`${fx}: no index at ${A.indexPath}`); process.exit(1); }
const db = new MemoryGraphIndex(A.indexPath); db.load();

const topK = Math.max(k, 10);
const results = db.searchHybrid(query, null, topK);

console.log(`\nfixture: ${fx}${qid ? `  [${qid} · kind=${kind} · ${difficulty}]` : ''}`);
console.log(`query:   "${query}"   (NL-classified: ${isNaturalLanguageQuery(query)})`);
if (expected.length) console.log(`expected: ${expected.join(', ')}${expectedFiles.length ? `   files: ${expectedFiles.join(', ')}` : ''}`);
const strictRank = results.findIndex(r => strictRelevant(r.chunk, expected)) + 1;
if (expected.length) console.log(`strict rank: ${strictRank || 'NOT in top-' + topK}`);
console.log('');
console.log('  #  score    strict  name (class_context)                        node_type                 file:line');
results.slice(0, k).forEach((r, i) => {
    const c = r.chunk || {};
    const hit = strictRelevant(c, expected) ? '  ✓  ' : '     ';
    const nm = `${c.class_context ? c.class_context + '.' : ''}${c.name || '∅'}`;
    console.log(`  ${String(i + 1).padStart(2)} ${(r.score ?? 0).toFixed(4)}  ${hit} ${nm.slice(0, 42).padEnd(42)} ${(c.node_type || '∅').padEnd(24)} ${c.file_path || ''}:${c.start_line ?? '?'}`);
});
