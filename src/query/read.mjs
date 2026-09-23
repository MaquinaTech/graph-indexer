/**
 * What a piece of code depends on, for reading it without searching: the definitions its lines use
 * that live outside those lines, with where each one is and its signature.
 *
 * An agent exploring code reads a function, meets a name, searches for its definition, reads that,
 * meets another name… one hop per call. The index already resolved those names (scope, imports,
 * receiver types), so a read can carry the answers: this module ranks them and the tools render them
 * next to the code (a "defined elsewhere" card) and in hooks after the agent's own reads.
 */

// how much a use says about what the reader needs to know
const KIND_WEIGHT = { call: 1, new: 1, inherit: 1, type: 0.8, decorator: 0.6, value: 0.6, read: 0.5 };
const NAMED_KINDS = ['call', 'new', 'inherit', 'type', 'decorator'];
// what the reader most often needs next: code it calls and types it uses; data (fields, constants,
// enum members) comes after, its one-line definition is usually all there is to it
const TARGET_WEIGHT = (kind) => (['field', 'property', 'variable', 'constant'].includes(kind) ? 0.35 : 1);
const DEFINITION_KINDS = ['function', 'method', 'constructor', 'class', 'interface', 'struct', 'trait', 'enum', 'type', 'constant', 'macro', 'object', 'module'];

/**
 * Definitions used by lines [from, to] of `file` that are defined outside that range.
 *
 * Bound references come from the resolver; a name that stayed unbound is included when exactly one
 * definition in the repository's non-test code carries it (marked `byName`). Ranked by how the code
 * uses them (calls, instantiations and base types first; more uses first), then by first use.
 *
 * @param {object} opts
 * @param {number} [opts.max] rows returned in `rows`; the rest go to `more`
 * @param {Set<number>} [opts.skipIds] definitions not to list (already shown to the reader)
 * @param {Set<number>} [opts.skipAncestorsOf] symbol id whose enclosing definitions are not listed
 * @returns {{ rows: object[], more: object[] }}
 */
export function definitionsUsed(intel, file, from, to, { max = 10, skipIds = new Set(), skipAncestorsOf = null } = {}) {
    const f = intel.store.get('SELECT id FROM files WHERE path = ?', file);
    if (!f) return { rows: [], more: [] };
    const skip = new Set(skipIds);
    for (let p = skipAncestorsOf != null ? intel.store.get('SELECT parent_id FROM symbols WHERE id = ?', skipAncestorsOf)?.parent_id : null; p != null;
        p = intel.store.get('SELECT parent_id FROM symbols WHERE id = ?', p)?.parent_id) skip.add(p);
    const refs = intel.store.all('SELECT name, kind, line, dst_id, conf FROM refs WHERE file_id = ? AND line BETWEEN ? AND ? ORDER BY line', f.id, from, to);
    const bound = new Map(), unbound = new Map();
    for (const r of refs) {
        const w = KIND_WEIGHT[r.kind] ?? 0.5;
        if (r.dst_id != null) {
            // weak name-only bindings of plain values are mostly locals that share a global's name
            if ((r.kind === 'value' || r.kind === 'read') && (r.conf ?? 1) < 0.5) continue;
            const e = bound.get(r.dst_id) ?? bound.set(r.dst_id, { n: 0, score: 0, first: r.line }).get(r.dst_id);
            e.n++; e.score += w * Math.max(0.3, r.conf ?? 1);
        } else if (NAMED_KINDS.includes(r.kind)) {
            const e = unbound.get(r.name) ?? unbound.set(r.name, { n: 0, score: 0, first: r.line }).get(r.name);
            e.n++; e.score += w * 0.5;
        }
    }
    const inView = (s) => s.path === file && s.start_line >= from && s.end_line <= to;
    const rows = [];
    const get = intel.store.q(`SELECT s.id, s.name, s.qname, s.kind, s.start_line, s.end_line, s.sig, s.doc, s.type, f.path, f.is_test
        FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`);
    for (const [id, e] of bound) {
        if (skip.has(id)) continue;
        const s = get.get(id);
        if (!s || inView(s)) continue;
        rows.push({ ...s, ...e, score: e.score * TARGET_WEIGHT(s.kind), byName: false });
    }
    const seen = new Set(rows.map(r => r.id));
    for (const [name, e] of unbound) {
        const cands = intel.store.all(`SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
            WHERE s.name = ? AND f.is_test = 0 AND s.kind IN (${DEFINITION_KINDS.map(() => '?').join(',')}) LIMIT 2`, name, ...DEFINITION_KINDS);
        if (cands.length !== 1 || seen.has(cands[0].id) || skip.has(cands[0].id)) continue;
        const s = get.get(cands[0].id);
        if (!s || inView(s)) continue;
        seen.add(s.id);
        rows.push({ ...s, ...e, score: e.score * TARGET_WEIGHT(s.kind), byName: true });
    }
    rows.sort((a, b) => b.score - a.score || a.first - b.first);
    return { rows: rows.slice(0, max), more: rows.slice(max) };
}

/** Test functions that reference a definition (directly), for "which tests exercise this". */
export function testsUsing(intel, id, { max = 3 } = {}) {
    return intel.store.all(`SELECT f.path, COALESCE(s.qname, '(module)') AS qname, MIN(r.line) AS line FROM refs r
        JOIN files f ON f.id = r.file_id LEFT JOIN symbols s ON s.id = r.src_id
        WHERE r.dst_id = ? AND f.is_test = 1 GROUP BY f.path, s.qname ORDER BY f.path, line LIMIT ?`, id, max + 1);
}
