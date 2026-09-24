/**
 * Agent configurations ("arms") compared by the benchmark. Every arm gets the same model, task,
 * repository and instructions; arms differ only in the code-navigation tools they may use and in
 * how those tools are introduced.
 *
 *   grep      the agent's built-in tools only (Read, Grep, Glob, Bash, Edit, Write)
 *   gi        graph-indexer replaces grep/glob: no Grep/Glob tools, no grep/rg/find in the shell
 *   grep+gi   built-in tools plus graph-indexer, introduced like an MCP server (tool card)
 *   grep+gi+  built-in tools plus graph-indexer with the integrated workflow (decision rules and
 *             the verification commands the integration adds)
 *   grep+gi2  second iteration of the integrated card: verification only for changes that cross a
 *             function's boundary
 *   gi2       the grep-free arm with the second card (plus `gi files` for file names)
 *   grep+gi3  the second card for graph-indexer with indirect subtypes, `refs --path` and complete-list notes
 *   gi3       its grep-free counterpart
 *   grep+rules  built-in tools plus rules on how to look code up (several things per call, the lines
 *             needed rather than the file, one check at the end) — no graph-indexer
 *   grep+gi4  the same rules with graph-indexer's reads: `gi read` lists where every name the code
 *             uses is defined, so the two arms separate what the rules do from what the index adds
 *   grep+gi5  the control's rules word for word, pointed at graph-indexer where it replaces a search
 *             (a definition by name, uses, the tests closest to an edit), with compact reads
 *   grep+gi6  the control's rules for reading and searching, and graph-indexer only for exact uses,
 *             callers, impact and the edit check
 *   grep+gi7  grep+gi6 with graph-indexer's post-read hook: code is read with a \`view\` command that
 *             prints what Read prints plus what the hook adds after a Read (the indirection the lines
 *             involve, resolved; where names are defined while crawling) — hooks do not run in sub-agents
 *   ask-grep  a delegated question: a general-purpose sub-agent gets the question as its message,
 *             like one a main agent hands off, and its reply is the answer; built-in tools only
 *   ask-explore the same message to the built-in Explore agent (read-only search), built-in tools
 *   ask-helper the same message to the structural helper `init` installs (src/cli/helper.mjs): its
 *             instructions, then the message; graph-indexer through the CLI
 *   mcp       graph-indexer as users install it: the MCP server plus the block `init` writes to
 *             CLAUDE.md/AGENTS.md; needs a harness with MCP (run-headless.mjs)
 *   mcp+hooks the same plus the Claude Code hooks (edit check, definition rescue, crawl-gated context)
 *   cc        a real Claude Code session with the tools it ships with, sub-agents (Explore,
 *             general-purpose) included; no graph-indexer (run-headless.mjs)
 *   cc+gi     the same with graph-indexer as `init --no-helper` installs it: the MCP server and the
 *             CLAUDE.md block
 *   cc+gi+helper  as `init` installs it: also the structural helper sub-agent, which the main agent
 *             may hand structural questions to (routing inside a session)
 *   cc+v2     the same session with graph-indexer 2.x as its `init` installed it: its MCP server over
 *             its own index, and CLAUDE.md importing its assembled prompt suite (bench/agentic/v2.mjs)
 *
 * When running in a harness without MCP (sub-agents, plain shells) graph-indexer is used through
 * its CLI, which prints exactly what the MCP tools return.
 */

export const ARM_NAMES = ['grep', 'gi', 'grep+gi', 'grep+gi+', 'grep+gi2', 'gi2', 'grep+gi3', 'gi3', 'grep+rules', 'grep+gi4', 'grep+gi5', 'grep+gi6', 'grep+gi7', 'ask-grep', 'ask-explore', 'ask-helper', 'mcp', 'mcp+hooks', 'cc', 'cc+gi', 'cc+gi+helper', 'cc+v2'];

/**
 * Arms that answer a delegated question: the sub-agent type to launch, and whether the message
 * starts with the structural helper's instructions. The reply is graded, not an answer file.
 */
export const ASK_ARMS = {
    'ask-grep': { agentType: 'general-purpose', helper: false },
    'ask-explore': { agentType: 'Explore', helper: false },
    'ask-helper': { agentType: 'general-purpose', helper: true },
};

/** Arms that read through \`view\` (Read plus the post-read hook's context). */
export const VIEW_ARMS = new Set(['grep+gi7']);

/**
 * Real Claude Code sessions: whether graph-indexer is installed (the MCP server, and the CLAUDE.md
 * block in the session's directory) and whether the structural helper is (.claude/agents/ there),
 * each exactly as `init` writes them.
 */
export const SESSION_ARMS = {
    cc: { index: false, helper: false },
    'cc+gi': { index: true, helper: false },
    'cc+gi+helper': { index: true, helper: true },
    // graph-indexer 2.x as its `init` installed it (MCP server, index and prompt suite), for the v2 comparison
    'cc+v2': { index: true, helper: false, v2: true },
};

/** Arms that need a harness with the MCP server (and hooks) wired in, not sub-agents following a card. */
export const HARNESS_ARMS = new Set(['mcp', 'mcp+hooks', ...Object.keys(SESSION_ARMS)]);

/** Arms whose agent gets graph-indexer (an index is built for their checkout). */
export const usesIndex = (arm) => arm !== 'grep' && arm !== 'grep+rules' && !(ASK_ARMS[arm] && !ASK_ARMS[arm].helper) && !(SESSION_ARMS[arm] && !SESSION_ARMS[arm].index);

import { managedBlock } from '../../src/cli/init.mjs';
import { helperInstructions } from '../../src/cli/helper.mjs';

/**
 * The message a main agent sends when it delegates a question: the repository, the question and
 * the answer format. The helper arm's message starts with the helper's instructions, which the
 * product installs as the sub-agent's system prompt.
 */
export function askMessage(arm, task, checkout, gi = null) {
    const msg = `Repository root: \`${checkout}\`. Your working directory is a different repository: use absolute paths and pass this root to every search. Work offline (no web, no downloads) and do not modify any file.

${task.statement}

Answer format: ${task.answerFormat}
Be efficient, but the answer must be complete and correct. Reply with the answer alone.`;
    return ASK_ARMS[arm].helper ? `${helperInstructions({ cli: gi })}\n\n---\n\n${msg}` : msg;
}

/** Tool card: the same information an MCP client shows (tool descriptions + server instructions), CLI syntax. */
function basicCard(gi, { grep = true } = {}) {
    return `## graph-indexer (code index for this repository)
A live structural index of the repository — definitions, references bound through scopes/imports/receiver types, call graph, tests — re-synced with the files on every call. Run it through the shell with the executable \`${gi}\` (written \`gi\` below — type the full path):
- \`gi search "<what you are looking for>" [--path DIR] [--kind function|method|class|…] [--limit N]\` — find where a behaviour or identifier is implemented (natural language or identifiers); ranked symbols with location, signature and matching lines.
- \`gi symbol <Name | Class.member | path:Name | path:LINE> [--no-code]\` — read one definition with line numbers instead of a whole file, plus members, what it calls and who calls it.
- \`gi refs <symbol> [--kind call|type|inherit|new|value|decorator] [--no-tests] [--limit N]\` — every use of a symbol grouped by file with the enclosing function and confidence; same-name methods of other classes are told apart, and a footer says how many same-name call sites could not be bound.
- \`gi callgraph <symbol> [--direction callers|callees|both] [--depth N]\` — call hierarchy tree with locations.
- \`gi impact [--symbols A,B] [--files X,Y] [--diff] [--depth N]\` — blast radius of a change: dependents by distance, tests that exercise them, files that change together.
- \`gi outline [path] [--focus TEXT] [--max-tokens N]\` — skeleton of a file, or a ranked map of a directory/the repository.
Typical workflow: search → symbol → refs/callgraph before changing a signature → impact --diff before finishing.${grep ? ' Use grep for string literals, config values and non-code files.' : ''}`;
}

/** Integrated card: decision rules plus the verification/search commands of the integration. */
function integratedCard(gi, caps = {}, { grep = true } = {}) {
    const textRule = grep
        ? `plain grep only for strings, config, docs and non-code files${caps.grep ? ` — or \`gi grep\`, which also says which definition each match refers to` : ''}`
        : caps.grep ? `\`gi grep\` for strings, config, docs and non-code files (it also says which definition each code match refers to)` : 'read the files for strings, config and docs';
    const lines = [`## graph-indexer (code index for this repository)
A live structural index of the repository — definitions, references bound through scopes/imports/receiver types, call graph, tests — re-synced with the files on every call. Run it through the shell with the executable \`${gi}\` (written \`gi\` below — type the full path).

When to use what:
- You know an identifier and need its definition or uses → \`gi symbol\` / \`gi refs\` (exact, tells same-name methods apart); ${textRule}.
- You need to find code for a behaviour described in words → \`gi search\`, then \`gi symbol\` on the best hit.
- Before changing a signature, renaming, or changing behaviour others rely on → \`gi refs\` / \`gi callgraph --direction callers\` to get every call site first.
${caps.check ? `- After editing → \`gi check\`: lists call sites that no longer match the new definitions, references to removed names, and the tests to run.\n` : ''}- Before finishing → \`gi impact --diff\` to see what depends on your change and which tests to run.

Commands:
- \`gi search "<behaviour or identifier>" [--path DIR] [--kind K] [--limit N]\` — ranked symbols with location, signature and matching lines.
- \`gi symbol <Name | Class.member | path:Name | path:LINE> [--no-code]\` — one definition with line numbers, members, callers/callees summary.
- \`gi refs <symbol> [--kind call|type|inherit|new|value|decorator] [--no-tests]\` — every use, grouped by file, with confidence and unbound same-name call sites.
- \`gi callgraph <symbol> [--direction callers|callees|both] [--depth N]\` — call hierarchy.
- \`gi impact [--symbols A,B] [--files X,Y] [--diff]\` — dependents, tests to run, co-change.
- \`gi outline [path] [--focus TEXT]\` — file skeleton or ranked map.`];
    if (caps.grep) lines.push(`- \`gi grep <regex> [--path DIR] [--literal] [-i]\` — text search over all files (code, config, docs); code matches are grouped by enclosing symbol and identifier matches say which definition they refer to.`);
    if (caps.check) lines.push(`- \`gi check [--files X,Y]\` — verify your uncommitted edits: broken call sites (argument count), references to removed or renamed symbols, callers of changed signatures you did not touch, and the test files to run.`);
    return lines.join('\n');
}

/**
 * Integrated card, second iteration (after the first benchmark round): the verification steps
 * are for changes that cross a function's boundary; a local fix is checked by its tests. On the
 * fresh bug-fix tasks the first card's unconditional "check / impact before finishing" added turns
 * without adding solved tasks. Without grep (gi2) the card also covers text and file-name search.
 */
function integratedCard2(gi, { grep = true, v = 2 } = {}) {
    const head = `## graph-indexer (code index for this repository)
A live structural index of the repository — definitions, references bound through scopes/imports/receiver types, call graph, tests — re-synced with the files on every call. Run it through the shell with the executable \`${gi}\` (written \`gi\` below — type the full path).`;
    const rules = [
        grep ? 'When it saves work (otherwise use your usual tools):' : 'When to use what:',
        ...(grep ? [] : [
            '- Files by name or path → `gi files <text|glob>`; text anywhere (identifiers, strings, config, docs) → `gi grep <regex>`.',
        ]),
        `- Uses of a known function/method/class, especially when other classes share the name → \`gi refs\` (exact call sites; same-name methods told apart)${grep ? ' instead of grepping the name' : ''}.`,
        '- Where a behaviour described in words lives → `gi search`, then `gi symbol` on the hit (several targets at once: `gi symbol A B C`).',
        '- Changing a signature, renaming or removing something, or changing behaviour other code relies on → `gi impact --symbols X` first (all call sites and tests), `gi check` after editing.',
        '- A fix inside one function that keeps its signature needs neither impact nor check: run the tests that cover it and finish.',
    ];
    const commands = [
        'Commands:',
        v >= 3
            ? '- `gi refs <symbol> [--kind call|type|inherit|new|value] [--path DIR] [--no-tests]` — every use, grouped by file, with confidence; for a class or interface also what inherits it indirectly; says when the list is complete, lists same-name calls it could not bind and names used as strings (stubs, getattr).'
            : '- `gi refs <symbol> [--kind call|type|inherit|new|value] [--no-tests]` — every use, grouped by file, with confidence; lists same-name calls it could not bind and names used as strings (stubs, getattr).',
        '- `gi symbol <Name | Class.member | path:Name | path:LINE>… [--no-code]` — definitions with line numbers, members, callers/callees summary.',
        '- `gi search "<behaviour or identifier>" [--path DIR] [--kind K] [--limit N]` — ranked symbols with location and matching lines.',
        '- `gi grep <regex> [--path DIR] [--literal] [-i]` — text search over all files; each code match shows its enclosing definition and, for identifiers, the definition it refers to.',
        ...(grep ? [] : ['- `gi files <text|glob> [--path DIR]` — files whose path contains the text, or matches a glob (`*.toml`, `tests/test_*.py`).']),
        '- `gi impact [--symbols A,B] [--files X,Y] [--diff]` — call sites to update, overrides, dependents, tests to run.',
        '- `gi check [--files X,Y]` — after a cross-function change: broken call sites, references to removed names, tests to run.',
        '- `gi callgraph <symbol> [--direction callers|callees|both] [--depth N]` · `gi outline [path]` — call hierarchy; file skeleton or area map.',
    ];
    return [head, '', rules.join('\n'), '', commands.join('\n')].join('\n');
}

/** How to look code up with the built-in tools only (the control for grep+gi4). */
function rulesCard() {
    return `## How to look code up
- Explore in one pass: when you need several definitions or files, ask for them together — several tool calls in one message, or one search with alternatives — not one search per turn.
- Read keyholes, not files: the function or the 50–100 lines you need (Read with offset/limit); find the line first (grep -n).
- To find where a name is defined, search for its definition line (\`def name\`, \`class Name\`) across the package in one search, not directory by directory.
- Check once: run the tests that cover your change when you are done; do not re-run a check nothing has changed.`;
}

/** Fourth card: the same rules, with graph-indexer's reads carrying the definitions of the names they use. */
function giCard4(gi) {
    return `## graph-indexer (code index for this repository)
A live structural index of the repository — definitions, references bound through scopes, imports and receiver types, call graph, tests — re-synced with the files on every call. Run it through the shell with the executable \`${gi}\` (written \`gi\` below — type the full path).

How to look code up:
- Explore in one pass: when you need several definitions or files, ask for them together — several tool calls in one message, or one \`gi read\` with several targets (symbols such as \`Class.method\`, ranges such as \`path:120-180\`) — not one search per turn.
- Read keyholes, not files: the function or the 50–100 lines you need. \`gi read <file>\` of a long file returns its outline, with the line range of every definition.
- Follow names through the index: every \`gi read\` lists where each name the code uses is defined (file:line and signature); read those targets instead of grepping for their definitions.
- Uses of a function, method or class, especially when other classes share the name → \`gi refs\` (exact call sites) instead of grepping the name; when it reports the list as complete, a grep only repeats it. Callers of callers → one \`gi callgraph X --direction callers --depth 2\`.
- Text that is not a code name (messages, config keys, strings) → grep as usual, or \`gi grep\`, which also says where the definition of a searched name is.
- Changing a signature, renaming or removing something, or behaviour other code relies on → \`gi impact --symbols X\` first, \`gi check\` after editing. A fix inside one function needs neither: run the tests that cover it, once.
- Your Edit tool may require its own Read of a file before editing it: read just the lines you change.

Commands:
- \`gi read <target>… [--full]\` — symbols (Name, Class.method, path:Name), ranges (path:START-END) or files, up to 12 per call: code with line numbers, then where each name it uses is defined.
- \`gi refs <symbol> [--kind call|type|inherit|new|value] [--path DIR] [--no-tests]\` — every use, grouped by file, with confidence; says when the list is complete.
- \`gi grep <regex> [--path DIR] [--literal] [-i]\` — text search over all files; code matches show their enclosing definition and, for identifiers, the definition they refer to.
- \`gi search "<behaviour or identifier>" [--path DIR] [--kind K]\` — ranked symbols for a behaviour described in words.
- \`gi impact [--symbols A,B] [--files X,Y] [--diff]\` · \`gi check [--files X,Y]\` — call sites to update and tests to run; what an edit broke.
- \`gi callgraph <symbol> [--direction callers|callees|both] [--depth N] [--no-tests]\` · \`gi outline [path]\` — call hierarchy (every caller at each level, and whether the list is complete); file skeleton or area map.`;
}

/**
 * Fifth card: the control's rules word for word, pointed at graph-indexer where it does the same job
 * with less reading (a definition by name, uses, the tests closest to an edit), and a short command
 * list. Round 4 showed the fourth card's reads carrying more text than they saved on real issues.
 */
function giCard5(gi) {
    return `## graph-indexer (code index for this repository)
A live index of this repository's definitions, references, call graph and tests, re-synced on every call. Run it through the shell with the executable \`${gi}\` (written \`gi\` below — type the full path).

## How to look code up
- Explore in one pass: when you need several definitions or files, ask for them together — several tool calls in one message, or one \`gi read\` with several targets — not one search per turn.
- Read keyholes, not files: the function or the 50–100 lines you need (\`gi read Class.method\`, \`gi read path:120-180\`, or Read with offset/limit).
- To find where a name is defined, \`gi read <name>\` — or the "Defined elsewhere" lines under every \`gi read\` — not a search, and not directory by directory.
- Uses of a function or class: \`gi refs <name>\` (exact call sites; it says when the list is complete). Callers of callers: \`gi callgraph <name> --direction callers --depth 2\`. Text that is not a code name: grep as usual.
- Check once: when you are done, \`gi check\` says what your edit broke and which tests are closest to it; run those tests; do not re-run a check nothing has changed.
- Your Edit tool may require its own Read of a file before editing it: read just the lines you change.

Commands: \`gi read <target>…\` (symbols, path:START-END ranges or files — a long file gives its outline — up to 12 per call) · \`gi refs <name> [--kind call|type|inherit] [--no-tests]\` · \`gi callgraph <name> [--direction callers|callees] [--depth N]\` · \`gi grep <regex>\` · \`gi search "<behaviour in words>"\` · \`gi impact --symbols A,B\` · \`gi check\``;
}

/**
 * Sixth card: the control's rules word for word for reading and searching, and graph-indexer only
 * for what text search cannot answer exactly. In rounds 4a/4b the gains on questions came from
 * `gi refs`, while on real issues agents used `gi read`/`gi grep` in place of their own reads and
 * searches, which returned more text than they saved.
 */
function giCard6(gi) {
    return `${rulesCard()}

## graph-indexer (code index for this repository)
A live index of this repository's definitions, references, call graph and tests, re-synced on every call. Run it through the shell with the executable \`${gi}\` (written \`gi\` below — type the full path). Use it for what a text search cannot answer exactly:
- Uses of a function, method or class, even when other code shares its name: \`gi refs <name>\` (exact call sites; it says when the list is complete). Callers of callers: \`gi callgraph <name> --direction callers --depth 2\`. Classes that implement or extend a type: \`gi refs <name> --kind inherit\`.
- Before changing a signature or behaviour other code relies on: \`gi impact --symbols <name>\`. When you are done: \`gi check\` says what your edit broke and which test functions are closest to it — run those.
- A definition a search did not find: \`gi read <name>\`.`;
}

/**
 * Seventh card: the sixth, with reads through the post-read hook. The hook's context after a Read is
 * what the product adds in hosts with hooks; \`view\` gives the same text in one shell command.
 */
function giCard7(gi, view) {
    return `${giCard6(gi)}

## Reading code
Read source code only with \`${view} <path> [offset] [limit]\` (written \`view\` here — type the full path), not with the Read tool, cat, sed, head or tail: it prints the same numbered lines as Read, followed by graph-indexer's notes on those lines when there is something to resolve — which override of a method a subclass runs and which subclasses inherit it, which registration-table entry handles a key, what calls a method by a name built at run time, what a decorator is — each with its location, so you can use it instead of looking it up. The one exception: your Edit tool may require its own Read of a file before editing it — Read just the lines you change.`;
}

const POLICY = {
    grep: 'Use your built-in tools (Read, Grep, Glob, Bash, Edit, Write) as you normally would.',
    gi: 'For searching and navigating code use graph-indexer (below) instead of Grep/Glob: do NOT use the Grep or Glob tools, and do NOT run grep, rg, ag, ack, git grep or find in the shell. You may use Read, Edit, Write, and Bash for everything else (running tests or builds, ls, git status/diff).',
    'grep+gi': 'Use your built-in tools (Read, Grep, Glob, Bash, Edit, Write) and, where it helps, graph-indexer (below).',
    'grep+gi+': 'Use your built-in tools (Read, Grep, Glob, Bash, Edit, Write) together with graph-indexer (below), following its "when to use what" rules.',
    'grep+gi2': 'Use your built-in tools (Read, Grep, Glob, Bash, Edit, Write) together with graph-indexer (below) where it saves work.',
};
POLICY.gi2 = POLICY.gi;
POLICY['grep+gi3'] = POLICY['grep+gi2'];
POLICY.gi3 = POLICY.gi;
POLICY['grep+rules'] = 'Use your built-in tools (Read, Grep, Glob, Bash, Edit, Write), following the rules below.';
POLICY['grep+gi4'] = 'Use your built-in tools (Read, Grep, Glob, Bash, Edit, Write) together with graph-indexer (below), following its rules.';
POLICY['grep+gi5'] = 'Use your built-in tools (Read, Grep, Glob, Bash, Edit, Write) together with graph-indexer (below), following the rules below.';
POLICY['grep+gi6'] = 'Use your built-in tools (Read, Grep, Glob, Bash, Edit, Write), following the rules below, and graph-indexer where it says.';
POLICY['grep+gi7'] = 'Use your built-in tools (Grep, Glob, Bash, Edit, Write), following the rules below, and graph-indexer where it says — except for reading source code: read it only with `view` (see "Reading code" below), never with Read, cat, sed, head or tail, apart from the Read your Edit tool requires right before an edit.';
POLICY.mcp = 'Use your built-in tools and the graph-indexer MCP tools as you see fit.';
POLICY['mcp+hooks'] = POLICY.mcp;
// a session's own configuration (CLAUDE.md, MCP servers, sub-agents) is all that differs between these
for (const a of Object.keys(SESSION_ARMS)) POLICY[a] = 'Use your tools as you normally would.';

export function toolSection(arm, gi, caps = {}, view = null) {
    if (arm === 'grep+gi7') return `# Tools\n${POLICY[arm]}\n\n${giCard7(gi, view)}`;
    if (arm === 'grep') return `# Tools\n${POLICY.grep}`;
    if (SESSION_ARMS[arm]) return `# Tools\n${POLICY[arm]}`;
    if (arm === 'grep+rules') return `# Tools\n${POLICY[arm]}\n\n${rulesCard()}`;
    if (arm === 'grep+gi4') return `# Tools\n${POLICY[arm]}\n\n${giCard4(gi)}`;
    if (arm === 'grep+gi5') return `# Tools\n${POLICY[arm]}\n\n${giCard5(gi)}`;
    if (arm === 'grep+gi6') return `# Tools\n${POLICY[arm]}\n\n${giCard6(gi)}`;
    // what a user's CLAUDE.md / AGENTS.md carries after `graph-indexer init`
    if (HARNESS_ARMS.has(arm)) return `# Tools\n${POLICY[arm]}\n\n${managedBlock().replace(/<!-- graph-indexer:(start|end) -->\n?/g, '').trim()}`;
    if (arm === 'grep+gi2' || arm === 'gi2') return `# Tools\n${POLICY[arm]}\n\n${integratedCard2(gi, { grep: arm === 'grep+gi2' })}`;
    if (arm === 'grep+gi3' || arm === 'gi3') return `# Tools\n${POLICY[arm]}\n\n${integratedCard2(gi, { grep: arm === 'grep+gi3', v: 3 })}`;
    const grep = arm !== 'gi';
    const card = arm === 'grep+gi+' || (arm === 'gi' && (caps.grep || caps.check)) ? integratedCard(gi, caps, { grep }) : basicCard(gi, { grep });
    return `# Tools\n${POLICY[arm]}\n\n${card}`;
}
