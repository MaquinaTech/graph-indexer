/**
 * Where an issue points in the code. An issue names things in code spans, examples and tracebacks
 * (`DATE_DIFF`, `rich_club_coefficient(normalized=True)`, `exp.Agg`); the code to change is where
 * several of those names meet. Each name is matched against identifiers by their words, so
 * `DATE_DIFF`, `DateDiff` and `_date_diff_sql` are one term, and each definition scores the
 * rarity (inverse document frequency) of the distinct terms its lines carry, plus the terms its
 * own name or its file's path is made of. Library code only: tests are left out.
 */
import fs from 'node:fs';
import path from 'node:path';

// words of examples that name the language, not the code under it
const NOISE = new Set(('true false none null undefined self cls this def class return import from print len str int float bool list dict set tuple range '
    + 'isinstance assert lambda and or not in is if else elif for while with as pass raise try except finally yield async await new let const var '
    + 'function public private static void string object type repr').split(' '));
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;
const WORD = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g;
const MAX_FILE_BYTES = 1_000_000;
// examples, benchmarks and docs are not where an issue gets fixed
const ASIDE_PATH = /(^|\/)(examples?|samples?|demos?|sandbox|playground|docs?(_src|_source|_examples?)?|documentation|benchmarks?|bench|scripts?|fixtures?|testdata|tutorials?|website|\.github)\//i;
// measured on the dev split of bench/agentic/localize.mjs: mild length normalisation (BM25's b),
// the title's terms four times an example's, tables and lists of names at 0.6 of a definition
const B = 0.2;
const TITLE_W = 4;
const VALUE_W = 0.6;
const VALUE_KINDS = new Set(['field', 'property', 'variable', 'constant']);

const partsCache = new Map();
function parts(id) {
    let p = partsCache.get(id);
    if (!p) {
        p = (id.match(WORD) ?? []).map(w => w.toLowerCase());
        if (partsCache.size > 200_000) partsCache.clear();
        partsCache.set(id, p);
    }
    return p;
}

/** Whether an issue reads like one: long enough, or carrying code. */
export function isIssueText(text) {
    const t = String(text ?? '');
    return t.length >= 240 || /```/.test(t) || (t.match(/`[^`\n]+`/g) ?? []).length >= 3;
}

/** The code-like names an issue uses: from its code spans and blocks, and identifier-shaped words of its prose. */
export function issueTerms(text) {
    const t = String(text ?? '');
    const code = [];
    // a fence's language tag (```python) is not part of the code
    const prose = t.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, m) => { code.push(m); return ' '; })
        .replace(/`([^`\n]+)`/g, (_, m) => { code.push(m); return ' '; });
    // the title names what the issue is about; examples name everything they touch
    const title = new Set((t.trim().split('\n')[0].match(IDENT) ?? []).map(x => parts(x).join('_')));
    const ids = [];
    for (const c of code) for (const m of c.matchAll(IDENT)) ids.push(m[0]);
    // prose words that can only be code: snake_case, camelCase, dotted paths
    for (const m of prose.matchAll(/[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)+|\b[a-z]+_[a-z_\d]+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/g)) for (const x of m[0].split('.')) ids.push(x);
    const terms = new Map();
    for (const id of ids) {
        const p = parts(id);
        if (!p.length || NOISE.has(id.toLowerCase())) continue;
        if (p.length === 1 && p[0].length < 3) continue;
        if (p.every(w => /^\d+$/.test(w))) continue;
        const key = p.join('_');
        if (!terms.has(key)) terms.set(key, { key, parts: p, forms: new Set(), title: title.has(key) });
        terms.get(key).forms.add(id);
    }
    return [...terms.values()];
}

/**
 * Definitions ranked by the issue's terms they carry. Returns [{ id, score, terms }] (best first).
 * @param {import('./intel.mjs').CodeIntel} intel
 */
export function issueSeeds(intel, text, { limit = 12, path: prefix = null } = {}) {
    const terms = issueTerms(text);
    if (!terms.length) return [];
    const byFirst = new Map();
    for (const t of terms) { if (!byFirst.has(t.parts[0])) byFirst.set(t.parts[0], []); byFirst.get(t.parts[0]).push(t); }
    const files = intel.store.all('SELECT id, path, size FROM files WHERE is_test = 0');
    const hits = new Map(); // symbol id -> Set(term key)
    const owned = new Map(); // symbol id -> lines it owns (its own, not its members')
    const df = new Map();   // term key -> number of definitions carrying it
    let total = 0;
    for (const f of files) {
        if (prefix && !f.path.startsWith(prefix)) continue;
        if (f.size > MAX_FILE_BYTES) continue;
        if (ASIDE_PATH.test(f.path) && !(prefix && ASIDE_PATH.test(prefix))) continue;
        const syms = intel.store.all('SELECT id, start_line, end_line FROM symbols WHERE file_id = ? ORDER BY start_line', f.id);
        total += syms.length;
        if (!syms.length) continue;
        let text;
        try { text = fs.readFileSync(path.join(intel.root, f.path), 'utf8'); } catch { continue; }
        const lines = text.split('\n');
        // innermost definition of each line
        const owner = new Int32Array(lines.length + 2).fill(-1);
        const span = new Int32Array(lines.length + 2).fill(1 << 30);
        for (const s of syms) {
            const w = s.end_line - s.start_line;
            for (let l = s.start_line; l <= Math.min(s.end_line, lines.length); l++) if (w < span[l]) { span[l] = w; owner[l] = s.id; }
        }
        for (let i = 0; i < lines.length; i++) {
            const o = owner[i + 1];
            if (o < 0) continue;
            owned.set(o, (owned.get(o) ?? 0) + 1);
            for (const m of lines[i].matchAll(IDENT)) {
                const p = parts(m[0]);
                for (let k = 0; k < p.length; k++) {
                    const cands = byFirst.get(p[k]);
                    if (!cands) continue;
                    for (const t of cands) {
                        if (k + t.parts.length > p.length) continue;
                        let ok = true;
                        for (let j = 1; j < t.parts.length; j++) if (p[k + j] !== t.parts[j]) { ok = false; break; }
                        if (!ok) continue;
                        let set = hits.get(o);
                        if (!set) hits.set(o, (set = new Set()));
                        if (!set.has(t.key)) { set.add(t.key); df.set(t.key, (df.get(t.key) ?? 0) + 1); }
                    }
                }
            }
        }
    }
    if (!hits.size) return [];
    const idf = (k) => Math.log(1 + total / (df.get(k) ?? total));
    const rows = new Map();
    const ids = [...hits.keys()];
    for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        for (const r of intel.store.all(`SELECT s.id, s.name, s.kind, s.start_line, s.end_line, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) rows.set(r.id, r);
    }
    // longer definitions carry more terms by chance: BM25's length normalisation, over owned lines
    let sumLen = 0;
    for (const v of owned.values()) sumLen += v;
    const avgLen = sumLen / Math.max(1, owned.size);
    const byKey = new Map(terms.map(t => [t.key, t]));
    const scored = [];
    for (const [id, set] of hits) {
        const r = rows.get(id);
        if (!r) continue;
        let score = 0;
        for (const k of set) score += idf(k) * (byKey.get(k)?.title ? TITLE_W : 1);
        // its own name is a term the issue uses: the issue names this definition
        const own = parts(r.name).join('_');
        if (set.has(own)) score += idf(own);
        // its file's path is made of a term (a dialect, a format, a module named in the issue)
        const pathWords = new Set(r.path.split(/[/._-]+/).flatMap(parts));
        for (const t of terms) if (t.parts.length === 1 && pathWords.has(t.parts[0]) && !set.has(t.key)) score += 0.5 * idf(t.key);
        score /= 1 - B + B * ((owned.get(id) ?? 1) / avgLen);
        // a table or list of names (`__all__`, a function map) enumerates terms rather than combining them
        if (VALUE_KINDS.has(r.kind)) score *= VALUE_W;
        scored.push({ id, score, terms: [...set] });
    }
    scored.sort((a, b) => b.score - a.score || a.id - b.id);
    return scored.slice(0, limit);
}
