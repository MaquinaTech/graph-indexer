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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { argv, sh, sandboxed, fairJobs } from './lib.mjs';

const PYTEST = process.env.GI_PYTEST ?? (fs.existsSync('/root/.local/bin/pytest') ? '/root/.local/bin/pytest' : 'python3 -m pytest');
const PYTHON = process.env.GI_PYTHON ?? 'python3';

const modOf = (f) => f.replace(/\.py$/, '').replace(/\//g, '.');

/**
 * unittest: a result object records each test's outcome as it happens, so output a test prints
 * cannot hide its status. Ids: `tests/test_x.py::Class::test_name`; a module that fails to import
 * is `tests/test_x.py::<import>`.
 */
const UNITTEST_DRIVER = `
import json, sys, unittest
out = {}
def tid(t):
    if type(t).__name__ == '_FailedTest':
        return t._testMethodName.replace('.', '/') + '.py::<import>'
    return type(t).__module__.replace('.', '/') + '.py::' + type(t).__name__ + '::' + getattr(t, '_testMethodName', str(t))
class Result(unittest.TextTestResult):
    def addSuccess(self, t): super().addSuccess(t); out.setdefault(tid(t), 'pass')
    def addFailure(self, t, e): super().addFailure(t, e); out[tid(t)] = 'fail'
    def addError(self, t, e):
        super().addError(t, e)
        if isinstance(t, unittest.TestCase): out[tid(t)] = 'fail'
    def addSkip(self, t, r): super().addSkip(t, r); out[tid(t)] = 'skip'
    def addExpectedFailure(self, t, e): super().addExpectedFailure(t, e); out[tid(t)] = 'pass'
    def addUnexpectedSuccess(self, t): super().addUnexpectedSuccess(t); out[tid(t)] = 'fail'
    def addSubTest(self, t, st, e):
        super().addSubTest(t, st, e)
        if e is not None: out[tid(t)] = 'fail'
# guarded: processes started with "spawn" (tests that use multiprocessing) import this file again
if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromNames(sys.argv[2:])
    unittest.TextTestRunner(resultclass=Result, verbosity=1, stream=sys.stdout).run(suite)
    json.dump(out, open(sys.argv[1], 'w'))
`;

function runUnittest(cwd, targets, timeoutSec) {
    const json = path.join(os.tmpdir(), `gi-unittest-${process.pid}-${Date.now()}.json`);
    const driver = path.join(os.tmpdir(), `gi-unittest-${process.pid}.py`);
    fs.writeFileSync(driver, UNITTEST_DRIVER);
    // the driver runs as a file outside the checkout, with the checkout first on the path
    const r = sh(sandboxed(`/usr/bin/time -p env PYTHONPATH=. ${PYTHON} ${driver} ${json} ${targets.join(' ')} 2>&1`, { checkout: cwd }), { cwd, timeout: timeoutSec * 1000 });
    const out = new Map();
    try { for (const [id, s] of Object.entries(JSON.parse(fs.readFileSync(json, 'utf8')))) out.set(id, s); } catch { /* timed out or crashed: no outcomes */ }
    fs.rmSync(json, { force: true });
    return { outcomes: out, code: r.code, ms: r.ms, cpuMs: cpuMs(r.stdout), tail: r.stdout.slice(-1500) };
}

/** pytest: junit XML per test case. */
function runPytest(cwd, targets, timeoutSec) {
    const xml = path.join(os.tmpdir(), `gi-pytest-${process.pid}-${Date.now()}.xml`);
    const r = sh(sandboxed(`/usr/bin/time -p ${PYTEST} -q -p no:cacheprovider -o addopts= --junitxml=${xml} ${targets.join(' ')} 2>&1`, { checkout: cwd }), { cwd, timeout: timeoutSec * 1000 });
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
    return { outcomes: out, code: r.code, ms: r.ms, cpuMs: cpuMs(r.stdout), tail: r.stdout.slice(-1500) };
}

/**
 * CPU time (user + sys) the run took, from `time -p`: unlike the wall clock it does not grow when
 * other processes load the machine, so a "too slow" rule on it gives the same verdict at any load.
 */
function cpuMs(out) {
    const u = /^user\s+([\d.,]+)$/m.exec(out), s = /^sys\s+([\d.,]+)$/m.exec(out);
    return u && s ? Math.round((Number(u[1]) + Number(s[1])) * 1000) : null;
}

export function runTests(cwd, runner, files, { timeoutSec = 600 } = {}) {
    if (runner === 'unittest') return runUnittest(cwd, files.map(modOf), timeoutSec);
    return runPytest(cwd, files, timeoutSec);
}

/**
 * Many test files, each in its own process, up to `jobs` at a time (fewer when the machine is
 * busy; re-checked before each file): a whole suite in a fraction of the time, and a file that
 * crashes or times out costs only its own outcomes (`<file>::<run>` = fail).
 */
export async function runFiles(cwd, runner, files, { jobs = 6, timeoutSec = 600 } = {}) {
    const out = {};
    let running = 0;
    let i = 0;
    await Promise.all(Array.from({ length: jobs }, async (_, w) => {
        while (i < files.length) {
            // workers beyond what the idle cores allow wait (worker 0 always runs)
            if (w > 0 && running >= fairJobs(jobs)) { await new Promise(r => setTimeout(r, 2000)); continue; }
            const f = files[i++];
            running++;
            const json = path.join(os.tmpdir(), `gi-files-${process.pid}-${i}-${Date.now()}.json`);
            await new Promise((resolve) => {
                const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--runner', runner, '--files', f, '--json', json, '--timeout', String(timeoutSec)], { cwd, stdio: 'ignore' });
                p.on('close', resolve);
            });
            let o = {};
            try { o = JSON.parse(fs.readFileSync(json, 'utf8')); } catch { /* crashed or timed out */ }
            fs.rmSync(json, { force: true });
            Object.assign(out, Object.keys(o).length ? o : { [`${f}::<run>`]: 'fail' });
            running--;
        }
    }));
    return out;
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
        for (const id of bad.slice(0, 20)) console.log(`  ${r.outcomes.get(id) ?? 'missing'}: ${id}`);
        if (bad.length && ![...r.outcomes.keys()].length) console.log(r.tail);
        // the count comes last: graders keep the tail of the output
        console.log(`${ids.length - bad.length}/${ids.length} expected tests passed in ${(r.ms / 1000).toFixed(1)} s`);
        process.exitCode = bad.length ? 1 : 0;
    } else {
        const files = opt('--files', '').split(',').filter(Boolean);
        const r = runTests(cwd, runner, files, { timeoutSec: Number(opt('--timeout', 600)) });
        const obj = Object.fromEntries(r.outcomes);
        if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(obj, null, 1));
        const counts = {};
        for (const v of r.outcomes.values()) counts[v] = (counts[v] ?? 0) + 1;
        console.log(JSON.stringify({ code: r.code, ms: r.ms, counts }));
    }
}
