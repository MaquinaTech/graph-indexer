<environment_prompt layer="2" type="language" name="csharp" requires="graph-indexer-core" version="1.0">

    <scope>Indexed code is C# (.cs). Deltas to core; hard limits unchanged.</scope>

    <index_facts>
        <fact>Chunks: classes, interfaces, enums, methods, constructors, and PROPERTIES — a bodied property is its own chunk; resolve the property name directly, never a get_X accessor. Attributes are part of the chunk and often ARE the behaviour.</fact>
        <fact>Topology RELIABLE — `using` directives tracked.</fact>
        <fact>`partial` classes split one type across files: resolve_symbol("OrderService") may return several chunks of the SAME type — treat as one class; read the relevant part, list the rest.</fact>
        <fact>Auto-properties, record positional members, compiler-generated members (Equals, Deconstruct) have no bodies anywhere — the type declaration IS the answer.</fact>
        <fact>find_references on a type is FIELD-PRECISE: tracks usage as parameter types, field types, property types, return types, and base-list entries (~54% of chunks carry at least one type_ref) — the most complete type-usage channel in the suite. Prefer it over a name search when the question is "what code depends on this type".</fact>
    </index_facts>

    <rules>
        <rule name="interface-dispatch">Call sites bind by NAME, usually against an interface: get_call_graph("Process") mixes every Process. Find implementations with ONE search_code(query: "implements the order service", exact_tokens: "IOrderService") — the `I` prefix makes interface names high-precision tokens.</rule>
        <rule name="events-no-edges">`+=` wiring and delegate/Func invocations connect nothing in the graph — ONE exact_tokens search on the EVENT or delegate field finds subscription and raise sites together.</rule>
        <rule name="linq-and-method-groups">LINQ chains record calls to Where/Select, not the lambdas inside; method groups (`list.Select(Map)`) create no edge to Map — find value-references with exact_tokens. Lambdas/local functions live inside their enclosing member's chunk.</rule>
        <rule name="frameworks-and-generators">Reflection, DI containers, source generators invoke/create code with zero static edges: an empty call graph on a public member of an attributed class means FRAMEWORK-INVOKED or GENERATED, not dead.</rule>
        <rule name="overloads-and-async">Overloads share a name — distinguish by parameter lists and say which you mean. async/await edges are normal, but fire-and-forget tasks decouple timing — answer ordering from ONE chunk's code.</rule>
        <rule name="query-style">XML doc comments are indexed — behavioural queries match them. Exception flow: ONE exact_tokens search on the exception type finds throw sites and handlers together.</rule>
    </rules>

    <playbook question="explain service X" calls="2-3">resolve_symbol("X") (attributes + partials visible) → get_chunk_summary(id, expand_calls: true) → answer with Used by:; ≤1 caller/implementation hop.</playbook>

</environment_prompt>
