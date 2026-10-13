/**
 * Shared helpers for the agentic benchmark: processes, git, JSON files and the work area.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GI_ROOT = path.resolve(HERE, '../..');

/** Work area for checkouts, runs and results: ~/.gi-agentic unless GI_AGENTIC_WORK says otherwise (never the temporary directory, where a run without the variable would leave a second, stray work area). */
export const WORK = path.resolve(process.env.GI_AGENTIC_WORK ?? path.join(os.homedir(), '.gi-agentic'));

export function argv() {
    const args = process.argv.slice(2);
    return {
        args,
        opt: (k, d = null) => { const i = args.indexOf(k); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; },
        flag: (k) => args.includes(k),
        list: (k, d = []) => { const i = args.indexOf(k); return i >= 0 && i + 1 < args.length ? args[i + 1].split(',').map(s => s.trim()).filter(Boolean) : d; },
    };
}

/**
 * A shell command that runs third-party code (a mined repository's tests or build) inside the
 * macOS sandbox of `sandbox.sb`: no network beyond localhost, writes only to `checkout`, the
 * temporary directories and a cache in the work area (GOCACHE, npm, XDG point there), and no reads
 * of credentials. Fails closed: without `sandbox-exec` it throws, unless GI_SANDBOX=off says to run
 * unconfined. Inside a sandbox (GI_IN_SANDBOX) commands are not wrapped again (sandboxes cannot nest).
 */
export function sandboxed(cmd, { checkout }) {
    if (process.env.GI_IN_SANDBOX === '1' || process.env.GI_SANDBOX === 'off') return cmd;
    if (!fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('no /usr/bin/sandbox-exec: third-party code runs only sandboxed (GI_SANDBOX=off to override)');
    const cache = path.join(WORK, 'sandbox-cache');
    fs.mkdirSync(cache, { recursive: true });
    const q = JSON.stringify;
    const env = `GI_IN_SANDBOX=1 GOCACHE=${q(path.join(cache, 'go-build'))} npm_config_cache=${q(path.join(cache, 'npm'))} XDG_CACHE_HOME=${q(cache)}`;
    return `/usr/bin/sandbox-exec -D CHECKOUT=${q(fs.realpathSync(checkout))} -D HOME=${q(os.homedir())} -D CACHE=${q(fs.realpathSync(cache))} -f ${q(path.join(HERE, 'sandbox.sb'))} /usr/bin/env ${env} bash -c ${q(cmd)}`;
}

/**
 * How many processes to run at once: at most `want`, and no more than the cores the machine has
 * idle now (other sessions and builds share it), never below one.
 */
export function fairJobs(want) {
    const idle = os.cpus().length - Math.ceil(os.loadavg()[0]);
    return Math.max(1, Math.min(want, idle));
}

// Runs $GI_CMD as a job in its own process group and, past the time limit, kills the whole group
// (SIGTERM, then SIGKILL): killing only the shell would leave its children (a test run) orphaned.
const WATCHDOG = `set -m
bash -c "$GI_CMD" & p=$!
( sleep "$GI_LIMIT"; kill -TERM -- -$p; sleep 5; kill -KILL -- -$p ) >/dev/null 2>&1 & w=$!
set +m
wait $p; rc=$?
kill -- -$w 2>/dev/null
exit $rc`;

/** Run a shell command; never throws. */
export function sh(cmd, { cwd = process.cwd(), timeout = 600_000, env = {}, input } = {}) {
    const t0 = Date.now();
    const limit = Math.max(1, Math.ceil(timeout / 1000));
    const r = spawnSync('bash', ['-lc', WATCHDOG], {
        cwd, encoding: 'utf8', timeout: timeout + 30_000, input, maxBuffer: 1 << 28,
        env: { ...process.env, ...env, GI_CMD: cmd, GI_LIMIT: String(limit) },
    });
    const elapsed = Date.now() - t0;
    return {
        code: r.status ?? (r.signal ? 124 : 1),
        signal: r.signal ?? null,
        timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM' || (r.status !== 0 && elapsed >= limit * 1000),
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        ms: Date.now() - t0,
    };
}

export function git(cwd, ...a) {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')} (in ${cwd}): ${(r.stderr || '').trim()}`);
    return r.stdout;
}
export const tryGit = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return null; } };

export function readJson(p, fallback = null) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
export function writeJson(p, v) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
}
export function appendJsonl(p, v) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(v) + '\n');
}
export function readJsonl(p) {
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** All task files under bench/agentic/tasks (one JSON array or object per file). */
export function loadTasks(dir = path.join(HERE, 'tasks')) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
        const v = readJson(path.join(dir, f));
        for (const t of Array.isArray(v) ? v : v ? [v] : []) out.push({ ...t, _file: f });
    }
    return out;
}

export const runId = (taskId, arm, rep) => `${taskId}__${arm}__r${rep}`;

export function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); }
