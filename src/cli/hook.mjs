/**
 * `graph-indexer hook <event>`: agent hooks that put the index into the agent's normal loop.
 *
 * Reads the hook payload on stdin (Claude Code's format, which Codex, Copilot CLI, Devin and VS Code
 * share; Gemini CLI and Cursor tool names are recognised too) and, only when it has something
 * useful to add, prints the host's "additional context" field:
 *
 *   post-tool       after an edit: the edit checker on the edited file (syntax errors introduced,
 *                   calls that no longer fit a changed signature, removed names still in use);
 *                   after a search for a definition that did not find it: where it is defined;
 *                   while the agent is crawling (three or more searches and reads since its last
 *                   edit): after a read, where the names used in the lines it read are defined, and
 *                   after a grep for a name several definitions share, which definition is which
 *   session-start   one line saying the index exists (builds it in the background if missing), plus
 *                   the lookup rules when the repository's instruction files do not carry them
 *   subagent-start  the line and the lookup rules, for subagents that do not read CLAUDE.md/AGENTS.md
 *
 * Staying quiet until the agent is crawling matters: context added to every search made "where is
 * X" questions dearer in other projects' measurements. Fail-open by design: any error, timeout or
 * irrelevant input prints nothing and exits 0. Context is phrased as facts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRepoRoot, DATA_DIR_NAME } from '../util/paths.mjs';
import { specForPath } from '../parse/languages.mjs';

const MAX_CONTEXT = 1500;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit', 'write', 'apply_patch', 'replace', 'write_file']);
const GREP_TOOLS = new Set(['Grep', 'grep', 'search_file_content', 'grep_search']);
const READ_TOOLS = new Set(['Read', 'read_file', 'read', 'view']);
const SHELL_TOOLS = new Set(['Bash', 'shell', 'Shell', 'run_shell_command', 'exec_command']);
// navigation calls since the last edit from which the agent counts as crawling
const CRAWL = 3;
const DEF_SEARCH = /\b(def|class|function|func|fn|interface|struct|trait|enum|type)\s+(\\?\(?)?\w/;
const SEARCH_CMD = /(?:^|[|;&(]\s*|\s)(grep|egrep|fgrep|rg|ugrep|ag|ack|git\s+grep)\s+(.*)$/;
const STOP_IDENTS = new Set(['function', 'return', 'import', 'export', 'const', 'class', 'async', 'await', 'self', 'this', 'true', 'false', 'null', 'None', 'TODO', 'FIXME', 'test', 'error', 'string']);

async function readStdin() {
    if (process.stdin.isTTY) return {};
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

/** Cursor's own hook events are camelCase (`postToolUse`) and take `additional_context`. */
const isCursor = (input) => /^[a-z]/.test(input.hook_event_name ?? '') || input.cursor_version != null;

function emit(event, context, input = {}, max = MAX_CONTEXT) {
    if (!context) return;
    const text = context.length > max ? context.slice(0, max - 1) + '…' : context;
    const out = isCursor(input) ? { additional_context: text } : { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
    process.stdout.write(JSON.stringify(out) + '\n');
}

/** The text a tool returned, whatever the host's shape (string, Bash {stdout}, Grep {content}). */
function responseText(input) {
    const r = input.tool_response ?? input.tool_result ?? input.toolResult ?? null;
    if (r == null) return null;
    if (typeof r === 'string') return r;
    if (typeof r.stdout === 'string') return r.stdout;
    if (typeof r.content === 'string') return r.content;
    if (typeof r.file?.content === 'string') return r.file.content;
    if (Array.isArray(r.content)) return r.content.map(c => c?.text ?? '').join('\n');
    return JSON.stringify(r);
}

/** Navigation calls since the last edit and definitions already shown, per session (crawl detector). */
function sessionState(input) {
    const id = String(input.session_id ?? input.sessionId ?? input.conversation_id ?? 'default').replace(/[^\w.-]/g, '_').slice(0, 80);
    const file = path.join(os.tmpdir(), 'graph-indexer-hooks', `${id}.json`);
    let st = { nav: 0, shown: [] };
    try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first call */ }
    return {
        st,
        save() {
            try {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                st.shown = st.shown.slice(-400);
                fs.writeFileSync(file, JSON.stringify(st));
            } catch { /* optional */ }
        },
    };
}

/** A file read through the shell: [file, from, to] for `sed -n 'a,bp' f`, `head -n N f`, `cat f`, `nl -ba f | sed -n …`. */
export function shellRead(command) {
    const c = String(command ?? '').replace(/^\s*cd\s+\S+\s*&&\s*/, '');
    let m;
    if ((m = /^(?:nl\s+-ba\s+|cat\s+-n\s+)(\S+)\s*\|\s*sed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s*$/.exec(c))) return [m[1], +m[2], +m[3]];
    if ((m = /^sed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+(\S+)\s*$/.exec(c))) return [m[3], +m[1], +m[2]];
    if ((m = /^head\s+-(?:n\s*)?(\d+)\s+(\S+)\s*$/.exec(c))) return [m[2], 1, +m[1]];
    if ((m = /^cat\s+(?:-n\s+)?(\S+\.\w+)\s*$/.exec(c))) return [m[1], 1, 2000];
    return null;
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

async function afterGrep(root, input, crawling) {
    const shell = !GREP_TOOLS.has(input.tool_name);
    const pattern = shell ? grepPattern(input.tool_input?.command) : input.tool_input?.pattern;
    if (!pattern || pattern.length > 200) return null;
    const { identifierOf } = await import('../query/textsearch.mjs');
    const literal = shell && /(^|\s)(-F|--fixed-strings)\b/.test(input.tool_input?.command ?? '');
    const ident = identifierOf(pattern, literal);
    if (!ident || ident.length < 3 || STOP_IDENTS.has(ident)) return null;
    const out = responseText(input);
    // a search for a definition that did not find it: say where it is (always — it replaces the
    // next search). A search for uses is left alone unless the agent is crawling.
    const defSearch = DEF_SEARCH.test(pattern) || (out != null && out.trim() === '');
    const foundDef = out != null && new RegExp(`\\b(def|class|function|func|fn|interface|struct|trait|enum|type)\\s+${ident}\\b`).test(out);
    if (!(defSearch && !foundDef) && !crawling) return null;
    const intel = await openIntel(root);
    if (!intel) return null;
    try {
        const defs = intel.store.all(`SELECT s.id, s.qname, s.kind, s.start_line, s.end_line, s.sig, f.path, f.is_test,
                (SELECT COUNT(*) FROM refs r WHERE r.dst_id = s.id) AS uses
            FROM symbols s JOIN files f ON f.id = s.file_id
            WHERE s.name = ? AND s.kind IN ('function','method','class','interface','struct','trait','enum','type','field','property','constant','constructor')
            ORDER BY uses DESC, f.is_test, f.path`, ident);
        // one entry per qualified name (overloads, re-declarations)
        const byQ = new Map();
        for (const d of defs) { const p = byQ.get(d.qname); if (!p) byQ.set(d.qname, { ...d }); else p.uses += d.uses; }
        const list = [...byQ.values()].filter(d => !d.is_test || d.uses > 0);
        if (!list.length) return null;
        if (defSearch && !foundDef) {
            const shown = list.slice(0, 3).map(d => `${d.qname} → ${d.path}:${d.start_line}-${d.end_line}  ${String(d.sig ?? d.kind).replace(/\s+/g, ' ').slice(0, 110)}`);
            return `graph-indexer: "${ident}" is defined at:\n  ${shown.join('\n  ')}${list.length > 3 ? `\n  (${list.length - 3} more definitions with this name)` : ''}`;
        }
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

/** After a read while the agent is crawling: where the names used in the lines it read are defined. */
async function afterRead(root, input, state) {
    let file = null, from = 1, to = 2000;
    if (READ_TOOLS.has(input.tool_name)) {
        file = input.tool_input?.file_path ?? input.tool_input?.path ?? input.tool_input?.absolute_path ?? null;
        const off = Number(input.tool_input?.offset ?? 0), lim = Number(input.tool_input?.limit ?? 0);
        if (off > 0) from = off;
        if (lim > 0) to = from + lim - 1;
    } else {
        const r = shellRead(input.tool_input?.command);
        if (!r) return null;
        [file, from, to] = r;
    }
    if (!file) return null;
    const cwd = input.cwd || root;
    const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (rel.startsWith('..') || !specForPath(rel)) return null;
    const intel = await openIntel(root);
    if (!intel) return null;
    try {
        const { definitionsUsed } = await import('../query/read.mjs');
        const n = Math.max(1, to - from + 1);
        const { rows } = definitionsUsed(intel, rel, from, to, { max: Math.min(12, Math.max(4, Math.round(n / 15))), skipIds: new Set(state.st.shown) });
        if (!rows.length) return null;
        for (const r of rows) state.st.shown.push(r.id);
        const lines = rows.map(r => `  ${r.qname} → ${r.path}:${r.start_line}  ${String(r.sig || r.kind).replace(/\s+/g, ' ').replace(/\s+#.*$/, '').slice(0, 100)}`);
        return `graph-indexer: where names used in these lines are defined (read them directly instead of searching):\n${lines.join('\n')}`;
    } finally { intel.close(); }
}

// the lookup rules, for sessions and subagents whose instruction files do not carry them
const RULES = `How to look code up in this repository (graph-indexer):
- Several things at once: several tool calls in one message, or one read_code call with several targets (Class.method, path:120-180) — \`npx graph-indexer read A B\` in a shell — not one search per turn.
- The function or the 50–100 lines you need, not whole files; a long file's outline gives every definition's line range.
- Every read lists where each name the code uses is defined; read those targets instead of grepping for their definitions.
- Exact uses of a function or class: find_references. Text that is not a code name: grep as usual.`;

async function sessionLine(root, { rules = false } = {}) {
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
        const line = `graph-indexer has a live index of this repository (${st.files} files, ${st.symbols} symbols). Its MCP tools answer with exact locations: read_code (symbols, ranges or files, several per call, with where each name they use is defined), search_text (grep that also says which definition each match refers to), find_references, change_impact (what a change affects and which tests to run), check_changes (what an edit broke), call_graph, search_code and outline.`;
        // the managed block of `init` already carries the rules; otherwise add them
        const carried = ['CLAUDE.md', 'AGENTS.md'].some(f => { try { return fs.readFileSync(path.join(root, f), 'utf8').includes('<!-- graph-indexer:start -->'); } catch { return false; } });
        return rules || !carried ? `${line}\n${RULES}` : line;
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
            const tool = input.tool_name ?? input.toolName ?? '';
            const command = input.tool_input?.command;
            const state = sessionState(input);
            if (EDIT_TOOLS.has(tool)) {
                state.st.nav = 0;
                state.save();
                text = await afterEdit(root, input);
            } else if (GREP_TOOLS.has(tool) || (SHELL_TOOLS.has(tool) && grepPattern(command))) {
                state.st.nav++;
                state.save();
                text = await afterGrep(root, input, state.st.nav >= CRAWL);
            } else if (READ_TOOLS.has(tool) || (SHELL_TOOLS.has(tool) && shellRead(command))) {
                state.st.nav++;
                if (state.st.nav >= CRAWL) text = await afterRead(root, input, state);
                state.save();
            }
        } else if (event === 'session-start' || event === 'subagent-start') {
            name ??= event === 'session-start' ? 'SessionStart' : 'SubagentStart';
            text = await sessionLine(root, { rules: event === 'subagent-start' });
        }
        emit(name, text, input, event === 'post-tool' ? MAX_CONTEXT : 2500);
    } catch { /* fail open */ }
    clearTimeout(timer);
}
