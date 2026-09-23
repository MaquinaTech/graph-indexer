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
## Code navigation (graph-indexer)
The \`graph-indexer\` MCP server keeps a live index of this repository (re-synced before every answer).
- Uses of a function, method or class, even when other code shares the name: \`find_references\` (exact call sites) rather than grepping the name.
- Identifiers, strings or config across all files: \`search_text\` — grep output plus the definition each code match refers to.
- Before changing a signature, renaming, removing, or changing behaviour others rely on: \`change_impact\`; after such an edit: \`check_changes\` (calls that no longer fit, removed names still in use, tests to run). A fix inside one function needs neither: run its tests.
- Code for a behaviour described in words: \`search_code\`, then \`get_symbol\` to read one definition.
${BLOCK_END}`;

const AGENTS = {
    claude: { label: 'Claude Code', file: '.mcp.json', key: 'mcpServers', detect: ['.claude', 'CLAUDE.md', '.mcp.json'], instructions: 'CLAUDE.md' },
    cursor: { label: 'Cursor', file: '.cursor/mcp.json', key: 'mcpServers', detect: ['.cursor', '.cursorrules'], instructions: 'AGENTS.md', workspaceVar: '${workspaceFolder}' },
    vscode: { label: 'VS Code (Copilot)', file: '.vscode/mcp.json', key: 'servers', detect: ['.vscode'], instructions: 'AGENTS.md', workspaceVar: '${workspaceFolder}', vscode: true },
    gemini: { label: 'Gemini CLI', file: '.gemini/settings.json', key: 'mcpServers', detect: ['.gemini', 'GEMINI.md'], instructions: 'AGENTS.md' },
    codex: { label: 'Codex CLI', file: null, detect: ['AGENTS.md', '.codex'], instructions: 'AGENTS.md' },
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
    return agent.vscode ? { type: 'stdio', ...base } : base;
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

/** The command agents run for graph-indexer (npx, or this installation with --local). */
function cliCommand(local) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bin = path.resolve(here, '../../bin/graph-indexer.mjs');
    return local ? `${JSON.stringify(process.execPath)} ${JSON.stringify(bin)}` : 'npx -y graph-indexer@3';
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
    const ours = (h) => /graph-indexer(\.mjs"?|@\d+)? hook /.test(h?.command ?? '');
    const want = {
        PostToolUse: { matcher: 'Edit|Write|MultiEdit|Grep|Bash', hooks: [{ type: 'command', command: `${cmd} hook post-tool`, timeout: 10 }] },
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
            const file = path.join(repo, a.file);
            const cfg = readJson(file) ?? {};
            cfg[a.key] ??= {};
            const entry = serverEntry(a, { local });
            const before = JSON.stringify(cfg[a.key]['graph-indexer'] ?? null);
            cfg[a.key]['graph-indexer'] = entry;
            const changed = before !== JSON.stringify(entry);
            if (changed && !dryRun) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
            }
            report.push(`${a.label}: ${changed ? (before === 'null' ? 'added' : 'updated') : 'already configured'} ${a.file}`);
        } else if (key === 'codex') {
            const entry = serverEntry(a, { local });
            report.push(`Codex CLI: add to ~/.codex/config.toml →\n  [mcp_servers.graph-indexer]\n  command = "${entry.command}"\n  args = ${JSON.stringify(entry.args)}\n  cwd = "${repo}"`);
        }
    }
    if (hooks && chosen.includes('claude')) report.push(upsertClaudeHooks(repo, local, dryRun));
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
        `Other agents (Claude Desktop, Windsurf, JetBrains): add an MCP server with command "npx" and args ["-y","graph-indexer@3","serve","--repo","${repo}"].\n` +
        `Build the index now with: npx graph-indexer index   (the server also builds it on first start)\n` +
        (hooks ? '' : `Optional: graph-indexer init --hooks adds Claude Code hooks (edit check after each edit, grep disambiguation).\n`));
}
