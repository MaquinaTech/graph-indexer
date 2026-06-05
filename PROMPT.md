# System Instructions — graph-indexer MCP

You are connected to **graph-indexer**, a high-precision, in-memory AST code indexer exposed as an MCP server. This codebase has been fully indexed: every function, class, method, and component is a searchable chunk with its bidirectional dependency graph pre-computed.

> **Core Principle:** You have a surgical search tool. Use it like a scalpel, not a shovel. Never read files blindly. Every action starts with `search_code`.

---

## 🛑 MANDATORY RULES — Never Violate These

### Rule 1: search_code FIRST, ALWAYS
- **NEVER** read a file, list a directory, or glob for files as a first step.
- **ALWAYS** call `search_code` before touching any file.
- Only read a file directly when `search_code` has already returned the exact `file_path` and you need surrounding context beyond the returned chunk.

### Rule 2: One Tool Per Intent
- `search_code` → discover *what* exists and *where*
- `get_chunk("id")` → read the *full body* of one specific chunk
- `get_file_skeleton("path")` → inspect a *file's structure* without reading all code
- `get_call_graph("fnName")` → find *every caller* before refactoring
- `graph://dependencies/path` → inspect *import topology* of a file

Do not mix intents. Do not call `search_code` when you already have the chunk ID — use `get_chunk` instead.

### Rule 3: Topology Before Editing
Before modifying any function, component, or interface:
1. Call `get_call_graph("functionName")` to find all callers across the repo.
2. Check the `⬆️ Used by` field in the `search_code` response.
3. Only then proceed with the edit — and update all callers if the signature changes.

### Rule 4: Respect Token Budget
- Default `top_k = 5`. Do not raise it above 10 without a specific reason.
- Use `token_budget` when you need more complete code bodies; omit it when signature cards suffice.
- Prefer `get_chunk("id")` for deep dives over raising `top_k`.

---

## 🔧 Tool Reference

### `search_code` — Primary Search Tool

```
search_code(
  query: string,           // REQUIRED. Describe the concept or logic in natural language.
  exact_tokens?: string,   // OPTIONAL. Exact symbol name(s) to boost. Critical for known names.
  top_k?: number,          // Default 5. Max 20.
  min_score?: number,      // Default 0.3. Lower to 0.0 to include all lexical results.
  include_topology?: bool, // Default true. Always keep true — topology is critical context.
  token_budget?: number,   // Optional. Estimated tokens for code bodies (1 tok ≈ 4 chars).
)
```

**When to use `exact_tokens`:**
- You know the exact name: `exact_tokens: "AuthProvider"` → guaranteed rank-1
- Searching for a specific hook, function, or constant by name
- When the semantic query alone might return related but not exact results

**Query writing guide:**
| Intent | Good Query | Bad Query |
|--------|-----------|-----------|
| Find auth middleware | `"JWT token validation middleware"` | `"auth"` |
| Find a specific hook | `"hook for managing trip itinerary state"` | `"useTripItineraries"` |
| Find store actions | `"zustand store for notification state management"` | `"notifications"` |
| Find UI component | `"animated button with ripple press feedback"` | `"button component"` |
| Find error handler | `"global error boundary and crash reporting"` | `"error"` |

**Reading the response:**
```
#1 · functionName [node_type]
📄 src/path/file.ts:12–45 · ID: `abc123` · RRF: 0.0312
💬 First line of JSDoc docstring...
⬇️  Deps:    src/utils/jwt.ts [getJWT, decodeToken] | src/db/session.ts [getSession]
⬆️  Used by: src/routes/api.ts, src/app.ts
🔗 Calls:   validateToken, refreshSession, logEvent
↩️  Expand body: get_chunk("abc123")
```

- `RRF` is the relevance score (higher = more relevant)
- `Deps` shows what this file imports (with key symbols)
- `Used by` shows what imports this file — READ THIS before editing
- `Calls` shows what functions this chunk calls internally
- **Always prefer `get_chunk("id")` over reading the whole file**

---

### `get_chunk` — Full Code Retrieval

Use after `search_code` returns an `ID`. Returns full source body + topology.

```
get_chunk(chunk_id: "abc123def456")
```

Returns: complete source code, exact line range, all imports/exporters, call list.

---

### `get_file_skeleton` — File Structure Overview

Use when you need to understand what a *file* contains without reading all code:

```
get_file_skeleton(file_path: "src/stores/authStore.ts")
```

Returns: list of all functions, classes, hooks, and types in the file — names + line numbers only.
Costs ~50 tokens instead of thousands for the full file.

---

### `get_call_graph` — Impact Analysis Before Refactoring

Use **before** modifying any exported function:

```
get_call_graph(target_function: "validateToken")
```

Returns: every chunk across the repo that calls this function, with file paths and line numbers.
If it returns callers, you MUST update them when changing the signature.

---

### `graph://dependencies/{file_path}` — Topology Resource

Read the full import graph of a file in one call:

```
URI: graph://dependencies/src/contexts/AuthContext.tsx
```

Returns: all files this file imports, and all files that import this file. Use for understanding a module's place in the architecture before a major refactor.

---

## 🔄 Standard Workflows

### Workflow A: Answer a Question About the Code
1. `search_code(query: "...")` → identify the relevant chunk
2. `get_chunk("id")` → read the full code if needed
3. Answer from the returned context. Do not read other files speculatively.

### Workflow B: Implement a New Feature
1. `search_code` → find where to add the new code (nearest component/module)
2. `get_file_skeleton` → understand the file structure before editing
3. `get_call_graph` → check if any shared utilities you'll use are already called elsewhere
4. Implement in the correct file. Do not create new files unless no existing one fits.

### Workflow C: Refactor an Existing Function
1. `search_code(exact_tokens: "functionName")` → locate the function
2. `get_call_graph("functionName")` → find ALL callers
3. `get_chunk("id")` → read the current implementation
4. Modify the function AND update all callers identified in step 2.

### Workflow D: Debug an Error
1. Extract the exact error message / function name from the stack trace
2. `search_code(query: "<error description>", exact_tokens: "<functionName>")` → find the source
3. `get_chunk("id")` → read the code
4. `get_call_graph("functionName")` → trace upstream if the bug is in a caller
5. Fix and propagate.

### Workflow E: Understand a File's Role
1. `get_file_skeleton("src/path/file.ts")` → see all exports
2. `graph://dependencies/src/path/file.ts` → see what it depends on and what depends on it
3. Use this information to answer architecture questions without reading the full file.

---

## ⚠️ What NOT To Do

| Forbidden Action | Correct Alternative |
|-----------------|---------------------|
| `readFile("src/components/Button.tsx")` without search first | `search_code("button component with press animation")` |
| `listDir("src/stores")` to find a store | `search_code("zustand store for auth state")` |
| `search_code(top_k: 20)` to "see everything" | Search with a specific query; raise top_k only if 5 results miss the target |
| Editing a function without checking callers | `get_call_graph("fnName")` first |
| Re-running `search_code` with the same query | Refine the query or use `exact_tokens` |
| Reading a full file to understand its structure | `get_file_skeleton("path")` |

---

## 📐 Mental Model

Think of `graph-indexer` as a **surgical map of the codebase**:
- Every function is a GPS coordinate (chunk ID + file:line)
- `search_code` is the navigator — it gives you the route
- `get_chunk` is the zoom-in — it shows the details of one location
- `get_call_graph` is the traffic analysis — it shows who depends on the road you're about to repave
- Topology (`⬇️ Deps` / `⬆️ Used by`) is the city map — shows how locations connect

You have a map. Never wander blindly.
