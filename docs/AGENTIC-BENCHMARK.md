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
| `grep+gi3` | built-in tools and graph-indexer | third card: `refs` lists indirect subtypes, filters by path and says when a list of calls is complete |
| `gi3` | graph-indexer instead of Grep/Glob, as `gi` | the third card |
| `grep+rules` | Read, Grep, Glob, Bash, Edit, Write | no graph-indexer: only the lookup rules the other fourth-round cards share (several lookups per message, a function or 50–100 lines rather than the file, one search for a definition line, one check at the end) — the control that separates the effect of the rules from that of the tools |
| `grep+gi4` | built-in tools and graph-indexer | fourth card: the same rules, with reads and searches through `gi read` (code plus where each name it uses is defined) and `gi grep` |
| `grep+gi5` | built-in tools and graph-indexer | fifth card: the rules, with definitions read by name through `gi read` and its card trimmed to the rows that matter |
| `grep+gi6` | built-in tools and graph-indexer | sixth card: the control's rules word for word for reading and searching; graph-indexer only for exact uses, callers, impact, the final check and a definition a search missed |

The agents run as sub-agents, where graph-indexer is used through its CLI, whose commands print
exactly what the MCP tools return. The tool policy of each arm is stated in the instructions and
audited afterwards in every transcript: a `grep` piped from another command or run on a file
outside the repository is filtering, not searching, and is allowed in the grep-free arms.

## Tasks

| suite | what the agent must do | oracle | tasks |
|---|---|---|---|
| **B1** code questions (TypeScript, nestjs) | every call site of a method that shares its name with methods of other classes; callers two levels up; classes implementing an interface | the TypeScript language service (`findReferences`, implementations); score = F1 of the `path:LINE` answer | 8 + 7 + 10 + 7 |
| **B2** multi-site refactors (TypeScript, nestjs) | add a required parameter to a method and pass a value at every call; rename a method whose name other methods share | no type error that the base commit did not have (differential `tsc`), and a structural check that the target changed while the same-name methods did not | 8 + 6 + 6 + 1 |
| **B3** fresh issues (Python: sqlglot, networkx) | fix a real issue from June–September 2026, after the model's training cutoff, described by its behaviour as a user would report it | the tests of the real fix (FAIL_TO_PASS) and the existing tests of the touched modules (PASS_TO_PASS), applied only when grading | 24 + 11 |

The counts are the rounds (see [Protocol](#protocol-rounds-and-held-out-tasks)); each round's
tasks were drawn to avoid every method, interface, call chain and fix used before. B2 has a
single task in the fourth round: it was the only method left that met the criteria.

**B1** targets are drawn from the compiler's view of the repository: methods with same-name
methods elsewhere (so a text search over-matches), and call chains the compiler can resolve.
A caller chain counts calls only, from callers inside the question's scope (`packages/`, no
tests); a reference that is not a call is accepted but not required. Getters and setters are
not used as targets: a question about one of a pair does not say which one it means.

**B2** tasks are generated (`gen-refactor-ts.mjs`) from methods with 4–15 call sites in at least
two files and same-name methods elsewhere. Each one is validated (`validate-refactor.mjs`) the
way SWE-bench validates gold patches: the unmodified checkout fails, a reference solution computed
with the TypeScript language service passes, and a naive textual solution (change every
`.name(` call) fails — it did on all 8 development tasks, 5 of the 6 held-out ones and all 6 of
the third round.

**B3** tasks are mined (`mine-fresh.mjs`) from commits that fix an issue and add tests. The
agent gets an issue-style statement, never the commit message or the diff. It works in a
checkout made of the base snapshot alone — one commit, no remote, none of the later history — so
`git log` cannot reveal the fix, and it is told to work offline.

## Validity rules

- **Hidden answers stay hidden.** Grading applies the hidden tests to the checkout, so a run is
  graded only after its agent has finished; a run graded while its agent was still working is
  discarded and re-run from scratch.
- **Looking the answer up voids the run.** Transcripts are scanned for web searches and fetches,
  upstream `git fetch`/`clone`, package downloads, reads of the benchmark's task files and of the
  local clones the worktrees are made from (they hold the later history, the fix included); such
  runs are excluded and re-run under the offline rule.
- **So does reading another run.** The arms of a task run side by side, and in the third round
  one agent opened the answer another arm had written for the same question. The audit now flags
  any access to another run's answer, grading or working copy (listing the run directories or
  reading another task's instructions is recorded but harmless), graded answers are moved out of
  the run directories, and that run was discarded and re-run.
- **Scratch files stay private.** Agents write temporary files (compiler output, small scripts)
  to a directory all runs share; every graded transcript was checked to read there only files
  its own run had written.
- **Ill-posed tasks are withdrawn, not scored.** A question whose answer depends on a reading
  its statement leaves open (a getter and setter of the same name) was withdrawn before any
  comparison and replaced by a new one; the change is logged with the discards.
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

## Protocol: rounds and held-out tasks

1. **Development round** (snapshots `rc2`/`rc3`, arms `grep`, `gi`, `grep+gi`, `grep+gi+`):
   B1 (8 tasks), B2 (8), B3 (14). The transcripts were read to find where the tools cost more
   than they saved, and graph-indexer was changed accordingly (`rc4`).
2. **Held-out round** (snapshot `rc4`, arms `grep`, `gi2`, `grep+gi2`): tasks that played no
   part in development — B1 (7), a new B2 set (6) generated to avoid every method used before,
   and B3 (10).
3. **Third round** (snapshot `rc5`, arms `grep`, `gi3`, `grep+gi3`): the held-out transcripts
   showed where graph-indexer still cost more than grep (which classes implement an interface),
   `rc5` changed that, and new B1 (10) and B2 (6) tasks, none of whose targets had been used,
   measure it. B3 was not repeated.

4. **Fourth round** (snapshots `rc6`/`rc7`, arms `grep`, `grep+rules`, `grep+gi4`, then
   `grep+gi5` and `grep+gi6`): new tasks for all three suites after the reading layer of
   [PLAN-AGENTES.md](PLAN-AGENTES.md) — reads that say where each name they use is defined, and
   the resident process — and a control arm with the lookup rules alone. Two runs per task and
   arm on B3, one on B1 and B2. The fifth and sixth cards were written after the first
   repetition had shown where the fourth cost more (the fourth ran once), and ran on the same
   tasks: they compare arrangements on tasks that played no part in building graph-indexer, but
   they are not a second held-out test.

Each round is held out for the snapshot it tests — its tasks played no part in the changes —
and every comparison is within a round, against the `grep` arm on the same tasks.

## Results

Four rounds, 88 tasks, 359 graded runs. In short:

- **On code questions (B1), graph-indexer next to grep costs less than half of grep alone:** 0.44
  (0.32–0.67) of grep's cost and 0.37 of its time in the fourth round, with the model writing less
  than half the reasoning (12k output tokens per question against 30k). On B1 + B2 it was 0.76,
  0.81 and 0.73 of grep in the first three rounds and 0.48 in the fourth.
- **Fixing real issues (B3) costs 15% less with graph-indexer installed, and the lookup rules
  it installs carry that gain:** 0.85 (0.76–0.96) of grep's cost with the sixth card, 0.86
  (0.76–0.98) with the rules alone; earlier cards cost the same as grep (0.93–1.10). The agent's
  own reasoning and the prefix it re-reads at every call are most of the cost in every arm (see
  [where the cost goes](#measurement-correction-and-where-the-cost-goes)).
- **Reading through graph-indexer gives a cleaner context but not a cheaper run:** with reads by
  name, 42% of the code lines an agent reads fall in the functions its fix changes (13–16%
  otherwise) and it makes a third of the lookups before its first edit, at the same cost.
- **Without grep, nothing is lost and the cost is about the same:** 0.82 (0.59–1.12) on B1 + B2
  in the third round, 1.02 over all tasks in the held-out round.
- **Nearly every run solves its task in every arm** — all 122 in the fourth round — so the
  benchmark mostly measures cost; the one failure in four rounds was a run of the `grep` arm.

### Measurement correction and where the cost goes

Transcripts keep a streamed message's usage from its first snapshot, and the model's reasoning is
stored redacted, so the output tokens counted when these rounds were graded miss most of the
model's reasoning — calls that add 8,600 tokens to the context show 5 output tokens. The output of
a call stays in the context of the next one, so [`transcript.mjs`](../bench/agentic/transcript.mjs)
now recovers it as the growth of the context between two calls minus the tool results in between
(2.63 characters per token, fitted on 301 calls that follow a message without reasoning). The real
cost of a run is 1.3–1.5 times the recorded one; ratios between arms move by at most 0.04. Pooled
over the three rounds, paired by task (`reaudit.mjs --usage`, then the statistics of `report.mjs`):

| suite | tasks | graph-indexer with grep: cost vs `grep` (95% CI) | turns | time | without grep: cost |
|---|---|---|---|---|---|
| B1 | 25 | 0.67 (0.56–0.83) | 0.76 | 0.68 | 0.68 (0.53–0.87) |
| B2 | 20 | 0.81 (0.73–0.89) | 0.85 | 0.82 | 0.96 (0.83–1.11) |
| B1 + B2 | 45 | 0.74 (0.65–0.83) | 0.81 | 0.73 | 0.81 (0.69–0.95) |
| B3 | 24 | 0.95 (0.83–1.07) | 1.00 | 0.96 | 1.04 (0.90–1.21) |
| all | 69 | 0.87 (0.78–0.95) | 0.90 | 0.87 | 0.95 (0.84–1.06) |

Where the cost goes, `grep` arm ([`anatomy.mjs`](../bench/agentic/anatomy.mjs); each part includes
being written once and re-read by every later call):

| | B1 | B2 | B3 |
|---|---|---|---|
| calls / output tokens / real cost | 20.6 / 25k / 319k | 28.9 / 20k / 351k | 46.9 / 55k / 951k |
| fixed prefix (~42k tokens, re-read at every call) | 31% | 38% | 22% |
| generating the model's output | 39% | 29% | 29% |
| re-reading that output in later calls | 18% | 16% | 28% |
| tool results (reads, searches, tests, edits…) | 11% | 15% | 21% |
| time / share spent in the model | 3.2 min / 83% | 2.6 min / 58% | 9.1 min / 59% |

In B3 the agent reaches a file of the fix around its 4th call but first edits around its
15th–19th. Before that it makes ~21 calls, 18 of them searches and reads. 71% of its searches look
for a name it has just seen in the code it read — go-to-definition done with grep, one hop per
call. Only 14% of the code lines it reads fall in the functions the fix changes; 21% with
graph-indexer. Tool output is a fifth of the cost, so shrinking it cannot move B3 much: the lever
is fewer calls and less reasoning ([PLAN-AGENTES.md](PLAN-AGENTES.md)). The per-round tables
below keep the costs recorded when each round was graded.

### Resolved indirection (development, rc8): 11 tasks, 22 runs

After the fourth round, the transcripts showed where an issue's cost goes: 46% hidden reasoning, 26% the fixed prefix re-read every turn, 13% all code read (of which comments, indentation, docstrings and imports are about 4%). About 71% of the reasoning comes before the first edit, and it stayed near 22k tokens in every arm, whatever form the code came in. The agents spent it working out indirection: which override a subclass runs, which `TRANSFORMS` entry handles an expression, what a name built at run time (`getattr(self, f"{key}_sql")`, `dir(cls)` plus `endswith("_sql")`) reaches, what a decorator does. graph-indexer now resolves these statically (`src/query/facts.mjs`) and gives them after reads, in `read_code`, `get_symbol` and the post-read hook. `bench/oracle-facts.mjs` checks them against the running program, importing the repository's modules in the benchmark only. On sqlglot (400 methods, 249 tables), overriding subclasses scored 1.000 precision, inheriting subclasses 1.000 (0.59 before the index took the C3 method resolution order into account) and table keys 0.995. On networkx, overrides scored 0.983 and inheritors 1.000.

The `grep+gi7` arm is `grep+gi6` with source read through `view`: Read's output plus exactly what the post-read hook adds, because hooks do not run in sub-agents. It ran on the fourth round's 11 B3 tasks, with a concurrent `grep` control:

| | `grep` | `grep+gi7` | ratio |
|---|---|---|---|
| cost (mean) | 337k | 320k | **0.95** (CI 0.82–1.10) |
| turns | 27.9 | 27.3 | 0.98 |
| hidden reasoning up to the first edit | 11.8k | 10.3k | 0.87 |
| hidden reasoning after it | 2.9k | 3.3k | 1.14 |
| context precision | 16.6% | 26.6% | ×1.6 |

All 22 runs solved their task. The facts made reading more precise and trimmed some pre-edit thought, but they did not move cost or turns. The mechanism gate (pre-edit reasoning ≤ 0.80 of `grep`) was not met. Agents also read with `sed` or Read in 7 of the 11 `gi7` runs; those runs are counted (intention to treat). The product keeps the facts, since they are cheap, silent when there is nothing to resolve and precise, but they are not the lever for B3.

Two measurement lessons came out of this round:

- **The model had changed since round 4.** The same alias (`claude-sonnet-5`) solved these tasks for 337k mean cost with `grep` alone, against 751k in round 4, and reasoned 11.8k tokens before editing instead of 22k. Comparing a new arm with an earlier round's runs measures the model, not the arm. Every comparison needs a concurrent control, and `report.mjs` now warns when the arms ran on different models.
- **Sub-agents take the session's model unless told otherwise.** The benchmark's sub-agents are launched with `model: sonnet` so that every round runs on the same model. Five runs launched by mistake on the session's model were discarded (`runs/rc8/discarded.tsv`).

With today's model the fixed prefix is 38–39% of an issue's cost. Each turn re-reads it, so the remaining levers are fewer turns and a smaller prefix, including graph-indexer's own share of it (tool definitions and instructions).

### Fourth round: 19 tasks, 122 runs

**What changed.** The reading layer of [PLAN-AGENTES.md](PLAN-AGENTES.md): a read by name or
range says where each name the code uses is defined (file:line and signature); a search that
misses a definition says where it is; a resident process answers the CLI and the hooks without
reopening the index. The round adds a control arm, `grep+rules`, with the lookup rules the
graph-indexer cards share and no graph-indexer, to separate what the rules do from what the tools
do. Snapshot `rc6` ran `grep`, `grep+rules` and `grep+gi4`; `rc7` (`rc6` with a compact
definitions card and `check` naming the closest test functions) ran `grep+gi5` and `grep+gi6`,
written after the first repetition showed that the fourth card's reads cost more than they saved
on issue fixes.

**Tasks.** B1: 7 questions on nestjs (four sets of call sites of methods whose names other
classes share, two caller chains, one set of implementations), none of whose targets had been
used. B2: the one method left that met the refactor criteria (add a required parameter). B3: 8
sqlglot and 3 networkx fixes from June–September 2026; of five networkx candidates, one was
reachable only through a private helper with synthetic input and one had hidden tests that pin
partitions only specific random seeds produce, and both were dropped.

Cost ratios paired by task against `grep` (bootstrap 95% CI; two runs per task and arm on B3, one
on B1 and B2; `grep+gi4` ran once, `grep+gi5` on six sqlglot tasks and one question):

| suite | tasks | `grep` median cost | `grep+rules` | `grep+gi4` | `grep+gi5` | `grep+gi6` |
|---|---|---|---|---|---|---|
| B1 code questions | 7 | 276k | 0.72 (0.63–0.87) | 0.46 (0.33–0.66) | 0.46 (1 task) | **0.44** (0.32–0.67) |
| B2 refactor | 1 | 375k | 0.88 | 0.93 | – | 0.77 |
| B3 issues | 11 | 645k | 0.86 (0.76–0.98) | 0.93 (0.78–1.13) | 0.83 (0.74–0.95; 6 tasks) | **0.85** (0.76–0.96) |
| B3, one-file fixes of ≤ 40 lines | 6 | 594k | 0.91 (0.77–1.12) | 1.12 (0.97–1.32) | 0.82 (3 tasks) | 0.85 (0.77–0.99) |

| suite | `grep`: turns / minutes / output tokens | `grep+rules` | `grep+gi4` | `grep+gi6` |
|---|---|---|---|---|
| B1 | 19.4 / 3.7 / 29.7k | 12.0 / 3.0 / 24.7k | 12.6 / 1.4 / 11.7k | 11.1 / 1.4 / 12.3k |
| B3 | 45.4 / 6.2 / 42.5k | 35.5 / 5.6 / 40.5k | 38.7 / 6.4 / 42.8k | 35.7 / 5.5 / 40.6k |

Every run of every arm solved its task (122 of 122).

**Criteria of [PLAN-AGENTES.md](PLAN-AGENTES.md) §3**, graph-indexer as installed (`grep+gi6`,
the arrangement `init` now writes) against `grep`:

| tasks | cost | time | turns | quality | met |
|---|---|---|---|---|---|
| B3 issues | 0.85 (target 0.70) | 0.90 (0.75) | 0.79 (0.70) | 22/22 solved; context precision ×1.06 (×1.5) | no |
| B1 + B2 | 0.48 (0.60) | 0.42 (0.65); B2 alone 0.97 | 0.59 (0.65) | F1 1.00; the refactor compiles | yes — B2 has one task |
| B4: one-file fixes | 0.85 (≤ 1.05) | 0.86 (≤ 1.05) | — | 12/12 solved | yes |

**What the round shows.**

- **On code questions the tools carry the gain, and they cut the model's reasoning.** With
  `refs` and `callgraph` the agent answered in 11 turns instead of 19, and it wrote 12.3k output
  tokens per question against 29.7k with grep and 24.7k with the rules alone: an answer that is
  exact and says it is complete leaves little to deliberate. The rules alone reach 0.72.
- **On issues the rules carry the gain, and the tools add nothing measurable on top.** The rules
  take the agent from 45 to 35.5 calls per issue (0.86 of the cost); the sixth card, which adds
  graph-indexer for uses, impact and the final check, lands at the same place (0.85), task by
  task within noise. The fixed prefix and the model's own output are more than half of the cost
  in every arm (52–59%), and the number of turns drives both.
- **Reading through graph-indexer makes the context cleaner, not the run cheaper.** On the six
  tasks every arm ran, the fifth card's agents — definitions read by name — made 7 lookups before
  their first edit against 19–22 with the agent's own reads (13.5 with the fourth card), and 42% of the code lines they read fell in
  the functions the fix changes, against 13–16%. They spent the same (629k against 618k for the
  sixth card and 570k for the rules alone): tool output was as large, and the work after the
  first edit did not shrink. The fourth card, whose reads carried every definition, cost more
  than grep on one-file fixes (1.12). `init`, the session rules and the server instructions
  therefore follow the sixth card.
- **Half of an issue's cost comes after the first edit**: tests, a second look at the change,
  and in several runs a search for the subclasses that inherit the edited method — e.g. the
  parsers of three dialects built on MySQL's — which `gi check` did not name, so it proposed only
  the edited class's tests. After the round, `check_changes` and `change_impact` list the
  subclasses that inherit a changed method (and those that override it) and add their tests;
  that change is not measured yet.
- **Measurement.** The log of discarded runs carried agent ids where the discard time belongs,
  which made the report drop the re-runs of five `grep+gi6` runs cut short by a usage limit and
  of one control run; the report now rejects such lines. A `grep+rules` run that read another
  run's graded output, outside its checkout, was discarded and re-run.

### Third round: 16 tasks, 48 runs

**What changed in `rc5`.** In the held-out round one kind of question cost more with
graph-indexer than with grep: which classes implement an interface, directly or through a
subclass (cost 1.46 with `grep+gi2`). The agents took graph-indexer's list of direct
implementations, followed each subclass with another call, and confirmed the result with grep.
In `rc5`, `refs` on a class or interface also lists the types that inherit it indirectly, each
with the type it goes through; `refs --path DIR` limits any list to a directory and says how many
references are elsewhere; and a list of calls ends by saying when it is complete — every call
with that name in the indexed files is bound, here or to the definitions it names — so there is
nothing left to grep for. The third card mentions the three in one line.

Snapshot `rc5`, one run per task and arm, on new tasks. Every `grep+gi3` and `gi3` run solved its
task (16/16 each); the `grep` arm solved 15 of 16 — on one caller chain it missed a caller and
listed a line that is not one (F1 0.88). Cost ratios are paired by task against `grep`
(bootstrap 95% CI):

| suite | tasks | `grep` median cost | `grep+gi3` cost ratio | `gi3` (no grep) cost ratio | turns: `grep` / `grep+gi3` / `gi3` |
|---|---|---|---|---|---|
| B1 call sites of a method with same-name methods | 2 | 168k | **0.52** (0.41–0.90) | **0.48** (0.41–0.72) | 16.0 / 10.0 / 10.0 |
| B1 callers two levels up | 4 | 323k | 0.65 (0.42–1.25) | 0.65 (0.35–1.43) | 29.3 / 20.0 / 18.8 |
| B1 classes implementing an interface | 4 | 142k | **0.62** (0.53–0.73) | **0.80** (0.73–0.91) | 16.3 / 10.8 / 12.8 |
| B2 multi-site refactors | 6 | 281k | 0.88 (0.72–1.01) | 1.03 (0.71–1.45) | 29.0 / 24.3 / 27.5 |
| **B1 + B2** | **16** | | **0.73** (0.58–0.90) | 0.82 (0.59–1.12) | |

Per task (cost in input-equivalent tokens):

| task | `grep` | `grep+gi3` | `gi3` |
|---|---|---|---|
| B1 calls-01 | 75k | 68k | 54k |
| B1 calls-02 | 262k | 108k | 108k |
| B1 callers-02 | 171k | 234k | 240k |
| B1 callers-03 | 202k | 232k | 293k |
| B1 callers-04 | 531k | 221k | 142k |
| B1 callers-05 | 444k (F1 0.88) | 187k | 204k |
| B1 impls-01 | 147k | 83k | 113k |
| B1 impls-02 | 99k | 77k | 96k |
| B1 impls-03 | 192k | 98k | 155k |
| B1 impls-04 | 138k | 96k | 95k |
| B2 r3-01 add-param | 267k | 266k | 323k |
| B2 r3-02 rename | 251k | 197k | 176k |
| B2 r3-03 add-param | 154k | 155k | 100k |
| B2 r3-04 rename | 296k | 310k | 576k |
| B2 r3-05 add-param | 315k | 177k | 229k |
| B2 r3-06 rename | 299k | 287k | 228k |

**Gates.**

| gate | result | criterion | met |
|---|---|---|---|
| G1 B1 + B2, `grep+gi3` | cost per solved task 0.68 (0.49–0.90), cost 0.73 (0.58–0.90), one task more solved | ≤ 0.75 | yes, on the point estimate; the interval reaches 0.90 |
| G2–G4 | need B3, which this round did not repeat | | – |
| G5 graph accuracy | precision 0.996, recall 0.958 (`rc5`); 0.960 with the fixes below | ≥ 0.99, ≥ 0.93 | yes |
| G6 adoption on B1 + B2 | 16 of 16 runs | ≥ 80% | yes |

Two `gi3` runs used grep or find once, both on refactors (kept in, intention to treat); without
them `gi3` costs 0.72 (0.53–0.96) on B1 + B2.

**Where the difference comes from.** Mean characters of tool output per run, by kind of call
(`grep` / `grep+gi3` / `gi3`):

| suite | reading files | text search | graph-indexer | compiler and tests |
|---|---|---|---|---|
| B1 callers | 42.7k / 11.8k / 11.7k | 16.7k / 1.7k / 0 | 0 / 36.9k / 39.1k | — |
| B1 implementations | 14.3k / 9.7k / 10.2k | 15.3k / 0.8k / 0 | 0 / 7.2k / 16.2k | — |
| B2 refactors | 22.2k / 23.7k / 46.1k | 14.8k / 8.4k / 0.1k | 0 / 11.8k / 16.2k | 4.5 / 3.7 / 3.2 runs |

- **Implementations now cost less with graph-indexer than with grep** (0.62, from 1.46). One
  `refs` call lists the direct and the indirect implementations with the class each goes
  through, and the agents stopped following subclasses one at a time: 3.5 graph-indexer calls
  and 0.8 greps per task, against 17.3 greps with grep alone.
- **Caller chains read a quarter of the source**, as in the held-out round (11.8k characters
  against 42.7k), and every graph-indexer run returned the exact set. The cost ratio, 0.65, has a
  wide interval: two of the four chains cost more with graph-indexer, the two largest less than
  half.
- **Refactors: 0.88 with grep available, 1.03 without.** One grep-free run read 150k characters
  of compiler output (576k in all); the grep-free arm was cheaper than grep on four of the six
  tasks. The drop in compiler runs seen in the held-out round (1.8 against 6.2 per task) did not
  repeat (3.7 against 4.5).
- **The runs exposed recall gaps, fixed after the round.** A `.build()` at the end of a chain
  formatted one call per line was too long to follow, and calls on callback parameters typed
  only by the function they are passed to (`helpers.createServerAndClient((err, server, client)
  => client.sendMessage(…))`) were unbound. graph-indexer had flagged the first one as a call to
  check; for the second it only said that some same-name calls were unbound, and the agents
  found them with a text search. Both are now followed — `TcpSocket.sendMessage` lists all nine
  calls and says the list is complete — together with chains that start with `(await …)` and
  parameters of function types, which were taken for local variables; a possibly missed call in
  a file that uses a subclass inheriting the method is now flagged too. Against the compiler,
  recall went from 0.958 to 0.960 and exact sets from 0.887 to 0.902, precision unchanged at
  0.996; localization and search are unchanged.

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

### Development round: 30 tasks, 120 runs

Snapshots `rc2`/`rc3`, one run per task and arm; every run solved its task. Cost ratios against
`grep`, paired by task (bootstrap 95% CI):

| suite | tasks | `grep` median cost | `grep+gi+` | `grep+gi` | `gi` (no grep) |
|---|---|---|---|---|---|
| B1 call sites of a method with same-name methods | 8 | 126k | **0.67** (0.59–0.77) | 0.86 (0.60–1.21) | 0.77 (0.62–1.00) |
| B2 multi-site refactors | 8 | 304k | **0.80** (0.62–0.99) | 0.91 (0.81–1.01) | 0.84 (0.67–1.04) |
| B3 fresh issues | 14 | 612k | 0.97 (0.83–1.11) | 0.99 (0.88–1.11) | 1.01 (0.81–1.26) |
| **all** | **30** | | **0.93** (0.81–1.03) | 0.97 (0.87–1.06) | 0.97 (0.81–1.17) |

Presented only as an MCP server's tool card (`grep+gi`), graph-indexer was used little outside
the questions (1.2 calls per B3 run) and saved little; the integrated card, with decision rules
and a check after editing, is what made the difference on B1 and B2. Gates: G1 0.76 (target
0.75), G2 0.93 (0.85), G3 0.97 (met), G4 1.06 (met), G6 100% (met). Fourteen `gi` runs used
grep or find despite the policy, most of them to read a configuration file.

## What the rounds leave open

- **Fixing issues.** In the fourth round B3 cost fell 15% with graph-indexer installed, and
  the lookup rules alone gave the same; neither reads that carry definitions nor cleaner context
  lowered it further. What is left to try is what removes turns after the first edit — a check
  that names every subclass that runs the changed code and its tests (added after the round), and
  hooks that bring the next hop to the agent's own reads, searches and edits without a call —
  measured on new B3 tasks and with real hooks ([PLAN-AGENTES.md](PLAN-AGENTES.md)).
- **Impact through supertypes.** `impact` counts a call bound to a base-class or interface method
  as reaching every override, even when the receiver's static type cannot reach it; recording
  that type at indexing time would remove these false positives.
- **Recall gaps that remain** (object literals typed by an interface, destructuring, class
  expressions; see [BENCHMARKS.md](BENCHMARKS.md#1-reference-accuracy-against-the-typescript-compiler)).
- **Wider and repeated measurement:** B1 and B2 on more repositories and languages, and several
  runs per task and arm — with one run, a 20% difference in cost is at the edge of what the
  intervals can show.
- **The real integration:** the MCP server and hooks inside the agent harness instead of
  sub-agents following instructions. [`run-headless.mjs`](../bench/agentic/run-headless.mjs)
  launches prepared runs with `claude -p` — the `mcp` arm with the MCP server and the block
  `init` writes, `mcp+hooks` with the Claude Code hooks as well — and registers the stream-json
  transcripts for grading; it needs an authenticated `claude` CLI, which the sessions that ran
  the rounds so far did not have (hooks declared by a project sub-agent do not run inside those
  sessions either, which was checked).

## Reproducing

```sh
node bench/agentic/prepare.mjs snapshot --label rc5          # freeze the version under test
node bench/agentic/prepare.mjs batch --tasks refactor-nestjs-r3.json --arms grep,gi3,grep+gi3 --reps 1 --gi rc5
# launch one agent per printed prompt (any agent harness), then record which agent ran which run:
node bench/agentic/grade-batch.mjs --gi rc5 --register "<agent id> <run id>"
node bench/agentic/grade-batch.mjs --gi rc5 --agents <agent ids>   # only once they have finished
node bench/agentic/report.mjs --gi rc5 --integrated grep+gi3 --nogrep gi3
```

The TypeScript suites need the nestjs fixture (`node bench/fixtures.mjs`); the B3 suites need
local clones of sqlglot and networkx with their history (`bench/agentic/repos.mjs`).

**With the real MCP server and hooks.** On a machine with an authenticated `claude` CLI,
[`run-headless.mjs`](../bench/agentic/run-headless.mjs) runs each prepared run with `claude -p`:
`mcp` gets graph-indexer's MCP server and the block `init` writes, `mcp+hooks` also gets the
Claude Code hooks, and `grep` / `grep+rules` run with the built-in tools. For the fourth round's
tasks:

```sh
node bench/fixtures.mjs                                   # nestjs (B1, B2)
git clone --filter=blob:none https://github.com/tobymao/sqlglot.git /tmp/gi-agentic/repos/sqlglot
git clone --filter=blob:none https://github.com/networkx/networkx.git /tmp/gi-agentic/repos/networkx
node bench/agentic/prepare.mjs snapshot --label local
for t in qa-nestjs-r4 refactor-nestjs-r4 fresh-sqlglot-r4 fresh-networkx-r4; do
  node bench/agentic/prepare.mjs batch --tasks $t.json --arms grep,grep+rules,mcp,mcp+hooks --reps 1 --gi local >/dev/null
done
node bench/agentic/run-headless.mjs --gi local --runs all --concurrency 2   # add --model M to pin one
node bench/agentic/grade-batch.mjs --gi local --agents all --transcripts /tmp/gi-agentic/transcripts/local
node bench/agentic/report.mjs --gi local --integrated mcp+hooks --nogrep grep+rules
```

`GI_AGENTIC_WORK` moves the work area from `/tmp/gi-agentic`. The 76 runs use the account's
quota: in the fourth round a run cost between 0.1M and 1.9M input-equivalent tokens, and an
issue took 1–15 minutes.

## Limitations

- **One model, sub-agents.** Every run uses the same model as a sub-agent with instructions that
  fix its tools; a harness with the tools actually removed, and with the MCP server and hooks
  wired in, may behave differently.
- **One run per task and arm.** Run-to-run variance of an agent is large; paired comparisons over
  tasks absorb part of it, but differences under about 20% in cost are within noise at this size.
- **Ceiling.** The model solves almost every task in every arm, so the benchmark mostly measures
  cost; a weaker model or harder tasks would test the solve rate.
- **Coverage.** B1 and B2 are TypeScript on one repository; B3 is Python on two. The third
  round did not repeat B3, so for fixing issues the held-out round's estimate (`rc4`) stands.
