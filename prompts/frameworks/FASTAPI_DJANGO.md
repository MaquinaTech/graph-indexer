<environment_prompt layer="2" type="framework" name="fastapi-django" requires="graph-indexer-core, python" version="1.0">

    <scope>Python web app: decorator-routed endpoints (FastAPI) and/or URLconf + ORM (Django). Loads after the python layer.</scope>

    <critical_fact>Endpoints and views are invoked by the framework dispatcher: an empty call graph on them means ENTRY POINT, never dead code.</critical_fact>

    <rules>
        <rule name="routes">FastAPI/Flask decorator endpoints: find_routes(method, path) maps them straight to the handler chunk_id — the first move. Fall back to a path search — search_code(query: "endpoint that updates user profile", exact_tokens: "/users") — for computed paths or behavioural matching. Django URLconf is NOT covered by find_routes: views bind in a urls file, so search the path string then resolve the referenced view name — that is 2 calls, plan for it.</rule>
        <rule name="depends-is-a-default">FastAPI dependencies are parameter DEFAULTS (`user = Depends(get_current_user)`), not calls — no edge. The endpoint's SIGNATURE enumerates its dependencies (summary is enough); resolve at most ONE dependency body.</rule>
        <rule name="metaclass-managers">ORM model classes are rewritten by metaclasses: `Model.objects`, queryset methods, generated fields (id, *_set) have NO chunks — resolve_symbol("objects") finding nothing is CORRECT. The MODEL class declares the schema; custom managers/querysets DO exist as classes — search the manager class name when query behaviour looks non-default.</rule>
        <rule name="cbv-mro">Class-based views inherit handlers through mixins/generic bases: the view chunk often shows only attributes. The method you seek (get, post, get_queryset, form_valid) lives on a parent — resolve ONE parent method, guided by the bases in the view's signature.</rule>
        <rule name="schema-models">Pydantic models, serializers, forms are declarative — the class definition IS the validation. resolve_symbol("UserCreate") answers "what is validated"; imperative validation code doesn't exist, don't search for it.</rule>
        <rule name="signals-and-tasks">Signals connect by the signal OBJECT and tasks by name/registration — no call edges. ONE exact_tokens search on the signal/task name finds both ends. Middleware lists and settings are config files — fallback condition 3 once the consuming code is located.</rule>
        <rule name="query-style">URL fragments and signal names beat function names. For "where is this field validated/transformed", name the FIELD and behaviour ("normalize email before saving user") — model, serializer, or signal handler, one behavioural search covers all three.</rule>
    </rules>

    <playbook question="what happens on POST /orders" calls="3-4">find_routes("POST", "/orders") (FastAPI/Flask; for Django URLconf fall back to search_code(exact_tokens: "/orders")) → get_chunk(handler/view) — decorators + signature reveal deps and models → resolve_symbol(the ONE model/service it delegates to) → answer; ONE dependency/parent hop only if the question demands it.</playbook>

</environment_prompt>
