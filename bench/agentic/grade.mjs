#!/usr/bin/env node
/**
 * Grade a finished run and record it.
 *
 *   node bench/agentic/grade.mjs --gi LABEL --run RUN_ID [--transcript FILE]
 *
 * Question tasks: the answer file — or, for a delegated question (deliver: "reply"), the agent's
 * reply — is compared with the compiler-verified gold set (precision, recall, F1; "solved" = F1 of 1). Edit tasks: the task's hidden checks run in the run's worktree
 * (tests added by the original commit, the repository's existing tests for the touched area,
 * compiler/type checks, and structural checks for refactors).
 * The agent transcript, when given, adds tokens, turns, tool calls and tool-policy violations.
 * The result goes to <runDir>/result.json and is appended to WORK/results/<LABEL>.jsonl.
 */
import fs from 'node:fs';
import path from 'node:path';
import { argv, readJson, writeJson, appendJsonl, loadTasks, sh, sandboxed, git, tryGit, WORK, GI_ROOT } from './lib.mjs';
import { parseTranscript, RESULT_CHARS_PER_TOKEN } from './transcript.mjs';

/** Parse "path:LINE" answers (tolerates bullets, backticks, "./" and absolute checkout paths). */
export function parseAnswer(text, checkout) {
    const items = [], bad = [];
    for (const raw of String(text).split('\n')) {
        const line = raw.trim().replace(/^[-*•\d.)\s]+(?=\S)/, '').replace(/`/g, '').trim();
        if (!line) continue;
        const m = line.match(/^(.+?):(\d+)(?::\d+)?\b/);
        if (!m) { bad.push(raw); continue; }
        let p = m[1].trim();
        if (checkout && p.startsWith(checkout)) p = p.slice(checkout.length);
        p = p.replace(/^\.?\//, '');
        items.push({ path: p, line: Number(m[2]) });
    }
    return { items, bad };
}

/**
 * One-to-one matching of answer lines to gold items. Items marked `optional` (judgement calls) are
 * neither required nor penalised: matching one removes that answer line from the count.
 */
export function scoreSets(answer, gold) {
    const used = new Set();
    let tp = 0, optionalHits = 0;
    const dedup = [...new Map(answer.map(a => [`${a.path}:${a.line}`, a])).values()];
    const match = (a, g) => gold.type === 'lines' ? (Math.abs(g.line - a.line) <= (gold.tolerance ?? 0) ? Math.abs(g.line - a.line) : null)
        : (a.line >= g.start && a.line <= g.end ? a.line - g.start : null);
    for (const a of dedup) {
        let best = -1, bestD = Infinity;
        // required items first, then optional ones
        for (const pass of [false, true]) {
            gold.items.forEach((g, i) => {
                if (used.has(i) || g.path !== a.path || !!g.optional !== pass) return;
                const d = match(a, g);
                if (d !== null && d < bestD) { best = i; bestD = d; }
            });
            if (best >= 0) break;
        }
        if (best >= 0) { used.add(best); if (gold.items[best].optional) optionalHits++; else tp++; }
    }
    const required = gold.items.filter(g => !g.optional);
    const answered = dedup.length - optionalHits;
    const p = answered ? tp / answered : (required.length ? 0 : 1);
    const r = required.length ? tp / required.length : 1;
    const f1 = p + r ? 2 * p * r / (p + r) : 0;
    return { tp, answered, optionalHits, gold: required.length, precision: p, recall: r, f1, missed: gold.items.filter((g, i) => !g.optional && !used.has(i)).map(g => `${g.path}:${g.line ?? g.start}`) };
}

/**
 * zvec-grep's SWE-QA judge (rust/benchmarks/swe-qa-bench/zg_bench/swe_qa/judge.py at the commit in
 * mine-swe-qa.mjs), word for word: five rubric scores of 1–20 against the reference answer.
 */
export function judgePrompt({ question, reference, candidate }) {
    return `You are a strict evaluator. Score the candidate only against the supplied question and reference answer.

Score each dimension as an integer from 1 through 20:
- correctness: factual agreement with the reference; penalize errors.
- completeness: coverage of the reference's important points; penalize omissions.
- relevance: focus on the question; penalize tangents.
- clarity: precision and ease of understanding.
- coherence: logical organization and consistency of the explanation.

Scores 16-20 are reserved for excellent answers. When uncertain, choose the lower score. Treat the reference as judge-only evidence, not text to reproduce.

Question:
${question}

Reference answer:
${reference}

Candidate answer:
${candidate}

Return only one strict JSON object with exactly these five integer fields and no markdown:
{"correctness": 1, "completeness": 1, "relevance": 1, "clarity": 1, "coherence": 1}
`;
}
export const JUDGE_KEYS = ['correctness', 'completeness', 'relevance', 'clarity', 'coherence'];
// the judge: a model the agents are not, told nothing about the arm; GI_JUDGE_MODEL overrides it
export const JUDGE_MODEL = process.env.GI_JUDGE_MODEL || 'claude-sonnet-5-5';

/** One blind judgement through the claude CLI (no tools, no project settings, a neutral directory). */
export function judge({ question, reference, candidate }) {
    const cwd = fs.mkdtempSync(path.join(WORK, 'judge-'));
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            const r = sh(`claude -p --model ${JUDGE_MODEL} --output-format json --tools "" --setting-sources "" --strict-mcp-config --no-session-persistence --system-prompt "You grade answers. Reply with the JSON object asked for and nothing else."`,
                { cwd, input: judgePrompt({ question, reference, candidate }), timeout: 600_000 });
            let text = '';
            try { text = JSON.parse(r.stdout).result ?? ''; } catch { continue; }
            const m = text.match(/\{[^{}]*\}/);
            if (!m) continue;
            let v; try { v = JSON.parse(m[0]); } catch { continue; }
            if (!JUDGE_KEYS.every(k => Number.isInteger(v[k]) && v[k] >= 1 && v[k] <= 20)) continue;
            const total = JUDGE_KEYS.reduce((a, k) => a + v[k], 0);
            return { scores: Object.fromEntries(JUDGE_KEYS.map(k => [k, v[k]])), total, model: JUDGE_MODEL };
        }
        return null;
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function gradeQa(task, meta) {
    // answers of graded runs are kept under WORK/graded (see gradeRun)
    const file = [path.join(meta.runDir, 'answer.txt'), path.join(WORK, 'graded', meta.giLabel, meta.runId, 'answer.txt')].find(f => fs.existsSync(f)) ?? path.join(meta.runDir, 'answer.txt');
    if (!fs.existsSync(file)) return { solved: false, score: 0, error: 'no answer file' };
    if (task.gold.type === 'reference') {
        const candidate = fs.readFileSync(file, 'utf8').trim();
        if (!candidate) return { solved: false, score: 0, error: 'empty answer' };
        const j = judge({ question: task.statement, reference: task.gold.reference, candidate });
        if (!j) return { solved: false, score: null, error: 'judge gave no valid scores' };
        // score: the five rubric scores as a fraction of 100; "solved": an excellent correctness (16+)
        return { solved: j.scores.correctness >= 16, score: j.total / 100, judge: j, answerChars: candidate.length };
    }
    const { items, bad } = parseAnswer(fs.readFileSync(file, 'utf8'), meta.checkout + '/');
    const s = scoreSets(items, task.gold);
    return { solved: s.f1 === 1, score: s.f1, ...s, unparsed: bad.length };
}

export function gradeEdit(task, meta) {
    const g = task.grade ?? {};
    const cwd = meta.checkout;
    const out = { checks: [] };
    const diff = git(cwd, 'diff', '--stat', 'HEAD').trim();
    out.changedFiles = git(cwd, 'diff', '--name-only', 'HEAD').trim().split('\n').filter(Boolean);
    out.untracked = git(cwd, 'ls-files', '--others', '--exclude-standard').trim().split('\n').filter(Boolean);
    out.diffStat = diff.split('\n').pop() ?? '';
    // keep the agent's change (new files included) for failure analysis
    sh('git add -A -N', { cwd });
    fs.writeFileSync(path.join(meta.runDir, 'agent.patch'), git(cwd, 'diff', '--no-color', 'HEAD'));
    // hidden tests: apply the original commit's test changes on top of the agent's work; like
    // SWE-bench, the files they touch are first reset, so tests the agent wrote there are dropped
    if (g.testPatch) {
        const patch = path.join(meta.runDir, 'hidden-tests.patch');
        fs.writeFileSync(patch, g.testPatch);
        const touched = [...g.testPatch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map(m => m[2]);
        for (const f of touched) {
            if (tryGit(cwd, 'cat-file', '-e', `HEAD:${f}`) !== null) git(cwd, 'checkout', '-q', 'HEAD', '--', f);
            else fs.rmSync(path.join(cwd, f), { force: true });
        }
        out.testFilesReset = touched.filter(f => out.changedFiles.includes(f) || out.untracked.includes(f));
        const r = sh(`git apply --whitespace=nowarn ${JSON.stringify(patch)}`, { cwd });
        out.checks.push({ name: 'apply hidden tests', ok: r.code === 0, detail: r.stderr.slice(-300) });
        if (r.code !== 0) return { ...out, solved: false, score: 0 };
    }
    for (const c of g.checks ?? []) {
        // the checks run the repository's code (tests, builds): sandboxed (lib.mjs)
        const r = sh(sandboxed(c.cmd.replaceAll('{GI}', GI_ROOT), { checkout: cwd }), { cwd, timeout: (c.timeoutSec ?? 900) * 1000, env: c.env ?? {} });
        const ok = c.expect === 'fail' ? r.code !== 0 : r.code === 0;
        out.checks.push({ name: c.name, kind: c.kind ?? 'test', ok, code: r.code, ms: r.ms, tail: (r.stdout + r.stderr).slice(-600) });
    }
    const required = out.checks.filter(c => c.kind !== 'info');
    out.solved = required.length > 0 && required.every(c => c.ok);
    out.score = required.length ? required.filter(c => c.ok).length / required.length : 0;
    return out;
}

export function gradeRun(label, id, transcript = null) {
    const runDir = path.join(WORK, 'runs', label, id);
    const meta = readJson(path.join(runDir, 'meta.json'));
    if (!meta) throw new Error(`no run ${id} under ${label}`);
    const task = loadTasks().find(t => t.id === meta.taskId);
    if (!task) throw new Error(`task ${meta.taskId} not found`);
    let t = null;
    if (transcript && fs.existsSync(transcript)) t = parseTranscript(transcript, { arm: meta.arm, repo: meta.checkout, own: [meta.runDir, meta.checkout], work: WORK });
    // a delegated question is answered by the reply: it becomes the answer file
    if (meta.deliver === 'reply') {
        if (!t) throw new Error(`${id} is answered by its reply: a transcript is required`);
        fs.writeFileSync(path.join(runDir, 'answer.txt'), t.reply);
    }
    const res = task.family === 'qa' ? gradeQa(task, meta) : gradeEdit(task, meta);
    if (t) {
        fs.copyFileSync(transcript, path.join(runDir, 'transcript.jsonl'));
        // reading benchmark internals would leak answers: file contents are a violation, a bare
        // file list (a search tool run from the wrong directory) is recorded
        const text = fs.readFileSync(transcript, 'utf8');
        if (text.includes('bench/agentic/tasks') && /\\*"(gold|testPatch|callSites|decoys|statementNotes)\\*"\s*:/.test(text)) t.leaks.push('read benchmark task files');
        else if (text.includes('bench/agentic/tasks')) t.benign.push('listed benchmark task files');
    }
    const record = {
        runId: id, taskId: task.id, family: task.family, kind: task.kind ?? null, repo: task.repo, arm: meta.arm, rep: meta.rep,
        giLabel: label, gradedAt: new Date().toISOString(), ...res,
        agent: t ? { models: t.models, turns: t.turns, usage: t.usage, costUnits: t.costUnits, toolCalls: t.toolCalls, toolCounts: t.toolCounts,
            giCalls: t.giCalls, grepCalls: t.grepCalls, filesRead: t.filesRead, filesEdited: t.filesEdited.length, wallMs: t.wallMs,
            outputRecorded: t.outputRecorded, firstEditTurn: t.firstEditTurn, modelMs: t.modelMs, toolMs: t.toolMs, violations: t.violations, benign: t.benign, leaks: t.leaks,
            contextFirst: t.contextFirst, contextLast: t.contextLast, contextAtAnswer: t.contextAtAnswer,
            turnsToAnswer: t.turnsToAnswer, costUnitsToAnswer: t.costUnitsToAnswer, wallMsToAnswer: t.wallMsToAnswer,
            // a real session: what it cost in dollars (all models), the main agent's own work and each delegation
            ...(t.costUsd != null ? { costUsd: t.costUsd } : {}), ...(t.session ? { session: t.session } : {}),
            // what a delegating agent's context receives: the reply, at the density of a tool result
            ...(meta.deliver === 'reply' ? { agentType: meta.agentType, replyChars: t.reply.length, replyTokens: Math.round(t.reply.length / RESULT_CHARS_PER_TOKEN) } : {}) } : null,
    };
    writeJson(path.join(runDir, 'result.json'), record);
    appendJsonl(path.join(WORK, 'results', `${label}.jsonl`), record);
    // graded artifacts leave the runs tree, where agents working on the same task could find them
    const kept = path.join(WORK, 'graded', label, id);
    fs.mkdirSync(kept, { recursive: true });
    for (const f of ['answer.txt', 'result.json', 'transcript.jsonl']) {
        if (fs.existsSync(path.join(runDir, f))) fs.renameSync(path.join(runDir, f), path.join(kept, f));
    }
    return record;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { opt } = argv();
    const r = gradeRun(opt('--gi'), opt('--run'), opt('--transcript'));
    const a = r.agent;
    console.log(`${r.runId}: ${r.solved ? 'SOLVED' : 'not solved'} score=${(r.score ?? 0).toFixed(3)}` +
        (r.precision !== undefined ? ` P=${r.precision.toFixed(2)} R=${r.recall.toFixed(2)} (${r.tp}/${r.gold}, answered ${r.answered})` : '') +
        (a ? ` | turns=${a.turns} tools=${a.toolCalls} gi=${a.giCalls} grep=${a.grepCalls} cost=${a.costUnits}${a.violations.length ? ` VIOLATIONS=${a.violations.length}` : ''}` : ''));
}
