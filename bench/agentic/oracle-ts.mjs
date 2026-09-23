/**
 * TypeScript compiler oracle for benchmark tasks: references, call sites, incoming call
 * hierarchies and implementations, computed by the TypeScript LanguageService over a repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export function createTsOracle(root, relFiles, tsPath = process.env.TYPESCRIPT_PATH ?? '/opt/node22/lib/node_modules/typescript') {
    const ts = createRequire(import.meta.url)(tsPath);
    const cfgFile = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
    const cfg = cfgFile ? ts.parseJsonConfigFileContent(ts.readConfigFile(cfgFile, ts.sys.readFile).config, ts.sys, root) : { options: {} };
    const options = { ...cfg.options, noEmit: true, skipLibCheck: true, types: [] };
    const files = relFiles.map(f => path.join(root, f));
    const host = {
        getScriptFileNames: () => files,
        getScriptVersion: () => '0',
        getScriptSnapshot: (f) => fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined,
        getCurrentDirectory: () => root,
        getCompilationSettings: () => options,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
    };
    const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
    const program = ls.getProgram();
    const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');
    const inRepo = (abs) => { const r = rel(abs); return !r.startsWith('..') && !r.includes('node_modules'); };
    const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

    function posOf(relPath, line, col) {
        const sf = program.getSourceFile(path.join(root, relPath));
        if (!sf) return null;
        return { sf, file: sf.fileName, pos: ts.getPositionOfLineAndCharacter(sf, line - 1, col) };
    }

    function inImportExport(sf, pos) {
        let n = ts.getTokenAtPosition(sf, pos);
        for (let g = 0; n && g < 12; g++, n = n.parent) {
            if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || ts.isExportDeclaration(n) || ts.isExportAssignment(n)) return true;
        }
        return false;
    }

    /** Related declarations (overloads, overriding/implementing members) are not uses. */
    function isDeclarationName(sf, pos) {
        const tok = ts.getTokenAtPosition(sf, pos);
        const p = tok?.parent;
        return !!p && (ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)
            || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isGetAccessorDeclaration(p)
            || ts.isSetAccessorDeclaration(p)) && p.name === tok;
    }

    /** Is the reference at pos the callee of a call (`x.m(…)`, `m(…)`, `x?.m(…)`)? */
    function isCallee(sf, pos) {
        const tok = ts.getTokenAtPosition(sf, pos);
        let p = tok?.parent;
        if (!p) return false;
        if ((ts.isPropertyAccessExpression(p) || ts.isPropertyAccessChain?.(p)) && p.name === tok) {
            return !!p.parent && ts.isCallExpression(p.parent) && p.parent.expression === p;
        }
        return ts.isCallExpression(p) && p.expression === tok;
    }

    /** Enclosing function-like declaration of a position: {name, start, end} (1-based lines). */
    function enclosing(sf, pos) {
        let n = ts.getTokenAtPosition(sf, pos);
        while (n && !(ts.isFunctionLike(n) && (n.name || ts.isConstructorDeclaration(n)))) n = n.parent;
        if (!n) return null;
        const owner = n.parent && (ts.isClassLike(n.parent) || ts.isInterfaceDeclaration(n.parent)) && n.parent.name ? n.parent.name.text + '.' : '';
        const name = ts.isConstructorDeclaration(n) ? 'constructor' : n.name.getText(sf);
        return { name: owner + name, start: lineOf(sf, n.getStart(sf)), end: lineOf(sf, n.getEnd()) };
    }

    /**
     * References of the symbol declared at (relPath, line, col).
     * Returns { groups, refs: [{path, line, call}] } — groups > 1 means related declarations
     * (overridden/implemented/overriding members) share the reference set.
     */
    function references(relPath, line, col) {
        const at = posOf(relPath, line, col);
        if (!at) return null;
        const groups = ls.findReferences(at.file, at.pos) ?? [];
        const refs = [];
        for (const g of groups) {
            for (const r of g.references) {
                if (r.isDefinition || !inRepo(r.fileName)) continue;
                const sf = program.getSourceFile(r.fileName);
                if (!sf || inImportExport(sf, r.textSpan.start) || isDeclarationName(sf, r.textSpan.start)) continue;
                refs.push({ path: rel(r.fileName), line: lineOf(sf, r.textSpan.start), call: isCallee(sf, r.textSpan.start), fn: enclosing(sf, r.textSpan.start) });
            }
        }
        return { groups: groups.length, refs };
    }

    /**
     * Direct and transitive callers up to `depth` levels: [{path, name, start, end, level}].
     * `keep(item)` limits the walk: only kept callers are listed and followed further up.
     */
    function incomingCalls(relPath, line, col, depth = 2, keep = () => true) {
        const at = posOf(relPath, line, col);
        if (!at) return [];
        const out = new Map();
        let frontier = [{ file: at.file, pos: at.pos }];
        for (let level = 1; level <= depth; level++) {
            const next = [];
            for (const f of frontier) {
                let calls = [];
                try { calls = ls.provideCallHierarchyIncomingCalls(f.file, f.pos) ?? []; } catch { calls = []; }
                for (const c of calls) {
                    const it = c.from;
                    if (!inRepo(it.file)) continue;
                    const sf = program.getSourceFile(it.file);
                    if (!sf) continue;
                    const key = `${rel(it.file)}:${it.selectionSpan.start}`;
                    if (out.has(key)) continue;
                    const start = lineOf(sf, it.span.start), end = lineOf(sf, it.span.start + it.span.length);
                    // a reference that is not in call position (`isFunction(x.m)`) makes no call
                    const call = (c.fromSpans ?? []).some(sp => isCallee(sf, sp.start));
                    const item = { path: rel(it.file), name: (it.containerName ? it.containerName + '.' : '') + it.name, kind: it.kind, start, end, level, call };
                    if (!keep(item)) continue;
                    out.set(key, item);
                    if (call && it.kind !== 'script' && it.kind !== 'module') next.push({ file: it.file, pos: it.selectionSpan.start });
                }
            }
            frontier = next;
        }
        return [...out.values()];
    }

    /** Classes implementing the interface/abstract class declared at (relPath, line, col). */
    function implementations(relPath, line, col) {
        const at = posOf(relPath, line, col);
        if (!at) return [];
        const impls = ls.getImplementationAtPosition(at.file, at.pos) ?? [];
        const out = [];
        for (const i of impls) {
            if (!inRepo(i.fileName)) continue;
            const sf = program.getSourceFile(i.fileName);
            if (!sf) continue;
            // only class declarations count: an implementation location can also be an object
            // literal or a value typed with the interface inside some unrelated class
            const tok = ts.getTokenAtPosition(sf, i.textSpan.start);
            const n = tok?.parent;
            if (!n || !ts.isClassLike(n) || n.name !== tok) continue;
            out.push({ path: rel(i.fileName), name: n.name.text, start: lineOf(sf, n.getStart(sf)), end: lineOf(sf, n.getEnd()) });
        }
        return out;
    }

    return { ts, ls, program, references, incomingCalls, implementations };
}
