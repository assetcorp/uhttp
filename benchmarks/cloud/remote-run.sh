#!/usr/bin/env bash

set -uo pipefail

REQUIRED_NODE_MAJOR=24
MIN_PINNING_CPUS=6
STATE_DIR="$HOME"
REPO="$HOME/uhttp"
export PATH="/usr/local/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

stamp() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

finish() {
  stamp "finished with status $1"
  echo "$1" >"$STATE_DIR/bench.status"
  touch "$STATE_DIR/bench.done"
  exit "$1"
}

cd "$REPO" || { stamp "the repository is missing at $REPO"; finish 1; }

node_major="$(node -v 2>/dev/null | sed -n 's/^v\([0-9]*\)\..*/\1/p')"
[ "$node_major" = "$REQUIRED_NODE_MAJOR" ] \
  || { stamp "Node $REQUIRED_NODE_MAJOR is missing; run the setup step first"; finish 1; }
for tool in pnpm h2load uv taskset; do
  command -v "$tool" >/dev/null 2>&1 || { stamp "$tool is missing; run the setup step first"; finish 1; }
done

cpus="$(nproc)"
if [ "$cpus" -lt "$MIN_PINNING_CPUS" ]; then
  stamp "warning: this VM has $cpus CPUs, so the suite pins nothing, and machine.json records that"
fi

profile="${BENCH_PROFILE:-published}"
case "$profile" in
  published | smoke) ;;
  *) stamp "BENCH_PROFILE must be published or smoke"; finish 2 ;;
esac

suite_args=()
add_suite_option() {
  local value="${!1:-}"
  if [ -n "$value" ]; then
    suite_args+=("--$2" "$value")
  fi
}
add_suite_option BENCH_SERVERS servers
add_suite_option BENCH_ROUTES routes
add_suite_option BENCH_HEADERS headers
add_suite_option BENCH_CONNECTIONS connections
add_suite_option BENCH_DURATION duration
add_suite_option BENCH_WARM_UP warm-up
add_suite_option BENCH_THREADS threads

stamp "install the workspace from the lockfile"
pnpm install --frozen-lockfile || finish 1

stamp "start the suite in the $profile profile with: ${suite_args[*]:-the default options}"
BENCH_PROFILE="$profile" pnpm --dir benchmarks/suite bench "${suite_args[@]}"
finish "$?"
