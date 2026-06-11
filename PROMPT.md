# graph-indexer — Agent Instructions

---

## Prime directive

This codebase is **pre-indexed**. The `graph-indexer` MCP server answers code
questions from an AST-precise search index in tens of tokens, with cross-file
topology your file tools cannot see.

**Every code discovery task starts with a graph-indexer tool. Never start with
a native file tool** — no `read file`, `list directory`, `grep`, `codebase
search`, `find`, or equivalent — regardless of what your IDE calls them.
Reading a file to "look around" costs 5,000–15,000 tokens; the same answer via
the index costs 50–700. The difference compounds over every step of your
session.

Native tools are a **last resort**, permitted only under the fallback rules at
the end of this document. Editing files is unaffected — write code with your
normal tools; *discovery* belongs to the index.

---

## The five rules

1. **Search before you read.** First step of any discovery task is
   `search_code`, `resolve_symbol`, or `get_repo_map` — never a file read.
2. **Know the name? Don't search it.** `resolve_symbol("validateToken")` is an
   O(1) exact lookup with topology included. Use it whenever you know the
   symbol's exact name. Use `search_code` only for concepts and behaviour.
3. **Never read a whole file to get one function.** Search results give you a
   chunk ID → `get_chunk(id)` returns exactly that function's body.
4. **Never change a signature blind.** Before modifying any exported
   function/class, `get_call_graph("name")` lists every caller repo-wide in
   one call. Skipping this breaks code you cannot see.
5. **Escalate token spend stepwise.** signatures → summary → smart → full
   body. Start cheap; pay for bodies only when you must (ladder below).

---

## Tool selection — decision table

| You need… | Call | ~Tokens |
| :--- | :--- | ---: |
| Orientation in an unfamiliar repo | `get_repo_map()` | 1,500 |
| Orientation in one subsystem | `get_repo_map(path_filter: "auth")` | 300 |
| A symbol you can name exactly | `resolve_symbol("UserService")` | 50 |
| Code for a concept/behaviour | `search_code(query, detail: "signatures")` | 100 |
| The interface of a found chunk | `get_chunk_summary(id)` | 50 |
| Interfaces of everything a chunk calls | `get_chunk_summary(id, expand_calls: true)` | 150 |
| The full implementation | `get_chunk(id)` | 300 |
| All exports of one known file | `get_file_skeleton("src/file.ts")` | 80 |
| Who calls a function (pre-refactor) | `get_call_graph("name")` | 100 |
| What a file imports / who imports it | resource `graph://dependencies/{path}` | 100 |
| Index health / why results look off | `list_index_stats()` | 100 |
| *(comparison)* reading one file directly | — | 5,000+ |

### Escalation ladder (token budget)

```
1. search_code(query, detail: "signatures", top_k: 5)   ~100 tok — find candidates
2. get_chunk_summary(id)                                 ~50 tok — confirm the interface
3. search_code(query, detail: "smart")                  ~750 tok — see query-relevant lines
4. get_chunk(id)                                        ~300 tok — full body, last resort
```

Stop climbing as soon as you can answer. Most questions die at step 1–2.

---

## Writing queries that hit

`search_code` is hybrid (BM25 keywords + semantic vectors) and **detects your
query style automatically**. Both styles are first-class:

**Keyword style** — when you know domain words or partial names:
- `JWT token validation expiry middleware`
- `route registration path method handler`
- Partial name known? Pin it: `search_code(query: "token validation", exact_tokens: "validateToken")` → guaranteed rank-1.
- Use resolve_symbol("Name") when you ONLY need the definition of that specific symbol. Use search_code(query: "...", exact_tokens: "Name") when you want to explore a concept but want to guarantee a specific symbol appears at the very top of the results.

**Natural-language style** — when you only know the behaviour:
- `How does the application parse incoming JSON payloads from the client?`
- `the logic that decides whether a requested URL matches a registered route`
- `stopping an HTTP call that takes too long or is no longer needed`

Rules of thumb:
- Describe **behaviour, not nouns**: `parse and validate request body schema`, not `validation`.
- One-word queries (`auth`, `request`, `handler`) are useless — thousands of matches.
- Include path hints when you have them: `middleware auth route` boosts `auth/middleware.ts`.
- **A keyword miss is not a dead end**: rephrase the same need as a full
  behavioural sentence — the semantic channel finds code that shares none of
  your words. This rephrase is *mandatory* before any native-tool fallback.
- Slow-but-smarter option: `search_code(..., rerank: true)` has a local LLM
  judge reorder the top results (~1–2 s). Use it when a natural-language query
  returns plausible-but-not-quite results.

### Reading results

Every result card includes **free topology** — use it instead of new searches:
- `Deps:` what this file imports (with key symbols per import)
- `Used by:` which files import this one
- `Calls:` functions this chunk invokes
- `ID:` pass to `get_chunk` / `get_chunk_summary` — never re-search what you already found.

A result with node type `re_export` means the symbol is re-exported from a
dependency (e.g. `fastapi` re-exporting Starlette's `BackgroundTasks`): the
implementation lives outside this repo — do not hunt for it in the codebase.

---

## Standard workflows

**Unfamiliar codebase** → `get_repo_map()` → pick files → `resolve_symbol` /
`search_code` to drill in.

**"Where is X implemented?"** → `search_code(behavioural query, detail:
"signatures")` → `get_chunk_summary(best id)` → `get_chunk(id)` only if you
must see the body.

**Safe refactor** → `get_call_graph("target")` → review callers →
`get_chunk(callerId)` for each call site you need to update → edit with your
normal tools.

**Understanding one file** → `get_file_skeleton(path)` (all exports + line
numbers, no bodies) → drill into specific symbols.

**Debugging a behaviour** → natural-language `search_code` describing the
symptom's mechanism → follow `Calls:` topology instead of re-searching.

---

## Anti-patterns (each of these is a bug in your behaviour)

- ❌ Reading a file as your *first* move on any question.
- ❌ `search_code("validateToken")` — you know the name; that's `resolve_symbol`.
- ❌ Re-searching a concept you already have a chunk ID for.
- ❌ `detail: "full"` by default — signatures first, always.
- ❌ Editing an exported signature without `get_call_graph` first.
- ❌ Giving up after one keyword query without trying a behavioural rephrase.
- ❌ Ignoring `Used by:` / `Calls:` topology and issuing new searches for it.
- ❌ Re-indexing after edits: Do not tell the user to re-index or attempt to re-index after you modify a file. Graph Indexer has a live daemon (watch-daemon.mjs) that instantly updates the index in the background using SQLite WAL. Your next search will automatically see your changes.

---

## Fallback to native tools — the ONLY permitted cases

You may use native file/search tools **only** when one of these is true:

1. **The index says no.** You tried BOTH query styles (keyword + behavioural
   sentence) and `resolve_symbol`, and the target genuinely isn't returned.
2. **The index is unhealthy.** `list_index_stats()` shows 0 chunks, a missing
   index, or a clearly stale index that the daemon isn't updating — tell the
   user to run `npm run mcp:index`, then fall back for now.
3. **Non-code files.** Configs, lockfiles, markdown, data files, generated
   artifacts — the index covers source code chunks; plain files are fair game.
4. **You need exact current file state for an edit** you are about to make
   (e.g. precise surrounding lines to produce a diff) — *after* the index
   located the file and line range for you.

When you do fall back, scope it: read the one file the index pointed you to —
never directory-walk or repo-grep what the index already answered.

---

## Quick reference

```
search_code(query, exact_tokens?, detail?, top_k?, rerank?)  hybrid search, topology included
resolve_symbol(symbol)                                       O(1) exact definition lookup
get_chunk(chunk_id, view?)                                   full body of one chunk
get_chunk_summary(chunk_id, expand_calls?)                   interface only, ~50 tok
get_file_skeleton(file_path)                                 all exports of a file, no bodies
get_call_graph(target_function)                              every caller repo-wide
get_repo_map(path_filter?, max_files?)                       PageRank-ordered codebase map
list_index_stats()                                           index health + search mode
graph://dependencies/{file_path}                             bidirectional import topology
```

**Detail levels:** `signatures` ~20 tok/result · `smart` (default) ~150 ·
`full` ~300. **Search modes:** hybrid (semantic + lexical) when Ollama runs;
lexical-only otherwise — in lexical-only mode prefer keyword-style queries.
