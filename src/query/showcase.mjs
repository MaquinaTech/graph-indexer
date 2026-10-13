/**
 * The first answer a new user sees, on their own repository: a function or method that shares its
 * name with other definitions, what a text search for that name returns, and the exact uses the
 * index binds to that one definition. The contrast is the point of the tool, shown instead of told.
 */
import { textSearch } from './textsearch.mjs';
import { escapeRegExp } from '../util/regex.mjs';

const CALLABLE = ['function', 'method'];

/**
 * The best example in the repository, or null: a non-test callable with at least 3 bound uses whose
 * name at least one other callable carries, ranked by its uses and how much same-name text surrounds them.
 * @returns {Promise<{ sym: object, defs: number, uses: number, useFiles: number, grepLines: number, grepFiles: number } | null>}
 */
export async function pickShowcase(intel, { candidates = 8 } = {}) {
    const ph = CALLABLE.map(() => '?').join(',');
    const homonyms = new Map(intel.store.all(`SELECT name, COUNT(*) AS n FROM symbols WHERE kind IN (${ph}) AND length(name) >= 3 GROUP BY name HAVING COUNT(*) >= 2`, ...CALLABLE)
        .map(r => [r.name, r.n]));
    if (!homonyms.size) return null;
    const byName = new Map(intel.store.all(`SELECT name, COUNT(*) AS n FROM refs WHERE kind IN ('call', 'new') GROUP BY name`).map(r => [r.name, r.n]));
    // a class's method or an exported function: what a reader recognises, not a local helper
    const rows = intel.store.all(`SELECT s.id, s.name, s.qname, s.kind, COUNT(r.id) AS uses, COUNT(DISTINCT r.file_id) AS files
        FROM symbols s JOIN files f ON f.id = s.file_id JOIN refs r ON r.dst_id = s.id LEFT JOIN symbols p ON p.id = s.parent_id
        WHERE s.kind IN (${ph}) AND f.is_test = 0 AND r.kind IN ('call', 'new') AND r.conf >= 0.9
          AND (p.kind IN ('class', 'struct', 'interface', 'trait', 'object', 'impl') OR (s.parent_id IS NULL AND s.exported = 1))
        GROUP BY s.id HAVING COUNT(r.id) >= 3`, ...CALLABLE)
        .filter(r => homonyms.has(r.name))
        .map(r => ({ ...r, others: (byName.get(r.name) ?? 0) - r.uses }))
        .filter(r => r.others > 0)
        // most uses drowned in the most same-name noise
        .sort((a, b) => b.uses * Math.log1p(b.others / b.uses) - a.uses * Math.log1p(a.others / a.uses))
        .slice(0, candidates);
    let best = null;
    for (const r of rows) {
        const g = await textSearch(intel, { pattern: `\\b${escapeRegExp(r.name)}\\b`, limit: 1 });
        if (g.error || !g.total) continue;
        const ex = { sym: intel.sym(r.id), defs: homonyms.get(r.name), uses: r.uses, useFiles: r.files, grepLines: g.total, grepFiles: g.files };
        const score = (x) => Math.min(x.uses, 40) * Math.log2(x.grepLines / x.uses);
        if (ex.grepLines >= 2 * ex.uses && (!best || score(ex) > score(best))) best = ex;
    }
    return best;
}

/** The showcase as text, with the command that reproduces it (`cli` names the executable). */
export async function showcaseText(intel, { cli = 'npx graph-indexer' } = {}) {
    const st = intel.stats();
    const ex = await pickShowcase(intel);
    const head = `Indexed ${st.files} files, ${st.symbols} symbols, ${st.refs} references.`;
    if (!ex) return `${head}\nNo method here shares its name with another one, so there is no grep-versus-index contrast to show; try \`${cli} explore "<a task in words>"\`.`;
    const s = ex.sym;
    return [
        head,
        `Example from this repository: ${s.qname} (${s.path}:${s.start_line}) is one of ${ex.defs} definitions named "${s.name}".`,
        `  grep -w ${s.name}: ${ex.grepLines} lines in ${ex.grepFiles} files to read through`,
        `  graph-indexer:   ${ex.uses} calls in ${ex.useFiles} file${ex.useFiles === 1 ? '' : 's'}, bound to this definition (scopes, imports, receiver types)`,
        `See them: ${cli} refs ${s.qname}`,
    ].join('\n');
}
