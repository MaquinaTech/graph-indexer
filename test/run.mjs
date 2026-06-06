#!/usr/bin/env node
/**
 * test/run.mjs
 *
 * Main test runner for the graph-indexer test suite.
 *
 * Usage:
 *   node test/run.mjs                   # run all suites
 *   node test/run.mjs --suite axios     # run one suite
 *   node test/run.mjs --skip-indexing   # reuse existing code-index.json files
 *   node test/run.mjs --embeddings      # enable Ollama vector embeddings
 *   node test/run.mjs --json            # also write reports/YYYY-MM-DD_HHmmss.json
 *   node test/run.mjs --help
 *
 * Requires fixtures cloned by:  node test/setup.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { FIXTURES_DIR } from './setup.mjs';
import { runSuite } from './harness.mjs';
import {
    fmt, fmtPct, fmtBytes, fmtMs, pad,
    mean, colourScore, colourSavings,
    c,
} from './metrics.mjs';

// ── Suite registry ────────────────────────────────────────────────────────────
import * as axiosSuite from './suites/axios.mjs';
import * as expressJsSuite from './suites/express-js.mjs';
import * as nestjsSuite from './suites/nestjs.mjs';
import * as fastapiSuite from './suites/fastapi.mjs';
import * as ginSuite from './suites/gin.mjs';

const ALL_SUITES = [axiosSuite, expressJsSuite, nestjsSuite, fastapiSuite, ginSuite];

// ── CLI argument parsing ──────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node test/run.mjs [options]

  --suite <id>       Run only the named suite (axios | express-js | nestjs | fastapi | gin)
  --skip-indexing    Reuse existing code-index.json files instead of re-indexing
  --embeddings       Enable Ollama vector embeddings (requires running Ollama + nomic-embed-text)
  --json             Write a JSON report to test/reports/
  --help             Show this message
`);
    process.exit(0);
}

const suiteFilter = args.includes('--suite') ? args[args.indexOf('--suite') + 1] : null;
const skipIndexing = args.includes('--skip-indexing');
const useEmbeddings = args.includes('--embeddings');
const writeJson = args.includes('--json');

// ── Determine which suites to run ─────────────────────────────────────────────
const suitesToRun = suiteFilter
    ? ALL_SUITES.filter(s => s.META.id === suiteFilter)
    : ALL_SUITES;

if (suitesToRun.length === 0) {
    console.error(`✗ Unknown suite: "${suiteFilter}". Valid IDs: ${ALL_SUITES.map(s => s.META.id).join(', ')}`);
    process.exit(1);
}

// Attach the fixtureDir to each suite definition
function prepareSuite(suite) {
    return { ...suite, fixtureDir: path.join(FIXTURES_DIR, suite.META.id) };
}

// ── Report rendering ──────────────────────────────────────────────────────────

const HR1 = '═'.repeat(72);
const HR2 = '─'.repeat(72);
const HR3 = '·'.repeat(72);

function renderSuiteResult(result) {
    const { META, stats, sizes, srcTokens, throughput, aggregate, queryResults, warnings, indexResult } = result;

    if (result.error) {
        console.log(`\n${c.red('✗ ERROR')}: ${result.error}\n`);
        return;
    }

    console.log(`\n${c.bold(HR1)}`);
    console.log(c.bold(c.cyan(`  ${META.displayName}`)));
    console.log(c.bold(HR1));

    // ── Warnings ───────────────────────────────────────────────────────────────
    if (warnings && warnings.length > 0) {
        for (const w of warnings) console.log(`  ${c.yellow('⚠ WARN')}: ${w}`);
        console.log('');
    }

    // ── Indexing stats ─────────────────────────────────────────────────────────
    console.log(c.bold('  INDEXING'));
    console.log('  ' + HR3);
    console.log(`  ${pad('Files processed', 26)} ${c.cyan(stats.fileCount)}`);
    console.log(`  ${pad('Chunks extracted', 26)} ${c.cyan(stats.chunkCount)}`);
    console.log(`  ${pad('  named chunks', 26)} ${fmtPct(stats.namedChunksPct)}`);
    console.log(`  ${pad('  with docstring', 26)} ${fmtPct(stats.docstringPct)}`);
    console.log(`  ${pad('  with call-graph', 26)} ${fmtPct(stats.callsPct)}`);
    console.log(`  ${pad('  with parameters', 26)} ${fmtPct(stats.paramsPct)}`);
    console.log(`  ${pad('Avg chunk tokens (est.)', 26)} ${stats.avgChunkTokens}`);
    console.log(`  ${pad('Median chunk tokens', 26)} ${stats.medChunkTokens}`);
    console.log(`  ${pad('P95 chunk tokens', 26)} ${stats.p95ChunkTokens}`);
    console.log(`  ${pad('Index size (JSON)', 26)} ${fmtBytes(sizes.jsonSize)}`);
    if (sizes.binSize > 0) {
        console.log(`  ${pad('Index size (embeddings)', 26)} ${fmtBytes(sizes.binSize)}`);
    }
    console.log(`  ${pad('Total index size', 26)} ${fmtBytes(sizes.totalSize)}`);
    if (throughput !== null) {
        console.log(`  ${pad('Indexing time', 26)} ${fmtMs(indexResult.wallMs)}`);
        console.log(`  ${pad('Throughput', 26)} ${Math.round(throughput)} chunks/s`);
    }
    console.log(`  ${pad('Source tokens (est.)', 26)} ${srcTokens.toLocaleString()}`);

    // ── Dependency graph ───────────────────────────────────────────────────────
    console.log(`\n  ${c.bold('DEPENDENCY GRAPH')}`);
    console.log('  ' + HR3);
    console.log(`  ${pad('Total import edges', 26)} ${stats.totalDepEdges}`);
    console.log(`  ${pad('Files with imports', 26)} ${stats.filesWithDeps} / ${stats.fileCount} (${fmtPct(stats.filesWithDepsPct)})`);

    // ── Search quality ─────────────────────────────────────────────────────────
    const mode = stats.vectorCount > 0 ? 'hybrid (lexical + vector)' : 'lexical-only (no embeddings)';
    console.log(`\n  ${c.bold('SEARCH QUALITY')}  ${c.dim('— ' + mode)}`);
    console.log('  ' + HR3);

    const agg = aggregate;
    console.log(`  ${pad('Queries tested', 26)} ${agg.queryCount}`);
    console.log(`  ${pad('recall@1', 26)} ${colourScore(agg.recalls[1])}`);
    console.log(`  ${pad('recall@3', 26)} ${colourScore(agg.recalls[3])}`);
    console.log(`  ${pad('recall@5', 26)} ${colourScore(agg.recalls[5])}`);
    console.log(`  ${pad('recall@10', 26)} ${colourScore(agg.recalls[10])}`);
    console.log(`  ${pad('MRR', 26)} ${colourScore(agg.mrr)}`);
    console.log(`  ${pad('nDCG@5', 26)} ${colourScore(agg.ndcgs[5])}`);
    console.log(`  ${pad('Avg search latency', 26)} ${fmtMs(agg.avgSearchMs)}`);

    if (Object.keys(agg.byDifficulty).length > 0) {
        console.log(`\n  ${c.dim('By difficulty:')}`);
        for (const [diff, d] of Object.entries(agg.byDifficulty)) {
            const label = pad(`  ${diff} (${d.count})`, 22);
            console.log(`  ${label}  recall@5: ${colourScore(d.recall5)}   MRR: ${colourScore(d.mrr)}`);
        }
    }

    // ── Token savings ──────────────────────────────────────────────────────────
    console.log(`\n  ${c.bold('TOKEN SAVINGS')}  ${c.dim('(top-5 chunks vs full source files)')}`);
    console.log('  ' + HR3);
    console.log(`  ${pad('Avg savings per query', 26)} ${colourSavings(agg.avgTokenSavings)}`);

    // ── Per-query table ────────────────────────────────────────────────────────
    console.log(`\n  ${c.bold('PER-QUERY DETAIL')}`);
    const QW = 32;  // query column width
    const COL = `  ${'ID'.padEnd(6)}  ${'Query'.padEnd(QW)}  ${'Diff'.padEnd(8)}  ${'Rank'.padStart(4)}  ${'R@5'.padEnd(4)}  ${'Savings'.padStart(7)}  Top result`;
    console.log('  ' + HR3);
    console.log(c.dim(COL));
    console.log('  ' + HR3);

    for (const qr of queryResults) {
        const hit = qr.rank > 0 && qr.rank <= 5;
        const rankStr = qr.rank > 0 ? String(qr.rank).padStart(4) : pad('  --', 4);
        const r5 = hit ? c.green('✓') : c.red('✗');
        const savings = qr.tokenSavings.savingsPct > 0
            ? colourSavings(qr.tokenSavings.savingsPct)
            : c.dim('   --  ');
        const topName = qr.firstHit?.chunk?.name?.slice(0, 24) ?? '';
        const topFile = qr.firstHit?.chunk?.file_path?.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
        const topResult = topName ? `${topName} (${topFile})` : topFile || c.dim('none');

        const queryText = qr.query.length > QW ? qr.query.slice(0, QW - 1) + '…' : qr.query;

        console.log(`  ${qr.id.padEnd(6)}  ${pad(queryText, QW)}  ${pad(qr.difficulty, 8)}  ${rankStr}  ${r5}     ${savings}  ${c.dim(topResult.slice(0, 32))}`);
    }
    console.log('  ' + HR3);
}

// ── Summary table ─────────────────────────────────────────────────────────────

function renderSummary(results) {
    console.log(`\n\n${c.bold(HR1)}`);
    console.log(c.bold(c.cyan('  OVERALL SUMMARY')));
    console.log(c.bold(HR1));

    const header = `  ${'Project'.padEnd(34)}  ${'Lang'.padEnd(12)}  ${'Chunks'.padStart(7)}  ${'Recall@5'.padStart(8)}  ${'MRR'.padStart(5)}  ${'Savings'.padStart(7)}  ${'Time'.padStart(8)}`;
    console.log(c.dim(header));
    console.log('  ' + HR2);

    const validResults = results.filter(r => !r.error);

    for (const r of results) {
        if (r.error) {
            console.log(`  ${pad(r.META.displayName, 34)}  ${c.red('ERROR: ' + r.error.slice(0, 30))}`);
            continue;
        }
        const lang = pad(r.META.language, 12);
        const chunks = String(r.stats.chunkCount).padStart(7);
        const recall5 = colourScore(r.aggregate.recalls[5]).padStart(8 + 10); // +10 for ANSI escape codes
        const mrr = colourScore(r.aggregate.mrr);
        const savings = colourSavings(r.aggregate.avgTokenSavings);
        const timeStr = r.indexResult?.wallMs > 0 ? fmtMs(r.indexResult.wallMs) : c.dim('  cached');
        const name = pad(r.META.displayName, 34);

        console.log(`  ${name}  ${lang}  ${chunks}  ${recall5}  ${mrr}  ${savings}  ${timeStr.padStart(8)}`);
    }

    if (validResults.length > 1) {
        console.log('  ' + HR2);
        const allRecall5 = mean(validResults.map(r => r.aggregate.recalls[5]));
        const allMrr = mean(validResults.map(r => r.aggregate.mrr));
        const allSavings = mean(validResults.map(r => r.aggregate.avgTokenSavings));
        const totalChunks = validResults.reduce((s, r) => s + r.stats.chunkCount, 0);
        const totalMs = validResults.reduce((s, r) => s + (r.indexResult?.wallMs || 0), 0);

        const aggLabel = pad(`  TOTAL / MEAN  (${validResults.length} suites)`, 38);
        console.log(`${c.bold(aggLabel)}  ${String(totalChunks).padStart(7)}  ${colourScore(allRecall5).padStart(8 + 10)}  ${colourScore(allMrr)}  ${colourSavings(allSavings)}  ${fmtMs(totalMs).padStart(8)}`);
    }

    console.log(c.bold(HR1));

    // Final pass/fail badge
    const passed = validResults.filter(r => r.aggregate.recalls[5] >= 0.75).length;
    const total = validResults.length;
    const badge = passed === total ? c.green('ALL PASS') : passed > 0 ? c.yellow(`${passed}/${total} PASS`) : c.red('FAIL');
    const target = 'Target: recall@5 ≥ 0.75 per suite';
    console.log(`\n  ${c.bold(badge)}  ${c.dim(target)}\n`);
}

// ── JSON report writer ────────────────────────────────────────────────────────

function writeJsonReport(results) {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const reportsDir = path.join(__dirname, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });

    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outPath = path.join(reportsDir, `${stamp}.json`);

    // Serialise to plain object (strip non-JSON fields like Buffer)
    const payload = results.map(r => ({
        suite: r.META.id,
        name: r.META.displayName,
        language: r.META.language,
        version: r.META.version,
        error: r.error ?? null,
        indexing: r.error ? null : {
            wallMs: r.indexResult.wallMs,
            chunks: r.stats.chunkCount,
            files: r.stats.fileCount,
            throughput: r.throughput ? Math.round(r.throughput) : null,
            namedChunksPct: r.stats.namedChunksPct,
            docstringPct: r.stats.docstringPct,
            callsPct: r.stats.callsPct,
            avgChunkTokens: r.stats.avgChunkTokens,
            indexSizeBytes: r.sizes.totalSize,
            srcTokensTotal: r.srcTokens,
            totalDepEdges: r.stats.totalDepEdges,
            filesWithDepsPct: r.stats.filesWithDepsPct,
        },
        search: r.error ? null : {
            recalls: r.aggregate.recalls,
            ndcgs: r.aggregate.ndcgs,
            mrr: r.aggregate.mrr,
            avgSearchMs: r.aggregate.avgSearchMs,
            avgTokenSavings: r.aggregate.avgTokenSavings,
            byDifficulty: r.aggregate.byDifficulty,
        },
        queries: r.error ? [] : r.queryResults.map(qr => ({
            id: qr.id,
            query: qr.query,
            difficulty: qr.difficulty,
            rank: qr.rank,
            mrr: qr.reciprocalRank,
            recalls: qr.recalls,
            searchMs: qr.searchMs,
            tokenSavings: qr.tokenSavings,
            topResult: qr.firstHit?.chunk?.name ?? null,
            topFile: qr.firstHit?.chunk?.file_path ?? null,
        })),
        warnings: r.warnings ?? [],
    }));

    fs.writeFileSync(outPath, JSON.stringify({ generatedAt: now.toISOString(), results: payload }, null, 2));
    console.log(`\n  📄  JSON report saved to: ${path.relative(process.cwd(), outPath)}`);
    return outPath;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    // Pre-flight: check that fixtures directory exists
    if (!fs.existsSync(FIXTURES_DIR)) {
        console.error(`\n✗ Fixtures directory not found: ${FIXTURES_DIR}`);
        console.error('  Run:  node test/setup.mjs\n');
        process.exit(1);
    }

    // Filter out missing fixtures and warn
    const availableSuites = [];
    const missingFixtures = [];
    for (const suite of suitesToRun) {
        const fixDir = path.join(FIXTURES_DIR, suite.META.id);
        if (!fs.existsSync(fixDir)) {
            missingFixtures.push(suite.META.id);
        } else {
            availableSuites.push(suite);
        }
    }

    if (availableSuites.length === 0) {
        console.error(`\n✗ No fixtures found. Run:  node test/setup.mjs\n`);
        process.exit(1);
    }

    if (missingFixtures.length > 0) {
        console.log(`\n${c.yellow('⚠ Skipping missing fixtures:')} ${missingFixtures.join(', ')}`);
        console.log(`${c.dim('  To enable them, run: node test/setup.mjs\n')}`);
    }

    // ── Header ────────────────────────────────────────────────────────────────
    const now = new Date();
    const mode = useEmbeddings ? 'hybrid mode (lexical + embeddings)' : 'lexical-only mode (no Ollama required)';
    console.log(`\n${c.bold(HR1)}`);
    console.log(c.bold(c.cyan('  GRAPH-INDEXER TEST SUITE')));
    console.log(c.dim(`  ${now.toISOString().slice(0, 10)}  ·  ${mode}`));
    if (suiteFilter) console.log(c.dim(`  Filtering to suite: ${suiteFilter}`));
    console.log(`${c.bold(HR1)}\n`);

    // ── Run suites ────────────────────────────────────────────────────────────
    const results = [];
    for (const suite of availableSuites) {
        const prepared = prepareSuite(suite);
        const result = await runSuite(prepared, { useEmbeddings, skipIndexing });
        results.push(result);
        renderSuiteResult(result);
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    if (results.length > 1 || availableSuites.length > 1) {
        renderSummary(results);
    }

    // ── JSON export ───────────────────────────────────────────────────────────
    if (writeJson) writeJsonReport(results);

    // ── Exit code ─────────────────────────────────────────────────────────────
    const failed = results.filter(r => r.error || (r.aggregate?.recalls[5] ?? 0) < 0.5).length;
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('\n✗ Unexpected error in test runner:', err);
    process.exit(2);
});
