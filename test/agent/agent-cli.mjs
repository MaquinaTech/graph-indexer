#!/usr/bin/env node
/**
 * test/agent/agent-cli.mjs
 *
 * The single discovery interface a benchmarked sub-agent is allowed to use.
 * It drives the REAL graph-indexer tools (via tool-bridge.mjs) against one
 * indexed fixture and prints the tool's output to stdout — exactly what the
 * agent would receive from the live MCP server.
 *
 * Every invocation is appended to a JSONL trace so we can reconstruct the
 * agent's full call chain afterwards: which tool, which args, how many tokens
 * it cost, and the running budget total.
 *
 * Usage:
 *   AGENT_FIXTURE=nestjs AGENT_TRACE=/tmp/nestjs.trace.jsonl \
 *     node test/agent/agent-cli.mjs <tool> '<json-args>'
 *
 * Examples:
 *   node test/agent/agent-cli.mjs search_code '{"query":"dependency injection container","detail":"smart","top_k":6}'
 *   node test/agent/agent-cli.mjs resolve_symbol '{"symbol":"NestFactory"}'
 *   node test/agent/agent-cli.mjs get_call_graph '{"target_function":"create"}'
 */
import fs from 'fs';
import { createBridge } from './tool-bridge.mjs';

const fixture = process.env.AGENT_FIXTURE;
const tracePath = process.env.AGENT_TRACE;

function fail(msg) {
    process.stderr.write(`agent-cli error: ${msg}\n`);
    process.exit(1);
}

if (!fixture) fail('AGENT_FIXTURE env var is required (fixture name or repo path).');

const [, , toolName, rawArgs] = process.argv;
if (!toolName) {
    fail('usage: agent-cli.mjs <tool> \'<json-args>\'');
}

let args = {};
if (rawArgs != null && rawArgs !== '') {
    try {
        args = JSON.parse(rawArgs);
    } catch (err) {
        fail(`could not parse JSON args: ${err.message}\n  got: ${rawArgs}`);
    }
}

function priorTrace() {
    if (!tracePath || !fs.existsSync(tracePath)) return [];
    return fs.readFileSync(tracePath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
}

const bridge = await createBridge({ fixture });

let out;
try {
    out = await bridge.callTool(toolName, args);
} catch (err) {
    fail(err.message);
}

// ── Append to the trace ──────────────────────────────────────────────────────
if (tracePath) {
    const prior = priorTrace();
    const seq = prior.length + 1;
    const cumulative = prior.reduce((s, e) => s + (e.tokens || 0), 0) + out.tokens;
    const record = {
        seq,
        ts: new Date().toISOString(),
        task: process.env.AGENT_TASK || null,   // archetype tag: symbol|behaviour|keyword|crosscut
        tool: toolName,
        args,
        tokens: out.tokens,
        cumulative_tokens: cumulative,
        is_error: out.isError,
    };
    fs.appendFileSync(tracePath, JSON.stringify(record) + '\n');
}

process.stdout.write(out.text + '\n');
