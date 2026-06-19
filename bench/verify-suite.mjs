#!/usr/bin/env node
/**
 * bench/verify-suite.mjs <fixture>
 *
 * Fabrication guard for authored ground truth. For each query in
 * test/suites/<fixture>.mjs it confirms that at least one REAL indexed chunk
 * satisfies the strict-relevance predicate for its expected_names (the exact
 * same predicate test/evaluate.mjs scores with: whole name, any dotted/`::`/`#`
 * component, or class_context). A query whose expected target does not exist in
 * the index is "unwinnable" — an invented symbol — and is reported as FAIL.
 *
 * Also reports the held-out split and the query-count, so each language meets
 * the ~8-10 queries + ~25% held-out discipline.
 *
 * Exit code 0 only if every query resolves to a real chunk.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { artifactPaths } from '../layout.mjs';
import { MemoryGraphIndex } from '../engine/memory.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const fixture = process.argv[2];

const dir = path.join(ROOT, 'test', 'fixtures', fixture);
const A = artifactPaths(dir);
const db = new MemoryGraphIndex(A.indexPath); db.load();
const chunks = Array.from(db.iterateChunks());

/** Does any chunk strictly satisfy these expected names? (mirrors evaluate.strictRelevant) */
function nameResolves(expectedNames) {
    const want = (expectedNames || []).map(n => n.toLowerCase());
    if (!want.length) return false;
    for (const c of chunks) {
        const raw = (c.name || '').toLowerCase();
        if (!raw) continue;
        const parts = new Set(raw.split(/[.#:]/).filter(Boolean));
        parts.add(raw);
        const ctx = (c.class_context || '').toLowerCase();
        if (ctx) parts.add(ctx);
        if (want.some(n => parts.has(n))) return true;
    }
    return false;
}
function fileResolves(expectedFiles) {
    const want = (expectedFiles || []).map(f => f.toLowerCase());
    if (!want.length) return true; // optional
    return chunks.some(c => { const fp = (c.file_path || '').toLowerCase(); return want.some(f => fp.includes(f)); });
}

const mod = await import(`../test/suites/${fixture}.mjs`);
const QUERIES = mod.QUERIES || [];
let fails = 0;
const kinds = {};
let held = 0;
for (const q of QUERIES) {
    if (q.heldOut) held++;
    const d = q.difficulty || 'medium'; kinds[d] = (kinds[d] || 0) + 1;
    const nameOk = nameResolves(q.expected_names);
    const fileOk = fileResolves(q.expected_files);
    if (!nameOk) {
        fails++;
        console.log(`  ✗ ${q.id} [${d}] expected_names=${JSON.stringify(q.expected_names)} — NO real chunk matches (invented/unwinnable)`);
    } else if (!fileOk) {
        console.log(`  ⚠ ${q.id} [${d}] expected_files=${JSON.stringify(q.expected_files)} — no file matches (name ok)`);
    }
}
const tuning = QUERIES.length - held;
console.log(`${fixture}: ${QUERIES.length} queries (${tuning} tuning + ${held} held-out, ${(held / QUERIES.length * 100).toFixed(0)}%) | by-difficulty ${JSON.stringify(kinds)} | ${fails === 0 ? 'ALL RESOLVE ✓' : fails + ' UNWINNABLE ✗'}`);
process.exit(fails === 0 ? 0 : 1);
