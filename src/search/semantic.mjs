/**
 * Optional semantic channel: a static (Model2Vec) code embedding model, run in plain JavaScript.
 *
 * A static model is a table of one vector per WordPiece token; a text's embedding is the mean of
 * its tokens' vectors, normalised. There is no neural network to run, so it needs no native code,
 * no ONNX runtime and no GPU: embedding a whole repository takes seconds on one core.
 *
 * The model is not part of the package. `graph-indexer semantic install` downloads it once, at a
 * pinned revision with checked SHA-256 digests, into ~/.cache/graph-indexer/models (or
 * GRAPH_INDEXER_MODEL_DIR). The channel is opt-in: it runs only with GRAPH_INDEXER_SEMANTIC=1 and
 * the model installed; otherwise search is purely lexical + graph. On the benchmarks it helps
 * symbol search for queries in words and does not help localizing real commits (docs/BENCHMARKS.md),
 * so it is not the default.
 *
 * Vectors are computed lazily, file by file, the first time a search needs them, and kept in the
 * index (`vectors`, `vec_files`), keyed by the file's content hash so edits re-embed only that file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const MODEL = {
    id: 'potion-code-16M-v2',
    repo: 'minishlab/potion-code-16M-v2',
    revision: 'e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b',
    license: 'MIT',
    files: {
        'model.safetensors': '75cf7a6c2171b230ad19b1e7d8e0b1aee86da5a02af8e7cacedd9921d227623c',
        'tokenizer.json': '107bbdcbad4bff1d299b7a4c3a2fb17c52890688b7dd0e4c9deab79d3c4f3d45',
        'config.json': '148e5691a6fcc553437156859701fba017a1ba5d340b170f17e0f3668fb861a7',
    },
};

const MAX_TOKENS = 512;       // Model2Vec's default truncation
const MAX_WORD_CHARS = 100;   // WordPiece max_input_chars_per_word

export function modelDir() {
    const base = process.env.GRAPH_INDEXER_MODEL_DIR || path.join(os.homedir(), '.cache', 'graph-indexer', 'models');
    return path.join(base, MODEL.id);
}

export function semanticEnabled() {
    if (process.env.GRAPH_INDEXER_SEMANTIC !== '1') return false;
    return fs.existsSync(path.join(modelDir(), 'model.safetensors')) && fs.existsSync(path.join(modelDir(), 'tokenizer.json'));
}

// ── tokenizer: BertNormalizer(lowercase, strip accents) + BertPreTokenizer + WordPiece ──────────

function isControl(c) {
    if (c === 9 || c === 10 || c === 13) return false;
    return (c < 32) || (c >= 127 && c < 160);
}
function isWhitespace(c) { return c === 32 || c === 9 || c === 10 || c === 13 || c === 0xa0 || c === 0x3000 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x1680; }
function isCJK(c) {
    return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x20000 && c <= 0x2a6df) || (c >= 0x2a700 && c <= 0x2b73f) ||
        (c >= 0x2b740 && c <= 0x2b81f) || (c >= 0x2b820 && c <= 0x2ceaf) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x2f800 && c <= 0x2fa1f);
}
const PUNCT_RE = /\p{P}/u;
function isPunct(ch, c) {
    return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126) || (c > 127 && PUNCT_RE.test(ch));
}

/** Text → normalised pre-tokens (words and single punctuation characters). */
export function preTokenize(text) {
    let s = '';
    for (const ch of text) {
        const c = ch.codePointAt(0);
        if (c === 0 || c === 0xfffd || isControl(c)) continue;
        if (isWhitespace(c)) { s += ' '; continue; }
        if (isCJK(c)) { s += ' ' + ch + ' '; continue; }
        s += ch;
    }
    s = s.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
    const out = [];
    let cur = '';
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c === 32) { if (cur) { out.push(cur); cur = ''; } continue; }
        if (isPunct(ch, c)) { if (cur) { out.push(cur); cur = ''; } out.push(ch); continue; }
        cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}

export class StaticModel {
    constructor(dir = modelDir()) {
        const tok = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8'));
        const m = tok.model;
        if (m?.type !== 'WordPiece') throw new Error(`unsupported tokenizer model ${m?.type}`);
        this.vocab = new Map(Object.entries(m.vocab));
        this.prefix = m.continuing_subword_prefix ?? '##';
        this.unk = this.vocab.get(m.unk_token ?? '[UNK]') ?? -1;
        const buf = fs.readFileSync(path.join(dir, 'model.safetensors'));
        const hlen = Number(buf.readBigUInt64LE(0));
        const header = JSON.parse(buf.subarray(8, 8 + hlen).toString('utf8'));
        const t = header.embeddings ?? Object.values(header).find(v => v && v.shape);
        const [rows, dim] = t.shape;
        const [a, b] = t.data_offsets;
        const raw = buf.subarray(8 + hlen + a, 8 + hlen + b);
        this.dim = dim;
        this.rows = rows;
        this.table = new Float32Array(rows * dim);
        if (t.dtype === 'F32') for (let i = 0; i < rows * dim; i++) this.table[i] = raw.readFloatLE(i * 4);
        else if (t.dtype === 'F16') for (let i = 0; i < rows * dim; i++) this.table[i] = f16(raw.readUInt16LE(i * 2));
        else throw new Error(`unsupported embedding dtype ${t.dtype}`);
        this.cache = new Map(); // word -> token ids
    }

    /** WordPiece ids of one pre-token (greedy longest match), [] when unknown. */
    #word(w) {
        let ids = this.cache.get(w);
        if (ids) return ids;
        ids = [];
        if ([...w].length > MAX_WORD_CHARS) ids = [this.unk];
        else {
            let start = 0;
            while (start < w.length) {
                let end = w.length, found = -1;
                while (start < end) {
                    const sub = (start > 0 ? this.prefix : '') + w.slice(start, end);
                    const id = this.vocab.get(sub);
                    if (id !== undefined) { found = id; break; }
                    end--;
                }
                if (found < 0) { ids = [this.unk]; break; }
                ids.push(found);
                start = end;
            }
        }
        if (this.cache.size > 200000) this.cache.clear();
        this.cache.set(w, ids);
        return ids;
    }

    tokenize(text) {
        const out = [];
        for (const w of preTokenize(text)) {
            for (const id of this.#word(w)) { if (id !== this.unk) out.push(id); }
            if (out.length >= MAX_TOKENS) break;
        }
        return out.length > MAX_TOKENS ? out.slice(0, MAX_TOKENS) : out;
    }

    /** Mean of token vectors, L2-normalised; null for text without known tokens. */
    embed(text) {
        const ids = this.tokenize(text);
        if (!ids.length) return null;
        const d = this.dim, v = new Float32Array(d), T = this.table;
        for (const id of ids) { const o = id * d; for (let j = 0; j < d; j++) v[j] += T[o + j]; }
        let n = 0;
        for (let j = 0; j < d; j++) n += v[j] * v[j];
        n = Math.sqrt(n);
        if (!n) return null;
        for (let j = 0; j < d; j++) v[j] /= n;
        return v;
    }
}

function f16(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** int8 with one scale per vector: v ≈ q * scale. */
export function quantize(v) {
    let m = 0;
    for (let j = 0; j < v.length; j++) { const a = Math.abs(v[j]); if (a > m) m = a; }
    const q = new Int8Array(v.length);
    const scale = m / 127 || 1;
    for (let j = 0; j < v.length; j++) q[j] = Math.round(v[j] / scale);
    return { q, scale };
}

// ── model download (explicit, user-initiated) ──────────────────────────────────────────────────

export async function installModel({ log = console.error } = {}) {
    const dir = modelDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, digest] of Object.entries(MODEL.files)) {
        const dest = path.join(dir, name);
        if (fs.existsSync(dest) && sha256File(dest) === digest) { log(`${name}: present`); continue; }
        const url = `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${name}`;
        log(`downloading ${url}`);
        const res = await fetch(url, { redirect: 'follow' });
        if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
        const data = Buffer.from(await res.arrayBuffer());
        const got = crypto.createHash('sha256').update(data).digest('hex');
        if (got !== digest) throw new Error(`${name}: SHA-256 mismatch (expected ${digest}, got ${got}); nothing was installed`);
        const tmp = dest + '.part';
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, dest);
        log(`${name}: ${(data.length / 1048576).toFixed(1)} MB, verified`);
    }
    return dir;
}

function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
