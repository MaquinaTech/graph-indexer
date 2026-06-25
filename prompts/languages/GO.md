<environment_prompt layer="2" type="language" name="go" requires="graph-indexer-core" version="1.0">

    <scope>Indexed code is Go (.go). Deltas to core; hard limits unchanged.</scope>

    <index_facts>
        <fact>Chunks: top-level funcs, methods, type decls. A method's signature includes its RECEIVER — `func (s *Server) Start()` — so the card already says whose method it is; check the receiver before reasoning.</fact>
        <fact>Topology RELIABLE — imports tracked.</fact>
        <fact>Generated files (*.pb.go, mocks, stringer) are indexed like source and can dominate results — prefer detail: "signatures" and skip generated paths.</fact>
        <fact>Struct construction (`&Engine{...}`, `Engine{}`, constructors returning `*T`) is NOT a call edge → get_call_graph("Engine") on a struct is EMPTY, never "unused". Enumerate consumers from Used by: + ONE search_code(exact_tokens: "Engine", detail: "signatures") for call-site locations; never read the whole defining file's skeleton.</fact>
    </index_facts>

    <rules>
        <rule name="package-scoped-names">Every package has a New, a Config, a Client: resolve_symbol("New") returns many — disambiguate by package path on the cards, or query with a path hint ("storage client New connection pool").</rule>
        <rule name="interface-dispatch">Interface satisfaction is implicit; call sites bind by method NAME: get_call_graph("Process") mixes every Process. Enumerate implementations: ONE search_code(query: "method receiver implementation", exact_tokens: "MethodName") and read the receivers off the signatures.</rule>
        <rule name="embedded-promotion">A call to a method the outer type doesn't define lives in an EMBEDDED type — check the type-declaration chunk for embedded fields before distrusting the index.</rule>
        <rule name="implicit-execution">init() and `_` blank imports run with no inbound edges — absence of callers is not dead code. `go fn()` and `defer fn()` ARE edges; channel flow is not — trace channels by searching the channel field name.</rule>
        <rule name="first-class-functions">Functions passed as values (http.HandlerFunc(handle), middleware constructors) create no edge to the passed function — find sites with exact_tokens.</rule>
        <rule name="input-reachability">SECURITY — "can request/CLI input reach a dangerous call" (exec, SQL, fs/path) → trace_taint (Go is supported); find_tainted_sinks first to map the surface. Finder, not proof — "no flows" ≠ safe.</rule>
        <rule name="query-style">Always include package/domain words ("auth middleware token refresh", never bare "Refresh"). To find where an error originates, search its message string literal — the most unique token in the flow.</rule>
    </rules>

    <playbook question="explain X / who implements interface I" calls="1-3">resolve_symbol("X") (check receiver) → get_chunk_summary(id, expand_calls: true) → answer. Implementors of I: ONE exact_tokens search on the method name — receivers in the signatures are the answer, no per-type reads.</playbook>

</environment_prompt>
