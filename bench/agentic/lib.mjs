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

/** Work area for checkouts, runs and results (outside the repository by default). */
export const WORK = path.resolve(process.env.GI_AGENTIC_WORK ?? path.join(os.tmpdir(), 'gi-agentic'));

export function argv() {
    const args = process.argv.slice(2);
    return {
        args,
        opt: (k, d = null) => { const i = args.indexOf(k); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; },
        flag: (k) => args.includes(k),
        list: (k, d = []) => { const i = args.indexOf(k); return i >= 0 && i + 1 < args.length ? args[i + 1].split(',').map(s => s.trim()).filter(Boolean) : d; },
    };
}

/** Run a shell command; never throws. */
export function sh(cmd, { cwd = process.cwd(), timeout = 600_000, env = {}, input } = {}) {
    const t0 = Date.now();
    const r = spawnSync('bash', ['-lc', cmd], {
        cwd, encoding: 'utf8', timeout, input, maxBuffer: 1 << 28,
        env: { ...process.env, ...env },
    });
    return {
        code: r.status ?? (r.signal ? 124 : 1),
        signal: r.signal ?? null,
        timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM',
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
