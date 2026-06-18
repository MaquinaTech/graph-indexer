# BENCH_TIER1_BASELINE.md — pre-fix numbers (every later gate compares against these)

Captured on the unmodified engine (HEAD `13daaff`, branch `feat/prompts`, working tree clean of engine
edits). All numbers extracted from the harness, none estimated. Cold rebuilds (`bench/cell.mjs <fx> L1`
does `rm -rf .graph-indexer` then a clean build). This is the reference for the three Tier-1 fixes.

## The floor (the one invariant that must never regress)

**Floor = overall (pooled, tuning-channel) symbolic rank-1 across the 5 core suites, lexical-only,
from `node test/evaluate.mjs --json` = `npm run test:eval`.** Reproduced to 4 decimals against the
committed `test/BENCH_BASELINE.md:381`:

| Core metric (lexical-only, tuning, pooled across axios/express-js/nestjs/fastapi/gin) | value | n |
|---|---|---|
| **symbolic rank-1 — THE FLOOR (must stay ≥ 0.7536)** | **0.7536** | 69 |
| semantic rank-1 | 0.1935 | 31 |
| semantic s@5 | 0.6129 | 31 |
| overall strict s@5 | 0.8065 | 100 |
| file-only inflation | 0.1163 | 100 |
| held-out symbolic rank-1 | 1.0000 | 10 |
| held-out semantic rank-1 / s@5 | 0.40 / 0.60 | 5 |

> **Naming note (reconciled, honest):** the task brief calls the floor "held-out symbolic rank-1 = 0.7536".
> Measured, the *held-out* symbolic rank-1 is actually **1.00** (n=10); the number **0.7536** is the
> **overall tuning-channel symbolic rank-1** (n=69), exactly as recorded in `test/BENCH_BASELINE.md:381`
> ("Lexical-only, tuning channel, from evaluate.mjs --json"). The intent is unambiguous — *symbolic
> rank-1 must not fall below 0.7536* — so that is the metric every fix is gated on below. Held-out
> symbolic (1.00) is reported too and must not fall either.

Per-suite symbolic rank-1 (the granularity Fix 3's "zero regression on other fixtures" check uses):

| core suite | symbolic rank-1 | n |
|---|---|---|
| axios | 0.786 | 14 |
| express-js | 0.786 | 14 |
| nestjs | 0.571 | 14 |
| fastapi | 0.786 | 14 |
| gin | 0.846 | 13 |

## Per-fixture baseline — the 5 fix-relevant fixtures

`sym r1` / `sem r1` are mean `rank1Strict` over the tuning rows split by `difficulty` (matches the
`bench/synth.mjs` doc derivation: css 42.9%, cjson 62.5% reproduce the published numbers exactly).

| fixture | lang | chunks | files | chunks/file | sym r1 (n) | sem r1 (n) | file-only | callGraph category | callerEdges | calleesIndexedDefs | distinctCallees | type_refs | token save top-5 / amort |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **aspnet** | C# | 373 | 224 | 1.67 | 62.5% (8) | 50.0% (2) | 0.0% | **none** | 0 | 0 | 0 | empty | 19.3% / 65.1% |
| **laravel** | PHP | 699 | 699 | 1.00 | 62.5% (8) | 0.0% (3) | 27.3% | **none** | 0 | 0 | 0 | populated (72.2%) | 32.4% / 72.7% |
| **symfony** | PHP | 407 | 307 | 1.33 | 77.8% (9) | 33.3% (3) | 0.0% | **none** | 0 | 0 | 0 | populated (58.7%) | 57.6% / 86.1% |
| **css** | SCSS | 440 | 85 | 5.18 | 42.9% (7) | 25.0% (4) | 9.1% | degraded | 0 | 0 | 6 | empty | 65.4% / 79.4% |
| **cjson** | C | 562 | 54 | 10.41 | 62.5% (8) | 25.0% (4) | 41.7% | **yes** (control) | 1045 | 255 | 457 | populated (9.3%) | 91.9% / 96.8% |

Call-site field counts (from `bench/structural.mjs`): aspnet / laravel / symfony all have **`call_sites = 0`**
(dead call-graph — the W2 weakness). cjson has 1918 call_sites (83.1% of chunks carry a call) — the
positive control proving the verifier and parser path work.

### What each fix targets (and what cannot move)

- **Fix 1 (C#):** aspnet `callGraph: none → yes`. Floor cannot move (no C# in the core suites). PHP/css/cjson untouched.
- **Fix 2 (PHP):** laravel + symfony `callGraph: none → yes`. **Pre-measured caveat:** laravel has only
  **10 / 772 PHP files > 200 lines**, so the god-class method-split fires on ~10 classes — chunks/file
  will barely rise above 1.0 and the W4 token-savings goal (>50%) is *unlikely* to be met by method-chunks
  alone (this is a property of the fixture, not of the fix). symfony has 48 files > 200 lines → more splitting.
  Floor cannot move (no PHP in the core suites). The risk is PHP *symbolic rank-1* shifting if a winning
  whole-class chunk fragments.
- **Fix 3 (name-boost, global query-time):** css 42.9% → ≥ 71% (need +2 of 7), cjson 62.5% → ≥ 75% (need
  +1 of 8). This is the only fix that can move the floor and the other 16 fixtures — gated on the full
  strict suite.

## Parity

`node test/sqlite.mjs` → **6 passed, 0 failed** (green). Backends share `fuseAndRank` / `buildLexicalDocument`
/ `LANGUAGE_QUERIES` / `extractCallSites`, so parity holds by construction — re-verified after every fix.

## Reproduce

```bash
for fx in aspnet laravel symfony css cjson; do node bench/cell.mjs "$fx" L1; done
node test/evaluate.mjs --json     # floor = pooled tuning symbolic rank-1 (0.7536)
node test/sqlite.mjs              # parity
node bench/structural.mjs aspnet laravel symfony css cjson
node bench/verify-structural.mjs aspnet laravel symfony css cjson   # callGraph.category
node bench/tokens.mjs aspnet laravel symfony css cjson
```
