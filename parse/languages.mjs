/**
 * @file parse/languages.mjs
 * @description Language registry: Tree-sitter grammar loading, LANGUAGE_MAP,
 *              EXTENSIONS, and getParserForFile. Grammar packages are NOT bundled
 *              dependencies of graph-indexer (they were pulled via npm's
 *              `optionalDependencies`, which installs eagerly regardless of the
 *              name — that shipped all 16 grammars, ~250 MB, to every install even
 *              when a repo only uses one or two languages). Instead, `GRAMMAR_PACKAGES`
 *              is the single-sourced registry of what each language needs, and
 *              `ensureLanguagesReady()` resolves each package: ambient node_modules
 *              first (covers this repo's own devDependencies, or a project that
 *              added a grammar directly), then a scoped `.graph-indexer/node_modules`
 *              install dir (works for ANY project — Node or not, npx-run or not,
 *              since it's keyed off `--repo`, not ambient resolution), auto-
 *              installing missing packages there on first use.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import Parser from 'tree-sitter';
import { dataDir } from '../layout.mjs';

export const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

// ─── Grammar registry (single source of truth for versions) ───────────────────
// Keyed by the same language keys used by init.mjs's LANGUAGES list and
// `.graph-indexer.json`'s `languages` array. 'css' covers two packages (CSS and
// SCSS share one user-facing "CSS / SCSS" selection).
export const GRAMMAR_PACKAGES = {
    typescript: [{ pkg: 'tree-sitter-typescript', version: '0.21.2' }],
    javascript: [{ pkg: 'tree-sitter-javascript', version: '0.21.4' }],
    css: [
        { pkg: 'tree-sitter-css', version: '0.21.1' },
        { pkg: 'tree-sitter-scss', version: '1.0.0' },
    ],
    python: [{ pkg: 'tree-sitter-python', version: '0.21.0' }],
    rust: [{ pkg: 'tree-sitter-rust', version: '0.21.0' }],
    go: [{ pkg: 'tree-sitter-go', version: '0.21.0' }],
    php: [{ pkg: 'tree-sitter-php', version: '0.23.1' }],
    java: [{ pkg: 'tree-sitter-java', version: '0.21.0' }],
    kotlin: [{ pkg: 'tree-sitter-kotlin', version: '0.3.8' }],
    csharp: [{ pkg: 'tree-sitter-c-sharp', version: '0.21.3' }],
    ruby: [{ pkg: 'tree-sitter-ruby', version: '0.23.1' }],
    c: [{ pkg: 'tree-sitter-c', version: '0.21.4' }],
    bash: [{ pkg: 'tree-sitter-bash', version: '0.23.3' }],
    swift: [{ pkg: 'tree-sitter-swift', version: '0.5.0' }],
};

function _loadProjectConfig(projectRoot) {
    const configPath = path.join(projectRoot || process.env.MCP_PROJECT_ROOT || process.cwd(), '.graph-indexer.json');
    try {
        if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { /* ignore */ }
    return null;
}

// ─── Package resolution ────────────────────────────────────────────────────────

/** Ambient resolution: relative to THIS module's own location (covers devDependencies
 *  in this repo's checkout, or a grammar a project installed directly). */
async function _tryAmbient(pkg) {
    try { return (await import(pkg)).default; }
    catch { return null; }
}

/** Resolve `pkg` from a scoped install dir (its own node_modules), without relying
 *  on ambient ancestor-directory resolution — required for the npx/global-install
 *  case, where graph-indexer's own location shares no node_modules ancestry with
 *  the target `--repo`. */
async function _importFrom(pkg, dir) {
    try {
        const req = createRequire(path.join(dir, '__grammar_resolve__.js'));
        const resolved = req.resolve(pkg);
        return (await import(pathToFileURL(resolved).href)).default;
    } catch { return null; }
}

// A platform-incompatible grammar (e.g. no Xcode toolchain for a native binding)
// would otherwise re-attempt its slow, doomed build on every single `idx-index`
// run. Once a spec fails, it's remembered here so later runs skip straight to the
// "not installed — skipped" warning instead of re-running node-gyp. Delete this
// file (or the whole node_modules dir) to retry after fixing the toolchain.
function _failedCachePath(dir) { return path.join(dir, '.install-failed.json'); }
function _readFailedCache(dir) {
    try { return new Set(JSON.parse(fs.readFileSync(_failedCachePath(dir), 'utf-8'))); }
    catch { return new Set(); }
}
function _writeFailedCache(dir, failedSet) {
    try { fs.writeFileSync(_failedCachePath(dir), JSON.stringify([...failedSet])); } catch { /* best effort */ }
}

// Installed ONE package per `npm install` call — not batched. A single native
// build failure (e.g. no Xcode toolchain for a grammar with a compiled binding)
// must only skip THAT language, not roll back the whole batch: npm treats a
// multi-spec `install` as one transaction, so one failing package would otherwise
// take every other requested language down with it (this is exactly the
// per-package graceful-degradation `optionalDependencies` used to give us for
// free). Returns the subset of `specs` that failed (including previously-known
// failures, which are skipped without a retry).
function _installGrammars(dir, specs, log) {
    fs.mkdirSync(dir, { recursive: true });
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) fs.writeFileSync(pkgPath, JSON.stringify({ name: 'graph-indexer-grammars', private: true }) + '\n');
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const knownBad = _readFailedCache(dir);
    const failed = [];
    let knownBadChanged = false;
    for (const spec of specs) {
        if (knownBad.has(spec)) {
            log(`[graph-indexer] WARNING: ${spec} previously failed to install — skipping retry (delete ${path.relative(process.cwd(), dir) || dir}/.install-failed.json to retry)`);
            failed.push(spec);
            continue;
        }
        log(`[graph-indexer] installing ${spec} (first use only, cached in ${path.relative(process.cwd(), dir) || dir}/node_modules)…`);
        const res = spawnSync(npmBin, ['install', '--no-audit', '--no-fund', '--no-package-lock', spec], { cwd: dir, stdio: 'inherit' });
        if (res.status !== 0) {
            log(`[graph-indexer] WARNING: ${spec} failed to install (exit ${res.status}) — this platform may not support it; skipping`);
            failed.push(spec);
            knownBad.add(spec);
            knownBadChanged = true;
        }
    }
    if (knownBadChanged) _writeFailedCache(dir, knownBad);
    return failed;
}

// ─── Lazy, memoized language loading ───────────────────────────────────────────
// LANGUAGE_MAP/EXTENSIONS are mutated IN PLACE (not reassigned) so every consumer
// that imported these bindings sees the same populated object/set once
// ensureLanguagesReady() resolves — no need to re-import or re-bind anything.
export const LANGUAGE_MAP = {};
export const EXTENSIONS = new Set();

let _readyPromise = null;

function _applyLanguageMap(modules) {
    const primary = (key) => modules[key]?.[0]?.mod || null;
    const byPkg = (key, pkg) => modules[key]?.find(m => m.pkg === pkg)?.mod || null;

    const TypeScript = primary('typescript');
    const JavaScript = primary('javascript');
    const CSS = byPkg('css', 'tree-sitter-css');
    const SCSS = byPkg('css', 'tree-sitter-scss');
    const Python = primary('python');
    const Rust = primary('rust');
    const Go = primary('go');
    const PHP = primary('php');
    const Java = primary('java');
    const Kotlin = primary('kotlin');
    const CSharp = primary('csharp');
    const Ruby = primary('ruby');
    const C = primary('c');
    const Bash = primary('bash');
    const Swift = primary('swift');

    const map = {
        ...(TypeScript ? { '.ts': TypeScript.typescript, '.tsx': TypeScript.tsx } : {}),
        ...(JavaScript ? { '.js': JavaScript, '.jsx': JavaScript, '.mjs': JavaScript, '.cjs': JavaScript } : {}),
        ...(CSS ? { '.css': CSS } : {}),
        ...(SCSS ? { '.scss': SCSS } : (CSS ? { '.scss': CSS } : {})),
        ...(Python ? { '.py': Python } : {}),
        ...(Rust ? { '.rs': Rust } : {}),
        ...(Go ? { '.go': Go } : {}),
        ...(PHP ? { '.php': PHP.php } : {}),
        ...(Java ? { '.java': Java } : {}),
        ...(Kotlin ? { '.kt': Kotlin, '.kts': Kotlin } : {}),
        ...(CSharp ? { '.cs': CSharp } : {}),
        ...(Ruby ? { '.rb': Ruby } : {}),
        ...(C ? { '.c': C, '.h': C } : {}),
        // Shebang-only extensionless scripts are not keyed.
        ...(Bash ? { '.sh': Bash, '.bash': Bash } : {}),
        ...(Swift ? { '.swift': Swift } : {}),
    };
    for (const k of Object.keys(LANGUAGE_MAP)) delete LANGUAGE_MAP[k];
    Object.assign(LANGUAGE_MAP, map);
    EXTENSIONS.clear();
    for (const k of Object.keys(map)) EXTENSIONS.add(k);
}

async function _doLoadLanguages({ projectRoot, enabledLangs, autoInstall, log }) {
    const grammarsRoot = dataDir(projectRoot); // packages land in <grammarsRoot>/node_modules
    const keys = enabledLangs && enabledLangs.length ? enabledLangs : Object.keys(GRAMMAR_PACKAGES);

    const modules = {};
    let missing = [];
    for (const key of keys) {
        const specs = GRAMMAR_PACKAGES[key];
        if (!specs) continue;
        modules[key] = [];
        for (const { pkg, version } of specs) {
            const mod = (await _tryAmbient(pkg)) || (await _importFrom(pkg, grammarsRoot));
            if (mod) modules[key].push({ pkg, mod });
            else missing.push({ key, pkg, version });
        }
    }

    if (missing.length && autoInstall) {
        const specs = [...new Set(missing.map(m => `${m.pkg}@${m.version}`))];
        const failedSpecs = new Set(_installGrammars(grammarsRoot, specs, log));
        const stillMissing = [];
        for (const m of missing) {
            if (failedSpecs.has(`${m.pkg}@${m.version}`)) { stillMissing.push(m); continue; }
            const mod = await _importFrom(m.pkg, grammarsRoot);
            if (mod) modules[m.key].push({ pkg: m.pkg, mod });
            else stillMissing.push(m);
        }
        missing = stillMissing;
    }

    for (const m of missing) {
        log(`[graph-indexer] WARNING: ${m.pkg} not installed — ${m.key} files will be skipped`);
    }

    _applyLanguageMap(modules);
    return { missing };
}

/**
 * Resolve (and, unless `autoInstall` is false, install) every requested language's
 * grammar, then populate LANGUAGE_MAP/EXTENSIONS. Idempotent + memoized per process
 * — the first call's options win; call this once, early, before any getParserForFile.
 * `enabledLangs` defaults to `.graph-indexer.json`'s `languages` field (null = all 14).
 */
export function ensureLanguagesReady({
    projectRoot = process.env.MCP_PROJECT_ROOT || process.cwd(),
    enabledLangs = _loadProjectConfig(projectRoot)?.languages ?? null,
    autoInstall = true,
    log = (msg) => process.stderr.write(msg + '\n'),
} = {}) {
    if (!_readyPromise) _readyPromise = _doLoadLanguages({ projectRoot, enabledLangs, autoInstall, log });
    return _readyPromise;
}

/** Test-only: forces the next ensureLanguagesReady() call to reload from scratch. */
export function _resetLanguagesReady() { _readyPromise = null; }

let _warnedNotReady = false;
export function getParserForFile(ext) {
    if (!_readyPromise && !_warnedNotReady) {
        _warnedNotReady = true;
        process.stderr.write('[graph-indexer] WARNING: getParserForFile() called before ensureLanguagesReady() — no grammars loaded\n');
    }
    const language = LANGUAGE_MAP[ext];
    if (!language) return null;
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
}
