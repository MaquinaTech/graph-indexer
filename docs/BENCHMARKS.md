# Benchmarks

Three benchmarks, each answering a question an agent actually depends on:

1. **Are the references right?** — `bench/eval-graph.mjs`, against the TypeScript compiler;
   `bench/eval-graph-go.mjs`, against the Go type checker; `bench/eval-graph-java.mjs`, against
   the Java compiler. Libraries and frameworks, and one product monorepo (Twenty).
2. **Does search find the code a real change touched?** — `bench/eval-localize.mjs`, replaying
   real commits.
3. **Does search find the symbol a developer means?** — `bench/eval-search.mjs`, 377 authored
   queries.

Each of them also runs graph-indexer 2.x on the same sample ([section 5](#5-against-graph-indexer-2x)).

Everything runs offline on public repositories pinned to exact commits (`bench/fixtures.mjs`).
Numbers below were produced with graph-indexer 3.0.0 on Node.js 22.

## Setup

```bash
node bench/fixtures.mjs                 # clone the 9 pinned fixtures into test/fixtures/
node bench/fixtures.mjs --history 400   # plus history, for the localization benchmark
```

| fixture | language | repository | commit |
|---|---|---|---|
| axios | JavaScript | axios/axios | `f7adacd` (v1.6.0) |
| express-js | JavaScript | expressjs/express | `8368dc1` (4.18.2) |
| nestjs | TypeScript | nestjs/nest | `416830c` (v10.4.9) |
| fastapi | Python | tiangolo/fastapi | `415eb14` (0.103.0) |
| gin | Go | gin-gonic/gin | `4ea0e64` (v1.9.1) |
| spring | Java | spring-projects/spring-petclinic | `a2c2ef9` |
| rust | Rust | serde-rs/json | `a1ae73a` |
| cjson | C | DaveGamble/cJSON | `fb16e5c` |
| nvm | Bash | nvm-sh/nvm | `a6ec739` |

## 1. Reference accuracy against the TypeScript compiler

```bash
node bench/eval-graph.mjs --n 400 --seed 11     # needs the `typescript` package (TYPESCRIPT_PATH)
```

**Method.** A seeded random sample of functions, methods, classes and interfaces from nestjs
`packages/core` and `packages/common` (non-test, non-`.d.ts`). For each one the TypeScript
LanguageService's `findReferences` over the whole repository is the oracle; lines are compared
at `file:line` granularity. Import/export lines, declarations of related members and the
definition itself are excluded on both sides; only TypeScript files count (the compiler's
program does not include the JavaScript samples).

Two oracles are derived from the compiler's answer:

- **dispatch** — references to the member itself, to the members it overrides or implements
  (a call through the base type may dispatch here) and to its own overrides. This is what
  `find_references` promises.
- **rename** — everything `findReferences` returns, which for a method also includes calls to
  *sibling* overrides that merely share a base declaration (e.g. calls to `ValidationPipe.transform`
  when asking about `ParseUUIDPipe.transform`).

Baselines on the same sample: **grep** (every line containing the name as a whole word, import
lines excluded) and **name-only** (every syntactic reference with that name, unresolved).

**Results** (400 symbols, seed 11; 149 symbols with seed 7 in parentheses):

| oracle | system | micro-P | micro-R | micro-F1 | macro-P | macro-R | exact set |
|---|---|---|---|---|---|---|---|
| dispatch | graph-indexer | 0.997 (0.999) | 0.962 (0.887) | 0.979 (0.940) | 0.972 | 0.966 | 0.915 |
| dispatch | graph-indexer, confidence ≥ likely | 0.997 (1.000) | 0.962 (0.887) | 0.979 (0.940) | 0.974 | 0.966 | 0.920 |
| dispatch | name-only | 0.252 | 0.975 | 0.400 | 0.735 | 0.976 | 0.591 |
| dispatch | grep | 0.128 | 0.993 | 0.227 | 0.515 | 0.994 | 0.226 |
| rename | graph-indexer | 0.997 (0.999) | 0.925 (0.767) | 0.960 (0.868) | 0.972 | 0.950 | 0.885 |
| rename | name-only | 0.262 | 0.976 | 0.413 | 0.752 | 0.977 | 0.607 |
| rename | grep | 0.133 | 0.993 | 0.235 | 0.521 | 0.994 | 0.226 |

An earlier 3.0 build, before the correctness work that followed the agent studies, gave with the
same seed: dispatch precision 0.979, recall 0.895, exact sets 0.835. Constructors recognised by
language and the type arguments of a constructed map kept moved recall from 0.960 to 0.961 and
exact sets from 0.902 to 0.905; anonymous classes and the values of maps (below) moved exact sets
to 0.907 and per-symbol recall and precision up by 0.002 each. The sample leaves out anonymous
classes, which nobody looks up by name, so it is the same symbols as before. The fixes found on
Twenty (below) moved precision from 0.996 to 0.997, recall from 0.961 to 0.962 and exact sets
to 0.915.

Micro averages pool all reference lines (dominated by heavily used symbols); macro averages
weigh each symbol equally; "exact set" is the share of symbols whose reference set matches the
oracle exactly.

**What is still missed.** Receivers whose type only a type checker knows: object literals
contextually typed by an interface (`{ useFactory: … }` as a `FactoryProvider`), generic
instantiation, destructured property reads, and `any`-typed values; type names in JSDoc tags are not references at all. These show up as lower recall, not
as wrong answers, and `find_references` names the same-name call sites it could not bind, in the
files that use the type or a subclass of it, so an agent knows what to check. Callback parameters
typed only by the signature of the function they are passed to
(`helpers.connect((err, socket) => socket.send(…))`) are followed, as are fluent chains formatted
one call per line, chains that start with `(await …)`, `this` inside an anonymous class
(`return class extends ModuleRef {…}`), and the values of a map handed to `forEach`, a
`values()` loop or a copy (`Array.from`, spread), also from a class that extends `Map<K, V>`.

**A caveat on the oracle.** The fixture is checked out without `node_modules`, so values that
flow through third-party libraries (for example `iterate(instances).filter(([_, w]) =>
w.isDependencyTreeStatic())` with `iterare`) are `any` to the compiler and their references are
missing from its answer. graph-indexer still finds some of them, and each one counts as a false
positive here: the precision figures are a lower bound.

### The same measurement for Go

```bash
brew install go                                   # or any Go ≥ 1.22
(cd bench/oracle-go && go build -o ~/.gi-agentic/oracle-go .)
(cd test/fixtures/gin && go mod download)
node bench/eval-graph-go.mjs --n 150              # gin; --fixture/--fixture-dir for another module
```

**Method.** The oracle (`bench/oracle-go`) loads every package of the module, tests included,
with `golang.org/x/tools/go/packages` and answers from `go/types`: the **exact** oracle is every
identifier bound to the sampled declaration; the **dispatch** oracle adds, for a method, the uses
of the interface methods it implements and, for an interface method, the uses of its
implementations, which matches the contract of the TypeScript dispatch oracle. Lines the default build
leaves out (files behind build tags) are excluded on both sides, since the checker has no answer
there. graph-indexer's implicit implementations (`kind: inherit` on a type's declaration line, as
Go has no `implements` clause) are not uses, so they are scored separately, for every
interface in the repository, against `types.Implements` on the type or its pointer.

Three repositories: gin (the fixture above) and two that graph-indexer had not been run on,
caddy v2.8.4 (`7088605`, a module at major version 2 built around interfaces) and nats-server
v2.10.22 (`240e9a4`, large types with many methods). Clone them at those tags and run
`go mod download` in each. The seed is 7; the sample is 150 symbols for gin and 200 for the others.

| repository | build | precision | recall | exact set | implementations P / R | grep P | name-only P |
|---|---|---|---|---|---|---|---|
| gin (146 symbols, 10 interfaces) | before | 0.992 | 0.952 | 0.911 | 1.000 / 0.936 | 0.238 | 0.373 |
| | after | **1.000** | **0.981** | **0.986** | **1.000 / 1.000** | | |
| caddy (196, 48) | before | 0.980 | 0.916 | 0.842 | 0.823 / 0.964 | 0.085 | 0.271 |
| | after | **1.000** | **0.972** | **0.934** | **0.994 / 1.000** | | |
| nats-server (199, 24) | before | 0.971 | 0.975 | 0.894 | 0.966 / 0.249 | 0.232 | 0.483 |
| | after | **0.992** | **0.978** | **0.935** | **0.977 / 0.938** | | |

(dispatch oracle, micro averages; grep's recall is 1.000 by construction.) The first run found
seven faults, fixed in this order (the agent tasks on caddy, below, found four more):

- **Reopening an index lost Go's implicit implementations.** They lived only in memory after
  indexing, so a server that opened an existing index (every session) no longer counted calls
  through an interface as calls to its implementations. "Before" above was measured on fresh
  indexes and does not show it. On a reopened gin index `find_references` on
  `xmlBinding.Bind` found 0 of its 14 uses.
- **A module at major version 2 or later** (`github.com/caddyserver/caddy/v2`) was imported
  under the name `v2` rather than its package name, so no `caddy.X` in the repository resolved
  (likewise `gopkg.in/yaml.v3`).
- **Implementations were matched by method name only**: in caddy, `Handler.ServeHTTP(w, r,
  next)` counted as implementing `AdminHandler.ServeHTTP(w, r)`. Parameter and result types
  are now compared by their base names.
- **Promoted methods and aliases were not counted**: `type Engine struct { RouterGroup }`
  implements what `RouterGroup` implements, and `type DummyLogger = testhelper.DummyLogger`
  has its target's methods.
- **A package-level variable in another file** (`b := Form`, with `Form = formBinding{}`) left
  the local untyped, and **conversions** `(*T)(nil)` were not references to `T`.
- **Library types lost their package**: `req *http.Request` was stored as `Request`, and
  `req.PostForm` was then bound by name to a repository method `PostForm`. Types now keep
  their package, and a package outside the repository makes the type external.
- **Locals did not shadow package functions**: `stack := stack(3); log(stack)` and a local
  closure `check := func…; check()` were bound to the package's `stack` and `check`.
- Found while generating the agent questions on caddy, whose call sites the index missed:
  an **embedded field named by its type** (`m.MatchRegexp.Match()` in a struct that embeds
  `MatchRegexp`), the elements of **named collection types** (`for _, rm := range m` with
  `type MatchHeaderRE map[string]*MatchRegexp`), chains that start with a **type assertion**
  (`val.(Module).CaddyModule().ID.Name()`; likewise `(x as Foo).bar()` in TypeScript), and the
  **result types of interface methods**. On one question the index went from 3 to 12 of 13 call
  sites.

**What is still missed.** Methods that a type gets from an embedded *library* type
(`struct { net.Conn }` has `SetReadDeadline`; an interface embedding `io.Reader` needs
`Read`): the index does not read the standard library or dependencies, so such types are not
known to implement those interfaces, and calls through a library interface (`w.Write` on an
`http.ResponseWriter`) are not tied to the repository's implementations. The rest is receiver
types only a type checker knows: several values returned by one call, type switches and some
chained calls. As in TypeScript, these lower recall and do not produce wrong answers.

### The same measurement for Java

```bash
node bench/eval-graph-java.mjs --fixture spring --n 200          # needs a JDK (17+); main code only
node bench/eval-graph-java.mjs --fixture jsoup --fixture-dir DIR --n 200
```

**Method.** `bench/oracle-java/Oracle.java` runs javac's own front end (`JavacTask`: parse and
attribute) over every file of the source directories and binds each identifier, member access
and method reference to the element it names. Dependencies are not on the class path, which
turns library types into error types: what the repository declares still resolves. The
**exact** oracle is the uses of the sampled element; **dispatch** adds the uses of the methods it
overrides or implements and of those that override it (`Elements.overrides`), as for TypeScript.
Tests are left out on both sides (they need their libraries to compile).

Three repositories: the spring-petclinic fixture above and two that graph-indexer had not been run
on, jsoup 1.18.1 (`19e8539`, no dependencies, enum constants with bodies) and Apache Commons
Collections 4.4 (`cab58b3`, interfaces, generics and deep hierarchies everywhere). The seed is 7;
up to 200 symbols per repository.

| repository | build | precision | recall | exact set | grep P | name-only P |
|---|---|---|---|---|---|---|
| spring-petclinic (111 symbols) | before | 0.919 | 0.995 | 0.946 | 0.609 | 0.887 |
| | after | **0.994** | 0.989 | **0.973** | | |
| jsoup (200 · 188) | before | 0.767 | 0.862 | 0.550 | 0.090 | 0.337 |
| | after | **0.960** | **0.916** | **0.798** | | |
| commons-collections (200) | before | 0.878 | 0.791 | 0.725 | 0.015 | 0.097 |
| | after | **0.955** | **0.861** | **0.805** | | |

(dispatch oracle, micro averages. In jsoup twelve enum constants with bodies became classes, which
the oracle does not sample: 188 symbols after.) Java was the weakest language measured; the
faults were general:

- **Overloads were merged**, as TypeScript's declarations of one function are: in Java each
  overload is a method of its own. Calls now carry their argument count and bind to the overload
  that takes it, preferring a fixed-arity one over a variadic one as javac does; a call none of a
  type's own overloads fits reaches an inherited one (`element.attr("x")` runs `Node.attr(key)`
  when `Element` declares only `attr(key, value)`); overrides are matched by parameter count, and
  `clean(html, "")` inside `clean(html)` is no longer taken for recursion.
- **A class named for a static access** (`StringUtil.join(…)`, `Token.TokenType.EOF`, `Foo::bar`)
  was not a use of the class: in jsoup, 85 uses of `StringUtil` were missing.
- **Anonymous classes and enum constants with bodies** (`new Transformer<>() {…}`,
  `AfterBody { boolean process(…) }`) are subclasses of what they instantiate or of their enum,
  so their methods take calls through the base. A method's enclosing type is its parent, not a
  type found by the name `<anonymous>`, which repeats (this applies to every language).
- **Nested types** keep their enclosing type (`Token.Comment` is not the top-level `Comment`); a
  field inherited from a base class in another file types its receiver; an argument is a variable,
  never the method of the same name.

**What is still missed.** Overloads that take the same number of arguments (telling them apart
needs the argument types), calls through a library interface, and lambdas typed only by the
functional interface they are passed to. The dispatch oracle, like TypeScript's, also counts a
`super.m()` call as reaching every override of `m`, while the index knows it binds statically
to the parent's `m`; those count as missed here.

### A product monorepo: Twenty

```bash
GI_TSCONFIG=bench/agentic/tsconfig/twenty.json node bench/eval-graph.mjs --fixture twenty \
  --fixture-dir DIR --scope packages/twenty-server/src/ --n 400 --seed 11
```

The fixtures above are libraries and frameworks, written with care and read by many. Most code
agents work in is not: it is a company's product, with a server, a front end and shared packages
in one repository, dependency injection, generated GraphQL types, upgrade commands by the hundred
and tests next to the code. Twenty (`twentyhq/twenty` at `4c28e34`, September 2026), an open-source
CRM, is one: 28,512 indexed files, 2.3 million lines, a NestJS server, a React front end and a
shared package. The sample is 400 symbols of the server (`packages/twenty-server/src`); the
oracle's program is the server, its integration tests and the shared package, with the path aliases
each package declares for itself (`bench/agentic/tsconfig/twenty.json`, which `GI_TSCONFIG` passes
to the oracle and to the task graders); third-party packages are not installed, as for nestjs.

| build | precision | recall | exact set | file-level P / R | grep P |
|---|---|---|---|---|---|
| before | 0.990 | **0.182** | 0.495 | 0.990 / 0.199 | 0.009 |
| after | **0.999** | **0.924** | **0.945** | 0.998 / 0.956 | |

(dispatch oracle, micro averages.) On the libraries graph-indexer found 96% of the uses; here it
found 18%, because of one assumption that holds in a library and fails in a product:

- **Path aliases were read from the root tsconfig only.** In a monorepo each package declares its
  own (`src/*` in the server, `@/*` in the shared package and again, for another directory, in
  the front end), so nearly every import of the server (`from 'src/engine/…'`) was unresolved.
  Each file now resolves through the nearest `tsconfig.json` above it (following `extends`, with
  targets relative to its `baseUrl` or to the config that declares them), then the root's.

The remaining misses led to five more general fixes, in every JavaScript/TypeScript repository:

- **A bare call inside a method is never the method**: `sweepLocalCache(…)` inside the method
  `sweepLocalCache()` calls the imported function; a method calls itself only with `this.`
  (languages with implicit `this`, like Java, keep the old rule).
- **Members of object and type literals are not names in scope**: in
  `const fillers: { fill: typeof fill } = { fill }` both `fill`s are the function, not the
  literal's property.
- **A function or class used as a value** in more positions: an arrow's body (`@Field(() =>
  EventDTO)`, `forwardRef(() => X)`, the NestJS and TypeORM decorators), both branches of a
  conditional, `return fn`, `const f = fn`, assignments and `typeof fn` in a type.
- **Destructuring keeps types**: `const { command: cmd } = entry` is `entry.command`, and
  `({ a }: Deps)` or `({ a }: { a: A })` is the member's written type.
- **`Pick<T, …>`, `Omit<T, …>` and type aliases** (`type Entry = Pick<Registered, 'command'>`,
  `type X = A & { … }`) have the members of the types they are made of.

**What is still missed** here: calls through a union or an interface declared in a registry
object (`workspaceCommand.runOnWorkspace` for each of the upgrade commands), methods of object
literals that implement an interface, fluent query builders whose chain returns `this` through a
generic, and `factory['privateMethod']()` in tests.

## 2. Localization from real commits

```bash
node bench/eval-localize.mjs --n 40 [--fixtures express-js,gin,fastapi,nestjs,axios]
```

**Method** (SWE-bench-style, no hand labels). For each fixture, the most recent non-merge commits
before the pinned commit are filtered to focused changes: a descriptive subject (conventional
prefixes, release/dependency/doc/lint commits excluded), at most 8 files changed of which 1–3 are
modified source files (tests, docs, examples and scripts are not answers). The commit subject,
stripped of prefixes and issue numbers, is the query. The answer is the set of changed source
files and the functions/methods whose lines the commit touched. Before each query a scratch
worktree is checked out at the commit's **parent** and the index is updated incrementally, so the
fix itself is never searchable.

Systems on the same snapshot:

- **graph-indexer** — `search_code` exactly as the MCP tool runs it.
- **grep** — what grepping the query words gives an agent, made as strong as possible: files are
  ranked by summed idf-weighted term hits over their full text; functions by their best-matching
  line. (An agent actually sees unranked grep output, so this baseline is optimistic.)
- **BM25** — the same FTS5 symbol index ranked by BM25F alone.

Metrics: file Acc@k (a changed file among the first k distinct files), function Acc@k and MRR@10
over changed functions (commits touching no function are excluded from function metrics).

**Results** (169 commits; the file-level channel's weight was selected on express-js, gin and
fastapi only; nestjs and axios are held out):

| fixture | commits | system | file Acc@1 | file Acc@5 | fn Acc@5 | fn Acc@10 | fn MRR@10 |
|---|---|---|---|---|---|---|---|
| express-js | 36 | graph-indexer | 0.722 | 0.917 | 0.893 | 0.929 | 0.810 |
| | | grep | 0.778 | 0.889 | 0.857 | 0.929 | 0.633 |
| | | BM25 | 0.472 | 0.861 | 0.821 | 0.893 | 0.598 |
| gin | 40 | graph-indexer | 0.625 | 0.925 | 0.500 | 0.528 | 0.396 |
| | | grep | 0.600 | 0.875 | 0.583 | 0.639 | 0.461 |
| | | BM25 | 0.450 | 0.850 | 0.417 | 0.528 | 0.309 |
| fastapi | 13 | graph-indexer | 0.692 | 0.923 | 0.667 | 0.778 | 0.405 |
| | | grep | 0.308 | 0.846 | 0.556 | 0.667 | 0.295 |
| | | BM25 | 0.462 | 0.846 | 0.556 | 0.556 | 0.254 |
| nestjs *(held out)* | 40 | graph-indexer | 0.450 | 0.675 | 0.324 | 0.432 | 0.271 |
| | | grep | 0.325 | 0.625 | 0.162 | 0.297 | 0.103 |
| | | BM25 | 0.300 | 0.575 | 0.243 | 0.324 | 0.164 |
| axios *(held out)* | 40 | graph-indexer | 0.350 | 0.675 | 0.438 | 0.688 | 0.335 |
| | | grep | 0.325 | 0.675 | 0.531 | 0.719 | 0.386 |
| | | BM25 | 0.250 | 0.575 | 0.156 | 0.313 | 0.154 |
| **all** | **169** | **graph-indexer** | **0.544** | **0.805** | **0.528** | **0.634** | **0.432** |
| | | grep | 0.485 | 0.769 | 0.514 | 0.627 | 0.374 |
| | | BM25 | 0.373 | 0.722 | 0.401 | 0.500 | 0.290 |

**Reading it honestly.** On commit subjects, a well-ranked grep is a strong baseline: it wins on
gin and axios at function level. graph-indexer is ahead overall on every metric and clearly on the
larger repositories (nestjs, fastapi), where there is more to search through. Commit subjects are terse; real issues carry more context, and
agents combine search with `find_references`/`call_graph`, which this benchmark does not measure.

## 3. Symbol search

```bash
node bench/eval-search.mjs [--rebuild] [--verbose] [--json out.json]
node bench/tune-weights.mjs             # coordinate ascent on the tuning split only
```

**Method.** 377 hand-written queries over the nine fixtures (`bench/suites/*.mjs`, inherited from
graph-indexer 2.x): identifier lookups, descriptions of behaviour ("parse the incoming request
body into the declared parameters") and hard cases. A hit is strict and symbol-level: the result's
name, or a contiguous segment of its qualified name, equals an expected name — no credit for
landing in the right file. Queries are split into a tuning set (208) and a held-out set (169);
ranking weights were only ever selected on the tuning set. graph-indexer 2.x results on the same
queries (`bench/baseline-v2.json`) were produced by its own harness with its default lexical
configuration.

**Results:**

| queries | n | v3 rank-1 | v3 success@5 | v3 MRR@10 | v2 rank-1 | v2 success@5 | v2 MRR@10 |
|---|---|---|---|---|---|---|---|
| all | 377 | **0.700** | **0.841** | **0.759** | 0.552 | 0.780 | 0.646 |
| held-out | 169 | **0.728** | **0.846** | **0.773** | 0.544 | 0.757 | 0.632 |
| tuning | 208 | 0.678 | 0.837 | 0.747 | 0.558 | 0.798 | 0.658 |
| symbol-oriented (easy/medium/hard) | 285 | 0.772 | 0.895 | 0.822 | 0.639 | 0.842 | 0.727 |
| semantic (behaviour descriptions) | 92 | 0.478 | 0.674 | 0.563 | 0.283 | 0.587 | 0.396 |

Per fixture (MRR@10, v3 vs v2): axios 0.76 / 0.80, express 0.83 / 0.70, gin 0.88 / 0.79,
spring 0.86 / 0.71, serde-json 0.66 / 0.37, cJSON 0.69 / 0.56, nvm 0.85 / 0.64,
fastapi 0.63 / 0.64, nestjs 0.68 / 0.59. 2.x ranks better on axios, and on fastapi by 0.01.

The file-level channel added last trades some top-5 recall on the semantic queries of the tuning
split (0.706 → 0.608) for better rank-1 and better localization; overall MRR rose from 0.755 to
0.761. Later changes moved a few tuning-split queries down (MRR 0.752 → 0.747, all
queries 0.761 → 0.759); the held-out split did not change.

## 4. Agents with and without graph-indexer

The end-to-end test is the [agentic benchmark](AGENTIC-BENCHMARK.md): the same model gets the same
task in the same repository, with built-in tools only (`grep`), with graph-indexer added to them,
or with graph-indexer instead of grep and glob, and an oracle the agent never sees grades the
result — the TypeScript compiler for code questions (B1) and multi-site refactors (B2), the tests
of the real fix for issues reported after the model's training cutoff (B3). Three rounds, each on
tasks that played no part in the changes it tests; cost is the agent's usage in input-equivalent
tokens, paired by task (bootstrap 95% CI):

| round | tasks | graph-indexer with grep: cost vs `grep` | graph-indexer without grep | solved |
|---|---|---|---|---|
| development (`rc2`/`rc3`) | B1 8, B2 8, B3 14 | 0.93 (0.81–1.03); B1 + B2 0.76 | 0.97 (0.81–1.17) | 120 of 120 |
| held out (`rc4`) | B1 7, B2 6, B3 10 | 0.90 (0.77–1.04); B1 + B2 0.81 | 1.02 (0.89–1.15) | 69 of 69 |
| third (`rc5`) | B1 10, B2 6 | 0.73 (0.58–0.90) | 0.82 (0.59–1.12) | 47 of 48 (`grep` 15 of 16) |

- On code questions and refactors, graph-indexer next to grep costs about three quarters of
  grep alone: caller chains are answered after reading a quarter of the source, and on the last
  round "which classes implement X" costs 0.62 of grep instead of 1.46.
- Without grep nothing is lost, at about the same cost.
- Fixing real issues costs the same with or without it (cost ratios between 0.96 and 1.10):
  reading the code around the fault and running tests are most of the work.

## 5. Against graph-indexer 2.x

```bash
git worktree add --detach ~/.gi-agentic/v2 v2.1.1 && (cd ~/.gi-agentic/v2 && npm ci)
node bench/eval-graph.mjs --n 400 --seed 11 --v2 ~/.gi-agentic/v2          # likewise eval-graph-go/-java
node bench/eval-localize.mjs --n 40 --v2 ~/.gi-agentic/v2
node bench/eval-search.mjs                                                  # 2.x results are in bench/baseline-v2.json
```

**Method.** 2.x (the 2.1.1 release) runs as users installed it: its own index, built with its
defaults, queried through its own MCP server. For references it gets the tool call an agent would
make: `find_references` with the symbol's name, and the owning class for a method. 2.x answers
with the functions, methods or whole classes that reference the name, not with lines; its lines
are those of each chunk it names that contain the name as a word (what an agent finds by reading
those chunks), and the table also scores both versions at file level, where 2.x needs no such
step. Answer size is the default text answer of each version's tool, in tokens. For localization
2.x's `search_code` returns its top 20 with no score floor; a chunk counts as the functions it
spans.

**References** (dispatch oracle, micro averages, the samples of section 1; 3.0 is the build these
docs describe):

| repository | 3.0 P / R | 2.x P / R | 3.0 files P / R | 2.x files P / R | answer, tokens 3.0 / 2.x |
|---|---|---|---|---|---|
| nestjs (TS, 399) | **0.997 / 0.962** | 0.176 / 0.886 | 0.999 / 0.972 | 0.371 / 0.886 | 587 / 1,084 |
| Twenty (TS, 400) | **0.999 / 0.924** | 0.052 / 0.739 | 0.998 / 0.956 | 0.083 / 0.774 | 394 / 2,787 |
| gin (Go, 146) | **1.000 / 0.981** | 0.642 / 0.264 | 1.000 / 0.971 | 0.648 / 0.239 | 387 / 117 |
| caddy (Go, 196) | **1.000 / 0.972** | 0.641 / 0.378 | 1.000 / 0.958 | 0.693 / 0.292 | 374 / 106 |
| nats-server (Go, 199) | **0.992 / 0.978** | 0.300 / 0.167 | 0.968 / 0.984 | 0.438 / 0.251 | 426 / 502 |
| spring-petclinic (Java, 111) | **0.994 / 0.989** | 0.699 / 0.984 | 1.000 / 0.978 | 0.909 / 0.968 | 343 / 159 |
| jsoup (Java, 188) | **0.960 / 0.916** | 0.117 / 0.790 | 0.961 / 0.915 | 0.309 / 0.837 | 599 / 2,791 |
| commons-collections (Java, 200) | **0.955 / 0.861** | 0.020 / 0.982 | 0.938 / 0.848 | 0.081 / 0.977 | 996 / 11,968 |

- **In TypeScript and Java 2.x finds most uses but buries them**: it matches callers by name and
  lists every chunk that mentions it, so in Twenty 95% of the lines it points to are not uses of
  the symbol (in Commons Collections, 98%), and its answers run to thousands of tokens (a mean of
  12,000 in Commons Collections). 3.0's answers are exact and a few hundred tokens.
- **In Go 2.x misses most uses**: calls through a receiver (`c.JSON(…)`) are not tied to the
  method, so for `Context.JSON` in gin it reports no caller at all. Its short answers in Go are
  short because they are empty.
- Leaving out what 2.x marks unverified raises its precision (Twenty 0.215, nestjs 0.343) and
  halves its recall; no setting of 2.x comes close to 3.0 on both.

**Localization** (169 real commits, section 2):

| | file Acc@1 | file Acc@5 | function Acc@5 | function Acc@10 | function MRR@10 |
|---|---|---|---|---|---|
| 3.0 `search_code` | **0.544** | **0.805** | 0.528 | **0.634** | **0.432** |
| 2.x `search_code` | 0.473 | 0.775 | **0.535** | 0.627 | 0.414 |

A draw on functions, with 2.x credited with every method of a class it returns whole; 3.0 puts
the changed file first 15% more often.

**Symbol search** (377 queries, section 3): rank-1 0.703 against 0.552, MRR 0.760 against 0.646;
on the held-out queries MRR 0.773 against 0.632; on behaviour descriptions rank-1 0.478 against
0.283.

**What a session carries and what indexing costs.**

| | 3.0 | 2.x |
|---|---|---|
| context added to every Claude Code session (tools, instructions, CLAUDE.md) | **1,200 tokens** | 10,600 tokens |
| full index, nestjs / Twenty | **2.3 s / 51 s** | 9.3 s / about 180 s |
| update with nothing changed, nestjs / Twenty | **0.2 s / 1.8 s** | 9.0 s / about 180 s (it rebuilds) |
| index on disk, nestjs / Twenty | **13 MB / 304 MB** | 48 MB / 561 MB |

The added context is measured in real sessions (the first request of each session, against a
session without graph-indexer: 15,900 tokens); 2.x's is its 16 tools and the prompt suite its
`init` imports into CLAUDE.md. Index times are those the agent harness measured when it prepared
the runs, both versions on the same machine and checkouts (the speed table below was measured
separately). The agent rounds against 2.x are in the
[agentic benchmark](AGENTIC-BENCHMARK.md#against-2x-in-real-sessions-vs-nest-vs-twenty-120-runs).

## Speed and size

| fixture | files | lines | symbols | references | bound | full index | DB |
|---|---|---|---|---|---|---|---|
| nvm | 6 | 5,786 | 158 | 1,419 | 94% | 0.1 s | 0.4 MB |
| spring | 52 | 13,743 | 2,733 | 1,853 | 43% | 0.5 s | 1.7 MB |
| rust | 71 | 23,198 | 2,028 | 5,976 | 86% | 0.7 s | 2.1 MB |
| gin | 91 | 18,118 | 1,811 | 6,687 | 92% | 0.9 s | 2.3 MB |
| cjson | 120 | 26,564 | 2,111 | 6,270 | 87% | 1.4 s | 2.5 MB |
| axios | 136 | 15,374 | 1,000 | 5,838 | 68% | 1.0 s | 1.7 MB |
| express-js | 157 | 23,326 | 424 | 10,165 | 70% | 0.7 s | 2.0 MB |
| fastapi | 1,215 | 100,435 | 7,795 | 13,315 | 72% | 2.3 s | 7.0 MB |
| nestjs | 1,641 | 95,963 | 7,958 | 33,360 | 82% | 3.7 s | 12.3 MB |
| Twenty | 28,512 | 2,327,185 | 170,126 | 554,975 | 79% | 51 s | 304 MB |

"Bound" is the share of stored references resolved to a definition in the repository (calls into
libraries stay unbound; value, member-read and type references that cannot be bound are dropped
at index time). After the first build only changed files are re-parsed.

Warm tool latency on nestjs (median of 5): `get_symbol` 1.2 ms, `find_references` 1.1 ms,
`call_graph` 1.4 ms, `change_impact` 3.7 ms, `outline` 17.8 ms, `search_code` about 30 ms.
The eight tool definitions cost about 2.4k tokens of context and the server instructions about
500; replies are typically 400–1,500 tokens.
