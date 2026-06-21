/**
 * @file git-signals.mjs
 * @description Lightweight, air-gapped git-history signals for ranking and
 *              blast-radius hints. Reads ONLY the local repository's commit log
 *              (no network, no remote, no code sent anywhere) and derives three
 *              cheap per-file signals competitors mostly ignore:
 *
 *                • churn      — how often a file changes (commit count);
 *                • recency    — how recently it last changed (last-commit time);
 *                • co-change  — which files historically change *together* (the
 *                               "if you touch A you usually touch B" hint that
 *                               sharpens the refactoring/blast-radius story).
 *
 *              Computed once at index time into a sidecar (code-index.git.json),
 *              kept out of the storage contract and the ranking math: the
 *              co-change hint is surfaced by the blast-radius tools, and the
 *              recency/churn boost is applied opt-in in the tool layer (default
 *              off), so the measured retrieval ranking is unchanged by default.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Record/field separators chosen to never collide with file paths.
const REC = '\x01';
const FS_ = '\x1f';

/**
 * Collect git signals for a repository from its local commit log.
 *
 * Strictly local: shells out to `git log` on `repoRoot` and parses stdout. No
 * remote is contacted. Returns `null` (a no-op) when the directory is not a git
 * repo, git is unavailable, or there is no history — callers degrade silently.
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {number} [opts.maxCommits=500]       History depth (bounds cost + size).
 * @param {number} [opts.topCoChange=8]        Co-changed files kept per file.
 * @param {number} [opts.maxFilesPerCommit=50] Skip sweeping commits (mass renames,
 *                                              formatting) whose co-change is noise.
 * @returns {null | {generated:number, commits:number, maxChurn:number,
 *                    churn:Object<string,number>, lastCommit:Object<string,number>,
 *                    coChange:Object<string,Array<[string,number]>>}}
 */
export function collectGitSignals(repoRoot, { maxCommits = 500, topCoChange = 8, maxFilesPerCommit = 50 } = {}) {
    // Resolve the actual repo root. If `repoRoot` is a SUBDIRECTORY of a larger
    // repo (e.g. indexing one package, or a fixture nested in this repo), a bare
    // `git -C <dir> log` walks UP and returns the PARENT repo's history with
    // parent-root-relative paths that never match this index's file paths. So we
    // find the toplevel, scope the log to this subtree, and strip the prefix so
    // emitted paths are relative to `repoRoot` (matching chunk.file_path).
    let prefix = '';
    try {
        const toplevel = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--show-toplevel'],
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (!toplevel) return null;
        // Compare REAL paths: git returns the physical toplevel, while repoRoot may
        // contain symlinks (e.g. macOS /var → /private/var), which would otherwise
        // produce a bogus prefix.
        const realTop = (() => { try { return fs.realpathSync(toplevel); } catch { return toplevel; } })();
        const realRoot = (() => { try { return fs.realpathSync(path.resolve(repoRoot)); } catch { return path.resolve(repoRoot); } })();
        const rel = path.relative(realTop, realRoot).replace(/\\/g, '/');
        prefix = rel && rel !== '.' ? rel : '';
    } catch {
        return null; // not a git repo / git missing — air-gapped no-op
    }

    let raw;
    try {
        const args = ['-C', repoRoot, 'log', '--no-merges', `-n${maxCommits}`,
            `--pretty=format:${REC}%H${FS_}%ct`, '--name-only'];
        if (prefix) args.push('--', '.'); // limit to this subtree (paths stay toplevel-relative)
        raw = execFileSync('git', args,
            { encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return null;
    }
    if (!raw || !raw.includes(REC)) return null;
    const stripPrefix = prefix ? prefix + '/' : '';

    const churn = Object.create(null);
    const lastCommit = Object.create(null);
    const pairCounts = new Map(); // file → Map<coFile, count>
    let commits = 0;

    const bump = (f, ts) => {
        churn[f] = (churn[f] || 0) + 1;
        if (ts > (lastCommit[f] || 0)) lastCommit[f] = ts;
    };

    for (const block of raw.split(REC)) {
        if (!block) continue;
        const nl = block.indexOf('\n');
        const header = nl === -1 ? block : block.slice(0, nl);
        const ts = parseInt(header.split(FS_)[1], 10);
        if (!Number.isFinite(ts)) continue;
        commits++;

        const files = [];
        if (nl !== -1) {
            for (const line of block.slice(nl + 1).split('\n')) {
                let f = line.trim();
                if (!f) continue;
                // git quotes paths with unusual chars: "src/é.ts" — unwrap.
                if (f.startsWith('"') && f.endsWith('"')) f = f.slice(1, -1);
                if (stripPrefix) {
                    if (!f.startsWith(stripPrefix)) continue; // outside the indexed subtree
                    f = f.slice(stripPrefix.length);
                }
                files.push(f);
            }
        }
        for (const f of files) bump(f, ts);

        // Co-change: only for focused commits — a 400-file sweep links nothing useful.
        if (files.length >= 2 && files.length <= maxFilesPerCommit) {
            for (let i = 0; i < files.length; i++) {
                const a = files[i];
                let row = pairCounts.get(a);
                if (!row) { row = new Map(); pairCounts.set(a, row); }
                for (let j = 0; j < files.length; j++) {
                    if (i === j) continue;
                    const b = files[j];
                    row.set(b, (row.get(b) || 0) + 1);
                }
            }
        }
    }

    if (commits === 0) return null;

    // Stamp HEAD so clients can report "indexed at commit X" and detect drift
    // (the freshness contract). Best-effort — absence just omits the commit.
    let head = null;
    try {
        head = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'],
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch { /* detached/empty — no stamp */ }

    const coChange = Object.create(null);
    for (const [file, row] of pairCounts) {
        const top = [...row.entries()]
            .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
            .slice(0, topCoChange);
        if (top.length) coChange[file] = top;
    }

    let maxChurn = 1;
    for (const k in churn) if (churn[k] > maxChurn) maxChurn = churn[k];

    return { generated: Math.floor(Date.now() / 1000), head, commits, maxChurn, churn, lastCommit, coChange };
}

/** Persist signals next to the index (best-effort). */
export function writeGitSignals(filePath, signals) {
    try { fs.writeFileSync(filePath, JSON.stringify(signals)); return true; }
    catch { return false; }
}

/** Load a signals sidecar, or null if absent/corrupt. */
export function loadGitSignals(filePath) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
    catch { return null; }
}

/** Files that historically change together with `file`, strongest first. */
export function coChangesFor(signals, file, limit = 5) {
    if (!signals || !signals.coChange) return [];
    const row = signals.coChange[file];
    if (!row) return [];
    return row.slice(0, limit).map(([f, count]) => ({ file: f, count }));
}

// ─── Index freshness (query-time drift detection) ────────────────────────────
// The blast-radius tools are only trustworthy if the index reflects the working
// tree. We surface a compact freshness signal on tool responses: index age, the
// commit it was built at (stamped above), and whether the tree has drifted since.
// The git read is cheap and cached briefly so a burst of tool calls costs one
// `git status`; it degrades silently (null) outside a git repo.

const _SRC_RE = /\.(js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|kt|cs|rb|php|swift|c|h|cc|cpp|hpp|scss|css|sh|bash)$/i;
let _gitStateCache = null; // { at, root, head, dirtyCount }

/** Reset the cached working-tree state (tests). */
export function _resetGitStateCache() { _gitStateCache = null; }

/**
 * Cheap, cached working-tree state: current short HEAD + count of changed SOURCE
 * files (uncommitted). Cached `ttlMs` per root so a burst of tool calls shells out
 * at most once. `exec`/`nowMs` injectable for tests. Returns {head:null,dirtyCount:null}
 * outside a git repo.
 */
export function currentGitState(repoRoot, { ttlMs = 5000, nowMs = Date.now(), exec = execFileSync } = {}) {
    if (_gitStateCache && _gitStateCache.root === repoRoot && (nowMs - _gitStateCache.at) < ttlMs) return _gitStateCache;
    let head = null, dirtyCount = null;
    try {
        head = exec('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'],
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
        const status = exec('git', ['-C', repoRoot, 'status', '--porcelain'],
            { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
        dirtyCount = status.split('\n').filter(l => l.trim() && _SRC_RE.test(l)).length;
    } catch { /* not a git repo / git missing → unknown */ }
    _gitStateCache = { at: nowMs, root: repoRoot, head, dirtyCount };
    return _gitStateCache;
}

/**
 * Derive the freshness verdict from index age + the stamped index commit + the
 * current working-tree state + whether the watch daemon is live. Pure (no I/O) so
 * it is trivially testable.
 *
 * @returns {{ageSeconds:number|null, ageLabel:string, indexedCommit:string|null,
 *            currentCommit:string|null, pendingChanges:number|null, commitMoved:boolean,
 *            daemonRunning:boolean, stale:boolean, syncing:boolean}}
 */
export function computeFreshness({ ageSeconds = null, indexedCommit = null, current = null, daemonRunning = false } = {}) {
    const ageLabel = ageSeconds == null ? 'unknown'
        : ageSeconds < 60 ? `${ageSeconds}s` : ageSeconds < 3600 ? `${Math.floor(ageSeconds / 60)}m` : `${Math.floor(ageSeconds / 3600)}h`;
    const currentCommit = current?.head ?? null;
    const pendingChanges = current?.dirtyCount ?? null;
    const commitMoved = Boolean(indexedCommit && currentCommit && indexedCommit !== currentCommit);
    const hasPending = (pendingChanges != null && pendingChanges > 0) || commitMoved;
    // A live daemon syncs changes incrementally, so pending work is "syncing", not
    // "stale". Only when no daemon is keeping the index fresh is drift truly stale.
    return {
        ageSeconds, ageLabel, indexedCommit, currentCommit, pendingChanges, commitMoved,
        daemonRunning, stale: hasPending && !daemonRunning, syncing: hasPending && daemonRunning,
    };
}

/**
 * A bounded 0..1 "this file is hot" score combining recency and churn, for the
 * OPT-IN ranking boost only. Returns 0 when there is no signal for the file, so a
 * disabled or signal-less repo never perturbs ranking.
 */
export function gitBoostScore(signals, file, nowSec = Date.now() / 1000) {
    if (!signals) return 0;
    const churn = (signals.churn && signals.churn[file]) || 0;
    const last = (signals.lastCommit && signals.lastCommit[file]) || 0;
    if (!churn && !last) return 0;
    const ageDays = last ? Math.max(0, (nowSec - last) / 86400) : 3650;
    const recency = Math.exp(-ageDays / 90);                                   // ~quarter half-life
    const churnScore = Math.log1p(churn) / Math.log1p(signals.maxChurn || 1);  // 0..1
    return 0.5 * recency + 0.5 * churnScore;
}
