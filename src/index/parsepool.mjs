/**
 * Parsing on several threads. Extraction (tree-sitter parse + queries) is most of a full index's
 * time and each file is independent, so a pool of worker threads parses while the main thread
 * writes the previous batch to SQLite. Each worker loads the WASM runtime and the grammars it meets
 * once; results come back by structured clone, the same objects `extractFile` returns.
 *
 * A file the pool fails on is parsed again inline by the caller, so a thread error never loses it.
 * Only worth it for many files: small updates (a watcher event, a query-time check) parse inline.
 * GRAPH_INDEXER_WORKERS sets the number of threads (0 turns the pool off).
 */
import os from 'node:os';
import { Worker } from 'node:worker_threads';

const WORKER = new URL('./parse-worker.mjs', import.meta.url);
export const POOL_MIN_FILES = 48;

/** Threads to use for `n` files to parse: 0 when parsing inline is as fast. */
export function poolSize(n) {
    const env = process.env.GRAPH_INDEXER_WORKERS;
    const want = env != null && env !== '' ? Math.max(0, Number(env) | 0) : Math.min(8, Math.max(0, (os.availableParallelism?.() ?? os.cpus().length) - 1));
    if (n < POOL_MIN_FILES || want < 1) return 0;
    return Math.min(want, Math.ceil(n / 16));
}

export class ParsePool {
    constructor(size) {
        this.workers = [];
        this.idle = [];
        this.queue = [];
        this.pending = new Map();
        this.nextId = 0;
        for (let i = 0; i < size; i++) {
            const w = new Worker(WORKER);
            w.on('message', ({ id, extraction, error }) => {
                const p = this.pending.get(id);
                this.pending.delete(id);
                if (error) p.reject(new Error(error)); else p.resolve(extraction);
                this.#next(w);
            });
            // a thread that dies takes the pool with it: every pending and later file is parsed inline
            w.on('error', (e) => this.#break(e));
            w.on('exit', (code) => { if (code !== 0 && !this.closing) this.#break(new Error(`parse thread exited with code ${code}`)); });
            this.workers.push(w);
            this.idle.push(w);
        }
    }

    /** Extraction of one file, as `extractFile(specForPath(rel), source, rel)` would return it. */
    extract(rel, source) {
        if (this.broken) return Promise.reject(this.broken);
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            const task = { id, rel, source };
            const w = this.idle.pop();
            if (w) w.postMessage(task); else this.queue.push(task);
        });
    }

    #next(w) {
        const task = this.queue.shift();
        if (task) w.postMessage(task); else this.idle.push(w);
    }

    #break(e) {
        this.broken ??= e;
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
        this.queue = [];
    }

    async close() { this.closing = true; await Promise.all(this.workers.map(w => w.terminate())); this.workers = []; }
}
