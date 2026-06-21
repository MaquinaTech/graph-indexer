#!/bin/bash
# bench/_rerun-v2.sh [phase]
#
# Re-runs the per-fixture grid against the EXPANDED (higher-powered) suites, using the
# SAME measurement protocol as run-focused.sh (cold cell.mjs builds; query-time variants
# reuse the on-disk index; nondeterministic HyDE/rerank scored 3× via repeat-score.mjs).
#
# Restructured into phases so the affordable, highest-coverage work lands FIRST and the
# expensive qwen3:4b builds come last (and can be interrupted without losing the bulk):
#   phase1  — L1,E0,O0 + nomic HyDE/rerank family (O0H,O0R,O0HR ×3) for ALL 18 fixtures.
#             The nomic family REUSES the O0 build (no qwen), so this whole phase has zero
#             qwen3 builds — it re-establishes the cheap-tier winners + HyDE/rerank coverage
#             at full power for every fixture.
#   phase2  — qwen3:4b family (O2 + O2H,R0,O2HR ×3) for the contested/heavy subset, ordered
#             cheapest-build-first; rails/nestjs (the ~70/56-min builds) last.
#   phase3  — enrichment (R1 + R2 ×3) for the fixtures where it is a documented winner/contender.
#
# Markers: bench/results/.seg2__<fixture>__<seg>  (distinct from the n=3 run's .seg__).
# Resumable: a finished segment is skipped; an interrupted one redoes its own cold build.
cd "$(dirname "$0")/.."
RES="bench/results"; LOG="bench/logs/rerun-v2.log"; mkdir -p "$RES" bench/logs
REPS="${BENCH_REPEATS:-3}"
log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
seg_done() { [ -f "$RES/.seg2__$1__$2" ]; }
seg_mark() { touch "$RES/.seg2__$1__$2"; }

ALL18=(axios express-js nestjs fastapi gin react django rust spring android aspnet rails laravel symfony css cjson nvm alamofire)
# qwen subset: the fixtures where qwen3:4b / heavy stack plausibly changes the winner
# (the documented heavy/contested set), cheapest-qwen-build first, rails+nestjs last.
QWEN_SET=(alamofire laravel rust spring gin symfony django nestjs rails)
ENRICH_SET=(rust spring laravel symfony)   # nestjs/rails: enrichment skipped (TS regress / ~2.5h build)

seg_cheap_nomic() {
  local fx="$1"; seg_done "$fx" cheapnomic && { log "SKIP $fx/cheapnomic"; return; }
  log "=== $fx / cheap+nomic (L1,E0,O0,O0H,O0R,O0HR) ==="
  node bench/cell.mjs "$fx" L1 || return 1
  node bench/cell.mjs "$fx" E0 || return 1
  node bench/cell.mjs "$fx" O0 || return 1                # leaves nomic index on disk
  node bench/repeat-score.mjs "$fx" O0H  "$REPS" || return 1
  node bench/repeat-score.mjs "$fx" O0R  "$REPS" || return 1
  node bench/repeat-score.mjs "$fx" O0HR "$REPS" || return 1
  seg_mark "$fx" cheapnomic
}
seg_qwen() {
  local fx="$1"; seg_done "$fx" qwen && { log "SKIP $fx/qwen"; return; }
  log "=== $fx / qwen family (O2 + O2H,R0,O2HR) — SLOW build ==="
  node bench/cell.mjs "$fx" O2 || return 1
  node bench/repeat-score.mjs "$fx" O2H  "$REPS" || return 1
  node bench/repeat-score.mjs "$fx" R0   "$REPS" || return 1
  node bench/repeat-score.mjs "$fx" O2HR "$REPS" || return 1
  seg_mark "$fx" qwen
}
seg_enrich() {
  local fx="$1"; seg_done "$fx" enrich && { log "SKIP $fx/enrich"; return; }
  log "=== $fx / enrichment (R1 + R2) — SLOWEST build ==="
  node bench/cell.mjs "$fx" R1 || return 1
  node bench/repeat-score.mjs "$fx" R2 "$REPS" || return 1
  seg_mark "$fx" enrich
}

PHASE="${1:-all}"
run_phase1() { log "########## PHASE 1: cheap+nomic for all 18 ##########"; for fx in "${ALL18[@]}"; do seg_cheap_nomic "$fx" || log "!! $fx cheapnomic FAILED"; done; }
run_phase2() { log "########## PHASE 2: qwen subset ##########"; for fx in "${QWEN_SET[@]}"; do seg_qwen "$fx" || log "!! $fx qwen FAILED"; done; }
run_phase3() { log "########## PHASE 3: enrichment subset ##########"; for fx in "${ENRICH_SET[@]}"; do seg_enrich "$fx" || log "!! $fx enrich FAILED"; done; }

case "$PHASE" in
  phase1) run_phase1 ;;
  phase2) run_phase2 ;;
  phase3) run_phase3 ;;
  all)    run_phase1; run_phase2; run_phase3 ;;
  *) echo "usage: $0 [phase1|phase2|phase3|all]"; exit 2 ;;
esac
log "########## RERUN-V2 ($PHASE) COMPLETE ##########"
