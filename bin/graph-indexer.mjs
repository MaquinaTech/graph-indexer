#!/usr/bin/env node
/**
 * graph-indexer CLI.
 *
 *   graph-indexer serve   [--repo DIR]                MCP server on stdio (what agents launch)
 *   graph-indexer index   [--repo DIR]                build / update the index and print stats
 *   graph-indexer init    [--repo DIR] [--agents …]   wire the MCP server into your coding agents
 *   graph-indexer status  [--repo DIR]
 *   graph-indexer search   <query>  [--path P] [--kind K] [--limit N]
 *   graph-indexer read     <target>… [--full]           symbols, file:START-END ranges or files, with the
 *                                                        definitions each one uses
 *   graph-indexer symbol   <name>…  [--no-code]
 *   graph-indexer refs     <name>   [--kind K] [--path P] [--no-tests] [--limit N]
 *   graph-indexer callgraph <name>  [--direction callers|callees|both] [--depth N] [--no-tests]
 *   graph-indexer impact   [--symbols a,b] [--files x,y] [--diff] [--depth N]
 *   graph-indexer outline  [path]   [--focus TEXT] [--max-tokens N]
 *   graph-indexer files    <text|glob> [--path P]
 *
 * The query commands print exactly what the MCP tools return, so humans (and agents limited to a
 * shell) get the same answers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const aliasOf = { 'idx-mcp': 'serve', 'idx-index': 'index', mcp: 'serve', references: 'refs', 'call-graph': 'callgraph', map: 'outline' };
const invokedAs = path.basename(process.argv[1] || '').replace(/\.m?js$/, '');
let cmd = aliasOf[invokedAs] ?? null;
if (!cmd && argv.length && !argv[0].startsWith('-')) { const c = argv.shift(); cmd = aliasOf[c] ?? c; }

function flag(name) { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; }
function opt(name, dflt = null) {
    const i = argv.indexOf(name);
    if (i < 0) return dflt;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
}

const log = (m) => process.stderr.write(`[graph-indexer] ${m}\n`);
// global options are consumed before any command joins the remaining words into a query
const repoArg = opt('--repo') ?? process.env.GRAPH_INDEXER_REPO ?? process.env.MCP_PROJECT_ROOT ?? null;

async function openIntel({ watch = false, background = false, quiet = false } = {}) {
    const { CodeIntel } = await import('../src/query/intel.mjs');
    const { findRepoRoot } = await import('../src/util/paths.mjs');
    const root = repoArg ? path.resolve(repoArg) : findRepoRoot(process.cwd());
    const intel = new CodeIntel({ root, log, watch });
    let last = 0;
    const onProgress = quiet ? null : (d, n) => {
        const now = Date.now();
        if (now - last > 1000 || d === n) { last = now; process.stderr.write(`\r[graph-indexer] indexing ${d}/${n} files`); if (d === n) process.stderr.write('\n'); }
    };
    await intel.open({ onProgress, background });
    return intel;
}

/** Options left over after a command took its own are typos, not part of the query. */
function rejectUnknownOptions() {
    const bad = argv.filter(a => /^--?[A-Za-z][\w-]*$/.test(a));
    if (!bad.length) return false;
    process.stderr.write(`Unknown option${bad.length > 1 ? 's' : ''} for "${cmd}": ${bad.join(' ')}\n\n${HELP}\n`);
    process.exitCode = 2;
    return true;
}

async function runTool(name, args) {
    return runTools([[name, args]]);
}

/** Several tool calls against one open index (e.g. `symbol A B C`), outputs separated by a blank line. */
async function runTools(calls) {
    if (rejectUnknownOptions()) return;
    // a resident process (MCP server or daemon) answers without opening and syncing the index again
    const { findRepoRoot } = await import('../src/util/paths.mjs');
    const { askResident, residentRequired } = await import('../src/cli/resident.mjs');
    const root = repoArg ? path.resolve(repoArg) : findRepoRoot(process.cwd());
    const reply = await askResident(root, { op: 'tool', calls }, { version: pkg.version, totalMs: 60_000 });
    if (reply && typeof reply.out === 'string') { process.stdout.write(reply.out + '\n'); return; }
    if (residentRequired()) { process.stderr.write('graph-indexer: no resident process answers for this repository\n'); process.exitCode = 3; return; }
    const intel = await openIntel({ quiet: true });
    const { callTool } = await import('../src/mcp/tools.mjs');
    try {
        const outs = [];
        for (const [name, args] of calls) outs.push(await callTool(intel, name, args, { cli: true }));
        process.stdout.write(outs.join('\n\n') + '\n');
    } finally { intel.close(); }
}

/**
 * Answer hooks and CLI queries for this index over the repository's local socket (see
 * src/cli/resident.mjs). Resolves to null when another process already does.
 */
async function serveResident(intel, { idleMs = 0, onIdle = null } = {}) {
    const { startResident } = await import('../src/cli/resident.mjs');
    const hold = async () => ({ intel, release() {} });
    return startResident({
        root: intel.root, version: pkg.version, log, idleMs, onIdle,
        wanted: () => fs.existsSync(intel.dbPath),
        handle: async (req) => {
            if (req.op === 'hook') {
                const { handleHook } = await import('../src/cli/hook.mjs');
                return handleHook(String(req.event ?? ''), req.input ?? {}, { root: intel.root, acquire: hold });
            }
            if (req.op === 'tool' && Array.isArray(req.calls)) {
                const { callTool } = await import('../src/mcp/tools.mjs');
                const outs = [];
                for (const [name, args] of req.calls) outs.push(await callTool(intel, name, args ?? {}, { cli: true }));
                return outs.join('\n\n');
            }
            return null;
        },
    });
}

const HELP = `graph-indexer ${pkg.version} — live code graph & search for AI coding agents (MCP)

Usage:
  graph-indexer init [--repo DIR] [--agents claude,cursor,vscode,gemini,codex] [--all] [--hooks] [--local] [--dry-run] [--no-instructions]
  graph-indexer serve [--repo DIR]          start the MCP server on stdio
  graph-indexer index [--repo DIR]          build or update the index
  graph-indexer status [--repo DIR]
  graph-indexer search <query> [--path P] [--kind K] [--limit N]
  graph-indexer grep <regex> [--path P] [--literal|-F] [-i] [--limit N]
  graph-indexer files <text|glob> [--path P] [--limit N]    find files by path or name
  graph-indexer read <target>… [--full] [--max-lines N]   symbols (Class.method), ranges (file:10-80) or files,
                                                   with where each name they use is defined
  graph-indexer symbol <name>… [--no-code]         one or several definitions
  graph-indexer refs <name> [--kind call|type|inherit|new|value|decorator] [--path P] [--no-tests]
  graph-indexer callgraph <name> [--direction callers|callees|both] [--depth N] [--no-tests]
  graph-indexer impact [--symbols a,b] [--files x,y] [--diff] [--depth N]
  graph-indexer outline [path] [--focus TEXT] [--max-tokens N]
  graph-indexer check [--files x,y] [--base REV]     verify uncommitted edits
  graph-indexer hook post-tool|session-start|subagent-start   agent hook (JSON on stdin)
  graph-indexer daemon [--idle-minutes N]           keep the index open for hooks and CLI queries
                                                   (the hooks start it; the MCP server does the same)

The index lives in <repo>/.graph-indexer/ and is kept in sync automatically.`;

async function main() {
    if (!cmd || cmd === 'help' || flag('--help') || flag('-h')) { process.stdout.write(HELP + '\n'); return; }
    if (cmd === 'version' || flag('--version')) { process.stdout.write(pkg.version + '\n'); return; }
    switch (cmd) {
        case 'serve': {
            const intel = await openIntel({ watch: true, background: true, quiet: true });
            const { McpServer } = await import('../src/mcp/server.mjs');
            const server = new McpServer({ intel, version: pkg.version, log, ready: intel.ready });
            intel.ready.then((r) => log(`index ready: ${r.total} files (${r.added} added, ${r.changed} changed, ${r.removed} removed) in ${r.ms} ms`)).catch((e) => log(`indexing failed: ${e.stack || e.message}`));
            server.onClose = () => { intel.close(); process.exit(0); };
            server.listen();
            for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { intel.close(); process.exit(0); });
            serveResident(intel).catch((e) => log(`resident: ${e.message}`));
            return;
        }
        case 'daemon': {
            // the resident for hooks and CLI queries when no MCP server runs; the hooks start it
            const idle = Math.max(1, Number(opt('--idle-minutes', 30)));
            const { findRepoRoot } = await import('../src/util/paths.mjs');
            const { askResident } = await import('../src/cli/resident.mjs');
            const root = repoArg ? path.resolve(repoArg) : findRepoRoot(process.cwd());
            if (await askResident(root, { op: 'ping' }, { version: pkg.version })) return; // already served
            const intel = await openIntel({ watch: true, quiet: true });
            const stop = () => { intel.close(); process.exit(0); };
            const res = await serveResident(intel, { idleMs: idle * 60_000, onIdle: stop });
            if (!res) { intel.close(); return; }
            for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, stop);
            return;
        }
        case 'index': {
            const t0 = Date.now();
            const intel = await openIntel();
            const st = intel.stats();
            const r = intel.lastSyncStats;
            process.stdout.write(`indexed ${st.root}\n  ${st.files} files · ${st.symbols} symbols · ${st.refs} references (${st.resolved} resolved, ${st.exact} exact)\n  this run: ${r.added} added, ${r.changed} changed, ${r.removed} removed in ${Date.now() - t0} ms\n  languages: ${st.langs.map(l => `${l.lang} ${l.n}`).join(', ')}\n`);
            intel.close();
            return;
        }
        case 'status': {
            const intel = await openIntel({ quiet: true });
            const st = intel.stats();
            process.stdout.write(JSON.stringify({ version: pkg.version, ...st, db: intel.dbPath }, null, 2) + '\n');
            intel.close();
            return;
        }
        case 'init': {
            const { runInit } = await import('../src/cli/init.mjs');
            await runInit({ argv, opt, flag, log, version: pkg.version, repo: repoArg });
            return;
        }
        case 'search': {
            const pathF = opt('--path'); const kind = opt('--kind'); const limit = Number(opt('--limit', 8));
            return runTool('search_code', { query: argv.join(' '), path: pathF, kind, limit });
        }
        case 'grep': {
            const pathF = opt('--path'); const literal = flag('--literal') || flag('-F'); const ic = flag('-i') || flag('--ignore-case'); const limit = Number(opt('--limit', 60));
            const pattern = argv.shift();
            return runTool('search_text', { pattern, path: pathF, literal, ignore_case: ic, limit });
        }
        case 'read': {
            const full = flag('--full'); const maxLines = Number(opt('--max-lines', 200));
            const targets = argv.filter(a => !a.startsWith('--'));
            argv.length = 0;
            return runTool('read_code', { targets, full, max_lines: maxLines });
        }
        case 'symbol': {
            const noCode = flag('--no-code'); const maxLines = Number(opt('--max-lines', 200));
            // `symbol A B C` reads several definitions in one call
            const targets = argv.filter(a => !a.startsWith('--'));
            return runTools((targets.length ? targets : ['']).map(t => ['get_symbol', { symbol: t, include_code: !noCode, max_lines: maxLines }]));
        }
        case 'refs': {
            const kind = opt('--kind', 'all'); const noTests = flag('--no-tests'); const limit = Number(opt('--limit', 80)); const pathF = opt('--path');
            return runTool('find_references', { symbol: argv.join(' '), kind, include_tests: !noTests, limit, ...(pathF ? { path: pathF } : {}) });
        }
        case 'callgraph': {
            const direction = opt('--direction', 'both'); const depth = Number(opt('--depth', 2)); const limit = Number(opt('--limit', 40)); const noTests = flag('--no-tests');
            return runTool('call_graph', { symbol: argv.join(' '), direction, depth, limit, include_tests: !noTests });
        }
        case 'impact': {
            const symbols = (opt('--symbols') ?? '').split(',').filter(Boolean);
            const files = (opt('--files') ?? '').split(',').filter(Boolean);
            const diff = flag('--diff'); const depth = Number(opt('--depth', 3));
            return runTool('change_impact', { symbols, files, diff, depth });
        }
        case 'hook': {
            const { runHook } = await import('../src/cli/hook.mjs');
            return runHook(argv.shift() ?? '', { repo: repoArg, version: pkg.version });
        }
        case 'check': {
            const files = (opt('--files') ?? '').split(',').filter(Boolean); const base = opt('--base', 'HEAD');
            return runTool('check_changes', { files, base });
        }
        case 'files': {
            const pathF = opt('--path'); const limit = Number(opt('--limit', 100));
            return runTool('find_files', { pattern: argv.join(' '), path: pathF, limit });
        }
        case 'outline': {
            const focus = opt('--focus'); const maxTokens = Number(opt('--max-tokens', 1500));
            return runTool('outline', { path: argv[0] ?? '', focus, max_tokens: maxTokens });
        }
        default:
            process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}\n`);
            process.exitCode = 2;
    }
}

main().catch((e) => { process.stderr.write(`graph-indexer: ${e.stack || e.message}\n`); process.exit(1); });
