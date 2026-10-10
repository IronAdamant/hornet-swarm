#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p images/runner/build
pnpm exec esbuild packages/runner/src/main.ts \
  --bundle --platform=node --format=esm \
  --external:playwright --external:playwright-core \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile=images/runner/build/main.js
docker build -f images/runner/Dockerfile -t aegis-runner:local .
pnpm --filter @aegis/controller build
docker build -f images/proxy/Dockerfile -t aegis-proxy:local .
echo "images ready: aegis-runner:local aegis-proxy:local"
