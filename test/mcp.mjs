#!/usr/bin/env node
/**
 * test/mcp.mjs
 *
 * End-to-end MCP smoke test. Boots the real server over stdio against an indexed
 * fixture and exercises the extracted tool surface (search_code, resolve_symbol,
 * get_call_graph, list_index_stats), proving the slimmed bootstrap + mcp-tools
 * wiring works against the storage contract.
 *
 *   node test/mcp.mjs
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'express-js');

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

/** Minimal newline-delimited JSON-RPC client over a child process. */
function startServer() {
    const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server.mjs')], {
        env: { ...process.env, MCP_PROJECT_ROOT: FIXTURE, INDEXER_EMBEDDINGS: 'off' },
        stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buf = '';
    const waiters = new Map();
    child.stdout.on('data', (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
        }
    });
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
    const request = (id, method, params) => new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), 15000);
        waiters.set(id, (m) => { clearTimeout(timer); res(m); });
        send({ jsonrpc: '2.0', id, method, params });
    });
    return { child, send, request };
}

function textOf(callResult) {
    return (callResult?.result?.content || []).map(c => c.text || '').join('\n');
}

async function main() {
    console.log('\nMCP SERVER SMOKE TEST\n');
    if (!fs.existsSync(path.join(FIXTURE, 'code-index.json'))) {
        console.log('  (skipped — express-js fixture not indexed)\n');
        process.exit(0);
    }

    const srv = startServer();
    try {
        await srv.request(1, 'initialize', {
            protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' },
        });
        srv.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

        const tools = await srv.request(2, 'tools/list', {});
        const names = (tools.result?.tools || []).map(t => t.name);
        check('tools/list exposes the full surface', () => {
            for (const t of ['search_code', 'get_chunk', 'resolve_symbol', 'get_chunk_summary',
                'get_file_skeleton', 'get_call_graph', 'get_repo_map', 'list_index_stats']) {
                assert.ok(names.includes(t), `missing tool: ${t}`);
            }
        });

        const search = await srv.request(3, 'tools/call', {
            name: 'search_code', arguments: { query: 'response json serialize object', top_k: 3, detail: 'signatures' },
        });
        check('search_code returns ranked results', () => {
            const txt = textOf(search);
            assert.ok(/QUERY:/.test(txt), 'no query header');
            assert.ok(/json/i.test(txt), `expected a json-related symbol, got:\n${txt.slice(0, 300)}`);
        });

        const resolve = await srv.request(4, 'tools/call', {
            name: 'resolve_symbol', arguments: { symbol: 'Layer' },
        });
        check('resolve_symbol finds an exact symbol', () => {
            assert.ok(/Layer/.test(textOf(resolve)), 'Layer not resolved');
        });

        const stats = await srv.request(5, 'tools/call', { name: 'list_index_stats', arguments: {} });
        check('list_index_stats reports the in-memory backend', () => {
            const txt = textOf(stats);
            assert.ok(/Storage backend/.test(txt), 'no backend row');
            assert.ok(/In-memory/.test(txt), `expected in-memory backend, got:\n${txt.slice(0, 300)}`);
        });
    } finally {
        srv.child.kill('SIGTERM');
        // Clean up the watch daemon the server spawned in the fixture.
        try {
            const pidFile = path.join(FIXTURE, '.idx-daemon.pid');
            if (fs.existsSync(pidFile)) {
                const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
                try { process.kill(pid, 'SIGTERM'); } catch {}
                fs.unlinkSync(pidFile);
            }
            for (const f of ['.idx-daemon.log']) { try { fs.unlinkSync(path.join(FIXTURE, f)); } catch {} }
        } catch {}
    }

    console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
