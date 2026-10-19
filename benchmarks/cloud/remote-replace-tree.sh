#!/usr/bin/env bash

set -euo pipefail

cd "$HOME"

[ -d uhttp.new ] || { echo 'remote-replace-tree: ~/uhttp.new is missing' >&2; exit 1; }

for runs in benchmarks/results/runs benchmarks/results/.smoke/runs; do
  [ -d "uhttp/$runs" ] || continue
  mkdir -p "uhttp.new/$runs"
  for directory in "uhttp/$runs"/*/; do
    [ -d "$directory" ] || continue
    id="$(basename "$directory")"
    if [ ! -e "uhttp.new/$runs/$id" ]; then
      mv "uhttp/$runs/$id" "uhttp.new/$runs/$id"
      echo "kept $runs/$id from the previous tree"
    fi
  done
done

rm -rf uhttp
mv uhttp.new uhttp
