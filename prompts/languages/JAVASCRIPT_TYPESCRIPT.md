<environment_prompt layer="2" type="language" name="javascript-typescript" requires="graph-indexer-core" version="1.0">

    <scope>Indexed code is JavaScript/TypeScript (.js .jsx .mjs .cjs .ts .tsx). Deltas to core; hard limits unchanged.</scope>

    <index_facts>
        <fact>Chunks: functions, classes, methods, exported consts. An arrow fn assigned to a const chunks under the VARIABLE name — resolve_symbol("handleSubmit") finds `const handleSubmit = () => {...}`.</fact>
        <fact>Topology RELIABLE — ESM and require both tracked. Read Deps:/Used by: before any usage search.</fact>
        <fact>Anonymous default exports (`export default () => {}`) have no stable name — locate via get_file_skeleton(path) or behavioural search, never by guessing.</fact>
        <fact>Interfaces, type aliases, enums resolve like values but NEVER appear in get_call_graph (types aren't called) — usage from Used by: or ONE exact_tokens search.</fact>
        <fact>`new ClassName()` DOES create a call edge → get_call_graph("Layer") returns construction sites: the cheap precise first move for a class's blast radius (~15 tok), no file reads. (A class used only as a type annotation shows none → Used by: + ONE search_code(exact_tokens: "Name", detail: "signatures").)</fact>
    </index_facts>

    <rules>
        <rule name="barrel-files">Resolution landing on a re_export (index.ts barrel): internal origin → ONE hop to the origin; external dependency → stop, implementation is outside the repo.</rule>
        <rule name="callbacks-no-edges">A function passed as a VALUE has no edge: `items.map(transform)` records a call to map, not transform. An empty call graph on a callback-style fn is NOT dead — find sites with ONE exact_tokens search.</rule>
        <rule name="dynamic-imports">`await import(computedPath)` / `require(variable)` create no dependency edge. Empty Used by: on a module that should be popular → suspect dynamic loading before declaring it unused.</rule>
        <rule name="name-overmatch">`this.method()` and property calls bind by NAME; common names (get, run, handle) overmatch across classes, and declaration merging returns several nodes for one name — pick by file path + node type on the cards, no extra reads.</rule>
        <rule name="event-emitters">`emitter.on("event", fn)` pairs connect by STRING, not call edge — trace event flow by searching the event-name string.</rule>
        <rule name="query-style">camelCase/PascalCase split well so partial-name keyword queries work; for async flows describe behaviour ("retries the fetch with exponential backoff"), never the keyword "async".</rule>
    </rules>

    <playbook question="explain service/module X" calls="2-3">resolve_symbol("X") → get_chunk_summary(id, expand_calls: true) → answer with the Used by: list; ≤1 consumer chunk as example.</playbook>

</environment_prompt>
