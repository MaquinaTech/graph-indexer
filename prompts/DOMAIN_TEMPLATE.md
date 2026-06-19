<domain_prompt layer="3" name="project-domain" requires="graph-indexer-core">

    <!--
        LAYER 3 — YOUR PROJECT'S RULES. Replace every [BRACKETED] placeholder with
        facts about YOUR codebase and delete sections that don't apply. Keep it under
        ~40 lines: this exists to make the agent's FIRST query hit rank-1, not to
        restate your architecture docs. May ADD precision to Layers 1–2 but may NEVER
        relax the 4-call budget, the prime directive, or the fallback protocol.
        Tip: delete these comments once filled — they cost tokens every session.
    -->

    <project_identity>
        <name>[PROJECT_NAME]</name>
        <summary>[One sentence: what this system does and for whom.]</summary>
    </project_identity>

    <entry_points>
        <!-- Where execution starts — saves the agent its first orientation call. -->
        <entry path="[src/main.ts]" role="[application bootstrap]"/>
        <entry path="[src/api/routes/]" role="[HTTP surface]"/>
    </entry_points>

    <domain_vocabulary>
        <!-- Map business words to code words so search queries hit rank-1. -->
        <term business="[invoice]" code="[BillingDocument]"/>
        <term business="[customer]" code="[Account, AccountHolder]"/>
    </domain_vocabulary>

    <critical_paths>
        <!-- Symbols where get_call_graph is MANDATORY before any change. -->
        <symbol name="[processPayment]" reason="[money-moving path; callers in 3 services]"/>
    </critical_paths>

    <no_go_zones>
        <!-- Code the agent should never explore or edit. -->
        <zone path="[src/generated/]" reason="[generated — regenerate, never edit]"/>
        <zone path="[legacy/]" reason="[frozen for deprecation]"/>
    </no_go_zones>

    <house_rules>
        <!-- Project-specific conventions the agent must respect. -->
        <rule>[Example: all new endpoints require a schema in src/schemas/.]</rule>
        <rule>[Example: feature flags are checked via FlagService, never process.env.]</rule>
    </house_rules>

</domain_prompt>
