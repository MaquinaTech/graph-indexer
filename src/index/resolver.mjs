/**
 * Reference resolution: binds every reference occurrence to the definition it most likely
 * denotes, with an explicit confidence, using only what a parser can see:
 *
 *   receiver `this`/`self`/`super`   → members of the enclosing type (+ inherited)
 *   receiver with an inferred type    → members of that type (+ inherited), across files
 *   receiver that is an import alias  → exported symbol of that module / package
 *   bare name                         → nested scope → enclosing type (implicit-this languages)
 *                                       → same file → explicit import → same package/dir
 *                                       → wildcard import → unique global name → ambiguous
 *
 * Confidence scale: ≥0.9 exact (scope/type/import proven) · ≥0.7 high · ≥0.4 likely · <0.4 possible.
 * Ambiguous references stay attached to the best candidate with a low confidence and a
 * candidate count, so tools can say "3 possible targets" instead of guessing silently.
 */
import path from 'node:path';

const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'type', 'object', 'module', 'impl']);
const CALLABLE_KINDS = new Set(['function', 'method', 'constructor', 'macro']);
const MEMBER_HOLDERS = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'object', 'impl', 'module']);
const PACKAGE_LANGS = new Set(['java', 'kotlin', 'scala', 'csharp', 'php']);
const DIR_PACKAGE_LANGS = new Set(['go']);
const MAX_GLOBAL_CANDIDATES = 12;

function push(map, key, val) {
    const a = map.get(key);
    if (a) a.push(val); else map.set(key, [val]);
}

export class SymbolTable {
    constructor() {
        this.syms = new Map();          // id -> sym
        this.byName = new Map();        // name -> [id]
        this.byQname = new Map();       // qname -> [id]
        this.byParent = new Map();      // parentId -> Map(name -> [id])
        this.byOwner = new Map();       // owner name -> [id] (members declared outside their type: Go/Rust/C++/JS prototype)
        this.fileSyms = new Map();      // fileId -> [id]
        this.files = new Map();         // fileId -> { id, path, lang, package, dir, isTest }
        this.fileByPath = new Map();
        this.packageFiles = new Map();  // package -> [fileId]
        this.dirFiles = new Map();      // dir -> [fileId]
        this.imports = new Map();       // fileId -> [imp]
        this.importedBy = new Map();    // fileId -> Set(fileId)
        this.fieldTypes = new Map();    // ownerQname -> Map(name -> type)
    }

    addFile(f) {
        const file = { ...f, dir: path.posix.dirname(f.path) };
        this.files.set(f.id, file);
        this.fileByPath.set(f.path, file);
        if (f.package) push(this.packageFiles, f.package, f.id);
        push(this.dirFiles, file.dir, f.id);
        this.fileSyms.set(f.id, []);
    }

    removeFile(fileId) {
        const f = this.files.get(fileId);
        if (!f) return;
        for (const id of this.fileSyms.get(fileId) ?? []) this.#removeSym(id);
        this.fileSyms.delete(fileId);
        this.files.delete(fileId);
        this.fileByPath.delete(f.path);
        const rm = (map, key) => { const a = map.get(key); if (a) { const i = a.indexOf(fileId); if (i >= 0) a.splice(i, 1); } };
        if (f.package) rm(this.packageFiles, f.package);
        rm(this.dirFiles, f.dir);
        this.setImports(fileId, []);
        for (const [q, m] of this.fieldTypes) if (m.fileId === fileId) this.fieldTypes.delete(q);
    }

    addSym(s) {
        this.syms.set(s.id, s);
        push(this.byName, s.name, s.id);
        push(this.byQname, s.qname, s.id);
        if (s.parentId != null) {
            let m = this.byParent.get(s.parentId);
            if (!m) this.byParent.set(s.parentId, (m = new Map()));
            push(m, s.name, s.id);
        }
        if (s.owner && (s.parentId == null || this.syms.get(s.parentId)?.name !== s.owner)) push(this.byOwner, s.owner, s.id);
        push(this.fileSyms, s.fileId, s.id);
    }

    #removeSym(id) {
        const s = this.syms.get(id);
        if (!s) return;
        const rm = (map, key) => { const a = map.get(key); if (a) { const i = a.indexOf(id); if (i >= 0) a.splice(i, 1); if (!a.length) map.delete(key); } };
        rm(this.byName, s.name);
        rm(this.byQname, s.qname);
        if (s.parentId != null) { const m = this.byParent.get(s.parentId); if (m) rm(m, s.name); }
        if (s.owner) rm(this.byOwner, s.owner);
        this.byParent.delete(id);
        this.syms.delete(id);
    }

    setImports(fileId, imps) {
        for (const old of this.imports.get(fileId) ?? []) {
            if (old.targetFileId != null) this.importedBy.get(old.targetFileId)?.delete(fileId);
        }
        this.imports.set(fileId, imps);
        for (const imp of imps) {
            if (imp.targetFileId != null) {
                let s = this.importedBy.get(imp.targetFileId);
                if (!s) this.importedBy.set(imp.targetFileId, (s = new Set()));
                s.add(fileId);
            }
        }
    }

    setFieldTypes(fileId, rows) {
        for (const r of rows) {
            let m = this.fieldTypes.get(r.owner_qname ?? r.owner);
            if (!m) { m = new Map(); m.fileId = fileId; this.fieldTypes.set(r.owner_qname ?? r.owner, m); }
            if (!m.has(r.name)) m.set(r.name, r.type);
        }
    }

    sym(id) { return this.syms.get(id); }
    file(id) { return this.files.get(id); }
}

export class Resolver {
    constructor(table, specsById) {
        this.t = table;
        this.specs = specsById; // lang id -> spec (implicitThis etc.)
        this.memo = new Map();
    }

    resetMemo() { this.memo.clear(); }

    // ── type & member helpers ─────────────────────────────────────────────────────

    /** Enclosing type of a symbol: {id?, name} or null. */
    enclosingType(symId) {
        for (let s = this.t.sym(symId), guard = 0; s && guard < 32; s = s.parentId != null ? this.t.sym(s.parentId) : null, guard++) {
            if (MEMBER_HOLDERS.has(s.kind) && s.kind !== 'module') return { id: s.id, name: s.name, fileId: s.fileId };
            if (s.owner && (CALLABLE_KINDS.has(s.kind) || s.kind === 'field' || s.kind === 'property')) {
                const typeSym = this.#typeByNameNear(s.owner, s.fileId);
                return typeSym ? { id: typeSym.id, name: typeSym.name, fileId: typeSym.fileId } : { id: null, name: s.owner, fileId: s.fileId };
            }
        }
        return null;
    }

    #typeByNameNear(name, fileId) {
        const ids = this.t.byName.get(name);
        if (!ids) return null;
        let best = null, bestScore = -1;
        const f = this.t.file(fileId);
        for (const id of ids) {
            const s = this.t.sym(id);
            if (!TYPE_KINDS.has(s.kind)) continue;
            const sf = this.t.file(s.fileId);
            const score = (s.fileId === fileId ? 4 : 0) + (sf?.dir === f?.dir ? 2 : 0) + (sf?.package && sf.package === f?.package ? 2 : 0);
            if (score > bestScore) { best = s; bestScore = score; }
        }
        return best;
    }

    /** Members named `name` of a type (by id and/or name), including inherited ones. */
    membersOf(type, name, depth = 0, seen = new Set()) {
        if (!type || depth > 6) return [];
        const key = (type.id ?? '') + ':' + type.name;
        if (seen.has(key)) return [];
        seen.add(key);
        const out = [];
        if (type.id != null) for (const id of this.t.byParent.get(type.id)?.get(name) ?? []) out.push(id);
        for (const id of this.t.byOwner.get(type.name) ?? []) {
            const s = this.t.sym(id);
            if (s.name !== name) continue;
            // owner-declared members must live near the type (same package/dir/file family)
            if (type.fileId != null) {
                const a = this.t.file(s.fileId), b = this.t.file(type.fileId);
                if (a && b && a.lang === b.lang && (a.dir === b.dir || a.package === b.package || a.lang === 'cpp' || a.lang === 'c' || a.lang === 'rust' || a.lang === 'javascript' || a.lang === 'typescript')) out.push(id);
            } else out.push(id);
        }
        if (out.length) return out;
        const typeSym = type.id != null ? this.t.sym(type.id) : null;
        for (const base of typeSym?.bases ?? []) {
            const bt = this.resolveTypeName(base, typeSym.fileId);
            if (bt) {
                const r = this.membersOf({ id: bt.id, name: bt.name, fileId: bt.fileId }, name, depth + 1, seen);
                if (r.length) return r;
            } else if (base !== type.name) {
                const r = this.membersOf({ id: null, name: base, fileId: null }, name, depth + 1, seen);
                if (r.length) return r;
            }
        }
        return out;
    }

    /** Resolve a type name visible from a file to a type symbol. */
    resolveTypeName(name, fileId) {
        if (!name) return null;
        const k = 't|' + fileId + '|' + name;
        if (this.memo.has(k)) return this.memo.get(k);
        this.memo.set(k, null); // cycle guard
        const r = this.#resolveName(name, 'type', fileId, null);
        const s = r && r.id != null ? this.t.sym(r.id) : null;
        const res = s && TYPE_KINDS.has(s.kind) ? s : null;
        this.memo.set(k, res);
        return res;
    }

    /** Resolve an extraction-time receiver type descriptor to a type {id,name,fileId}. */
    resolveRecvType(desc, fileId, srcId) {
        if (!desc) return null;
        const k = 'r|' + fileId + '|' + desc;
        if (this.memo.has(k)) return this.memo.get(k);
        this.memo.set(k, null);
        let res = null;
        const parts = desc.split('#');
        let head = parts[0];
        let cur = null;
        if (head.startsWith('call:')) {
            const fn = head.slice(5);
            const r = this.#resolveName(fn, 'call', fileId, srcId);
            const s = r?.id != null ? this.t.sym(r.id) : null;
            if (s) {
                if (TYPE_KINDS.has(s.kind)) cur = s;
                else if (s.type) cur = this.resolveTypeName(s.type, s.fileId);
            }
        } else {
            // same-file qualified name first (this.x → Class#x uses the class qname)
            const q = (this.t.byQname.get(head) ?? []).map(id => this.t.sym(id)).find(s => s.fileId === fileId && TYPE_KINDS.has(s.kind));
            cur = q ?? this.resolveTypeName(head.split('.').pop(), fileId);
            if (!cur && parts.length === 1) res = null;
            if (!cur && head.includes('.')) {
                // enclosing class that is not a symbol itself (e.g. JS prototype owner)
                cur = { id: null, name: head.split('.').pop(), fileId };
            }
        }
        for (let i = 1; i < parts.length && cur; i++) {
            const mem = this.membersOf({ id: cur.id ?? null, name: cur.name, fileId: cur.fileId }, parts[i]);
            let nextType = null;
            for (const id of mem) {
                const m = this.t.sym(id);
                if (m.type) { nextType = this.resolveTypeName(m.type, m.fileId); if (nextType) break; }
            }
            if (!nextType) {
                // inferred field types (self.x = X() / this.x = new X())
                const ft = this.t.fieldTypes.get(cur.qname ?? cur.name)?.get(parts[i]);
                if (ft) nextType = ft.startsWith('call:') ? this.resolveRecvType(ft, cur.fileId ?? fileId, null) : this.resolveTypeName(ft, cur.fileId ?? fileId);
            }
            cur = nextType;
        }
        if (cur) res = { id: cur.id ?? null, name: cur.name, fileId: cur.fileId ?? null };
        this.memo.set(k, res);
        return res;
    }

    // ── import helpers ───────────────────────────────────────────────────────────

    #importFor(fileId, local) {
        for (const imp of this.t.imports.get(fileId) ?? []) if (imp.local === local) return imp;
        return null;
    }

    /** Top-level symbols named `name` exported by a module file, following re-exports. */
    exportedFrom(targetFileId, name, depth = 0, seen = new Set()) {
        if (targetFileId == null || depth > 6 || seen.has(targetFileId)) return [];
        seen.add(targetFileId);
        const out = [];
        for (const id of this.t.fileSyms.get(targetFileId) ?? []) {
            const s = this.t.sym(id);
            if (s.name === name && s.parentId == null) out.push(id);
        }
        if (out.length) return out;
        for (const imp of this.t.imports.get(targetFileId) ?? []) {
            // `export { X } from './x'`, `export * from './x'`, Python `from .x import X` in __init__
            const passes = imp.reexport === name || imp.reexport === '*' || imp.local === name || (imp.wildcard && imp.imported === '*');
            if (!passes || imp.targetFileId == null) continue;
            const inner = imp.reexport === name && imp.imported && imp.imported !== '*' ? imp.imported : (imp.local === name && imp.imported && imp.imported !== '*' ? imp.imported : name);
            const r = this.exportedFrom(imp.targetFileId, inner, depth + 1, seen);
            if (r.length) return r;
        }
        return out;
    }

    #symbolsInDir(dir, name, fileId) {
        const out = [];
        for (const fid of this.t.dirFiles.get(dir) ?? []) {
            for (const id of this.t.fileSyms.get(fid) ?? []) {
                const s = this.t.sym(id);
                if (s.name === name && (s.parentId == null) && !(s.kind === 'method' && s.owner)) out.push(id);
            }
        }
        return out;
    }

    #symbolsInPackage(pkg, name) {
        const out = [];
        for (const fid of this.t.packageFiles.get(pkg) ?? []) {
            for (const id of this.t.fileSyms.get(fid) ?? []) {
                const s = this.t.sym(id);
                if (s.name === name && s.parentId == null) out.push(id);
            }
        }
        return out;
    }

    // ── main entry ───────────────────────────────────────────────────────────────

    /**
     * Resolve one reference.
     * @param {{ name, kind, recv, recv_type, file_id, src_id }} ref
     * @returns {{ id: number|null, conf: number, ncand: number }}
     */
    resolve(ref) {
        const fileId = ref.file_id;
        const srcId = ref.src_id ?? null;
        const recv = ref.recv || '';
        const kind = ref.kind;
        const name = ref.name;
        if (recv) return this.#resolveMember(name, kind, recv, ref.recv_type, fileId, srcId);
        return this.#resolveName(name, kind, fileId, srcId) ?? { id: null, conf: 0, ncand: 0 };
    }

    #compatible(s, kind) {
        if (kind === 'type' || kind === 'inherit') return TYPE_KINDS.has(s.kind);
        if (kind === 'new') return TYPE_KINDS.has(s.kind) || s.kind === 'function' || s.kind === 'constructor';
        if (kind === 'call') return CALLABLE_KINDS.has(s.kind) || TYPE_KINDS.has(s.kind) || s.kind === 'variable' || s.kind === 'field' || s.kind === 'property' || s.kind === 'constant';
        if (kind === 'decorator') return CALLABLE_KINDS.has(s.kind) || TYPE_KINDS.has(s.kind) || s.kind === 'variable';
        return true;
    }

    #pick(ids, kind, conf, fileId) {
        const cands = ids.map(id => this.t.sym(id)).filter(s => s && this.#compatible(s, kind));
        if (!cands.length) return null;
        if (cands.length === 1) return { id: cands[0].id, conf, ncand: 1 };
        // overloads / redeclarations in one type or file: prefer the definition with a body (larger span)
        const sameQ = cands.every(s => s.qname === cands[0].qname);
        const scored = cands.map(s => ({ s, score: this.#proximity(s, fileId) + (s.endLine - s.startLine) / 1e4 }));
        scored.sort((a, b) => b.score - a.score || a.s.id - b.s.id);
        return { id: scored[0].s.id, conf: sameQ ? conf : conf * 0.75, ncand: cands.length };
    }

    #proximity(s, fileId) {
        const a = this.t.file(s.fileId), b = this.t.file(fileId);
        if (!a || !b) return 0;
        let score = 0;
        if (s.fileId === fileId) score += 4;
        if (a.dir === b.dir) score += 2;
        if (a.package && a.package === b.package) score += 1.5;
        if (this.t.importedBy.get(s.fileId)?.has(fileId)) score += 3;
        const pa = a.dir.split('/'), pb = b.dir.split('/');
        let common = 0;
        while (common < pa.length && common < pb.length && pa[common] === pb[common]) common++;
        score += common * 0.15;
        if (a.isTest && !b.isTest) score -= 3;
        if (a.lang !== b.lang) score -= 2;
        if (s.exported) score += 0.3;
        return score;
    }

    #resolveName(name, kind, fileId, srcId) {
        const file = this.t.file(fileId);
        if (!file) return null;
        const spec = this.specs[file.lang];
        // 1. lexical scope: symbols nested in enclosing definitions (closures, inner functions)
        for (let s = srcId != null ? this.t.sym(srcId) : null, g = 0; s && g < 32; s = s.parentId != null ? this.t.sym(s.parentId) : null, g++) {
            const ids = this.t.byParent.get(s.id)?.get(name);
            if (ids?.length && !MEMBER_HOLDERS.has(s.kind)) {
                const r = this.#pick(ids, kind, 0.95, fileId);
                if (r) return r;
            }
            if (s.name === name && kind === 'call' && CALLABLE_KINDS.has(s.kind)) return { id: s.id, conf: 0.9, ncand: 1 }; // recursion
        }
        // 2. implicit this: members of the enclosing type (Java/Kotlin/C#/Scala/C++/Ruby)
        if (spec?.implicitThis && srcId != null && kind !== 'type' && kind !== 'inherit') {
            const type = this.enclosingType(srcId);
            if (type) {
                const r = this.#pick(this.membersOf(type, name), kind, 0.9, fileId);
                if (r) return r;
            }
        }
        // 3. same file, top-level
        const local = (this.t.fileSyms.get(fileId) ?? []).filter(id => { const s = this.t.sym(id); return s.name === name && (s.parentId == null || TYPE_KINDS.has(s.kind)); });
        if (local.length) {
            const r = this.#pick(local, kind, 0.9, fileId);
            if (r) return r;
        }
        // 4. explicit import binding
        const imp = this.#importFor(fileId, name);
        if (imp) {
            const target = imp.imported && imp.imported !== '*' && imp.imported !== 'default' ? imp.imported : name;
            let ids = [];
            if (imp.targetFileId != null) {
                ids = this.exportedFrom(imp.targetFileId, target);
                if (!ids.length && imp.imported === 'default') ids = this.#defaultExport(imp.targetFileId, name);
            }
            if (!ids.length && imp.targetDir) ids = this.#symbolsInDir(imp.targetDir, target, fileId);
            if (!ids.length && imp.source && PACKAGE_LANGS.has(file.lang)) ids = this.#symbolsInPackage(imp.source, target);
            if (ids.length) {
                const r = this.#pick(ids, kind, 0.95, fileId);
                if (r) return r;
            }
            if (imp.targetFileId == null && !imp.targetDir && !PACKAGE_LANGS.has(file.lang)) return { id: null, conf: 0, ncand: 0, external: true };
        }
        // 5. same package / directory
        if (PACKAGE_LANGS.has(file.lang) && file.package) {
            const r = this.#pick(this.#symbolsInPackage(file.package, name), kind, 0.85, fileId);
            if (r) return r;
        }
        if (DIR_PACKAGE_LANGS.has(file.lang)) {
            const r = this.#pick(this.#symbolsInDir(file.dir, name, fileId), kind, 0.85, fileId);
            if (r) return r;
        }
        // 6. wildcard imports (import pkg.*, from x import *, using Ns;, use x::*)
        for (const w of this.t.imports.get(fileId) ?? []) {
            if (!w.wildcard) continue;
            let ids = [];
            if (w.targetFileId != null) ids = this.exportedFrom(w.targetFileId, name);
            else if (w.targetDir) ids = this.#symbolsInDir(w.targetDir, name, fileId);
            else if (w.source && PACKAGE_LANGS.has(file.lang)) ids = this.#symbolsInPackage(w.source, name);
            const r = ids.length ? this.#pick(ids, kind, 0.85, fileId) : null;
            if (r) return r;
        }
        // 7. C/C++: included headers and their implementation files
        if (file.lang === 'c' || file.lang === 'cpp') {
            const ids = [];
            for (const inc of this.t.imports.get(fileId) ?? []) {
                if (inc.targetFileId == null) continue;
                const hdr = this.t.file(inc.targetFileId);
                ids.push(...this.exportedFrom(inc.targetFileId, name));
                const stem = hdr.path.replace(/\.(h|hh|hpp|hxx)$/, '');
                for (const ext of ['.c', '.cc', '.cpp', '.cxx']) {
                    const impl = this.t.fileByPath.get(stem + ext);
                    if (impl) ids.push(...this.exportedFrom(impl.id, name));
                }
            }
            const r = ids.length ? this.#pick(ids, kind, 0.8, fileId) : null;
            if (r) return r;
        }
        // 8. global by name
        return this.#global(name, kind, fileId);
    }

    #defaultExport(targetFileId, localName) {
        // `export default class Foo` / `module.exports = Foo` → the file's main exported symbol
        const ids = (this.t.fileSyms.get(targetFileId) ?? []).filter(id => { const s = this.t.sym(id); return s.parentId == null && s.exported; });
        const same = ids.filter(id => this.t.sym(id).name.toLowerCase() === localName.toLowerCase());
        if (same.length) return same;
        return ids.length === 1 ? ids : [];
    }

    #global(name, kind, fileId) {
        const all = (this.t.byName.get(name) ?? []).filter(id => {
            const s = this.t.sym(id);
            return s && this.#compatible(s, kind) && (s.parentId == null || TYPE_KINDS.has(s.kind) || kind === 'call');
        });
        const file = this.t.file(fileId);
        // never bind across unrelated languages (a TS call never resolves to a Python def)
        const sameFamily = all.filter(id => {
            const f = this.t.file(this.t.sym(id).fileId);
            return f && (f.lang === file.lang || familyOf(f.lang) === familyOf(file.lang));
        });
        // unqualified calls cannot target methods of unrelated classes in most languages
        const cands = sameFamily.filter(id => {
            const s = this.t.sym(id);
            if (s.kind === 'method' || s.kind === 'field' || s.kind === 'property') return false;
            return true;
        });
        if (!cands.length) return null;
        if (cands.length > MAX_GLOBAL_CANDIDATES) return { id: null, conf: 0, ncand: cands.length };
        const base = cands.length === 1 ? 0.6 : 0.35;
        return this.#pick(cands, kind, base, fileId);
    }

    #resolveMember(name, kind, recv, recvType, fileId, srcId) {
        const file = this.t.file(fileId);
        const root = recv.split('.')[0];
        // this / self / super
        if (root === 'this' || recv === 'super') {
            const type = srcId != null ? this.enclosingType(srcId) : null;
            if (type) {
                if (recv === 'this' || recv === 'super') {
                    let ids;
                    if (recv === 'super') {
                        const ts = type.id != null ? this.t.sym(type.id) : null;
                        ids = [];
                        for (const b of ts?.bases ?? []) { const bt = this.resolveTypeName(b, ts.fileId); if (bt) ids.push(...this.membersOf({ id: bt.id, name: bt.name, fileId: bt.fileId }, name)); }
                    } else ids = this.membersOf(type, name);
                    const r = this.#pick(ids, kind, 0.95, fileId);
                    if (r) return r;
                    return { id: null, conf: 0, ncand: 0 };
                }
            }
        }
        // inferred receiver type (locals, params, fields, factories; chains across files)
        if (recvType) {
            const type = this.resolveRecvType(recvType, fileId, srcId);
            if (type) {
                const ids = this.membersOf(type, name);
                const r = this.#pick(ids, kind, 0.9, fileId);
                if (r) return r;
                // interface / abstract receiver: the member may be declared only on implementations
                return { id: null, conf: 0, ncand: 0 };
            }
        }
        // receiver is an imported module / namespace / package alias
        const imp = this.#importFor(fileId, root) ?? this.#importFor(fileId, recv);
        if (imp) {
            const rest = recv === imp.local ? [] : recv.slice(imp.local.length + 1).split('.').filter(Boolean);
            let ids = [];
            const importedName = imp.imported && imp.imported !== '*' && imp.imported !== 'default' ? imp.imported : null;
            if (importedName && rest.length === 0) {
                // `import { Foo } from './foo'; Foo.bar()` → static member of Foo, or module object's member
                let owners = imp.targetFileId != null ? this.exportedFrom(imp.targetFileId, importedName) : [];
                if (!owners.length && PACKAGE_LANGS.has(file.lang)) owners = this.#symbolsInPackage(imp.source, importedName);
                for (const oid of owners) {
                    const o = this.t.sym(oid);
                    ids.push(...this.membersOf({ id: o.id, name: o.name, fileId: o.fileId }, name));
                }
                if (!ids.length && imp.targetFileId != null && owners.length === 0) {
                    // `from pkg import submodule` then submodule.fn()
                    ids = this.exportedFrom(imp.targetFileId, name);
                }
            } else if (rest.length === 0) {
                if (imp.targetFileId != null) ids = this.exportedFrom(imp.targetFileId, name);
                if (!ids.length && imp.targetDir) ids = this.#symbolsInDir(imp.targetDir, name, fileId);
            } else if (imp.targetFileId != null || imp.targetDir) {
                // ns.Class.method / pkg.sub.fn
                let owners = imp.targetFileId != null ? this.exportedFrom(imp.targetFileId, rest[0]) : this.#symbolsInDir(imp.targetDir, rest[0], fileId);
                for (const oid of owners) {
                    const o = this.t.sym(oid);
                    ids.push(...this.membersOf({ id: o.id, name: o.name, fileId: o.fileId }, name));
                }
            }
            if (ids.length) {
                const r = this.#pick(ids, kind, 0.95, fileId);
                if (r) return r;
            }
            if (imp.targetFileId == null && !imp.targetDir && !PACKAGE_LANGS.has(file.lang)) return { id: null, conf: 0, ncand: 0, external: true };
        }
        // receiver is a type name (static call / namespace-like object)
        if (/^[A-Za-z_$][\w$]*$/.test(root) && !recv.includes('.')) {
            const r0 = this.#resolveName(root, 'type', fileId, srcId);
            let typeSym = r0?.id != null ? this.t.sym(r0.id) : null;
            if (!typeSym) {
                // JS object namespaces (`proto.handle`, `utils.merge`): same-file owner
                const owned = (this.t.byOwner.get(root) ?? []).filter(id => this.t.sym(id).name === name);
                const r = this.#pick(owned, kind, owned.some(id => this.t.sym(id).fileId === fileId) ? 0.8 : 0.6, fileId);
                if (r) return r;
            } else {
                const ids = this.membersOf({ id: typeSym.id, name: typeSym.name, fileId: typeSym.fileId }, name);
                const r = this.#pick(ids, kind, Math.min(0.9, r0.conf), fileId);
                if (r) return r;
            }
        }
        // unknown receiver: any member with that name (dynamic dispatch by name)
        return this.#anyMember(name, kind, fileId) ?? { id: null, conf: 0, ncand: 0 };
    }

    #anyMember(name, kind, fileId) {
        const file = this.t.file(fileId);
        const ids = (this.t.byName.get(name) ?? []).filter(id => {
            const s = this.t.sym(id);
            if (!s || !(s.kind === 'method' || s.kind === 'field' || s.kind === 'property' || s.kind === 'function' && s.owner)) return false;
            const f = this.t.file(s.fileId);
            return f && familyOf(f.lang) === familyOf(file.lang);
        });
        if (!ids.length) return null;
        if (ids.length > MAX_GLOBAL_CANDIDATES) return { id: null, conf: 0, ncand: ids.length };
        return this.#pick(ids, kind, ids.length === 1 ? 0.5 : 0.25, fileId);
    }
}

export function familyOf(lang) {
    if (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') return 'ecma';
    if (lang === 'c' || lang === 'cpp') return 'c';
    if (lang === 'java' || lang === 'kotlin' || lang === 'scala') return 'jvm';
    return lang;
}

export function confidenceLabel(conf) {
    if (conf >= 0.9) return 'exact';
    if (conf >= 0.7) return 'high';
    if (conf >= 0.4) return 'likely';
    return 'possible';
}
