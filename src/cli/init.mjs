/**
 * `graph-indexer init`: wire the MCP server into the coding agents used in this repository.
 *
 * Writes project-level MCP configuration (merged, never clobbering other servers) and, unless
 * --no-instructions, a short managed block in AGENTS.md / CLAUDE.md naming the tools and when to
 * use them (a few lines — long generated context files measurably hurt agents). Idempotent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../util/paths.mjs';

const BLOCK_START = '<!-- graph-indexer:start -->';
const BLOCK_END = '<!-- graph-indexer:end -->';
const SNIPPET = `${BLOCK_START}
## Reading and searching code (graph-indexer)
The \`graph-indexer\` MCP server keeps a live index of this repository (re-synced before every answer).
- Explore in one pass: when you need several definitions or files, ask for them together — several tool calls in one message, or one \`read_code\` call with several targets (symbols such as \`Class.method\`, ranges such as \`path:120-180\`) — not one search per turn.
- Read keyholes, not files: the function or the 50–100 lines you need. A long file comes back as its outline, with the line range of every definition.
- Follow names through the index: every read lists where each name the code uses is defined (file:line and signature); read those targets instead of grepping for their definitions.
- Uses of a function, method or class, even when other code shares the name: \`find_references\` (exact call sites; for an interface or class, every type that implements or extends it) rather than grepping the name; callers of callers: \`call_graph\`.
- Text that is not a code name (messages, config keys, strings): grep as usual; \`search_text\` also says which definition each code match refers to.
- Before changing a signature or behaviour other code relies on: \`change_impact\`; after the edit: \`check_changes\`. A fix inside one function needs neither: run the tests that cover it, once.
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

export async function runInit({ opt, flag, repo: repoArg = null }) {
    const repo = path.resolve(repoArg ?? opt('--repo') ?? findRepoRoot(process.cwd()));
    const dryRun = flag('--dry-run');
    const local = flag('--local');
    const hooks = flag('--hooks');
    const noInstructions = flag('--no-instructions');
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
    // Devin Desktop/CLI, Copilot CLI and Cursor also run the Claude Code hooks in .claude/settings.json
    if (hooks && (chosen.includes('claude') || chosen.includes('devin'))) report.push(upsertClaudeHooks(repo, local, dryRun));
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
