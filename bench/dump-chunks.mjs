#!/usr/bin/env node
/**
 * bench/dump-chunks.mjs <fixture>
 *
 * Prints the full universe of indexed symbol names / files / types for a fixture,
 * so ground-truth queries can be authored against REAL chunk names (never invented).
 * Writes bench/_chunks/<fixture>.json = { names:[...], byType:{...}, files:[...] }.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { artifactPaths } from '../layout.mjs';
import { MemoryGraphIndex } from '../core-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const fixture = process.argv[2];
const dir = path.join(ROOT, 'test', 'fixtures', fixture);
const A = artifactPaths(dir);
if (!fs.existsSync(A.indexPath)) { console.error(`no index at ${A.indexPath} — build it first`); process.exit(1); }
const db = new MemoryGraphIndex(A.indexPath); db.load();
const chunks = Array.from(db.iterateChunks());

const byType = {};
const names = new Set();
const fileSet = new Set();
for (const c of chunks) {
    if (c.name && c.name !== 'anonymous') names.add(c.name);
    fileSet.add(c.file_path);
    const t = c.type || c.kind || 'unknown';
    (byType[t] ||= []).push({ name: c.name, file: c.file_path, ctx: c.class_context || '' });
}
const out = {
    fixture,
    chunkCount: chunks.length,
    fileCount: fileSet.size,
    names: [...names].sort(),
    files: [...fileSet].sort(),
    byType: Object.fromEntries(Object.entries(byType).map(([t, v]) => [t, v.length])),
    sample: chunks.slice(0, 0), // populated below as a readable sample
};
// A readable sample: up to 60 named chunks with file + type, to orient the author.
out.sample = chunks.filter(c => c.name && c.name !== 'anonymous')
    .slice(0, 200)
    .map(c => ({ name: c.name, type: c.type || c.kind, file: c.file_path, ctx: c.class_context || undefined }));

const outDir = path.join(__dirname, '_chunks');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${fixture}.json`), JSON.stringify(out, null, 2));
console.log(`${fixture}: ${chunks.length} chunks, ${names.size} distinct names, ${fileSet.size} files → bench/_chunks/${fixture}.json`);
