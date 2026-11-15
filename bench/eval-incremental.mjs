#!/usr/bin/env node
/**
 * Is an index that was updated the same as one built from scratch?
 *
 * Every reference oracle (eval-graph*.mjs) scores a freshly built index. An agent never works on
 * one: it edits, the index re-syncs the changed files, and the next answer comes from an index
 * that has been updated dozens of times. This benchmark replays real history through that path
 * and compares each state, fact by fact, with a fresh index of the same tree.
 *
 * For the last N commits of a fixture (first-parent chain ending at the pinned commit) a scratch
 * worktree is moved commit by commit:
 *
 *   commit   one `sync()` per commit (what a branch switch or a pull does)
 *   file     the commit's files are written one at a time with `syncPaths()` in between, in the
 *            order given by --order (what an agent's edits do; `reverse` and `forward` exercise
 *            "the caller is written before the definition" both ways)
 *
 * After each commit the updated index is compared with a fresh one: symbols, imports, inferred
 * field types and every reference (where it is, what it binds to, with what confidence).
 *
 *   node bench/fixtures.mjs --history 400
 *   node bench/eval-incremental.mjs [--fixtures gin,fastapi,express-js,axios,nestjs] [--n 40]
 *        [--mode commit|file] [--order forward|reverse] [--verbose] [--json out.json]
 *
 * The result to want is zero divergent facts. Anything else is an answer that depends on the
 * order in which the files were edited.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/db.mjs';
import { Indexer } from '../src/index/indexer.mjs';
import { FIXTURES } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FX = opt('--fixtures', 'gin,fastapi,express-js,axios,nestjs').split(',');
const N = Number(opt('--n', 40));
const MODE = opt('--mode', 'commit');
const ORDER = opt('--order', 'forward');
const FIXDIR = path.resolve(opt('--fixture-dir', path.join(here, '../test/fixtures')));
const WORK = path.resolve(opt('--work-dir', path.join(os.tmpdir(), 'gi-incremental')));
const verbose = args.includes('--verbose');
const MAX_EXAMPLES = Number(opt('--examples', 12));

function git(cwd, ...a) {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${(r.stderr || '').trim()}`);
    return r.stdout;
}
const tryGit = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return null; } };

/** Every fact of an index, keyed so that two indexes of one tree can be compared (ids differ). */
export function dump(store) {
    const symKey = new Map();
    const symbols = new Map();
    for (const s of store.all(`SELECT s.id, f.path, s.qname, s.kind, s.ordinal, s.start_line, s.end_line, s.name_line, s.sig, s.type, s.bases, s.decorators, s.owner, s.exported, s.is_static, s.parent_id
        FROM symbols s JOIN files f ON f.id = s.file_id`)) {
        const key = `${s.path}:${s.start_line}:${s.qname}:${s.kind}:${s.ordinal}`;
        symKey.set(s.id, key);
        symbols.set(key, s);
    }
    for (const s of symbols.values()) s.parent = s.parent_id != null ? symKey.get(s.parent_id) ?? '?' : null;
    const symFacts = new Map();
    for (const [key, s] of symbols) symFacts.set(key, JSON.stringify([s.end_line, s.name_line, s.sig, s.type, s.bases, s.decorators, s.owner, s.exported, s.is_static, s.parent]));
    const refs = new Map();
    for (const r of store.all(`SELECT r.kind, r.name, r.line, r.col, r.recv, r.recv_type, r.dst_id, r.src_id, r.conf, r.ncand, f.path FROM refs r JOIN files f ON f.id = r.file_id`)) {
        // Go's implicit implementations are edges of their own on the type's declaration line
        const key = `${r.path}:${r.line}:${r.col}:${r.kind}:${r.name}${r.recv_type === '~structural' ? ':~' + (symKey.get(r.dst_id) ?? '') : ''}`;
        refs.set(key, { dst: r.dst_id != null ? symKey.get(r.dst_id) ?? `?${r.dst_id}` : null, src: r.src_id != null ? symKey.get(r.src_id) ?? `?${r.src_id}` : null, conf: Math.round(r.conf * 1000) / 1000, ncand: r.ncand, recvType: r.recv_type ?? null });
    }
    const imports = new Map();
    for (const i of store.all(`SELECT f.path, i.source, i.imported, i.local, i.reexport, i.wildcard, i.line, i.target_dir, i.target_path, t.path AS target FROM imports i JOIN files f ON f.id = i.file_id LEFT JOIN files t ON t.id = i.target_file_id`)) {
        imports.set(`${i.path}:${i.line}:${i.source}:${i.imported}:${i.local}:${i.reexport}:${i.wildcard}`, JSON.stringify([i.target ?? null, i.target_dir ?? null, i.target_path ?? null]));
    }
    const fields = new Map();
    for (const f of store.all('SELECT fl.path, f.owner_qname, f.name, f.type FROM fields f JOIN files fl ON fl.id = f.file_id')) fields.set(`${f.path}:${f.owner_qname}:${f.name}`, f.type);
    const files = new Map(store.all('SELECT path, lang, hash, package, is_test, parse_errors FROM files').map(f => [f.path, JSON.stringify([f.lang, f.hash, f.package, f.is_test, f.parse_errors])]));
    return { files, symbols: symFacts, refs, imports, fields };
}

/** Differences between an updated index (a) and a fresh one (b). */
export function compare(a, b) {
    const out = { files: [], symbols: [], imports: [], fields: [], refs: { missing: [], extra: [], rebound: [], unboundStale: [], boundStale: [], conf: [] }, totals: { refs: b.refs.size, bound: 0 } };
    for (const table of ['files', 'symbols', 'imports', 'fields']) {
        for (const [k, v] of b[table]) { const w = a[table].get(k); if (w === undefined) out[table].push({ key: k, how: 'missing' }); else if (w !== v) out[table].push({ key: k, how: 'differs', fresh: v, updated: w }); }
        for (const k of a[table].keys()) if (!b[table].has(k)) out[table].push({ key: k, how: 'extra' });
    }
    for (const [k, fresh] of b.refs) {
        if (fresh.dst != null) out.totals.bound++;
        const upd = a.refs.get(k);
        if (!upd) { out.refs.missing.push({ key: k, fresh: fresh.dst }); continue; }
        if (upd.dst !== fresh.dst) {
            const row = { key: k, fresh: fresh.dst, updated: upd.dst };
            if (fresh.dst == null) out.refs.boundStale.push(row);       // bound to something a fresh index leaves unbound
            else if (upd.dst == null) out.refs.unboundStale.push(row);  // left unbound where a fresh index binds it
            else out.refs.rebound.push(row);                            // bound to another definition
        } else if (upd.conf !== fresh.conf || upd.ncand !== fresh.ncand) out.refs.conf.push({ key: k, fresh: `${fresh.conf}/${fresh.ncand}`, updated: `${upd.conf}/${upd.ncand}` });
    }
    for (const [k, upd] of a.refs) if (!b.refs.has(k)) out.refs.extra.push({ key: k, updated: upd.dst });
    return out;
}

export function divergent(d) {
    return d.files.length + d.symbols.length + d.imports.length + d.fields.length + Object.values(d.refs).reduce((n, l) => n + l.length, 0);
}

async function freshDump(root, dbPath) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    const store = new Store(dbPath);
    const ix = new Indexer({ root, store });
    await ix.sync();
    const d = dump(store);
    store.close();
    return d;
}

/** Give a file written "now" a modification time the index has not seen (coarse clocks). */
let tick = Date.now();
function touch(abs) { tick += 2000; const t = new Date(tick); try { fs.utimesSync(abs, t, t); } catch { /* removed */ } }

async function run(fixture) {
    const repo = path.join(FIXDIR, fixture);
    const pinned = FIXTURES[fixture]?.commit ?? git(repo, 'rev-parse', 'HEAD').trim();
    const chain = git(repo, 'rev-list', '--first-parent', '-n', String(N + 1), pinned).trim().split('\n').reverse()
        .filter(sha => tryGit(repo, 'cat-file', '-e', sha + '^{tree}') !== null);
    if (chain.length < 2) { console.log(`${fixture}: no history (run bench/fixtures.mjs --history ${N})`); return null; }
    const wt = path.join(WORK, fixture);
    tryGit(repo, 'worktree', 'remove', '--force', wt);
    fs.rmSync(wt, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    git(repo, 'worktree', 'add', '--detach', '--force', wt, chain[0]);
    const dbA = path.join(WORK, `${fixture}.updated.db`), dbB = path.join(WORK, `${fixture}.fresh.db`);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbA + suffix, { force: true });
    const res = { fixture, mode: MODE, order: ORDER, commits: 0, divergentCommits: 0, refs: 0, bound: 0, facts: { files: 0, symbols: 0, imports: 0, fields: 0, missing: 0, extra: 0, rebound: 0, unboundStale: 0, boundStale: 0, conf: 0 }, worst: [], examples: [], updateMs: 0, freshMs: 0, updates: 0, dependents: 0, maxDependents: 0, slowestMs: 0 };
    try {
        const store = new Store(dbA);
        let ix = new Indexer({ root: wt, store });
        await ix.sync();
        // how far one update reaches: the files resolved again because they read what it changed
        const note = (ix, ms) => { const f = ix.lastFanout; if (!f) return; ix.lastFanout = null; res.updates++; res.dependents += f.dependents; res.maxDependents = Math.max(res.maxDependents, f.dependents); res.slowestMs = Math.max(res.slowestMs, ms); };
        for (let i = 1; i < chain.length; i++) {
            const sha = chain[i];
            const t0 = Date.now();
            if (MODE === 'file') {
                const status = git(wt, 'diff', '--name-status', '--no-renames', 'HEAD', sha).trim().split('\n').filter(Boolean).map(l => l.split('\t'));
                if (ORDER === 'reverse') status.reverse();
                // removals first, as a rename does them: where file names differ only in case and the
                // file system does not tell them apart, deleting `readme.md` after writing `README.md`
                // would delete the file just written
                status.sort((a, b) => (b[0] === 'D') - (a[0] === 'D'));
                for (const [st, p] of status) {
                    const abs = path.join(wt, p);
                    if (st === 'D') fs.rmSync(abs, { force: true });
                    else {
                        fs.mkdirSync(path.dirname(abs), { recursive: true });
                        const r = spawnSync('git', ['show', `${sha}:${p}`], { cwd: wt, maxBuffer: 1 << 28 });
                        if (r.status !== 0) continue; // a submodule or a path git cannot show
                        fs.writeFileSync(abs, r.stdout);
                        touch(abs);
                    }
                    const t = Date.now();
                    await ix.syncPaths([p]);
                    note(ix, Date.now() - t);
                }
                // move HEAD and the git index without touching the files just written
                git(wt, 'reset', '-q', '--soft', sha);
                git(wt, 'reset', '-q', '--', '.');
            } else {
                git(wt, 'checkout', '-q', '--detach', sha);
                const t = Date.now();
                await ix.sync();
                note(ix, Date.now() - t);
            }
            res.updateMs += Date.now() - t0;
            const t1 = Date.now();
            const fresh = await freshDump(wt, dbB);
            res.freshMs += Date.now() - t1;
            const d = compare(dump(store), fresh);
            const n = divergent(d);
            res.commits++;
            res.refs += d.totals.refs;
            res.bound += d.totals.bound;
            if (n) {
                res.divergentCommits++;
                res.worst.push({ sha: sha.slice(0, 10), facts: n });
                for (const t of ['files', 'symbols', 'imports', 'fields']) res.facts[t] += d[t].length;
                for (const [k, l] of Object.entries(d.refs)) {
                    res.facts[k] += l.length;
                    for (const row of l.slice(0, 3)) if (res.examples.length < MAX_EXAMPLES * 6) res.examples.push({ sha: sha.slice(0, 10), kind: k, ...row });
                }
                for (const t of ['symbols', 'imports', 'fields']) for (const row of d[t].slice(0, 2)) if (res.examples.length < MAX_EXAMPLES * 6) res.examples.push({ sha: sha.slice(0, 10), kind: t, ...row });
                // a divergence carried forward would be counted again at every later commit: start over
                store.reset();
                ix = new Indexer({ root: wt, store });
                await ix.sync();
            }
            if (verbose) console.log(`  ${fixture} ${sha.slice(0, 10)} ${n ? `DIVERGES: ${n} facts` : 'same'}`);
        }
        store.close();
    } finally {
        tryGit(repo, 'worktree', 'remove', '--force', wt);
        fs.rmSync(wt, { recursive: true, force: true });
        for (const db of [dbA, dbB]) for (const suffix of ['', '-wal', '-shm']) fs.rmSync(db + suffix, { force: true });
    }
    res.worst.sort((a, b) => b.facts - a.facts);
    return res;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const all = [];
    for (const fx of FX) {
        const r = await run(fx);
        if (!r) continue;
        all.push(r);
        const f = r.facts;
        const refFacts = f.missing + f.extra + f.rebound + f.unboundStale + f.boundStale;
        console.log(`${fx} (${MODE}${MODE === 'file' ? ', ' + ORDER : ''}): ${r.commits} commits, ${r.divergentCommits} leave the updated index different from a fresh one`);
        console.log(`  references: ${refFacts} of ${r.refs} differ — bound to another definition ${f.rebound}, bound where fresh is unbound ${f.boundStale}, unbound where fresh is bound ${f.unboundStale}, missing ${f.missing}, extra ${f.extra}; confidence only ${f.conf}`);
        console.log(`  symbols ${f.symbols}, imports ${f.imports}, field types ${f.fields}, files ${f.files}; update ${(r.updateMs / r.commits).toFixed(0)} ms per commit against ${(r.freshMs / r.commits).toFixed(0)} ms fresh`);
        if (r.updates) console.log(`  ${r.updates} updates: ${(r.dependents / r.updates).toFixed(1)} other files resolved again on average, ${r.maxDependents} at most; slowest update ${r.slowestMs} ms`);
        const shown = new Map();
        for (const e of r.examples) { const n = shown.get(e.kind) ?? 0; if (n >= (verbose ? MAX_EXAMPLES : 2)) continue; shown.set(e.kind, n + 1); console.log(`    [${e.kind}] ${e.sha} ${e.key}${e.how ? ' ' + e.how : ''}${e.fresh !== undefined ? `\n        fresh:   ${e.fresh}` : ''}${e.updated !== undefined ? `\n        updated: ${e.updated}` : ''}`); }
    }
    const out = opt('--json', null);
    if (out) fs.writeFileSync(out, JSON.stringify(all, null, 1));
    const bad = all.reduce((n, r) => n + r.divergentCommits, 0);
    console.log(`\n${all.reduce((n, r) => n + r.commits, 0)} commits replayed, ${bad} with a divergent index`);
    process.exitCode = bad ? 1 : 0;
}
