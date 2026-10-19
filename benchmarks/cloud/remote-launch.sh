#!/usr/bin/env bash

set -euo pipefail

cd "$HOME"

for assignment in "$@"; do
  case "$assignment" in
    BENCH_PROFILE=* | BENCH_MACHINE_LABEL=* | BENCH_SERVERS=* | BENCH_ROUTES=* | BENCH_HEADERS=* | BENCH_CONNECTIONS=* \
      | BENCH_DURATION=* | BENCH_WARM_UP=* | BENCH_THREADS=*) ;;
    *)
      printf 'remote-launch: refusing the argument %q\n' "$assignment" >&2
      exit 2
      ;;
  esac
done

[ -f uhttp/benchmarks/cloud/remote-run.sh ] || { echo 'remote-launch: ~/uhttp is missing; sync first' >&2; exit 1; }
if [ "$(bash uhttp/benchmarks/cloud/remote-state.sh)" = "active" ]; then
  printf 'remote-launch: a benchmark is still going as pid %s\n' "$(cat bench.pid)" >&2
  exit 3
fi

rm -f bench.done bench.status
: >bench.log
nohup env "$@" bash uhttp/benchmarks/cloud/remote-run.sh </dev/null >>bench.log 2>&1 &
echo "$!" >bench.pid
echo "launched pid $(cat bench.pid); the log is in ~/bench.log"
