/**
 * @file daemon-lock.mjs
 * @description Single-instance guard for the watch daemon. One — and only one —
 *              daemon may run per project, regardless of how it was launched
 *              (auto-spawned by the MCP server, `idx-daemon start`, or `idx-watch`
 *              directly). The guard is a PID lock file owned exclusively by the
 *              live daemon: acquisition is atomic (O_EXCL create) and tolerant of
 *              stale locks left by a crashed process.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';

/** Read a PID from a lock file, or null if absent/garbage. */
export function readPid(pidFile) {
    try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch { return null; }
}

/** True if a process with this PID currently exists. */
export function isAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; }
    catch (err) { return err.code === 'EPERM'; } // exists but owned by another user
}

/**
 * Inspect the lock without acquiring it.
 * @returns {{running:boolean, pid:number|null}}
 */
export function daemonStatus(pidFile) {
    const pid = readPid(pidFile);
    return { running: isAlive(pid), pid: isAlive(pid) ? pid : null };
}

/**
 * Atomically claim the daemon lock for the current process. A stale lock (PID no
 * longer alive) is cleared and retried; a lock held by a *live* daemon is left
 * untouched.
 *
 * @returns {boolean} true if this process now owns the lock; false if another
 *                    live daemon already holds it (caller should exit).
 */
export function acquireLock(pidFile) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const fd = fs.openSync(pidFile, 'wx'); // O_EXCL: fails if the file exists
            try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
            return true;
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            const pid = readPid(pidFile);
            if (pid === process.pid) return true;
            if (isAlive(pid)) return false;
            try { fs.unlinkSync(pidFile); } catch { /* another racer cleared it — retry */ }
        }
    }
    return false;
}

/** Release the lock, but only if this process owns it (never steal another's). */
export function releaseLock(pidFile) {
    if (readPid(pidFile) === process.pid) {
        try { fs.unlinkSync(pidFile); } catch { }
    }
}
