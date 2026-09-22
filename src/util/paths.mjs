/** Data layout: everything graph-indexer writes lives in <repo>/.graph-indexer/ (git-ignored). */
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR_NAME = '.graph-indexer';

export function dataDir(root) {
    const dir = path.join(root, DATA_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true });
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
