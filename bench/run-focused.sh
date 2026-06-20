#!/bin/bash
# bench/run-focused.sh [fixture ...]
#
# Drives the FOCUSED per-fixture best-config grid (the measure-then-document task).
# Heavy configs are measured only where they can change the held-out winner; the 12
# fixtures whose cheap config already saturates held-out s@5=1.00 are NOT rebuilt
# here (documented as pruned in BENCH_PER_FIXTURE.md).
#
# Ollama is a SERIAL bottleneck on one machine, so every cell runs sequentially —
# no parallelism (it would only thrash qwen3:4b). Nondeterministic query-time
# configs (HyDE / rerank) are scored 3× via bench/repeat-score.mjs.
#
# Build/reuse ordering is critical: bench/cell.mjs wipes .graph-indexer before each
# cold build, so ALL reuse-scorings of one embed index must finish BEFORE the next
# cold build overwrites it. The segments below enforce that: each segment is one
# cold build followed immediately by its query-time reuse-scorings.
#
# RESUMABLE at segment granularity: a completed segment drops a marker under
# bench/results/.seg__<fixture>__<seg>; a re-run skips finished segments and redoes
# only an interrupted one (which is safe — it rebuilds its own index).
#
# Usage:
#   bash bench/run-focused.sh                 # full focused grid, in order
#   bash bench/run-focused.sh laravel symfony # only these fixtures
cd "$(dirname "$0")/.."
RES="bench/results"
LOG="bench/logs/focused-grid.log"
mkdir -p "$RES" bench/logs
REPS="${BENCH_REPEATS:-3}"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
seg_done() { [ -f "$RES/.seg__$1__$2" ]; }
seg_mark() { touch "$RES/.seg__$1__$2"; }

# ── Segments ────────────────────────────────────────────────────────────────────
seg_cheap() {  # L1 + E0 + O0 cold builds (lexical, in-process MiniLM, nomic)
  local fx="$1"; seg_done "$fx" cheap && { log "SKIP $fx/cheap"; return; }
  log "=== $fx / cheap (L1,E0,O0) ==="
  node bench/cell.mjs "$fx" L1 || return 1
  node bench/cell.mjs "$fx" E0 || return 1
  node bench/cell.mjs "$fx" O0 || return 1   # leaves nomic index on disk
  seg_mark "$fx" cheap
}
seg_nomic() {  # nomic index + HyDE / rerank / HyDE+rerank (3× each)
  local fx="$1"; seg_done "$fx" nomic && { log "SKIP $fx/nomic"; return; }
  log "=== $fx / nomic family (O0 + O0H,O0R,O0HR ×$REPS) ==="
  node bench/cell.mjs "$fx" O0 || return 1                  # cold nomic build (+ scores O0)
  node bench/repeat-score.mjs "$fx" O0H  "$REPS" || return 1
  node bench/repeat-score.mjs "$fx" O0R  "$REPS" || return 1
  node bench/repeat-score.mjs "$fx" O0HR "$REPS" || return 1
  seg_mark "$fx" nomic
}
seg_qwen() {   # qwen3:4b index + HyDE / rerank / HyDE+rerank (3× each)
  local fx="$1"; seg_done "$fx" qwen && { log "SKIP $fx/qwen"; return; }
  log "=== $fx / qwen family (O2 + O2H,R0,O2HR ×$REPS) — SLOW build ==="
  node bench/cell.mjs "$fx" O2 || return 1                  # cold qwen3:4b build (+ scores O2)
  node bench/repeat-score.mjs "$fx" O2H  "$REPS" || return 1
  node bench/repeat-score.mjs "$fx" R0   "$REPS" || return 1   # qwen + rerank
  node bench/repeat-score.mjs "$fx" O2HR "$REPS" || return 1
  seg_mark "$fx" qwen
}
seg_enrich() { # qwen3:4b + enrichment index + rerank (R2, 3×)
  local fx="$1"; seg_done "$fx" enrich && { log "SKIP $fx/enrich"; return; }
  log "=== $fx / enrichment family (R1 + R2 ×$REPS) — SLOWEST build ==="
  node bench/cell.mjs "$fx" R1 || return 1                  # cold qwen3:4b + enrichment build
  node bench/repeat-score.mjs "$fx" R2 "$REPS" || return 1     # + query rerank
  seg_mark "$fx" enrich
}

# ── Profiles ────────────────────────────────────────────────────────────────────
# Cost-shaped per fixture. laravel/symfony have NO prior O2/R1 data → full grid
# (incl. enrichment, to also confirm the coverage finding). spring/rust already
# carry single-run R1/R2 that show enrichment winning there → we add the HyDE
# families + 3× qwen-rerank but REUSE the existing enrichment rows rather than
# pay the ~20-min R1 rebuild again. nestjs/rails skip enrichment (TS regresses
# under rerank/enrichment per repo memory; rails R1 ~2.5h is prohibitive). The
# saturated subset (winner already a cheap config) gets the cheap nomic-HyDE
# family only — enough to characterize HyDE without the slow qwen rebuilds.
profile_heavy_full() { seg_nomic "$1" && seg_qwen "$1" && seg_enrich "$1"; }  # laravel, symfony
profile_heavy_qwen() { seg_nomic "$1" && seg_qwen "$1"; }                     # spring, rust, nestjs, rails
profile_subset_hyde() { seg_nomic "$1"; }                                     # gin, django, express-js, alamofire

run_fixture() {
  local fx="$1"
  case "$fx" in
    laravel|symfony)                    profile_heavy_full "$fx" ;;
    spring|rust|nestjs|rails)           profile_heavy_qwen "$fx" ;;
    gin|django|express-js|alamofire)    profile_subset_hyde "$fx" ;;
    *) log "WARN no profile for $fx — skipping" ;;
  esac
}

# Default order = most-valuable-first so an early interrupt still yields the cells
# that decide contested winners. The two big qwen builds (nestjs ~30m, rails ~80m)
# go LAST so the smaller contested fixtures land first.
DEFAULT_ORDER=(laravel symfony spring rust gin django express-js alamofire nestjs rails)
FIXTURES=("$@"); [ ${#FIXTURES[@]} -eq 0 ] && FIXTURES=("${DEFAULT_ORDER[@]}")

log "########## FOCUSED GRID START — fixtures: ${FIXTURES[*]} (reps=$REPS) ##########"
for fx in "${FIXTURES[@]}"; do
  log ">>>>>>>>>> fixture: $fx"
  run_fixture "$fx" || log "!!!!!!!!!! $fx FAILED (continuing) !!!!!!!!!!"
  log "<<<<<<<<<< fixture: $fx done"
done
log "########## FOCUSED GRID COMPLETE ##########"
