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
import { BENCHMARKS } from './benchmark.config.mjs';

const BUDGET = 4;

// Per (fixture,task) expected/forbidden discovery tools — the archetype tool-fit signal.
// A clean answer uses ≥1 expect tool and 0 avoid tools (e.g. references→find_references,
// refactor→get_call_graph, flow→get_subgraph, an import-composition ecosystem must NOT
// reach for get_subgraph). Sourced from the config so the two stay in lock-step.
const TOOL_FIT = {};
for (const b of BENCHMARKS) {
    for (const [task, t] of Object.entries(b.tasks)) {
        TOOL_FIT[`${b.fixture}/${task}`] = { expect: t.expect || [], avoid: t.avoid || [] };
    }
}
const DISCOVERY_TOOLS = new Set([
    'search_code', 'resolve_symbol', 'get_repo_map', 'get_file_skeleton',
    'get_call_graph', 'get_chunk', 'get_chunk_summary', 'list_index_stats',
]);
// Valid first discovery moves: those that take a name / no prior ID. The new archetypes
// legitimately OPEN with these — refactor→get_call_graph, references→find_references,
// flow→get_subgraph, routes→find_routes (all per the CORE.md playbooks). Only the
// ID/locate-dependent tools (get_chunk, get_chunk_summary, get_file_skeleton) are a bad
// first move because they presuppose a located target.
const FIRST_MOVE_OK = new Set([
    'search_code', 'resolve_symbol', 'get_repo_map', 'list_index_stats',
    'get_call_graph', 'find_references', 'find_routes', 'get_subgraph',
]);

const readTrace = (file) =>
    fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));

function scoreSegment(calls, fit = null) {
    const n = calls.length;
    const counts = {};
    for (const c of calls) counts[c.tool] = (counts[c.tool] || 0) + 1;
    const totalTokens = calls.reduce((s, c) => s + (c.tokens || 0), 0);
    const toolsUsed = new Set(calls.map(c => c.tool));

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

    // Archetype tool-fit: did the agent reach for the RIGHT tool for this question type?
    let toolFit = null;
    if (fit && (fit.expect.length || fit.avoid.length)) {
        const usedExpect = fit.expect.length === 0 || fit.expect.some(t => toolsUsed.has(t));
        const usedAvoid = fit.avoid.filter(t => toolsUsed.has(t));
        if (usedAvoid.length) violations.push(`tool-fit: used ${usedAvoid.join(',')} (wrong tool here)`);
        if (!usedExpect) violations.push(`tool-fit: never used expected ${fit.expect.join('/')}`);
        toolFit = { ok: usedExpect && usedAvoid.length === 0, usedExpect, usedAvoid };
    }

    return {
        calls: n, within_budget: n <= BUDGET, tokens: totalTokens, tool_counts: counts,
        used_search: searches.length > 0, used_call_graph: (counts.get_call_graph || 0) > 0,
        detail_use: detailUse, first_tool: firstTool || '—',
        errors: calls.filter(c => c.is_error).length,
        non_discovery: calls.filter(c => !DISCOVERY_TOOLS.has(c.tool)).length,
        tool_fit: toolFit,
        violations, clean: violations.length === 0,
    };
}

function analyzeFile(file) {
    const fixture = path.basename(file).replace(/\.jsonl$/, '');
    const calls = readTrace(file);
    const segments = {};
    for (const c of calls) (segments[c.task || 'all'] ||= []).push(c);
    const perTask = Object.fromEntries(Object.entries(segments).map(
        ([k, v]) => [k, scoreSegment(v, TOOL_FIT[`${fixture}/${k}`] || null)]));
    return { file: fixture, perTask, total_calls: calls.length };
}

function fmtFile(r) {
    const lines = [`▸ ${r.file}`];
    for (const [task, s] of Object.entries(r.perTask)) {
        const ok = s.clean ? '✅' : '⚠️';
        const fitTag = s.tool_fit ? ` fit:${s.tool_fit.ok ? 'y' : 'n'}` : '';
        lines.push(`   ${ok} ${task.padEnd(10)} ${String(s.calls).padStart(2)}/${BUDGET} calls · ${String(s.tokens).padStart(5)} tok · ` +
            `search:${s.used_search ? 'y' : 'n'} callgraph:${s.used_call_graph ? 'y' : 'n'}${fitTag} · ` +
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
const fitSegs = segs.filter(s => s.tool_fit);
const fitOk = fitSegs.filter(s => s.tool_fit.ok).length;
const avgCalls = (segs.reduce((a, s) => a + s.calls, 0) / segs.length).toFixed(1);
const avgTok = Math.round(segs.reduce((a, s) => a + s.tokens, 0) / segs.length);
process.stdout.write(
    `\n${'═'.repeat(60)}\n` +
    `SUMMARY: ${segs.length} task-runs across ${results.length} fixtures\n` +
    `  clean: ${clean}/${segs.length} · within-budget: ${within}/${segs.length} · ` +
    `used search_code: ${usedSearch}/${segs.length}\n` +
    `  tool-fit: ${fitOk}/${fitSegs.length} task-runs used the right tool for the archetype\n` +
    `  avg ${avgCalls} calls · avg ${avgTok} discovery tok/task\n`);
