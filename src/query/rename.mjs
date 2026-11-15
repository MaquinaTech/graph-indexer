/**
 * Rename a definition everywhere it is used, on the references the index binds to it.
 *
 * An agent renames by search and replace: every `.send(` in the repository, whatever it is called
 * on, or line by line with `sed`. This does what an IDE does instead. The edits are:
 *
 *   - the definition's own name, with its overloads;
 *   - for a method or property, its family: the declarations it overrides or implements and the
 *     ones that override it, through every type in between (renaming one and not the others
 *     breaks the override), and nothing else of that name;
 *   - every reference bound to any of them with confidence at or above `minConf` (0.9: bound through
 *     a scope, an import or a receiver type);
 *   - the import and re-export statements that name it.
 *
 * What is not edited is listed with the reason: references bound with less confidence, same-name
 * calls whose receiver type is unknown in files that use the type, string literals that name the
 * member (`spyOn(x, 'name')`, `getattr(o, "name")`), and code the parser could not read. Each
 * edit is checked against the file as it is now (the old name must stand at that position).
 *
 * Nothing is written unless `apply` is set; the default is the list of edits.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { escapeRegExp } from '../util/regex.mjs';
import { confidenceLabel } from '../index/resolver.mjs';
import { isConstructor, codeSpecForPath } from '../parse/languages.mjs';
import { prepareLanguage, parseSource } from '../parse/extract.mjs';
import { withinRoot } from '../util/paths.mjs';

const MEMBER = new Set(['method', 'property', 'field']);
const PACKAGE_SCOPED = new Set(['go', 'java', 'kotlin']);
const TYPE_KINDS = new Set(['class', 'interface', 'enum', 'record', 'struct', 'trait', 'object', 'annotation']);
// a definition of the file's (or package's) own scope: a Go method has no parent and is still a member of its receiver's type
const isTopLevel = (s) => s.parent_id == null && !MEMBER.has(s.kind) && s.kind !== 'constructor';
const ECMA = new Set(['javascript', 'typescript', 'tsx']);
const words = (s) => new Set(s.split(/\s+/));

// Reserved words per language family (a definition cannot be called one of them). Compact on purpose:
// the words a grammar reserves, not the contextual ones (`type`, `get`, `async` in JS are fine as names).
const JS_WORDS = words('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static await implements interface package private protected public arguments eval');
const C_WORDS = words('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while');
const RESERVED = {
    javascript: JS_WORDS, typescript: JS_WORDS, tsx: JS_WORDS, vue: JS_WORDS, svelte: JS_WORDS,
    python: words('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'),
    go: words('break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var _'),
    java: words('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null _'),
    rust: words('as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try _'),
    csharp: words('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while'),
    kotlin: words('as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while'),
    scala: words('abstract case catch class def do else extends false final finally for forSome if implicit import lazy match new null object override package private protected return sealed super this throw trait true try type val var while with yield'),
    php: words('abstract and array as break callable case catch class clone const continue declare default die do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield'),
    ruby: words('BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'),
    c: C_WORDS,
    cpp: new Set([...C_WORDS, ...words('alignas alignof and and_eq asm bitand bitor bool catch class compl concept consteval constexpr constinit const_cast co_await co_return co_yield decltype delete dynamic_cast explicit export false friend mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public reinterpret_cast requires static_assert static_cast template this thread_local throw true try typeid typename using virtual wchar_t xor xor_eq')]),
};

// Names a file can use without defining them (builtins, globals, the prelude): a definition given one of these would take over
// those uses. Compact on purpose, the names code actually calls.
const PY_BUILTINS = words('abs all any bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip Exception BaseException ValueError TypeError KeyError IndexError AttributeError RuntimeError StopIteration NotImplementedError OSError IOError');
const JS_GLOBALS = words('console Promise Object Array String Number Boolean Symbol BigInt Map Set WeakMap WeakSet JSON Math Date Error TypeError RangeError RegExp Reflect Proxy parseInt parseFloat isNaN isFinite setTimeout setInterval clearTimeout clearInterval queueMicrotask structuredClone fetch URL URLSearchParams TextEncoder TextDecoder Buffer window document globalThis process require module exports undefined NaN Infinity');
const BUILTINS = {
    python: PY_BUILTINS, javascript: JS_GLOBALS, typescript: JS_GLOBALS, tsx: JS_GLOBALS, vue: JS_GLOBALS, svelte: JS_GLOBALS,
    go: words('append cap clear close complex copy delete imag len make max min new panic print println real recover nil true false iota error any bool byte rune string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128'),
    rust: words('Some None Ok Err Vec String Box Option Result Default Clone Copy Drop Fn FnMut FnOnce Iterator IntoIterator Into From ToString ToOwned Send Sync Sized drop'),
    java: words('String Object Integer Long Double Float Boolean Character Byte Short Math System Thread Exception RuntimeException Override Deprecated'),
};

/** Why `name` cannot name a definition in this language, or null. A trailing `?`/`!` only exists in Ruby; `$` in a name only in the languages that allow it. */
function nameProblem(lang, name) {
    const dollar = ['javascript', 'typescript', 'tsx', 'vue', 'svelte', 'java', 'scala'].includes(lang) ? '$' : '';
    const re = new RegExp(`^[A-Za-z_${dollar}][\\w${dollar}]*${lang === 'ruby' ? '[?!]?' : ''}$`);
    if (!re.test(name)) return `Not a name in ${lang ?? 'this language'}: ${name}`;
    const set = RESERVED[lang];
    if (set && (lang === 'php' ? [...set].includes(name.toLowerCase()) : set.has(name))) return `${name} is a reserved word in ${lang}; it cannot name a definition.`;
    return null;
}

/** Bring the index up to date with the working tree before anything is read from it (a full reconcile, like ensureFresh's sweep). */
async function reconcile(intel) {
    if (intel.indexing) await intel.indexing;
    intel.dirty.clear();
    const p = intel.ix.sync();
    intel.indexing = p;
    try { await p; } finally { if (intel.indexing === p) intel.indexing = null; }
    intel.lastSweep = Date.now();
}

/**
 * Write `bytes` to `abs` through a temporary file in the same directory (the mode is kept). The temporary name is random and
 * created exclusively, never through a link (a repository could plant one at a name it can guess), and the target is checked
 * to still be a regular file just before the temporary takes its place.
 */
function writeAtomic(abs, bytes, mode) {
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0 } = fs.constants;
    let tmp = null, fd = null;
    for (let k = 0; fd == null; k++) {
        tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.gi-rename-${crypto.randomBytes(8).toString('hex')}.tmp`);
        try { fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600); }
        catch (e) { if (e.code !== 'EEXIST' || k >= 8) throw e; }
    }
    try {
        fs.writeSync(fd, bytes);
        fs.fchmodSync(fd, mode);
        fs.closeSync(fd); fd = null;
        if (!fs.lstatSync(abs).isFile()) throw Object.assign(new Error(`${path.basename(abs)} stopped being a regular file`), { code: 'ENOTFILE' });
        fs.renameSync(tmp, abs);
    } catch (e) {
        if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ }
        try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
        throw e;
    }
}

/** The definitions that have to change name together: overloads, and for a member its whole family. */
function family(intel, sym) {
    const ids = new Map([[sym.id, { sym, how: 'the definition' }]]);
    const queue = [sym];
    while (queue.length) {
        const s = queue.shift();
        for (const id of intel.overloads(s)) if (!ids.has(id)) { const o = intel.sym(id); if (o) { ids.set(id, { sym: o, how: 'overload' }); queue.push(o); } }
        // Rust: a trait's method and its `fn` in each `impl Trait for X` are one name
        for (const m of intel.traitFamily?.(s) ?? []) if (!ids.has(m.id)) { ids.set(m.id, { sym: m, how: m.parent_id != null && intel.sym(m.parent_id)?.kind === 'trait' ? 'the trait method it implements' : 'implements the same trait method' }); queue.push(m); }
        if (!MEMBER.has(s.kind) || s.is_static) continue;
        const { up, down } = intel.methodFamily(s);
        for (const m of up) if (!ids.has(m.id)) { ids.set(m.id, { sym: m, how: 'declared in a supertype' }); queue.push(m); }
        for (const m of down) if (!ids.has(m.id)) { ids.set(m.id, { sym: m, how: 'overrides it' }); queue.push(m); }
    }
    return ids;
}

/** Is position `at` of a line inside a string literal (`from './parse'` names a file, not the definition)? */
function inString(line, at) {
    let quote = null;
    for (let k = 0; k < at; k++) {
        const ch = line[k];
        if (quote) { if (ch === '\\') k++; else if (ch === quote) quote = null; }
        else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    }
    return quote !== null;
}

/** Column of `name` on a line at or nearest to `col`, as a whole word; -1 when it is not there. */
function nameAt(line, name, col) {
    if (line == null) return -1;
    const word = (i) => i >= 0 && line.startsWith(name, i) && !/[\w$]/.test(line[i - 1] ?? '') && !/[\w$]/.test(line[i + name.length] ?? '');
    if (word(col)) return col;
    const re = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, 'g');
    const hits = [...line.matchAll(re)].map(m => m.index);
    return hits.length === 1 ? hits[0] : -1;
}

/** Members named `newName` in the supertypes and subtypes of the type that owns `sym` (an override one would now silently create or hide). */
function hierarchyClashes(intel, sym, newName) {
    const type = intel.ix.resolver.enclosingType(sym.id);
    if (type?.id == null) return [];
    const types = new Set(intel.ix.resolver.mro(type.id).filter(id => id !== type.id));
    let frontier = [type.id];
    for (let depth = 0; depth < 8 && frontier.length; depth++) {
        const next = [];
        for (const tid of frontier) for (const { src_id } of intel.store.all("SELECT DISTINCT src_id FROM refs WHERE dst_id = ? AND kind = 'inherit' AND src_id IS NOT NULL", tid)) {
            if (src_id !== type.id && !types.has(src_id)) { types.add(src_id); next.push(src_id); }
        }
        frontier = next;
    }
    const out = [];
    for (const id of types) {
        for (const c of intel.store.all('SELECT s.qname, s.start_line, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.parent_id = ? AND s.name = ?', id, newName)) out.push({ qname: c.qname, path: c.path, line: c.start_line, why: `${c.qname} (${c.path}:${c.start_line}) already declares ${newName} in a supertype or subtype of ${sym.qname}; it would override or hide it` });
    }
    return out;
}

/** Is the object an assignment to the CommonJS export list (`module.exports = { a, b }`)? A shorthand there is the exported name, so it follows the rename. */
function isCjsExportList(obj) {
    const asg = obj?.parent;
    return asg?.type === 'assignment_expression' && ['module.exports', 'exports'].includes(asg.childForFieldName('left')?.text) && asg.childForFieldName('right')?.id === obj.id;
}

/**
 * @param {import('./intel.mjs').CodeIntel} intel
 * @param {{ symbol: string, newName: string, apply?: boolean, minConf?: number, includeTests?: boolean }} opts
 */
export async function renameSymbol(intel, { symbol, newName, apply = false, minConf = 0.9 }) {
    // every query below reads the index: it has to match the files first (a stale line/column would point at another token)
    await reconcile(intel);
    newName = String(newName ?? '');
    if (!newName) return { error: `Not a name: ${newName}` };
    const found = intel.findSymbols(symbol, { limit: 8 });
    if (!found.matches.length) return { error: `No definition matches "${symbol}".${found.sameName?.length ? ` Definitions of that name: ${found.sameName.slice(0, 5).map(s => `${s.qname} (${s.path}:${s.start_line})`).join(', ')}.` : ''}` };
    const sym = found.matches[0];
    // several definitions of one name and nothing that says which: do not guess what to rename
    const others = found.matches.slice(1).filter(m => m.qname !== sym.qname || m.path !== sym.path);
    if (others.length && found.how === 'name') return { error: `"${symbol}" names ${found.matches.length} definitions; say which one (Class.member or path:Name): ${found.matches.slice(0, 6).map(s => `${s.qname} (${s.path}:${s.start_line})`).join(', ')}.` };
    const bad = nameProblem(codeSpecForPath(sym.path)?.id ?? sym.lang, newName);
    if (bad) return { error: bad };
    if (sym.name === newName) return { error: `${sym.qname} is already called ${newName}.` };
    if (isConstructor(sym) || sym.kind === 'section' || sym.kind === 'selector') return { error: `${sym.qname} is a ${sym.kind}; it has no name of its own to change.` };

    const fam = family(intel, sym);
    const old = sym.name;
    const edits = new Map();     // `${path}:${line}:${col}` -> { path, line, col, what, repl?, src? }
    const skipped = [];          // { path, line, why }
    const unverified = [];       // edits the index wants that do not hold in the file: a write would be partial
    const lineOf = (p, line) => intel.fileLines(p)?.[line - 1];
    // a use under an import alias (`import { old as fmt }`) holds the alias, not the name: it stays as it is
    const aliasMemo = new Map();
    const underAlias = (p, text, col) => {
        if (!aliasMemo.has(p)) aliasMemo.set(p, intel.store.all('SELECT i.local FROM imports i JOIN files f ON f.id = i.file_id WHERE f.path = ? AND i.imported = ? AND i.local != i.imported', p, old).map(r => r.local));
        return aliasMemo.get(p).some(l => text?.startsWith(l, col) && !/[\w$]/.test(text[col + l.length] ?? ''));
    };
    const add = (p, line, col, what, extra = {}) => {
        const at = nameAt(lineOf(p, line), old, col);
        if (at < 0 && underAlias(p, lineOf(p, line), col)) return;
        if (at < 0) { const why = `the index expected \`${old}\` here and the file has something else`; skipped.push({ path: p, line, why }); unverified.push({ path: p, line, why }); return; }
        const key = `${p}:${line}:${at}`;
        if (!edits.has(key)) edits.set(key, { path: p, line, col: at, what, ...extra });
    };
    // an edit found in the text itself (a closing tag, an export statement): exactly at `col`, or it does not hold
    const put = (p, line, col, what) => {
        if (!lineOf(p, line)?.startsWith(old, col)) { const why = `the index expected \`${old}\` here and the file has something else`; skipped.push({ path: p, line, why }); unverified.push({ path: p, line, why }); return; }
        const key = `${p}:${line}:${col}`;
        if (!edits.has(key)) edits.set(key, { path: p, line, col, what });
    };

    // a name that is taken where the new one would live
    const conflicts = [];
    const conflict = (c) => { if (!conflicts.some(x => x.path === c.path && x.line === c.line && x.qname === c.qname)) conflicts.push(c); };
    for (const { sym: s } of fam.values()) {
        const goMethod = s.parent_id == null && s.lang === 'go' && MEMBER.has(s.kind);
        const recvQ = goMethod && s.qname.endsWith(`.${old}`) ? s.qname.slice(0, -old.length) + newName : null;
        const clash = s.parent_id != null
            ? intel.store.all('SELECT qname, start_line FROM symbols WHERE parent_id = ? AND name = ?', s.parent_id, newName)
            // a Go method clashes with what its receiver type already has of that name, in any file of the package
            : goMethod ? (recvQ ? intel.store.all(`SELECT s.qname, s.start_line, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.qname = ? AND f.lang = 'go'`, recvQ)
                .filter(c => path.posix.dirname(c.path) === path.posix.dirname(s.path)) : [])
                : intel.store.all(`SELECT qname, start_line FROM symbols WHERE file_id = ? AND parent_id IS NULL AND name = ? AND kind NOT IN ('method', 'field', 'property', 'constructor')`, s.file_id, newName);
        for (const c of clash) conflict({ qname: c.qname, path: c.path ?? s.path, line: c.start_line });
        // Go and Java/Kotlin scope a top-level name by package (in Go the directory): another file of the package can hold the name
        if (isTopLevel(s) && PACKAGE_SCOPED.has(s.lang)) {
            const pkg = intel.store.get('SELECT package FROM files WHERE id = ?', s.file_id)?.package ?? null, dir = path.posix.dirname(s.path);
            for (const c of intel.store.all(`SELECT s.qname, s.start_line, f.path, f.package FROM symbols s JOIN files f ON f.id = s.file_id
                WHERE s.parent_id IS NULL AND s.name = ? AND s.kind NOT IN ('method', 'field', 'property', 'constructor') AND f.lang = ? AND f.id != ?`, newName, s.lang, s.file_id)) {
                const same = s.lang === 'go' ? path.posix.dirname(c.path) === dir && (c.package ?? null) === pkg : pkg != null ? c.package === pkg : path.posix.dirname(c.path) === dir;
                if (same) conflict({ qname: c.qname, path: c.path, line: c.start_line, why: `${c.qname} (${c.path}:${c.start_line}) already declares ${newName} in the same package as ${s.qname}` });
            }
        }
        // a Java top-level type named like its file is the file's public class: the file would have to be renamed too, which this does not do
        if (isTopLevel(s) && s.lang === 'java' && TYPE_KINDS.has(s.kind) && path.posix.basename(s.path) === `${old}.java`) {
            conflict({ qname: `${newName}.java`, path: s.path, line: s.start_line, why: `${s.qname} is the class ${s.path} is named after; Java needs the file renamed to ${newName}.java as well, which a rename here does not do (rename the file, then the class)` });
        }
        // a member also clashes with one of that name up or down its type hierarchy: it would override or hide it
        if (MEMBER.has(s.kind)) for (const c of hierarchyClashes(intel, s, newName)) conflict(c);
    }

    // definitions
    for (const { sym: s, how } of fam.values()) add(s.path, s.name_line, s.name_col, how);

    // `@old.setter` / `@old.getter` / `@old.deleter` above a redefinition of a Python property name the property: part of the definition
    for (const { sym: s } of fam.values()) {
        if (s.lang !== 'python') continue;
        const lines = intel.fileLines(s.path) ?? [];
        for (let k = s.name_line - 1; k >= Math.max(1, s.name_line - 8); k--) {
            const text = lines[k - 1] ?? '';
            if (!text.trim() || /^\s*(async\s+)?(def|class)\b/.test(text)) break;
            const m = new RegExp(`^(\\s*@)${escapeRegExp(old)}(?=\\.(?:setter|getter|deleter)\\b)`).exec(text);
            if (m) put(s.path, k, m[1].length, 'decorator');
        }
    }

    // references bound to any of them
    const ids = [...fam.keys()];
    const marks = ids.map(() => '?').join(',');
    const rows = intel.store.all(`SELECT r.line, r.col, r.kind, r.conf, r.recv, r.src_id, f.path, f.is_test FROM refs r JOIN files f ON f.id = r.file_id
        WHERE r.dst_id IN (${marks}) AND (r.recv_type IS NULL OR r.recv_type != '~structural') ORDER BY f.is_test, f.path, r.line, r.col`, ...ids);
    for (const r of rows) {
        if (r.conf >= minConf) add(r.path, r.line, r.col, r.kind, { src: r.src_id });
        else skipped.push({ path: r.path, line: r.line, why: `bound with ${confidenceLabel(r.conf)} confidence${r.recv ? ` (receiver \`${r.recv}\`)` : ''}` });
    }

    // import and re-export statements that name a top-level definition (or a type's static owner)
    const top = [...fam.values()].map(f => f.sym).filter(isTopLevel);
    if (top.length) {
        const resolver = intel.ix.resolver, topIds = new Set(top.map(s => s.id));
        const imps = intel.store.all(`SELECT f.path, i.line, i.imported, i.local, i.reexport, i.target_file_id FROM imports i JOIN files f ON f.id = i.file_id
            WHERE i.imported = ? AND i.target_file_id IS NOT NULL ORDER BY f.path, i.line`, old);
        for (const imp of imps) {
            if (!resolver.exportedFrom(imp.target_file_id, old).some(id => topIds.has(id))) continue;
            const lines = intel.fileLines(imp.path) ?? [];
            // the statement can span lines (`import {\n  a,\n  b,\n} from '…'`, or in Python a trailing backslash): to the line that closes it
            const python = imp.path.endsWith('.py');
            let end = imp.line;
            for (let depth = 0, k = imp.line; k <= Math.min(lines.length, imp.line + 60); k++) {
                const text = lines[k - 1] ?? '';
                depth += (text.match(/[({]/g) ?? []).length - (text.match(/[)}]/g) ?? []).length;
                end = k;
                if (depth <= 0 && !(python && /\\\s*$/.test(text))) break;
            }
            const re = new RegExp(`(?<![\\w$.])${escapeRegExp(old)}(?![\\w$])`, 'g');
            for (let k = imp.line; k <= end; k++) for (const m of (lines[k - 1] ?? '').matchAll(re)) {
                // the module path may hold the same word (`import { parse } from './parse'`): it names a file
                if (inString(lines[k - 1], m.index)) continue;
                const key = `${imp.path}:${k}:${m.index}`;
                if (!edits.has(key)) edits.set(key, { path: imp.path, line: k, col: m.index, what: imp.reexport ? 're-export' : 'import' });
            }
        }
    }

    // what the syntax tree knows and the index does not (JavaScript family): the closing tag of a JSX element, the export
    // statements of the defining file, and what a shorthand property means
    const topFiles = new Set(top.map(s => s.path));
    const ecmaFiles = new Set([...[...edits.values()].map(e => e.path), ...topFiles].filter(p => ECMA.has(codeSpecForPath(p)?.id)));
    for (const p of ecmaFiles) {
        const lines = intel.fileLines(p);
        const spec = codeSpecForPath(p);
        if (!lines) continue;
        let tree = null;
        try {
            const { parser } = await prepareLanguage(spec);
            tree = parseSource(spec, parser, lines.join('\n'));
            const root = tree.rootNode;
            for (const e of [...edits.values()].filter(x => x.path === p)) {
                const n = root.descendantForPosition({ row: e.line - 1, column: e.col });
                if (!n || n.text !== old) continue;
                // `{ old }` in an object expression is the key `old` and the value: only the value is renamed. In a pattern (`const { old } = require(…)`)
                // and in the CommonJS export list the name is the binding itself, which follows
                if (n.type === 'shorthand_property_identifier' && !isCjsExportList(n.parent)) e.repl = `${old}: ${newName}`;
                // an opening JSX tag and its closing tag are one name
                let tag = n.parent;
                for (let k = 0; tag && k < 3 && !/^jsx_(opening|self_closing|closing)_element$/.test(tag.type); k++) tag = tag.parent;
                if (tag?.type === 'jsx_opening_element' && tag.parent?.type === 'jsx_element') {
                    const name = tag.childForFieldName('name'), close = tag.parent.childForFieldName('close_tag')?.childForFieldName('name');
                    if (name && close && n.startIndex >= name.startIndex && n.endIndex <= name.endIndex && name.startPosition.row === n.startPosition.row && close.startPosition.row === close.endPosition.row) {
                        put(p, close.startPosition.row + 1, close.startPosition.column + (n.startPosition.column - name.startPosition.column), 'closing tag');
                    }
                }
            }
            // the defining file's own export statements name the definition: `export default old`, `export { old }`, `export { old as alias }` (only
            // `old` changes: the alias is the exported name), `module.exports = { old }`
            if (topFiles.has(p)) for (const stmt of root.namedChildren) {
                const names = [];
                if (stmt.type === 'export_statement' && !stmt.childForFieldName('source')) {
                    const val = stmt.childForFieldName('value');
                    if (val?.type === 'identifier') names.push(val);
                    for (const c of stmt.namedChildren) if (c.type === 'export_clause') for (const sp of c.namedChildren) {
                        const nm = sp.type === 'export_specifier' ? sp.childForFieldName('name') : null;
                        if (nm && nm.type !== 'string') names.push(nm);
                    }
                } else if (stmt.type === 'expression_statement') {
                    const asg = stmt.namedChildren[0], obj = asg?.type === 'assignment_expression' ? asg.childForFieldName('right') : null;
                    if (obj?.type === 'object' && isCjsExportList(obj)) for (const c of obj.namedChildren) if (c.type === 'shorthand_property_identifier') names.push(c);
                }
                for (const n of names) if (n.text === old) put(p, n.startPosition.row + 1, n.startPosition.column, 'export');
            }
        } catch { /* the tree is an addition: without it the edits stay what the index knows */ }
        finally { tree?.delete(); }
    }

    // what a rename has to look at by hand
    const unbound = intel.unboundFor(sym.id);
    const unreadable = intel.filesWithParseErrors(old, { lang: null, max: 12 });

    // …or in a file that will come to use the new name: one that already declares or imports
    // something called that would end up with two bindings of it, or with calls that mean the other
    if (top.length) {
        const sites = new Map();
        for (const e of edits.values()) if (!sites.has(e.path)) sites.set(e.path, e.line);
        for (const [p, line] of sites) {
            const own = intel.store.all(`SELECT s.qname, s.start_line FROM symbols s JOIN files f ON f.id = s.file_id
                WHERE f.path = ? AND s.name = ? AND s.kind NOT IN ('method', 'field', 'property', 'constructor')`, p, newName);
            for (const c of own) if (!conflicts.some(x => x.path === p && x.line === c.start_line)) conflicts.push({ qname: c.qname, path: p, line: c.start_line });
            const imported = intel.store.get('SELECT i.line FROM imports i JOIN files f ON f.id = i.file_id WHERE f.path = ? AND i.local = ? LIMIT 1', p, newName);
            if (imported) conflicts.push({ qname: `${newName} (imported)`, path: p, line: imported.line ?? line });
        }
    }

    // a bare use of the old name (not after `.`, `->`, `::`) means whatever the new name is bound to where it stands: if the enclosing
    // definition already uses the new name as a bare identifier (a parameter, a local), the call would reach that instead
    const wordRe = new RegExp(`(?<![\\w$.])(?<!->)(?<!::)${escapeRegExp(newName)}(?![\\w$])`, 'g');
    const scanned = new Map();
    for (const e of edits.values()) {
        if (e.src == null) continue;
        const text = lineOf(e.path, e.line) ?? '';
        if (/(\.|->|::)\s*$/.test(text.slice(0, e.col))) continue;
        const enc = scanned.get(e.src) ?? scanned.set(e.src, intel.sym(e.src)).get(e.src);
        if (!enc) continue;
        const lines = intel.fileLines(enc.path) ?? [];
        for (let k = enc.start_line; k <= Math.min(enc.end_line, lines.length); k++) {
            const l = lines[k - 1] ?? '';
            if (/^\s*(\/\/|#|\*|\/\*)/.test(l)) continue;
            const hit = [...l.matchAll(wordRe)].find(m => !inString(l, m.index));
            if (hit) { conflict({ qname: `${newName} (in ${enc.qname})`, path: enc.path, line: k, why: `${newName} is already used as a name inside ${enc.qname} (${enc.path}:${k}), where ${old} is used at ${e.path}:${e.line}: the call would reach that instead` }); break; }
        }
    }

    // Go: the first letter decides who can see a name; an exported one made unexported breaks every other package that uses it
    if (sym.lang === 'go' && /^\p{Lu}/u.test(old) && !/^\p{Lu}/u.test(newName)) {
        const dirs = new Set([...fam.values()].map(f => path.posix.dirname(f.sym.path)));
        const outside = [...edits.values()].find(e => !dirs.has(path.posix.dirname(e.path)));
        if (outside) conflict({ qname: `${newName} (unexported)`, path: outside.path, line: outside.line, why: `${old} is exported and ${outside.path}:${outside.line} uses it from another package; ${newName} would be unexported there and not compile` });
    }

    // a builtin or global a file that will hold the new name already uses: a top-level definition called that takes the use over.
    // The files where the new name will be bound: the defining one and those that import it by name; in Go and Java every file
    // of the package. A keyword argument (`f(id=2)`) is no use of the name.
    const builtins = BUILTINS[codeSpecForPath(sym.path)?.id ?? sym.lang];
    if (top.length && builtins?.has(newName)) {
        const holders = new Set(top.map(s => s.path));
        for (const r of intel.store.all('SELECT DISTINCT f.path FROM imports i JOIN files f ON f.id = i.file_id WHERE i.imported = ? AND i.local = ?', old, old)) holders.add(r.path);
        for (const s of top) if (PACKAGE_SCOPED.has(s.lang)) {
            const pkg = intel.store.get('SELECT package FROM files WHERE id = ?', s.file_id)?.package ?? null, dir = path.posix.dirname(s.path);
            for (const f of intel.store.all('SELECT path, package FROM files WHERE lang = ?', s.lang)) if (s.lang === 'go' ? path.posix.dirname(f.path) === dir : pkg != null ? f.package === pkg : path.posix.dirname(f.path) === dir) holders.add(f.path);
        }
        const kwarg = (l, at) => sym.lang === 'python' && /^\s*=(?!=)/.test(l.slice(at + newName.length)) && (l.slice(0, at).match(/\(/g) ?? []).length > (l.slice(0, at).match(/\)/g) ?? []).length;
        outer: for (const p of [...holders].sort()) {
            const lines = intel.fileLines(p) ?? [];
            for (let k = 0; k < lines.length; k++) {
                const l = lines[k];
                if (/^\s*(\/\/|#|\*|\/\*)/.test(l)) continue;
                if ([...l.matchAll(wordRe)].some(m => !inString(l, m.index) && !kwarg(l, m.index))) { conflict({ qname: `${newName} (builtin)`, path: p, line: k + 1, why: `${newName} is a builtin or global that ${p}:${k + 1} uses; a definition called ${newName} would take that use over` }); break outer; }
            }
        }
    }

    // string literals that name the member: not the ones at a position that is edited anyway (`__all__ = ["name"]`)
    const strings = intel.stringMentions(sym.id, { max: 40 }).filter(sm => {
        const hits = [...sm.text.matchAll(new RegExp(`(['"\`])(?:[\\w.]*\\.)?${escapeRegExp(old)}\\1`, 'g'))];
        if (!hits.length) return true;
        const raw = lineOf(sm.path, sm.line) ?? '';
        const at = [...raw.matchAll(new RegExp(`(['"\`])(?:[\\w.]*\\.)?${escapeRegExp(old)}\\1`, 'g'))];
        return !at.length || at.some(m => !edits.has(`${sm.path}:${sm.line}:${m.index + m[0].length - 1 - old.length}`));
    }).slice(0, 12);

    // the name where the index records nothing at all, in the files that use the definition (a function passed as a value,
    // `ns.old` through a namespace import, a method reference `T::old`): not edited, listed
    const mentions = [];
    let mentionsCut = 0;
    {
        const files = new Set([...edits.values()].map(e => e.path));
        const famSyms = [...fam.values()].map(f => f.sym);
        const fileIds = [...new Set(famSyms.map(s => s.file_id))], parentIds = [...new Set(famSyms.map(s => s.parent_id).filter(x => x != null))];
        const qs = (a) => a.map(() => '?').join(',');
        for (const r of intel.store.all(`SELECT DISTINCT f.path FROM imports i JOIN files f ON f.id = i.file_id WHERE i.target_file_id IN (${qs(fileIds)})`, ...fileIds)) files.add(r.path);
        const dirs = [...new Set(famSyms.filter(s => s.lang === 'go').map(s => path.posix.dirname(s.path)))];
        if (dirs.length) for (const r of intel.store.all(`SELECT DISTINCT f.path FROM imports i JOIN files f ON f.id = i.file_id WHERE i.target_dir IN (${qs(dirs)})`, ...dirs)) files.add(r.path);
        if (parentIds.length) for (const r of intel.store.all(`SELECT DISTINCT f.path FROM refs r JOIN files f ON f.id = r.file_id WHERE r.dst_id IN (${qs(parentIds)})`, ...parentIds)) files.add(r.path);
        const listed = new Set([...skipped, ...unbound.plausible, ...strings, ...unreadable].map(x => `${x.path}:${x.line}`));
        const oldRe = new RegExp(`(?<![\\w$])${escapeRegExp(old)}(?![\\w$])`, 'g');
        // lines where the index does know what the name means: a reference bound (to it, or to another definition), a definition, an import
        const known = (p) => new Set(intel.store.all(`SELECT r.line FROM refs r JOIN files f ON f.id = r.file_id WHERE f.path = ? AND r.name = ? AND r.dst_id IS NOT NULL
            UNION SELECT s.name_line FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.name = ?
            UNION SELECT i.line FROM imports i JOIN files f ON f.id = i.file_id WHERE f.path = ? AND (i.imported = ? OR i.local = ?)`, p, old, p, old, p, old, old).map(r => r.line));
        // a member called on some receiver (`x.get(…)`) is a call the index saw and judged: the unbound ones of note are listed above
        const memberCall = MEMBER.has(sym.kind) ? (l, at) => /(\.|\?\.|->)\s*$/.test(l.slice(0, at)) && /^\s*\(/.test(l.slice(at + old.length)) : () => false;
        const scan = [...files].sort();
        if (scan.length > 400) mentionsCut = scan.length;
        for (const p of scan.slice(0, 400)) {
            if (mentions.length >= 20) break;
            const lines = intel.fileLines(p);
            if (!lines) continue;
            let seen = null;
            for (let k = 0; k < lines.length && mentions.length < 20; k++) {
                const l = lines[k];
                if (!l.includes(old) || /^\s*(\/\/|#|\*|\/\*)/.test(l) || listed.has(`${p}:${k + 1}`)) continue;
                const hit = [...l.matchAll(oldRe)].find(m => !edits.has(`${p}:${k + 1}:${m.index}`) && !inString(l, m.index) && !memberCall(l, m.index));
                if (!hit) continue;
                seen ??= known(p);
                if (!seen.has(k + 1)) mentions.push({ path: p, line: k + 1, text: l.trim() });
            }
        }
    }

    const list = [...edits.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.col - b.col));
    const byFile = new Map();
    for (const e of list) (byFile.get(e.path) ?? byFile.set(e.path, []).get(e.path)).push(e);
    const preview = list.map(e => {
        const text = lineOf(e.path, e.line) ?? '';
        const { src, repl, ...rest } = e;
        return { ...rest, before: text.trim(), after: (text.slice(0, e.col) + (repl ?? newName) + text.slice(e.col + old.length)).trim() };
    });

    const out = {
        sym, old, newName, family: [...fam.values()].map(f => ({ qname: f.sym.qname, path: f.sym.path, line: f.sym.start_line, how: f.how })),
        edits: preview, files: byFile.size, skipped, conflicts, applied: false, written: 0, notWritten: null,
        unbound: { total: unbound.total, plausible: unbound.plausible.slice(0, 20), typeNames: unbound.typeNames },
        strings, unreadable, mentions, mentionsCut,
    };
    if (!apply || conflicts.length) return out;
    if (unverified.length) {
        out.notWritten = `${unverified.length} edit${unverified.length === 1 ? '' : 's'} the index expects could not be verified against the files (${unverified.slice(0, 3).map(u => `${u.path}:${u.line}`).join(', ')}): writing the rest would leave the code half renamed. Nothing was written`;
        return out;
    }
    return writeEdits(intel, out, byFile, list.length);
}

/**
 * Write every file or none: the new texts are computed first, from what is on disk now and checked against the index, each file is
 * checked writable and unchanged, then written through a temporary file; a failure restores the files already written.
 */
async function writeEdits(intel, out, byFile, total) {
    const { old, newName } = out;
    const files = [...byFile.keys()];
    const stale = intel.ix.staleAmong(files);
    if (stale.length) return { ...out, applied: false, error: `Not written: ${stale.slice(0, 4).join(', ')} changed on disk since the index read ${stale.length === 1 ? 'it' : 'them'}; nothing was written. Run it again.` };
    const plan = [];   // { p, abs, raw, next, mode, size, mtime }
    const fail = (why) => ({ ...out, applied: false, notWritten: why });
    for (const [p, es] of byFile) {
        const abs = path.join(intel.root, p);
        let st, text, raw;
        try {
            if (!withinRoot(intel.root, p)) return fail(`${p} is outside the repository root`);
            st = fs.lstatSync(abs);
            if (!st.isFile()) return fail(`${p} is not a regular file (a symbolic link or something else): it is not written through`);
            fs.accessSync(abs, fs.constants.W_OK);
            raw = fs.readFileSync(abs);
        } catch (e) { return fail(`${p} cannot be written (${e.code ?? e.message})`); }
        // the edits are made on the text: bytes that are not UTF-8 would come back changed on lines the rename never touched
        text = raw.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(raw)) return fail(`${p} is not valid UTF-8; rewriting it would change bytes the rename does not touch`);
        // lines with their own endings, so a file with mixed CRLF and LF keeps each as it was
        const parts = text.split(/(?<=\n)/).map(l => { const m = /\r?\n$/.exec(l); return m ? [l.slice(0, -m[0].length), m[0]] : [l, '']; });
        // right to left on each line, so earlier columns stay where the index put them
        for (const e of [...es].sort((a, b) => b.line - a.line || b.col - a.col)) {
            const l = parts[e.line - 1]?.[0];
            if (l == null || !l.startsWith(old, e.col)) return fail(`${p}:${e.line} does not hold \`${old}\` where the index expected it`);
            parts[e.line - 1][0] = l.slice(0, e.col) + (e.repl ?? newName) + l.slice(e.col + old.length);
        }
        plan.push({ p, abs, raw, next: Buffer.from(parts.map(x => x[0] + x[1]).join(''), 'utf8'), mode: st.mode & 0o7777, size: st.size, mtime: st.mtimeMs });
    }
    const done = [], restored = [], stuck = [];
    let failure = null;
    try {
        for (const f of plan) {
            const st = fs.lstatSync(f.abs);
            if (!st.isFile() || st.size !== f.size || st.mtimeMs !== f.mtime) throw new Error(`${f.p} changed while it was being written`);
            writeAtomic(f.abs, f.next, f.mode);
            done.push(f);
        }
    } catch (e) {
        failure = e;
        for (const f of done.reverse()) {
            try {
                if (!fs.readFileSync(f.abs).equals(f.next)) throw new Error('changed since');
                writeAtomic(f.abs, f.raw, f.mode); restored.push(f.p);
            } catch { stuck.push(f.p); }
        }
    } finally {
        await intel.ix.syncPaths(plan.map(f => f.p));
    }
    if (failure) {
        return { ...out, applied: false, error: `Not renamed: writing failed (${[failure.code, String(failure.message).split(intel.root + path.sep).join('')].filter(Boolean).join(' ')}). Restored: ${restored.join(', ') || 'none needed'}.${stuck.length ? ` Could not restore (check by hand): ${stuck.join(', ')}.` : ''}` };
    }
    return { ...out, applied: true, written: plan.length, edits: out.edits.slice(0, total) };
}
