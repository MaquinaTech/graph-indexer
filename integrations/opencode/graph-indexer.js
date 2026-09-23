/**
 * graph-indexer plugin for OpenCode and Kilo Code (installed by `graph-indexer init --hooks`).
 *
 * After a read, a search or an edit it appends to the tool's output what the Claude Code hooks add
 * as context: where the names used in the lines just read are defined (once the agent is
 * crawling), where a definition that a search missed is, and what an edit broke. It asks the
 * repository's graph-indexer resident process over its local socket (the MCP server `init`
 * configures keeps one running) and adds nothing when none answers; the first miss starts
 * `graph-indexer daemon` in the background for the next calls.
 *
 * Only the plugin function is exported: OpenCode calls every export of a plugin module.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const PROTOCOL = 1;
const WIN = process.platform === 'win32';
// how to start a resident when none answers (rewritten by `init --local` and installed binaries)
const DAEMON = ['npx', '-y', 'graph-indexer@3', 'daemon'];
// OpenCode tool ids → the tool names graph-indexer's hook understands
const TOOLS = { read: 'Read', grep: 'Grep', bash: 'Bash', edit: 'Edit', write: 'Write' };

function findRepoRoot(start) {
    let dir = path.resolve(start);
    for (;;) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return path.resolve(start);
        dir = parent;
    }
}

// must match socketPath() in graph-indexer's src/cli/resident.mjs
function socketPath(root) {
    const abs = path.resolve(root);
    const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 16);
    if (WIN) return `\\\\.\\pipe\\graph-indexer-${hash}`;
    const inRepo = path.join(abs, '.graph-indexer', 'resident.sock');
    if (Buffer.byteLength(inRepo) <= 100) return inRepo;
    return path.join(os.tmpdir(), `graph-indexer-${process.getuid?.() ?? 'user'}`, `${hash}.sock`);
}

function trusted(file, root) {
    if (WIN) return true;
    if (!fs.existsSync(file)) return false;
    const dir = path.dirname(file);
    if (dir === path.join(path.resolve(root), '.graph-indexer')) return true;
    try {
        const st = fs.lstatSync(dir);
        return st.isDirectory() && (!process.getuid || st.uid === process.getuid()) && (st.mode & 0o077) === 0;
    } catch { return false; }
}

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

/** The Claude Code-style PostToolUse payload for an OpenCode tool call, or null. */
function hookPayload(input, output, root) {
    const name = TOOLS[input?.tool];
    if (!name) return null;
    const a = input.args ?? {};
    let text = typeof output?.output === 'string' ? output.output : '';
    if (name === 'Grep' && /^No files found/.test(text.trim())) text = ''; // a search that found nothing
    const toolInput = name === 'Read' ? { file_path: a.filePath, offset: a.offset, limit: a.limit }
        : name === 'Grep' ? { pattern: a.pattern, path: a.path }
            : name === 'Bash' ? { command: a.command }
                : { file_path: a.filePath };
    return { session_id: `opencode-${input.sessionID ?? 'default'}`, cwd: root, hook_event_name: 'PostToolUse', tool_name: name, tool_input: toolInput, tool_response: text };
}

export const GraphIndexer = async ({ directory, worktree } = {}) => {
    // Kilo Code may load the plugin from both .kilo/ and .opencode/: register once
    if (globalThis.__graphIndexerPlugin) return {};
    globalThis.__graphIndexerPlugin = true;
    const root = findRepoRoot(worktree || directory || process.cwd());
    let started = false;
    return {
        'tool.execute.after': async (input, output) => {
            try {
                const payload = hookPayload(input, output, root);
                if (!payload) return;
                const reply = await ask(root, { op: 'hook', event: 'post-tool', input: payload }, 2000);
                if (!reply) {
                    if (!started) {
                        started = true;
                        const child = spawn(DAEMON[0], [...DAEMON.slice(1), '--repo', root], { detached: true, stdio: 'ignore', windowsHide: true, shell: WIN });
                        child.on('error', () => { /* optional */ });
                        child.unref();
                    }
                    return;
                }
                const text = reply.out ? JSON.parse(reply.out)?.hookSpecificOutput?.additionalContext : null;
                if (text) output.output = `${output.output ?? ''}\n\n${text}`;
            } catch { /* fail open: the tool's own output is untouched */ }
        },
    };
};

// for tests only; a property, not an export, so OpenCode does not call it as a plugin
GraphIndexer.hookPayload = hookPayload;
