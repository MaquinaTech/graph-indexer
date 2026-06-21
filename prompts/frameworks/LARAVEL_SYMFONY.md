<environment_prompt layer="2" type="framework" name="laravel-symfony" requires="graph-indexer-core, php" version="1.0">

    <scope>PHP on Laravel or Symfony (container MVC, ORM, facades/attributes). Loads after the php layer — whole-class chunks, weak topology, batched class questions all apply.</scope>

    <critical_fact>Controllers are invoked by the framework dispatcher: empty call graphs on controller methods mean ENTRY POINT. And because PHP `use` imports are untracked, EMPTY Deps:/Used by: mean NOTHING — usage always comes from name search, never from topology absence.</critical_fact>

    <rules>
        <rule name="eloquent-magic">Active-record models route everything through magic methods: attributes are __get/__set on the row, `User::where(...)` is __callStatic, scopes are scopeActive defs invoked as active(), relations (hasMany/belongsTo) generate accessors. The MODEL chunk's relation/scope/cast declarations ARE the API — and model chunks are SMALL, so one batched search shows several models' full relation graphs at once. Never hunt for generated method bodies.</rule>
        <rule name="routes">Laravel routes are DSL calls in route files (`Route::get('/orders', [OrderController::class, 'index'])`) — ONE exact_tokens search of the URL fragment finds the registration; the controller class is named right there. Symfony routes are attributes on the controller method (#[Route('/orders')]) — the class chunk includes them; search the path fragment.</rule>
        <rule name="big-controllers">A large controller (≥~200 lines) is god-class-split, so each action is its own chunk and resolve_symbol on an action name hits directly; a smaller controller stays one whole-class chunk. Either way, get_file_skeleton(its file) lists every action with line ranges in ~80 tok — THE move instead of searching method names one by one (the skeleton call replaces 3-4 searches).</rule>
        <rule name="facades">Facade calls (Cache::get, DB::table, Log::info) are static proxies — NO edge to the implementation behind the container binding. Treat as "delegates to the named service"; resolve the underlying service ONLY when its internals are the question.</rule>
        <rule name="container-bindings">Interface→implementation wiring lives in service providers (bind/singleton) or services config — ONE exact_tokens search on the INTERFACE name surfaces binding site and implementation together.</rule>
        <rule name="implicit-runners">Middleware, policies, form requests, events/listeners, subscribers run implicitly around controllers. Registrations (kernel/provider/route/attributes) name them; events connect dispatch site to listeners by the EVENT CLASS NAME — ONE exact_tokens search finds both ends. Read at most ONE such body.</rule>
        <rule name="templates">Blade/Twig templates are content, not symbols: the controller chunk's view(...)/render(...) call names the template; reading the template file is fallback condition 3.</rule>
        <rule name="query-style">URL fragments, event class names, config keys are the highest-precision tokens. exact_tokens on a class name REPLACES the missing Used by: — the default usage-mapping move here.</rule>
    </rules>

    <playbook question="explain models Country, Community, Region, Location — structure, relations, where used" calls="1-2">ONE search_code(query: "Country Community Region Location", detail: "smart", top_k: 10): the four model chunks rank top with their hasMany/belongsTo/HasManyThrough lines visible — that IS the hierarchy — and the controllers/Livewire components referencing them appear in the same results. Answer structure AND usage from this single call; optional 2nd call: detail: "full" + token_budget: 3000 to quote every relation method. Four resolve_symbol calls here = budget dead.</playbook>
    <playbook question="what happens on POST /orders" calls="3-4">search_code(exact_tokens: "/orders") → get_file_skeleton(controller file) or get_chunk_summary(controller class) for the action map → get_chunk_summary(the ONE model/service it delegates to) → answer; ONE middleware/listener/binding hop only if the question demands it.</playbook>

</environment_prompt>
