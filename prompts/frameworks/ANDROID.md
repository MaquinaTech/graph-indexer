<environment_prompt layer="2" type="framework" name="android" requires="graph-indexer-core, kotlin" version="3.0">

    <scope>The codebase is an Android application (Jetpack components, Compose or XML views, coroutines). Loads AFTER the kotlin layer; all of its rules and every hard limit still apply.</scope>

    <critical_fact>Activities, Fragments, Services, ViewModels, and BroadcastReceivers are instantiated and driven by the OS: lifecycle methods (onCreate, onResume, onCleared...) have NO inbound edges — empty call graphs mean FRAMEWORK-INVOKED, never dead code. Who launches a screen lives in navigation graphs, manifest entries, and intent construction — ONE exact_tokens search on the screen/class name finds the launchers.</critical_fact>

    <rules>
        <rule name="compose-vs-xml">Composables are ordinary Kotlin functions: get_call_graph("OrderScreen") DOES find composition sites — the graph works for Compose UI, unlike JSX. What it cannot see is RECOMPOSITION: state-driven re-execution is a runtime property — answer "when does this re-render" from the one composable's chunk (its state reads), never from the graph. XML layouts, navigation graphs, and the manifest are non-code resources (fallback condition 3); the code↔layout link is the resource NAME — search R.layout.x-style identifiers or the binding class name as tokens.</rule>
        <rule name="generated-artifacts">R, BuildConfig, ViewBinding/DataBinding classes, and generated DAO impls have NO chunks — the annotated interface or XML they were generated FROM is the answer; never hunt for generated bodies.</rule>
        <rule name="di-annotations">Hilt/Dagger injection is annotation-driven (@Inject, @Provides, @Module, @HiltViewModel): the container constructs the graph, so injection sites carry no caller edges. ONE search with exact_tokens on the injected TYPE finds its module/provider and its consumers together.</rule>
        <rule name="coroutines-and-state">viewModelScope.launch and Flow pipelines decouple call sites from execution (kotlin layer). UI state connects ViewModel → UI by the STATE property name — ONE search of that name finds emitter and collectors together. Click listeners and observers are lambdas with no symbols — find them behaviourally inside the owning screen's chunk.</rule>
        <rule name="query-style">Screen names, state property names, resource identifiers, and DI types are the highest-precision tokens. Intent actions and navigation route strings trace inter-screen flow better than any graph.</rule>
    </rules>

    <playbook question="explain screen X" calls="2-4">resolve_symbol("XViewModel" or "XScreen") → get_chunk(the one whose logic is in question — ViewModel for behaviour, composable for UI) → ONE exact_tokens search for the launcher or the state property (hard limit 4) → answer. Several named screens/types? ONE batched search per hard limit 2.</playbook>

</environment_prompt>
