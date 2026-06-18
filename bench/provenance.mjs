#!/usr/bin/env node
/**
 * bench/provenance.mjs — records the exact source provenance of every fixture so
 * the whole matrix reproduces. Pinned commit where the fixture kept its .git;
 * repo+subdir provenance (commit NOT pinned) where the fixture was reduced to a
 * language-pure subdir with .git stripped — reported honestly as such.
 * Writes bench/provenance.json.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { FIXTURES as CORE } from '../test/setup.mjs';
import { FIXTURES as EXT } from '../test/agent/fixtures.manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FX_DIR = path.join(ROOT, 'test', 'fixtures');

function gitCommit(dir) {
    // Only the fixture's OWN .git counts. Without this guard `git rev-parse` walks
    // up to the parent graph-indexer repo and falsely "pins" subdir-reduced fixtures.
    if (!fs.existsSync(path.join(dir, '.git'))) return null;
    try { return execSync('git rev-parse HEAD', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { return null; }
}

const rows = {};

// Core 5: pinned tag (test/setup.mjs) + resolved commit.
for (const f of CORE) {
    const dir = path.join(FX_DIR, f.id);
    rows[f.id] = {
        id: f.id, language: f.language, repo: f.url.replace(/\.git$/, ''),
        ref: f.ref, refType: f.refType, commit: gitCommit(dir), subdirs: ['.'],
        pinned: true, source: 'test/setup.mjs (shallow clone at pinned tag)',
    };
}

// Extended language fixtures: repo + subdir reduction (manifest). Commit pinned
// only if the dir kept its .git.
for (const f of EXT) {
    const dir = path.join(FX_DIR, f.dest);
    const commit = gitCommit(dir);
    rows[f.dest] = {
        id: f.dest, language: f.lang, repo: f.repo,
        ref: null, refType: null, commit,
        subdirs: Array.isArray(f.subdirs) ? f.subdirs : ['.'],
        pinned: Boolean(commit),
        source: 'test/agent/fixtures.manifest.mjs (subdir-reduced, default branch at clone time)'
            + (commit ? '' : ' — .git stripped, COMMIT NOT PINNED'),
    };
}

fs.writeFileSync(path.join(__dirname, 'provenance.json'), JSON.stringify(rows, null, 2));
const pinned = Object.values(rows).filter(r => r.pinned).length;
console.log(`provenance: ${Object.keys(rows).length} fixtures, ${pinned} commit-pinned, ${Object.keys(rows).length - pinned} repo+subdir-only (not commit-pinned)`);
for (const r of Object.values(rows)) console.log(`  ${r.id.padEnd(12)} ${(r.language||'').padEnd(16)} ${r.pinned ? (r.ref || r.commit?.slice(0,10)) : 'NOT PINNED'}  ${r.repo}`);
