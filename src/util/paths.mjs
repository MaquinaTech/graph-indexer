/** Data layout: everything graph-indexer writes lives in <repo>/.graph-indexer/ (git-ignored). */
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR_NAME = '.graph-indexer';

export function dataDir(root) {
    const dir = path.join(root, DATA_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // a .graph-indexer the repository committed as a link would put the index (excerpts of the
    // source) wherever it points
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) throw new Error(`${dir} is not a directory (a symbolic link?); remove it and run again`);
    if ((st.mode & 0o077) !== 0) { try { fs.chmodSync(dir, 0o700); } catch { /* read-only */ } }
    // nor may a link inside it (`index.db-wal` → ~/.zshrc, `resident.started` → ~/.ssh/…) send the
    // index's writes elsewhere: everything in here is ours, so a link is never legitimate
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isSymbolicLink()) fs.unlinkSync(path.join(dir, e.name));
    } catch { /* read-only */ }
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) { try { fs.writeFileSync(gi, '*\n'); } catch { /* read-only */ } }
    return dir;
}

/** Walk up from `start` to the nearest directory containing .git (or return start). */
export function findRepoRoot(start) {
    let dir = path.resolve(start);
    for (;;) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return path.resolve(start);
        dir = parent;
    }
}

const realRoots = new Map();

/**
 * `rel` names a file inside the repository once `..` and symlinks are resolved, so a tool target
 * like `../../etc/hosts` or a tracked link to ~/.ssh/… is never read. The index's own data and git's
 * internals are not served either.
 */
export function withinRoot(root, rel) {
    let realRoot = realRoots.get(root);
    if (!realRoot) { try { realRoot = fs.realpathSync.native(root); } catch { realRoot = path.resolve(root); } realRoots.set(root, realRoot); }
    let real;
    // the native realpath gives the name as stored on disk, so on a case-insensitive file system
    // (macOS, Windows) `.GIT/config` resolves to `.git/config` and is refused like it
    try { real = fs.realpathSync.native(path.join(root, rel)); } catch { return false; }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return false;
    const top = path.relative(realRoot, real).split(path.sep)[0].toLowerCase();
    return top !== '.git' && top !== DATA_DIR_NAME;
}

/** A git revision given by a caller: never an option (`--output=…`), whitespace or NUL. */
export const isRevision = (s) => typeof s === 'string' && s.length > 0 && s.length <= 256 && !s.startsWith('-') && !/[\s\0]/.test(s);

/**
 * A small regular file of the repository (a manifest, a config), or null: never a device, a FIFO,
 * a file larger than `maxBytes` or a link out of the root — a `tsconfig.json` linked to /dev/zero
 * would otherwise hang the indexer.
 */
export function readRepoFile(root, rel, maxBytes = 2_000_000) {
    if (!withinRoot(root, rel)) return null;
    try {
        const abs = path.join(root, rel);
        const st = fs.statSync(abs);
        return st.isFile() && st.size <= maxBytes ? fs.readFileSync(abs, 'utf8') : null;
    } catch { return null; }
}
