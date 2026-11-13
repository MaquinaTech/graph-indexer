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
import { specForPath } from '../parse/languages.mjs';

export const MAX_FILE_BYTES = 1_500_000;

const SKIP_DIRS = new Set([
    'node_modules', 'bower_components', 'jspm_packages', '.git', '.hg', '.svn', '.graph-indexer',
    'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', '.output', '.turbo', '.cache', '.parcel-cache',
    'coverage', '.nyc_output', '__pycache__', '.venv', 'venv', 'env', '.env', '.tox', '.mypy_cache', '.pytest_cache',
    'site-packages', '.gradle', '.idea', '.vscode', 'Pods', 'DerivedData', 'vendor', 'third_party', 'thirdparty',
    'external', 'deps', '_deps', 'obj', 'bin', 'packages-cache', '.yarn', '.pnpm-store', 'elm-stuff', '.terraform',
]);
// `vendor` / `bin` / `obj` are common real source dirs in some ecosystems only when they contain
// sources the user wrote; the conservative default is to skip them (override via config.include).

const GENERATED_FILE = /(\.min\.(js|css|mjs)$|\.bundle\.js$|[.-]bundle\.[cm]?js$|\.chunk\.js$|\.map$|\.pb\.go$|_pb2(_grpc)?\.py$|\.pb\.(cc|h)$|\.generated\.\w+$|\.g\.dart$|\.designer\.cs$|(^|\/)generated\/|\.d\.ts\.map$)/i;

function isGitRepo(root) {
    const r = gitSync(root, ['rev-parse', '--is-inside-work-tree']);
    return r.status === 0 && r.stdout.trim() === 'true';
}

function gitListFiles(root) {
    const r = gitSync(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 1 << 30 });
    if (r.status !== 0) return null;
    return r.stdout.split('\0').filter(Boolean);
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
                if (SKIP_DIRS.has(e.name) || e.name.startsWith('.') || ignored(r)) continue;
                stack.push(r);
            } else if (e.isFile() && !ignored(r)) out.push(r);
        }
    }
    return out;
}

export function isIndexablePath(rel, { include = null } = {}) {
    if (!specForPath(rel)) return false;
    const parts = rel.split('/');
    if (include && include.some(p => rel.startsWith(p))) return !GENERATED_FILE.test(rel);
    for (let i = 0; i < parts.length - 1; i++) if (SKIP_DIRS.has(parts[i])) return false;
    return !GENERATED_FILE.test(rel);
}

/**
 * List indexable files (repo-relative, forward slashes), sorted for determinism.
 * @returns {{ files: string[], viaGit: boolean }}
 */
export function discoverFiles(root, opts = {}) {
    let rels = null, viaGit = false;
    if (!opts.noGit && isGitRepo(root)) {
        rels = gitListFiles(root);
        viaGit = rels !== null;
    }
    if (!rels) rels = walk(root, loadGitignore(root));
    const files = rels.map(r => r.replace(/\\/g, '/')).filter(r => isIndexablePath(r, opts) && insideRoot(root, r));
    files.sort();
    return { files, viaGit };
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
