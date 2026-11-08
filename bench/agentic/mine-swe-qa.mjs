#!/usr/bin/env node
/**
 * zvec-grep's own agent benchmark as graph-indexer tasks: the 20 SWE-QA-Bench questions zvec-grep
 * publishes for its Claude Code comparison (rust/benchmarks/swe-qa-bench in zvec-ai/zvec-grep, at
 * the pinned commit below), with their reference answers, written to tasks/swe-qa-zvec.json.
 *
 * Both sources are Apache-2.0: SWE-QA-Bench (peng-weihan/SWE-QA-Bench) for the questions and
 * references, zvec-grep for the selection. Each task records where it comes from.
 *
 * The questions are graded the way zvec-grep grades them: a blind judge model scores the answer
 * against the reference on correctness, completeness, relevance, clarity and coherence (1–20 each),
 * with zvec-grep's judge prompt word for word (grade.mjs, gold type "reference"). The judge is told
 * neither the arm nor the tools.
 *
 *   node bench/agentic/mine-swe-qa.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HERE } from './lib.mjs';

export const ZVEC_REPO = 'zvec-ai/zvec-grep';
export const ZVEC_COMMIT = '407a38512bb0b778819e38035d87fb6ac229a4eb';
const DATA = 'rust/benchmarks/swe-qa-bench/zg_bench/swe_qa/data';

function fetchJson(file) {
    const r = spawnSync('gh', ['api', `repos/${ZVEC_REPO}/contents/${DATA}/${file}?ref=${ZVEC_COMMIT}`, '--jq', '.content'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) throw new Error(`gh api ${file}: ${r.stderr}`);
    return JSON.parse(Buffer.from(r.stdout.trim(), 'base64').toString('utf8'));
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(new URL(import.meta.url).pathname)) {
    const selection = fetchJson('selection.json');
    const refs = new Map(fetchJson('references.json').references.map(r => [r.task_id, r]));
    const tasks = selection.tasks.map(t => {
        const ref = refs.get(t.task_id);
        if (!ref || ref.question_hash !== t.question_hash) throw new Error(`no matching reference for ${t.task_id}`);
        const repo = `sweqa-${t.repository.split('/')[1].toLowerCase()}`;
        return {
            id: `swe-qa-${t.task_slug}`,
            family: 'qa',
            kind: `swe-qa-${t.category}`,
            repo,
            base: t.repository_commit,
            statement: t.question,
            answerFormat: 'A complete, precise explanation in prose that answers the question, naming the files, classes and functions involved. Nothing else.',
            gold: { type: 'reference', reference: ref.reference_answer },
            source: { benchmark: `${selection.benchmark}@${selection.benchmark_revision}`, task: t.task_id, selection: `${ZVEC_REPO}@${ZVEC_COMMIT}`, license: 'Apache-2.0', repository: t.repository_url },
        };
    });
    const out = path.join(HERE, 'tasks', 'swe-qa-zvec.json');
    fs.writeFileSync(out, JSON.stringify(tasks, null, 2) + '\n');
    console.log(`${tasks.length} tasks → ${out}`);
    const repos = [...new Map(tasks.map(t => [t.repo, t.source.repository])).entries()];
    console.log(repos.map(([k, u]) => `${k}  ${u}`).join('\n'));
}
