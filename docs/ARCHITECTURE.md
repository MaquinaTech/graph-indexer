# Architecture

graph-indexer turns a repository into a small relational model of its code — files, symbols,
references, imports, field types — keeps that model in step with the working tree, and answers
six kinds of questions over it through MCP. This document follows the data from source text to a
tool reply.

```
 working tree ──▶ discover ─▶ extract ─▶ store ─▶ resolve ──▶ SQLite index
   (git / fs)       (src/index, src/parse)                    (.graph-indexer/index.db)
        ▲                                                             │
        │  watcher + stat sweeps: ensureFresh() before every answer   ▼
        └──────────────────────────────────────────────  query layer (src/query/intel.mjs)
                                                       references · call graph · impact
                                                       search · maps
                                                                      │
                                                       MCP tools over stdio (src/mcp)
```

## Source layout

| path | role |
|---|---|
| `bin/graph-indexer.mjs` | CLI: `init`, `serve`, `index`, `status` and one command per tool |
| `src/parse/runtime.mjs` | loads the vendored web-tree-sitter runtime and gzipped grammar WASM |
| `src/parse/languages.mjs`, `src/parse/lang/*.mjs` | one spec per language: a tree-sitter query plus small hooks |
| `src/parse/extract.mjs` | language-agnostic extraction and intra-file type inference |
| `src/index/discover.mjs` | which files to index (git, `.gitignore`, generated/minified/huge filters, symlink containment) |
| `src/index/modules.mjs` | module resolution: import specifier → file or directory |
| `src/index/resolver.mjs` | symbol table and the reference-binding ladder |
| `src/index/indexer.mjs` | incremental sync: change detection, per-file writes, targeted re-resolution |
| `src/index/fingerprint.mjs` | extractor fingerprint; a change rebuilds the index |
| `src/index/graph.mjs` | PageRank centrality (global and personalized) |
| `src/store/db.mjs` | SQLite schema (`node:sqlite`, WAL) and helpers |
| `src/search/*.mjs` | tokenizer, query analysis, hybrid ranking |
| `src/query/intel.mjs` | the query facade: freshness, symbol lookup, references, dependents, impact, maps |
| `src/mcp/*.mjs` | MCP server, tool definitions and text rendering |
| `src/cli/init.mjs` | agent configuration writer |

## 1. Parsing and extraction

Each language is described by a spec (`src/parse/lang/*.mjs`): file extensions, one tree-sitter
query, and optional hooks (import parsing, visibility, doc comments, test-file pattern, type
tables). The query is compiled once per process; only captured nodes cross the WASM boundary.

Capture conventions:

| capture | meaning |
|---|---|
| `@def.<kind>` + `@name` [+ `@owner`, `@type`] | a definition; `@type` is its declared or return type |
| `@ref.<kind>` + `@name` [+ `@recv`] | a reference: `call`, `new`, `type`, `inherit`, `decorator`, `value`, `read` |
| `@import`, `@import.require` + `@src` | import statements / CommonJS `require` |
| `@bind` + `@bind.name` + `@bind.(type\|new\|call\|expr\|elem)` | type evidence for a local |
| `@field` + `@field.name` + `@field.(type\|new\|expr\|var)` | type evidence for a class field |
| `@scope` | an anonymous function, lambda or comprehension (a lexical scope) |
| `@ret` | a returned expression (return-type inference) |

`extract.mjs` turns matches into:

- **symbols** — nested by syntax (`Class.method`), with signature (text up to the body), doc
  comment, export/visibility, static flag, decorators and bases. Constructor parameter properties
  are hoisted to class fields; class expressions assigned to fields/variables are classes, and
  one without a name is the class `<anonymous>` (so `this` in its methods is its own).
- **references** — one per name node (the most specific kind wins: a decorator call is a
  `decorator`, `new X()` is `new`), with the enclosing symbol, a receiver descriptor and, when it
  can be inferred from the file alone, the receiver's static type.
- **imports** and **inferred field types** for cross-file resolution.

### Receiver descriptors and type inference

An expression is summarized as a descriptor: `this`, `x`, an access chain such as
`this.repo.find().items[]` (arguments dropped, subscripts marked), `new T`, `as T` (casts) or `?`.
`await`, parentheses, non-null assertions, `?.`, `->`, `::` and Rust's `?` are looked through.

Types are strings the resolver understands:

| encoding | meaning |
|---|---|
| `T` | a named type (after normalization) |
| `T[]` | a collection whose elements are `T` |
| `T{}` | a map (dictionary) whose values are `T` |
| `call:f` | the return type of callable `f`, resolved globally |
| `…#a#b` | member `a`, then member `b`, of the preceding type (crosses files) |
| a `[]` suffix on a part | the element type of that part |
| `!` | members never live in the repository (primitives, builtins) |

`normalizeType` reduces type text per language: optional unions collapse (`Foo | undefined`,
`Optional[Foo]`, `Foo?`), transparent wrappers unwrap (`Promise<T>`, `Box/Rc/Arc/Mutex<T>`,
`Option/Result<T>`, `Task<T>`, `unique_ptr<T>`), collections become `T[]` (`T[]`, `List<T>`,
`Vec<T>`, `[]T`, `list[T]`, `Set<T>` …), maps become `V{}` (`Map<K, V>`, `dict[K, V]`,
`HashMap<K, V>`, `map[K]V` …, also for classes that extend them), and pointers, references,
qualifiers and namespaces are dropped. Generic return types resolve through their bound or default; `Self`/`this` return types
become the enclosing type.

Evidence, in order of trust: explicit annotations; `new`/casts/literal constructions (`Foo{}`,
`Foo { … }`); initializer expressions (evaluated lazily as descriptors); loop variables and
element-wise callback parameters (`for x of xs`, `for x in xs`, `range`, `xs.forEach(x => …)`)
bound to the element type; fields assigned in constructors or declared in the class; declared
return types, or return types inferred when every `return` in a callable agrees. Collection
accessors (`get`, `first`, `at`, `pop` …), map accessors (`get`, `values` …) and identity methods
(`unwrap`, `clone`, `iter`, `lock` …) are handled per language. Members of a primitive or of a collection itself are marked
external (`!`) rather than guessed.

Bindings are keyed by lexical scope — callables, types, and anonymous functions/lambdas/
comprehensions — so same-named locals in sibling callbacks do not collide. Two different bindings
of one name in one scope are a conflict and yield no type (precision over recall).

## 2. Storage

`src/store/db.mjs` (SQLite through `node:sqlite`, WAL, one file in `.graph-indexer/`):

| table | content |
|---|---|
| `files` | path, language, size, mtime, content hash, package, test flag |
| `symbols` | name, qualified name, kind, parent, owner, ranges, signature, doc, type, export/visibility, static, decorators, bases, ordinal |
| `refs` | name, kind, position, enclosing symbol, receiver, receiver type, bound target, confidence, candidate count |
| `imports` | source, imported/local names, re-exports, wildcard, resolved target file/dir |
| `fields` | inferred field types per owner |
| `fts` | FTS5 (contentless, porter) over symbol name, qualified name, signature, doc, path, body |
| `file_fts` | FTS5 over each file's path and tokens (file-level relevance) |

Every fact is owned by one file (the Glean model): re-indexing a file deletes its rows and inserts
new ones. Symbol ids are stable across edits — a re-extracted symbol with the same (qualified name,
kind, ordinal) keeps its id — and ids are never reused (`AUTOINCREMENT`), so references from
untouched files stay valid. The index stores a fingerprint of the extractor, resolver, tokenizer,
schema and grammar builds; when it differs (an upgrade), the index is rebuilt instead of mixing
facts from two extractor versions. A flag records unfinished resolution so an interrupted run is
completed on the next start.

## 3. Indexing and freshness

`Indexer.sync()` reconciles with the working tree: discover files (git `ls-files` including
untracked-but-not-ignored, or a `.gitignore`-aware walk), compare size+mtime, hash only what
changed, parse changed files in batches, write each file in a transaction, then re-resolve:

- references in the files that changed,
- references that pointed at symbols that disappeared,
- references by name that could now bind to newly added symbols (incremental runs only).

`CodeIntel.ensureFresh()` runs before every tool call. With a healthy recursive `fs.watch` it
re-indexes just the dirty paths (plus a sweep every 30 s); without one it does a stat sweep at most
every 3 s. Files a reply is about to quote are re-validated (`stat`) right before rendering. The
MCP server builds the initial index in the background, so the first call never times out; until it
finishes, answers come from the partial index.

## 4. Resolution

`Resolver.resolve(ref)` tries, in order, and labels the result with a confidence
(exact ≥ 0.9, high ≥ 0.7, likely ≥ 0.4, possible):

1. **Receiver-based** (member access): `this`/`self`/`super` → the enclosing type and its bases;
   an inferred receiver type → that type's members (instance members preferred; for an interface
   or abstract receiver a missing member stays unbound rather than guessed); a module/namespace
   import → the target's exports; a type name → static members; a typed module-level value
   (`export const api = new Api()`) → its type's members.
2. **Name-based**: lexical scope → enclosing type → same file → explicit import (following
   barrels and re-exports) → same package/directory → wildcard imports → C/C++ includes → global
   by name (bounded candidate count, never across unrelated languages).
3. Unknown receivers fall back to "any member with that name" with low confidence — except
   property reads, which are too common to guess and stay unbound.

Unresolvable value, read and type references and calls into external code are dropped at index
time; unresolved calls are kept so tools can report how many same-name call sites were not bound.

`ModuleResolver` maps specifiers to files: relative paths with extension/index probing, tsconfig
`paths`/`baseUrl`, workspace packages, Python packages and relative imports, Go module paths to
directories, Rust `crate`/`self`/`super`, C includes, Ruby/Bash/CSS relatives.

## 5. Queries

`src/query/intel.mjs`:

- **Symbol lookup** accepts `name`, `Class.method`, `path/file.ts:Name` and `path/file.ts:42`;
  ambiguous names are ranked by centrality, exportedness and kind, and the alternatives listed.
- **References** include the overload set and, for members, the method family: calls through
  supertypes (they may dispatch here) and to overrides in subtypes, each labelled with the type
  it came through. Production code is listed before tests.
- **Call graph / dependents** walk reverse edges breadth-first with confidence multiplied along
  paths, including calls through supertypes.
- **Change impact** seeds from symbols, files or the uncommitted `git diff`, collects dependents by
  distance, tests that reach them (via the graph and naming conventions), exported surface and git
  co-change counts, and summarizes a risk level.
- **Maps** (`outline` of a directory or the repository) rank symbols by PageRank over the
  reference graph, personalized to a focus query when given (Aider's repo-map idea applied to
  symbols), within a token budget.

## 6. Search

`SearchEngine.search()` (`src/search/search.mjs`) gathers candidates from four channels and
reranks them with a linear model over interpretable features:

1. **Names** — exact, case-insensitive, singular/plural, qualified (`A.b`) and prefix matches.
2. **Lexical** — FTS5 BM25 with field weights (name 10, qualified name 6, signature 3, doc 2,
   path 2.5, body 1) over code-aware tokens (`getUserById` → `getuserbyid get user by id`).
3. **Concepts** — a small thesaurus expands natural-language queries (e.g. *auth* ↔ *login,
   authentication, credentials*); it takes over when literal matches are weak.
4. **Files** — BM25 over whole files; the best-matching symbols of the top files become candidates,
   and a file's relevance lifts its symbols in proportion to their own match.

Features: normalized BM25 and concept scores, name evidence, coverage of the query by the
symbol's name, kind prior, test/example/declaration/nested penalties, export and doc bonuses,
PageRank centrality and file relevance. Weights were selected by coordinate ascent on the tuning
split of the query suites only (`bench/tune-weights.mjs`). Results are diversified to at most
three per file before the rest, and replies show the matching lines of the top results.

## 7. MCP server

`src/mcp/server.mjs` implements JSON-RPC over stdio without an SDK. It negotiates protocol
versions 2024-11-05 through 2025-11-25 and also serves the stateless 2026-07-28 revision
(`server/discover`, per-request `_meta` protocol version, error −32022 for unsupported versions).
Logs go to stderr only. Tools are declared read-only (`readOnlyHint`), with descriptions under
2 KB and short server instructions.

Replies are plain text designed for a model's context: best result first, capped lists with
"N more — narrow with …" hints, code with line numbers and at most `max_lines`, a
confidence tag on anything inferred, and a closing hint for the natural next call.

## 8. Adding a language

1. Add the grammar WASM (gzipped) to `vendor/grammars/` and its entry (repo, tag, SHA-256) to
   `manifest.json`.
2. Write `src/parse/lang/<lang>.mjs`: a query using the captures above and whichever hooks apply
   (`parseImport`, `testFile`, `isPrimitiveType`, `transparentTypes`, `elementTypes`, …).
3. Register it in `src/parse/languages.mjs`; teach `src/index/modules.mjs` its import syntax.
4. Add a fixture test in `test/` — the index fingerprint changes automatically, so existing
   indexes rebuild.

## Known limits

- Type inference is intra-file plus declared types across files; it is not a type checker.
  Contextually typed object literals, generic instantiation and dynamic features (`getattr`,
  reflection, `any`) are not followed.
- Dependency-injection frameworks that wire by string tokens are only partially visible.
- Only the working tree is indexed; other branches and history are used just for co-change hints.
