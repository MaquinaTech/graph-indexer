/**
 * The Claude Code plugin must name the exact graph-indexer release it runs: an npx range (`@3`,
 * `@latest`) lets two installs of the same plugin version run different code, and plugin directories
 * refuse such launchers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VERSION } from '../integrations/claude-code-local/hooks/gi-hook.mjs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('plugin: manifest, MCP launcher and hook client all pin the package version', () => {
    assert.equal(JSON.parse(read('integrations/claude-code-local/.claude-plugin/plugin.json')).version, pkg.version);
    assert.equal(VERSION, pkg.version);
    const args = JSON.parse(read('integrations/claude-code-local/.mcp.json')).mcpServers['graph-indexer'].args;
    assert.ok(args.includes(`graph-indexer@${pkg.version}`), args.join(' '));
});

test('plugin: no launcher in the plugin fetches a range', () => {
    for (const f of ['integrations/claude-code-local/.mcp.json', 'integrations/claude-code-local/hooks/gi-hook.mjs', 'integrations/claude-code-local/hooks/hooks.json']) {
        const bad = read(f).match(/graph-indexer@(?!\d+\.\d+\.\d+\b|\$\{VERSION\})[^\s'",`]*/g);
        assert.equal(bad, null, `${f}: ${bad}`);
    }
});

test('plugin directory: integrations/claude-code holds only Markdown and JSON, no hooks, no local MCP server, minimal frontmatter', () => {
    const root = new URL('../integrations/claude-code/', import.meta.url);
    const files = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
        .map(e => `${e.parentPath ?? e.path}/${e.name}`.replace(/\\/g, '/'));
    assert.ok(files.length >= 3, files.join(' '));
    for (const f of files) {
        assert.match(f, /\.(md|json)$/, `${f}: only Markdown and JSON`);
        const text = fs.readFileSync(f, 'utf8');
        assert.ok(!text.startsWith('#!') && !text.includes('\0'), f);
        assert.ok(!/"type"\s*:\s*"command"/.test(text), `${f}: no command hooks`);
        if (f.endsWith('.md')) {
            const front = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
            for (const key of front.match(/^[A-Za-z][\w-]*(?=:)/gm) ?? []) assert.ok(['name', 'description'].includes(key), `${f}: frontmatter key ${key}`);
        }
    }
    assert.ok(!files.some(f => /\/(hooks\/|\.mcp\.json$)/.test(f)), 'hooks and .mcp.json live in claude-code-local');
    assert.equal(JSON.parse(read('integrations/claude-code/.claude-plugin/plugin.json')).version, pkg.version);
    assert.ok(read('integrations/claude-code/skills/setup/SKILL.md').includes(`graph-indexer@${pkg.version}`));
});
