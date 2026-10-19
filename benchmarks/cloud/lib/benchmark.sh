#!/usr/bin/env bash

RUN_ID_PATTERN='^[0-9]{8}T[0-9]{6}Z$'
EMPTY_FAILURES_LINE='"failures": []'
LOG_STREAM_RECONNECT_LIMIT=20
LOG_STREAM_RECONNECT_INTERVAL_SECONDS=5
RUN_OUTCOME=""
RESULTS_COPIED=0

cmd_run() {
  vm_lifetime_guard
  require_idle_vm "a second benchmark"
  local forward name
  forward="$(printf '%q ' "BENCH_PROFILE=$PROFILE" "BENCH_MACHINE_LABEL=$MACHINE_LABEL")"
  for name in $SUITE_OPTION_VARIABLES; do
    [ -n "${!name:-}" ] || continue
    forward+="$(printf '%q ' "$name=${!name}")"
  done
  log "start the suite in the $PROFILE profile on $VM_NAME, detached, so that it continues when the connection drops"
  prov_ssh "bash $REMOTE_REPO/benchmarks/cloud/remote-launch.sh $forward" </dev/null
  RUN_OUTCOME="running"
  cmd_logs
}

stream_log() {
  local shown misses=0 state
  STREAM_DETACHED=0
  STREAM_MIRROR="$(mktemp "${TMPDIR:-/tmp}/uhttp-bench-log.XXXXXX")"
  trap 'STREAM_DETACHED=1' INT
  trap 'rm -f "$STREAM_MIRROR"; exit 143' TERM HUP
  while [ "$STREAM_DETACHED" = "0" ]; do
    shown="$(wc -l <"$STREAM_MIRROR" | tr -d ' ')"
    [ "$shown" -eq 0 ] || log "reconnect to the log at line $((shown + 1))"
    prov_ssh "tail -n +$((shown + 1)) --follow=name --pid=\"\$(cat bench.pid)\" bench.log" </dev/null \
      | tee -a "$STREAM_MIRROR" || true
    [ "$STREAM_DETACHED" = "0" ] || break
    state="$(remote_state)" || state="unreachable"
    [ "$state" = "active" ] || [ "$state" = "unreachable" ] || break
    if [ "$(wc -l <"$STREAM_MIRROR" | tr -d ' ')" -eq "$shown" ]; then
      misses=$((misses + 1))
    else
      misses=0
    fi
    if [ "$misses" -ge "$LOG_STREAM_RECONNECT_LIMIT" ]; then
      log "the log grew no further over $misses reconnections, so the script stops streaming it"
      break
    fi
    sleep "$LOG_STREAM_RECONNECT_INTERVAL_SECONDS" || true
  done
  trap - INT TERM HUP
  rm -f "$STREAM_MIRROR"
}

cmd_logs() {
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would stream ~/bench.log until the suite finishes"
    RUN_OUTCOME="passed"
    return 0
  fi
  local state
  state="$(remote_state)" || die "cannot read the benchmark state on $VM_NAME over SSH"
  [ "$state" != "none" ] || die "no benchmark has started on $VM_NAME; start one with: PROVIDER=$PROVIDER ./run-cloud.sh run"
  log "stream ~/bench.log until the suite finishes (Ctrl-C detaches, and the suite continues)"
  RUN_OUTCOME="running"
  stream_log
  state="$(remote_state)" || state="unreachable"
  case "$state" in
    done:0)
      RUN_OUTCOME="passed"
      log "the suite finished with status 0"
      ;;
    done:*)
      RUN_OUTCOME="failed"
      log "the suite finished with status ${state#done:}; open a shell with: PROVIDER=$PROVIDER ./run-cloud.sh ssh"
      ;;
    stale)
      RUN_OUTCOME="failed"
      log "the suite stopped without recording a status, which happens when the VM restarts or the kernel ends the process"
      ;;
    *)
      RUN_OUTCOME="running"
      log "the suite is still going on $VM_NAME; stream its log again with: PROVIDER=$PROVIDER ./run-cloud.sh logs"
      ;;
  esac
}

warn_on_failed_measurements() {
  local run="$1"
  grep -qF "$EMPTY_FAILURES_LINE" "$REPO_ROOT/$run/results.json" && return 0
  log "$run records failed measurements; read results.json, and delete the directory before you regenerate the page"
}

fetch_run() {
  local runs_dir="$1" id="$2" dest="$REPO_ROOT/$1" incoming
  mkdir -p "$dest" || return 1
  incoming="$(mktemp -d "$dest/.incoming.XXXXXX")" || return 1
  log "fetch $runs_dir/$id"
  if ! prov_scp_down "$REMOTE_REPO/$runs_dir/$id" "$incoming/" </dev/null; then
    rm -rf "$incoming"
    return 1
  fi
  if [ ! -f "$incoming/$id/results.json" ] || [ ! -f "$incoming/$id/machine.json" ]; then
    rm -rf "$incoming"
    log "$runs_dir/$id on the VM lacks results.json or machine.json, so the script leaves it there"
    return 0
  fi
  if [ -e "$dest/$id" ]; then
    rm -rf "$incoming"
    log "$runs_dir/$id appeared here during the copy, so the script keeps the one here"
    return 0
  fi
  mv "$incoming/$id" "$dest/$id" || { rm -rf "$incoming"; return 1; }
  rmdir "$incoming" || true
  FETCHED_RUNS="$FETCHED_RUNS $id"
  warn_on_failed_measurements "$runs_dir/$id"
}

cmd_fetch() {
  local runs_dir
  runs_dir="$(profile_runs_dir)"
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would copy every run directory that the VM created under $runs_dir into this repository, leaving each one that exists here as it is"
    return 0
  fi
  local state listing id
  state="$(remote_state)" || die "cannot read the benchmark state on $VM_NAME over SSH"
  [ "$state" != "active" ] \
    || die "the suite is still going on $VM_NAME; follow it with: PROVIDER=$PROVIDER ./run-cloud.sh logs"
  listing="$(prov_ssh "bash $REMOTE_REPO/benchmarks/cloud/remote-list-runs.sh $PROFILE" </dev/null | tr -d '\r')" \
    || die "cannot list the run directories on $VM_NAME"
  FETCHED_RUNS=""
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if ! [[ "$id" =~ $RUN_ID_PATTERN ]]; then
      log "skip $(printf '%q' "$id"), which the suite never names a run directory"
      continue
    fi
    if [ -e "$REPO_ROOT/$runs_dir/$id" ]; then
      log "$runs_dir/$id exists here, so the script leaves it as it is"
      continue
    fi
    fetch_run "$runs_dir" "$id" || die "could not copy $runs_dir/$id from $VM_NAME"
  done <<<"$listing"
  if [ -z "$FETCHED_RUNS" ]; then
    log "the VM holds no new run directory under $runs_dir"
    return 0
  fi
  log "copied$FETCHED_RUNS into $runs_dir/"
  [ "$PROFILE" = "published" ] || return 0
  log "regenerate BENCHMARKS.md and both READMEs from the newest run with: (cd benchmarks/writeup && uv run --frozen python generate.py)"
}

finish_all() {
  local code=$?
  trap - EXIT
  if [ "$DRY_RUN" = "1" ]; then
    if [ "${TEARDOWN:-0}" = "1" ]; then
      log "(dry-run) would delete $VM_NAME on exit"
    else
      log "(dry-run) the script created nothing; a real 'all' leaves the VM up until you run 'down'"
    fi
    exit "$code"
  fi
  if [ "$RUN_OUTCOME" = "running" ]; then
    log "the suite is still going, so $VM_NAME stays up and billing; use logs, then fetch, then down"
    exit "$code"
  fi
  if [ -n "$RUN_OUTCOME" ] && [ "$RESULTS_COPIED" != "1" ]; then
    log "the script could not finish copying the results back, so $VM_NAME stays up and billing; use fetch, then down"
    exit "$code"
  fi
  if [ "${TEARDOWN:-0}" = "1" ]; then
    [ "$code" -eq 0 ] || log "a step failed with status $code, and you passed --teardown, so the script deletes $VM_NAME"
    if prov_exists; then
      cmd_down || log "the script could not delete $VM_NAME; delete it with: PROVIDER=$PROVIDER ./run-cloud.sh down"
    fi
  elif prov_exists; then
    log "$VM_NAME is up and billing; delete it with: PROVIDER=$PROVIDER ./run-cloud.sh down"
  fi
  exit "$code"
}

cmd_all() {
  trap finish_all EXIT
  cmd_up
  prov_connect
  cmd_sync
  cmd_setup
  cmd_run
  [ "$RUN_OUTCOME" != "running" ] || return 0
  cmd_fetch
  RESULTS_COPIED=1
  [ "$RUN_OUTCOME" = "passed" ] || die "the suite failed on $VM_NAME"
}
