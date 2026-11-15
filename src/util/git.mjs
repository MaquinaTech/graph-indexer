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
    // core.quotePath off: a path with an accent is printed as it is, not as "\303\272til.py"
    const pairs = [['core.fsmonitor', 'false'], ['core.hooksPath', '/dev/null'], ['diff.external', ''], ['log.showSignature', 'false'], ['core.quotePath', 'false'],
        // the a/ and b/ prefixes the diff headers are read with: a user's diff.noprefix or diff.mnemonicPrefix would change them
        ['diff.noprefix', 'false'], ['diff.mnemonicPrefix', 'false']];
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

/**
 * The path a `+++ b/…` or `--- a/…` line of a diff names, or null for /dev/null. git ends a path
 * that holds a space with a tab, and writes one that holds a quote, a backslash or a control
 * character in C quotes.
 */
export function diffHeaderPath(line) {
    let p = line.slice(4);
    if (p.endsWith('\t')) p = p.slice(0, -1);
    if (p.length > 1 && p.startsWith('"') && p.endsWith('"')) {
        const bytes = [];
        const body = p.slice(1, -1);
        const esc = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
        for (let i = 0; i < body.length; i++) {
            if (body[i] !== '\\') { bytes.push(...Buffer.from(body[i], 'utf8')); continue; }
            const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
            if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; }
            else { bytes.push(esc[body[i + 1]] ?? body.charCodeAt(i + 1)); i++; }
        }
        p = Buffer.from(bytes).toString('utf8');
    }
    return p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
}
