#!/bin/sh
# Seeds the compose demo with real runs of examples/rag (once; later starts keep the data).
set -e
cd /opt/scope/examples/rag
if scope runs --json --limit 1 | grep -q '"number"'; then
  echo "Demo data already present."
  exit 0
fi
scope run workflows/support.yaml --no-fail --quiet
scope run workflows/support.yaml --variant terse --variant narrow --no-baseline --no-fail --quiet
# A variant compared with the committed baseline: fails its regression gate.
scope run workflows/support.yaml --variant terse --baseline baselines/support.json --no-fail --quiet
echo "Seeded the demo with four runs."
