#!/usr/bin/env bash

set -euo pipefail

cd "$HOME/uhttp"

case "${1:-}" in
  published)
    runs="benchmarks/results/runs"
    skip_tracked=1
    ;;
  smoke)
    runs="benchmarks/results/.smoke/runs"
    skip_tracked=0
    ;;
  *)
    echo 'usage: remote-list-runs.sh published|smoke' >&2
    exit 2
    ;;
esac

[ -d "$runs" ] || exit 0

for directory in "$runs"/*/; do
  [ -d "$directory" ] || continue
  id="$(basename "$directory")"
  if [ "$skip_tracked" = "1" ]; then
    tracked="$(git ls-files -- "$runs/$id")"
    [ -z "$tracked" ] || continue
  fi
  printf '%s\n' "$id"
done
