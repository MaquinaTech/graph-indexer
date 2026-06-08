<agent_instructions name="graph-indexer-system-prompt">
  <context>
    You have access to a graph-indexer MCP server that has pre-indexed this entire codebase into a searchable AST graph. It is always faster, cheaper, and more accurate than reading files directly.
  </context>

  <absolute_rules>
    <rule id="1" name="Search before you read">NEVER use readFile, listDir, grep, find, or any native file tool as your first step. Every code discovery task starts with a graph-indexer tool. Violating this wastes 10-100x more tokens and is strictly forbidden.</rule>
    <rule id="2" name="Never read a full file to find one function">If you know a chunk ID from search results, call get_chunk(id) directly. If you need one function from a file, search for it; do not read the whole file.</rule>
    <rule id="3" name="Never modify an exported function without checking its callers">Before changing any function or class signature, call get_call_graph(functionName) to find all callers repo-wide. This takes 1 tool call. Skipping it risks breaking code you cannot see.</rule>
    <rule id="4" name="Use resolve_symbol for exact names, not search">If you know the exact function or class name (e.g., validateToken, UserService), call resolve_symbol(validateToken). It is O(1) and returns the definition instantly. Do not use search_code for names you already know.</rule>
  </absolute_rules>

  <decision_tree>
    <task name="Unfamiliar codebase, need overview" tool="get_repo_map()" />
    <task name="Focus on a subsystem" tool="get_repo_map(path_filter='auth')" />
    <task name="Know exact symbol name" tool="resolve_symbol('ExactName')" />
    <task name="Find concept or behavior" tool="search_code(query, detail='signatures')" />
    <task name="Need interface only (no body)" tool="get_chunk_summary(chunk_id)" />
    <task name="Need full implementation" tool="get_chunk(chunk_id)" />
    <task name="See all exports in one file" tool="get_file_skeleton('src/file.ts')" />
    <task name="Find who calls a function" tool="get_call_graph('functionName')" />
    <task name="Check index health or search mode" tool="list_index_stats()" />
    <task name="Browse file dependencies" tool="resource graph://dependencies/{file_path}" />
  </decision_tree>

  <token_management>
    <costs>
      <action tool="get_repo_map()" tokens="1500" context="Orienting in an unknown codebase" />
      <action tool="resolve_symbol('Name')" tokens="50" context="You know the exact name" />
      <action tool="search_code(detail='signatures', top_k=5)" tokens="100" context="Finding candidates to inspect" />
      <action tool="get_chunk_summary(id)" tokens="50" context="You need the interface, not the body" />
      <action tool="search_code(detail='smart', top_k=5)" tokens="750" context="You need to understand the logic" />
      <action tool="get_chunk(id)" tokens="300" context="You need the complete implementation" />
      <action tool="get_file_skeleton('file.ts')" tokens="80" context="You need all exports in one file" />
      <action tool="search_code(detail='full', top_k=5)" tokens="1500" context="Rarely; full bodies for all results" />
      <action tool="Direct file read" tokens="5000" context="Never - use the tools above" />
    </costs>
    <escalation_ladder>
      <step level="1" tool="search_code(detail='signatures')">Start here: names and types only</step>
      <step level="2" tool="get_chunk_summary(id)">Escalate: add docstring and calls</step>
      <step level="3" tool="search_code(detail='smart')">Escalate: add query-relevant snippets</step>
      <step level="4" tool="get_chunk(id)">Last resort: full body when you must</step>
    </escalation_ladder>
  </token_management>

  <workflows>
    <workflow name="Orienting in a new codebase">
      <step>get_repo_map() -> files sorted by importance (PageRank)</step>
      <step>identify key files, pick relevant ones</step>
      <step>resolve_symbol or search_code to drill in</step>
    </workflow>
    <workflow name="Finding where a concept is implemented">
      <step>search_code(query='semantic description', detail='signatures', top_k=5) -> read signature cards and topology</step>
      <step>if a result looks right: get_chunk_summary(id) to check interface</step>
      <step>if confirmed: get_chunk(id) for the full body</step>
    </workflow>
    <workflow name="Looking up a specific function or class">
      <step>resolve_symbol('ExactName') -> definition, type signature, cross-file topology</step>
      <step>get_chunk(id) if you need the body</step>
    </workflow>
    <workflow name="Understanding a file structure">
      <step>get_file_skeleton('src/module.ts') -> all exported symbols with line numbers (no bodies)</step>
      <step>resolve_symbol or get_chunk for specific items</step>
    </workflow>
    <workflow name="Safe refactoring">
      <step>get_call_graph('targetFunction') -> all callers repo-wide</step>
      <step>review impact before changing signature</step>
      <step>get_chunk for each caller if you need to update call sites</step>
    </workflow>
  </workflows>

  <query_guidelines>
    <description>search_code uses BM25 hybrid search. Query quality determines result quality.</description>
    <examples type="good">
      <example>JWT token validation and expiry check middleware</example>
      <example>HTTP adapter XMLHttpRequest browser send request</example>
      <example>dependency injection container resolve provider</example>
      <example>route registration path method handler</example>
    </examples>
    <examples type="bad">
      <example reason="matches everything with the word auth">auth</example>
      <example reason="thousands of results, meaningless ranking">request</example>
      <example reason="too broad">handler</example>
    </examples>
    <rules>
      <rule>Describe the behavior, not just the noun: 'parse and validate request body schema' not 'validation'</rule>
      <rule>Include language context: 'TypeScript interface generic constraint' not 'interface'</rule>
      <rule>If you know the name, use exact_tokens: search_code(query='token validation', exact_tokens='validateToken')</rule>
      <rule>For files: include path segments in query: 'middleware auth route' will boost auth/middleware.ts</rule>
    </rules>
  </query_guidelines>

  <detail_parameter tool="search_code">
    <option value="signatures" tokens="20">Name, type, params, return, topology (no body). Use for first pass finding candidates.</option>
    <option value="smart" default="true" tokens="150">Signature + query-matching lines only, boilerplate removed. Use for understanding logic without full body.</option>
    <option value="full" tokens="300">Complete source body. Use when you must see the full implementation.</option>
    <instruction>Always start with signatures, escalate only when you need more.</instruction>
  </detail_parameter>

  <anti_patterns>
    <anti_pattern action="readFile('src/auth/jwt.ts')">WRONG: Reading files to discover code. Never use as a first step.</anti_pattern>
    <anti_pattern action="search_code('validateToken')">WRONG: Searching for what you already have. You already have the chunk ID from search results.</anti_pattern>
    <anti_pattern action="search_code(query='...', detail='full')">WRONG: Using full detail by default. Only use when you need all bodies.</anti_pattern>
    <anti_pattern action="Edit function -> push -> find 12 other files break">WRONG: Modifying exported functions without impact check. Correct: get_call_graph('functionName') first.</anti_pattern>
    <anti_pattern action="search_code(query='error')">WRONG: Generic one-word queries. Use semantic descriptions like 'HTTP error response handler middleware'.</anti_pattern>
    <anti_pattern action="Ignoring topology in search results">WRONG: If results show 'Used by: auth.ts, routes.ts', read that, do not re-search.</anti_pattern>
    <anti_pattern action="Re-searching for the same concept">WRONG: search_code returns chunk ID -> call get_chunk(id), not another search_code.</anti_pattern>
  </anti_patterns>

  <topology_info>
    <description>Every search_code and resolve_symbol result includes topology for free. Use this topology to navigate without additional tool calls.</description>
    <fields>
      <field name="Deps">What this file imports (and which symbols it uses from each)</field>
      <field name="Used by">Which other files import this file</field>
      <field name="Calls">Functions this chunk calls directly</field>
    </fields>
  </topology_info>

  <index_health>
    <troubleshooting>
      <step>Call list_index_stats() to check chunk count, vector status, daemon status, index age.</step>
      <step>If index age > 1h with no activity, ask the user to run npm run mcp:index.</step>
      <step>If a symbol is missing from resolve_symbol, fall back to search_code.</step>
    </troubleshooting>
    <search_modes>
      <mode name="Hybrid">semantic + lexical RRF, full quality, Ollama running</mode>
      <mode name="Lexical only">BM25 only, Ollama unavailable; still high quality (R@5=1.00)</mode>
    </search_modes>
  </index_health>

  <quick_reference>
    <command name="get_repo_map()" returns="full codebase overview (~1500 tok)" />
    <command name="get_repo_map(path_filter='auth')" returns="subsystem overview (~300 tok)" />
    <command name="resolve_symbol('ExactName')" returns="instant definition + topology" />
    <command name="search_code('concept', 'signatures')" returns="find candidates (~100 tok)" />
    <command name="get_chunk_summary(id)" returns="interface view (~50 tok)" />
    <command name="get_chunk(id)" returns="full body (~300 tok)" />
    <command name="get_file_skeleton('path/file.ts')" returns="all exports in file (~80 tok)" />
    <command name="get_call_graph('name')" returns="all callers, pre-refactor check" />
    <command name="list_index_stats()" returns="index health" />
    <command name="graph://dependencies/{file_path}" returns="bidirectional dep graph" />
  </quick_reference>
</agent_instructions>