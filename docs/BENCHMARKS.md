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

**The sample is frozen since 2026-11-15** (`--sample bench/ts-samples/nestjs.txt`, the 400 symbols
drawn with seed 11 by 3.1.0). nestjs keeps the interfaces it restates from other libraries in
directories called `external/`, which were not indexed before
([CHANGELOG](../CHANGELOG.md)); once they are, the seeded draw picks other symbols, and two builds
would be scored on different samples. On the frozen sample this build scores what 3.1.0 scores:
0.997 / 0.962 / 0.920.

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

**2026-11-10: block scopes and table-driven tests.** Two things the debug output of the oracle and
the rename tasks on caddy ([below](#rename-alone-on-the-refactor-tasks)) showed, measured on the
same samples (seed 7):

| repository | build | precision | recall | exact set |
|---|---|---|---|---|
| gin (146 symbols) | 3.1.0 | 1.000 | 0.981 | 0.986 |
| | now | 1.000 | **0.982** | **0.993** |
| caddy (196) | 3.1.0 | 1.000 | 0.972 | 0.934 |
| | block scopes | 1.000 | 0.975 | 0.949 |
| | now | 1.000 | **0.978** | **0.964** |
| nats-server (199) | 3.1.0 | 0.992 | 0.978 | 0.935 |
| | now | 0.992 | **0.983** | **0.945** |

- **A name declared again in an inner block erased its type in the whole function.** In
  `func (r AsciiJSON) Render(…) { r.WriteContentType(w); … for _, r := range s { … } }` the loop's
  `r` and the receiver `r` were two bindings of one name in one scope, which is a conflict and
  yields no type, so the call on the receiver stayed unbound. Blocks, `for`, `if`, `switch` and
  `select` statements and their cases are scopes of their own now, as Rust's are.
- **Table-driven tests were untyped.** `for _, tc := range []struct{ require ResponseMatcher; … }{…}`
  and `tests := []struct{…}{…}; for _, tt := range tests` declare a struct type in place: the
  fields of `tc` and `tt` now have the types written there (also for maps and arrays of such
  structs, and for a single `x := struct{…}{…}`).

The same block scoping measured for TypeScript (nestjs, seed 11) and Java (the three repositories)
changed no figure, so it was not kept there. Every other repository's index is unchanged, fact for
fact, but for eight references of Commons Collections (23 checkouts compared with 3.1.0: 19
identical, the three Go ones gain bound references — gin 25, caddy 56, nats-server 1,254).

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
| | now | **0.992** | **0.943** | **0.846** | | |
| commons-collections (200) | before | 0.878 | 0.791 | 0.725 | 0.015 | 0.097 |
| | after | **0.955** | **0.861** | **0.805** | | |
| | now | **0.961** | **0.883** | **0.825** | | |

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

"Now" is 2026-11-09 (spring-petclinic unchanged): calls record the types their arguments show
(literals, typed locals and fields, `new`, casts, array elements, `"a" + x`), and among the
overloads of one arity the resolver keeps those the types fit, an exact type before a widening or
boxing (`append('-')` is `append(char)`); a single-type import from a library package (`import
java.io.UncheckedIOException;`) is no longer a same-name class of the repository; and
`Outer.this.m()`, `new Node(…)` inside `Node` and nested types named through their outer class
(`Token.TokenType.EOF`) are uses.

**2026-11-15** (same samples; "before" is the "now" above):

| repository | build | precision | recall | exact set |
|---|---|---|---|---|
| spring-petclinic (111 symbols) | before | 0.994 | 0.989 | 0.973 |
| | now | **1.000** | **0.995** | **0.991** |
| jsoup (188) | before | 0.992 | 0.943 | 0.846 |
| | now | **0.996** | **0.965** | **0.899** |
| commons-collections (200) | before | 0.961 | 0.883 | 0.825 |
| | now | **0.991** | **0.904** | **0.885** |

- **A signature that began with an annotation** (`@Override` on its own line above a bodyless
  `boolean add(E e);`) was stored as `@Override`: the method had no readable parameters and fitted
  any call. Signatures of up to 800 characters are kept where each overload is a method of its own
  (240 cut the parameter list of annotated generic methods).
- **Varargs.** `T... xs` is an array, and a call whose last argument is an array reaches the
  variadic overload, not the fixed one javac's first phase would otherwise prefer; `f(x)` inside
  `f(T... xs)` may be another overload, not a call of itself.
- **Static imports** (`import static pkg.Type.m;`, `import static pkg.Type.*;`) bind to the static
  members of the type, inherited ones included.
- **A method's family is told by parameter types too**: `putAll(Map)` does not override
  `putAll(MultiValuedMap)`, and a field is no override of a method of its name.
- **An inner class calls its outer class's methods** (the lookup goes outwards, JLS 15.12.1); an
  enum constant with a body is a value of the enum, so `InBody.process(…)` names the enum's
  method; of a field and a method with one name, a call takes the method and a read the field.
- **An override reached through a second interface** wins over what the first one inherits
  (`OrderedBidiMap extends BidiMap, OrderedMap`: `mapIterator()` is `OrderedMap`'s). This alone
  moved Commons Collections' precision from 0.958 to 0.991.
- A library collection whose element type the index cannot hold (`Deque<Iterator<? extends E>>`)
  is still the library's, not a type of the repository.

Commons Collections' recall stays at 0.904 for the reason given below: 65 of its 69 missed lines
(8 of jsoup's 33) are `super.m()` calls, which the oracle counts for every override of `m` and the
index binds to the parent's `m` alone. With that rule switched off, to see its size and not to
ship, recall is 0.993 (jsoup 0.973) at the same precision.

**What is still missed.** Overloads that take the same number of arguments of types the source
does not show (a method's result, another class's constant), calls through a library interface, and lambdas typed only by the
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

**2026-11-09.** A call or value a module neither defines nor imports is a `NameError` in Python;
it was bound by name to a definition anywhere in the repository. It no longer is (unless a star
import from outside the index may have brought the name; types are still looked up, since an
annotation may name a type imported only under `TYPE_CHECKING`), and names inside tuples and sets
are uses (`(InvalidSchema, "x")` in a parametrize list). flask: precision 0.871 → 0.895 (recall
0.929 → 0.927); requests: recall 0.967 → 0.987; click: exact sets 0.910 → 0.917; the other three
unchanged.

"Now" is 2026-10-11, after three more fixes found on flask and click: an absolute import resolves
only from an import root (`import json as _json` inside `flask/json/` had been bound to that
package rather than the standard library); `import click.utils` also binds `click`, the package
(click's tests that write `click.open_file(…)` after it had none of those uses bound); and names
inside the subscripts of qualified generics (`t.Optional[Command]`, `t.Callable[[Ctx], "Group"]`)
are type references. (On this machine the "after" build reproduces every row except flask's exact
set, 0.707 instead of 0.713; "now" is measured against that.) fastapi is unchanged (0.997 / 0.998 / 0.940); no Python repository lost
precision or recall.

**2026-11-15** ("before" is the 2026-11-09 build; rich was only read for its headline figures):

| repository | build | precision | recall | exact set |
|---|---|---|---|---|
| fastapi (150 symbols) | before / now | 0.997 | 0.998 | 0.947 |
| flask (150) | before | 0.895 | 0.927 | 0.753 |
| | now | **0.961** | **0.976** | **0.853** |
| requests (149) | before | 0.954 | 0.987 | 0.886 |
| | now | 0.954 | **0.993** | **0.913** |
| httpx (150) | before | 0.998 | 0.950 | 0.800 |
| | now | **0.999** | **0.970** | **0.873** |
| rich (144) *(held out)* | before | 0.992 | 0.974 | 0.861 |
| | now | 0.992 | **0.979** | **0.896** |
| click (144) | before | 0.971 | 0.980 | 0.917 |
| | now | **0.994** | 0.980 | **0.931** |

- **An import inside a function binds in that function only.** One flask test's `from blueprintapp
  import app` had made `app` that import for the whole file.
- **`name.attr` is a use of `name`**, whatever its letter case (`run_command.make_context`).
- **A parameter without an annotation that is assigned a typed value** (`def f(app): app = Flask()`)
  has that type from the assignment on; an annotated name keeps its declared type through later
  assignments; `a, b, c = f()` types each name when `f` returns `tuple[A, B, C]`.
- **Properties.** `@x.setter` is a read of the property `x`, and `self.x = v` in a class that
  declares no `x` runs the setter of a base class's property: a use of it.
- **`pkg.sub.X` binds only once some module imports `pkg.sub`**; a submodule nobody imports is an
  `AttributeError`. This is Python's rule, and here the index and the oracle part ways on purpose.
  pyright wants the import in the file that writes `pkg.sub` or in the package's `__init__`, and
  the rule was first written that way: requests reached 0.975 precision. But
  `requests.cookies.RequestsCookieJar()` after a plain `import requests` runs — `requests/__init__`
  imports `sessions`, which imports `cookies` — and requests' tests are full of it; with pyright's
  rule those uses were not found, and `check` stopped seeing a caller it had seen before
  (sqlglot's `optimizer.pushdown_projections.pushdown_projections(…)`, a ripple of the `check`
  benchmark). Nine of requests' extra lines are such uses.
- **A module's function named as a value** (`requests.get` in a tuple) is a use.
- **A member called on an untyped parameter of a test function is not bound by name.** The test
  runner fills such a parameter in (a pytest fixture, a parametrized value); nothing in the
  repository's calls says what it is, and giving the call to the one class that happens to declare
  a member of that name was wrong far more often than right (flask's extra lines went from 58 to
  22). The same guess is kept outside tests: dropping it everywhere lost real references on rich
  and click, and was reverted. Resolving a fixture parameter to what its `@pytest.fixture`
  function returns is the real answer; pyright does not see fixtures, so this oracle cannot
  confirm it, and it has not been built.

flask and requests do not reach 0.99 precision. Of flask's 22 extra lines, 13 are in `examples/`,
which flask's own pyright configuration leaves out (the oracle cannot report them), and most of the
rest are chains through untyped values that graph-indexer follows by its own return-type inference
and pyright does not. Of requests' 26, nine are the submodule uses above and two are uses through
an import alias, which pyright's reference search skips; the rest are such chains.

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

**Second round (2026-11-09, rust-analyzer 1.99.1).** rust-analyzer 1.9x reports inactive code
through pull diagnostics (`textDocument/diagnostic`) and as `inactive_code`; the oracle listened
for pushed `inactive-code` only, saw no inactive line, and counted the uses in `#[cfg]`-disabled
items and files (tokio's `rt_unstable_metrics.rs`, 20,195 lines in all) as graph-indexer's false
positives. It now reads both. The samples are the frozen ones of `bench/rust-samples/`; the
symbols that sit in inactive code drop out of them (8 of serde_json's). "Before" is the build
above, measured again with this oracle; on ripgrep and tokio it reproduces the "after" rows:

```bash
node bench/eval-graph-rust.mjs --fixture tokio --fixture-dir DIR --features full --n 150 --sample bench/rust-samples/tokio.txt
```

| repository | build | precision | recall | exact set |
|---|---|---|---|---|
| serde_json (142 symbols) | before | 0.955 | 0.841 | 0.807 |
| | now | **0.968** | **0.925** | **0.866** |
| ripgrep (150) | before | 0.941 | 0.768 | 0.880 |
| | now | **0.990** | **0.942** | **0.907** |
| tokio (150) | before | 0.929 | 0.582 | 0.613 |
| | now | **0.975** | **0.799** | **0.733** |

What the debug output showed, fixed in this order:

- **Every `impl RegexMatcher` was a member of every `RegexMatcher`.** ripgrep has four, one per
  crate; methods declared in impl blocks were matched to a type by its name alone, so
  `RegexMatcher::new` in the printer crate bound to the test helper's (0 of 96 uses found). An
  impl's owner is now the type its own file resolves under that name, or one of the same Cargo
  package. `impl Trait for &'a mut T` had made the owner the text `&'a mut T`.
- **A bare name was taken for a method**: a parameter `path` passed as an argument bound to the
  method `path` of an impl block in the same file, and `suffix!` to a method through `use
  super::*`. Methods are no items of their module.
- **`mod runtime; pub use runtime::Runtime;`** (a 2018 path through a child module) was read as an
  external crate, so nothing in tokio's tests reached `Runtime`.
- **Types the extraction did not follow**: tuples (`let (tx, rx) = channel()`, `for (i, x) in
  xs.iter().enumerate()`, `self.0`), wrappers built in place (`Arc::new(x)`, `Pin::new(&mut x)`), a
  crate's own `Mutex` (not a transparent wrapper), type parameters (`R: Read`, a field `formatter:
  F` under `impl<W, F: Formatter>`), enum patterns (`Value::Object(map) =>`, `other =>`, `if let
  Some(x)`), `Self::new()`, sequential shadowing with block and match-arm scopes, and methods such
  as `upgrade()` or `get_mut()` that keep the value only when its type has no method of that name.

**Third round: calls through traits (2026-11-09, rust-analyzer 1.99.1).** Same oracle and frozen
samples; "before" is the second round's "now":

| repository | build | precision | recall | exact set |
|---|---|---|---|---|
| serde_json (142 symbols) | before | 0.968 | 0.925 | 0.866 |
| | now | **0.974** | **0.947** | **0.899** |
| ripgrep (150) | before | 0.990 | 0.942 | 0.907 |
| | now | **0.990** | **0.944** | **0.912** |
| tokio (150) | before | 0.975 | 0.799 | 0.733 |
| | now | **0.981** | **0.838** | **0.747** |

- **Several bounds.** `W: AsyncWrite + AsyncSeek` kept only the first trait, so tokio's
  `AsyncSeek::poll_complete` had 0 of its 19 uses; a value bound by several traits now has the
  methods of each (`A + B` in type parameters, `where` clauses, `impl A + B`, `dyn A + B`), also
  through a field typed by the parameter (`me.inner` with `inner: W`), a method returning it
  (`get_pin_mut()` → `Pin<&mut R>`) and pin-project's `self.project()`. 17 of 19 now.
- **Trait-path calls.** `ser::SerializeSeq::serialize_element(self, v)`, `Debug::fmt(n, f)`,
  `AsRawFd::as_raw_fd(self)` and `<T as Trait>::m(x)` reach the method of the impl of that trait
  for the first argument's type (or `T`). Each method knows the trait of its impl block, so a type
  with `Debug::fmt` and `Display::fmt` has two methods, not one redeclared.
- **A trait method's uses include its implementations'.** rust-analyzer counts `a.to_addrs()` on a
  concrete `V4` as a use of the trait's `to_addrs`; so does graph-indexer now.
- **Impls of one type stay apart.** Methods of one name in impls of different types or traits
  (`impl AsyncWrite for Cursor<Vec<u8>>` and `… for Cursor<&mut [u8]>`) were merged as
  redeclarations; they are now merged only within impls of one type (`#[cfg]` variants), and
  `self.flush()` reaches the flush of its own impl block. A call on a value reaches `impl
  IntoIterator for Map`, not the impl for `&'a Map`.
- **Blanket impls.** `impl<M: Matcher> Matcher for &M` (and `… for Box<M>`) belongs to the trait:
  `(*self).find_at(at)` inside it is the trait's method. `f32::to_bits(self)` inside `impl Float
  for f32` is the primitive's own method, not a call of itself.

**Fourth round (2026-11-15, rust-analyzer 1.99.1).** Same oracle and frozen samples; "before" is the
third round's "now":

| repository | build | precision | recall | exact set |
|---|---|---|---|---|
| serde_json (138 symbols) | before | 0.974 | 0.947 | 0.899 |
| | now | **0.993** | 0.947 | **0.920** |
| ripgrep (148) | before | 0.990 | 0.944 | 0.912 |
| | now | 0.990 | **0.948** | **0.919** |
| tokio (150) | before | 0.981 | 0.838 | 0.747 |
| | now | **0.990** | **0.906** | **0.813** |

- **Names that are std's in one file and the crate's in another.** `use tokio::sync::Mutex;` names
  tokio's `Mutex`, a crate's own `LinkedList` or `HashMap` is not the std collection, `fs::f()` is
  the crate's `fs` when the file imports one, and `Arc` reached through a crate path
  (`crate::loom::sync::Arc`) is still a pointer to its contents (tokio's `Arc<Shared>` fields had
  no type). The other way round, `std::fs::DirEntry` is std's, not the repository's `DirEntry`,
  and a bound imported from another crate (`use bytes::Buf; … B: Buf`) is not the repository's
  type of that name.
- **A module brought in by a glob starts a path**: after `use tokio_util::codec::*;`,
  `length_delimited::Builder::new()` is found.
- **A method call never selects a field** (a builder's field and its setter share a name), a
  parameter typed `Self` (`me: &Arc<Self>`) is of the impl's type, a turbofish call
  (`channel::<u8>(1)`) types its value, and a primitive-typed local (`value: f32`) is typed, so
  `value.classify()` is no longer the repository's one `classify`.
- **Impls of one trait that differ in a parameter type** (`impl From<f32> for Value`, `impl
  From<bool> for Value`) are told apart by the argument's type. `Value::from(x)` was bound to the
  first of them whatever `x` was. Calls now record the types their arguments show, as Java's do
  (literals with their suffixes, `"s"` and `b"x"`, `vec![…]`, `String::from(…)`, `&x`, `&x[..]`,
  `x.clone()`, typed locals, parameters and fields, constructions of a repository type), and the
  call reaches the one impl whose parameter takes them; when the source does not show the type,
  or more than one impl still fits (an unsuffixed integer fits every integer impl), it is left
  unbound and counted among the calls an answer could not bind. This is where serde_json's
  precision comes from. The first version of the rule only left such calls unbound, and what
  that costs on code built around these impls showed on bytes, below.

What remains: receivers typed by a constructor of a library type (`SocketAddrV4::new(ip,
port).to_socket_addrs()`), calls on a reference the index does not tell from the value (`map` of
type `&Map`), `self[..]`, and macros whose arguments are not plain Rust (`async_assert_fn!`).

### Repositories nobody had looked at (2026-11-15)

The fixes above were found on the repositories above. To see what carries over, repositories
that had never been indexed were cloned at a tag, a sample was drawn once and frozen, and the
build before this pass and the build after it were each run once on it:

```bash
node bench/eval-graph-java.mjs --fixture gson --fixture-dir DIR --src gson/src/main/java --n 200 --sample bench/java-samples/gson.txt
node bench/eval-graph-python.mjs --fixture urllib3 --fixture-dir DIR --scope src/urllib3/ --n 150 --sample bench/python-samples/urllib3.txt
node bench/eval-graph-rust.mjs --fixture arrayvec --fixture-dir DIR --n 150 --sample bench/rust-samples/arrayvec.txt
node bench/eval-graph-rust.mjs --fixture bytes --fixture-dir DIR --n 150 --sample bench/rust-samples/bytes.txt
# gson-parent-2.11.0, urllib3 2.2.3, arrayvec 0.7.6, bytes v1.9.0; for the two Rust crates the
# dependency tables are removed from Cargo.toml, so nothing is fetched
```

| repository | oracle | build | precision | recall | exact set |
|---|---|---|---|---|---|
| gson 2.11.0 (199 symbols) | javac, dispatch | before | 0.939 | 0.983 | 0.905 |
| | | now | **0.991** | **0.987** | **0.940** |
| urllib3 2.2.3 (150) | pyright | before | 0.966 | 0.975 | 0.780 |
| | | now | 0.966 | 0.980 | **0.827** |
| arrayvec 0.7.6 (150) | rust-analyzer | before | 0.960 | 0.751 | 0.673 |
| | | now | 0.964 | 0.759 | **0.700** |

Java carries over in full. Python and Rust carry over in the direction and a fraction of the size
seen on the development repositories: what was fixed there were mostly their own idioms. (urllib3
was run a second time, after the submodule rule above went back to Python's: 0.968 precision with
pyright's rule, 0.966 with Python's, the rest the same.)

**bytes, and a fault of this pass.** The first Rust repository measured this way was bytes 1.9.0,
and it is not in the table because it stopped being unseen. Run once like the others it gave
0.666 / 0.844 / 0.633 before and 0.904 / 0.732 / 0.633 after: 24 points of precision gained, 11 of
recall lost. The debug output, read after the run, said why. bytes has four `impl From<…> for
Bytes` and as many for `BytesMut` and `Vec`. The build before bound every `Bytes::from(x)` to one
of the four, so that one had all its uses and the uses of the other three, and those three had
none; the rule as first written in this pass bound none of them. Neither is right, and the second
is no better for someone asking who uses `From<Vec<u8>>`. Recording the types of the arguments of
Rust calls (the fourth round's last point) was done because of this, with bytes as a development
repository from then on: 0.939 / 0.859 / 0.673, and serde_json, ripgrep and tokio unchanged. What
bytes still misses is a constant passed as the argument (`Bytes::from(LONG)`: constants carry no
type), a local initialised from a method's result, and impls whose parameter is itself generic
(`impl Extend<u8>`, `Extend<&u8>` and `Extend<Bytes> for BytesMut`, all `extend<T>(&mut self,
iter: T)`). arrayvec was cloned after that, as the repository that had not been looked at.

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
### The session axis (2026-10-12)

What a tool's exactness is worth in an agent's session is measured in
[AGENTIC-BENCHMARK.md](AGENTIC-BENCHMARK.md#against-other-tools-in-real-sessions-arena1-34-tasks-170-runs):
Claude Code (Sonnet 5.5) with each tool installed by its own installer (there the installers do
run, into each run's repository) and Serena 1.7.0 as a third tool, on 34 tasks. Paired by task,
graph-indexer cost 0.65 / 0.74 / 0.87 of CodeGraph on questions, refactors and issues, 0.79 /
0.91 / 0.96 of codebase-memory-mcp and 0.87 / 0.93 / **1.12 of Serena (it loses on issues)**,
and answered all 11 questions exactly against 9–10. The larger answers above do not make its
sessions dearer: on code questions its arm is the cheapest of the five.

### zvec-grep 0.3.0 (2026-11-06)

[zvec-grep](https://github.com/zvec-ai/zvec-grep) is a semantic grep: hybrid BM25 + vector search
over chunks of code and documents. It has no references or call graph, so the questions of
section 1 do not apply to it; there an agent with zvec-grep is left with grep (precision 0.128
against graph-indexer's 0.997 on nestjs). What it does is search, and that is measured here on
graph-indexer's two search benchmarks (sections 2 and 3), with zg's default `--hybrid` search
through its own CLI ([`bench/zvec-client.mjs`](../bench/zvec-client.mjs)).

```bash
npm pack @zvec/zvec-grep-darwin-arm64@0.3.0 && tar -xzf zvec-zvec-grep-darwin-arm64-0.3.0.tgz   # checked against package/checksums.json
~/MLXServer/.venv/bin/python -I bench/embed-server.py --port 47812                              # Qwen3-Embedding-0.6B (MLX, 8-bit) on loopback
Z="--zvec bench/arena/.tools/zvec/bin/zg --zvec-upstream http://127.0.0.1:47812/v1/embeddings"
ZVEC_GREP_EMBEDDING_CONCURRENCY=1 node bench/eval-search.mjs $Z [--zvec-code-only]
ZVEC_GREP_EMBEDDING_CONCURRENCY=1 node bench/eval-localize.mjs --n 40 $Z [--zvec-code-only]
node bench/eval-search.mjs --zvec bench/arena/.tools/zvec/bin/zg --zvec-embedding local/potion-code-16m-v2
```

- **Embeddings.** zvec-grep's default local model is Qwen3-Embedding-0.6B (a GGUF it runs with
  llama.cpp). The same model ran here in MLX (`mlx-community/Qwen3-Embedding-0.6B-8bit` at a
  pinned revision, served on this Mac by `bench/embed-server.py`), reached through zg's
  OpenAI-format remote slot and a loopback proxy that adds Qwen3's query instruction to queries
  and nothing to documents, as zg does for its local Qwen3. That is why the logs name the slot,
  `qwen/text-embedding-v4`; nothing left the Mac. The 8-bit weights are not zg's GGUF, so its own
  setup may score slightly differently. A second run used `local/potion-code-16m-v2`, the static
  model in zg's catalog.
- **Code only.** zg also indexes documents and plain text. `--zvec-code-only` passes
  `--category code`, which only helps it on these code questions; both are reported.
- **Scoring.** zg answers with `path:start-end` chunks. Its first 30 are mapped to the symbols
  they span in graph-indexer's index of the same snapshot (a chunk counts for the symbols at least
  half inside it, or the innermost symbol holding it), and scored exactly as graph-indexer.
- **Runs.** 26,264 texts embedded in 3,553 requests for search, 0 errors. zg's embedding client
  gives up on a request after 60 s, which two processes sharing the model on this M2 exceeded, so
  the runs used `ZVEC_GREP_EMBEDDING_CONCURRENCY=1`. Index times are therefore not comparable
  (from 20 to 66 minutes per localization fixture with Qwen3 on the M2, 1–2 minutes with potion)
  and are not reported as a result.

**Symbol search** (377 queries, section 3):

| queries | n | graph-indexer r1 / s@5 / MRR | zvec Qwen3 | zvec Qwen3, code only | zvec potion |
|---|---|---|---|---|---|
| all | 377 | **0.703 / 0.841 / 0.761** | 0.549 / 0.690 / 0.611 | 0.581 / 0.708 / 0.639 | 0.517 / 0.703 / 0.596 |
| without nvm (Bash) | 335 | **0.690 / 0.833 / 0.751** | 0.615 / 0.767 / 0.679 | 0.651 / 0.791 / 0.711 | 0.570 / 0.728 / 0.638 |
| held-out | 169 | **0.734 / 0.846 / 0.779** | 0.544 / 0.663 / 0.599 | 0.568 / 0.686 / 0.623 | |
| behaviour described in words | 92 | **0.478 / 0.674 / 0.566** | 0.326 / 0.565 / 0.422 | 0.424 / 0.620 / 0.501 | |

Per fixture, MRR@10 (graph-indexer / zvec Qwen3 / zvec Qwen3 code only): axios 0.76 / 0.69 /
0.72, express 0.83 / 0.54 / 0.57, **gin 0.88 / 0.90 / 0.91**, spring 0.86 / 0.81 / 0.86,
serde-json 0.68 / 0.65 / 0.63, cJSON 0.69 / 0.61 / 0.66, nvm 0.85 / 0.07 / 0.07,
**fastapi 0.63 / 0.59 / 0.68**, nestjs 0.68 / 0.67 / 0.67. zg does not split Bash into symbols,
so nvm's results are whole-file chunks that rarely name the function asked for; the second row
leaves nvm out.

**Localization** (169 real commits, section 2):

| fixture | system | file Acc@1 | file Acc@5 | fn Acc@5 | fn Acc@10 | fn MRR@10 |
|---|---|---|---|---|---|---|
| express-js | graph-indexer | **0.722** | **0.917** | **0.893** | **0.929** | **0.810** |
| | zvec Qwen3 / code only | 0.167 / 0.444 | 0.806 / 0.889 | 0.464 / 0.429 | 0.571 / 0.536 | 0.305 / 0.313 |
| gin | graph-indexer | 0.625 | **0.925** | **0.500** | 0.528 | 0.396 |
| | zvec Qwen3 / code only | 0.450 / **0.650** | 0.775 / 0.825 | 0.472 / 0.472 | 0.528 / 0.528 | **0.415** / 0.401 |
| fastapi | graph-indexer | **0.769** | **0.923** | 0.667 | 0.778 | 0.405 |
| | zvec Qwen3 / code only | 0.308 / 0.615 | 0.615 / 0.846 | **0.778** / **0.778** | 0.778 / 0.778 | 0.583 / **0.639** |
| nestjs *(held out)* | graph-indexer | **0.450** | **0.675** | **0.324** | **0.459** | **0.274** |
| | zvec Qwen3 / code only | 0.275 / 0.275 | 0.500 / 0.500 | 0.297 / 0.297 | 0.432 / 0.432 | 0.221 / 0.221 |
| axios *(held out)* | graph-indexer | **0.350** | **0.650** | **0.438** | **0.688** | **0.335** |
| | zvec Qwen3 / code only | 0.250 / 0.250 | 0.525 / 0.550 | 0.438 / 0.406 | 0.563 / 0.531 | 0.322 / 0.319 |
| **all** | **graph-indexer** | **0.550** | **0.799** | **0.528** | **0.641** | **0.433** |
| | grep (ranked, section 2) | 0.485 | 0.769 | 0.514 | 0.627 | 0.374 |
| | zvec Qwen3 | 0.290 | 0.645 | 0.437 | 0.535 | 0.332 |
| | zvec Qwen3, code only | 0.420 | 0.698 | 0.423 | 0.521 | 0.333 |
| | zvec potion | 0.308 | 0.633 | 0.437 | 0.535 | 0.335 |

**Where zvec-grep wins.** On gin it ranks better in symbol search (MRR 0.91 against 0.88),
puts the changed file first more often (0.650 against 0.625) and ranks the changed functions a
little higher (MRR 0.415 against 0.396). On fastapi, with code only, it
finds the changed functions better (MRR 0.639 against 0.405, Acc@5 0.778 against 0.667) and edges
graph-indexer in symbol search (0.68 against 0.63). Those are its two best fixtures. Everywhere
else, and on every total, graph-indexer is ahead. Over all commits zvec-grep is also below the
ranked grep baseline, which ranks whole files where zg ranks chunks: on commit subjects the file
that changed is more often found by its words than by a chunk's meaning.

What an agent does with each one in a session is in
[AGENTIC-BENCHMARK.md](AGENTIC-BENCHMARK.md#against-zvec-grep-030-with-its-own-benchmarks-questions-zp1-pilot-24-tasks-72-runs):
in a one-repetition pilot with Haiku 5.5 on 24 tasks, neither tool beat Claude Code alone.

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

## ORM models, their migrations and Prisma's client

An ORM model's table is named in strings: migrations touch it by name, and Prisma's client is
generated outside the repository (`prisma.envelope.findFirst(…)` is typed only by
`node_modules/.prisma`). graph-indexer reads the models (Prisma `model` blocks, Django models,
SQLAlchemy / SQLModel tables, TypeORM entities) with the table each ORM gives them, the migration
statements that name that table, and Prisma's client calls. Every claim of the first version was
checked by an independent reader with its own scripts against the source — all of them, not a
sample:

| | documenso (`38ecb21`, Prisma) | full-stack-fastapi-template (`7257e60`, SQLModel + Alembic) | django-oscar (`1635338`, Django) | twenty (`4c28e34f09`, TypeORM) |
|---|---|---|---|---|
| models found / in the code | 52 / 52 | 2 / 2 | 81 / 85 | 79 / 80 |
| wrong table name | 0 | 0 | 1 | 0 |
| migration statements claimed | 610 | 56 | 328 | 1,677 |
| … that do not touch the table | 0 | 0 (1 mislabelled) | 0 | 0 |
| Prisma client calls claimed | 1,073 | – | – | – |
| … wrong | 0 | – | – | – |
| … found of those in the code | 100% | – | – | – |

What the reader found missing, all fixed since: a Django `db_table` inherited from an abstract
base (the wrong table), Django models whose base comes from a library (treebeard's `MP_Node`,
auth's `AbstractUser`: 4 models), an entity whose 49 lines of decorators hid its `@Entity`,
statements that name the table only as an aliased `UPDATE "T" t`, a read (`FROM`, `JOIN`), a
`RENAME TO` target or `create_primary_key`, Django data migrations (`apps.get_model(…)`), and
twenty's schema changes in upgrade commands outside any `migrations` directory (code driving
TypeORM's `queryRunner`). After the fixes: 85 / 85 and 80 / 80 models, no table name wrong, and
1,109 more statements (documenso 84, the template 10, oscar 35, twenty 980), each of them checked
by script to name its table; none of the first version's lines was lost. Still not modelled:
TypeORM's data-source default schema (16 of twenty's entities show their table without `core.`),
Kysely and raw queries through the Prisma client, materialized views, and a proxy model lists its
base's migrations, which are its table's.

## An updated index against one built from scratch

```bash
node bench/fixtures.mjs --history 400
node bench/eval-incremental.mjs --fixtures gin,express-js,fastapi,axios,rust,spring --n 120 --mode commit
node bench/eval-incremental.mjs --fixtures gin,express-js,fastapi,axios,rust,spring --n 120 --mode file --order reverse
```

Every figure in section 1 scores an index built from scratch. An agent never works on one: it
edits, the index re-syncs the files that changed, and the next answer comes from an index that has
been updated many times. This benchmark asks whether the two are the same index.

**Method.** A scratch worktree of a repository is moved along its last N commits (the first-parent
chain ending at the pinned commit) in one of three ways, and after each commit the updated index is
compared with a fresh index of the same tree: every symbol, import, inferred field type and
reference, with what it binds to, its confidence and its candidate count.

- `commit` — one sync per commit, what a pull or a branch switch does;
- `file`, `forward` — the commit's files are written one at a time with a sync in between, the
  way an agent's edits arrive;
- `file`, `reverse` — the same in the opposite order, so that whichever of two files a change
  spans is written first in one of the two runs (a call before its definition, and the reverse).

A commit after which any fact differs counts as divergent; the updated index is then rebuilt, so
one divergence is not counted again at every later commit.

**Results** (nine repositories in six languages: gin, express, fastapi, axios, serde_json and
spring-petclinic over 120 commits each, nestjs, sqlglot and networkx over 50):

| mode | build | commits | commits that leave the index different | references that differ | …bound to another definition | …bound where a fresh index leaves them unbound | …unbound or missing where a fresh index binds them | …extra | imports that differ |
|---|---|---|---|---|---|---|---|---|---|
| commit | 3.1.0 | 870 | 8 | 580 | 4 | 11 | 153 | 412 | 40 |
| | now | 870 | **0** | **0** | | | | | 0 |
| file, forward | 3.1.0 | 870 | 25 | 706 | 4 | 11 | 262 | 429 | 70 |
| | now | 870 | **0** | **0** | | | | | 0 |
| file, reverse | 3.1.0 | 870 | 30 | 772 | 33 | 17 | 296 | 426 | 69 |
| | now | 870 | **0** | **0** | | | | | 0 |

By repository, 3.1.0 diverges in gin (3, 7 and 6 commits in the three modes), axios (4, 9, 8),
serde_json (1, 1, 1), spring-petclinic (0, 2, 1), nestjs (0, 5, 4), sqlglot (0, 1, 6), fastapi
(0, 0, 3) and networkx (0, 0, 1); express never does. The counts are of commits and references
after which the index is wrong until the files involved are indexed again: each divergent commit
is followed by a rebuild in this benchmark, so they do not accumulate as they would in a session.
A first run of the new build over 3,240 replays (150 commits a fixture) had found one difference,
which was the benchmark's own: a commit that renames `readme.md` to `README.md`, replayed on a
file system that does not tell the two names apart by writing the new file and then deleting "the
old one". Removals are replayed first now.

**What the replays did not find.** History exercises the edits developers make, not every edit.
An independent reading of the code after these runs found one more: two definitions of one name
that swap places inside a file (`namespace A { f }` and `namespace B { f }` reordered) changed
which one "the first candidate" is for a call elsewhere, and nothing said so. A definition's place
among its file's definitions of that name is part of what a change emits now, with a test. The
same reading found that a manifest edited while no process had the index open went unnoticed until
the next full sweep, and that a failed update left the in-memory table ahead of the store; both
are fixed. After those fixes a confirmation replay (60 commits of each fixture, 25 of nestjs, the
three modes: 1,155 replays) again left no difference.

**Second pass (2026-11-15).** A second independent reading, of the update path alone, found what
no replay of history can hold, each now a test in `test/incremental.test.mjs`: two tool calls at
once ran two updates at once (`UNIQUE constraint failed: files.path`, and references left bound
to rows that were gone); an update that failed after its removals had been written left imports
resolved to the removed file for good; an index written by a second process (the edit hook's own)
was not read again by the first; and the type of a receiver such as `make().x` was remembered per
file, so with a function declared inside another and an imported one of its name the answer
depended on which reference was resolved first. It also found paths the quick update did not
follow until the next full sweep (a directory renamed as a whole, a file the repository ignores, a
rename that changes only letter case, the base a `tsconfig` extends), and two cases of needless
work: a file rewritten alone in its directory re-resolved every Java file that imports a library
type, and a new document every Rust file.

With all of that fixed, and with the resolver changes of section 1 in, history was replayed
again: gin, express, fastapi, axios, serde_json, spring-petclinic and nestjs, 120 commits each,
in the three modes (2,520 replays). Commit by commit and file by file in forward order left no
difference. File by file in reverse order left one, in axios `7a2f901`, and it was a fault this
pass had introduced: the commit adds files under `test/module/typings/` and removes `typings/`
from `.gitignore`; written last to first, the files arrive while they are still ignored, the new
check for ignored paths rightly leaves them out, and nothing looked at them again when the rule
went. A change to a `.gitignore` is now followed by a full reconciliation.

That fix was replayed in turn, and the reverse order left one again, in spring-petclinic
`a50bfb65bb`: the commit renames `readme.md` to `README.md` and edits `.gitignore`. On a file
system that does not tell the two names apart git goes on listing `readme.md` until its index is
moved, so the full reconciliation the `.gitignore` now triggers named the file as git did, while
the update of the path alone had named it as the disk does: a disagreement that had been there
all along and that no replay had reached. The name of a file is now the one on disk in both
(untracked files are asked of git without folding case), and `check` reports the imports that
still use the old name. On that code, the code these numbers describe, the three modes were
replayed once more in full: no difference in any of the 2,520.

What 3.1.0 got wrong, by kind, from the commits above and from the scenarios of
`test/incremental.test.mjs` (26 of the 32 tests it had before the second pass fail on 3.1.0):

- an import written before the file it names existed was never resolved (fastapi's tutorial tests
  written before the tutorial module), and one whose target moved with a `package.json` or
  `tsconfig.json` change stayed where it was (in axios one such commit leaves 453 facts wrong:
  references kept through an `import 'axios'` that no longer led there, and reads that a
  declaration added in another file should have bound);
- a Go import of a package whose last file was removed still led to the empty directory (gin);
- a type, a value or an attribute used before its definition was written lost the reference for
  good: references that bound to nothing were deleted at indexing time;
- a changed return type, base class, field type or re-export left the calls made through it bound
  to the old definition in every file that had not itself changed;
- the candidate count and confidence of a call could depend on which file was indexed last.

**How far an update reaches.** With dependency tracking an update resolves again only the files
that read what changed ([ARCHITECTURE](ARCHITECTURE.md#an-updated-index-is-the-index-built-from-scratch)).
Over the replays above an update resolves again 9.6 other files on average when a whole commit
arrives at once and 14.5 when its files arrive one by one, 957 at most (a fastapi commit that
touches a name hundreds of tutorial files define), and the slowest single update took 1.2 s
(networkx, 615 files resolved again). Moving the index one commit forward takes about what it
took: 95 ms against 96 ms a commit in `commit` mode, 167 against 160 and 109 against 144 in the
two `file` modes (both builds measured on a machine doing other work), against 0.9–1.1 s to
build it afresh. On Twenty (31,529 files, 1.2 million references): appending a
comment to the most referenced file (`isDefined.ts`, 11,987 uses) reaches no other file and takes
0.18 s; renaming its export reaches the 4,561 files that use it and takes 4.2 s; creating a file
takes 0.8 s, most of it resolving the 177,722 imports again. Each file records 29 keys on average
there (3.7 MB in all).

**What it costs.** Cold index, CPU seconds of one thread (`GRAPH_INDEXER_WORKERS=0`), three runs of
each build alternated on a machine that was doing other work, so CPU time rather than the clock:

| repository | 3.1.0 | now | index size |
|---|---|---|---|
| nestjs (1,686 files) | 3.45 | 3.63 | 13.5 → 14.0 MB |
| fastapi (1,698) | 2.96 | 3.15 | 13.2 → 13.5 MB |
| sqlglot (266) | 4.90 | 4.23 | 16.8 → 17.9 MB |
| nats-server (233) | 38.3 | 8.8 | 35.9 → 38.5 MB |
| Twenty (31,529; two runs) | 62.9 | 61.4 | 334.4 → 334.8 MB |

The second pass costs some of that back. Same measurement, on an idle machine, the build before
the pass against this one (medians of three alternated runs):

| repository | before | now | index size |
|---|---|---|---|
| nestjs (1,686 → 1,703 files) | 3.10 | 3.39 | 14.0 → 14.6 MB |
| fastapi (1,698) | 2.62 | 2.75 | 13.5 → 13.9 MB |
| sqlglot (265) | 3.69 | 4.20 | 17.9 → 19.7 MB |
| nats-server (233) | 7.65 | 8.05 | 38.5 → 38.5 MB |
| tokio (740 → 743) | 5.96 | 6.46 | 17.7 → 17.9 MB |
| commons-collections (545) | 2.61 | 2.82 | 16.5 → 16.5 MB |

Five to fourteen per cent more CPU for a cold index: a receiver's type is now kept per enclosing
definition rather than per file (the fix for the order-dependent answer above), Rust calls record
the types of their arguments, and Python binds more (`name.attr` of any case is a use). Clock time
grows by two to eleven per cent.

nats-server is one Go package of 233 files. For every reference the resolver scanned all the
symbols of the file, or of every file of the package, to pick those of one name: quadratic in a
large package. A per-file index by name gives the same symbols in the same order.

A fresh index holds the same facts as one built by 3.1.0 in 19 of the 23 checkouts compared fact
for fact (the fixtures, six Python, three Java and three Rust repositories, sqlglot, and Twenty
with its 853,426 facts). The three Go repositories gain bound references through the scoping
change of section 1, and eight references of Commons Collections change: in Java the type of a
`call:` receiver is chosen with the arguments of the reference being resolved and was kept for the
next reference of the file whatever its arguments, so the answer depended on which asked first; it
is kept per argument shape now. Against javac Commons Collections scores the same (0.961 / 0.883,
exact sets 0.825). So the
oracle figures of section 1 hold as published, except Go's, measured again there.

## `check` on changes left half done

```bash
node bench/eval-check.mjs --repos gin,axios,nestjs --n 40 --verbose
node bench/eval-check.mjs --repos sqlglot --repo-dir ~/.gi-agentic/repos --n 30 --scan 1500 --verbose
```

`check_changes` exists for one failure: a definition is changed and its users elsewhere are not.
Real history has the answer key.

**Method.** A commit that changed the definition line of a name in a file A and, in the same
commit, a line that uses that name in another file B shows where a developer had to follow the
change: a *ripple*. The rules come from git text alone and follow B5's
([PLAN-IDE-AGENTE](PLAN-IDE-AGENTE.md)): one parent, a subject that is not a release or a revert,
2–8 modified source files and at most 16 files; a name of four or more characters whose definition
line the commit removes or changes in A; a file B, not itself such an A, that contained the name
and in which the commit changes a line containing it. Built and vendored copies (`dist/`,
`*.min.*`) are neither A nor B: that exclusion was added after the first run on axios, whose bundle
and its minified twin change together. The most recent such commits of each repository are taken.

For each commit, in a worktree at its parent:

- **half done** — only the A files are written as the commit leaves them, and `check` runs. A
  ripple is *found* when a finding about that name points into file B; a *site* when it names the
  line. Only what the reply shows counts: a list it cuts short ("… 12 more") is counted as far as
  it is shown. Findings are problems ("✗": a call that no longer fits, a removed name still used)
  or things to review ("•": callers in files not touched, the method's family, possible uses);
- **finished** — the whole commit is checked out and `check` runs against the parent. A problem
  reported here is a false alarm, or something the developer left broken.

The repositories were split before any result was read. **Development** (looked at while fixing
`check`): gin, axios, nestjs, sqlglot. **Held out** (run once, at the end, with the code frozen):
express, serde_json, spring-petclinic, networkx, sqlalchemy, mypy, xarray, scrapy, haystack,
pylint, sympy and Twenty.

**Results.**

| split | build | commits | ripples found | …as a problem | …into source files | sites | finished changes reported with problems | problems reported elsewhere |
|---|---|---|---|---|---|---|---|---|
| development | 3.1.0 | 56 | 40 of 103 (39 %) | 25 | 32 of 86 (37 %) | 59 of 172 (34 %) | 12 of 56 commits (122 problems) | 106 |
| | now | 56 | **59 of 103 (57 %)** | 26 | **48 of 86 (56 %)** | **90 of 172 (52 %)** | **1 of 56 (6)** | **12** |
| held out | 3.1.0 | 120 | 159 of 288 (55 %) | 135 | 90 of 157 (57 %) | 290 of 1,148 (25 %) | 18 of 120 commits (147 problems) | 42 |
| | now | 120 | **177 of 288 (61 %)** | 118 | **97 of 157 (62 %)** | **333 of 1,148 (29 %)** | **6 of 120 (6)** | **12** |
| development | second pass (2026-11-15) | 56 | 61 of 103 (59 %) | 29 | 50 of 86 (58 %) | 93 of 172 (54 %) | 1 of 56 (6) | 15 |
| held out | second pass (2026-11-15) | 120 | 178 of 288 (62 %) | 122 | 97 of 157 (62 %) | 345 of 1,148 (30 %) | **2 of 120 (2)** | 12 |

(Development: 40 commits a repository where the fetched history has them, 30 for sqlglot. Held
out: 20 a repository, 10 for Twenty; express and spring-petclinic have no such commit in the
history fetched, so ten repositories count.)

The held-out gain in ripples found is a third of the development one (6 points against 18): most
of what was fixed was found on JavaScript and TypeScript, and the held-out set is mostly Python,
where 3.1.0 already did best. What carries over in full is the other column: finished changes
reported as broken fall from 18 commits to 6 and from 147 problems to 6. Fewer ripples are reported
*as a problem* (135 → 118) because a use tied to a removed definition only by its name is now
listed as possible rather than as broken.

The six held-out commits still reported, one problem each, were read after the run. Three were two
bugs, fixed afterwards and not measured again (the figures above are the frozen build's): a
generator passed as the only argument (`f(x for x in xs)`) was counted as two arguments (scrapy,
sympy; 3.1.0 has it too), and a value named like a class that exists elsewhere (`G = nx.Graph()`
with a test class `G`) was taken for the class in the new rule for `Base.method(self, …)`
(networkx; introduced by this work). The other three (serde_json `Compound.serialize_entry`, two
in sqlalchemy) were not looked into further.

The one finished change still reported in development is a true one: nestjs `40e2755c82` removed
the parameter of `ClientRedis.getClientOptions` and left six calls in a spec file passing it.

What 3.1.0 got wrong, each now a test in `test/check.test.mjs`:

- **JavaScript arity was treated as an error.** `merge(a, b)` against a function that now declares
  three parameters is legal JavaScript; `check` called it a call that no longer fits. On axios the
  developer's finished change was reported with problems in 7 of 7 commits (97 problems). In
  JavaScript a count that does not match is now listed to look at; in TypeScript, Python, Go, Java
  and the rest it is still a problem.
- **"Removed but still used" went by name.** A removed top-level `map` claimed every `.map()` call
  in the repository; a Go type renamed in one file and still named in another file of its package
  was not found at all, because references that bound to nothing were not kept. The removed
  definition is now put back into the symbol table as it was, the references that bind to nothing
  and carry its name are resolved again, and those that bind to it are its uses
  ([ARCHITECTURE](ARCHITECTURE.md#5-queries)). Uses only the name ties to it are listed apart, as
  possible.
- **A definition that changed kind was "removed"** (`function AxiosHeaders` made a class, a type
  alias made an interface), and so was a name the file still binds by an import or by destructuring.
- **Python:** `Base.method(self, x)` passes its receiver by hand and was one argument too many; a
  call that passes a keyword the definition no longer takes is now a problem.
- **A method's family.** A method removed from a class, or whose signature changed, is reported
  with the supertypes that still declare it and the subtypes that still override it, in files the
  change did not touch (16 of the 30 ripples found on nestjs carry such a finding).
- **A signature that changes without changing its argument count** (another result, a parameter
  renamed) lists its callers in files not touched.

**Second pass (2026-11-15).** On the development commits `check` now finds 61 of the 103 ripples
(59 before), 29 of them as a problem (26), 93 of the 172 sites (90), and still reports one finished
change of 56, the true one. The held-out commits were run again, once, with the code frozen: 178
of 288 ripples (177), and the developer's finished change reported with problems in 2 of 120
commits instead of 6 — serde_json's `Compound.serialize_entry` and one in sqlalchemy remain; the
four that went were the two bugs read after the first run (a generator passed as the only
argument, a value named like a class) and what the decorator rule below no longer counts. The two more are the removed nestjs interface that sat in a directory
the index used to skip (`external/`), and a function removed from sqlglot's parser that
`parsers/postgres.py` still names (`build_jsonb_contains`). That is not where this pass changed `check` most: an
independent reading of the code found what the benchmark's commits cannot contain — its rules
take commits that only *modify* files — and each of these is now a test in `test/check.test.mjs`:

- a file deleted or moved (`git mv util.ts helpers.ts`) while others still import it by the old
  path: "No problems found" before; now the imports left behind are listed, with where the file
  went;
- a removed function when any other file declares one of the same name: it was taken for a
  definition that had moved;
- a changed file whose path holds a space or a non-ASCII letter: it was not checked at all;
- a false alarm on a correct change under a decorator that supplies arguments (`@click.option`),
  and on Rust's `Type::method(value, …)`;
- limits (40 changed signatures, 30 removed definitions) that hid the rest without a word.

**What it costs to read.** The whole reply, tests section included, over the development commits:
1,445 → 1,583 characters per half-done change and 1,669 → 1,744 per finished one. axios's replies
shrink (2,098 → 1,274: the false alarms are gone) and nestjs's grow (1,171 → 1,684: the method's
family and the callers of a signature that changed without changing its count). That last list was
first written with the old and the new signature and six call sites for each definition; it took
844 characters of every reply about a finished nestjs change for 5 of the ripples found, so it is
one line now: the definition, how many call sites, the first three.

**What is still missed** (43 % of the development ripples): a change of meaning behind an
unchanged signature (gin's `Render` stopped panicking; its tests changed what they assert),
declaration files (`index.d.ts` restates the API, it does not use it), and uses through values the
index cannot type. Part of this cannot be seen without running the code; the benchmark says how
much.

## `rename` alone on the refactor tasks

```bash
node bench/eval-rename.mjs          # needs the typescript package; for caddy, Go and the oracle
```

The B2 rename tasks ([AGENTIC-BENCHMARK](AGENTIC-BENCHMARK.md)) ask to rename one method that
shares its name with methods of other classes. They are graded by the compiler: no new type error
(TypeScript: `tsdiag` against the base revision; Go: the type checker over the module, tests
included) and the target renamed with the same-name methods left alone. Each task records that the
unmodified checkout fails, that the compiler's own rename passes, and that renaming every
`.name(` call fails.

Here no agent takes part. In a worktree at the task's base `graph-indexer rename <symbol> <new>
--write` runs once, and the task's own checks grade what it wrote.

| task set | tasks | solved, first run | solved now |
|---|---|---|---|
| nestjs (development, held-out, third and fifth rounds) | 11 | 11 | 11 |
| Twenty | 4 | 4 | 4 |
| caddy (Go) | 2 | 0 | 2 |
| all | 17 | 15 | 17 |

(Run again at the end, after the fixes below: 17 of 17.) Each rename took 0.04–0.3 s on nestjs
and 1–2.7 s on Twenty. The two caddy tasks failed on one
call each, `tc.require.Match(…)` and `tc.input.Name()`, where `tc` ranges over a table of test
cases declared as a struct type in place: the index did not type the fields of such a struct, so
the call was listed ("1 same-name call on a receiver of unknown type") and not edited. Typing
them was a change to the engine, verified against the Go type checker (section 1: caddy's exact
sets 0.949 → 0.964), after which both tasks pass. Those two tasks were the reason for the fix and
are no evidence for it; the fifteen others were solved before anything was changed.

These tasks rename methods. The same independent reading found two faults they could not show,
both in renaming a top-level definition and both fixed with tests: the name was also replaced
inside the module path of an import (`import { parse } from './parse'` became `'./parseText'`),
and a new name already declared or imported in a file that uses the definition was not seen as a
conflict.

**Second pass (2026-11-15).** The seventeen tasks said the rename was right where it was used as
the tasks use it. A reviewer who tried to break it found thirteen ways it was not, none of which
a task exercises: with an index one edit behind, it renamed the call of another class's method of
the same name and reported success (it read the positions before bringing the index up to date);
it left `</Button>` after renaming `<Button>`, `@value.setter` above a renamed property, and
`export { name }` in the defining file; it turned `{ name }` into `{ newName }`, changing the key
other code reads; it accepted a new name a base class already declares, or one that is a local
variable where a use stands; and a read-only file among the ones to edit left the rename half
written. All are fixed and tested (`test/rename.test.mjs`): the index is reconciled first, every
edit is checked against the file on disk, the files are written all or none, and a rename that
would change what the code means is refused with the reason. Run again, it solves the same 17 of
17.

What the rename edits and what it lists instead is in
[ARCHITECTURE](ARCHITECTURE.md#5-queries). Since 3.2.0 it is also an MCP tool, `rename_symbol`,
the one that is not read-only: it writes when called with `apply: true`. Whether an agent uses
it, and gains from it, has not been measured in sessions.

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
fastapi only; nestjs and axios are held out; rerun 2026-11-06 with the current version):

| fixture | commits | system | file Acc@1 | file Acc@5 | fn Acc@5 | fn Acc@10 | fn MRR@10 |
|---|---|---|---|---|---|---|---|
| express-js | 36 | graph-indexer | 0.722 | 0.917 | 0.893 | 0.929 | 0.810 |
| | | grep | 0.778 | 0.889 | 0.857 | 0.929 | 0.633 |
| | | BM25 | 0.472 | 0.861 | 0.821 | 0.893 | 0.598 |
| gin | 40 | graph-indexer | 0.625 | 0.925 | 0.500 | 0.528 | 0.396 |
| | | grep | 0.600 | 0.875 | 0.583 | 0.639 | 0.461 |
| | | BM25 | 0.450 | 0.850 | 0.417 | 0.528 | 0.309 |
| fastapi | 13 | graph-indexer | 0.769 | 0.923 | 0.667 | 0.778 | 0.405 |
| | | grep | 0.308 | 0.846 | 0.556 | 0.667 | 0.295 |
| | | BM25 | 0.462 | 0.846 | 0.556 | 0.556 | 0.254 |
| nestjs *(held out)* | 40 | graph-indexer | 0.450 | 0.675 | 0.324 | 0.459 | 0.274 |
| | | grep | 0.325 | 0.625 | 0.162 | 0.297 | 0.103 |
| | | BM25 | 0.300 | 0.575 | 0.243 | 0.324 | 0.164 |
| axios *(held out)* | 40 | graph-indexer | 0.350 | 0.650 | 0.438 | 0.688 | 0.335 |
| | | grep | 0.325 | 0.675 | 0.531 | 0.719 | 0.386 |
| | | BM25 | 0.250 | 0.575 | 0.156 | 0.313 | 0.154 |
| **all** | **169** | **graph-indexer** | **0.550** | **0.799** | **0.528** | **0.641** | **0.433** |
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

### Documentation sections and the semantic channel (2026-11-06)

Two later additions, measured on the same 377 queries and the 169 commits of section 2:

| configuration | rank-1 | success@5 | MRR@10 | queries in words, success@5 | localization file Acc@1 |
|---|---|---|---|---|---|
| before both | 0.706 | 0.841 | 0.763 | 0.674 | 0.550 |
| Markdown sections indexed (the default now) | 0.703 | 0.841 | 0.761 | 0.674 | 0.550 |
| + semantic channel, chosen weights (`GRAPH_INDEXER_SEMANTIC=1`) | 0.695 | **0.859** | 0.761 | **0.728** | 0.533–0.538 |
| + semantic channel, weights ×2 / ×4 | | | | | 0.485 |

- **Sections.** Indexed with the symbols, Markdown headings cost symbol search 0.018 of MRR. Kept in
  an index of their own and searched only for questions about docs, design or reasons, they cost
  0.002, and localization does not change. (A first run seemed to show a localization loss; it
  came from the benchmark counting `.md` files as source, which changed which commits qualify.
  `eval-localize.mjs` now leaves documentation out.)
- **Semantic channel.** A static model (potion-code-16M-v2, 256 dimensions) over each definition's
  name, signature, doc comment and first 60 lines, fused with the other channels by weight. It
  finds what the words of a description mean when no name shares them, so success@5 on those
  queries rises by 0.054. On commit subjects it pulls up definitions that are about the same topic
  but not the ones changed: localization falls a little at the chosen weights and by 0.065 at
  higher ones. Ranking only the candidates the lexical channels found, or embedding only the
  signature and doc line, did not help either. It stays opt-in.

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
- **An `explore` that reads issues** does not change this. It shows the code the fix changes in
  25 of 50 fresh issues instead of 12, measured offline. In two pilots of real sessions (47 tasks,
  94 runs) it cost 1.12 (1.01–1.25) and 1.03 (0.96–1.12) of Claude Code alone
  ([details](AGENTIC-BENCHMARK.md#issues-as-written-explore-offline-and-in-real-sessions-issue1p-issue2-47-tasks-94-runs)).

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
| nvm | 19 | 8,539 | 459 | 1,419 | 94% | 0.1 s | 0.8 MB |
| spring | 53 | 13,922 | 2,753 | 1,454 | 54% | 0.3 s | 2.0 MB |
| rust | 73 | 23,634 | 2,040 | 7,386 | 83% | 0.6 s | 2.9 MB |
| gin | 102 | 22,342 | 1,981 | 7,548 | 91% | 0.4 s | 2.8 MB |
| cjson | 132 | 29,967 | 2,435 | 6,556 | 84% | 0.5 s | 3.3 MB |
| axios | 160 | 18,529 | 1,251 | 5,986 | 58% | 0.6 s | 2.3 MB |
| express-js | 169 | 27,940 | 509 | 8,114 | 36% | 0.5 s | 2.5 MB |
| fastapi | 1,698 | 196,531 | 13,461 | 16,333 | 70% | 1.4 s | 13.9 MB |
| nestjs | 1,703 | 101,774 | 9,537 | 31,841 | 77% | 1.7 s | 14.6 MB |
| Twenty | 31,634 | 2,610,431 | 197,622 | 442,396 | 73% | 43 s | 336 MB |

Measured on 3.2.0 (2026-11-15, Apple Silicon, the default worker processes; the median of three
cold builds, one for Twenty). Files and lines include documentation, which is indexed too.
"Bound" is the share of stored references resolved to a definition in the repository (calls into
libraries stay unbound; a reference that binds to nothing yet is kept apart, to be bound when
its definition is written, and is not counted here). After the first build only changed files
are re-parsed.

Warm tool latency on nestjs (median of 5): `get_symbol` 1.2 ms, `find_references` 1.1 ms,
`call_graph` 1.4 ms, `change_impact` 3.7 ms, `outline` 17.8 ms, `search_code` about 30 ms.
The ten tool definitions are 9.9k characters of JSON (about 2.5k tokens; `rename_symbol` is 1.2k
characters of them) and the server instructions 0.8k characters; replies are typically 400–1,500 tokens.
