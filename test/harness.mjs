/**
 * test/harness.mjs
 *
 * Core evaluation harness.  For each suite it:
 *   1. Runs `node indexer.mjs --repo <fixture>` as a child process (with
 *      INDEXER_EMBEDDINGS=off for speed + reproducibility).
 *   2. Loads the resulting code-index.json into a MemoryGraphIndex.
 *   3. Executes all ground-truth queries via searchHybrid(query, null, topK).
 *   4. Collects per-query and aggregate metrics.
 *   5. Returns a structured SuiteResult object consumed by run.mjs.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { MemoryGraphIndex } from '../core-engine.mjs';
import { SqliteGraphStore } from '../sqlite-store.mjs';
import {
    approxTokens,
    recallAtK,
    reciprocalRank,
    ndcgAtK,
    firstRelevantRank,
    computeTokenSavings,
    totalSourceTokens,
    mean,
    median,
    p95,
} from './metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const INDEXER = path.join(ROOT_DIR, 'indexer.mjs');

// ─── Indexer invocation ───────────────────────────────────────────────────────

/**
 * Runs the indexer on a fixture directory.
 * Returns { exitCode, stdout, stderr, wallMs }
 */
export function runIndexer(fixtureDir, { useEmbeddings = false, useSqlite = false, ollamaHost = null } = {}) {
    const env = {
        ...process.env,
        INDEXER_EMBEDDINGS: useEmbeddings ? 'on' : 'off',
    };
    if (ollamaHost) env.OLLAMA_HOST = ollamaHost;

    const args = [INDEXER, '--repo', fixtureDir];
    if (useSqlite) args.push('--use-sqlite');

    const start = Date.now();
    const result = spawnSync(
        process.execPath,
        args,
        { env, encoding: 'utf-8', timeout: 180_000 /* 3 min hard cap */ }
    );
    const wallMs = Date.now() - start;

    return {
        exitCode: result.status ?? -1,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        timedOut: result.signal === 'SIGTERM',
        wallMs,
    };
}

// ─── Index loading & introspection ────────────────────────────────────────────

export function loadIndex(fixtureDir, { useSqlite = false } = {}) {
    // Try to load SQLite backend if available and requested
    if (useSqlite) {
        const dbPath = path.join(fixtureDir, 'code-index.db');
        if (fs.existsSync(dbPath)) {
            const store = new SqliteGraphStore(dbPath, { embeddingPath: path.join(fixtureDir, 'code-index.embeddings.bin') });
            store.load();
            return store;
        }
    }
    // Fallback to memory backend
    const indexPath = path.join(fixtureDir, 'code-index.json');
    if (!fs.existsSync(indexPath)) return null;
    const db = new MemoryGraphIndex(indexPath);
    db.load();
    return db;
}

export function measureIndexSize(fixtureDir) {
    const jsonPath = path.join(fixtureDir, 'code-index.json');
    const dbPath = path.join(fixtureDir, 'code-index.db');
    const binPath = path.join(fixtureDir, 'code-index.embeddings.bin');
    const jsonSize = fs.existsSync(jsonPath) ? fs.statSync(jsonPath).size : 0;
    const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    const binSize = fs.existsSync(binPath) ? fs.statSync(binPath).size : 0;
    return { jsonSize, dbSize, binSize, totalSize: jsonSize + dbSize + binSize };
}

/**
 * Computes static statistics about a loaded index that don't require queries.
 */
export function indexStats(db) {
    if (!db) return null;

    const chunks = Array.from(db.iterateChunks());
    const files = new Set(chunks.map(c => c.file_path));

    const namedChunks = chunks.filter(c => c.name && c.name !== 'anonymous').length;
    const chunksWithDocstring = chunks.filter(c => c.docstring && c.docstring.trim().length > 0).length;
    const chunksWithCalls = chunks.filter(c => c.calls && c.calls.length > 0).length;
    const chunksWithParams = chunks.filter(c => c.params && c.params.length > 0).length;
    const chunksWithVectors = db.vectorCount();

    const chunkTokensList = chunks.map(c => approxTokens(c.code_snippet));
    const avgChunkTokens = chunks.length > 0 ? Math.round(mean(chunkTokensList)) : 0;
    const medChunkTokens = chunks.length > 0 ? Math.round(median(chunkTokensList)) : 0;
    const p95ChunkTokens = chunks.length > 0 ? Math.round(p95(chunkTokensList)) : 0;

    const deps = db.graph?.dependencies || {};
    const totalDepEdges = Object.values(deps).reduce((s, arr) => s + arr.length, 0);
    const filesWithDeps = Object.values(deps).filter(arr => arr.length > 0).length;

    return {
        chunkCount: chunks.length,
        fileCount: files.size,
        vectorCount: chunksWithVectors,
        namedChunks,
        namedChunksPct: chunks.length > 0 ? (namedChunks / chunks.length) * 100 : 0,
        chunksWithDocstring,
        docstringPct: chunks.length > 0 ? (chunksWithDocstring / chunks.length) * 100 : 0,
        chunksWithCalls,
        callsPct: chunks.length > 0 ? (chunksWithCalls / chunks.length) * 100 : 0,
        chunksWithParams,
        paramsPct: chunks.length > 0 ? (chunksWithParams / chunks.length) * 100 : 0,
        avgChunkTokens,
        medChunkTokens,
        p95ChunkTokens,
        totalDepEdges,
        filesWithDeps,
        filesWithDepsPct: files.size > 0 ? (filesWithDeps / files.size) * 100 : 0,
    };
}

// ─── Query evaluation ─────────────────────────────────────────────────────────

/**
 * Runs all queries in a suite against a loaded index.
 * Returns { queryResults, aggregate }
 */
export function runQueries(db, queries, fixtureDir, { queryVectors = null } = {}) {
    const queryResults = [];

    for (const q of queries) {
        const topK = q.topK ?? 10;
        const qVec = queryVectors ? (queryVectors.get(q.id) ?? null) : null;

        // Measure search latency — run each query 3× and take the minimum
        // to reduce scheduling noise.
        let bestMs = Infinity;
        let results;
        for (let trial = 0; trial < 3; trial++) {
            const t0 = process.hrtime.bigint();
            results = db.searchHybrid(q.query, qVec, topK);
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            if (ms < bestMs) bestMs = ms;
        }

        const names = q.expected_names || [];
        const files = q.expected_files || [];

        const rr = reciprocalRank(results, names, files);
        const rank = firstRelevantRank(results, names, files);
        const recalls = {};
        const ndcgs = {};
        for (const k of [1, 3, 5, 10]) {
            recalls[k] = recallAtK(results, names, files, k);
            ndcgs[k] = ndcgAtK(results, names, files, k);
        }

        // Token savings: compare top-5 chunk tokens vs full source files
        const savings5 = computeTokenSavings(results.slice(0, 5), fixtureDir);

        // Surface the best matching chunk for the report
        const firstHitIdx = rank - 1; // -1 if not found
        const firstHit = firstHitIdx >= 0 ? results[firstHitIdx] : null;

        queryResults.push({
            id: q.id,
            query: q.query,
            description: q.description ?? '',
            difficulty: q.difficulty ?? 'medium',
            expected_names: names,
            expected_files: files,
            topK,
            results: results.slice(0, topK),
            rank,
            reciprocalRank: rr,
            recalls,
            ndcgs,
            searchMs: bestMs,
            tokenSavings: savings5,
            firstHit,
        });
    }

    // ── Aggregate ────────────────────────────────────────────────────────────────
    const mrr = mean(queryResults.map(r => r.reciprocalRank));
    const aggRecalls = {};
    const aggNdcgs = {};
    for (const k of [1, 3, 5, 10]) {
        aggRecalls[k] = mean(queryResults.map(r => r.recalls[k]));
        aggNdcgs[k] = mean(queryResults.map(r => r.ndcgs[k]));
    }
    const avgSearchMs = mean(queryResults.map(r => r.searchMs));
    const avgTokenSavings = mean(queryResults.map(r => r.tokenSavings.savingsPct));

    // ── By difficulty ─────────────────────────────────────────────────────────
    const byDifficulty = {};
    for (const diff of ['easy', 'medium', 'hard']) {
        const subset = queryResults.filter(r => r.difficulty === diff);
        if (subset.length === 0) continue;
        byDifficulty[diff] = {
            count: subset.length,
            mrr: mean(subset.map(r => r.reciprocalRank)),
            recall1: mean(subset.map(r => r.recalls[1])),
            recall3: mean(subset.map(r => r.recalls[3])),
            recall5: mean(subset.map(r => r.recalls[5])),
            recall10: mean(subset.map(r => r.recalls[10])),
        };
    }

    return {
        queryResults,
        aggregate: {
            queryCount: queryResults.length,
            mrr,
            recalls: aggRecalls,
            ndcgs: aggNdcgs,
            avgSearchMs,
            avgTokenSavings,
            byDifficulty,
        },
    };
}

// ─── Full suite runner ────────────────────────────────────────────────────────

/**
 * Main entry point used by run.mjs.
 *
 * @param {object} suite  - { META, QUERIES, fixtureDir }
 * @param {object} opts   - { useEmbeddings, skipIndexing }
 * @returns {SuiteResult}
 */
export async function runSuite(suite, opts = {}) {
    const { META, QUERIES, fixtureDir } = suite;
    const { useEmbeddings = false, useSqlite = false, skipIndexing = false, ollamaHost = null, embedFn = null } = opts;

    // ── 1. Optionally run (or re-run) the indexer ─────────────────────────────
    let indexResult = null;
    const indexJsonPath = path.join(fixtureDir, 'code-index.json');
    const dbPath = path.join(fixtureDir, 'code-index.db');
    const binPath = path.join(fixtureDir, 'code-index.embeddings.bin');
    // When embeddings are requested, require the .bin file too; absence → must re-index
    const indexReady = useSqlite
        ? (fs.existsSync(dbPath) && (!useEmbeddings || fs.existsSync(binPath)))
        : (fs.existsSync(indexJsonPath) && (!useEmbeddings || fs.existsSync(binPath)));

    if (!skipIndexing || !indexReady) {
        process.stdout.write(`  ⚙  Indexing ${META.displayName} ... `);
        indexResult = runIndexer(fixtureDir, { useEmbeddings, useSqlite, ollamaHost });

        if (indexResult.timedOut) {
            console.log('TIMEOUT');
            return { META, error: 'Indexer timed out after 3 minutes' };
        }
        if (indexResult.exitCode !== 0) {
            console.log(`FAILED (exit ${indexResult.exitCode})`);
            return { META, error: `Indexer exited ${indexResult.exitCode}`, indexResult };
        }
        console.log(`done  (${(indexResult.wallMs / 1000).toFixed(2)} s)`);
    } else {
        console.log(`  ↩  ${META.displayName} — reusing existing index`);
        indexResult = { wallMs: 0, exitCode: 0, stdout: '', stderr: '' };
    }

    // ── 2. Load the index ─────────────────────────────────────────────────────
    const db = loadIndex(fixtureDir, { useSqlite });
    if (!db) {
        return { META, error: (useSqlite ? 'code-index.db' : 'code-index.json') + ' not found after indexing', indexResult };
    }

    // ── 3. Compute static metrics ─────────────────────────────────────────────
    const stats = indexStats(db);
    const sizes = measureIndexSize(fixtureDir);
    const srcTokens = totalSourceTokens(fixtureDir);
    const throughput = indexResult.wallMs > 0
        ? stats.chunkCount / (indexResult.wallMs / 1000)
        : null;

    // Sanity check against expected minimums
    const warnings = [];
    if (stats.chunkCount < META.expectedMinChunks) {
        warnings.push(`chunk count ${stats.chunkCount} < expected minimum ${META.expectedMinChunks}`);
    }
    if (stats.fileCount < META.expectedMinFiles) {
        warnings.push(`file count ${stats.fileCount} < expected minimum ${META.expectedMinFiles}`);
    }

    // ── 4. Run queries ────────────────────────────────────────────────────────
    let queryVectors = null;
    if (embedFn && db.vectors.size > 0) {
        // Fetch query embeddings in a single batch for efficiency
        queryVectors = await embedFn(QUERIES);
    }
    const { queryResults, aggregate } = runQueries(db, QUERIES, fixtureDir, { queryVectors });

    return {
        META,
        indexResult,
        stats,
        sizes,
        srcTokens,
        throughput,
        queryResults,
        aggregate,
        warnings,
    };
}
