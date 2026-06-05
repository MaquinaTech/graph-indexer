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
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDryRun = process.argv.includes('--dry-run');
const PROJECT_ROOT = process.cwd();

// ─── MCP Server config block ──────────────────────────────────────────────────

const SERVER_CONFIG = {
    command: 'node',
    args: [path.join(PROJECT_ROOT, 'node_modules', 'graph-indexer', 'mcp-server.mjs')],
    env: { MCP_PROJECT_ROOT: PROJECT_ROOT }
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(msg) { process.stdout.write(msg + '\n'); }

function writeFile(filePath, content) {
    if (isDryRun) {
        log(`  [dry-run] Would write: ${filePath}`);
        return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
}

function readJsonSafe(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
    } catch { /* malformed JSON — start fresh */ }
    return null;
}

/** Deep-merge src into dst without duplicating top-level keys. */
function mergeJson(dst, src) {
    for (const [k, v] of Object.entries(src)) {
        if (dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k]) && typeof v === 'object' && !Array.isArray(v)) {
            mergeJson(dst[k], v);
        } else {
            dst[k] = v;
        }
    }
    return dst;
}

// ─── IDE Detectors & Configurators ───────────────────────────────────────────

function configureVSCode() {
    const vscodeDir = path.join(PROJECT_ROOT, '.vscode');
    const configPath = path.join(vscodeDir, 'mcp.json');

    const existing = readJsonSafe(configPath) || {};
    if (!existing.servers) existing.servers = {};
    if (existing.servers['graph-indexer']) return false; // already configured

    existing.servers['graph-indexer'] = SERVER_CONFIG;
    writeFile(configPath, JSON.stringify(existing, null, 2) + '\n');
    return true;
}

function configureCursor() {
    // Check both project-level and global Cursor config
    const candidates = [
        path.join(PROJECT_ROOT, '.cursor', 'mcp.json'),
        path.join(os.homedir(), '.cursor', 'mcp.json'),
    ];
    const detected = candidates.some(p => fs.existsSync(path.dirname(p)));

    // Prefer project-level config
    const configPath = candidates[0];
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

    if (!fs.existsSync(path.dirname(configPath))) return false; // Claude not installed

    const existing = readJsonSafe(configPath) || {};
    if (!existing.mcpServers) existing.mcpServers = {};
    if (existing.mcpServers['graph-indexer']) return false;

    existing.mcpServers['graph-indexer'] = SERVER_CONFIG;
    writeFile(configPath, JSON.stringify(existing, null, 2) + '\n');
    return true;
}

function configureClaudeCode() {
    // Claude Code stores MCP config in .mcp.json or .claude/settings.json at project root
    const candidates = [
        path.join(PROJECT_ROOT, '.claude', 'settings.json'),
        path.join(PROJECT_ROOT, '.mcp.json'),
    ];

    // Prefer .claude/settings.json if directory exists, else .mcp.json
    const hasClaudeDir = fs.existsSync(path.join(PROJECT_ROOT, '.claude'));
    const configPath = hasClaudeDir ? candidates[0] : candidates[1];

    const existing = readJsonSafe(configPath) || {};
    const serverKey = hasClaudeDir ? 'mcpServers' : 'mcpServers';
    if (!existing[serverKey]) existing[serverKey] = {};
    if (existing[serverKey]['graph-indexer']) return false;

    existing[serverKey]['graph-indexer'] = SERVER_CONFIG;
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

    const entries = ['code-index.json', 'code-index.embeddings.bin'];
    const toAdd = entries.filter(e => !existing.includes(e));
    if (toAdd.length === 0) return false;

    const newContent = existing.trimEnd() + '\n\n# graph-indexer runtime artifacts\n' + toAdd.join('\n') + '\n';
    writeFile(gitignorePath, newContent);
    return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

log('\n🔧 graph-indexer init' + (isDryRun ? ' [dry-run]' : '') + '\n');
log(`📂 Project: ${PROJECT_ROOT}\n`);

const configured = [];
const skipped = [];

// IDE configuration
const ides = [
    { name: 'VS Code', fn: configureVSCode },
    { name: 'Cursor', fn: configureCursor },
    { name: 'Claude Desktop', fn: configureClaudeDesktop },
    { name: 'Claude Code', fn: configureClaudeCode },
];

log('🔍 Detecting IDEs / agents...\n');
for (const { name, fn } of ides) {
    try {
        const result = fn();
        if (result === false) {
            skipped.push(name + ' (already configured or not installed)');
        } else {
            configured.push(name);
        }
    } catch (e) {
        skipped.push(name + ' (error: ' + e.message + ')');
    }
}

// Package scripts
const scriptsAdded = addPackageScripts();
if (scriptsAdded) configured.push('package.json scripts (mcp:index, mcp:watch, mcp:start)');
else skipped.push('package.json scripts (already present)');

// .gitignore
const gitignoreUpdated = updateGitignore();
if (gitignoreUpdated) configured.push('.gitignore (code-index.json, code-index.embeddings.bin)');
else skipped.push('.gitignore (already contains index entries)');

// ─── Summary ─────────────────────────────────────────────────────────────────

log('\n✅ Configured:\n');
if (configured.length) configured.forEach(c => log('  • ' + c));
else log('  (nothing new to configure)');

if (skipped.length) {
    log('\n⏭️  Skipped:\n');
    skipped.forEach(s => log('  • ' + s));
}

log('\n📋 Next steps:\n');
log('  1. Run `npm run mcp:index` to index this project');
log('  2. Restart your IDE to activate MCP servers');
log('  3. Run `npm run mcp:start` if your IDE needs the server started manually');
log('\n');
