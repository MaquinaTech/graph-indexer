#!/usr/bin/env node
/**
 * Reference-graph accuracy against a compiler oracle.
 *
 * For a seeded random sample of functions/methods/classes, compare the references graph-indexer
 * reports (find_references) with the TypeScript LanguageService's findReferences (the compiler's
 * own symbol binding), at (file, line) granularity. Import/export specifiers and the declaration
 * itself are excluded on both sides. Two oracles are derived from the compiler's answer:
 *   - rename:   everything findReferences returns (the editor's Find All References / rename set;
 *               for a method this includes calls to sibling overrides that share a base member);
 *   - dispatch: only references to the member itself, the members it overrides/implements
 *               (calls through a base type may dispatch here) and its own overrides — i.e. sibling
 *               implementations' call sites are dropped. This is what find_references promises.
 * Two baselines are scored on the same sample:
 *   - grep:      every line containing the name as a whole word (what an agent does by default);
 *   - name-only: every syntactic reference (call/new/type/…) with the same name, unresolved.
 * With --v2 <dir>, graph-indexer 2.x is scored too, through its own MCP server and index:
 *   - v2:        its find_references (called by, subclassed by, used as a type by) for the name,
 *                scoped to the owning class for a method. 2.x answers with the referencing chunks
 *                (function, method or whole class), not lines: its lines are those of each chunk
 *                that contain the name as a word — what an agent finds reading the chunks it names;
 *   - v2 (high): the same without the references it marks unverified (name-only).
 * Every system is also scored at file level (the files holding references), where 2.x needs no
 * derivation, and the size of each tool's answer (the text an agent reads) is reported.
 * A monorepo whose packages carry their own path aliases sets its program with GI_TSCONFIG
 * (bench/agentic/tsconfig.mjs).
 *
 *   node bench/eval-graph.mjs [--fixture nestjs] [--scope packages/core,packages/common] [--n 150] [--seed 7] [--v2 ~/.gi-agentic/v2]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CodeIntel } from '../src/query/intel.mjs';
import { tsSetup } from './agentic/tsconfig.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { v2Comparison, answerSizes } from './v2-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const fixture = opt('--fixture', 'nestjs');
const scope = opt('--scope', 'packages/core,packages/common').split(',');
const N = Number(opt('--n', 150));
const seed = Number(opt('--seed', 7));
const root = path.resolve(opt('--fixture-dir', path.join(here, '../test/fixtures')), fixture);
const tsPath = opt('--typescript', process.env.TYPESCRIPT_PATH ?? '/opt/node22/lib/node_modules/typescript');
const ts = createRequire(import.meta.url)(tsPath);

function rng(s) { return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

const intel = new CodeIntel({ root, dbPath: path.join(opt('--db-dir', path.join(os.tmpdir(), 'graph-indexer-bench')), fixture + '.db') });
await intel.open();

// ── TypeScript language service over the whole repo's .ts files ───────────────────
const cfg = tsSetup(ts, root);
const inProgram = cfg.files && new Set(cfg.files.map(f => path.relative(root, f).split(path.sep).join('/')));
const tsFiles = intel.store.all("SELECT path FROM files WHERE lang IN ('typescript','tsx')").map(r => r.path).filter(f => !inProgram || inProgram.has(f));
const options = { ...cfg.options, noEmit: true, skipLibCheck: true, types: [] };
const versions = new Map();
const host = {
    getScriptFileNames: () => tsFiles.map(f => path.join(root, f)),
    getScriptVersion: (f) => String(versions.get(f) ?? 0),
    getScriptSnapshot: (f) => fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined,
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
};
const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
const t0 = Date.now();
const program = ls.getProgram();
console.log(`TypeScript ${ts.version}: program with ${program.getSourceFiles().length} files in ${Date.now() - t0} ms`);

function inImportExport(sf, pos) {
    let n = ts.getTokenAtPosition ? ts.getTokenAtPosition(sf, pos) : null;
    for (let g = 0; n && g < 12; g++, n = n.parent) {
        if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || ts.isExportDeclaration(n) || ts.isExportAssignment(n) || ts.isImportSpecifier?.(n) || ts.isExportSpecifier?.(n)) return true;
    }
    return false;
}

/** Related declarations (overload signatures, overriding/implementing members) are not uses. */
function isDeclarationName(sf, pos) {
    const tok = ts.getTokenAtPosition(sf, pos);
    const p = tok?.parent;
    return !!p && (ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)
        || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isGetAccessorDeclaration(p)
        || ts.isSetAccessorDeclaration(p)) && p.name === tok;
}

const checker = program.getTypeChecker();

/**
 * For a member declaration at a position: the class/interface symbol declaring it (null for
 * object-literal or anonymous-class members). `undefined` when the position is not a member
 * declaration (functions, classes, import aliases…), where both oracles coincide.
 */
function memberOwnerAt(fileName, pos) {
    const sf = program.getSourceFile(fileName);
    if (!sf) return undefined;
    const tok = ts.getTokenAtPosition(sf, pos);
    const d = tok?.parent;
    if (!d || d.name !== tok) return undefined;
    let owner;
    if (ts.isMethodDeclaration(d) || ts.isMethodSignature(d) || ts.isPropertyDeclaration(d) || ts.isPropertySignature(d) || ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d)) owner = d.parent;
    else if (ts.isParameter(d) && ts.isConstructorDeclaration(d.parent) && ts.getEffectiveModifierFlags?.(d)) owner = d.parent.parent; // parameter property
    else return undefined;
    if ((ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) && owner.name) return checker.getSymbolAtLocation(owner.name) ?? null;
    return null;
}

const superCache = new Map();
/** All transitive supertypes (extends + implements) of a class/interface symbol. */
function supertypes(typeSym) {
    if (superCache.has(typeSym)) return superCache.get(typeSym);
    const out = new Set();
    superCache.set(typeSym, out);
    const visit = (sym, depth) => {
        if (!sym || depth > 12) return;
        for (const d of sym.declarations ?? []) {
            for (const hc of d.heritageClauses ?? []) for (const t of hc.types) {
                let b = checker.getSymbolAtLocation(t.expression);
                if (b && (b.flags & ts.SymbolFlags.Alias)) b = checker.getAliasedSymbol(b);
                if (b && !out.has(b)) { out.add(b); visit(b, depth + 1); }
            }
        }
    };
    visit(typeSym, 0);
    return out;
}

function oracleRefs(sym, { dispatch = false } = {}) {
    const file = path.join(root, sym.path);
    const sf = program.getSourceFile(file);
    if (!sf) return null;
    const pos = ts.getPositionOfLineAndCharacter(sf, sym.name_line - 1, sym.name_col);
    const groups = ls.findReferences(file, pos);
    if (!groups) return null;
    const self = memberOwnerAt(file, pos);
    const out = new Set();
    for (const g of groups) {
        if (dispatch && self) {
            const owner = memberOwnerAt(g.definition.fileName, g.definition.textSpan.start);
            const related = owner === undefined || owner === self || (owner && (supertypes(self).has(owner) || supertypes(owner).has(self)));
            if (!related) continue;
        }
        for (const r of g.references) {
            if (r.isDefinition) continue;
            const rsf = program.getSourceFile(r.fileName);
            if (!rsf) continue;
            const rel = path.relative(root, r.fileName).split(path.sep).join('/');
            if (rel.startsWith('..') || rel.includes('node_modules')) continue;
            if (inImportExport(rsf, r.textSpan.start)) continue;
            if (isDeclarationName(rsf, r.textSpan.start)) continue;
            const line = rsf.getLineAndCharacterOfPosition(r.textSpan.start).line + 1;
            out.add(`${rel}:${line}`);
        }
    }
    // the declaration line itself is never a reference
    out.delete(`${sym.path}:${sym.name_line}`);
    return out;
}

const TS_FILE = /\.(ts|tsx|mts|cts)$/; // the oracle's universe (the TS program does not include JS files)
function oursRefs(sym, { minConf = 0 } = {}) {
    const r = intel.references(sym.id, { minConf });
    const out = new Set();
    for (const rows of r.groups.values()) for (const x of rows) if (x.kind !== 'import' && TS_FILE.test(x.path)) out.add(`${x.path}:${x.line}`);
    out.delete(`${sym.path}:${sym.name_line}`);
    return out;
}

function nameOnlyRefs(sym) {
    const rows = intel.store.all("SELECT f.path, r.line FROM refs r JOIN files f ON f.id = r.file_id WHERE r.name = ? AND f.lang IN ('typescript','tsx')", sym.name);
    const out = new Set(rows.map(r => `${r.path}:${r.line}`));
    out.delete(`${sym.path}:${sym.name_line}`);
    return out;
}

const grepCache = new Map();
function grepRefs(sym) {
    const re = new RegExp(`\\b${sym.name.replace(/[$]/g, '\\$')}\\b`);
    const out = new Set();
    for (const f of tsFiles) {
        let lines = grepCache.get(f);
        if (!lines) { lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n'); grepCache.set(f, lines); }
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (!re.test(l)) continue;
            if (/^\s*(import|export)\b.*\bfrom\b/.test(l) || /^\s*import\s/.test(l)) continue;
            out.add(`${f}:${i + 1}`);
        }
    }
    out.delete(`${sym.path}:${sym.name_line}`);
    return out;
}

// ── sample ───────────────────────────────────────────────────────────────────────
// (an anonymous class, named `<anonymous>` in the index, is nothing anyone looks up by name)
const cands = intel.store.all(`SELECT s.id, s.name, s.qname, s.kind, s.name_line, s.name_col, f.path FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE f.lang = 'typescript' AND f.is_test = 0 AND s.kind IN ('function','method','class','interface') AND length(s.name) > 2 AND s.name NOT IN ('constructor')
    AND s.name NOT LIKE '<%'`)
    .filter(s => scope.some(p => s.path.startsWith(p)) && !s.path.endsWith('.d.ts'));
const rand = rng(seed);
const sample = [];
const pool = [...cands];
while (sample.length < N && pool.length) sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);

// ── graph-indexer 2.x, and the size of each tool's answer ────────────────────────────
const v2Root = opt('--v2', null) && path.resolve(opt('--v2').replace(/^~/, os.homedir()));
const fileLines = (f) => { let l = grepCache.get(f); if (!l) { l = fs.readFileSync(path.join(root, f), 'utf8').split('\n'); grepCache.set(f, l); } return l; };
const v2 = v2Root ? await v2Comparison({ v2Root, root, sample, intel, fileRe: TS_FILE, linesOf: fileLines, reindex: args.includes('--v2-reindex'), callTool }) : null;

const systems = { 'graph-indexer': oursRefs, 'gi (>=likely)': (s) => oursRefs(s, { minConf: 0.4 }), 'name-only': nameOnlyRefs, grep: grepRefs,
    ...(v2 ? { v2: v2.refs, 'v2 (high)': (s) => v2.refs(s, { highOnly: true }) } : {}) };
const ORACLES = ['dispatch', 'rename', 'dispatch/files'];
const filesOf = (set) => new Set([...set].map(x => x.slice(0, x.lastIndexOf(':'))));
const newAgg = () => Object.fromEntries(Object.keys(systems).map(k => [k, { tp: 0, fp: 0, fn: 0, pSum: 0, rSum: 0, n: 0, perfect: 0 }]));
const aggs = Object.fromEntries(ORACLES.map(o => [o, newAgg()]));
let evaluated = 0, withRefs = 0;
const t1 = Date.now();
for (const sym of sample) {
    const golds = { dispatch: oracleRefs(sym, { dispatch: true }), rename: oracleRefs(sym) };
    if (golds.dispatch) golds['dispatch/files'] = filesOf(golds.dispatch);
    if (!golds.rename) continue;
    const gold = golds.dispatch;
    evaluated++;
    if (gold.size) withRefs++;
    if (args.includes('--debug')) {
        const got = oursRefs(sym);
        const miss = [...gold].filter(x => !got.has(x));
        const extra = [...got].filter(x => !gold.has(x));
        if (miss.length || extra.length) {
            console.log(`\n${sym.qname} (${sym.kind}) ${sym.path}:${sym.name_line}  gold=${gold.size} ours=${got.size}`);
            for (const m of miss.slice(0, 6)) { const [f, l] = m.split(':'); console.log(`   MISS ${m}  ${(grepCache.get(f) ?? fs.readFileSync(path.join(root, f), 'utf8').split('\n'))[l - 1]?.trim().slice(0, 110)}`); }
            for (const m of extra.slice(0, 3)) { const [f, l] = m.split(':'); console.log(`   EXTRA ${m}  ${fs.readFileSync(path.join(root, f), 'utf8').split('\n')[l - 1]?.trim().slice(0, 110)}`); }
        }
    }
    for (const [name, fn] of Object.entries(systems)) {
        const lines = fn(sym);
        for (const o of ORACLES) {
            const g = golds[o];
            const got = o.endsWith('/files') ? filesOf(lines) : lines;
            let tp = 0;
            for (const x of got) if (g.has(x)) tp++;
            const fp = got.size - tp, fnn = g.size - tp;
            const a = aggs[o][name];
            a.tp += tp; a.fp += fp; a.fn += fnn;
            const p = got.size ? tp / got.size : (g.size ? 0 : 1);
            const r = g.size ? tp / g.size : 1;
            a.pSum += p; a.rSum += r; a.n++;
            if (fp === 0 && fnn === 0) a.perfect++;
        }
    }
}
console.log(`\n${fixture} (${scope.join(', ')}): ${evaluated} sampled symbols (${withRefs} with ≥1 dispatch-oracle reference), oracle = TypeScript findReferences, ${Date.now() - t1} ms`);
const result = {};
for (const o of ORACLES) {
    console.log(`\noracle: ${o === 'dispatch' ? 'dispatch (self + overridden + overriding members)' : o === 'rename' ? 'rename (full Find All References, incl. sibling overrides)' : 'dispatch, file level (the files holding references)'}`);
    console.log('system          micro-P  micro-R  micro-F1 | macro-P  macro-R | exact-set');
    result[o] = {};
    for (const [name, a] of Object.entries(aggs[o])) {
        const P = a.tp / Math.max(1, a.tp + a.fp), R = a.tp / Math.max(1, a.tp + a.fn), F = 2 * P * R / Math.max(1e-9, P + R);
        result[o][name] = { microP: P, microR: R, microF1: F, macroP: a.pSum / a.n, macroR: a.rSum / a.n, exactSet: a.perfect / a.n };
        console.log(`${name.padEnd(15)} ${P.toFixed(3).padStart(7)}  ${R.toFixed(3).padStart(7)}  ${F.toFixed(3).padStart(8)} | ${(a.pSum / a.n).toFixed(3).padStart(7)}  ${(a.rSum / a.n).toFixed(3).padStart(7)} | ${(a.perfect / a.n).toFixed(3)}`);
    }
}
const answers = v2 ? answerSizes(v2.answers) : {};
if (opt('--json', null)) fs.writeFileSync(opt('--json'), JSON.stringify({ fixture, scope, n: evaluated, result, answers }, null, 2));
intel.close();
