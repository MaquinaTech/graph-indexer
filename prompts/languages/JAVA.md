<environment_prompt layer="2" type="language" name="java" requires="graph-indexer-core" version="1.0">

    <scope>Indexed code is Java (.java). Deltas to core; hard limits unchanged.</scope>

    <index_facts>
        <fact>Chunks: classes, interfaces, enums, constructors, methods. Annotations are part of the chunk — summaries surface @Override, validation, and framework annotations that frequently carry the real behaviour.</fact>
        <fact>Topology RELIABLE — imports tracked. One public class per file means path ≈ FQN: resolve_symbol("InvoiceService") is extremely reliable.</fact>
        <fact>Chunking is CLASS-GRANULAR (god-class split only ≥200 lines) — methods are NOT their own chunks in small classes. get_call_graph on a method name returns callers at class level, not method level; name the method explicitly and confirm by class context on the cards.</fact>
        <fact>Anonymous inner classes and lambdas have no named symbol — a Runnable defined inline lives in its enclosing method's chunk; find it by behavioural search.</fact>
    </index_facts>

    <rules>
        <rule name="overloads-collapse">Overloads share one name: resolve_symbol("save") / get_call_graph("save") mix all signatures — distinguish by parameter lists on the cards and say WHICH overload you mean.</rule>
        <rule name="polymorphic-dispatch">Call sites bind to the NAME as written, usually against an interface/superclass: verify the receiver's declared type before claiming a concrete impl is called. Enumerate overrides: ONE exact_tokens search on the method name — class context comes from each signature.</rule>
        <rule name="inheritance-walk">If resolve_symbol finds a method only on a parent type, that IS the impl — resolve at most ONE parent up, never the whole hierarchy.</rule>
        <rule name="frameworks-and-reflection">Class.forName, Method.invoke, DI containers, annotation processors invoke with ZERO static edges: an empty call graph on a public method of an annotated class means FRAMEWORK-INVOKED, not dead.</rule>
        <rule name="functional-interfaces">Lambdas and method references (this::handle, User::getName) create no edge to the referenced method — find sites with exact_tokens.</rule>
        <rule name="accessor-noise">Never read a POJO/bean body: detail: "signatures" or get_file_skeleton tells you everything a data class can. Exception flow: ONE exact_tokens search on the exception class finds throw sites and handlers together.</rule>
    </rules>

    <playbook question="explain service X / change a method safely" calls="2-4">resolve_symbol("X") (annotations visible) → get_chunk_summary(id, expand_calls: true) → answer with Used by:. Signature change: get_call_graph("method") → filter callers by class via paths → ONE caller chunk as template → edit.</playbook>

</environment_prompt>
