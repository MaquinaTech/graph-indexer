/**
 * The resident process: a long-lived graph-indexer that keeps one repository's index open and in
 * sync, and answers hooks and CLI queries over a local socket.
 *
 * Opening the index and reconciling it with the working tree costs 200–500 ms on a repository of
 * 1,600 files, on every hook call and every CLI query. Hooks run on each read, search and edit, so
 * that cost lands on every step of the agent. The MCP server (`serve`) is already long-lived and
 * serves as the resident when the agent runs it; `graph-indexer daemon` does the same for agents
 * that only use hooks or the CLI, and exits after a while without requests.
 *
 * Clients ask first and fall back to opening the index themselves when nothing answers, so a
 * missing, dead or different-version resident only costs the old latency.
 *
 * Protocol: one JSON request per connection, one JSON reply, each ended by a newline.
 *   { v, version, op: 'ping' }                  → { ok, root, pid }
 *   { v, version, op: 'hook', event, input }     → { ok, out }   out: what the hook prints, or null
 *   { v, version, op: 'tool', calls }            → { ok, out }   out: the CLI's output text
 * A request from another graph-indexer version gets { ok: false } and the client falls back, except
 * from thin clients that only relay hooks (`any: true`, integrations/claude-code/hooks/gi-hook.mjs).
 *
 * The socket is only reachable by its owner: inside the repository's .graph-indexer/ directory,
 * or, when that path is too long for a Unix socket, in a per-user directory with mode 0700 that
 * both sides check before using it. On Windows it is a named pipe.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR_NAME } from '../util/paths.mjs';

const PROTOCOL = 1;
const MAX_REQUEST = 8 * 1024 * 1024;
const WIN = process.platform === 'win32';

/** Where the resident for `root` listens. */
export function socketPath(root) {
    const abs = path.resolve(root);
    const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 16);
    if (WIN) return `\\\\.\\pipe\\graph-indexer-${hash}`;
    const inRepo = path.join(abs, DATA_DIR_NAME, 'resident.sock');
    // Unix socket paths are limited to 104–108 bytes
    if (Buffer.byteLength(inRepo) <= 100) return inRepo;
    return path.join(os.tmpdir(), `graph-indexer-${process.getuid?.() ?? 'user'}`, `${hash}.sock`);
}

/** A per-user directory in the temp dir must belong to us and be closed to everyone else. */
function privateDir(dir, root) {
    if (WIN || dir === path.join(path.resolve(root), DATA_DIR_NAME)) return true;
    try {
        const st = fs.lstatSync(dir);
        return st.isDirectory() && (process.getuid ? st.uid === process.getuid() : true) && (st.mode & 0o077) === 0;
    } catch { return false; }
}

const disabled = () => process.env.GRAPH_INDEXER_RESIDENT === '0';
/** GRAPH_INDEXER_RESIDENT=require: answer only through a resident, never by opening the index (tests, debugging). */
export const residentRequired = () => process.env.GRAPH_INDEXER_RESIDENT === 'require';

/**
 * Ask the resident serving `root`. Resolves to its reply ({ ok: true, … }) or null when there is
 * none, it is another version, it fails, or it is slower than `totalMs`.
 */
export function askResident(root, request, { version, connectMs = 250, totalMs = 5000 } = {}) {
    if (disabled()) return Promise.resolve(null);
    const file = socketPath(root);
    if (!WIN && (!fs.existsSync(file) || !privateDir(path.dirname(file), root))) return Promise.resolve(null);
    return new Promise((resolve) => {
        let done = false, connected = false, buf = '';
        const sock = net.createConnection(file);
        const finish = (v) => {
            if (done) return;
            done = true;
            clearTimeout(connectTimer);
            clearTimeout(totalTimer);
            sock.destroy();
            resolve(v);
        };
        const connectTimer = setTimeout(() => { if (!connected) finish(null); }, connectMs);
        const totalTimer = setTimeout(() => finish(null), totalMs);
        sock.setEncoding('utf8');
        sock.on('connect', () => {
            connected = true;
            sock.write(JSON.stringify({ v: PROTOCOL, version, ...request }) + '\n');
        });
        sock.on('data', (d) => {
            buf += d;
            const i = buf.indexOf('\n');
            if (i < 0) return;
            let reply = null;
            try { reply = JSON.parse(buf.slice(0, i)); } catch { /* garbled */ }
            finish(reply?.ok ? reply : null);
        });
        sock.on('error', () => finish(null));
        sock.on('close', () => finish(null));
    });
}

/**
 * Serve `root` on its socket. `handle(request)` answers hook and tool requests. Returns null when
 * another resident already serves the repository (or the socket cannot be made private), else
 * { file, close }. `idleMs` > 0 calls `onIdle` after that long without a request, or as soon as
 * `wanted()` turns false.
 */
export async function startResident({ root, version, handle, log = () => {}, idleMs = 0, onIdle = null, wanted = () => true }) {
    if (disabled()) return null;
    const file = socketPath(root);
    if (!WIN) {
        const dir = path.dirname(file);
        try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* checked below */ }
        if (!privateDir(dir, root)) { log(`resident: ${dir} is not private; not listening`); return null; }
    }
    // another resident may serve this repository already; a dead one leaves its socket file behind
    if (await askResident(root, { op: 'ping' }, { version, connectMs: 300, totalMs: 1500 })) return null;
    if (!WIN) { try { fs.unlinkSync(file); } catch { /* none */ } }

    let last = Date.now();
    const server = net.createServer((sock) => {
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('error', () => { /* client went away */ });
        sock.on('data', async (d) => {
            buf += d;
            if (buf.length > MAX_REQUEST) { sock.destroy(); return; }
            const i = buf.indexOf('\n');
            if (i < 0) return;
            const line = buf.slice(0, i);
            buf = '';
            last = Date.now();
            let reply;
            try {
                const req = JSON.parse(line);
                // `any`: a thin client with no logic of its own (the Claude Code plugin's hook command)
                if (req.v !== PROTOCOL || (req.version !== version && req.any !== true)) reply = { ok: false, reason: 'version' };
                else if (req.op === 'ping') reply = { ok: true, root, pid: process.pid };
                else reply = { ok: true, out: (await handle(req)) ?? null };
            } catch (e) { reply = { ok: false, reason: String(e?.message ?? e).slice(0, 200) }; }
            last = Date.now();
            if (!sock.destroyed) sock.end(JSON.stringify(reply) + '\n');
        });
    });
    try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(file, resolve); });
    } catch (e) {
        log(`resident: cannot listen on ${file} (${e.code ?? e.message})`);
        return null;
    }
    let ino = null;
    if (!WIN) {
        try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
        try { ino = fs.statSync(file).ino; } catch { /* checked on close */ }
    }
    server.unref(); // the caller's own work (stdio, watcher, idle timer) decides the process lifetime

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        try { server.close(); } catch { /* closed */ }
        // only our own socket file: a resident started after us may have replaced it
        if (!WIN) { try { if (fs.statSync(file).ino === ino) fs.unlinkSync(file); } catch { /* gone */ } }
    };
    process.once('exit', close);
    if (idleMs > 0) {
        // also stop when the repository or its index goes away
        const timer = setInterval(() => {
            if (Date.now() - last < idleMs && wanted()) return;
            clearInterval(timer);
            close();
            onIdle?.();
        }, Math.min(idleMs, 30_000));
    }
    log(`resident: answering hooks and CLI queries on ${file}`);
    return { file, close };
}
