<environment_prompt layer="2" type="language" name="go" requires="graph-indexer-core" version="3.0">

    <scope>The indexed code is Go (.go). These are deltas to the core protocol — every hard limit is unchanged.</scope>

    <index_facts>
        <fact>Chunks: top-level funcs, methods, and type declarations. A method's signature includes its RECEIVER — `func (s *Server) Start()` — so the card already tells you whose method it is; always check the receiver before reasoning.</fact>
        <fact>Imports are tracked — Deps:/Used by: topology is RELIABLE here.</fact>
        <fact>Generated files (*.pb.go, mocks, stringer) are indexed like source and can dominate results — prefer detail: "signatures" and skip chunks whose path marks them generated.</fact>
        <fact>Struct values are built with composite literals (`&Engine{...}`, `Engine{}`) and constructors that return `*T` — NONE of these is a call edge. get_call_graph("Engine") on a struct is EMPTY, and that is never "unused". Enumerate consumers from the Used by: import topology plus ONE search_code(exact_tokens: "Engine", detail: "signatures") — signatures, so you get call-site locations not bodies; never read the whole defining file's skeleton to find them — a framework-core file is thousands of tokens, and resolve_symbol already carried the type's Used by: list.</fact>
    </index_facts>

    <rules>
        <rule name="package-scoped-names">Every package has a New, a Config, a Client: resolve_symbol("New") returns many candidates — disambiguate by package path on the cards, or query with a path hint ("storage client New connection pool"). Never spend calls reading every candidate.</rule>
        <rule name="interface-dispatch">Interface satisfaction is implicit and call sites bind by method NAME: get_call_graph("Process") mixes every Process across all types. To enumerate implementations: ONE search_code(query: "method receiver implementation", exact_tokens: "MethodName") and read the receivers off the signatures.</rule>
        <rule name="embedded-promotion">IF a call references a method the outer type does not define, the method lives in an EMBEDDED type — check the type declaration chunk for embedded fields before distrusting the index.</rule>
        <rule name="implicit-execution">init() functions and `_` blank imports run with no inbound edges — absence of callers is NOT dead code. `go fn()` and `defer fn()` ARE call edges; channel-based flow is not — trace channels by searching the channel field name.</rule>
        <rule name="first-class-functions">Functions passed as values (http.HandlerFunc(handle), middleware constructors) create no edge to the passed function — find reference sites with exact_tokens.</rule>
        <rule name="query-style">Always include package or domain words ("auth middleware token refresh", never bare "Refresh"). To find where an error originates, search its message string literal — the most unique token in the flow.</rule>
    </rules>

    <playbook question="explain X / who implements interface I" calls="1-3">resolve_symbol("X") (check receiver) → get_chunk_summary(id, expand_calls: true) → answer. Implementors of I: ONE exact_tokens search on the method name — receivers in the signatures are the answer, no per-type reads.</playbook>

</environment_prompt>
