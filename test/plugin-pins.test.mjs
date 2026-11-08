/**
 * The Claude Code plugin must name the exact graph-indexer release it runs: an npx range (`@3`,
 * `@latest`) lets two installs of the same plugin version run different code, and plugin directories
 * refuse such launchers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VERSION } from '../integrations/claude-code/hooks/gi-hook.mjs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('plugin: manifest, MCP launcher and hook client all pin the package version', () => {
    assert.equal(JSON.parse(read('integrations/claude-code/.claude-plugin/plugin.json')).version, pkg.version);
    assert.equal(VERSION, pkg.version);
    const args = JSON.parse(read('integrations/claude-code/.mcp.json')).mcpServers['graph-indexer'].args;
    assert.ok(args.includes(`graph-indexer@${pkg.version}`), args.join(' '));
});

test('plugin: no launcher in the plugin fetches a range', () => {
    for (const f of ['integrations/claude-code/.mcp.json', 'integrations/claude-code/hooks/gi-hook.mjs', 'integrations/claude-code/hooks/hooks.json']) {
        const bad = read(f).match(/graph-indexer@(?!\d+\.\d+\.\d+\b|\$\{VERSION\})[^\s'",`]*/g);
        assert.equal(bad, null, `${f}: ${bad}`);
    }
});
