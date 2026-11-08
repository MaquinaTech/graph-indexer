/**
 * Vector index over definitions for the semantic channel (see semantic.mjs).
 *
 * One int8 vector per definition, embedded from its qualified name, signature, doc comment and
 * the head of its body. Vectors are filled lazily, file by file, keyed by the file's content
 * hash, so an edit re-embeds only the files it touched. Search is an exact scan over the matrix
 * held in memory (no ANN structure to go stale): ~1 ms per 10k definitions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { StaticModel, quantize, semanticEnabled } from './semantic.mjs';
import { splitIdentifier } from './tokenize.mjs';

const EMBED_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'type', 'object', 'module', 'impl',
    'function', 'method', 'constructor', 'macro', 'section']);
const BODY_LINES = 60;

let sharedModel = null;
function model() { return (sharedModel ??= new StaticModel()); }

/** The text a definition is embedded from. */
export function symbolText(sym, path_, lines) {
    const words = splitIdentifier(sym.name).join(' ');
    const head = `${path_}\n${sym.qname} (${words})\n${sym.sig ?? ''}\n${sym.doc ?? ''}\n`;
    const body = lines.slice(sym.start_line - 1, Math.min(sym.end_line, sym.start_line - 1 + BODY_LINES)).join('\n');
    return head + body;
}

export class VectorIndex {
    constructor(indexer, { m = null } = {}) {
        this.ix = indexer;
        this.store = indexer.store;
        this.m = m;
        this.version = -1;
        this.ids = null;      // Int32Array of symbol ids
        this.mat = null;      // Int8Array rows × dim
        this.scales = null;   // Float32Array
    }

    static maybe(indexer) {
        try { return semanticEnabled() ? new VectorIndex(indexer) : null; } catch { return null; }
    }

    get model() { return (this.m ??= model()); }

    /** Embed the files whose vectors are missing or stale; returns how many files were embedded. */
    fill() {
        const s = this.store;
        const stale = s.all(`SELECT f.id, f.path, f.hash FROM files f LEFT JOIN vec_files v ON v.file_id = f.id
            WHERE v.hash IS NULL OR v.hash <> f.hash`);
        const gone = s.all('SELECT v.file_id AS id FROM vec_files v LEFT JOIN files f ON f.id = v.file_id WHERE f.id IS NULL');
        if (!stale.length && !gone.length) return 0;
        const dim = this.model.dim;
        let n = 0;
        const BATCH = 200;
        for (let i = 0; i < stale.length; i += BATCH) {
            s.tx(() => {
                for (const f of stale.slice(i, i + BATCH)) {
                    s.run('DELETE FROM vectors WHERE file_id = ?', f.id);
                    let src = null;
                    try { src = fs.readFileSync(path.join(this.ix.root, f.path), 'utf8'); } catch { /* deleted since */ }
                    if (src != null) {
                        const lines = src.split('\n');
                        const syms = s.all('SELECT id, name, qname, kind, sig, doc, start_line, end_line FROM symbols WHERE file_id = ?', f.id);
                        for (const sym of syms) {
                            if (!EMBED_KINDS.has(sym.kind)) continue;
                            const v = this.model.embed(symbolText(sym, f.path, lines));
                            if (!v || v.length !== dim) continue;
                            const { q, scale } = quantize(v);
                            s.run('INSERT INTO vectors (symbol_id, file_id, scale, v) VALUES (?, ?, ?, ?)', sym.id, f.id, scale, Buffer.from(q.buffer));
                        }
                    }
                    s.run('INSERT INTO vec_files (file_id, hash) VALUES (?, ?) ON CONFLICT(file_id) DO UPDATE SET hash = excluded.hash', f.id, f.hash);
                    n++;
                }
            });
        }
        if (gone.length) s.tx(() => { for (const g of gone) { s.run('DELETE FROM vectors WHERE file_id = ?', g.id); s.run('DELETE FROM vec_files WHERE file_id = ?', g.id); } });
        return n;
    }

    #load() {
        if (this.version === this.ix.version && this.mat) return;
        this.fill();
        const rows = this.store.all('SELECT symbol_id, scale, v FROM vectors');
        const dim = this.model.dim;
        this.ids = new Int32Array(rows.length);
        this.scales = new Float32Array(rows.length);
        this.mat = new Int8Array(rows.length * dim);
        rows.forEach((r, i) => {
            this.ids[i] = r.symbol_id;
            this.scales[i] = r.scale;
            this.mat.set(new Int8Array(r.v.buffer, r.v.byteOffset, dim), i * dim);
        });
        this.version = this.ix.version;
    }

    /** Top-k definitions by cosine similarity to the query: Map(symbol id → cosine). */
    search(query, k = 200) {
        const qv = this.model.embed(query);
        if (!qv) return new Map();
        this.#load();
        const dim = this.model.dim, M = this.mat, n = this.ids.length;
        const top = [];  // small min-heap would be faster; k ≪ n and n is modest, a threshold scan is enough
        let floor = -Infinity;
        for (let i = 0; i < n; i++) {
            let d = 0;
            const o = i * dim;
            for (let j = 0; j < dim; j++) d += M[o + j] * qv[j];
            d *= this.scales[i];
            if (top.length < k) { top.push([i, d]); if (top.length === k) { top.sort((a, b) => a[1] - b[1]); floor = top[0][1]; } }
            else if (d > floor) {
                top[0] = [i, d];
                // re-establish the minimum at index 0 (insertion into sorted position)
                let p = 0;
                while (p + 1 < top.length && top[p][1] > top[p + 1][1]) { const t = top[p]; top[p] = top[p + 1]; top[p + 1] = t; p++; }
                floor = top[0][1];
            }
        }
        return new Map(top.map(([i, d]) => [this.ids[i], d]));
    }
}
