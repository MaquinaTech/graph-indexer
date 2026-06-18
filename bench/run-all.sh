#!/bin/bash
# Non-core cheap matrix + parity. Waits for the detached core runner first so
# every build-time/throughput number is measured without CPU/Ollama contention.
cd "$(dirname "$0")/.."
echo "=== waiting for core runner to finish ==="
while pgrep -f "run-list.sh" >/dev/null 2>&1; do sleep 5; done
echo "=== core runner done $(date) — non-core cheap matrix ==="
for fx in react django rust spring android aspnet rails laravel symfony css cjson nvm alamofire; do
  for cfg in L1 E0 O0; do node bench/cell.mjs "$fx" "$cfg"; done
done
echo "=== cheap matrix done $(date) — parity (all 18) ==="
node bench/parity.mjs axios express-js nestjs fastapi gin react django rust spring android aspnet rails laravel symfony css cjson nvm alamofire
echo "=== ALL CHEAP+PARITY DONE $(date) ==="
