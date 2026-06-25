<environment_prompt layer="2" type="language" name="rust" requires="graph-indexer-core" version="1.0">

    <scope>Indexed code is Rust (.rs). Deltas to core; hard limits unchanged.</scope>

    <index_facts>
        <fact>Chunks: top-level fns, impl-block methods, traits, structs, enums. Attribute lines (#[...]) are part of the chunk — derives and attribute macros are visible in summaries and often ARE the behaviour.</fact>
        <fact>Topology RELIABLE — `use` declarations tracked.</fact>
        <fact priority="critical">MACROS ARE NOT EXPANDED: code from #[derive(...)], attribute macros, and macro_rules! has NO chunks, and calls written inside macro invocations may be missing from the call graph. If an impl that "must exist" is unfindable (e.g. Serialize for a struct), the struct's derive attribute IS the answer — never hunt for generated bodies.</fact>
    </index_facts>

    <rules>
        <rule name="hidden-calls">Rust inserts calls the source never spells: `?`→From::from, operators→Add::add etc., Deref coercion→deref, scope end→Drop::drop, `.await`→poll. None appear as edges — never call a trait method unused from an empty call graph.</rule>
        <rule name="trait-dispatch">Calls through generics (T: Trait) or dyn Trait bind to the method NAME: get_call_graph("execute") mixes every execute. Disambiguate by the impl target in each signature. Enumerate implementors: ONE search_code(query: "impl TraitName for", exact_tokens: "TraitName"). If your index was built --resolver scip (rust-analyzer --scip), find_references returns a precise 🎯 SCIP-resolved set that separates same-named methods — trust it over name-only.</rule>
        <rule name="re-exports">`pub use` hubs (crate roots, preludes) produce re_export nodes: internal origin → ONE hop; external crate → stop.</rule>
        <rule name="closures-and-generics">Logic inside closures passed to combinators has no edges — behavioural search. A generic fn is ONE chunk regardless of instantiations; per-type behaviour comes from its trait bounds — resolve the bound trait's method ONCE, per-type copies don't exist.</rule>
        <rule name="query-style">snake_case splits well; pin PascalCase trait/type names with exact_tokens. For error flow, search the error variant name or the thiserror/anyhow message string — far more unique than "error". Trust card file paths over guessed `crate::` paths.</rule>
    </rules>

    <playbook question="explain type X and its trait impls" calls="1-2">ONE search_code(query: "X impl trait", top_k: 8) — the struct chunk and its impl chunks surface together (name boost); attributes on the struct card answer derive questions. Escalate ONE chunk to full body only if implementation detail is the question.</playbook>

</environment_prompt>
