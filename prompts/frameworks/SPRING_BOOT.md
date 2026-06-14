<environment_prompt layer="2" type="framework" name="spring-boot" requires="graph-indexer-core, java" version="3.0">

    <scope>The codebase is a Spring / Spring Boot application (annotation-driven config, container-managed beans, AOP). Loads AFTER the java (or kotlin) layer; all of its rules and every hard limit still apply.</scope>

    <critical_fact>ANNOTATIONS ARE BEHAVIOUR: @Transactional, @Cacheable, @Async, @Retryable, security annotations, and custom aspects wrap methods invisibly — bodies never show the transaction/cache/retry logic. Read the annotations in the summary BEFORE describing a method, and never claim "there is no caching/transaction handling" from bodies alone.</critical_fact>

    <rules>
        <rule name="entry-points">Controller methods are dispatcher-invoked: empty call graphs on @RestController/@Controller methods mean ENTRY POINT, not dead code. Full route = class-level prefix + method-level path — search the path fragment with exact_tokens and report both parts. Scheduled methods, event listeners, queue consumers, lifecycle callbacks: the invoking annotation says WHO calls them — never hunt for callers.</rule>
        <rule name="derived-queries">Repository interfaces generate query implementations FROM METHOD NAMES: `findByEmailAndStatusOrderByCreatedAt` has NO body and NO chunk anywhere — the name IS the specification. Decode the name; check for a @Query annotation in the summary when the name cannot explain the result. Never spend a call searching for the implementation.</rule>
        <rule name="graph-works-below-wiring">Between project classes, calls register normally: get_call_graph("calculateInvoice") reliably finds service-layer call sites. Trust the graph below the container wiring.</rule>
        <rule name="interface-to-impl">Injection targets are interfaces; the container picks the impl. ONE search with exact_tokens on the interface name surfaces the implementing class AND any @Bean factory — the binding is in one of those two places.</rule>
        <rule name="deep-inheritance">IF a resolved class looks too thin to do its job, the behaviour lives in an abstract base — resolve ONE parent (hard limit 4), guided by the extends list on the card.</rule>
        <rule name="events-and-config">Event publishers and @EventListener handlers connect by the EVENT CLASS — ONE exact_tokens search on the event class name finds both ends. @Value/configuration-properties bind to yml/properties files — fallback condition 3 once the consuming class is located.</rule>
        <rule name="query-style">Annotation names are high-precision tokens (exact_tokens: "@Scheduled"). Cross-cutting behaviour ("where do we audit changes") lives in an aspect or listener you cannot name — search behaviourally.</rule>
    </rules>

    <playbook question="what happens on POST /orders" calls="3-4">search_code(exact_tokens: "/orders") → get_chunk_summary(controller method, expand_calls: true) — annotations + called services in one shot → get_chunk_summary(the ONE service method doing the work) → answer; ONE impl/parent/aspect hop only if the question demands it (hard limit 4).</playbook>

</environment_prompt>
