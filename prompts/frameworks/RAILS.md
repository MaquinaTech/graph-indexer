<environment_prompt layer="2" type="framework" name="rails" requires="graph-indexer-core, ruby" version="1.0">

    <scope>Ruby on Rails (convention-over-configuration MVC, ActiveRecord). Loads after the ruby layer — weak require topology applies.</scope>

    <critical_fact>Rails wires almost everything BY NAMING CONVENTION, not by calls: router → controller action, controller → view template, model ↔ table. Most "who calls this" questions are answered by the convention itself — spend budget confirming the convention's endpoints, never searching for explicit wiring that doesn't exist.</critical_fact>

    <rules>
        <rule name="routes">Routes are DSL calls in config/routes.rb (`resources :orders`): search the URL fragment or resource name; the controller is `<Resource>sController`, the action the conventional method (index, show, create...). Controller actions are framework-invoked ENTRY POINTS — empty call graphs are normal. The rendered view matches the action name unless a render/redirect_to in the chunk overrides it.</rule>
        <rule name="generated-methods">Associations/macros GENERATE the API at runtime: `has_many :orders` creates orders/build_order/...; attr/enum/scope macros likewise; dynamic finders (find_by_email) are metaprogrammed. NONE have chunks — the macro line in the model chunk IS the definition. Decode macros; never hunt for generated bodies.</rule>
        <rule name="declarative-callbacks">`before_save :normalize`, `validates :email` are DECLARATIVE: the model chunk's macro lines say WHAT runs and WHEN. before_action filter chains are declared at the top of the controller chunk. Resolve at most the ONE callback/filter method whose logic is the question.</rule>
        <rule name="concerns">Behaviour mixed in via `include SomeConcern` lives in the concern's module chunk (app/models/concerns, app/controllers/concerns) — ruby mixin rule applies, ONE module hop max.</rule>
        <rule name="jobs-mailers">Jobs (perform_later), mailers (deliver_later), subscribers connect enqueue site to handler by CLASS NAME — ONE exact_tokens search on the class name finds both ends.</rule>
        <rule name="non-code-config">config/*.yml, locales, credentials, db/schema.rb are data/config — fallback condition 3 once the consuming code is located.</rule>
        <rule name="query-style">URL fragments, route helper names (order_path), macro symbols (:before_save, :orders) are the highest-precision tokens. For "where does X get validated/transformed", name the FIELD and behaviour — validation macro, callback, or form object, one behavioural search covers all.</rule>
    </rules>

    <playbook question="explain models A, B, C (and where used)" calls="1-2">ONE batched search — the macro lines (has_many, validates, scope) in the smart bodies ARE the schema and behaviour; consumers (controllers, jobs) surface in the same results because require topology is absent. Never one call per model.</playbook>
    <playbook question="what happens on POST /orders" calls="3-4">search_code(exact_tokens: "orders") → get_chunk(OrdersController create action or class) → get_chunk_summary(Order model — macros reveal callbacks/validations) → answer; ONE callback/concern/job hop only if the question demands it.</playbook>

</environment_prompt>
