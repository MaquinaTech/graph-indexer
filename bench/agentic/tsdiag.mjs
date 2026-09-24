#!/usr/bin/env node
/**
 * TypeScript diagnostics of a checkout, for grading refactor tasks without a build: the program
 * covers every tracked .ts file with the repository's tsconfig options (missing third-party
 * packages make the baseline noisy, so grading compares against the base commit's diagnostics).
 *
 *   node bench/agentic/tsdiag.mjs [--json out.json]              diagnostics of the cwd checkout
 *   node bench/agentic/tsdiag.mjs --baseline base.json           exit 1 if new diagnostics appeared
 *   node bench/agentic/tsdiag.mjs --baseline-rev <commit>        same, against that commit of the cwd's
 *                                                                repository (computed once, cached)
 *
 * A diagnostic is keyed by file + code + message (no line numbers, which move with any edit).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { argv, sh, git, tryGit, WORK } from './lib.mjs';
import { tsSetup } from './tsconfig.mjs';

const tsPath = process.env.TYPESCRIPT_PATH ?? '/opt/node22/lib/node_modules/typescript';
const ts = createRequire(import.meta.url)(tsPath);

export function diagnostics(root) {
    const cfg = tsSetup(ts, root);
    const files = cfg.files ?? sh('git ls-files -co --exclude-standard -- "*.ts" "*.tsx"', { cwd: root }).stdout.split('\n').filter(f => f && !f.includes('node_modules')).map(f => path.join(root, f));
    const options = { ...cfg.options, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false };
    const program = ts.createProgram(files, options);
    const out = [];
    for (const d of ts.getPreEmitDiagnostics(program)) {
        if (!d.file) continue;
        const rel = path.relative(root, d.file.fileName).split(path.sep).join('/');
        if (rel.startsWith('..') || rel.includes('node_modules')) continue;
        const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
        // messages can name types by absolute path (import("/…/x").T): make them checkout-independent
        const message = ts.flattenDiagnosticMessageText(d.messageText, ' ').split(root + path.sep).join('').slice(0, 300);
        out.push({ file: rel, line: line + 1, code: d.code, message });
    }
    return out;
}

const key = (d) => `${d.file}|${d.code}|${d.message}`;

/** Diagnostics of `rev` in the repository of `cwd`, from a pristine temporary worktree (cached). */
export function baselineAt(cwd, rev) {
    const sha = git(cwd, 'rev-parse', rev).trim();
    const cache = path.join(WORK, 'tsdiag', `${sha}.json`);
    if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
    const tmp = path.join(WORK, 'tsdiag', `wt-${sha.slice(0, 12)}-${process.pid}`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    git(cwd, 'worktree', 'add', '-q', '--detach', tmp, sha);
    try {
        const diags = diagnostics(tmp);
        fs.writeFileSync(cache + '.tmp', JSON.stringify(diags));
        fs.renameSync(cache + '.tmp', cache);
        return diags;
    } finally {
        if (tryGit(cwd, 'worktree', 'remove', '--force', tmp) === null) fs.rmSync(tmp, { recursive: true, force: true });
    }
}

/** Diagnostics present now but not in the baseline (as a multiset). */
export function newDiagnostics(now, baseline) {
    const count = new Map();
    for (const d of baseline) count.set(key(d), (count.get(key(d)) ?? 0) + 1);
    const out = [];
    for (const d of now) {
        const k = key(d);
        const n = count.get(k) ?? 0;
        if (n > 0) count.set(k, n - 1); else out.push(d);
    }
    return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { opt } = argv();
    const t0 = Date.now();
    const now = diagnostics(process.cwd());
    if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(now));
    if (opt('--baseline') || opt('--baseline-rev')) {
        const base = opt('--baseline') ? JSON.parse(fs.readFileSync(opt('--baseline'), 'utf8')) : baselineAt(process.cwd(), opt('--baseline-rev'));
        const fresh = newDiagnostics(now, base);
        console.log(`${now.length} diagnostics, ${fresh.length} new (${Date.now() - t0} ms)`);
        for (const d of fresh.slice(0, 15)) console.log(`  ${d.file}:${d.line} TS${d.code} ${d.message}`);
        process.exitCode = fresh.length ? 1 : 0;
    } else console.log(`${now.length} diagnostics (${Date.now() - t0} ms)`);
}
