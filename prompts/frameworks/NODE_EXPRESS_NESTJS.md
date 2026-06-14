<environment_prompt layer="2" type="framework" name="node-express-nestjs" requires="graph-indexer-core, javascript-typescript" version="3.0">

    <scope>The codebase is a Node.js backend using Express-style routing and/or NestJS-style DI. Loads AFTER the javascript-typescript layer; all of its rules and every hard limit still apply.</scope>

    <critical_fact>HTTP handlers are invoked by the framework dispatcher: an empty call graph on a route handler means ENTRY POINT, never dead code. Request flow is reconstructed from REGISTRATION sites, not from get_call_graph.</critical_fact>

    <rules>
        <rule name="routes-by-path-string">Find any endpoint by its PATH STRING — the most unique, most stable token: search_code(query: "user creation endpoint", exact_tokens: "/users"). Express handlers are often anonymous closures inside `app.get(path, ...)` — the registration chunk IS the handler. NestJS routes = controller prefix (@Controller("users")) PLUS method path (@Get(":id")) — search the other token if the first misses.</rule>
        <rule name="middleware-order">Middleware order equals REGISTRATION order. "What runs before this handler" is answered by reading the ONE app/module setup chunk where registration happens — never by resolving every middleware. `next()` carries no edge; guards/pipes/interceptors bound via decorators are visible in summaries — read AT MOST ONE middleware body, and only when its logic is the question (hard limit 4).</rule>
        <rule name="graph-works-below-routing">Inside project code, calls are direct: controller → service → repository edges register normally, and get_call_graph("createUser") reliably finds controller call sites. Trust the graph below the routing layer.</rule>
        <rule name="container-wiring">WHICH implementation backs an injected token is container wiring, not a call: constructor injection creates no edge. Find the binding with ONE search of the module/provider registration (exact_tokens: "UserService") — never via the constructor's call graph.</rule>
        <rule name="lifecycle-hooks">onModuleInit-style hooks, error handlers, scheduled/cron methods, and event/queue consumers have no inbound edges — the decorator in the summary says WHO invokes them; do not hunt for callers.</rule>
        <rule name="query-style">Path strings beat handler names (routes rename rarely, handlers often). Cross-cutting behaviour ("where do we attach the request ID") lives in middleware whose name you cannot guess — search behaviourally.</rule>
    </rules>

    <playbook question="what happens on POST /orders" calls="3-4">search_code(exact_tokens: "/orders") → get_chunk(handler or controller method) → get_chunk_summary(the service it calls, expand_calls: true) → answer; ONE middleware/guard chunk only if the question is about it (hard limit 4).</playbook>

</environment_prompt>
