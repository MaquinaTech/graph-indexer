/**
 * File discovery. Inside a git work tree we ask git (tracked + untracked-but-not-ignored),
 * which honours every .gitignore/.git/info/exclude rule exactly; elsewhere we walk the tree
 * with a small .gitignore matcher. On top of that we skip what an agent never wants in its
 * index: dependencies, build output, vendored bundles, minified and generated files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gitSync } from '../util/git.mjs';
import { readRepoFile, withinRoot } from '../util/paths.mjs';
import { specForPath, codeSpecForPath } from '../parse/languages.mjs';

export const MAX_FILE_BYTES = 1_500_000;

// Always a dependency, a tool's cache or a bundle, whatever git says about it.
const SKIP_DIRS = new Set([
    'node_modules', 'bower_components', 'jspm_packages', '.git', '.hg', '.svn', '.graph-indexer',
    'dist', '.next', '.nuxt', '.svelte-kit', '.output', '.turbo', '.cache', '.parcel-cache',
    '.nyc_output', '__pycache__', '.venv', '.env', '.tox', '.mypy_cache', '.pytest_cache',
    'site-packages', '.gradle', '.idea', '.vscode', 'Pods', 'DerivedData', 'vendor', 'third_party', 'thirdparty',
    'packages-cache', '.yarn', '.pnpm-store', 'elm-stuff', '.terraform',
]);
// Build output or an environment in one project, source in another: `bin/` holds a CLI's entry
// points, `build/` the build scripts, `external/` the adapters to other services, `coverage/` is
// coverage.py's own package, `target` and `env` are words of a domain. What a build writes there
// is ignored or untracked; what is committed there is the project's own. So these are skipped
// unless git tracks source files under them (`ownDirectories`), and without git as before.
const OUTPUT_DIRS = new Set(['build', 'out', 'target', 'coverage', 'venv', 'env', 'external', 'deps', '_deps', 'obj', 'bin']);
// …except a copy of another project kept in one of them (`deps/hiredis/`, `external/googletest/`),
// which carries that project's licence
const LICENCE_FILE = /^(licen[sc]e|copying|notice|unlicense)(\.[\w-]+)?$/i;

const GENERATED_FILE = /(\.min\.(js|css|mjs)$|\.bundle\.js$|[.-]bundle\.[cm]?js$|\.chunk\.js$|\.map$|\.pb\.go$|_pb2(_grpc)?\.py$|\.pb\.(cc|h)$|\.generated\.\w+$|\.g\.dart$|\.designer\.cs$|(^|\/)generated\/|\.d\.ts\.map$)/i;

function isGitRepo(root) {
    const r = gitSync(root, ['rev-parse', '--is-inside-work-tree']);
    return r.status === 0 && r.stdout.trim() === 'true';
}

/** What git lists: the files it tracks and, apart, the untracked ones it does not ignore. Null outside a work tree. */
export function gitListFiles(root) {
    const list = (args, config = []) => {
        const r = gitSync(root, [...config, 'ls-files', '-z', ...args], { maxBuffer: 1 << 30 });
        return r.status === 0 ? r.stdout.split('\0').filter(Boolean).map(p => p.replace(/\\/g, '/')) : null;
    };
    const tracked = list(['--cached']);
    // untracked files are asked for without folding case: see diskNames()
    const others = tracked && list(['--others', '--exclude-standard'], ['-c', 'core.ignorecase=false']);
    if (!others) return null;
    return foldsCase(root, others) ? diskNames(root, tracked, others) : { tracked, others };
}

const swapCase = (s) => s.replace(/[a-z]/gi, c => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

/** Does the file system here answer for a name written in another case? Asked of one of the files listed. */
function foldsCase(root, rels) {
    const rel = rels.find(r => /[a-z]/i.test(r));
    if (!rel) return false;
    try {
        const a = fs.lstatSync(path.join(root, rel)), b = fs.lstatSync(path.join(root, swapCase(rel)));
        return a.ino === b.ino && a.dev === b.dev;
    } catch { return false; }
}

/**
 * Where the file system does not tell `README.md` from `readme.md`, git answers for both with the
 * name its index holds, and after a rename that changed only the case that is the old one until
 * someone says `git mv`. A file's name is the one on disk: it is what a path handed over one by one
 * is held to (`diskName`), and it does not change when git's index catches up. Asked not to fold
 * case, git lists the name on disk as an untracked file: that is the tracked file, under its
 * present name. The same listing shows what the repository ignores through a rule written in
 * another case (`/Build` for `build/`); it stays ignored.
 */
function diskNames(root, tracked, others) {
    const byLower = new Map(others.map(o => [o.toLowerCase(), o]));
    const renamed = new Set();
    const names = tracked.map(t => {
        const o = byLower.get(t.toLowerCase());
        if (o === undefined) return t;
        renamed.add(o);
        return o;
    });
    let rest = renamed.size ? others.filter(o => !renamed.has(o)) : others;
    const ignored = ignoredAmong(root, rest, true) ?? new Set();
    if (ignored.size) rest = rest.filter(o => !ignored.has(o));
    return { tracked: names, others: rest };
}

/**
 * The directories with an output-like name that are the project's own, and the copies of other
 * projects inside them. `own` holds every path prefix ending at such a name under which git tracks
 * a source file; `vendored` the directories there (the prefix itself or one directly under it) that
 * carry a licence file of their own.
 * @param {string[]} tracked repo-relative paths git tracks
 * @param {Set<string>} [names] the directory names in question
 */
export function ownDirectories(tracked, names = OUTPUT_DIRS) {
    const own = new Set(), vendored = new Set();
    for (const rel of tracked) {
        const parts = rel.split('/');
        const last = parts.length - 1;
        let source = null, licence = null; // decided on the first directory that needs them
        for (let i = 0; i < last; i++) {
            if (!names.has(parts[i])) continue;
            licence ??= LICENCE_FILE.test(parts[last]);
            if (licence) { if (last - 1 - i <= 1) vendored.add(parts.slice(0, last).join('/')); continue; }
            source ??= !!codeSpecForPath(rel); // code: a README committed next to build output makes nothing source
            if (source) own.add(parts.slice(0, i + 1).join('/'));
        }
    }
    return { own, vendored };
}

/** Is `rel` under a directory that keeps it out: a dependency or cache, or an output-like one that is not the project's own? */
export function underSkippedDir(rel, layout = null, skip = SKIP_DIRS, output = OUTPUT_DIRS) {
    let prefix = '';
    for (let i = 0, j; (j = rel.indexOf('/', i)) >= 0; i = j + 1) {
        const name = rel.slice(i, j);
        prefix = rel.slice(0, j);
        if (skip.has(name)) return true;
        if (output.has(name) && !layout?.own.has(prefix)) return true;
        if (layout?.vendored.size && layout.vendored.has(prefix)) return true;
    }
    return false;
}

/**
 * A .gitignore pattern as a matcher that cannot backtrack: `*` (within a name), `?`, `**` (across
 * names), anything else literal. A regular expression of many stars (`*a*a*a*a*a*b`) takes seconds
 * per long path; this keeps the set of positions reachable after each token, so a match costs
 * pattern length × path length. Unanchored, it may start at any name; it must end at the end of
 * the path or at a `/` (a directory and everything under it).
 */
function globMatcher(glob, anchored) {
    const tokens = [];
    for (let i = 0; i < glob.length; i++) {
        if (glob[i] === '*') {
            let j = i; while (glob[j + 1] === '*') j++;
            tokens.push(j > i ? '**' : '*'); i = j;
        } else tokens.push(glob[i] === '?' ? '?' : { c: glob[i] });
    }
    return (s) => {
        const n = s.length;
        let cur = new Uint8Array(n + 1);
        cur[0] = 1;
        if (!anchored) for (let k = 0; k < n; k++) if (s[k] === '/') cur[k + 1] = 1;
        for (const t of tokens) {
            const next = new Uint8Array(n + 1);
            let any = false;
            if (t === '**') { let on = 0; for (let p = 0; p <= n; p++) { on |= cur[p]; next[p] = on; any ||= !!on; } }
            else if (t === '*') { let on = 0; for (let p = 0; p <= n; p++) { on |= cur[p]; next[p] = on; any ||= !!on; if (s[p] === '/') on = 0; } }
            else if (t === '?') { for (let p = 0; p < n; p++) if (cur[p] && s[p] !== '/') { next[p + 1] = 1; any = true; } }
            else { for (let p = 0; p < n; p++) if (cur[p] && s[p] === t.c) { next[p + 1] = 1; any = true; } }
            if (!any) return false;
            cur = next;
        }
        for (let p = 0; p <= n; p++) if (cur[p] && (p === n || s[p] === '/')) return true;
        return false;
    };
}

/** Minimal .gitignore → predicate (used only outside git repos). */
function loadGitignore(root) {
    const rules = [];
    for (let line of (readRepoFile(root, '.gitignore') ?? '').split(/\r?\n/)) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        const neg = line.startsWith('!');
        if (neg) line = line.slice(1);
        if (line.endsWith('/')) line = line.slice(0, -1);
        const anchored = line.startsWith('/') || line.includes('/');
        rules.push({ neg, test: globMatcher(line.replace(/^\//, ''), anchored) });
    }
    return (rel) => {
        let ignored = false;
        for (const r of rules) if (r.test(rel)) ignored = !r.neg;
        return ignored;
    };
}

function walk(root, ignored) {
    const out = [];
    const stack = [''];
    while (stack.length) {
        const rel = stack.pop();
        let entries;
        try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name) || OUTPUT_DIRS.has(e.name) || e.name.startsWith('.') || ignored(r)) continue;
                stack.push(r);
            } else if (e.isFile() && !ignored(r)) out.push(r);
        }
    }
    return out;
}

/**
 * @param {string} rel
 * @param {{ include?: string[] | null, layout?: { own: Set<string>, vendored: Set<string> } | null }} [opts]
 *   `layout` is what `discoverFiles` found git to track under output-like directories; without it
 *   (no git, or before the first discovery) those directories are skipped by name.
 */
export function isIndexablePath(rel, { include = null, layout = null } = {}) {
    if (!specForPath(rel)) return false;
    if (include && include.some(p => rel.startsWith(p))) return !GENERATED_FILE.test(rel);
    if (underSkippedDir(rel, layout)) return false;
    return !GENERATED_FILE.test(rel);
}

/**
 * List indexable files (repo-relative, forward slashes), sorted for determinism.
 * @returns {{ files: string[], viaGit: boolean, layout: { own: Set<string>, vendored: Set<string> } | null }}
 *   `layout` (git only) goes back into `isIndexablePath` for paths checked one by one later.
 */
export function discoverFiles(root, opts = {}) {
    let rels = null, viaGit = false, layout = null;
    if (!opts.noGit && isGitRepo(root)) {
        const listed = gitListFiles(root);
        if (listed) {
            viaGit = true;
            layout = ownDirectories(listed.tracked);
            rels = listed.tracked.concat(listed.others);
        }
    }
    if (!rels) rels = walk(root, loadGitignore(root)).map(r => r.replace(/\\/g, '/'));
    const files = rels.filter(r => isIndexablePath(r, { ...opts, layout }) && insideRoot(root, r));
    files.sort();
    return { files, viaGit, layout };
}

/**
 * A tracked file must resolve inside the repository: every component of its path is resolved, so
 * neither a link to /etc/… or ~/.ssh/… nor a file under a linked directory (`link/secret.ts` with
 * `link` → elsewhere, which git lists from its index without looking) is read, indexed or served.
 */
export function insideRoot(root, rel) {
    try { fs.lstatSync(path.join(root, rel)); } catch { return true; } // vanished: the caller handles deletion
    return withinRoot(root, rel);
}

/** Heuristic: minified / generated content that slipped past the name filters. */
export function looksMinified(source) {
    if (source.length < 2000) return false;
    const lines = source.split('\n', 50);
    const long = lines.filter(l => l.length > 500).length;
    return long >= 3 || source.length / Math.max(1, source.split('\n').length) > 300;
}

/**
 * Which of these paths the repository ignores (`.gitignore` and the rest of git's exclude rules, or
 * the root `.gitignore` outside git). A full discovery never lists them; a path handed over one by
 * one — by the file watcher, which sees what a code generator or a build writes — has to be asked.
 */
export function ignoredAmong(root, rels, viaGit) {
    if (!rels.length) return new Set();
    if (viaGit) {
        // 0: some are ignored, 1: none is; anything else is an error (a path in a submodule or beyond a link), and null says git could not tell
        const r = gitSync(root, ['check-ignore', '-z', '--stdin'], { input: rels.join('\0'), maxBuffer: 1 << 26 });
        if (r.status !== 0 && r.status !== 1) return null;
        return new Set(r.status === 0 ? r.stdout.split('\0').filter(Boolean) : []);
    }
    const ignored = loadGitignore(root);
    return new Set(rels.filter(r => ignored(r)));
}

/**
 * Which of these paths git lists as the project's files, as a full discovery would (tracked, or untracked and not ignored,
 * letter case compared exactly). A path inside a nested repository or a submodule, or beyond a symbolic link, is not listed.
 * Null when git could not answer.
 */
export function listedAmong(root, rels) {
    const out = new Set();
    // the paths as pathspecs, literal whatever the user's environment says; in batches that stay well within a command line (32K on Windows)
    const env = { GIT_LITERAL_PATHSPECS: '1', GIT_GLOB_PATHSPECS: '0', GIT_NOGLOB_PATHSPECS: '0', GIT_ICASE_PATHSPECS: '0' };
    for (let i = 0; i < rels.length;) {
        const batch = [];
        for (let chars = 0; i < rels.length && (batch.length === 0 || chars + rels[i].length < 20_000); i++) { batch.push(rels[i]); chars += rels[i].length + 1; }
        const r = gitSync(root, ['-c', 'core.ignorecase=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...batch], { maxBuffer: 1 << 26, env });
        if (r.status !== 0) return null;
        for (const p of r.stdout.split('\0')) if (p) out.add(p.replace(/\\/g, '/'));
    }
    // compared exactly, a rule written in another letter case (`*.GEN.ts`) misses; git's own matching, as discovery applies it, does not
    if (out.size) { const ignored = ignoredAmong(root, [...out], true); if (ignored == null) return null; for (const p of ignored) out.delete(p); }
    return out;
}

const realRootOf = new Map();
/**
 * The name `rel` has on disk, letter case included. On a file system that ignores case (macOS,
 * Windows) `src/foo.ts` is still found after it was renamed to `src/Foo.ts`, and both names would
 * be indexed as two files: the file is `src/Foo.ts`, whoever asks for it by the old name (git does,
 * until it is told).
 */
export function diskName(root, rel) {
    try {
        let realRoot = realRootOf.get(root);
        if (!realRoot) realRootOf.set(root, (realRoot = fs.realpathSync.native(root)));
        const real = path.relative(realRoot, fs.realpathSync.native(path.join(root, rel))).split(path.sep).join('/');
        return real.toLowerCase() === rel.toLowerCase() ? real : rel; // another path altogether is a link, not a case
    } catch { return rel; }
}

/** The files under a directory, at most `max` of them (null when there are more: sweep instead). */
export function filesUnder(root, rel, max = 5000) {
    const out = [];
    const stack = [rel];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && e.name !== '.git') stack.push(`${dir}/${e.name}`); }
            else if (e.isFile() || e.isSymbolicLink()) { out.push(`${dir}/${e.name}`); if (out.length > max) return null; }
        }
    }
    return out;
}
