# No-build, multi-language static analysis and incremental indexing for a local code-intelligence engine (state of the art, September 2026)

*How these notes were gathered:* WebFetch was blocked by the egress proxy for this session, and the shared web-search budget ran out partway through. Primary sources on GitHub were therefore read by shallow/sparse `git clone` of the public repos (docs, READMEs, `.proto`/`.d.ts`/C sources, query files), checked on 2026-09-22. Numbers from academic papers come from search-engine extracts of abstracts or summaries. I did not open the full texts, and I flag this wherever it matters. Links point to the canonical GitHub/paper URLs.

---

## 1. Tree-sitter query-based extraction (tags.scm / locals.scm, GitHub search-based navigation, node-tree-sitter Query API, WASM vs native, grammar packaging)

### Takeaway
Tree-sitter's `tags.scm` convention (`@definition.<kind>` / `@reference.<kind>` + `@name`) plus `locals.scm` (`@local.scope/definition/reference`) is the de-facto no-build extraction layer, used by GitHub's search-based navigation and by Aider. Upstream queries are thin and uneven across graph-indexer's 14 languages. They have no import captures, no receivers, no references at all for C and Swift, no tags at all for Bash and CSS, and `locals.scm` exists only for JS/TS, Ruby and Swift. Expect to ship your own query files. Native node-tree-sitter 0.25.x (N-API, prebuilt binaries) is the right runtime. The current `tree-sitter@0.21.1` pin cannot load the ABI-15 parsers that current grammars generate.

### Cited Findings

**tags.scm convention and tooling**
- Tagging uses a `@role.kind` capture plus an inner `@name` capture. An optional `@doc` capture binds docstrings, and the built-ins `#strip!` (regex removal) and `#select-adjacent!` (keep only doc nodes adjacent to the definition) clean them. Tag queries are expected at `queries/tags.scm` in each grammar repo. The doc says the "notable application of this is GitHub's support for search-based code navigation." — [tree-sitter docs: Code Navigation](https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/4-code-navigation.md)
- The standard vocabulary is `@definition.class`, `@definition.function`, `@definition.interface`, `@definition.method`, `@definition.module`, `@reference.call`, `@reference.class` and `@reference.implementation`. "New applications may extend (or only recognize a subset of) these capture names." `tree-sitter tags <files>` dumps name/role/kind/location/first line/docstring, and tag queries are unit-testable under `test/tags/` with `tree-sitter test`. — [tree-sitter docs: Code Navigation](https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/4-code-navigation.md)
- The reference tagger (Rust `tree-sitter-tags` crate) builds one `Query` from `locals_query + tags_query` concatenated. It accepts captures `@definition.*`, `@reference.*`, `@doc`, `@name`, `@ignore` and `@local.(scope|definition|reference)`. A pattern carrying `(#is-not? local)` sets `name_must_be_non_local`, which drops references whose name resolves to a local definition in an enclosing scope. `local.scope-inherits` controls whether a scope sees its parent's definitions. The tagger checks a cancellation flag every 100 iterations of its match loop (`CANCELLATION_CHECK_INTERVAL = 100`). — [tree-sitter/crates/tags/src/tags.rs](https://github.com/tree-sitter/tree-sitter/blob/master/crates/tags/src/tags.rs)
- Query predicates/directives available to bindings: `#eq?`/`#not-eq?`, `#match?` (with `not-` for negation and `any-` for quantified captures), `#any-of?`, `#is?`/`#is-not?` (property checks, e.g. `local`), and `#set!` (key/value metadata). Tags additionally use `#strip!` and `#select-adjacent!`. — [tree-sitter docs: predicates & directives](https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/using-parsers/queries/3-predicates-and-directives.md)

**locals.scm (scope-aware local resolution)**
- The locals query uses fixed captures: `@local.scope` (a node introduces a scope), `@local.definition` (a node holds a name defined in the current scope) and `@local.reference` (a name that *may* refer to an earlier definition in an enclosing scope). `@ignore` excludes nodes and must come before the tagging patterns. The engine "will keep track of the set of scopes that contains any given position, and the set of definitions within each scope." When it processes a `local.reference`, it "will try to find a definition for a name that matches the node's text." Highlights/tags can then use `(#is-not? local)`. — [tree-sitter docs: Syntax Highlighting → Local Variables](https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/3-syntax-highlighting.md)
- The algorithm is purely lexical name matching within nested scopes. It does no hoisting semantics or type information, and it expects the definition to come earlier in the scope (the docs' Ruby example). — [tree-sitter docs: Syntax Highlighting](https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/3-syntax-highlighting.md)

**Coverage for graph-indexer's 14 languages** (upstream grammar repos at HEAD, cloned 2026-09-22; the counts are capture occurrences in `queries/tags.scm`)

| Language (grammar, version) | tags.scm captures | locals.scm |
|---|---|---|
| Bash (tree-sitter-bash 0.25.1) | **none** (highlights only) | no |
| C (0.24.2) | def.class×2, def.function, def.type×2. **No references** | no |
| C# (0.23.5) | def.class/interface/method/module; ref.class×5, ref.interface, ref.send | no |
| CSS (0.25.0) | **none** | no |
| Go (0.25.0) | def.function×2, def.method×2, def.type; ref.call, ref.type | no |
| Java (0.23.5) | def.class/interface/method; ref.call, ref.class×2, ref.implementation | no |
| JavaScript (0.25.0) | def.class×2, def.constant, def.function×8, def.method×2; ref.call×2, ref.class | **yes** |
| TypeScript (0.23.2) | own: def.class/function/interface/method×2/module; ref.class, ref.type. `tree-sitter.json` composes it with JS `tags.scm` | **yes** |
| Kotlin (fwcd 0.4.0) | def.class×3, def.constant×2, def.function, def.type; ref.call×2, ref.class | no |
| PHP (0.24.2) | def.class/field/function×2/interface×2/module; ref.call×3, ref.class, ref.implementation | no |
| Python (0.25.0) | def.class, def.constant, def.function; ref.call (identifier or `attribute.attribute`) | no |
| Ruby (0.23.1) | def.class×3, def.method×4, def.module; ref.call×2 (uses `#is-not? local`) | **yes** |
| Rust (0.24.2) | def.class×4, def.function, def.interface, def.macro, def.method, def.module; ref.call×3, ref.implementation×2 | no |
| Swift (alex-pinkus 0.7.3) | def.class/function/interface/method×2/property×2. **No references** | **yes** |

- Sources: [tree-sitter-python tags.scm](https://github.com/tree-sitter/tree-sitter-python/blob/master/queries/tags.scm), [tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go/tree/master/queries), [tree-sitter-javascript](https://github.com/tree-sitter/tree-sitter-javascript/tree/master/queries), [tree-sitter-typescript tree-sitter.json](https://github.com/tree-sitter/tree-sitter-typescript/blob/master/tree-sitter.json), [tree-sitter-ruby](https://github.com/tree-sitter/tree-sitter-ruby/tree/master/queries), [tree-sitter-swift](https://github.com/alex-pinkus/tree-sitter-swift/tree/main/queries) and [fwcd/tree-sitter-kotlin](https://github.com/fwcd/tree-sitter-kotlin/tree/main/queries). This is confirmed by the per-language query-availability table (highlights/injections/locals/indents/folds/tags) in [tree-sitter-language-pack README](https://github.com/kreuzberg-dev/tree-sitter-language-pack): Bash ✅/❌/❌/❌/❌/❌, CSS no tags, JS/TS/Ruby/Swift locals ✅, all others locals ❌.
- The upstream Python `tags.scm` is 14 lines: module-level assignment → `@definition.constant`, `class_definition` → class, `function_definition` → function (methods are not distinguished), and `call` with identifier or attribute → `@reference.call`. No import statements are tagged in any grammar (imports are not in the tags vocabulary). — [tree-sitter-python tags.scm](https://github.com/tree-sitter/tree-sitter-python/blob/master/queries/tags.scm)
- `fwcd/tree-sitter-kotlin` (0.4.0) ships tags.scm. The newer `tree-sitter-grammars/tree-sitter-kotlin` (1.1.0) has no top-level `queries/` directory. — [fwcd/tree-sitter-kotlin](https://github.com/fwcd/tree-sitter-kotlin), [tree-sitter-grammars/tree-sitter-kotlin](https://github.com/tree-sitter-grammars/tree-sitter-kotlin)

**How GitHub's search-based navigation works**
- Current GitHub docs: "Code navigation uses the open source tree-sitter library… [GitHub] has developed a code navigation approach based on the open source tree-sitter library that searches all definitions and references across a repository to find entities with a given name." It needs no configuration, "only works for active branches" and "only works for repositories with fewer than 100,000 files." — [GitHub Docs: Navigating code on GitHub](https://github.com/github/docs/blob/main/content/repositories/working-with-files/using-files/navigating-code-on-github.md)
- Supported languages: Bash, C, C#, C++, CodeQL, Elixir, Go, JSX, Java, JavaScript, Lua, PHP, Protocol Buffers, Python, R, Ruby, Rust, Scala, Starlark, Swift, TypeScript. (Kotlin and CSS are absent.) — [GitHub Docs reusable: code-nav-supported-languages](https://github.com/github/docs/blob/main/data/reusables/search/code-nav-supported-languages.md)
- Earlier, GitHub described two modes. "Precise" navigation used stack graphs for Python and "resolves definitions and references based on classes, functions, and imported definitions at a given point". "Search-based" navigation "searches all definitions and references across a repository to find entities with a given name", which previously showed "all definitions in a repository with that name, resulting in noise" for common names. — [GitHub blog: Precise code navigation for Python](https://github.blog/news-insights/product-news/precise-code-navigation-python-code-navigation-pull-requests/) (search extract)

**Aider's production use of tags (repo map)**
- Aider ships tags queries for about 30 languages in two sets (`tree-sitter-language-pack/` and `tree-sitter-languages/`) adapted from the language-pack sources. It converts captures to `def`/`ref` tags. When a file yields defs but no refs ("Some tags files only provide defs (cpp, for example)"), it backfills refs from Pygments `Token.Name` tokens. — [aider/repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py), [aider/queries](https://github.com/Aider-AI/aider/tree/main/aider/queries)
- Ranking is PageRank over a file graph with referencer→definer edges weighted by identifier heuristics: ×10 if the identifier was mentioned in chat; ×10 if it is snake/kebab/camel case and ≥8 chars; ×0.1 if it starts with `_`; ×0.1 if it is defined in more than 5 files; ×50 if the referencer is a chat file; the reference count is dampened with `sqrt`. PageRank is personalized toward chat/mentioned files. — [aider/repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)

**node-tree-sitter API, versions and performance knobs**
- The latest `tree-sitter` (node) tag is **v0.25.1**; the latest core tag is **v0.27.0** (`git ls-remote`, 2026-09-22). The node package uses `node-addon-api` + `node-gyp-build` and ships `prebuilds/*` built with `prebuildify --napi --strip`, so it installs without a compiler on supported platforms. — [node-tree-sitter package.json](https://github.com/tree-sitter/node-tree-sitter/blob/master/package.json)
- Query API (`tree-sitter.d.ts`): `new Query(language, source)` ("References to Queries can be shared between multiple threads"). `query.matches(node, opts)` returns `{pattern, captures[{name,node}]}`; `query.captures(node, opts)` returns a flat ordered capture list. Options: `startPosition/endPosition/startIndex/endIndex` (restrict to a range), `matchLimit` (max in-progress matches, 1–65536), `maxStartDepth`, `progressCallback` (return true to abort), and the deprecated `timeoutMicros`. Other members: `disableCapture(name)`, `disablePattern(i)`, `didExceedMatchLimit()`, `isPatternRooted/NonLocal/GuaranteedAtStep`. — [node-tree-sitter tree-sitter.d.ts](https://github.com/tree-sitter/node-tree-sitter/blob/master/tree-sitter.d.ts)
- Incremental reparse: call `tree.edit({startIndex, oldEndIndex, newEndIndex, startPosition, oldEndPosition, newEndPosition})` and then `parser.parse(newSource, oldTree)` ("much faster than the first parse"). `parse` also accepts a callback `(index, position) => string` for ropes and line arrays. — [node-tree-sitter README](https://github.com/tree-sitter/node-tree-sitter/blob/master/README.md). Core docs: nodes held outside the tree need `ts_node_edit`. Tree-sitter aims to be "fast enough to parse on every keystroke in a text editor". — [advanced parsing](https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/using-parsers/3-advanced-parsing.md), [docs index](https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/index.md)
- ABI compatibility: tree-sitter 0.20.3–0.24 loads parser ABI 13–14; **≥0.25 loads 13–15**. — [ABI versions doc](https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/using-parsers/7-abi-versions.md). Current `tree-sitter-python` and `tree-sitter-go` HEAD `src/parser.c` have `#define LANGUAGE_VERSION 15`. — [tree-sitter-python parser.c](https://github.com/tree-sitter/tree-sitter-python/blob/master/src/parser.c)
- graph-indexer pins `tree-sitter` 0.21.1 with grammar devDependencies from 0.21.x to 0.25.x. `parse/extractor.mjs` already runs `new Query(parser.getLanguage(), LANGUAGE_QUERIES[langKey]).matches(rootNode)` with hand-written queries. The watcher uses chokidar 5.0.0 with `awaitWriteFinish {stabilityThreshold: 300}`. — local [package.json](../../package.json), [parse/extractor.mjs](../../parse/extractor.mjs), [watch-daemon.mjs](../../watch-daemon.mjs)

**web-tree-sitter (WASM) vs native**
- web-tree-sitter README: "executing `.wasm` files in Node.js is considerably slower than running Node.js bindings." web-tree-sitter ≥0.25 supports parser ABI 13–15. Also: "Some prebuilt `.wasm` files use an older dynamic-linking format that newer versions of `web-tree-sitter` cannot load, even if their parser ABI is supported." Since v0.26.1, `tree-sitter build --wasm` uses wasi-sdk (auto-downloaded). The binding in the repo HEAD is versioned 0.28.0. — [web-tree-sitter README](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md), [binding_web/package.json](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/package.json)
- Pulsar editor (which moved to web-tree-sitter): "the performance penalty between web-tree-sitter and node-tree-sitter bindings is small enough that most users won't notice", but "migrating back to node-tree-sitter would surely improve parsing and querying speed". The `.wasm` files "make distribution easier as they don't have to be built for the user's architecture, nor rebuilt when the version of Electron changes." — [Pulsar blog, Modern Tree-sitter part 7](https://blog.pulsar-edit.dev/posts/20240902-savetheclocktower-modern-tree-sitter-part-7/) (search extract). This partly **conflicts** with the web-tree-sitter README's "considerably slower". Neither source gives numbers.

**Grammar packaging**
- `tree-sitter-wasms` (npm 0.1.13): prebuilt WASM grammars, forked from Menci's prebuilt set. Last commit 2025-10-07. Given the dynamic-linking warning above, stale `.wasm` builds are a compatibility risk. — [Gregoor/tree-sitter-wasms](https://github.com/Gregoor/tree-sitter-wasms)
- tree-sitter-language-pack (actively maintained, last commit 2026-09-19): "371 languages", "Pre-compiled parsers at ABI 14 (backwards compatible with tree-sitter 0.21–0.26)", Node package `@xberg-io/tree-sitter-language-pack` plus a `-wasm` variant, "On-demand downloads" of parsers cached locally, `prefetch()`, and an MCP server. — [tree-sitter-language-pack README](https://github.com/kreuzberg-dev/tree-sitter-language-pack)

### Inferences
- The cheapest path from hand-written per-language extraction to data-driven extraction is to adopt the tags vocabulary, keep one `queries/<lang>/tags.scm` + `locals.scm` per language in-repo (seeded from upstream and from Aider's richer variants), and extend it with custom captures that the standard lacks: `@import.module`, `@import.name`, `@import.alias`, `@reference.call.receiver`, `@definition.method.class`, `@inherits.base`, `@assign.ctor` (for `x = new Foo()` / `x = Foo()`). Run them through a single generic `QueryCursor` loop in the same way the `tree-sitter-tags` crate concatenates locals + tags. Test them with `tree-sitter test` `test/tags/` fixtures.
- Because only 4 of the 14 languages have upstream `locals.scm`, local-variable suppression (the `#is-not? local` trick that removes false call/reference edges to shadowed names) needs custom locals queries for Python, Go, Java, C#, Kotlin, PHP, Rust, C and Bash. These are short (scope nodes + parameter/assignment definitions).
- Upgrading to node-tree-sitter 0.25.x is a prerequisite for current grammars (ABI 15). Otherwise the project stays frozen on 2024-era grammars. WASM only makes sense as a fallback for platforms without prebuilds. The distribution benefit is real, but both primary sources concede it is slower.
- Performance: restrict queries by byte range (`startIndex/endIndex`) on incremental reparses (only re-run tags on changed ranges or the containing top-level declarations), use `disableCapture` for unused captures, and set a `matchLimit`/`progressCallback` guard for pathological files.

### Gaps
- I found no published precision/recall for GitHub's search-based navigation or for tags-based "find references". The current GitHub docs page no longer mentions "precise" navigation. I could not confirm whether GitHub formally retired stack-graphs-based Python navigation (see §2).
- I found no reliable 2025–2026 microbenchmarks with numbers comparing node-tree-sitter vs web-tree-sitter parse/query throughput. Only qualitative, partly conflicting statements exist. Recommend benchmarking locally (parse + tags query on a 1M-LOC corpus).
- No numbers found on Query execution cost vs manual tree walks in Node (the N-API crossing cost per capture is plausibly the dominant factor; unverified).

---

## 2. Stack graphs, SCIP/LSIF, Kythe, Glean and universal-ctags

### Takeaway
Stack graphs is the only mature no-build, file-incremental precise name-resolution design, but GitHub archived it on 2025-09-09 ("no longer supported or updated by GitHub"). It only ever had rule sets for Java, JavaScript, Python and TypeScript. Treat it as a design to borrow from (per-file partial paths stitched at query time, stored in SQLite), not as a dependency. SCIP is the living interchange format for build-based precise data, with active indexers for TS/JS, Java/Kotlin/Scala, Go, Rust, C/C++, Ruby, C# and Python (scip-python looks stale). Its `Occurrence` + `symbol_roles` + `enclosing_range` model maps cleanly onto an optional "precision upgrade" import path. Glean contributes the ownership/unit model for incremental invalidation. Kythe shows the call-graph schema (anchors with `ref/call` + `childof`). universal-ctags' reference support is still limited.

### Cited Findings

**Stack graphs**
- README banner: "**NOTE:** This repository is no longer supported or updated by GitHub. If you wish to continue to develop this code yourself, we recommend you fork it." Stack graphs "allow you to define the name resolution rules for an arbitrary programming language in a way that is efficient, incremental, and does not need to tap into existing build or program analysis tools." The last commit is 2025-09-09. — [github/stack-graphs](https://github.com/github/stack-graphs). The repo was "archived by the owner on September 9, 2025" and is read-only. — [github/stack-graphs (search extract)](https://github.com/github/stack-graphs)
- The only language rule crates are `tree-sitter-stack-graphs-java` 0.5.0, `-javascript` 0.3.0, `-python` 0.3.0 and `-typescript` 0.4.0. — [stack-graphs/languages](https://github.com/github/stack-graphs/tree/main/languages)
- Design: definitions and references are graph nodes, and a binding is a path. Path finding tracks a *symbol stack* (what we are resolving) and a *scope stack* (where to look). Incrementality comes from pausing the resolution of `foo` in `A.foo` while resolving `A` (a stack), so "each 'chunk' of the overall graph only depends on 'local' information from the original source file." The design is based on TU Delft scope graphs. — [stack-graphs/src/lib.rs docs](https://github.com/github/stack-graphs/blob/main/stack-graphs/src/lib.rs)
- The EVCS 2023 paper says stack graphs power Precise Code Navigation at GitHub. Graph construction and path finding were made file-incremental ("for each source file, an isolated subgraph is created"), with graphs built "via purely syntactic analysis… using a declarative graph construction language, … without per-package configuration or invoking untrusted build processes". Stack graphs have been in production since November 2021, analyzing every commit to every public and private Python repository on GitHub. — [Creager & van Antwerpen, "Stack graphs: Name resolution at scale" (arXiv 2211.01224)](https://arxiv.org/abs/2211.01224), [Dagstuhl OASIcs EVCS 2023](https://drops.dagstuhl.de/entities/document/10.4230/OASIcs.EVCS.2023.8) (search extracts)
- The storage layer uses SQLite via `rusqlite` (`stack-graphs/src/storage.rs`), and the `tree-sitter-stack-graphs` CLI workflow is "index source code and issue queries against the resulting database". — [stack-graphs storage.rs](https://github.com/github/stack-graphs/blob/main/stack-graphs/src/storage.rs), [tree-sitter-stack-graphs README](https://github.com/github/stack-graphs/blob/main/tree-sitter-stack-graphs/README.md)
- No precision/recall numbers vs search-based navigation were found in the search results. — [GitHub blog (search extract)](https://github.blog/news-insights/product-news/precise-code-navigation-python-code-navigation-pull-requests/)

**SCIP (and LSIF)**
- SCIP is "a language-agnostic protocol for indexing source code" (Protobuf schema, Go/Rust bindings, generated TS/Haskell bindings, `scip` CLI). The README now links to `github.com/scip-code/scip` and `scip-code.org`. Listed indexers: scip-java (Java, Scala, Kotlin), scip-typescript (TS, JS), rust-analyzer (Rust), scip-clang (C++, C), scip-ruby, scip-python, scip-dotnet (C#, VB), scip-dart, scip-php. — [sourcegraph/scip README](https://github.com/sourcegraph/scip/blob/main/README.md)
- Design: SCIP "is meant to be a *transmission* format… not… a *storage* format for querying". Sourcegraph "ran into issues of development velocity, debugging, as well as indexer performance bottlenecks" with LSIF, and "LSIF support has since been fully deprecated and removed". Goals include "Adding file-level incrementality should be easy" and parallel indexers. It avoids LSIF-style integer IDs because "With LSIF, we've had off-by-one bugs in indexers cause code navigation to fail repo-wide". "SCIP data tends to have a compression ratio around… 10%-20%". — [SCIP DESIGN.md](https://github.com/sourcegraph/scip/blob/main/docs/DESIGN.md)
- `Occurrence` fields:
  - The deprecated `range` is a half-open `[startLine, startChar, endChar]` (3 ints, single-line) or `[startLine, startChar, endLine, endChar]` (4 ints). The new typed `single_line_range` / `multi_line_range` oneof takes precedence; its size overhead is "single-digit percent".
  - `symbol` (string).
  - `symbol_roles` bitset: Definition 0x1, Import 0x2, WriteAccess 0x4, ReadAccess 0x8, Generated 0x10, Test 0x20, ForwardDefinition 0x40.
  - `enclosing_range`: the "nearest non-trivial enclosing AST node", explicitly meant for "Call hierarchies: to determine what symbols are referenced from the body of a function". For definitions it spans the whole definition including docs and decorators.
  - `PositionEncoding` states whether `character` counts UTF-8, UTF-16 or UTF-32 code units.
  
  — [scip.proto](https://github.com/sourcegraph/scip/blob/main/scip.proto)
- Indexer requirements and activity (last commit dates from clones on 2026-09-22):
  - **scip-typescript** needs `npm/yarn/pnpm install` and a `tsconfig.json` (or `--infer-tsconfig`), and has an OOM section. Last commit 2026-09-11, tag v0.4.0. — [scip-typescript](https://github.com/sourcegraph/scip-typescript)
  - **scip-python** is a "Sourcegraph fork of pyright", with a suggested 8 GB heap for OOM. Last commit **2025-09-05** (about a year idle), tag v0.6.6. — [scip-python](https://github.com/sourcegraph/scip-python)
  - **scip-java**: "Java and Kotlin indexer" (status badge "development"). Last commit 2026-09-18. — [scip-java](https://github.com/sourcegraph/scip-java)
  - **scip-go**: supports other build systems via the Go packages driver. Last commit 2026-09-17. — [scip-go](https://github.com/sourcegraph/scip-go)
  - **scip-clang** (Beta) requires `compile_commands.json`, does not support precompiled headers, and "2GB RAM per core is generally sufficient". Last commit 2026-03-24. — [scip-clang](https://github.com/sourcegraph/scip-clang)
  - scip-ruby: last commit 2026-09-03. scip-dotnet: last commit 2026-05-27. — [scip-ruby](https://github.com/sourcegraph/scip-ruby), [scip-dotnet](https://github.com/sourcegraph/scip-dotnet)

**Kythe**
- Kythe is a "hub" of "language-agnostic protocols and data formats" that reduces integration cost from O(L×C×B) to O(L+C+B). It grew out of Google's internal cross-reference index. — [Kythe overview](https://github.com/kythe/kythe/blob/master/kythe/docs/kythe-overview.txt)
- It is build-dependent: Kythe "captures a record of each compilation that is to be indexed" into `.kzip` compilation archives. — [kzip spec](https://github.com/kythe/kythe/blob/master/kythe/docs/kythe-kzip.txt)
- Call-graph schema: a call-site anchor has a `ref/call` edge to the callee and a `childof` edge that "blame[s]" the enclosing caller. "These queries will not capture the full set of traditional callsites": consumers must also follow `completedby` edges (forward declarations) and consider overrides. — [Kythe schema: callgraph](https://github.com/kythe/kythe/blob/master/kythe/docs/schema/callgraph.txt)

**Glean (Meta)**
- Glean stores "facts about source code" and answers queries such as "Where are all the callers of this function?" through the Angle query language. — [Glean introduction](https://github.com/facebookincubator/Glean/blob/main/glean/website/docs/introduction.md)
- Derived predicates are "stored" (materialized) or "on demand", defined as Angle queries. — [Glean derived predicates](https://github.com/facebookincubator/Glean/blob/main/glean/website/docs/derived.md)
- Incrementality:
  - Every fact is owned by *units* (arbitrary strings, e.g. files).
  - Owners are *ownership sets* (`unit | A || B | A && B`). A fact referenced by a fact with owner A gets owner `A || B`, so that "every fact referenced by a visible fact is also visible" (no dangling references) when units are excluded.
  - Derived facts get conjunctive owners ("visible if and only if all the facts that it was derived from are visible").
  - Propagation is O(facts) time and space, and incremental DBs are *stacked* on a base DB.
  
  — [Glean incrementality](https://github.com/facebookincubator/Glean/blob/main/glean/website/docs/implementation/incrementality.md)

**universal-ctags**
- "A tag is categorized into *definition tags* or *reference tags*… support for generating reference tags is new and limited to specific areas of specific languages". Roles are "not implemented widely yet". — [ctags(1) man page](https://github.com/universal-ctags/ctags/blob/master/docs/man/ctags.1.rst)

### Inferences
- Borrow the stack-graphs architecture without the dependency: per-file extraction produces a self-contained "file fragment": definitions, exports, imports (as pending symbol paths), references (as symbol stacks such as `["A","foo"]`) and scopes. Cross-file resolution happens lazily at query time by "stitching" fragments through the import table. Only a file's own fragment is recomputed on change. This is the property graph-indexer needs for always-fresh updates.
- Implement SCIP ingestion as an optional accuracy tier. The repo already has `parse/scip.mjs`. When a `index.scip` exists (CI or user-run), it overrides heuristic edges for that file. Derive caller→callee edges by assigning each non-definition occurrence to the innermost definition occurrence whose `enclosing_range` contains it (the proto names this use case). Respect `PositionEncoding` when mapping to tree-sitter byte/UTF-16 offsets.
- Adopt the Glean ownership rule directly in SQLite. Every row carries `file_id`. Cross-file derived rows (resolved edges) carry both endpoints' file_ids and are deleted when *either* changes (the conjunction rule). This gives O(changed-file rows) invalidation with no dangling edges.

### Gaps
- There is no quantitative precision comparison of stack graphs vs search-based navigation in the accessible sources.
- I could not confirm whether GitHub still serves precise Python navigation. The repo is archived and the current docs describe only the search-based approach, which suggests but does not prove retirement.
- rust-analyzer's `scip` subcommand docs were not retrievable in my sparse clone. Only the SCIP README lists rust-analyzer as an emitter.
- Glean/Kythe performance numbers (index size, update latency) were not retrieved.

---

## 3. Heuristic name resolution quality vs precise call graphs, and cheap improvements

### Takeaway
Across Python and JavaScript, the literature shows that lightweight, unsound-by-design analyses built on name/field-based resolution plus intra-/inter-procedural assignment flow reach roughly 80–99% precision and roughly 70–90% recall against dynamic or manual ground truth: PyCG ~99%/70%, ACG >80%/>80%, HeaderGen ~95%/95%, Jelly 76→88% recall. Even sound-ish Java analyses miss ~12% of real edges (median recall 0.884). The measured "cheap wins" are, in order: assignment/flow tracking (PyCG→JARVIS: +84% precision, ≥+20% recall), handling dynamic property/initialization idioms (+12.2 pts recall in Jelly), and dampening ambiguous names (Aider down-weights names defined in more than 5 files). I found no study that directly measures a tree-sitter name-only call graph. That gap should be closed with a local benchmark.

### Cited Findings

**Python**
- PyCG (ICSE 2021) builds an assignment graph and handles modules, generators, closures and multiple inheritance. It achieves "precision ~99.2%, and adequate recall ~69.9%" on its micro-benchmark, and is fast ("0.38 seconds for 1k LoC on average"). Missing edges come from unsupported features. — [PyCG, arXiv 2103.00587](https://arxiv.org/abs/2103.00587) (search extract). PyCG, Pyan and Depends use ~61.2, ~36.3 and ~22 MB of memory respectively. Pyan has "average precision and low recall because it does not track the inter-procedural flow of functions". — [PyCG paper (search extract)](https://arxiv.org/pdf/2103.00587)
- **PyCG is archived** ("no further development improvements are planned"). Last commit 2023-11-26. — [vitsalis/PyCG README](https://github.com/vitsalis/PyCG)
- JARVIS (application-centered, demand-driven, flow-sensitive intra-procedural analysis with per-function assignment graphs) "improves PyCG by 84% in precision and at least 20% in recall". Reported recall is 0.82 / 0.66 in two scenarios (about +8% over PyCG in both). It adds built-ins and control-flow handling that PyCG misses. — [JARVIS, arXiv 2305.05949](https://arxiv.org/abs/2305.05949), [pythonjarvis.github.io](https://pythonjarvis.github.io/) (search extracts)
- HeaderGen (flow-sensitive extension of PyCG for notebooks) reports "95.6% precision and 95.3% recall on real-world notebooks". The benchmark lineage is PyCG's 112 micro-tests; Jarvis added 23 more. — [HeaderGen, EMSE 2024](https://link.springer.com/article/10.1007/s10664-024-10525-w), [LLM call-graph study (EMSE 2025)](https://link.springer.com/article/10.1007/s10664-025-10704-3) (search extracts)

**JavaScript / TypeScript**
- ACG, the field-based approximate call graph of Feldthaus, Schäfer, Sridharan, Dolby and Tip (ICSE 2013), treats each property name as a single global abstract location, ignores dynamic property accesses, and is "in principle unsound" but "highly accurate in practice". It has pessimistic (limited inter-procedural flow) and optimistic (full) variants. — [ICSE 2013 paper](https://www.franktip.org/pubs/icse2013approximate.pdf), [IEEE Xplore](https://ieeexplore.ieee.org/document/6606621/). A later summary reports that "both precision and recall were typically above 80%" on the call-site-targets metric, with lower recall on stricter metrics (especially pessimistic), and that ">70% of call sites have at most one target, 80% at most two and 90% at most three." — [Antal et al., arXiv 2405.07206 HTML](https://arxiv.org/html/2405.07206v1) (secondary, search extract)
- Antal et al. (SCAM 2018) compared npm callgraph, WALA, Closure Compiler, ACG and TAJS. "ACG had the highest precision followed immediately by TAJS", and ACG and TAJS together "covered 99% of the found true edges… while maintaining a precision as high as 98%." — [arXiv 2405.07206](https://arxiv.org/abs/2405.07206)
- Their follow-up (IEEE Access 2023, 941 manually validated edges) found that on benchmarks TAJS found 93% of all edges at 97% precision. On real-world Node.js modules, static tools "struggle with parsing the code and fail to detect a significant amount of call edges". — [Is JavaScript Call Graph Extraction Solved Yet?](https://ieeexplore.ieee.org/document/10066273/) (search extract)
- Jelly (Laursen & Møller, PLDI 2024) uses approximate interpretation: "For 36 JavaScript projects… average analysis recall is improved from 75.9% to 88.1% with a negligible reduction in precision". It yields 55.1% more call edges and 17.7% more resolved call sites. — [Reducing Static Analysis Unsoundness with Approximate Interpretation](https://dl.acm.org/doi/10.1145/3656424) (search extract). Jelly builds on JAM, TAPIR and ACG, supports TypeScript (compiled), and can compare static vs dynamic call graphs for precision/recall. Last commit 2026-08-11. — [cs-au-dk/jelly README](https://github.com/cs-au-dk/jelly)

**Java / JVM**
- Sui, Dietrich, Tahir and Fourtounis (ICSE 2020) measured the recall of static call graph algorithms on 31 real Java programs against dynamic oracles, and investigated which dynamic features cause false negatives. — [On the Recall of Static Call Graph Construction in Practice](https://dl.acm.org/doi/10.1145/3377811.3380441)
- Helm et al. (ISSTA 2024): "The median recall is 0.884", and state-of-the-art dynamic-feature support raises it to a median of 0.935 "but it comes with a hefty performance penalty". The main unsoundness sources are "objects allocated or accessed via native methods, and invocations initiated by the JVM", not reflection. — [Total Recall? How Good Are Static Call Graphs Really?](https://dl.acm.org/doi/10.1145/3650212.3652114), [PDF](https://www.opal-project.de/articles/TotalRecall@ISSTA24.pdf) (search extracts)

**Go (CHA / RTA / VTA)**
- `golang.org/x/tools` callgraph offers `static` (static calls only, unsound), CHA, RTA and VTA, "ordered by increasing precision… and thus also computational cost".
  - CHA "conservatively computes the entire 'implements' relation" and "is sound to run on partial programs, such as libraries".
  - RTA "requires a whole program (main or test)".
  - VTA refines an initial call graph via type flow.
  
  — [cmd/callgraph](https://github.com/golang/tools/blob/master/cmd/callgraph/main.go), [cha](https://pkg.go.dev/golang.org/x/tools/go/callgraph/cha), [rta](https://pkg.go.dev/golang.org/x/tools/go/callgraph/rta), [vta](https://pkg.go.dev/golang.org/x/tools/go/callgraph/vta) (search extracts)

**Tree-sitter-based engines for agents (2026)**
- Codebase-Memory (arXiv, 28 Mar 2026) is a tree-sitter knowledge graph over MCP for 66 languages, with call-graph traversal, impact analysis and community detection. On 31 repos it reports "83% answer quality versus 92% for a file-exploration agent, at ten times fewer tokens". No call-edge precision/recall was reported in the extract. — [arXiv 2603.27277](https://arxiv.org/abs/2603.27277)

### Inferences
- ACG's success is direct evidence that *name-based method resolution* (a property/method name is a global location) is acceptable when combined with precise resolution of *free identifiers* (locals → module scope → imports) and simple function-value flow. A tiered resolver for graph-indexer, with a confidence stored per edge and `find_references` ranking by tier:
  1. Local scope (locals.scm).
  2. Same-file top-level definition.
  3. Explicit import binding (named, aliased or module-qualified `mod.f`), resolved through a per-language module resolver (TS `paths`/`index.ts`, Python packages/`__init__`, Go package dir, Java package + imports, Rust `mod`/`use`).
  4. Receiver typed via constructor assignment, annotation, `self`/`this` or a parameter type hint, then CHA over the class hierarchy (subclasses overriding the name).
  5. Globally unique name.
  6. Ambiguous name: fan-out capped at k (e.g. ≤3, mirroring ACG's ">90% of call sites have ≤3 targets"), marked low confidence.
- Aider's ×0.1 weight for identifiers defined in more than 5 files is a cheap, validated-in-practice ambiguity damper. Use the same idea to suppress edges for very common method names (`get`, `run`, `init`, `toString`).
- Expect the precision of a heuristic engine to fall mainly on dynamic dispatch (interfaces, duck typing, callbacks) and recall to fall on higher-order functions, decorators, DI frameworks and reflection. The Java "Total Recall" finding (JVM-initiated calls and natives) suggests adding framework entry-point conventions (routes, test methods, `main`) as synthetic callers rather than chasing full soundness.

### Gaps
- I found **no peer-reviewed measurement of a tree-sitter/tags-only call graph** (name-only vs import-aware vs receiver-typed) across languages. A search extract claimed "name matching-based call graphs show the lowest recall, with a minimum of just 5.4%". I could not attribute it to a specific paper, and it is counter-intuitive (name matching usually over-approximates), so treat it as **unverified**.
- There are no measured precision/recall numbers for GitHub's search-based navigation or for stack graphs.
- Exact per-benchmark numbers from the ACG paper (ICSE 2013) and STARTS/Ekstazi were not verifiable because the PDFs could not be opened.
- Recommendation: build a small in-repo benchmark. Use dynamic call traces (e.g. Node `--cpu-prof`/V8 coverage, Python `sys.setprofile`) or SCIP output from scip-typescript/scip-java/scip-go as ground truth, and measure each resolution tier.

---

## 4. Change impact analysis (static vs evolutionary coupling) and regression test selection / test-to-code traceability

### Takeaway
Static transitive-caller impact and co-change (evolutionary) coupling are complementary. ROSE-style association rules alone give roughly 30% precision / 34% recall per navigation suggestion, but a correct location lands in the top 3 more than 70% of the time. Combining coupling sources measurably raises recall (e.g. 51–58% → 70% on Apache httpd at cut-point 30), at a small precision cost. For test selection, file- and class-level dependency methods (Ekstazi/STARTS) cut suites by about 68–84% with small safety violations. Meta's learned selection halves test cost while catching over 99.9% of faulty changes. Naming-convention test mapping is almost perfectly precise but low-recall, and multi-signal ensembles (TCTracer) reach 85–92% MAP.

### Cited Findings
- **ROSE** (Zimmermann et al., TSE 2005), association rules mined from co-changes:
  - Navigation scenario: "recall of 0.34… precision of 0.30".
  - "ROSE's topmost three suggestions contained a correct location with a likelihood of more than 70 percent".
  - Closure/"erroneous change" scenario precision "usually around 0.98".
  
  — [Mining Version Histories to Guide Software Changes](https://thomas-zimmermann.com/publications/files/zimmermann-tse-2005.pdf) (search extract)
- **Blending couplings** (Kagdi, Gethers, Poshyvanyk, WCRE 2010): combining conceptual (IR) and evolutionary coupling gives "statistically significant improvements… recall values of up to 20% over the conceptual technique in KOffice and up to 45% over the evolutionary technique in iBatis". For Apache httpd at cut point 30, "conceptual and evolutionary couplings yielded recall values of 58% and 51%… the combination… increased recall to 70%." — [WCRE 2010 paper](https://www.cs.wm.edu/~dposhyvanyk/pubs/wcre2010-semplusevol-IA-camera.pdf) (search extract)
- **Integrated impact analysis** (Gethers et al., ICSE 2012): IR + dynamic + evolutionary coupling together "supersedes others to estimate the impact set". — [ICSE 2012 paper](https://www.cs.wm.edu/~denys/pubs/ICSE12-ImpactAnalysis.pdf) (search extract). Stochastic/evolutionary dependencies "improve recall… at the cost of slightly decreased precision". — [Wong & Cai, ASE 2011](https://www.cs.drexel.edu/~yc349/papers/2011/ASE2011.pdf) (search extract)
- **Regression test selection:**
  - Ekstazi is dynamic RTS that records per-test *file* dependencies with checksums and selects tests whose dependencies changed. Class-level granularity "provides better results than… method-level". — [Gligoric et al., ISSTA 2015](https://users.ece.utexas.edu/~gligoric/papers/GligoricETAL15Ekstazi.pdf) (search extract)
  - STARTS is the static class-level counterpart. — [STARTS](https://www.researchgate.net/publication/321260915_STARTS_STAtic_regression_test_selection)
  - A comparative study reported average suite reduction of 68.28% (STARTS) vs 84.05% (Ekstazi), and an average safety violation of 3.19% for STARTS relative to Ekstazi (5.94% in another comparison). — [CEUR-WS case study](https://ceur-ws.org/Vol-2201/UYMS_YTM_2018_paper_87.pdf), [ScienceDirect (PKRTS)](https://www.sciencedirect.com/science/article/pii/S1571066120300402) (search extract; which number came from which paper is **not verified**)
- **Meta Predictive Test Selection** (ML over historical outcomes + dependency-graph features) "reduces the total infrastructure cost of testing code changes by a factor of two, while guaranteeing that over 95% of individual test failures and over 99.9% of faulty changes are still reported". — [Machalica et al., arXiv 1810.05286](https://arxiv.org/abs/1810.05286), [Engineering at Meta](https://engineering.fb.com/2018/11/21/developer-tools/predictive-test-selection/)
- **Test-to-code traceability:**
  - Naming Conventions (NC) links a test to the function whose name equals the test name with "test" removed. NCC relaxes this to "contains". NC "has a precision of 100%" but "low recall".
  - TCTracer (an ensemble of static + dynamic techniques at the function and class levels) reaches MAP 85% for test→function and 92% for test-class→class links.
  
  — [TCTracer, EMSE 2022](https://discovery.ucl.ac.uk/10145439/1/f5f2e040-a6b9-4f07-a0b9-de73b6d60d76.pdf), [White et al., ICSE 2020](http://www0.cs.ucl.ac.uk/staff/jkrinke/publications/icse20.pdf) (search extracts)

### Inferences
- A practical `impact_of(change)` for graph-indexer:
  1. Changed symbols come from a diff of per-file symbol tables before and after the change (not line diffs).
  2. Static impact = reverse call/reference BFS with per-hop decay × edge confidence (tiers from §3), capped at depth 3–4.
  3. Evolutionary impact = file-level (optionally symbol-level) co-change rules from `git log --name-only` with support ≥2 and confidence ≥0.3, filtered to exclude mega-commits (e.g. more than 30 files).
  4. Final score is a weighted union. Report both ranked lists, since the literature shows they catch different things.
- Test mapping as a cascade:
  1. Naming convention: `foo.ts` ↔ `foo.test.ts`/`foo.spec.ts`, `test_foo.py`, `FooTest.java`, `foo_test.go`. This is near-100% precision.
  2. Import/reference edges from test files to changed files (STARTS-like static class/file level).
  3. Transitive reachability from test functions through the call graph.
  4. Co-change between test files and source files.
  
  Present these as "must run" (1–2) vs "likely relevant" (3–4).

### Gaps
- No verified numbers for Ekstazi's end-to-end time savings or STARTS' exact selection rates (papers not openable).
- Hassan & Holt (ICSM 2004) co-change heuristics and TARMAQ-style rule mining were not retrieved (search budget exhausted).
- No study found that measures impact analysis precision/recall specifically on tree-sitter/heuristic call graphs.

---

## 5. Incremental and always-fresh indexing (hashing/Merkle trees, git change detection, watcher pitfalls, stat-before-serve, tree-sitter edits, salsa-style incrementality, trigram/Zoekt vs ripgrep scanning)

### Takeaway
"Always fresh" is best achieved by making correctness independent of the watcher. Keep git-style per-file stat signatures (mtime/ctime/size/inode, with racy-timestamp protection) plus content hashes. Re-validate lazily ("stat before serve") for the files a query touches. Use the watcher (or `@parcel/watcher` snapshots, git fsmonitor/untracked cache) only as an accelerator. A Merkle tree over directory hashes gives O(changed) sync. A salsa-style "early cutoff" (a file's *interface hash* unchanged means dependents are not re-resolved) keeps updates cheap. At ≤1M LOC a trigram index is not needed for latency: ripgrep scans the whole Linux kernel tree in about 0.08 s warm. Zoekt-style positional trigrams cost about 3–3.5× corpus size.

### Cited Findings

**Content hashing / Merkle trees (Cursor)**
- Cursor builds "a Merkle tree… a cryptographic hash of every file, along with hashes of each folder that are based on the hashes of its children". On sync it "walks only the branches where hashes differ". For index reuse, it "computes the Merkle tree and derives a simhash", finds the most similar existing team index, and uses "Merkle tree content proofs" to avoid leaking content. "For median repos, time to first query drops from 7.87 seconds to 525 milliseconds." — [Cursor blog: Securely indexing large codebases](https://cursor.com/blog/secure-codebase-indexing) (search extract)
- A secondary write-up says Cursor checks for hash mismatches every 10 minutes and uploads only changed files. — [Engineer's Codex: How Cursor Indexes Codebases Fast](https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast) (search extract; secondary)

**Git-based change detection (index stat cache, racy git, untracked cache, fsmonitor)**
- Git's index caches `lstat(2)` data so modified files can be detected "without even looking at their contents". It compares file type/exec bits, `st_mtime`, `st_ctime`, `st_uid`, `st_gid`, `st_ino` and `st_size` (nanoseconds only with `USE_NSEC`).
- **Racy git**: if a file is modified again within the same timestamp granularity after indexing, the stat data still matches. Git mitigates this by content-comparing entries whose `st_mtime` is the same as or newer than the index file's own timestamp ("racily clean").

  — [git racy-git.adoc](https://github.com/git/git/blob/master/Documentation/technical/racy-git.adoc)
- The untracked cache records directory mtimes to skip `readdir`/stat of unchanged directories. It requires the filesystem to update directory `st_mtime` on add/modify/delete; test this with `--test-untracked-cache`. The file system monitor integration (`git fsmonitor--daemon` or the Watchman hook) "enables git to avoid having to lstat() every file". — [git-update-index docs](https://github.com/git/git/blob/master/Documentation/git-update-index.adoc)

**File-watching pitfalls**
- Node `fs.watch`:
  - Uses inotify (Linux), kqueue (BSD), kqueue for files + FSEvents for directories (macOS), and ReadDirectoryChangesW (Windows). Recursive support on Linux was added in v19.1.0.
  - It "is not 100% consistent across platforms". It watches inodes: "If the watched path is deleted and recreated… Events for the new inode will not be emitted."
  - It is "unreliable, and in some cases impossible, on network file systems… or… Vagrant or Docker". The `filename` argument may be `null`.

  — [Node.js fs docs](https://github.com/nodejs/node/blob/main/doc/api/fs.md#caveats)
- chokidar 5.0.0 (Nov 2025) is ESM-only and requires Node ≥20. v4 (Sep 2024) removed glob support and bundled fsevents (dependencies 13 → 1). It "will initiate watchers recursively for everything within scope". `ENOSPC`/`EMFILE` are fixed by raising `fs.inotify.max_user_watches` (e.g. 524288) or falling back to `usePolling`. `awaitWriteFinish` polls file size (default `stabilityThreshold` 2000 ms), and `atomic` handles write-rename saves. — [chokidar README](https://github.com/paulmillr/chokidar/blob/main/README.md)
- `@parcel/watcher` 2.6.0 (last commit 2026-07-19):
  - Native C++ with backends FSEvents, Watchman, inotify, ReadDirectoryChangesW and kqueue. Events are "throttled and coalesced… during large changes like `git checkout` or `npm install`".
  - `writeSnapshot()`/`getEventsSince()` query changes that happened *while the process was not running*. These are fast with FSEvents/Watchman ("milliseconds instead of seconds") but fall back to brute-force `fts` crawling on Linux/Windows unless Watchman is installed.
  - The WASM build "is significantly less efficient".

  — [@parcel/watcher README](https://github.com/parcel-bundler/watcher/blob/master/README.md)
- inotify limits: `max_user_watches` defaulted to 8192 from 2005. Since Linux 5.11 it auto-scales up to 1,048,576 based on RAM (≤1% of addressable memory). "an inotify_inode_mark plus 2 inodes have a size close to 2 kilobytes" on 64-bit. — [LKML patch](https://lkml.iu.edu/hypermail/linux/kernel/2010.3/08749.html), [watchexec: inotify limits](https://watchexec.github.io/docs/inotify-limits.html) (search extracts)

**Incremental parsing**
- `tree.edit()` + `parser.parse(newText, oldTree)` reuses unchanged subtrees. See §1 for the API, and the core docs for [editing and `ts_node_edit`](https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/using-parsers/3-advanced-parsing.md).

**Salsa-style incremental computation**
- Salsa's "red-green" algorithm:
  - Each input set bumps a global **revision**. Memoized tracked functions record their dependencies and the revisions in which those last changed. On re-query, a function is re-executed only if some dependency changed.
  - **Backdating** marks a recomputed value as unchanged when it equals the old memo, so dependents are not re-executed. An example is a comment-only edit that produces the same AST.
  - **Durability** lets functions that depend only on HIGH-durability inputs (e.g. the stdlib or vendored code) skip dependency traversal entirely.

  — [salsa book: red-green algorithm](https://github.com/salsa-rs/salsa/blob/master/book/src/reference/algorithm.md), [backdate](https://github.com/salsa-rs/salsa/blob/master/book/src/plumbing/terminology/backdate.md), [durability](https://github.com/salsa-rs/salsa/blob/master/book/src/reference/durability.md)

**Trigram indexes (Code Search, Zoekt) vs scanning**
- Russ Cox / Google Code Search: a trigram index filters candidate documents, and the full regex then runs only on the candidates. Each regex is analyzed into emptyable / exact set / prefixes / suffixes / match-query ("five results"), and trigrams are used "because there are too few distinct 2-grams and too many distinct 4-grams". — [Regular Expression Matching with a Trigram Index](https://swtch.com/~rsc/regexp/regexp4.html) (search extract)
- The codesearch implementation:
  - Posting lists of file IDs are delta + γ-coded, and paths are prefix-compressed.
  - It skips files with invalid UTF-8, files longer than `maxFileLen = 1<<30`, lines over `maxLineLen = 2000`, or more than `maxTextTrigrams = 20000` distinct trigrams.
  - The index is built by sorting (trigram, file#) pairs, spilling to temp files and merging, so it is batch-oriented rather than incrementally updatable.

  — [google/codesearch index/read.go](https://github.com/google/codesearch/blob/master/index/read.go), [index/write.go](https://github.com/google/codesearch/blob/master/index/write.go)
- Zoekt uses *positional* trigrams, storing the offset of each occurrence. A substring query intersects only two posting lists (the first and last trigram at the correct distance), and a regex becomes an AND/OR of literal substrings, then verification.
  - Index size: "about 3x the corpus size (2x offsets, 1x original content)". Shard size is "about 3.5x the corpus size", and RAM needed is about "1.2x corpus size" because posting lists can stay on SSD.
  - Shards are mmap'd files with uint32 offsets, which caps a shard at 4 GB and about 1 GB of content. Case-insensitive search enumerates case variants.
  - Construction "can easily be made incremental".
  - Goal: "sub-50ms results on large codebases, such as Android (~2G text)". Suggested ranking signals include "is the match a symbol definition?" (via ctags).

  — [Zoekt design.md](https://github.com/sourcegraph/zoekt/blob/main/doc/design.md)
- ripgrep searches "the entire Linux kernel source tree" for `[A-Z]+_SUSPEND` (word match) in **0.082 s** on an i9-12900K, vs 0.273 s for `git grep -P` in the same gitignore-respecting benchmark. In a second, whitelist benchmark (`-uuu -tc`), ripgrep takes 0.063 s vs 0.674 s for GNU grep. The README warns: "Beware of performance cliffs". — [ripgrep README](https://github.com/BurntSushi/ripgrep/blob/master/README.md)

### Inferences
- **Freshness protocol** (all inferred design, grounded in git's approach):
  1. **Persist per file** `{path, size, mtime_ns, ctime_ns, ino, content_hash (xxhash/blake3), parse_ok, interface_hash}`, plus the index write timestamp T.
  2. **Stat before serve.** Before answering `find_references`/`callers`, `lstat` every file whose rows appear in the candidate result set, plus the query's "anchor" file. If the signature differs, or `mtime ≥ T` (racily clean), rehash, and reparse on a hash change. A tree-sitter reparse plus tags query of one file is typically milliseconds, so this is cheap for dozens of files.
  3. **Cheap global check.** On MCP session start and every N seconds of idle time, run `git status --porcelain=v2 -z --untracked-files=all` (fast with `core.untrackedCache`/`core.fsmonitor`) or a full stat sweep for non-git dirs, and enqueue differences. Use `git ls-files -s` blob OIDs as free content hashes for tracked, unmodified files.
  4. **Watcher as hint only.** Replace the chokidar daemon with `@parcel/watcher` (coalesced events + `getEventsSince` snapshot on restart), or keep chokidar. Either way, lost events are repaired by steps 2–3.
- **Early cutoff.** Compute an `interface_hash` over a file's exported/top-level definitions and their signatures, and its import list. If it is unchanged after an edit (a body-only change), only that file's outgoing edges and its own references are recomputed, and dependents are not re-resolved (backdating). If it changed, re-resolve only references *by name* to the added or removed symbols. This requires an inverted `name → unresolved/ambiguous reference ids` table.
- **Merkle directory hashes** are cheap to add on top (hash of sorted child `(name, hash)` pairs). They make "what changed since snapshot X" O(changed dirs) and enable Cursor-like index reuse across branches or worktrees.
- **Trigram index verdict for ≤1M LOC (≈30–40 MB of source, assuming ~35 bytes/line):** scanning is already well under 100 ms with ripgrep, so a trigram index adds about 3× storage and update complexity for little latency gain. If shelling out to `rg` is unacceptable, a JS scan of 40 MB with a precompiled RegExp is plausibly 100–300 ms (unmeasured). An FTS5 trigram table is the middle ground (see §6) and is incrementally updatable per file.

### Gaps
- Cursor's full blog text (chunking and embedding-cache details) could not be opened. Only search extracts were available.
- No primary numbers found for macOS FSEvents latency/coalescing or Windows ReadDirectoryChangesW buffer-overflow behaviour.
- No measured Node-side regex scanning throughput or tree-sitter reparse latency numbers were gathered. Recommend measuring on graph-indexer's `bench/`.
- Russ Cox's article-specific index-size numbers (index as a % of source) were not retrievable.

---

## 6. Storage for a local index in Node (node:sqlite vs better-sqlite3 vs JSON/binary files; FTS5 BM25 for code tokens; memory)

### Takeaway
node:sqlite (Release Candidate since Node 25.7.0/24.15.0, compiled with FTS5) is now a sound zero-dependency default, and graph-indexer already uses it. better-sqlite3 (v13.0.3, SQLite 3.53.4, prebuilt binaries) remains somewhat faster on multi-row reads but brings native-addon install friction. FTS5's BM25 has hard-coded k1 = 1.2 and b = 0.75 (only per-column weights are tunable). The default tokenizers do not split camelCase or snake_case, so index identifiers pre-split into sub-tokens, and use the trigram tokenizer (LIKE/GLOB acceleration) for substring search.

### Cited Findings
- **node:sqlite history:**
  - Added in v22.5.0.
  - "no longer behind `--experimental-sqlite` but still experimental" in v23.4.0 / v22.13.0.
  - "SQLite is now a release candidate" in **v25.7.0 / v24.15.0** ("Stability: 1.2 - Release candidate").
  
  API highlights: `DatabaseSync`, `prepare`, `createTagStore` (a cached prepared-statement store), `function`/`aggregate` (UDFs), `loadExtension`/`enableLoadExtension`, `serialize`/`deserialize`, `createSession`/`applyChangeset`, `backup` and `setAuthorizer`. — [Node.js doc/api/sqlite.md](https://github.com/nodejs/node/blob/main/doc/api/sqlite.md), [nodejs.org/api/sqlite](https://nodejs.org/api/sqlite.html)
- Node's bundled SQLite is compiled with `SQLITE_ENABLE_FTS3`, `FTS3_PARENTHESIS`, **`SQLITE_ENABLE_FTS5`**, `GEOPOLY`, `MATH_FUNCTIONS`, `PERCENTILE`, `PREUPDATE_HOOK`, `RBU`, `RTREE`, `SESSION`, `DBSTAT_VTAB` and `COLUMN_METADATA`. — [node deps/sqlite/sqlite.gyp](https://github.com/nodejs/node/blob/main/deps/sqlite/sqlite.gyp)
- **better-sqlite3** v13.0.3 (last commit 2026-08-09) bundles "SQLite version 3.53.4" with `SQLITE_ENABLE_FTS5`, `FTS3/4`, `JSON1`, `RTREE`, `STAT4`, `MATH_FUNCTIONS` and `SQLITE_DEFAULT_CACHE_SIZE=-16000` (a 16,000 KiB page cache per connection), `THREADSAFE=2`. "Prebuilt binaries are available for major platforms/architectures." The docs recommend worker threads only for very slow queries. — [better-sqlite3 docs/compilation.md](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md), [README](https://github.com/WiseLibs/better-sqlite3), [threads.md](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/threads.md). Its own published benchmark is from 2020 and compares only against node-sqlite3 (e.g. 313,899 vs 26,780 ops/s reading rows individually). — [benchmark.md](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/benchmark.md)
- **node:sqlite vs better-sqlite3:** one benchmark reports 115,544 vs 112,696 ops/s (better-sqlite3 vs node:sqlite) reading single rows, and 36,904 vs 23,015 ops/s reading 100 rows into an array (node:sqlite about 38% slower on bulk reads). The same summary says node:sqlite is "better than node-sqlite3, but not quite as good as better-sqlite3". — [better-sqlite3 issue #1266](https://github.com/WiseLibs/better-sqlite3/issues/1266), [SQG driver benchmark](https://sqg.dev/blog/sqlite-driver-benchmark/) (search extract; which of the two pages holds these exact numbers is **unverified**)
- **FTS5 BM25:**
  - The implementation hard-codes `const double k1 = 1.2;` and `const double b = 0.75;`.
  - IDF = `log((N - nHit + 0.5)/(nHit + 0.5))`, clamped to `1e-6` when ≤0 (very common terms get near-zero weight).
  - Per-column weights come via `bm25(tbl, w1, w2, …)`.

  — [sqlite ext/fts5/fts5_aux.c](https://github.com/sqlite/sqlite/blob/master/ext/fts5/fts5_aux.c), [FTS5 docs](https://www.sqlite.org/fts5.html)
- **FTS5 tokenizers:**
  - `unicode61`/`ascii` accept `tokenchars`, `separators` and `categories` (e.g. to keep `_` inside tokens), plus `remove_diacritics`.
  - The `trigram` tokenizer accepts `case_sensitive` and `remove_diacritics`. It accelerates LIKE (default, case-insensitive) or GLOB (`case_sensitive=1`); all other tokenizers get `FTS5_PATTERN_NONE`.
  
  — [sqlite ext/fts5/fts5_tokenize.c](https://github.com/sqlite/sqlite/blob/master/ext/fts5/fts5_tokenize.c)
- Third-party "better trigram" tokenizers exist specifically to handle "words less than 3 characters in length", a limitation of the stock trigram tokenizer. — [streetwriters/sqlite-better-trigram](https://github.com/streetwriters/sqlite-better-trigram). The FTS5 trigram index turns multi-second `LIKE '%x%'` linear scans over millions of strings into indexed lookups. — [Andrew Mara: Faster SQLite LIKE queries using FTS5 trigram indexes](https://andrewmara.com/blog/faster-sqlite-like-queries-using-fts5-trigram-indexes) (search extract)
- Zoekt's positional-trigram format costs about 3.5× corpus size on disk and about 1.2× corpus in RAM (see §5) — [Zoekt design](https://github.com/sourcegraph/zoekt/blob/main/doc/design.md). stack-graphs also chose SQLite for its per-file partial-path database — [stack-graphs storage.rs](https://github.com/github/stack-graphs/blob/main/stack-graphs/src/storage.rs).

### Inferences
- Keep **node:sqlite** as the single store (zero dependencies, FTS5 included, RC stability). Consider better-sqlite3 only if profiling shows bulk-read hot paths dominate (e.g. multi-hop graph expansion returning thousands of rows). In that case, mitigate first with `statement.iterate()`, `setReturnArrays(true)` and recursive CTEs that keep traversal inside SQLite.
- Schema pattern (Glean-inspired ownership, see §2):
  - `files(file_id, path, sig…, content_hash, interface_hash)`
  - `symbols(sym_id, file_id, name, kind, qual_name, range, enclosing_range)`
  - `refs(ref_id, file_id, name, receiver, kind, range, enclosing_sym_id)`
  - `edges(src_sym, dst_sym, src_file, dst_file, tier, confidence)`
  - `imports(file_id, local_name, module, imported_name)`
  - `unresolved(name → ref_id)`

  An update is one transaction: `DELETE … WHERE file_id=?` (and edges where `src_file=?` or `dst_file=?`), reinsert, and re-resolve only affected names. Use WAL mode with `synchronous=NORMAL` for write throughput.
- FTS for code:
  - Store a derived `tokens` column with identifiers split on camelCase, snake_case and digits, plus the original identifier. This works around unicode61 not splitting `getUserById`.
  - Use a separate `trigram` FTS5 table with `detail=none` for substring/regex prefiltering (LIKE/GLOB). This table size overhead is expected to be multiple times the text size; measure it.
  - Weight BM25 columns (e.g. symbol name ≫ path > body). Accept that k1/b cannot be tuned without a custom rank function (FTS5 allows custom auxiliary functions).
- JSON/binary snapshot files remain fine for small immutable artifacts (e.g. embeddings, HNSW graphs). Whole-file JSON rewrites are O(index) per update and incompatible with per-file incremental updates.

### Gaps
- There are no authoritative 2026 memory-footprint numbers for node:sqlite vs better-sqlite3 (RSS per connection, page cache defaults in Node's build) or for FTS5 trigram index size on code corpora. The FTS5 documentation page itself (for `detail=` size effects) could not be opened. Recommend measuring with `dbstat` (enabled in both builds).
- I could not verify from a primary source which benchmark page holds the 115,544/112,696 ops/s numbers, or the exact Node/SQLite versions used.
