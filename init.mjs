#!/usr/bin/env node
/**
 * @file init.mjs
 * @description graph-indexer init CLI — auto-configures all detected IDEs/agents
 *              and assembles the layered agent prompt suite (core + language +
 *              framework) for the selected stack.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDryRun = process.argv.includes('--dry-run');
const isAllLanguages = process.argv.includes('--all-languages');
const isInteractive = !isAllLanguages && process.stdin.isTTY;
const PROJECT_ROOT = process.cwd();

// ─── Styling ──────────────────────────────────────────────────────────────────

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
    bold: paint('1'),
    dim: paint('2'),
    cyan: paint('36'),
    green: paint('32'),
    yellow: paint('33'),
};
const RULE = '─'.repeat(64);
const TOTAL_STEPS = 4;

function log(msg = '') { process.stdout.write(msg + '\n'); }
function stepHeader(n, title) { log('\n' + c.bold(`Step ${n}/${TOTAL_STEPS} · ${title}`)); }
function ok(label, detail) { log(`  ${c.green('✓')} ${label}${detail ? c.dim(' · ' + detail) : ''}`); }
function skip(label, reason) { log(c.dim(`  – ${label}${reason ? ' · ' + reason : ''}`)); }

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
    if (isDryRun) { log(c.dim(`  [dry-run] Would write: ${path.relative(PROJECT_ROOT, filePath) || filePath}`)); return; }
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

// ─── Stack Detection (used to pre-select menu entries) ───────────────────────

const EXT_TO_LANG = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.go': 'go', '.rs': 'rust', '.php': 'php', '.java': 'java',
    '.kt': 'kotlin', '.kts': 'kotlin', '.cs': 'csharp', '.rb': 'ruby',
    '.css': 'css', '.scss': 'css',
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
                const checkbox = selected.has(i) ? '◉' : '◯';
                const detected = preselected.has(item.key) ? '  · detected' : '';
                const line = `  ${prefix} ${checkbox} ${item.label.padEnd(28)} ${item.desc}${detected}\n`;
                stdout.write(isHovered ? c.cyan(line) : line);
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

// ─── Stack config persistence (.graph-indexer.json) ──────────────────────────

function saveStackConfig(languages, frameworks) {
    const configPath = path.join(PROJECT_ROOT, '.graph-indexer.json');
    if (isDryRun) { log(c.dim(`  [dry-run] Would write: .graph-indexer.json`)); return; }
    const existing = readJsonSafe(configPath) || {};
    if (!languages) delete existing.languages;
    else existing.languages = languages;
    if (!frameworks || frameworks.length === 0) delete existing.frameworks;
    else existing.frameworks = frameworks;
    if (Object.keys(existing).length > 0 || languages || (frameworks && frameworks.length)) {
        fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    }
}

// ─── IDE Detectors & Configurators ───────────────────────────────────────────

function configureVSCode() {
    const configPath = path.join(PROJECT_ROOT, '.vscode', 'mcp.json');
    const existing = readJsonSafe(configPath) || {};
    if (!existing.servers) existing.servers = {};
    if (existing.servers['graph-indexer']) return false;

    existing.servers['graph-indexer'] = SERVER_CONFIG;
    writeFile(configPath, JSON.stringify(existing, null, 2) + '\n');
    return '.vscode/mcp.json';
}

function configureCursor() {
    const configPath = path.join(PROJECT_ROOT, '.cursor', 'mcp.json');
    const existing = readJsonSafe(configPath) || {};
    if (!existing.mcpServers) existing.mcpServers = {};
    if (existing.mcpServers['graph-indexer']) return false;

    existing.mcpServers['graph-indexer'] = SERVER_CONFIG;
    writeFile(configPath, JSON.stringify(existing, null, 2) + '\n');
    return '.cursor/mcp.json';
}

function configureClaudeDesktop() {
    let configPath;
    if (process.platform === 'win32') {
        configPath = path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
    } else {
        configPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }

    if (!fs.existsSync(path.dirname(configPath))) return false;

    const existing = readJsonSafe(configPath) || {};
    if (!existing.mcpServers) existing.mcpServers = {};
    if (existing.mcpServers['graph-indexer']) return false;

    existing.mcpServers['graph-indexer'] = SERVER_CONFIG_GLOBAL;
    writeFile(configPath, JSON.stringify(existing, null, 2) + '\n');
    return 'claude_desktop_config.json';
}

function configureClaudeCode() {
    const hasClaudeDir = fs.existsSync(path.join(PROJECT_ROOT, '.claude'));
    const configPath = hasClaudeDir
        ? path.join(PROJECT_ROOT, '.claude', 'settings.json')
        : path.join(PROJECT_ROOT, '.mcp.json');

    const existing = readJsonSafe(configPath) || {};
    if (!existing.mcpServers) existing.mcpServers = {};
    if (existing.mcpServers['graph-indexer']) return false;

    existing.mcpServers['graph-indexer'] = SERVER_CONFIG;
    writeFile(configPath, JSON.stringify(existing, null, 2) + '\n');
    return path.relative(PROJECT_ROOT, configPath);
}

// ─── package.json scripts ─────────────────────────────────────────────────────

function addPackageScripts() {
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;

    const pkg = readJsonSafe(pkgPath);
    if (!pkg) return false;

    const scripts = pkg.scripts || {};
    const toAdd = {
        'mcp:index': 'idx-index --repo .',
        'mcp:watch': 'idx-watch',
        'mcp:start': 'idx-mcp',
    };

    let changed = false;
    for (const [k, v] of Object.entries(toAdd)) {
        if (!scripts[k]) { scripts[k] = v; changed = true; }
    }

    if (changed) {
        pkg.scripts = scripts;
        writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    }
    return changed;
}

// ─── .gitignore ──────────────────────────────────────────────────────────────

function updateGitignore() {
    const gitignorePath = path.join(PROJECT_ROOT, '.gitignore');
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';

    const entries = [
        'code-index.json',
        'code-index.embeddings.bin',
        'code-index.db',
        'code-index.db-wal',
        'code-index.db-shm',
        'code-index.enrichment.json',
        '.idx-daemon.pid',
        '.idx-daemon.log'
    ];

    const toAdd = entries.filter(e => !existing.includes(e));
    if (toAdd.length === 0) return false;

    const newContent = existing.trimEnd() + '\n\n# graph-indexer runtime artifacts\n' + toAdd.join('\n') + '\n';
    writeFile(gitignorePath, newContent);
    return true;
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
    return true;
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
    writeFile(p, frontmatter + '\n' + assembled.content + tail);
    return existed ? 'updated' : 'created';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const pkgSelf = readJsonSafe(path.join(__dirname, 'package.json')) || {};
const detectedLanguages = detectLanguages(PROJECT_ROOT);
const detectedFrameworks = detectFrameworks(PROJECT_ROOT);

log('');
log(c.dim(RULE));
log(`  ${c.bold('⚡ graph-indexer · init')}${pkgSelf.version ? c.dim('  v' + pkgSelf.version) : ''}${isDryRun ? c.yellow('  [dry-run]') : ''}`);
log(c.dim(RULE));
log(`  ${c.dim('Project')}  ${PROJECT_ROOT}`);
log(`  ${c.dim('Mode')}     ${isInteractive ? 'interactive' : 'non-interactive (auto-detect)'}`);

// ── Step 1/4 · Languages ─────────────────────────────────────────────────────

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
    ok('Indexing', selectedLanguages.map(k => LANGUAGES.find(l => l.key === k)?.label || k).join(', '));
} else {
    ok('Indexing', 'all supported languages (default)');
    if (detectedLanguages.size > 0) {
        log(c.dim(`    detected in project: ${Array.from(detectedLanguages).join(', ')}`));
    }
}

// ── Step 2/4 · Frameworks ────────────────────────────────────────────────────

stepHeader(2, 'Frameworks (sharpen the agent prompt)');

// Languages that drive prompt assembly: explicit selection wins; otherwise what
// the scan found (keeps "all languages" from dumping every Layer 2 file).
const promptLanguages = selectedLanguages || Array.from(detectedLanguages);
const availableFrameworks = FRAMEWORKS.filter(f => f.langs.some(l => promptLanguages.includes(l)));

let selectedFrameworks = [];
if (availableFrameworks.length === 0) {
    skip('No framework add-ons apply to this language selection');
} else if (isInteractive) {
    selectedFrameworks = await interactiveMultiSelect({
        title: 'Select frameworks',
        items: availableFrameworks.map(f => ({ key: f.key, label: f.label, desc: c.dim(f.hint) })),
        preselected: detectedFrameworks,
    });
    if (selectedFrameworks.length > 0) {
        ok('Frameworks', selectedFrameworks.map(k => FRAMEWORKS.find(f => f.key === k)?.label || k).join(', '));
    } else {
        skip('No frameworks selected', 'language rules only');
    }
} else {
    selectedFrameworks = availableFrameworks.filter(f => detectedFrameworks.has(f.key)).map(f => f.key);
    if (selectedFrameworks.length > 0) {
        ok('Auto-detected', selectedFrameworks.map(k => FRAMEWORKS.find(f => f.key === k)?.label || k).join(', '));
    } else {
        skip('None detected', 'language rules only');
    }
}

saveStackConfig(selectedLanguages, selectedFrameworks);

// ── Step 3/4 · Editors & MCP wiring ──────────────────────────────────────────

stepHeader(3, 'Editors & MCP wiring');

const configured = [];
const skipped = [];

const ides = [
    { name: 'VS Code', fn: configureVSCode },
    { name: 'Cursor', fn: configureCursor },
    { name: 'Claude Desktop', fn: configureClaudeDesktop },
    { name: 'Claude Code', fn: configureClaudeCode },
];

for (const { name, fn } of ides) {
    try {
        const result = fn();
        if (result === false) {
            skip(name, 'already configured or not installed');
            skipped.push(name);
        } else {
            ok(name, typeof result === 'string' ? result : '');
            configured.push(name);
        }
    } catch (e) {
        skip(name, 'error: ' + e.message);
        skipped.push(name);
    }
}

if (addPackageScripts()) { ok('package.json scripts', 'mcp:index, mcp:watch, mcp:start'); configured.push('package.json scripts'); }
else skip('package.json scripts', 'already present');

if (updateGitignore()) { ok('.gitignore', 'index + daemon artifacts'); configured.push('.gitignore'); }
else skip('.gitignore', 'already contains index/daemon entries');

// ── Step 4/4 · Agent instructions (layered prompt suite) ─────────────────────

stepHeader(4, 'Agent instructions');

const assembled = assembleAgentPrompt(promptLanguages, selectedFrameworks);
let layersUsed = [];

if (!assembled) {
    skip('Prompt suite not found in the installed package', 'see prompts/ in the repo');
} else {
    layersUsed = assembled.layers;
    log(c.dim(`    layers: ${layersUsed.join(' + ')}`));

    const promptAction = writeAssembledPrompt(assembled);
    ok('GRAPH_INDEXER_PROMPT.md', `${promptAction} (Layers 1+2 — regenerated on every init)`);
    configured.push('GRAPH_INDEXER_PROMPT.md');

    if (ensureDomainFile()) {
        ok('GRAPH_INDEXER_DOMAIN.md', 'created (Layer 3 — yours to edit, never overwritten)');
        configured.push('GRAPH_INDEXER_DOMAIN.md');
    } else {
        skip('GRAPH_INDEXER_DOMAIN.md', 'already exists — kept untouched');
    }

    if (ensureClaudeMdImports()) {
        ok('CLAUDE.md', '@-imports added for Claude Code');
        configured.push('CLAUDE.md');
    } else {
        skip('CLAUDE.md', 'imports already present');
    }

    const ruleAction = writeCursorRule(assembled);
    ok('.cursor/rules/graph-indexer.mdc', `${ruleAction} (always-on Cursor rule)`);
    configured.push('.cursor/rules/graph-indexer.mdc');
}

// ── Summary ──────────────────────────────────────────────────────────────────

log('\n' + c.dim(RULE));
log(`  ${c.bold('Summary')}`);
log(c.dim(RULE));
log(`  ${c.dim('Configured')}  ${configured.length ? configured.join(', ') : '(nothing new)'}`);
if (layersUsed.length > 0) log(`  ${c.dim('Prompt')}      ${layersUsed.join(' + ')}`);

log('\n' + c.bold('Next steps') + '\n');
log('  1. Run ' + c.cyan('npm run mcp:index') + ' to index this project');
log('  2. Restart your IDE to activate the MCP server');
log('  3. Fill in ' + c.cyan('GRAPH_INDEXER_DOMAIN.md') + ' with your project\'s own rules (Layer 3)');
log('  4. Other agents (.cursorrules, .clauderc, …): see ' + c.cyan('prompts/INTEGRATION.md'));
log(c.dim('     https://github.com/MaquinaTech/graph-indexer/blob/main/prompts/INTEGRATION.md'));

log('\n' + c.dim(RULE));
log('  ✨ Thank you for setting up graph-indexer!');
log('     Enjoy your blazing-fast, AST-precise codebase search.');
log(c.dim(RULE) + '\n');

process.exit(0);
