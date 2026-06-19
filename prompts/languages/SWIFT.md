<environment_prompt layer="2" type="language" name="swift" requires="graph-indexer-core" version="1.0">

    <scope>Indexed code is Swift (.swift). Deltas to core; hard limits unchanged.</scope>

    <index_facts>
        <fact priority="critical">struct, class, enum, extension, actor ALL appear with card type `class_declaration` — the card does NOT distinguish them, so READ THE KEYWORD in the signature before reasoning about value vs reference semantics. A god-type is split so its methods become their own chunks.</fact>
        <fact priority="critical">A type's behaviour is SPREAD across its base declaration AND every `extension` — each is a separate chunk, all carry the SAME name, possibly in different files. resolve_symbol("Point") returns the struct AND every extension; protocol conformance is usually in an extension. Read them together, not just the first card.</fact>
        <fact>Topology WEAK: `import Module` is recorded but Swift resolves by MODULE not file path — an empty Used by: is uninformative, never "unused".</fact>
    </index_facts>

    <rules>
        <rule name="protocol-dispatch">Protocol calls bind by NAME across every conformer: get_call_graph("draw") mixes every draw(). Disambiguate by receiver type in each card. Enumerate conformers: ONE search_code(query: "conform protocol", exact_tokens: "ProtocolName") — extension conformances surface by the protocol name.</rule>
        <rule name="attributes-are-behaviour">Property wrappers/attributes are part of the chunk and frequently ARE the behaviour: @Published, @State/@Binding, @MainActor, @objc, @escaping. A computed property's logic lives in the PROPERTY declaration, not a synthesized getX accessor.</rule>
        <rule name="synthesized-has-no-chunk">Memberwise inits, synthesized Codable/Equatable/Hashable, enum case accessors have NO chunks — a "missing" member matching that list means the type declaration (or its Codable conformance) IS the answer.</rule>
        <rule name="closures-and-builders">Trailing closures/combinators (`.map { }`, `Task { }`, `DispatchQueue.async { }`) record a call to the combinator only; SwiftUI `body` and result builders generate view structure with no edges. Closure logic belongs to the enclosing chunk — find it behaviourally. `super.m()`/`self.m()` record receiver hints.</rule>
        <rule name="query-style">camelCase splits well; pin Type names and argument labels with exact_tokens. A method written `distance(to:)` is searched by its base name `distance`. For error flow, search the thrown error case name or its message string.</rule>
    </rules>

    <playbook question="explain type X and its conformances" calls="1-3">ONE search_code(query: "X", exact_tokens: "X") — the base declaration and its extension chunks surface together via the name boost; read keyword + attributes off the cards → get_chunk_summary(id, expand_calls: true) on the primary chunk. ≤1 protocol hop.</playbook>

</environment_prompt>
