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
| `ask-grep` | a general-purpose sub-agent with the built-in tools | none: it gets a question as the message a main agent sends when it hands one off, and its reply is the answer |
| `ask-explore` | Claude Code's built-in Explore agent (read-only search) | none, with the same message |
| `ask-helper` | graph-indexer, through the structural helper | the helper's instructions (`src/cli/helper.mjs`, what `init` installs as the sub-agent's system prompt), then the same message |
| `cc` | a real Claude Code session with the tools it ships with, sub-agents (Explore, general-purpose) included | none |
| `cc+gi` | the same session with graph-indexer's MCP server | as `init --no-helper` installs it: the server and the CLAUDE.md block |
| `cc+gi+helper` | the same, with the structural helper among the sub-agents | as `init` installs it; the main agent decides on its own whether to hand a question to the helper |

The agents run as sub-agents, where graph-indexer is used through its CLI, whose commands print
exactly what the MCP tools return — except the `cc` arms, which are real sessions (`claude -p`,
[`run-headless.mjs`](../bench/agentic/run-headless.mjs)) where graph-indexer is the MCP server. The tool policy of each arm is stated in the instructions and
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
5. **Resolved indirection** (snapshot `rc8`, arms `grep` and `grep+gi7`): the fourth round's B3
   tasks again, after the facts of `src/query/facts.mjs` were built from their transcripts — a
   development comparison, with a control run at the same time.
6. **A smaller model** (snapshot `rc8small`, the product of `rc8` unchanged; arms `grep`,
   `grep+gi7` and, on B3, `grep+rules`): the fourth round's B1 and B3 tasks and the B2 tasks of
   the third and fourth rounds, run by a smaller model at half the usual model's price per token.
7. **Delegated questions** (snapshot `rc9`, arms `ask-grep`, `ask-explore`, `ask-helper`): 24
   new code questions (set `r5`), each given as the message a main agent sends when it hands a
   question off — to a general-purpose sub-agent with grep, to Claude Code's Explore agent and to
   the structural helper `init` now installs — all on the smaller model.

8. **Real sessions** (prepared, not yet run; arms `cc`, `cc+gi`, `cc+gi+helper`): 12 new code
   questions (set `r6`) and 8 refactors — the two new targets left (set `r5`) and the six of the
   held-out round — each given to a Claude Code session with its usual model, so that the main
   agent chooses whether to hand work to a sub-agent. The report is in dollars, since the helper
   runs on a smaller model; `session-round.mjs` runs it (see Reproducing).

Each of the four rounds and the delegation round is held out for the snapshot it tests — its tasks
played no part in the changes. The resolved-indirection and smaller-model comparisons reuse
earlier tasks. Every comparison is within a round, against the `grep` (or `ask-grep`) arm on the
same tasks, run at the same time.

## Results

Four rounds (88 tasks, 359 graded runs), two later comparisons on earlier tasks (83 runs) and a
round of delegated questions on 24 new ones (72 runs). In short:

- **On code questions (B1), graph-indexer next to grep costs less than half of grep alone, and it
  is what makes a smaller model answer them right:** 0.44 (0.32–0.67) of grep's cost and 0.37 of
  its time in the fourth round, with the model writing less than half the reasoning (12k output
  tokens per question against 30k). A smaller model, at half the price per token, answered all 7
  of that round's questions exactly with graph-indexer and 5 of 7 with grep alone, at 0.26
  (0.18–0.50) of the cost and 0.32 of the time: a tenth of what the usual model spent with grep.
  On B1 + B2 graph-indexer cost 0.76, 0.81 and 0.73 of grep in the first three rounds and 0.48 in
  the fourth.
- **Handed to graph-indexer's structural helper, a code question costs a quarter as much and takes
  a quarter of the time.** On 24 new questions asked the way a main agent delegates them, the
  helper (the smaller model with graph-indexer, as `init` installs it) answered as many exactly
  as a general-purpose sub-agent with grep — 20 of 24 — at 0.24 (0.18–0.33) of its cost and 0.28
  of its time; Claude Code's Explore agent came to 0.76. Whichever answers, the agent that asked
  gets about 170 tokens back instead of the 23k that looking it up itself adds to its context.
- **Multi-site refactors (B2) cost a fifth to a third less:** 0.81 (0.73–0.89) pooled over three
  rounds with the usual model, 0.69 (0.56–0.87) with the smaller one; every refactor passed its
  checks in every arm.
- **Fixing real issues (B3) costs the same with or without graph-indexer.** In the fourth round
  graph-indexer as installed cost 0.85 (0.76–0.96) of grep and its lookup rules alone 0.86
  (0.76–0.98), so the rules carry that gain; facts that resolve the code's indirection after each
  read (0.95, 0.82–1.10) and a smaller model (1.05, 0.82–1.46) did not lower it. The agent's own
  reasoning and the prefix it re-reads at every call are most of the cost in every arm (see
  [where the cost goes](#measurement-correction-and-where-the-cost-goes)).
- **Reading through graph-indexer gives a cleaner context but not a cheaper run:** with reads by
  name, 42% of the code lines an agent reads fall in the functions its fix changes (13–16%
  otherwise) and it makes a third of the lookups before its first edit, at the same cost; with
  facts after each read, 27–29% against 12–17%.
- **Without grep, nothing is lost and the cost is about the same:** 0.82 (0.59–1.12) on B1 + B2
  in the third round, 1.02 over all tasks in the held-out round.
- **The usual model solves nearly every task in every arm** — all 122 in the fourth round — so
  with it the benchmark mostly measures cost; its one failure in four rounds was a run of the
  `grep` arm. The smaller model missed 2 of 7 questions and 1 of 11 issues with grep alone, one
  issue with the rules alone, and none with graph-indexer; on the 24 delegated questions every
  arm missed 4, all of them two-level caller questions.

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

### Delegated questions (rc9): 24 new questions, 72 runs

A smaller model with graph-indexer answered the fourth round's code questions as the usual model
did, at a tenth of its spend (below). This round measures that where it would be used: a main
agent handing a structural question to a helper. `init` now installs one for Claude Code
(`.claude/agents/code-structure.md`, instructions in [`src/cli/helper.mjs`](../src/cli/helper.mjs)):
a read-only sub-agent on a small model that answers call-site, caller, subclass and impact
questions from the index and replies with the list alone. The sessions that run the benchmark
cannot let a sub-agent start another, so each run is the delegated part: a sub-agent gets the
message a main agent sends — the repository, the question and the answer format — and its reply
is graded. Three sub-agents get the same message, all on the smaller model:

- `ask-grep`, a general-purpose sub-agent with the built-in tools — the main agent's own tools;
- `ask-explore`, Claude Code's Explore agent, the read-only searcher it delegates to today;
- `ask-helper`, the structural helper with graph-indexer.

The 24 questions (set `r5`, targets unused by earlier sets, answers from the TypeScript compiler)
are 12 lists of call sites of a method that shares its name with others, 7 lists of callers and
callers of callers, and 5 lists of the classes that extend a class, directly or through another —
a new kind. One run per question and arm; the 72 runs started within eight minutes. The harness
makes a sub-agent hand its result back with a tool call and nudges it once or twice afterwards;
the figures stop at the answer (with those turns the cost ratios are 0.28 and 0.77).

Paired by question against `ask-grep` (bootstrap 95% CI):

| arm | solved | mean F1 | cost (mean) | cost ratio | time (mean) | time ratio | calls | context the work added | reply |
|---|---|---|---|---|---|---|---|---|---|
| `ask-grep` | 20 / 24 | 0.97 | 215k | 1 | 118 s | 1 | 28.6 | 22.8k tokens | 173 tokens |
| `ask-explore` | 20 / 24 | 0.98 | 164k | 0.76 (0.66–0.89) | 94 s | 0.80 | 26.3 | 24.4k | 180 |
| `ask-helper` | 20 / 24 | 0.98 | 52k | **0.24** (0.18–0.33) | 33 s | **0.28** | 4.7 | 5.9k | 171 |

By kind of question (solved, mean cost, mean time):

| kind | `ask-grep` | `ask-explore` | `ask-helper` |
|---|---|---|---|
| call sites (12) | 12 · 128k · 67 s | 12 · 100k · 58 s | 12 · 33k · 15 s |
| callers of callers (7) | 3 · 443k · 247 s | 3 · 337k · 196 s | 3 · 96k · 76 s |
| subclasses (5) | 5 · 104k · 58 s | 5 · 73k · 40 s | 5 · 33k · 15 s |

**What it shows.**

- **The helper answers as often and as exactly, for a quarter of the cost and time.** It made 4.7
  calls per question against 28.6, and wrote about 4k output tokens against 11k. The gain holds for
  every kind of question: 0.26 of the cost on call sites, 0.22 on callers of callers, 0.32 on
  subclasses.
- **Delegating keeps the asking agent's context clean whoever answers.** Every arm replied with
  the list alone (about 170 tokens). Looking the answer up in its own context would have added
  about 23k tokens with grep, which every later call of that agent reads again.
- **Explore is cheaper than a general-purpose sub-agent (0.76), but not a structural tool.** It
  searched as much (26 calls) and missed the same questions. In Claude Code, Explore runs on the
  main model ([research notes](research/research_notes/Impacto%20real%20de%20indexaci%C3%B3n%20en%20agentes/integracion_en_agentes.md));
  the helper declares the small model, so its work is billed at the small model's price.
- **Every arm missed four two-level caller questions, for different reasons.** Of the helper's
  four: on one, three calls go through a receiver the compiler cannot type (`this.socketModule`,
  loaded at run time), which all three arms listed and the compiler's answer leaves out; on one,
  the helper added the method that encloses a nested caller, where the index's answer was exact;
  the other two were the index's. It listed every `new InstanceWrapper()` as a caller of
  `InstanceWrapper.initialize` — a method called `initialize` was taken for a constructor in
  every language, while it is one only in Ruby — and missed a call on a value taken from a
  `new Map<K, V>()`; and it left out that a recursive method is one of its own callers. All three
  were fixed after the round: the index alone then answered 22 of the 24 questions exactly, against
  20, and the two it missed were two calls it flags for checking (a receiver it cannot type), which
  the helper checked and got right. Against the TypeScript compiler over 400 symbols, recall went
  from 0.960 to 0.961 and exact sets from 0.902 to 0.905, with precision unchanged. A second pass
  closed those two as well — `this` inside an anonymous class (`return class extends ModuleRef
  {…}`), which the index had bound to the class around it, and the values of a class that extends
  `Map` handed to `forEach` — and the index alone now answers all 24; exact sets 0.907.
- In `rc8small` the smaller model with grep spent 0.35 of what the usual model spent with grep on
  code questions; at 0.24 of that, the helper would come to under a tenth — an estimate across
  rounds and question sets, not a measurement.

### A smaller model (rc8small): 25 tasks, 61 runs

The usual model solves nearly every task in every arm, so the rounds below could only measure
cost. This comparison runs the product of `rc8`, unchanged, with a smaller model at half the usual
model's price per token, to answer two questions: do the gains on code questions and refactors
hold on a current model, against a control run at the same time; and do exact structural answers
let a cheaper model do what the usual one does?

It uses the fourth round's 7 code questions and 11 issues, and 7 refactors (the fourth round's one
and the third round's six). The arms are `grep` and `grep+gi7` (graph-indexer as installed, with
the post-read hook given through `view`), one run per task and arm. On issues, a third arm,
`grep+rules`, separates the lookup rules from the tools, as in the fourth round. The harness runs
at most 20 sub-agents at once; the other runs started as those finished, all within about an hour.

Within the smaller model, paired by task against `grep` (bootstrap 95% CI):

| suite | arm | tasks | solved (`grep` / arm) | cost ratio | time ratio | calls (`grep` → arm) |
|---|---|---|---|---|---|---|
| B1 code questions | `grep+gi7` | 7 | 5 / 7 | **0.26** (0.18–0.50) | 0.32 | 29.9 → 9.0 |
| B2 refactors | `grep+gi7` | 7 | 7 / 7 | **0.69** (0.56–0.87) | 0.75 | 34.1 → 28.1 |
| B3 issues | `grep+gi7` | 11 | 10 / 11 | 1.05 (0.82–1.46) | 1.16 | 48.2 → 55.7 |
| B3 issues | `grep+rules` | 11 | 10 / 10 | 1.19 (0.92–1.48) | 1.20 | 48.2 → 57.1 |

Spend per task at list prices, relative to the usual model with `grep` (the smaller model's tokens
count half), and tasks solved:

| suite | usual model, `grep` | usual model, graph-indexer | smaller model, `grep` | smaller model, graph-indexer |
|---|---|---|---|---|
| B1 (7) | 1.00 · 7/7 | 0.44 · 7/7 | 0.35 · 5/7 | **0.09** · 7/7 |
| B2 (7) | 1.00 · 7/7 | 0.86 · 7/7 | 0.37 · 7/7 | **0.26** · 7/7 |
| B3 (11) | 1.00 · 11/11 | 0.95 · 11/11 | 0.68 · 10/11 | 0.71 · 11/11 |

The usual model's runs are those of the fourth round (B1 and one refactor, `grep+gi6`), the third
round (the other refactors, `grep+gi3`) and `rc8` (issues, `grep+gi7`, run the same day as this
comparison). Its cost on issues halved between the fourth round and `rc8`. If its cost on
questions and refactors fell as much, the smaller model with graph-indexer spends about a fifth of
what it spends with grep on questions and about half on refactors.

**What it shows.**

- **On code questions, graph-indexer is what makes the smaller model reliable.** With it, the
  smaller model answered all 7 questions exactly, in 9 calls and 39 seconds on average. With grep
  alone it missed a call site in one answer and named a wrong caller in another (F1 0.92 and
  0.89), and took 30 calls, two minutes and 7.1k tokens of hidden reasoning before writing its
  answer, against 2.7k. Its answers matched the usual model's at a tenth of what the usual model
  spent with grep and a fifth of what it spent with graph-indexer. Two tasks out of seven are not
  a significant difference in accuracy (McNemar p = 0.5); the differences in cost and time are.
- **On refactors, the smaller model gets every one right with or without graph-indexer**, and
  graph-indexer cuts its cost by 31%, to about a quarter of the usual model's spend with grep.
- **On issues, neither the tools nor the rules lower the cost.** Graph-indexer came to 1.05 of
  grep's cost and the rules alone to 1.19, and each arm solved 10 or 11 of the 11. Reading
  through `view` was more precise — 29% of the code lines read fall in the functions the fix
  changes, against 12.5% with grep and 18% with the rules — but those agents made more calls. The
  issue grep failed was solved in the other two arms, and the issue the rules failed was solved in
  the other two: at one run per task that is run-to-run variance (the same issue cost 535k with
  grep and 1,322k with graph-indexer). After nine of the eleven issues graph-indexer stood at 0.84
  (0.78–0.94); the last two, the longest, took it to 1.05. With grep alone, the smaller model
  solved 10 of the 11 issues at 0.68 of the usual model's spend.
- The smaller model used graph-indexer's commands on questions and refactors (1.4 and 3.4 calls
  per run) but hardly on issues (0.9), and read source with `sed` or `head` instead of `view` in
  7 of the 11 issue runs and 2 of the 7 refactors (kept, intention to treat).
- The audit counted writing a script with `cat > file.py` as reading source. The pattern now
  excludes writes, and the runs were re-audited.

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

- **The model had changed since round 4.** The same model alias solved these tasks for 337k mean cost with `grep` alone, against 751k in round 4, and reasoned 11.8k tokens before editing instead of 22k. Comparing a new arm with an earlier round's runs measures the model, not the arm. Every comparison needs a concurrent control, and `report.mjs` now warns when the arms ran on different models.
- **Sub-agents take the session's model unless told otherwise.** The benchmark's sub-agents are now launched on a fixed model, the one the earlier rounds used, so that every round runs on the same model. Five runs launched by mistake on the session's model were discarded (`runs/rc8/discarded.tsv`).

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

- **Fixing issues: closed.** In the fourth round B3 cost fell 15% with graph-indexer installed,
  and the lookup rules alone gave the same. Nothing tried since lowered it further: not reads that
  carry definitions, not a cleaner context, not facts that resolve the code's indirection after
  each read (`rc8`, 0.95), not a smaller model (1.05). What an issue costs is the model's own
  reasoning and the prefix it re-reads at every call, which a code index does not reach, so this
  line of work is closed ([PLAN-AGENTES.md](PLAN-AGENTES.md)); only the real integration (below)
  is left to measure there.
- **Delegation inside a session.** The delegated part is measured (`rc9`): the structural
  helper answers as exactly as the main agent's own tools, at a quarter of the cost and time, and
  hands back about 170 tokens. What is left is the rest of the session: whether a main model hands
  structural questions to the helper at the right moments, and what a clean context saves over a
  long task. The sessions that ran the rounds could not start sub-agents from sub-agents, so this
  runs in real sessions: the round is prepared (protocol item 8, `session-round.mjs`) and needs a
  machine with an authenticated `claude`.
- **Impact through supertypes.** `impact` counts a call bound to a base-class or interface method
  as reaching every override, even when the receiver's static type cannot reach it; recording
  that type at indexing time would remove these false positives.
- **Recall gaps that remain** (object literals typed by an interface, destructuring, generic
  instantiation; see
  [BENCHMARKS.md](BENCHMARKS.md#1-reference-accuracy-against-the-typescript-compiler)). The
  index flags the calls it could not bind for checking.
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

Delegated questions: prepare the `ask-*` arms, launch each run as the sub-agent type its
`meta.json` names (`agentType`) with the printed prompt, and report from `ask-grep`:

```sh
node bench/agentic/gen-qa-ts.mjs --repo test/fixtures/nestjs --name nestjs --scope packages/ --seed 5 \
     --calls 12 --callers 7 --impls 5 --subclasses 5 --impl-max 30 --set r5
node bench/agentic/prepare.mjs batch --tasks qa-nestjs-r5.json --arms ask-grep,ask-explore,ask-helper --reps 1 --gi rc9
node bench/agentic/report.mjs --gi rc9 --baseline ask-grep --family qa --to-answer
```

The TypeScript suites need the nestjs fixture (`node bench/fixtures.mjs`); the B3 suites need
local clones of sqlglot and networkx with their history (`bench/agentic/repos.mjs`).

Every arm of a comparison must run on the same model, launched at the same time: sub-agents take
the session's model unless they are given one, and `report.mjs` warns when the arms of a
comparison ran on different models. To compare models, run each on its own label and read their
reports side by side; spend is cost × the model's price per input token, since both cost units
and prices weigh output, cache writes and cache reads the same way.

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

**Real sessions and the helper (protocol item 8).** One command prepares, checks, runs, grades
and reports the round:

```sh
node bench/fixtures.mjs --only nestjs
npm install -g typescript                      # grades the refactors (or set TYPESCRIPT_PATH)
node bench/agentic/session-round.mjs --model M --pilot    # 1 question + 1 refactor per arm
node bench/agentic/session-round.mjs --model M            # the 20 tasks × 3 arms
```

`--model` pins the sessions' model (the usual model of the earlier rounds, for comparison with
them); without it the CLI's default runs.

It freezes the working graph-indexer, prepares the runs (a graph-indexer arm's run directory gets
the CLAUDE.md block, and the helper arm's also `.claude/agents/code-structure.md`, as `init` writes
them), and starts one short session per arm that must show the Agent tool, the graph-indexer server
connected and the helper offered only where it belongs — nothing else runs if one of them does
not. The sessions run under `acceptEdits` with Bash and graph-indexer's tools allowed, the web
tools off, no MCP server but graph-indexer's and none of the machine's own settings, with a
ceiling of $5 each (`--max-budget`). The report (`/tmp/gi-agentic/reports/<label>.md`) compares
dollars, every model included, and adds a table of what the main agent handed to sub-agents, to
which, and the context it carried itself. With the usual model the 60 sessions should come to
tens of dollars, billed to the account the `claude` CLI is logged in with (a subscription's quota,
or `ANTHROPIC_API_KEY`); the runs are graded where they ran, since the answers and edits stay in
the work area.

## Limitations

- **Two models, sub-agents.** Every run uses the usual model, or in two comparisons a smaller
  one, as a sub-agent with instructions that fix its tools; a harness with the tools actually
  removed, and with the MCP server and hooks wired in, may behave differently. Sub-agents here
  cannot start sub-agents, so delegation is measured as the delegated part, and the helper's
  instructions reach it in its first message instead of as its system prompt.
- **One run per task and arm.** Run-to-run variance of an agent is large; paired comparisons over
  tasks absorb part of it, but differences under about 20% in cost are within noise at this size.
  With the smaller model, the estimate for issues moved from 0.84 after nine tasks to 1.05 after
  eleven.
- **Ceiling.** The usual model solves almost every task in every arm, so with it the benchmark
  mostly measures cost. The smaller model missed some tasks with grep alone, but on 31 questions
  (7 in `rc8small`, 24 in `rc9`) the arms with and without graph-indexer differ by two answers,
  too few to measure a difference in accuracy.
- **Coverage.** B1 and B2 are TypeScript on one repository; B3 is Python on two. The third
  round did not repeat B3, so for fixing issues the held-out round's estimate (`rc4`) stands.
