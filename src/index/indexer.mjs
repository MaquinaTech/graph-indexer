/**
 * Indexer: keeps the SQLite store in sync with the working tree.
 *
 *   sync()          full reconciliation (discover → stat → hash → parse changed → resolve)
 *   syncPaths(ps)   targeted refresh for a handful of files (watcher events, query-time checks)
 *
 * Change detection follows git's model: (size, mtime) is the cheap signature, the content hash
 * decides. Symbol ids are stable across re-indexing (matched by qualified name + kind + ordinal),
 * so references from untouched files stay valid; only references that pointed at deleted symbols,
 * or that could now bind to newly added names, are re-resolved.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverFiles, isIndexablePath, insideRoot, looksMinified, MAX_FILE_BYTES } from './discover.mjs';
import { ModuleResolver } from './modules.mjs';
import { SymbolTable, Resolver } from './resolver.mjs';
import { extractFile } from '../parse/extract.mjs';
import { specForPath, LANGUAGES } from '../parse/languages.mjs';
import { tokenString, codeTokens } from '../search/tokenize.mjs';
import { indexFingerprint } from './fingerprint.mjs';

const SPECS = Object.fromEntries(LANGUAGES.map(l => [l.id, l]));
const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'type', 'object', 'module', 'impl']);
const BODY_TOKEN_CAP = 1200;
const FILE_TOKEN_CAP = 30000;

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

function lineStarts(src) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
    return starts;
}

export class Indexer {
    constructor({ root, store, log = () => {}, include = null }) {
        this.root = path.resolve(root);
        this.store = store;
        this.log = log;
        this.include = include;
        this.table = new SymbolTable();
        this.resolver = new Resolver(this.table, SPECS, { sigOf: (id) => this.store.get('SELECT sig FROM symbols WHERE id = ?', id)?.sig ?? null });
        this.modules = null;
        this.loaded = false;
        this.resolveAll = false;
        this.version = 0; // bumps on every change; caches key off it
    }

    // ── bootstrap from the store ─────────────────────────────────────────────────
    load() {
        const s = this.store;
        const fp = indexFingerprint();
        if (s.getMeta('fingerprint') !== fp) {
            if (s.get('SELECT 1 AS x FROM files LIMIT 1')) { this.log('index was written by another graph-indexer version: rebuilding'); s.reset(); }
            s.setMeta('fingerprint', fp);
        }
        // an interrupted run may have written files whose references were never resolved
        this.resolveAll = s.getMeta('resolve_pending') === '1';
        const files = s.all('SELECT id, path, lang, package, is_test FROM files');
        for (const f of files) this.table.addFile({ id: f.id, path: f.path, lang: f.lang, package: f.package, isTest: !!f.is_test });
        for (const r of s.all('SELECT id, file_id, name, qname, kind, parent_id, owner, type, bases, exported, is_static, start_line, end_line FROM symbols')) {
            this.table.addSym(rowToSym(r));
        }
        // the interfaces a Go type satisfies implicitly are stored only as `~structural` edges
        for (const r of s.all("SELECT DISTINCT src_id, name FROM refs WHERE kind = 'inherit' AND recv_type = '~structural'")) {
            const ty = this.table.sym(r.src_id);
            if (!ty) continue;
            ty.declaredBases ??= [...ty.bases];
            ty.structural ??= new Set();
            if (!ty.bases.includes(r.name)) { ty.bases.push(r.name); ty.structural.add(r.name); }
        }
        const imps = new Map();
        for (const r of s.all('SELECT file_id, source, imported, local, reexport, wildcard, target_file_id, target_dir, target_path FROM imports')) {
            const list = imps.get(r.file_id) ?? imps.set(r.file_id, []).get(r.file_id);
            list.push(rowToImport(r, r.target_dir, r.target_path));
        }
        for (const [fid, list] of imps) this.table.setImports(fid, list);
        const fields = new Map();
        for (const r of s.all('SELECT file_id, owner_qname, name, type FROM fields')) (fields.get(r.file_id) ?? fields.set(r.file_id, []).get(r.file_id)).push(r);
        for (const [fid, rows] of fields) this.table.setFieldTypes(fid, rows);
        this.modules = new ModuleResolver(this.root, files.map(f => f.path));
        this.loaded = true;
    }

    // ── public API ──────────────────────────────────────────────────────────────
    /** Full reconciliation with the working tree. */
    async sync({ onProgress = null } = {}) {
        if (!this.loaded) this.load();
        const t0 = Date.now();
        const { files } = discoverFiles(this.root, { include: this.include });
        const known = new Map(this.store.all('SELECT id, path, size, mtime_ms, hash FROM files').map(r => [r.path, r]));
        const present = new Set(files);
        const removed = [...known.keys()].filter(p => !present.has(p));
        this.modules.setFiles(files);
        const toParse = [];
        for (const rel of files) {
            const st = safeStat(path.join(this.root, rel));
            if (!st || st.size > MAX_FILE_BYTES) { if (known.has(rel)) removed.push(rel); continue; }
            const k = known.get(rel);
            if (k && k.size === st.size && k.mtime_ms === Math.floor(st.mtimeMs)) continue;
            toParse.push({ rel, st, prev: k ?? null });
        }
        const res = await this.#apply(toParse, removed, { onProgress });
        this.store.setMeta('last_sync', String(Date.now()));
        this.store.setMeta('root', this.root);
        return { ...res, total: files.length, ms: Date.now() - t0 };
    }

    /** Re-check specific paths (created/modified/deleted). Cheap; used before answering queries. */
    async syncPaths(paths) {
        if (!this.loaded) this.load();
        const toParse = [];
        const removed = [];
        for (const p of new Set(paths)) {
            const rel = path.isAbsolute(p) ? path.relative(this.root, p).split(path.sep).join('/') : p;
            if (rel.startsWith('..') || !isIndexablePath(rel, { include: this.include })) continue;
            const st = safeStat(path.join(this.root, rel));
            const k = this.store.get('SELECT id, path, size, mtime_ms, hash FROM files WHERE path = ?', rel);
            if (!st || !st.isFile() || st.size > MAX_FILE_BYTES || !insideRoot(this.root, rel)) { if (k) removed.push(rel); continue; }
            if (k && k.size === st.size && k.mtime_ms === Math.floor(st.mtimeMs)) continue;
            toParse.push({ rel, st, prev: k ?? null });
            this.modules.addFile(rel);
        }
        for (const r of removed) this.modules.removeFile(r);
        if (!toParse.length && !removed.length) return { changed: 0, removed: 0 };
        return this.#apply(toParse, removed, {});
    }

    /** Which of these indexed paths differ from disk right now (size/mtime)? */
    staleAmong(paths) {
        const out = [];
        for (const rel of new Set(paths)) {
            const k = this.store.get('SELECT size, mtime_ms FROM files WHERE path = ?', rel);
            const st = safeStat(path.join(this.root, rel));
            if (!k || !st || k.size !== st.size || k.mtime_ms !== Math.floor(st.mtimeMs)) out.push(rel);
        }
        return out;
    }

    // ── internals ────────────────────────────────────────────────────────────────
    async #apply(toParse, removed, { onProgress }) {
        const s = this.store;
        let changed = 0, unchangedContent = 0, added = 0;
        const touchedFileIds = [];
        const removedSymIds = [];
        const addedNames = new Set();

        // remove deleted files
        if (removed.length) {
            s.tx(() => {
                for (const rel of removed) {
                    const f = s.get('SELECT id FROM files WHERE path = ?', rel);
                    if (!f) continue;
                    for (const r of s.all('SELECT id FROM symbols WHERE file_id = ?', f.id)) { removedSymIds.push(r.id); s.run('DELETE FROM fts WHERE rowid = ?', r.id); }
                    s.run('DELETE FROM file_fts WHERE rowid = ?', f.id);
                    for (const t of ['symbols', 'refs', 'imports', 'fields']) s.run(`DELETE FROM ${t} WHERE file_id = ?`, f.id);
                    s.run('DELETE FROM files WHERE id = ?', f.id);
                    this.table.removeFile(f.id);
                    this.modules?.removeFile(rel);
                }
            });
        }

        // parse changed/new files (async extraction), write in batches
        if (toParse.length || removed.length) s.setMeta('resolve_pending', '1');
        const BATCH = 200;
        let done = 0;
        for (let i = 0; i < toParse.length; i += BATCH) {
            const batch = toParse.slice(i, i + BATCH);
            const parsed = [];
            for (const item of batch) {
                const abs = path.join(this.root, item.rel);
                let source;
                try { source = fs.readFileSync(abs, 'utf8'); } catch { continue; }
                const hash = sha1(source);
                if (item.prev && item.prev.hash === hash) {
                    s.run('UPDATE files SET size = ?, mtime_ms = ? WHERE id = ?', item.st.size, Math.floor(item.st.mtimeMs), item.prev.id);
                    unchangedContent++;
                    continue;
                }
                const spec = specForPath(item.rel);
                if (!spec) continue;
                let extraction;
                if (looksMinified(source)) extraction = { symbols: [], refs: [], imports: [], fields: [], fileInfo: null, errors: 0 };
                else {
                    try { extraction = await extractFile(spec, source, item.rel); }
                    catch (e) { this.log(`parse failed for ${item.rel}: ${e.message}`); extraction = { symbols: [], refs: [], imports: [], fields: [], fileInfo: null, errors: 1 }; }
                }
                parsed.push({ ...item, source, hash, spec, extraction });
            }
            s.tx(() => {
                for (const p of parsed) {
                    const r = this.#writeFile(p);
                    touchedFileIds.push(r.fileId);
                    removedSymIds.push(...r.removedIds);
                    for (const n of r.addedNames) addedNames.add(n);
                    if (p.prev) changed++; else added++;
                }
            });
            done += batch.length;
            onProgress?.(done, toParse.length);
        }

        // resolve: refs of touched files + refs that pointed at removed symbols + refs that may bind to new names
        this.resolver.resetMemo();
        const refIds = new Set();
        if (touchedFileIds.length) {
            for (const fid of touchedFileIds) for (const r of s.all('SELECT id FROM refs WHERE file_id = ?', fid)) refIds.add(r.id);
        }
        const dangling = [];
        if (removedSymIds.length) {
            for (let i = 0; i < removedSymIds.length; i += 500) {
                const chunk = removedSymIds.slice(i, i + 500);
                for (const r of s.all(`SELECT id FROM refs WHERE dst_id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) { refIds.add(r.id); dangling.push(r.id); }
            }
        }
        const isIncremental = touchedFileIds.length < this.table.files.size;
        if (addedNames.size && isIncremental) {
            const names = [...addedNames];
            for (let i = 0; i < names.length; i += 500) {
                const chunk = names.slice(i, i + 500);
                for (const r of s.all(`SELECT id FROM refs WHERE name IN (${chunk.map(() => '?').join(',')}) AND (dst_id IS NULL OR conf < 0.9)`, ...chunk)) refIds.add(r.id);
            }
        }
        const goTouched = this.resolveAll || removed.some(r => r.endsWith('.go')) || toParse.some(p => p.rel.endsWith('.go'));
        if (this.resolveAll) for (const r of s.all('SELECT id FROM refs')) refIds.add(r.id);
        const resolved = this.#resolveRefs([...refIds]);
        if (goTouched) this.#goImplements();
        this.resolveAll = false;
        if (toParse.length || removed.length) s.setMeta('resolve_pending', '0');
        if (touchedFileIds.length || removed.length) this.version++;
        return { added, changed, removed: removed.length, unchangedContent, resolved };
    }

    #writeFile({ rel, st, prev, source, hash, spec, extraction }) {
        const s = this.store;
        const { symbols, refs, imports, fields, fileInfo, errors } = extraction;
        const lines = lineStarts(source);
        const isTest = spec.testFile?.test(rel) ? 1 : 0;
        const pkg = fileInfo?.package ?? null;
        let fileId;
        let oldSyms = [];
        if (prev) {
            fileId = prev.id;
            oldSyms = s.all('SELECT id, qname, kind, ordinal FROM symbols WHERE file_id = ?', fileId);
            for (const o of oldSyms) s.run('DELETE FROM fts WHERE rowid = ?', o.id);
            s.run('DELETE FROM file_fts WHERE rowid = ?', fileId);
            for (const t of ['symbols', 'refs', 'imports', 'fields']) s.run(`DELETE FROM ${t} WHERE file_id = ?`, fileId);
            s.run('UPDATE files SET lang = ?, size = ?, mtime_ms = ?, hash = ?, lines = ?, package = ?, is_test = ?, parse_errors = ?, indexed_at = ? WHERE id = ?',
                spec.id, st.size, Math.floor(st.mtimeMs), hash, lines.length, pkg, isTest, errors, Date.now(), fileId);
            this.table.removeFile(fileId);
        } else {
            const r = s.run('INSERT INTO files (path, lang, size, mtime_ms, hash, lines, package, is_test, parse_errors, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                rel, spec.id, st.size, Math.floor(st.mtimeMs), hash, lines.length, pkg, isTest, errors, Date.now());
            fileId = Number(r.lastInsertRowid);
        }
        this.table.addFile({ id: fileId, path: rel, lang: spec.id, package: pkg, isTest: !!isTest });

        // stable ids: reuse by (qname, kind, ordinal)
        const oldByKey = new Map(oldSyms.map(o => [o.qname + '\0' + o.kind + '\0' + o.ordinal, o.id]));
        const ordinals = new Map();
        const ids = new Array(symbols.length);
        const reused = new Set();
        const addedNames = [];
        const pathTokens = tokenString(rel.replace(/\.[^.]+$/, ''));
        for (let i = 0; i < symbols.length; i++) {
            const sym = symbols[i];
            const k0 = sym.qname + '\0' + sym.kind;
            const ord = ordinals.get(k0) ?? 0;
            ordinals.set(k0, ord + 1);
            const key = k0 + '\0' + ord;
            const reuse = oldByKey.get(key);
            const parentId = sym.parentIdx >= 0 ? ids[sym.parentIdx] : null;
            const decorators = sym.decorators?.length ? JSON.stringify(sym.decorators) : null;
            const bases = sym.bases?.length ? JSON.stringify(sym.bases) : null;
            const r = s.run(`INSERT INTO symbols (id, file_id, name, name_lc, qname, kind, parent_id, owner, start_line, start_col, end_line, end_col, name_line, name_col, sig, doc, type, exported, visibility, decorators, bases, ordinal, is_static)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                reuse ?? null, fileId, sym.name, sym.name.toLowerCase(), sym.qname, sym.kind, parentId, sym.owner, sym.startLine, sym.startCol, sym.endLine, sym.endCol,
                sym.nameLine, sym.nameCol, sym.sig || null, sym.doc || null, sym.type, sym.exported ? 1 : 0, sym.visibility, decorators, bases, ord, sym.isStatic ? 1 : 0);
            const id = reuse ?? Number(r.lastInsertRowid);
            ids[i] = id;
            if (reuse != null) reused.add(reuse); else addedNames.push(sym.name);
            this.table.addSym({ id, fileId, name: sym.name, qname: sym.qname, kind: sym.kind, parentId, owner: sym.owner, type: sym.type, bases: sym.bases ?? [], exported: !!sym.exported, isStatic: !!sym.isStatic, startLine: sym.startLine, endLine: sym.endLine });
        }
        // FTS documents
        for (let i = 0; i < symbols.length; i++) {
            const sym = symbols[i];
            let body;
            if (TYPE_KINDS.has(sym.kind)) {
                const kids = [];
                for (let j = i + 1; j < symbols.length && kids.length < 200; j++) if (symbols[j].parentIdx === i) kids.push(symbols[j].name, symbols[j].sig ?? '');
                body = tokenString(kids.join(' '), { maxTokens: BODY_TOKEN_CAP });
            } else if (sym.kind === 'macro' || sym.kind === 'selector' || sym.kind === 'variable' && sym.endLine - sym.startLine > 30) {
                // macro_rules bodies, CSS blocks and big literal tables are token soup: index their head only
                const a = lines[sym.startLine - 1] ?? 0;
                const b = lines[Math.min(sym.startLine + 2, lines.length - 1)] ?? source.length;
                body = codeTokens(source.slice(a, b), { maxTokens: 60 }).join(' ');
            } else {
                const a = lines[sym.startLine - 1] ?? 0;
                const b = lines[Math.min(sym.endLine, lines.length - 1)] ?? source.length;
                body = codeTokens(source.slice(a, sym.endLine >= lines.length ? source.length : b), { maxTokens: BODY_TOKEN_CAP }).join(' ');
            }
            s.run('INSERT INTO fts (rowid, name, qname, sig, doc, path, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
                ids[i], tokenString(sym.name), tokenString(sym.qname), tokenString(sym.sig ?? ''), tokenString(sym.doc ?? ''), pathTokens, body);
        }
        // file document (hierarchical ranking: which files talk about the query at all)
        s.run('INSERT INTO file_fts (rowid, path, body) VALUES (?, ?, ?)', fileId, pathTokens, codeTokens(source, { maxTokens: FILE_TOKEN_CAP }).join(' '));
        // refs (unresolved for now)
        for (const r of refs) {
            s.run('INSERT INTO refs (file_id, src_id, name, kind, line, col, recv, recv_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                fileId, r.symIdx >= 0 ? ids[r.symIdx] : null, r.name, r.kind, r.line, r.col, r.recv || null, r.recvType || null);
        }
        // imports (module resolution needs only the file list)
        const impRows = [];
        for (const imp of imports) {
            const target = this.modules.resolve(spec.id, rel, imp.source);
            let targetFileId = null;
            if (target?.file) targetFileId = s.get('SELECT id FROM files WHERE path = ?', target.file)?.id ?? null;
            const row = { source: imp.source ?? null, imported: imp.imported ?? null, local: imp.local ?? null, reexport: imp.reexport ?? null, wildcard: imp.wildcard ? 1 : 0, line: imp.line ?? null, target_file_id: targetFileId, target_dir: target?.dir ?? null };
            s.run('INSERT INTO imports (file_id, source, imported, local, reexport, wildcard, line, target_file_id, target_dir, target_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                fileId, row.source, row.imported, row.local, row.reexport, row.wildcard, row.line, row.target_file_id, row.target_dir, target?.file ?? null);
            impRows.push(rowToImport(row, target?.dir ?? null, target?.file ?? null));
        }
        this.table.setImports(fileId, impRows);
        for (const f of fields ?? []) s.run('INSERT INTO fields (file_id, owner_qname, name, type) VALUES (?, ?, ?, ?)', fileId, f.owner, f.name, f.type);
        this.table.setFieldTypes(fileId, (fields ?? []).map(f => ({ owner_qname: f.owner, name: f.name, type: f.type })));
        const removedIds = oldSyms.filter(o => !reused.has(o.id)).map(o => o.id);
        return { fileId, removedIds, addedNames };
    }

    /** Import targets whose file was not indexed yet at write time are fixed up lazily here. */
    #fixImportTargets() {
        const s = this.store;
        for (const [fid, imps] of this.table.imports) {
            const f = this.table.file(fid);
            if (!f) continue;
            let changed = false;
            for (const imp of imps) {
                // a package import can have both a directory and an entry file (Python `pkg/__init__.py`)
                if (imp.targetFileId != null || !imp.targetPath) continue;
                const t = this.table.fileByPath.get(imp.targetPath);
                if (t) { imp.targetFileId = t.id; changed = true; }
            }
            if (changed) {
                for (const imp of imps) if (imp.targetFileId != null && imp.targetPath) s.run('UPDATE imports SET target_file_id = ? WHERE file_id = ? AND target_path = ? AND target_file_id IS NULL', imp.targetFileId, fid, imp.targetPath);
                this.table.setImports(fid, imps);
            }
        }
    }

    /**
     * Go interfaces are satisfied implicitly: a named type implements an interface when its method
     * set (methods declared on the type or its pointer, in its package) contains every method the
     * interface declares, embedded interfaces included. Recorded as `inherit` edges marked
     * `~structural`, recomputed whenever a Go file changes, and added to the type's bases so calls
     * through the interface count as calls to the implementations and vice versa.
     */
    #goImplements() {
        const s = this.store, t = this.table;
        s.tx(() => {
            const old = s.all("SELECT src_id, name FROM refs WHERE kind = 'inherit' AND recv_type = '~structural'");
            s.run("DELETE FROM refs WHERE kind = 'inherit' AND recv_type = '~structural'");
            for (const o of old) {
                const sym = t.sym(o.src_id);
                if (sym && sym.structural?.has(o.name)) { sym.bases = sym.bases.filter(b => b !== o.name || sym.declaredBases?.includes(b)); sym.structural.delete(o.name); }
            }
            const goFile = (fid) => t.file(fid)?.lang === 'go';
            const dirOf = (fid) => { const f = t.file(fid); return f ? path.posix.dirname(f.path) : null; };
            const ifaces = [], types = [];
            for (const sym of t.syms.values()) {
                if (!goFile(sym.fileId)) continue;
                if (sym.kind === 'interface') ifaces.push(sym);
                else if (sym.kind === 'struct' || sym.kind === 'type' || sym.kind === 'class') types.push(sym);
            }
            if (!ifaces.length || !types.length) return;
            const ifaceByName = new Map();
            for (const i of ifaces) (ifaceByName.get(i.name) ?? ifaceByName.set(i.name, []).get(i.name)).push(i);
            // a method's signature shape (see go.mjs methodShape); null when unreadable, which matches any
            const shapeOf = (m) => this.resolver.specs.go?.methodShape?.(s.get('SELECT sig FROM symbols WHERE id = ?', m.id)?.sig, m.name) ?? null;
            // methods of an interface (name → shape), following embedded interfaces declared in the same package
            const methodSet = (i, seen = new Set()) => {
                const out = new Map();
                if (seen.has(i.id)) return out;
                seen.add(i.id);
                for (const [n, ids] of t.byParent.get(i.id) ?? []) {
                    const m = ids.map(id => t.sym(id)).find(x => x?.kind === 'method');
                    if (m) out.set(n, shapeOf(m));
                }
                for (const b of i.declaredBases ?? i.bases ?? []) for (const e of ifaceByName.get(b) ?? []) if (dirOf(e.fileId) === dirOf(i.fileId)) for (const [n, sh] of methodSet(e, seen)) if (!out.has(n)) out.set(n, sh);
                return out;
            };
            // methods per type (methods live outside the type body in Go: owner = type name), plus
            // those promoted from embedded types of the repository (`type Engine struct { RouterGroup }`)
            const own = (ty) => {
                if (ty.kind === 'interface') return methodSet(ty);
                const dir = dirOf(ty.fileId), out = new Map();
                for (const id of t.byOwner.get(ty.name) ?? []) {
                    const m = t.sym(id);
                    if (m && m.kind === 'method' && dirOf(m.fileId) === dir && !out.has(m.name)) out.set(m.name, shapeOf(m));
                }
                return out;
            };
            const promoted = (ty, depth = 0, seen = new Set()) => {
                const out = own(ty);
                if (depth > 4 || seen.has(ty.id)) return out;
                seen.add(ty.id);
                // an alias (`type DummyLogger = testhelper.DummyLogger`) has its target's methods
                const alias = ty.kind === 'type' && !out.size && ty.type && !/(\[\]|\{\})$/.test(ty.type) ? this.resolver.resolveTypeName(ty.type, ty.fileId) : null;
                if (alias && alias.id !== ty.id) for (const [n, sh] of promoted(t.sym(alias.id) ?? alias, depth + 1, seen)) if (!out.has(n)) out.set(n, sh);
                for (const b of ty.declaredBases ?? ty.bases ?? []) {
                    const e = this.resolver.resolveTypeName(b, ty.fileId);
                    if (e && e.id !== ty.id) for (const [n, sh] of promoted(t.sym(e.id) ?? e, depth + 1, seen)) if (!out.has(n)) out.set(n, sh);
                }
                return out;
            };
            const byMethod = new Map(); // name → Map(type id → shape)
            for (const ty of types) {
                for (const [n, sh] of promoted(ty)) (byMethod.get(n) ?? byMethod.set(n, new Map()).get(n)).set(ty.id, sh);
            }
            const fits = (a, b) => a == null || b == null || a === b;
            for (const i of ifaces) {
                const need = [...methodSet(i)];
                if (!need.length) continue;
                need.sort((a, b) => (byMethod.get(a[0])?.size ?? 0) - (byMethod.get(b[0])?.size ?? 0));
                const cands = byMethod.get(need[0][0]);
                if (!cands) continue;
                for (const tyId of cands.keys()) {
                    if (!need.every(([n, sh]) => byMethod.get(n)?.has(tyId) && fits(sh, byMethod.get(n).get(tyId)))) continue;
                    const ty = t.sym(tyId);
                    s.run("INSERT INTO refs (file_id, src_id, name, kind, line, col, recv, recv_type, dst_id, conf, ncand) VALUES (?, ?, ?, 'inherit', ?, 0, NULL, '~structural', ?, 0.8, 1)",
                        ty.fileId, ty.id, i.name, ty.startLine, i.id);
                    ty.declaredBases ??= [...ty.bases];
                    ty.structural ??= new Set();
                    if (!ty.bases.includes(i.name)) { ty.bases.push(i.name); ty.structural.add(i.name); }
                }
            }
        });
    }

    #resolveRefs(refIds) {
        if (!refIds.length) return 0;
        const s = this.store;
        this.#fixImportTargets();
        let n = 0;
        s.tx(() => {
            for (let i = 0; i < refIds.length; i += 900) {
                const chunk = refIds.slice(i, i + 900);
                const rows = s.all(`SELECT id, file_id, src_id, name, kind, recv, recv_type FROM refs WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk);
                for (const r of rows) {
                    const res = this.resolver.resolve(r);
                    if (res.id == null && (r.kind === 'value' || r.kind === 'read' || r.kind === 'type' || res.external)) { s.run('DELETE FROM refs WHERE id = ?', r.id); continue; }
                    s.run('UPDATE refs SET dst_id = ?, conf = ?, ncand = ? WHERE id = ?', res.id, res.conf, res.ncand ?? 0, r.id);
                    if (res.id != null) n++;
                }
            }
        });
        return n;
    }
}

function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }

function rowToSym(r) {
    return {
        id: r.id, fileId: r.file_id, name: r.name, qname: r.qname, kind: r.kind, parentId: r.parent_id ?? null, owner: r.owner ?? null,
        type: r.type ?? null, bases: r.bases ? JSON.parse(r.bases) : [], exported: !!r.exported, isStatic: !!r.is_static, startLine: r.start_line, endLine: r.end_line,
    };
}

function rowToImport(r, dir = null, targetPath = null) {
    return {
        source: r.source, imported: r.imported, local: r.local, reexport: r.reexport, wildcard: !!r.wildcard,
        targetFileId: r.target_file_id ?? null, targetDir: dir ?? r.target_dir ?? null, targetPath,
    };
}
