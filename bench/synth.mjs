#!/usr/bin/env node
/**
 * bench/synth.mjs — synthesise the benchmark documents from per-cell JSON.
 *
 * Reads ONLY extracted data (bench/results/*.json, provenance.json, parity.json,
 * structural.json). Every table cell is a real number or an explicit "not run".
 * Emits: BENCH_LANGUAGES.md (master matrix) + BENCH_SUMMARY.md (cross-language).
 * BENCH_AGENT.md is produced by bench/synth-agent.mjs.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIGS } from './configs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RES = path.join(__dirname, 'results');

const CONFIG_ORDER = ['L1', 'E0', 'E1', 'O0', 'O2', 'R0', 'R1', 'R2'];
const FIX_ORDER = ['axios', 'express-js', 'nestjs', 'react', 'fastapi', 'django', 'gin', 'rust', 'spring', 'android', 'aspnet', 'rails', 'laravel', 'symfony', 'css', 'cjson', 'nvm', 'alamofire'];

const prov = JSON.parse(fs.readFileSync(path.join(__dirname, 'provenance.json'), 'utf8'));
const parity = fs.existsSync(path.join(RES, 'parity.json')) ? JSON.parse(fs.readFileSync(path.join(RES, 'parity.json'), 'utf8')) : {};
const structural = fs.existsSync(path.join(RES, 'structural.json')) ? JSON.parse(fs.readFileSync(path.join(RES, 'structural.json'), 'utf8')) : {};
// Invocation-verified structural categories (bench/verify-structural.mjs): the
// authoritative call_graph / type_refs verdicts, each confirmed by calling the
// real tool on the fixture (not by reading a field — which produced earlier false
// positives). These drive the canonical structural-coverage table.
const verify = fs.existsSync(path.join(RES, 'verify-structural.json')) ? JSON.parse(fs.readFileSync(path.join(RES, 'verify-structural.json'), 'utf8')) : {};
// Docs now live in test/ (moved by the maintainer). Write them there.
const DOCS = path.join(ROOT, 'test');

const f2 = (x) => (x == null ? '—' : x.toFixed(2));
const pc = (x) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);
const pc1 = (x) => (x == null ? '—' : `${x.toFixed(1)}%`);
const secs = (ms) => (ms == null ? '—' : ms === 0 ? 'reuse' : `${(ms / 1000).toFixed(1)}s`);
const mb = (b) => (b == null ? '—' : `${(b / 1048576).toFixed(1)}MB`);

function cell(fx, cfg) {
    const p = path.join(RES, `${fx}__${cfg}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}
const mean = (xs, sel) => (xs.length ? xs.reduce((s, r) => s + sel(r), 0) / xs.length : null);

function derive(c) {
    if (!c) return { present: false };
    if (!c.ok) return { present: true, ok: false, reason: c.reason };
    const a = c.eval.aggregate, rows = c.eval.rows || [], held = c.eval.heldRows || [], h = c.eval.heldOutAggregate;
    const sem = rows.filter(r => r.difficulty === 'semantic'), sym = rows.filter(r => r.difficulty !== 'semantic');
    const hSem = held.filter(r => r.difficulty === 'semantic');
    return {
        present: true, ok: true,
        s5: a.strictSuccess[5], r1: a.rank1Strict, mrr: a.mrrStrict,
        semR1: mean(sem, r => r.rank1Strict), semMRR: mean(sem, r => r.mrrStrict), semS5: mean(sem, r => r.strictSuccess[5]),
        semN: sem.length, symN: sym.length,
        symR1: mean(sym, r => r.rank1Strict), symMRR: mean(sym, r => r.mrrStrict),
        foPct: a.fileOnlyHitRate * 100, qCount: a.queryCount,
        fileHit1: a.fileHitRate?.[1] ?? null, fileHit5: a.fileHitRate?.[5] ?? null,
        fileHitN: a.fileHitQueryCount ?? null,
        heldR1: h ? h.rank1Strict : null, heldS5: h ? h.strictSuccess[5] : null,
        heldSemR1: hSem.length ? mean(hSem, r => r.rank1Strict) : null,
        buildMs: c.build?.wallMs, reused: c.build?.reused, thr: c.throughputChunksPerSec,
        sizeBytes: c.stats?.sizeBytes?.total, dim: c.stats?.embedMeta?.dim, vec: c.stats?.vectorCount,
        latMed: c.latency?.medianMs, latP99: c.latency?.p99Ms, rss: c.build?.peakRssBytes,
        chunks: c.stats?.chunkCount, files: c.stats?.fileCount,
    };
}

function provLine(fx) {
    const p = prov[fx]; if (!p) return '';
    const pin = p.pinned ? `\`${p.ref || p.commit?.slice(0, 10)}\`` : `\`${p.commit ? p.commit.slice(0, 10) : 'unpinned'}\` (subdir-reduced clone)`;
    const sub = (p.subdirs && p.subdirs.join(',') !== '.') ? ` · subdirs: \`${p.subdirs.join(', ')}\`` : '';
    return `[${p.repo}](${p.repo}) @ ${pin}${sub}`;
}

// ── Canonical structural-coverage table (Phase-1 reconciliation) ─────────────────
// One authoritative row per fixture. Categories come from verify-structural.json
// (invocation-verified); percentages from structural.json (full-index counts).
// This is THE source of truth for structural gaps — BENCH_SUMMARY/AGENT reference it
// instead of re-deriving (which is how the docs drifted apart).
function callGraphCell(fx) {
    const cat = verify[fx]?.callGraph?.category, edges = verify[fx]?.callGraph?.calleeCallerEdges ?? 0;
    if (cat === 'none') return 'none';
    if (cat === 'degraded') return edges < 20 ? `none (${edges} trivial)‡` : 'degraded (class-granular)†';
    return 'yes';
}
function typeRefsCell(fx) {
    const cat = verify[fx]?.findReferences?.category;
    const pct = structural[fx]?.typeRefChannel?.typeRefsPct;
    if (cat === 'empty') return '**empty**';
    return pct != null ? `populated (${pct}%)` : 'populated';
}
function callersCell(fx) {
    const s = structural[fx]; const cgCat = verify[fx]?.callGraph?.category;
    if (!s) return '—';
    const total = s.callSites?.total || 0, recv = s.callSites?.withReceiverPct;
    if (cgCat === 'none' || total === 0) return 'none';
    if (total < 10) return `none (${total} trivial)`;
    if (recv >= 50) return `receiver-aware (${recv}%)${cgCat === 'degraded' ? '†' : ''}`;
    if (recv >= 10) return `mixed (${recv}%)`;
    return `name-only (${recv}%)`;
}
function inheritanceCell(fx) {
    const ext = structural[fx]?.typeRefChannel?.extendsPct;
    return ext > 0 ? `yes (${ext}%)` : 'n/a';
}
function canonicalStructuralTable() {
    const T = [];
    T.push('| Language | fixture | call_graph edges | type_refs channel | callers resolution | inheritance |');
    T.push('|---|---|---|---|---|---|');
    for (const fx of FIX_ORDER) {
        const p = prov[fx]; if (!p || !structural[fx]) continue;
        T.push(`| ${p.language} | ${fx} | ${callGraphCell(fx)} | ${typeRefsCell(fx)} | ${callersCell(fx)} | ${inheritanceCell(fx)} |`);
    }
    return T.join('\n');
}
// Reconciled gap sets, derived from the invocation-verified categories (NOT from a
// raw <1% threshold, which mis-classified css and spring).
const NO_CALLGRAPH = FIX_ORDER.filter(fx => verify[fx]?.callGraph?.category === 'none');         // 0 call edges
const DEGRADED_CALLGRAPH = FIX_ORDER.filter(fx => verify[fx]?.callGraph?.category === 'degraded'); // edges, coarse granularity
const EMPTY_TYPEREFS = FIX_ORDER.filter(fx => verify[fx]?.findReferences?.category === 'empty');

// Real per-language semantic query counts (the denominator behind every `sem`
// figure). Computed, never hardcoded, so the caveat text can't drift from the data
// (e.g. aspnet has sem n=2 → a single query is worth 50 points, not 33).
const SEM_NS = FIX_ORDER.map(fx => derive(cell(fx, 'L1'))).filter(d => d.ok && d.semN != null).map(d => d.semN);
const SEM_N_LO = Math.min(...SEM_NS), SEM_N_HI = Math.max(...SEM_NS);
const SEM_N_PHRASE = `n=${SEM_N_LO}–${SEM_N_HI}`;
const PERQ_PHRASE = `${Math.round(100 / SEM_N_HI)}–${Math.round(100 / SEM_N_LO)} points`;

// ── BENCH_LANGUAGES.md ─────────────────────────────────────────────────────────
function languagesDoc() {
    const L = [];
    L.push('# BENCH_LANGUAGES.md — per-language configuration matrix\n');
    L.push('> Generated by `bench/synth.mjs` from `bench/results/*.json`. Every cell is an extracted number from a **cold, isolated** build (`rm -rf .graph-indexer` before each), scored by `test/evaluate.mjs` with strict symbol-level ground truth. No ranking code was tuned. "not run" = a configuration that could not run, with the reason.\n');
    L.push('**Configurations.** ' + CONFIG_ORDER.map(k => CONFIGS[k] ? `**${k}** = ${CONFIGS[k].label}` : k).join(' · ') + '. (L0 = lexical-without-stemming is *not separately measurable* — stemming is not runtime-togglable; L1 is the shipped lexical floor. O1 = qwen3-embedding:0.6b is **not run — model not pulled**.)\n');
    L.push(`Strict metrics are primary. \`s@5\`=strict success@5, \`r1\`=strict rank-1 accuracy, \`MRR\`=strict MRR, \`sem\`=behavioural/semantic-query subset (\`difficulty:"semantic"\`), \`held\`=held-out validation split (never used to tune), \`file-only\`=loose-hit-but-not-strict inflation. **Per-language \`sem\` query counts (\`n\`) are small (${SEM_N_PHRASE}); a single query moves \`sem r1\` by ${PERQ_PHRASE} — read those columns as directional, with the \`sem n\` printed under each language.**\n`);

    // ── Canonical structural-coverage table (authoritative) ──
    L.push('## Canonical structural-coverage table (authoritative)\n');
    L.push('One row per fixture; **the single source of truth for structural gaps**. Every `none` / `empty` / `degraded` verdict was confirmed by **invoking the actual tool** (`get_call_graph` / `find_references`) on the fixture\'s real index via `bench/verify-structural.mjs` — not by reading a field (the method that previously produced false positives: macOS `grep` treating `mcp-tools.mjs` as binary; the `recv` vs `receiver_type` mismatch). Where any other doc or section disagreed, **this table is the correction**.\n');
    L.push(canonicalStructuralTable());
    L.push('\n**Legend.** `call_graph edges`: **yes** = `get_call_graph` resolves callers · **none** = index has zero call edges (tool returns nothing for any symbol) · **degraded (class-granular)†** = call edges exist and resolve callers, but the language is chunked at class granularity so the callee method is not its own node · **none (N trivial)‡** = only N outbound edges, none resolving to an indexed definition. `type_refs channel`: **populated** = ≥1 chunk carries `type_refs` (type-usage refs extractable) · **empty** = no chunk carries any `type_refs` (`find_references` degrades to callers + `extends`). `callers resolution`: **receiver-aware** = a meaningful share of `call_sites` carry a receiver (high-confidence caller classification) · **mixed** / **name-only** = lower / zero receiver share · **none** = no usable call edges. `inheritance`: `extends` populated (subclass/implements refs) or n/a (language has no inheritance / none indexed).\n');
    L.push('> **† spring (Java):** 426 method-call edges exist and every callee name resolves callers, but spring-petclinic\'s Java is chunked at *class* granularity (god-class split only fires ≥200 lines), so the callee method is not its own chunk and callers attribute at class level. The fixture is also SCSS-diluted (1132 of 1174 chunks are `rule_set`). **‡ css (SCSS):** 6 outbound `@include`/`@function` edges, none resolving to an indexed definition — `get_call_graph` is effectively empty for SCSS.\n');

    for (const fx of FIX_ORDER) {
        const p = prov[fx]; if (!p) continue;
        const anyCell = CONFIG_ORDER.map(cfg => derive(cell(fx, cfg))).find(d => d.present && d.ok);
        const chunks = anyCell?.chunks, files = anyCell?.files;
        const l1 = derive(cell(fx, 'L1'));
        const qn = l1.ok ? l1.qCount : '?';
        const semN = l1.ok ? l1.semN : '?';
        L.push(`\n## ${p.id} — ${p.language}\n`);
        L.push(`Source: ${provLine(fx)}  `);
        L.push(`Index: ${chunks ?? '?'} chunks · ${files ?? '?'} files · ${qn} scored queries (**sem n=${semN}**) + held-out split.\n`);

        // config table
        L.push('| Config | s@5 | r1 | MRR | sem r1 | sem s@5 | held r1 | file@1 | file@5 | file-only | build | ch/s | size | dim | p50 lat |');
        L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
        for (const cfg of CONFIG_ORDER) {
            const c = cell(fx, cfg), d = derive(c);
            if (!d.present) {
                const reason = CONFIGS[cfg]?.blocked ? 'not run (jina q8 not shipped)' : (cfg === 'O2' || cfg.startsWith('R')) ? 'not run (costly — subset only)' : 'not run';
                L.push(`| ${cfg} | ${reason} | | | | | | | | | | | | |`);
                continue;
            }
            if (!d.ok) { L.push(`| ${cfg} | not run — ${d.reason} | | | | | | | | | | | | |`); continue; }
            L.push(`| ${cfg} | ${pc(d.s5)} | ${pc(d.r1)} | ${f2(d.mrr)} | ${pc(d.semR1)} | ${pc(d.semS5)} | ${pc(d.heldR1)} | ${d.fileHit1 != null ? pc(d.fileHit1) : '—'} | ${d.fileHit5 != null ? pc(d.fileHit5) : '—'} | ${pc1(d.foPct)} | ${secs(d.buildMs)} | ${d.thr ?? '—'} | ${mb(d.sizeBytes)} | ${d.dim ?? '—'} | ${d.latMed != null ? d.latMed.toFixed(2) + 'ms' : '—'} |`);
        }

        // structural channel
        const s = structural[fx];
        if (s) {
            const cgCat = verify[fx]?.callGraph?.category;
            const cgNote = cgCat === 'none' ? ' — **call-graph empty (0 edges, verified by invocation)**'
                : cgCat === 'degraded' ? ' — **call-graph degraded (verified): edges resolve callers but the callee is not its own chunk; see canonical table**'
                    : '';
            const trEmpty = verify[fx]?.findReferences?.category === 'empty';
            L.push('\n**Structural channels** (authoritative verdicts in the canonical table above): '
                + `call-graph: ${s.callGraph.chunksWithCallsPct}% of chunks carry call edges (${s.callGraph.avgCallsPerChunk}/chunk)${cgNote}; `
                + `\`find_references\`: type_refs ${s.typeRefChannel.typeRefsPct}%${trEmpty ? ' (**empty** — type-usage refs not extracted; verified)' : ''}, extends ${s.typeRefChannel.extendsPct}%; `
                + (s.callSites.total ? `call_sites ${s.callSites.total} (${s.callSites.withReceiverPct}% via a receiver)` : 'call_sites: none') + '.');
        }
        // parity
        const pr = parity[fx];
        if (pr) L.push(`\n**Backend parity (P):** ${pr.ok ? `✓ memory vs SQLite top-5 byte-identical across all ${pr.queries} queries.` : `✗ **PARITY BROKEN** on ${pr.mismatches.length}/${pr.queries} queries (defect).`}`);
    }
    L.push('\n## Reproduce\n');
    L.push('```bash\n# one cell (cold build + strict score):\nnode bench/cell.mjs <fixture> <config>     # e.g. node bench/cell.mjs gin O0\n# parity / structural:\nnode bench/parity.mjs <fixture...>\nnode bench/structural.mjs <fixture...>\n# regenerate this doc:\nnode bench/synth.mjs\n```\n');
    return L.join('\n');
}

// ── BENCH_SUMMARY.md ───────────────────────────────────────────────────────────
function summaryDoc() {
    const S = [];
    const cells = fs.readdirSync(RES).filter(f => /__/.test(f) && f.endsWith('.json'));
    const parityAll = Object.values(parity); const parityOk = parityAll.filter(p => p.ok).length;
    S.push('# BENCH_SUMMARY.md — honest cross-language summary\n');
    S.push('> Generated by `bench/synth.mjs`. Strict symbol-level metrics, cold isolated builds, no tuning. See BENCH_LANGUAGES.md for the full per-config matrix (and its **canonical structural-coverage table**, the source of truth for structural gaps) and BENCH_AGENT.md for end-to-end agent results.\n');

    S.push(`> ⚠️ **Read semantic numbers with their \`n\`.** Semantic metrics use small per-language query sets (${SEM_N_PHRASE}); a single query shifts rank-1 by ${PERQ_PHRASE} (e.g. aspnet's semantic rank-1 is over just ${SEM_N_LO} queries). Per-language semantic numbers are **directional, not precise** — the symbolic numbers (larger n) and the cross-language pattern are the reliable signals. Every semantic figure below carries its \`n\`.\n`);

    S.push('## Executive summary\n');
    S.push(`- **Backend parity holds everywhere:** memory vs SQLite top-5 is byte-identical on **${parityOk}/${parityAll.length}** fixtures — the "parity by construction" (shared \`fuseAndRank\`) claim is measured, not asserted.`);
    S.push(`- **Strength is symbolic/structural retrieval, not raw semantic recall:** default-path symbolic rank-1 is strong and consistent; semantic (behavioural-query) rank-1 is much lower and highly language-dependent — the known semantic ceiling, now resolved per language (small per-language semantic ${SEM_N_PHRASE} queries, so read those cells with the count in mind).`);
    S.push('- **Embeddings lift recall more than rank-1:** in-process (E0) and Ollama (O0/O2) embeddings raise semantic s@5 on several languages but rarely move rank-1; the default lexical path is often already at the s@5 ceiling on these small fixtures.');
    S.push('- **Rerank and enrichment invert by language and do not stack:** LLM rerank is a strong *semantic* rank-1 lever but trades against exact symbolic precision; enrichment inverts oppositely. Both are correctly off by default. (Measured on a 6-language subset — see below.)');
    S.push(`- **Real per-language structural gaps (invocation-verified — see the canonical table in BENCH_LANGUAGES.md):** \`get_call_graph\` returns nothing for **${NO_CALLGRAPH.join(', ')}** (zero call edges) and is **degraded** for **${DEGRADED_CALLGRAPH.join(', ')}** (edges exist but coarse/class-granular or trivial); the \`type_refs\` (type-usage) channel is **empty** for **${EMPTY_TYPEREFS.join(', ')}**; Go/Rust/Kotlin/Ruby callers are name-only (no receiver). Details below.`);
    S.push('- **qwen3-embedding:4b is accurate but ~0.4–3 chunks/s** — impractical to index large repos with; that is why the costly configs were measured on a subset.\n');

    S.push('## Method & invariants\n');
    S.push('- **Cold, isolated builds:** every cell is `rm -rf .graph-indexer` then a fresh index — no warm/shared state. `bench/cell.mjs`.');
    S.push('- **Strict scoring is primary:** exact symbol match (no file-path fallback), via `test/evaluate.mjs`. Loose/file metrics are secondary; the `file-only` column is the inflation gap (now a true percentage after the v2.0 fmtPct fix).');
    S.push('- **Held-out discipline:** each language has a held-out split (~20–25%) reported separately, never used to tune.');
    S.push('- **No tuning, no fabrication:** ranking code is byte-identical to HEAD (only `test/evaluate.mjs` test-harness flags were added); every expected symbol was verified against the real index by `bench/verify-suite.mjs`; every cell is extracted, never estimated.\n');

    // master table: default-path L1 + best-achievable
    S.push('## Per-language: default path (L1) vs best-achievable\n');
    S.push('`sem n` = number of scored semantic queries for that language (the denominator behind every `sem` figure). `sym n` is correspondingly the larger symbolic denominator. Semantic columns are directional at these n; symbolic is the reliable channel.\n');
    S.push('| Language | fixture | sym n | L1 sym r1 | sem n | L1 sem r1 | L1 sem s@5 | L1 file@5 | best sem r1 (config) | best sem s@5 (config) |');
    S.push('|---|---|---|---|---|---|---|---|---|---|');
    const rowsForAvg = [];
    for (const fx of FIX_ORDER) {
        const p = prov[fx]; if (!p) continue;
        const l1 = derive(cell(fx, 'L1')); if (!l1.ok) continue;
        // best semantic across all present+ok configs
        let bestR1 = { v: l1.semR1, cfg: 'L1' }, bestS5 = { v: l1.semS5, cfg: 'L1' };
        for (const cfg of CONFIG_ORDER) {
            const d = derive(cell(fx, cfg)); if (!d.ok) continue;
            if (d.semR1 != null && (bestR1.v == null || d.semR1 > bestR1.v)) bestR1 = { v: d.semR1, cfg };
            if (d.semS5 != null && (bestS5.v == null || d.semS5 > bestS5.v)) bestS5 = { v: d.semS5, cfg };
        }
        rowsForAvg.push({ fx, l1, bestR1, bestS5 });
        const fh5 = l1.fileHit5 != null ? pc(l1.fileHit5) : '—';
        S.push(`| ${p.language} | ${fx} | ${l1.symN} | ${pc(l1.symR1)} | ${l1.semN} | ${pc(l1.semR1)} | ${pc(l1.semS5)} | ${fh5} | ${pc(bestR1.v)} (${bestR1.cfg}) | ${pc(bestS5.v)} (${bestS5.cfg}) |`);
    }

    // cross-language spread
    const arr = (sel) => rowsForAvg.map(sel).filter(x => x != null);
    const stat = (xs) => xs.length ? { mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) } : null;
    const symR1 = stat(arr(r => r.l1.symR1)), semR1 = stat(arr(r => r.l1.semR1)), semS5 = stat(arr(r => r.l1.semS5));
    S.push('\n## Cross-language spread (mean and range, not just mean)\n');
    if (symR1) {
        S.push('| Metric (default path L1) | mean | min | max |');
        S.push('|---|---|---|---|');
        S.push(`| symbolic rank-1 | ${pc(symR1.mean)} | ${pc(symR1.min)} | ${pc(symR1.max)} |`);
        const semNs = rowsForAvg.map(r => r.l1.semN).filter(x => x != null);
        S.push(`| semantic rank-1 | ${pc(semR1.mean)} | ${pc(semR1.min)} | ${pc(semR1.max)} |`);
        S.push(`| semantic s@5 | ${pc(semS5.mean)} | ${pc(semS5.min)} | ${pc(semS5.max)} |`);
        S.push(`\n_Averaged over ${rowsForAvg.length} languages. **The semantic means are over small per-language sets (sem n=${Math.min(...semNs)}–${Math.max(...semNs)}, ${semNs.reduce((a, b) => a + b, 0)} semantic queries total)** — the spread is wide and a single mean hides it, which is why the per-language numbers (with their n) exist._`);
    }

    // weaknesses — sets are the invocation-verified canonical ones (NO_CALLGRAPH /
    // DEGRADED_CALLGRAPH / EMPTY_TYPEREFS), consistent with the canonical table.
    S.push('\n## Where each language is weak\n');
    S.push('_Structural verdicts below are the canonical, invocation-verified ones (full table in BENCH_LANGUAGES.md)._\n');
    if (NO_CALLGRAPH.length) S.push(`- **No call-graph extraction (zero call edges):** ${NO_CALLGRAPH.join(', ')} — \`get_call_graph\` returns nothing for any symbol (C#, PHP). Verified by invocation.`);
    if (DEGRADED_CALLGRAPH.length) S.push(`- **Degraded call-graph:** ${DEGRADED_CALLGRAPH.join(', ')} — call edges exist but are coarse: spring (Java) is chunked at *class* granularity so the callee method is not its own node; css (SCSS) has 6 trivial edges that resolve to no definition. Verified by invocation.`);
    if (EMPTY_TYPEREFS.length) S.push(`- **Empty \`type_refs\` (type-usage) channel:** ${EMPTY_TYPEREFS.join(', ')} — \`find_references\` still fuses callers + \`extends\` (inheritance) where present, but type-usage references are not extracted. Verified by full-scan + invocation.`);
    // rerank: separate the SEMANTIC delta (where it helps) from the OVERALL delta
    // (incl. exact symbolic, where it can regress by demoting exact-name hits).
    const fmtD = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}pt`;
    const semD = [], ovD = [];
    for (const fx of FIX_ORDER) {
        const o2 = derive(cell(fx, 'O2')), r0 = derive(cell(fx, 'R0'));
        if (o2.ok && r0.ok) {
            if (o2.semR1 != null && r0.semR1 != null) semD.push(`${fx} ${fmtD(r0.semR1 - o2.semR1)} (sem n=${o2.semN})`);
            if (o2.r1 != null && r0.r1 != null) ovD.push(`${fx} ${fmtD(r0.r1 - o2.r1)}`);
        }
    }
    if (semD.length) {
        S.push(`- **Rerank (R0 vs O2) lifts *semantic* rank-1 substantially:** ${semD.join(', ')}. But the *overall* rank-1 delta (including exact symbolic queries) is mixed: ${ovD.join(', ')} — reranking favours behavioural queries and can demote exact-name hits (django's overall rank-1 regresses while its semantic rank-1 rises). At these small sem n a single query is 14–33pt, so treat the per-language magnitudes as directional; the *direction* (semantic up, symbolic mixed) is the robust signal. It is opt-in, not default.`);
        // enrichment (R1 vs O2) overall delta — inverts oppositely to rerank.
        const enD = [];
        for (const fx of FIX_ORDER) { const o2 = derive(cell(fx, 'O2')), r1 = derive(cell(fx, 'R1')); if (o2.ok && r1.ok && o2.r1 != null && r1.r1 != null) enD.push(`${fx} ${fmtD(r1.r1 - o2.r1)}`); }
        if (enD.length) S.push(`- **Enrichment (R1 vs O2) overall rank-1 delta:** ${enD.join(', ')} — it inverts *oppositely* to rerank (helps rust/django, hurts gin), and the two do not stack cleanly (R2 ≠ R0+R1).`);
    }
    S.push('- **Lexical ceiling:** languages whose L1 semantic rank-1 is far below symbolic rank-1 are bounded by the embedding channel, not lexical ranking.');

    // not run
    S.push('\n## What was NOT measured (so the averages are not mistaken for universal)\n');
    S.push('- **O1 (qwen3-embedding:0.6b):** not run — model not pulled in this environment.');
    S.push('- **E1 (in-process jina-embeddings-v2-base-code):** not run in this matrix — the shipped `_localPipeline` loads jina at fp32 (~1-3 chunks/s, no q8 dtype option), and adding one would edit engine source (out of scope). The gin/express deltas were measured in the v2.0 pass (ANALYSIS_V2.md).');
    S.push(`- **Costly configs (O2/R0/R1/R2):** run only on the representative subset (${CONFIGS && 'gin, express-js, django, spring, rust, alamofire'}); other languages show "not run — costly" for those rows.`);
    const pinnedCount = Object.values(prov).filter(p => p.pinned).length;
    const unpinned = Object.values(prov).filter(p => !p.pinned).map(p => p.id);
    S.push(`- **Fixture pinning:** ${pinnedCount}/${Object.keys(prov).length} fixtures are commit-pinned (full hashes in \`bench/FIXTURES.md\`); the other ${unpinned.length} — ${unpinned.join(', ')} — had \`.git\` stripped during subdir reduction and are **unpinnable post-hoc** (the commit cannot be recovered by \`git rev-parse\`). They are recorded by repo + subdir + chunk/file count only — a known reproducibility gap, not interpolatable.`);

    S.push('\n## Run metadata & reproduce\n');
    S.push(`- **Cells:** ${cells.length} per-(fixture,config) result files in \`bench/results/\` + parity (${parityOk}/${parityAll.length}) + structural + tokens + agent-trace.`);
    S.push('- **Effective parallelism:** ground-truth authoring fanned out 13 sub-agents concurrently; all *indexing/scoring* cells were run **serially** (one at a time) so build-time / throughput / latency are measured without CPU or Ollama contention. Ollama-dependent cells (O*/R*) shared one daemon and were queued behind the lexical/in-process cells.');
    S.push('- **Wall-clock:** the lexical+in-process matrix + parity is ~30 min; the qwen3:4b costly subset dominates at ~3 h (0.4–3 chunks/s). Total end-to-end ≈ 4 h on this machine.');
    S.push('```bash');
    S.push('# rebuild any cell (cold) / re-derive everything:');
    S.push('node bench/cell.mjs <fixture> <config>          # L1 E0 E1 O0 O2 R0 R1 R2');
    S.push('node bench/parity.mjs <fixture...>              # backend parity');
    S.push('node bench/structural.mjs <fixture...>          # call-graph / type-ref / call_sites (field counts)');
    S.push('node bench/verify-structural.mjs <fixture...>   # INVOCATION-verify call_graph / type_refs verdicts');
    S.push('node bench/tokens.mjs <fixture...>              # token footprint');
    S.push('node bench/synth.mjs && node bench/synth-agent.mjs   # regenerate the three docs (into test/)');
    S.push('# fixture provenance + ground-truth verification:');
    S.push('node bench/provenance.mjs ; node bench/fixtures-doc.mjs ; node bench/verify-suite.mjs <fixture>');
    S.push('```\n');
    const semMeanR = rowsForAvg.length ? rowsForAvg.reduce((a, r) => a + (r.l1.semR1 || 0), 0) / rowsForAvg.length : null;
    const symMeanR = rowsForAvg.length ? rowsForAvg.reduce((a, r) => a + (r.l1.symR1 || 0), 0) / rowsForAvg.length : null;
    const semNall = rowsForAvg.map(r => r.l1.semN).filter(x => x != null);
    S.push('## Proposed README replacement (do NOT edit README yet)\n');
    S.push('Replace the single 5-fixture average with the per-language default-path table above. Draft block + limitations wording (every semantic number carries its `n`):\n');
    S.push('```md');
    S.push('### Per-language retrieval (default lexical path, strict symbol-level)');
    S.push('graph-indexer is measured per language on a pinned OSS fixture. The default path is');
    S.push('lexical+stemming (zero dependencies). Numbers are strict (exact symbol match), with a');
    S.push('held-out validation split. See BENCH_SUMMARY.md for the full matrix and what was not run.');
    S.push('');
    S.push(`Default-path strict rank-1, averaged across 18 languages: symbolic ${pc(symMeanR)} (large n)`);
    S.push(`vs semantic ${pc(semMeanR)} (small per-language sets, sem n=${Math.min(...semNall)}–${Math.max(...semNall)} — directional).`);
    S.push('Symbol/structure retrieval is the strength; the pure-local semantic channel has a real');
    S.push('rank-1 ceiling. Per-language semantic numbers must be read with their n (see the table).');
    S.push('');
    S.push('Known per-language limits (invocation-verified; see the canonical structural table):');
    if (NO_CALLGRAPH.length) S.push(`- get_call_graph returns no edges for: ${NO_CALLGRAPH.join(', ')} (C#, PHP — zero call edges).`);
    if (DEGRADED_CALLGRAPH.length) S.push(`- get_call_graph is degraded (coarse / trivial) for: ${DEGRADED_CALLGRAPH.join(', ')} (Java class-granular; SCSS trivial).`);
    if (EMPTY_TYPEREFS.length) S.push(`- find_references type-usage (type_refs) channel is empty for: ${EMPTY_TYPEREFS.join(', ')}; inheritance (extends) + callers still work where present.`);
    S.push('- Reranking helps some languages and regresses others — it is opt-in, not default.');
    S.push('```');

    // ── Reconciliation log (Phase-1) ──
    S.push('\n## Reconciliation log (Phase 1)\n');
    S.push('Each correction applied so the three documents state the same facts. Where a prior doc disagreed with the harness, the harness (re-run + invocation-verified) wins.\n');
    S.push('| # | Was | Now | Docs changed |');
    S.push('|---|---|---|---|');
    S.push('| 1 | Call-graph gap stated two ways: "C# and PHP" (SUMMARY) vs the fixture list "aspnet, laravel, symfony, css" (LANGUAGES, via a <1% threshold). | One **canonical structural-coverage table** (invocation-verified). `get_call_graph` returns **nothing** for aspnet/laravel/symfony (0 edges); **degraded** for spring (Java class-granular, 426 edges) and css (6 trivial edges). | LANGUAGES (table added, authoritative), SUMMARY (refs it), AGENT (refs it). |');
    S.push('| 2 | spring shown as having a call-graph (2.7% of chunks carry edges) — not flagged. | Verified **degraded**: 426 method-call edges resolve callers, but Java is chunked at class granularity so the callee method is not its own node (the 2.7% is also SCSS-dilution: 1132/1174 chunks are `rule_set`). | LANGUAGES, SUMMARY. |');
    S.push('| 3 | css flagged "no call-graph extracted" via the <1% rule, lumped with C#/PHP. | Verified **none (6 trivial)**: 6 `@include`/`@function` edges, none resolving to a definition — distinct from the literal-zero C#/PHP case. | LANGUAGES, SUMMARY. |');
    S.push('| 4 | `type_refs`-empty set described inconsistently (older notes said "C#/Ruby"). | Verified-empty set is **' + EMPTY_TYPEREFS.join(', ') + '** (full-scan: no chunk carries `type_refs`). PHP (laravel/symfony) **does** populate `type_refs` — not empty. fastapi is populated (17.8%) despite a sampled probe missing it. | LANGUAGES, SUMMARY. |');
    S.push('| 5 | Semantic rank-1 printed without sample size; "Swift 67%" reads as precise (it is 2/3). | Every semantic metric now carries its **n** (`sem n` column + per-language caption + caveat box). Per-language semantic n=' + Math.min(...semNall) + '–' + Math.max(...semNall) + '. | SUMMARY, AGENT, README proposal. |');
    S.push('| 6 | "9/18 not pinned … reproducibility gap" with no per-fixture detail. | `bench/FIXTURES.md` records repo+commit+subdir+chunk count for all 18; the ' + unpinned.length + ' unpinned (`.git` stripped) are marked **unpinnable post-hoc** with reason. Count confirmed ' + pinnedCount + '/' + Object.keys(prov).length + ' pinned. | SUMMARY, new bench/FIXTURES.md. |');
    return S.join('\n');
}

fs.writeFileSync(path.join(DOCS, 'BENCH_LANGUAGES.md'), languagesDoc());
fs.writeFileSync(path.join(DOCS, 'BENCH_SUMMARY.md'), summaryDoc());
console.log('wrote test/BENCH_LANGUAGES.md + test/BENCH_SUMMARY.md');
const have = fs.readdirSync(RES).filter(f => f.endsWith('.json') && !f.startsWith('_') && f !== 'parity.json' && f !== 'structural.json');
console.log(`cells present: ${have.length}`);
