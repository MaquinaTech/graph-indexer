<environment_prompt layer="2" type="language" name="bash" requires="graph-indexer-core" version="1.0">

    <scope>Indexed code is Bash/shell (.sh .bash). Deltas to core; hard limits unchanged.</scope>

    <index_facts>
        <fact priority="critical">ONLY FUNCTIONS ARE CHUNKED. Top-level command sequences (script glue) have NO chunk — a script that runs purely at top level with no functions is INVISIBLE to search_code. Use get_file_skeleton(path) to read its structure; never conclude "nothing here" from an empty search.</fact>
        <fact>`source x` / `. x` ARE tracked, so Deps:/Used by: reflect sourced libraries (relative paths resolve). A function you can't find in the current file is often DEFINED in a sourced lib — follow Deps:.</fact>
        <fact>Every command is a potential call edge. Builtins and ubiquitous coreutils (echo, cd, grep, sed, awk, find…) are filtered; project functions and notable external tools (docker, git, npm, kubectl…) are kept as callees.</fact>
    </index_facts>

    <rules>
        <rule name="external-vs-internal">get_call_graph mixes calls to YOUR functions with invocations of external programs. A callee that doesn't resolve to an indexed function is an external command (a tool, not your code) — expected, never "dead code".</rule>
        <rule name="names-are-global">No objects/namespaces and all calls are unqualified (empty receiver). Within a script + its sourced libs, function names are globally unique, so get_call_graph("deploy_app") is RELIABLE for your own functions — the OO-language precision worry doesn't apply.</rule>
        <rule name="dynamic-invocation">`eval "$cmd"`, indirect expansion (`${!var}`), calling a function held in a variable (`"$handler" "$@"`), and `trap '…' EXIT` record NO usable edge. Find these by searching the function NAME as a string — it appears in the dispatch expression.</rule>
        <rule name="subshells-and-pipes">Functions inside `$(...)`, pipes, and `&` jobs still record command calls, but variable side effects don't escape the subshell — answer state/ordering questions from the function's own body, not the graph.</rule>
        <rule name="query-style">Function names are snake_case/kebab-case and split well; pin exact names with exact_tokens. To find an entrypoint, search the usage/help text or option-flag strings (`--force`, `usage:`) — far more unique than "main".</rule>
    </rules>

    <playbook question="explain what script X does" calls="1-3">get_file_skeleton(path) for the top-level flow → resolve_symbol("the_function") → get_chunk_summary(id, expand_calls: true). Follow at most ONE Deps: hop into a sourced lib for a function defined there.</playbook>

</environment_prompt>
