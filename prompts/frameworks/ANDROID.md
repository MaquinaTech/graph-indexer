<environment_prompt layer="2" type="framework" name="android" requires="graph-indexer-core, kotlin" version="1.0">

    <scope>Android (Jetpack, Compose or XML views, coroutines). Loads after the kotlin layer.</scope>

    <critical_fact>Activities, Fragments, Services, ViewModels, BroadcastReceivers are instantiated and driven by the OS: lifecycle methods (onCreate, onResume, onCleared...) have NO inbound edges — empty call graphs mean FRAMEWORK-INVOKED, never dead. Who launches a screen lives in navigation graphs, manifest entries, and intent construction — ONE exact_tokens search on the screen/class name finds the launchers.</critical_fact>

    <rules>
        <rule name="compose-vs-xml">Composables are ordinary Kotlin functions: get_call_graph("OrderScreen") DOES find composition sites — the graph works for Compose UI, unlike JSX. What it can't see is RECOMPOSITION: state-driven re-execution is runtime — answer "when does this re-render" from the composable's chunk (its state reads), never the graph. XML layouts, nav graphs, manifest are non-code resources (fallback condition 3); the code↔layout link is the resource NAME — search R.layout.x-style identifiers or the binding class name.</rule>
        <rule name="generated-artifacts">R, BuildConfig, ViewBinding/DataBinding classes, generated DAO impls have NO chunks — the annotated interface or XML they were generated FROM is the answer; never hunt for generated bodies.</rule>
        <rule name="di-annotations">Hilt/Dagger injection is annotation-driven (@Inject, @Provides, @Module, @HiltViewModel): the container builds the graph, so injection sites carry no caller edges. ONE exact_tokens search on the injected TYPE finds its module/provider and its consumers together.</rule>
        <rule name="coroutines-and-state">viewModelScope.launch and Flow pipelines decouple call sites from execution (kotlin layer). UI state connects ViewModel → UI by the STATE property name — ONE search of that name finds emitter and collectors together. Click listeners and observers are lambdas with no symbols — find them behaviourally inside the owning screen's chunk.</rule>
        <rule name="query-style">Screen names, state property names, resource identifiers, DI types are the highest-precision tokens. Intent actions and navigation route strings trace inter-screen flow better than any graph.</rule>
    </rules>

    <playbook question="explain screen X" calls="2-4">resolve_symbol("XViewModel" or "XScreen") → get_chunk(the one whose logic is in question — ViewModel for behaviour, composable for UI) → ONE exact_tokens search for the launcher or the state property → answer. Several screens/types? ONE batched search (limit 2).</playbook>

</environment_prompt>
