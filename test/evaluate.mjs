#!/usr/bin/env node
/**
 * test/evaluate.mjs
 *
 * Evaluation harness.
 *
 * The default suite runner (test/run.mjs) scores a query as a "hit" when ANY
 * top-k result's `name` *contains* an expected substring OR its `file_path`
 * *contains* an expected substring. That is a permissive *hit-rate*, not recall,
 * and the file-path fallback lets the WRONG symbol count as a perfect hit as
 * long as it lives in the right file (e.g. Gin's GN08 returns `StaticFS` at
 * rank 1 for "GET POST route handler register" and still scores 1.00, because
 * StaticFS is defined in routergroup.go).
 *
 * This harness re-scores the exact same queries with STRICT, symbol-level
 * ground truth so the real retrieval quality is visible:
 *
 *   - strictRelevant: the result's symbol NAME (whole, or its last dotted
 *     component) must EXACTLY equal one of the expected names. No substring
 *     matching, no file-path fallback.
 *   - success@k (loose)   — the old metric, kept for comparison.
 *   - success@k (strict)  — at least one strictly-correct symbol in top-k.
 *   - precision@k         — fraction of top-k that are strictly correct.
 *   - rank1               — is the #1 result the correct symbol? (what an
 *                           agent actually consumes first)
 *   - MRR (strict)        — mean reciprocal rank under strict matching.
 *   - nDCG@k (strict)     — correctly normalised to [0, 1].
 *   - fileOnlyHitRate     — fraction of loose hits that are NOT strict hits,
 *                           i.e. how much of the headline number is inflation.
 *
 * Usage:
 *   node test/evaluate.mjs                 # all suites, reuse existing indexes
 *   node test/evaluate.mjs --suite gin     # one suite
 *   node test/evaluate.mjs --embeddings    # include vector embeddings in ranking
 *   node test/evaluate.mjs --use-sqlite    # test SQLite backend instead of in-memory
 *   node test/evaluate.mjs --json          # write test/reports/eval-<ts>.json
 *   node test/evaluate.mjs --verbose       # per-query breakdown
 *
 * Requires indexes built first:  node test/run.mjs --use-sqlite  (or node test/run.mjs for memory)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { FIXTURES_DIR } from './setup.mjs';
import { loadIndex } from './harness.mjs';
import { mean, fmt, fmtPct, pad, c } from './metrics.mjs';
import { isNaturalLanguageQuery } from '../search-core.mjs';
import { rerankResults } from '../enrichment.mjs';
import { ollamaGenerate } from '../providers.mjs';

import * as axiosSuite from './suites/axios.mjs';
import * as expressJsSuite from './suites/express-js.mjs';
import * as nestjsSuite from './suites/nestjs.mjs';
import * as fastapiSuite from './suites/fastapi.mjs';
import * as ginSuite from './suites/gin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALL_SUITES = [axiosSuite, expressJsSuite, nestjsSuite, fastapiSuite, ginSuite];

const args = process.argv.slice(2);
const suiteFilter = args.includes('--suite') ? args[args.indexOf('--suite') + 1] : null;
const writeJson = args.includes('--json');
const verbose = args.includes('--verbose') || args.includes('-v');
const useEmbeddings = args.includes('--embeddings');
const useSqlite = args.includes('--use-sqlite');
const useRerank = args.includes('--rerank');
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';
const RERANK_MODEL = process.env.RERANK_MODEL || 'qwen2.5-coder:1.5b';

const KS = [1, 3, 5, 10];

/**
 * Embed the suite's queries via Ollama for the hybrid (lexical+vector) channel.
 * Uses the "search_query:" prefix required by nomic-embed-text (mirrors
 * test/run-embeddings.mjs). Returns Map<queryId, Float32Array> or null on failure.
 */
async function embedQueries(queries) {
    const input = queries.map(q => `search_query: ${q.query}`);
    const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input }),
    });
    if (!res.ok) throw new Error(`Ollama /api/embed HTTP ${res.status}`);
    const data = await res.json();
    const map = new Map();
    queries.forEach((q, i) => map.set(q.id, new Float32Array(data.embeddings[i])));
    return map;
}

// ─── Relevance predicates ──────────────────────────────────────────────────────

/** LOOSE (legacy): name-substring OR file-substring. Mirrors metrics.mjs. */
function looseRelevant(result, expectedNames, expectedFiles) {
    if (!result?.chunk) return false;
    const name = (result.chunk.name || '').toLowerCase();
    const filePath = (result.chunk.file_path || '').toLowerCase();
    const nameHit = (expectedNames || []).some(n => name.includes(n.toLowerCase()));
    const fileHit = (expectedFiles || []).some(f => filePath.includes(f.toLowerCase()));
    return nameHit || fileHit;
}

/**
 * STRICT: the result's symbol name must EXACTLY equal one of the expected names —
 * matched against the whole name, any dotted/`::`/`#` component of it (so
 * `Layer.prototype.handle` matches expected `Layer` or `handle`), or the chunk's
 * `class_context` (so the `__init__` method chunk of class `APIRouter` counts
 * when the ground truth lists `APIRouter` — oversized classes are indexed as
 * one chunk per method, and an agent that received that method HAS found the
 * class). No substring matching, no file-path fallback.
 */
function strictRelevant(result, expectedNames) {
    if (!result?.chunk) return false;
    const raw = (result.chunk.name || '').toLowerCase();
    if (!raw) return false;
    const parts = new Set(raw.split(/[.#:]/).filter(Boolean));
    parts.add(raw);
    const ctx = (result.chunk.class_context || '').toLowerCase();
    if (ctx) parts.add(ctx);
    return (expectedNames || []).some(n => parts.has(n.toLowerCase()));
}

// ─── Metric primitives ─────────────────────────────────────────────────────────

function successAtK(results, isRel, k) {
    return results.slice(0, k).some(isRel) ? 1 : 0;
}
function precisionAtK(results, isRel, k) {
    const top = results.slice(0, k);
    if (top.length === 0) return 0;
    return top.filter(isRel).length / top.length;
}
function reciprocalRank(results, isRel) {
    for (let i = 0; i < results.length; i++) if (isRel(results[i])) return 1 / (i + 1);
    return 0;
}
function firstRank(results, isRel) {
    for (let i = 0; i < results.length; i++) if (isRel(results[i])) return i + 1;
    return -1;
}
/** Correctly normalised binary nDCG@k ∈ [0,1]. IDCG places min(#relevant_in_topk, k) hits up front. */
function ndcgAtK(results, isRel, k) {
    const top = results.slice(0, k);
    let dcg = 0;
    let relCount = 0;
    for (let i = 0; i < top.length; i++) {
        if (isRel(top[i])) { dcg += 1 / Math.log2(i + 2); relCount++; }
    }
    let idcg = 0;
    for (let i = 0; i < relCount; i++) idcg += 1 / Math.log2(i + 2);
    return idcg > 0 ? dcg / idcg : 0;
}

// ─── Per-suite evaluation ──────────────────────────────────────────────────────

async function evaluateSuite(suite) {
    const fixtureDir = path.join(FIXTURES_DIR, suite.META.id);
    const db = loadIndex(fixtureDir, { useSqlite });
    if (!db) return { META: suite.META, error: 'index not found — run `node test/run.mjs` first' };

    // Optional hybrid channel: embed queries and pass vectors into searchHybrid.
    let queryVectors = null;
    if (useEmbeddings) {
        if (db.vectorCount() === 0) {
            return { META: suite.META, error: 'no embeddings in index — re-index with INDEXER_EMBEDDINGS=on' };
        }
        try { queryVectors = await embedQueries(suite.QUERIES); }
        catch (e) { return { META: suite.META, error: `query embedding failed: ${e.message}` }; }
    }

    const rows = [];
    for (const q of suite.QUERIES) {
        const topK = Math.max(q.topK ?? 10, 10);
        const qVec = queryVectors ? (queryVectors.get(q.id) ?? null) : null;
        let results = db.searchHybrid(q.query, qVec, topK);
        // Mirrors the production gate in mcp-tools: rerank only natural-language
        // queries, best-effort, original order on any failure.
        if (useRerank && isNaturalLanguageQuery(q.query)) {
            results = await rerankResults(q.query, results, {
                generate: (prompt) => ollamaGenerate(prompt, {
                    model: RERANK_MODEL, ollamaHost: OLLAMA_HOST, timeoutMs: 30000,
                    options: { temperature: 0, num_predict: 40 },
                }),
            });
        }
        const names = q.expected_names || [];
        const files = q.expected_files || [];

        const isLoose = (r) => looseRelevant(r, names, files);
        const isStrict = (r) => strictRelevant(r, names);

        const row = {
            id: q.id, query: q.query, difficulty: q.difficulty ?? 'medium',
            expected_names: names,
            top1: results[0] ? { name: results[0].chunk?.name, file: results[0].chunk?.file_path } : null,
            looseSuccess: {}, strictSuccess: {}, precision: {}, ndcg: {},
            rank1Strict: results[0] ? (isStrict(results[0]) ? 1 : 0) : 0,
            mrrStrict: reciprocalRank(results, isStrict),
            mrrLoose: reciprocalRank(results, isLoose),
            strictRank: firstRank(results, isStrict),
            looseRank: firstRank(results, isLoose),
        };
        for (const k of KS) {
            row.looseSuccess[k] = successAtK(results, isLoose, k);
            row.strictSuccess[k] = successAtK(results, isStrict, k);
            row.precision[k] = precisionAtK(results, isStrict, k);
            row.ndcg[k] = ndcgAtK(results, isStrict, k);
        }
        // A "file-only hit" = counted as loose hit at k=5 but never strictly correct.
        row.fileOnlyHit = (row.looseSuccess[5] === 1 && row.strictSuccess[5] === 0) ? 1 : 0;
        rows.push(row);
    }

    const agg = (sel) => mean(rows.map(sel));
    const aggregate = {
        queryCount: rows.length,
        looseSuccess: Object.fromEntries(KS.map(k => [k, agg(r => r.looseSuccess[k])])),
        strictSuccess: Object.fromEntries(KS.map(k => [k, agg(r => r.strictSuccess[k])])),
        precision: Object.fromEntries(KS.map(k => [k, agg(r => r.precision[k])])),
        ndcg: Object.fromEntries(KS.map(k => [k, agg(r => r.ndcg[k])])),
        rank1Strict: agg(r => r.rank1Strict),
        mrrStrict: agg(r => r.mrrStrict),
        mrrLoose: agg(r => r.mrrLoose),
        fileOnlyHitRate: agg(r => r.fileOnlyHit),
    };
    return { META: suite.META, rows, aggregate };
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

function scoreColour(n) {
    const s = fmt(n);
    if (n >= 0.75) return c.green(s);
    if (n >= 0.5) return c.yellow(s);
    return c.red(s);
}

function render(result) {
    if (result.error) { console.log(`\n${c.red('✗')} ${result.META.displayName}: ${result.error}`); return; }
    const a = result.aggregate;

    // Partition rows into symbolic (easy/medium/hard) vs semantic (agent-style conceptual queries)
    const symbolicRows = result.rows.filter(r => r.difficulty !== 'semantic');
    const semanticRows = result.rows.filter(r => r.difficulty === 'semantic');
    const symCount = symbolicRows.length;
    const semCount = semanticRows.length;

    console.log(`\n${c.bold(c.cyan(result.META.displayName))}  ${c.dim(`(${a.queryCount} queries: ${symCount} symbolic + ${semCount} semantic)`)}`);
    console.log('  ' + '─'.repeat(70));
    console.log(`  ${pad('success@5  loose (legacy)', 30)} ${scoreColour(a.looseSuccess[5])}`);
    console.log(`  ${pad('success@5  strict', 30)} ${scoreColour(a.strictSuccess[5])}`);
    console.log(`  ${pad('rank-1 strict accuracy', 30)} ${scoreColour(a.rank1Strict)}`);
    console.log(`  ${pad('precision@5 strict', 30)} ${scoreColour(a.precision[5])}`);
    console.log(`  ${pad('MRR strict', 30)} ${scoreColour(a.mrrStrict)}  ${c.dim('(loose ' + fmt(a.mrrLoose) + ')')}`);
    console.log(`  ${pad('nDCG@5 strict', 30)} ${scoreColour(a.ndcg[5])}`);
    console.log(`  ${pad('file-only inflated hits', 30)} ${a.fileOnlyHitRate > 0 ? c.red(fmtPct(a.fileOnlyHitRate)) : c.green('0.0%')}`);

    // Semantic channel breakdown — highlights the benchmark mismatch the PROMPT.md revealed:
    // symbolic queries test name-lookup (what agents use resolve_symbol for), while semantic
    // queries test the actual search_code use case (behavioral descriptions, no symbol names).
    if (semCount > 0) {
        const semR1 = mean(semanticRows.map(r => r.rank1Strict));
        const semMRR = mean(semanticRows.map(r => r.mrrStrict));
        const semS5 = mean(semanticRows.map(r => r.strictSuccess[5]));
        const symR1 = symCount > 0 ? mean(symbolicRows.map(r => r.rank1Strict)) : null;
        const symMRR = symCount > 0 ? mean(symbolicRows.map(r => r.mrrStrict)) : null;
        console.log(`  ${'┄'.repeat(70)}`);
        console.log(`  ${c.dim('Breakdown by query type:')}`);
        if (symCount > 0) {
            console.log(`  ${c.dim(pad(`  symbolic  (${symCount}q)`, 32))} rank-1: ${scoreColour(symR1)}  MRR: ${scoreColour(symMRR)}`);
        }
        const semNote = useEmbeddings ? '' : c.dim('  ← best with --embeddings');
        console.log(`  ${c.dim(pad(`  semantic  (${semCount}q)`, 32))} rank-1: ${scoreColour(semR1)}  MRR: ${scoreColour(semMRR)}  s@5: ${scoreColour(semS5)}${semNote}`);
    }

    if (verbose) {
        console.log('  ' + c.dim('·'.repeat(70)));
        console.log('  ' + c.dim(pad('ID', 7) + pad('Diff', 10) + pad('strictR1', 9) + pad('looseR', 8) + pad('strictR', 8) + 'top-1 (name @ file)'));
        for (const r of result.rows) {
            const flag = r.fileOnlyHit ? c.red('⚠ file-only') : '';
            const t1 = r.top1 ? `${r.top1.name} @ ${r.top1.file}` : '∅';
            const diffColour = r.difficulty === 'semantic' ? c.cyan(pad(r.difficulty, 10)) : c.dim(pad(r.difficulty, 10));
            console.log('  ' + pad(r.id, 7) + diffColour
                + pad(r.rank1Strict ? '✓' : '✗', 9)
                + pad(r.looseRank < 0 ? '—' : String(r.looseRank), 8)
                + pad(r.strictRank < 0 ? '—' : String(r.strictRank), 8)
                + c.dim(t1) + (flag ? '  ' + flag : ''));
        }
    }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const suites = suiteFilter ? ALL_SUITES.filter(s => s.META.id === suiteFilter) : ALL_SUITES;
if (suites.length === 0) { console.error(`Unknown suite: ${suiteFilter}`); process.exit(1); }

console.log('\n' + c.bold('═'.repeat(72)));
console.log(c.bold('  EVALUATION  ') + c.dim('— strict symbol-level ground truth (no file-path fallback)'));
console.log(c.dim(`  channel: ${useEmbeddings ? `hybrid (lexical + ${EMBED_MODEL} @ ${OLLAMA_HOST})` : 'lexical-only'}${useRerank ? ` + LLM rerank (${RERANK_MODEL})` : ''}`));
console.log(c.bold('═'.repeat(72)));

const results = [];
for (const s of suites) results.push(await evaluateSuite(s));
for (const r of results) render(r);

// Overall
const ok = results.filter(r => !r.error);
if (ok.length > 0) {
    const m = (sel) => mean(ok.map(sel));
    console.log('\n' + c.bold('═'.repeat(72)));
    console.log(c.bold(c.cyan('  OVERALL (mean across suites)')));
    console.log('═'.repeat(72));
    const hdr = pad('', 24) + pad('loose', 9) + pad('strict', 9);
    console.log(c.dim(hdr));
    console.log(`  ${pad('success@1', 22)} ${pad(fmt(m(r => r.aggregate.looseSuccess[1])), 9)} ${scoreColour(m(r => r.aggregate.strictSuccess[1]))}`);
    console.log(`  ${pad('success@5', 22)} ${pad(fmt(m(r => r.aggregate.looseSuccess[5])), 9)} ${scoreColour(m(r => r.aggregate.strictSuccess[5]))}`);
    console.log(`  ${pad('rank-1 accuracy', 22)} ${pad('—', 9)} ${scoreColour(m(r => r.aggregate.rank1Strict))}`);
    console.log(`  ${pad('precision@5', 22)} ${pad('—', 9)} ${scoreColour(m(r => r.aggregate.precision[5]))}`);
    console.log(`  ${pad('MRR', 22)} ${pad(fmt(m(r => r.aggregate.mrrLoose)), 9)} ${scoreColour(m(r => r.aggregate.mrrStrict))}`);
    console.log(`  ${pad('nDCG@5', 22)} ${pad('—', 9)} ${scoreColour(m(r => r.aggregate.ndcg[5]))}`);
    console.log(`  ${pad('file-only inflation', 22)} ${pad('—', 9)} ${m(r => r.aggregate.fileOnlyHitRate) > 0 ? c.red(fmtPct(m(r => r.aggregate.fileOnlyHitRate))) : c.green('0.0%')}`);

    // Semantic vs symbolic cross-suite summary
    const allRows = ok.flatMap(r => r.rows || []);
    const semAllRows = allRows.filter(r => r.difficulty === 'semantic');
    const symAllRows = allRows.filter(r => r.difficulty !== 'semantic');
    if (semAllRows.length > 0) {
        console.log(`  ${'┄'.repeat(68)}`);
        console.log(c.dim(`  Agent-style query channel (${semAllRows.length} semantic queries across suites):`));
        const semR1 = mean(semAllRows.map(r => r.rank1Strict));
        const semMRR = mean(semAllRows.map(r => r.mrrStrict));
        const semS5 = mean(semAllRows.map(r => r.strictSuccess[5]));
        const symR1 = symAllRows.length > 0 ? mean(symAllRows.map(r => r.rank1Strict)) : null;
        const symMRR = symAllRows.length > 0 ? mean(symAllRows.map(r => r.mrrStrict)) : null;
        if (symAllRows.length > 0) {
            console.log(`  ${pad('  symbolic (name-lookup)', 30)} rank-1: ${scoreColour(symR1)}  MRR: ${scoreColour(symMRR)}`);
        }
        const embNote = useEmbeddings ? '' : c.dim('  (run with --embeddings for true semantic quality)');
        console.log(`  ${pad('  semantic (agent-style)', 30)} rank-1: ${scoreColour(semR1)}  MRR: ${scoreColour(semMRR)}  s@5: ${scoreColour(semS5)}${embNote}`);
    }
    console.log('═'.repeat(72) + '\n');
}

if (writeJson) {
    const dir = path.join(__dirname, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const out = path.join(dir, `eval-${ts}.json`);
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
    console.log(`📄  JSON report saved to: ${path.relative(process.cwd(), out)}\n`);
}
