#!/bin/bash
# Sequential cell runner: avoids Ollama/CPU thrash. Args: pairs "fixture:config"
cd "$(dirname "$0")/.."
for pair in "$@"; do
  fx="${pair%%:*}"; cfg="${pair##*:}"
  node bench/cell.mjs "$fx" "$cfg"
done
echo "ALL DONE: $*"
