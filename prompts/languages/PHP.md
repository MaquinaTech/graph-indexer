<environment_prompt layer="2" type="language" name="php" requires="graph-indexer-core" version="3.0">

    <scope>The indexed code is PHP (.php). These are deltas to the core protocol — every hard limit is unchanged.</scope>

    <index_facts>
        <fact>Chunks are functions and WHOLE CLASSES — one class is ONE chunk containing all its methods. Class-sized questions are therefore cheap: one model/entity/service class is one card, and its full body is one get_chunk.</fact>
        <fact>get_file_skeleton(path) parses the live file and lists EVERY method with line ranges (~80 tok) — THE tool for a large class. Never search repeatedly inside a class you already located; one skeleton call replaces all of those searches.</fact>
        <fact priority="critical">Import topology is WEAK BY DESIGN: only include/require is tracked; namespace `use` imports are NOT. In autoloaded (PSR-4) code, Deps:/Used by: are sparse or empty — this means NOTHING about usage. Map consumers by name search instead: bodies are indexed, so chunks mentioning "ClassName" surface in the same search as its definition.</fact>
        <fact>Closures and arrow functions have no symbol — callback logic belongs to the enclosing function/class chunk.</fact>
    </index_facts>

    <rules>
        <rule name="batched-class-questions">"Explain classes A, B, C, D (and where they're used)" = ONE search_code(query: "A B C D", detail: "smart", top_k: 2×N). Definitions rank top (name boost), consumers follow (body mentions). Escalate ONCE to detail: "full" with token_budget (e.g. 3000) when the complete bodies of several small classes are genuinely needed. NEVER one resolve_symbol or search per class — that is the budget-killing failure mode.</rule>
        <rule name="usage-mapping">Consumers of ONE class: search_code(query: "what it is used for", exact_tokens: "ClassName") — this REPLACES the missing Used by: line. get_call_graph works for function/method NAMES, not for class references.</rule>
        <rule name="one-method-of-a-class">Method names inside classes are not independently resolvable: get_file_skeleton(file) for the method map and line range, or get_chunk_summary(classChunkId) for the interface — only then decide whether the full class body is worth it.</rule>
        <rule name="magic-methods">__call/__callStatic/__get/__set/__invoke route behaviour with NO edges. IF a called method does not exist in the class chunk, check its magic methods and its `use TraitName;` lines — trait methods live in the TRAIT's chunk; resolve ONE trait (hard limit 4).</rule>
        <rule name="dynamic-dispatch">$obj->$method(), call_user_func, and 'Class::method' strings create no edges — search the name as a string literal. Dispatch binds by name: get_call_graph("handle") mixes every handle; confirm receivers via class context.</rule>
        <rule name="namespaces">Resolve SHORT class names; the file path mirrors the namespace under PSR-4 — disambiguate from paths on the cards, never with extra calls.</rule>
    </rules>

    <playbook question="explain models Country, Community, Region, Location and where they're used" calls="1-2">ONE search_code(query: "Country Community Region Location", detail: "smart", top_k: 10) → the four model class cards (relation methods visible in the smart body lines) plus the controllers/components that mention them → answer covering structure AND usage. Optional 2nd call: re-search detail: "full", token_budget: 3000 only if every method body must be quoted. Four resolve_symbol calls here = budget dead with nothing read.</playbook>

</environment_prompt>
