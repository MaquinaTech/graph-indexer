/**
 * Resolved indirection: conclusions about a piece of code that an agent would otherwise derive by
 * searching and reasoning, one hop per call.
 *
 * Measured on the fourth benchmark round: before its first edit an agent spends most of its thought
 * working out which code actually runs — which override of a method a subclass uses, which entry of a
 * registration table (`TRANSFORMS = {exp.Concat: …}`) handles a key, which method a name-built
 * `getattr(self, f"{key}_sql")` reaches, what a decorator does. Serving where names are defined
 * (evidence) did not lower that thought; these facts serve the conclusion itself, with its location,
 * so the agent can cite it instead of deriving it. Everything here is static analysis of the index and
 * the source text: nothing is imported or executed.
 *
 *   overrides    a method defined in the lines: what it overrides, which subclasses override it and
 *                which inherit it unchanged (those run it as their own)
 *   dispatch     a call through self/this in the lines to a method that subclasses override
 *   handler      a function registered as a value in a table (dict/object literal keyed by classes,
 *                constants or strings): which table, which key, in which class
 *   key          a class defined in the lines that is a key of such tables: which handler each class uses
 *   by-name      a method reached by a name built at run time (getattr/hasattr with a prefix or suffix)
 *   decorator    what a decorator applied in the lines is (its definition and first doc line)
 *
 * Each fact says whether it is exact (bound by the index) or heuristic (a naming convention).
 */

const CALLABLE = new Set(['function', 'method', 'constructor', 'class']);
const MEMBER = new Set(['method', 'function', 'constructor', 'property']);

// the first sentence of a docstring: what the definition is for
const firstSentence = (doc) => {
    const t = String(doc ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const m = /^(.{12,200}?[.!?])(\s|$)/.exec(t);
    return (m ? m[1] : t.slice(0, 140)).replace(/\s+(Parameters|Args|Arguments|Returns)\b.*$/, '');
};
const loc = (s) => `${s.path}:${s.start_line}`;
const short = (s) => s.qname ?? s.name;

// ── registration tables ───────────────────────────────────────────────────────
// Python dicts, JS/TS objects, PHP arrays and Ruby hashes whose entries map a key to code:
//   KEY: handler,  "KEY": lambda self: self._parse_x(),  [Kind.X]: fn,  'key' => [Cls::class, 'm'],  **Base.TABLE / ...base
const ENTRY = /^\s*(\[?[A-Za-z_][\w.]*\]?|"[^"\n]*"|'[^'\n]*')\s*(?::(?!:)|=>)/;
const SPREAD = /^\s*(?:\*\*|\.\.\.)([A-Za-z_][\w.]*)\s*,?\s*$/;
const OPENS = /(?:=|:|=>)\s*(?:\{|\[|array\()\s*(?:#.*|\/\/.*)?$/;

function tablesOf(intel) {
    const version = intel.ix?.version ?? 0;
    if (intel._tables?.version === version) return intel._tables;
    const tables = new Map(), byHandler = new Map(), byKey = new Map();
    const fields = intel.store.all(`SELECT s.id, s.qname, s.name, s.parent_id, s.start_line, s.end_line, f.path, f.id AS file_id
        FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.kind IN ('field', 'variable', 'constant', 'property') AND s.end_line - s.start_line >= 2 AND f.is_test = 0`);
    const refsIn = intel.store.q(`SELECT r.kind, r.name, r.line, r.dst_id, d.kind AS dst_kind FROM refs r LEFT JOIN symbols d ON d.id = r.dst_id
        WHERE r.file_id = ? AND r.line BETWEEN ? AND ? ORDER BY r.line, r.col`);
    for (const f of fields) {
        const lines = intel.fileLines(f.path);
        if (!lines || !OPENS.test(lines[f.start_line - 1] ?? '')) continue;
        const entries = [], spreads = [];
        let cur = null;
        for (let n = f.start_line + 1; n <= f.end_line; n++) {
            const sp = SPREAD.exec(lines[n - 1] ?? '');
            if (sp) { spreads.push({ line: n, text: sp[1] }); continue; }
            const m = ENTRY.exec(lines[n - 1] ?? '');
            if (!m) continue;
            cur = { key: m[1].replace(/^\[|\]$/g, ''), line: n, end: n };
            entries.push(cur);
        }
        if (!entries.length && !spreads.length) continue;
        const starts = [...entries.map(e => e.line), ...spreads.map(x => x.line)].sort((a, b) => a - b);
        for (const e of entries) e.end = (starts.find(l => l > e.line) ?? f.end_line + 1) - 1;
        const refs = refsIn.all(f.file_id, f.start_line, f.end_line);
        const t = { id: f.id, qname: f.qname, name: f.name, owner: f.parent_id, path: f.path, line: f.start_line, parents: [], entries: [] };
        for (const s of spreads) {
            const r = refs.find(x => x.line === s.line && x.dst_id != null && x.name === s.text.split('.').pop());
            if (r) t.parents.push(r.dst_id);
        }
        for (const e of entries) {
            const keyName = e.key.split('.').pop();
            const inEntry = refs.filter(r => r.line >= e.line && r.line <= e.end);
            const keyRef = inEntry.find(r => r.line === e.line && r.name === keyName && r.dst_id != null);
            const handlers = [...new Set(inEntry.filter(r => r !== keyRef && r.dst_id != null && (r.kind === 'value' || r.kind === 'call' || r.kind === 'new')
                && CALLABLE.has(r.dst_kind)).map(r => r.dst_id))];
            if (!handlers.length) continue;
            t.entries.push({ key: e.key, keyId: keyRef?.dst_id ?? null, line: e.line, handlers });
        }
        // a table is a registry when most of its entries map to code
        if (t.entries.length < 2 && !t.parents.length) continue;
        if (t.entries.length < Math.max(2, entries.length / 3) && !t.parents.length) continue;
        tables.set(t.id, t);
    }
    // inherited tables: a subclass that redefines TABLE with `**Base.TABLE` extends it
    for (const t of tables.values()) {
        for (const e of t.entries) {
            for (const h of e.handlers) (byHandler.get(h) ?? byHandler.set(h, []).get(h)).push({ table: t, entry: e });
            const k = e.keyId ?? `"${e.key}"`;
            (byKey.get(k) ?? byKey.set(k, []).get(k)).push({ table: t, entry: e });
        }
    }
    intel._tables = { version, tables, byHandler, byKey };
    return intel._tables;
}

// ── dispatch by a name built at run time ──────────────────────────────────────
//   getattr(self, f"{expression.key}_sql")  ·  getattr(self, "visit_" + node)  ·  hasattr(self, f"_parse_{x}")
const BUILT_NAME = /\b(?:getattr|hasattr)\(\s*(?:self|cls|this|[a-z_]\w*)\s*,\s*(?:f["']([A-Za-z_]*)\{[^}]+\}([A-Za-z_]*)["']|["']([A-Za-z_]+)["']\s*\+|[\w.]+\s*\+\s*["']([A-Za-z_]+)["'])/;

const BUILT_ASSIGN = /\b\w+\s*=\s*(?:f["']([A-Za-z_]*)\{[^}]+\}([A-Za-z_]*)["']|["']([A-Za-z_]+)["']\s*\+|[\w.]+\s*\+\s*["']([A-Za-z_]+)["'])\s*$/;

// a registry built by scanning names: `for name in dir(cls): if name.endswith("_sql")` / `startswith("visit_")`
const NAME_FILTER = /\.(endswith|startswith)\(\s*["']([A-Za-z_]{3,})["']\s*\)/;
const SCANS_NAMES = /\b(?:dir|vars|getmembers|inspect\.getmembers)\(|__dict__|\bgetattr\(/;
const CONVENTION_HINT = /getattr\(|hasattr\(|endswith\(|startswith\(/;

function conventionsOf(intel) {
    const version = intel.ix?.version ?? 0;
    if (intel._conventions?.version === version) return intel._conventions.list;
    const list = [];
    const seen = new Set();
    const files = intel.store.all(`SELECT id, path FROM files WHERE is_test = 0 AND lang IN ('python', 'javascript', 'typescript', 'tsx', 'ruby', 'php')`);
    for (const f of files) {
        const lines = intel.fileLines(f.path);
        if (!lines) continue;
        for (let i = 0; i < lines.length; i++) {
            const text = lines[i];
            if (!CONVENTION_HINT.test(text)) continue;
            let m = BUILT_NAME.exec(text), prefix = null, suffix = null, shown = text.trim();
            if (m) { prefix = m[1] ?? m[3] ?? ''; suffix = m[2] ?? m[4] ?? ''; }
            else if (/\b(?:getattr|hasattr)\(/.test(text)) {
                // the name built a few lines earlier: handler = f"{expression.key}_sql"; getattr(self, handler)
                for (let n = Math.max(0, i - 12); n < i && !m; n++) {
                    m = BUILT_ASSIGN.exec(lines[n]);
                    if (m) { prefix = m[1] ?? m[3] ?? ''; suffix = m[2] ?? m[4] ?? ''; shown = `${lines[n].trim()} … ${text.trim()}`; }
                }
            }
            if (!m && (m = NAME_FILTER.exec(text))) {
                // only a registry when the same few lines enumerate names (dir(cls), vars(), getattr)
                const near = lines.slice(Math.max(0, i - 6), i + 7).join('\n');
                if (!SCANS_NAMES.test(near)) m = null;
                else if (m[1] === 'endswith') { prefix = ''; suffix = m[2]; } else { prefix = m[2]; suffix = ''; }
            }
            if (!m || (prefix + suffix).length < 3) continue;
            const line = i + 1;
            const site = intel.store.get(`SELECT id FROM symbols WHERE file_id = ? AND start_line <= ? AND end_line >= ? AND kind IN ('function', 'method')
                ORDER BY end_line - start_line LIMIT 1`, f.id, line, line);
            const caller = site ? intel.sym(site.id) : null;
            // whose members the convention reaches: the caller's class, or the classes of the file for a module function
            const owners = caller?.parent_id != null ? [caller.parent_id]
                : intel.store.all(`SELECT id FROM symbols WHERE file_id = ? AND kind = 'class' AND parent_id IS NULL`, f.id).map(r => r.id);
            const key = `${owners.join(',')}|${prefix}|${suffix}`;
            if (seen.has(key)) continue;
            seen.add(key);
            list.push({ prefix, suffix, owners, caller, path: f.path, line, text: shown.slice(0, 120) });
        }
    }
    intel._conventions = { version, list };
    return list;
}

/** The convention through which a method is called by a built name, if any: its site and the key stem. */
function reachedByName(intel, sym) {
    if (!MEMBER.has(sym.kind) || sym.parent_id == null) return null;
    for (const c of conventionsOf(intel)) {
        if (!sym.name.startsWith(c.prefix) || !sym.name.endsWith(c.suffix) || sym.name.length <= c.prefix.length + c.suffix.length) continue;
        if (c.owners.length && !c.owners.some(o => o === sym.parent_id || isSubtypeOf(intel, sym.parent_id, o))) continue;
        return { ...c, stem: sym.name.slice(c.prefix.length, sym.name.length - c.suffix.length) };
    }
    return null;
}

function isSubtypeOf(intel, typeId, superId, depth = 0) {
    if (typeId === superId) return true;
    if (depth > 6 || typeId == null) return false;
    for (const { dst_id } of intel.store.all("SELECT DISTINCT dst_id FROM refs WHERE src_id = ? AND kind = 'inherit' AND dst_id IS NOT NULL", typeId)) {
        if (isSubtypeOf(intel, dst_id, superId, depth + 1)) return true;
    }
    return false;
}

// ── facts for lines an agent reads ────────────────────────────────────────────
/**
 * Facts about lines [from, to] of `file`, ranked, at most `max`.
 * @param {object} opts
 * @param {Set<string>} [opts.shown] fact keys already given in this session (not repeated)
 * @returns {{ text: string, kind: string, tier: 'exact'|'heuristic', targets: number[], key: string }[]}
 */
export function factsForRange(intel, file, from, to, { max = 6, shown = new Set() } = {}) {
    const f = intel.store.get('SELECT id FROM files WHERE path = ?', file);
    if (!f) return [];
    const defs = intel.store.all(`SELECT s.id FROM symbols s WHERE s.file_id = ? AND s.start_line <= ? AND s.end_line >= ?
        AND s.kind IN ('function', 'method', 'constructor', 'property', 'class', 'interface', 'struct', 'trait') ORDER BY s.start_line`, f.id, to, from)
        .map(r => intel.sym(r.id)).filter(Boolean)
        // a definition the lines show (at least half of it, or its header) — not the class that merely encloses them
        .filter(s => s.start_line >= from || (Math.min(to, s.end_line) - Math.max(from, s.start_line) + 1) >= (s.end_line - s.start_line + 1) / 2);
    const out = [];
    const push = (fact, score) => { if (!shown.has(fact.key) && !out.some(o => o.key === fact.key)) out.push({ ...fact, score }); };

    const T = tablesOf(intel);
    for (const s of defs) {
        if (MEMBER.has(s.kind)) {
            // handler registered in tables
            const regs = T.byHandler.get(s.id) ?? [];
            if (regs.length) {
                const first = regs.slice(0, 3).map(({ table, entry }) => `${entry.key} in ${table.qname} (${table.path}:${entry.line})`);
                push({ kind: 'handler', tier: 'exact', key: `handler:${s.id}`, targets: regs.map(r => r.table.id),
                    text: `${s.name} is registered as the handler of ${first.join('; ')}${regs.length > 3 ? `; and ${regs.length - 3} more entries` : ''}` }, 5);
            }
            // reached by a name built at run time
            const conv = reachedByName(intel, s);
            if (conv) {
                const keyCls = intel.store.all(`SELECT s.id, s.qname, f.path, s.start_line FROM symbols s JOIN files f ON f.id = s.file_id
                    WHERE s.name_lc = ? AND s.kind = 'class' AND f.is_test = 0 LIMIT 3`, conv.stem.replace(/_/g, '').toLowerCase());
                push({ kind: 'by-name', tier: 'heuristic', key: `byname:${s.id}`, targets: [conv.caller?.id, ...keyCls.map(k => k.id)].filter(x => x != null),
                    text: `${s.name} is called by name from ${conv.caller ? short(conv.caller) : conv.path} (${conv.path}:${conv.line}: ${conv.text.slice(0, 80)})`
                        + (keyCls.length ? ` — for ${keyCls.map(k => `${k.qname} (${k.path}:${k.start_line})`).join(', ')}` : '') + ' [name convention]' }, 4);
            }
            // overrides and inheritors
            if (s.kind === 'method' || s.kind === 'property') {
                const fam = intel.methodFamily(s);
                const inh = intel.inheritance(s.id, { max: 40 });
                const parts = [];
                if (fam.up.length) parts.push(`overrides ${fam.up.slice(0, 2).map(u => `${short(u)} (${loc(u)})`).join(', ')}`);
                if (inh.override.length) parts.push(`overridden in ${inh.override.length} subclass${inh.override.length > 1 ? 'es' : ''}: ${inh.override.slice(0, 4).map(o => `${o.name} (${o.path})`).join(', ')}${inh.override.length > 4 ? ', …' : ''}`);
                if (inh.inherit.length) parts.push(`inherited unchanged by ${inh.inherit.length}: ${inh.inherit.slice(0, 5).map(o => o.name).join(', ')}${inh.inherit.length > 5 ? ', …' : ''}`);
                if (parts.length && (fam.up.length || inh.override.length || inh.inherit.length >= 1)) {
                    const downIds = fam.down.map(d => d.id);
                    push({ kind: 'overrides', tier: 'exact', key: `ovr:${s.id}`, targets: [...fam.up.map(u => u.id), ...downIds],
                        text: `${s.qname}: ${parts.join('; ')}` }, inh.override.length || inh.inherit.length ? 4 : 2);
                }
            }
            // decorators
            for (const d of intel.store.all(`SELECT DISTINCT r.dst_id FROM refs r WHERE r.file_id = ? AND r.kind = 'decorator' AND r.dst_id IS NOT NULL
                AND r.line BETWEEN ? AND ?`, f.id, Math.max(1, s.start_line - 6), s.start_line)) {
                const dec = intel.sym(d.dst_id);
                if (!dec || !CALLABLE.has(dec.kind) || dec.is_test) continue;
                const doc = firstSentence(dec.doc);
                push({ kind: 'decorator', tier: 'exact', key: `dec:${dec.id}`, targets: [dec.id],
                    text: `@${dec.name} is ${short(dec)} (${loc(dec)})${doc ? `: ${doc.slice(0, 140)}` : ''}` }, 2);
            }
        } else if (s.kind === 'class') {
            // a class used as a key of registration tables
            const regs = T.byKey.get(s.id) ?? [];
            if (regs.length) {
                const per = regs.slice(0, 4).map(({ table, entry }) => `${table.qname} → ${entry.handlers.map(h => intel.sym(h)?.name).filter(Boolean).join('/')} (${table.path}:${entry.line})`);
                push({ kind: 'key', tier: 'exact', key: `key:${s.id}`, targets: regs.flatMap(r => r.entry.handlers),
                    text: `${s.name} is a key of ${regs.length} table entr${regs.length > 1 ? 'ies' : 'y'}: ${per.join('; ')}${regs.length > 4 ? '; …' : ''}` }, 5);
            }
            // handled by a method whose name is built from the class name
            for (const c of conventionsOf(intel)) {
                const want = `${c.prefix}${s.name.toLowerCase()}${c.suffix}`;
                const m = intel.store.all(`SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name_lc = ? AND f.is_test = 0 LIMIT 6`, want.toLowerCase())
                    .map(r => intel.sym(r.id)).filter(x => x && x.parent_id != null && (!c.owners.length || c.owners.some(o => o === x.parent_id || isSubtypeOf(intel, x.parent_id, o))));
                if (!m.length) continue;
                push({ kind: 'by-name', tier: 'heuristic', key: `keyname:${s.id}:${c.prefix}${c.suffix}`, targets: m.map(x => x.id),
                    text: `${s.name} is handled by name (${c.path}:${c.line}) by ${m.slice(0, 3).map(x => `${short(x)} (${loc(x)})`).join(', ')}${m.length > 3 ? ', …' : ''} [name convention]` }, 3);
                break;
            }
        }
    }
    // registration tables defined in the lines: what they extend and which inherited keys they replace
    for (const t of T.tables.values()) {
        if (t.path !== file || t.line < from || t.line > to) continue;
        const inherited = new Map(); // key -> table that defines it
        const visit = (id, depth) => {
            const p = T.tables.get(id);
            if (!p || depth > 6) return;
            for (const e of p.entries) if (!inherited.has(e.key)) inherited.set(e.key, p);
            for (const q of p.parents) visit(q, depth + 1);
        };
        for (const p of t.parents) visit(p, 0);
        const parents = t.parents.map(p => T.tables.get(p) ?? intel.sym(p)).filter(Boolean);
        const replaced = t.entries.filter(e => inherited.has(e.key)).map(e => e.key);
        const subs = [...T.tables.values()].filter(x => x.parents.includes(t.id));
        const parts = [];
        if (parents.length) parts.push(`extends ${parents.map(p => `${p.qname} (${p.path}:${p.line ?? p.start_line})`).join(', ')} with ${t.entries.length} entries`
            + (replaced.length ? `, ${replaced.length} replacing inherited ones (${replaced.slice(0, 6).join(', ')}${replaced.length > 6 ? ', …' : ''})` : ', none replacing inherited ones'));
        // entries for a key whose class a method also handles by name (the table entry is the one to read)
        const shadow = [];
        for (const e of t.entries) {
            if (shadow.length >= 4 || e.keyId == null) continue;
            const k = intel.sym(e.keyId);
            if (!k || k.kind !== 'class') continue;
            for (const c of conventionsOf(intel)) {
                const m = intel.store.all(`SELECT s.id FROM symbols s WHERE s.name_lc = ? AND s.parent_id IS NOT NULL LIMIT 4`, `${c.prefix}${k.name}${c.suffix}`.toLowerCase())
                    .map(r => intel.sym(r.id)).filter(x => x && (!c.owners.length || c.owners.some(o => o === x.parent_id || isSubtypeOf(intel, x.parent_id, o))));
                if (m.length && t.owner != null && m.some(x => x.parent_id === t.owner || isSubtypeOf(intel, t.owner, x.parent_id))) { shadow.push(`${e.key} (also ${short(m[0])} by name, ${loc(m[0])})`); break; }
            }
        }
        if (shadow.length) parts.push(`entries for keys also handled by a method by name: ${shadow.join(', ')}`);
        if (subs.length) parts.push(`extended by ${subs.length}: ${subs.slice(0, 5).map(x => x.qname).join(', ')}${subs.length > 5 ? ', …' : ''}`);
        if (parts.length) push({ kind: 'table', tier: 'exact', key: `tbl:${t.id}`, targets: [...t.parents, ...subs.map(x => x.id)], text: `${t.qname} ${parts.join('; ')}` }, 3);
    }
    // calls through self/this in the lines to methods that subclasses override
    const calls = intel.store.all(`SELECT r.line, r.name, r.dst_id FROM refs r WHERE r.file_id = ? AND r.kind = 'call' AND r.dst_id IS NOT NULL
        AND r.line BETWEEN ? AND ? AND r.recv IN ('self', 'this', 'cls', '$this', 'static') ORDER BY r.line`, f.id, from, to);
    const seenDst = new Set();
    for (const c of calls) {
        if (seenDst.has(c.dst_id)) continue;
        seenDst.add(c.dst_id);
        const target = intel.sym(c.dst_id);
        if (!target || target.kind !== 'method') continue;
        const down = intel.methodFamily(target).down;
        if (!down.length) continue;
        push({ kind: 'dispatch', tier: 'exact', key: `dsp:${c.dst_id}`, targets: [c.dst_id, ...down.map(d => d.id)],
            text: `self.${c.name}() (line ${c.line}) runs ${short(target)} (${loc(target)}) or one of ${down.length} override${down.length > 1 ? 's' : ''}: ${down.slice(0, 4).map(d => `${short(d)} (${loc(d)})`).join(', ')}${down.length > 4 ? ', …' : ''}` }, 3);
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, max);
}

/** The same facts for one definition (all of its lines). */
export function factsForSymbol(intel, id, opts = {}) {
    const s = intel.sym(id);
    return s ? factsForRange(intel, s.path, s.start_line, s.end_line, opts) : [];
}

/** Every table entry keyed by a class, constant or string, and the handler each table maps it to. */
export function handlersOfKey(intel, keyIdOrText) {
    const T = tablesOf(intel);
    return (T.byKey.get(keyIdOrText) ?? []).map(({ table, entry }) => ({ table: table.qname, path: table.path, line: entry.line, handlers: entry.handlers.map(h => intel.sym(h)).filter(Boolean) }));
}

/** Render facts as lines for tool output and hooks. */
export function renderFacts(facts) {
    return facts.map(f => `• ${f.text}`);
}
