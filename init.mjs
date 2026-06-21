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
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { c, glyph, log, rule, box } from './cli-ui.mjs';
import {
    DATA_DIR_NAME, CONFIG_FILE_NAME, ensureDataDir, artifactPaths,
    migrateLegacyLayout, hasLegacyLayout,
} from './layout.mjs';
import { readPid, isAlive } from './daemon-lock.mjs';
import { ensureMlxEnv, mlxEnvReady } from './embedders/setup-mlx.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default MLX embed model offered in onboarding (mirrors config.mjs DEFAULTS.mlxEmbedModel).
const MLX_MODEL_DEFAULT = 'mlx-community/all-MiniLM-L6-v2-4bit';

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

const TOTAL_STEPS = 6;

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
// `npx -p graph-indexer idx-mcp` runs the real idx-mcp bin regardless of language
// or whether graph-indexer is installed, and `--repo` carries the absolute root.
// The `-p` form is required: `npx graph-indexer idx-mcp` would run the package's
// same-named (init) bin instead. MCP_PROJECT_ROOT is kept as a belt-and-suspenders
// fallback for the npm form (which has no --repo).
const NPX_MCP_ARGS = ['-y', '-p', 'graph-indexer', 'idx-mcp', '--repo', PROJECT_ROOT];

const SERVER_CONFIG = localDep
    ? { command: 'npm', args: ['run', 'mcp:start'], env: { MCP_PROJECT_ROOT: PROJECT_ROOT } }
    : { command: 'npx', args: NPX_MCP_ARGS, env: { MCP_PROJECT_ROOT: PROJECT_ROOT } };

// Global clients (Claude Desktop) launch from outside the project. With a local
// dep, `npm run --prefix <root>` resolves the bin from the project; otherwise the
// npx form already carries the absolute --repo, so it doubles as the global form.
const SERVER_CONFIG_GLOBAL = localDep
    ? { command: 'npm', args: ['run', '--prefix', PROJECT_ROOT, 'mcp:start'], env: { MCP_PROJECT_ROOT: PROJECT_ROOT } }
    : { command: 'npx', args: NPX_MCP_ARGS, env: { MCP_PROJECT_ROOT: PROJECT_ROOT } };

// Display commands for "Next steps" — adapt to the same local-dep vs npx decision.
const q = (p) => (/\s/.test(p) ? `"${p}"` : p);
const CMD = {
    index: localDep ? 'npm run mcp:index' : `npx -y -p graph-indexer idx-index --repo ${q(PROJECT_ROOT)}`,
    daemonStatus: localDep ? 'npm run mcp:daemon:status' : `npx -y -p graph-indexer idx-daemon status --repo ${q(PROJECT_ROOT)}`,
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function writeFile(filePath, content) {
    if (isDryRun) { log(c.dim(`    [dry-run] would write ${path.relative(PROJECT_ROOT, filePath) || filePath}`)); return; }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
}

function readJsonSafe(filePath) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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

// ─── Interactive Multi-Select Menu ────────────────────────────────────────────

/**
 * Renders an arrow-key multi-select. `items` need { key, label, desc }; entries
 * whose key is in `preselected` start checked. Resolves to the selected keys
 * (possibly empty — callers decide what an empty selection means).
 */
function interactiveMultiSelect({ title, items, preselected = new Set() }) {
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

            stdout.write(`  ${title} ${c.dim('(↑↓/Tab move · Space toggle · Enter confirm)')}\n\n`);

            items.forEach((item, i) => {
                const isHovered = i === cursorIndex;
                const prefix = isHovered ? '❯' : ' ';
                const checkbox = selected.has(i) ? c.green('◉') : '◯';
                const detected = preselected.has(item.key) ? c.dim('  · detected') : '';
                const label = isHovered ? c.cyan(item.label.padEnd(28)) : item.label.padEnd(28);
                stdout.write(`  ${c.cyan(prefix)} ${checkbox} ${label} ${item.desc}${detected}\n`);
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
                process.exit(0);
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
            stdout.write(`  ${title} ${c.dim('(↑↓ move · Enter select)')}\n\n`);
            items.forEach((item, i) => {
                const hovered = i === cursor;
                const radio = hovered ? c.green('◉') : '◯';
                const label = hovered ? c.cyan(item.label.padEnd(26)) : item.label.padEnd(26);
                stdout.write(`  ${c.cyan(hovered ? '❯' : ' ')} ${radio} ${label} ${item.desc || ''}\n`);
            });
        };

        const cleanup = () => {
            if (stdin.isTTY) stdin.setRawMode(false);
            stdout.write('\x1B[?25h');
            stdin.removeListener('keypress', onKeypress);
        };

        const onKeypress = (str, key) => {
            if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }
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

/** GET {host}/api/tags → array of installed model names, or null if unreachable. */
async function listOllamaModels(host) {
    try {
        const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2500) });
        if (!res.ok) return null;
        const data = await res.json();
        return (data.models || []).map(m => m.name).filter(Boolean);
    } catch { return null; }
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

// ─── Stack config persistence (.graph-indexer/config.json) ───────────────────

function saveStackConfig({ languages, frameworks, engine, interactive }) {
    if (isDryRun) { log(c.dim(`    [dry-run] would write ${DATA_DIR_NAME}/${CONFIG_FILE_NAME}`)); return 'skipped'; }
    ensureDataDir(PROJECT_ROOT);
    const existing = readJsonSafe(PATHS.configPath) || {};
    const before = JSON.stringify(existing);

    if (interactive) {
            if (languages) existing.languages = languages; else delete existing.languages;
        if (frameworks && frameworks.length) existing.frameworks = frameworks; else delete existing.frameworks;
    } else {
        if (languages && !existing.languages) existing.languages = languages;
        if (frameworks && frameworks.length && !existing.frameworks) existing.frameworks = frameworks;
    }

    // Merge nested objects so power-user knobs we didn't prompt for (coreRatio,
    // topM, poolSize, …) survive a re-run.
    if (engine) {
        existing.storage = engine.storage;
        existing.embeddings = engine.embeddings;
        if (engine.embedProvider) existing.embedProvider = engine.embedProvider;
        existing.ollamaHost = engine.ollamaHost;
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
    return { ...upsertMcpServer(path.join(PROJECT_ROOT, '.mcp.json'), 'mcpServers', SERVER_CONFIG), detected };
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

/** Writes the always-on Cursor rule mirroring the assembled prompt. Regenerated each run. */
function writeCursorRule(assembled) {
    const p = path.join(PROJECT_ROOT, '.cursor', 'rules', 'graph-indexer.mdc');
    const existed = fs.existsSync(p);
    const frontmatter = [
        '---',
        'description: graph-indexer usage rules for AI agents (generated — re-run `npx graph-indexer init` to regenerate)',
        'alwaysApply: true',
        '---',
        '',
    ].join('\n');
    const tail = '\n<!-- Layer 3 (project-specific rules): see GRAPH_INDEXER_DOMAIN.md at the repo root. -->\n';
    const content = frontmatter + '\n' + assembled.content + tail;
    if (existed && readTextSafe(p) === content) return 'kept';
    writeFile(p, content);
    return existed ? 'updated' : 'created';
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

        const ollamaHost = normalizeHost(await promptText({
            label: 'Ollama host', hint: '(URL or port)',
            def: existing.ollamaHost || 'http://localhost:11434',
        }));
        log(c.dim('      probing Ollama…'));
        const models = await listOllamaModels(ollamaHost);
        if (models) line(glyph.ok, 'Ollama', `${models.length} model(s) at ${ollamaHost}`);
        else line(glyph.warn, 'Ollama', `not reachable at ${ollamaHost} — you can still name models to pull later`);

        const embedModel = (embedProvider === 'ollama' || embedProvider === 'auto')
            ? await selectModel({ purpose: 'embeddings', def: existing.embedModel || 'nomic-embed-text', models })
            : (existing.embedModel || 'nomic-embed-text');
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
        const enrichment = { enabled: enrichEnabled };
        if (enrichEnabled) {
            enrichment.model = await selectModel({ purpose: 'enrichment', def: exEnrich.model || 'qwen2.5-coder:1.5b', models });
            if (await confirm({ label: 'Tune enrichment limits?', def: false })) {
                enrichment.maxChunks = await promptInt({ label: 'Max LLM calls per index run', def: exEnrich.maxChunks || 500 });
                enrichment.concurrency = await promptInt({ label: 'Parallel Ollama requests', def: exEnrich.concurrency || 4 });
            }
        }

        const rerankEnabled = await confirm({ label: 'Enable LLM reranker?  (one LLM call per query, sharper top hits)', def: Boolean(exRerank.enabled) });
        const rerank = { enabled: rerankEnabled };
        if (rerankEnabled) {
            rerank.model = await selectModel({ purpose: 'reranker', def: exRerank.model || 'qwen2.5-coder:7b', models });
            if (await confirm({ label: 'Tune reranker limits?', def: false })) {
                rerank.topM = await promptInt({ label: 'Candidates shown to the judge', def: exRerank.topM || 12 });
                rerank.poolSize = await promptInt({ label: 'Over-fetch pool size', def: exRerank.poolSize || 15 });
            }
        }

        engineConfig = { storage, embeddings: embeddingsEnabled, embedProvider, ollamaHost, embedModel, localEmbedModel, mlxEmbedModel, enrichment, rerank };

        const embedSummary = embedProvider === 'off' ? 'lexical only'
            : embedProvider === 'local' ? `local · ${localEmbedModel}`
                : embedProvider === 'mlx' ? `MLX · ${mlxEmbedModel}`
                    : embedProvider === 'ollama' ? `Ollama · ${embedModel}`
                        : `auto · Ollama ${embedModel} → local`;
        line(glyph.ok, 'Backend', storage === 'sqlite' ? 'SQLite (large repos)'
            : storage === 'memory' ? 'In-memory (forced)' : 'Auto (in-memory → SQLite past 15k chunks)');
        line(embedProvider === 'off' ? glyph.skip : glyph.ok, 'Embeddings', embedSummary);
        line(enrichEnabled ? glyph.ok : glyph.skip, 'Enrichment', enrichEnabled ? enrichment.model : 'disabled (default)');
        line(rerankEnabled ? glyph.ok : glyph.skip, 'Reranker', rerankEnabled ? rerank.model : 'disabled (default)');
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


stepHeader(4, 'Editors & MCP wiring');

const ides = [
    { name: 'VS Code', fn: configureVSCode },
    { name: 'Cursor', fn: configureCursor },
    { name: 'Claude Desktop', fn: configureClaudeDesktop },
    { name: 'Claude Code', fn: configureClaudeCode },
];

for (const { name, fn } of ides) {
    try {
        const result = fn();
        if (result === false) { act('skipped', name, 'not installed'); continue; }
        const { action, rel, detected } = result;
        act(action, name, detected ? `${rel} · detected` : `${rel} · ready if you use ${name}`);
    } catch (e) {
        act('warn', name, 'error: ' + e.message);
    }
}


stepHeader(5, 'Project files & daemon control');

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

const cfg = saveStackConfig({ languages: selectedLanguages, frameworks: selectedFrameworks, engine: engineConfig, interactive: isInteractive });
if (cfg !== 'skipped') act(cfg, `${DATA_DIR_NAME}/${CONFIG_FILE_NAME}`, 'stack + engine settings');

if (!isDryRun) ensureDataDir(PROJECT_ROOT);


stepHeader(6, 'Agent instructions');

const assembled = assembleAgentPrompt(promptLanguages, selectedFrameworks);
let layersUsed = [];

if (!assembled) {
    act('warn', 'Prompt suite not found in the installed package', 'see prompts/ in the repo');
} else {
    layersUsed = assembled.layers;
    log(c.dim(`      layers: ${layersUsed.join(' + ')}`));

    const promptAction = writeAssembledPrompt(assembled);
    act(promptAction, 'GRAPH_INDEXER_PROMPT.md', 'Layers 1+2 (regenerated each init)');

    if (ensureDomainFile()) act('created', 'GRAPH_INDEXER_DOMAIN.md', 'Layer 3 — yours to edit, never overwritten');
    else act('kept', 'GRAPH_INDEXER_DOMAIN.md', 'exists — left untouched');

    const claudeRes = ensureClaudeMdImports();
    if (claudeRes) act(claudeRes, 'CLAUDE.md', '@-imports for Claude Code');
    else act('kept', 'CLAUDE.md', 'imports already present');

    const ruleAction = writeCursorRule(assembled);
    act(ruleAction, '.cursor/rules/graph-indexer.mdc', 'always-on Cursor rule');
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
    if (await confirm({ label: 'Build the index now?', def: true })) {
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
log(c.dim(`       Other agents (.clinerules, .windsurfrules, …): prompts/INTEGRATION.md`));
if (engineConfig && (engineConfig.enrichment.enabled || engineConfig.rerank.enabled)) {
    log(c.dim(`       LLM features on — first index run calls Ollama at ${engineConfig.ollamaHost}`));
}

log('\n' + rule());
log(`  ${glyph.ok} ${c.bold('graph-indexer is ready.')} ${c.dim('Generated files live in ' + DATA_DIR_NAME + '/ — your root stays clean.')}`);
log(rule() + '\n');

process.exit(0);
