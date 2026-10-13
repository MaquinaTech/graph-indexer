#!/usr/bin/env node
/**
 * Run one command of a mined repository inside the benchmark's sandbox (lib.mjs `sandboxed`,
 * sandbox.sb): no network beyond localhost, writes only to the checkout, the temporary directories
 * and the work area's cache, no reads of credentials. The repository's Python (repos.mjs) comes
 * first on PATH, so `python` and `pytest` are the ones its tests are graded with.
 *
 *   node bench/agentic/sandbox-run.mjs --checkout DIR [--repo NAME] [--timeout SEC] -- CMD ARGS...
 *
 * Prints the command's output and exits with its status (124 on timeout).
 */
import path from 'node:path';
import { argv, sandboxed, sh } from './lib.mjs';
import { REPOS } from './repos.mjs';

const { args, opt } = argv();
const sep = args.indexOf('--');
if (sep < 0 || !opt('--checkout')) {
    console.error('usage: sandbox-run.mjs --checkout DIR [--repo NAME] [--timeout SEC] -- CMD ARGS...');
    process.exit(2);
}
const checkout = path.resolve(opt('--checkout'));
const repo = REPOS[opt('--repo', '')];
const python = repo?.python ?? process.env.GI_PYTHON;
const bin = python ? path.dirname(python) : null;
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const cmd = `${bin ? `PATH=${q(bin)}:"$PATH" ` : ''}${args.slice(sep + 1).map(q).join(' ')}`;
const r = sh(sandboxed(cmd, { checkout }), { cwd: checkout, timeout: Number(opt('--timeout', 600)) * 1000 });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exit(r.timedOut ? 124 : r.code);
