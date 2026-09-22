import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Create a temporary repository from a { 'path': 'content' } map (optionally git-initialised). */
export function makeRepo(files, { git = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-test-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    if (git) {
        const run = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
        run('init', '-q');
        run('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
        run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    }
    return root;
}

export function writeFile(root, rel, content) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    // make sure mtime changes even on coarse-grained filesystems
    const t = new Date(Date.now() + 2000);
    fs.utimesSync(abs, t, t);
}

export function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
