#!/usr/bin/env node
/**
 * Run Python tests and report per-test outcomes, for mining and grading benchmark tasks.
 *
 *   node bench/agentic/pytests.mjs --runner unittest|pytest --files a.py,b.py [--json out.json]
 *   node bench/agentic/pytests.mjs --runner unittest|pytest --expect-pass ids.json
 *
 * Outcomes are keyed by a stable test id (`tests/test_x.py::Class::test_name`). With
 * --expect-pass the exit code is 0 only when every listed test ran and passed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { argv, sh } from './lib.mjs';

const PYTEST = process.env.GI_PYTEST ?? (fs.existsSync('/root/.local/bin/pytest') ? '/root/.local/bin/pytest' : 'python3 -m pytest');
const PYTHON = process.env.GI_PYTHON ?? 'python3';

const modOf = (f) => f.replace(/\.py$/, '').replace(/\//g, '.');
const fileOfMod = (m) => m.replace(/\./g, '/') + '.py';

/** unittest: `python -m unittest -v` lines "test_x (pkg.mod.Class.test_x) ... ok". */
function runUnittest(cwd, targets, timeoutSec) {
    const r = sh(`${PYTHON} -m unittest -v ${targets.join(' ')} 2>&1`, { cwd, timeout: timeoutSec * 1000 });
    const out = new Map();
    const re = /^(\w+) \(([\w.]+)\)(?:\n[^\n]*?)? \.\.\. (ok|FAIL|ERROR|skipped.*|expected failure|unexpected success)$/gm;
    for (const m of r.stdout.matchAll(re)) {
        const [, name, full, status] = m;
        const parts = full.split('.');
        const cls = parts[parts.length - 1] === name ? parts[parts.length - 2] : parts[parts.length - 1];
        const mod = parts.slice(0, parts[parts.length - 1] === name ? -2 : -1).join('.');
        out.set(`${fileOfMod(mod)}::${cls}::${name}`, status === 'ok' || status === 'expected failure' ? 'pass' : status.startsWith('skipped') ? 'skip' : 'fail');
    }
    // a module that fails to import reports one error for the whole module
    for (const m of r.stdout.matchAll(/^ERROR: ([\w.]+) \(unittest\.loader\._FailedTest\.\1\)/gm)) out.set(`${fileOfMod(m[1])}::<import>`, 'fail');
    return { outcomes: out, code: r.code, ms: r.ms, tail: r.stdout.slice(-1500) };
}

/** pytest: junit XML per test case. */
function runPytest(cwd, targets, timeoutSec) {
    const xml = path.join(os.tmpdir(), `gi-pytest-${process.pid}-${Date.now()}.xml`);
    const r = sh(`${PYTEST} -q -p no:cacheprovider -o addopts= --junitxml=${xml} ${targets.join(' ')} 2>&1`, { cwd, timeout: timeoutSec * 1000 });
    const out = new Map();
    let text = '';
    try { text = fs.readFileSync(xml, 'utf8'); fs.rmSync(xml, { force: true }); } catch { /* no report */ }
    for (const m of text.matchAll(/<testcase ([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
        const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
        const body = m[3] ?? '';
        const status = /<(failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass';
        const parts = (attrs.classname ?? '').split('.');
        // classname "pkg.mod.Class" or "pkg.mod"; the file is the longest existing module prefix
        let file = null, cls = '';
        for (let k = parts.length; k > 0; k--) {
            const cand = parts.slice(0, k).join('/') + '.py';
            if (fs.existsSync(path.join(cwd, cand))) { file = cand; cls = parts.slice(k).join('.'); break; }
        }
        out.set(`${file ?? attrs.classname}::${cls}::${attrs.name}`, status);
    }
    return { outcomes: out, code: r.code, ms: r.ms, tail: r.stdout.slice(-1500) };
}

export function runTests(cwd, runner, files, { timeoutSec = 600 } = {}) {
    if (runner === 'unittest') return runUnittest(cwd, files.map(modOf), timeoutSec);
    return runPytest(cwd, files, timeoutSec);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { opt } = argv();
    const runner = opt('--runner', 'pytest');
    const cwd = process.cwd();
    const expect = opt('--expect-pass');
    if (expect) {
        const ids = JSON.parse(fs.readFileSync(expect, 'utf8'));
        const files = [...new Set(ids.map(id => id.split('::')[0]))];
        const r = runTests(cwd, runner, files, { timeoutSec: Number(opt('--timeout', 900)) });
        const bad = ids.filter(id => r.outcomes.get(id) !== 'pass');
        console.log(`${ids.length - bad.length}/${ids.length} expected tests passed in ${(r.ms / 1000).toFixed(1)} s`);
        for (const id of bad.slice(0, 20)) console.log(`  ${r.outcomes.get(id) ?? 'missing'}: ${id}`);
        if (bad.length && ![...r.outcomes.keys()].length) console.log(r.tail);
        process.exitCode = bad.length ? 1 : 0;
    } else {
        const files = opt('--files', '').split(',').filter(Boolean);
        const r = runTests(cwd, runner, files);
        const obj = Object.fromEntries(r.outcomes);
        if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(obj, null, 1));
        const counts = {};
        for (const v of r.outcomes.values()) counts[v] = (counts[v] ?? 0) + 1;
        console.log(JSON.stringify({ code: r.code, ms: r.ms, counts }));
    }
}
