/**
 * Compact, agent-oriented text rendering. Conventions:
 *   - locations are `path:line` / `path:start-end` (clickable in most agent UIs);
 *   - code is shown with right-aligned line numbers, like the agents' own file readers;
 *   - every list states its total and what was left out, so truncation is never silent;
 *   - confidence words: exact (scope/import/type proven), high, likely, possible (name-only).
 */
import { confidenceLabel } from '../index/resolver.mjs';

const MAX_LINE = 220;

export function loc(s) {
    return s.start_line === s.end_line ? `${s.path}:${s.start_line}` : `${s.path}:${s.start_line}-${s.end_line}`;
}

export function clip(text, n = MAX_LINE) {
    if (!text) return '';
    return text.length > n ? text.slice(0, n - 1) + '…' : text;
}

export function codeBlock(lines, from, to, { highlight = null, maxLines = 400 } = {}) {
    if (!lines) return '(file not readable)';
    const a = Math.max(1, from), b = Math.min(lines.length, to);
    const w = String(b).length;
    const out = [];
    let shown = 0;
    for (let i = a; i <= b; i++) {
        if (shown >= maxLines) { out.push(`${' '.repeat(w)}  … ${b - i + 1} more lines (${i}-${b})`); break; }
        const mark = highlight?.has(i) ? '›' : ' ';
        out.push(`${String(i).padStart(w)}${mark} ${clip(lines[i - 1].replace(/\t/g, '    '))}`);
        shown++;
    }
    return out.join('\n');
}

export function kindTag(s) {
    const bits = [s.kind];
    if (s.is_test) bits.push('test');
    return bits.join(', ');
}

export function symHeader(s) {
    return `${s.qname} (${kindTag(s)}) ${loc(s)}`;
}

export function confWord(c) { return confidenceLabel(c); }

/** Lines of a symbol's body that mention any of the query terms (for search snippets). */
export function matchingLines(lines, s, terms, max = 2) {
    if (!lines || !terms.length) return [];
    const re = new RegExp(terms.filter(t => t.length >= 3).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '$^', 'i');
    const out = [];
    for (let i = s.start_line + 1; i <= Math.min(s.end_line, lines.length) && out.length < max; i++) {
        const t = lines[i - 1];
        if (t && re.test(t) && t.trim().length > 3) out.push(i);
    }
    return out;
}

export function plural(n, word, pluralWord = word + 's') { return `${n} ${n === 1 ? word : pluralWord}`; }
