/**
 * Indexer: keeps the SQLite store in sync with the working tree.
 *
 *   sync()          full reconciliation (discover → stat → hash → parse changed → resolve)
 *   syncPaths(ps)   targeted refresh for a handful of files (watcher events, query-time checks)
 *
 * Change detection follows git's model: (size, mtime) is the cheap signature, the content hash
 * decides. Symbol ids are stable across re-indexing (matched by qualified name + kind + ordinal),
 * so references from untouched files stay valid.
 *
 * An updated index holds the same facts as one built from scratch (bench/eval-incremental.mjs
 * replays real history to check it). Three things make that so:
 *   - resolving a file's references records what it asked of the rest of the repository (the
 *     definitions of a name, a file's imports, a type's inferred fields, the module map), and a
 *     change emits the keys of what it altered: exactly the files that asked are resolved again;
 *   - references that bind to nothing are kept aside (`refs_unbound`), so a definition written
 *     after its uses still finds them;
 *   - the symbol table's lists are in one canonical order, so no answer depends on the order in
 *     which files were indexed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverFiles, isIndexablePath, insideRoot, looksMinified, ignoredAmong, listedAmong, diskName, filesUnder, MAX_FILE_BYTES } from './discover.mjs';
import { ModuleResolver, isManifestPath } from './modules.mjs';
import { SymbolTable, Resolver, newDeps, depHash } from './resolver.mjs';
import { extractFile } from '../parse/extract.mjs';
import { specForPath, LANGUAGES } from '../parse/languages.mjs';
import { tokenString, codeTokens } from '../search/tokenize.mjs';
import { indexFingerprint } from './fingerprint.mjs';
import { ParsePool, poolSize } from './parsepool.mjs';

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

// Languages whose resolution asks the module map while binding a reference (a Rust path is walked
// module by module); the others only follow the import targets stored for each file.
const MODULE_MAP_READERS = new Set(['rust']);

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
        this.deps = new Map(); // fileId -> sorted Uint32Array of the keys its references' resolution read
        this.modulesFp = null; // fingerprint of the manifests the stored imports were resolved with
        this.lastFanout = null; // { changed, dependents, keys } of the last update, for `status` and the benchmarks
        this.layout = null; // set by sync(): the output-like directories git tracks source in (discover.mjs)
        this.viaGit = null; // set by sync(): whether git lists the files (and answers what is ignored)
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
        const files = s.all('SELECT id, path, lang, package, is_test, deps FROM files ORDER BY path');
        for (const f of files) {
            this.table.addFile({ id: f.id, path: f.path, lang: f.lang, package: f.package, isTest: !!f.is_test });
            this.deps.set(f.id, f.deps ? new Uint32Array(f.deps.buffer.slice(f.deps.byteOffset, f.deps.byteOffset + f.deps.byteLength)) : EMPTY_DEPS);
        }
        this.modulesFp = s.getMeta('modules_fp');
        for (const r of s.all('SELECT s.id, s.file_id, s.name, s.qname, s.kind, s.parent_id, s.owner, s.type, s.bases, s.decorators, s.exported, s.is_static, s.start_line, s.end_line, s.seq FROM symbols s JOIN files f ON f.id = s.file_id ORDER BY f.path, s.seq')) {
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
        for (const r of s.all('SELECT file_id, source, imported, local, reexport, wildcard, line, target_file_id, target_dir, target_path FROM imports ORDER BY rowid')) {
            const list = imps.get(r.file_id) ?? imps.set(r.file_id, []).get(r.file_id);
            list.push(rowToImport(r, r.target_dir, r.target_path));
        }
        for (const [fid, list] of imps) this.table.setImports(fid, list);
        const fields = new Map();
        for (const r of s.all('SELECT file_id, owner_qname, name, type FROM fields')) (fields.get(r.file_id) ?? fields.set(r.file_id, []).get(r.file_id)).push(r);
        for (const [fid, rows] of fields) this.table.setFieldTypes(fid, rows);
        this.modules = new ModuleResolver(this.root, files.map(f => f.path));
        this.resolver.modules = this.modules;
        // a manifest edited while no process had the index open: the stored imports were resolved with the old one
        this.modulesStale = files.length > 0 && sha1(this.modules.fingerprint()) !== this.modulesFp;
        this.dataVersion = s.get('PRAGMA data_version')?.data_version ?? null;
        this.loaded = true;
    }

    /** Forget the in-memory state: it is read again from the store, and every reference resolved again. */
    #forget() {
        this.table = new SymbolTable();
        this.resolver.t = this.table;
        this.resolver.resetMemo();
        this.deps = new Map();
        this.modules = null;
        this.loaded = false;
    }

    // ── public API ──────────────────────────────────────────────────────────────
    /**
     * One update at a time. Tool calls arrive while another is still syncing; two updates interleaved
     * at their awaits wrote the same file twice (`UNIQUE constraint failed: files.path`) and one could
     * lose the keys the other had emitted, leaving references bound to rows that were gone.
     */
    #queue = Promise.resolve();
    #serial(fn) {
        const run = this.#queue.then(fn, fn);
        this.#queue = run.catch(() => {});
        return run;
    }

    /**
     * Another process wrote the index (the edit hook opens its own when the resident is busy): what
     * this one holds in memory is no longer what the store holds, so it is read again. SQLite's
     * `data_version` changes only when another connection commits.
     * @returns {boolean} whether the state was read again
     */
    reloadIfForeign() {
        const v = this.store.get('PRAGMA data_version')?.data_version ?? null;
        if (this.loaded && this.dataVersion != null && v !== this.dataVersion) {
            this.#forget();
            this.load();
            this.version++;
            return true;
        }
        this.dataVersion = v;
        return false;
    }

    /** Full reconciliation with the working tree. */
    sync(opts = {}) { return this.#serial(() => this.#sync(opts)); }

    async #sync({ onProgress = null } = {}) {
        if (!this.loaded) this.load();
        this.reloadIfForeign();
        const t0 = Date.now();
        const { files, layout, viaGit } = discoverFiles(this.root, { include: this.include });
        this.layout = layout; // which output-like directories are the project's own, for paths checked one by one
        this.viaGit = viaGit;
        const known = new Map(this.store.all('SELECT id, path, size, mtime_ms, hash FROM files').map(r => [r.path, r]));
        const present = new Set(files);
        const removed = [...known.keys()].filter(p => !present.has(p));
        const toParse = [], onDisk = [];
        for (const rel of files) {
            const st = safeStat(path.join(this.root, rel));
            // git lists a tracked file until its deletion is staged: one that is gone from the
            // working tree is no module an import can lead to
            if (st?.isFile()) onDisk.push(rel);
            if (!st || !st.isFile() || st.size > MAX_FILE_BYTES) { if (known.has(rel)) removed.push(rel); continue; }
            const k = known.get(rel);
            if (k && k.size === st.size && k.mtime_ms === Math.floor(st.mtimeMs)) continue;
            toParse.push({ rel, st, prev: k ?? null });
        }
        this.modules.setFiles(onDisk);
        const res = await this.#apply(toParse, removed, { onProgress, modulesChanged: sha1(this.modules.fingerprint()) !== this.modulesFp });
        this.store.setMeta('last_sync', String(Date.now()));
        this.store.setMeta('root', this.root);
        return { ...res, total: files.length, ms: Date.now() - t0 };
    }

    /** Re-check specific paths (created/modified/deleted). Cheap; used before answering queries. */
    syncPaths(paths) { return this.#serial(() => this.#syncPaths(paths)); }

    async #syncPaths(paths) {
        if (!this.loaded) this.load();
        this.reloadIfForeign();
        // which files are the project's own is learnt by a full discovery: an index reopened and handed paths first does one
        if (this.viaGit == null) return this.#sync();
        const toParse = [];
        const removed = [];
        let manifest = false;
        const rels = new Set();
        for (const p of new Set(paths)) {
            let rel = path.isAbsolute(p) ? path.relative(this.root, p).split(path.sep).join('/') : String(p);
            // one spelling per file: `./src/`, `src//a.ts`, `src/./a.ts` are `src`, `src/a.ts`
            rel = path.posix.normalize(rel.replace(/\\/g, '/')).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
            if (rel === '' || rel === '.') return this.#sync();
            if (rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) continue;
            // one Unicode form per file: the name the index holds, else the composed one git lists (macOS hands decomposed names to the watcher)
            if (rel !== rel.normalize('NFC') || rel !== rel.normalize('NFD')) {
                const held = [rel.normalize('NFC'), rel.normalize('NFD')].find(n => this.store.get('SELECT 1 FROM files WHERE path = ?', n));
                rel = held ?? (process.platform === 'darwin' ? rel.normalize('NFC') : rel);
            }
            // what the repository ignores decides which files there are: one written while it was
            // ignored is the project's own once the rule is gone (and the other way round), and no
            // path among these says which. Rare enough to look at everything again.
            if (path.posix.basename(rel) === '.gitignore') return this.#sync();
            // a manifest is not indexed (`svelte.config.js` is: it is source as well), but it decides
            // where imports lead; so does a file a manifest reads (the base a tsconfig extends)
            if (isManifestPath(rel) || this.modules.manifestReads?.has(rel)) manifest = true;
            if (specForPath(rel)) rels.add(rel);
            // a directory that was renamed, moved in or removed arrives as one path: the files the
            // index holds under it, and the ones it holds on disk now (a directory can be named like a file, `m.ts/`)
            const under = this.store.all('SELECT path FROM files WHERE path >= ? AND path < ?', rel + '/', rel + '0').map(r => r.path);
            const isDir = safeStat(path.join(this.root, rel))?.isDirectory();
            if (!under.length && !isDir) continue;
            const onDisk = isDir ? filesUnder(this.root, rel) : [];
            if (!onDisk) return this.#sync(); // too many to look at one by one
            for (const f of under) rels.add(f);
            for (const f of onDisk) if (specForPath(f)) rels.add(f);
        }
        const unknown = [], oversize = [];
        for (const rel of rels) {
            if (!isIndexablePath(rel, { include: this.include, layout: this.layout })) continue;
            const st = safeStat(path.join(this.root, rel));
            const k = this.store.get('SELECT id, path, size, mtime_ms, hash FROM files WHERE path = ?', rel);
            // a name the file system answers for in another case is not the file's: the one on disk is
            // looked at in its place (git names a file as its index does until it is told of the rename)
            const disk = st ? diskName(this.root, rel) : rel;
            if (disk !== rel) rels.add(disk);
            // handed over by its new name only, after a rename that changed only its letter case: the old row goes
            if (!k && st && disk === rel && this.#foldsCase()) for (const o of this.store.all('SELECT path FROM files WHERE lower(path) = lower(?) AND path != ?', rel, rel)) if (diskName(this.root, o.path) !== o.path) removed.push(o.path);
            if (!st || !st.isFile() || st.size > MAX_FILE_BYTES || !insideRoot(this.root, rel) || disk !== rel) {
                if (k) removed.push(rel);
                // too big to index, but a file all the same: imports of it still lead there, as a full discovery has it
                if (st?.isFile() && st.size > MAX_FILE_BYTES && disk === rel && insideRoot(this.root, rel)) { oversize.push(rel); if (!k) unknown.push(rel); }
                continue;
            }
            if (k && k.size === st.size && k.mtime_ms === Math.floor(st.mtimeMs)) continue;
            toParse.push({ rel, st, prev: k ?? null });
            if (!k) unknown.push(rel);
        }
        // a file the index does not hold yet may be one the repository ignores (generated code, the
        // output of a watch build): a full discovery would not list it, so it is not indexed here either
        if (unknown.length && this.viaGit != null) {
            // with git, what it lists: that also leaves out a nested repository, a submodule and a path beyond a link
            const listed = this.viaGit ? listedAmong(this.root, unknown) : null;
            const ignored = this.viaGit ? (listed && new Set(unknown.filter(u => !listed.has(u)))) : ignoredAmong(this.root, unknown, false);
            if (ignored == null) return this.#sync(); // git could not answer: a full discovery can
            if (ignored.size) for (let i = oversize.length - 1; i >= 0; i--) if (ignored.has(oversize[i])) oversize.splice(i, 1);
            if (ignored.size) for (let i = toParse.length - 1; i >= 0; i--) if (!toParse[i].prev && ignored.has(toParse[i].rel)) toParse.splice(i, 1);
        }
        for (const p of toParse) if (this.modules.addFile(p.rel)) manifest = true;
        for (const r of removed) if (this.modules.removeFile(r)) manifest = true;
        for (const r of oversize) if (this.modules.addFile(r)) manifest = true;
        // manifests are looked for next to source directories: one that changed, or a directory that
        // appeared or emptied, can bring one in or out (a Cargo manifest also counts only when its
        // library file exists, so a Rust file coming or going reads them again)
        let modulesChanged = !!this.modulesStale;
        if (manifest || [...removed, ...toParse.filter(p => !p.prev).map(p => p.rel)].some(p => p.endsWith('.rs'))) {
            this.modules.reloadManifests();
            modulesChanged = sha1(this.modules.fingerprint()) !== this.modulesFp;
        }
        if (!toParse.length && !removed.length && !modulesChanged) return { changed: 0, removed: 0 };
        return this.#apply(toParse, removed, { modulesChanged });
    }

    /** Does the file system answer for a name in another letter case (macOS, Windows)? Asked once, of the root's own name. */
    #foldsCase() {
        if (this.folds === undefined) {
            const base = path.basename(this.root);
            const swapped = base.replace(/\p{L}/gu, c => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
            try {
                const a = fs.statSync(this.root), b = swapped !== base ? fs.statSync(path.join(path.dirname(this.root), swapped)) : null;
                this.folds = !!b && a.ino === b.ino && a.dev === b.dev;
            } catch { this.folds = false; }
        }
        return this.folds;
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
    /**
     * Apply a set of changes. If it fails half way the store has rolled back the batch in hand, but
     * the symbol table has not, and the keys emitted so far are lost: the in-memory state is dropped,
     * and the next call reads the store again and resolves everything (`resolve_pending`).
     */
    async #apply(toParse, removed, opts) {
        try { return await this.#applyChanges(toParse, removed, opts); }
        catch (e) { this.#forget(); throw e; }
    }

    async #applyChanges(toParse, removed, { onProgress, modulesChanged = false }) {
        const s = this.store, t = this.table;
        let changed = 0, unchangedContent = 0, added = 0;
        const touched = new Set();   // files whose references are resolved again
        const written = new Set();   // files parsed in this run (their imports were resolved against the final module map)
        const emitted = new Set();   // hashes of the keys this update altered (see resolver.mjs: TrackedMap)
        const emit = (kind, key) => emitted.add(depHash(kind, String(key)));
        let fileSetChanged = false, goTouched = this.resolveAll;
        // a file of a language whose resolution reads the module map itself (Rust paths) came or went
        let moduleFilesChanged = false;

        // from the first write to the last, the index is one whose references have to be resolved
        // again if the run stops: the mark goes up before the removals, which commit on their own
        if (toParse.length || removed.length || modulesChanged) s.setMeta('resolve_pending', '1');
        t.pkgDelta.clear();
        t.importDelta.clear();

        // remove deleted files
        if (removed.length) {
            s.tx(() => {
                for (const rel of removed) {
                    const f = s.get('SELECT id FROM files WHERE path = ?', rel);
                    if (!f) continue;
                    if (rel.endsWith('.go')) goTouched = true;
                    this.#emitFile(f.id, this.#snapshot(f.id, new Map(s.all('SELECT id, sig FROM symbols WHERE file_id = ?', f.id).map(r => [r.id, r.sig]))), emit);
                    emit('P', rel);
                    emit('I', f.id);
                    for (const r of s.all('SELECT id FROM symbols WHERE file_id = ?', f.id)) { s.run('DELETE FROM fts WHERE rowid = ?', r.id); s.run('DELETE FROM doc_fts WHERE rowid = ?', r.id); }
                    s.run('DELETE FROM file_fts WHERE rowid = ?', f.id);
                    for (const tb of ['symbols', 'refs', 'refs_unbound', 'imports', 'fields']) s.run(`DELETE FROM ${tb} WHERE file_id = ?`, f.id);
                    s.run('DELETE FROM files WHERE id = ?', f.id);
                    t.removeFile(f.id);
                    this.deps.delete(f.id);
                    // a file still on disk (grown too big to index) is still where its imports lead, as a fresh discovery has it
                    if (!safeStat(path.join(this.root, rel))?.isFile()) this.modules?.removeFile(rel);
                    fileSetChanged = true;
                    if (MODULE_MAP_READERS.has(specForPath(rel)?.id)) moduleFilesChanged = true;
                }
            });
        }

        // parse changed/new files, write in batches; with many files a pool of threads parses the
        // next batch while this one is written
        const BATCH = 200;
        const threads = poolSize(toParse.length);
        const pool = threads ? new ParsePool(threads) : null;
        // a file the parser could not read at all is one unreadable region, so no answer calls it complete
        const failed = (e, rel, source) => { this.log(`parse failed for ${rel}: ${e.message}`); return { symbols: [], refs: [], imports: [], fields: [], fileInfo: null, errors: 1, errorLines: [[1, source.split('\n').length]] }; };
        // read and hash a batch now; its extraction starts now with the pool, or when awaited without
        const start = (batch) => {
            const items = [];
            for (const item of batch) {
                let source;
                try { source = fs.readFileSync(path.join(this.root, item.rel), 'utf8'); } catch { continue; }
                const hash = sha1(source);
                if (item.prev && item.prev.hash === hash) {
                    s.run('UPDATE files SET size = ?, mtime_ms = ? WHERE id = ?', item.st.size, Math.floor(item.st.mtimeMs), item.prev.id);
                    unchangedContent++;
                    continue;
                }
                const spec = specForPath(item.rel);
                if (!spec) continue;
                const minified = looksMinified(source);
                const inline = () => extractFile(spec, source, item.rel).catch(e => failed(e, item.rel, source));
                const job = minified ? null : pool ? pool.extract(item.rel, source).catch(inline) : null;
                items.push({ ...item, source, hash, spec, minified, job });
            }
            return items;
        };
        let done = 0;
        try {
            // with the pool, a few batches are in flight so no thread waits; sources held stay bounded
            const ahead = pool ? 4 : 0;
            const queued = [];
            let started = 0;
            const fill = () => { while (started < toParse.length && queued.length <= ahead) { queued.push(start(toParse.slice(started, started + BATCH))); started += BATCH; } };
            for (let i = 0; i < toParse.length; i += BATCH) {
                fill();
                const items = queued.shift();
                fill();
                const parsed = [];
                for (const it of items) {
                    let extraction;
                    if (it.minified) extraction = { symbols: [], refs: [], imports: [], fields: [], fileInfo: null, errors: 0 };
                    else if (it.job) extraction = await it.job;
                    else {
                        try { extraction = await extractFile(it.spec, it.source, it.rel); }
                        catch (e) { extraction = failed(e, it.rel, it.source); }
                    }
                    parsed.push({ rel: it.rel, st: it.st, prev: it.prev, source: it.source, hash: it.hash, spec: it.spec, extraction });
                }
                s.tx(() => {
                    for (const p of parsed) {
                        const fileId = this.#writeFile(p, emit);
                        touched.add(fileId);
                        written.add(fileId);
                        if (p.spec.id === 'go') goTouched = true;
                        if (p.prev) changed++; else { added++; fileSetChanged = true; if (MODULE_MAP_READERS.has(p.spec.id)) moduleFilesChanged = true; }
                    }
                });
                done += Math.min(BATCH, toParse.length - i);
                onProgress?.(done, toParse.length);
            }
        } finally { await pool?.close(); }

        s.tx(() => {
            // where imports lead depends on the file list and the manifests: when either changed, the
            // imports of the files that were not parsed are looked at again
            // (a run that stopped half way may have changed either and not got this far: `resolveAll`.
            // The module map is read directly only by the languages of MODULE_MAP_READERS; the others
            // read it through their stored imports, refreshed just below — so a new markdown file
            // does not send every Rust file through resolution again)
            const again = fileSetChanged || modulesChanged || this.resolveAll;
            if (modulesChanged || moduleFilesChanged || this.resolveAll) emit('G', 'modules');
            // a package or directory gained its first file or lost its last (a file rewritten alone in
            // its directory leaves and comes back: no change)
            if ([...t.pkgDelta.values()].some(d => d !== 0)) emit('G', 'packages');
            for (const fid of this.#refreshImports(again, written)) { touched.add(fid); emit('I', fid); }
            // a file gained its first importer or lost one: what was asked of "who imports it" may answer otherwise
            for (const id of t.importDelta) emit('B', id);
            // the files whose references read something this update altered
            const direct = touched.size;
            if (this.resolveAll) for (const fid of t.files.keys()) touched.add(fid);
            else if (emitted.size) for (const [fid, deps] of this.deps) if (!touched.has(fid) && intersects(deps, emitted)) touched.add(fid);
            this.lastFanout = { changed: written.size + removed.length, dependents: touched.size - direct, keys: emitted.size };
            for (const fid of touched) if (t.file(fid)?.lang === 'go') { goTouched = true; break; }
            // Go's implicit implementations are derived after resolution: resolution never sees them
            if (goTouched) this.#stripStructural();
        });
        const resolved = this.#resolveFiles([...touched]);
        if (goTouched) this.#goImplements();
        this.resolveAll = false;
        const fp = sha1(this.modules.fingerprint());
        if (fp !== this.modulesFp) { this.modulesFp = fp; s.setMeta('modules_fp', fp); }
        this.modulesStale = false;
        if (toParse.length || removed.length || modulesChanged) s.setMeta('resolve_pending', '0');
        if (touched.size || removed.length) this.version++;
        return { added, changed, removed: removed.length, unchangedContent, resolved, dependents: this.lastFanout.dependents };
    }

    /**
     * What resolution can read of a file's definitions, per definition: a signature of everything
     * but its position (name, kind, nesting, type, bases, signature text…) and its length in lines.
     */
    #snapshot(fileId, sigs) {
        const t = this.table, out = new Map();
        const names = t.fileNames.get(fileId);
        for (const id of t.fileSyms.get(fileId) ?? []) {
            const y = t.sym(id);
            // its place among the file's definitions of that name: "the first candidate" is read in that order
            const rank = names?.get(y.name)?.indexOf(id) ?? 0;
            let anc = '';
            for (let p = y.parentId != null ? t.sym(y.parentId) : null, g = 0; p && g < 32; p = p.parentId != null ? t.sym(p.parentId) : null, g++) anc += p.kind + '/';
            out.set(id, {
                name: y.name, qname: y.qname, owner: y.owner, top: y.parentId == null && y.exported, span: y.endLine - y.startLine,
                sig: JSON.stringify([y.name, y.qname, y.kind, y.parentId, y.owner, y.type, y.declaredBases ?? y.bases, y.exported, y.isStatic, y.byRef, sigs.get(id) ?? null, anc, rank]),
            });
        }
        return out;
    }

    /** Emit the keys of every definition of a file (the file appeared, disappeared or changed package). */
    #emitFile(fileId, snap, emit) {
        for (const d of snap.values()) this.#emitSym(fileId, d, emit);
        for (const r of this.table.fieldRows.get(fileId) ?? []) emit('FT', r.owner);
    }

    #emitSym(fileId, d, emit) {
        emit('N', d.name);
        emit('Q', d.qname);
        if (d.owner) emit('O', d.owner);
        if (d.top) emit('X', fileId);
    }

    #writeFile({ rel, st, prev, source, hash, spec, extraction }, emit) {
        const s = this.store, t = this.table;
        const { symbols, refs, imports, fields, fileInfo, errors, errorLines } = extraction;
        const lines = lineStarts(source);
        const isTest = spec.testFile?.test(rel) ? 1 : 0;
        const pkg = fileInfo?.package ?? null;
        let fileId;
        let oldSyms = [];
        let before = null; // what the rest of the repository could read of this file before the change
        if (prev) {
            fileId = prev.id;
            oldSyms = s.all('SELECT id, qname, kind, ordinal, sig FROM symbols WHERE file_id = ?', fileId);
            before = {
                snap: this.#snapshot(fileId, new Map(oldSyms.map(o => [o.id, o.sig]))),
                imports: importsKey(Map.prototype.get.call(t.imports, fileId) ?? []),
                fields: fieldsByOwner(t.fieldRows.get(fileId) ?? []),
                pkg: t.file(fileId)?.package ?? null,
            };
            for (const o of oldSyms) { s.run('DELETE FROM fts WHERE rowid = ?', o.id); s.run('DELETE FROM doc_fts WHERE rowid = ?', o.id); }
            s.run('DELETE FROM file_fts WHERE rowid = ?', fileId);
            for (const tb of ['symbols', 'refs', 'refs_unbound', 'imports', 'fields']) s.run(`DELETE FROM ${tb} WHERE file_id = ?`, fileId);
            s.run('UPDATE files SET lang = ?, size = ?, mtime_ms = ?, hash = ?, lines = ?, package = ?, is_test = ?, parse_errors = ?, parse_error_lines = ?, indexed_at = ? WHERE id = ?',
                spec.id, st.size, Math.floor(st.mtimeMs), hash, lines.length, pkg, isTest, errors, errorLines?.length ? JSON.stringify(errorLines) : null, Date.now(), fileId);
            t.removeFile(fileId);
        } else {
            const r = s.run('INSERT INTO files (path, lang, size, mtime_ms, hash, lines, package, is_test, parse_errors, parse_error_lines, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                rel, spec.id, st.size, Math.floor(st.mtimeMs), hash, lines.length, pkg, isTest, errors, errorLines?.length ? JSON.stringify(errorLines) : null, Date.now());
            fileId = Number(r.lastInsertRowid);
        }
        t.addFile({ id: fileId, path: rel, lang: spec.id, package: pkg, isTest: !!isTest });

        // stable ids: reuse by (qname, kind, ordinal)
        const oldByKey = new Map(oldSyms.map(o => [o.qname + '\0' + o.kind + '\0' + o.ordinal, o.id]));
        const ordinals = new Map();
        const ids = new Array(symbols.length);
        const sigs = new Map();
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
            const r = s.run(`INSERT INTO symbols (id, file_id, name, name_lc, qname, kind, parent_id, owner, start_line, start_col, end_line, end_col, name_line, name_col, sig, doc, type, exported, visibility, decorators, bases, ordinal, is_static, seq)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                reuse ?? null, fileId, sym.name, sym.name.toLowerCase(), sym.qname, sym.kind, parentId, sym.owner, sym.startLine, sym.startCol, sym.endLine, sym.endCol,
                sym.nameLine, sym.nameCol, sym.sig || null, sym.doc || null, sym.type, sym.exported ? 1 : 0, sym.visibility, decorators, bases, ord, sym.isStatic ? 1 : 0, i);
            const id = reuse ?? Number(r.lastInsertRowid);
            ids[i] = id;
            sigs.set(id, sym.sig || null);
            t.addSym({ id, fileId, name: sym.name, qname: sym.qname, kind: sym.kind, parentId, owner: sym.owner, type: sym.type, bases: sym.bases ?? [], exported: !!sym.exported, isStatic: !!sym.isStatic, startLine: sym.startLine, endLine: sym.endLine, byRef: !!sym.decorators?.[0]?.startsWith('impl &'), path: rel, seq: i });
        }
        // FTS documents; documentation goes to its own table and has no file document
        if (spec.docs) {
            for (let i = 0; i < symbols.length; i++) {
                const sym = symbols[i];
                const a = lines[sym.startLine - 1] ?? 0;
                const b = sym.endLine >= lines.length ? source.length : lines[sym.endLine];
                s.run('INSERT INTO doc_fts (rowid, name, body) VALUES (?, ?, ?)', ids[i], tokenString(sym.qname.replace(/ › /g, ' ')), codeTokens(source.slice(a, b), { maxTokens: BODY_TOKEN_CAP }).join(' '));
            }
        }
        for (let i = 0; i < symbols.length && !spec.docs; i++) {
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
        if (!spec.docs) s.run('INSERT INTO file_fts (rowid, path, body) VALUES (?, ?, ?)', fileId, pathTokens, codeTokens(source, { maxTokens: FILE_TOKEN_CAP }).join(' '));
        // refs (unresolved for now)
        for (const r of refs) {
            s.run('INSERT INTO refs (file_id, src_id, name, kind, line, col, recv, recv_type, argc, arg_types) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                fileId, r.symIdx >= 0 ? ids[r.symIdx] : null, r.name, r.kind, r.line, r.col, r.recv || null, r.recvType || null, r.argc ?? null, r.argTypes ? JSON.stringify(r.argTypes) : null);
        }
        // imports (module resolution needs only the file list)
        const impRows = [];
        for (const imp of imports) {
            const target = this.modules.resolveImport(spec.id, rel, imp);
            const targetFileId = target?.file ? Map.prototype.get.call(t.fileByPath, target.file)?.id ?? null : null;
            const row = { source: imp.source ?? null, imported: imp.imported ?? null, local: imp.local ?? null, reexport: imp.reexport ?? null, wildcard: imp.wildcard ? 1 : 0, line: imp.line ?? null, target_file_id: targetFileId, target_dir: target?.dir ?? null };
            s.run('INSERT INTO imports (file_id, source, imported, local, reexport, wildcard, line, target_file_id, target_dir, target_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                fileId, row.source, row.imported, row.local, row.reexport, row.wildcard, row.line, row.target_file_id, row.target_dir, target?.file ?? null);
            impRows.push(rowToImport(row, target?.dir ?? null, target?.file ?? null));
        }
        t.setImports(fileId, impRows);
        for (const f of fields ?? []) s.run('INSERT INTO fields (file_id, owner_qname, name, type) VALUES (?, ?, ?, ?)', fileId, f.owner, f.name, f.type);
        t.setFieldTypes(fileId, (fields ?? []).map(f => ({ owner_qname: f.owner, name: f.name, type: f.type })));

        // what changed for the rest of the repository: the keys other files' resolutions may have read
        const after = this.#snapshot(fileId, sigs);
        if (!before) {
            this.#emitFile(fileId, after, emit);
            emit('P', rel);
        } else {
            const moved = before.pkg !== pkg; // another package: every definition is a different one to its users
            for (const [id, o] of before.snap) {
                const n = after.get(id);
                if (!n || n.sig !== o.sig || moved) { this.#emitSym(fileId, o, emit); if (n) this.#emitSym(fileId, n, emit); }
                else if (n.span !== o.span) emit('L', o.name);
            }
            for (const [id, n] of after) if (!before.snap.has(id)) this.#emitSym(fileId, n, emit);
            if (importsKey(impRows) !== before.imports) emit('I', fileId);
            const now = fieldsByOwner(t.fieldRows.get(fileId) ?? []);
            for (const owner of new Set([...before.fields.keys(), ...now.keys()])) if (before.fields.get(owner) !== now.get(owner)) emit('FT', owner);
        }
        return fileId;
    }

    /**
     * Bring stored import targets in line with the module map. `all`: the file list or a manifest
     * changed, so every import of the files that were not parsed in this run is resolved again;
     * otherwise only targets that were waiting for their file to be indexed are filled in.
     * @returns {number[]} the files, not parsed in this run, whose imports now lead elsewhere
     */
    #refreshImports(all, written) {
        const s = this.store, t = this.table;
        const moved = [];
        for (const [fid, imps] of t.imports) {
            const f = t.file(fid);
            if (!f || !imps.length) continue;
            const again = all && !written.has(fid);
            let changed = false;
            for (const imp of imps) {
                let file = imp.targetPath, dir = imp.targetDir;
                if (again) { const target = this.modules.resolveImport(f.lang, f.path, imp); file = target?.file ?? null; dir = target?.dir ?? null; }
                else if (imp.targetFileId != null || !file) continue;
                const id = file ? Map.prototype.get.call(t.fileByPath, file)?.id ?? null : null;
                if (file !== imp.targetPath || dir !== imp.targetDir || id !== imp.targetFileId) { imp.targetPath = file; imp.targetDir = dir; imp.targetFileId = id; changed = true; }
            }
            if (!changed) continue;
            s.run('DELETE FROM imports WHERE file_id = ?', fid);
            for (const imp of imps) {
                s.run('INSERT INTO imports (file_id, source, imported, local, reexport, wildcard, line, target_file_id, target_dir, target_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    fid, imp.source, imp.imported, imp.local, imp.reexport, imp.wildcard ? 1 : 0, imp.line ?? null, imp.targetFileId, imp.targetDir, imp.targetPath);
            }
            t.setImports(fid, imps);
            if (!written.has(fid)) moved.push(fid);
        }
        return moved;
    }

    /** Take Go's implicit implementations out of the table and the store (they are derived again after resolution). */
    #stripStructural() {
        const s = this.store, t = this.table;
        const old = s.all("SELECT DISTINCT src_id, name FROM refs WHERE kind = 'inherit' AND recv_type = '~structural'");
        s.run("DELETE FROM refs WHERE kind = 'inherit' AND recv_type = '~structural'");
        for (const o of old) {
            const sym = t.sym(o.src_id);
            if (sym && sym.structural?.has(o.name)) { sym.bases = sym.bases.filter(b => b !== o.name || sym.declaredBases?.includes(b)); sym.structural.delete(o.name); }
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
            const goFile = (fid) => t.file(fid)?.lang === 'go';
            const dirOf = (fid) => { const f = t.file(fid); return f ? path.posix.dirname(f.path) : null; };
            const ifaces = [], types = [];
            for (const sym of t.syms.values()) {
                if (!goFile(sym.fileId)) continue;
                if (sym.kind === 'interface') ifaces.push(sym);
                else if (sym.kind === 'struct' || sym.kind === 'type' || sym.kind === 'class') types.push(sym);
            }
            if (!ifaces.length || !types.length) return;
            // in the table's canonical order, whatever order the files were indexed in
            ifaces.sort((a, b) => t.cmp(a, b));
            types.sort((a, b) => t.cmp(a, b));
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

    /**
     * Resolve every reference of these files again, recording for each file what its resolution
     * read. A reference that binds to nothing in the repository moves to `refs_unbound`, and one
     * kept there that now binds comes back.
     */
    #resolveFiles(fileIds) {
        if (!fileIds.length) return 0;
        const s = this.store, t = this.table;
        const droppable = (r, res) => res.id == null && (r.kind === 'value' || r.kind === 'read' || r.kind === 'type' || res.external);
        let n = 0;
        s.tx(() => {
            for (const fid of fileIds) {
                if (!t.file(fid)) continue;
                const rows = s.all("SELECT id, file_id, src_id, name, kind, line, col, recv, recv_type, argc, arg_types, dst_id, conf, ncand FROM refs WHERE file_id = ? AND (recv_type IS NULL OR recv_type != '~structural')", fid);
                const unbound = s.all('SELECT id, file_id, src_id, name, kind, line, col, recv, recv_type, argc, arg_types FROM refs_unbound WHERE file_id = ?', fid);
                // nothing computed for another file is reused: what this file's answers read is all recorded here
                this.resolver.resetMemo();
                const deps = t.deps = newDeps();
                try {
                    // one order for both lists, the same whether the index is being built or brought up
                    // to date: by position, as the file reads (rows move between the two tables as
                    // they gain and lose a target, so their own order says nothing)
                    const all = [...rows, ...unbound.map(r => ({ ...r, aside: true }))].sort((x, y) => x.line - y.line || x.col - y.col || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
                    for (const r of all) {
                        const res = this.resolver.resolve(r);
                        if (r.aside) {
                            if (droppable(r, res)) continue;
                            s.run('DELETE FROM refs_unbound WHERE id = ?', r.id);
                            s.run('INSERT INTO refs (file_id, src_id, name, kind, line, col, recv, recv_type, dst_id, conf, ncand, argc, arg_types) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', fid, r.src_id, r.name, r.kind, r.line, r.col, r.recv, r.recv_type, res.id, res.conf, res.ncand ?? 0, r.argc, r.arg_types);
                            if (res.id != null) n++;
                            continue;
                        }
                        if (droppable(r, res)) {
                            s.run('DELETE FROM refs WHERE id = ?', r.id);
                            s.run('INSERT INTO refs_unbound (file_id, src_id, name, kind, line, col, recv, recv_type, argc, arg_types) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', fid, r.src_id, r.name, r.kind, r.line, r.col, r.recv, r.recv_type, r.argc, r.arg_types);
                            continue;
                        }
                        const ncand = res.ncand ?? 0;
                        if (res.id !== r.dst_id || res.conf !== r.conf || ncand !== r.ncand) s.run('UPDATE refs SET dst_id = ?, conf = ?, ncand = ? WHERE id = ?', res.id, res.conf, ncand, r.id);
                        if (res.id != null) n++;
                    }
                } finally { t.deps = null; }
                const keys = packDeps(deps);
                this.deps.set(fid, keys);
                s.run('UPDATE files SET deps = ? WHERE id = ?', new Uint8Array(keys.buffer, keys.byteOffset, keys.byteLength), fid);
            }
        });
        this.resolver.resetMemo();
        return n;
    }
}

const EMPTY_DEPS = new Uint32Array(0);

/** A file's recorded reads as a sorted array of distinct key hashes. */
function packDeps(deps) {
    const set = new Set();
    for (const kind of Object.keys(deps)) for (const key of deps[kind]) set.add(depHash(kind, String(key)));
    return Uint32Array.from(set).sort();
}

/** Does a sorted array of key hashes hold any of the emitted ones? */
function intersects(sorted, emitted) {
    if (!sorted.length) return false;
    if (emitted.size > 24) { for (let i = 0; i < sorted.length; i++) if (emitted.has(sorted[i])) return true; return false; }
    for (const h of emitted) {
        let lo = 0, hi = sorted.length - 1;
        while (lo <= hi) { const mid = (lo + hi) >> 1; const v = sorted[mid]; if (v === h) return true; if (v < h) lo = mid + 1; else hi = mid - 1; }
    }
    return false;
}

/** The parts of a file's imports that other files' resolutions read (not their lines). */
function importsKey(imps) {
    return JSON.stringify(imps.map(i => [i.source, i.imported, i.local, i.reexport, i.wildcard ? 1 : 0, i.targetPath ?? null, i.targetDir ?? null]));
}

function fieldsByOwner(rows) {
    const by = new Map();
    for (const r of rows) by.set(r.owner, (by.get(r.owner) ?? '') + r.name + '\u0000' + r.type + '\u0001');
    return by;
}

function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }

function rowToSym(r) {
    return {
        id: r.id, fileId: r.file_id, name: r.name, qname: r.qname, kind: r.kind, parentId: r.parent_id ?? null, owner: r.owner ?? null,
        type: r.type ?? null, bases: r.bases ? JSON.parse(r.bases) : [], exported: !!r.exported, isStatic: !!r.is_static, startLine: r.start_line, endLine: r.end_line,
        byRef: r.decorators ? /^\["impl &/.test(r.decorators) : false, seq: r.seq ?? undefined,
    };
}

function rowToImport(r, dir = null, targetPath = null) {
    return {
        source: r.source, imported: r.imported, local: r.local, reexport: r.reexport, wildcard: !!r.wildcard, line: r.line ?? null,
        targetFileId: r.target_file_id ?? null, targetDir: dir ?? r.target_dir ?? null, targetPath,
    };
}
