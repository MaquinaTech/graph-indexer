<environment_prompt layer="2" type="language" name="php" requires="graph-indexer-core" version="1.0">

    <scope>Indexed code is PHP (.php). Deltas to core; hard limits unchanged.</scope>

    <index_facts>
        <fact>Chunks are functions and WHOLE CLASSES — one class is ONE chunk with all its methods, UNTIL the class exceeds ~200 lines: a god-class is split so its methods become their own resolvable chunks. Class-sized questions on normal classes are cheap: one model/service class is one card, its full body one get_chunk.</fact>
        <fact>get_file_skeleton(path) parses the live file and lists EVERY method + line ranges (~80 tok) — THE tool for a large class. One skeleton call replaces searching method names inside it.</fact>
        <fact priority="critical">Topology WEAK BY DESIGN: only include/require tracked, namespace `use` imports are NOT. In autoloaded (PSR-4) code Deps:/Used by: are sparse/empty and mean NOTHING about usage. Map consumers by name search: chunks mentioning "ClassName" surface alongside its definition.</fact>
        <fact>Closures and arrow functions have no symbol — callback logic belongs to the enclosing function/class chunk.</fact>
    </index_facts>

    <rules>
        <rule name="batched-class-questions">"Explain classes A, B, C, D (and where used)" = ONE search_code(query: "A B C D", detail: "smart", top_k: 2×N). Definitions rank top (name boost), consumers follow. Escalate ONCE to detail: "full" + token_budget (e.g. 3000) when complete bodies of several small classes are needed. NEVER one resolve_symbol/search per class — the budget-killing failure.</rule>
        <rule name="usage-mapping">Consumers of ONE class: search_code(query: "what it's used for", exact_tokens: "ClassName") — REPLACES the missing Used by:. get_call_graph works for function/method NAMES, not class references.</rule>
        <rule name="one-method-of-a-class">In a normal (sub-200-line) class, method names aren't independently resolvable: get_file_skeleton(file) for the method map + line range, or get_chunk_summary(classChunkId) for the interface — only then decide if the full body is worth it. In a god-class (≥200 lines) the methods ARE their own chunks, so resolve_symbol / search_code on the method name hits directly.</rule>
        <rule name="magic-methods">__call/__callStatic/__get/__set/__invoke route behaviour with NO edges. If a called method isn't in the class chunk, check its magic methods and `use TraitName;` lines — trait methods live in the TRAIT's chunk; resolve ONE trait.</rule>
        <rule name="dynamic-dispatch">`$obj->$method()`, call_user_func, 'Class::method' strings create no edges — search the name as a string literal. Dispatch binds by name: get_call_graph("handle") mixes every handle; confirm receivers via class context.</rule>
        <rule name="namespaces">Resolve SHORT class names; the file path mirrors the namespace under PSR-4 — disambiguate from paths on the cards, no extra calls.</rule>
    </rules>

    <playbook question="explain models Country, Community, Region, Location and where used" calls="1-2">ONE search_code(query: "Country Community Region Location", detail: "smart", top_k: 10) → the four model cards (relation methods in the smart body lines) plus the controllers/components mentioning them → answer structure AND usage. Optional 2nd call: detail: "full", token_budget: 3000 only if every method body must be quoted. Four resolve_symbol calls here = budget dead.</playbook>

</environment_prompt>
