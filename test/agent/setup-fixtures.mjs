#!/usr/bin/env node
/**
 * test/agent/setup-fixtures.mjs
 *
 * Reproducibly (re)builds the full-matrix benchmark fixtures from
 * fixtures.manifest.mjs: shallow-clone each repo, copy its language-pure
 * subdirs into test/fixtures/<dest>, and index it with embeddings.
 *
 *   node test/agent/setup-fixtures.mjs                 # all fixtures
 *   node test/agent/setup-fixtures.mjs rust react      # selected
 *   OLLAMA_HOST=http://localhost:11435 node test/agent/setup-fixtures.mjs
 *
 * Requires: git, and (for semantic search) a running Ollama with nomic-embed-text.
 * Without Ollama the index still builds (lexical-only); embeddings are skipped.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { FIXTURES } from './fixtures.manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const FIXROOT = path.join(REPO, 'test', 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-fixtures-'));

const want = process.argv.slice(2);
const sel = want.length ? FIXTURES.filter(f => want.includes(f.dest)) : FIXTURES;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

for (const fx of sel) {
    const clone = path.join(TMP, fx.dest);
    const dest = path.join(FIXROOT, fx.dest);
    console.log(`\n=== ${fx.dest} (${fx.lang}) ===`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
    run('git', ['clone', '--depth', '1', '--quiet', fx.repo, clone]);
    fs.mkdirSync(dest, { recursive: true });
    for (const sub of fx.subdirs) {
        const src = path.join(clone, sub);
        if (!fs.existsSync(src)) { console.warn(`  ! missing subdir: ${sub}`); continue; }
        // copy contents of the subdir into dest (merges multiple subdirs).
        run('cp', ['-R', src + '/.', dest + '/']);
    }
    const count = execFileSync('bash', ['-c', `find "${dest}" -type f | wc -l`]).toString().trim();
    console.log(`  files: ${count} → indexing…`);
    run('node', [path.join(REPO, 'indexer.mjs'), '--repo', dest], { cwd: REPO });
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nDone. Rebuilt ${sel.length} fixture(s). Now run: node test/agent/assemble.mjs`);
