#!/usr/bin/env node
/**
 * The plugin's hook command: hands the hook payload to the graph-indexer resident process of the
 * repository (the plugin's MCP server keeps one running) and prints its answer.
 *
 * Starting graph-indexer through `npx` costs about a second on every call; this client only
 * connects to a local socket (tens of milliseconds). When no resident answers, it runs the full
 * hook through npx once, which also starts a resident for the next calls.
 *
 *   node gi-hook.mjs post-tool|session-start|subagent-start   (hook payload on stdin)
 *
 * The socket location must match socketPath() in graph-indexer's src/cli/resident.mjs.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PROTOCOL = 1;
const WIN = process.platform === 'win32';

export function findRepoRoot(start) {
    let dir = path.resolve(start);
    for (;;) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return path.resolve(start);
        dir = parent;
    }
}

export function socketPath(root) {
    const abs = path.resolve(root);
    const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 16);
    if (WIN) return `\\\\.\\pipe\\graph-indexer-${hash}`;
    const inRepo = path.join(abs, '.graph-indexer', 'resident.sock');
    if (Buffer.byteLength(inRepo) <= 100) return inRepo;
    return path.join(os.tmpdir(), `graph-indexer-${process.getuid?.() ?? 'user'}`, `${hash}.sock`);
}

function trusted(file, root) {
    if (WIN) return true;
    const dir = path.dirname(file);
    if (dir === path.join(path.resolve(root), '.graph-indexer')) return fs.existsSync(file);
    try {
        const st = fs.lstatSync(dir);
        return fs.existsSync(file) && st.isDirectory() && (!process.getuid || st.uid === process.getuid()) && (st.mode & 0o077) === 0;
    } catch { return false; }
}

/** The resident's answer ({ out }) or null. `any: true`: this client has no logic of its own to match. */
function ask(root, request, totalMs) {
    const file = socketPath(root);
    if (!trusted(file, root)) return Promise.resolve(null);
    return new Promise((resolve) => {
        let done = false, buf = '';
        const sock = net.createConnection(file);
        const finish = (v) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(v); } };
        const timer = setTimeout(() => finish(null), totalMs);
        sock.setEncoding('utf8');
        sock.on('connect', () => sock.write(JSON.stringify({ v: PROTOCOL, any: true, ...request }) + '\n'));
        sock.on('data', (d) => {
            buf += d;
            const i = buf.indexOf('\n');
            if (i < 0) return;
            let r = null;
            try { r = JSON.parse(buf.slice(0, i)); } catch { /* garbled */ }
            finish(r?.ok ? r : null);
        });
        sock.on('error', () => finish(null));
        sock.on('close', () => finish(null));
    });
}

async function main() {
    const event = process.argv[2] ?? '';
    const chunks = [];
    if (!process.stdin.isTTY) for await (const c of process.stdin) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let input = {};
    try { input = JSON.parse(raw || '{}'); } catch { return; }
    const root = findRepoRoot(input.cwd || process.cwd());
    const reply = await ask(root, { op: 'hook', event, input }, 2500);
    if (reply) { if (reply.out) process.stdout.write(reply.out + '\n'); return; }
    // no resident yet: the full hook through npx (it starts one for the next calls)
    const child = spawn(WIN ? 'npx.cmd' : 'npx', ['-y', 'graph-indexer@3', 'hook', event], { stdio: ['pipe', 'inherit', 'ignore'], shell: WIN });
    child.on('error', () => { /* fail open */ });
    child.stdin.on('error', () => { /* fail open */ });
    child.stdin.end(raw);
    await new Promise((resolve) => child.on('close', resolve).on('error', resolve));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const timer = setTimeout(() => process.exit(0), 9000); // fail open before the host's 10 s timeout
    main().catch(() => { /* fail open */ }).finally(() => clearTimeout(timer));
}
