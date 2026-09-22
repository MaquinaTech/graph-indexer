#!/usr/bin/env node
/**
 * Fetch the benchmark fixtures: public repositories pinned to exact commits (the same snapshots
 * graph-indexer v2 was benchmarked on, so results stay comparable).
 *
 *   node bench/fixtures.mjs [--only gin,nestjs] [--history 400] [--dir test/fixtures]
 *
 * --history N also fetches N commits of history before the pinned commit (needed by
 * bench/eval-localize.mjs, which replays real commits). Idempotent: fixtures already at the pinned
 * commit are left alone (their history is deepened when --history asks for more).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURES = {
    'axios':      { repo: 'https://github.com/axios/axios', commit: 'f7adacdbaa569281253c8cfc623ad3f4dc909c60', ref: 'v1.6.0', language: 'JavaScript' },
    'express-js': { repo: 'https://github.com/expressjs/express', commit: '8368dc178af16b91b576c4c1d135f701a0007e5d', ref: '4.18.2', language: 'JavaScript' },
    'nestjs':     { repo: 'https://github.com/nestjs/nest', commit: '416830c3924b37ec354d4e15c14119519e389afc', ref: 'v10.4.9', language: 'TypeScript' },
    'fastapi':    { repo: 'https://github.com/tiangolo/fastapi', commit: '415eb1405a5bc93a32e14c15d690517c95d26743', ref: '0.103.0', language: 'Python' },
    'gin':        { repo: 'https://github.com/gin-gonic/gin', commit: '4ea0e648e38a63d6caff14100f5eab5c50912bcd', ref: 'v1.9.1', language: 'Go' },
    'spring':     { repo: 'https://github.com/spring-projects/spring-petclinic', commit: 'a2c2ef994340d3970eb6db51247456a51bb161f8', language: 'Java' },
    'rust':       { repo: 'https://github.com/serde-rs/json', commit: 'a1ae73ac6a6940a4a57c673aebaa13ed4dfe3e8c', language: 'Rust' },
    'cjson':      { repo: 'https://github.com/DaveGamble/cJSON', commit: 'fb16e5cf358798aabb049655975cde8427101056', language: 'C' },
    'nvm':        { repo: 'https://github.com/nvm-sh/nvm', commit: 'a6ec73943099a86fba98bde3b04a1c60944a4549', language: 'Bash' },
};

function git(cwd, ...args) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || '').trim()}`);
    return r.stdout.trim();
}

function historyDepth(dir) {
    try { return Number(git(dir, 'rev-list', '--count', 'HEAD')); } catch { return 0; }
}

export function ensureFixture(name, { dir = path.join(here, '../test/fixtures'), history = 0, log = console.log } = {}) {
    const fx = FIXTURES[name];
    if (!fx) throw new Error(`unknown fixture ${name} (known: ${Object.keys(FIXTURES).join(', ')})`);
    const target = path.join(dir, name);
    const depth = Math.max(1, history + 1);
    let head = null;
    try { head = git(target, 'rev-parse', 'HEAD'); } catch { /* not a checkout yet */ }
    if (head !== fx.commit) {
        if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`${target} exists but is not at ${fx.commit}; remove it first`);
        fs.mkdirSync(target, { recursive: true });
        log(`${name}: fetching ${fx.repo} @ ${fx.commit.slice(0, 12)}${history ? ` (+${history} commits of history)` : ''}`);
        git(target, 'init', '-q');
        git(target, 'remote', 'add', 'origin', fx.repo);
        git(target, 'fetch', '-q', '--depth', String(depth), 'origin', fx.commit);
        git(target, 'checkout', '-q', '--detach', 'FETCH_HEAD');
    } else if (history && historyDepth(target) < depth) {
        log(`${name}: deepening history to ${depth} commits`);
        git(target, 'fetch', '-q', '--depth', String(depth), 'origin', fx.commit);
    } else {
        log(`${name}: ok (${fx.commit.slice(0, 12)})`);
    }
    return target;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
    const only = opt('--only', null)?.split(',') ?? Object.keys(FIXTURES);
    const history = Number(opt('--history', 0));
    const dir = path.resolve(opt('--dir', path.join(here, '../test/fixtures')));
    let failed = 0;
    for (const name of only) {
        try { ensureFixture(name, { dir, history }); } catch (e) { failed++; console.error(`${name}: ${e.message}`); }
    }
    process.exit(failed ? 1 : 0);
}
