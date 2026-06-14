<environment_prompt layer="2" type="language" name="css-scss" requires="graph-indexer-core" version="3.0">

    <scope>The indexed code includes stylesheets (.css, .scss). These are deltas to the core protocol — every hard limit is unchanged.</scope>

    <index_facts>
        <fact>RULE SETS chunk as their selector: one selector (or selector list) plus its declaration block. The chunk's "symbol" is the selector. There is no import topology for stylesheets, so Deps:/Used by: are empty.</fact>
        <fact>SCSS @mixin and @function ARE indexed as NAMED chunks — resolve_symbol("button-variant") and resolve_symbol("tint-color") work, and they are the reusable units worth searching by name. ($variables, @include sites and &-nesting are not separate chunks — find them by searching the token.)</fact>
        <fact>get_call_graph DOES NOT APPLY to styles (no call edges); for a mixin/function's call sites, search its name token. resolve_symbol is useful ONLY for SCSS @mixin/@function names, not for plain selectors.</fact>
        <fact>Very short rules (under ~2 lines) are filtered out as trivial fragments — a one-line utility class may be absent; widen the query or read the file if a specific tiny rule is the whole question.</fact>
        <fact>get_file_skeleton is WEAK on stylesheets (mostly anonymous `declaration` nodes, no `@keyframes` names) — don't use it to enumerate a sheet; search_code by selector/mixin token instead.</fact>
        <fact>In a MIXED repo, style chunks can surface as noise in natural-language searches for OTHER languages — add a path hint or directory token to keep code queries on code.</fact>
    </index_facts>

    <rules>
        <rule name="find-by-token">Styles for an element: ONE search of the class/id token, e.g. search_code(query: "card hover elevation styles", exact_tokens: ".card") or the bare class name. Variables and design tokens ($spacing, --color-primary): search the variable name — definition and usages return in one query.</rule>
        <rule name="cascade-awareness">Several rule sets can target one element and the top hit may not win the cascade. For "why does this look wrong", read the 2-3 top-ranked rule sets FROM THE SAME RESULT — never a second search, never whole stylesheets.</rule>
        <rule name="markup-side">WHERE a class is applied lives in components/markup, not stylesheets — that half of the question belongs to the component language layer (search the class name string in code chunks).</rule>
    </rules>

    <playbook question="why does element X look wrong" calls="1-2">ONE search of the selector token (top_k: 10) → list every matching rule_set with file:lines, compare declarations → answer. Stylesheet chunks are tiny; one search almost always suffices.</playbook>

</environment_prompt>
