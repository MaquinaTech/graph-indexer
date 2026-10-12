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

(dispatch oracle, micro averages; grep's recall is 1.000 by construction.) Re-run on 2026-10-11
(Go 1.27.1) after the general resolver changes for TypeScript and Python (nested functions kept out
of global binding, external re-exports): all three "after" rows and implementation scores are
reproduced exactly. The first run found
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

### The same measurement for Python

```bash
pip install pyright                                   # or npm i -g pyright; needs pyright-langserver on PATH
node bench/eval-graph-python.mjs --n 150              # fastapi; --fixture/--fixture-dir/--scope for another repository
```

**Method.** Python has no compiler; the oracle is pyright (1.1.414), the type checker behind
Pylance, through its language server's Find All References (`bench/eval-graph-python.mjs`).
Third-party packages are not installed, so what the repository declares still resolves and
library types do not, as for the other oracles. pyright binds `obj.m()` to the method of obj's
declared type only, so its answer is an **exact** oracle; graph-indexer is scored on its exact
answer (`family: false`). Import statements and declaration lines — the sampled one and
redeclarations such as `if PYDANTIC_V2: def f … else: def f` — are excluded on both sides. The
seed is 7; up to 150 functions, methods and classes per repository.

Six repositories. fastapi, flask, requests and httpx were used while fixing what the oracle found;
rich and click were measured only once, after the fixes. "Before" is graph-indexer 3.0.0.

| repository | build | precision | recall | exact set | grep P | name-only P |
|---|---|---|---|---|---|---|
| fastapi 0.103.0 (`415eb14`, 150 symbols) | before | 0.984 | 0.986 | 0.793 | 0.273 | 0.571 |
| | after | **0.997** | **0.998** | **0.940** | | |
| flask 3.0.3 (`c12a5d8`, 150) | before | 0.869 | 0.851 | 0.667 | 0.110 | 0.358 |
| | after | 0.868 | **0.909** | **0.713** | | |
| | now | 0.871 | 0.929 | 0.720 | | |
| requests 2.32.3 (`0e322af`, 149) | before | 0.927 | 0.936 | 0.826 | 0.251 | 0.477 |
| | after | **0.952** | **0.964** | **0.846** | | |
| | now | 0.952 | 0.967 | 0.852 | | |
| httpx 0.27.2 (`609df7e`, 150) | before | 0.910 | 0.832 | 0.620 | 0.158 | 0.432 |
| | after | **0.998** | **0.946** | **0.760** | | |
| | now | 0.998 | 0.950 | 0.800 | | |
| rich 13.9.4 (`43d3b04`, 144) *(held out)* | before | 0.991 | 0.867 | 0.785 | 0.214 | 0.543 |
| | after | **0.992** | **0.971** | **0.854** | | |
| | now | 0.992 | 0.972 | 0.854 | | |
| click 8.1.7 (`874ca2b`, 144) *(held out)* | before | 0.962 | 0.882 | 0.785 | 0.266 | 0.493 |
| | after | **0.967** | **0.888** | **0.826** | | |
| | now | 0.970 | 0.980 | 0.910 | | |

What changed:
- `from pkg import submodule` then `submodule.X` was looked up in `pkg/__init__.py` first, which
  may re-export something else under that name: fastapi's `params.File(…)` (the class) was bound
  to the `File` function that `fastapi/__init__.py` exports.
- A name imported from a module that re-exports it from an uninstalled package (`from fastapi
  import Response`, Starlette's) fell back to a same-name definition anywhere in the repository; it
  is now external.
- An untyped parameter (`def send(self, request): … request`) was bound by name to a function
  `request` elsewhere; parameters and other locals now shadow repository names, as in pyright.
- A function nested in another is visible only inside it, so a call elsewhere no longer binds to it.
- Missing uses: `return name`, PEP 604 unions (`A | B | None`), `except (A, B) as e`, dictionary
  keys, generic arguments (`Union[A, B]`), `__all__` entries, `TypeVar(bound="A")`, `Class.attr`,
  submodule chains (`import flask; flask.json.dumps`), and `self.x` under a property `x` of a base
  class, which was taken for a new field.

"Now" is 2026-10-11, after three more fixes found on flask and click: an absolute import resolves
only from an import root (`import json as _json` inside `flask/json/` had been bound to that
package rather than the standard library); `import click.utils` also binds `click`, the package
(click's tests that write `click.open_file(…)` after it had none of those uses bound); and names
inside the subscripts of qualified generics (`t.Optional[Command]`, `t.Callable[[Ctx], "Group"]`)
are type references. (On this machine the "after" build reproduces every row except flask's exact
set, 0.707 instead of 0.713; "now" is measured against that.) fastapi is unchanged (0.997 / 0.998 / 0.940); no Python repository lost
precision or recall.

What remains: flask's precision is lower because of test code whose receivers pyright cannot type
either (`app` fixtures without annotations), which graph-indexer binds by name as `likely` — counted
as false positives here; with `likely` and better only, flask is 0.929. Other differences: pyright
does not count uses through an import alias (`from m import A as B; B()`), graph-indexer does; an
assignment `self.x = …` that runs a base class's property setter is not counted as a use of it;
and attribute chains through untyped values (`proxy.url.raw_host`) stay unbound.

### The same measurement for Rust

```bash
rustup component add rust-analyzer
(cd test/fixtures/rust && cargo fetch)               # serde_json; resolves dependencies as rust-analyzer does
node bench/eval-graph-rust.mjs --n 150 --sample bench/rust-samples/rust.txt
node bench/eval-graph-rust.mjs --fixture ripgrep --fixture-dir DIR --n 150 --sample bench/rust-samples/ripgrep.txt
```

**Method.** The oracle is rust-analyzer (1.96.0), the Rust language server: its Find All
References comes from its own name resolution, trait solving and macro expansion over the cargo
workspace. As for Python, it binds `x.m()` to the method of x's type and a call through a trait
bound to the trait's method, so its answer is the **exact** oracle. `use` declarations and
declaration lines are excluded on both sides, and so are two kinds of reference it reports that do
not name the symbol: `Self` standing for a type, and the `fn` of each implementation of a trait
method. Code the build leaves out is excluded on both sides, since the oracle has no answer there:
`#[cfg]` code rust-analyzer reports as inactive with the default features, and whole files outside
the module tree (serde_json's `lexical/` and `raw.rs` sit behind `#[cfg(feature = …)] mod`). The
sample is frozen (`--sample`, one `path:line:qname` per line), so that two builds are scored on the
same symbols even when one of them finds more definitions.

Three repositories: serde_json 1.0.150 (the fixture, `a1ae73a`), ripgrep 14.1.1 (`4649aa9`, a
workspace of nine crates that use each other by name) and tokio 1.41.1 (`bb7ca75`, seven crates,
items declared inside `cfg_*! { … }` macros). Seed 7, 150 symbols each.

| repository | build | precision | recall | exact set | grep P | name-only P |
|---|---|---|---|---|---|---|
| serde_json (150 symbols) | before | 0.895 | 0.523 | 0.667 | 0.129 | 0.296 |
| | after | **0.955** | **0.841** | **0.807** | | |
| ripgrep (150) | before | 0.914 | 0.555 | 0.773 | 0.024 | 0.049 |
| | after | **0.941** | **0.768** | **0.880** | | |
| tokio (150) | before | 0.887 | 0.389 | 0.520 | 0.015 | 0.041 |
| | after | **0.930** | **0.582** | **0.600** | | |

(micro averages, graph-indexer's `exact` answer.) What the first run found, fixed in this order:

- **Macro arguments were opaque.** tree-sitter leaves a macro's arguments as a token tree, so
  `tri!(self.parse_integer(false))`, `assert_eq!(x.len(), 2)` and `format!("{}", v.name())` held
  no calls, and the items inside `cfg_rt! { pub struct Runtime … }` were not definitions. Before
  extraction, invocations whose arguments are plain Rust are now rewritten in place to text of the
  same length (`m!(a)` → `m (a)`, `m![a]` → an array, an item-position `m! { items }` → the items),
  each kept only if it parses cleanly on its own; macro definitions are left alone.
- **The crates of a workspace were external to each other.** `use tokio::sync::mpsc` in tokio's own
  tests, or `grep::cli::CommandReaderBuilder` in ripgrep, did not resolve, and those calls were
  dropped as library calls (110 of the 114 uses of tokio's `mpsc::channel`). Crate names now come
  from each `Cargo.toml` (`[package]`/`[lib]` name, `-` read as `_`).
- **Modules in the 2018 layout** (`util/rand.rs` next to `util/rand/`) were not found from their
  children (`use super::RngSeed` in `util/rand/rt.rs`), and **`use a::b::chan`** resolved to the
  module that declares `chan` rather than to `chan.rs`: `chan::channel()` was then bound, at 0.95,
  to the `channel` that `a::b` re-exports from elsewhere.
- **Paths were read by their last name only.** `crate::Parser::new()`, `super::f()`,
  `other_crate::m::T` and `alias::sub::f()` are now walked module by module; the type in
  `Type::new()` and `Enum::Variant` counts as a use of the type; `de::Deserializer` (serde's
  trait) is no longer the repository's `Deserializer`; a unit struct used as a value (`&Mmap`)
  is a use.

**What is still missed** (from the debug output): receivers whose type only inference knows —
builder chains (`builder.line_terminator(…).dot_matches_new_line(…)`), values returned by a chain
of calls, calls on generic parameters (`T::when(item)`) and through trait bounds — and macros whose
arguments are not plain Rust (`select!`, `matches!` with patterns). As elsewhere, these lower recall
and do not produce wrong answers. The extras that remain are mostly calls through a primitive or a
generic parameter (`f64::to_bits(self)`, `R::byte_offset(self)`) bound by name to a repository
method with that name.

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

## The arena: other tools, measured the same way

`bench/arena/` scores any code-intelligence tool that has an MCP server against the same oracles
and samples as graph-indexer. Each tool is an entry in `bench/arena/systems.json` (start from
`systems.example.json`): how to start its server and build its index, which tool answers "where is
X used" and with which arguments. Nothing about a tool is assumed: `arena.mjs tools --system NAME`
lists what its server offers, and the entry is written from that.

```bash
node bench/arena/arena.mjs tools --system "NAME" --repo test/fixtures/nestjs
node bench/arena/arena.mjs exactness -- --n 150                   # TypeScript and Python oracles
node bench/arena/arena.mjs speed --repos test/fixtures/nestjs,test/fixtures/fastapi
```

`bench/arena/systems.json` holds the entries used below; `systems.example.json` is the template
for a new one.

A tool is scored on the `path:line` locations its answer names, in any of three shapes (`file:line`
inline, JSON objects with a file and a line, or a file heading followed by indented line numbers),
with import lines left out as for every system. An entry may declare `stopAt` (where the answer's
own list ends and notes about candidates begin) and `ignoreLines` (single lines such as a header
naming the definition itself); both are in the entry, in the open. The answer's median size in
tokens is reported next to its accuracy: an exact list that does not fit in an agent's context is
not an answer.

**Check of the harness.** graph-indexer's own MCP server, entered as an external tool, scores within
0.007 of its native row on nestjs (dispatch oracle, 150 symbols: precision 0.993 vs 1.000, recall
0.889 vs 0.889, exact sets 0.913 vs 0.919). On fastapi its micro recall is lower (0.806) only
because `find_references` returns at most 500 uses and `FastAPI` has 743: per-symbol recall agrees
(0.990 vs 0.996). Results for other tools are published only from runs with their own maintainers'
recommended installation; entries that a tool's maintainers correct are welcome.

### CodeGraph and codebase-memory-mcp (2026-10-11)

Versions and installation, each as its README recommends, into `bench/arena/.tools` (git-ignored)
rather than globally, and without running either tool's agent installer, which rewrites agent
configuration:

```bash
npm i --prefix bench/arena/.tools/codegraph @colbymchenry/codegraph@1.6.2      # "Already have Node? Use npm"
mkdir -p bench/arena/.tools/cbm/x && cd bench/arena/.tools/cbm                  # pre-built binary, checksum from the release
curl -LO https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.11.0/codebase-memory-mcp-darwin-arm64.tar.gz
curl -LO https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.11.0/checksums.txt
shasum -a 256 -c --ignore-missing checksums.txt && tar xzf codebase-memory-mcp-darwin-arm64.tar.gz -C x
```

How each one is asked "where is X used", from what its server lists (`arena.mjs tools`):

- **CodeGraph 1.6.2** exposes only `codegraph_explore` by default; its README documents
  `CODEGRAPH_MCP_TOOLS` to list the others, and the entry enables them to call
  `codegraph_callers` (symbol, `file` to pick the definition, `limit` 500). Telemetry is off
  (`CODEGRAPH_TELEMETRY=0`) and the background daemon too (`CODEGRAPH_NO_DAEMON=1`, documented):
  the daemon left by one session watched the fixtures and re-indexed them while the next
  measurement deleted and rebuilt its index. The answer lists the referencing declarations, each at
  its first line (a whole file at line 1 for module scope and imports), not the lines of the uses.
- **codebase-memory-mcp 0.11.0** stores its graph under `CBM_CACHE_DIR` (set to
  `bench/arena/.tools/cbm/cache`). Its `trace_path` answers with qualified names only, without
  files or lines, so the entry uses its read-only Cypher tool, `query_graph`, over the incoming
  `CALLS`, `USAGE`, `CALL_REFERENCE`, `INHERITS` and `IMPLEMENTS` edges of the sampled
  definition. A `CALLS` edge carries the line of a call; the other edges carry none, and their
  answer is the referencing declaration's range. This is the most exact answer its graph holds;
  an agent following its instructions would more often call `trace_path`.

An answer that names declarations rather than lines is read as for graph-indexer 2.x: a
declaration's lines are those inside it that contain the name as a word, outside comments and
string literals. For CodeGraph a declaration's extent is taken from the parsed source (syntax,
the same for any parser); codebase-memory-mcp returns its own ranges. The file-level rows need no
such reading.

nestjs, TypeScript dispatch oracle, 149 symbols (seed 7):

| system | precision | recall | exact set | file P / R | median answer |
|---|---|---|---|---|---|
| graph-indexer (MCP) | **0.993** | **0.886** | **0.913** | **0.991 / 0.879** | 310 tokens |
| CodeGraph 1.6.2 | 0.743 | 0.755 | 0.510 | 0.719 / 0.699 | **80 tokens** |
| codebase-memory-mcp 0.11.0 | 0.559 | 0.263 | 0.322 | 0.765 / 0.418 | 96 tokens |
| grep | 0.140 | 1.000 | 0.255 | 0.209 / 1.000 | |

fastapi, pyright oracle, 150 symbols (seed 7):

| system | precision | recall | exact set | file P / R | median answer |
|---|---|---|---|---|---|
| graph-indexer (MCP) | **0.997** | **0.826** | **0.927** | **0.997 / 0.848** | 189 tokens |
| CodeGraph 1.6.2 | 0.652 | 0.363 | 0.480 | 0.911 / 0.333 | **70 tokens** |
| codebase-memory-mcp 0.11.0 | 0.929 | 0.571 | 0.493 | 0.964 / 0.645 | 96 tokens |
| grep | 0.273 | 1.000 | 0.380 | 0.434 / 1.000 | |

(micro averages; per-symbol macro recall is 0.961 / 0.824 / 0.503 on nestjs and 0.987 / 0.798 /
0.654 on fastapi, in the same order.) Raw output: `bench/results/arena-exactness.txt` after a run.

Cold index (`arena.mjs speed`, three runs each, all three identical to ±0.3 s; Apple Silicon,
nothing else running). Each tool's index is deleted before its run:

| system | nestjs (1,641 files) | fastapi (1,215 files) | index size nestjs / fastapi |
|---|---|---|---|
| graph-indexer | **1.9 s** | **1.2 s** | **13.2 / 7.8 MB** |
| CodeGraph 1.6.2 | 3.0–3.3 s | 3.1–3.2 s | 47.8 / 25.3 MB |
| codebase-memory-mcp 0.11.0 (default `full` mode) | 11.8–12.1 s | 12.6 s | 27.8 / 76 MB (cache directory) |

**Where graph-indexer loses.** Its answers are the largest: 310 tokens median on nestjs against 80
and 96, because it lists every use with its line while the others list fewer, coarser entries:
for a question whose answer is "the five callers" an agent reads more text. Its MCP `find_references` stops at 500 uses (fastapi's `FastAPI` has 743),
which is why its micro recall through MCP (0.826) is below its native one (0.998).

**Notes on the others, from these runs.** CodeGraph's `codegraph_callers` returns at most 100
callers whatever `limit` asks for, and says "100 found" (its CLI returned 133 for nestjs'
`Module`); calls only, so a class or interface used as a type is not a caller. Its low recall on
fastapi has not been broken down yet. codebase-memory-mcp keeps at most one `CALLS` edge per
caller and callee, with the line of the first call (`isUndefined` called on lines 17 and 18 of
`get-injection-providers.util.ts`: one edge, line 17), so further calls from the same function
are missed; its precision on fastapi (0.929) is the closest to graph-indexer's.
The session axis (cost and turns of real agent runs with each tool) is not measured yet.

## Dependency injection (NestJS)

`@Inject(TOKEN)` hands a class whatever a module registered as `{ provide: TOKEN, useClass |
useExisting | useFactory | useValue }` (or `ClientsModule.register([{ name: TOKEN }])`); its declared
type is often an interface, so no compiler answers "what does this receive". There is no oracle,
so the edges were checked by hand: every injection point in Twenty's server and in the nestjs
repository (its packages and samples), 40 in all, was read together with each provider claimed
for it and searched for providers not claimed (an independent reading of the code, by an agent
told to be strict and to quote every line it marked wrong).

| | count |
|---|---|
| injection points | 40 |
| provider claims (injection → provider) | 45 |
| claims wrong | **0** |
| injection points whose provider is in the repository but not found | 1 |
| injection points with no provider in the repository (library tokens such as `REQUEST`, `CACHE_MANAGER`) | 4 — reported as such |
| class tokens (a class is its own provider) | 7 — reported as such |

The first reading found four providers missed; all four are now found (`ClientsModule` clients, a
token written `provider.provide`, and a string token given once as a constant and once as
`Reflector.name`). The one still missed is computed at run time:
`Object.values(CacheStorageNamespace).map(ns => ({ provide: ns, … }))`. Test files are left out
(their providers are mocks). Where a token has several providers (`forRoot` and `forRootAsync`,
or one per module) all are listed: which one a given module receives depends on what it imports.

## Dependency injection (Spring)

A Spring injection point — an `@Autowired`, `@Inject` or `@Resource` field or setter, a
component's constructor parameter, a `@Bean` method's parameter, a final field under Lombok's
`@RequiredArgsConstructor` — declares a type, usually an interface; Spring gives it the bean of
that type, choosing by `@Qualifier`, `@Primary` and then the parameter's name, among the beans of
the application the class belongs to. graph-indexer reads the beans (component classes, `@Bean`
methods by return type, registered `@ConfigurationProperties`, and as generated proxies Feign
clients, Spring Data repositories and MyBatis mappers), works out which build module belongs to
which application from `pom.xml` / `build.gradle`, and resolves each point. There is no oracle, so
every claim was checked by an independent reading of the code (an agent told to be strict and to
quote the lines proving each error), on four applications: spring-petclinic (`a2c2ef9`),
piggymetrics (`6bb2cf9`, seven services), jhipster-sample-app (`6b000b5`) and mall (`dcaa93b`,
five modules, two applications sharing a security library).

| | petclinic | piggymetrics | jhipster | mall |
|---|---|---|---|---|
| injection points (first reading) | 6 | 24 | 48 | 234 |
| injection points (after the fixes) | 6 | 24 | 49 | 233 |
| claims wrong at the first reading | 0 | 0 | 0 | 3 |
| injection points missed at the first reading | 0 | 0 | 1 | 0 |
| points whose bean is not in the repository (library or auto-configured: `Environment`, `JavaMailSender`…) — reported as such | 0 | 5 | 29 | 7 |

The first version made the four errors fixed since: it took a `@ConfigurationProperties` class
nothing registers for a second bean (a false "ambiguous", twice), it resolved a field in a class
whose `@Component` is commented out, and it missed the constructor of the `@SpringBootApplication`
class. After the fixes the four outputs differ from the first in exactly those four lines (two
corrected, one removed, one added: 312 points either way). Before that reading, a check by hand
on the same repositories had found three faults: beans of one service offered to another (piggymetrics), an application's
bean not offered to the shared library it includes (mall), and a module (`mall-demo`) taken as
including a library its `pom.xml` does not list. Every `@Autowired`, `@Inject` and `@Resource` in
the non-test code of mall (223) and piggymetrics (24) is found. Not modelled: custom stereotype
annotations, XML configuration, profiles and conditions beyond naming them, and generics as
qualifiers.

## Components in Vue and Svelte templates

A `.vue` or `.svelte` file's `<script>` is indexed as TypeScript, and each tag in its template of
a component the script imports (`<UserCard>`, `<user-card>`) is a use of that component, bound
through the import like a call. There is no compiler oracle here either (vue-tsc and svelte-check
need each project's dependencies installed), so the check is two-fold: for a tag whose import
names a `.vue`/`.svelte` file directly, the bound definition must be that file (checked by
script, every tag); for a tag imported through barrels and workspace packages, a sample was
followed by hand by an independent reader (an agent with its own resolver, quoting each chain).

| | open-webui (`f8ae8a6`, Svelte) | vue-vben-admin (`4634655`, Vue) |
|---|---|---|
| component files | 701 | 693 |
| template tags of components imported from the repository | 3,604 | 1,179 |
| … found and bound | 3,602 | 1,178 |
| … imported from the file directly: bound to that file | 3,602 / 3,602 | 207 / 207 |
| … through barrels or workspace packages: checked by hand (sample of 80) | — | 80 / 80 correct |
| tags of library components (left out, as for any library) | 31 | 959 |

Found while measuring, and fixed: SvelteKit's `$lib` and `kit.alias` (defined in a generated
tsconfig the repository does not carry), `package.json` `imports` (`#/*`), `export { default as X }
from './x'`, anonymous `export default function () {}` not counted as exported, and a default
import resolved by the importer's name to whatever the module itself imported under that name.
The last three touch TypeScript too; the compiler oracles of every language give the same scores
as before. Library components re-exported through a workspace package (lucide icons through
`@vben/icons`) are recognised as library ones: 125 of vben's tags. Not modelled: components
registered globally (`app.component(…)`, Nuxt's auto-imports) and dynamic ones
(`<component :is>`, `<svelte:component>`).

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
