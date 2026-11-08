/**
 * git, run so that an indexed repository's own config cannot make it execute anything: no
 * fsmonitor, no hooks, no signature verification, no external diff or textconv, and every
 * clean/smudge/process filter switched off. A repository copied with its .git directory (an
 * archive, a shared folder) is not trusted.
 */
import { spawnSync } from 'node:child_process';

const COMMAND_KEY = /^(filter\.[^\n]+)\.(clean|smudge|process)$|^diff\.[^\n]+\.(textconv|command)$/;

function hardening(root) {
    const args = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'log.showSignature=false'];
    const r = spawnSync('git', ['config', '--name-only', '--get-regexp', '^(filter|diff)\\.'], { cwd: root, encoding: 'utf8' });
    for (const key of (r.status === 0 ? r.stdout : '').split('\n')) {
        const m = COMMAND_KEY.exec(key);
        if (!m) continue;
        args.push('-c', `${key}=`);
        // a required filter (Git LFS sets one) would otherwise fail the diff once its command is blank
        if (m[1]) args.push('-c', `${m[1]}.required=false`);
    }
    return args;
}

const NO_TOOLS = { diff: ['--no-ext-diff', '--no-textconv'], log: ['--no-ext-diff', '--no-textconv', '--no-show-signature'] };

/** spawnSync('git', args) in `root`, hardened as above; diff and log never run external tools. */
export function gitSync(root, args, opts = {}) {
    const sub = NO_TOOLS[args[0]] ? [args[0], ...NO_TOOLS[args[0]], ...args.slice(1)] : args;
    return spawnSync('git', [...hardening(root), ...sub], { cwd: root, encoding: 'utf8', ...opts });
}
