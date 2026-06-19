<environment_prompt layer="2" type="framework" name="aspnet-core" requires="graph-indexer-core, csharp" version="1.0">

    <scope>ASP.NET Core (attribute routing or minimal APIs, built-in DI, EF Core data access). Loads after the csharp layer.</scope>

    <critical_fact>Controller actions and endpoint handlers are invoked by the routing middleware: empty call graphs on them mean ENTRY POINT, never dead code.</critical_fact>

    <rules>
        <rule name="routes">Attribute-routed: full route = class-level [Route("api/[controller]")] PLUS method-level [HttpGet("{id}")] — both on cards; find endpoints by path fragment (exact_tokens: "/orders") or verb attribute. Minimal APIs: handlers are lambdas at the `app.MapGet(...)` registration — the registration chunk IS the handler, and they live in the Program/startup chunk.</rule>
        <rule name="registration-is-the-binding">DI wiring is explicit code: `services.AddScoped<IOrderService, OrderService>()` in Program/Startup or extension methods. ONE exact_tokens search on the INTERFACE name surfaces the registration line and the implementing class together.</rule>
        <rule name="graph-works-below-routing">Below routing, calls are direct: controller → service → repository edges register normally — trust get_call_graph inside project code.</rule>
        <rule name="implicit-runners">Middleware (app.UseX / InvokeAsync), filters, hosted services (ExecuteAsync), health checks are framework-invoked — the registration site names them; never hunt for callers of InvokeAsync/ExecuteAsync.</rule>
        <rule name="ef-data-layer">LINQ queries translate to SQL at runtime — no generated code to find. The DbContext declares the sets; entity config lives in attributes or model-builder chunks. Migration files are tool-generated snapshots — skip unless schema history is the question.</rule>
        <rule name="config-and-messages">IOptions<T>/Configuration["Key"] bind to appsettings.json — fallback condition 3 once the consumer is located; find consumers by the options class or key string. MediatR-style buses connect sender and handler by MESSAGE TYPE — ONE exact_tokens search on the message class finds both ends.</rule>
        <rule name="query-style">Route fragments, interface names, options/message class names are the highest-precision tokens. Cross-cutting behaviour ("where do we log request IDs") lives in middleware you can't name — search behaviourally.</rule>
    </rules>

    <playbook question="what happens on POST /orders" calls="3-4">search_code(exact_tokens: "/orders") → get_chunk_summary(controller action or Map* registration, expand_calls: true) → get_chunk_summary(the ONE service method doing the work) → answer; ONE DI-registration or middleware hop only if the question demands it.</playbook>

</environment_prompt>
