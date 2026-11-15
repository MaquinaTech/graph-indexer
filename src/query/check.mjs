/**
 * Edit checker: what an agent's uncommitted changes broke or left behind, found without building
 * the project. Compares every changed file with its version at the base commit (HEAD by default)
 * and reports, with locations:
 *
 *   syntax        parse errors that are new since the base version
 *   arity         calls whose arguments no longer fit the (changed) definition — call sites of
 *                 changed signatures anywhere, and calls written in the changed lines: the count,
 *                 and in Python a keyword the definition no longer takes
 *   imports       files that were deleted or moved but are still imported by their old path
 *   removed       definitions that were deleted or renamed but are still used or imported: the
 *                 uses the index binds to the definition as it was (types, values and attribute
 *                 reads as well as calls)
 *   maybeRemoved  calls only the name ties to a removed member: on a receiver of unknown type, in
 *                 a file that names the member's type (to review)
 *   untouched     callers of a changed signature in files the change did not touch (to review)
 *   loose         JavaScript call sites that pass fewer arguments than a changed definition now
 *                 declares (legal there: the rest are undefined), to review
 *   changed       callers, in files not touched, of a definition whose signature text changed
 *                 while its argument count did not (a parameter renamed or retyped, another
 *                 result), to review
 *   family        the same method declared in a supertype or overridden in a subtype, in a file
 *                 not touched, when the method changed its signature or was removed (to review)
 *   inherited     subclasses that inherit a changed member (they run the new code) or override it
 *   tests         the test files that exercise the changed code, and the command to run them;
 *                 then, apart, the test files that name a changed module in a string (dialect,
 *                 plugin or backend lookups such as `read="mysql"`, which no reference shows)
 */
import fs from 'node:fs';
import path from 'node:path';
import { codeSpecForPath as specForPath, isConstructor } from '../parse/languages.mjs'; // documentation is not checked
import { prepareLanguage, extractFile, parseSource } from '../parse/extract.mjs';
import { paramArity, paramKeywords, callAt, callArgc, callKeywords, fits, describeArity } from '../parse/arity.mjs';
import { testCommands, testCaseCommands } from './testcmd.mjs';
import { escapeRegExp } from '../util/regex.mjs';
import { readRepoFile, isRevision } from '../util/paths.mjs';
import { MAX_FILE_BYTES, diskName, ignoredAmong } from '../index/discover.mjs';
import { gitSync, diffHeaderPath } from '../util/git.mjs';

const CALLABLE = new Set(['function', 'method', 'constructor']);
// languages where a call may pass fewer arguments than the definition declares (the rest are
// undefined) or more (they are ignored): a count that does not match is something to look at, not an error
const LOOSE_ARITY = new Set(['javascript']);
// languages where a method can be called through its type with the receiver passed by hand
const RECEIVER_BY_HAND = new Set(['python', 'rust']);
// decorators and annotations that leave a function's parameters as written
const KEEPS_SIGNATURE = /^(staticmethod|classmethod|abstractmethod|abstractclassmethod|abstractstaticmethod|overload|override|final|cache|lru_cache|cached|wraps|contextmanager|asynccontextmanager|deprecated|no_type_check|singledispatch|singledispatchmethod|Override|Deprecated|SuppressWarnings|SafeVarargs|Nullable|NonNull|NotNull)$/;
const squash = (sig) => String(sig ?? '').replace(/\s+/g, ' ').trim();
/** Does the source bind `name` in a destructuring declaration (`const { a, name } = x`, `let [name] = y`)? */
const destructured = (src, name) => new RegExp(`\\b(?:const|let|var)\\s*[{\\[][^=;]*(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])[^=;]*[}\\]]\\s*=`).test(src);
const MEMBER_KINDS = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'object', 'impl', 'module', 'type']);

function git(root, args) {
    const r = gitSync(root, args, { maxBuffer: 1 << 28 });
    return r.status === 0 ? r.stdout : null;
}

/** Changed files vs base with their changed (new-side) line ranges; untracked files count whole. */
function changedFiles(root, base) {
    const out = new Map();
    const diff = git(root, ['diff', '--relative', '-U0', '--no-color', '--no-renames', base, '--']);
    if (diff === null) return null;
    let file = null;
    for (const line of diff.split('\n')) {
        if (line.startsWith('--- ')) continue;
        if (line.startsWith('+++ ')) {
            file = diffHeaderPath(line); // null: the file was deleted
            if (file && !out.has(file)) out.set(file, { ranges: [], status: 'M' });
            continue;
        }
        const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (h && file) {
            const start = Number(h[1]), len = h[2] === undefined ? 1 : Number(h[2]);
            if (len > 0) out.get(file).ranges.push([start, start + len - 1]);
        }
    }
    // -z: a status and a path per record, the path as it is (spaces, tabs, quotes)
    const status = (git(root, ['diff', '--relative', '--name-status', '-z', '--no-renames', base, '--']) ?? '').split('\0');
    for (let i = 0; i + 1 < status.length; i += 2) {
        const st = status[i], p = status[i + 1];
        if (st === 'D') out.set(p, { ranges: [], status: 'D' });
        else if (st === 'A' && out.has(p)) out.get(p).status = 'A';
    }
    // git names a file as its index does: after a rename that changed only the letter case, and that
    // git was not told of, that is the old name, while the file and the index have the one on disk
    const res = new Map([...out].map(([p, info]) => {
        const disk = info.status === 'D' ? p : diskName(root, p);
        return disk === p ? [p, info] : [disk, { ...info, was: p }];
    }));
    // untracked, with the letter case compared exactly (on a file system that folds case git would not list a file
    // renamed only in its case, content unchanged, anywhere): such a file is the tracked one under its new name
    let untracked = (git(root, ['-c', 'core.ignorecase=false', 'ls-files', '-z', '--others', '--exclude-standard']) ?? '').split('\0').filter(Boolean);
    // compared exactly, an ignore rule written in another case misses: git's own matching decides, as discovery has it
    const ignored = untracked.length ? ignoredAmong(root, untracked, true) : null;
    if (ignored?.size) untracked = untracked.filter(f => !ignored.has(f));
    let tracked = null;
    for (const f of untracked) {
        if (res.has(f)) continue;
        tracked ??= new Map((git(root, ['ls-files', '-z']) ?? '').split('\0').filter(Boolean).map(t => [t.toLowerCase(), t]));
        const was = tracked.get(f.toLowerCase());
        if (was && was !== f && diskName(root, was) === f) res.set(f, { ranges: [], status: 'M', was });
        else res.set(f, { ranges: [[1, 1e9]], status: 'A' });
    }
    return res;
}

/** Parse a source text: tree + extracted symbols, each symbol with its definition node's arity. */
async function analyse(spec, source, rel, tree = null) {
    if (!tree) { const { parser } = await prepareLanguage(spec); tree = parseSource(spec, parser, source); }
    const ex = await extractFile(spec, source, rel);
    for (const s of ex.symbols) {
        if (!CALLABLE.has(s.kind) && !(s.kind === 'field' && /=>|function/.test(s.sig ?? ''))) continue;
        const node = defNodeAt(tree, s);
        if (!node) continue;
        s.arity = paramArity(node, { method: s.kind === 'method' || s.kind === 'constructor', lang: spec.id, isStatic: s.isStatic, decorators: s.decorators ?? [] });
        s.keywords = paramKeywords(node, { lang: spec.id, decorators: s.decorators ?? [] });
    }
    return { tree, symbols: ex.symbols, locals: new Set(ex.imports.map(i => i.local).filter(Boolean)) };
}

/** The outermost node spanning exactly the symbol's range (the definition, not its name token). */
function defNodeAt(tree, s) {
    let n = tree.rootNode.descendantForPosition({ row: s.startLine - 1, column: s.startCol });
    let best = null;
    for (let g = 0; n && g < 12; g++, n = n.parent) {
        if (n.startPosition.row !== s.startLine - 1 || n.startPosition.column !== s.startCol) { if (best) break; continue; }
        if (n.endPosition.row === s.endLine - 1) best = n;
    }
    return best;
}

/** New syntax errors: ERROR / MISSING nodes whose line text was not already broken in the base. */
function syntaxErrors(tree, lines, baseErrorTexts) {
    const out = [];
    const visit = (n, depth) => {
        if (out.length >= 5 || depth > 400) return;
        if (n.type === 'ERROR' || n.isMissing) {
            const line = n.startPosition.row + 1;
            const text = (lines[line - 1] ?? '').trim();
            if (!baseErrorTexts.has(text)) out.push({ line, text, missing: n.isMissing ? n.type : null });
            return;
        }
        if (!n.hasError) return;
        for (let i = 0; i < n.childCount; i++) visit(n.child(i), depth + 1);
    };
    if (tree.rootNode.hasError) visit(tree.rootNode, 0);
    return out;
}

function errorTexts(tree, lines) {
    const out = new Set();
    const visit = (n, depth) => {
        if (depth > 400) return;
        if (n.type === 'ERROR' || n.isMissing) { out.add((lines[n.startPosition.row] ?? '').trim()); return; }
        if (!n.hasError) return;
        for (let i = 0; i < n.childCount; i++) visit(n.child(i), depth + 1);
    };
    if (tree.rootNode.hasError) visit(tree.rootNode, 0);
    return out;
}

const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'object', 'impl', 'type']);
/** The member (method, field, …) a changed symbol belongs to: itself, or the member around a local. */
function memberOf(intel, id) {
    let s = intel.sym(id);
    for (let guard = 0; s && guard < 16; guard++) {
        if (TYPE_KINDS.has(s.kind)) return null;
        if (s.parent_id == null) return s.kind === 'method' ? s : null; // Go/Rust: declared outside its type
        const p = intel.sym(s.parent_id);
        if (!p) return null;
        if (TYPE_KINDS.has(p.kind)) return s;
        s = p;
    }
    return null;
}

const keyOf = (s) => `${s.qname}|${s.kind}`;
/** "2", "1–2", or "1 | 2" for overload sets (definitions without a countable parameter list are skipped). */
const arityText = (defs) => [...new Set(defs.filter(d => d.arity).map(d => describeArity(d.arity)))].sort().join(' | ') || '?';
const inRanges = (line, ranges) => ranges.some(([a, b]) => line >= a && line <= b);

/** Arity accepted by a set of overloads: a call fits if any overload fits. */
function unionFits(argc, arities) {
    const list = arities.filter(Boolean);
    if (!list.length) return true;
    return list.some(r => fits(argc, r));
}

const GENERIC_STEMS = new Set(['__init__', 'index', 'main', 'mod', 'lib', 'core', 'base', 'utils', 'util', 'helpers', 'common', 'types']);

/**
 * Test files that mention a changed source module's name as a string literal ("mysql" for
 * generators/mysql.py): code reached by a registry lookup — a dialect, plugin or backend chosen by
 * name — that no reference shows. A second tier: broader than the files the index links to.
 */
function testsNamingModules(intel, files) {
    const stems = new Set();
    for (const f of files) {
        if (intel.store.get('SELECT is_test FROM files WHERE path = ?', f)?.is_test) continue;
        const stem = path.posix.basename(f).replace(/\.[^.]+$/, '');
        if (stem.length >= 3 && !GENERIC_STEMS.has(stem) && /^\w+$/.test(stem)) stems.add(stem);
    }
    if (!stems.size) return [];
    const re = new RegExp(`["'](${[...stems].join('|')})["']`);
    const out = [];
    for (const { path: p } of intel.store.all('SELECT path FROM files WHERE is_test = 1 ORDER BY path')) {
        let text;
        try { text = fs.readFileSync(path.join(intel.root, p), 'utf8'); } catch { continue; }
        if (re.test(text)) out.push(p);
    }
    return out;
}

/**
 * The uses that would bind to each removed definition if it were still declared: the definitions
 * are put back into the symbol table as they were at the base, every reference that binds to
 * nothing now and carries one of their names is resolved again, and the definitions are taken out.
 * This is `find_references` on what is no longer there — types, values and attribute reads as well
 * as calls, each through its scope, import or receiver type rather than by its name.
 * While they are back, a removed method's family is read too: the supertypes that still declare
 * it and the subtypes that still override it, in files the change did not touch.
 * @returns {{ uses: Map<object, object[]>, family: Map<object, object[]> }} by removed symbol
 */
function usesOfRemoved(intel, removed, changed) {
    const out = new Map(), family = new Map();
    if (!removed.length) return { uses: out, family };
    const t = intel.ix.table, resolver = intel.ix.resolver, s = intel.store;
    const phantom = new Map();   // phantom id → removed symbol
    const idOf = new Map();      // base symbol → phantom id
    const sigs = new Map();
    const sigOf = resolver.sigOf;
    let next = -1;
    try {
        for (const o of removed) {
            const file = Map.prototype.get.call(t.fileByPath, o.path);
            if (!file) continue; // the file itself is gone: its importers are reported by the import check
            // a name the language provides (a polyfill of `URLSearchParams`, a local `fetch`): once
            // the repository's own is gone, its uses mean the platform's
            const spec = specForPath(o.path);
            if (o.kind !== 'method' && o.kind !== 'field' && o.kind !== 'property' && (spec?.isPrimitiveType?.(o.name) || spec?.builtinCalls?.has(o.name))) continue;
            let parentId = null;
            if (o.parentIdx >= 0) {
                const p = o.base[o.parentIdx];
                parentId = idOf.get(p) ?? s.get('SELECT id FROM symbols WHERE file_id = ? AND qname = ? AND kind = ? LIMIT 1', file.id, p.qname, p.kind)?.id ?? null;
                if (parentId == null) continue;
            }
            const id = next--;
            t.addSym({ id, fileId: file.id, name: o.name, qname: o.qname, kind: o.kind, parentId, owner: o.owner, type: o.type, bases: o.bases ?? [], exported: !!o.exported, isStatic: !!o.isStatic,
                startLine: o.startLine, endLine: o.endLine, byRef: false, path: o.path, seq: 1e9 - id });
            phantom.set(id, o);
            idOf.set(o, id);
            sigs.set(id, o.sig ?? null);
        }
        if (!phantom.size) return { uses: out, family };
        resolver.sigOf = (id) => (id < 0 ? sigs.get(id) ?? null : sigOf(id));
        resolver.resetMemo();
        for (const [id, o] of phantom) {
            if (o.kind !== 'method' || o.isStatic) continue;
            const fam = intel.methodFamily({ id, name: o.name, sig: o.sig ?? null, kind: o.kind, lang: specForPath(o.path)?.id });
            const sites = [...fam.up.map(m => ({ ...m, how: 'declares it' })), ...fam.down.map(m => ({ ...m, how: 'overrides it' }))]
                .filter(m => !changed.has(m.path)).map(m => ({ qname: m.qname, path: m.path, line: m.start_line, how: m.how }));
            if (sites.length) family.set(o, sites);
        }
        const names = [...new Set([...phantom.values()].map(o => o.name))];
        const marks = names.map(() => '?').join(',');
        const cols = 'r.file_id, r.src_id, r.name, r.kind, r.line, r.col, r.recv, r.recv_type, r.argc, r.arg_types, f.path, f.is_test, src.qname AS src_qname';
        const rows = [
            ...s.all(`SELECT ${cols} FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols src ON src.id = r.src_id WHERE r.name IN (${marks}) AND r.dst_id IS NULL AND (r.recv_type IS NULL OR r.recv_type != '~structural')`, ...names),
            ...s.all(`SELECT ${cols} FROM refs_unbound r JOIN files f ON f.id = r.file_id LEFT JOIN symbols src ON src.id = r.src_id WHERE r.name IN (${marks})`, ...names),
        ];
        rows.sort((a, b) => a.is_test - b.is_test || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
        for (const r of rows) {
            const res = resolver.resolve(r);
            const o = res.id != null ? phantom.get(res.id) : null;
            if (!o) continue;
            // the definition's own lines (a recursive call in the removed body) are not users left behind
            (out.get(o) ?? out.set(o, []).get(o)).push({ path: r.path, line: r.line, kind: r.kind, recv: r.recv, src_qname: r.src_qname, conf: res.conf });
        }
    } finally {
        resolver.sigOf = sigOf;
        for (const id of phantom.keys()) t.dropSym(id);
        resolver.resetMemo();
    }
    return { uses: out, family };
}

/**
 * The imports a deleted or moved file left behind. The files that are gone are put back into the
 * module map, every import that leads nowhere now is resolved again, and the ones that reach a
 * file that is gone are imports by its old path: the question the indexer asks of each import,
 * asked of the tree as it was. A compiler says "module not found" for these; nothing else in the
 * report does, because the definitions of a moved file still exist under their names.
 * @returns {Map<string, { path: string, line: number, source: string }[]>} by path that is gone
 */
function importsOfGone(intel, gone) {
    const out = new Map();
    const modules = intel.ix.modules;
    const absent = gone.filter(p => !modules.files.has(p));
    if (!absent.length) return out;
    // an import of the file names it, or its directory when it is the directory's entry file
    const words = new Set();
    for (const p of absent) {
        const stem = path.posix.basename(p).replace(/\.[^.]+$/, '');
        words.add(/^(index|__init__|mod|lib|main)$/.test(stem) ? path.posix.basename(path.posix.dirname(p)) : stem);
    }
    const named = (source) => { for (const w of words) if (w === '.' || source.includes(w)) return true; return false; };
    const rows = intel.store.all(`SELECT i.source, i.imported, i.line, f.path, f.lang FROM imports i JOIN files f ON f.id = i.file_id
        WHERE i.target_file_id IS NULL AND i.target_dir IS NULL AND i.source IS NOT NULL ORDER BY f.is_test, f.path, i.line`).filter(r => named(r.source));
    if (!rows.length) return out;
    const was = new Set(absent);
    for (const p of absent) modules.addFile(p);
    try {
        const seen = new Set();
        for (const r of rows) {
            const t = modules.resolveImport(r.lang, r.path, { source: r.source, imported: r.imported });
            if (!t?.file || !was.has(t.file) || seen.has(`${r.path}:${r.line}`)) continue;
            seen.add(`${r.path}:${r.line}`); // `import { a, b } from './gone'` is one statement
            (out.get(t.file) ?? out.set(t.file, []).get(t.file)).push({ path: r.path, line: r.line, source: r.source });
        }
    } finally { for (const p of absent) modules.removeFile(p); }
    return out;
}

/** Where each deleted file went, when the change shows it: git's rename detection, or the one added file of the same name. */
function movedTo(root, base, gone, changed) {
    const out = new Map();
    const recs = (git(root, ['diff', '--relative', '--name-status', '-z', '-M', '--diff-filter=R', base, '--']) ?? '').split('\0');
    for (let i = 0; i + 2 < recs.length; i += 3) if (recs[i].startsWith('R')) out.set(recs[i + 1], recs[i + 2]);
    // a file moved without `git mv` is a deletion and an untracked file: the one of the same name,
    // or the one with the same text
    const added = [...changed].filter(([, info]) => info.status === 'A').map(([p]) => p);
    for (const p of gone) {
        if (out.has(p)) continue;
        const same = added.filter(a => path.posix.basename(a) === path.posix.basename(p));
        if (same.length === 1) { out.set(p, same[0]); continue; }
        const ext = path.posix.extname(p);
        const like = added.filter(a => path.posix.extname(a) === ext).slice(0, 40);
        const was = like.length ? git(root, ['show', `${base}:./${p}`]) : null;
        const twin = was == null ? [] : like.filter(a => readRepoFile(root, a, MAX_FILE_BYTES) === was);
        if (twin.length === 1) out.set(p, twin[0]);
    }
    return out;
}

/**
 * Is a call's receiver a class (`Base.m(self)`, `pkg.Base.m(self)`) rather than a value of it? A
 * receiver the index found a type for is a value (`G = nx.Graph()` is no class `G`, even when a
 * test declares one).
 */
function throughClass(intel, { recv, recv_type: recvType }) {
    if (!recv || recvType || recv === 'self' || recv === 'cls' || recv.startsWith('super')) return false;
    const last = recv.split('.').pop();
    if (!/^[A-Z_]\w*$/.test(last)) return false;
    return (Map.prototype.get.call(intel.ix.table.byName, last) ?? []).some(id => TYPE_KINDS.has(intel.ix.table.sym(id)?.kind));
}

export async function checkChanges(intel, { base = 'HEAD', files = null, tests = true, byName = false } = {}) {
    const root = intel.root;
    if (!isRevision(base)) return { error: `Not a git revision: ${base}` };
    const changed = changedFiles(root, base);
    if (!changed) return { error: `git diff against ${base} failed — is this a git repository with that commit?` };
    // the edited files must be re-indexed now, whatever the file watcher has seen so far
    await intel.ensureFresh();
    await intel.ix.syncPaths([...changed].flatMap(([p, info]) => (info.was ? [info.was, p] : [p])));
    const targets = [...changed.keys()].filter(f => specForPath(f) && (!files || files.some(x => f === x || f.startsWith(x.replace(/\/?$/, '/')))));
    const report = { base, files: targets.length, syntax: [], arity: [], imports: [], removed: [], untouched: [], loose: [], changed: [], family: [], maybeRemoved: [], sigChanged: [], inherited: [], tests: [], commands: [], byName: [], byNameCommands: [], cases: [], casesTotal: 0, caseCommands: [], notes: [] };
    if (!targets.length) return report;
    // callers only need a syntax tree; definitions (changed files, callees) also need symbols + arities
    const treeCache = new Map(), symCache = new Map();
    const parsed = async (rel) => {
        if (treeCache.has(rel)) return treeCache.get(rel);
        let v = null;
        const spec = specForPath(rel);
        try {
            const src = spec ? readRepoFile(root, rel, MAX_FILE_BYTES) : null;
            if (src !== null) {
                const { parser } = await prepareLanguage(spec);
                v = { tree: parseSource(spec, parser, src), lines: src.split(/\r?\n/), src, spec };
            }
        } catch { v = null; }
        treeCache.set(rel, v);
        return v;
    };
    const analysed = async (rel) => {
        if (symCache.has(rel)) return symCache.get(rel);
        const t = await parsed(rel);
        const v = t ? { ...t, ...(await analyse(t.spec, t.src, rel, t.tree)) } : null;
        symCache.set(rel, v);
        return v;
    };
    const changedSigs = [];   // { cur (index row), arities: new overload arities, was: old description }
    const changedText = [];   // same argument count, another signature text
    const removedSyms = [];   // extracted base symbols
    for (const rel of targets) {
        const info = changed.get(rel);
        const spec = specForPath(rel);
        const baseSrc = info.status === 'A' ? null : git(root, ['show', `${base}:./${info.was ?? rel}`]);
        const baseA = baseSrc !== null ? await analyse(spec, baseSrc, rel) : null;
        const cur = info.status === 'D' ? null : await analysed(rel);
        if (cur) {
            const baseErr = baseA ? errorTexts(baseA.tree, baseSrc.split(/\r?\n/)) : new Set();
            for (const e of syntaxErrors(cur.tree, cur.lines, baseErr)) report.syntax.push({ path: rel, ...e });
        }
        if (!baseA) continue;
        const baseTree = baseA.tree;
        const now = new Map();
        for (const s of cur?.symbols ?? []) (now.get(keyOf(s)) ?? now.set(keyOf(s), []).get(keyOf(s))).push(s);
        const before = new Map();
        for (const s of baseA.symbols) (before.get(keyOf(s)) ?? before.set(keyOf(s), []).get(keyOf(s))).push(s);
        const stillNamed = new Set((cur?.symbols ?? []).map(s => s.qname));
        for (const [k, olds] of before) {
            const news = now.get(k);
            const o = olds[0];
            if (!news) {
                if (o.kind === 'variable' && o.parentIdx >= 0) continue; // locals come and go
                // a module's own variables are names other files use; a local is not
                if (!['function', 'method', 'class', 'interface', 'struct', 'enum', 'trait', 'type', 'constant', 'field', 'property', 'constructor'].includes(o.kind) && !(o.kind === 'variable' && o.parentIdx < 0)) continue;
                // declared again as another kind of thing (a function made a class, a type alias an
                // interface): changed, not removed
                if (stillNamed.has(o.qname)) continue;
                // the file still binds the name, by an import (the definition moved and is imported
                // back) or by destructuring (`const { toString } = Object.prototype`)
                if (o.parentIdx < 0 && cur && (cur.locals.has(o.name) || destructured(cur.src, o.name))) continue;
                // (a definition of the same name elsewhere says nothing: one that moved has its uses
                // bound to where it is now, and they are not found below; one that merely shares
                // the name leaves the uses of this one bound to nothing)
                removedSyms.push({ ...o, path: rel, base: baseA.symbols });
                continue;
            }
            const was = arityText(olds);
            const is = arityText(news);
            // Python: keyword names every old overload took and no new one takes
            const kwNow = news.map(s => s.keywords);
            const takes = (k) => kwNow.some(d => !d || d.open || d.names.has(k));
            const goneKw = olds.every(s => s.keywords) ? [...olds[0].keywords.names].filter(k => !takes(k)) : [];
            if ((was !== is && news.some(s => s.arity)) || goneKw.length) changedSigs.push({ qname: o.qname, kind: o.kind, path: rel, was, is, arities: news.map(s => s.arity), oldArities: olds.map(s => s.arity), keywords: kwNow, goneKw, name: o.name, loose: LOOSE_ARITY.has(spec.id), sameCount: was === is });
            else if (CALLABLE.has(o.kind) && olds.length === 1 && news.length === 1 && o.sig && news[0].sig && squash(o.sig) !== squash(news[0].sig)) changedText.push({ qname: o.qname, kind: o.kind, path: rel, was: squash(o.sig), is: squash(news[0].sig), name: o.name });
        }
        baseTree.delete();
    }

    if (changedSigs.length > 40) report.notes.push(`${changedSigs.length - 40} more definitions changed their parameters and were not checked against their call sites: ${changedSigs.slice(40, 46).map(c => c.qname).join(', ')}${changedSigs.length > 46 ? ', …' : ''} (narrow with files)`);
    if (removedSyms.length > 30) report.notes.push(`${removedSyms.length - 30} more definitions were removed or renamed and were not looked up: ${removedSyms.slice(30, 36).map(c => c.qname).join(', ')}${removedSyms.length > 36 ? ', …' : ''} (narrow with files)`);
    // ── call sites of changed signatures ────────────────────────────────────────
    const seen = new Set();
    for (const c of changedSigs.slice(0, 40)) {
        const rows = intel.store.all(`SELECT s.id, s.parent_id, s.is_static FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.qname = ? AND s.kind = ?`, c.path, c.qname, c.kind);
        if (!rows.length) continue;
        const ids = rows.map(r => r.id);
        // a constructor is called through its class
        if (isConstructor({ name: c.name, kind: c.kind, lang: specForPath(c.path)?.id }) && rows[0].parent_id != null) ids.push(rows[0].parent_id);
        const calls = intel.store.all(`SELECT r.line, r.col, r.kind, r.conf, r.recv, r.recv_type, f.path, src.qname AS src_qname FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols src ON src.id = r.src_id
            WHERE r.dst_id IN (${ids.map(() => '?').join(',')}) AND r.kind IN ('call','new') AND r.conf >= 0.7 ORDER BY f.is_test, f.path, r.line`, ...ids);
        const bad = [], untouched = [];
        const takes = (k) => c.keywords.some(d => !d || d.open || d.names.has(k));
        const selfMethod = c.kind === 'method' && RECEIVER_BY_HAND.has(specForPath(c.path)?.id) && !rows.some(r => r.is_static);
        for (const r of calls) {
            const t = await parsed(r.path);
            if (!t) continue;
            const node = callAt(t.tree, r.line - 1, r.col);
            let argc = node ? callArgc(node) : null;
            // `Base.method(self, x)`, `Type::method(value, x)`: a method called through its type is handed its receiver
            if (argc && selfMethod && throughClass(intel, r)) argc = { n: Math.max(0, argc.n - 1), open: argc.open };
            const k = `${r.path}:${r.line}:${r.col}`;
            // a keyword the definition took and no longer takes (Python: a parameter renamed or removed)
            const keyword = node && c.goneKw.length ? callKeywords(node).find(kw => c.goneKw.includes(kw) && !takes(kw)) : null;
            // a call that no longer fits is one that fitted: a count that matched neither before nor now
            // says the parameters are not what the call site passes (a decorator that supplies one)
            // (where any count is legal, a call that was already short is still one to look at)
            if (argc && !unionFits(argc, c.arities) && (c.loose || unionFits(argc, c.oldArities))) { bad.push({ ...r, argc, text: t.lines[r.line - 1]?.trim() }); seen.add(k); }
            else if (argc && !unionFits(argc, c.arities)) continue;
            else if (keyword) { bad.push({ ...r, argc, keyword, text: t.lines[r.line - 1]?.trim() }); seen.add(k); }
            else if (!changed.has(r.path)) untouched.push({ ...r, text: t.lines[r.line - 1]?.trim() });
        }
        // where a count that does not match is legal (JavaScript), the short calls are listed to be looked at
        if (bad.length && c.loose) report.loose.push({ target: c.qname, path: c.path, was: c.was, is: c.is, total: calls.length, sites: bad });
        else if (bad.length) report.arity.push({ target: c.qname, path: c.path, was: c.was, is: c.is, total: calls.length, sites: bad, keyword: bad.every(b => b.keyword) });
        if (untouched.length && !c.sameCount) report.untouched.push({ target: c.qname, path: c.path, was: c.was, is: c.is, sites: untouched });
        else if (untouched.length) changedText.push({ qname: c.qname, kind: c.kind, path: c.path, was: `keyword${c.goneKw.length === 1 ? '' : 's'} ${c.goneKw.join(', ')}`, is: 'no longer taken', name: c.name, keywords: true });
        report.sigChanged.push({ qname: c.qname, kind: c.kind, path: c.path, was: c.was, is: c.is, ids });
    }

    // ── callers, in files not touched, of a signature that changed without changing its count ──
    for (const c of changedText.slice(0, 12)) {
        const rows = intel.store.all(`SELECT s.id, s.parent_id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.qname = ? AND s.kind = ?`, c.path, c.qname, c.kind);
        if (!rows.length) continue;
        const ids = rows.map(r => r.id);
        if (isConstructor({ name: c.name, kind: c.kind, lang: specForPath(c.path)?.id }) && rows[0].parent_id != null) ids.push(rows[0].parent_id);
        if (!c.keywords) report.sigChanged.push({ qname: c.qname, kind: c.kind, path: c.path, was: null, is: null, ids });
        const calls = intel.store.all(`SELECT r.line, r.col, r.kind, r.conf, f.path, src.qname AS src_qname FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols src ON src.id = r.src_id
            WHERE r.dst_id IN (${ids.map(() => '?').join(',')}) AND r.kind IN ('call','new') AND r.conf >= 0.7 ORDER BY f.is_test, f.path, r.line`, ...ids).filter(r => !changed.has(r.path));
        if (!calls.length) continue;
        // production code first (the query's order); the reply names the first few
        report.changed.push({ target: c.qname, path: c.path, was: c.was, is: c.is, total: calls.length, sites: calls.slice(0, 3).map(r => ({ path: r.path, line: r.line, src_qname: r.src_qname })) });
    }

    // ── the same method declared in a supertype or overridden in a subtype, in a file not touched ──
    for (const c of report.sigChanged) {
        if (c.kind !== 'method') continue;
        const sym = intel.sym(c.ids[0]);
        const fam = sym ? intel.methodFamily(sym) : { up: [], down: [] };
        const sites = [...fam.up.map(m => ({ ...m, how: 'declares it' })), ...fam.down.map(m => ({ ...m, how: 'overrides it' }))]
            .filter(m => !changed.has(m.path)).map(m => ({ qname: m.qname, path: m.path, line: m.start_line, how: m.how }));
        if (sites.length) report.family.push({ target: c.qname, path: c.path, change: 'signature', sites });
    }

    // ── calls written in the changed lines (to anything) that do not fit their callee ─
    for (const rel of targets) {
        const info = changed.get(rel);
        if (info.status === 'D') continue;
        if (LOOSE_ARITY.has(specForPath(rel)?.id)) continue; // any count is legal there
        const fileRow = intel.store.get('SELECT id FROM files WHERE path = ?', rel);
        if (!fileRow) continue;
        const calls = intel.store.all(`SELECT r.line, r.col, r.dst_id, r.conf, r.recv, r.recv_type, d.qname, d.kind, d.parent_id, d.is_static, df.path AS dpath, src.qname AS src_qname FROM refs r
            JOIN symbols d ON d.id = r.dst_id JOIN files df ON df.id = d.file_id LEFT JOIN symbols src ON src.id = r.src_id
            WHERE r.file_id = ? AND r.kind IN ('call','new') AND r.conf >= 0.9`, fileRow.id);
        const t = await parsed(rel);
        if (!t) continue;
        for (const r of calls) {
            if (!inRanges(r.line, info.ranges) || seen.has(`${rel}:${r.line}:${r.col}`)) continue;
            let calleePath = r.dpath, calleeQ = r.qname, calleeKind = r.kind;
            if (MEMBER_KINDS.has(r.kind)) {
                // instantiation: check against the class's constructor
                const lang = specForPath(r.dpath)?.id;
                const ctor = intel.store.all(`SELECT s.name, s.qname, s.kind FROM symbols s WHERE s.parent_id = ? AND s.name IN ('constructor','__init__','initialize','__construct')`, r.dst_id)
                    .find(s => isConstructor({ ...s, lang }));
                if (!ctor) continue;
                calleeQ = ctor.qname; calleeKind = ctor.kind;
            } else if (!CALLABLE.has(r.kind)) continue;
            if (LOOSE_ARITY.has(specForPath(calleePath)?.id)) continue;
            const ct = await analysed(calleePath);
            const defs = ct?.symbols.filter(s => s.qname === calleeQ && s.kind === calleeKind) ?? [];
            const arities = defs.map(s => s.arity).filter(Boolean);
            if (!arities.length) continue;
            // a decorator may supply arguments (`@click.option`, `@with_db`) or take them away: only
            // the ones known to leave the signature alone say what a call has to pass
            if (defs.some(d => (d.decorators ?? []).some(x => !KEEPS_SIGNATURE.test(String(x).replace(/\(.*$/s, '').split('.').pop())))) continue;
            const node = callAt(t.tree, r.line - 1, r.col);
            let argc = node ? callArgc(node) : null;
            if (argc && calleeKind === 'method' && !r.is_static && RECEIVER_BY_HAND.has(specForPath(calleePath)?.id) && throughClass(intel, r)) argc = { n: Math.max(0, argc.n - 1), open: argc.open };
            if (argc && !unionFits(argc, arities)) {
                report.arity.push({ target: calleeQ, path: calleePath, is: arities.map(describeArity).join(' | '), total: 1, sites: [{ ...r, path: rel, argc, text: t.lines[r.line - 1]?.trim() }], newCall: true });
            }
        }
    }

    // ── files deleted or moved that are still imported by their old path ───────
    const gone = targets.filter(f => changed.get(f).status === 'D');
    // a file whose name changed only in its letter case is gone by the old one
    const recased = new Map(targets.filter(f => changed.get(f).was).map(f => [changed.get(f).was, f]));
    if (gone.length || recased.size) {
        const left = importsOfGone(intel, [...gone, ...recased.keys()]);
        const moves = left.size ? movedTo(root, base, [...left.keys()].filter(p => !recased.has(p)), changed) : new Map();
        for (const [p, sites] of left) {
            report.imports.push({ path: p, movedTo: moves.get(p) ?? recased.get(p) ?? null, total: sites.length,
                sites: sites.slice(0, 12).map(x => ({ ...x, text: intel.fileLines(x.path)?.[x.line - 1]?.trim() ?? '' })) });
        }
    }

    // ── removed or renamed definitions still in use ─────────────────────────────
    const { uses: stillBound, family: removedFamily } = usesOfRemoved(intel, removedSyms.slice(0, 30), changed);
    for (const s of removedSyms.slice(0, 30)) {
        const owner = s.owner ?? (s.qname.includes('.') ? s.qname.split('.').slice(-2, -1)[0] : null);
        // calls only the name ties to a removed member: on a receiver whose type the index does not
        // know, in a file that names the member's type. A removed top-level name has no such
        // fallback: its uses are bound through scopes and imports, or they are another `name`.
        const member = (s.parentIdx >= 0 || s.owner) && owner;
        let rows = !member ? [] : intel.store.all(`SELECT r.line, r.recv, r.kind, f.path, src.qname AS src_qname FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols src ON src.id = r.src_id
            WHERE r.name = ? AND r.dst_id IS NULL AND r.recv IS NOT NULL AND r.kind IN ('call','new','type','inherit','decorator','value','read') ORDER BY f.is_test, f.path, r.line`, s.name);
        const files = new Map();
        const mentions = (p, word) => {
            const key = p + '\u0000' + word;
            if (!files.has(key)) { const lines = intel.fileLines(p); files.set(key, !!lines && lines.some(l => new RegExp(`\\b${escapeRegExp(word)}\\b`).test(l))); }
            return files.get(key);
        };
        rows = rows.filter(r => {
            // a member, also one declared outside its type's body (a Go receiver, a Rust impl): its owner is what a user has to name
            if ((s.parentIdx >= 0 || s.owner) && owner) return (r.recv && r.recv.toLowerCase().includes(owner.toLowerCase())) || r.recv === 'this' && r.path === s.path || mentions(r.path, owner);
            return r.path === s.path || mentions(r.path, s.name);
        });
        // imports of a removed top-level name
        // (not the ones the file still serves: it re-exports the name from where the definition went)
        const imports = s.parentIdx < 0 ? intel.store.all(`SELECT f.path, i.line, i.target_file_id FROM imports i JOIN files f ON f.id = i.file_id JOIN files t ON t.id = i.target_file_id
            WHERE t.path = ? AND (i.imported = ? OR i.local = ?)`, s.path, s.name, s.name).filter(i => !intel.ix.resolver.exportedFrom(i.target_file_id, s.name).length) : [];
        // the uses the index binds to the definition as it was are problems; the ones only a name
        // ties to it are listed apart, as possible
        // (bound: through a scope, an import or a receiver type; a use that only the name's
        // uniqueness ties to the definition is possible, like the others of its name)
        const all = stillBound.get(s) ?? [];
        const bound = all.filter(r => r.conf >= 0.7);
        const at = new Set(bound.map(r => `${r.path}:${r.line}`));
        for (const i of imports) at.add(`${i.path}:${i.line}`);
        const maybe = [...all.filter(r => r.conf < 0.7), ...rows].filter(r => !at.has(`${r.path}:${r.line}`) && !at.has(`?${r.path}:${r.line}`) && at.add(`?${r.path}:${r.line}`));
        if (bound.length || imports.length) report.removed.push({ qname: s.qname, kind: s.kind, path: s.path, uses: bound.slice(0, 12), total: bound.length, imports });
        if (maybe.length) report.maybeRemoved.push({ qname: s.qname, kind: s.kind, path: s.path, uses: maybe.slice(0, 8), total: maybe.length });
        const fam = removedFamily.get(s);
        if (fam?.length) report.family.push({ target: s.qname, path: s.path, change: 'removed', sites: fam });
    }

    // ── subclasses that inherit a changed member run the new code too ───────────
    // (with tests: false — the edit hook — only problems are reported, so the diff is not mapped to symbols)
    const seeds = tests ? intel.diffSeeds(base).seeds ?? [] : [];
    const inheritorFiles = new Set();
    const byType = new Map();
    const members = new Map();
    for (const id of seeds) { const m = memberOf(intel, id); if (m && !m.is_test) members.set(m.id, m); }
    for (const m of members.values()) {
        const { inherit, extend, override } = intel.inheritance(m.id);
        if (!inherit.length && !extend.length && !override.length) continue;
        const owner = m.parent_id != null ? intel.sym(m.parent_id) : null;
        const type = owner?.qname ?? m.qname.split('.').slice(0, -1).join('.');
        const e = byType.get(type) ?? byType.set(type, { type, path: m.path, members: [], inherit: new Map(), extend: new Map(), override: [] }).get(type);
        e.members.push(m.name);
        for (const [list, into] of [[inherit, e.inherit], [extend, e.extend]]) for (const s of list) {
            inheritorFiles.add(s.path); // a test subclass is not listed, but its file is a test to run
            if (!s.is_test) into.set(s.id, { qname: s.qname, path: s.path });
        }
        for (const s of override) if (!s.is_test) e.override.push({ qname: `${s.qname}.${m.name}`, path: s.path });
    }
    report.inherited = [...byType.values()].map(e => ({ ...e, inherit: [...e.inherit.values()], extend: [...e.extend.values()] })).filter(e => e.inherit.length || e.extend.length || e.override.length);

    // ── tests to run ─────────────────────────────────────────────────────────────
    if (seeds.length) {
        const { nodes, fileLevel } = intel.dependents(seeds, { depth: 3, maxNodes: 300 });
        const tests = new Set();
        for (const [id] of nodes) { const x = intel.sym(id); if (x?.is_test) tests.add(x.path); }
        for (const [p] of fileLevel) if (intel.store.get('SELECT is_test FROM files WHERE path = ?', p)?.is_test) tests.add(p);
        for (const t of intel.conventionTests([...targets, ...inheritorFiles])) tests.add(t);
        for (const f of inheritorFiles) if (intel.store.get('SELECT is_test FROM files WHERE path = ?', f)?.is_test) tests.add(f);
        for (const rel of targets) if (intel.store.get('SELECT is_test FROM files WHERE path = ?', rel)?.is_test) tests.add(rel);
        report.tests = [...tests].sort();
        report.commands = testCommands(root, report.tests.slice(0, 40));
        // opt-in: the test files that name a changed module in a string (measured: more of the tests
        // a fix breaks are found, fewer test files are avoided, and nothing gained outside sqlglot)
        if (byName) {
            report.byName = testsNamingModules(intel, [...targets, ...inheritorFiles]).filter(t => !tests.has(t));
            report.byNameCommands = testCommands(root, report.byName.slice(0, 40));
        }
        // the test functions closest to the change: changed themselves, calling it, or calling a
        // function that calls it — running these first verifies a fix in seconds
        const near = new Map(seeds.map(id => [id, 0]));
        for (const [id, info] of nodes) if (info.depth <= 2 && !near.has(id)) near.set(id, info.depth);
        const cases = [];
        for (const [id, depth] of near) {
            const x = intel.sym(id);
            if (!x?.is_test || (x.kind !== 'function' && x.kind !== 'method') || !/^test/i.test(x.name)) continue;
            const parent = x.parent_id != null ? intel.sym(x.parent_id) : null;
            cases.push({ path: x.path, name: x.name, cls: parent?.kind === 'class' ? parent.name : null, depth });
        }
        cases.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
        report.casesTotal = cases.length;
        report.cases = cases.slice(0, 15);
        if (cases.length <= 15) report.caseCommands = testCaseCommands(root, cases);
    }
    for (const v of treeCache.values()) v?.tree?.delete(); // WASM memory
    delete report.sigChanged;
    return report;
}
