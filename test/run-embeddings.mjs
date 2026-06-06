#!/usr/bin/env node
/**
 * test/run-embeddings.mjs
 *
 * Ollama-powered hybrid-search test runner.
 * Re-indexes every fixture with vector embeddings enabled (nomic-embed-text),
 * fetches query embeddings at evaluation time, and measures the quality
 * improvement from lexical → hybrid (lexical + vector) retrieval.
 *
 * Usage:
 *   node test/run-embeddings.mjs                   # run all suites
 *   node test/run-embeddings.mjs --suite fastapi   # one suite
 *   node test/run-embeddings.mjs --skip-indexing   # reuse existing .bin files
 *   node test/run-embeddings.mjs --json            # write reports/emb-*.json
 *   node test/run-embeddings.mjs --help
 *
 * Requirements:
 *   • Ollama running at $OLLAMA_HOST (default: http://localhost:11435)
 *   • nomic-embed-text model pulled: `ollama pull nomic-embed-text`
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { FIXTURES_DIR } from './setup.mjs';
import { runSuite, runIndexer, loadIndex, indexStats, measureIndexSize, runQueries } from './harness.mjs';
import {
    fmt, fmtPct, fmtBytes, fmtMs, pad,
    mean, colourScore, colourSavings,
    approxTokens, totalSourceTokens,
    c,
} from './metrics.mjs';

// ── Suite registry ────────────────────────────────────────────────────────────
import * as axiosSuite from './suites/axios.mjs';
import * as expressJsSuite from './suites/express-js.mjs';
import * as nestjsSuite from './suites/nestjs.mjs';
import * as fastapiSuite from './suites/fastapi.mjs';
import * as ginSuite from './suites/gin.mjs';

const ALL_SUITES = [axiosSuite, expressJsSuite, nestjsSuite, fastapiSuite, ginSuite];

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node test/run-embeddings.mjs [options]

  --suite <id>       Run only one suite (axios|express-js|nestjs|fastapi|gin)
  --skip-indexing    Reuse existing code-index.json + code-index.embeddings.bin
  --json             Write JSON report to test/reports/
  --ollama-host <u>  Override Ollama URL (default: http://localhost:11435)
  --help             Show this message
`);
    process.exit(0);
}

const suiteFilter = args.includes('--suite') ? args[args.indexOf('--suite') + 1] : null;
const skipIndexing = args.includes('--skip-indexing');
const writeJson = args.includes('--json');
const ollamaHost = args.includes('--ollama-host')
    ? args[args.indexOf('--ollama-host') + 1]
    : (process.env.OLLAMA_HOST || 'http://localhost:11435');
const EMBED_MODEL = 'nomic-embed-text';

// ── Colour helpers ────────────────────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';

function colourDelta(delta) {
    if (delta > 0.005) return `${GREEN}+${fmt(delta)}${RESET}`;
    if (delta < -0.005) return `${RED}${fmt(delta)}${RESET}`;
    return `${DIM}±${fmt(Math.abs(delta))}${RESET}`;
}

// ── Ollama helpers ────────────────────────────────────────────────────────────
async function checkOllama() {
    try {
        const res = await fetch(`${ollamaHost}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const data = await res.json();
        const models = (data.models || []).map(m => m.name);
        const hasEmbed = models.some(m => m.startsWith(EMBED_MODEL));
        return { ok: true, models, hasEmbed };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Fetch embeddings for an array of text strings from Ollama's /api/embed.
 * Uses "search_query:" prefix as required by nomic-embed-text.
 * Returns Float32Array[] in the same order as inputs, or throws.
 */
async function fetchQueryEmbeddings(texts) {
    const prefixed = texts.map(t => `search_query: ${t.length > 4000 ? t.slice(0, 4000) : t}`);
    const res = await fetch(`${ollamaHost}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: prefixed }),
        signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Ollama /api/embed error: HTTP ${res.status}`);
    const data = await res.json();
    return (data.embeddings || []).map(e => new Float32Array(e));
}

/**
 * Returns a Map<queryId, Float32Array> for all queries in a suite.
 */
async function buildQueryVectorMap(queries) {
    process.stdout.write(`    ${DIM}embedding ${queries.length} queries ...${RESET} `);
    const t0 = Date.now();
    const texts = queries.map(q => q.query);
    const vecs = await fetchQueryEmbeddings(texts);
    const ms = Date.now() - t0;
    console.log(`${DIM}(${ms} ms)${RESET}`);
    const map = new Map();
    queries.forEach((q, i) => map.set(q.id, vecs[i]));
    return map;
}

// ── Report helpers ────────────────────────────────────────────────────────────
const LINE = '═'.repeat(72);
const DASH = '─'.repeat(72);

function box(text) { return `${BOLD}${text}${RESET}`; }

function rankCell(rank) {
    if (rank === -1) return `${DIM}--${RESET}`;
    if (rank === 1) return `${GREEN}${rank}${RESET}`;
    if (rank <= 3) return `${YELLOW}${rank}${RESET}`;
    return `${RED}${rank}${RESET}`;
}

function passCell(pass) {
    return pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
}

function diffCell(lexical, hybrid) {
    if (lexical === hybrid) return `${DIM}→${RESET}`;
    if (hybrid < lexical) return `${GREEN}↑${RESET}`; // better (lower rank)
    return `${RED}↓${RESET}`;
}

function printSuiteReport(meta, lexRes, hybRes, stats, sizes, indexMs, embedMs) {
    const lAgg = lexRes.aggregate;
    const hAgg = hybRes.aggregate;
    const delta5 = hAgg.recalls[5] - lAgg.recalls[5];
    const deltaMRR = hAgg.mrr - lAgg.mrr;

    console.log(`\n${LINE}`);
    console.log(`  ${box(meta.displayName)}  (${meta.language})`);
    console.log(LINE);

    // ── Indexing ──────────────────────────────────────────────────────────────
    console.log(`  ${BOLD}INDEXING${RESET}`);
    console.log(`    chunks      ${stats.chunkCount.toLocaleString()}   files: ${stats.fileCount.toLocaleString()}   vectors: ${stats.vectorCount.toLocaleString()}`);
    console.log(`    index time  ${indexMs > 0 ? fmtMs(indexMs) : 'cached'}   embed time (queries): ${fmtMs(embedMs)}`);
    console.log(`    index size  json ${fmtBytes(sizes.jsonSize)}   bin ${fmtBytes(sizes.binSize)}`);

    // ── Search quality ────────────────────────────────────────────────────────
    console.log(`\n  ${BOLD}SEARCH QUALITY${RESET}`);
    console.log(`  ${'Metric'.padEnd(18)} ${'Lexical'.padStart(9)}  ${'Hybrid'.padStart(9)}  ${'Δ'.padStart(8)}`);
    console.log(`  ${DASH.slice(0, 50)}`);
    for (const k of [1, 3, 5, 10]) {
        const l = lAgg.recalls[k];
        const h = hAgg.recalls[k];
        console.log(`  recall@${k}${' '.repeat(10 - String(k).length)} ${colourScore(l).padStart(18)}  ${colourScore(h).padStart(18)}  ${colourDelta(h - l).padStart(18)}`);
    }
    console.log(`  MRR               ${colourScore(lAgg.mrr).padStart(18)}  ${colourScore(hAgg.mrr).padStart(18)}  ${colourDelta(deltaMRR).padStart(18)}`);
    const lndcg = lAgg.ndcgs[5]; const hndcg = hAgg.ndcgs[5];
    console.log(`  nDCG@5            ${colourScore(lndcg).padStart(18)}  ${colourScore(hndcg).padStart(18)}  ${colourDelta(hndcg - lndcg).padStart(18)}`);
    console.log(`  avg search ms     ${fmt(lAgg.avgSearchMs).padStart(9)}  ${fmt(hAgg.avgSearchMs).padStart(9)}`);

    // ── Per-query ─────────────────────────────────────────────────────────────
    console.log(`\n  ${BOLD}PER - QUERY DETAIL${RESET}`);
    console.log(`  ${'ID'.padEnd(6)} ${'Query'.padEnd(34)} ${'Diff'.padEnd(8)} ${'Lex'.padStart(4)} ${'Hyb'.padStart(4)} ${'R@5'.padStart(5)}  ${'Top result (hybrid)'.padEnd(30)}`);
    console.log(`  ${DASH}`);

    for (const hq of hybRes.queryResults) {
        const lq = lexRes.queryResults.find(q => q.id === hq.id);
        const lRank = lq?.rank ?? -1;
        const hRank = hq.rank;
        const pass = hq.recalls[5] === 1;
        const topChunk = hq.firstHit?.chunk ?? hq.results?.[0]?.chunk;
        const topName = topChunk ? `${topChunk.name}(${path.basename(topChunk.file_path, path.extname(topChunk.file_path))})` : 'none';

        console.log(
            `  ${hq.id.padEnd(6)} ${hq.query.slice(0, 33).padEnd(34)} ${(hq.difficulty ?? '').padEnd(8)} ` +
            `${rankCell(lRank).padStart(13)} ${rankCell(hRank).padStart(13)} ${passCell(pass)} ${DIM}${fmtPct(hq.tokenSavings?.savingsPct ?? 0)}${RESET}  ${topName.slice(0, 30)} `
        );
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
    console.log(`\n${LINE} `);
    console.log(`  ${BOLD} GRAPH - INDEXER EMBEDDING TEST SUITE${RESET} (nomic - embed - text via Ollama)`);
    console.log(`  Host: ${CYAN}${ollamaHost}${RESET} Model: ${CYAN}${EMBED_MODEL}${RESET} `);
    console.log(LINE);

    // 1. Connectivity check
    process.stdout.write(`  Checking Ollama ... `);
    const ollamaStatus = await checkOllama();
    if (!ollamaStatus.ok) {
        console.log(`${RED}FAILED${RESET} — ${ollamaStatus.error} `);
        console.log(`  Make sure Ollama is running: ollama serve`);
        process.exit(1);
    }
    if (!ollamaStatus.hasEmbed) {
        console.log(`${RED}FAILED${RESET} — model "${EMBED_MODEL}" not found`);
        console.log(`  Pull it first: ollama pull ${EMBED_MODEL} `);
        process.exit(1);
    }
    console.log(`${GREEN}OK${RESET} (${ollamaStatus.models.length} models available)`);

    // 2. Build suite list
    const suites = ALL_SUITES.filter(s => {
        if (suiteFilter && s.META.id !== suiteFilter) return false;
        const fixtureDir = path.join(FIXTURES_DIR, s.META.id);
        if (!fs.existsSync(fixtureDir)) {
            console.log(`  ${YELLOW}SKIP${RESET}  ${s.META.id} — fixture not found(run: node test / setup.mjs)`);
            return false;
        }
        return true;
    }).map(s => ({ ...s, fixtureDir: path.join(FIXTURES_DIR, s.META.id) }));

    if (suites.length === 0) {
        console.log(`\n  No suites to run.Check--suite or run node test / setup.mjs`);
        process.exit(1);
    }

    // 3. Run suites
    const allSuiteResults = [];

    for (const suite of suites) {
        const { META, QUERIES, fixtureDir } = suite;
        console.log(`\n  Processing ${BOLD}${META.displayName}${RESET} ...`);

        // 3a. Index with embeddings
        const binPath = path.join(fixtureDir, 'code-index.embeddings.bin');
        const jsonPath = path.join(fixtureDir, 'code-index.json');
        const alreadyIndexed = skipIndexing && fs.existsSync(jsonPath) && fs.existsSync(binPath);

        let indexMs = 0;
        if (!alreadyIndexed) {
            process.stdout.write(`    indexing with embeddings ... `);
            const t0 = Date.now();
            const ir = runIndexer(fixtureDir, { useEmbeddings: true, ollamaHost });
            indexMs = Date.now() - t0;
            if (ir.exitCode !== 0 || ir.timedOut) {
                console.log(`${RED}FAILED${RESET} (exit ${ir.exitCode})`);
                console.error(ir.stderr.slice(-500));
                allSuiteResults.push({ META, error: 'Indexer failed' });
                continue;
            }
            console.log(`${GREEN}done${RESET} (${(indexMs / 1000).toFixed(1)}s)`);
        } else {
            console.log(`    ${DIM}reusing existing index + embeddings${RESET} `);
        }

        // 3b. Load index
        const db = loadIndex(fixtureDir);
        if (!db) {
            allSuiteResults.push({ META, error: 'Failed to load index' });
            continue;
        }
        const stats = indexStats(db);
        const sizes = measureIndexSize(fixtureDir);
        const srcTokens = totalSourceTokens(fixtureDir);

        console.log(`    ${stats.chunkCount.toLocaleString()} chunks  ${stats.vectorCount.toLocaleString()} vectors  ${stats.fileCount.toLocaleString()} files`);

        // 3c. Lexical baseline (no query vectors)
        const lexRun = runQueries(db, QUERIES, fixtureDir, { queryVectors: null });

        // 3d. Query embeddings from Ollama
        let embedMs = 0;
        let queryVectors = null;
        try {
            const et0 = Date.now();
            queryVectors = await buildQueryVectorMap(QUERIES);
            embedMs = Date.now() - et0;
        } catch (err) {
            console.log(`    ${RED}Query embedding failed: ${err.message}${RESET} `);
        }

        // 3e. Hybrid run (with query vectors)
        const hybRun = runQueries(db, QUERIES, fixtureDir, { queryVectors });

        // 3f. Print per-suite report
        printSuiteReport(META, lexRun, hybRun, stats, sizes, indexMs, embedMs);

        allSuiteResults.push({
            META, stats, sizes, srcTokens,
            lexical: lexRun.aggregate,
            hybrid: hybRun.aggregate,
            lexQueryResults: lexRun.queryResults,
            hybQueryResults: hybRun.queryResults,
            indexMs, embedMs,
        });
    }

    // 4. Overall summary
    const valid = allSuiteResults.filter(r => !r.error);
    if (valid.length === 0) {
        console.log('\n  No results to summarise.');
        process.exit(1);
    }

    const overallLexR5 = mean(valid.map(r => r.lexical.recalls[5]));
    const overallHybR5 = mean(valid.map(r => r.hybrid.recalls[5]));
    const overallLexMRR = mean(valid.map(r => r.lexical.mrr));
    const overallHybMRR = mean(valid.map(r => r.hybrid.mrr));

    console.log(`\n\n${LINE} `);
    console.log(`  ${BOLD}OVERALL SUMMARY${RESET} `);
    console.log(LINE);
    console.log(`  ${'Project'.padEnd(36)} ${'Lang'.padEnd(14)} ${'Chunks'.padStart(7)}  ${'Lex R@5'.padStart(8)}  ${'Hyb R@5'.padStart(8)}  ${'Δ'.padStart(6)}  ${'Lex MRR'.padStart(8)}  ${'Hyb MRR'.padStart(8)} `);
    console.log(`  ${DASH} `);

    for (const r of valid) {
        const lr5 = r.lexical.recalls[5];
        const hr5 = r.hybrid.recalls[5];
        const lmrr = r.lexical.mrr;
        const hmrr = r.hybrid.mrr;
        const d = hr5 - lr5;
        console.log(
            `  ${r.META.displayName.padEnd(36)} ${r.META.language.padEnd(14)} ` +
            `${r.stats.chunkCount.toLocaleString().padStart(7)} ` +
            `${colourScore(lr5).padStart(18)}  ${colourScore(hr5).padStart(18)}  ${colourDelta(d).padStart(16)} ` +
            `${colourScore(lmrr).padStart(18)}  ${colourScore(hmrr).padStart(18)} `
        );
    }

    console.log(`  ${DASH} `);
    console.log(
        `  ${'TOTAL / MEAN'.padEnd(36)} ${' '.repeat(14)} ${' '.repeat(7)} ` +
        `${colourScore(overallLexR5).padStart(18)}  ${colourScore(overallHybR5).padStart(18)} ` +
        `${colourDelta(overallHybR5 - overallLexR5).padStart(16)} ` +
        `${colourScore(overallLexMRR).padStart(18)}  ${colourScore(overallHybMRR).padStart(18)} `
    );
    console.log(LINE);

    const allPassHybrid = valid.every(r => r.hybrid.recalls[5] >= 0.85);
    const allPassLex = valid.every(r => r.lexical.recalls[5] >= 0.85);
    if (allPassHybrid) {
        console.log(`\n  ${GREEN}${BOLD}ALL PASS${RESET} (hybrid recall @5 ≥ 0.85 for every suite)`);
    } else {
        const failing = valid.filter(r => r.hybrid.recalls[5] < 0.85).map(r => r.META.id);
        console.log(`\n  ${RED}${BOLD}FAILING${RESET}  suites below 0.85 hybrid recall @5: ${failing.join(', ')} `);
    }
    console.log();

    // 5. Optional JSON dump
    if (writeJson) {
        const reportsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reports');
        fs.mkdirSync(reportsDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const outPath = path.join(reportsDir, `emb - ${ts}.json`);
        fs.writeFileSync(outPath, JSON.stringify({
            runAt: new Date().toISOString(),
            ollamaHost,
            embedModel: EMBED_MODEL,
            suites: valid.map(r => ({
                id: r.META.id,
                displayName: r.META.displayName,
                language: r.META.language,
                chunkCount: r.stats.chunkCount,
                vectorCount: r.stats.vectorCount,
                lexical: r.lexical,
                hybrid: r.hybrid,
            })),
            overall: { lexicalRecall5: overallLexR5, hybridRecall5: overallHybR5, lexicalMRR: overallLexMRR, hybridMRR: overallHybMRR },
        }, null, 2));
        console.log(`  JSON report written to ${path.relative(process.cwd(), outPath)} \n`);
    }

    process.exit(allPassHybrid ? 0 : 1);
})();
