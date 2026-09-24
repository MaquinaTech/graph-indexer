/**
 * `graph-indexer init`: wire the MCP server into the coding agents used in this repository.
 *
 * Writes project-level MCP configuration (merged, never clobbering other servers) and, unless
 * --no-instructions, a short managed block in AGENTS.md / CLAUDE.md naming the tools and when to
 * use them (a few lines — long generated context files measurably hurt agents). For Claude Code it
 * also writes, unless --no-helper, the structural helper sub-agent (.claude/agents/code-structure.md,
 * src/cli/helper.mjs). Idempotent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../util/paths.mjs';
import { HELPER_NAME, claudeAgentFile } from './helper.mjs';

const BLOCK_START = '<!-- graph-indexer:start -->';
const BLOCK_END = '<!-- graph-indexer:end -->';
// The lookup rules first, then graph-indexer for what a text search cannot answer exactly: the
// arrangement that cost least in the fourth benchmark round (docs/AGENTIC-BENCHMARK.md). Sending
// every read and search through graph-indexer cost more on issue fixes than the rules alone.
const SNIPPET = `${BLOCK_START}
## Looking code up (graph-indexer)
- Explore in one pass: when you need several definitions or files, ask for them together — several tool calls in one message, or one search with alternatives — not one search per turn.
- Read keyholes, not files: the function or the 50–100 lines you need (find the line first, then read that range).
- To find where a name is defined, search for its definition line (\`def name\`, \`class Name\`, \`function name\`) across the package in one search, not directory by directory.
- Check once: run the tests that cover your change when you are done; do not re-run a check nothing has changed.

The \`graph-indexer\` MCP server keeps a live index of this repository — definitions, references, call graph, tests — re-synced before every answer. Use it for what a text search cannot answer exactly:
- Uses of a function, method or class, even when other code shares its name: \`find_references\` (exact call sites; it says when the list is complete). Callers of callers: \`call_graph\`. Classes that implement or extend a type: \`find_references\` with kind \`inherit\`.
- Before changing a signature or behaviour other code relies on: \`change_impact\`. When you are done: \`check_changes\` says what your edit broke, which subclasses inherit the changed code and which tests are closest to it — run those.
- A definition your search did not find: \`read_code\` with its name.
${BLOCK_END}`;

/** The managed instructions block `init` writes to CLAUDE.md / AGENTS.md (markers included). */
export function managedBlock() { return SNIPPET; }

const AGENTS = {
    claude: { label: 'Claude Code', file: '.mcp.json', key: 'mcpServers', detect: ['.claude', 'CLAUDE.md', '.mcp.json'], instructions: 'CLAUDE.md' },
    cursor: { label: 'Cursor', file: '.cursor/mcp.json', key: 'mcpServers', detect: ['.cursor', '.cursorrules'], instructions: 'AGENTS.md', workspaceVar: '${workspaceFolder}' },
    vscode: { label: 'VS Code (Copilot)', file: '.vscode/mcp.json', key: 'servers', detect: ['.vscode'], instructions: 'AGENTS.md', workspaceVar: '${workspaceFolder}', vscode: true },
    gemini: { label: 'Gemini CLI', file: '.gemini/settings.json', key: 'mcpServers', detect: ['.gemini', 'GEMINI.md'], instructions: 'AGENTS.md' },
    codex: { label: 'Codex CLI', file: null, detect: ['AGENTS.md', '.codex'], instructions: 'AGENTS.md' },
    // Kilo Code (CLI and VS Code, rebuilt on OpenCode) also reads opencode.json; an existing kilo.json is used instead
    opencode: { label: 'OpenCode / Kilo Code', file: 'opencode.json', alt: ['kilo.json', '.kilo/kilo.json'], key: 'mcp', detect: ['opencode.json', 'opencode.jsonc', '.opencode', 'kilo.json', 'kilo.jsonc', '.kilo', '.kilocode'], instructions: 'AGENTS.md', opencode: true },
    junie: { label: 'Junie', file: '.junie/mcp/mcp.json', key: 'mcpServers', detect: ['.junie'], instructions: 'AGENTS.md' },
    // Zed runs project context servers in the project root; it reads the first of .rules, …, AGENTS.md, CLAUDE.md
    zed: { label: 'Zed', file: '.zed/settings.json', key: 'context_servers', detect: ['.zed'], instructions: 'AGENTS.md', zed: true },
    // Devin Desktop (formerly Windsurf) and Devin CLI load the Claude Code hooks in .claude/ by default
    devin: { label: 'Devin Desktop / Devin CLI', file: null, detect: ['.devin', '.windsurf', '.windsurfrules'], instructions: 'AGENTS.md' },
};

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '')); } catch { return null; }
}

function serverEntry(agent, { local }) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bin = path.resolve(here, '../../bin/graph-indexer.mjs');
    const repoArgs = agent.workspaceVar ? ['--repo', agent.workspaceVar] : [];
    const base = local
        ? { command: process.execPath, args: [bin, 'serve', ...repoArgs] }
        : { command: 'npx', args: ['-y', 'graph-indexer@3', 'serve', ...repoArgs] };
    if (agent.opencode) return { type: 'local', command: [base.command, ...base.args], enabled: true };
    if (agent.zed) return { ...base, env: {} };
    return agent.vscode ? { type: 'stdio', ...base } : base;
}

/** The config file to edit: the agent's default, or an existing alternative it also reads. */
function configFile(agent, repo) {
    for (const f of agent.alt ?? []) if (fs.existsSync(path.join(repo, f))) return f;
    return agent.file;
}

function upsertBlock(file, dryRun) {
    const exists = fs.existsSync(file);
    const text = exists ? fs.readFileSync(file, 'utf8') : '';
    let next;
    if (text.includes(BLOCK_START) && text.includes(BLOCK_END)) {
        next = text.replace(new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}`), SNIPPET);
    } else {
        next = (text.trimEnd() ? text.trimEnd() + '\n\n' : '') + SNIPPET + '\n';
    }
    if (next === text) return 'unchanged';
    if (!dryRun) fs.writeFileSync(file, next);
    return exists ? 'updated' : 'created';
}

/** An installed `graph-indexer` executable on PATH, if any (hooks start in ~0.1 s instead of npx's ~1 s). */
function installedBin() {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const f = path.join(dir, process.platform === 'win32' ? 'graph-indexer.cmd' : 'graph-indexer');
        try { if (fs.statSync(f).isFile()) return f; } catch { /* not here */ }
    }
    return null;
}

/** The command agents run for graph-indexer: this installation with --local, an installed binary, or npx. */
function cliCommand(local) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bin = path.resolve(here, '../../bin/graph-indexer.mjs');
    if (local) return `${JSON.stringify(process.execPath)} ${JSON.stringify(bin)}`;
    const installed = installedBin();
    return installed ? JSON.stringify(installed) : 'npx -y graph-indexer@3';
}

/** The command that starts graph-indexer, as an argv array (for the OpenCode/Kilo Code plugin). */
function cliArgv(local) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    if (local) return [process.execPath, path.resolve(here, '../../bin/graph-indexer.mjs')];
    const installed = installedBin();
    return installed ? [installed] : ['npx', '-y', 'graph-indexer@3'];
}

/**
 * The OpenCode / Kilo Code plugin (integrations/opencode/graph-indexer.js): after reads, searches
 * and edits it appends what the Claude Code hooks add as context. Kilo Code loads project plugins
 * from .kilo/plugin/, OpenCode from .opencode/plugins/.
 */
function writeOpenCodePlugin(repo, local, dryRun) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, '../../integrations/opencode/graph-indexer.js'), 'utf8')
        .replace(/^const DAEMON = .*$/m, `const DAEMON = ${JSON.stringify([...cliArgv(local), 'daemon'])};`);
    const kilo = ['kilo.json', 'kilo.jsonc', '.kilo', '.kilocode'].some(f => fs.existsSync(path.join(repo, f)));
    const open = ['opencode.json', 'opencode.jsonc', '.opencode'].some(f => fs.existsSync(path.join(repo, f)));
    const targets = [...(kilo ? ['.kilo/plugin/graph-indexer.js'] : []), ...(open || !kilo ? ['.opencode/plugins/graph-indexer.js'] : [])];
    const out = [];
    for (const rel of targets) {
        const file = path.join(repo, rel);
        const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === src;
        if (!same && !dryRun) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, src);
        }
        out.push(`${same ? 'already in' : 'written to'} ${rel}`);
    }
    return `OpenCode / Kilo Code plugin (definitions after reads, missed definitions, edit check): ${out.join(', ')}`;
}

/**
 * Claude Code hooks (project .claude/settings.json), merged with existing ones: after edits the
 * edit checker runs on the edited file, after a grep for a shared identifier the definitions are
 * told apart, and sessions/subagents learn in one line that the index exists. Silent otherwise.
 */
function upsertClaudeHooks(repo, local, dryRun) {
    const file = path.join(repo, '.claude', 'settings.json');
    const cfg = readJson(file) ?? {};
    const cmd = cliCommand(local);
    const ours = (h) => /graph-indexer(\.mjs|\.cmd)?"?(@\d+)? hook /.test(h?.command ?? '');
    const want = {
        PostToolUse: { matcher: 'Edit|Write|MultiEdit|Grep|Bash|Read', hooks: [{ type: 'command', command: `${cmd} hook post-tool`, timeout: 10 }] },
        SessionStart: { hooks: [{ type: 'command', command: `${cmd} hook session-start`, timeout: 10 }] },
        SubagentStart: { hooks: [{ type: 'command', command: `${cmd} hook subagent-start`, timeout: 10 }] },
    };
    cfg.hooks ??= {};
    const before = JSON.stringify(cfg.hooks);
    for (const [event, entry] of Object.entries(want)) {
        const list = (cfg.hooks[event] ?? []).map(e => ({ ...e, hooks: (e.hooks ?? []).filter(h => !ours(h)) })).filter(e => e.hooks.length);
        list.push(entry);
        cfg.hooks[event] = list;
    }
    const changed = before !== JSON.stringify(cfg.hooks);
    if (changed && !dryRun) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    }
    return `Claude Code hooks: ${changed ? 'written to' : 'already in'} .claude/settings.json (post-edit check, grep disambiguation, session line)`;
}

/**
 * The structural helper for Claude Code (.claude/agents/code-structure.md). A file of that name the
 * user wrote is left alone; an earlier version of ours is updated.
 */
function upsertClaudeHelper(repo, dryRun) {
    const rel = `.claude/agents/${HELPER_NAME}.md`;
    const file = path.join(repo, rel);
    const want = claudeAgentFile();
    const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (have === want) return `Claude Code: structural helper already in ${rel}`;
    if (have != null && !have.includes("graph-indexer's index")) return `Claude Code: ${rel} exists and is not graph-indexer's, so it was left as is`;
    if (!dryRun) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, want);
    }
    return `Claude Code: structural helper ${have == null ? 'written to' : 'updated in'} ${rel} (a sub-agent on a small model that answers call-site, caller, subclass and impact questions from the index)`;
}

export async function runInit({ opt, flag, repo: repoArg = null }) {
    const repo = path.resolve(repoArg ?? opt('--repo') ?? findRepoRoot(process.cwd()));
    const dryRun = flag('--dry-run');
    const local = flag('--local');
    const hooks = flag('--hooks');
    const noInstructions = flag('--no-instructions');
    const noHelper = flag('--no-helper');
    const all = flag('--all');
    const agentList = opt('--agents');
    let chosen;
    if (agentList) chosen = agentList.split(',').map(s => s.trim()).filter(k => AGENTS[k]);
    else if (all) chosen = Object.keys(AGENTS);
    else {
        chosen = Object.entries(AGENTS).filter(([, a]) => a.detect.some(d => fs.existsSync(path.join(repo, d)))).map(([k]) => k);
        if (!chosen.length) chosen = ['claude'];
    }
    const report = [];
    for (const key of chosen) {
        const a = AGENTS[key];
        if (a.file) {
            const rel = configFile(a, repo);
            const file = path.join(repo, rel);
            const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
            const entry = serverEntry(a, { local });
            // never rewrite a file whose comments or JSONC syntax a JSON round trip would lose
            const cfg = raw == null ? {} : readJson(file);
            if (!cfg || /^\s*\/\/|\/\*/m.test(raw ?? '')) {
                const already = JSON.stringify(cfg?.[a.key]?.['graph-indexer'] ?? null) === JSON.stringify(entry);
                report.push(already ? `${a.label}: already configured ${rel}`
                    : `${a.label}: ${rel} has comments or is not plain JSON, so it was left as is; add under "${a.key}": "graph-indexer": ${JSON.stringify(entry)}`);
                continue;
            }
            cfg[a.key] ??= {};
            const before = JSON.stringify(cfg[a.key]['graph-indexer'] ?? null);
            cfg[a.key]['graph-indexer'] = entry;
            const changed = before !== JSON.stringify(entry);
            if (changed && !dryRun) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
            }
            report.push(`${a.label}: ${changed ? (before === 'null' ? 'added' : 'updated') : 'already configured'} ${rel}`);
        } else if (key === 'codex') {
            const entry = serverEntry(a, { local });
            report.push(`Codex CLI: add to ~/.codex/config.toml →\n  [mcp_servers.graph-indexer]\n  command = "${entry.command}"\n  args = ${JSON.stringify(entry.args)}\n  cwd = "${repo}"`);
        } else if (key === 'devin') {
            const entry = serverEntry(a, { local });
            report.push(`Devin: reads AGENTS.md${hooks ? ' and the Claude Code hooks in .claude/settings.json' : ' (and, with --hooks, the Claude Code hooks)'}; add the MCP server in Devin's MCP settings → command "${entry.command}", args ${JSON.stringify([...entry.args, '--repo', repo])}`);
        }
    }
    if (!noHelper && chosen.includes('claude')) report.push(upsertClaudeHelper(repo, dryRun));
    // Devin Desktop/CLI, Copilot CLI and Cursor also run the Claude Code hooks in .claude/settings.json
    if (hooks && (chosen.includes('claude') || chosen.includes('devin'))) report.push(upsertClaudeHooks(repo, local, dryRun));
    if (hooks && chosen.includes('opencode')) report.push(writeOpenCodePlugin(repo, local, dryRun));
    if (!noInstructions) {
        const targets = [...new Set(chosen.map(k => AGENTS[k].instructions))];
        for (const t of targets) report.push(`${t}: ${upsertBlock(path.join(repo, t), dryRun)} graph-indexer instructions block`);
    }
    // keep the index out of version control
    const gi = path.join(repo, '.gitignore');
    const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!/^\/?\.graph-indexer\/?$/m.test(giText)) {
        if (!dryRun) fs.writeFileSync(gi, (giText.trimEnd() ? giText.trimEnd() + '\n' : '') + '.graph-indexer/\n');
        report.push('.gitignore: added .graph-indexer/');
    }
    process.stdout.write(`graph-indexer init ${dryRun ? '(dry run) ' : ''}in ${repo}\n  ${report.join('\n  ')}\n\n` +
        `Other agents (Claude Desktop, JetBrains AI Assistant, Cline): add an MCP server with command "npx" and args ["-y","graph-indexer@3","serve","--repo","${repo}"].\n` +
        `Build the index now with: npx graph-indexer index   (the server also builds it on first start)\n` +
        (hooks ? '' : `Optional: graph-indexer init --hooks adds Claude Code hooks (edit check after each edit, grep disambiguation).\n`));
}
