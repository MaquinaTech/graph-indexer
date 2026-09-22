/**
 * `graph-indexer hook <event>`: agent hooks that put the index into the agent's normal loop.
 *
 * Reads the hook payload (Claude Code / Codex style JSON) on stdin and, only when it has something
 * useful to add, prints `{"hookSpecificOutput": {"hookEventName", "additionalContext"}}`:
 *
 *   post-tool       after an edit: the edit checker on the edited file (syntax errors introduced,
 *                   calls that no longer fit a changed signature, removed names still in use);
 *                   after a grep for an identifier that several definitions share: which
 *                   definition each group of matches belongs to
 *   session-start   one line saying the index exists (builds it in the background if missing)
 *   subagent-start  the same line for subagents that do not read CLAUDE.md/AGENTS.md
 *
 * Fail-open by design: any error, timeout or irrelevant input prints nothing and exits 0, so a
 * hook can never block or slow the agent by more than its deadline. Context is phrased as facts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRepoRoot, DATA_DIR_NAME } from '../util/paths.mjs';
import { specForPath } from '../parse/languages.mjs';

const MAX_CONTEXT = 1500;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit', 'write', 'apply_patch', 'replace', 'write_file']);
const GREP_TOOLS = new Set(['Grep', 'grep', 'search_file_content', 'grep_search']);
const SEARCH_CMD = /(?:^|[|;&(]\s*|\s)(grep|egrep|fgrep|rg|ugrep|ag|ack|git\s+grep)\s+(.*)$/;
const STOP_IDENTS = new Set(['function', 'return', 'import', 'export', 'const', 'class', 'async', 'await', 'self', 'this', 'true', 'false', 'null', 'None', 'TODO', 'FIXME', 'test', 'error', 'string']);

async function readStdin() {
    if (process.stdin.isTTY) return {};
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

function emit(event, context) {
    if (!context) return;
    const text = context.length > MAX_CONTEXT ? context.slice(0, MAX_CONTEXT - 1) + '…' : context;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) + '\n');
}

/** Minimal shell-words split (quotes and escapes) for extracting a grep pattern. */
function shellWords(s) {
    const out = [];
    let cur = '', q = null, any = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"' && i + 1 < s.length) cur += s[++i]; else cur += ch; continue; }
        if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
        if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; any = true; continue; }
        if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
        if (ch === '|' || ch === ';' || ch === '&') { if (cur || any) out.push(cur); break; }
        cur += ch;
    }
    if (cur || any) out.push(cur);
    return out;
}

/** The pattern of a grep-like shell command (first non-option word, or the value of -e). */
export function grepPattern(command) {
    const m = SEARCH_CMD.exec(command ?? '');
    if (!m) return null;
    const words = shellWords(m[2]);
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w === '-e' || w === '--regexp') return words[i + 1] ?? null;
        if (w.startsWith('-')) { if (/^-(A|B|C|m|g|t|T|-type|-glob|-include|-exclude|-max-count)$/.test(w)) i++; continue; }
        return w;
    }
    return null;
}

async function openIntel(root) {
    const db = path.join(root, DATA_DIR_NAME, 'index.db');
    if (!fs.existsSync(db)) return null; // never build a whole index inside a tool hook
    const { CodeIntel } = await import('../query/intel.mjs');
    const intel = new CodeIntel({ root });
    await intel.open();
    return intel;
}

async function afterEdit(root, input) {
    const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? input.tool_input?.path ?? null;
    if (!file) return null;
    const rel = path.isAbsolute(file) ? path.relative(root, file).split(path.sep).join('/') : file;
    if (rel.startsWith('..') || !specForPath(rel)) return null;
    const intel = await openIntel(root);
    if (!intel) return null;
    try {
        const { checkChanges } = await import('../query/check.mjs');
        const r = await checkChanges(intel, { files: [rel], tests: false });
        if (r.error) return null;
        const lines = [];
        for (const e of r.syntax.slice(0, 3)) lines.push(`${e.path}:${e.line} has a syntax error introduced since the last commit (${e.missing ? `missing ${e.missing}` : 'unexpected code'}): ${e.text.slice(0, 100)}`);
        for (const a of r.arity.slice(0, 4)) {
            const sites = a.sites.slice(0, 4).map(x => `${x.path}:${x.line} (passes ${x.argc.n})`).join(', ');
            lines.push(a.newCall ? `The call at ${sites} does not fit ${a.target}, which takes ${a.is} argument(s).`
                : `${a.target} now takes ${a.is} argument(s) (was ${a.was}); ${a.sites.length} of its ${a.total} call sites no longer fit: ${sites}${a.sites.length > 4 ? ', …' : ''}.`);
        }
        for (const m of r.removed.slice(0, 3)) {
            const uses = m.uses.slice(0, 4).map(u => `${u.path}:${u.line}`).join(', ');
            lines.push(`${m.qname} no longer exists in ${m.path} but is still used ${m.total + m.imports.length} time(s): ${uses}${m.total > 4 ? ', …' : ''}.`);
        }
        if (!lines.length) return null;
        return `graph-indexer check after this edit:\n- ${lines.join('\n- ')}\n(check_changes lists everything, including the tests to run.)`;
    } finally { intel.close(); }
}

async function afterGrep(root, input) {
    const pattern = GREP_TOOLS.has(input.tool_name) ? input.tool_input?.pattern : grepPattern(input.tool_input?.command);
    if (!pattern || pattern.length > 200) return null;
    const { identifierOf } = await import('../query/textsearch.mjs');
    const literal = GREP_TOOLS.has(input.tool_name) ? false : /(^|\s)(-F|--fixed-strings)\b/.test(input.tool_input?.command ?? '');
    const ident = identifierOf(pattern, literal);
    if (!ident || ident.length < 3 || STOP_IDENTS.has(ident)) return null;
    const intel = await openIntel(root);
    if (!intel) return null;
    try {
        const defs = intel.store.all(`SELECT s.id, s.qname, s.kind, s.start_line, f.path, f.is_test,
                (SELECT COUNT(*) FROM refs r WHERE r.dst_id = s.id) AS uses
            FROM symbols s JOIN files f ON f.id = s.file_id
            WHERE s.name = ? AND s.kind IN ('function','method','class','interface','struct','trait','enum','type','field','property','constant','constructor')
            ORDER BY uses DESC, f.is_test, f.path`, ident);
        // one entry per qualified name (overloads, re-declarations)
        const byQ = new Map();
        for (const d of defs) { const p = byQ.get(d.qname); if (!p) byQ.set(d.qname, { ...d }); else p.uses += d.uses; }
        const list = [...byQ.values()].filter(d => !d.is_test || d.uses > 0);
        if (!list.length) return null;
        const unbound = intel.store.get(`SELECT COUNT(*) AS n FROM refs WHERE name = ? AND dst_id IS NULL AND kind IN ('call','new')`, ident)?.n ?? 0;
        const totalUses = list.reduce((n, d) => n + d.uses, 0);
        if (list.length === 1 && totalUses < 8) return null; // one definition, few uses: grep output is already clear
        const shown = list.slice(0, 5).map(d => `${d.qname} (${d.path}:${d.start_line}, ${d.uses} bound use${d.uses === 1 ? '' : 's'})`);
        const head = list.length === 1
            ? `graph-indexer: "${ident}" is ${shown[0]}`
            : `graph-indexer: "${ident}" names ${list.length} different definitions — ${shown.join('; ')}${list.length > 5 ? `; ${list.length - 5} more` : ''}`;
        return `${head}.${unbound ? ` ${unbound} same-name call${unbound === 1 ? ' has' : 's have'} a receiver of unknown type.` : ''} find_references on one qualified name lists only its uses, with the enclosing function of each.`;
    } finally { intel.close(); }
}

async function sessionLine(root) {
    const db = path.join(root, DATA_DIR_NAME, 'index.db');
    if (!fs.existsSync(db)) {
        // build it in the background so the first query is fast; say nothing yet
        const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/graph-indexer.mjs');
        try { spawn(process.execPath, [bin, 'index', '--repo', root], { detached: true, stdio: 'ignore' }).unref(); } catch { /* optional */ }
        return null;
    }
    const intel = await openIntel(root);
    if (!intel) return null;
    try {
        const st = intel.stats();
        return `graph-indexer has a live index of this repository (${st.files} files, ${st.symbols} symbols). Its MCP tools answer with exact locations: search_text (grep that also says which definition each match refers to), find_references, call_graph, change_impact (what a change affects and which tests to run), check_changes (what an edit broke) and search_code / get_symbol / outline.`;
    } finally { intel.close(); }
}

export async function runHook(event, { repo = null } = {}) {
    const deadlineMs = event === 'post-tool' ? 4000 : 3000;
    const timer = setTimeout(() => process.exit(0), deadlineMs); // fail open: never hold the agent up
    try {
        const input = await readStdin();
        const root = findRepoRoot(input.cwd || repo || process.cwd());
        let text = null, name = input.hook_event_name ?? null;
        if (event === 'post-tool') {
            name ??= 'PostToolUse';
            const tool = input.tool_name ?? '';
            if (EDIT_TOOLS.has(tool)) text = await afterEdit(root, input);
            else if (GREP_TOOLS.has(tool) || (tool === 'Bash' || tool === 'shell' || tool === 'run_shell_command') && grepPattern(input.tool_input?.command)) text = await afterGrep(root, input);
        } else if (event === 'session-start' || event === 'subagent-start') {
            name ??= event === 'session-start' ? 'SessionStart' : 'SubagentStart';
            text = await sessionLine(root);
        }
        emit(name, text);
    } catch { /* fail open */ }
    clearTimeout(timer);
}
