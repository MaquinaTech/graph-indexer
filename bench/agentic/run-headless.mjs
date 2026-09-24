#!/usr/bin/env node
/**
 * Run prepared benchmark runs with a real agent CLI in headless mode, with graph-indexer wired in the
 * way users install it: the MCP server for the `mcp` and `mcp+hooks` arms, plus the Claude Code hooks
 * for `mcp+hooks`. Other arms run with the built-in tools (`grep`, `grep+rules`) or their CLI card.
 * This measures what sub-agents following a card cannot: MCP tool discovery and hooks that fire on
 * the agent's own reads, searches and edits.
 *
 *   node bench/agentic/run-headless.mjs --gi LABEL [--runs ID,ID|all] [--model M] [--concurrency 3]
 *        [--transcripts DIR] [--claude-bin claude] [--max-budget USD] [--dry-run] [--preflight]
 *
 * For each prepared run (runs/<label>/<run>/meta.json, from prepare.mjs batch) with no registered
 * agent yet it launches, in the run directory,
 *
 *   claude -p <prompt> --output-format stream-json --verbose --permission-mode bypassPermissions
 *          --tools Read,Grep,Glob,Bash,Edit,Write --add-dir <checkout> [--model M]
 *          [--mcp-config <mcp.json> --strict-mcp-config] [--settings <settings.json>]
 *
 * The real-session arms (cc, cc+gi, cc+gi+helper) keep the tools Claude Code ships with, sub-agents
 * included, and the run directory's CLAUDE.md and .claude/agents/ (prepare.mjs writes them as `init`
 * does); they run under acceptEdits with Bash and graph-indexer's tools allowed, which also works
 * as root, with the web tools off, only graph-indexer's MCP server (none for cc) and none of the
 * user's own settings (hooks, agents, permissions of the machine that runs them):
 *
 *   claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits
 *          --allowedTools Bash,mcp__graph-indexer --disallowedTools WebSearch,WebFetch
 *          --add-dir <checkout> --mcp-config <mcp.json> --strict-mcp-config
 *          --setting-sources project,local [--model M] [--max-budget-usd USD]
 *
 * --preflight starts one short session per arm among the runs (in its first run's directory) and
 * checks that it has what the arm needs — the Agent tool, the graph-indexer server connected, the
 * helper among the sub-agents it can start — before anything is spent on the runs themselves.
 *
 * It streams each transcript to <transcripts>/<agent id>.jsonl and registers the agent id in
 * runs/<label>/agents.tsv. Grade afterwards with
 *   node bench/agentic/grade-batch.mjs --gi LABEL --agents <ids> --transcripts <dir>
 * It needs an authenticated `claude` CLI on the machine that runs it (a login, or ANTHROPIC_API_KEY).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { argv, WORK } from './lib.mjs';
import { giBin } from './prepare.mjs';
import { usesIndex, SESSION_ARMS } from './arms.mjs';
import { HELPER_NAME } from '../../src/cli/helper.mjs';

const { opt, list, flag } = argv();
const label = opt('--gi');
if (!label) throw new Error('--gi LABEL is required');
const dir = path.resolve(opt('--transcripts', path.join(WORK, 'transcripts', label)));
const claude = opt('--claude-bin', 'claude');
const model = opt('--model', null);
const concurrency = Math.max(1, Number(opt('--concurrency', 3)));
const dry = flag('--dry-run');
const preflight = flag('--preflight');
// a ceiling per session: a run that reaches it stops, unsolved (the same for every arm)
const maxBudget = opt('--max-budget', null);
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
function commandFor(meta, { bin = giBin(label), prompt = null, budget = null } = {}) {
    prompt ??= `Your task instructions are in ${path.join(meta.runDir, 'INSTRUCTIONS.md')} — read that file first and follow it exactly. The repository is at ${meta.checkout}. When you have finished, reply with the single word DONE.`;
    const session = SESSION_ARMS[meta.arm];
    if (session) {
        const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
            '--allowedTools', session.index ? 'Bash,mcp__graph-indexer' : 'Bash', '--disallowedTools', 'WebSearch,WebFetch',
            '--add-dir', meta.checkout, '--mcp-config', path.join(meta.runDir, 'mcp.json'), '--strict-mcp-config',
            '--setting-sources', 'project,local'];
        if (model) args.push('--model', model);
        if (budget ?? maxBudget) args.push('--max-budget-usd', String(budget ?? maxBudget));
        const servers = session.index ? { 'graph-indexer': { command: process.execPath, args: [bin, 'serve', '--repo', meta.checkout] } } : {};
        return { args, files: { 'mcp.json': { mcpServers: servers } } };
    }
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

/** Run the CLI in a run directory, its stream-json output to `file`; resolves to the exit code. */
function launch(meta, args, files, file) {
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(meta.runDir, name), JSON.stringify(content, null, 2) + '\n');
    const out = fs.createWriteStream(file);
    return new Promise((resolve) => {
        const child = spawn(claude, args, { cwd: meta.runDir, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.pipe(out);
        let err = '';
        child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
        child.on('close', (c) => { if (c) fs.writeFileSync(path.join(meta.runDir, 'headless.stderr'), err); resolve(c); });
        child.on('error', (e) => { fs.writeFileSync(path.join(meta.runDir, 'headless.stderr'), String(e)); resolve(-1); });
    });
}

async function runOne(meta) {
    const { args, files } = commandFor(meta, { bin: usesIndex(meta.arm) ? giBin(label) : null });
    const agent = `h-${meta.runId.replace(/[^\w.+-]/g, '_')}-${Date.now().toString(36)}`;
    if (dry) { console.log(`${agent}\t${claude} ${args.map(a => JSON.stringify(a)).join(' ')}`); return; }
    // registered before it starts: grade-batch only grades it once its transcript shows it finished
    fs.appendFileSync(tsv, `${agent}\t${meta.runId}\n`);
    const t0 = Date.now();
    const code = await launch(meta, args, files, path.join(dir, `${agent}.jsonl`));
    console.log(`${meta.runId}: exit ${code} in ${((Date.now() - t0) / 60000).toFixed(1)} min → ${agent}`);
}

/**
 * One one-turn session per arm, in the directory of its first run: does the session have what the
 * arm needs? Returns the number of arms that failed.
 */
async function preflightArms() {
    const firstOf = new Map();
    for (const m of runs) if (!firstOf.has(m.arm)) firstOf.set(m.arm, m);
    let failed = 0;
    for (const [arm, meta] of firstOf) {
        const session = SESSION_ARMS[arm];
        // the sub-agents a session can start are listed in its Agent tool, which the model reads
        const { args, files } = commandFor(meta, { bin: usesIndex(arm) ? giBin(label) : null, budget: 0.5,
            prompt: 'Without using any tool, reply with the names of the sub-agent types your Agent tool can start, comma-separated, and nothing else.' });
        const file = path.join(dir, `preflight-${arm.replace(/[^\w.+-]/g, '_')}-${Date.now().toString(36)}.jsonl`);
        const code = await launch(meta, args, files, file);
        const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const init = events.find(e => e.type === 'system' && e.subtype === 'init');
        const result = events.find(e => e.type === 'result');
        const tools = init?.tools ?? [];
        const servers = init?.mcp_servers ?? [];
        const agents = (init?.agents ?? []).map(a => (typeof a === 'string' ? a : a?.name ?? a?.agentType ?? ''));
        const reply = String(result?.result ?? '');
        const checks = [
            ['session started', !!init, init ? `model ${init.model}, key source ${init.apiKeySource ?? '?'}` : `exit ${code}; see ${meta.runDir}/headless.stderr`],
            ['answered', !!result && !result.is_error, result ? `${result.subtype}, $${(result.total_cost_usd ?? 0).toFixed(4)}: ${reply.slice(0, 160)}` : 'no result event'],
            ['web tools off', !tools.some(t => t === 'WebSearch' || t === 'WebFetch'), ''],
        ];
        if (session) checks.push(['sub-agents (Agent tool)', tools.includes('Agent') || tools.includes('Task'), '']);
        if (usesIndex(arm)) {
            const gi = servers.find(s => s.name === 'graph-indexer');
            checks.push(['graph-indexer server', gi?.status === 'connected', gi ? gi.status : 'absent'],
                ['graph-indexer tools', tools.some(t => t.startsWith('mcp__graph-indexer__')), `${tools.filter(t => t.startsWith('mcp__graph-indexer__')).length} tools`]);
        }
        // the helper is there when the session lists it (init event) or the model names it (its Agent tool lists it)
        const offered = agents.includes(HELPER_NAME) || reply.includes(HELPER_NAME);
        if (session?.helper) checks.push(['helper sub-agent offered', offered, init?.agents ? `agents: ${agents.join(', ')}` : '']);
        else if (session) checks.push(['no helper sub-agent', !offered, '']);
        const bad = checks.filter(([, ok]) => !ok);
        failed += bad.length ? 1 : 0;
        console.log(`${arm}: ${bad.length ? 'NOT READY' : 'ready'}`);
        for (const [what, ok, note] of checks) console.log(`  ${ok ? 'ok ' : 'NO '} ${what}${note ? ` — ${note}` : ''}`);
    }
    return failed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
    if (preflight) {
        const failed = await preflightArms();
        process.exitCode = failed ? 1 : 0;
        process.exit();
    }
    console.error(`${runs.length} run(s) to launch with ${claude}, ${concurrency} at a time${dry ? ' (dry run)' : ''}`);
    const queue = [...runs];
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length) await runOne(queue.shift());
    }));
    if (!dry) console.error(`grade with: node bench/agentic/grade-batch.mjs --gi ${label} --transcripts ${dir} --agents <ids above>`);
}
