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
 *
 * When running in a harness without MCP (sub-agents, plain shells) graph-indexer is used through
 * its CLI, which prints exactly what the MCP tools return.
 */

export const ARM_NAMES = ['grep', 'gi', 'grep+gi', 'grep+gi+'];

/** Tool card: the same information an MCP client shows (tool descriptions + server instructions), CLI syntax. */
function basicCard(gi) {
    return `## graph-indexer (code index for this repository)
A live structural index of the repository — definitions, references bound through scopes/imports/receiver types, call graph, tests — re-synced with the files on every call. Run it through the shell with the executable \`${gi}\` (written \`gi\` below — type the full path):
- \`gi search "<what you are looking for>" [--path DIR] [--kind function|method|class|…] [--limit N]\` — find where a behaviour or identifier is implemented (natural language or identifiers); ranked symbols with location, signature and matching lines.
- \`gi symbol <Name | Class.member | path:Name | path:LINE> [--no-code]\` — read one definition with line numbers instead of a whole file, plus members, what it calls and who calls it.
- \`gi refs <symbol> [--kind call|type|inherit|new|value|decorator] [--no-tests] [--limit N]\` — every use of a symbol grouped by file with the enclosing function and confidence; same-name methods of other classes are told apart, and a footer says how many same-name call sites could not be bound.
- \`gi callgraph <symbol> [--direction callers|callees|both] [--depth N]\` — call hierarchy tree with locations.
- \`gi impact [--symbols A,B] [--files X,Y] [--diff] [--depth N]\` — blast radius of a change: dependents by distance, tests that exercise them, files that change together.
- \`gi outline [path] [--focus TEXT] [--max-tokens N]\` — skeleton of a file, or a ranked map of a directory/the repository.
Typical workflow: search → symbol → refs/callgraph before changing a signature → impact --diff before finishing. Use grep for string literals, config values and non-code files.`;
}

/** Integrated card: decision rules plus the verification/search commands of the integration. */
function integratedCard(gi, caps = {}) {
    const lines = [`## graph-indexer (code index for this repository)
A live structural index of the repository — definitions, references bound through scopes/imports/receiver types, call graph, tests — re-synced with the files on every call. Run it through the shell with the executable \`${gi}\` (written \`gi\` below — type the full path).

When to use what:
- You know an identifier and need its definition or uses → \`gi symbol\` / \`gi refs\` (exact, tells same-name methods apart); plain grep only for strings, config, docs and non-code files${caps.grep ? ` — or \`gi grep\`, which also says which definition each match refers to` : ''}.
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

const POLICY = {
    grep: 'Use your built-in tools (Read, Grep, Glob, Bash, Edit, Write) as you normally would.',
    gi: 'For searching and navigating code use graph-indexer (below) instead of Grep/Glob: do NOT use the Grep or Glob tools, and do NOT run grep, rg, ag, ack, git grep or find in the shell. You may use Read, Edit, Write, and Bash for everything else (running tests or builds, ls, git status/diff).',
    'grep+gi': 'Use your built-in tools (Read, Grep, Glob, Bash, Edit, Write) and, where it helps, graph-indexer (below).',
    'grep+gi+': 'Use your built-in tools (Read, Grep, Glob, Bash, Edit, Write) together with graph-indexer (below), following its "when to use what" rules.',
};

export function toolSection(arm, gi, caps = {}) {
    if (arm === 'grep') return `# Tools\n${POLICY.grep}`;
    const card = arm === 'grep+gi+' || (arm === 'gi' && (caps.grep || caps.check)) ? integratedCard(gi, caps) : basicCard(gi);
    return `# Tools\n${POLICY[arm]}\n\n${card}`;
}
