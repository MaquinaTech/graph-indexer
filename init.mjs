#!/usr/bin/env node
/**
 * @file init.mjs
 * @description graph-indexer init CLI — interactive project setup. Selects
 *              languages, the AI provider (local Ollama or a cloud provider),
 *              and the storage backend, writes `.graph-indexer.json`, and
 *              auto-configures all detected IDEs/agents.
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
import { PROVIDER_DEFAULTS, PROVIDER_IDS, resolveApiKey } from './providers.mjs';
import { STORAGE_BACKENDS } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const isDryRun = argv.includes('--dry-run');
const isAllLanguages = argv.includes('--all-languages');
const PROJECT_ROOT = process.cwd();

function flagValue(flag) {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// ─── Language Registry ────────────────────────────────────────────────────────

const LANGUAGES = [
    { key: 'typescript', label: 'TypeScript / TSX', hint: '.ts, .tsx' },
    { key: 'javascript', label: 'JavaScript', hint: '.js, .jsx, .mjs, .cjs' },
    { key: 'python', label: 'Python', hint: '.py' },
    { key: 'go', label: 'Go', hint: '.go' },
    { key: 'rust', label: 'Rust', hint: '.rs' },
    { key: 'php', label: 'PHP', hint: '.php' },
    { key: 'java', label: 'Java', hint: '.java' },
    { key: 'kotlin', label: 'Kotlin', hint: '.kt, .kts' },
    { key: 'csharp', label: 'C#', hint: '.cs' },
    { key: 'ruby', label: 'Ruby', hint: '.rb' },
    { key: 'css', label: 'CSS / SCSS', hint: '.css, .scss' },
];

// ─── Provider / storage choices ───────────────────────────────────────────────

function keyStatus(provider) {
    const envName = PROVIDER_DEFAULTS[provider].apiKeyEnv;
    if (!envName) return 'no API key needed';
    return resolveApiKey(provider) ? `${envName} detected ✓` : `requires ${envName}`;
}

function providerItems(ids) {
    return ids.map(id => ({
        key: id,
        label: PROVIDER_DEFAULTS[id].label + (id === 'ollama' ? '  (default)' : ''),
        hint: keyStatus(id),
    }));
}

// Embedding channel: every provider except Anthropic, which has no embeddings API.
const EMBED_PROVIDER_IDS = PROVIDER_IDS.filter(id => PROVIDER_DEFAULTS[id].embedModel);

const STORAGES = [
    { key: 'memory', label: 'In-memory  (default)', hint: 'zero-dependency JSON artifacts' },
    { key: 'sqlite', label: 'SQLite', hint: 'disk-backed, Node ≥22.5, monorepo scale' },
    { key: 'postgres', label: 'PostgreSQL', hint: 'external/shared database (npm install pg)' },
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

// ─── Interactive menu (arrow-key list, single- or multi-select) ───────────────

/**
 * Render an arrow-key menu over `items` ({label, hint}).
 * Multi-select resolves to an array of selected indices (empty = none chosen);
 * single-select resolves to one index.
 */
function menu(title, items, { multiSelect = false, initialIndex = 0 } = {}) {
    return new Promise((resolve) => {
        const { stdin, stdout } = process;
        readline.emitKeypressEvents(stdin);
        stdin.setRawMode(true);
        stdout.write('\x1B[?25l');

        let cursorIndex = initialIndex;
        const selected = new Set();
        let hasRendered = false;
        const labelWidth = Math.max(...items.map(i => i.label.length)) + 2;

        const render = () => {
            if (hasRendered) {
                readline.moveCursor(stdout, 0, -(items.length + 2));
                readline.cursorTo(stdout, 0);
                readline.clearScreenDown(stdout);
            }
            hasRendered = true;

            const hint = multiSelect ? 'Arrows: move, Space: toggle, Enter: confirm' : 'Arrows: move, Enter: confirm';
            stdout.write(`${title} (${hint}):\n\n`);

            items.forEach((item, i) => {
                const isHovered = i === cursorIndex;
                const prefix = isHovered ? '❯' : ' ';
                const marker = multiSelect ? (selected.has(i) ? '◉' : '◯') : (isHovered ? '●' : '○');
                const line = `  ${prefix} ${marker} ${item.label.padEnd(labelWidth)} ${item.hint || ''}\n`;
                stdout.write(isHovered ? `\x1b[36m${line}\x1b[0m` : line);
            });
        };

        const cleanup = () => {
            stdin.setRawMode(false);
            stdout.write('\x1B[?25h');
            stdin.removeListener('keypress', onKeypress);
            readline.moveCursor(stdout, 0, -(items.length + 2));
            readline.cursorTo(stdout, 0);
            readline.clearScreenDown(stdout);
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
            } else if (key.name === 'space' && multiSelect) {
                if (selected.has(cursorIndex)) selected.delete(cursorIndex);
                else selected.add(cursorIndex);
                render();
            } else if (key.name === 'return') {
                cleanup();
                resolve(multiSelect ? Array.from(selected) : cursorIndex);
            }
        };

        stdin.on('keypress', onKeypress);
        render();
    });
}

/** Plain one-line prompt (used for the optional Postgres URL). */
function question(prompt) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
    });
}

// ─── Setup steps ──────────────────────────────────────────────────────────────

async function selectLanguages() {
    if (isAllLanguages || !process.stdin.isTTY) return null;
    const picked = await menu('⚙️  Select languages', LANGUAGES, { multiSelect: true });
    return picked.length === 0 ? null : picked.map(i => LANGUAGES[i].key); // none = all
}

async function selectStorage() {
    const flag = flagValue('--storage');
    if (flag) {
        if (!STORAGE_BACKENDS.includes(flag)) {
            log(`\n❌ Unknown storage backend '${flag}'. Valid: ${STORAGE_BACKENDS.join(', ')}`);
            process.exit(1);
        }
        return flag;
    }
    if (!process.stdin.isTTY) return 'memory';
    const i = await menu('🗄  Select the storage backend', STORAGES);
    return STORAGES[i].key;
}

async function collectPostgresUrl() {
    if (process.env.GRAPH_INDEXER_PG_URL || process.env.DATABASE_URL) {
        log('   Connection: using GRAPH_INDEXER_PG_URL / DATABASE_URL from the environment ✓');
        return null;
    }
    if (!process.stdin.isTTY) return null;
    const url = await question(
        '   PostgreSQL URL (blank = use GRAPH_INDEXER_PG_URL / DATABASE_URL / PG* env vars later):\n   > '
    );
    if (url && /:[^/@]+@/.test(url)) {
        log('   ⚠️  The URL embeds a password and will be stored in .graph-indexer.json.');
        log('      Prefer exporting GRAPH_INDEXER_PG_URL (it always overrides the file).');
    }
    return url || null;
}

async function selectProvider() {
    const flag = flagValue('--provider');
    if (flag) {
        if (!PROVIDER_IDS.includes(flag)) {
            log(`\n❌ Unknown provider '${flag}'. Valid: ${PROVIDER_IDS.join(', ')}`);
            process.exit(1);
        }
        return flag;
    }
    if (!process.stdin.isTTY) return 'ollama';
    const items = providerItems(PROVIDER_IDS);
    const i = await menu('🤖 Select the AI provider for LLM generation (enrichment + rerank)', items);
    return items[i].key;
}

/**
 * Resolve the embedding provider. Anthropic has no embeddings API, so when it
 * is the generation provider the user must pick the embedding provider
 * explicitly — there is no automatic fallback. For other providers the same
 * provider serves both channels (changeable in the model-customisation step).
 */
async function selectEmbedProvider(provider) {
    const flag = flagValue('--embed-provider');
    if (flag) {
        if (!EMBED_PROVIDER_IDS.includes(flag)) {
            log(`\n❌ '${flag}' cannot embed. Valid embedding providers: ${EMBED_PROVIDER_IDS.join(', ')}`);
            process.exit(1);
        }
        return flag;
    }
    if (provider !== 'anthropic') return provider;
    if (!process.stdin.isTTY) {
        log('\n❌ Anthropic offers no embeddings API — pass --embed-provider <ollama|openai|gemini>.');
        process.exit(1);
    }
    const items = providerItems(EMBED_PROVIDER_IDS);
    const i = await menu('🧮 Anthropic has no embeddings API — select the embedding provider', items);
    return items[i].key;
}

/**
 * Per-channel model selection. Shows the recommended provider/model trio and
 * lets the user keep it (default) or customise each channel — provider and
 * model — independently. Blank model input keeps the provider's default.
 */
async function selectModels(provider, embedProvider) {
    const channels = {
        embedding: { provider: embedProvider, model: PROVIDER_DEFAULTS[embedProvider].embedModel },
        enrichment: { provider, model: PROVIDER_DEFAULTS[provider].enrichModel },
        rerank: { provider, model: PROVIDER_DEFAULTS[provider].rerankModel },
    };
    if (!process.stdin.isTTY) return channels;

    log('\nModels:');
    for (const [name, ch] of Object.entries(channels)) {
        log(`  ${name.padEnd(11)} ${ch.model} [${ch.provider}]`);
    }
    const choice = await menu('🎛  Use these recommended models?', [
        { key: 'yes', label: 'Yes, use recommended  (default)', hint: '' },
        { key: 'custom', label: 'Customise per channel', hint: 'pick provider + model for embedding / enrichment / rerank' },
    ]);
    if (choice === 0) return channels;

    for (const [name, ch] of Object.entries(channels)) {
        const ids = name === 'embedding' ? EMBED_PROVIDER_IDS : PROVIDER_IDS;
        const items = providerItems(ids);
        const i = await menu(`  ${name} provider`, items, { initialIndex: ids.indexOf(ch.provider) });
        ch.provider = items[i].key;
        const def = name === 'embedding'
            ? PROVIDER_DEFAULTS[ch.provider].embedModel
            : name === 'enrichment' ? PROVIDER_DEFAULTS[ch.provider].enrichModel : PROVIDER_DEFAULTS[ch.provider].rerankModel;
        ch.model = (await question(`  ${name} model [${def}]: `)) || def;
    }
    return channels;
}

/**
 * Persist only the deviations from what config.mjs derives on its own, so the
 * file stays minimal: a default ollama setup writes no provider keys at all.
 */
function saveProjectConfig({ languages, provider, storage, postgresUrl, channels }) {
    const configPath = path.join(PROJECT_ROOT, '.graph-indexer.json');
    const existing = readJsonSafe(configPath) || {};

    if (!languages) delete existing.languages;
    else existing.languages = languages;

    if (provider === 'ollama') delete existing.provider;
    else existing.provider = provider;

    if (storage === 'memory') delete existing.storage;
    else existing.storage = storage;

    if (storage === 'postgres' && postgresUrl) {
        existing.postgres = { ...(existing.postgres || {}), url: postgresUrl };
    } else if (storage !== 'postgres') {
        delete existing.postgres;
    }

    const { embedding, enrichment, rerank } = channels;

    if (embedding.provider === provider) delete existing.embedProvider;
    else existing.embedProvider = embedding.provider;
    if (embedding.model === PROVIDER_DEFAULTS[embedding.provider].embedModel) delete existing.embedModel;
    else existing.embedModel = embedding.model;

    const channelConfig = (key, ch, defaultModel) => {
        const out = { ...(existing[key] || {}) };
        if (ch.provider === provider) delete out.provider;
        else out.provider = ch.provider;
        if (ch.model === defaultModel) delete out.model;
        else out.model = ch.model;
        if (Object.keys(out).length === 0) delete existing[key];
        else existing[key] = out;
    };
    channelConfig('enrichment', enrichment,
        enrichment.provider === provider ? PROVIDER_DEFAULTS[provider].enrichModel : PROVIDER_DEFAULTS[enrichment.provider].enrichModel);
    channelConfig('rerank', rerank,
        rerank.provider === provider ? PROVIDER_DEFAULTS[provider].rerankModel : PROVIDER_DEFAULTS[rerank.provider].rerankModel);

    if (isDryRun) { log(`  [dry-run] Would write: ${configPath}`); return; }
    if (Object.keys(existing).length > 0 || fs.existsSync(configPath)) {
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
        'code-index.embeddings.meta.json',
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

const selectedLanguages = await selectLanguages();
if (selectedLanguages) {
    const names = selectedLanguages.map(k => LANGUAGES.find(l => l.key === k)?.label || k);
    log(`✅ Languages: ${names.join(', ')}`);
} else {
    log('✅ Languages: all (default)');
}

const storage = await selectStorage();
log(`✅ Storage backend: ${STORAGES.find(s => s.key === storage).label.replace('  (default)', '')}`);
let postgresUrl = null;
if (storage === 'postgres') {
    postgresUrl = await collectPostgresUrl();
}

const provider = await selectProvider();
log(`✅ Generation provider: ${PROVIDER_DEFAULTS[provider].label} — ${keyStatus(provider)}`);

const embedProvider = await selectEmbedProvider(provider);
if (embedProvider !== provider) {
    log(`✅ Embedding provider: ${PROVIDER_DEFAULTS[embedProvider].label} — ${keyStatus(embedProvider)}`);
}

const channels = await selectModels(provider, embedProvider);
log('✅ Models:');
for (const [name, ch] of Object.entries(channels)) {
    log(`     ${name.padEnd(11)} ${ch.model} [${ch.provider}]`);
}
const missingKeys = [...new Set(Object.values(channels).map(ch => ch.provider))]
    .filter(p => PROVIDER_DEFAULTS[p].apiKeyEnv && !resolveApiKey(p))
    .map(p => PROVIDER_DEFAULTS[p].apiKeyEnv);
if (missingKeys.length) {
    log(`   ⚠️  Export ${missingKeys.join(' and ')} before indexing (keys are read from the environment, never stored).`);
}

saveProjectConfig({ languages: selectedLanguages, provider, storage, postgresUrl, channels });
log('');

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
let step = 1;
for (const envName of missingKeys) {
    log(`  ${step++}. Export ${envName} in your shell`);
}
if (storage === 'postgres') {
    if (!postgresUrl && !process.env.GRAPH_INDEXER_PG_URL && !process.env.DATABASE_URL) {
        log(`  ${step++}. Export GRAPH_INDEXER_PG_URL (or DATABASE_URL) with your PostgreSQL connection string`);
    }
    log(`  ${step++}. Run \`npm install pg\` (the PostgreSQL driver is an optional dependency)`);
}
log(`  ${step++}. Run \`npm run mcp:index\` to index this project`);
log(`  ${step++}. Restart your IDE to activate the MCP server`);
log(`  ${step++}. Run \`npm run mcp:start\` if your IDE needs the server started manually`);

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
