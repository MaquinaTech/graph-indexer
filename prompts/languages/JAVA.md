<environment_prompt layer="2" type="language" name="java" requires="graph-indexer-core" version="3.0">

    <scope>The indexed code is Java (.java). These are deltas to the core protocol — every hard limit is unchanged.</scope>

    <index_facts>
        <fact>Chunks: classes, interfaces, enums, constructors, and methods. Annotations are part of the chunk — summaries surface @Override, validation, and framework annotations, which frequently carry the real behaviour.</fact>
        <fact>Imports are tracked — Deps:/Used by: topology is RELIABLE here. One public class per file means file path ≈ fully-qualified name: resolve_symbol("InvoiceService") is extremely reliable.</fact>
        <fact>Anonymous inner classes and lambdas have no named symbol — a Runnable defined inline lives in its enclosing method's chunk; find such logic by behavioural search.</fact>
    </index_facts>

    <rules>
        <rule name="overloads-collapse">Overloads share one name: resolve_symbol("save") and get_call_graph("save") mix all signatures — distinguish by parameter lists on the cards and say WHICH overload you mean in your answer.</rule>
        <rule name="polymorphic-dispatch">Call sites bind to the NAME as written, usually against an interface or superclass: verify the receiver's declared type before claiming a concrete implementation is called. To enumerate overrides: ONE search with exact_tokens on the method name — class context comes from each signature.</rule>
        <rule name="inheritance-walk">IF resolve_symbol finds a method only on a parent type, that IS the implementation — resolve at most ONE parent up (hard limit 4), never the whole hierarchy.</rule>
        <rule name="frameworks-and-reflection">Class.forName, Method.invoke, DI containers, and annotation processors invoke code with ZERO static edges: an empty call graph on a public method of an annotated class means FRAMEWORK-INVOKED, not dead.</rule>
        <rule name="functional-interfaces">Lambdas and method references (this::handle, User::getName) create no edge to the referenced method — find reference sites with exact_tokens.</rule>
        <rule name="accessor-noise">Never read a POJO/bean body: detail: "signatures" or get_file_skeleton tells you everything a data class can. Exception flow: ONE search with exact_tokens on the exception class name finds throw sites and handlers together.</rule>
    </rules>

    <playbook question="explain service X / change a method safely" calls="2-4">resolve_symbol("X") (annotations visible) → get_chunk_summary(id, expand_calls: true) → answer with Used by: list. For a signature change: get_call_graph("method") → filter callers by class via paths → ONE caller chunk as template → edit.</playbook>

</environment_prompt>
