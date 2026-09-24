/**
 * graph-indexer 2.x through its own MCP server, for the v2 comparisons (bench/eval-graph.mjs
 * --v2, bench/agentic/v2.mjs). The 2.x tree is a checkout of the last 2.x release with its
 * dependencies installed:
 *
 *   git worktree add --detach ~/.gi-agentic/v2 v2.1.1 && (cd ~/.gi-agentic/v2 && npm ci)
 *
 * The 2.x server starts a watch daemon for the repository on launch (as it did for users); stop()
 * stops it again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export function buildIndexV2(v2Root, repo) {
    const r = spawnSync(process.execPath, [path.join(v2Root, 'indexer.mjs'), '--repo', repo], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 3_600_000 });
    if (r.status !== 0) throw new Error(`2.x indexing of ${repo} failed: ${(r.stderr ?? '').slice(-400)}`);
}

export function hasIndexV2(repo) {
    const dir = path.join(repo, '.graph-indexer');
    return fs.existsSync(path.join(dir, 'code-index.json')) || fs.existsSync(path.join(dir, 'code-index.db'));
}

export async function startV2(v2Root, repo) {
    const child = spawn(process.execPath, [path.join(v2Root, 'mcp-server.mjs'), '--repo', repo], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MCP_PROJECT_ROOT: repo } });
    let buf = '', next = 1;
    const pending = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            const p = pending.get(msg.id);
            if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
        }
    });
    child.stderr.on('data', () => { });
    const request = (method, params) => new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gi-bench', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return {
        listTools: () => request('tools/list', {}),
        /** The tool's text answer. */
        call: async (name, args) => (await request('tools/call', { name, arguments: args })).content?.map(c => c.text ?? '').join('\n') ?? '',
        stop() {
            child.kill();
            spawnSync(process.execPath, [path.join(v2Root, 'daemon-ctl.mjs'), 'stop', '--repo', repo], { encoding: 'utf8', timeout: 30_000 });
        },
    };
}

/** Tool results, measured on real transcripts (bench/agentic/anatomy.mjs). */
export const CHARS_PER_TOKEN = 2.63;

/**
 * 2.x as a system in the reference-accuracy harnesses: for each sampled symbol its find_references
 * (the name, scoped to the owning class for a method), and the size of both versions' default text
 * answers. 2.x answers with referencing chunks (function, method or whole class), not lines: a
 * chunk's lines are those that contain the name as a word — what an agent finds reading the chunks
 * it names. `refs(sym, { highOnly })` leaves out what 2.x marks unverified.
 */
export async function v2Comparison({ v2Root, root, sample, intel, fileRe, linesOf, reindex = false, callTool }) {
    if (!hasIndexV2(root) || reindex) { const t = Date.now(); buildIndexV2(v2Root, root); console.log(`2.x index built in ${Date.now() - t} ms`); }
    const cardsOf = new Map(), answers = { 'graph-indexer': [], v2: [] };
    const v2 = await startV2(v2Root, root);
    try {
        for (const sym of sample) {
            const owner = sym.kind === 'method' && sym.qname.includes('.') ? sym.qname.slice(0, sym.qname.lastIndexOf('.')).split('.').pop() : null;
            const a = { symbol: sym.name, ...(owner ? { target_class: owner } : {}) };
            const json = JSON.parse(await v2.call('find_references', { ...a, response_format: 'json' }));
            answers.v2.push((await v2.call('find_references', a)).length / CHARS_PER_TOKEN);
            cardsOf.set(sym.id, [...json.called_by.high, ...json.called_by.name_only, ...json.subclassed_by, ...json.used_as_type_by, ...(json.referenced_by_resolved ?? [])]);
        }
    } finally { v2.stop(); }
    for (const sym of sample) answers['graph-indexer'].push((await callTool(intel, 'find_references', { symbol: `${sym.path}:${sym.name_line}` })).length / CHARS_PER_TOKEN);
    const refs = (sym, { highOnly = false } = {}) => {
        const re = new RegExp(`\\b${sym.name.replace(/[$]/g, '\\$')}\\b`);
        const out = new Set();
        for (const c of cardsOf.get(sym.id) ?? []) {
            if ((highOnly && c.confidence === 'name-only') || !fileRe.test(c.file_path)) continue;
            const lines = linesOf(c.file_path);
            for (let i = Math.max(1, c.start_line); i <= Math.min(lines.length, c.end_line); i++) {
                const l = lines[i - 1];
                if (re.test(l) && !/^\s*import\b/.test(l) && !/^\s*export\b.*\bfrom\b/.test(l)) out.add(`${c.file_path}:${i}`);
            }
        }
        out.delete(`${sym.path}:${sym.name_line}`);
        return out;
    };
    return { refs, answers };
}

/** Mean, median and 90th percentile of answer sizes, printed and returned. */
export function answerSizes(answers) {
    const out = {};
    for (const [k, xs] of Object.entries(answers)) if (xs.length) {
        const s = [...xs].sort((a, b) => a - b);
        out[k] = { mean: xs.reduce((a, b) => a + b, 0) / xs.length, median: s[Math.floor((s.length - 1) / 2)], p90: s[Math.floor(0.9 * (s.length - 1))] };
    }
    if (Object.keys(out).length) {
        console.log('\nfind_references answer size (tokens, the default text answer)');
        for (const [k, a] of Object.entries(out)) console.log(`${k.padEnd(15)} mean ${Math.round(a.mean)}  median ${Math.round(a.median)}  p90 ${Math.round(a.p90)}`);
    }
    return out;
}
