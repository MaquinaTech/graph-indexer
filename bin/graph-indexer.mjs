#!/usr/bin/env node
/**
 * graph-indexer CLI.
 *
 *   graph-indexer serve   [--repo DIR]                MCP server on stdio (what agents launch)
 *   graph-indexer index   [--repo DIR]                build / update the index and print stats
 *   graph-indexer init    [--repo DIR] [--agents …]   wire the MCP server into your coding agents
 *   graph-indexer status  [--repo DIR]
 *   graph-indexer search   <query>  [--path P] [--kind K] [--limit N]
 *   graph-indexer symbol   <name>…  [--no-code]
 *   graph-indexer refs     <name>   [--kind K] [--no-tests] [--limit N]
 *   graph-indexer callgraph <name>  [--direction callers|callees|both] [--depth N]
 *   graph-indexer impact   [--symbols a,b] [--files x,y] [--diff] [--depth N]
 *   graph-indexer outline  [path]   [--focus TEXT] [--max-tokens N]
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
    const intel = await openIntel({ quiet: true });
    const { callTool } = await import('../src/mcp/tools.mjs');
    try {
        const outs = [];
        for (const [name, args] of calls) outs.push(await callTool(intel, name, args, { cli: true }));
        process.stdout.write(outs.join('\n\n') + '\n');
    } finally { intel.close(); }
}

const HELP = `graph-indexer ${pkg.version} — live code graph & search for AI coding agents (MCP)

Usage:
  graph-indexer init [--repo DIR] [--agents claude,cursor,vscode,gemini,codex] [--all] [--hooks] [--local] [--dry-run] [--no-instructions]
  graph-indexer serve [--repo DIR]          start the MCP server on stdio
  graph-indexer index [--repo DIR]          build or update the index
  graph-indexer status [--repo DIR]
  graph-indexer search <query> [--path P] [--kind K] [--limit N]
  graph-indexer grep <regex> [--path P] [--literal|-F] [-i] [--limit N]
  graph-indexer symbol <name>… [--no-code]         one or several definitions
  graph-indexer refs <name> [--kind call|type|inherit|new|value|decorator] [--no-tests]
  graph-indexer callgraph <name> [--direction callers|callees|both] [--depth N]
  graph-indexer impact [--symbols a,b] [--files x,y] [--diff] [--depth N]
  graph-indexer outline [path] [--focus TEXT] [--max-tokens N]
  graph-indexer check [--files x,y] [--base REV]     verify uncommitted edits
  graph-indexer hook post-tool|session-start|subagent-start   agent hook (JSON on stdin)

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
        case 'symbol': {
            const noCode = flag('--no-code'); const maxLines = Number(opt('--max-lines', 200));
            // `symbol A B C` reads several definitions in one call
            const targets = argv.filter(a => !a.startsWith('--'));
            return runTools((targets.length ? targets : ['']).map(t => ['get_symbol', { symbol: t, include_code: !noCode, max_lines: maxLines }]));
        }
        case 'refs': {
            const kind = opt('--kind', 'all'); const noTests = flag('--no-tests'); const limit = Number(opt('--limit', 80));
            return runTool('find_references', { symbol: argv.join(' '), kind, include_tests: !noTests, limit });
        }
        case 'callgraph': {
            const direction = opt('--direction', 'both'); const depth = Number(opt('--depth', 2)); const limit = Number(opt('--limit', 40));
            return runTool('call_graph', { symbol: argv.join(' '), direction, depth, limit });
        }
        case 'impact': {
            const symbols = (opt('--symbols') ?? '').split(',').filter(Boolean);
            const files = (opt('--files') ?? '').split(',').filter(Boolean);
            const diff = flag('--diff'); const depth = Number(opt('--depth', 3));
            return runTool('change_impact', { symbols, files, diff, depth });
        }
        case 'hook': {
            const { runHook } = await import('../src/cli/hook.mjs');
            return runHook(argv.shift() ?? '', { repo: repoArg });
        }
        case 'check': {
            const files = (opt('--files') ?? '').split(',').filter(Boolean); const base = opt('--base', 'HEAD');
            return runTool('check_changes', { files, base });
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
