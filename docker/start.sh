#!/bin/sh

set -eu

cleanup() {
  if [ -n "${API_PID:-}" ] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

pnpm --filter @llm-council-search/api start &
API_PID=$!

exec pnpm --filter @llm-council-search/web exec next start --hostname 0.0.0.0 -p 4000
