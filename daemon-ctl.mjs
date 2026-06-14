#!/usr/bin/env node
/**
 * @file daemon-ctl.mjs
 * @description `idx-daemon` — control the graph-indexer watch daemon from the
 *              command line (and therefore from npm scripts): start, stop,
 *              restart, status, logs. Exactly one daemon runs per project; the
 *              daemon self-guards via an atomic PID lock (daemon-lock.mjs), so
 *              `start` is safe to call repeatedly and from any launcher.
 *
 *                idx-daemon start      Start it (no-op if already running)
 *                idx-daemon stop       Gracefully stop it
 *                idx-daemon restart    Stop then start
 *                idx-daemon status     Show daemon + index state (default)
 *                idx-daemon logs [-f]  Print recent daemon logs (-f to follow)
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { resolveConfig } from './config.mjs';
import { ensureDataDir, migrateLegacyLayout } from './layout.mjs';
import { daemonStatus, readPid, isAlive } from './daemon-lock.mjs';
import { c, glyph, log } from './cli-ui.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = path.join(__dirname, 'watch-daemon.mjs');

const config = resolveConfig();
const ROOT = config.projectRoot;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function relArtifact() {
    const p = config.storage === 'sqlite' ? config.sqlitePath : config.indexPath;
    return path.relative(ROOT, p) || p;
}

function freshness(file) {
    try {
        const sec = Math.floor((Date.now() - fs.statSync(file).mtimeMs) / 1000);
        if (sec < 60) return `${sec}s ago`;
        if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
        if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
        return `${Math.floor(sec / 86400)}d ago`;
    } catch { return 'never indexed'; }
}

/** Spawn the watch daemon detached, logging to the data dir. */
function spawnDaemon() {
    ensureDataDir(ROOT);
    let logFd = null;
    try { logFd = fs.openSync(config.logFile, 'a'); } catch { /* log to /dev/null */ }
    const child = spawn(process.execPath, [DAEMON_PATH], {
        detached: true,
        stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
        env: { ...process.env, MCP_PROJECT_ROOT: ROOT },
    });
    child.unref();
    if (logFd !== null) fs.closeSync(logFd);
    return child.pid;
}

function cmdStatus() {
    const { running, pid } = daemonStatus(config.pidFile);
    const artifact = config.storage === 'sqlite' ? config.sqlitePath : config.indexPath;
    log('');
    log(`  ${c.bold('graph-indexer')} ${c.dim('· daemon status')}`);
    log(`  ${running ? glyph.run : glyph.stop} Daemon       ${running ? c.green(`running (PID ${pid})`) : c.dim('stopped')}`);
    log(`  ${glyph.arrow} Project      ${c.dim(ROOT)}`);
    log(`  ${glyph.arrow} Backend      ${config.storage === 'sqlite' ? 'SQLite (disk-backed)' : 'in-memory'}`);
    log(`  ${glyph.arrow} Index        ${c.dim(relArtifact())} ${c.dim('· ' + freshness(artifact))}`);
    log(`  ${glyph.arrow} Logs         ${c.dim(path.relative(ROOT, config.logFile) || config.logFile)}`);
    log('');
    if (!running) log(c.dim(`  Start it with: ${c.cyan('npm run mcp:daemon:start')}\n`));
    return 0;
}

function cmdStart() {
    ensureDataDir(ROOT);
    migrateLegacyLayout(ROOT);
    const { running, pid } = daemonStatus(config.pidFile);
    if (running) {
        log(`${glyph.keep} Daemon already running ${c.dim(`(PID ${pid})`)} — only one runs per project.`);
        return 0;
    }
    const newPid = spawnDaemon();
    log(`${glyph.ok} Watch daemon started ${c.dim(`(PID ${newPid})`)}`);
    log(c.dim(`  Logs: ${path.relative(ROOT, config.logFile) || config.logFile}`));
    return 0;
}

async function cmdStop() {
    const pid = readPid(config.pidFile);
    if (!isAlive(pid)) {
        log(`${glyph.keep} No daemon running.`);
        try { if (pid) fs.unlinkSync(config.pidFile); } catch { /* nothing to clear */ }
        return 0;
    }
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 50 && isAlive(readPid(config.pidFile) ?? pid); i++) await sleep(100);
    if (isAlive(pid)) {
        log(`${glyph.warn} Daemon ${c.dim(`(PID ${pid})`)} did not stop within 5s.`);
        return 1;
    }
    log(`${glyph.ok} Daemon stopped ${c.dim(`(PID ${pid})`)}.`);
    return 0;
}

async function cmdRestart() {
    await cmdStop();
    await sleep(200);
    return cmdStart();
}

function tail(file, n) {
    try {
        const size = fs.statSync(file).size;
        const start = Math.max(0, size - 256 * 1024); // last 256 KB is plenty
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            const lines = buf.toString('utf-8').split('\n');
            return { lines: lines.slice(-n - 1), size };
        } finally { fs.closeSync(fd); }
    } catch { return { lines: [], size: 0 }; }
}

async function cmdLogs(args) {
    const follow = args.includes('-f') || args.includes('--follow');
    const nArg = args.find((a) => /^\d+$/.test(a));
    const n = nArg ? Number(nArg) : 50;
    if (!fs.existsSync(config.logFile)) {
        log(c.dim(`No daemon log yet (${path.relative(ROOT, config.logFile) || config.logFile}).`));
        return 0;
    }
    const { lines, size } = tail(config.logFile, n);
    process.stdout.write(lines.join('\n'));
    if (!follow) { log(''); return 0; }

    // Follow mode: print appended bytes as they arrive until interrupted.
    let pos = size;
    log(c.dim(`\n— following ${path.relative(ROOT, config.logFile)} (Ctrl-C to stop) —`));
    fs.watchFile(config.logFile, { interval: 500 }, (cur) => {
        if (cur.size < pos) { pos = 0; return; } // truncated/rotated
        if (cur.size === pos) return;
        const fd = fs.openSync(config.logFile, 'r');
        try {
            const buf = Buffer.alloc(cur.size - pos);
            fs.readSync(fd, buf, 0, buf.length, pos);
            process.stdout.write(buf.toString('utf-8'));
            pos = cur.size;
        } finally { fs.closeSync(fd); }
    });
    return new Promise(() => { /* runs until Ctrl-C */ });
}

const [cmd = 'status', ...rest] = process.argv.slice(2);
const run = {
    start: cmdStart,
    stop: cmdStop,
    restart: cmdRestart,
    status: cmdStatus,
    logs: () => cmdLogs(rest),
}[cmd];

if (!run) {
    log(`${glyph.err} Unknown command: ${c.bold(cmd)}`);
    log(c.dim('  Usage: idx-daemon [start|stop|restart|status|logs]'));
    process.exit(2);
}

Promise.resolve(run()).then((code) => process.exit(code ?? 0));
