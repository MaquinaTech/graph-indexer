/**
 * git, run so that an indexed repository's own config cannot make it execute anything: no
 * fsmonitor, no hooks, no signature verification, no external diff or textconv, every
 * clean/smudge/process filter switched off, and no descent into submodules (whose own config the
 * overrides below do not cover). A repository copied with its .git directory (an archive, a shared
 * folder) is not trusted. Every git call graph-indexer makes goes through gitSync.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const COMMAND_KEY = /^(filter\.[^\n]+)\.(clean|smudge|process)$|^diff\.[^\n]+\.(textconv|command)$/;

let gitBin = null;
/**
 * The git executable. On Windows a bare `git` is looked up in the working directory before PATH,
 * so a `git.exe` committed at the repository root would run instead: look it up on PATH only.
 */
export function gitExecutable() {
    if (gitBin) return gitBin;
    gitBin = 'git';
    if (process.platform === 'win32') {
        const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean);
        for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
            if (!dir || !path.isAbsolute(dir)) continue;
            const hit = exts.map(e => path.join(dir, 'git' + e.toLowerCase())).find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
            if (hit) { gitBin = hit; break; }
        }
    }
    return gitBin;
}

let envConfig = null;
/** git ≥ 2.31 takes config from GIT_CONFIG_COUNT/KEY/VALUE, which carry a key verbatim. */
function supportsEnvConfig() {
    if (envConfig != null) return envConfig;
    const m = /(\d+)\.(\d+)/.exec(spawnSync(gitExecutable(), ['--version'], { encoding: 'utf8' }).stdout ?? '');
    return (envConfig = !!m && (+m[1] > 2 || (+m[1] === 2 && +m[2] >= 31)));
}

/**
 * The overrides for `root`: fixed ones, plus one blanking each command its config names. Those go
 * in the environment, not as `-c key=`: git splits a `-c` at the first `=`, and a driver may be
 * named `x=y`, so `-c filter.x=y.clean=` would set `filter.x` and leave the real command on.
 * Returns null when the overrides cannot be expressed (an old git and such a name): git is not run.
 */
function hardening(root) {
    const pairs = [['core.fsmonitor', 'false'], ['core.hooksPath', '/dev/null'], ['diff.external', ''], ['log.showSignature', 'false']];
    const r = spawnSync(gitExecutable(), ['config', '-z', '--name-only', '--get-regexp', '^(filter|diff)\\.'], { cwd: root, encoding: 'utf8' });
    for (const key of (r.status === 0 ? r.stdout : '').split('\0')) {
        const m = COMMAND_KEY.exec(key);
        if (!m) continue;
        pairs.push([key, '']);
        // a required filter (Git LFS sets one) would otherwise fail the diff once its command is blank
        if (m[1]) pairs.push([`${m[1]}.required`, 'false']);
    }
    if (supportsEnvConfig()) {
        const base = Number(process.env.GIT_CONFIG_COUNT) || 0;
        const env = { GIT_CONFIG_COUNT: String(base + pairs.length) };
        pairs.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${base + i}`] = k; env[`GIT_CONFIG_VALUE_${base + i}`] = v; });
        return { args: [], env };
    }
    if (pairs.some(([k]) => k.includes('='))) return null;
    return { args: pairs.flatMap(([k, v]) => ['-c', `${k}=${v}`]), env: {} };
}

const NO_TOOLS = {
    diff: ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all'],
    log: ['--no-ext-diff', '--no-textconv', '--no-show-signature'],
    status: ['--ignore-submodules=all'],
};

/** spawnSync('git', args) in `root`, hardened as above; diff and log never run external tools. */
export function gitSync(root, args, opts = {}) {
    const sub = NO_TOOLS[args[0]] ? [args[0], ...NO_TOOLS[args[0]], ...args.slice(1)] : args;
    const h = hardening(root);
    if (!h) return { status: 1, stdout: '', stderr: 'git not run: the repository config names a filter or diff driver this git cannot switch off', error: null };
    return spawnSync(gitExecutable(), [...h.args, ...sub], { cwd: root, encoding: 'utf8', ...opts, env: { ...process.env, ...opts.env, ...h.env } });
}
