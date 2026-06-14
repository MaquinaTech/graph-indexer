<environment_prompt layer="2" type="language" name="javascript-typescript" requires="graph-indexer-core" version="3.0">

    <scope>The indexed code is JavaScript / TypeScript (.js, .jsx, .mjs, .cjs, .ts, .tsx). These are deltas to the core protocol — every hard limit is unchanged.</scope>

    <index_facts>
        <fact>Chunks: functions, classes, methods, and exported constants. An arrow function assigned to a const chunks under the VARIABLE name — resolve_symbol("handleSubmit") finds `const handleSubmit = () => {...}`.</fact>
        <fact>Imports are tracked for BOTH ESM and require — Deps:/Used by: topology is RELIABLE here. Read usage from it before considering any usage search.</fact>
        <fact>Anonymous default exports (`export default () => {...}`) have no stable name: locate by get_file_skeleton(path) or behavioural search, never by guessing a name.</fact>
        <fact>Interfaces, type aliases, and enums resolve like values but NEVER appear in get_call_graph (types are not called) — their usage sites come from Used by: or one exact_tokens search.</fact>
        <fact>A class instantiated with `new ClassName()` DOES create a call edge: get_call_graph("Layer") returns its construction sites. So for a class's blast radius it is the cheap precise first move (~15 tok) — never read a router/module file skeleton to hunt `new` sites. (A class used only as a type annotation still shows none — fall back to Used by: + ONE search_code(exact_tokens: "Name", detail: "signatures") then.)</fact>
    </index_facts>

    <rules>
        <rule name="barrel-files">IF resolution lands on a re_export node (index.ts barrels): internal origin → spend ONE call on the origin symbol; external dependency → stop, the implementation is outside the repo.</rule>
        <rule name="callbacks-no-edges">Passing a function as a VALUE creates no call edge: `items.map(transform)` records a call to map, not transform. IF a callback-style function shows an empty call graph, it is NOT dead — find reference sites with ONE search using exact_tokens.</rule>
        <rule name="dynamic-imports">`await import(computedPath)` / `require(variable)` create no dependency edge. IF Used by: looks empty for a module that should be popular, suspect dynamic loading before declaring it unused.</rule>
        <rule name="name-overmatch">`this.method()` and object-property calls bind by NAME; common names (get, run, handle) overmatch across classes, and declaration merging returns several nodes for one name — pick by file path and node type on the cards; never spend calls reading every candidate.</rule>
        <rule name="event-emitters">`emitter.on("event", fn)` pairs connect by STRING, not call edge — trace event flow by searching the event name string.</rule>
        <rule name="query-style">camelCase/PascalCase token-split well, so partial-name keyword queries work; for async flows describe the behaviour ("retries the fetch with exponential backoff"), never the keyword "async".</rule>
    </rules>

    <playbook question="explain service/module X" calls="2-3">resolve_symbol("X") → get_chunk_summary(id, expand_calls: true) → answer with the Used by: list; at most ONE consumer chunk as example (hard limit 4). Several named symbols? ONE batched search per hard limit 2.</playbook>

</environment_prompt>
