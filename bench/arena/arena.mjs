#!/usr/bin/env node
/**
 * The arena: graph-indexer and other code-intelligence tools for agents, measured the same way.
 *
 *   tools      list the MCP tools a configured system exposes (to write its entry)
 *   speed      cold index time and index size per system and repository
 *   exactness  reference accuracy against compiler and type-checker oracles: runs
 *              bench/eval-graph.mjs (TypeScript) and bench/eval-graph-python.mjs (Python) with
 *              --systems, so every tool is scored on the same sample against the same oracle
 *
 *   node bench/arena/arena.mjs tools --system NAME [--repo DIR] [--systems FILE]
 *   node bench/arena/arena.mjs speed --repos DIR[,DIR…] [--systems FILE]
 *   node bench/arena/arena.mjs exactness [--systems FILE] [-- options for the oracle scripts]
 *
 * Sessions (cost, turns and time of real agent runs) use the agentic harness in bench/agentic with
 * one arm per tool; see docs/BENCHMARKS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSystems, startSystem, indexWith, fill } from './mcp-system.mjs';

const fillPath = (p, repo) => fill(p, { repo });

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const systemsFile = path.resolve(opt('--systems', fs.existsSync(path.join(here, 'systems.json')) ? path.join(here, 'systems.json') : path.join(here, 'systems.example.json')));

function dirSize(p) {
    let n = 0;
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st) return 0;
    if (st.isFile()) return st.size;
    for (const e of fs.readdirSync(p)) n += dirSize(path.join(p, e));
    return n;
}

if (cmd === 'tools') {
    const name = opt('--system');
    const sys = loadSystems(systemsFile).find(s => s.name === name);
    if (!sys) { console.error(`No system "${name}" in ${systemsFile}`); process.exit(2); }
    const srv = await startSystem(sys, path.resolve(opt('--repo', repoRoot)));
    try {
        for (const t of await srv.listTools()) console.log(`${t.name}\n  ${(t.description ?? '').replace(/\s+/g, ' ').slice(0, 300)}\n  input: ${JSON.stringify(t.inputSchema?.properties ?? {})}\n`);
    } finally { srv.stop(); }
} else if (cmd === 'speed') {
    const repos = (opt('--repos', '') || '').split(',').filter(Boolean).map(r => path.resolve(r));
    if (!repos.length) { console.error('Pass --repos DIR[,DIR…]'); process.exit(2); }
    const rows = [];
    for (const repo of repos) {
        // graph-indexer itself, cold: an existing index is set aside and put back afterwards
        const dir = path.join(repo, '.graph-indexer'), aside = dir + '.arena-aside';
        if (fs.existsSync(dir)) fs.renameSync(dir, aside);
        try {
            const t = Date.now();
            const r = spawnSync(process.execPath, [path.join(repoRoot, 'bin/graph-indexer.mjs'), 'index', '--repo', repo], { encoding: 'utf8', maxBuffer: 1 << 26 });
            rows.push({ system: 'graph-indexer', repo: path.basename(repo), ms: r.status === 0 ? Date.now() - t : null, note: r.status === 0 ? `${(dirSize(dir) / 1e6).toFixed(1)} MB` : 'failed' });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
            if (fs.existsSync(aside)) fs.renameSync(aside, dir);
        }
        for (const sys of loadSystems(systemsFile).filter(s => s.index && !s.name.startsWith('graph-indexer'))) {
            // cold: the system's index (`indexDir`) is removed first, and rebuilt by the run
            const idx = sys.indexDir ? path.resolve(repo, fillPath(sys.indexDir, repo)) : null;
            if (idx) fs.rmSync(idx, { recursive: true, force: true });
            try { rows.push({ system: sys.name, repo: path.basename(repo), ms: indexWith(sys, repo), note: idx ? `${(dirSize(idx) / 1e6).toFixed(1)} MB` : '' }); }
            catch (e) { rows.push({ system: sys.name, repo: path.basename(repo), ms: null, note: e.message.slice(0, 80) }); }
        }
    }
    console.log('| system | repository | cold index | note |\n|---|---|---|---|');
    for (const r of rows) console.log(`| ${r.system} | ${r.repo} | ${r.ms == null ? '–' : (r.ms / 1000).toFixed(1) + ' s'} | ${r.note} |`);
} else if (cmd === 'exactness') {
    const rest = args.includes('--') ? args.slice(args.indexOf('--') + 1) : [];
    for (const script of ['eval-graph.mjs', 'eval-graph-python.mjs']) {
        console.log(`\n## ${script}`);
        spawnSync(process.execPath, [path.join(repoRoot, 'bench', script), '--systems', systemsFile, ...rest], { stdio: 'inherit' });
    }
} else {
    console.error('Usage: arena.mjs tools|speed|exactness (see the header of bench/arena/arena.mjs)');
    process.exit(2);
}
