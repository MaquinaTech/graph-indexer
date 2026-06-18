#!/bin/bash
# Final pass: after the costly subset, rebuild every fixture to a canonical clean
# L1 (memory) so structural/token probes read a consistent index, then synth docs.
cd "$(dirname "$0")/.."
ALL="axios express-js nestjs fastapi gin react django rust spring android aspnet rails laravel symfony css cjson nvm alamofire"
echo "=== run-final waiting for run-costly to finish ==="
while pgrep -f "run-costly.sh" >/dev/null 2>&1; do sleep 15; done
echo "=== final canonical L1 rebuild $(date) ==="
for fx in $ALL; do node bench/cell.mjs "$fx" L1 >/dev/null 2>&1 && echo "  L1 $fx ok"; done
echo "=== structural + tokens $(date) ==="
node bench/structural.mjs $ALL
node bench/tokens.mjs $ALL
echo "=== synth docs $(date) ==="
node bench/synth.mjs
node bench/synth-agent.mjs
echo "=== RUN-FINAL DONE $(date) ==="
