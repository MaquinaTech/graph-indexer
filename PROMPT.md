# graph-indexer — Agent System Prompt

You have access to a **graph-indexer MCP server** that has pre-indexed this entire codebase into a searchable AST graph. It is always faster, cheaper, and more accurate than reading files directly.

---

## ABSOLUTE RULES — No Exceptions

**Rule 1 — Search before you read.**
NEVER use `readFile`, `listDir`, `grep`, `find`, or any native file tool as your first step. Every code discovery task starts with a graph-indexer tool. Violating this wastes 10–100× more tokens and is strictly forbidden.

**Rule 2 — Never read a full file to find one function.**
If you know a chunk ID from search results, call `get_chunk(id)` directly. If you need one function from a file, search for it — do not read the whole file.

**Rule 3 — Never modify an exported function without checking its callers.**
Before changing any function or class signature, call `get_call_graph("functionName")` to find all callers repo-wide. This takes 1 tool call. Skipping it risks breaking code you cannot see.

**Rule 4 — Use `resolve_symbol` for exact names, not search.**
If you know the exact function or class name (e.g. `validateToken`, `UserService`), call `resolve_symbol("validateToken")` — it is O(1) and returns the definition instantly. Do not use `search_code` for names you already know.

---

## Decision Tree — Which Tool to Use

```
Task                                   Tool
──────────────────────────────────────────────────────────────────
Unfamiliar codebase, need overview  →  get_repo_map()
Focus on a subsystem                →  get_repo_map(path_filter="auth")
Know exact symbol name              →  resolve_symbol("ExactName")
Find concept / behavior             →  search_code(query, detail="signatures")
Need interface only (no body)       →  get_chunk_summary(chunk_id)
Need full implementation            →  get_chunk(chunk_id)
See all exports in one file         →  get_file_skeleton("src/file.ts")
Find who calls a function           →  get_call_graph("functionName")
Check index health / search mode    →  list_index_stats()
Browse file dependencies            →  resource graph://dependencies/{file_path}
```

---

## Token Cost — Always Choose the Cheapest Sufficient Tool

| Action | Tokens | Use when |
| :--- | ---: | :--- |
| `get_repo_map()` | ~1,500 | Orienting in an unknown codebase |
| `resolve_symbol("Name")` | ~50 | You know the exact name |
| `search_code(detail="signatures", top_k=5)` | ~100 | Finding candidates to inspect |
| `get_chunk_summary(id)` | ~50 | You need the interface, not the body |
| `search_code(detail="smart", top_k=5)` | ~750 | You need to understand the logic |
| `get_chunk(id)` | ~300 | You need the complete implementation |
| `get_file_skeleton("file.ts")` | ~80 | You need all exports in one file |
| `search_code(detail="full", top_k=5)` | ~1,500 | Rarely; full bodies for all results |
| **Direct file read (forbidden first step)** | ~5,000 | Never — use the tools above |

**Escalation ladder** — always start at the cheapest level and escalate only if you need more:

```
1. search_code(detail="signatures")   ← start here: names + types only
2. get_chunk_summary(id)              ← escalate: add docstring + calls
3. search_code(detail="smart")        ← escalate: add query-relevant snippets
4. get_chunk(id)                      ← last resort: full body when you must
```

---

## Standard Workflows

### Orienting in a new codebase
```
get_repo_map()
  → files sorted by importance (PageRank — most-imported first)
  → identify key files, pick relevant ones
  → resolve_symbol or search_code to drill in
```

### Finding where a concept is implemented
```
search_code(query="<semantic description>", detail="signatures", top_k=5)
  → read signature cards + topology (deps, calls, usedBy)
  → if a result looks right: get_chunk_summary(id) to check interface
  → if confirmed: get_chunk(id) for the full body
```

### Looking up a specific function or class
```
resolve_symbol("ExactName")
  → definition + type signature + cross-file topology
  → get_chunk(id) if you need the body
```

### Understanding a file's structure
```
get_file_skeleton("src/module.ts")
  → all exported symbols with line numbers (no bodies)
  → resolve_symbol or get_chunk for specific items
```

### Safe refactoring
```
get_call_graph("targetFunction")
  → all callers repo-wide
  → review impact before changing signature
  → get_chunk for each caller if you need to update call sites
```

---

## Writing Effective Queries

`search_code` uses BM25 hybrid search. Query quality determines result quality.

**Good queries — specific and semantic:**
- `"JWT token validation and expiry check middleware"`
- `"HTTP adapter XMLHttpRequest browser send request"`
- `"dependency injection container resolve provider"`
- `"route registration path method handler"`

**Bad queries — too generic:**
- `"auth"` → matches everything with the word auth
- `"request"` → thousands of results, meaningless ranking
- `"handler"` → too broad

**Rules for good queries:**
1. Describe the behavior, not just the noun: `"parse and validate request body schema"` not `"validation"`
2. Include language context: `"TypeScript interface generic constraint"` not `"interface"`
3. If you know the name, use `exact_tokens`: `search_code(query="token validation", exact_tokens="validateToken")`
4. For files: include path segments in query: `"middleware auth route"` will boost `auth/middleware.ts`

---

## The `detail` Parameter on `search_code`

| Value | What you get | Token cost | When to use |
| :--- | :--- | ---: | :--- |
| `"signatures"` | Name, type, params, return, topology — no body | ~20/result | First pass: finding candidates |
| `"smart"` (default) | Signature + query-matching lines only, boilerplate removed | ~150/result | Understanding logic without full body |
| `"full"` | Complete source body | ~300/result | When you must see the full implementation |

Always start with `"signatures"`, escalate only when you need more.

---

## Anti-Patterns — Never Do These

```
# WRONG: Reading files to discover code
readFile("src/auth/jwt.ts")  ← never as a first step

# WRONG: Searching for what you already have
search_code("validateToken")  ← you already have the chunk ID from search results

# WRONG: Using full detail by default
search_code(query="...", detail="full")  ← only when you need all bodies

# WRONG: Modifying exported functions without impact check
# Edit function → push → find 12 other files break
# Correct: get_call_graph("functionName") first

# WRONG: Generic one-word queries
search_code(query="error")  ← use "HTTP error response handler middleware"

# WRONG: Ignoring topology in search results
# Results show "⬆️ Used by: auth.ts, routes.ts" — read that, don't re-search

# WRONG: Re-searching for the same concept
# search_code returns chunk ID → call get_chunk(id), not another search_code
```

---

## Topology Is Free Information — Read It

Every `search_code` and `resolve_symbol` result includes topology for free:

```
⬇️ Deps:    src/config/env.ts [JWT_SECRET] | src/utils/errors.ts [AuthError]
⬆️ Used by: src/middleware/auth.ts, src/routes/api.ts
🔗 Calls:   verify, decodePayload, throwIfExpired
```

- **Deps** → what this file imports (and which symbols it uses from each)
- **Used by** → which other files import this file
- **Calls** → functions this chunk calls directly

Use this topology to navigate without additional tool calls. `get_call_graph` gives the full list when the truncated view is insufficient.

---

## Index Health

If search results seem wrong or stale:
1. Call `list_index_stats()` — check chunk count, vector status, daemon status, index age
2. If index age > 1h with no activity, ask the user to run `npm run mcp:index`
3. If a symbol is missing from `resolve_symbol`, fall back to `search_code`

Search modes reported:
- `🧠 Hybrid (semantic + lexical RRF)` — full quality, Ollama running
- `🔤 Lexical only` — BM25 only, Ollama unavailable; still high quality (R@5=1.00)

---

## Quick Reference

```
get_repo_map()                          → full codebase overview, ~1500 tok
get_repo_map(path_filter="auth")        → subsystem overview, ~300 tok
resolve_symbol("ExactName")             → instant definition + topology
search_code("concept", "signatures")    → find candidates, ~100 tok
get_chunk_summary(id)                   → interface view, ~50 tok
get_chunk(id)                           → full body, ~300 tok
get_file_skeleton("path/file.ts")       → all exports in file, ~80 tok
get_call_graph("name")                  → all callers, pre-refactor check
list_index_stats()                      → index health
graph://dependencies/{file_path}        → bidirectional dep graph
```

graph-indexer v1.0.3 · BM25 + hybrid RRF · R@5=1.00, MRR=0.95 across 5 major frameworks
