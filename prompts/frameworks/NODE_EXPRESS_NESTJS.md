<environment_prompt layer="2" type="framework" name="node-express-nestjs" requires="graph-indexer-core, javascript-typescript" version="1.0">

    <scope>Node.js backend: Express-style routing and/or NestJS-style DI. Loads after the javascript-typescript layer.</scope>

    <critical_fact>HTTP handlers are invoked by the framework dispatcher: an empty call graph on a route handler means ENTRY POINT, never dead code. Request flow is reconstructed from REGISTRATION sites, not from get_call_graph.</critical_fact>

    <rules>
        <rule name="routes">find_routes(method, path) maps Express/Koa and NestJS endpoints straight to their handler chunk_id — THE first move for "what handles VERB /path", and it already joins the NestJS @Controller prefix onto the @Get path. Fall back to a PATH-STRING search — search_code(query: "user creation endpoint", exact_tokens: "/users") — only for dynamic/computed paths or behavioural matching. Express handlers are often anonymous closures in `app.get(path, ...)` — find_routes reports the registration line.</rule>
        <rule name="middleware-order">Middleware order = REGISTRATION order. "What runs before this handler" comes from the ONE app/module setup chunk where registration happens — never by resolving every middleware. `next()` carries no edge; guards/pipes/interceptors bound via decorators are visible in summaries — read AT MOST ONE middleware body, only when its logic is the question.</rule>
        <rule name="graph-works-below-routing">Inside project code calls are direct: controller → service → repository edges register normally, and get_call_graph("createUser") reliably finds controller call sites. Trust the graph below the routing layer.</rule>
        <rule name="container-wiring">WHICH implementation backs an injected token is container wiring, not a call: constructor injection creates no edge. Find the binding with ONE search of the module/provider registration (exact_tokens: "UserService") — never via the constructor's call graph.</rule>
        <rule name="lifecycle-hooks">onModuleInit-style hooks, error handlers, scheduled/cron methods, event/queue consumers have no inbound edges — the decorator in the summary says WHO invokes them; don't hunt for callers.</rule>
        <rule name="query-style">Path strings beat handler names (routes rename rarely, handlers often). Cross-cutting behaviour ("where do we attach the request ID") lives in middleware whose name you can't guess — search behaviourally.</rule>
        <rule name="request-taint">SECURITY: req.body/query/params is the untrusted source. "Is this endpoint injectable" → find_tainted_sinks(category) to map the surface, then trace_taint one source→sink path (sqli|rce|xss|path|ssrf). Finder, not proof — "no flows" ≠ safe.</rule>
    </rules>

    <playbook question="what happens on POST /orders" calls="3-4">find_routes("POST", "/orders") → get_chunk(handler chunk_id) → get_chunk_summary(the service it calls, expand_calls: true) → answer; ONE middleware/guard chunk only if the question is about it.</playbook>

</environment_prompt>
