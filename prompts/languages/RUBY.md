<environment_prompt layer="2" type="language" name="ruby" requires="graph-indexer-core" version="1.0">

    <scope>Indexed code is Ruby (.rb). Deltas to core; hard limits unchanged.</scope>

    <index_facts>
        <fact>Chunks: methods, singleton methods (`def self.x`), classes, MODULES. Instance vs class methods of the same name are DIFFERENT chunks — check the signature for which you hold.</fact>
        <fact priority="critical">Topology WEAK: only require/require_relative tracked, and most apps autoload — Deps:/Used by: are sparse/empty and mean NOTHING about usage. Map consumers by name search: bodies are indexed, so chunks mentioning "ClassName" surface in the same search as its definition.</fact>
        <fact>Reopened classes produce MULTIPLE chunks for one name — reopening, not duplication; treat them together, read only the one matching your concern.</fact>
        <fact>Blocks (`do...end`, `{ }`) have no symbol — logic passed to each/map/DSL methods belongs to the enclosing chunk; find it behaviourally.</fact>
    </index_facts>

    <rules>
        <rule name="metaprogrammed-methods">define_method, method_missing, attr_accessor/attr_reader, delegate macros create methods with NO chunks. If resolve_symbol misses a method callers clearly use, ONE search of the SYMBOL LITERAL (exact_tokens: ":method_name") or the macro line — the macro call IS the definition.</rule>
        <rule name="duck-typed-dispatch">Everything dispatches by NAME: get_call_graph("call")/("perform") overmatches massively — prefer rarer names as graph entry points and confirm receivers from context. send/public_send invoke by symbol with no edge — search the symbol literal.</rule>
        <rule name="mixins">Methods arrive via include/extend/prepend — if a class responds to a method it doesn't define, its include lines (in the class chunk) name the module; resolve ONE module.</rule>
        <rule name="implicit-hooks">included/inherited/method_added hooks and yield-passed blocks run with no inbound edges — not dead code; the behaviour of `process { }` splits between the method chunk and the ONE call site that matters.</rule>
        <rule name="query-style">snake_case splits perfectly; pin ?/! suffixed names with exact_tokens. For DSL-heavy code search the DSL keyword or symbol literal ("validates", ":before_save") — the declaration site is the behaviour. Resolve namespaced constants by the LAST segment, disambiguate by path.</rule>
    </rules>

    <playbook question="explain classes A, B, C (and where used)" calls="1-2">ONE search_code(query: "A B C", detail: "smart", top_k: 2×N): definitions rank top, consumers (bodies mentioning the names) follow — this REPLACES the missing Used by: topology. Escalate ONE chunk to full body only if needed.</playbook>

</environment_prompt>
