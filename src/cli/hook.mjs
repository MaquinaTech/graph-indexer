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
 *                   after a read: the indirection the lines involve, resolved (which override runs,
 *                   which table entry handles a key, what reaches a method by a built name, what a
 *                   decorator is — silent when there is none, never repeated in a session);
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
 *
 * A resident process (the MCP server, or `graph-indexer daemon`) answers when one runs for the
 * repository, with the index already open (src/cli/resident.mjs); otherwise the hook opens the
 * index itself and starts a daemon for the next calls.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRepoRoot, dataDir, DATA_DIR_NAME } from '../util/paths.mjs';
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

/** What the hook prints for `context` in the calling host's format, or null for nothing. */
function format(event, context, input = {}, max = MAX_CONTEXT) {
    if (!context) return null;
    const text = context.length > max ? context.slice(0, max - 1) + '…' : context;
    const out = isCursor(input) ? { additional_context: text } : { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
    return JSON.stringify(out);
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

const hasIndex = (root) => fs.existsSync(path.join(root, DATA_DIR_NAME, 'index.db'));

/** The index for one hook call when no resident process answers: opened, synced, closed after. */
function localIndex(root) {
    return async () => {
        if (!hasIndex(root)) return null; // never build a whole index inside a tool hook
        const { CodeIntel } = await import('../query/intel.mjs');
        const intel = new CodeIntel({ root });
        await intel.open();
        return { intel, release: () => intel.close() };
    };
}

async function afterEdit(root, input, acquire) {
    const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? input.tool_input?.path ?? null;
    if (!file) return null;
    const rel = path.isAbsolute(file) ? path.relative(root, file).split(path.sep).join('/') : file;
    if (rel.startsWith('..') || !specForPath(rel)) return null;
    const ix = await acquire();
    if (!ix) return null;
    const { intel } = ix;
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
    } finally { ix.release(); }
}

async function afterGrep(root, input, crawling, acquire) {
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
    const ix = await acquire();
    if (!ix) return null;
    const { intel } = ix;
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
    } finally { ix.release(); }
}

/**
 * After a read: the indirection the lines involve, resolved (which override runs, which table entry
 * handles a key, what reaches a method by a built name, what a decorator is) — always, since it is
 * silent when there is none; and while the agent is crawling, where the names the lines use are defined.
 */
async function afterRead(root, input, state, crawling, acquire) {
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
    const ix = await acquire();
    if (!ix) return null;
    const { intel } = ix;
    try {
        await intel.revalidate([rel]); // a long-lived index may not have seen the file change yet
        const out = [];
        const { factsForRange, renderFacts } = await import('../query/facts.mjs');
        state.st.facts ??= [];
        const facts = factsForRange(intel, rel, from, to, { max: 4, shown: new Set(state.st.facts) });
        if (facts.length) {
            for (const f of facts) state.st.facts.push(f.key);
            out.push(`graph-indexer, resolved for these lines:\n${renderFacts(facts).map(l => `  ${l}`).join('\n')}`);
        }
        if (crawling) {
            const { definitionsUsed } = await import('../query/read.mjs');
            const n = Math.max(1, to - from + 1);
            const { rows } = definitionsUsed(intel, rel, from, to, { max: Math.min(12, Math.max(4, Math.round(n / 15))), skipIds: new Set(state.st.shown) });
            for (const r of rows) state.st.shown.push(r.id);
            if (rows.length) out.push(`graph-indexer: where names used in these lines are defined (read them directly instead of searching):\n${rows.map(r => `  ${r.qname} → ${r.path}:${r.start_line}  ${String(r.sig || r.kind).replace(/\s+/g, ' ').replace(/\s+#.*$/, '').slice(0, 100)}`).join('\n')}`);
        }
        return out.length ? out.join('\n') : null;
    } finally { ix.release(); }
}

// the lookup rules, for sessions and subagents whose instruction files do not carry them
const RULES = `How to look code up in this repository (graph-indexer):
- Several things at once: several tool calls in one message, or one search with alternatives — not one search per turn.
- The function or the 50–100 lines you need, not whole files; to find a definition, search for its definition line (\`def name\`, \`class Name\`) across the package in one search.
- Exact uses of a function or class, even when other code shares its name: find_references (\`npx graph-indexer refs NAME\` in a shell). Before changing what other code relies on: change_impact; when you are done: check_changes, then run the tests it names, once.`;

async function sessionLine(root, { rules = false, acquire }) {
    if (!hasIndex(root)) return null; // being built in the background (spawnResident); say nothing yet
    const ix = await acquire();
    if (!ix) return null;
    const { intel } = ix;
    try {
        const st = intel.stats();
        const line = `graph-indexer has a live index of this repository (${st.files} files, ${st.symbols} symbols). Its MCP tools answer with exact locations: find_references (exact uses, even when other code shares the name), change_impact (what a change affects and which tests to run), check_changes (what an edit broke, and the closest tests), call_graph, read_code (symbols or ranges by name, with where each name they use is defined), search_text, search_code and outline.`;
        // the managed block of `init` already carries the rules; otherwise add them
        const carried = ['CLAUDE.md', 'AGENTS.md'].some(f => { try { return fs.readFileSync(path.join(root, f), 'utf8').includes('<!-- graph-indexer:start -->'); } catch { return false; } });
        return rules || !carried ? `${line}\n${RULES}` : line;
    } finally { ix.release(); }
}

/**
 * One hook call: what the hook prints (in the calling host's format), or null. `acquire()` gives
 * the index: opened for this call, or the resident process's own.
 */
export async function handleHook(event, input, { root, acquire }) {
    let text = null, name = input.hook_event_name ?? null;
    if (event === 'post-tool') {
        name ??= 'PostToolUse';
        const tool = input.tool_name ?? input.toolName ?? '';
        const command = input.tool_input?.command;
        const state = sessionState(input);
        if (EDIT_TOOLS.has(tool)) {
            state.st.nav = 0;
            state.save();
            text = await afterEdit(root, input, acquire);
        } else if (GREP_TOOLS.has(tool) || (SHELL_TOOLS.has(tool) && grepPattern(command))) {
            state.st.nav++;
            state.save();
            text = await afterGrep(root, input, state.st.nav >= CRAWL, acquire);
        } else if (READ_TOOLS.has(tool) || (SHELL_TOOLS.has(tool) && shellRead(command))) {
            state.st.nav++;
            text = await afterRead(root, input, state, state.st.nav >= CRAWL, acquire);
            state.save();
        }
    } else if (event === 'session-start' || event === 'subagent-start') {
        name ??= event === 'session-start' ? 'SessionStart' : 'SubagentStart';
        text = await sessionLine(root, { rules: event === 'subagent-start', acquire });
    }
    return format(name, text, input, event === 'post-tool' ? MAX_CONTEXT : 2500);
}

/**
 * Start a resident process (`graph-indexer daemon`) so later hook calls skip opening the index; at
 * session start it also builds a missing index. At most once a minute per repository, and never
 * from a tool hook in a repository without an index.
 */
function spawnResident(root, event) {
    const starting = event === 'session-start' || event === 'subagent-start';
    if (!starting && !hasIndex(root)) return;
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/graph-indexer.mjs');
    const off = process.env.GRAPH_INDEXER_RESIDENT === '0';
    if (off && (!starting || hasIndex(root))) return;
    try {
        const mark = path.join(dataDir(root), 'resident.started');
        try { if (Date.now() - fs.statSync(mark).mtimeMs < 60_000) return; } catch { /* first time */ }
        fs.writeFileSync(mark, String(Date.now()));
        // without a resident, still build a missing index in the background so the first query is fast
        spawn(process.execPath, [bin, off ? 'index' : 'daemon', '--repo', root], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch { /* optional */ }
}

export async function runHook(event, { repo = null, version = null } = {}) {
    const deadlineMs = event === 'post-tool' ? 4000 : 3000;
    const timer = setTimeout(() => process.exit(0), deadlineMs); // fail open: never hold the agent up
    try {
        const input = await readStdin();
        const root = findRepoRoot(input.cwd || repo || process.cwd());
        const { askResident, residentRequired } = await import('./resident.mjs');
        const reply = await askResident(root, { op: 'hook', event, input }, { version, totalMs: 2000 });
        let out = null;
        if (reply) out = reply.out;
        else if (!residentRequired()) {
            out = await handleHook(event, input, { root, acquire: localIndex(root) });
            spawnResident(root, event);
        }
        if (out) process.stdout.write(out + '\n');
    } catch { /* fail open */ }
    clearTimeout(timer);
}
