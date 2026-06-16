<environment_prompt layer="2" type="language" name="swift" requires="graph-indexer-core" version="3.0">

    <scope>The indexed code is Swift (.swift). These are deltas to the core protocol — every hard limit is unchanged.</scope>

    <index_facts>
        <fact priority="critical">struct, class, enum, extension, and actor ALL appear with card type `class_declaration` — the card does not distinguish them, so READ THE KEYWORD in the signature before reasoning about value vs reference semantics. Methods inside a normal type live in that one chunk; a god-type is split so its methods become their own chunks.</fact>
        <fact priority="critical">A type's behaviour is SPREAD ACROSS its base declaration AND every `extension` of it — each is a separate chunk, all carry the SAME name, and they may sit in different files. resolve_symbol("Point") returns the struct AND every extension; protocol conformance is usually in an extension. To understand a type you must read them together, not just the first card.</fact>
        <fact>`import Module` is recorded, but Swift resolves by MODULE not file path, so Deps:/Used by: topology is WEAK here — an empty Used by: is uninformative, never read it as "unused".</fact>
    </index_facts>

    <rules>
        <rule name="protocol-dispatch">Protocol method calls bind by NAME across every conformer: get_call_graph("draw") mixes every draw() in the codebase. Disambiguate by the receiver type in each card's signature. To enumerate conformers of a protocol: ONE search_code(query: "conform protocol", exact_tokens: "ProtocolName") — conformances declared in extensions surface by the protocol name.</rule>
        <rule name="attributes-are-behaviour">Property wrappers and attributes are part of the chunk and frequently ARE the behaviour: `@Published`, `@State`/`@Binding`, `@MainActor`, `@objc`, `@escaping`. A computed property's logic lives in the PROPERTY declaration, not a synthesized getX accessor.</rule>
        <rule name="synthesized-has-no-chunk">Memberwise initializers, synthesized Codable/Equatable/Hashable conformances, and enum `case` accessors have NO chunks — IF a "missing" member matches that list, the type declaration (or its `Codable` conformance) IS the answer; do not hunt for a generated body.</rule>
        <rule name="closures-and-builders">Trailing closures and combinators (`.map { }`, `Task { }`, `DispatchQueue.async { }`) record a call to the combinator only; SwiftUI `body` and result builders generate view structure with no edges. Logic inside a closure belongs to the enclosing chunk — find it behaviourally, not in the graph. `super.m()` / `self.m()` record receiver hints (super, this).</rule>
        <rule name="query-style">camelCase splits well; pin Type names and argument labels with exact_tokens. A method written `distance(to:)` is searched by its base name `distance`. For error flow, search the thrown error case name or its message string.</rule>
    </rules>

    <playbook question="explain type X and its conformances" calls="1-3">ONE search_code(query: "X", exact_tokens: "X") — the base declaration and its extension chunks surface together via the name boost; read the keyword + attributes off the cards → get_chunk_summary(id, expand_calls: true) on the primary chunk. At most ONE protocol hop (hard limit 4).</playbook>

</environment_prompt>
