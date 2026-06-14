<environment_prompt layer="2" type="language" name="python" requires="graph-indexer-core" version="3.0">

    <scope>The indexed code is Python (.py). These are deltas to the core protocol — every hard limit is unchanged.</scope>

    <index_facts>
        <fact>Chunks: top-level defs, classes, and methods. Decorator lines are INSIDE the chunk — routing, caching, and permission behaviour is visible in summaries and searchable as body text.</fact>
        <fact>Imports (absolute and relative) are tracked — Deps:/Used by: topology is RELIABLE here.</fact>
        <fact>Calling a class — `UserService(...)` — records a call to the CLASS name: get_call_graph("UserService") finds instantiation sites; get_call_graph("__init__") is noise.</fact>
        <fact>Module-level statements (constants, registrations, import-time side effects) live outside any function: IF behaviour happens "at import time", get_file_skeleton(path) shows the module-level code — do not hunt for a function that does not exist.</fact>
    </index_facts>

    <rules>
        <rule name="name-overmatch">Dispatch binds by NAME and Python is duck-typed: get_call_graph("save") mixes every `save` repo-wide, and resolve_symbol may return several candidates — pick by file path and class context from the cards; never read all of them.</rule>
        <rule name="dunder-magic">Implicit protocol calls create no edges: `obj()` ↛ __call__, `a + b` ↛ __add__, attribute access ↛ __getattr__, `with` ↛ __enter__/__exit__. An empty call graph on a dunder method means nothing.</rule>
        <rule name="package-barrels">`__init__.py` re-export hubs produce re_export nodes: internal origin → ONE hop; external dependency → stop.</rule>
        <rule name="decorators-wrap">Call sites point at the DECORATED name even when a decorator wraps it. IF runtime behaviour is the question, read the decorator's chunk ONCE (hard limit 4) — never trace every wrapped function.</rule>
        <rule name="string-references">getattr/importlib/task-queue registrations reference code by STRING — no edges. Trace them by searching the string literal. Same for monkey-patching: when observed behaviour contradicts the source, ONE search of the patched name as a literal.</rule>
        <rule name="query-style">snake_case splits perfectly ("parse_request_body" matches "parse request body") and docstrings are indexed — query with the vocabulary a docstring would use. For duck-typed behaviour, use a behavioural sentence, not the method name.</rule>
    </rules>

    <playbook question="explain function/class X" calls="2-3">resolve_symbol("X") (decorators visible) → get_chunk_summary(id, expand_calls: true) → answer with Used by: list; at most ONE consumer or the ONE behaviour-defining decorator (hard limit 4). Several named symbols? ONE batched search per hard limit 2.</playbook>

</environment_prompt>
