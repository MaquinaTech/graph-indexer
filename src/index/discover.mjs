/**
 * File discovery. Inside a git work tree we ask git (tracked + untracked-but-not-ignored),
 * which honours every .gitignore/.git/info/exclude rule exactly; elsewhere we walk the tree
 * with a small .gitignore matcher. On top of that we skip what an agent never wants in its
 * index: dependencies, build output, vendored bundles, minified and generated files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
    const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() === 'true';
}

function gitListFiles(root) {
    const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: root, encoding: 'utf8', maxBuffer: 1 << 30,
    });
    if (r.status !== 0) return null;
    return r.stdout.split('\0').filter(Boolean);
}

/** Minimal .gitignore → predicate (used only outside git repos). */
function loadGitignore(root) {
    const rules = [];
    try {
        for (let line of fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/)) {
            line = line.trim();
            if (!line || line.startsWith('#')) continue;
            const neg = line.startsWith('!');
            if (neg) line = line.slice(1);
            const dirOnly = line.endsWith('/');
            if (dirOnly) line = line.slice(0, -1);
            const anchored = line.startsWith('/') || line.includes('/');
            line = line.replace(/^\//, '');
            const re = line.split('**').map(seg => seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('.*');
            rules.push({ neg, re: new RegExp(anchored ? `^${re}(/|$)` : `(^|/)${re}(/|$)`) });
        }
    } catch { /* no .gitignore */ }
    return (rel) => {
        let ignored = false;
        for (const r of rules) if (r.re.test(rel)) ignored = !r.neg;
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
    const files = rels.map(r => r.replace(/\\/g, '/')).filter(r => isIndexablePath(r, opts));
    files.sort();
    return { files, viaGit };
}

/** Heuristic: minified / generated content that slipped past the name filters. */
export function looksMinified(source) {
    if (source.length < 2000) return false;
    const lines = source.split('\n', 50);
    const long = lines.filter(l => l.length > 500).length;
    return long >= 3 || source.length / Math.max(1, source.split('\n').length) > 300;
}
