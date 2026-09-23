#!/usr/bin/env node
/**
 * Run prepared benchmark runs with a real agent CLI in headless mode, with graph-indexer wired in the
 * way users install it: the MCP server for the `mcp` and `mcp+hooks` arms, plus the Claude Code hooks
 * for `mcp+hooks`. Other arms run with the built-in tools (`grep`, `grep+rules`) or their CLI card.
 * This measures what sub-agents following a card cannot: MCP tool discovery and hooks that fire on
 * the agent's own reads, searches and edits.
 *
 *   node bench/agentic/run-headless.mjs --gi LABEL [--runs ID,ID|all] [--model M] [--concurrency 3]
 *        [--transcripts DIR] [--claude-bin claude] [--dry-run]
 *
 * For each prepared run (runs/<label>/<run>/meta.json, from prepare.mjs batch) with no registered
 * agent yet it launches, in the run directory,
 *
 *   claude -p <prompt> --output-format stream-json --verbose --permission-mode bypassPermissions
 *          --tools Read,Grep,Glob,Bash,Edit,Write --add-dir <checkout> [--model M]
 *          [--mcp-config <mcp.json> --strict-mcp-config] [--settings <settings.json>]
 *
 * streams the transcript to <transcripts>/<agent id>.jsonl and registers the agent id in
 * runs/<label>/agents.tsv. Grade afterwards with
 *   node bench/agentic/grade-batch.mjs --gi LABEL --agents <ids> --transcripts <dir>
 * It needs an authenticated `claude` CLI on the machine that runs it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { argv, WORK } from './lib.mjs';
import { giBin } from './prepare.mjs';
import { usesIndex } from './arms.mjs';

const { opt, list, flag } = argv();
const label = opt('--gi');
if (!label) throw new Error('--gi LABEL is required');
const dir = path.resolve(opt('--transcripts', path.join(WORK, 'transcripts', label)));
const claude = opt('--claude-bin', 'claude');
const model = opt('--model', null);
const concurrency = Math.max(1, Number(opt('--concurrency', 3)));
const dry = flag('--dry-run');
const runsDir = path.join(WORK, 'runs', label);
const tsv = path.join(runsDir, 'agents.tsv');

const registered = new Set(fs.existsSync(tsv) ? fs.readFileSync(tsv, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t')[1]) : []);
const wanted = list('--runs');
const runs = fs.readdirSync(runsDir).filter(r => fs.existsSync(path.join(runsDir, r, 'meta.json')))
    .filter(r => (!wanted.length || wanted.includes('all') ? true : wanted.includes(r)))
    .filter(r => !registered.has(r) && !/__r0$/.test(r))
    .map(r => JSON.parse(fs.readFileSync(path.join(runsDir, r, 'meta.json'), 'utf8')));
fs.mkdirSync(dir, { recursive: true });

/** The command line for one run, and the config files it needs (written next to the run). */
function commandFor(meta, { bin = giBin(label) } = {}) {
    const prompt = `Your task instructions are in ${path.join(meta.runDir, 'INSTRUCTIONS.md')} — read that file first and follow it exactly. The repository is at ${meta.checkout}. When you have finished, reply with the single word DONE.`;
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
        '--tools', 'Read,Grep,Glob,Bash,Edit,Write', '--add-dir', meta.checkout];
    if (model) args.push('--model', model);
    const files = {};
    if (meta.arm === 'mcp' || meta.arm === 'mcp+hooks') {
        files['mcp.json'] = { mcpServers: { 'graph-indexer': { command: process.execPath, args: [bin, 'serve', '--repo', meta.checkout] } } };
        args.push('--mcp-config', path.join(meta.runDir, 'mcp.json'), '--strict-mcp-config');
    }
    if (meta.arm === 'mcp+hooks') {
        const hook = (event) => ({ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(bin)} hook ${event} --repo ${JSON.stringify(meta.checkout)}`, timeout: 10 });
        files['settings.json'] = { hooks: {
            PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|Grep|Bash|Read', hooks: [hook('post-tool')] }],
            SessionStart: [{ hooks: [hook('session-start')] }],
            SubagentStart: [{ hooks: [hook('subagent-start')] }],
        } };
        args.push('--settings', path.join(meta.runDir, 'settings.json'));
    }
    return { args, files };
}

async function runOne(meta) {
    const { args, files } = commandFor(meta, { bin: usesIndex(meta.arm) ? giBin(label) : null });
    const agent = `h-${meta.runId.replace(/[^\w.+-]/g, '_')}-${Date.now().toString(36)}`;
    if (dry) { console.log(`${agent}\t${claude} ${args.map(a => JSON.stringify(a)).join(' ')}`); return; }
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(meta.runDir, name), JSON.stringify(content, null, 2) + '\n');
    const out = fs.createWriteStream(path.join(dir, `${agent}.jsonl`));
    // registered before it starts: grade-batch only grades it once its transcript shows it finished
    fs.appendFileSync(tsv, `${agent}\t${meta.runId}\n`);
    const t0 = Date.now();
    const code = await new Promise((resolve) => {
        const child = spawn(claude, args, { cwd: meta.runDir, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.pipe(out);
        let err = '';
        child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
        child.on('close', (c) => { if (c) fs.writeFileSync(path.join(meta.runDir, 'headless.stderr'), err); resolve(c); });
        child.on('error', (e) => { fs.writeFileSync(path.join(meta.runDir, 'headless.stderr'), String(e)); resolve(-1); });
    });
    console.log(`${meta.runId}: exit ${code} in ${((Date.now() - t0) / 60000).toFixed(1)} min → ${agent}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
    console.error(`${runs.length} run(s) to launch with ${claude}, ${concurrency} at a time${dry ? ' (dry run)' : ''}`);
    const queue = [...runs];
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length) await runOne(queue.shift());
    }));
    if (!dry) console.error(`grade with: node bench/agentic/grade-batch.mjs --gi ${label} --transcripts ${dir} --agents <ids above>`);
}
