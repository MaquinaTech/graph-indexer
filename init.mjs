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
import { fileURLToPath } from 'url';
import { c, glyph, log, rule, box } from './cli-ui.mjs';
import {
    DATA_DIR_NAME, CONFIG_FILE_NAME, ensureDataDir, artifactPaths,
    migrateLegacyLayout, hasLegacyLayout,
} from './layout.mjs';
import { readPid, isAlive } from './daemon-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDryRun = process.argv.includes('--dry-run');
const isAllLanguages = process.argv.includes('--all-languages');
const isInteractive = !isAllLanguages && process.stdin.isTTY;
const PROJECT_ROOT = process.cwd();
const PATHS = artifactPaths(PROJECT_ROOT);

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

// ─── MCP Server config blocks ─────────────────────────────────────────────────

const SERVER_CONFIG = {
    command: 'npm',
    args: ['run', 'mcp:start'],
    env: { MCP_PROJECT_ROOT: PROJECT_ROOT },
};

const SERVER_CONFIG_GLOBAL = {
    command: 'npm',
    args: ['run', '--prefix', PROJECT_ROOT, 'mcp:start'],
    env: { MCP_PROJECT_ROOT: PROJECT_ROOT },
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
    const queue = [{ dir: root, depth: 0 }];

    while (queue.length > 0 && visited < 4000) {
        const { dir, depth } = queue.shift();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            if (++visited >= 4000) break;
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
    return new Set(Object.keys(counts).filter(k => counts[k] >= threshold));
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

// ─── Stack config persistence (.graph-indexer/config.json) ───────────────────

function saveStackConfig({ languages, frameworks, engine, interactive }) {
    if (isDryRun) { log(c.dim(`    [dry-run] would write ${DATA_DIR_NAME}/${CONFIG_FILE_NAME}`)); return 'skipped'; }
    ensureDataDir(PROJECT_ROOT);
    const existing = readJsonSafe(PATHS.configPath) || {};
    const before = JSON.stringify(existing);

    if (interactive) {
        // The user just made an explicit choice — it is authoritative.
        if (languages) existing.languages = languages; else delete existing.languages;
        if (frameworks && frameworks.length) existing.frameworks = frameworks; else delete existing.frameworks;
    } else {
        // Auto-detect run: never destroy an existing selection; only fill blanks.
        if (languages && !existing.languages) existing.languages = languages;
        if (frameworks && frameworks.length && !existing.frameworks) existing.frameworks = frameworks;
    }

    // Engine settings only when the user explicitly configured them (interactive).
    // Merge nested objects so power-user knobs we didn't prompt for (coreRatio,
    // topM, poolSize, …) survive a re-run.
    if (engine) {
        existing.storage = engine.storage;
        existing.embeddings = engine.embeddings;
        if (engine.embedProvider) existing.embedProvider = engine.embedProvider;
        existing.ollamaHost = engine.ollamaHost;
        existing.embedModel = engine.embedModel;
        if (engine.localEmbedModel) existing.localEmbedModel = engine.localEmbedModel;
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
    return upsertMcpServer(path.join(PROJECT_ROOT, '.vscode', 'mcp.json'), 'servers', SERVER_CONFIG);
}

function configureCursor() {
    return upsertMcpServer(path.join(PROJECT_ROOT, '.cursor', 'mcp.json'), 'mcpServers', SERVER_CONFIG);
}

function configureClaudeDesktop() {
    const configPath = process.platform === 'win32'
        ? path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json')
        : path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    if (!fs.existsSync(path.dirname(configPath))) return false; // Claude Desktop not installed
    const res = upsertMcpServer(configPath, 'mcpServers', SERVER_CONFIG_GLOBAL);
    return { ...res, rel: 'claude_desktop_config.json' };
}

function configureClaudeCode() {
    const hasClaudeDir = fs.existsSync(path.join(PROJECT_ROOT, '.claude'));
    const configPath = hasClaudeDir
        ? path.join(PROJECT_ROOT, '.claude', 'settings.json')
        : path.join(PROJECT_ROOT, '.mcp.json');
    return upsertMcpServer(configPath, 'mcpServers', SERVER_CONFIG);
}

// ─── package.json scripts (index + daemon control) ───────────────────────────

// Canonical script values graph-indexer manages. These call the package bins, so
// they work when graph-indexer is installed as a dependency of the user's project.
const CANON_SCRIPTS = {
    'mcp:index': 'idx-index --repo .',
    'mcp:start': 'idx-mcp',
    'mcp:daemon:start': 'idx-daemon start',
    'mcp:daemon:stop': 'idx-daemon stop',
    'mcp:daemon:restart': 'idx-daemon restart',
    'mcp:daemon:status': 'idx-daemon status',
    'mcp:daemon:logs': 'idx-daemon logs',
};
// Values previous graph-indexer versions wrote — safe to overwrite on upgrade.
// Anything else under these keys is treated as a user customisation and kept.
const OLD_SCRIPT_VALUES = {
    'mcp:index': new Set(['idx-index --repo .', 'node indexer.mjs --repo .', 'idx-index']),
    'mcp:start': new Set(['idx-mcp', 'node mcp-server.mjs']),
};

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

    // Drop any previous managed block...
    let body = existing.replace(
        new RegExp(`\\n?${GITIGNORE_BEGIN}[\\s\\S]*?${GITIGNORE_END}\\n?`, 'g'), '\n'
    );
    // ...and any stray pre-v1.4 single lines we used to add.
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

    // A daemon from an older install may hold the SQLite db open at the old root
    // path; stop it before relocating so nothing writes to a moved inode.
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
const detectedLanguages = detectLanguages(PROJECT_ROOT);
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

// ── Pre-flight migration ──────────────────────────────────────────────────────
runMigration();

// ── Step 1 · Languages ────────────────────────────────────────────────────────

stepHeader(1, 'Languages to index');

let selectedLanguages = null; // null = all languages (default)
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

// ── Step 2 · Frameworks ───────────────────────────────────────────────────────

stepHeader(2, 'Frameworks (sharpen the agent prompt)');

// Languages that drive prompt assembly: explicit selection wins; otherwise what
// the scan found (keeps "all languages" from dumping every Layer 2 file).
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

// ── Step 3 · Search engine & LLM features ─────────────────────────────────────

stepHeader(3, 'Search engine & LLM features');

let engineConfig = null; // null = leave engine settings to defaults / existing config
{
    const existing = readJsonSafe(PATHS.configPath) || {};
    const exEnrich = existing.enrichment || {};
    const exRerank = existing.rerank || {};

    if (!isInteractive) {
        line(glyph.skip, 'Engine', 'using defaults / existing config (non-interactive)');
    } else {
        // Storage backend
        const storage = await interactiveSelect({
            title: 'Storage backend',
            items: [
                { key: 'auto', label: 'Auto', desc: c.dim('recommended · in-memory now, SQLite past 15k chunks') },
                { key: 'memory', label: 'In-memory', desc: c.dim('force · fastest · ideal for most repos') },
                { key: 'sqlite', label: 'SQLite', desc: c.dim('force · persistent · for very large repos (1M+ LOC)') },
            ],
            selectedKey: existing.storage || 'auto',
        });

        // Semantic search engine — how query/code vectors are produced. Embeddings
        // are opt-in (the default lexical + stemming path needs zero dependencies),
        // so 'Lexical only' is highlighted; choosing a provider enables them. 'auto'
        // prefers a running Ollama and otherwise a small in-process model (no daemon).
        const embedProvider = await interactiveSelect({
            title: 'Semantic search engine',
            items: [
                { key: 'off', label: 'Lexical only', desc: c.dim('default · keyword/symbol + stemming · no vectors, no dependencies') },
                { key: 'auto', label: 'Auto', desc: c.dim('Ollama if running, else a bundled local model — no setup') },
                { key: 'ollama', label: 'Ollama', desc: c.dim('highest quality · needs the Ollama app + a pulled model') },
                { key: 'local', label: 'Local (in-process)', desc: c.dim('no daemon · downloads a ~25 MB model on first index') },
            ],
            selectedKey: existing.embeddings === true ? (existing.embedProvider || 'auto') : 'off',
        });
        const embeddingsEnabled = embedProvider !== 'off';

        // Ollama endpoint — powers Ollama embeddings, enrichment and reranking.
        const ollamaHost = normalizeHost(await promptText({
            label: 'Ollama host', hint: '(URL or port)',
            def: existing.ollamaHost || 'http://localhost:11434',
        }));
        log(c.dim('      probing Ollama…'));
        const models = await listOllamaModels(ollamaHost);
        if (models) line(glyph.ok, 'Ollama', `${models.length} model(s) at ${ollamaHost}`);
        else line(glyph.warn, 'Ollama', `not reachable at ${ollamaHost} — you can still name models to pull later`);

        // Ollama embedding model — only when Ollama can be the embedder. nomic is the
        // safe default; qwen3-embedding:4b is the documented opt-in upgrade.
        const embedModel = (embedProvider === 'ollama' || embedProvider === 'auto')
            ? await selectModel({ purpose: 'embeddings', def: existing.embedModel || 'nomic-embed-text', models })
            : (existing.embedModel || 'nomic-embed-text');
        const localEmbedModel = existing.localEmbedModel || 'Xenova/all-MiniLM-L6-v2';

        // LLM enrichment (opt-in)
        const enrichEnabled = await confirm({ label: 'Enable LLM enrichment?  (richer semantics, slower indexing)', def: Boolean(exEnrich.enabled) });
        const enrichment = { enabled: enrichEnabled };
        if (enrichEnabled) {
            enrichment.model = await selectModel({ purpose: 'enrichment', def: exEnrich.model || 'qwen2.5-coder:1.5b', models });
            if (await confirm({ label: 'Tune enrichment limits?', def: false })) {
                enrichment.maxChunks = await promptInt({ label: 'Max LLM calls per index run', def: exEnrich.maxChunks || 500 });
                enrichment.concurrency = await promptInt({ label: 'Parallel Ollama requests', def: exEnrich.concurrency || 4 });
            }
        }

        // LLM reranker (opt-in)
        const rerankEnabled = await confirm({ label: 'Enable LLM reranker?  (one LLM call per query, sharper top hits)', def: Boolean(exRerank.enabled) });
        const rerank = { enabled: rerankEnabled };
        if (rerankEnabled) {
            rerank.model = await selectModel({ purpose: 'reranker', def: exRerank.model || 'qwen2.5-coder:7b', models });
            if (await confirm({ label: 'Tune reranker limits?', def: false })) {
                rerank.topM = await promptInt({ label: 'Candidates shown to the judge', def: exRerank.topM || 12 });
                rerank.poolSize = await promptInt({ label: 'Over-fetch pool size', def: exRerank.poolSize || 15 });
            }
        }

        engineConfig = { storage, embeddings: embeddingsEnabled, embedProvider, ollamaHost, embedModel, localEmbedModel, enrichment, rerank };

        const embedSummary = embedProvider === 'off' ? 'lexical only'
            : embedProvider === 'local' ? `local · ${localEmbedModel}`
                : embedProvider === 'ollama' ? `Ollama · ${embedModel}`
                    : `auto · Ollama ${embedModel} → local`;
        line(glyph.ok, 'Backend', storage === 'sqlite' ? 'SQLite (large repos)'
            : storage === 'memory' ? 'In-memory (forced)' : 'Auto (in-memory → SQLite past 15k chunks)');
        line(embedProvider === 'off' ? glyph.skip : glyph.ok, 'Embeddings', embedSummary);
        line(enrichEnabled ? glyph.ok : glyph.skip, 'Enrichment', enrichEnabled ? enrichment.model : 'disabled (default)');
        line(rerankEnabled ? glyph.ok : glyph.skip, 'Reranker', rerankEnabled ? rerank.model : 'disabled (default)');
    }
}

// ── Step 4 · Editors & MCP wiring ─────────────────────────────────────────────

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
        const { action, rel } = result;
        act(action, name, rel);
    } catch (e) {
        act('warn', name, 'error: ' + e.message);
    }
}

// ── Step 5 · Project files & daemon control ───────────────────────────────────

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

// ── Step 6 · Agent instructions (layered prompt suite) ────────────────────────

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

// ── Summary ────────────────────────────────────────────────────────────────────

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

// ── Next steps ──────────────────────────────────────────────────────────────────

log('\n' + c.bold('  Next steps'));
log(`    ${c.cyan('1.')} Build the index        ${c.dim('→')} ${c.cyan('npm run mcp:index')}`);
log(`    ${c.cyan('2.')} Restart your editor    ${c.dim('→')} loads the MCP server (auto-starts the daemon)`);
log(`    ${c.cyan('3.')} Control the daemon     ${c.dim('→')} ${c.cyan('npm run mcp:daemon:status')} ${c.dim('| start | stop | restart | logs')}`);
log(`    ${c.cyan('4.')} Add project rules      ${c.dim('→')} edit ${c.cyan('GRAPH_INDEXER_DOMAIN.md')} (Layer 3)`);
log(c.dim(`       Other agents (.clinerules, .windsurfrules, …): prompts/INTEGRATION.md`));
if (engineConfig && (engineConfig.enrichment.enabled || engineConfig.rerank.enabled)) {
    log(c.dim(`       LLM features on — first ${c.cyan('npm run mcp:index')} calls Ollama at ${engineConfig.ollamaHost}`));
}

log('\n' + rule());
log(`  ${glyph.ok} ${c.bold('graph-indexer is ready.')} ${c.dim('Generated files live in ' + DATA_DIR_NAME + '/ — your root stays clean.')}`);
log(rule() + '\n');

process.exit(0);
