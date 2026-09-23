/**
 * CodeIntel: the query facade used by the MCP tools and the CLI.
 *
 * Every public query first calls ensureFresh(): files touched since the last check are
 * re-indexed before answering, and the files a result points into are re-validated, so an agent
 * that just edited code never receives stale line numbers or stale call graphs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../store/db.mjs';
import { Indexer } from '../index/indexer.mjs';
import { SearchEngine } from '../search/search.mjs';
import { computeCentrality, loadGraph } from '../index/graph.mjs';
import { confidenceLabel } from '../index/resolver.mjs';
import { dataDir } from '../util/paths.mjs';

const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'type', 'object', 'module', 'impl']);
const CALLABLE = new Set(['function', 'method', 'constructor', 'macro']);
const DEP_KINDS = ['call', 'new', 'inherit', 'type', 'decorator', 'value', 'read'];
const CONSTRUCTORS = new Set(['constructor', '__init__', '__new__', 'initialize', '__construct']);
// examples, docs snippets and sample apps are visited after library code and tests
const EXAMPLE_PATH = /(^|\/)(docs?_src|docs?|examples?|samples?|demos?|tutorials?|benchmarks?|playground)\//i;

export class CodeIntel {
    constructor({ root, dbPath = null, log = () => {}, watch = false }) {
        this.root = path.resolve(root);
        this.dbPath = dbPath ?? path.join(dataDir(this.root), 'index.db');
        this.log = log;
        this.watchEnabled = watch;
        this.dirty = new Set();
        this.lastSweep = 0;
        this.sweepIntervalMs = 3000;
        this.watcher = null;
        this.watcherHealthy = false;
        this.lastSyncStats = null;
        this.fileCache = new Map();
        this._centrality = null;
        this._centralityVersion = -1;
        this.indexing = null;
    }

    // ── lifecycle ────────────────────────────────────────────────────────────────
    /**
     * Open the store and reconcile with the working tree. With `background: true` the initial
     * sync runs asynchronously (queries answer from the partial index meanwhile) — used by the
     * MCP server so the first tool call never times out on a large repository.
     */
    async open({ onProgress = null, background = false } = {}) {
        this.store = new Store(this.dbPath);
        this.ix = new Indexer({ root: this.root, store: this.store, log: this.log });
        this.ix.load();
        this.search = new SearchEngine(this.ix, { centrality: () => this.centrality() });
        if (this.watchEnabled) this.#startWatcher();
        this.initialDone = false;
        this.progress = null;
        const p = this.ix.sync({ onProgress: (done, total) => { this.progress = { done, total }; onProgress?.(done, total); } })
            .then((res) => { this.lastSyncStats = res; this.lastSweep = Date.now(); this.initialDone = true; this.progress = null; return res; })
            .finally(() => { if (this.indexing === p) this.indexing = null; });
        this.indexing = p;
        this.ready = p;
        if (!background) await p;
        return background ? null : p;
    }

    close() {
        try { this.watcher?.close(); } catch { /* closed */ }
        this.store?.close();
    }

    #startWatcher() {
        try {
            this.watcher = fs.watch(this.root, { recursive: true, persistent: false }, (_ev, file) => {
                if (!file) { this.lastSweep = 0; return; }
                const rel = String(file).split(path.sep).join('/');
                if (rel.startsWith('.git/') || rel.includes('/.git/') || rel.startsWith('.graph-indexer/') || rel.includes('node_modules/')) return;
                this.dirty.add(rel);
            });
            this.watcher.on?.('error', () => { this.watcherHealthy = false; });
            this.watcherHealthy = true;
        } catch (e) {
            this.log(`file watcher unavailable (${e.message}); falling back to periodic stat sweeps`);
            this.watcherHealthy = false;
        }
    }

    /**
     * Freshness contract: before answering, apply pending file changes. With a healthy watcher we
     * re-index only the dirty paths (plus a periodic full sweep as a safety net); without one we
     * do a stat sweep at most every few seconds (cheap: size+mtime compare).
     */
    async ensureFresh() {
        if (!this.initialDone) return null; // initial build in progress: answer from the partial index
        if (this.indexing) await this.indexing;
        const now = Date.now();
        const sweepDue = now - this.lastSweep > (this.watcherHealthy ? 30_000 : this.sweepIntervalMs);
        let res = null;
        if (sweepDue) {
            this.dirty.clear();
            this.indexing = this.ix.sync();
            try { res = await this.indexing; } finally { this.indexing = null; }
            this.lastSweep = Date.now();
        } else if (this.dirty.size) {
            const paths = [...this.dirty];
            this.dirty.clear();
            this.indexing = this.ix.syncPaths(paths);
            try { res = await this.indexing; } finally { this.indexing = null; }
        }
        if (res && (res.changed || res.added || res.removed)) this.lastSyncStats = { ...res, at: Date.now() };
        return res;
    }

    /** Re-validate specific files right before rendering them (cheap stat). */
    async revalidate(paths) {
        const stale = this.ix.staleAmong(paths);
        if (stale.length) await this.ix.syncPaths(stale);
        return stale;
    }

    centrality() {
        if (this._centralityVersion !== this.ix.version || !this._centrality) {
            this._centrality = computeCentrality(this.store);
            this._centralityVersion = this.ix.version;
        }
        return this._centrality;
    }

    // ── source access ────────────────────────────────────────────────────────────
    fileLines(rel) {
        const abs = path.join(this.root, rel);
        let st;
        try { st = fs.statSync(abs); } catch { return null; }
        const key = rel;
        const c = this.fileCache.get(key);
        if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.lines;
        let text;
        try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
        const lines = text.split(/\r?\n/);
        this.fileCache.set(key, { mtime: st.mtimeMs, size: st.size, lines });
        if (this.fileCache.size > 256) this.fileCache.delete(this.fileCache.keys().next().value);
        return lines;
    }

    // ── symbol lookup ────────────────────────────────────────────────────────────
    sym(id) {
        return this.store.get(`SELECT s.*, f.path, f.lang, f.is_test FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`, id) ?? null;
    }

    /**
     * Resolve a user-supplied target to symbols. Accepts:
     *   `name` · `Class.method` · `path/file.ts:Class.method` · `path/file.ts#qname` · `path/file.ts:42`
     * @returns {{ matches: object[], how: string }}
     */
    findSymbols(target, { limit = 20 } = {}) {
        let t = String(target).trim().replace(/\(\)$/, '');
        if (t.startsWith(this.root + '/')) t = t.slice(this.root.length + 1); // absolute path inside the repository
        let m = /^(.+?\.[A-Za-z0-9]+):(\d+)$/.exec(t);
        if (m) {
            const [, file, line] = m;
            const rows = this.store.all(`SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.start_line <= ? AND s.end_line >= ?
                ORDER BY (s.end_line - s.start_line) ASC LIMIT 1`, file.replace(/^\.\//, ''), Number(line), Number(line));
            return { matches: rows.map(r => this.sym(r.id)), how: 'location' };
        }
        m = /^(.+?\.[A-Za-z0-9]+)[:#](.+)$/.exec(t);
        if (m) {
            const [, file, q] = m;
            const rows = this.store.all(`SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND (s.qname = ? OR s.name = ? OR s.qname LIKE ?) ORDER BY s.qname = ? DESC, s.start_line LIMIT ?`,
                file.replace(/^\.\//, ''), q, q, '%.' + q, q, limit);
            return { matches: rows.map(r => this.sym(r.id)), how: 'file+name' };
        }
        const norm = t.replace(/::|#|->/g, '.');
        if (norm.includes('.')) {
            const name = norm.split('.').pop();
            const rows = this.store.all(`SELECT id, qname FROM symbols WHERE name = ?`, name).filter(r => r.qname === norm || r.qname.endsWith('.' + norm));
            if (rows.length) return { matches: this.#rank(rows.map(r => r.id)).slice(0, limit).map(id => this.sym(id)), how: 'qualified' };
        }
        let rows = this.store.all('SELECT id FROM symbols WHERE name = ?', norm.split('.').pop());
        if (!rows.length) rows = this.store.all('SELECT id FROM symbols WHERE name_lc = ?', norm.split('.').pop().toLowerCase());
        return { matches: this.#rank(rows.map(r => r.id)).slice(0, limit).map(id => this.sym(id)), how: 'name' };
    }

    /**
     * Order same-name candidates the way a developer means them: library code before tests and
     * example/sample apps, definitions that are used before unused copies, central before peripheral.
     */
    #rank(ids) {
        const cen = this.centrality();
        const meta = new Map(ids.map(id => [id, this.store.get(`SELECT f.is_test, f.path, s.kind, s.exported, (SELECT COUNT(*) FROM refs r WHERE r.dst_id = s.id) AS nrefs
            FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`, id)]));
        const score = (id) => {
            const m = meta.get(id);
            return (cen.get(id) ?? 0) + (m?.is_test ? -1 : 0) + (m && EXAMPLE_PATH.test(m.path) ? -0.8 : 0) + (m?.exported ? 0.2 : 0)
                + (TYPE_KINDS.has(m?.kind) || CALLABLE.has(m?.kind) ? 0.3 : 0) + Math.log1p(m?.nrefs ?? 0) * 0.1;
        };
        return [...ids].sort((a, b) => score(b) - score(a) || a - b);
    }

    members(id) {
        return this.store.all('SELECT id, name, qname, kind, start_line, end_line, sig, visibility FROM symbols WHERE parent_id = ? ORDER BY start_line', id);
    }

    /** Members declared outside the type body (Go/Rust/C++ receivers, JS prototype assignments). */
    ownedMembers(sym) {
        const t = this.ix.table;
        const ids = t.byOwner.get(sym.name) ?? [];
        const f = t.file(sym.file_id);
        return ids.map(id => t.sym(id)).filter(s => s && s.parentId !== sym.id && (t.file(s.fileId)?.dir === f?.dir || t.file(s.fileId)?.package === f?.package || s.fileId === sym.file_id))
            .map(s => this.store.get('SELECT s.id, s.name, s.qname, s.kind, s.start_line, s.end_line, s.sig, s.visibility, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?', s.id));
    }

    // ── references ───────────────────────────────────────────────────────────────
    /** Supertypes (resolved) of the type that declares a member, for dispatch-aware references. */
    #supertypeMembers(sym) {
        const t = this.ix.table, r = this.ix.resolver;
        const type = r.enclosingType(sym.id);
        if (!type) return [];
        const out = [];
        const seen = new Set();
        const visit = (typeSym, depth) => {
            if (!typeSym || depth > 5 || seen.has(typeSym.id)) return;
            seen.add(typeSym.id);
            for (const b of typeSym.bases ?? []) {
                const bt = r.resolveTypeName(b, typeSym.fileId);
                if (!bt) continue;
                for (const mid of this.#membersNamed(bt.id, sym.name)) if (!t.sym(mid)?.isStatic) out.push({ id: mid, via: bt.name });
                visit(bt, depth + 1);
            }
        };
        if (type.id != null) visit(t.sym(type.id), 0);
        return out;
    }

    /** Members of a type with a name: declared in its body, or outside it with the type as owner (Go, Rust, C++). */
    #membersNamed(typeId, name) {
        const t = this.ix.table;
        const ty = t.sym(typeId);
        const out = [...(t.byParent.get(typeId)?.get(name) ?? [])];
        if (ty) {
            const dir = path.posix.dirname(t.file(ty.fileId)?.path ?? '');
            for (const id of t.byOwner.get(ty.name) ?? []) {
                const m = t.sym(id);
                if (m && m.name === name && m.parentId !== typeId && path.posix.dirname(t.file(m.fileId)?.path ?? '') === dir && !out.includes(id)) out.push(id);
            }
        }
        return out;
    }

    /** Overload set: same qualified name, same file, same container (TS/Java/C#/C++ overloads). */
    overloads(sym) {
        return this.store.all('SELECT id FROM symbols WHERE file_id = ? AND qname = ? AND kind = ? AND (parent_id IS ? OR parent_id = ?) AND is_static = ?',
            sym.file_id, sym.qname, sym.kind, sym.parent_id, sym.parent_id, sym.is_static ? 1 : 0).map(r => r.id);
    }

    /** Is `memberId` one of the members `sym` overrides (declared in a supertype)? */
    #isSupertypeMemberOf(memberId, sym) {
        return this.#supertypeMembers(sym).some(s => s.id === memberId);
    }

    /** Members with the same name in subtypes (overrides/implementations), transitively. */
    #subtypeMembers(sym) {
        const t = this.ix.table, r = this.ix.resolver;
        const type = r.enclosingType(sym.id);
        if (!type || type.id == null) return [];
        const out = [];
        const seen = new Set([type.id]);
        let frontier = [type.id];
        for (let depth = 0; depth < 4 && frontier.length; depth++) {
            const next = [];
            for (const tid of frontier) {
                const subs = this.store.all("SELECT DISTINCT src_id FROM refs WHERE dst_id = ? AND kind = 'inherit' AND src_id IS NOT NULL", tid);
                for (const { src_id } of subs) {
                    if (seen.has(src_id)) continue;
                    seen.add(src_id);
                    next.push(src_id);
                    const st = t.sym(src_id);
                    for (const mid of this.#membersNamed(src_id, sym.name)) if (!t.sym(mid)?.isStatic) out.push({ id: mid, via: st?.name ?? '?' });
                }
            }
            frontier = next;
        }
        return out;
    }

    /**
     * String literals naming a member in code that works with its class or a subclass —
     * `sinon.stub(obj, 'name')`, `jest.spyOn(x, 'name')`, `getattr(o, "name")`,
     * `patch.object(C, "name")`, `patch("pkg.mod.C.name")`: uses no type checker sees, which a
     * rename has to update too. Test titles (`describe('name', …)`) are left out.
     * @returns {{ path: string, line: number, text: string }[]}
     */
    stringMentions(id, { max = 20 } = {}) {
        const sym = this.sym(id);
        if (!sym || !['method', 'property', 'field', 'function'].includes(sym.kind) || sym.name.length < 3) return [];
        const files = new Set(this.references(id, { family: true })?.groups.keys() ?? []);
        const type = this.ix.resolver.enclosingType(sym.id);
        if (type?.id != null) {
            const family = new Set([type.id]);
            let frontier = [type.id];
            for (let depth = 0; depth < 4 && frontier.length; depth++) {
                const next = [];
                for (const tid of frontier) {
                    for (const { src_id } of this.store.all("SELECT DISTINCT src_id FROM refs WHERE dst_id = ? AND kind = 'inherit' AND src_id IS NOT NULL", tid)) {
                        if (!family.has(src_id)) { family.add(src_id); next.push(src_id); }
                    }
                }
                frontier = next;
            }
            const ids = [...family];
            for (const { path: p } of this.store.all(`SELECT DISTINCT f.path FROM refs r JOIN files f ON f.id = r.file_id WHERE r.dst_id IN (${ids.map(() => '?').join(',')})`, ...ids)) files.add(p);
        } else files.add(sym.path);
        const name = sym.name.replace(/[$]/g, '\\$');
        const lit = new RegExp(`(['"\`])(?:[\\w.]*\\.)?${name}\\1`);
        const title = /^\s*(?:describe|it|test|context|suite)(?:\.\w+)?\s*\(/;
        const out = [];
        for (const f of [...files].sort()) {
            const lines = this.fileLines(f) ?? [];
            for (let i = 0; i < lines.length && out.length < max; i++) {
                if (lit.test(lines[i]) && !title.test(lines[i])) out.push({ path: f, line: i + 1, text: lines[i].trim() });
            }
        }
        return out;
    }

    /**
     * All references to a symbol, grouped by file. Includes its overload set and, for members,
     * the method family: calls through a supertype (may dispatch here) and calls to overrides in
     * subtypes — each labelled so the agent can tell direct uses from dispatch-related ones.
     * @returns {{ groups: Map<string, object[]>, total: number, unresolvedSameName: number }}
     */
    references(id, { kinds = null, includeTests = true, minConf = 0, family = true } = {}) {
        const sym = this.sym(id);
        if (!sym) return null;
        const ids = [...new Set([id, ...this.overloads(sym)])];
        const via = new Map();
        if (family && !sym.is_static && (sym.kind === 'method' || sym.kind === 'property' || sym.kind === 'field')) {
            for (const s of this.#supertypeMembers(sym)) if (!ids.includes(s.id)) { ids.push(s.id); via.set(s.id, s.via); }
            for (const s of this.#subtypeMembers(sym)) if (!ids.includes(s.id)) { ids.push(s.id); via.set(s.id, s.via); }
        }
        const rows = this.store.all(`SELECT r.id, r.kind, r.line, r.col, r.conf, r.ncand, r.recv, r.dst_id, f.path, f.is_test, src.qname AS src_qname, src.kind AS src_kind, src.start_line AS src_line
            FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols src ON src.id = r.src_id
            WHERE r.dst_id IN (${ids.map(() => '?').join(',')}) ORDER BY f.is_test, f.path, r.line`, ...ids); // production code before tests
        const out = [];
        for (const r of rows) {
            if (kinds && !kinds.includes(r.kind)) continue;
            if (!includeTests && r.is_test) continue;
            if (r.conf < minConf) continue;
            // `super().m()` binds statically to the parent's m: it cannot reach an override elsewhere
            if (r.recv === 'super' && via.has(r.dst_id) && this.#isSupertypeMemberOf(r.dst_id, sym)) continue;
            out.push({ ...r, via: via.get(r.dst_id) ?? null, confidence: confidenceLabel(via.has(r.dst_id) ? r.conf * 0.8 : r.conf) });
        }
        const unbound = this.#unboundSameName(sym, ids, { includeTests });
        const unresolved = unbound.total;
        // where the other references with this name went (lets an agent rule them out without grepping)
        const elsewhere = this.store.all(`SELECT d.qname, df.path, COUNT(*) AS n FROM refs r JOIN symbols d ON d.id = r.dst_id JOIN files df ON df.id = d.file_id
            JOIN files f ON f.id = r.file_id WHERE r.name = ? AND r.dst_id NOT IN (${ids.map(() => '?').join(',')})${includeTests ? '' : ' AND f.is_test = 0'}
            GROUP BY r.dst_id ORDER BY n DESC LIMIT 4`, sym.name, ...ids);
        const groups = new Map();
        for (const r of out) (groups.get(r.path) ?? groups.set(r.path, []).get(r.path)).push(r);
        return { sym, groups, total: out.length, unresolvedSameName: unresolved, unbound, elsewhere };
    }

    /**
     * Same-name call sites whose receiver type is unknown, split by plausibility: a call to
     * `Reflector.get` has to obtain a Reflector somewhere, so a site is plausible when its file
     * mentions the declaring type (or a related type) or its receiver is named after it
     * (`this.reflector.get`). The rest are in files that never mention the type.
     */
    #unboundSameName(sym, ids, { includeTests = true } = {}) {
        const rows = this.store.all(`SELECT r.line, r.recv, f.path FROM refs r JOIN files f ON f.id = r.file_id
            WHERE r.name = ? AND r.dst_id IS NULL AND r.kind IN ('call','new','decorator')${includeTests ? '' : ' AND f.is_test = 0'} ORDER BY f.is_test, f.path, r.line`, sym.name);
        if (!rows.length) return { total: 0, plausible: [], typeNames: [] };
        const typeNames = new Set();
        const owner = sym.parent_id != null ? this.sym(sym.parent_id) : null;
        if (owner && TYPE_KINDS.has(owner.kind)) typeNames.add(owner.name);
        for (const id of ids) {
            const s = id === sym.id ? null : this.sym(id);
            const o = s?.parent_id != null ? this.sym(s.parent_id) : null;
            if (o && TYPE_KINDS.has(o.kind)) typeNames.add(o.name);
        }
        if (!typeNames.size) {
            // a free function: plausible where its file is imported, or next to it
            const dir = path.posix.dirname(sym.path);
            const importers = new Set(this.store.all('SELECT DISTINCT f.path FROM imports i JOIN files f ON f.id = i.file_id WHERE i.target_file_id = ?', sym.file_id).map(r => r.path));
            const plausible = rows.filter(r => importers.has(r.path) || path.posix.dirname(r.path) === dir);
            return { total: rows.length, plausible, typeNames: [] };
        }
        const names = [...typeNames];
        const wordRe = new RegExp(`\\b(${names.map(n => n.replace(/[$]/g, '\\$')).join('|')})\\b`);
        const lower = names.map(n => n.toLowerCase());
        const mentions = new Map();
        const plausible = rows.filter(r => {
            const recv = (r.recv || '').toLowerCase();
            if (recv && lower.some(n => recv.includes(n))) return true;
            if (!mentions.has(r.path)) {
                const lines = this.fileLines(r.path);
                mentions.set(r.path, !!lines && lines.some(l => wordRe.test(l)));
            }
            return mentions.get(r.path);
        });
        return { total: rows.length, plausible, typeNames: names };
    }

    /** Outgoing references of a symbol (what it calls/uses), including nested closures. */
    callees(id, { kinds = ['call', 'new'] } = {}) {
        const sym = this.sym(id);
        if (!sym) return [];
        const scope = [id, ...this.store.all(`SELECT id FROM symbols WHERE file_id = ? AND start_line >= ? AND end_line <= ? AND id != ? AND kind IN ('function','method')`, sym.file_id, sym.start_line, sym.end_line, id).map(r => r.id)];
        const rows = this.store.all(`SELECT r.kind, r.line, r.name, r.recv, r.conf, r.ncand, r.dst_id, d.qname AS dst_qname, d.kind AS dst_kind, df.path AS dst_path, d.start_line AS dst_line
            FROM refs r LEFT JOIN symbols d ON d.id = r.dst_id LEFT JOIN files df ON df.id = d.file_id
            WHERE r.src_id IN (${scope.map(() => '?').join(',')}) AND r.kind IN (${kinds.map(() => '?').join(',')}) ORDER BY r.line`, ...scope, ...kinds);
        return rows;
    }

    /** Transitive callers/dependents (BFS over reverse edges), confidence multiplied along paths. */
    dependents(startIds, { depth = 3, maxNodes = 300, minConf = 0.3, kinds = DEP_KINDS } = {}) {
        const seen = new Map(); // id -> { depth, conf, via, kind, sites }
        const fileLevel = new Map(); // path -> { depth, conf, via, sites } for module-level references
        const overflow = new Set();  // dependents beyond maxNodes: counted, not expanded
        let frontier = [];
        for (const id of startIds) {
            seen.set(id, { depth: 0, conf: 1, via: null });
            frontier.push({ id, conf: 1 });
        }
        // overrides / implementations of a changed method must keep matching its signature
        for (const id of startIds) {
            const sym = this.sym(id);
            if (!sym || sym.is_static || sym.kind !== 'method') continue;
            for (const m of this.#subtypeMembers(sym)) {
                if (seen.has(m.id)) continue;
                seen.set(m.id, { depth: 1, conf: 0.9, via: id, kind: 'override', sites: [] });
                frontier.push({ id: m.id, conf: 0.9 });
            }
        }
        for (let d = 1; d <= depth && frontier.length; d++) {
            const next = [];
            for (const { id, conf } of frontier) {
                const sym = this.sym(id);
                const targets = [id];
                if (sym && !sym.is_static && (sym.kind === 'method' || sym.kind === 'property')) for (const s of this.#supertypeMembers(sym)) targets.push(s.id);
                // a constructor is invoked through its class: `new Foo()` / `Foo()` (Python)
                if (sym && CONSTRUCTORS.has(sym.name) && sym.parent_id != null) targets.push(sym.parent_id);
                const rows = this.store.all(`SELECT r.src_id, r.conf, r.kind, r.line, r.dst_id, r.recv, f.path, f.is_test FROM refs r JOIN files f ON f.id = r.file_id
                    WHERE r.dst_id IN (${targets.map(() => '?').join(',')}) AND r.kind IN (${kinds.map(() => '?').join(',')})`, ...targets, ...kinds);
                const rank = (r) => (EXAMPLE_PATH.test(r.path) ? 2 : r.is_test ? 1 : 0);
                rows.sort((a, b) => rank(a) - rank(b));
                for (const r of rows) {
                    // through the class only its instantiations reach the constructor
                    if (r.dst_id !== id && sym && CONSTRUCTORS.has(sym.name) && r.dst_id === sym.parent_id && r.kind !== 'call' && r.kind !== 'new') continue;
                    // `super().m()` runs exactly the parent's m, never this override (it is static dispatch)
                    if (r.dst_id !== id && r.recv === 'super') continue;
                    const c = conf * r.conf;
                    if (c < minConf) continue;
                    if (r.src_id == null) {
                        const prev = fileLevel.get(r.path);
                        if (!prev) fileLevel.set(r.path, { depth: d, conf: c, via: id, sites: [r.line] });
                        else { if (prev.conf < c) Object.assign(prev, { depth: d, conf: c, via: id }); if (prev.sites.length < 20) prev.sites.push(r.line); }
                        continue;
                    }
                    const prev = seen.get(r.src_id);
                    if (prev) {
                        if (prev.via === id && prev.sites && prev.sites.length < 20) prev.sites.push({ path: r.path, line: r.line });
                        if (prev.conf >= c) continue;
                    }
                    if (!prev && seen.size >= maxNodes + startIds.length) { overflow.add(r.src_id); continue; } // count, don't expand
                    seen.set(r.src_id, { depth: prev ? Math.min(prev.depth, d) : d, conf: c, via: id, kind: r.kind, sites: prev?.via === id ? prev.sites : [{ path: r.path, line: r.line }] });
                    if (!prev) next.push({ id: r.src_id, conf: c });
                }
            }
            frontier = next;
        }
        for (const s of startIds) seen.delete(s);
        return { nodes: seen, fileLevel, truncated: overflow.size > 0, overflow: overflow.size };
    }

    /** Members this method overrides/implements (up) and members overriding it (down). */
    methodFamily(sym) {
        const load = (list) => list.map(x => this.sym(x.id)).filter(Boolean);
        return { up: load(this.#supertypeMembers(sym)), down: load(this.#subtypeMembers(sym)) };
    }

    /** Unbound same-name call sites that may be uses of a symbol (see #unboundSameName). */
    unboundFor(id, opts = {}) {
        const sym = this.sym(id);
        if (!sym) return { total: 0, plausible: [], typeNames: [] };
        return this.#unboundSameName(sym, [id, ...this.overloads(sym)], opts);
    }

    // ── impact ───────────────────────────────────────────────────────────────────
    /** Symbols overlapping the working-tree diff (git), as impact seeds. */
    diffSeeds(base = 'HEAD') {
        const r = spawnSync('git', ['diff', '-U0', '--no-color', base, '--'], { cwd: this.root, encoding: 'utf8', maxBuffer: 1 << 28 });
        if (r.status !== 0) return { error: (r.stderr || 'git diff failed').trim(), seeds: [], files: [] };
        const changes = new Map();
        let file = null;
        for (const line of r.stdout.split('\n')) {
            if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); if (file === '/dev/null') file = null; continue; }
            const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (h && file) {
                const start = Number(h[1]), len = h[2] === undefined ? 1 : Number(h[2]);
                (changes.get(file) ?? changes.set(file, []).get(file)).push([start, Math.max(start, start + len - 1)]);
            }
        }
        const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: this.root, encoding: 'utf8' });
        for (const f of (untracked.stdout || '').split('\n').filter(Boolean)) if (!changes.has(f)) changes.set(f, [[1, 1e9]]);
        const seeds = new Set();
        for (const [f, ranges] of changes) {
            for (const [a, b] of ranges) {
                const rows = this.store.all(`SELECT s.id, s.start_line, s.end_line, s.kind FROM symbols s JOIN files fl ON fl.id = s.file_id WHERE fl.path = ? AND s.start_line <= ? AND s.end_line >= ?`, f, b, a);
                // innermost symbols only
                const inner = rows.filter(x => !rows.some(y => y.id !== x.id && y.start_line >= x.start_line && y.end_line <= x.end_line && (y.end_line - y.start_line) < (x.end_line - x.start_line)));
                for (const x of inner) seeds.add(x.id);
            }
        }
        return { seeds: [...seeds], files: [...changes.keys()] };
    }

    /** Files that historically change together with the given files (git log, bounded). */
    coChange(files, { commits = 400, limit = 8 } = {}) {
        if (!this._cochange || this._cochangeAt < Date.now() - 600_000) {
            const r = spawnSync('git', ['log', `-n${commits}`, '--name-only', '--pretty=format:%x00'], { cwd: this.root, encoding: 'utf8', maxBuffer: 1 << 28 });
            const counts = new Map(); const pair = new Map();
            if (r.status === 0) {
                for (const block of r.stdout.split('\0')) {
                    const fs_ = [...new Set(block.split('\n').map(s => s.trim()).filter(Boolean))];
                    if (fs_.length < 2 || fs_.length > 40) { for (const f of fs_) counts.set(f, (counts.get(f) ?? 0) + 1); continue; }
                    for (const f of fs_) counts.set(f, (counts.get(f) ?? 0) + 1);
                    for (const a of fs_) for (const b of fs_) if (a !== b) { const k = a + '\0' + b; pair.set(k, (pair.get(k) ?? 0) + 1); }
                }
            }
            this._cochange = { counts, pair };
            this._cochangeAt = Date.now();
        }
        const { counts, pair } = this._cochange;
        const agg = new Map();
        for (const f of files) {
            const n = counts.get(f) ?? 0;
            if (!n) continue;
            for (const [k, v] of pair) {
                if (!k.startsWith(f + '\0')) continue;
                const other = k.slice(f.length + 1);
                if (files.includes(other) || v < 2) continue;
                const score = v / n;
                const prev = agg.get(other);
                if (!prev || prev.score < score) agg.set(other, { file: other, together: v, of: n, score });
            }
        }
        return [...agg.values()].sort((a, b) => b.score - a.score || b.together - a.together).slice(0, limit);
    }

    /** Tests related to files by naming convention (foo.ts ↔ foo.test.ts / test_foo.py / foo_test.go). */
    conventionTests(files) {
        const out = new Set();
        for (const f of files) {
            const base = path.posix.basename(f).replace(/\.[^.]+$/, '');
            const stem = base.replace(/\.(test|spec)$/, '');
            const rows = this.store.all(`SELECT path FROM files WHERE is_test = 1 AND (path LIKE ? OR path LIKE ? OR path LIKE ? OR path LIKE ? OR path LIKE ?)`,
                `%/${stem}.test.%`, `%/${stem}.spec.%`, `%test_${stem}.%`, `%/${stem}_test.%`, `%/${stem}Test.%`);
            for (const r of rows) out.add(r.path);
        }
        return [...out];
    }

    // ── maps ─────────────────────────────────────────────────────────────────────
    /** Symbols ranked by (personalized) centrality, grouped by file. */
    rankedSymbols({ focusIds = null, pathPrefix = null, limit = 400 } = {}) {
        let scores;
        if (focusIds?.length) {
            const pers = new Map(focusIds.map(id => [id, 1]));
            scores = computeCentrality(this.store, { personalization: pers, graph: loadGraph(this.store) });
        } else scores = this.centrality();
        const rows = this.store.all(`SELECT s.id, s.name, s.qname, s.kind, s.parent_id, s.start_line, s.end_line, s.sig, s.exported, f.path, f.is_test
            FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.kind NOT IN ('variable','field','property','constant','selector','keyframes')`);
        const filtered = rows.filter(r => !r.is_test && (!pathPrefix || r.path.startsWith(pathPrefix)));
        filtered.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || a.id - b.id);
        return filtered.slice(0, limit).map(r => ({ ...r, score: scores.get(r.id) ?? 0 }));
    }

    stats() {
        const c = (sql) => this.store.get(sql)?.n ?? 0;
        const langs = this.store.all('SELECT lang, COUNT(*) AS n FROM files GROUP BY lang ORDER BY n DESC');
        return {
            root: this.root,
            files: c('SELECT COUNT(*) n FROM files'),
            symbols: c('SELECT COUNT(*) n FROM symbols'),
            refs: c('SELECT COUNT(*) n FROM refs'),
            resolved: c('SELECT COUNT(*) n FROM refs WHERE dst_id IS NOT NULL'),
            exact: c('SELECT COUNT(*) n FROM refs WHERE conf >= 0.9'),
            langs,
            lastSync: this.lastSyncStats,
            watcher: this.watcherHealthy,
        };
    }
}
