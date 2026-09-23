/**
 * Read an agent transcript and reduce it to what the benchmark measures: token usage (uncached
 * input, cache writes, cache reads, output), turns, tool calls by kind, shell commands, files read
 * and edited, and violations of the arm's tool policy.
 *
 * Two formats are understood:
 *   - Claude Code session/sub-agent JSONL (one event per line; an assistant message may be split
 *     over several lines that repeat the same usage, so usage is counted once per message id);
 *   - `claude -p --output-format stream-json` (same message shapes plus a final `result` event).
 */
import fs from 'node:fs';

// tokens a tool result adds to the next call's context: 2.63 characters per token, fitted on 301 calls
// (237 runs) that follow a message without reasoning
const RESULT_CHARS_PER_TOKEN = 2.63;
const GREP_CMD = /(^|[|;&(\s])(grep|egrep|fgrep|rg|ag|ack|git\s+grep)(\s|$)/;
const FIND_NAME = /(^|[|;&(\s])find\s+\S.*-(i?name|i?path|regex)\b/;
const GI_CMD = /(^|[\s/])(gi|graph-indexer(\.mjs)?)\s+(search|symbol|read|refs|callgraph|impact|outline|grep|check|files|tests|status)\b/;
/** Shell variables that hold graph-indexer's path (`GI=/runs/x/gi; $GI refs Foo`). */
const GI_VAR = /(?:^|[\s;&|(])([A-Za-z_]\w*)=(["']?)(\S*?(?:\/gi|graph-indexer(?:\.mjs)?))\2(?=[\s;&|)]|$)/g;
/** Replace `$GI` / `${GI}` by `gi` for every variable known to hold graph-indexer's path. */
function expandGiVars(cmd, vars) {
    for (const m of cmd.matchAll(GI_VAR)) vars.add(m[1]);
    let out = cmd;
    for (const v of vars) out = out.replace(new RegExp(`\\$\\{?${v}\\}?(?=[\\s;&|)]|$)`, 'g'), 'gi');
    return out;
}

/** `gi grep …` is graph-indexer's own text search, not a shell grep. */
const maskGiGrep = (cmd) => cmd.replace(/(^|[\s/])(gi|graph-indexer(?:\.mjs)?)\s+grep\b/g, '$1$2 GI-GREP');
const isGrep = (cmd) => GREP_CMD.test(maskGiGrep(cmd)) || FIND_NAME.test(cmd);

/**
 * Does a shell command search the code? A grep that filters another command's output
 * (`tsc … | grep x`) or reads files outside the repository (saved logs) does not navigate code.
 * Returns 'search', 'filter' or null.
 */
export function grepUse(cmd, repo = null) {
    // quoted patterns may contain `|` / `;` (`grep -v "a\\|b"`): blank them before splitting
    const masked = maskGiGrep(cmd).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, 'Q');
    let use = null;
    for (const seg of masked.split(/&&|\|\||;|\n/)) {
        const stages = seg.split('|');
        stages.forEach((stage, i) => {
            if (!GREP_CMD.test(stage) && !FIND_NAME.test(stage)) return;
            if (i > 0 && !/-r|-R|--recursive|\bfind\b/.test(stage)) { use ??= 'filter'; return; }
            const paths = [...stage.matchAll(/(?:^|\s)(\/[^\s'"|;&]+)/g)].map(m => m[1]);
            if (repo && paths.length && paths.every(p => !p.startsWith(repo))) { use ??= 'filter'; return; }
            use = 'search';
        });
    }
    return use;
}

/** Tool policy of each arm: which tool uses count as violations. */
export const POLICIES = {
    grep: { forbidTools: [], forbidBash: [GI_CMD], label: 'built-in tools only' },
    gi: { forbidTools: ['Grep', 'Glob'], forbidBash: [{ test: isGrep }], label: 'graph-indexer instead of grep/glob' },
    'grep+gi': { forbidTools: [], forbidBash: [], label: 'built-in tools and graph-indexer' },
    'grep+gi+': { forbidTools: [], forbidBash: [], label: 'built-in tools and graph-indexer, integrated' },
    'grep+gi2': { forbidTools: [], forbidBash: [], label: 'built-in tools and graph-indexer, integrated (adaptive rules)' },
    gi2: { forbidTools: ['Grep', 'Glob'], forbidBash: [{ test: isGrep }], label: 'graph-indexer instead of grep/glob (adaptive rules)' },
    'grep+gi3': { forbidTools: [], forbidBash: [], label: 'built-in tools and graph-indexer, integrated (third card)' },
    gi3: { forbidTools: ['Grep', 'Glob'], forbidBash: [{ test: isGrep }], label: 'graph-indexer instead of grep/glob (third card)' },
    'grep+rules': { forbidTools: [], forbidBash: [], label: 'built-in tools and rules on how to look code up' },
    'grep+gi4': { forbidTools: [], forbidBash: [], label: 'built-in tools and graph-indexer, fourth card (reads with definitions, same rules)' },
};

export function parseTranscript(file, { arm = null, repo = null, own = [], work = null } = {}) {
    const text = fs.readFileSync(file, 'utf8');
    const events = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /* partial line */ }
    }
    // one assistant message can span several lines (one per content block), each repeating a usage
    // snapshot that grows while streaming: keep the largest value of each field per message
    const perMessage = new Map();
    const order = [];                 // message keys in the order the model produced them
    const outChars = new Map();
    const resultChars = new Map();    // message key → characters of the tool results that answered it
    const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    const tools = [];
    const models = new Set();
    const usedAt = new Map();
    let first = null, last = null, result = null, finalText = '';
    let lastKey = null, lastResultAt = null, modelMs = 0, toolMs = 0, firstEditTurn = null;
    for (const ev of events) {
        const ts = ev.timestamp ? Date.parse(ev.timestamp) : null;
        if (ts) { first ??= ts; last = ts; }
        if (ev.type === 'result') { result = ev; continue; }
        const msg = ev.message;
        if (ev.type === 'user' && Array.isArray(msg?.content)) {
            for (const c of msg.content) {
                if (c.type !== 'tool_result') continue;
                const text = Array.isArray(c.content) ? c.content.map(x => x.text ?? '').join('') : String(c.content ?? '');
                if (lastKey) resultChars.set(lastKey, (resultChars.get(lastKey) ?? 0) + text.length);
                if (ts && usedAt.has(c.tool_use_id)) { toolMs += ts - usedAt.get(c.tool_use_id); lastResultAt = ts; }
            }
            continue;
        }
        if (ev.type !== 'assistant' || !msg || msg.role !== 'assistant') continue;
        const key = msg.id ?? ev.requestId ?? ev.uuid;
        if (!perMessage.has(key)) {
            order.push(key);
            if (ts && lastResultAt) { modelMs += ts - lastResultAt; lastResultAt = null; }
        }
        lastKey = key;
        if (msg.model) models.add(msg.model);
        const u = msg.usage ?? {};
        const prev = perMessage.get(key) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
        perMessage.set(key, {
            input: Math.max(prev.input, u.input_tokens ?? 0),
            cacheWrite: Math.max(prev.cacheWrite, u.cache_creation_input_tokens ?? 0),
            cacheRead: Math.max(prev.cacheRead, u.cache_read_input_tokens ?? 0),
            output: Math.max(prev.output, u.output_tokens ?? 0),
        });
        for (const c of msg.content ?? []) {
            if (c.type === 'tool_use') {
                tools.push({ name: c.name, input: c.input ?? {} });
                outChars.set(key, (outChars.get(key) ?? 0) + JSON.stringify(c.input ?? {}).length);
                if (ts) usedAt.set(c.id, ts);
                if (firstEditTurn == null && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) firstEditTurn = order.length;
            }
            else if (c.type === 'text' && c.text) { finalText = c.text; outChars.set(key, (outChars.get(key) ?? 0) + c.text.length); }
            else if (c.type === 'thinking' && c.thinking) outChars.set(key, (outChars.get(key) ?? 0) + c.thinking.length);
        }
    }
    // Transcripts often keep a streamed message's usage from its first snapshot (output_tokens 1–10) and
    // store its thinking redacted, so the recorded output misses the model's reasoning. A message's output
    // stays in the context of the next call, so it is recovered as that call's context minus this call's
    // context minus the tool results in between (2.63 characters per token, fitted on calls that follow a
    // message without reasoning); the larger of that, the recorded value and ~4 chars/token of visible text.
    const ctxOf = (u) => u.input + u.cacheWrite + u.cacheRead;
    let outputRecorded = 0;
    order.forEach((key, i) => {
        const u = perMessage.get(key);
        outputRecorded += u.output;
        let est = Math.round((outChars.get(key) ?? 0) / 4);
        if (i + 1 < order.length) est = Math.max(est, Math.round(ctxOf(perMessage.get(order[i + 1])) - ctxOf(u) - (resultChars.get(key) ?? 0) / RESULT_CHARS_PER_TOKEN));
        u.output = Math.max(u.output, est);
    });
    for (const u of perMessage.values()) for (const k of Object.keys(usage)) usage[k] += u[k];
    const turns = perMessage.size;
    // headless runs report authoritative totals in the final result event
    if (result?.usage) {
        const u = result.usage;
        usage.input = u.input_tokens ?? usage.input;
        usage.cacheWrite = u.cache_creation_input_tokens ?? usage.cacheWrite;
        usage.cacheRead = u.cache_read_input_tokens ?? usage.cacheRead;
        usage.output = u.output_tokens ?? usage.output;
    }
    const counts = {};
    const bash = [];
    const reads = new Set(), edits = new Set();
    let giCalls = 0, grepCalls = 0;
    const giVars = new Set();
    for (const t of tools) if (t.name === 'Bash') t.cmd = expandGiVars(String(t.input.command ?? ''), giVars);
    for (const t of tools) {
        counts[t.name] = (counts[t.name] ?? 0) + 1;
        if (t.name === 'Bash') {
            const cmd = t.cmd;
            bash.push(cmd);
            if (GI_CMD.test(cmd)) giCalls++;
            if (isGrep(cmd) && grepUse(cmd, repo) === 'search') grepCalls++; // code searches, not output filters
        }
        if (t.name === 'Grep' || t.name === 'Glob') grepCalls++;
        if (t.name.startsWith('mcp__graph-indexer') || t.name.startsWith('mcp__plugin_graph-indexer')) giCalls++;
        if (t.name === 'Read' && t.input.file_path) reads.add(t.input.file_path);
        if ((t.name === 'Edit' || t.name === 'Write' || t.name === 'MultiEdit' || t.name === 'NotebookEdit') && (t.input.file_path || t.input.notebook_path)) edits.add(t.input.file_path || t.input.notebook_path);
    }
    // looking the answer up outside the repository invalidates a run whatever its arm
    const leaks = [];
    for (const t of tools) {
        if (t.name === 'WebSearch' || t.name === 'WebFetch') leaks.push(`${t.name}: ${JSON.stringify(t.input).slice(0, 100)}`);
        else if (t.name === 'Bash' && /(^|[\s;&|(])(curl|wget|git\s+(fetch|clone|pull|ls-remote)|pip3?\s+download|gh\s+(pr|api))\b/.test(t.cmd)) leaks.push(`bash: ${t.cmd.slice(0, 100)}`);
    }
    const violations = [], benign = [];
    // another run's answer, grading or worktree (its edits) gives the answer away, and so do the
    // source clones the worktrees are made from (they hold the later history, fix included);
    // listing the parent directories or reading another task's instructions does not
    if (work) {
        // path characters only (shell variables included: `${arm}`), so quotes, escapes and
        // punctuation around a path are not taken for part of it
        const under = new RegExp(`${work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:runs|wt|results|graded|repos)(?:/[\\w.+@%=\${}/-]*)?`, 'g');
        const mine = own.filter(Boolean).map(o => o.replace(/\/+$/, ''));
        for (const t of tools) {
            const text = t.name === 'Bash' ? t.cmd : JSON.stringify(t.input);
            for (const m of text.matchAll(under)) {
                const p = m[0].replace(/[./]+$/, '');
                if (mine.some(o => p === o || p.startsWith(o + '/'))) continue;
                const rel = p.slice(work.length).split('/').filter(Boolean);
                if (rel[0] === 'runs' && (rel.length <= 3 || (rel.length === 4 && rel[3] === 'INSTRUCTIONS.md'))) {
                    if (rel.length === 4) benign.push(`read another run's instructions: ${p.slice(0, 100)}`);
                    continue;
                }
                if ((rel[0] === 'wt' || rel[0] === 'repos') && rel.length <= 1) continue;
                leaks.push(`other run: ${p.slice(0, 100)}`);
                break;
            }
        }
    }
    const policy = arm ? POLICIES[arm] : null;
    if (policy) {
        for (const t of tools) {
            if (policy.forbidTools.includes(t.name)) violations.push(`${t.name} tool`);
            if (t.name !== 'Bash') continue;
            const cmd = t.cmd;
            for (const re of policy.forbidBash) {
                if (!re.test(cmd)) continue;
                // for the grep-free arm only code searches count; filtering output is allowed in spirit
                const use = re.test === isGrep ? grepUse(cmd, repo) : 'search';
                if (!use) continue; // the word only appears in quoted text (`echo "== grep x =="`)
                (use === 'filter' ? benign : violations).push(`bash: ${cmd.slice(0, 120)}`);
            }
        }
    }
    return {
        models: [...models],
        turns: result?.num_turns ?? turns,
        usage,
        outputRecorded,
        firstEditTurn,
        modelMs, toolMs,
        // input-equivalent tokens: a model-agnostic cost proxy with the usual price ratios
        // (cache write 1.25×, cache read 0.1×, output 5× the uncached input price)
        costUnits: Math.round(usage.input + 1.25 * usage.cacheWrite + 0.1 * usage.cacheRead + 5 * usage.output),
        toolCalls: tools.length,
        toolCounts: counts,
        giCalls, grepCalls,
        bashCommands: bash.length,
        filesRead: reads.size,
        filesEdited: [...edits],
        wallMs: result?.duration_ms ?? (first && last ? last - first : null),
        costUsd: result?.total_cost_usd ?? null,
        violations, benign, leaks,
        finalText: finalText.slice(0, 2000),
    };
}
