/**
 * `graph-indexer hook prompt` (UserPromptSubmit, opt-in): before the agent's first turn, the answers
 * graph-indexer's own tools give for the code a request names, so a "who calls X" question starts
 * from find_references instead of a search.
 *
 * A thin layer over what the tools already do, so it never says more than they would:
 *   names    the identifiers analyzeQuery finds in the request, kept the way explore keeps them
 *            (namedInQuery), plus a lone name written in backticks; a bare name that several
 *            definitions share is left out, since find_references would have to pick one
 *   content  find_references on each (at most 3), and call_graph's callers too when the request
 *            asks about paths or impact, as those tools word it: completeness, parse gaps,
 *            unbound calls, string mentions and injection included
 *   budget   whole answers only, with fewer lines listed where needed (the tools' own `limit` and
 *            "… more" line); an answer that does not fit is left out and named
 *   input    blocks a host adds to a prompt in tags (<system-reminder>, <task-notification>,
 *            <agent-message>, <command-message>…) are not read; runHook skips sessions a program
 *            drives (programDriven in src/cli/hook.mjs)
 */
import { analyzeQuery } from '../search/tokenize.mjs';
import { codeSpecForPath } from '../parse/languages.mjs';

const MAX_TARGETS = 3;
const MAX_PROMPT = 20_000;
// definitions whose uses are worth listing (as the grep hook's lookup)
const DEFINITIONS = new Set(['function', 'method', 'constructor', 'class', 'interface', 'struct', 'trait', 'enum', 'type', 'object', 'field', 'property', 'constant', 'variable']);
const CALLABLE = new Set(['function', 'method', 'constructor']);
// lines listed per answer, tried in turn until the answer fits
const LIMITS = [40, 12, 4];
// the opening tag of a block a host adds, named in kebab or snake case (<system-reminder>)
const HOST_TAG = /<([a-z]+(?:[-_][a-z]+)+)(?:\s[^<>]*)?>/g;
const CODE_SPAN = /`([^`\s]{3,120})`/g;
// a request about chains of calls or the effect of a change (English and Spanish)
const CALLERS = /\b(affect\w*|impact\w*|break(s|ing)?|callers of (the )?callers|call (chain|path)s?|chains? of calls|entry points?|ends? up calling|reach(es|ed)?|transitive(ly)?|indirect(ly)?|afecta\w*|impacto|rompe\w*|puntos? de entrada|cadena de llamadas|acaba\w* llamando|llega\w*)\b/i;

/** The part of a prompt the user wrote: without the blocks a host adds in tags (one left open runs to the end). */
export function userText(prompt) {
    const s = String(prompt ?? '').slice(0, MAX_PROMPT);
    let out = '', at = 0;
    HOST_TAG.lastIndex = 0;
    for (let m; (m = HOST_TAG.exec(s));) {
        out += s.slice(at, m.index) + ' ';
        const end = s.indexOf(`</${m[1]}>`, HOST_TAG.lastIndex);
        if (end < 0) { at = s.length; break; }
        at = HOST_TAG.lastIndex = end + m[1].length + 3;
    }
    return (out + s.slice(at)).trim();
}

/** The names a request may mean as code, in order, each with whether it was written as code. */
export function promptNames(text) {
    const names = [];
    const add = (id, quoted) => { if (id.length >= 3 && !names.some(n => n.id === id)) names.push({ id, quoted }); };
    // a lone name in backticks is code even when it is a plain word (`render`)
    for (const m of String(text).matchAll(CODE_SPAN)) {
        const a = analyzeQuery(m[1]);
        if (a.identifiers.length === 1) add(a.identifiers[0], true);
    }
    // a request is prose: a plain lowercase word is a lookup only when written as code, `render`
    // or render() (namedInQuery)
    for (const id of analyzeQuery(text).identifiers) add(id, text.includes(`${id}()`));
    return names;
}

/** The definitions the request names, at most MAX_TARGETS: [{ name, sym }]. */
export async function promptTargets(intel, text) {
    const { namedInQuery } = await import('../mcp/tools.mjs'); // loaded once a request may name code
    const out = [];
    for (const { id, quoted } of promptNames(text)) {
        if (out.length >= MAX_TARGETS) break;
        const m = namedInQuery(intel, id, { natural: !quoted }).filter(s => DEFINITIONS.has(s.kind) && codeSpecForPath(s.path));
        if (!m.length || out.some(t => t.sym.id === m[0].id)) continue;
        // a bare name several definitions share: find_references would show one of them, a guess
        // (unless the others are test doubles, and it shows the one outside tests)
        if (m.length > 1 && !/[.:#>]/.test(id) && (m[0].is_test || m.filter(s => !s.is_test).length > 1)) continue;
        out.push({ name: id, sym: m[0] });
    }
    return out;
}

/**
 * The context for a request: each tool's answer as the tool gives it, within `budget` characters,
 * or null when the request names no definition.
 */
export async function promptContext(intel, prompt, { budget = 6000 } = {}) {
    const text = userText(prompt);
    const targets = await promptTargets(intel, text);
    if (!targets.length) return null;
    const { callTool } = await import('../mcp/tools.mjs');
    const paths = CALLERS.test(text);
    const calls = [];
    for (const { name, sym } of targets) {
        calls.push({ label: `find_references "${name}"`, tool: 'find_references', args: { symbol: name } });
        if (paths && CALLABLE.has(sym.kind)) calls.push({ label: `call_graph "${name}" (callers, depth 2)`, tool: 'call_graph', args: { symbol: name, direction: 'callers', depth: 2, include_tests: false } });
    }
    const head = 'graph-indexer ran its tools on the code this request names, before the first turn. Each answer below is the tool\'s own, as the tool gives it:';
    // room for the line that names what was left out, were it all
    let left = budget - head.length - 60 - calls.reduce((n, c) => n + c.label.length + 2, 0);
    const parts = [head], cut = [];
    for (let i = 0; i < calls.length; i++) {
        const { label, tool, args } = calls[i];
        // the budget left is shared among the answers not yet given; the shortest form may take more
        const share = Math.floor(left / (calls.length - i));
        let block = null;
        for (const limit of LIMITS) {
            block = `\n── ${label}\n${await callTool(intel, tool, { ...args, limit })}`;
            if (block.length < share) break;
        }
        if (block.length >= left) { cut.push(label); continue; }
        parts.push(block);
        left -= block.length + 1;
    }
    if (cut.length) parts.push(`\nLeft out to fit: ${cut.join(', ')}. Call ${cut.length === 1 ? 'it' : 'them'} for the answer.`);
    return parts.length > 1 ? parts.join('\n') : null;
}
