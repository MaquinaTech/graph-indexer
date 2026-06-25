<environment_prompt layer="2" type="language" name="python" requires="graph-indexer-core" version="1.0">

    <scope>Indexed code is Python (.py). Deltas to core; hard limits unchanged.</scope>

    <index_facts>
        <fact>Chunks: top-level defs, classes, methods. Decorator lines are INSIDE the chunk — routing/caching/permission behaviour is visible in summaries and searchable as body text.</fact>
        <fact>Topology RELIABLE — absolute and relative imports tracked.</fact>
        <fact>Calling a class — `UserService(...)` — records a call to the CLASS name: get_call_graph("UserService") finds instantiation sites; get_call_graph("__init__") is noise.</fact>
        <fact>Module-level statements (constants, registrations, import-time side effects) live outside any function — if behaviour happens "at import time", get_file_skeleton(path) shows it; don't hunt for a function that doesn't exist.</fact>
    </index_facts>

    <rules>
        <rule name="name-overmatch">Dispatch binds by NAME and Python is duck-typed: get_call_graph("save") mixes every save repo-wide, and resolve_symbol may return several — pick by file path + class context from the cards, no extra reads. If your index was built --resolver scip (scip-python), find_references returns a 🎯 SCIP-resolved set that disambiguates the right one — trust it over name-only.</rule>
        <rule name="dunder-magic">Implicit protocol calls have no edges: `obj()`↛__call__, `a+b`↛__add__, attr access↛__getattr__, `with`↛__enter__/__exit__. An empty call graph on a dunder means nothing.</rule>
        <rule name="package-barrels">`__init__.py` re-export hubs produce re_export nodes: internal origin → ONE hop; external dependency → stop.</rule>
        <rule name="decorators-wrap">Call sites point at the DECORATED name even when a decorator wraps it. If runtime behaviour is the question, read the decorator's chunk ONCE — never trace every wrapped function.</rule>
        <rule name="string-references">getattr/importlib/task-queue registrations and monkey-patching reference code by STRING — no edges. Trace by searching the string literal; when observed behaviour contradicts the source, ONE search of the patched name as a literal.</rule>
        <rule name="query-style">snake_case splits perfectly ("parse_request_body" matches "parse request body") and docstrings are indexed — query with docstring vocabulary. For duck-typed behaviour use a behavioural sentence, not the method name.</rule>
    </rules>

    <playbook question="explain function/class X" calls="2-3">resolve_symbol("X") (decorators visible) → get_chunk_summary(id, expand_calls: true) → answer with Used by: list; ≤1 consumer OR the ONE behaviour-defining decorator.</playbook>

</environment_prompt>
