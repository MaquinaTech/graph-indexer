<environment_prompt layer="2" type="language" name="css-scss" requires="graph-indexer-core" version="1.0">

    <scope>Indexed code includes stylesheets (.css .scss). Deltas to core; hard limits unchanged.</scope>

    <index_facts>
        <fact>RULE SETS chunk as their selector (selector + declaration block); the chunk's "symbol" is the selector. No import topology — Deps:/Used by: are empty.</fact>
        <fact>SCSS @mixin and @function ARE indexed as NAMED chunks — resolve_symbol("button-variant") works; they are the reusable units worth searching by name. ($variables, @include sites, &-nesting are not separate chunks — find them by searching the token.)</fact>
        <fact>get_call_graph DOES NOT APPLY (no call edges); for a mixin/function's call sites, search its name token. resolve_symbol is useful ONLY for @mixin/@function names, not plain selectors.</fact>
        <fact>Very short rules (under ~2 lines) are filtered as trivial — a one-line utility class may be absent; widen the query or read the file if a tiny rule is the whole question.</fact>
        <fact>get_file_skeleton is WEAK on stylesheets (mostly anonymous declaration nodes, no @keyframes names) — search_code by selector/mixin token instead.</fact>
        <fact>In a MIXED repo, style chunks surface as noise in NL searches for other languages — add a path/directory hint to keep code queries on code.</fact>
    </index_facts>

    <rules>
        <rule name="find-by-token">Styles for an element: ONE search of the class/id token, e.g. search_code(query: "card hover elevation styles", exact_tokens: ".card"). Variables/design tokens ($spacing, --color-primary): search the variable name — definition and usages return in one query.</rule>
        <rule name="cascade-awareness">Several rule sets can target one element and the top hit may not win the cascade. For "why does this look wrong", read the 2-3 top-ranked rule sets FROM THE SAME RESULT — never a second search, never whole stylesheets.</rule>
        <rule name="markup-side">WHERE a class is applied lives in components/markup, not stylesheets — that half belongs to the component language layer (search the class name string in code chunks).</rule>
    </rules>

    <playbook question="why does element X look wrong" calls="1-2">ONE search of the selector token (top_k: 10) → list every matching rule_set with file:lines, compare declarations → answer. Stylesheet chunks are tiny; one search almost always suffices.</playbook>

</environment_prompt>
