<environment_prompt layer="2" type="language" name="kotlin" requires="graph-indexer-core" version="1.0">

    <scope>Indexed code is Kotlin (.kt .kts). Deltas to core; hard limits unchanged.</scope>

    <index_facts>
        <fact>Chunks: functions, classes, OBJECT declarations, COMPANION OBJECTS, secondary constructors — resolve objects/companions by name like any class. Annotations are part of the chunk and often ARE the behaviour.</fact>
        <fact>Topology RELIABLE — imports tracked.</fact>
        <fact>Top-level functions/properties live directly in files: get_file_skeleton(path) is the fastest view of free functions. Lambdas and `let`/`apply`/`run`/`also` blocks have no symbol — that logic belongs to the enclosing chunk; find it behaviourally.</fact>
        <fact>Data classes auto-generate copy/equals/hashCode/componentN with NO chunks — a "missing" method matching that list means the data-class declaration IS the answer.</fact>
    </index_facts>

    <rules>
        <rule name="invoke-operator">`useCase(input)` dispatches to an `invoke` operator with NO edge — common in clean-architecture code. Empty call graph on invoke (or a use-case class) means nothing: find usage with ONE exact_tokens search on the class name.</rule>
        <rule name="delegation">`by lazy`, `by viewModels()`, class delegation (`class A : B by impl`), property delegates route through getValue/setValue with no edges — resolve the DELEGATE expression's symbol when delegated behaviour is the question.</rule>
        <rule name="lambdas-and-references">Trailing-lambda calls (`list.map { }`, `scope.launch { }`) record a call to the combinator only; `::handle` references create no edge — find sites with exact_tokens.</rule>
        <rule name="name-overmatch">Like Java, call sites bind by NAME against interfaces/supertypes: get_call_graph("process") mixes every process — confirm receivers from card signatures. Extension functions resolve under the FUNCTION name (resolve_symbol("slugify")), not the receiver type. Custom property getters live in the PROPERTY's declaration, not a getX accessor.</rule>
        <rule name="coroutines">suspend calls have normal edges, but launch/async decouple call site from execution — answer ordering questions from ONE chunk's code, not the graph.</rule>
        <rule name="query-style">DSL/builder code has generic names — search behaviourally. Sealed hierarchies: ONE exact_tokens search on the SEALED PARENT name returns all variants and every `when` over them.</rule>
    </rules>

    <playbook question="explain class/use-case X" calls="2-3">resolve_symbol("X") (annotations + companion visible) → get_chunk_summary(id, expand_calls: true) → answer with Used by:; ≤1 delegate/interface hop. Several types? ONE batched search (limit 2).</playbook>

</environment_prompt>
