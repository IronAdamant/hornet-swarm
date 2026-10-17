#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm --filter @hornet-swarm/core build
mkdir -p images/runner/build
pnpm exec esbuild packages/runner/src/main.ts \
  --bundle --platform=node --format=esm \
  --external:playwright --external:playwright-core --external:axe-core \
  --banner:js="import { createRequire as __hornetCreateRequire } from 'node:module'; const require = __hornetCreateRequire(import.meta.url);" \
  --outfile=images/runner/build/main.js
docker build -f images/runner/Dockerfile -t hornet-swarm-runner:local .
# The controller typechecks against the report package, so that package is built first.
pnpm --filter @hornet-swarm/report build
pnpm --filter @hornet-swarm/controller build
docker build -f images/proxy/Dockerfile -t hornet-swarm-proxy:local .
echo "images ready: hornet-swarm-runner:local hornet-swarm-proxy:local"
