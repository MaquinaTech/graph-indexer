/**
 * Other code-intelligence tools as session arms: each one is installed into a run's repository the
 * way its own installer installs it for Claude Code, from the pinned build in bench/arena/.tools
 * (docs/BENCHMARKS.md, "The arena", says how to install them).
 *
 *   codegraph  CodeGraph 1.6.2: `codegraph install --target=claude --location=local --yes` run in
 *              the repository (the MCP server with alwaysLoad, its permission, the UserPromptSubmit
 *              hook, the .claude/CLAUDE.md section), then `codegraph init`; the `codegraph` CLI on
 *              the session's PATH, as the installer puts it there
 *   cbm        codebase-memory-mcp 0.11.0: `install -y --clients=claude` writes user-scope files
 *              (MCP server, hooks, sub-agents, skill); it runs once against a scratch HOME and its
 *              files are copied into the project's scope, which Claude Code loads the same way;
 *              the repository is indexed with its CLI beforehand
 *
 *   serena     Serena 1.7.0 (pip install serena-agent==1.7.0 uv into WORK/tools/serena-venv; its Python
 *              language server is started through uvx), as its
 *              guide for Claude Code sets it up (oraios.github.io/serena, "Clients"): the MCP server with
 *              --context claude-code for the project, all four recommended hooks (remind,
 *              auto-approve, activate, cleanup) and the system prompt it "highly recommends"
 *              (`serena prompts print-cc-system-prompt-override`, passed with --system-prompt); the
 *              project's symbols are put in its LSP cache beforehand (`serena project index`)
 *
 *   serena-prompt  a control: Serena's recommended system prompt alone, with no Serena (no MCP
 *              server, hooks or index) — what the prompt does by itself
 *
 * Telemetry is turned off where a tool has it (CODEGRAPH_TELEMETRY=0): it changes nothing the
 * agent sees, and the sessions work offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sh, WORK, GI_ROOT } from './lib.mjs';

const TOOLS = path.join(GI_ROOT, 'bench', 'arena', '.tools');
const SERENA_BIN = path.join(WORK, 'tools', 'serena-venv', 'bin');

export const COMPETITORS = {
    codegraph: {
        label: 'CodeGraph 1.6.2',
        server: 'codegraph',
        exclude: ['.codegraph/'],
        bin: path.join(TOOLS, 'codegraph', 'node_modules', '.bin', 'codegraph'),
        env: { CODEGRAPH_TELEMETRY: '0' },
    },
    cbm: {
        label: 'codebase-memory-mcp 0.11.0',
        server: 'codebase-memory-mcp',
        exclude: [],
        bin: path.join(TOOLS, 'cbm', 'x', 'codebase-memory-mcp'),
        env: {},
    },
    serena: {
        label: 'Serena 1.7.0',
        server: 'serena',
        exclude: ['.serena/'],
        bin: path.join(SERENA_BIN, 'serena'),
        // its own settings home (no dashboard window per session; nothing else changed)
        env: {},
    },
    'serena-prompt': {
        label: "Serena 1.7.0's system prompt, without Serena",
        server: null,
        exclude: [],
        bin: path.join(SERENA_BIN, 'serena'),
        env: {},
    },
};

function need(c) {
    if (!fs.existsSync(c.bin)) throw new Error(`${c.label} not installed at ${c.bin} (docs/BENCHMARKS.md, "The arena")`);
}

/** A directory holding only the tool's executable, put first on the session's PATH. */
export function pathDir(name) {
    const c = COMPETITORS[name];
    const dir = path.join(WORK, 'tools', `path-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    const links = name === 'serena-prompt' ? []
        : name === 'serena' ? [['serena', c.bin], ['serena-hooks', path.join(SERENA_BIN, 'serena-hooks')], ['uv', path.join(SERENA_BIN, 'uv')], ['uvx', path.join(SERENA_BIN, 'uvx')]]
        : [[name === 'cbm' ? 'codebase-memory-mcp' : 'codegraph', c.bin]];
    for (const [n, target] of links) if (!fs.existsSync(path.join(dir, n))) fs.symlinkSync(target, path.join(dir, n));
    return dir;
}

/** The environment a session of this arm runs with (tool binary on PATH, telemetry off). */
export function sessionEnv(name, base) {
    const c = COMPETITORS[name];
    const env = { ...base, ...c.env, PATH: `${pathDir(name)}${path.delimiter}${base.PATH}` };
    if (name === 'cbm') env.CBM_CACHE_DIR = cbmCache();
    if (name === 'serena' || name === 'serena-prompt') env.SERENA_HOME = serenaHome();
    return env;
}

const cbmCache = () => path.join(WORK, 'tools', 'cbm-cache');

/** Serena's settings: its defaults, with the dashboard not opened in a browser for every session. */
function serenaHome() {
    const home = path.join(WORK, 'tools', 'serena-home');
    const cfg = path.join(home, 'serena_config.yml');
    if (!fs.existsSync(cfg)) {
        fs.mkdirSync(home, { recursive: true });
        const tpl = path.join(path.dirname(SERENA_BIN), 'lib', 'python3.12', 'site-packages', 'serena', 'resources', 'serena_config.template.yml');
        fs.writeFileSync(cfg, fs.readFileSync(tpl, 'utf8').replace(/^web_dashboard_open_on_launch: True$/m, 'web_dashboard_open_on_launch: False'));
    }
    return home;
}

/** What cbm's installer writes for Claude Code, captured once from a scratch HOME. */
function cbmInstalled() {
    const root = path.join(WORK, 'tools', 'cbm-install');
    const home = path.join(root, 'home');
    if (!fs.existsSync(path.join(home, '.claude', 'settings.json'))) {
        fs.rmSync(root, { recursive: true, force: true });
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
        fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(home, '.claude.json'), '{}\n');
        fs.copyFileSync(COMPETITORS.cbm.bin, path.join(root, 'bin', 'codebase-memory-mcp'));
        fs.chmodSync(path.join(root, 'bin', 'codebase-memory-mcp'), 0o755);
        const r = sh(`${JSON.stringify(path.join(root, 'bin', 'codebase-memory-mcp'))} install -y --clients=claude --dir=${JSON.stringify(path.join(root, 'bin'))}`, { env: { ...process.env, HOME: home } });
        if (r.code !== 0) throw new Error(`codebase-memory-mcp install failed: ${r.stderr.slice(-400)}`);
    }
    return { home, bin: path.join(root, 'bin', 'codebase-memory-mcp') };
}

const copyDir = (from, to) => { if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true }); };

/**
 * Install a tool into a checkout and index it. Returns { mcpServers, allowed, indexMs } — the
 * servers for the session's --mcp-config and the tool names to allow (what the user approves).
 */
export function installCompetitor(name, checkout) {
    const c = COMPETITORS[name];
    need(c);
    const env = sessionEnv(name, process.env);
    if (name === 'codegraph') {
        const scratchHome = path.join(WORK, 'tools', 'codegraph-home');
        fs.mkdirSync(scratchHome, { recursive: true });
        let r = sh(`${JSON.stringify(c.bin)} install --target=claude --location=local --yes`, { cwd: checkout, env: { ...env, HOME: scratchHome } });
        if (r.code !== 0) throw new Error(`codegraph install failed: ${r.stderr.slice(-400)}`);
        r = sh(`${JSON.stringify(c.bin)} init --yes ${JSON.stringify(checkout)}`, { cwd: checkout, env, timeout: 1_800_000 });
        if (r.code !== 0) throw new Error(`codegraph init failed: ${r.stderr.slice(-400)}`);
        const mcp = JSON.parse(fs.readFileSync(path.join(checkout, '.mcp.json'), 'utf8'));
        return { mcpServers: mcp.mcpServers, allowed: ['mcp__codegraph'], indexMs: r.ms };
    }
    if (name === 'serena-prompt') {
        const sp = sh(`${JSON.stringify(c.bin)} prompts print-cc-system-prompt-override`, { env });
        if (sp.code !== 0 || !sp.stdout.trim()) throw new Error('serena: no system prompt override');
        return { mcpServers: {}, allowed: [], indexMs: 0, systemPrompt: sp.stdout };
    }
    if (name === 'serena') {
        const hook = (cmd) => ({ type: 'command', command: `serena-hooks ${cmd} --client=claude-code` });
        const own = path.join(checkout, '.claude', 'settings.json');
        fs.mkdirSync(path.dirname(own), { recursive: true });
        const merged = fs.existsSync(own) ? JSON.parse(fs.readFileSync(own, 'utf8')) : {};
        merged.hooks = { ...(merged.hooks ?? {}),
            PreToolUse: [{ matcher: '', hooks: [hook('remind')] }, { matcher: 'mcp__serena__*', hooks: [hook('auto-approve')] }],
            SessionStart: [{ matcher: '', hooks: [hook('activate')] }],
            SessionEnd: [{ matcher: '', hooks: [hook('cleanup')] }] };
        fs.writeFileSync(own, JSON.stringify(merged, null, 2) + '\n');
        const r = sh(`${JSON.stringify(c.bin)} project index ${JSON.stringify(checkout)}`, { cwd: checkout, env, timeout: 1_800_000, input: '\n'.repeat(20) }); // its default for each extra language server: no
        if (r.code !== 0) throw new Error(`serena project index failed: ${(r.stderr || r.stdout).slice(-600)}`);
        const sp = sh(`${JSON.stringify(c.bin)} prompts print-cc-system-prompt-override`, { env });
        if (sp.code !== 0 || !sp.stdout.trim()) throw new Error('serena: no system prompt override');
        return { mcpServers: { serena: { command: 'serena', args: ['start-mcp-server', '--context', 'claude-code', '--project', checkout] } },
            allowed: ['mcp__serena'], indexMs: r.ms, systemPrompt: sp.stdout };
    }
    // cbm: its user-scope files, in the project's scope
    const { home, bin } = cbmInstalled();
    const claude = path.join(checkout, '.claude');
    fs.mkdirSync(claude, { recursive: true });
    copyDir(path.join(home, '.claude', 'agents'), path.join(claude, 'agents'));
    copyDir(path.join(home, '.claude', 'skills'), path.join(claude, 'skills'));
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    // hooks name the installed binary with an args list; run them with the run's index cache
    for (const entries of Object.values(settings.hooks ?? {})) for (const e of entries) for (const h of e.hooks ?? []) {
        if (h.command === bin) { h.command = `CBM_CACHE_DIR=${JSON.stringify(cbmCache())} ${JSON.stringify(bin)} ${(h.args ?? []).join(' ')}`.trim(); delete h.args; }
    }
    const own = path.join(claude, 'settings.json');
    const merged = fs.existsSync(own) ? JSON.parse(fs.readFileSync(own, 'utf8')) : {};
    merged.hooks = { ...(merged.hooks ?? {}), ...settings.hooks };
    fs.writeFileSync(own, JSON.stringify(merged, null, 2) + '\n');
    const user = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    const servers = user.mcpServers ?? {};
    for (const s of Object.values(servers)) s.env = { ...(s.env ?? {}), CBM_CACHE_DIR: cbmCache() };
    const r = sh(`${JSON.stringify(c.bin)} cli --quiet index_repository --repo-path ${JSON.stringify(checkout)}`, { env, timeout: 1_800_000 });
    if (r.code !== 0) throw new Error(`codebase-memory-mcp index failed: ${r.stderr.slice(-400)}`);
    return { mcpServers: servers, allowed: ['mcp__codebase-memory-mcp'], indexMs: r.ms };
}
