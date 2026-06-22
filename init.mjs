#!/usr/bin/env node
/**
 * @file init.mjs
 * @description graph-indexer init CLI — a guided, idempotent project setup. It
 *              detects the stack, wires every installed IDE/agent to the MCP
 *              server (merging into existing configs, never clobbering them),
 *              assembles the layered agent prompt suite, installs npm scripts
 *              (index + daemon control), tidies generated artifacts into
 *              `.graph-indexer/`, and migrates pre-v1.4 layouts in place.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 * Copyright (c) 2026 MaquinaTech. All rights reserved.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright
 * notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { spawnSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { c, glyph, log, rule, box } from './cli-ui.mjs';
import {
    DATA_DIR_NAME, CONFIG_FILE_NAME, ensureDataDir, artifactPaths,
    migrateLegacyLayout, hasLegacyLayout,
} from './layout.mjs';
import { readPid, isAlive } from './daemon-lock.mjs';
import { ensureMlxEnv, mlxEnvReady, mlxVenvPython, mlxVenvDir } from './embedders/setup-mlx.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default MLX embed model offered in onboarding (mirrors config.mjs DEFAULTS.mlxEmbedModel).
const MLX_MODEL_DEFAULT = 'mlx-community/all-MiniLM-L6-v2-4bit';

// Curated MLX LLM models for enrichment / reranking, so the user picks from a short
// proven list instead of typing a long `mlx-community/…` id. "Other…" always escapes.
const MLX_LLM_MODELS = {
    enrichment: [
        { key: 'mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit', label: 'Qwen2.5-Coder 1.5B (4-bit)', desc: 'recommended · fast summaries' },
        { key: 'mlx-community/Qwen2.5-Coder-3B-Instruct-4bit', label: 'Qwen2.5-Coder 3B (4-bit)', desc: 'richer · a little slower' },
    ],
    reranker: [
        { key: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', label: 'Qwen2.5-Coder 7B (4-bit)', desc: 'recommended · sharpest judgment' },
        { key: 'mlx-community/Qwen2.5-Coder-14B-Instruct-4bit', label: 'Qwen2.5-Coder 14B (4-bit)', desc: 'sharper · needs ~12 GB RAM' },
    ],
};
const MLX_LLM_DEFAULTS = {
    enrichment: MLX_LLM_MODELS.enrichment[0].key,
    reranker: MLX_LLM_MODELS.reranker[0].key,
};

// ─── Subcommand dispatch ─────────────────────────────────────────────────────
// package.json maps the `graph-indexer` bin to THIS file, so `npx graph-indexer
// idx-mcp …` runs init.mjs with `idx-mcp` as argv[2] — npx resolves the package's
// same-named bin, never the `idx-mcp` bin. Delegate those tokens to the real bins
// (re-exec with inherited stdio, so a delegated MCP server talks straight over
// stdin/stdout) so `graph-indexer <subcommand> …` works everywhere. A bare `init`
// token, or none, falls through to the setup wizard below.
const SUBCOMMAND_BINS = {
    'idx-mcp': 'mcp-server.mjs',
    'idx-index': 'indexer.mjs',
    'idx-watch': 'watch-daemon.mjs',
    'idx-daemon': 'daemon-ctl.mjs',
};
if (SUBCOMMAND_BINS[process.argv[2]]) {
    const target = path.join(__dirname, SUBCOMMAND_BINS[process.argv[2]]);
    const res = spawnSync(process.execPath, [target, ...process.argv.slice(3)], { stdio: 'inherit' });
    if (res.error) { console.error(res.error.message); process.exit(1); }
    process.exit(res.status == null ? 1 : res.status);
}

// ─── CLI parsing (target repo + flags) ───────────────────────────────────────
/** Split argv into a flag set, a `--repo` value, and the first positional path. */
function parseCli(argv) {
    const flags = new Set();
    let repo = null, positional = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--repo') { repo = argv[++i] ?? null; continue; }
        if (a === 'init') continue;             // explicit "run the wizard" token
        if (a.startsWith('-')) { flags.add(a); continue; }
        if (positional == null) positional = a; // first bare token = target repo
    }
    return { flags, repo, positional };
}
const cli = parseCli(process.argv.slice(2));

const HELP = `graph-indexer — AST-precise, air-gapped code search for AI agents

Usage:
  graph-indexer [init] [path] [options]      Guided project setup (default)
  graph-indexer idx-mcp    [--repo <path>]   Start the MCP server (stdio)
  graph-indexer idx-index  [--repo <path>]   Build / refresh the index
  graph-indexer idx-daemon <start|stop|restart|status|logs> [--repo <path>]
  graph-indexer idx-watch  [--repo <path>]   Run the watch daemon in the foreground

Setup options:
  path, --repo <path>   Target repository (default: current directory)
  --yes, -y             Non-interactive: accept detected/default selections (CI)
  --non-interactive     Alias for --yes
  --all-languages       Index every supported language (implies --yes)
  --dry-run             Show the file actions without writing anything
  --help, -h            Show this help

Docs: https://github.com/MaquinaTech/graph-indexer
`;
if (cli.flags.has('--help') || cli.flags.has('-h')) { process.stdout.write(HELP); process.exit(0); }

const isDryRun = cli.flags.has('--dry-run');
const isAllLanguages = cli.flags.has('--all-languages');
// CI / scripted runs: an explicit switch — or a non-TTY stdin — both mean "no prompts".
const forceNonInteractive = isAllLanguages
    || cli.flags.has('--yes') || cli.flags.has('-y')
    || cli.flags.has('--non-interactive') || cli.flags.has('--ci');
const isInteractive = !forceNonInteractive && Boolean(process.stdin.isTTY);

const PROJECT_ROOT = path.resolve(cli.repo || cli.positional || process.cwd());
const PATHS = artifactPaths(PROJECT_ROOT);
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);

// Is graph-indexer resolvable as a local dependency of the TARGET repo? When it is
// (and a package.json exists), the npm scripts / bare bins resolve, so we wire
// `npm run mcp:start`. Otherwise — non-Node repos, or Node repos where the user only
// ran `npx graph-indexer` — we wire a self-contained `npx -p graph-indexer …`
// command (and npx-form scripts) so the server still launches.
function graphIndexerIsLocalDep(root) {
    if (fs.existsSync(path.join(root, 'node_modules', 'graph-indexer', 'package.json'))) return true;
    const pkg = readJsonSafe(path.join(root, 'package.json'));
    if (pkg) {
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        if (deps['graph-indexer']) return true;
    }
    return false;
}
const localDep = graphIndexerIsLocalDep(PROJECT_ROOT);

// Special case: setting up the graph-indexer repo on ITSELF (the maintainer
// dogfooding the tool). It is not its own dependency, so the npx path would
// otherwise fetch the PUBLISHED package from npm instead of this working tree —
// we wire the local mcp-server.mjs directly so it runs the code under edit.
const selfHost = !localDep
    && readJsonSafe(path.join(PROJECT_ROOT, 'package.json'))?.name === 'graph-indexer'
    && fs.existsSync(path.join(PROJECT_ROOT, 'mcp-server.mjs'));

const TOTAL_STEPS = 7;

// ─── Action ledger (drives the grouped end-of-run summary) ───────────────────────

const GLYPH_FOR = {
    created: glyph.ok, updated: glyph.upd, migrated: glyph.move,
    kept: glyph.keep, skipped: glyph.skip, warn: glyph.warn,
};
const ledger = { created: [], updated: [], migrated: [], kept: [], skipped: [], warn: [] };

/** Log one action live (with optional detail) and record it for the summary. */
function act(kind, label, detail) {
    log(`  ${GLYPH_FOR[kind]} ${label}${detail ? '  ' + c.dim(detail) : ''}`);
    ledger[kind].push(label);
}
/** Live-only line (e.g. the stack selection echo) — not recorded in the summary. */
function line(g, label, detail) {
    log(`  ${g} ${label}${detail ? '  ' + c.dim(detail) : ''}`);
}
function stepHeader(n, title) {
    log('\n' + c.bold(`  ${c.cyan(`[${n}/${TOTAL_STEPS}]`)} ${title}`));
}

// ─── Language Registry ────────────────────────────────────────────────────────

const LANGUAGES = [
    { key: 'typescript', label: 'TypeScript / TSX', exts: '.ts, .tsx' },
    { key: 'javascript', label: 'JavaScript', exts: '.js, .jsx, .mjs, .cjs' },
    { key: 'python', label: 'Python', exts: '.py' },
    { key: 'go', label: 'Go', exts: '.go' },
    { key: 'rust', label: 'Rust', exts: '.rs' },
    { key: 'php', label: 'PHP', exts: '.php' },
    { key: 'java', label: 'Java', exts: '.java' },
    { key: 'kotlin', label: 'Kotlin', exts: '.kt, .kts' },
    { key: 'csharp', label: 'C#', exts: '.cs' },
    { key: 'ruby', label: 'Ruby', exts: '.rb' },
    { key: 'css', label: 'CSS / SCSS', exts: '.css, .scss' },
    { key: 'c', label: 'C', exts: '.c, .h' },
    { key: 'bash', label: 'Bash / Shell', exts: '.sh, .bash' },
    { key: 'swift', label: 'Swift', exts: '.swift' },
];

// ─── Framework Registry (Layer 2 prompt add-ons) ─────────────────────────────

const FRAMEWORKS = [
    { key: 'react', label: 'React', hint: 'JSX components, hooks', langs: ['typescript', 'javascript'], prompt: 'frameworks/REACT.md' },
    { key: 'node-backend', label: 'Node.js / Express / NestJS', hint: 'routing, middleware, DI', langs: ['typescript', 'javascript'], prompt: 'frameworks/NODE_EXPRESS_NESTJS.md' },
    { key: 'python-web', label: 'FastAPI / Django', hint: 'route decorators, ORM', langs: ['python'], prompt: 'frameworks/FASTAPI_DJANGO.md' },
    { key: 'spring-boot', label: 'Spring Boot', hint: 'annotations, DI, AOP', langs: ['java', 'kotlin'], prompt: 'frameworks/SPRING_BOOT.md' },
    { key: 'rails', label: 'Ruby on Rails', hint: 'conventions, ActiveRecord', langs: ['ruby'], prompt: 'frameworks/RAILS.md' },
    { key: 'laravel-symfony', label: 'Laravel / Symfony', hint: 'facades, container, Eloquent', langs: ['php'], prompt: 'frameworks/LARAVEL_SYMFONY.md' },
    { key: 'aspnet-core', label: 'ASP.NET Core', hint: 'attribute routing, DI, EF', langs: ['csharp'], prompt: 'frameworks/ASPNET_CORE.md' },
    { key: 'android', label: 'Android (Jetpack / Compose)', hint: 'lifecycle, coroutines, DI', langs: ['kotlin'], prompt: 'frameworks/ANDROID.md' },
];

/** Language key → Layer 2 language prompt file. */
const LANGUAGE_PROMPTS = {
    typescript: 'languages/JAVASCRIPT_TYPESCRIPT.md',
    javascript: 'languages/JAVASCRIPT_TYPESCRIPT.md',
    python: 'languages/PYTHON.md',
    go: 'languages/GO.md',
    rust: 'languages/RUST.md',
    java: 'languages/JAVA.md',
    kotlin: 'languages/KOTLIN.md',
    csharp: 'languages/CSHARP.md',
    ruby: 'languages/RUBY.md',
    php: 'languages/PHP.md',
    css: 'languages/CSS_SCSS.md',
    c: 'languages/C.md',
    bash: 'languages/BASH.md',
    swift: 'languages/SWIFT.md',
};

// ─── MCP Server config blocks (self-contained when not a local dependency) ────
// Resolve mcp-server.mjs relative to this file — works whether graph-indexer is
// npm-installed (node_modules/graph-indexer/mcp-server.mjs), globally symlinked,
// or run from the dev tree. Using `node <absolute-path>` avoids the npx cache
// entirely, so stale cached versions can never shadow the currently-installed one.
const PACKAGE_MCP_SERVER = fileURLToPath(new URL('mcp-server.mjs', import.meta.url));

// Editors launched from the GUI (Dock/Finder/Spotlight) do NOT inherit the shell
// PATH, so a bare `npx`/`npm` command makes the MCP host fail with `spawn npx
// ENOENT`. We resolve the absolute binary that sits next to the `node` running
// init (true for nvm/Homebrew/fnm/volta/system installs) and write THAT as the
// command. We also bake the current PATH (prefixed with that bin dir) into the
// server env, so the server and its children — the daemon, its `git`/`node`
// subprocesses — resolve their tools too. These configs are already machine-
// specific (absolute --repo / MCP_PROJECT_ROOT), so absolute paths fit. Re-run
// init after switching Node versions to refresh them.
const NODE_BIN_DIR = path.dirname(process.execPath);
const IS_WIN = process.platform === 'win32';
function resolveNodeSibling(name) {
    const exe = IS_WIN ? `${name}.cmd` : name;
    const abs = path.join(NODE_BIN_DIR, exe);
    return fs.existsSync(abs) ? abs : name; // fall back to bare name if not a sibling
}
const NPX_BIN = resolveNodeSibling('npx');
const NPM_BIN = resolveNodeSibling('npm');
const SERVER_ENV = {
    MCP_PROJECT_ROOT: PROJECT_ROOT,
    PATH: NODE_BIN_DIR + path.delimiter + (process.env.PATH || ''),
};

// Self-host runs the working tree's own server with absolute node — already
// global-safe (absolute script + --repo), so it doubles as both forms.
const SELF_HOST_CONFIG = { command: process.execPath, args: [path.join(PROJECT_ROOT, 'mcp-server.mjs'), '--repo', PROJECT_ROOT], env: SERVER_ENV };

const SERVER_CONFIG = selfHost
    ? SELF_HOST_CONFIG
    : localDep
    ? { command: NPM_BIN, args: ['run', 'mcp:start'], env: SERVER_ENV }
    : { command: process.execPath, args: [PACKAGE_MCP_SERVER, '--repo', PROJECT_ROOT], env: SERVER_ENV };

// Global clients (Claude Desktop) launch from outside the project; same approach.
const SERVER_CONFIG_GLOBAL = selfHost
    ? SELF_HOST_CONFIG
    : localDep
    ? { command: NPM_BIN, args: ['run', '--prefix', PROJECT_ROOT, 'mcp:start'], env: SERVER_ENV }
    : { command: process.execPath, args: [PACKAGE_MCP_SERVER, '--repo', PROJECT_ROOT], env: SERVER_ENV };

// Display commands for "Next steps" — adapt to the self-host / local-dep / npx decision.
const q = (p) => (/\s/.test(p) ? `"${p}"` : p);
const CMD = selfHost
    ? {
        index: `node ${q(path.join(PROJECT_ROOT, 'indexer.mjs'))} --repo ${q(PROJECT_ROOT)}`,
        daemonStatus: `node ${q(path.join(PROJECT_ROOT, 'daemon-ctl.mjs'))} status`,
    }
    : {
        index: localDep ? 'npm run mcp:index' : `npx -y -p graph-indexer idx-index --repo ${q(PROJECT_ROOT)}`,
        daemonStatus: localDep ? 'npm run mcp:daemon:status' : `npx -y -p graph-indexer idx-daemon status --repo ${q(PROJECT_ROOT)}`,
    };

// ─── Utilities ────────────────────────────────────────────────────────────────

function writeFile(filePath, content) {
    if (isDryRun) { log(c.dim(`    [dry-run] would write ${path.relative(PROJECT_ROOT, filePath) || filePath}`)); return; }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
}

function stripJsonComments(str) {
    let result = '';
    let inString = false;
    let i = 0;
    while (i < str.length) {
        if (inString) {
            if (str[i] === '\\') { result += str[i++]; result += str[i++]; continue; }
            if (str[i] === '"') inString = false;
            result += str[i++];
        } else {
            if (str[i] === '"') { inString = true; result += str[i++]; continue; }
            if (str[i] === '/' && str[i + 1] === '/') { while (i < str.length && str[i] !== '\n') i++; continue; }
            if (str[i] === '/' && str[i + 1] === '*') {
                i += 2;
                while (i < str.length && !(str[i] === '*' && str[i + 1] === '/')) i++;
                i += 2;
                continue;
            }
            result += str[i++];
        }
    }
    return result;
}

function readJsonSafe(filePath) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(stripJsonComments(fs.readFileSync(filePath, 'utf-8')));
    } catch { /* malformed JSON — start fresh */ }
    return null;
}

function readTextSafe(filePath, maxBytes = 262144) {
    try {
        if (!fs.existsSync(filePath)) return '';
        const fd = fs.openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(Math.min(maxBytes, fs.fstatSync(fd).size));
            fs.readSync(fd, buf, 0, buf.length, 0);
            return buf.toString('utf-8');
        } finally { fs.closeSync(fd); }
    } catch { return ''; }
}

/** Structural equality for an MCP server entry (ignores key order). */
function sameServer(a, b) {
    if (!a || !b) return false;
    return a.command === b.command
        && JSON.stringify(a.args || []) === JSON.stringify(b.args || [])
        && JSON.stringify(a.env || {}) === JSON.stringify(b.env || {});
}

// ─── Stack Detection (used to pre-select menu entries) ───────────────────────

const EXT_TO_LANG = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.go': 'go', '.rs': 'rust', '.php': 'php', '.java': 'java',
    '.kt': 'kotlin', '.kts': 'kotlin', '.cs': 'csharp', '.rb': 'ruby',
    '.css': 'css', '.scss': 'css',
    '.c': 'c', '.h': 'c', '.sh': 'bash', '.bash': 'bash', '.swift': 'swift',
};

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
    'venv', '.venv', '__pycache__', '.next', '.nuxt', 'coverage', '.idea', '.vscode',
]);

/** Bounded breadth-first scan: counts source files per language, never more than ~4000 entries deep. */
function detectLanguages(root) {
    const counts = {};
    let visited = 0;
    let totalSourceFiles = 0;
    let truncated = false; // hit the scan cap → repo is large (used for the Node 22 hint)
    const queue = [{ dir: root, depth: 0 }];

    while (queue.length > 0 && visited < 4000) {
        const { dir, depth } = queue.shift();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            if (++visited >= 4000) { truncated = true; break; }
            if (entry.isDirectory()) {
                if (depth < 5 && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                    queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
                }
            } else {
                const lang = EXT_TO_LANG[path.extname(entry.name)];
                if (lang) { counts[lang] = (counts[lang] || 0) + 1; totalSourceFiles++; }
            }
        }
    }

    // ≥3 files of a language counts as "present"; tiny repos get a lower bar.
    const threshold = totalSourceFiles < 15 ? 1 : 3;
    const langs = new Set(Object.keys(counts).filter(k => counts[k] >= threshold));
    return { langs, fileCount: totalSourceFiles, truncated };
}

/** Best-effort framework detection from dependency manifests. */
function detectFrameworks(root) {
    const found = new Set();

    const pkg = readJsonSafe(path.join(root, 'package.json'));
    if (pkg) {
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        if (deps.react || deps['react-dom'] || deps.next || deps.preact) found.add('react');
        if (deps.express || deps.fastify || deps.koa || deps['@nestjs/core'] || deps['@nestjs/common']) found.add('node-backend');
    }

    const pyManifests = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg']
        .map(f => readTextSafe(path.join(root, f))).join('\n');
    if (/\b(fastapi|django)\b/i.test(pyManifests)) found.add('python-web');

    const jvmManifests = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
        'app/build.gradle', 'app/build.gradle.kts']
        .map(f => readTextSafe(path.join(root, f))).join('\n');
    if (/spring-boot|org\.springframework/i.test(jvmManifests)) found.add('spring-boot');
    if (/com\.android\.(application|library)|androidx\./i.test(jvmManifests)) found.add('android');

    if (/\brails\b/i.test(readTextSafe(path.join(root, 'Gemfile')))) found.add('rails');

    const composer = readJsonSafe(path.join(root, 'composer.json'));
    if (composer) {
        const req = { ...(composer.require || {}), ...(composer['require-dev'] || {}) };
        if (Object.keys(req).some(k => k.startsWith('laravel/') || k.startsWith('symfony/'))) found.add('laravel-symfony');
    }

    if (/Microsoft\.NET\.Sdk\.Web|Microsoft\.AspNetCore/i.test(findCsprojContent(root))) found.add('aspnet-core');

    return found;
}

/** Concatenates the first few .csproj files found in the root or one level down. */
function findCsprojContent(root) {
    const candidates = [];
    try {
        const top = fs.readdirSync(root, { withFileTypes: true });
        for (const entry of top) {
            if (entry.isFile() && entry.name.endsWith('.csproj')) candidates.push(path.join(root, entry.name));
            else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                try {
                    for (const sub of fs.readdirSync(path.join(root, entry.name))) {
                        if (sub.endsWith('.csproj')) candidates.push(path.join(root, entry.name, sub));
                    }
                } catch { /* unreadable dir — skip */ }
            }
            if (candidates.length >= 8) break;
        }
    } catch { /* unreadable root — no detection */ }
    return candidates.slice(0, 8).map(f => readTextSafe(f, 65536)).join('\n');
}

// ─── Interactive Menu Rendering Helpers ──────────────────────────────────────

const ANSI_RE = /\x1B\[[0-9;]*m/g;
/** Visible width of a string, ignoring SGR color escapes (which take no space). */
const visibleLen = (s) => s.replace(ANSI_RE, '').length;

/**
 * Clip one rendered line to the terminal width so it NEVER wraps. A wrapped line
 * occupies >1 physical row, which desyncs the `moveCursor(-lineCount)` redraw and
 * makes the menu repeat/grow on every keystroke. Color escapes are copied
 * verbatim (zero width); if we cut inside a colored span we close it with a reset
 * and mark the truncation with a dim ellipsis. One logical line ⇒ one screen row.
 */
function clipLine(str) {
    const max = Math.max(1, (process.stdout.columns || 80) - 1);
    if (visibleLen(str) <= max) return str;
    const budget = max - 1; // reserve a column for the ellipsis
    let out = '', width = 0, i = 0, sawAnsi = false;
    while (i < str.length && width < budget) {
        if (str[i] === '\x1B') {
            const m = str.slice(i).match(/^\x1B\[[0-9;]*m/);
            if (m) { out += m[0]; i += m[0].length; sawAnsi = true; continue; }
        }
        out += str[i++]; width++;
    }
    return out + (sawAnsi ? '\x1B[0m' : '') + c.dim('…');
}

// ─── Interactive Multi-Select Menu ────────────────────────────────────────────

/**
 * Renders an arrow-key multi-select. `items` need { key, label, desc }; entries
 * whose key is in `preselected` start checked. Resolves to the selected keys
 * (possibly empty — callers decide what an empty selection means).
 */
function interactiveMultiSelect({ title, items, preselected = new Set(), detected = preselected }) {
    return new Promise((resolve) => {
        const { stdin, stdout } = process;
        readline.emitKeypressEvents(stdin);
        stdin.setRawMode(true);
        stdin.resume(); // a preceding readline prompt may have left stdin paused
        stdout.write('\x1B[?25l');

        let cursorIndex = 0;
        const selected = new Set(items.map((it, i) => (preselected.has(it.key) ? i : -1)).filter(i => i >= 0));
        let hasRendered = false;
        const lineCount = items.length + 2;

        const render = () => {
            if (hasRendered) {
                readline.moveCursor(stdout, 0, -lineCount);
                readline.cursorTo(stdout, 0);
                readline.clearScreenDown(stdout);
            }
            hasRendered = true;

            stdout.write(clipLine(`  ${title} ${c.dim('(↑↓/Tab move · Space toggle · Enter confirm)')}`) + '\n\n');

            items.forEach((item, i) => {
                const isHovered = i === cursorIndex;
                const prefix = isHovered ? '❯' : ' ';
                const checkbox = selected.has(i) ? c.green('◉') : '◯';
                const detectedTag = detected.has(item.key) ? c.dim('  · detected') : '';
                const label = isHovered ? c.cyan(item.label.padEnd(28)) : item.label.padEnd(28);
                stdout.write(clipLine(`  ${c.cyan(prefix)} ${checkbox} ${label} ${item.desc}${detectedTag}`) + '\n');
            });
        };

        const cleanup = () => {
            stdin.setRawMode(false);
            stdout.write('\x1B[?25h');
            stdin.removeListener('keypress', onKeypress);
        };

        const onKeypress = (str, key) => {
            if (key.ctrl && key.name === 'c') {
                cleanup();
                stdout.write('\n');
                process.exit(130);
            }

            if (key.name === 'up' || (key.name === 'tab' && key.shift)) {
                cursorIndex = (cursorIndex - 1 + items.length) % items.length;
                render();
            } else if (key.name === 'down' || (key.name === 'tab' && !key.shift)) {
                cursorIndex = (cursorIndex + 1) % items.length;
                render();
            } else if (key.name === 'space') {
                if (selected.has(cursorIndex)) selected.delete(cursorIndex);
                else selected.add(cursorIndex);
                render();
            } else if (key.name === 'return') {
                cleanup();
                readline.moveCursor(stdout, 0, -lineCount);
                readline.cursorTo(stdout, 0);
                readline.clearScreenDown(stdout);
                resolve(Array.from(selected).sort((a, b) => a - b).map(i => items[i].key));
            }
        };

        stdin.on('keypress', onKeypress);
        render();
    });
}

// ─── Single-select menu, line prompts & Ollama model discovery ───────────────

const CUSTOM_MODEL = Symbol('custom-model'); // unique sentinel for the "Other…" choice

/**
 * Arrow-key single-select. Enter confirms the currently hovered row, and the
 * cursor starts on `selectedKey`, so pressing Enter with no movement always
 * yields the default. `items` need { key, label, desc }.
 */
function interactiveSelect({ title, items, selectedKey }) {
    return new Promise((resolve) => {
        const { stdin, stdout } = process;
        readline.emitKeypressEvents(stdin);
        if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume(); // a preceding readline prompt may have left stdin paused
        stdout.write('\x1B[?25l');

        let cursor = Math.max(0, items.findIndex(it => it.key === selectedKey));
        let hasRendered = false;
        const lineCount = items.length + 2;

        const render = () => {
            if (hasRendered) {
                readline.moveCursor(stdout, 0, -lineCount);
                readline.cursorTo(stdout, 0);
                readline.clearScreenDown(stdout);
            }
            hasRendered = true;
            stdout.write(clipLine(`  ${title} ${c.dim('(↑↓ move · Enter select)')}`) + '\n\n');
            items.forEach((item, i) => {
                const hovered = i === cursor;
                const radio = hovered ? c.green('◉') : '◯';
                const label = hovered ? c.cyan(item.label.padEnd(26)) : item.label.padEnd(26);
                stdout.write(clipLine(`  ${c.cyan(hovered ? '❯' : ' ')} ${radio} ${label} ${item.desc || ''}`) + '\n');
            });
        };

        const cleanup = () => {
            if (stdin.isTTY) stdin.setRawMode(false);
            stdout.write('\x1B[?25h');
            stdin.removeListener('keypress', onKeypress);
        };

        const onKeypress = (str, key) => {
            if (key.ctrl && key.name === 'c') { cleanup(); stdout.write('\n'); process.exit(130); }
            if (key.name === 'up' || (key.name === 'tab' && key.shift)) {
                cursor = (cursor - 1 + items.length) % items.length; render();
            } else if (key.name === 'down' || (key.name === 'tab' && !key.shift)) {
                cursor = (cursor + 1) % items.length; render();
            } else if (key.name === 'return') {
                cleanup();
                readline.moveCursor(stdout, 0, -lineCount);
                readline.cursorTo(stdout, 0);
                readline.clearScreenDown(stdout);
                resolve(items[cursor].key);
            }
        };

        stdin.on('keypress', onKeypress);
        render();
    });
}

/** One line of input via readline. Resolves the raw (untrimmed) answer. */
function promptLine(prompt) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, (ans) => { rl.close(); resolve(ans); });
    });
}

/** Free-text prompt; empty input falls back to `def`. */
async function promptText({ label, def = '', hint = '' }) {
    const tail = def ? c.dim(` [${def}]`) : '';
    const ans = await promptLine(`  ${c.cyan('?')} ${label}${tail}${hint ? ' ' + c.dim(hint) : ''}\n  ${c.cyan('›')} `);
    return ans.trim() || def;
}

/** Yes/No prompt; empty input falls back to `def`. */
async function confirm({ label, def = false }) {
    const ans = (await promptLine(`  ${c.cyan('?')} ${label} ${c.dim(def ? '[Y/n]' : '[y/N]')} `)).trim().toLowerCase();
    if (!ans) return def;
    return ans[0] === 'y';
}

/** Positive-integer prompt; empty input falls back to `def`, re-asks on garbage. */
async function promptInt({ label, def, min = 1 }) {
    for (;;) {
        const raw = await promptText({ label, def: String(def) });
        const n = parseInt(raw, 10);
        if (Number.isInteger(n) && n >= min) return n;
        log(c.yellow(`    Please enter a whole number ≥ ${min} (Enter = ${def}).`));
    }
}

/** Normalise free-form Ollama input — bare port, host:port, or full URL → URL. */
function normalizeHost(raw) {
    let v = (raw || '').trim();
    if (!v) return 'http://localhost:11434';
    if (/^\d+$/.test(v)) return `http://localhost:${v}`;          // bare port
    if (!/^https?:\/\//.test(v)) v = 'http://' + v;              // add scheme
    return v.replace('://0.0.0.0', '://localhost');
}

/** GET {host}/api/tags → array of installed model names, or null if unreachable.
 *  Deduplicates `:latest` variants — `nomic-embed-text:latest` and `nomic-embed-text`
 *  are the same model; keep only the short canonical form. */
async function listOllamaModels(host) {
    try {
        const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2500) });
        if (!res.ok) return null;
        const data = await res.json();
        const raw = (data.models || []).map(m => m.name).filter(Boolean);
        // Canonical name = strip trailing `:latest` (Ollama's implicit default tag).
        // If both `foo` and `foo:latest` appear, keep `foo` and drop the tagged form.
        const canonical = raw.map(n => n.endsWith(':latest') ? n.slice(0, -7) : n);
        return [...new Set(canonical)];
    } catch { return null; }
}

/** GET {host}/v1/models → { running, loadedModel } for mlx_lm.server. */
async function probeMlxLmServer(host, timeoutMs = 3000) {
    try {
        const res = await fetch(`${host}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return { running: false, loadedModel: null };
        const data = await res.json();
        const first = (data.data || [])[0];
        return { running: true, loadedModel: first?.id || first?.name || null };
    } catch { return { running: false, loadedModel: null }; }
}

/** True iff `import mlx_lm` succeeds under the given interpreter. */
function pythonHasMlxLm(py) {
    const r = spawnSync(py, ['-c', 'import mlx_lm'], { stdio: 'ignore', timeout: 8000 });
    return r.status === 0;
}

/** First interpreter with mlx_lm importable (shared MLX venv first), or null. */
function findMlxLmPython() {
    for (const py of [mlxVenvPython(), 'python3', 'python']) {
        if (pythonHasMlxLm(py)) return py;
    }
    return null;
}

/**
 * Install mlx-lm into the shared MLX venv (creating the venv if absent). We install
 * ONLY mlx-lm here — an LLM-only user shouldn't pull the full embeddings stack.
 * Returns { ok, py?, error? }.
 */
function installMlxLm({ log: logFn }) {
    const py = path.join(mlxVenvDir, 'bin', 'python3');
    if (!fs.existsSync(py)) {
        const base = ['python3.12', 'python3.11', 'python3.10', 'python3']
            .find(b => spawnSync(b, ['--version'], { stdio: 'ignore' }).status === 0);
        if (!base) return { ok: false, error: 'no python3 found on PATH to create the venv' };
        logFn(`creating MLX venv  (${base} -m venv embedders/venv-mlx)`);
        const mk = spawnSync(base, ['-m', 'venv', mlxVenvDir], { stdio: 'inherit' });
        if (mk.status !== 0) return { ok: false, error: 'virtualenv creation failed' };
        spawnSync(py, ['-m', 'pip', 'install', '-q', '--upgrade', 'pip'], { stdio: 'inherit' });
    }
    logFn('installing mlx-lm  (pip install mlx-lm — this may take a few minutes)');
    const pip = spawnSync(py, ['-m', 'pip', 'install', 'mlx-lm'], { stdio: 'inherit' });
    if (pip.status !== 0) return { ok: false, error: 'pip install mlx-lm failed' };
    return pythonHasMlxLm(py) ? { ok: true, py } : { ok: false, error: 'mlx-lm installed but still not importable' };
}

/** Fire one tiny completion to force the model to load/download. Best-effort. */
async function warmMlxLmModel(host, model) {
    try {
        const res = await fetch(`${host}/v1/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: 'ok', max_tokens: 1, temperature: 0 }),
            signal: AbortSignal.timeout(600000), // up to 10 min for a first-time model download
        });
        return res.ok;
    } catch { return false; }
}

/**
 * After MLX LLM provider + models are chosen: verify the path end-to-end so the
 * first index run can't fail with "generator unreachable". Warns about the
 * single-model constraint, then — if the server is down — offers to install
 * mlx-lm (into the shared venv), start the server, and warm up the model.
 */
async function checkMlxLmSetup({ mlxLmHost, enrichModel, rerankModel }) {
    const targetModel = enrichModel || rerankModel;
    if (!targetModel) return null;

    // mlx_lm.server serves exactly one model at a time — warn when both features
    // request different models so the user knows only one will actually be used.
    if (enrichModel && rerankModel && enrichModel !== rerankModel) {
        log('');
        log(`  ${glyph.warn} ${c.yellow('mlx_lm.server loads one model at a time.')}`);
        log(c.dim(`       Enrichment : ${enrichModel}`));
        log(c.dim(`       Reranker   : ${rerankModel}`));
        log(c.dim('       Both features will use whichever model the server has loaded.'));
        log(c.dim('       Tip: use the same model for both (the larger one is usually better).'));
        log('');
    }

    const probe = await probeMlxLmServer(mlxLmHost);
    if (probe.running) {
        if (probe.loadedModel && probe.loadedModel !== targetModel) {
            log('');
            log(`  ${glyph.warn} ${c.yellow('mlx_lm.server is running but has a different model loaded.')}`);
            log(c.dim(`       Loaded   : ${probe.loadedModel}`));
            log(c.dim(`       Expected : ${targetModel}`));
            log(c.dim(`       Restart it with: ${c.cyan(`mlx_lm.server --model ${targetModel}`)}`));
            log('');
        } else {
            line(glyph.ok, 'mlx_lm.server', `running${probe.loadedModel ? ` · ${probe.loadedModel}` : ''} at ${mlxLmHost}`);
        }
        return true;
    }

    // Server not running — offer to provision and start it end-to-end.
    log('');
    log(`  ${glyph.warn} ${c.yellow(`mlx_lm.server is not reachable at ${mlxLmHost}.`)}`);
    log(c.dim('       It must be running for MLX enrichment / reranking to work.'));

    let mlxPy = findMlxLmPython();
    if (!mlxPy) {
        log(c.dim('       mlx-lm is not installed yet.'));
        if (await confirm({ label: 'Install mlx-lm into embedders/venv-mlx now?', def: true })) {
            const res = installMlxLm({ log: (s) => log(c.dim('       ' + s)) });
            if (res.ok) { mlxPy = res.py; line(glyph.ok, 'mlx-lm', 'installed (embedders/venv-mlx)'); }
            else line(glyph.warn, 'mlx-lm', `install failed: ${res.error}`);
        }
    }

    const port = mlxLmHost.match(/:(\d+)/)?.[1] || '8080';
    if (!mlxPy) {
        log(c.dim('       Install it, then start the server manually before indexing:'));
        log(c.dim(`         ${c.cyan('pip install mlx-lm')}`));
        log(c.dim(`         ${c.cyan(`mlx_lm.server --model ${targetModel} --port ${port}`)}`));
        log('');
        return false;
    }

    if (!await confirm({ label: 'Start mlx_lm.server now?  (runs in the background)', def: true })) {
        line(glyph.skip, 'mlx_lm.server', 'start it before indexing');
        log(c.dim(`       ${c.cyan(`${mlxPy} -m mlx_lm.server --model ${targetModel} --port ${port}`)}`));
        return false;
    }

    const child = spawn(mlxPy, ['-m', 'mlx_lm.server', '--model', targetModel, '--port', port], {
        detached: true, stdio: 'ignore',
    });
    child.unref();
    log(c.dim(`       started (PID ${child.pid}) — stop later with ${c.cyan(`kill ${child.pid}`)}`));
    log(c.dim('       waiting for the server to accept connections…'));

    let ready = false;
    for (let i = 0; i < 12 && !ready; i++) {
        await new Promise(r => setTimeout(r, 5000));
        if ((await probeMlxLmServer(mlxLmHost)).running) { ready = true; break; }
        if (i < 11) log(c.dim(`       still starting… (${(i + 1) * 5}s)`));
    }

    if (!ready) {
        log(`  ${glyph.warn} ${c.yellow('Server did not respond within 60 s — it may still be starting.')}`);
        log(c.dim(`       Check: ${c.cyan(`curl ${mlxLmHost}/v1/models`)}`));
        return false;
    }
    line(glyph.ok, 'mlx_lm.server', `running at ${mlxLmHost}`);

    // Warm up so the (potentially large) model is downloaded/loaded before indexing,
    // turning a slow, failure-prone first index into a fast one. Opt-in — the download
    // can take minutes, and the first index run would otherwise trigger it anyway.
    if (await confirm({ label: `Pre-load ${targetModel} now?  (downloads weights — avoids a slow first index)`, def: true })) {
        log(c.dim('       loading the model (first run downloads weights, please wait)…'));
        if (await warmMlxLmModel(mlxLmHost, targetModel)) line(glyph.ok, 'Model', `${targetModel} loaded and ready`);
        else log(`  ${glyph.warn} ${c.yellow('Warm-up did not finish — the first index run will complete the download.')}`);
    }
    return true;
}

/**
 * Pick a model. With Ollama reachable: an arrow-select over the installed models
 * (the default is always listed and pre-highlighted) plus an "Other…" escape
 * hatch for a name to pull later. Offline: a plain text prompt. Either way,
 * Enter/empty yields `def`.
 */
async function selectModel({ purpose, def, models }) {
    if (models && models.length) {
        const names = models.includes(def) ? models.slice() : [def, ...models];
        const items = names.map(n => ({
            key: n, label: n,
            desc: models.includes(n) ? c.dim('installed') : c.yellow('not installed — pulled on first use'),
        }));
        items.push({ key: CUSTOM_MODEL, label: 'Other (type a name)…', desc: '' });
        const choice = await interactiveSelect({ title: `Model for ${purpose}`, items, selectedKey: def });
        if (choice !== CUSTOM_MODEL) return choice;
        return await promptText({ label: `${purpose} model`, def });
    }
    return await promptText({ label: `${purpose} model`, def, hint: '· Ollama offline — used once pulled' });
}

/**
 * Pick the MLX embedding model. Offers the proven MiniLM 4-bit default plus an
 * "Other…" escape hatch for any mlx_embeddings-compatible model id. The chosen id is
 * passed to the Python server at spawn time and stamped into the embed-meta sidecar.
 */
async function selectMlxModel(def) {
    const items = [
        { key: MLX_MODEL_DEFAULT, label: 'all-MiniLM-L6-v2 (4-bit)', desc: c.dim('recommended · 384-dim · fastest, proven') },
        { key: CUSTOM_MODEL, label: 'Other (type a model id)…', desc: c.dim('any mlx_embeddings-compatible model') },
    ];
    const choice = await interactiveSelect({ title: 'MLX embedding model', items, selectedKey: def });
    if (choice !== CUSTOM_MODEL) return choice;
    return await promptText({ label: 'MLX model id', def, hint: '· e.g. an mlx-community/* sentence model' });
}

/**
 * Pick an MLX LLM model for enrichment / reranking from a curated list (so the user
 * isn't forced to type a long id), plus an "Other…" escape for any instruct model.
 */
async function selectMlxLlmModel({ purpose, def }) {
    const presets = MLX_LLM_MODELS[purpose] || [];
    const items = presets.map(m => ({ key: m.key, label: m.label, desc: c.dim(m.desc) }));
    items.push({ key: CUSTOM_MODEL, label: 'Other (type a model id)…', desc: c.dim('any mlx-community/* instruct model') });
    const selectedKey = presets.some(m => m.key === def) ? def : presets[0]?.key;
    const choice = await interactiveSelect({ title: `MLX model for ${purpose}`, items, selectedKey });
    if (choice !== CUSTOM_MODEL) return choice;
    return await promptText({ label: `${purpose} model id`, def, hint: '· model name as loaded in mlx_lm.server' });
}

// ─── Stack config persistence (.graph-indexer/config.json) ───────────────────

function saveStackConfig({ languages, frameworks, agents, engine, interactive }) {
    if (isDryRun) { log(c.dim(`    [dry-run] would write ${DATA_DIR_NAME}/${CONFIG_FILE_NAME}`)); return 'skipped'; }
    ensureDataDir(PROJECT_ROOT);
    const existing = readJsonSafe(PATHS.configPath) || {};
    const before = JSON.stringify(existing);

    if (interactive) {
            if (languages) existing.languages = languages; else delete existing.languages;
        if (frameworks && frameworks.length) existing.frameworks = frameworks; else delete existing.frameworks;
        // Always persist the explicit agent choice (an empty array means "none").
        if (agents) existing.agents = agents; else delete existing.agents;
    } else {
        if (languages && !existing.languages) existing.languages = languages;
        if (frameworks && frameworks.length && !existing.frameworks) existing.frameworks = frameworks;
        if (agents && !existing.agents) existing.agents = agents;
    }

    // Merge nested objects so power-user knobs we didn't prompt for (coreRatio,
    // topM, poolSize, …) survive a re-run.
    if (engine) {
        existing.storage = engine.storage;
        existing.embeddings = engine.embeddings;
        if (engine.embedProvider) existing.embedProvider = engine.embedProvider;
        existing.ollamaHost = engine.ollamaHost;
        if (engine.llmProvider) existing.llmProvider = engine.llmProvider;
        if (engine.mlxLmHost) existing.mlxLmHost = engine.mlxLmHost;
        existing.embedModel = engine.embedModel;
        if (engine.localEmbedModel) existing.localEmbedModel = engine.localEmbedModel;
        if (engine.mlxEmbedModel) existing.mlxEmbedModel = engine.mlxEmbedModel;
        existing.enrichment = { ...(existing.enrichment || {}), ...engine.enrichment };
        existing.rerank = { ...(existing.rerank || {}), ...engine.rerank };
    }

    const after = JSON.stringify(existing);
    if (after === before && fs.existsSync(PATHS.configPath)) return 'kept';
    const action = fs.existsSync(PATHS.configPath) ? 'updated' : 'created';
    fs.writeFileSync(PATHS.configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    return action;
}

// ─── IDE Detectors & Configurators (merge-safe: never clobber other servers) ──

/**
 * Insert/refresh only the `graph-indexer` entry inside an MCP config file,
 * preserving every other server and key the user already has. Returns the action
 * taken: 'created' | 'updated' | 'kept'.
 */
function upsertMcpServer(configPath, containerKey, serverConfig) {
    const existing = readJsonSafe(configPath) || {};
    if (!existing[containerKey] || typeof existing[containerKey] !== 'object') existing[containerKey] = {};
    const current = existing[containerKey]['graph-indexer'];
    if (sameServer(current, serverConfig)) return { action: 'kept', rel: path.relative(PROJECT_ROOT, configPath) };
    const action = current ? 'updated' : 'created';
    existing[containerKey]['graph-indexer'] = serverConfig;
    writeFile(configPath, JSON.stringify(existing, null, 2) + '\n');
    return { action, rel: path.relative(PROJECT_ROOT, configPath) || configPath };
}

function configureVSCode() {
    const detected = fs.existsSync(path.join(PROJECT_ROOT, '.vscode'));
    return { ...upsertMcpServer(path.join(PROJECT_ROOT, '.vscode', 'mcp.json'), 'servers', SERVER_CONFIG), detected };
}

function configureCursor() {
    const detected = fs.existsSync(path.join(PROJECT_ROOT, '.cursor'));
    return { ...upsertMcpServer(path.join(PROJECT_ROOT, '.cursor', 'mcp.json'), 'mcpServers', SERVER_CONFIG), detected };
}

/** Per-platform Claude Desktop config path (Windows / macOS / Linux+XDG). */
function claudeDesktopConfigPath() {
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
            'Claude', 'claude_desktop_config.json');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }
    // Linux & other XDG platforms: ~/.config/Claude (honouring $XDG_CONFIG_HOME).
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(xdg, 'Claude', 'claude_desktop_config.json');
}

function configureClaudeDesktop() {
    const configPath = claudeDesktopConfigPath();
    if (!fs.existsSync(path.dirname(configPath))) return false; // Claude Desktop not installed
    const res = upsertMcpServer(configPath, 'mcpServers', SERVER_CONFIG_GLOBAL);
    return { ...res, rel: 'claude_desktop_config.json', detected: true };
}

function configureClaudeCode() {
    // Project-scoped MCP servers for Claude Code live in `.mcp.json` at the repo
    // root — NOT `.claude/settings.json` (that file holds settings/permissions and
    // is not read as an MCP server source). A .claude dir or CLAUDE.md is only a
    // "detected" hint; the write target is always .mcp.json.
    const detected = fs.existsSync(path.join(PROJECT_ROOT, '.claude'))
        || fs.existsSync(path.join(PROJECT_ROOT, 'CLAUDE.md'))
        || fs.existsSync(path.join(PROJECT_ROOT, '.mcp.json'));
    const mcpJsonPath = path.join(PROJECT_ROOT, '.mcp.json');
    // Honour whichever container key the user already has; fall back to 'mcpServers'.
    const existing = readJsonSafe(mcpJsonPath) || {};
    const containerKey = existing.servers && typeof existing.servers === 'object' ? 'servers' : 'mcpServers';
    return { ...upsertMcpServer(mcpJsonPath, containerKey, SERVER_CONFIG), detected };
}

// ─── package.json scripts (index + daemon control) ───────────────────────────

// Script values graph-indexer manages. When it's a local dependency the bare bins
// resolve from node_modules/.bin; otherwise wrap them in `npx -p graph-indexer …`
// so the scripts still run in npx-only Node repos. (The MCP wiring stays
// self-contained regardless — these scripts are a convenience, not the launch path.)
const SCRIPTS_LOCAL = {
    'mcp:index': 'idx-index --repo .',
    'mcp:start': 'idx-mcp',
    'mcp:daemon:start': 'idx-daemon start',
    'mcp:daemon:stop': 'idx-daemon stop',
    'mcp:daemon:restart': 'idx-daemon restart',
    'mcp:daemon:status': 'idx-daemon status',
    'mcp:daemon:logs': 'idx-daemon logs',
};
const SCRIPTS_NPX = Object.fromEntries(
    Object.entries(SCRIPTS_LOCAL).map(([k, v]) => [k, `npx -y -p graph-indexer ${v}`]),
);
const CANON_SCRIPTS = localDep ? SCRIPTS_LOCAL : SCRIPTS_NPX;

// Values any graph-indexer init has written (either form) — safe to refresh on
// upgrade or when the local-dep decision flips. Anything else under these keys is
// a user customisation we must not touch.
const OLD_SCRIPT_VALUES = {};
for (const k of Object.keys(SCRIPTS_LOCAL)) OLD_SCRIPT_VALUES[k] = new Set([SCRIPTS_LOCAL[k], SCRIPTS_NPX[k]]);
OLD_SCRIPT_VALUES['mcp:index'].add('node indexer.mjs --repo .').add('idx-index');
OLD_SCRIPT_VALUES['mcp:start'].add('node mcp-server.mjs');

function addPackageScripts() {
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    if (!fs.existsSync(pkgPath)) return { added: 0, updated: 0, skipped: 'no package.json' };

    const pkg = readJsonSafe(pkgPath);
    if (!pkg) return { added: 0, updated: 0, skipped: 'unreadable package.json' };

    const scripts = pkg.scripts || {};
    let added = 0, updated = 0;
    for (const [k, v] of Object.entries(CANON_SCRIPTS)) {
        if (!scripts[k]) { scripts[k] = v; added++; }
        else if (scripts[k] !== v && (OLD_SCRIPT_VALUES[k]?.has(scripts[k]))) { scripts[k] = v; updated++; }
        // else: identical (no-op) or a user customisation we must not touch
    }

    if (added + updated > 0) {
        pkg.scripts = scripts;
        writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    }
    return { added, updated };
}

// ─── .gitignore (marker-delimited managed block) ─────────────────────────────

const GITIGNORE_BEGIN = '# >>> graph-indexer >>>';
const GITIGNORE_END = '# <<< graph-indexer <<<';
const GITIGNORE_BLOCK = [
    GITIGNORE_BEGIN,
    '# Generated artifacts — https://github.com/MaquinaTech/graph-indexer',
    // Ignore the dir CONTENTS (not the dir itself) so the shared stack config can
    // be re-included — git can't un-ignore a file inside a fully-ignored directory.
    `/${DATA_DIR_NAME}/*`,
    `!/${DATA_DIR_NAME}/${CONFIG_FILE_NAME}`,
    GITIGNORE_END,
].join('\n');

// Individual lines pre-v1.4 init used to append; stripped during migration so the
// single `.graph-indexer/` rule replaces them cleanly.
const OLD_GITIGNORE_LINES = new Set([
    'code-index.json', 'code-index.embeddings.bin', 'code-index.json.tmp',
    'code-index.embeddings.bin.tmp', 'code-index.db', 'code-index.db-wal',
    'code-index.db-shm', 'code-index.enrichment.json', '.idx-daemon.pid',
    '.idx-daemon.log', '.graph-indexer.json', '# graph-indexer runtime artifacts',
]);

function updateGitignore() {
    const gitignorePath = path.join(PROJECT_ROOT, '.gitignore');
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';

        let body = existing.replace(
        new RegExp(`\\n?${GITIGNORE_BEGIN}[\\s\\S]*?${GITIGNORE_END}\\n?`, 'g'), '\n'
    );
    const cleaned = body.split('\n').filter(line => !OLD_GITIGNORE_LINES.has(line.trim()));
    body = cleaned.join('\n');

    const next = body.trimEnd() + (body.trim() ? '\n\n' : '') + GITIGNORE_BLOCK + '\n';
    if (next === existing) return 'kept';
    writeFile(gitignorePath, next);
    return existing.trim() ? 'updated' : 'created';
}

// ─── Agent prompt assembly (Layer 1 + Layer 2, from prompts/) ────────────────

const PROMPTS_DIR = path.join(__dirname, 'prompts');

function readPromptLayer(relPath) {
    const p = path.join(PROMPTS_DIR, relPath);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').trim() : null;
}

/**
 * Resolves which Layer 2 files apply to the chosen stack and concatenates them
 * under the Layer 1 core. Returns { content, layers } or null if even the core
 * prompt is missing (broken install).
 */
function assembleAgentPrompt(langKeys, frameworkKeys) {
    const layerFiles = ['CORE.md'];
    const seen = new Set(layerFiles);
    for (const key of langKeys) {
        const file = LANGUAGE_PROMPTS[key];
        if (file && !seen.has(file)) { seen.add(file); layerFiles.push(file); }
    }
    for (const key of frameworkKeys) {
        const fw = FRAMEWORKS.find(f => f.key === key);
        if (fw && !seen.has(fw.prompt)) { seen.add(fw.prompt); layerFiles.push(fw.prompt); }
    }

    const parts = [];
    const layers = [];
    for (const file of layerFiles) {
        const body = readPromptLayer(file);
        if (body) {
            parts.push(body);
            layers.push(file.replace(/\.md$/, '').toLowerCase());
        }
    }
    if (parts.length === 0) return null;

    const header = [
        '<!--',
        '  GRAPH_INDEXER_PROMPT.md — generated by `npx graph-indexer init`. Do not edit:',
        '  re-run init after changing languages or frameworks to regenerate.',
        `  Layers: ${layers.join(' + ')}`,
        '  Project-specific rules (Layer 3) belong in GRAPH_INDEXER_DOMAIN.md.',
        '-->',
    ].join('\n');

    return { content: header + '\n\n' + parts.join('\n\n') + '\n', layers };
}

/** Writes the assembled Layer 1+2 prompt. Always regenerated. */
function writeAssembledPrompt(assembled) {
    const p = path.join(PROJECT_ROOT, 'GRAPH_INDEXER_PROMPT.md');
    const existed = fs.existsSync(p);
    const same = existed && readTextSafe(p) === assembled.content;
    if (same) return 'kept';
    writeFile(p, assembled.content);
    return existed ? 'updated' : 'created';
}

/** Copies the Layer 3 template once; the user owns it afterwards. */
function ensureDomainFile() {
    const p = path.join(PROJECT_ROOT, 'GRAPH_INDEXER_DOMAIN.md');
    if (fs.existsSync(p)) return false;
    const template = readPromptLayer('DOMAIN_TEMPLATE.md');
    if (!template) return false;
    writeFile(p, template + '\n');
    return true;
}

/** Adds @-imports to CLAUDE.md (created if absent); idempotent. */
function ensureClaudeMdImports() {
    const p = path.join(PROJECT_ROOT, 'CLAUDE.md');
    const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
    if (existing.includes('@GRAPH_INDEXER_PROMPT.md')) return false;

    const block = '<!-- graph-indexer agent prompt suite (added by `npx graph-indexer init`) -->\n'
        + '@GRAPH_INDEXER_PROMPT.md\n'
        + '@GRAPH_INDEXER_DOMAIN.md\n';
    const content = existing.trim().length > 0
        ? existing.trimEnd() + '\n\n' + block
        : block;
    writeFile(p, content);
    return existing.trim().length > 0 ? 'updated' : 'created';
}

const RULE_TAIL = '\n<!-- Layer 3 (project-specific rules): see GRAPH_INDEXER_DOMAIN.md at the repo root. -->\n';

// ─── Per-agent prompt writers (driven by the AGENTS registry below) ──────────
// A "rule" file is fully owned by graph-indexer: the assembled prompt is written
// verbatim, with optional YAML frontmatter to make the rule always-on where the
// agent supports it.
function writeRuleFile(spec, assembled) {
    const p = path.join(PROJECT_ROOT, ...spec.rel);
    const existed = fs.existsSync(p);
    const fm = spec.frontmatter
        ? ['---',
           'description: graph-indexer usage rules for AI agents (generated — re-run `npx graph-indexer init` to regenerate)',
           ...spec.frontmatter,
           '---', '', ''].join('\n')
        : '';
    const content = fm + assembled.content + RULE_TAIL;
    if (existed && readTextSafe(p) === content) return 'kept';
    writeFile(p, content);
    return existed ? 'updated' : 'created';
}

// ─── Shared instruction files (marker-delimited managed block) ───────────────
// Agents that read a single shared markdown file as custom instructions. The file
// is shared with the user's own instructions, so our prompt lives in a marker
// block — regenerated each run, everything around the markers left untouched.
//
// `mode` decides what goes INSIDE the block:
//   'embed'  — the full assembled prompt is inlined (the only correct option for
//              agents with no transclusion: Copilot, Junie, Windsurf — they read
//              the file literally, so an `@import` would show as plain text and the
//              rules would silently not apply. AGENTS.md is embedded too: its main
//              reader (OpenAI Codex) does not yet honour `@` imports.)
//   'import' — only `@./…` references to the canonical GRAPH_INDEXER_*.md files, so
//              there is no duplication. Used ONLY where the agent has a documented,
//              reliable import processor (Gemini CLI's Memory Import Processor).
const BLOCK_BEGIN = '<!-- >>> graph-indexer >>> -->';
const BLOCK_END = '<!-- <<< graph-indexer <<< -->';
// Gemini's import processor resolves `@./` relative to the file; both targets sit
// at the repo root next to GEMINI.md. (Claude Code's CLAUDE.md uses the bare `@`.)
const IMPORT_BODY = '@./GRAPH_INDEXER_PROMPT.md\n@./GRAPH_INDEXER_DOMAIN.md';

function writeManagedBlockFile(spec, assembled) {
    const p = path.join(PROJECT_ROOT, ...spec.rel);
    const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';

    const block = [
        BLOCK_BEGIN,
        '<!-- graph-indexer agent prompt suite — generated by `npx graph-indexer init`.',
        '     Do not edit inside these markers; re-run init to regenerate. Project-specific',
        '     rules (Layer 3) belong in GRAPH_INDEXER_DOMAIN.md at the repo root. -->',
        '',
        spec.mode === 'import' ? IMPORT_BODY : assembled.content.trim(),
        BLOCK_END,
    ].join('\n');

    // Strip any prior managed block, then re-append the fresh one (markers contain
    // no regex-special characters, so they need no escaping — same as .gitignore).
    const body = existing.replace(
        new RegExp(`\\n?${BLOCK_BEGIN}[\\s\\S]*?${BLOCK_END}\\n?`, 'g'), '\n'
    );
    const next = body.trimEnd() + (body.trim() ? '\n\n' : '') + block + '\n';
    if (next === existing) return 'kept';
    writeFile(p, next);
    return existing.trim() ? 'updated' : 'created';
}

// ─── Unified agent / IDE registry ────────────────────────────────────────────
// One row per supported coding agent, tying together its (optional) MCP-server
// wiring and its (optional) prompt-instruction file. The "Agents & IDEs" step
// lets the user multi-select from this list; the MCP-wiring and Agent-instruction
// steps then act ONLY on the chosen rows — so deselecting an agent generates
// nothing for it (no MCP entry, no prompt file). `detect()` (read-only) decides
// which rows are pre-checked on first run. `prompt.kind`: 'claude' = CLAUDE.md
// @-imports · 'rule' = owned rule file · 'shared' = managed block ('embed' inline
// or 'import' @-references where the agent has a reliable import processor).
const agentPath = (...p) => path.join(PROJECT_ROOT, ...p);
const AGENTS = [
    {
        key: 'claude-code', label: 'Claude Code', hint: 'CLAUDE.md · .mcp.json',
        detect: () => fs.existsSync(agentPath('.claude')) || fs.existsSync(agentPath('CLAUDE.md')) || fs.existsSync(agentPath('.mcp.json')),
        mcp: { name: 'Claude Code', fn: () => configureClaudeCode() },
        prompt: { kind: 'claude' },
    },
    {
        key: 'claude-desktop', label: 'Claude Desktop', hint: 'global MCP config',
        detect: () => fs.existsSync(path.dirname(claudeDesktopConfigPath())),
        mcp: { name: 'Claude Desktop', fn: () => configureClaudeDesktop() },
        prompt: null,
    },
    {
        key: 'cursor', label: 'Cursor', hint: '.cursor/rules · .cursor/mcp.json',
        detect: () => fs.existsSync(agentPath('.cursor')),
        mcp: { name: 'Cursor', fn: () => configureCursor() },
        prompt: { kind: 'rule', rel: ['.cursor', 'rules', 'graph-indexer.mdc'], label: 'always-on Cursor rule', frontmatter: ['alwaysApply: true'] },
    },
    {
        key: 'vscode-copilot', label: 'VS Code / Copilot', hint: '.vscode/mcp.json · copilot-instructions.md',
        detect: () => fs.existsSync(agentPath('.vscode')) || fs.existsSync(agentPath('.github', 'copilot-instructions.md')),
        mcp: { name: 'VS Code', fn: () => configureVSCode() },
        prompt: { kind: 'shared', rel: ['.github', 'copilot-instructions.md'], label: 'GitHub Copilot', mode: 'embed' },
    },
    {
        key: 'windsurf', label: 'Windsurf', hint: '.windsurf/rules',
        detect: () => fs.existsSync(agentPath('.windsurf')),
        mcp: null,
        prompt: { kind: 'rule', rel: ['.windsurf', 'rules', 'graph-indexer.md'], label: 'always-on Windsurf rule', frontmatter: ['trigger: always_on'] },
    },
    {
        key: 'cline', label: 'Cline / Roo Code', hint: '.clinerules',
        detect: () => fs.existsSync(agentPath('.clinerules')) || fs.existsSync(agentPath('.roo')),
        mcp: null,
        prompt: { kind: 'rule', rel: ['.clinerules', 'graph-indexer.md'], label: 'Cline / Roo Code rule', frontmatter: null },
    },
    {
        key: 'junie', label: 'JetBrains Junie', hint: '.junie/guidelines.md',
        detect: () => fs.existsSync(agentPath('.junie')) || fs.existsSync(agentPath('.idea')),
        mcp: null,
        prompt: { kind: 'shared', rel: ['.junie', 'guidelines.md'], label: 'JetBrains Junie', mode: 'embed' },
    },
    {
        key: 'codex', label: 'Codex / AGENTS.md', hint: 'AGENTS.md (Codex · Zed · Jules)',
        detect: () => fs.existsSync(agentPath('AGENTS.md')) || fs.existsSync(agentPath('.codex')),
        mcp: null,
        prompt: { kind: 'shared', rel: ['AGENTS.md'], label: 'AGENTS.md standard (Codex · Zed · Jules · …)', mode: 'embed' },
    },
    {
        key: 'gemini', label: 'Gemini CLI', hint: 'GEMINI.md',
        detect: () => fs.existsSync(agentPath('GEMINI.md')) || fs.existsSync(agentPath('.gemini')),
        mcp: null,
        prompt: { kind: 'shared', rel: ['GEMINI.md'], label: 'Gemini CLI', mode: 'import' },
    },
];

/**
 * Writes the prompt file(s) for one selected agent, dispatching on prompt.kind.
 * Returns { action, rel, detail } for the summary ledger, or null if the agent
 * has no prompt integration (e.g. Claude Desktop — MCP only).
 */
function writeAgentPrompt(agent, assembled) {
    const p = agent.prompt;
    if (!p) return null;
    if (p.kind === 'claude') {
        const res = ensureClaudeMdImports();
        return { action: res || 'kept', rel: 'CLAUDE.md', detail: res ? '@-imports for Claude Code' : 'imports already present' };
    }
    if (p.kind === 'rule') {
        return { action: writeRuleFile(p, assembled), rel: p.rel.join('/'), detail: p.label };
    }
    const detail = p.mode === 'import' ? `@-imports for ${p.label} (no duplication)` : `managed block for ${p.label}`;
    return { action: writeManagedBlockFile(p, assembled), rel: p.rel.join('/'), detail };
}

// ─── Pre-flight: migrate any pre-v1.4 root layout into .graph-indexer/ ────────

function runMigration() {
    if (!hasLegacyLayout(PROJECT_ROOT)) return;

    log('\n' + c.bold('  ' + glyph.move + ' Tidying project layout'));

    let stoppedDaemon = false;
    for (const pf of [path.join(PROJECT_ROOT, '.idx-daemon.pid'), PATHS.pidFile]) {
        const pid = readPid(pf);
        if (isAlive(pid)) {
            try { if (!isDryRun) process.kill(pid, 'SIGTERM'); stoppedDaemon = true; } catch { /* gone */ }
        }
    }
    if (stoppedDaemon) act('migrated', 'Stopped a running daemon', 'restart with npm run mcp:daemon:start');

    if (isDryRun) {
        act('migrated', `Would relocate root artifacts → ${DATA_DIR_NAME}/`, 'run without --dry-run to apply');
        return;
    }

    const { moved, removed } = migrateLegacyLayout(PROJECT_ROOT);
    for (const m of moved) act('migrated', `${m.from} → ${m.to}`);
    for (const r of removed) act('migrated', `Removed stale ${r}`, 'superseded by .graph-indexer/');
    if (moved.length === 0 && removed.length === 0) act('kept', 'Layout already tidy');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const pkgSelf = readJsonSafe(path.join(__dirname, 'package.json')) || {};
const scan = detectLanguages(PROJECT_ROOT);
const detectedLanguages = scan.langs;
const detectedFrameworks = detectFrameworks(PROJECT_ROOT);

log('');
log(box([
    `${c.bold('⚡ graph-indexer')} ${c.dim('· init')}${pkgSelf.version ? '  ' + c.dim('v' + pkgSelf.version) : ''}${isDryRun ? '  ' + c.yellow('[dry-run]') : ''}`,
    c.dim('AST-precise, air-gapped code search for your AI agents'),
]));
log('');
log(`  ${c.dim('Project')}  ${PROJECT_ROOT}`);
log(`  ${c.dim('Mode')}     ${isInteractive ? 'interactive' : 'non-interactive (auto-detect)'}`);
const stackPreview = [
    detectedLanguages.size ? `${detectedLanguages.size} language(s)` : null,
    detectedFrameworks.size ? `${detectedFrameworks.size} framework(s)` : null,
].filter(Boolean).join(', ');
log(`  ${c.dim('Detected')} ${stackPreview ? stackPreview + c.dim(' in this repo') : c.dim('no known stack auto-detected')}`);

runMigration();


stepHeader(1, 'Languages to index');

let selectedLanguages = null;
if (isInteractive) {
    const picked = await interactiveMultiSelect({
        title: 'Select languages',
        items: LANGUAGES.map(l => ({ key: l.key, label: l.label, desc: c.dim(l.exts) })),
        preselected: detectedLanguages,
    });
    selectedLanguages = picked.length > 0 ? picked : null;
}

if (selectedLanguages) {
    line(glyph.ok, 'Languages', selectedLanguages.map(k => LANGUAGES.find(l => l.key === k)?.label || k).join(', '));
} else {
    line(glyph.ok, 'Languages', 'all supported (default)');
    if (detectedLanguages.size > 0) log(c.dim(`      detected: ${Array.from(detectedLanguages).join(', ')}`));
}


stepHeader(2, 'Frameworks (sharpen the agent prompt)');

const promptLanguages = selectedLanguages || Array.from(detectedLanguages);
const availableFrameworks = FRAMEWORKS.filter(f => f.langs.some(l => promptLanguages.includes(l)));

let selectedFrameworks = [];
if (availableFrameworks.length === 0) {
    line(glyph.skip, 'Frameworks', 'none apply to this language selection');
} else if (isInteractive) {
    selectedFrameworks = await interactiveMultiSelect({
        title: 'Select frameworks',
        items: availableFrameworks.map(f => ({ key: f.key, label: f.label, desc: c.dim(f.hint) })),
        preselected: detectedFrameworks,
    });
    if (selectedFrameworks.length > 0) {
        line(glyph.ok, 'Frameworks', selectedFrameworks.map(k => FRAMEWORKS.find(f => f.key === k)?.label || k).join(', '));
    } else {
        line(glyph.skip, 'Frameworks', 'none selected — language rules only');
    }
} else {
    selectedFrameworks = availableFrameworks.filter(f => detectedFrameworks.has(f.key)).map(f => f.key);
    if (selectedFrameworks.length > 0) {
        line(glyph.ok, 'Frameworks', 'auto-detected: ' + selectedFrameworks.map(k => FRAMEWORKS.find(f => f.key === k)?.label || k).join(', '));
    } else {
        line(glyph.skip, 'Frameworks', 'none detected — language rules only');
    }
}


stepHeader(3, 'Search engine & LLM features');

let engineConfig = null;
// MLX LLM readiness, surfaced to the "Build the index now?" step so we don't
// kick off an index that will fail enrichment/reranking against a down server.
// null = not applicable, true = confirmed running, false = configured but not ready.
let mlxServerReady = null;
{
    const existing = readJsonSafe(PATHS.configPath) || {};
    const exEnrich = existing.enrichment || {};
    const exRerank = existing.rerank || {};

    if (!isInteractive) {
        line(glyph.skip, 'Engine', 'using defaults / existing config (non-interactive)');
    } else if (await confirm({ label: 'Use recommended defaults?  (lexical search · no LLM · no network)', def: true })) {
        const keepStorage = existing.storage === 'memory' || existing.storage === 'sqlite' ? existing.storage : 'auto';
        engineConfig = {
            storage: keepStorage,
            embeddings: false,
            embedProvider: 'off',
            ollamaHost: existing.ollamaHost || 'http://localhost:11434',
            embedModel: existing.embedModel || 'nomic-embed-text',
            localEmbedModel: existing.localEmbedModel || 'Xenova/all-MiniLM-L6-v2',
            mlxEmbedModel: existing.mlxEmbedModel || MLX_MODEL_DEFAULT,
            enrichment: { enabled: false },
            rerank: { enabled: false },
        };
        line(glyph.ok, 'Engine', 'recommended defaults — lexical search, no LLM, no network');
    } else {
        const storage = await interactiveSelect({
            title: 'Storage backend',
            items: [
                { key: 'auto', label: 'Auto', desc: c.dim('recommended · in-memory now, SQLite past 15k chunks') },
                { key: 'memory', label: 'In-memory', desc: c.dim('force · fastest · ideal for most repos') },
                { key: 'sqlite', label: 'SQLite', desc: c.dim('force · persistent · for very large repos (1M+ LOC)') },
            ],
            selectedKey: existing.storage || 'auto',
        });

        const engineItems = [
            { key: 'off', label: 'Lexical only', desc: c.dim('default · keyword/symbol + stemming · no vectors, no dependencies') },
            { key: 'auto', label: 'Auto', desc: c.dim('Ollama if running, else a bundled local model — no setup') },
            { key: 'ollama', label: 'Ollama', desc: c.dim('highest quality · needs the Ollama app + a pulled model') },
            { key: 'local', label: 'Local (in-process)', desc: c.dim('no daemon · downloads a ~25 MB model on first index') },
        ];
        // MLX runs on the Apple Metal GPU and is macOS-only; only offer it there.
        if (process.platform === 'darwin') {
            engineItems.push({ key: 'mlx', label: 'Apple Metal (MLX)', desc: c.dim('fastest local vectors · auto-installs a Python venv (~900 MB)') });
        }
        const embedProvider = await interactiveSelect({
            title: 'Semantic search engine',
            items: engineItems,
            selectedKey: existing.embeddings === true ? (existing.embedProvider || 'auto') : 'off',
        });
        const embeddingsEnabled = embedProvider !== 'off';

        // Ollama is probed lazily — only when something actually needs it (embeddings
        // via ollama/auto, or an Ollama LLM provider chosen later). "Lexical only",
        // "Local", and "Apple Metal" users are never asked for an Ollama URL.
        let ollamaHost = existing.ollamaHost || 'http://localhost:11434';
        let models = null;
        let ollamaProbed = false;
        const ensureOllamaProbed = async () => {
            if (ollamaProbed) return;
            ollamaProbed = true;
            ollamaHost = normalizeHost(await promptText({ label: 'Ollama host', hint: '(URL or port)', def: ollamaHost }));
            log(c.dim('      probing Ollama…'));
            models = await listOllamaModels(ollamaHost);
            if (models) line(glyph.ok, 'Ollama', `${models.length} model(s) at ${ollamaHost}`);
            else line(glyph.warn, 'Ollama', `not reachable at ${ollamaHost} — you can still name models to pull later`);
        };

        let embedModel = existing.embedModel || 'nomic-embed-text';
        if (embedProvider === 'ollama' || embedProvider === 'auto') {
            await ensureOllamaProbed();
            embedModel = await selectModel({ purpose: 'embeddings', def: embedModel, models });
        }
        const localEmbedModel = existing.localEmbedModel || 'Xenova/all-MiniLM-L6-v2';

        // MLX (Apple Metal): let the user pick the model, then offer to provision the
        // dedicated Python venv right now so the first index doesn't fail on missing deps.
        let mlxEmbedModel = existing.mlxEmbedModel || MLX_MODEL_DEFAULT;
        if (embedProvider === 'mlx') {
            mlxEmbedModel = await selectMlxModel(mlxEmbedModel);
            if (mlxEnvReady()) {
                line(glyph.ok, 'MLX', 'environment ready (embedders/venv-mlx)');
            } else if (await confirm({ label: 'Set up the MLX environment now?  (creates embedders/venv-mlx + pip install, ~900 MB)', def: true })) {
                log(c.dim('      provisioning MLX venv — downloads MLX wheels, may take a few minutes…'));
                const res = ensureMlxEnv({ autoInstall: true, log: (s) => log(c.dim('      ' + s)) });
                if (res.ready) line(glyph.ok, 'MLX', 'environment ready (embedders/venv-mlx)');
                else line(glyph.warn, 'MLX', `setup incomplete: ${res.error} — run ${c.cyan('npm run embed:setup:mlx')} later`);
            } else {
                line(glyph.skip, 'MLX', `setup deferred — run ${c.cyan('npm run embed:setup:mlx')} before indexing`);
            }
        }

        const enrichEnabled = await confirm({ label: 'Enable LLM enrichment?  (richer semantics, slower indexing)', def: Boolean(exEnrich.enabled) });

        // Show a data-driven warning before the reranker question when the detected
        // stack is outside the languages where reranking is known to help.
        const hasGoOrPython = detectedLanguages.has('go') || detectedLanguages.has('python');
        if (!hasGoOrPython && detectedLanguages.size > 0) {
            log('');
            log(`  ${glyph.warn} ${c.yellow('Reranker note — measured impact varies by language:')}`);
            log(c.dim('       · Helps Go and Python repos (gin rank-1: 0.20 → 0.40)'));
            log(c.dim('       · Regressions on JavaScript / TypeScript (express rank-1: 0.43 → 0.29)'));
            log(c.dim(`       · Detected: ${Array.from(detectedLanguages).join(', ')} — measure before enabling`));
            log('');
        }

        const rerankEnabled = await confirm({ label: 'Enable LLM reranker?  (one LLM call per query, sharper top hits)', def: Boolean(exRerank.enabled) });

        // LLM provider: asked before model selection so the picker is provider-aware.
        // MLX is macOS-only — on other platforms Ollama is the only backend, so we
        // skip the question rather than offer an option that can't run.
        const isMac = process.platform === 'darwin';
        let llmProvider = (existing.llmProvider === 'mlx' && isMac) ? 'mlx' : 'ollama';
        let mlxLmHost = existing.mlxLmHost || 'http://localhost:8080';
        if (enrichEnabled || rerankEnabled) {
            if (isMac) {
                llmProvider = await interactiveSelect({
                    title: 'LLM backend for enrichment / reranking',
                    items: [
                        { key: 'ollama', label: 'Ollama', desc: c.dim('local daemon · any pulled model') },
                        { key: 'mlx', label: 'Apple MLX', desc: c.dim('mlx_lm.server · fastest on Apple Silicon') },
                    ],
                    selectedKey: llmProvider,
                });
            }
            if (llmProvider === 'mlx') {
                mlxLmHost = await promptText({ label: 'mlx_lm.server URL', def: mlxLmHost, hint: '· e.g. http://localhost:8080' });
            } else {
                await ensureOllamaProbed(); // the model pickers below need the installed list
            }
        }

        // Model selection is provider-aware: Ollama → installed list / pull-by-name;
        // MLX → a curated list of proven coder models (or any id you type).
        const enrichment = { enabled: enrichEnabled };
        if (enrichEnabled) {
            if (llmProvider === 'mlx') {
                enrichment.model = await selectMlxLlmModel({ purpose: 'enrichment', def: exEnrich.model || MLX_LLM_DEFAULTS.enrichment });
            } else {
                enrichment.model = await selectModel({ purpose: 'enrichment', def: exEnrich.model || 'qwen2.5-coder:1.5b', models });
            }
            if (await confirm({ label: 'Tune enrichment limits?', def: false })) {
                enrichment.maxChunks = await promptInt({ label: 'Max LLM calls per index run', def: exEnrich.maxChunks || 500 });
                enrichment.concurrency = await promptInt({ label: 'Parallel LLM requests', def: exEnrich.concurrency || 4 });
            }
        }

        const rerank = { enabled: rerankEnabled };
        if (rerankEnabled) {
            if (llmProvider === 'mlx') {
                rerank.model = await selectMlxLlmModel({ purpose: 'reranker', def: exRerank.model || MLX_LLM_DEFAULTS.reranker });
            } else {
                rerank.model = await selectModel({ purpose: 'reranker', def: exRerank.model || 'qwen2.5-coder:7b', models });
            }
            if (await confirm({ label: 'Tune reranker limits?', def: false })) {
                rerank.topM = await promptInt({ label: 'Candidates shown to the judge', def: exRerank.topM || 12 });
                rerank.poolSize = await promptInt({ label: 'Over-fetch pool size', def: exRerank.poolSize || 15 });
            }
        }

        // For MLX: verify the server is reachable and models are consistent, and
        // remember whether it's ready so the build step can warn before failing.
        if (llmProvider === 'mlx' && (enrichEnabled || rerankEnabled)) {
            mlxServerReady = await checkMlxLmSetup({
                mlxLmHost,
                enrichModel: enrichEnabled ? enrichment.model : null,
                rerankModel: rerankEnabled ? rerank.model : null,
            });
        }

        engineConfig = { storage, embeddings: embeddingsEnabled, embedProvider, ollamaHost, embedModel, localEmbedModel, mlxEmbedModel, llmProvider, mlxLmHost, enrichment, rerank };

        const embedSummary = embedProvider === 'off' ? 'lexical only'
            : embedProvider === 'local' ? `local · ${localEmbedModel}`
                : embedProvider === 'mlx' ? `MLX · ${mlxEmbedModel}`
                    : embedProvider === 'ollama' ? `Ollama · ${embedModel}`
                        : `auto · Ollama ${embedModel} → local`;
        line(glyph.ok, 'Backend', storage === 'sqlite' ? 'SQLite (large repos)'
            : storage === 'memory' ? 'In-memory (forced)' : 'Auto (in-memory → SQLite past 15k chunks)');
        line(embedProvider === 'off' ? glyph.skip : glyph.ok, 'Embeddings', embedSummary);
        const llmProviderLabel = llmProvider === 'mlx' ? `MLX · ${mlxLmHost}` : `Ollama · ${ollamaHost}`;
        line(enrichEnabled ? glyph.ok : glyph.skip, 'Enrichment', enrichEnabled ? `${enrichment.model} via ${llmProviderLabel}` : 'disabled (default)');
        line(rerankEnabled ? glyph.ok : glyph.skip, 'Reranker', rerankEnabled ? `${rerank.model} via ${llmProviderLabel}` : 'disabled (default)');
    }

    // Warn (never fail): 'auto' can promote to SQLite past ~15k chunks, so flag
    // large repos too — not just explicitly forced SQLite.
    const effStorage = engineConfig ? engineConfig.storage : (existing.storage || 'auto');
    if (nodeMajor < 22) {
        if (effStorage === 'sqlite') {
            act('warn', `SQLite backend needs Node 22+ (Node ${process.versions.node} active)`,
                'upgrade Node, or force in-memory (INDEXER_STORAGE=memory)');
        } else if (effStorage === 'auto' && (scan.truncated || scan.fileCount > 2000)) {
            act('warn', `Large repo on Node ${process.versions.node}`,
                'auto storage switches to SQLite past ~15k chunks, which needs Node 22+');
        }
    }
}


stepHeader(4, 'Agents & IDEs');

// Which agents to wire up. Pre-checked default = your saved choice (a previous
// init), else the agents detected in this repo, else all supported. The chosen
// set drives BOTH the MCP wiring (step 5) and the agent prompts (step 7), so you
// pick your tools once and graph-indexer generates nothing for the rest.
const detectedAgents = new Set(
    AGENTS.filter(a => { try { return a.detect(); } catch { return false; } }).map(a => a.key)
);
const savedAgentsRaw = readJsonSafe(PATHS.configPath)?.agents;
const savedAgents = Array.isArray(savedAgentsRaw)
    ? savedAgentsRaw.filter(k => AGENTS.some(a => a.key === k))
    : null;
const defaultAgents = savedAgents
    ? new Set(savedAgents)
    : detectedAgents.size ? new Set(detectedAgents)
    : new Set(AGENTS.map(a => a.key));
const defaultSource = savedAgents ? 'from your saved config'
    : detectedAgents.size ? 'detected in this repo'
    : 'all supported (default)';

let selectedAgentKeys;
if (isInteractive) {
    const picked = await interactiveMultiSelect({
        title: 'Select the agents / IDEs to wire up',
        items: AGENTS.map(a => ({ key: a.key, label: a.label, desc: c.dim(a.hint) })),
        preselected: defaultAgents,
        detected: detectedAgents,
    });
    selectedAgentKeys = new Set(picked);
} else {
    selectedAgentKeys = defaultAgents;
}
const selectedAgents = AGENTS.filter(a => selectedAgentKeys.has(a.key));

if (selectedAgents.length === 0) {
    line(glyph.skip, 'Agents', 'none selected — no MCP wiring or agent prompts will be generated');
} else {
    line(glyph.ok, 'Agents', selectedAgents.map(a => a.label).join(', '));
    log(c.dim(`      ${defaultSource}`));
}


stepHeader(5, 'MCP server wiring');

const mcpAgents = selectedAgents.filter(a => a.mcp);
if (mcpAgents.length === 0) {
    line(glyph.skip, 'MCP wiring', selectedAgents.length ? 'no selected agent uses an MCP config' : 'no agents selected');
} else {
    for (const { mcp } of mcpAgents) {
        try {
            const result = mcp.fn();
            if (result === false) { act('skipped', mcp.name, 'not installed'); continue; }
            const { action, rel, detected } = result;
            act(action, mcp.name, detected ? `${rel} · detected` : `${rel} · ready if you use ${mcp.name}`);
        } catch (e) {
            act('warn', mcp.name, 'error: ' + e.message);
        }
    }
}


stepHeader(6, 'Project files & daemon control');

const scriptRes = addPackageScripts();
if (scriptRes.skipped) {
    act('skipped', 'package.json scripts', scriptRes.skipped);
} else if (scriptRes.added + scriptRes.updated === 0) {
    act('kept', 'package.json scripts', 'already present');
} else {
    act(scriptRes.added > 0 ? 'created' : 'updated', 'package.json scripts',
        `mcp:index, mcp:start, mcp:daemon:* (${scriptRes.added} added${scriptRes.updated ? `, ${scriptRes.updated} refreshed` : ''})`);
}

const gi = updateGitignore();
act(gi, '.gitignore', `${DATA_DIR_NAME}/ (config.json shared)`);

const cfg = saveStackConfig({ languages: selectedLanguages, frameworks: selectedFrameworks, agents: Array.from(selectedAgentKeys), engine: engineConfig, interactive: isInteractive });
if (cfg !== 'skipped') act(cfg, `${DATA_DIR_NAME}/${CONFIG_FILE_NAME}`, 'stack + engine + agent selection');

if (!isDryRun) ensureDataDir(PROJECT_ROOT);


stepHeader(7, 'Agent instructions');

const assembled = assembleAgentPrompt(promptLanguages, selectedFrameworks);
let layersUsed = [];

if (!assembled) {
    act('warn', 'Prompt suite not found in the installed package', 'see prompts/ in the repo');
} else {
    layersUsed = assembled.layers;
    log(c.dim(`      layers: ${layersUsed.join(' + ')}`));

    // Canonical source files — ALWAYS written (they're the single source of truth
    // every agent file points at), independent of the agent selection.
    const promptAction = writeAssembledPrompt(assembled);
    act(promptAction, 'GRAPH_INDEXER_PROMPT.md', 'Layers 1+2 (regenerated each init)');

    if (ensureDomainFile()) act('created', 'GRAPH_INDEXER_DOMAIN.md', 'Layer 3 — yours to edit, never overwritten');
    else act('kept', 'GRAPH_INDEXER_DOMAIN.md', 'exists — left untouched');

    // Per-agent files — only for the agents chosen in step 4.
    const promptAgents = selectedAgents.filter(a => a.prompt);
    if (promptAgents.length === 0) {
        line(glyph.skip, 'Agent files', selectedAgents.length ? 'no selected agent needs a prompt file' : 'no agents selected');
    } else {
        for (const agent of promptAgents) {
            const r = writeAgentPrompt(agent, assembled);
            if (r) act(r.action, r.rel, r.detail);
        }
    }
}


log('\n' + rule());
log(`  ${c.bold('Summary')}${isDryRun ? c.yellow('  (dry-run — nothing written)') : ''}`);
log(rule());

const summaryOrder = [
    ['created', 'Created'], ['updated', 'Updated'], ['migrated', 'Migrated'],
    ['kept', 'Kept'], ['skipped', 'Skipped'], ['warn', 'Warnings'],
];
let anySummary = false;
for (const [kind, label] of summaryOrder) {
    const items = ledger[kind];
    if (!items.length) continue;
    anySummary = true;
    log(`  ${GLYPH_FOR[kind]} ${c.bold(label)} ${c.dim(`(${items.length})`)}  ${c.dim(items.join(', '))}`);
}
if (!anySummary) log(c.dim('  Nothing to do.'));
if (layersUsed.length > 0) log(`\n  ${c.dim('Prompt layers')}  ${layersUsed.join(' + ')}`);

// ── Build the index now (interactive) ────────────────────────────────────────
let indexBuilt = false;
if (isInteractive && !isDryRun) {
    log('');
    // If MLX enrichment/reranking is configured but the server isn't confirmed up,
    // building now would fail those LLM steps — warn and don't default to yes.
    if (mlxServerReady === false) {
        log(`  ${glyph.warn} ${c.yellow('mlx_lm.server is not confirmed running — enrichment / reranking will fail until it is.')}`);
    }
    if (await confirm({ label: 'Build the index now?', def: mlxServerReady !== false })) {
        log('\n  ' + c.dim('Running the indexer…') + '\n');
        const res = spawnSync(process.execPath, [path.join(__dirname, 'indexer.mjs'), '--repo', PROJECT_ROOT], { stdio: 'inherit' });
        indexBuilt = res.status === 0;
        log('');
        if (indexBuilt) log(`  ${glyph.ok} ${c.bold('Index built.')} ${c.dim('graph-indexer is ready to use.')}`);
        else log(`  ${glyph.warn} ${c.yellow('Index build failed.')} ${c.dim('Re-run ' + CMD.index + ' to see the error.')}`);
    }
}


log('\n' + c.bold('  Next steps'));
let nextStep = 1;
if (!indexBuilt) log(`    ${c.cyan(nextStep++ + '.')} Build the index        ${c.dim('→')} ${c.cyan(CMD.index)}`);
log(`    ${c.cyan(nextStep++ + '.')} Restart your editor    ${c.dim('→')} loads the MCP server (auto-starts the daemon)`);
log(`    ${c.cyan(nextStep++ + '.')} Control the daemon     ${c.dim('→')} ${c.cyan(CMD.daemonStatus)} ${c.dim('| start | stop | restart | logs')}`);
log(`    ${c.cyan(nextStep++ + '.')} Add project rules      ${c.dim('→')} edit ${c.cyan('GRAPH_INDEXER_DOMAIN.md')} (Layer 3)`);
if (selectedAgents.length) log(c.dim(`       Wired: ${selectedAgents.map(a => a.label).join(' · ')} — re-run init to change; more in prompts/INTEGRATION.md`));
else log(c.dim(`       No agents wired — re-run init to choose; see prompts/INTEGRATION.md`));
if (engineConfig && (engineConfig.enrichment.enabled || engineConfig.rerank.enabled)) {
    const llmLabel = engineConfig.llmProvider === 'mlx'
        ? `mlx_lm.server at ${engineConfig.mlxLmHost}`
        : `Ollama at ${engineConfig.ollamaHost}`;
    log(c.dim(`       LLM features on — first index run calls ${llmLabel}`));
}

log('\n' + rule());
log(`  ${glyph.ok} ${c.bold('graph-indexer is ready.')} ${c.dim('Generated files live in ' + DATA_DIR_NAME + '/ — your root stays clean.')}`);
log(rule() + '\n');

process.exit(0);
