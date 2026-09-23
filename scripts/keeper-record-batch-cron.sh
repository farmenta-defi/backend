#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."
exec flock -n /tmp/farmenta-keeper-record-batch.lock bun run src/keeper/run.ts
