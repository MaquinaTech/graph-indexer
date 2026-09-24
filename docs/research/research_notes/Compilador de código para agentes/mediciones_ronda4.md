# Where round-4 agents spend: headroom of each "compiler pass" (measured 2026-09-24)

Source: the 118 graded round-4 transcripts (rc6 + rc7; B3 = 89 runs on 11 fresh issues from sqlglot and networkx, B1 = 29 runs on NestJS code questions), same selection as `bench/agentic/report.mjs` (discards applied, latest valid run per task/arm/rep). Cost units = input + 1.25·cacheWrite + 0.1·cacheRead + 5·output; each token added to the context is priced once as written and then as re-read by every later call. Hidden reasoning = output recovered from context growth minus the visible text and tool-call inputs (thinking text is not stored in the transcripts). Scripts: scratchpad `r4/headroom.mjs`, `phases.mjs`, `reason.mjs`, `byarm.mjs`.

## Share of real cost by content (all arms pooled)

| Content | B3 (fresh issues) | B1 (questions) |
|---|---|---|
| Hidden reasoning (generated + re-read every later turn) | **46.0%** | **51.3%** |
| Fixed prefix (system prompt, tools, task) re-read every turn | **25.8%** | **29.9%** |
| Code read: code characters | 8.0% | 4.0% |
| Code read: indentation | 2.2% | 0.5% |
| Code read: line-number prefixes | 1.2% | 0.4% |
| Code read: comments + docstrings | 1.1% | 0.1% |
| Code read: imports | 0.2% | 0.6% |
| Code read: lines already read earlier in the run | 0.4% | 0.0% |
| Search results | 4.0% | 3.6% |
| Tool-call inputs: edits | 2.0% | 0.6% |
| Tool-call inputs: shell (scripts, tests, searches) | 3.1% | 2.3% |
| Test / other results | 3.3% | 1.5% |
| Visible text | 0.3% | 0.3% |

Everything a lossless "lowering" of source text can remove (indentation, line numbers, comments, docstrings, imports, blank lines, re-reads) is **≈5% of B3 cost**; all code read is ≈13%. A syntax-level compiler cannot reach the −30% target; the cost sits in reasoning and in the number of turns.

## Reasoning follows decisions, not tokens read (B3)

- Hidden reasoning: 34.6k tokens per run; 17.7 turns before the first edit at ~1.39k tokens per turn, 19.7 turns after it at ~0.51k per turn. **~71% of reasoning happens before the first edit.**
- Reasoning right after a read: mean 1.38k for reads of 300–1k tokens and 1.38k for 1k–3k tokens (flat); after a search of <300 tokens it is still 0.73k. It barely depends on the size of the observation: each observation→decision cycle costs ~0.7–1.4k tokens of thought.
- Share of reasoning by the preceding observation: read 38%, search 24%, graph-indexer 9%, agent's own python scripts 7%, first turn 6%, tests 6%.

## Pre-edit reasoning is invariant across every arm tried (same 6 sqlglot tasks)

| Arm | turns before 1st edit | reasoning before | turns after | reasoning after |
|---|---|---|---|---|
| grep | 19.8 | 22.8k | 26.0 | 13.3k |
| grep+rules | 14.2 | 21.8k | 16.7 | 10.1k |
| grep+gi4 (reads with definition cards) | 16.2 | 24.9k | 22.0 | 13.9k |
| grep+gi5 (definitions by name, compact) | 14.2 | 22.3k | 20.8 | 11.0k |
| grep+gi6 (product arrangement) | 16.1 | 21.2k | 18.7 | 11.0k |

Fewer turns before the edit did not lower the thought spent understanding the issue (~22k tokens): fewer, larger observations just raised reasoning per turn. What the arms did change is the number of turns (prefix re-reads) and the post-edit loop.

## What the calls are (B3, per run)

- Before the first edit: 9.9 reads, 9.7 searches, 1.9 graph-indexer, 0.4 python scripts.
- After it: 4.8 test runs, 3.9 edits, 3.6 searches, 3.1 ad-hoc python scripts (reproductions/experiments), 3.0 reads, 1.7 git (stash to compare against the base, diff).
- Qualitatively (sqlglot and networkx transcripts), the pre-edit chains resolve **indirection**: which override of `_parse_ordered` a dialect runs (class hierarchy), which generator method or `TRANSFORMS` entry handles an expression, what a decorator (`@py_random_state`, `@_dispatchable`) does to the arguments, what a module exports (`__all__`), and how sibling code follows the same convention (searches for other functions with the same decorators or signature shape). After the edit, they check the subclasses that inherit the change and whether failing tests fail on the base too.
