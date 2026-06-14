#!/usr/bin/env node
/**
 * test/agent/analyze.mjs
 *
 * Scores benchmark traces (JSONL from agent-cli.mjs) against the CORE.md protocol.
 * Traces now carry a per-call `task` tag (symbol|behaviour|keyword|crosscut), so
 * each task is scored as its own question (the 4-call budget is per question).
 *
 *   - call count vs the 4-call budget         (hard limit 1)
 *   - serial single-name lookups              (hard limit 2: batch-don't-iterate)
 *   - over-expansion / example-hop count       (hard limit 4: rule-of-one)
 *   - detail-level discipline                  (full as a crutch)
 *   - search_code usage + retrieval mode        (the gap this round targets)
 *   - blast-radius coverage (get_call_graph)
 *   - discovery tokens spent
 *
 * Usage:
 *   node test/agent/analyze.mjs <trace.jsonl> [...]
 *   node test/agent/analyze.mjs --dir test/agent/traces/<round>
 *   node test/agent/analyze.mjs --json --dir <dir>
 */
import fs from 'fs';
import path from 'path';

const BUDGET = 4;
const DISCOVERY_TOOLS = new Set([
    'search_code', 'resolve_symbol', 'get_repo_map', 'get_file_skeleton',
    'get_call_graph', 'get_chunk', 'get_chunk_summary', 'list_index_stats',
]);
const FIRST_MOVE_OK = new Set(['search_code', 'resolve_symbol', 'get_repo_map', 'list_index_stats']);

const readTrace = (file) =>
    fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));

function scoreSegment(calls) {
    const n = calls.length;
    const counts = {};
    for (const c of calls) counts[c.tool] = (counts[c.tool] || 0) + 1;
    const totalTokens = calls.reduce((s, c) => s + (c.tokens || 0), 0);

    const searches = calls.filter(c => c.tool === 'search_code');
    const detailUse = { signatures: 0, smart: 0, full: 0 };
    for (const s of searches) detailUse[s.args?.detail || 'smart']++;

    const nameLookups = calls.filter(c =>
        c.tool === 'resolve_symbol' ||
        (c.tool === 'search_code' && typeof c.args?.query === 'string'
            && c.args.query.trim().split(/\s+/).length === 1 && !c.args?.exact_tokens));

    const bodyFetches = counts.get_chunk || 0;
    const firstTool = calls[0]?.tool;

    const violations = [];
    if (n > BUDGET) violations.push(`HL1 budget: ${n} calls > ${BUDGET}`);
    if (nameLookups.length >= 2) violations.push(`HL2 serial lookups: ${nameLookups.length} single-name calls`);
    if (bodyFetches > 2) violations.push(`HL4 over-expansion: ${bodyFetches} get_chunk bodies`);
    if (firstTool && !FIRST_MOVE_OK.has(firstTool)) violations.push(`first move was ${firstTool}`);
    if (searches.length && searches[0].args?.detail === 'full') violations.push(`detail:"full" on first search`);

    return {
        calls: n, within_budget: n <= BUDGET, tokens: totalTokens, tool_counts: counts,
        used_search: searches.length > 0, used_call_graph: (counts.get_call_graph || 0) > 0,
        detail_use: detailUse, first_tool: firstTool || '—',
        errors: calls.filter(c => c.is_error).length,
        non_discovery: calls.filter(c => !DISCOVERY_TOOLS.has(c.tool)).length,
        violations, clean: violations.length === 0,
    };
}

function analyzeFile(file) {
    const calls = readTrace(file);
    const segments = {};
    for (const c of calls) (segments[c.task || 'all'] ||= []).push(c);
    const perTask = Object.fromEntries(Object.entries(segments).map(([k, v]) => [k, scoreSegment(v)]));
    return { file: path.basename(file).replace(/\.jsonl$/, ''), perTask, total_calls: calls.length };
}

function fmtFile(r) {
    const lines = [`▸ ${r.file}`];
    for (const [task, s] of Object.entries(r.perTask)) {
        const ok = s.clean ? '✅' : '⚠️';
        lines.push(`   ${ok} ${task.padEnd(10)} ${String(s.calls).padStart(2)}/${BUDGET} calls · ${String(s.tokens).padStart(5)} tok · ` +
            `search:${s.used_search ? 'y' : 'n'} callgraph:${s.used_call_graph ? 'y' : 'n'} · ` +
            `tools[${Object.entries(s.tool_counts).map(([k, v]) => `${k.replace('get_', '')}×${v}`).join(' ')}]`);
        for (const v of s.violations) lines.push(`        ✗ ${v}`);
    }
    return lines.join('\n');
}

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
let files = argv.filter(a => !a.startsWith('--'));
const dirIdx = argv.indexOf('--dir');
if (dirIdx >= 0) {
    const dir = argv[dirIdx + 1];
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f));
}
if (!files.length) { process.stderr.write('usage: analyze.mjs <trace.jsonl|--dir dir> [--json]\n'); process.exit(1); }

const results = files.map(analyzeFile);

if (asJson) { process.stdout.write(JSON.stringify(results, null, 2) + '\n'); process.exit(0); }

process.stdout.write(results.map(fmtFile).join('\n\n') + '\n');

// Aggregate across all task segments.
const segs = results.flatMap(r => Object.entries(r.perTask).map(([task, s]) => ({ task, ...s })));
const clean = segs.filter(s => s.clean).length;
const within = segs.filter(s => s.within_budget).length;
const usedSearch = segs.filter(s => s.used_search).length;
const avgCalls = (segs.reduce((a, s) => a + s.calls, 0) / segs.length).toFixed(1);
const avgTok = Math.round(segs.reduce((a, s) => a + s.tokens, 0) / segs.length);
process.stdout.write(
    `\n${'═'.repeat(60)}\n` +
    `SUMMARY: ${segs.length} task-runs across ${results.length} fixtures\n` +
    `  clean: ${clean}/${segs.length} · within-budget: ${within}/${segs.length} · ` +
    `used search_code: ${usedSearch}/${segs.length}\n` +
    `  avg ${avgCalls} calls · avg ${avgTok} discovery tok/task\n`);
