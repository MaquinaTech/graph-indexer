#!/usr/bin/env node
/**
 * @file init.mjs
 * @description graph-indexer init CLI — auto-configures all detected IDEs/agents.
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
const PROJECT_ROOT = process.cwd();

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

function log(msg) { process.stdout.write(msg + '\n'); }

function writeFile(filePath, content) {
    if (isDryRun) { log(`  [dry-run] Would write: ${filePath}`); return; }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
}

function readJsonSafe(filePath) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { /* malformed JSON — start fresh */ }
    return null;
}

// ─── Interactive Language Selection ───────────────────────────────────────────

function selectLanguages() {
    return new Promise((resolve) => {
        if (isAllLanguages || !process.stdin.isTTY) return resolve(null);

        const { stdin, stdout } = process;
        readline.emitKeypressEvents(stdin);
        stdin.setRawMode(true);
        stdout.write('\x1B[?25l');

        let cursorIndex = 0;
        const selected = new Set();
        let hasRendered = false;

        const render = () => {
            if (hasRendered) {
                readline.moveCursor(stdout, 0, -(LANGUAGES.length + 2));
                readline.cursorTo(stdout, 0);
                readline.clearScreenDown(stdout);
            }
            hasRendered = true;

            stdout.write('⚙️  Select languages (Arrows/Tab: move, Space: toggle, Enter: confirm):\n\n');

            LANGUAGES.forEach((lang, i) => {
                const isHovered = i === cursorIndex;
                const isSelected = selected.has(i);

                const prefix = isHovered ? '❯' : ' ';
                const checkbox = isSelected ? '◉' : '◯';

                const line = `  ${prefix} ${checkbox} ${lang.label.padEnd(20)} ${lang.exts}\n`;
                stdout.write(isHovered ? `\x1b[36m${line}\x1b[0m` : line);
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
                cursorIndex = (cursorIndex - 1 + LANGUAGES.length) % LANGUAGES.length;
                render();
            } else if (key.name === 'down' || (key.name === 'tab' && !key.shift)) {
                cursorIndex = (cursorIndex + 1) % LANGUAGES.length;
                render();
            } else if (key.name === 'space') {
                if (selected.has(cursorIndex)) selected.delete(cursorIndex);
                else selected.add(cursorIndex);
                render();
            } else if (key.name === 'return') {
                cleanup();
                readline.moveCursor(stdout, 0, -(LANGUAGES.length + 2));
                readline.cursorTo(stdout, 0);
                readline.clearScreenDown(stdout);

                if (selected.size === 0) {
                    resolve(null); // Enable all languages by default
                } else {
                    resolve(Array.from(selected).map(i => LANGUAGES[i].key));
                }
            }
        };

        stdin.on('keypress', onKeypress);
        render();
    });
}

function saveLanguageConfig(languages) {
    const configPath = path.join(PROJECT_ROOT, '.graph-indexer.json');
    if (isDryRun) {
        if (languages) log(`  [dry-run] Would write: ${configPath}`);
        return;
    }
    const existing = readJsonSafe(configPath) || {};
    if (!languages) {
        delete existing.languages;
    } else {
        existing.languages = languages;
    }
    if (languages || Object.keys(existing).length > 0) {
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
    return true;
}

function configureCursor() {
    const configPath = path.join(PROJECT_ROOT, '.cursor', 'mcp.json');
    const existing = readJsonSafe(configPath) || {};
    if (!existing.mcpServers) existing.mcpServers = {};
    if (existing.mcpServers['graph-indexer']) return false;

    existing.mcpServers['graph-indexer'] = SERVER_CONFIG;
    writeFile(configPath, JSON.stringify(existing, null, 2) + '\n');
    return true;
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
    return true;
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
    return true;
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

// ─── Main ─────────────────────────────────────────────────────────────────────

log('\n🚀 graph-indexer init' + (isDryRun ? ' [dry-run]' : '') + '\n');
log(`Project: ${PROJECT_ROOT}`);

// Language selection (interactive menu).
const selectedLanguages = await selectLanguages();
saveLanguageConfig(selectedLanguages);

if (selectedLanguages) {
    const names = selectedLanguages.map(k => LANGUAGES.find(l => l.key === k)?.label || k);
    log(`\n✅ Enabled languages: ${names.join(', ')}\n`);
} else {
    log('\n✅ Enabled languages: all (default)\n');
}

const configured = [];
const skipped = [];

const ides = [
    { name: 'VS Code', fn: configureVSCode },
    { name: 'Cursor', fn: configureCursor },
    { name: 'Claude Desktop', fn: configureClaudeDesktop },
    { name: 'Claude Code', fn: configureClaudeCode },
];

log('Detecting IDEs / agents...\n');
for (const { name, fn } of ides) {
    try {
        const result = fn();
        if (result === false) skipped.push(name + ' (already configured or not installed)');
        else configured.push(name);
    } catch (e) {
        skipped.push(name + ' (error: ' + e.message + ')');
    }
}

const scriptsAdded = addPackageScripts();
if (scriptsAdded) configured.push('package.json scripts (mcp:index, mcp:watch, mcp:start)');
else skipped.push('package.json scripts (already present)');

const gitignoreUpdated = updateGitignore();
if (gitignoreUpdated) configured.push('.gitignore (code-index, daemon artifacts)');
else skipped.push('.gitignore (already contains index/daemon entries)');

// ─── Summary ─────────────────────────────────────────────────────────────────

log('\nConfigured:\n');
if (configured.length) configured.forEach(c => log('  * ' + c));
else log('  (nothing new to configure)');

if (skipped.length) {
    log('\nSkipped:\n');
    skipped.forEach(s => log('  - ' + s));
}

log('\nNext steps:\n');
log('  1. Run `npm run mcp:index` to index this project');
log('  2. Restart your IDE to activate the MCP server');
log('  3. Run `npm run mcp:start` if your IDE needs the server started manually');

log('\n─────────────────────────────────────────────────────────────────');
log('✨ Thank you for setting up graph-indexer!');
log('   Enjoy your blazing-fast, AST-precise codebase search.');
log('─────────────────────────────────────────────────────────────────\n');
log('');
log('🤖 Agent Instructions:');
log('   To teach your AI agent how to use graph-indexer effectively,');
log('   copy the system prompt from our repository:');
log('   https://github.com/MaquinaTech/graph-indexer/blob/main/PROMPT.md?plain=1');
log('─────────────────────────────────────────────────────────────────\n');

process.exit(0);