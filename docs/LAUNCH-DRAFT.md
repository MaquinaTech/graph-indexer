# Launch draft (not for publication yet)

Status: **draft, gated.** The plan ([PLAN-REFERENCIA.md](PLAN-REFERENCIA.md) §4–5) holds the launch
until gate P1 (agent sessions on real issues at ≤ 0.70 of the cost of working without the index)
and P2 (cost per solved task no worse than CodeGraph's). Neither is met: on Sonnet 5.5 the agent
solves the B3 issues alone, never calls graph-indexer, and the hooks make it 7% dearer. Every number below is
measured, with its source; the losses are stated next to the wins. Update the numbers from the
linked documents before publishing; do not round them up.

## Show HN title

> Show HN: graph-indexer – exact code references for AI agents, checked against the compilers

## Post (≈ 300 words)

graph-indexer indexes a repository locally (no network, no dependencies beyond Node 22.5) and gives
coding agents, over MCP or a CLI, the exact references of a symbol: who calls this method — this
one, not every method with the same name — what implements this interface, what a change breaks.

We measure that exactness against each language's own compiler or type checker instead of
asserting it ([docs/BENCHMARKS.md](BENCHMARKS.md)):

- TypeScript (nestjs): precision 0.997, recall 0.962 against the TypeScript compiler.
- Go (gin, caddy, nats-server): precision ≥ 0.992, recall ≥ 0.972 against go/types.
- Java (spring-petclinic, jsoup, Commons Collections): precision 0.955–0.994, recall 0.861–0.989 against javac.
- Python (six repositories) against pyright: precision 0.871–0.998, recall 0.929–0.998.
- Rust (serde_json, ripgrep, tokio) against rust-analyzer: precision 0.930–0.955, recall 0.582–0.841.

The same oracles score other tools through their own MCP servers (the arena, `bench/arena/`). On
nestjs, precision / recall 0.993 / 0.886 against 0.743 / 0.755 (CodeGraph 1.6.2) and 0.559 / 0.263
(codebase-memory-mcp 0.11.0); on fastapi 0.997 / 0.826 against 0.652 / 0.363 and 0.929 / 0.571.
Cold index of nestjs: 1.9 s against 3.0 s and 11.8 s. **Where we lose:** our answers are the
largest — 310 tokens median against 80 and 96.

It also follows the links no compiler sees, each audited by an independent reading: HTTP routes
to handlers; dependency injection (NestJS: 45 edges, none wrong; Spring: 312 injection points on
four applications); Vue and Svelte template tags to their components (3,602 / 3,604 on
open-webui); ORM models to the migrations that touch their tables and Prisma's client calls (none
of 2,671 statements and 1,073 calls wrong).

**What we have not shown:** that it makes an agent cheaper on real issues. With Claude Sonnet 5.5,
on 26 issues fixed upstream after its training cutoff, the agent solved all of them with and
without graph-indexer and never called it; with the hooks that add context to its reads it cost
more, 1.07 (1.01–1.12) of the cost without them.
The benchmark, its tasks and that result are in [docs/AGENTIC-BENCHMARK.md](AGENTIC-BENCHMARK.md).

## Numbers to recheck before publishing

| claim | source | value now |
|---|---|---|
| oracle scores per language | README "Languages", BENCHMARKS §1 (documented seeds: `--seed 11` for TS, 7 for Python) | TS 0.997 / 0.962, reproduced 2026-10-12 |
| arena | BENCHMARKS "The arena" | as above, CodeGraph 1.6.2, codebase-memory-mcp 0.11.0 |
| framework edges | BENCHMARKS sections on injection, components, ORM | as above |
| B1 questions, real sessions (rt1) | AGENTIC-BENCHMARK "Real sessions (rt1)" | 12/12 with graph-indexer, 9/12 without; cost 0.89 (0.82–0.96) |
| B2 refactors, real sessions (rt1) | same | 8/8 both; cost 1.03 (0.87–1.27) |
| B3 issues, Sonnet 5.5 (b3h2, b3h3, b3h4) | AGENTIC-BENCHMARK | 1.00 (0.88–1.15), 1.05 (0.96–1.15), 1.07 (1.01–1.12) |

## Not to say

- Any token or cost saving without its interval and its task set.
- "Faster" or "cheaper agents" in general: B3 says otherwise today.
- Comparisons with a competitor whose arm we have not configured as its own documentation says.
