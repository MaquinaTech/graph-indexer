# Agentic benchmark: does graph-indexer make a coding agent better?

Retrieval metrics (sections 1–3 of [BENCHMARKS.md](BENCHMARKS.md)) say whether the index finds the
right code. They do not say whether an agent that has the index finishes more tasks, or the same
tasks for less. This benchmark measures that directly: the same model gets the same task in the
same repository, and the configurations ("arms") differ only in the code-navigation tools the
agent may use. What counts is the end result — the task solved or not, checked by an oracle the
agent never sees — and what it cost to get there.

The harness is in [`bench/agentic/`](../bench/agentic/); results and their interpretation are in
[Results](#results).

## Arms

| arm | tools | how graph-indexer is introduced |
|---|---|---|
| `grep` | Read, Grep, Glob, Bash, Edit, Write | — |
| `gi` | graph-indexer **instead of** Grep/Glob: no grep, rg, ag, ack, git grep or find in the shell | tool card (first round) |
| `grep+gi` | built-in tools and graph-indexer | the tool card an MCP client shows: tool descriptions and server instructions |
| `grep+gi+` | built-in tools and graph-indexer | integrated card: decision rules, `grep` with definitions, `check` after editing (first round) |
| `grep+gi2` | built-in tools and graph-indexer | integrated card, second iteration: verification only for changes that cross a function's boundary |
| `gi2` | graph-indexer instead of Grep/Glob, as `gi` | the second card plus `files` for file names |

The agents run as sub-agents, where graph-indexer is used through its CLI, whose commands print
exactly what the MCP tools return. The tool policy of each arm is stated in the instructions and
audited afterwards in every transcript: a `grep` piped from another command or run on a file
outside the repository is filtering, not searching, and is allowed in the grep-free arms.

## Tasks

| suite | what the agent must do | oracle | tasks |
|---|---|---|---|
| **B1** code questions (TypeScript, nestjs) | every call site of a method that shares its name with methods of other classes; callers two levels up; classes implementing an interface | the TypeScript language service (`findReferences`, implementations); score = F1 of the `path:LINE` answer | 15 |
| **B2** multi-site refactors (TypeScript, nestjs) | add a required parameter to a method and pass a value at every call; rename a method whose name other methods share | no type error that the base commit did not have (differential `tsc`), and a structural check that the target changed while the same-name methods did not | 8 + 6 held out |
| **B3** fresh issues (Python: sqlglot, networkx) | fix a real issue from June–September 2026, after the model's training cutoff, described by its behaviour as a user would report it | the tests of the real fix (FAIL_TO_PASS) and the existing tests of the touched modules (PASS_TO_PASS), applied only when grading | 24 |

**B1** targets are drawn from the compiler's view of the repository: methods with same-name
methods elsewhere (so a text search over-matches), and call chains the compiler can resolve.

**B2** tasks are generated (`gen-refactor-ts.mjs`) from methods with 4–15 call sites in at least
two files and same-name methods elsewhere. Each one is validated (`validate-refactor.mjs`) the
way SWE-bench validates gold patches: the unmodified checkout fails, a reference solution computed
with the TypeScript language service passes, and a naive textual solution (change every
`.name(` call) fails — it did on all 8 development tasks and 5 of the 6 held-out ones.

**B3** tasks are mined (`mine-fresh.mjs`) from commits that fix an issue and add tests. The
agent gets an issue-style statement, never the commit message or the diff. It works in a
checkout made of the base snapshot alone — one commit, no remote, none of the later history — so
`git log` cannot reveal the fix, and it is told to work offline.

## Validity rules

- **Hidden answers stay hidden.** Grading applies the hidden tests to the checkout, so a run is
  graded only after its agent has finished; a run graded while its agent was still working is
  discarded and re-run from scratch.
- **Looking the answer up voids the run.** Transcripts are scanned for web searches and fetches,
  upstream `git fetch`/`clone`, package downloads and reads of the benchmark's task files; such
  runs are excluded and re-run under the offline rule.
- **Interrupted runs are re-run.** A run stopped by an infrastructure error (rate limit, lost
  session) is discarded, whatever state its checkout was in.
- **Policy violations stay in** (intention to treat): dropping them would bias an arm towards
  the runs that happened to comply. `report.mjs --exclude-violations` is the sensitivity check.
- Every discard is logged with its reason (`runs/<label>/discarded.tsv`), and the report ignores
  gradings made before it.

## Metrics and statistics

Per run: solved (all checks pass, or F1 = 1 for questions), score, and the agent's usage from its
transcript. Cost is expressed in input-equivalent tokens at list-price ratios:
`input + 1.25 × cache writes + 0.1 × cache reads + 5 × output`. Turns, tool calls, graph-indexer
and grep calls, and wall time are reported alongside.

Arms are compared **paired by task** against `grep`: the difference in solve rate with a
bootstrap 95% CI and an exact McNemar test, the cost ratio with a bootstrap CI and a sign-flip
permutation test, Holm-adjusted across arms, and the cost per solved task.

The acceptance criteria are the gates of the [SOTA plan](PLAN-SOTA.md):

| gate | comparison | criterion |
|---|---|---|
| G1 | integrated arm vs `grep`, multi-site and impact tasks (B1 + B2) | +10 points solved (CI > 0), or no worse than −3 points with cost per solved task ≤ 0.75 |
| G2 | integrated arm vs `grep`, all tasks | no worse than −3 points solved and cost per solved task ≤ 0.85 |
| G3 | grep-free arm vs `grep`, all tasks | no worse than −5 points solved and cost ratio ≤ 1 |
| G4 | integrated arm vs `grep`, simple tasks (one-file fixes of ≤ 40 lines) | cost ratio ≤ 1.10 |
| G5 | graph accuracy against the TypeScript compiler (`bench/eval-graph.mjs`) | precision ≥ 0.99, recall ≥ 0.93 |
| G6 | adoption in the integrated arm on B1 + B2 | graph-indexer used in ≥ 80% of the runs, without forcing it |

## Protocol: a development round and a held-out round

1. **Development round** (snapshots `rc2`/`rc3`, arms `grep`, `gi`, `grep+gi`, `grep+gi+`):
   B1 (8 tasks), B2 (8), B3 (14). The transcripts were read to find where the tools cost more
   than they saved, and graph-indexer was changed accordingly (`rc4`).
2. **Held-out round** (snapshot `rc4`, arms `grep`, `gi2`, `grep+gi2`): tasks that played no
   part in development — B1 (7), a new B2 set (6) generated to avoid every method used before,
   and B3 (10). The held-out round is the estimate to trust; the development round shows where
   the changes came from.

## Results

### Held-out round: 23 tasks, 69 runs

Snapshot `rc4`, one run per task and arm, every run graded by its oracle. **Every run solved its
task in every arm** (69/69), so at this difficulty the tools change what a solution costs, not
whether it is found. Cost ratios are paired by task against `grep` (bootstrap 95% CI).

| suite | tasks | `grep` median cost | `grep+gi2` cost ratio | `gi2` (no grep) cost ratio | turns: `grep` / `grep+gi2` / `gi2` |
|---|---|---|---|---|---|
| B1 callers two levels up | 4 | 328k | **0.66** (0.58–0.77) | 0.68 (0.44–1.08) | 31.0 / 21.8 / 23.3 |
| B1 classes implementing an interface | 3 | 143k | 1.46 (1.25–1.59) | 1.23 (1.07–1.32) | 17.0 / 22.7 / 18.0 |
| B2 multi-site refactors | 6 | 250k | **0.77** (0.68–0.83) | 1.02 (0.80–1.28) | 29.5 / 22.8 / 31.2 |
| B3 fresh issues | 10 | 419k | 0.96 (0.77–1.18) | 1.10 (0.98–1.26) | 36.4 / 35.3 / 39.2 |
| **all** | **23** | | **0.90** (0.77–1.04) | **1.02** (0.89–1.15) | |

Per task (cost in input-equivalent tokens):

| task | `grep` | `grep+gi2` | `gi2` |
|---|---|---|---|
| B1 callers-01 | 237k | 162k | 145k |
| B1 callers-02 | 482k | 280k | 197k |
| B1 callers-03 | 337k | 195k | 419k |
| B1 callers-04 | 318k | 266k | 174k |
| B1 impls-01 | 150k | 187k | 196k |
| B1 impls-02 | 143k | 223k | 152k |
| B1 impls-03 | 128k | 204k | 169k |
| B2 held-01 add-param | 279k | 239k | 318k |
| B2 held-02 rename | 239k | 190k | 341k |
| B2 held-03 add-param | 261k | 202k | 244k |
| B2 held-04 rename | 167k | 98k | 244k |
| B2 held-05 add-param | 227k | 144k | 130k |
| B2 held-06 rename | 405k | 341k | 327k |
| B3 networkx 139259c6 | 243k | 418k | 450k |
| B3 networkx 2aecdbdd | 1008k | 1262k | 1152k |
| B3 networkx 6eb2a1db | 113k | 133k | 140k |
| B3 sqlglot 338bb069 | 526k | 525k | 662k |
| B3 sqlglot 4b84b4d4 | 312k | 346k | 381k |
| B3 sqlglot 4eb2c99a | 160k | 127k | 177k |
| B3 sqlglot 65eb23b5 | 892k | 529k | 807k |
| B3 sqlglot a069a096 | 533k | 377k | 425k |
| B3 sqlglot d53cbc98 | 254k | 256k | 286k |
| B3 sqlglot fa736935 | 585k | 489k | 601k |

**Gates.**

| gate | result | criterion | met |
|---|---|---|---|
| G1 B1 + B2, `grep+gi2` | cost 0.81 (0.70–0.96), no task lost | ≤ 0.75 | no |
| G2 all tasks, `grep+gi2` | cost 0.90 (0.77–1.04), no task lost | ≤ 0.85 | no |
| G3 all tasks, `gi2` | cost 1.02 (0.89–1.15), no task lost | ≤ 1 | no |
| G4 one-file fixes (8 tasks), `grep+gi2` | cost 0.98 (0.83–1.20) | ≤ 1.10 | yes |
| G5 graph accuracy | precision 0.996, recall 0.958 | ≥ 0.99, ≥ 0.93 | yes |
| G6 adoption on B1 + B2 | 13 of 13 runs | ≥ 80% | yes |

Five `gi2` runs used grep or find once despite the policy (kept in, intention to treat); without
them G3 is 1.01 (0.83–1.19).

**Where the difference comes from.** Mean characters of tool output an agent took in per run,
by kind of call (the transcripts, `grep` / `grep+gi2` / `gi2`):

| suite | reading files | text search | graph-indexer | compiler and tests |
|---|---|---|---|---|
| B1 callers | 33.8k / 11.8k / 13.5k | 12.3k / 2.8k / 0 | 0 / 26.6k / 29.9k | — |
| B1 implementations | 13.4k / 12.4k / 11.8k | 10.1k / 7.6k / 0 | 0 / 18.3k / 28.1k | — |
| B2 refactors | 20.8k / 17.7k / 17.1k | 16.9k / 9.5k / 2.3k | 0 / 8.1k / 15.0k | 6.2 / 1.8 / 4.5 runs |
| B3 issues | 58.7k / 55.7k / 54.7k | 12.8k / 7.8k / 0.4k | 0 / 5.3k / 20.4k | 6.0 / 5.9 / 5.8 runs |

- **Multi-site work is where the graph pays.** On caller chains the agent reads a third of the
  source it reads with grep. On refactors the agents checked their edits with `check` and ran the
  compiler far less (1.8 times per task instead of 6.2), in about a quarter fewer turns. Cost
  follows turns, because every turn re-reads the conversation.
- **Fixing a real issue is dominated by reading the code around the fault and running tests** —
  70–80% of what the agent takes in, in every arm. Finding the place is a small share, so a
  better locator cannot move the total much, and run-to-run variance is large (one task cost
  243k with grep and 418k–450k with graph-indexer; another 892k with grep and 529k with
  `grep+gi2`).
- **Where one grep is the right tool, the graph answer costs more.** "Which classes implement X"
  is a single `grep "implements X"`; with graph-indexer the agents confirmed its answer with grep
  and followed subclasses one class at a time.
- **Without grep nothing is lost, but nothing is saved outside questions.** Graph-indexer's
  output is larger than grep's for about the same number of calls (20.4k against 12.8k characters on
  B3), and on refactors the agents verified with the compiler more often (4.5 runs per task).

## Reproducing

```sh
node bench/agentic/prepare.mjs snapshot --label rc4          # freeze the version under test
node bench/agentic/prepare.mjs batch --tasks refactor-nestjs-held.json --arms grep,gi2,grep+gi2 --reps 1 --gi rc4
# launch one agent per printed prompt (any agent harness), then record which agent ran which run:
node bench/agentic/grade-batch.mjs --gi rc4 --register "<agent id> <run id>"
node bench/agentic/grade-batch.mjs --gi rc4 --agents <agent ids>   # only once they have finished
node bench/agentic/report.mjs --gi rc4 --integrated grep+gi2 --nogrep gi2
```

The TypeScript suites need the nestjs fixture (`node bench/fixtures.mjs`); the B3 suites need
local clones of sqlglot and networkx with their history (`bench/agentic/repos.mjs`).

## Limitations

- **One model, sub-agents.** Every run uses the same model as a sub-agent with instructions that
  fix its tools; a harness with the tools actually removed, and with the MCP server and hooks
  wired in, may behave differently.
- **One run per task and arm.** Run-to-run variance of an agent is large; paired comparisons over
  tasks absorb part of it, but differences under about 20% in cost are within noise at this size.
- **Ceiling.** The model solves almost every task in every arm, so the benchmark mostly measures
  cost; a weaker model or harder tasks would test the solve rate.
- **Coverage.** B1 and B2 are TypeScript on one repository; B3 is Python on two.
