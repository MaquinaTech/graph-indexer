#!/usr/bin/env node
/**
 * Does `check` see a change left half done?
 *
 * The failure it exists for: a definition is changed and its users elsewhere are not. Real history
 * has the answer key. A commit that changed the definition line of a name N in a file A and, in the
 * same commit, a line that uses N in another file B, shows where a developer had to follow the
 * change. Applying only A's part of the commit to the parent is the half-done edit; B's changed
 * lines are the places `check` should point at.
 *
 * Rules, from git text alone (no rule uses graph-indexer; they follow bench/agentic/mine-b5.mjs):
 *   1. one parent, no merge, a subject that is not a release, revert or backport; 2–8 modified
 *      source files, at most 16 files in all;
 *   2. ripple: a name N (4+ characters, not a special method) whose definition line in a source file
 *      A the commit removes or changes, and another modified file B, not itself such an A, that
 *      contained N at the parent and in which the commit changes a line containing N. Built or
 *      vendored copies (dist/, build/, vendor/, *.min.*) are neither A nor B.
 * The most recent --n such commits per repository.
 *
 * For each one, in a scratch worktree at the parent with the index brought there incrementally:
 *   partial   the A files are written as the commit leaves them; `check` runs against HEAD.
 *             A ripple is found when a finding about N names file B; a site when it names the line.
 *             Findings are split into problems ("✗": calls that no longer fit, removed names still
 *             used) and things to review ("•": callers in files not touched, inheriting subclasses).
 *   gold      the whole commit is checked out; `check` runs against the parent. Problems reported
 *             here are false alarms, or problems the developer left.
 *
 *   node bench/eval-check.mjs --repos gin,fastapi [--repo-dir test/fixtures] [--n 40] [--verbose] [--json out.json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodeIntel } from '../src/query/intel.mjs';
import { checkChanges } from '../src/query/check.mjs';
import * as tools from '../src/mcp/tools.mjs';
import { codeSpecForPath } from '../src/parse/languages.mjs';
import { FIXTURES } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const REPOS = opt('--repos', 'gin,fastapi,axios,express-js').split(',');
const DIR = path.resolve(opt('--repo-dir', path.join(here, '../test/fixtures')));
const N = Number(opt('--n', 40));
const SCAN = Number(opt('--scan', 4000));
const WORK = path.resolve(opt('--work-dir', path.join(os.tmpdir(), 'gi-check')));
const verbose = args.includes('--verbose');
// --full-reply: measure the whole reply as the tool gives it (tests section included), by calling
// the tool once more; without it, the reply is formatted from the report without that section
const fullReply = args.includes('--full-reply');

function git(cwd, ...a) {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${(r.stderr || '').trim()}`);
    return r.stdout;
}
const tryGit = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return null; } };

const SKIP_SUBJECT = /^(\[?Backport|Merge|Revert|Sync|Update CHANGELOG|Cleanup|chore|docs?|ci|build|style|bump|release|v?\d+\.\d+)\b/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|testing|testdata|fixtures?|e2e|integration)\/|(^|\/)(test_[^/]*|[^/]*_test|[^/]*\.(test|spec))\.[a-z]+$/i;
const NON_SOURCE = /(^|\/)(docs?|docs_src|examples?|samples?|benchmarks?|bench|scripts)\//i;
// built or vendored copies of the code (a bundle and its minified twin change together, but neither uses the other)
const GENERATED = /(^|\/)(dist|build|out|vendor|third_party|node_modules)\/|\.min\.|\.bundle\./i;
const COMMON = new Set(['main', 'init', 'test', 'name', 'type', 'self', 'this', 'data', 'value', 'list', 'item', 'next', 'call', 'read', 'send', 'open', 'close', 'write', 'error', 'String', 'toString', 'equals', 'clone', 'default', 'index', 'length', 'parse', 'create', 'update', 'delete', 'remove', 'render', 'handle']);

/** Definition lines by language family: the name a removed or changed line declares. */
const DEFS = [
    { ext: /\.py$/, res: [/^\s*(?:async\s+)?(?:def|class)\s+(\w+)/] },
    { ext: /\.(m|c)?[jt]sx?$/, res: [
        /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|enum)\s+([A-Za-z_$][\w$]*)/,
        /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
        /^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract)\s+)+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/,
    ] },
    { ext: /\.go$/, res: [/^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/, /^\s*type\s+(\w+)/] },
    { ext: /\.(java|kt|scala)$/, res: [
        /^\s*(?:(?:public|private|protected|static|final|abstract|sealed|open|data)\s+)*(?:class|interface|enum|record|object)\s+(\w+)/,
        /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|default|override)\s+)+(?:<[^>]+>\s+)?[\w<>\[\],.? ]+?\s+(\w+)\s*\(/,
        /^\s*(?:(?:public|private|protected|internal|override|open|suspend|inline)\s+)*fun\s+(?:<[^>]+>\s+)?(?:[\w.]+\.)?(\w+)\s*\(/,
    ] },
    { ext: /\.rs$/, res: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type)\s+(\w+)/] },
    { ext: /\.(rb)$/, res: [/^\s*(?:def|class|module)\s+(?:self\.)?(\w+)/] },
    { ext: /\.(cs)$/, res: [/^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|virtual|override|async)\s+)*(?:class|interface|enum|struct|record)\s+(\w+)/] },
    { ext: /\.(php)$/, res: [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+(\w+)/, /^\s*(?:final\s+|abstract\s+)?(?:class|interface|trait)\s+(\w+)/] },
];

const isSource = (p) => !!codeSpecForPath(p) && !TEST_PATH.test(p) && !NON_SOURCE.test(p) && !GENERATED.test(p) && !/\.d\.[cm]?ts$/.test(p) && !/\.(css|scss|less|sh|bash)$/.test(p);

/** Old-side lines of a -U0 diff: [{ line, text }] for removed lines. */
function removedLines(diff) {
    const out = [];
    let line = 0;
    for (const l of diff.split('\n')) {
        const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
        if (h) { line = Number(h[1]); continue; }
        if (l.startsWith('---') || l.startsWith('+++')) continue;
        if (l.startsWith('-')) { out.push({ line, text: l.slice(1) }); line++; }
    }
    return out;
}

/** Rules 1 and 2. */
function candidates(repo, tip, want) {
    const log = git(repo, 'log', '--no-merges', '--format=%H%x1f%P%x1f%s%x1e', '-n', String(SCAN), tip);
    const res = [];
    for (const rec of log.split('\x1e')) {
        const [sha, parent, subject] = rec.trim().split('\x1f');
        if (!sha || !parent || parent.includes(' ') || !subject || SKIP_SUBJECT.test(subject)) continue;
        if (tryGit(repo, 'cat-file', '-e', parent + '^{commit}') === null) continue; // beyond the shallow boundary
        const status = tryGit(repo, 'diff', '--name-status', '--no-renames', parent, sha);
        if (!status) continue;
        const files = status.trim().split('\n').filter(Boolean).map(l => l.split('\t'));
        if (files.length > 16) continue;
        const src = files.filter(([st, p]) => st === 'M' && isSource(p)).map(x => x[1]);
        if (src.length < 2 || src.length > 8) continue;
        const users = files.filter(([st, p]) => st === 'M' && codeSpecForPath(p) && !GENERATED.test(p)).map(x => x[1]);
        const diffs = Object.fromEntries(users.map(f => [f, removedLines(git(repo, 'diff', '-U0', '--no-color', parent, sha, '--', f))]));
        const defs = new Map(); // file A → names whose definition line the commit removes or changes
        for (const a of src) {
            const family = DEFS.find(d => d.ext.test(a));
            if (!family) continue;
            const names = new Set();
            for (const { text } of diffs[a]) for (const re of family.res) { const m = re.exec(text); if (m && m[1].length >= 4 && !/^__\w+__$/.test(m[1]) && !COMMON.has(m[1])) names.add(m[1]); }
            if (names.size) defs.set(a, names);
        }
        const ripples = [];
        for (const [a, names] of defs) for (const name of names) {
            const re = new RegExp(`(?<![\\w$])${name}(?![\\w$])`);
            for (const b of users) {
                if (b === a || defs.has(b)) continue;
                const lines = diffs[b].filter(x => re.test(x.text)).map(x => x.line);
                if (lines.length) ripples.push({ name, a, b, lines, test: TEST_PATH.test(b) });
            }
        }
        if (!ripples.length) continue;
        res.push({ sha, parent, subject, A: [...defs.keys()], ripples });
        if (res.length >= want) break;
    }
    return res;
}

/**
 * The findings of a report as the reply shows them: { name, path, line|null, tier: 'problem'|'review', kind }.
 * A list the reply cuts short counts only as far as it is shown (the caps are tools.mjs's), so a
 * ripple is "found" when an agent reading the reply would see it.
 */
function findings(report) {
    const out = [];
    const last = (q) => String(q).split('.').pop();
    for (const a of report.arity ?? []) for (const s of a.sites.slice(0, 10)) out.push({ name: last(a.target), path: s.path, line: s.line, tier: 'problem', kind: 'arity' });
    for (const m of report.removed ?? []) {
        for (const u of m.uses.slice(0, 12)) out.push({ name: last(m.qname), path: u.path, line: u.line, tier: 'problem', kind: 'removed' });
        for (const i of m.imports.slice(0, 6)) out.push({ name: last(m.qname), path: i.path, line: i.line, tier: 'problem', kind: 'removed' });
    }
    for (const m of (report.maybeRemoved ?? []).slice(0, 4)) for (const u of m.uses.slice(0, 6)) out.push({ name: last(m.qname), path: u.path, line: u.line, tier: 'review', kind: 'maybe-removed' });
    for (const u of report.untouched ?? []) for (const s of u.sites.slice(0, 8)) out.push({ name: last(u.target), path: s.path, line: s.line, tier: 'review', kind: 'untouched' });
    for (const u of report.loose ?? []) for (const s of u.sites.slice(0, 4)) out.push({ name: last(u.target), path: s.path, line: s.line, tier: 'review', kind: 'loose' });
    for (const u of (report.changed ?? []).slice(0, 4)) for (const s of u.sites.slice(0, 3)) out.push({ name: last(u.target), path: s.path, line: s.line, tier: 'review', kind: 'changed' });
    for (const f of (report.family ?? []).slice(0, 8)) for (const s of f.sites.slice(0, 6)) out.push({ name: last(f.target), path: s.path, line: s.line, tier: 'review', kind: 'family' });
    for (const h of report.inherited ?? []) {
        for (const list of [h.inherit, h.extend ?? [], h.override]) for (const x of list.slice(0, 8)) for (const m of [...h.members, last(h.type)]) out.push({ name: m, path: x.path, line: null, tier: 'review', kind: 'inherited' });
    }
    return out;
}

async function run(name) {
    const repo = path.join(DIR, name);
    const tip = FIXTURES[name]?.commit && DIR.endsWith('fixtures') ? FIXTURES[name].commit : git(repo, 'rev-parse', 'HEAD').trim();
    const cands = candidates(repo, tip, N);
    const res = { repo: name, commits: cands.length, ripples: 0, found: { problem: 0, review: 0, any: 0 }, sites: 0, sitesFound: { problem: 0, any: 0 }, srcRipples: 0, srcFound: { problem: 0, any: 0 },
        noise: { problem: 0, review: 0 }, gold: { commits: 0, withProblems: 0, problems: 0 }, missed: [], goldProblems: [], chars: { partial: 0, gold: 0 }, byKind: {} };
    if (!cands.length) return res;
    const wt = path.join(WORK, name);
    tryGit(repo, 'worktree', 'remove', '--force', wt);
    fs.rmSync(wt, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    git(repo, 'worktree', 'add', '--detach', '--force', wt, cands[0].parent);
    const dbPath = path.join(WORK, `${name}.db`);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    const intel = new CodeIntel({ root: wt, dbPath });
    try {
        await intel.open();
        for (const c of cands) {
            git(wt, 'checkout', '-q', '--force', '--detach', c.parent);
            git(wt, 'clean', '-fdq');
            await intel.ix.sync();
            // the half-done edit: only the files that define the changed names
            let tick = Date.now();
            for (const a of c.A) {
                const r = spawnSync('git', ['show', `${c.sha}:${a}`], { cwd: wt, maxBuffer: 1 << 28 });
                if (r.status !== 0) continue;
                fs.writeFileSync(path.join(wt, a), r.stdout);
                tick += 2000; fs.utimesSync(path.join(wt, a), new Date(tick), new Date(tick));
            }
            const partial = await checkChanges(intel, { base: 'HEAD' });
            const fs_ = partial.error ? [] : findings(partial);
            // what the agent reads: the reply without its test section, which is the same work in both versions
            const size = async (r, base) => (fullReply ? (await tools.callTool(intel, 'check_changes', { base })).length
                : tools.formatCheck ? tools.formatCheck({ ...r, tests: [], cases: [], byName: [], commands: [] }, {}).length : 0);
            res.chars.partial += await size(partial, 'HEAD');
            const gold = new Set();
            for (const r of c.ripples) {
                res.ripples++;
                if (!r.test) res.srcRipples++;
                const about = fs_.filter(f => f.name === r.name && f.path === r.b);
                const problem = about.some(f => f.tier === 'problem');
                if (problem) res.found.problem++;
                else if (about.length) res.found.review++;
                if (about.length) res.found.any++;
                for (const k of new Set(about.map(f => f.kind))) res.byKind[k] = (res.byKind[k] ?? 0) + 1;
                if (!r.test) { if (problem) res.srcFound.problem++; if (about.length) res.srcFound.any++; }
                for (const line of r.lines) {
                    res.sites++;
                    gold.add(`${r.b}:${line}`);
                    const at = about.filter(f => f.line === line);
                    if (at.some(f => f.tier === 'problem')) res.sitesFound.problem++;
                    if (at.length) res.sitesFound.any++;
                }
                if (!about.length && res.missed.length < 400) res.missed.push({ sha: c.sha.slice(0, 10), name: r.name, a: r.a, b: r.b, line: r.lines[0], subject: c.subject.slice(0, 70) });
            }
            // findings that point at nothing the commit went on to change
            for (const f of fs_) if (!c.ripples.some(r => r.b === f.path) && !c.A.includes(f.path)) res.noise[f.tier]++;
            // the developer's own version of the change: what it reports as broken is a false alarm (or a bug left in)
            git(wt, 'checkout', '-q', '--force', '--detach', c.sha);
            await intel.ix.sync();
            const full = await checkChanges(intel, { base: c.parent });
            const probs = full.error ? [] : findings(full).filter(f => f.tier === 'problem');
            res.chars.gold += await size(full, c.parent);
            // how much of the reply each kind of finding takes, on the finished change (what is read for nothing)
            if (tools.formatCheck && !full.error) for (const k of ['arity', 'removed', 'maybeRemoved', 'loose', 'untouched', 'changed', 'family', 'inherited']) {
                const only = { ...full, syntax: [], arity: [], removed: [], maybeRemoved: [], loose: [], untouched: [], changed: [], family: [], inherited: [], tests: [], cases: [], byName: [], commands: [], [k]: full[k] ?? [] };
                const empty = { ...only, [k]: [] };
                (res.sections ??= {})[k] = (res.sections[k] ?? 0) + tools.formatCheck(only, {}).length - tools.formatCheck(empty, {}).length;
            }
            res.gold.commits++;
            if (probs.length) { res.gold.withProblems++; res.gold.problems += probs.length; if (res.goldProblems.length < 60) res.goldProblems.push({ sha: c.sha.slice(0, 10), n: probs.length, first: `${probs[0].kind} ${probs[0].name} at ${probs[0].path}:${probs[0].line}` }); }
            if (verbose) console.log(`  ${name} ${c.sha.slice(0, 10)} ripples ${c.ripples.length}: ${c.ripples.map(r => `${r.name}→${r.b}${fs_.some(f => f.name === r.name && f.path === r.b) ? ' ✓' : ' ✗'}`).join(', ')}${probs.length ? `  | gold problems ${probs.length}` : ''}`);
        }
    } finally {
        intel.close();
        tryGit(repo, 'worktree', 'remove', '--force', wt);
        fs.rmSync(wt, { recursive: true, force: true });
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    }
    return res;
}

const pct = (a, b) => (b ? `${(100 * a / b).toFixed(0)}%` : '–');
const all = [];
for (const name of REPOS) {
    const r = await run(name);
    all.push(r);
    console.log(`${name}: ${r.commits} commits, ${r.ripples} ripples (${r.srcRipples} into source files), ${r.sites} sites`);
    console.log(`  ripples found: ${r.found.any} (${pct(r.found.any, r.ripples)}) — as a problem ${r.found.problem}, to review ${r.found.review}; into source files ${r.srcFound.any} of ${r.srcRipples} (${pct(r.srcFound.any, r.srcRipples)})`);
    console.log(`  sites found: ${r.sitesFound.any} of ${r.sites} (${pct(r.sitesFound.any, r.sites)}), as a problem ${r.sitesFound.problem}`);
    console.log(`  findings elsewhere: ${r.noise.problem} problems, ${r.noise.review} to review; the developer's own change: ${r.gold.withProblems} of ${r.gold.commits} commits reported with problems (${r.gold.problems})`);
    if (r.commits && r.chars.partial) console.log(`  reply size${fullReply ? '' : ' without the tests section'}: ${Math.round(r.chars.partial / r.commits)} characters per half-done change, ${Math.round(r.chars.gold / r.commits)} per finished one; ripples found by kind of finding: ${Object.entries(r.byKind).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    if (r.sections && r.gold.commits) console.log(`  characters per finished change by kind of finding: ${Object.entries(r.sections).filter(([, n]) => n).map(([k, n]) => `${k} ${Math.round(n / r.gold.commits)}`).join(', ')}`);
    if (verbose) for (const m of r.missed.slice(0, 25)) console.log(`    missed ${m.sha} ${m.name}: ${m.a} → ${m.b}:${m.line}  (${m.subject})`);
    if (verbose) for (const g of r.goldProblems.slice(0, 10)) console.log(`    gold ${g.sha}: ${g.n} problems, first ${g.first}`);
}
const sum = (f) => all.reduce((n, r) => n + f(r), 0);
console.log(`\nall: ${sum(r => r.commits)} commits, ${sum(r => r.ripples)} ripples — found ${sum(r => r.found.any)} (${pct(sum(r => r.found.any), sum(r => r.ripples))}), as a problem ${sum(r => r.found.problem)} (${pct(sum(r => r.found.problem), sum(r => r.ripples))}); into source ${sum(r => r.srcFound.any)} of ${sum(r => r.srcRipples)} (${pct(sum(r => r.srcFound.any), sum(r => r.srcRipples))})`);
console.log(`     sites ${sum(r => r.sitesFound.any)} of ${sum(r => r.sites)} (${pct(sum(r => r.sitesFound.any), sum(r => r.sites))}); findings elsewhere ${sum(r => r.noise.problem)} problems, ${sum(r => r.noise.review)} to review; developer's change reported with problems in ${sum(r => r.gold.withProblems)} of ${sum(r => r.gold.commits)} commits`);
const out = opt('--json', null);
if (out) fs.writeFileSync(out, JSON.stringify(all, null, 1));
