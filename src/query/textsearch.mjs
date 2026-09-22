/**
 * Text search over every file in the repository (code, config, docs), with the structure grep
 * cannot give: each code match is attributed to its enclosing definition, and when the pattern is
 * an identifier each match says what it is — the definition itself, a reference bound to a
 * specific symbol (so same-named methods of different classes are told apart), a reference the
 * index could not bind, or text in a comment or string.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_FILE_BYTES = 1_500_000;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.graph-indexer|dist|build|out|target|coverage|__pycache__|\.venv|venv|\.next|\.nuxt|\.cache|vendor)\//;
const EXAMPLE_PATH = /(^|\/)(docs?_src|docs?|examples?|samples?|demos?|tutorials?|benchmarks?|playground)\//i;
const COMMENT_LINE = /^\s*(\/\/|#(?![!\[])|\*|\/\*|<!--|--\s|;;|%)/;

function listFiles(root) {
    const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 });
    if (r.status === 0) return r.stdout.split('\0').filter(Boolean).filter(p => !SKIP_DIRS.test(p));
    const out = [];
    const stack = [''];
    while (stack.length) {
        const rel = stack.pop();
        let entries;
        try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const p = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { if (!e.name.startsWith('.') && !SKIP_DIRS.test(p + '/')) stack.push(p); } else if (e.isFile()) out.push(p);
        }
    }
    return out;
}

/** The identifier a pattern is about (`\bget\(` → get, `Reflector.get` → get), if any. */
export function identifierOf(pattern, literal) {
    const src = literal ? pattern : pattern.replace(/\\[bBsSdDwW]/g, ' ').replace(/\\(.)/g, '$1').replace(/[()[\]{}^$*+?|]/g, ' ');
    const words = src.split(/[^A-Za-z0-9_$]+/).filter(w => /^[A-Za-z_$][\w$]*$/.test(w));
    return words.length ? words[words.length - 1] : null;
}

function rank(p, isTest) {
    if (isTest) return 2;
    if (EXAMPLE_PATH.test(p)) return 3;
    return 0;
}

/**
 * @returns {{ error?: string, total: number, files: number, shown: object[], summary: object|null, truncated: boolean }}
 */
export async function textSearch(intel, { pattern, path: prefix = null, literal = false, ignoreCase = false, limit = 60 }) {
    let re;
    try {
        const src = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
        re = new RegExp(src, ignoreCase ? 'i' : '');
    } catch (e) {
        return { error: `Invalid regular expression: ${e.message}. Pass literal: true to search for the text as is.` };
    }
    const root = intel.root;
    const pre = prefix ? String(prefix).replace(/^\.\//, '').replace(/^\/+/, '') : null;
    const files = listFiles(root).filter(p => !pre || p === pre || p.startsWith(pre.endsWith('/') ? pre : pre + '/') || p.startsWith(pre));
    const indexed = new Map(intel.store.all('SELECT id, path, is_test FROM files').map(f => [f.path, f]));
    const matches = [];
    let total = 0, nfiles = 0;
    for (const rel of files) {
        let text;
        try {
            const st = fs.statSync(path.join(root, rel));
            if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
            text = fs.readFileSync(path.join(root, rel), 'utf8');
        } catch { continue; }
        if (!re.test(text)) continue;
        if (text.indexOf('\0') >= 0 && text.indexOf('\0') < 8000) continue; // binary
        const lines = text.split(/\r?\n/);
        let any = false;
        for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i])) continue;
            any = true;
            total++;
            const f = indexed.get(rel);
            matches.push({ path: rel, line: i + 1, text: lines[i], fileId: f?.id ?? null, isTest: !!f?.is_test, code: !!f });
        }
        if (any) nfiles++;
    }
    const ident = identifierOf(pattern, literal);
    // annotate: enclosing definition, and what an identifier match refers to
    const byFile = new Map();
    for (const m of matches) (byFile.get(m.path) ?? byFile.set(m.path, []).get(m.path)).push(m);
    const summary = ident ? { ident, targets: new Map(), defs: 0, unbound: 0, text: 0, nonCode: 0 } : null;
    for (const [rel, ms] of byFile) {
        const f = indexed.get(rel);
        if (!f) { for (const m of ms) { m.what = 'file'; if (summary) summary.nonCode++; } continue; }
        const syms = intel.store.all('SELECT id, qname, kind, name, start_line, end_line, name_line FROM symbols WHERE file_id = ? ORDER BY start_line', f.id);
        const refs = ident ? intel.store.all(`SELECT r.line, r.kind, r.dst_id, d.qname AS dst_qname, df.path AS dst_path FROM refs r LEFT JOIN symbols d ON d.id = r.dst_id LEFT JOIN files df ON df.id = d.file_id
            WHERE r.file_id = ? AND r.name = ?`, f.id, ident) : [];
        const refsAt = new Map();
        for (const r of refs) (refsAt.get(r.line) ?? refsAt.set(r.line, []).get(r.line)).push(r);
        for (const m of ms) {
            // innermost definition around the line, ignoring ones that start on it (inline classes, the def itself)
            let encl = null;
            for (const s of syms) if (s.start_line < m.line && s.end_line >= m.line && (!encl || s.start_line >= encl.start_line)) encl = s;
            m.encl = encl?.qname ?? null;
            if (!summary) continue;
            const def = syms.find(s => s.name === ident && s.name_line === m.line);
            const rs = refsAt.get(m.line) ?? [];
            if (def) { m.what = 'def'; m.target = def.qname; summary.defs++; continue; }
            const bound = rs.filter(r => r.dst_id != null);
            if (bound.length) {
                m.what = 'ref';
                m.target = [...new Set(bound.map(r => r.dst_qname))].join(', ');
                for (const r of bound) {
                    const k = `${r.dst_qname}\u0000${r.dst_path}`;
                    summary.targets.set(k, (summary.targets.get(k) ?? 0) + 1);
                }
                continue;
            }
            if (rs.length) { m.what = 'unbound'; summary.unbound++; continue; }
            m.what = COMMENT_LINE.test(m.text) ? 'comment' : 'text';
            summary.text++;
        }
    }
    matches.sort((a, b) => rank(a.path, a.isTest) + (a.code ? 0 : 1) - (rank(b.path, b.isTest) + (b.code ? 0 : 1)) || a.path.localeCompare(b.path) || a.line - b.line);
    return { total, files: nfiles, shown: matches.slice(0, limit), all: matches, summary, truncated: matches.length > limit };
}
