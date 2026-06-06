#!/usr/bin/env node
/**
 * test/setup.mjs
 *
 * Downloads all test fixture repos via shallow git clone at pinned refs.
 * Run once before the test suite: node test/setup.mjs
 *
 * Idempotent — already-cloned fixtures are skipped.
 * Each fixture lands in test/fixtures/<id>/
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/**
 * Pinned fixture definitions.
 * DO NOT bump versions without updating the matching ground-truth query file
 * in test/suites/<id>.mjs — expected names and file paths may change.
 */
export const FIXTURES = [
    {
        id: 'axios',
        displayName: 'Axios v1.6.0 (JavaScript)',
        language: 'JavaScript',
        url: 'https://github.com/axios/axios.git',
        ref: 'v1.6.0',
        refType: 'tag',
        expectedMinChunks: 80,
        expectedMinFiles: 30,
    },
    {
        id: 'express-js',
        displayName: 'Express 4.18.2 (JavaScript)',
        language: 'JavaScript',
        url: 'https://github.com/expressjs/express.git',
        ref: '4.18.2',
        refType: 'tag',
        expectedMinChunks: 60,
        expectedMinFiles: 20,
    },
    {
        id: 'nestjs',
        displayName: 'NestJS v10.4.9 (TypeScript Framework)',
        language: 'TypeScript',
        url: 'https://github.com/nestjs/nest.git',
        ref: 'v10.4.9',
        refType: 'tag',
        // Actively maintained enterprise TS framework; uses Express by default
        expectedMinChunks: 100,
        expectedMinFiles: 50,
    },
    {
        id: 'fastapi',
        displayName: 'FastAPI 0.103.0 (Python)',
        language: 'Python',
        url: 'https://github.com/tiangolo/fastapi.git',
        ref: '0.103.0',
        refType: 'tag',
        expectedMinChunks: 150,
        expectedMinFiles: 40,
    },
    {
        id: 'gin',
        displayName: 'Gin v1.9.1 (Go)',
        language: 'Go',
        url: 'https://github.com/gin-gonic/gin.git',
        ref: 'v1.9.1',
        refType: 'tag',
        expectedMinChunks: 80,
        expectedMinFiles: 20,
    },
];

// ─── clone helpers ────────────────────────────────────────────────────────────

function isAlreadyCloned(dest) {
    return fs.existsSync(path.join(dest, '.git'));
}

function cloneFixture(fixture) {
    const dest = path.join(FIXTURES_DIR, fixture.id);

    if (isAlreadyCloned(dest)) {
        console.log(`  ✓  ${fixture.displayName}  — already cloned`);
        return true;
    }

    console.log(`  ↓  ${fixture.displayName} ...`);

    const result = spawnSync(
        'git',
        [
            'clone',
            '--depth=1',
            '--single-branch',
            '--branch', fixture.ref,
            fixture.url,
            dest,
        ],
        { stdio: 'inherit', encoding: 'utf-8' }
    );

    if (result.status !== 0) {
        console.error(`  ✗  Clone failed for ${fixture.displayName} (exit ${result.status})`);
        return false;
    }

    console.log(`  ✓  Cloned ${fixture.displayName}`);
    return true;
}

function verifyFixture(fixture) {
    const dest = path.join(FIXTURES_DIR, fixture.id);
    if (!isAlreadyCloned(dest)) return false;

    // Quick sanity: count files to ensure the clone was not empty
    let fileCount = 0;
    try {
        const entries = fs.readdirSync(dest);
        fileCount = entries.filter(e => !e.startsWith('.')).length;
    } catch { return false; }

    if (fileCount < 3) {
        console.warn(`  ⚠  ${fixture.displayName} — unusually few files (${fileCount}), consider re-cloning`);
    }
    return true;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n📦  graph-indexer — setting up test fixtures\n');

    // Ensure fixtures directory exists
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });

    const results = { cloned: [], skipped: [], failed: [] };

    for (const fixture of FIXTURES) {
        const dest = path.join(FIXTURES_DIR, fixture.id);

        if (isAlreadyCloned(dest)) {
            results.skipped.push(fixture.id);
            console.log(`  ✓  ${fixture.displayName}  — already cloned`);
            verifyFixture(fixture);
        } else {
            const ok = cloneFixture(fixture);
            if (ok) {
                verifyFixture(fixture);
                results.cloned.push(fixture.id);
            } else {
                results.failed.push(fixture.id);
            }
        }
    }

    // Summary
    console.log('\n' + '─'.repeat(72));
    console.log(`📊  Setup Summary:`);
    console.log(`  ✓ Ready (already cloned):  ${results.skipped.length > 0 ? results.skipped.join(', ') : '(none)'}`);
    console.log(`  ✓ Newly cloned:             ${results.cloned.length > 0 ? results.cloned.join(', ') : '(none)'}`);
    if (results.failed.length > 0) {
        console.log(`  ✗ Failed to clone:          ${results.failed.join(', ')}`);
        console.log(`     (These will be skipped by test/run.mjs; run test/setup.mjs again to retry)\n`);
    }

    const totalReady = results.skipped.length + results.cloned.length;
    if (totalReady === 0) {
        console.error('✗  No fixtures available. Check network connectivity and try again.');
        process.exit(1);
    }

    console.log(`\n✅  ${totalReady} / ${FIXTURES.length} fixtures ready.\n`);
    console.log('Next step:  node test/run.mjs\n');
}

// Run when executed directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch(err => { console.error(err); process.exit(1); });
