/**
 * Edit checker: what an agent's uncommitted changes broke or left behind, found without building
 * the project. Compares every changed file with its version at the base commit (HEAD by default)
 * and reports, with locations:
 *
 *   syntax        parse errors that are new since the base version
 *   arity         calls whose argument count no longer fits the (changed) definition — call sites
 *                 of changed signatures anywhere, and calls written in the changed lines
 *   removed       definitions that were deleted or renamed but are still used or imported
 *   untouched     callers of a changed signature in files the change did not touch (to review)
 *   inherited     subclasses that inherit a changed member (they run the new code) or override it
 *   tests         the test files that exercise the changed code, and the command to run them
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { specForPath, isConstructor } from '../parse/languages.mjs';
import { prepareLanguage, extractFile } from '../parse/extract.mjs';
import { paramArity, callAt, callArgc, fits, describeArity } from '../parse/arity.mjs';
import { testCommands, testCaseCommands } from './testcmd.mjs';

const CALLABLE = new Set(['function', 'method', 'constructor']);
const MEMBER_KINDS = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'object', 'impl', 'module', 'type']);

function git(root, args) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
    return r.status === 0 ? r.stdout : null;
}

/** Changed files vs base with their changed (new-side) line ranges; untracked files count whole. */
function changedFiles(root, base) {
    const out = new Map();
    const diff = git(root, ['diff', '-U0', '--no-color', '--no-renames', base, '--']);
    if (diff === null) return null;
    let file = null, deleted = false;
    for (const line of diff.split('\n')) {
        if (line.startsWith('--- ')) { deleted = false; continue; }
        if (line.startsWith('+++ ')) {
            const p = line.slice(4);
            if (p === '/dev/null') { deleted = true; continue; }
            file = p.replace(/^b\//, '');
            if (!out.has(file)) out.set(file, { ranges: [], status: 'M' });
            continue;
        }
        const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (h && file && !deleted) {
            const start = Number(h[1]), len = h[2] === undefined ? 1 : Number(h[2]);
            if (len > 0) out.get(file).ranges.push([start, start + len - 1]);
        }
    }
    for (const l of (git(root, ['diff', '--name-status', '--no-renames', base, '--']) ?? '').split('\n')) {
        const [st, p] = l.split('\t');
        if (!p) continue;
        if (st === 'D') out.set(p, { ranges: [], status: 'D' });
        else if (st === 'A' && out.has(p)) out.get(p).status = 'A';
    }
    for (const f of (git(root, ['ls-files', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean)) {
        if (!out.has(f)) out.set(f, { ranges: [[1, 1e9]], status: 'A' });
    }
    return out;
}

/** Parse a source text: tree + extracted symbols, each symbol with its definition node's arity. */
async function analyse(spec, source, rel, tree = null) {
    if (!tree) { const { parser } = await prepareLanguage(spec); tree = parser.parse(source); }
    const ex = await extractFile(spec, source, rel);
    for (const s of ex.symbols) {
        if (!CALLABLE.has(s.kind) && !(s.kind === 'field' && /=>|function/.test(s.sig ?? ''))) continue;
        const node = defNodeAt(tree, s);
        if (!node) continue;
        s.arity = paramArity(node, { method: s.kind === 'method' || s.kind === 'constructor', lang: spec.id, isStatic: s.isStatic, decorators: s.decorators ?? [] });
    }
    return { tree, symbols: ex.symbols };
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

export async function checkChanges(intel, { base = 'HEAD', files = null, tests = true } = {}) {
    const root = intel.root;
    const changed = changedFiles(root, base);
    if (!changed) return { error: `git diff against ${base} failed — is this a git repository with that commit?` };
    // the edited files must be re-indexed now, whatever the file watcher has seen so far
    await intel.ensureFresh();
    await intel.ix.syncPaths([...changed.keys()]);
    const targets = [...changed.keys()].filter(f => specForPath(f) && (!files || files.some(x => f === x || f.startsWith(x.replace(/\/?$/, '/')))));
    const report = { base, files: targets.length, syntax: [], arity: [], removed: [], untouched: [], inherited: [], tests: [], commands: [], cases: [], casesTotal: 0, caseCommands: [], notes: [] };
    if (!targets.length) return report;
    // callers only need a syntax tree; definitions (changed files, callees) also need symbols + arities
    const treeCache = new Map(), symCache = new Map();
    const parsed = async (rel) => {
        if (treeCache.has(rel)) return treeCache.get(rel);
        let v = null;
        const spec = specForPath(rel);
        try {
            if (spec) {
                const src = fs.readFileSync(path.join(root, rel), 'utf8');
                const { parser } = await prepareLanguage(spec);
                v = { tree: parser.parse(src), lines: src.split(/\r?\n/), src, spec };
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
    const removedSyms = [];   // extracted base symbols
    for (const rel of targets) {
        const info = changed.get(rel);
        const spec = specForPath(rel);
        const baseSrc = info.status === 'A' ? null : git(root, ['show', `${base}:${rel}`]);
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
        for (const [k, olds] of before) {
            const news = now.get(k);
            const o = olds[0];
            if (!news) {
                if (o.kind === 'variable' && o.parentIdx >= 0) continue; // locals come and go
                if (!['function', 'method', 'class', 'interface', 'struct', 'enum', 'trait', 'type', 'constant', 'field', 'property', 'constructor'].includes(o.kind)) continue;
                // a moved definition (same qualified name elsewhere in the repository) is not removed
                if (intel.store.get('SELECT 1 FROM symbols WHERE qname = ? AND kind = ? LIMIT 1', o.qname, o.kind)) continue;
                removedSyms.push({ ...o, path: rel });
                continue;
            }
            const was = arityText(olds);
            const is = arityText(news);
            if (was !== is && news.some(s => s.arity)) changedSigs.push({ qname: o.qname, kind: o.kind, path: rel, was, is, arities: news.map(s => s.arity), name: o.name });
        }
        baseTree.delete();
    }

    // ── call sites of changed signatures ────────────────────────────────────────
    const seen = new Set();
    for (const c of changedSigs.slice(0, 40)) {
        const rows = intel.store.all(`SELECT s.id, s.parent_id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.qname = ? AND s.kind = ?`, c.path, c.qname, c.kind);
        if (!rows.length) continue;
        const ids = rows.map(r => r.id);
        // a constructor is called through its class
        if (isConstructor({ name: c.name, kind: c.kind, lang: specForPath(c.path)?.id }) && rows[0].parent_id != null) ids.push(rows[0].parent_id);
        const calls = intel.store.all(`SELECT r.line, r.col, r.kind, r.conf, f.path, src.qname AS src_qname FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols src ON src.id = r.src_id
            WHERE r.dst_id IN (${ids.map(() => '?').join(',')}) AND r.kind IN ('call','new') AND r.conf >= 0.7 ORDER BY f.is_test, f.path, r.line`, ...ids);
        const bad = [], untouched = [];
        for (const r of calls) {
            const t = await parsed(r.path);
            if (!t) continue;
            const node = callAt(t.tree, r.line - 1, r.col);
            const argc = node ? callArgc(node) : null;
            const k = `${r.path}:${r.line}:${r.col}`;
            if (argc && !unionFits(argc, c.arities)) { bad.push({ ...r, argc, text: t.lines[r.line - 1]?.trim() }); seen.add(k); }
            else if (!changed.has(r.path)) untouched.push({ ...r, text: t.lines[r.line - 1]?.trim() });
        }
        if (bad.length) report.arity.push({ target: c.qname, path: c.path, was: c.was, is: c.is, total: calls.length, sites: bad });
        if (untouched.length) report.untouched.push({ target: c.qname, path: c.path, was: c.was, is: c.is, sites: untouched });
    }

    // ── calls written in the changed lines (to anything) that do not fit their callee ─
    for (const rel of targets) {
        const info = changed.get(rel);
        if (info.status === 'D') continue;
        const fileRow = intel.store.get('SELECT id FROM files WHERE path = ?', rel);
        if (!fileRow) continue;
        const calls = intel.store.all(`SELECT r.line, r.col, r.dst_id, r.conf, d.qname, d.kind, d.parent_id, df.path AS dpath, src.qname AS src_qname FROM refs r
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
            const ct = await analysed(calleePath);
            const defs = ct?.symbols.filter(s => s.qname === calleeQ && s.kind === calleeKind) ?? [];
            const arities = defs.map(s => s.arity).filter(Boolean);
            if (!arities.length) continue;
            const node = callAt(t.tree, r.line - 1, r.col);
            const argc = node ? callArgc(node) : null;
            if (argc && !unionFits(argc, arities)) {
                report.arity.push({ target: calleeQ, path: calleePath, is: arities.map(describeArity).join(' | '), total: 1, sites: [{ ...r, path: rel, argc, text: t.lines[r.line - 1]?.trim() }], newCall: true });
            }
        }
    }

    // ── removed or renamed definitions still in use ─────────────────────────────
    for (const s of removedSyms.slice(0, 30)) {
        const owner = s.owner ?? (s.qname.includes('.') ? s.qname.split('.').slice(-2, -1)[0] : null);
        let rows = intel.store.all(`SELECT r.line, r.recv, r.kind, f.path, src.qname AS src_qname FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols src ON src.id = r.src_id
            WHERE r.name = ? AND r.dst_id IS NULL AND r.kind IN ('call','new','type','inherit','decorator','value','read') ORDER BY f.is_test, f.path, r.line`, s.name);
        const files = new Map();
        const mentions = (p, word) => {
            const key = p + '\u0000' + word;
            if (!files.has(key)) { const lines = intel.fileLines(p); files.set(key, !!lines && lines.some(l => new RegExp(`\\b${word.replace(/[$]/g, '\\$')}\\b`).test(l))); }
            return files.get(key);
        };
        rows = rows.filter(r => {
            if (s.parentIdx >= 0 && owner) return (r.recv && r.recv.toLowerCase().includes(owner.toLowerCase())) || r.recv === 'this' && r.path === s.path || mentions(r.path, owner);
            return r.path === s.path || mentions(r.path, s.name);
        });
        // imports of a removed top-level name
        const imports = s.parentIdx < 0 ? intel.store.all(`SELECT f.path, i.line FROM imports i JOIN files f ON f.id = i.file_id JOIN files t ON t.id = i.target_file_id
            WHERE t.path = ? AND (i.imported = ? OR i.local = ?)`, s.path, s.name, s.name) : [];
        if (rows.length || imports.length) report.removed.push({ qname: s.qname, kind: s.kind, path: s.path, uses: rows.slice(0, 12), total: rows.length, imports });
    }

    // ── subclasses that inherit a changed member run the new code too ───────────
    // (with tests: false — the edit hook — only problems are reported, so the diff is not mapped to symbols)
    const seeds = tests ? intel.diffSeeds(base).seeds ?? [] : [];
    const inheritorFiles = new Set();
    const byType = new Map();
    const members = new Map();
    for (const id of seeds) { const m = memberOf(intel, id); if (m && !m.is_test) members.set(m.id, m); }
    for (const m of members.values()) {
        const { inherit, override } = intel.inheritance(m.id);
        if (!inherit.length && !override.length) continue;
        const owner = m.parent_id != null ? intel.sym(m.parent_id) : null;
        const type = owner?.qname ?? m.qname.split('.').slice(0, -1).join('.');
        const e = byType.get(type) ?? byType.set(type, { type, path: m.path, members: [], inherit: new Map(), override: [] }).get(type);
        e.members.push(m.name);
        for (const s of inherit) {
            inheritorFiles.add(s.path); // a test subclass is not listed, but its file is a test to run
            if (!s.is_test) e.inherit.set(s.id, { qname: s.qname, path: s.path });
        }
        for (const s of override) if (!s.is_test) e.override.push({ qname: `${s.qname}.${m.name}`, path: s.path });
    }
    report.inherited = [...byType.values()].map(e => ({ ...e, inherit: [...e.inherit.values()] })).filter(e => e.inherit.length || e.override.length);

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
    return report;
}
