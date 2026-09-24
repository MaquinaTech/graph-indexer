/**
 * Module resolution: turns an import's source string into repository files (or a package
 * directory). Everything is computed from the file list plus a few manifest files
 * (package.json workspaces, tsconfig paths, go.mod) — no build, no network.
 */
import fs from 'node:fs';
import path from 'node:path';

const ECMA_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

function readJson(p) {
    try {
        const text = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
        return JSON.parse(text);
    } catch { return null; }
}

export class ModuleResolver {
    constructor(root, filePaths) {
        this.root = root;
        this.setFiles(filePaths);
    }

    setFiles(filePaths) {
        this.files = new Set(filePaths);
        this.bySuffix = null; // lazy
        this.dirs = new Map(); // dir -> [paths]
        for (const f of filePaths) {
            const d = path.posix.dirname(f);
            (this.dirs.get(d) ?? this.dirs.set(d, []).get(d)).push(f);
        }
        this.#loadManifests();
    }

    addFile(f) {
        if (this.files.has(f)) return;
        this.files.add(f);
        const d = path.posix.dirname(f);
        (this.dirs.get(d) ?? this.dirs.set(d, []).get(d)).push(f);
        this.bySuffix = null;
    }

    removeFile(f) {
        if (!this.files.delete(f)) return;
        const d = path.posix.dirname(f);
        const list = this.dirs.get(d);
        if (list) { const i = list.indexOf(f); if (i >= 0) list.splice(i, 1); }
        this.bySuffix = null;
    }

    #loadManifests() {
        // JS/TS workspace packages: package name -> directory
        this.packages = new Map();
        const pkgJsons = [...this.files].length ? this.#findManifests('package.json') : [];
        for (const rel of pkgJsons) {
            const j = readJson(path.join(this.root, rel));
            if (j?.name) this.packages.set(j.name, { dir: path.posix.dirname(rel), json: j });
        }
        // tsconfig paths and baseUrl, per project: a file resolves through the nearest tsconfig.json
        // above it (in a monorepo each package maps its own aliases, often the same `@/*` to a
        // different directory), then through the root's
        this.tsScopes = new Map();
        const rootCfg = fs.existsSync(path.join(this.root, 'tsconfig.json')) ? 'tsconfig.json' : 'tsconfig.base.json';
        const rootScope = this.#tsScope(rootCfg);
        if (rootScope) this.tsScopes.set('.', rootScope);
        for (const rel of this.#findManifests('tsconfig.json')) {
            const dir = path.posix.dirname(rel);
            if (dir === '.') continue;
            const scope = this.#tsScope(rel);
            if (scope) this.tsScopes.set(dir, scope);
        }
        // Go module path
        this.goModules = [];
        for (const rel of this.#findManifests('go.mod')) {
            try {
                const m = /^module\s+(\S+)/m.exec(fs.readFileSync(path.join(this.root, rel), 'utf8'));
                if (m) this.goModules.push({ module: m[1], dir: path.posix.dirname(rel) });
            } catch { /* unreadable */ }
        }
        this.goModules.sort((a, b) => b.module.length - a.module.length);
    }

    /** compilerOptions of a tsconfig file, following relative `extends` (a child's paths replace its parent's). */
    #tsOptions(rel, depth = 0) {
        const j = readJson(path.join(this.root, rel));
        if (!j || depth > 5) return null;
        const dir = path.posix.dirname(rel);
        let out = { paths: null, pathsDir: null, baseUrl: null };
        for (const ext of [j.extends ?? []].flat()) {
            if (typeof ext !== 'string' || !ext.startsWith('.')) continue;
            const parent = this.#tsOptions(path.posix.normalize(path.posix.join(dir, ext.endsWith('.json') ? ext : ext + '.json')), depth + 1);
            if (parent) out = { paths: parent.paths ?? out.paths, pathsDir: parent.paths ? parent.pathsDir : out.pathsDir, baseUrl: parent.baseUrl ?? out.baseUrl };
        }
        const co = j.compilerOptions ?? {};
        if (co.baseUrl != null) out.baseUrl = path.posix.normalize(path.posix.join(dir, co.baseUrl));
        if (co.paths) { out.paths = co.paths; out.pathsDir = dir; }
        return out;
    }

    /** The aliases a tsconfig (or, when it has none, the app/lib configs next to it) declares. */
    #tsScope(rel) {
        let o = this.#tsOptions(rel);
        const dir = path.posix.dirname(rel);
        if (o && !o.paths && !o.baseUrl) {
            for (const alt of ['tsconfig.app.json', 'tsconfig.lib.json', 'tsconfig.build.json']) {
                const a = this.#tsOptions(dir === '.' ? alt : `${dir}/${alt}`);
                if (a?.paths || a?.baseUrl) { o = a; break; }
            }
        }
        if (!o || (!o.paths && !o.baseUrl)) return null;
        // targets are relative to baseUrl, or to the config that declares them when there is none
        const base = o.baseUrl ?? o.pathsDir;
        const paths = Object.entries(o.paths ?? {}).map(([pat, targets]) => ({ pat, targets: [targets].flat().map(t => path.posix.normalize(path.posix.join(base, t))) }));
        return { paths, baseUrl: o.baseUrl };
    }

    #tsScopesFor(fromDir) {
        const out = [];
        for (let d = fromDir; ; d = path.posix.dirname(d)) {
            const s = this.tsScopes.get(d);
            if (s && d !== '.') { out.push(s); break; }
            if (d === '.' || d === '/' || !d) break;
        }
        const root = this.tsScopes.get('.');
        if (root) out.push(root);
        return out;
    }

    #findManifests(name) {
        // manifests are not source files, so look for them next to source directories (bounded)
        const out = [];
        const seen = new Set();
        const consider = (dir) => {
            if (seen.has(dir)) return; seen.add(dir);
            const rel = dir === '.' ? name : `${dir}/${name}`;
            if (fs.existsSync(path.join(this.root, rel))) out.push(rel);
        };
        consider('.');
        for (const d of this.dirs.keys()) {
            let cur = d;
            for (let i = 0; i < 6 && cur && cur !== '.'; i++) {
                if (/(^|\/)node_modules(\/|$)/.test(cur)) break;
                consider(cur);
                cur = path.posix.dirname(cur);
            }
        }
        return out;
    }

    #suffixIndex() {
        if (!this.bySuffix) {
            this.bySuffix = new Map();
            for (const f of this.files) {
                const parts = f.split('/');
                for (let i = Math.max(0, parts.length - 6); i < parts.length; i++) {
                    const suf = parts.slice(i).join('/');
                    (this.bySuffix.get(suf) ?? this.bySuffix.set(suf, []).get(suf)).push(f);
                }
            }
        }
        return this.bySuffix;
    }

    #ecmaFile(base) {
        if (this.files.has(base)) return base;
        const noJs = base.replace(/\.(m|c)?js$/, '');
        for (const ext of ECMA_EXTS) if (this.files.has(noJs + ext)) return noJs + ext;
        for (const ext of ECMA_EXTS) if (this.files.has(`${noJs}/index${ext}`)) return `${noJs}/index${ext}`;
        return null;
    }

    /**
     * Resolve an import from `fromFile`.
     * @returns {{ file?: string, dir?: string } | null}  null → external dependency
     */
    resolve(lang, fromFile, source) {
        if (!source) return null;
        const fromDir = path.posix.dirname(fromFile);
        switch (lang) {
            case 'javascript': case 'typescript': case 'tsx': return this.#resolveEcma(fromDir, source);
            case 'python': return this.#resolvePython(fromDir, source);
            case 'go': return this.#resolveGo(source);
            case 'c': case 'cpp': return this.#resolveInclude(fromDir, source);
            case 'ruby': case 'bash': case 'css': return this.#resolveRelativeOrSuffix(fromDir, source, lang);
            case 'rust': return this.#resolveRust(fromFile, source);
            default: return null; // package-based languages resolve through the package index
        }
    }

    #resolveEcma(fromDir, source) {
        if (source.startsWith('.')) {
            const f = this.#ecmaFile(path.posix.normalize(path.posix.join(fromDir, source)));
            return f ? { file: f } : null;
        }
        if (source.startsWith('/')) return null;
        const scopes = this.#tsScopesFor(fromDir);
        for (const { pat, targets } of scopes.flatMap(s => s.paths)) {
            const star = pat.indexOf('*');
            if (star < 0 ? pat === source : (source.startsWith(pat.slice(0, star)) && source.endsWith(pat.slice(star + 1)))) {
                const mid = star < 0 ? '' : source.slice(star, source.length - (pat.length - star - 1));
                for (const t of targets) {
                    const f = this.#ecmaFile(t.replace('*', mid));
                    if (f) return { file: f };
                }
            }
        }
        // workspace package (monorepo): '@scope/pkg' or '@scope/pkg/sub/path'
        const parts = source.split('/');
        const pkgName = source.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        const sub = source.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/');
        const pkg = this.packages.get(pkgName);
        if (pkg) {
            const base = pkg.dir === '.' ? '' : pkg.dir + '/';
            if (sub) {
                const f = this.#ecmaFile(base + sub) ?? this.#ecmaFile(base + 'src/' + sub) ?? this.#ecmaFile(base + 'lib/' + sub);
                if (f) return { file: f };
            }
            const j = pkg.json;
            const entries = [j.source, j.types, j.typings, j.module, j.main, 'index', 'src/index', 'lib/index'].filter(Boolean);
            for (const e of entries) {
                const f = this.#ecmaFile(path.posix.normalize(base + String(e).replace(/^\.\//, '')).replace(/\.d\.ts$/, '')) ?? this.#ecmaFile(path.posix.normalize(base + String(e).replace(/^\.\//, '')));
                if (f) return { file: f };
            }
        }
        for (const s of scopes) if (s.baseUrl) {
            const f = this.#ecmaFile(path.posix.normalize(path.posix.join(s.baseUrl, source)));
            if (f) return { file: f };
        }
        return null;
    }

    #resolvePython(fromDir, source) {
        let base;
        let mod = source;
        if (source.startsWith('.')) {
            const dots = /^\.+/.exec(source)[0].length;
            base = fromDir;
            for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
            mod = source.slice(dots);
            const p = mod ? path.posix.join(base, mod.replace(/\./g, '/')) : base;
            if (this.files.has(p + '.py')) return { file: p + '.py' };
            if (this.files.has(p + '/__init__.py')) return { file: p + '/__init__.py', dir: p };
            if (this.dirs.has(p)) return { dir: p };
            return null;
        }
        const rel = mod.replace(/\./g, '/');
        const idx = this.#suffixIndex();
        const cands = [...(idx.get(rel + '.py') ?? []), ...(idx.get(rel + '/__init__.py') ?? [])]
            .filter(f => f === rel + '.py' || f === rel + '/__init__.py' || f.endsWith('/' + rel + '.py') || f.endsWith('/' + rel + '/__init__.py'));
        if (cands.length) {
            cands.sort((a, b) => a.length - b.length);
            const f = cands[0];
            return f.endsWith('/__init__.py') ? { file: f, dir: path.posix.dirname(f) } : { file: f };
        }
        return null;
    }

    #resolveGo(source) {
        for (const { module, dir } of this.goModules) {
            if (source === module || source.startsWith(module + '/')) {
                const sub = source.slice(module.length).replace(/^\//, '');
                const d = path.posix.normalize(dir === '.' ? (sub || '.') : (sub ? `${dir}/${sub}` : dir));
                return this.dirs.has(d) ? { dir: d } : null;
            }
        }
        return null;
    }

    #resolveInclude(fromDir, source) {
        const direct = path.posix.normalize(path.posix.join(fromDir, source));
        if (this.files.has(direct)) return { file: direct };
        const idx = this.#suffixIndex();
        const cands = (idx.get(source) ?? []).filter(f => f === source || f.endsWith('/' + source));
        if (cands.length) {
            cands.sort((a, b) => a.length - b.length);
            return { file: cands[0] };
        }
        return null;
    }

    #resolveRelativeOrSuffix(fromDir, source, lang) {
        const exts = lang === 'ruby' ? ['', '.rb'] : lang === 'css' ? ['', '.css', '.scss'] : ['', '.sh', '.bash'];
        if (source.startsWith('.') || lang === 'bash') {
            for (const e of exts) {
                const p = path.posix.normalize(path.posix.join(fromDir, source + e));
                if (this.files.has(p)) return { file: p };
            }
        }
        const idx = this.#suffixIndex();
        for (const e of exts) {
            const s = source.replace(/^\.\//, '') + e;
            const cands = (idx.get(s) ?? []).filter(f => f === s || f.endsWith('/' + s));
            if (cands.length) { cands.sort((a, b) => a.length - b.length); return { file: cands[0] }; }
        }
        return null;
    }

    #resolveRust(fromFile, source) {
        // crate::a::b / self::a / super::a  → src/a/b.rs | src/a/b/mod.rs | src/a.rs (item b inside)
        const segs = source.split('::').filter(Boolean);
        if (!segs.length) return null;
        let baseDir;
        const crateRoot = this.#rustCrateRoot(fromFile);
        if (segs[0] === 'crate') { baseDir = crateRoot; segs.shift(); }
        else if (segs[0] === 'self') { baseDir = this.#rustModDir(fromFile); segs.shift(); }
        else if (segs[0] === 'super') { baseDir = path.posix.dirname(this.#rustModDir(fromFile)); segs.shift(); while (segs[0] === 'super') { baseDir = path.posix.dirname(baseDir); segs.shift(); } }
        else return null; // external crate
        for (let n = segs.length; n > 0; n--) {
            const p = path.posix.join(baseDir, ...segs.slice(0, n));
            if (this.files.has(p + '.rs')) return { file: p + '.rs' };
            if (this.files.has(p + '/mod.rs')) return { file: p + '/mod.rs' };
        }
        const lib = ['lib.rs', 'main.rs', 'mod.rs'].map(f => path.posix.join(baseDir, f)).find(f => this.files.has(f));
        return lib ? { file: lib } : null;
    }

    #rustCrateRoot(fromFile) {
        let d = path.posix.dirname(fromFile);
        while (d && d !== '.') {
            if (this.files.has(d + '/lib.rs') || this.files.has(d + '/main.rs')) return d;
            d = path.posix.dirname(d);
        }
        return 'src';
    }

    #rustModDir(fromFile) {
        const base = path.posix.basename(fromFile);
        const dir = path.posix.dirname(fromFile);
        return (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') ? dir : path.posix.join(dir, base.replace(/\.rs$/, ''));
    }
}
