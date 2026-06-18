#!/bin/bash
# Costly configs on the representative subset. O2 and R1 carry the qwen3:4b build
# cost; R0 reuses O2's index + query-rerank, R2 reuses R1's index + query-rerank,
# so the expensive embed build runs once per (fixture, embed-variant), not twice.
# Gated behind run-all.sh so Ollama isn't shared and timings stay clean.
cd "$(dirname "$0")/.."
echo "=== waiting for run-all to finish ==="
while pgrep -f "run-all.sh" >/dev/null 2>&1; do sleep 10; done
echo "=== costly subset start $(date) ==="
for fx in express-js gin rust alamofire spring django; do
  node bench/cell.mjs "$fx" O2          # cold build: qwen3-embedding:4b
  node bench/cell.mjs "$fx" R0 --reuse  # + query-time rerank (qwen2.5-coder:7b)
  node bench/cell.mjs "$fx" R1          # cold build: qwen3:4b + enrichment (qwen2.5-coder:1.5b)
  node bench/cell.mjs "$fx" R2 --reuse  # + query-time rerank
  echo "--- $fx costly done $(date) ---"
done
echo "=== COSTLY SUBSET DONE $(date) ==="
