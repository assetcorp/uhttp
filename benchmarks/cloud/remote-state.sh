#!/usr/bin/env bash

set -uo pipefail

cd "$HOME" || exit 1

if [ ! -e bench.pid ]; then
  echo none
elif [ -e bench.done ]; then
  echo "done:$(cat bench.status 2>/dev/null)"
elif grep -qs remote-run.sh "/proc/$(cat bench.pid)/cmdline"; then
  echo active
else
  echo stale
fi
