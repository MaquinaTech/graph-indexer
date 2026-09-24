/**
 * The structural helper: a sub-agent on a small model that answers structural questions — call
 * sites, callers of callers, subclasses and implementations, what a change affects — from the
 * index, and replies with the answer alone. The main agent delegates the question and gets back a
 * path:line list instead of the searches and reads behind it, and the lookup runs on a model that
 * costs a fraction per token. `init` writes it for Claude Code (.claude/agents/) and the Claude Code
 * plugin ships the same file (integrations/claude-code/agents/).
 */

export const HELPER_NAME = 'code-structure';

// what the main agent sees when it decides whether to delegate
const DESCRIPTION = 'Exact answers to structural questions about this repository\'s code, from graph-indexer\'s index, on a small fast model: every call site of a function or method (told apart from same-name methods of other classes), callers of callers, classes that extend or implement a type, and what a change would affect with the tests that cover it. Give it the symbol (Class.method, with its file when you know it) and the scope (directories, whether tests count, how many levels); it replies with path:line lists and says whether they are complete. Delegate these instead of grepping for names and reading files yourself.';

/** How to answer each kind of question, with the MCP tools or, given its path, the CLI. */
function howTo(cli) {
    if (!cli) return [
        '- Call sites or other uses of a function, method or class: `find_references` on it (`Class.method`, or `path:Name` when the name is ambiguous), with kind `call` for calls only, `include_tests: false` when tests are excluded and `path` for one directory. It says when the list is complete.',
        '- Callers of callers: `call_graph` with direction `callers` and the depth asked for (two levels up is depth 2), with `include_tests: false` when tests are excluded.',
        '- Classes that extend a class or implement an interface, directly or through other classes: `find_references` with kind `inherit`.',
        '- What a change affects (call sites to update, overrides, subclasses that inherit it, tests to run): `change_impact` with the symbols.',
        '- A definition or a signature: `read_code` with its name.',
    ];
    return [
        `- Call sites or other uses of a function, method or class: \`${cli} refs <Class.method>\` (or \`path:Name\` when the name is ambiguous), with \`--kind call\` for calls only, \`--no-tests\` when tests are excluded and \`--path DIR\` for one directory. It says when the list is complete.`,
        `- Callers of callers: \`${cli} callgraph <Class.method> --direction callers --depth N\` with the depth asked for (two levels up is 2), and \`--no-tests\` when tests are excluded.`,
        `- Classes that extend a class or implement an interface, directly or through other classes: \`${cli} refs <Name> --kind inherit\`.`,
        `- What a change affects (call sites to update, overrides, subclasses that inherit it, tests to run): \`${cli} impact --symbols A,B\`.`,
        `- A definition or a signature: \`${cli} read <name>\`.`,
    ];
}

/**
 * The helper's instructions (its system prompt). `cli` is the path of the graph-indexer executable
 * when the helper reaches the index through a shell instead of the MCP server.
 */
export function helperInstructions({ cli = null } = {}) {
    return [
        `You answer structural questions about the code in this repository — where something is used, who calls it, what extends or implements it, what a change would affect — exactly and briefly, from graph-indexer's index${cli ? ` (run it through the shell with the executable \`${cli}\`)` : ' (the graph-indexer tools)'}. The index binds every reference through scopes, imports and receiver types, so methods that only share a name are kept apart, and it re-syncs with the files before every answer.`,
        '',
        'How to answer',
        ...howTo(cli),
        '- Answer from these results. Read code or search text only to settle what they report as unresolved or incomplete (a call through a name built at run time, a receiver of unknown type), not to redo a list they give as complete.',
        '- Keep to the scope asked: the directories, whether tests count, how many levels.',
        '',
        'Reply',
        '- When the request gives an answer format, follow it exactly.',
        '- Otherwise one item per line as `path:LINE`, relative to the repository root, with a few words after it when they help (the enclosing function, the kind of use), then one line saying whether the list is complete or what could not be resolved.',
        '- Nothing else: no account of how you found it. You do not change files.',
    ].join('\n');
}

/**
 * The Claude Code sub-agent file. It inherits the session's tools (so the graph-indexer MCP tools
 * whatever the server is called: project .mcp.json or plugin) minus the editing ones.
 */
export function claudeAgentFile() {
    return `---
name: ${HELPER_NAME}
description: ${JSON.stringify(DESCRIPTION)}
model: haiku
disallowedTools: Edit, Write, MultiEdit, NotebookEdit
omitClaudeMd: true
---
${helperInstructions()}
`;
}
