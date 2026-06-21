<environment_prompt layer="2" type="framework" name="spring-boot" requires="graph-indexer-core, java" version="1.0">

    <scope>Spring / Spring Boot (annotation-driven config, container beans, AOP). Loads after the java (or kotlin) layer.</scope>

    <critical_fact>ANNOTATIONS ARE BEHAVIOUR: @Transactional, @Cacheable, @Async, @Retryable, security annotations, and custom aspects wrap methods invisibly — bodies never show the transaction/cache/retry logic. Read the annotations in the summary BEFORE describing a method; never claim "no caching/transaction handling" from bodies alone.</critical_fact>

    <rules>
        <rule name="entry-points">Controller methods are dispatcher-invoked: empty call graphs on @RestController/@Controller methods mean ENTRY POINT. Full route = class-level prefix + method-level path. find_routes(method, path) resolves @GetMapping/@RequestMapping endpoints to the handler chunk_id with both parts joined — but ONLY for **Java** controllers; route extraction has no Kotlin branch, so on a **Kotlin** Spring app find_routes returns nothing and you must locate the handler with an `exact_tokens` search on the path fragment or annotation. For Java, use find_routes first and fall back to the exact_tokens path-fragment search only when it misses. Scheduled methods, listeners, queue consumers, lifecycle callbacks: the invoking annotation says WHO calls them — never hunt for callers.</rule>
        <rule name="derived-queries">Repository interfaces generate query impls FROM METHOD NAMES: `findByEmailAndStatusOrderByCreatedAt` has NO body and NO chunk — the name IS the spec. Decode it; check for a @Query annotation in the summary when the name can't explain the result. Never search for the implementation.</rule>
        <rule name="graph-works-below-wiring">Between project classes calls register normally: get_call_graph("calculateInvoice") reliably finds service-layer call sites. Trust the graph below the container wiring.</rule>
        <rule name="interface-to-impl">Injection targets are interfaces; the container picks the impl. ONE exact_tokens search on the interface name surfaces the implementing class AND any @Bean factory — the binding is in one of those two.</rule>
        <rule name="deep-inheritance">If a resolved class looks too thin, the behaviour lives in an abstract base — resolve ONE parent, guided by the extends list on the card.</rule>
        <rule name="events-and-config">Event publishers and @EventListener handlers connect by the EVENT CLASS — ONE exact_tokens search on the event class finds both ends. @Value/configuration-properties bind to yml/properties — fallback condition 3 once the consuming class is located.</rule>
        <rule name="query-style">Annotation names are high-precision tokens (exact_tokens: "@Scheduled"). Cross-cutting behaviour ("where do we audit changes") lives in an aspect/listener you can't name — search behaviourally.</rule>
    </rules>

    <playbook question="what happens on POST /orders" calls="3-4">find_routes("POST", "/orders") → get_chunk_summary(handler chunk_id, expand_calls: true) — annotations + called services in one shot → get_chunk_summary(the ONE service method doing the work) → answer; ONE impl/parent/aspect hop only if the question demands it.</playbook>

</environment_prompt>
