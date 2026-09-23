# Benchmarks

Three benchmarks, each answering a question an agent actually depends on:

1. **Are the references right?** — `bench/eval-graph.mjs`, against the TypeScript compiler.
2. **Does search find the code a real change touched?** — `bench/eval-localize.mjs`, replaying
   real commits.
3. **Does search find the symbol a developer means?** — `bench/eval-search.mjs`, 377 authored
   queries, compared with graph-indexer 2.x.

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
| dispatch | graph-indexer | 0.996 (0.999) | 0.958 (0.886) | 0.977 (0.939) | 0.967 | 0.959 | 0.887 |
| dispatch | graph-indexer, confidence ≥ likely | 0.997 (1.000) | 0.958 (0.886) | 0.977 (0.939) | 0.969 | 0.959 | 0.892 |
| dispatch | name-only | 0.251 | 0.974 | 0.400 | 0.735 | 0.975 | 0.589 |
| dispatch | grep | 0.128 | 0.993 | 0.227 | 0.515 | 0.994 | 0.226 |
| rename | graph-indexer | 0.996 (0.999) | 0.922 (0.766) | 0.958 (0.867) | 0.967 | 0.943 | 0.857 |
| rename | name-only | 0.262 | 0.975 | 0.413 | 0.752 | 0.976 | 0.604 |
| rename | grep | 0.133 | 0.993 | 0.235 | 0.521 | 0.994 | 0.226 |

An earlier 3.0 build, before the correctness work that followed the agent studies, gave with the
same seed: dispatch precision 0.979, recall 0.895, exact sets 0.835.

Micro averages pool all reference lines (dominated by heavily used symbols); macro averages
weigh each symbol equally; "exact set" is the share of symbols whose reference set matches the
oracle exactly.

**What is still missed.** Receivers whose type only a type checker knows: object literals
contextually typed by an interface (`{ useFactory: … }` as a `FactoryProvider`), generic
instantiation, and `any`-typed values. These show up as lower recall, not as wrong answers, and
`find_references` reports the number of same-name call sites it could not bind so an agent knows
when to grep.

**A caveat on the oracle.** The fixture is checked out without `node_modules`, so values that
flow through third-party libraries (for example `iterate(instances).filter(([_, w]) =>
w.isDependencyTreeStatic())` with `iterare`) are `any` to the compiler and their references are
missing from its answer. graph-indexer still finds some of them, and each one counts as a false
positive here: the precision figures are a lower bound.

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

A small paired evaluation: the same five questions were given to two agents with the same model
(Claude Sonnet, as a sub-agent), one allowed only grep/glob/read, the other also given the
graph-indexer CLI (the same six tools as the MCP server). Answers were scored against the
compiler's `findReferences` or the suites' authored answers, checked by hand where the compiler
missed library-typed code. Usage is as reported by the agent runtime; every run carries a fixed
~44k-token overhead (system prompt and tool definitions).

| task | arm | correct | tool calls | tokens | time |
|---|---|---|---|---|---|
| T1 callers of `InstanceWrapper.isDependencyTreeStatic`, two levels deep (nestjs, 36 functions) | grep | 36/36 | 44 | 108.4k | 245 s |
| | graph-indexer | 36/36 | **20** | **88.8k** | **220 s** |
| T2 call sites of `Module.addProvider`, not the same-named `NestContainer.addProvider` (nestjs) | grep | ✓ | 5 | 50.7k | 25 s |
| | graph-indexer (before fixes) | ✓ | 9 | 54.4k | 36 s |
| | graph-indexer (after fixes) | ✓ | 8 | 51.8k | 24 s |
| T3 function that parses the request body into declared parameters (fastapi) | grep | ✓ | 3 | 45.1k | 8 s |
| | graph-indexer | ✓ | 4 | 48.3k | 16 s |
| T4 function that joins URL paths preserving a trailing slash (gin) | grep | ✓ | 3 | 44.6k | 7 s |
| | graph-indexer | ✓ | 4 | 46.4k | 9 s |
| T5 method that runs guards and denies on `false` (nestjs) | grep | ✓ | 3 | 45.5k | 8 s |
| | graph-indexer | ✓ | 3 | 46.7k | 11 s |

What it shows, with one run per cell (indicative, not statistically significant):

- A capable model answers single-location questions with grep just as well and slightly
  cheaper; the index adds a call it does not need.
- On the multi-hop impact question the graph-indexer agent needed 55% fewer tool calls and about
  30% fewer tokens beyond the fixed overhead, for the same complete answer and higher stated
  confidence.
- T2 surfaced two real defects, both fixed before the rerun: a call site reached through
  `class ModulesContainer extends Map<string, Module>` was not bound, and overloads of one method
  were reported as an ambiguous name. The remaining extra calls were the agent verifying that
  the other `addProvider` calls belong elsewhere; `find_references` now states where every other
  same-name reference resolves.

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

"Bound" is the share of stored references resolved to a definition in the repository (calls into
libraries stay unbound; value, member-read and type references that cannot be bound are dropped
at index time). After the first build only changed files are re-parsed.

Warm tool latency on nestjs (median of 5): `get_symbol` 1.2 ms, `find_references` 1.1 ms,
`call_graph` 1.4 ms, `change_impact` 3.7 ms, `outline` 17.8 ms, `search_code` about 30 ms.
The six tool definitions cost about 1.8k tokens of context; replies are typically 400–1,500
tokens.
