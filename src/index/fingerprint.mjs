/**
 * Fingerprint of everything that determines the stored facts: extraction queries and code,
 * module and reference resolution, FTS tokenization, the schema and the grammar builds. An index
 * written under a different fingerprint is rebuilt, so upgrading graph-indexer never keeps serving
 * facts that an older extractor produced for files that have not changed since.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUTS = ['parse', 'index', 'search/tokenize.mjs', 'store/db.mjs', '../vendor/grammars/manifest.json'];
const QUERY_TIME_ONLY = new Set(['graph.mjs']);

let cached = null;

export function indexFingerprint() {
    if (cached) return cached;
    const h = crypto.createHash('sha1');
    const add = (p) => {
        const st = fs.statSync(p, { throwIfNoEntry: false });
        if (!st) return;
        if (st.isDirectory()) { for (const e of fs.readdirSync(p).sort()) add(path.join(p, e)); return; }
        if (!/\.(mjs|json)$/.test(p) || QUERY_TIME_ONLY.has(path.basename(p))) return;
        h.update(path.relative(SRC, p).split(path.sep).join('/')).update('\0').update(fs.readFileSync(p)).update('\0');
    };
    for (const i of INPUTS) add(path.join(SRC, i));
    return (cached = h.digest('hex').slice(0, 16));
}
