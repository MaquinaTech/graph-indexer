<environment_prompt layer="2" type="framework" name="fastapi-django" requires="graph-indexer-core, python" version="3.0">

    <scope>The codebase is a Python web app using decorator-routed endpoints (FastAPI style) and/or URLconf + ORM (Django style). Loads AFTER the python layer; all of its rules and every hard limit still apply.</scope>

    <critical_fact>Endpoints and views are invoked by the framework dispatcher: an empty call graph on them means ENTRY POINT, never dead code.</critical_fact>

    <rules>
        <rule name="routes">Decorator-routed endpoints carry the path ON the function (decorators are inside the chunk): search_code(query: "endpoint that updates user profile", exact_tokens: "/users"). Full path = router/app prefix + decorator path — IF the literal full path misses, search the suffix. URLconf-routed views bind in a urls file: search the path string, then resolve the referenced view name — that is 2 calls, plan for it.</rule>
        <rule name="depends-is-a-default">FastAPI-style dependencies are parameter DEFAULTS (`user = Depends(get_current_user)`), not calls — no edge exists. The endpoint's SIGNATURE enumerates its dependencies (summary is enough); resolve at most ONE dependency body (hard limit 4).</rule>
        <rule name="metaclass-managers">ORM model classes are rewritten by metaclasses: `Model.objects`, queryset methods, and generated fields (id, *_set) have NO chunks — resolve_symbol("objects") finding nothing is CORRECT, not an index failure. The MODEL class declares the schema; custom managers/querysets DO exist as classes — search the manager class name when query behaviour looks non-default.</rule>
        <rule name="cbv-mro">Class-based views inherit handlers through mixins/generic bases: the view chunk often shows only attributes. The method you seek (get, post, get_queryset, form_valid) lives on a parent — resolve ONE parent method, guided by the bases in the view's signature (hard limit 4).</rule>
        <rule name="schema-models">Pydantic-style models, serializers, and forms are declarative — the class definition IS the validation. resolve_symbol("UserCreate") answers "what is validated"; imperative validation code does not exist, do not search for it.</rule>
        <rule name="signals-and-tasks">Signals connect by the signal OBJECT and tasks by name/registration — no call edges. ONE exact_tokens search on the signal/task name finds both ends. Middleware lists and settings are config files — fallback condition 3 applies once the index located the consuming code.</rule>
        <rule name="query-style">URL fragments and signal names beat function names. For "where is this field validated/transformed", name the FIELD and behaviour ("normalize email before saving user") — model, serializer, or signal handler, one behavioural search covers all three.</rule>
    </rules>

    <playbook question="what happens on POST /orders" calls="3-4">search_code(exact_tokens: "/orders") → get_chunk(endpoint/view) — decorators + signature reveal deps and models → resolve_symbol(the ONE model/service it delegates to) → answer; ONE dependency/parent hop only if the question demands it (hard limit 4).</playbook>

</environment_prompt>
