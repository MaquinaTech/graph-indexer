/**
 * @file test/security.mjs
 * @description Security regression tests for the MCP tool surface. Currently
 *              covers the get_file_skeleton path-traversal guard (#6): the textual
 *              containment check PLUS the realpath defence that stops a symlink
 *              *inside* the project from reading a file outside it.
 *
 *              Drives the real registerTools handler via a fake McpServer. No
 *              network. Skips the symlink case if the platform forbids symlinks.
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @license MIT
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { registerTools } from '../mcp/tools.mjs';

function captureTools(projectRoot) {
    const handlers = new Map();
    const fakeServer = { tool: (name, _d, _s, h) => handlers.set(name, h) };
    registerTools(fakeServer, { graph: { dependencies: {} } }, {
        projectRoot, artifactPath: '/nonexistent', pidFile: null,
        embeddingsEnabled: false, embedder: null,
    });
    return handlers;
}

test('get_file_skeleton blocks a symlink inside the project that points outside', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-sec-'));
    const project = path.join(base, 'project');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(project); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const SECRET = 42;\n');
    fs.writeFileSync(path.join(project, 'safe.ts'), 'export function ok() { return 1; }\n');

    let symlinked = true;
    try { fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(project, 'evil.ts')); }
    catch { symlinked = false; }

    try {
        const skeleton = captureTools(project).get('get_file_skeleton');

        // A normal in-root file is NOT denied (it may or may not parse, but never "Access denied").
        const safe = await skeleton({ file_path: 'safe.ts' });
        assert.doesNotMatch(safe.content[0].text, /Access denied/, 'in-root file is allowed');

        const trav = await skeleton({ file_path: '../outside/secret.ts' });
        assert.match(trav.content[0].text, /Access denied/, 'path traversal blocked');

        if (symlinked) {
            const evil = await skeleton({ file_path: 'evil.ts' });
            assert.match(evil.content[0].text, /Access denied/, 'symlink escape blocked by realpath check');
        } else {
            console.log('  ⚠️  symlinks unavailable — skipping symlink-escape case');
        }
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('get_file_skeleton honours json response_format for denials', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-sec2-'));
    try {
        const skeleton = captureTools(base).get('get_file_skeleton');
        const res = await skeleton({ file_path: '../etc/hosts', response_format: 'json' });
        // Errors are returned as an error result (text), not a structured success payload.
        assert.match(res.content[0].text, /Access denied|Error/, 'denial reported');
        assert.equal(res.isError, true);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
