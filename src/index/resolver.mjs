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
import { normalizeType } from '../parse/extract.mjs';
import { fits, sigArity } from '../parse/arity.mjs';

const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'type', 'object', 'module', 'impl']);
const VALUE_TYPED_KINDS = new Set(['variable', 'constant', 'field', 'property']);
const CALLABLE_KINDS = new Set(['function', 'method', 'constructor', 'macro']);
const MEMBER_HOLDERS = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'object', 'impl', 'module']);
const PACKAGE_LANGS = new Set(['java', 'kotlin', 'scala', 'csharp', 'php']);
const DIR_PACKAGE_LANGS = new Set(['go']);
const MAX_GLOBAL_CANDIDATES = 12;

/**
 * Method names that standard-library types of each language family also define (`map.get(k)`,
 * `promise.then()`, `w.Header().Get()`, `list.append()`). A call with an unknown receiver and one
 * of these names is never bound by name alone: it is far more often the library's method than a
 * same-named method in the repository.
 */
const COMMON_MEMBERS = {
    ecma: 'get set has delete add clear forEach map filter reduce reduceRight find findIndex findLast findLastIndex some every includes indexOf lastIndexOf join split slice splice concat push pop shift unshift sort reverse keys values entries fill flat flatMap at apply call bind then catch finally toString valueOf toJSON emit on once off addListener removeListener removeAllListeners listeners send write end close open read pipe resolve reject next return throw test exec match matchAll replace replaceAll trim trimStart trimEnd startsWith endsWith padStart padEnd charAt charCodeAt codePointAt substring substr toLowerCase toUpperCase localeCompare normalize repeat assign create freeze defineProperty hasOwnProperty isArray from of parse stringify log error warn info debug trace json status sendStatus header set setHeader getHeader removeHeader writeHead redirect render use listen subscribe unsubscribe complete pipe lift toPromise getTime toISOString setTimeout clone copy dispose destroy init start stop run update create remove insert append',
    python: 'get set items keys values update pop popitem append extend insert remove clear copy sort reverse index count join split rsplit splitlines strip lstrip rstrip replace format startswith endswith lower upper title encode decode read write close open readline readlines seek tell flush send recv add discard union intersection difference issubset setdefault fromkeys sleep info debug warning warn error exception critical log search match fullmatch findall finditer sub compile group groups groupdict dumps loads dump load exists mkdir makedirs is_file is_dir resolve cast run start stop wait acquire release put get_nowait put_nowait result done cancel',
    go: 'Get Set Add Del Delete Has Len Less Swap String Error Write Read Close Next Value Done Err Lock Unlock RLock RUnlock Wait Load Store LoadOrStore Header WriteHeader Printf Println Print Sprintf Errorf Fatal Fatalf Log Logf Run Cleanup Helper Skip Parse Format Unix Now Since Sub Before After Equal Scan Query QueryRow Exec Begin Commit Rollback Marshal Unmarshal Encode Decode New Copy Reset Bytes Seek Flush Cancel Deadline WithValue Context Body Cookie Query',
    jvm: 'get set add addAll put putAll remove contains containsKey containsValue size isEmpty clear iterator stream map filter collect forEach equals hashCode toString valueOf of apply accept test length charAt substring append build close write read flush println print printf format getName getClass orElse orElseThrow isPresent ifPresent join compareTo keySet values entrySet getKey getValue sort',
    csharp: 'Add AddRange Remove Contains ContainsKey Get Set ToString Equals GetHashCode Count Any All Select Where First FirstOrDefault Last ToList ToArray Dispose Write WriteLine Read ReadLine Close Invoke GetValue SetValue TryGetValue Append Clear Insert IndexOf Join Split Trim Replace Format',
    rust: 'get get_mut set insert remove push pop len is_empty iter iter_mut into_iter map filter collect unwrap expect clone to_string to_owned as_str as_ref as_mut borrow borrow_mut lock read write send recv next fmt eq cmp partial_cmp hash from into new default ok err is_some is_none and_then unwrap_or unwrap_or_else map_err contains extend join split trim',
    ruby: 'each map select reject find detect include? push pop shift unshift each_with_index each_with_object to_s to_i to_a to_h to_sym keys values fetch merge join split strip call new puts print send respond_to? nil? empty? any? all? first last count size length',
    php: 'get set has add remove count toArray all first last map filter each push pop merge keys values',
    c: 'push_back pop_back size begin end find insert erase at c_str get reset clear empty front back emplace emplace_back data swap',
};
const COMMON_BY_FAMILY = Object.fromEntries(Object.entries(COMMON_MEMBERS).map(([k, v]) => [k, new Set(v.split(/\s+/))]));

function push(map, key, val) {
    const a = map.get(key);
    if (a) a.push(val); else map.set(key, [val]);
}

/** Receiver type whose members never live in the repository (primitives, builtins, collections). */
export const EXTERNAL = Object.freeze({ external: true });

/** Split a list at top-level commas (brackets, generics and nested function types kept whole). */
function splitTopLevel(text, sep = ',') {
    const out = [];
    let depth = 0, cur = '';
    for (let k = 0; k < text.length; k++) {
        const ch = text[k];
        if ('([{<'.includes(ch)) depth++;
        else if (')]}'.includes(ch) || (ch === '>' && text[k - 1] !== '=')) depth--;
        if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/** The text between the bracket at `open` and its match, or null when it is not closed. */
function bracketed(text, open) {
    let depth = 0;
    for (let k = open; k < text.length; k++) {
        if (text[k] === '(') depth++;
        else if (text[k] === ')' && --depth === 0) return { inner: text.slice(open + 1, k), end: k };
    }
    return null;
}

/** Declared type of a parameter (`name?: T = x` → `T`), or null when it has none. */
function paramType(param) {
    if (/^\.\.\./.test(param)) return null; // rest parameter
    const colon = splitTopLevel(param, ':');
    if (colon.length < 2) return null;
    const type = colon.slice(1).join(':');
    // a default value starts at a top-level `=` that is not part of `=>`, `==`, `<=`, `>=`, `!=`
    let depth = 0;
    for (let k = 0; k < type.length; k++) {
        const ch = type[k];
        if ('([{<'.includes(ch)) depth++;
        else if (')]}'.includes(ch) || (ch === '>' && type[k - 1] !== '=')) depth--;
        else if (ch === '=' && depth === 0 && !'=>'.includes(type[k + 1] ?? '') && !'=!<>'.includes(type[k - 1] ?? '')) return type.slice(0, k).trim() || null;
    }
    return type.trim() || null;
}

/**
 * `cb` in `on(event: string, cb: (socket: JsonSocket, n: number) => void)`: the declared type of
 * parameter `j` of the function type that parameter `i` of `name` declares, from its signature.
 */
export function callbackParamTypeText(sig, name, i, j) {
    if (!sig) return null;
    const m = new RegExp(`(?:^|[^\\w$])${name.replace(/[$]/g, '\\$')}\\s*(?:<[^()]*>)?\\s*\\(`).exec(sig);
    const list = m ? bracketed(sig, m.index + m[0].length - 1) : null;
    let type = list ? paramType(splitTopLevel(list.inner)[i] ?? '') : null;
    if (!type) return null;
    // `cb?: ((s: T) => void) | undefined`: drop null/undefined, unwrap parentheses
    const alts = splitTopLevel(type, '|').filter(t => t !== 'undefined' && t !== 'null');
    if (alts.length !== 1) return null;
    type = alts[0];
    for (let g = 0; g < 3 && type.startsWith('('); g++) {
        const b = bracketed(type, 0);
        if (!b || b.end !== type.length - 1) break;
        type = b.inner.trim();
    }
    const fn = type.startsWith('(') ? bracketed(type, 0) : null;
    if (!fn || !/^\s*=>/.test(type.slice(fn.end + 1))) return null;
    return paramType(splitTopLevel(fn.inner)[j] ?? '');
}

/** `name[][]` → { name, elem: 2 } (element access applied to a descriptor part). */
function splitElem(part) {
    let elem = 0;
    while (part.endsWith('[]')) { part = part.slice(0, -2); elem++; }
    return { name: part, elem };
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
    constructor(table, specsById, { sigOf = null } = {}) {
        this.t = table;
        this.specs = specsById; // lang id -> spec (implicitThis etc.)
        this.sigOf = sigOf;     // symbol id -> signature text (read on demand: callback parameter types)
        this.memo = new Map();
    }

    resetMemo() { this.memo.clear(); }

    // ── type & member helpers ─────────────────────────────────────────────────────

    /** Enclosing type of a symbol: {id?, name} or null. */
    enclosingType(symId) {
        for (let s = this.t.sym(symId), guard = 0; s && guard < 32; s = s.parentId != null ? this.t.sym(s.parentId) : null, guard++) {
            if (MEMBER_HOLDERS.has(s.kind) && s.kind !== 'module') return { id: s.id, name: s.name, fileId: s.fileId };
            // a member declared in its type's body: the type itself, not one found by name (`<anonymous>` repeats)
            const parent = s.parentId != null ? this.t.sym(s.parentId) : null;
            if (parent && MEMBER_HOLDERS.has(parent.kind) && parent.kind !== 'module' && (!s.owner || parent.name === s.owner)) continue;
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

    /**
     * Method resolution order of a type: C3 linearization over its resolved bases (Python's MRO; for
     * single inheritance it is the chain of supertypes). Unresolved bases are left out; an inconsistent
     * hierarchy falls back to depth-first order. Ids, the type first.
     */
    mro(typeId) {
        const k = 'mro|' + typeId;
        if (this.memo.has(k)) return this.memo.get(k);
        this.memo.set(k, [typeId]); // cycle guard
        const ts = this.t.sym(typeId);
        const bases = [];
        for (const b of ts?.bases ?? []) {
            const bt = this.resolveTypeName(b, ts.fileId);
            if (bt && bt.id !== typeId && !bases.includes(bt.id)) bases.push(bt.id);
        }
        const seqs = [...bases.map(b => [...this.mro(b)]), [...bases]];
        const out = [typeId];
        for (;;) {
            const rest = seqs.filter(s => s.length);
            if (!rest.length) break;
            const head = rest.map(s => s[0]).find(h => !rest.some(s => s.indexOf(h) > 0));
            if (head === undefined) { for (const s of rest) for (const x of s) if (!out.includes(x)) out.push(x); break; }
            out.push(head);
            for (const s of rest) if (s[0] === head) s.shift();
        }
        this.memo.set(k, out);
        return out;
    }

    /** Resolve a type name visible from a file to a type symbol. */
    resolveTypeName(name, fileId) {
        if (!name || name.endsWith('[]') || name === '!') return null;
        const k = 't|' + fileId + '|' + name;
        if (this.memo.has(k)) return this.memo.get(k);
        this.memo.set(k, null); // cycle guard
        const q = this.#qualifiedType(name, fileId) ?? this.#nestedType(name, fileId);
        const r = q !== undefined ? null : this.#resolveName(name, 'type', fileId, null);
        const s = q !== undefined ? (q === EXTERNAL ? null : q) : r && r.id != null ? this.t.sym(r.id) : null;
        const res = s && TYPE_KINDS.has(s.kind) ? s : null;
        this.memo.set(k, res);
        return res;
    }

    /**
     * `pkg.T` in a language whose types keep their package (Go): the type in the imported package's
     * directory, EXTERNAL when the package is not in the repository, null when the repository's
     * package has no such type; undefined when the name is not package-qualified.
     */
    #qualifiedType(name, fileId) {
        const dot = name.indexOf('.');
        if (dot <= 0 || name.indexOf('.', dot + 1) >= 0) return undefined;
        const lang = this.t.file(fileId)?.lang;
        if (!this.specs[lang]?.qualifiedTypes) return undefined;
        const imp = this.#importFor(fileId, name.slice(0, dot));
        if (!imp) return undefined;
        if (imp.targetFileId == null && !imp.targetDir) return EXTERNAL;
        const ids = imp.targetDir ? this.#symbolsInDir(imp.targetDir, name.slice(dot + 1), fileId) : this.exportedFrom(imp.targetFileId, name.slice(dot + 1));
        return ids.map(id => this.t.sym(id)).find(s => s && TYPE_KINDS.has(s.kind)) ?? null;
    }

    /**
     * `Outer.Inner` in a language whose stored types keep their enclosing types (Java): the type
     * nested in the one the first name resolves to; EXTERNAL when that one is the language's
     * (`Map.Entry`); undefined when the name is not nested or its outer type is unknown.
     */
    #nestedType(name, fileId) {
        const spec = this.specs[this.t.file(fileId)?.lang];
        if (!spec?.nestedTypes || !name.includes('.')) return undefined;
        const [head, ...rest] = name.split('.');
        let cur = this.resolveTypeName(head, fileId);
        if (!cur) return spec.isPrimitiveType?.(head) ? EXTERNAL : undefined;
        for (const seg of rest) {
            const ids = (this.t.byParent.get(cur.id)?.get(seg) ?? []).map(id => this.t.sym(id)).filter(x => x && TYPE_KINDS.has(x.kind));
            if (!ids.length) return null;
            cur = ids[0];
        }
        return cur;
    }

    /**
     * A stored type string (see extract.mjs) → type {id,name,fileId}, EXTERNAL (members never live
     * in the repository: primitives, builtins, collections) or null (unknown). `elem` applies
     * element access that many times (`xs[i]`, loop variables).
     */
    typeFromString(str, fileId, elem = 0) {
        if (!str) return null;
        if (str.startsWith('call:') || str.startsWith('cb:') || str.includes('#')) return this.resolveRecvType(str + '[]'.repeat(elem), fileId, null);
        let s = str;
        for (let i = 0; i < elem; i++) {
            if (!s.endsWith('[]') && !s.endsWith('{}')) {
                // an element of a collection class (`class Registry extends Map<string, Module>`)
                const t = s !== '!' ? this.resolveTypeName(s, fileId) : null;
                return t ? this.#elementOf(t, elem - i) : null;
            }
            s = s.slice(0, -2);
        }
        if (s === '!') return EXTERNAL;
        if (s.endsWith('[]')) return { arrayOf: s.slice(0, -2), fileId }; // a collection value
        if (s.endsWith('{}')) return { mapOf: s.slice(0, -2), fileId };   // a map value
        if (this.#qualifiedType(s, fileId) === EXTERNAL || this.#nestedType(s, fileId) === EXTERNAL) return EXTERNAL;
        const t = this.resolveTypeName(s, fileId);
        if (t) return t;
        const spec = this.specs[this.t.file(fileId)?.lang];
        return spec?.isPrimitiveType?.(s) ? EXTERNAL : null;
    }

    /** An element of a type, `elem` levels down: of a collection value, or of a collection class. */
    #elementOf(t, elem) {
        if (t.arrayOf != null) return this.typeFromString(t.arrayOf, t.fileId, elem - 1);
        if (t.mapOf != null) return this.typeFromString(t.mapOf, t.fileId, elem - 1); // a map's value
        const s = t.id != null ? this.t.sym(t.id) : null;
        return s?.type && /(\[\]|\{\})$/.test(s.type) ? this.typeFromString(s.type, s.fileId, elem) : null;
    }

    /** Resolve an extraction-time receiver type descriptor to a type {id,name,fileId} or EXTERNAL. */
    resolveRecvType(desc, fileId, srcId) {
        if (!desc) return null;
        if (desc === '!') return EXTERNAL;
        const k = 'r|' + fileId + '|' + desc;
        if (this.memo.has(k)) return this.memo.get(k);
        this.memo.set(k, null);
        const parts = desc.split('#').map(splitElem);
        const head = parts[0];
        let cur = null;
        if (head.name.startsWith('call:')) {
            const callee = head.name.slice(5);
            const dot = callee.lastIndexOf('.');
            // `call:pkg.New`: the function is reached through a module / import alias
            const r = dot > 0 ? this.#resolveMember(callee.slice(dot + 1), 'call', callee.slice(0, dot), null, fileId, srcId)
                : this.#resolveName(callee, 'call', fileId, srcId);
            const s = r?.id != null ? this.t.sym(r.id) : null;
            if (s) {
                if (TYPE_KINDS.has(s.kind)) cur = head.elem ? null : s; // constructor call
                else if (s.type) cur = this.typeFromString(s.type, s.fileId, head.elem);
            }
            if ((cur?.arrayOf != null || cur?.mapOf != null) && parts.length === 1) cur = EXTERNAL;
        } else if (head.name.startsWith('cb:')) {
            cur = this.#callbackParam(head.name, fileId, srcId, head.elem);
        } else if (!head.elem) {
            // same-file qualified name first (this.x → Class#x uses the class qname)
            const q = (this.t.byQname.get(head.name) ?? []).map(id => this.t.sym(id)).find(s => s.fileId === fileId && TYPE_KINDS.has(s.kind));
            const qt = q ? undefined : this.#qualifiedType(head.name, fileId) ?? this.#nestedType(head.name, fileId);
            cur = q ?? (qt !== undefined ? qt : this.typeFromString(head.name.split('.').pop(), fileId));
            if (!cur && !head.name.includes('.')) {
                // a capitalised root can be a value rather than a type: `export const NestFactory =
                // new NestFactoryStatic()` makes `NestFactory.create()` a member of NestFactoryStatic
                const r = this.#resolveName(head.name, 'value', fileId, srcId);
                const v = r?.id != null ? this.t.sym(r.id) : null;
                if (v && VALUE_TYPED_KINDS.has(v.kind) && v.type && v.type !== head.name) cur = this.typeFromString(v.type, v.fileId);
            }
            if (!cur && head.name.includes('.')) {
                // enclosing class that is not a symbol itself (e.g. JS prototype owner)
                cur = { id: null, name: head.name.split('.').pop(), fileId };
            }
        }
        const spec = this.specs[this.t.file(fileId)?.lang];
        for (let i = 1; i < parts.length && cur && cur !== EXTERNAL; i++) {
            const { name, elem } = parts[i];
            if (!name) { cur = elem ? this.#elementOf(cur, elem) : cur; continue; } // `T#[]`: an element of T itself
            if (cur.arrayOf != null) {
                // `list.get(0)` / `xs.first()` reach the element; other members are the language's
                cur = spec?.elementMethods?.has(name) ? this.typeFromString(cur.arrayOf, cur.fileId, elem) : EXTERNAL;
                continue;
            }
            if (cur.mapOf != null) {
                // `m.get(k)` reaches a value, `m.values()` the collection of values
                cur = spec?.mapMethods?.has(name) ? this.typeFromString(cur.mapOf, cur.fileId, elem)
                    : spec?.mapValueMethods?.has(name) ? this.typeFromString(cur.mapOf + '[]', cur.fileId, elem) : EXTERNAL;
                continue;
            }
            const mem = this.membersOf({ id: cur.id ?? null, name: cur.name, fileId: cur.fileId }, name);
            if (!mem.length && cur.id != null && spec?.qualifiedTypes) {
                // Go: an embedded field is named after its type (`m.MatchRegexp` in a struct embedding MatchRegexp)
                const os = this.t.sym(cur.id);
                const emb = (os?.declaredBases ?? os?.bases ?? []).find(b => b === name || b.endsWith('.' + name));
                const et = emb ? this.resolveTypeName(emb, os.fileId) : null;
                if (et) { cur = elem ? this.#elementOf(et, elem) : et; continue; }
            }
            if (!mem.length && cur.id != null) {
                // a class that is a collection (`class Registry extends Map<string, Module>`): `get` & co.
                const ct = this.t.sym(cur.id)?.type;
                const c = ct ? this.typeFromString(ct, cur.fileId) : null;
                if (c && (c.arrayOf != null || c.mapOf != null)) { cur = c; i--; continue; }
            }
            let next = null;
            for (const id of mem) {
                const m = this.t.sym(id);
                if (m.type) { next = this.typeFromString(m.type, m.fileId, elem); if (next) break; }
            }
            if (!next) {
                // inferred field types (self.x = X() / this.x = new X() / this.x = param), also inherited
                let owner = cur;
                for (let d = 0; owner && !next && d < 5; d++) {
                    const ft = this.t.fieldTypes.get(owner.qname ?? owner.name)?.get(name);
                    if (ft) { next = this.typeFromString(ft, owner.fileId ?? fileId, elem); break; }
                    const os = owner.id != null ? this.t.sym(owner.id) : null;
                    const base = os?.bases?.[0];
                    owner = base ? this.resolveTypeName(base, os.fileId) : null;
                }
            }
            cur = next;
        }
        const res = cur === EXTERNAL || cur?.arrayOf != null || cur?.mapOf != null ? EXTERNAL : cur ? { id: cur.id ?? null, name: cur.name, fileId: cur.fileId ?? null } : null;
        this.memo.set(k, res);
        return res;
    }

    /** Type of a callback parameter (`cb:i:j:callee`, see extract.mjs) from the callee's signature. */
    #callbackParam(desc, fileId, srcId, elem) {
        const m = /^cb:(\d+):(\d+):(.+)$/.exec(desc);
        if (!m || !this.sigOf) return null;
        const target = m[3];
        let callee = null;
        const sep = target.lastIndexOf('::');
        if (sep > 0) {
            // a method of a typed receiver (`this`, a field, a local)
            const type = this.resolveRecvType(target.slice(0, sep).replace(/~/g, '#'), fileId, srcId);
            if (type && type !== EXTERNAL) callee = this.membersOf(type, target.slice(sep + 2)).map(id => this.t.sym(id)).find(s => s && CALLABLE_KINDS.has(s.kind)) ?? null;
        } else {
            // `@helpers.create`: a function reached through a module, namespace or class; else a name in scope
            const dot = target.lastIndexOf('.');
            const r = target.startsWith('@') && dot > 0 ? this.#resolveMember(target.slice(dot + 1), 'call', target.slice(1, dot), null, fileId, srcId)
                : this.#resolveName(target, 'call', fileId, srcId);
            callee = r?.id != null ? this.t.sym(r.id) : null;
        }
        if (!callee || !CALLABLE_KINDS.has(callee.kind)) return null;
        const text = callbackParamTypeText(this.sigOf(callee.id), callee.name, Number(m[1]), Number(m[2]));
        const spec = this.specs[this.t.file(callee.fileId)?.lang];
        const t = text && spec ? normalizeType(text, spec) : null;
        return t ? this.typeFromString(t, callee.fileId, elem) : null;
    }

    // ── import helpers ───────────────────────────────────────────────────────────

    #importFor(fileId, local) {
        for (const imp of this.t.imports.get(fileId) ?? []) if (imp.local === local) return imp;
        return null;
    }

    /**
     * The module file an imported Python name stands for, when that name is a module: `import a.b as x`,
     * `from pkg import sub` (a submodule), or a name the imported module itself imports as a module —
     * `from sqlglot import exp`, where sqlglot/__init__.py does `from sqlglot import expressions as exp`.
     */
    #moduleFileOf(fileId, local, depth = 0) {
        if (depth > 4 || local == null) return null;
        const imp = this.#importFor(fileId, local);
        if (!imp) return null;
        if (imp.imported === '*' && !imp.wildcard) return imp.targetFileId ?? null;
        const n = imp.imported && imp.imported !== '*' && imp.imported !== 'default' ? imp.imported : null;
        if (!n) return null;
        if (imp.targetDir) {
            const sub = `${imp.targetDir}/${n.replace(/\./g, '/')}`;
            const f = this.t.fileByPath.get(sub + '.py') ?? this.t.fileByPath.get(sub + '/__init__.py');
            if (f) return f.id;
        }
        if (imp.targetFileId != null && imp.targetFileId !== fileId) return this.#moduleFileOf(imp.targetFileId, n, depth + 1);
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
        // in Python a later import rebinds the name (`from a import *` then `from b import *`)
        const imports = this.t.imports.get(targetFileId) ?? [];
        for (const imp of this.t.file(targetFileId)?.lang === 'python' ? [...imports].reverse() : imports) {
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
        this.argc = ref.argc ?? null;
        const fileId = ref.file_id;
        const srcId = ref.src_id ?? null;
        const recv = ref.recv || '';
        const kind = ref.kind;
        const name = ref.name;
        if (recv) return this.#resolveMember(name, kind, recv, ref.recv_type, fileId, srcId);
        return this.#resolveName(name, kind, fileId, srcId) ?? { id: null, conf: 0, ncand: 0 };
    }

    /**
     * Where overloads are methods of their own, a call none of a type's own overloads can take
     * reaches an inherited one (`element.attr("x")` runs Node.attr(key) when Element declares only
     * attr(key, value)): the nearest supertype declaring an overload the arguments fit.
     */
    #overloadsReached(type, ids, name) {
        if (this.argc == null || !ids.length || type?.id == null || ids.some(id => this.#reaches(this.t.sym(id)))) return ids;
        if (!ids.every(id => CALLABLE_KINDS.has(this.t.sym(id)?.kind))) return ids;
        for (const tid of this.mro(type.id).slice(1)) {
            const ts = this.t.sym(tid);
            const own = ts ? this.membersOf({ id: ts.id, name: ts.name, fileId: ts.fileId }, name).filter(id => this.#reaches(this.t.sym(id))) : [];
            if (own.length) return own;
        }
        return ids;
    }

    /** Can the call being resolved reach this callable (its arguments fit, where overloads are methods of their own)? */
    #reaches(s) {
        if (this.argc == null || !this.sigOf || !this.specs[this.t.file(s.fileId)?.lang]?.distinctOverloads) return true;
        return fits({ n: Math.max(0, this.argc), open: this.argc < 0 }, sigArity(this.sigOf(s.id), s.name));
    }

    #compatible(s, kind) {
        if (kind === 'value' && CALLABLE_KINDS.has(s.kind) && this.specs[this.t.file(s.fileId)?.lang]?.localValues) return false; // Java: methods are no values
        if (kind === 'type' || kind === 'inherit') return TYPE_KINDS.has(s.kind);
        if (kind === 'new') return TYPE_KINDS.has(s.kind) || s.kind === 'function' || s.kind === 'constructor';
        if (kind === 'call') return CALLABLE_KINDS.has(s.kind) || TYPE_KINDS.has(s.kind) || s.kind === 'variable' || s.kind === 'field' || s.kind === 'property' || s.kind === 'constant';
        if (kind === 'decorator') return CALLABLE_KINDS.has(s.kind) || TYPE_KINDS.has(s.kind) || s.kind === 'variable';
        if (kind === 'read') return s.kind === 'field' || s.kind === 'property' || s.kind === 'method' || s.kind === 'constant' || s.kind === 'variable' || TYPE_KINDS.has(s.kind);
        return true;
    }

    #pick(ids, kind, conf, fileId) {
        const cands = ids.map(id => this.t.sym(id)).filter(s => s && this.#compatible(s, kind));
        if (!cands.length) return null;
        if (cands.length === 1) return { id: cands[0].id, conf, ncand: 1 };
        // overloads / redeclarations in one type or file: prefer the definition with a body (larger span)
        const sameQ = cands.every(s => s.qname === cands[0].qname);
        // where overloads are methods of their own, the call reaches the one its arguments fit
        if (sameQ && this.argc != null && this.sigOf && this.specs[this.t.file(cands[0].fileId)?.lang]?.distinctOverloads) {
            const a = { n: Math.max(0, this.argc), open: this.argc < 0 };
            let fit = cands.filter(s => fits(a, sigArity(this.sigOf(s.id), s.name)));
            // an overload that takes the arguments as they are wins over a variadic one (javac's phases)
            const fixed = fit.filter(s => sigArity(this.sigOf(s.id), s.name)?.max !== Infinity);
            if (fixed.length && fixed.length < fit.length) fit = fixed;
            if (fit.length === 1) return { id: fit[0].id, conf, ncand: 1 };
            if (fit.length > 1 && fit.length < cands.length) return this.#pick(fit.map(s => s.id), kind, conf, fileId);
        }
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
            if (s.name === name && kind === 'call' && CALLABLE_KINDS.has(s.kind) && this.#reaches(s)) return { id: s.id, conf: 0.9, ncand: 1 }; // recursion
        }
        // 2. implicit this: members of the enclosing type (Java/Kotlin/C#/Scala/C++/Ruby)
        if (spec?.implicitThis && srcId != null && kind !== 'type' && kind !== 'inherit') {
            const type = this.enclosingType(srcId);
            if (type) {
                const r = this.#pick(this.#overloadsReached(type, this.membersOf(type, name), name), kind, 0.9, fileId);
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
                    const r = this.#pick(this.#byStatic(ids, false), kind, 0.95, fileId);
                    if (r) return r;
                    return { id: null, conf: 0, ncand: 0 };
                }
            }
        }
        // inferred receiver type (locals, params, fields, factories; chains across files)
        if (recvType) {
            const type = this.resolveRecvType(recvType, fileId, srcId);
            if (type === EXTERNAL) return { id: null, conf: 0, ncand: 0, external: true };
            if (type) {
                const ids = this.#byStatic(this.#overloadsReached(type, this.membersOf(type, name), name), false);
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
                for (const oid of owners) ids.push(...this.#membersVia(this.t.sym(oid), name));
                if (!ids.length && imp.targetFileId != null && owners.length === 0) {
                    // `from pkg import submodule` then submodule.fn()
                    ids = this.exportedFrom(imp.targetFileId, name);
                }
            } else if (rest.length === 0) {
                if (imp.targetFileId != null) ids = this.exportedFrom(imp.targetFileId, name);
                if (!ids.length && imp.targetDir) ids = this.#symbolsInDir(imp.targetDir, name, fileId);
            } else if (imp.targetFileId != null || imp.targetDir) {
                // ns.Class.method / pkg.sub.fn / pkg.DefaultClient.Do
                let owners = imp.targetFileId != null ? this.exportedFrom(imp.targetFileId, rest[0]) : this.#symbolsInDir(imp.targetDir, rest[0], fileId);
                if (rest.length === 1) for (const oid of owners) ids.push(...this.#membersVia(this.t.sym(oid), name));
            }
            if (!ids.length && file.lang === 'python') {
                // the receiver is a module reached through a package (`exp.Column`, `exp.Literal.string`)
                const mod = this.#moduleFileOf(fileId, imp.local);
                if (mod != null && rest.length === 0) ids = this.exportedFrom(mod, name);
                else if (mod != null && rest.length === 1) for (const oid of this.exportedFrom(mod, rest[0])) ids.push(...this.#membersVia(this.t.sym(oid), name));
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
                // a typed package-level value (`DefaultClient.Do()`, a module singleton in the same package)
                const rv = this.#resolveName(root, 'read', fileId, srcId);
                const v = rv?.id != null ? this.t.sym(rv.id) : null;
                if (v && v.type && (v.kind === 'variable' || v.kind === 'constant')) {
                    const r = this.#pick(this.#membersVia(v, name), kind, Math.min(0.9, rv.conf), fileId);
                    if (r) return r;
                }
                // JS object namespaces (`proto.handle`, `utils.merge`): same-file owner
                const owned = (this.t.byOwner.get(root) ?? []).filter(id => this.t.sym(id).name === name);
                const r = this.#pick(owned, kind, owned.some(id => this.t.sym(id).fileId === fileId) ? 0.8 : 0.6, fileId);
                if (r) return r;
            } else {
                const ids = this.#byStatic(this.membersOf({ id: typeSym.id, name: typeSym.name, fileId: typeSym.fileId }, name), true);
                const r = this.#pick(ids, kind, Math.min(0.9, r0.conf), fileId);
                if (r) return r;
            }
        }
        // unknown receiver: any member with that name (dynamic dispatch by name). Property reads are
        // too common to guess (`x.length`, `opts.name`), so they stay unbound without type evidence.
        if (kind === 'read') return { id: null, conf: 0, ncand: 0 };
        return this.#anyMember(name, kind, fileId) ?? { id: null, conf: 0, ncand: 0 };
    }

    /**
     * Members named `name` reached through an imported/package symbol: a type's static members, a
     * typed value's instance members (`export const api = new Api()`), or members declared on the
     * symbol itself (JS object namespaces).
     */
    #membersVia(o, name) {
        if (!o) return [];
        if (!TYPE_KINDS.has(o.kind) && o.type) {
            const t = this.typeFromString(o.type, o.fileId);
            if (t && t !== EXTERNAL && t.arrayOf == null && t.mapOf == null) return this.#byStatic(this.membersOf(t, name), false);
            if (t) return [];
        }
        const ids = this.membersOf({ id: o.id, name: o.name, fileId: o.fileId }, name);
        return TYPE_KINDS.has(o.kind) ? this.#byStatic(ids, true) : ids;
    }

    /** Keep members of the wanted staticness when both kinds share the name (`Logger.error` vs `logger.error`). */
    #byStatic(ids, wantStatic) {
        if (ids.length < 2) return ids;
        const same = ids.filter(id => !!this.t.sym(id)?.isStatic === wantStatic);
        return same.length ? same : ids;
    }

    /**
     * Unknown receiver: bind by name only when the repository has exactly one member with that name
     * and the name is not also a standard-library method of the language (`get`, `set`, `apply`…).
     * Everything else stays unbound with its candidate count — a guessed edge that is wrong most of
     * the time costs an agent more than an honest "unknown".
     */
    #anyMember(name, kind, fileId) {
        const file = this.t.file(fileId);
        const fam = familyOf(file.lang);
        const ids = (this.t.byName.get(name) ?? []).filter(id => {
            const s = this.t.sym(id);
            if (!s || !(s.kind === 'method' || s.kind === 'field' || s.kind === 'property' || s.kind === 'function' && s.owner)) return false;
            const f = this.t.file(s.fileId);
            return f && familyOf(f.lang) === fam;
        });
        if (!ids.length) return null;
        if (ids.length > 1 || COMMON_BY_FAMILY[fam]?.has(name)) return { id: null, conf: 0, ncand: ids.length };
        return this.#pick(ids, kind, 0.5, fileId);
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
