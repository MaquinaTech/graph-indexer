#!/usr/bin/env node
/**
 * Where an agent's tokens and time go, read from the transcripts of graded runs.
 *
 *   node bench/agentic/anatomy.mjs --gi LABEL[,LABEL…] [--transcripts DIR] [--json out.json]
 *
 * Per suite and arm:
 *   - real cost split: the fixed prefix re-read every call, generating the model's output (thinking, text,
 *     tool calls — recovered from context growth, see transcript.mjs), re-reading that output in later
 *     calls, and re-reading tool results by kind (read, search, graph-indexer, tests, edit, other);
 *   - time: model vs tool execution;
 *   - exploration: calls before the first edit, how many of them look code up, and how many searches
 *     chase a name the agent had already seen in code it read or in a search result;
 *   - context precision (fresh issues): the share of code lines read that fall inside the functions the
 *     gold patch or the agent's own patch changes (±20 lines for changes outside a function), in the base
 *     version of each file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { argv, readJsonl, loadTasks, WORK } from './lib.mjs';
import { specForPath } from '../../src/parse/languages.mjs';
import { extractFile } from '../../src/parse/extract.mjs';

const { opt, list } = argv();
const labels = list('--gi');
const dir = opt('--transcripts', process.env.GI_TRANSCRIPTS);
if (!labels.length || !dir) throw new Error('usage: anatomy.mjs --gi LABEL[,LABEL…] --transcripts DIR (or GI_TRANSCRIPTS)');
const RESULT_CHARS_PER_TOKEN = 2.63;

// ── runs: the same selection as report.mjs ────────────────────────────────────
let rows = labels.flatMap(l => readJsonl(path.join(WORK, 'results', `${l}.jsonl`)));
const discardedAt = new Map(labels.flatMap(l => {
    const f = path.join(WORK, 'runs', l, 'discarded.tsv');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(line => { const [run, at] = line.split('\t'); return [`${l}|${run}`, at]; }) : [];
}));
rows = rows.filter(r => !(discardedAt.get(`${r.giLabel}|${r.runId}`) >= r.gradedAt));
rows = [...new Map(rows.map(r => [`${r.giLabel}|${r.runId}`, r])).values()];
rows = rows.filter(r => r.agent && (r.rep ?? 1) >= 1 && !r.agent.leaks?.length);
const tasks = new Map(loadTasks().map(t => [t.id, t]));
const suiteOf = (r) => r.family === 'qa' ? 'B1' : r.kind === 'fresh' ? 'B3' : 'B2';

function transcriptOf(r) {
    const tsv = path.join(WORK, 'runs', r.giLabel, 'agents.tsv');
    if (!fs.existsSync(tsv)) return null;
    const agents = fs.readFileSync(tsv, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t')).filter(([, run]) => run === r.runId).map(([a]) => a);
    const files = agents.map(a => ['.output', '.jsonl'].map(e => path.join(dir, a + e)).find(f => fs.existsSync(f))).filter(Boolean);
    const lastAt = (f) => { const ls = fs.readFileSync(f, 'utf8').trim().split('\n'); for (let i = ls.length - 1; i >= 0; i--) { try { const t = JSON.parse(ls[i]).timestamp; if (t) return t; } catch { } } return ''; };
    return files.filter(f => lastAt(f) <= r.gradedAt).at(-1) ?? null;
}

// ── what a tool call is for ───────────────────────────────────────────────────
const GI = /(^|[\s/])(gi|graph-indexer(\.mjs)?)\s+\w/;
const TESTS = /\b(pytest|unittest|tsc|jest|mocha|vitest|npm\s+test|go\s+test|cargo\s+test|tsdiag)\b/;
const stripCd = (c) => c.replace(/^\s*cd\s+\S+\s*&&\s*/, '');
function kindOf(name, input = {}) {
    if (name === 'Read') return /INSTRUCTIONS\.md$/.test(input.file_path ?? '') ? 'task' : 'read';
    if (name === 'Grep' || name === 'Glob') return 'search';
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'edit';
    if (name.startsWith('mcp__') && /graph-indexer/.test(name)) return 'gi';
    if (name !== 'Bash') return 'other';
    const c = stripCd(input.command ?? '');
    if (GI.test(c)) return 'gi';
    if (TESTS.test(c)) return 'tests';
    if (/^(ls|find|tree)\b/.test(c) || /\b(grep|rg|ag|ack)\b/.test(c)) return 'search';
    if (/^(cat|sed|head|tail|nl|awk)\b/.test(c)) return 'read';
    return 'other';
}
const STOP = new Set('def class function func interface struct type enum trait const return import from self this None True False null true false with print test tests name path file files output mode content glob head tail grep find'.split(' '));
const idents = (s) => new Set((s.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []).filter(w => !STOP.has(w)));
function searchedNames(name, input) {
    if (name === 'Grep') return idents(input.pattern ?? '');
    if (name === 'Glob') return idents(input.pattern ?? '');
    const c = stripCd(input.command ?? '');
    const pat = /(?:grep|rg|ag|ack)\s+(?:-[\w-]+(?:\s+\d+)?\s+)*["']([^"']+)["']/.exec(c)?.[1] ?? /-i?name\s+["']?([^"'\s]+)/.exec(c)?.[1] ?? /(?:grep|rg)\s+(?:-[\w-]+(?:\s+\d+)?\s+)*(\S+)/.exec(c)?.[1] ?? '';
    return idents(pat);
}

// ── context precision (fresh issues) ──────────────────────────────────────────
const fileCache = new Map();
async function baseSymbols(repo, base, rel) {
    const key = `${repo}|${base}|${rel}`;
    if (!fileCache.has(key)) {
        let src = null, syms = null;
        try { src = execFileSync('git', ['-C', path.join(WORK, 'repos', repo), 'show', `${base}:${rel}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { }
        const spec = specForPath(rel);
        if (src != null && spec) { try { syms = (await extractFile(spec, src, rel)).symbols; } catch { } }
        fileCache.set(key, syms ?? []);
    }
    return fileCache.get(key);
}
function touchedLines(patch) {
    const out = new Map(); let file = null, b = 0;
    for (const l of (patch ?? '').split('\n')) {
        if (l.startsWith('--- ')) continue;
        if (l.startsWith('+++ ')) { const p = l.slice(4).trim(); file = p === '/dev/null' ? null : p.replace(/^b\//, ''); if (file && !out.has(file)) out.set(file, new Set()); continue; }
        const h = /^@@ -(\d+)(?:,(\d+))? \+/.exec(l); if (h) { b = Number(h[1]); continue; }
        if (!file) continue;
        if (l.startsWith('-')) { out.get(file).add(b); b++; }
        else if (l.startsWith('+')) { out.get(file).add(Math.max(1, b - 1)); out.get(file).add(b); }
        else if (l.startsWith(' ')) b++;
    }
    return out;
}
const FN = new Set(['function', 'method', 'constructor']);
async function changedRegions(repo, base, patch, into = new Map()) {
    for (const [rel, lines] of touchedLines(patch)) {
        if (/(^|\/)tests?\//.test(rel)) continue;
        const syms = await baseSymbols(repo, base, rel);
        const rs = into.get(rel) ?? into.set(rel, []).get(rel);
        for (const line of lines) {
            const inner = syms.filter(s => s.startLine <= line && line <= s.endLine).sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));
            const fn = inner.find(s => FN.has(s.kind));
            if (fn) rs.push([fn.startLine, fn.endLine]);
            else rs.push([Math.max(line - 20, inner[0]?.startLine ?? 1), Math.min(line + 20, inner[0]?.endLine ?? 1e9)]);
        }
    }
    return into;
}
function shellRead(cmd) {
    const c = stripCd(cmd); let m;
    if ((m = /^(?:nl\s+-ba\s+|cat\s+-n\s+)(\S+)\s*\|\s*sed\s+-n\s+['"](\d+),(\d+)p['"]/.exec(c))) return [m[1], +m[2]];
    if ((m = /^sed\s+-n\s+['"](\d+),(\d+)p['"]\s+(\S+)/.exec(c))) return [m[3], +m[1]];
    if ((m = /^head\s+-(?:n\s*)?\d+\s+(\S+)/.exec(c))) return [m[1], 1];
    if ((m = /^awk\s+['"]NR\s*>=?\s*(\d+)\s*&&\s*NR\s*<=?\s*\d+['"]\s+(\S+)/.exec(c))) return [m[2], +m[1]];
    if ((m = /^cat\s+(?:-n\s+)?(\S+\.\w+)\s*$/.exec(c))) return [m[1], 1];
    return null;
}

// ── one run ───────────────────────────────────────────────────────────────────
async function analyse(r, file) {
    const turns = [], usage = new Map(), results = [], calls = [];
    let pending = [];
    const uses = new Map();
    for (const l of fs.readFileSync(file, 'utf8').trim().split('\n')) {
        let e; try { e = JSON.parse(l); } catch { continue; }
        const m = e.message; if (!m) continue;
        if (e.type === 'assistant' && m.id) {
            if (!usage.has(m.id)) { if (turns.length) results.push(pending); pending = []; turns.push(m.id); usage.set(m.id, m.usage ?? {}); }
            for (const c of Array.isArray(m.content) ? m.content : []) if (c.type === 'tool_use') { const call = { name: c.name, input: c.input ?? {}, turn: turns.length - 1, kind: kindOf(c.name, c.input ?? {}) }; uses.set(c.id, call); calls.push(call); }
        } else if (e.type === 'user' && Array.isArray(m.content)) {
            for (const c of m.content) if (c.type === 'tool_result') {
                const call = uses.get(c.tool_use_id); if (!call) continue;
                call.text = Array.isArray(c.content) ? c.content.map(x => x.text ?? '').join('') : String(c.content ?? '');
                pending.push(call);
            }
        }
    }
    results.push(pending);
    const T = turns.length; if (T < 2) return null;
    const U = turns.map(id => usage.get(id));
    const ctx = U.map(u => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0));
    // cost_t = input + 1.25·write + 0.1·read = 0.1·ctx_t + 0.9·input + 1.15·write; what is added after call t is
    // written once and re-read by every later call
    const parts = {}; const add = (k, v) => { parts[k] = (parts[k] ?? 0) + v; };
    let cost = 0, out = 0;
    for (const u of U) cost += (u.input_tokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0);
    add('prefix', 0.1 * T * ctx[0] + 0.9 * (U[0].input_tokens ?? 0) + 1.15 * (U[0].cache_creation_input_tokens ?? 0));
    for (let t = 0; t < T; t++) {
        const rTok = results[t].reduce((s, c) => s + (c.text?.length ?? 0) / RESULT_CHARS_PER_TOKEN, 0);
        const o = t < T - 1 ? Math.max(U[t].output_tokens ?? 0, ctx[t + 1] - ctx[t] - rTok) : (U[t].output_tokens ?? 0);
        out += o;
        if (t < T - 1) {
            const w = 1.15 + 0.1 * (T - 1 - t);
            for (const c of results[t]) add(`results:${c.kind}`, (c.text?.length ?? 0) / RESULT_CHARS_PER_TOKEN * w);
            add('reread output', o * w);
        }
    }
    add('generate output', 5 * out); cost += 5 * out;
    // exploration
    const firstEdit = calls.findIndex(c => c.kind === 'edit');
    const pre = firstEdit < 0 ? calls : calls.slice(0, firstEdit);
    const seen = new Set(); let lookups = 0, chases = 0;
    for (const c of pre) {
        if (c.kind === 'search') {
            const names = [...searchedNames(c.name, c.input)];
            if (names.length) { lookups++; if (names.some(n => seen.has(n))) chases++; }
        }
        if ((c.kind === 'read' || c.kind === 'search') && c.text) for (const n of idents(c.text)) seen.add(n);
    }
    // context precision (fresh issues)
    let codeLines = 0, relevantLines = 0;
    const task = tasks.get(r.taskId);
    if (task?.kind === 'fresh' && task.gold?.patch) {
        const regions = await changedRegions(task.repo, task.base, task.gold.patch);
        const ap = path.join(WORK, 'runs', r.giLabel, r.runId, 'agent.patch');
        if (fs.existsSync(ap)) await changedRegions(task.repo, task.base, fs.readFileSync(ap, 'utf8'), regions);
        for (const c of calls) {
            if (c.kind !== 'read' || !c.text) continue;
            let rel = null, lines = [];
            if (c.name === 'Read') { rel = c.input.file_path; lines = c.text.split('\n').map(l => /^\s*(\d+)\t/.exec(l)).filter(Boolean).map(m => +m[1]); }
            else { const s = shellRead(c.input.command ?? ''); if (!s) continue; rel = s[0]; const n = c.text.split('\n').length; for (let i = 0; i < n; i++) lines.push(s[1] + i); }
            rel = String(rel ?? '').replace(/^.*\/wt\/[^/]+\//, '').replace(/^\.\//, '');
            if (!rel || /(^|\/)tests?\//.test(rel) || !specForPath(rel)) continue;
            const rs = regions.get(rel) ?? [];
            codeLines += lines.length;
            relevantLines += lines.filter(n => rs.some(([a, b]) => a <= n && n <= b)).length;
        }
    }
    return { T, cost, out, parts, calls: calls.length, preCalls: pre.length, preLookups: pre.filter(c => c.kind === 'search' || c.kind === 'read').length,
        lookups, chases, codeLines, relevantLines, modelMs: r.agent.modelMs ?? null, toolMs: r.agent.toolMs ?? null, wallMs: r.agent.wallMs ?? null };
}

const groups = new Map();
for (const r of rows) {
    const f = transcriptOf(r); if (!f) continue;
    const x = await analyse(r, f); if (!x) continue;
    const key = `${suiteOf(r)} ${r.arm}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(x);
}
const mean = (xs, f) => xs.reduce((s, x) => s + f(x), 0) / Math.max(1, xs.length);
const pc = (v, tot) => `${Math.round(100 * v / tot)}%`;
const out = {};
for (const [key, xs] of [...groups].sort()) {
    const cost = mean(xs, x => x.cost);
    const part = (k) => mean(xs, x => x.parts[k] ?? 0);
    const resultKinds = [...new Set(xs.flatMap(x => Object.keys(x.parts).filter(k => k.startsWith('results:'))))].sort();
    const code = mean(xs, x => x.codeLines), rel = mean(xs, x => x.relevantLines);
    const g = {
        runs: xs.length, calls: mean(xs, x => x.T), cost, outputTokens: mean(xs, x => x.out),
        split: Object.fromEntries(['prefix', 'generate output', 'reread output', ...resultKinds].map(k => [k, part(k) / cost])),
        minutes: mean(xs, x => (x.wallMs ?? 0) / 60000), modelShare: mean(xs, x => x.modelMs ?? 0) / Math.max(1, mean(xs, x => x.wallMs ?? 0)),
        callsBeforeFirstEdit: mean(xs, x => x.preCalls), lookupsBeforeFirstEdit: mean(xs, x => x.preLookups),
        chaseShare: mean(xs, x => x.chases) / Math.max(1e-9, mean(xs, x => x.lookups)),
        contextPrecision: code ? rel / code : null,
    };
    out[key] = g;
    console.log(`\n${key}: ${g.runs} runs · ${g.calls.toFixed(1)} calls · real cost ${(cost / 1000).toFixed(0)}k · output ${(g.outputTokens / 1000).toFixed(1)}k tokens · ${g.minutes.toFixed(1)} min (model ${pc(g.modelShare, 1)})`);
    console.log(`  cost: ` + Object.entries(g.split).map(([k, v]) => `${k} ${pc(v, 1)}`).join(' · '));
    console.log(`  before the first edit: ${g.callsBeforeFirstEdit.toFixed(1)} calls, ${g.lookupsBeforeFirstEdit.toFixed(1)} searches/reads; ${pc(g.chaseShare, 1)} of searches chase a name already seen`
        + (g.contextPrecision != null ? ` · context precision ${(100 * g.contextPrecision).toFixed(1)}%` : ''));
}
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(out, null, 2));
