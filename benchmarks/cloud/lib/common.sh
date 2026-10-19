#!/usr/bin/env bash

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$CLOUD_DIR/../.." && pwd)"
REMOTE_REPO="uhttp"

PROVIDER="${PROVIDER:-gcp}"
VM_NAME="${VM_NAME:-uhttp-bench}"
DISK_SIZE="${DISK_SIZE:-20}"
DRY_RUN="${DRY_RUN:-0}"
MACHINE_TYPE="${MACHINE_TYPE:-}"
PROFILE="${BENCH_PROFILE:-published}"
MACHINE_LABEL="${BENCH_MACHINE_LABEL:-}"
VM_MAX_HOURS="${VM_MAX_HOURS:-8}"

MIN_DISK_SIZE_GB=10
PUBLISHED_PROFILE_WORST_CASE_RUN_HOURS=3
SMOKE_PROFILE_WORST_CASE_RUN_HOURS=1
SSH_READY_ATTEMPTS=40
SSH_READY_INTERVAL_SECONDS=5
VM_NAME_PATTERN='^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
WHOLE_NUMBER_PATTERN='^[0-9]+$'
SUITE_OPTION_PATTERN='^[A-Za-z0-9,]+$'
MACHINE_LABEL_PATTERN='^[A-Za-z0-9][A-Za-z0-9 ,./()_-]{0,119}$'
SUITE_OPTION_VARIABLES="BENCH_SERVERS BENCH_ROUTES BENCH_HEADERS BENCH_CONNECTIONS BENCH_DURATION BENCH_WARM_UP BENCH_THREADS"
SUITE_SUBSET_VARIABLES="BENCH_SERVERS BENCH_ROUTES BENCH_HEADERS"
PUBLISHED_RUNS_DIR="benchmarks/results/runs"
SMOKE_RUNS_DIR="benchmarks/results/.smoke/runs"

REMOTE_STATE_SCRIPT="$REMOTE_REPO/benchmarks/cloud/remote-state.sh"
REMOTE_STATE_PROBE="if [ -f $REMOTE_STATE_SCRIPT ]; then bash $REMOTE_STATE_SCRIPT; else echo none; fi"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

_run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY-RUN: %s\n' "$*"
    return 0
  fi
  "$@"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 && return 0
  [ "$DRY_RUN" = "1" ] && { log "(dry-run) '$1' is not installed, so the script prints the commands alone"; return 0; }
  die "$1 is required but not found"
}

validate_settings() {
  [[ "$VM_NAME" =~ $VM_NAME_PATTERN ]] \
    || die "set VM_NAME to lowercase letters, digits, and hyphens, starting with a letter, up to 63 characters"
  [[ "$DISK_SIZE" =~ $WHOLE_NUMBER_PATTERN ]] && [ "$DISK_SIZE" -ge "$MIN_DISK_SIZE_GB" ] \
    || die "set DISK_SIZE to a whole number of GB from $MIN_DISK_SIZE_GB"
  [[ "$VM_MAX_HOURS" =~ $WHOLE_NUMBER_PATTERN ]] \
    || die "set VM_MAX_HOURS to a whole number of hours, or to 0 to turn the self-delete backstop off"
  case "$PROFILE" in
    published | smoke) ;;
    *) die "set BENCH_PROFILE to published or smoke" ;;
  esac
  local name
  for name in $SUITE_OPTION_VARIABLES; do
    [ -n "${!name:-}" ] || continue
    [[ "${!name}" =~ $SUITE_OPTION_PATTERN ]] \
      || die "set $name to a comma-separated list of letters and digits, as in uhttp,uws"
  done
  [ "$PROFILE" = "smoke" ] && return 0
  for name in $SUITE_SUBSET_VARIABLES; do
    [ -z "${!name:-}" ] \
      || die "the published profile measures every server, route, and set of headers, so set BENCH_PROFILE=smoke to use $name"
  done
}

profile_runs_dir() {
  if [ "$PROFILE" = "smoke" ]; then
    printf '%s' "$SMOKE_RUNS_DIR"
  else
    printf '%s' "$PUBLISHED_RUNS_DIR"
  fi
}

remote_state() {
  local state
  state="$(prov_ssh "$REMOTE_STATE_PROBE" </dev/null | tr -d '\r')" || return 1
  case "$state" in
    none | active | stale | done:*) printf '%s' "$state" ;;
    *) return 1 ;;
  esac
}

require_idle_vm() {
  [ "$DRY_RUN" = "1" ] && return 0
  local state
  state="$(remote_state)" || die "cannot read the benchmark state on $VM_NAME over SSH"
  if [ "$state" = "active" ]; then
    die "a benchmark is still going on $VM_NAME, so $1 would disturb it; follow it with: PROVIDER=$PROVIDER ./run-cloud.sh logs"
  fi
}

prov_wait_ssh() {
  [ "$DRY_RUN" = "1" ] && { log "(dry-run) would wait for SSH"; return 0; }
  log "wait for SSH"
  local attempt
  for ((attempt = 1; attempt <= SSH_READY_ATTEMPTS; attempt++)); do
    if prov_ssh true </dev/null >/dev/null 2>&1; then
      log "SSH answered after ${attempt} attempt(s)"
      return 0
    fi
    sleep "$SSH_READY_INTERVAL_SECONDS"
  done
  die "$VM_NAME never answered over SSH"
}

vm_lifetime_guard() {
  [ "$DRY_RUN" = "1" ] && return 0
  [ "$VM_MAX_HOURS" = "0" ] && return 0
  declare -F prov_termination_epoch >/dev/null || return 0
  local deadline now required_hours left_hours
  deadline="$(prov_termination_epoch)" || deadline=""
  if ! [[ "$deadline" =~ $WHOLE_NUMBER_PATTERN ]]; then
    log "the script cannot read a self-delete deadline on $VM_NAME; recreate it with down and then up to set one"
    return 0
  fi
  if [ "$PROFILE" = "smoke" ]; then
    required_hours="$SMOKE_PROFILE_WORST_CASE_RUN_HOURS"
  else
    required_hours="$PUBLISHED_PROFILE_WORST_CASE_RUN_HOURS"
  fi
  now="$(date +%s)"
  left_hours=$(((deadline - now) / 3600))
  [ "$left_hours" -ge 0 ] || left_hours=0
  if [ $((deadline - now)) -lt $((required_hours * 3600)) ]; then
    die "$VM_NAME deletes itself in about ${left_hours}h, and the suite can need up to ${required_hours}h in the $PROFILE profile; recreate the VM with down and then up, or raise VM_MAX_HOURS"
  fi
  log "$VM_NAME deletes itself in about ${left_hours}h, and the suite needs at most ${required_hours}h in the $PROFILE profile"
}

cmd_up() {
  if [ "$DRY_RUN" != "1" ] && prov_exists; then
    log "$VM_NAME already exists"
    prov_lifetime_note
    return 0
  fi
  log "create $VM_NAME ($MACHINE_TYPE, $(prov_hourly))"
  if [ "$DRY_RUN" != "1" ] && [ "${ASSUME_YES:-0}" != "1" ]; then
    local reply
    read -r -p "The provider bills for this VM until you run 'down'. Proceed? [y/N] " reply
    [ "$reply" = "y" ] || [ "$reply" = "Y" ] || die "aborted"
  fi
  prov_create
  prov_lifetime_note
  prov_wait_ssh
}

list_shippable_files() {
  local raw="$1" list="$2" path
  git -C "$REPO_ROOT" ls-files -z >"$raw" || return 1
  git -C "$REPO_ROOT" ls-files --others --exclude-standard -z -- . ":(exclude)$PUBLISHED_RUNS_DIR" >>"$raw" || return 1
  : >"$list" || return 1
  while IFS= read -r -d '' path; do
    if [ -e "$REPO_ROOT/$path" ] || [ -L "$REPO_ROOT/$path" ]; then
      printf '%s\0' "$path" >>"$list" || return 1
    fi
  done <"$raw"
  printf '.git\0' >>"$list"
}

package_working_tree() {
  local tarball="$1" raw="$2" list="$3"
  list_shippable_files "$raw" "$list" || return 1
  COPYFILE_DISABLE=1 tar -czf "$tarball" -C "$REPO_ROOT" --no-xattrs --exclude=.git/config --null -T "$list"
}

cmd_sync() {
  command -v git >/dev/null 2>&1 || die "git is required to package the working tree"
  require_idle_vm "a sync"
  log "package the working tree through git, which leaves out the paths in .gitignore and keeps .git for the commit stamp"
  local unpack="rm -rf $REMOTE_REPO.new && mkdir $REMOTE_REPO.new && tar --no-same-owner -xzf $REMOTE_REPO.tgz -C $REMOTE_REPO.new && rm -f $REMOTE_REPO.tgz && bash $REMOTE_REPO.new/benchmarks/cloud/remote-replace-tree.sh"
  if [ "$DRY_RUN" = "1" ]; then
    prov_scp_up "<working-tree>.tgz" "$REMOTE_REPO.tgz"
    prov_ssh "$unpack"
    return 0
  fi
  local tarball raw list
  tarball="$(mktemp "${TMPDIR:-/tmp}/uhttp-sync.XXXXXX")"
  raw="$(mktemp "${TMPDIR:-/tmp}/uhttp-files.XXXXXX")"
  list="$(mktemp "${TMPDIR:-/tmp}/uhttp-shipped.XXXXXX")"
  if ! package_working_tree "$tarball" "$raw" "$list"; then
    rm -f "$tarball" "$raw" "$list"
    die "could not package the working tree"
  fi
  rm -f "$raw" "$list"
  log "upload the working tree and replace ~/$REMOTE_REPO, which keeps every run directory already on the VM"
  if ! prov_scp_up "$tarball" "$REMOTE_REPO.tgz" </dev/null || ! prov_ssh "$unpack" </dev/null; then
    rm -f "$tarball"
    die "could not upload and unpack the working tree on $VM_NAME"
  fi
  rm -f "$tarball"
}

cmd_setup() {
  log "install Node 24, pnpm, h2load, and uv on the VM"
  prov_ssh "bash $REMOTE_REPO/benchmarks/cloud/remote-bootstrap.sh" </dev/null
}

cmd_down() {
  if [ "$DRY_RUN" != "1" ] && ! prov_exists; then
    log "$VM_NAME not found, so there is nothing to delete"
    return 0
  fi
  log "delete $VM_NAME"
  prov_delete
}

cmd_status() {
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would describe $VM_NAME"
    return 0
  fi
  prov_status
}

usage() {
  cat <<'EOF'
Usage: PROVIDER=<gcp|hetzner|digitalocean|aws> ./run-cloud.sh <command> [flags]

Commands:
  all      up, sync, setup, run, and fetch in order
  up       create the VM
  sync     push the local working tree, keeping the run directories on the VM
  setup    install Node 24, pnpm, and uv on the VM, and build h2load
  run      start the suite on the VM, detached, and stream its log
  logs     stream the log of the suite again after a dropped connection
  fetch    copy the run directories that the VM created into this repository
  ssh      open a shell on the VM
  status   show the state of the VM
  down     delete the VM

Flags:
  --yes        skip the billing confirmation
  --teardown   delete the VM when 'all' exits, unless the suite is still going
  --dry-run    print the commands without calling the provider

Environment:
  VM_NAME, MACHINE_TYPE, DISK_SIZE (GB), VM_MAX_HOURS (0 turns the backstop off),
  SSH_KEY (private key for hetzner, digitalocean, and aws; the public key is <key>.pub),
  BENCH_PROFILE (published or smoke),
  BENCH_MACHINE_LABEL (the machine that machine.json names, such as "GCP c3-standard-8, us-central1-a"),
  BENCH_SERVERS, BENCH_ROUTES, BENCH_HEADERS (smoke profile alone),
  BENCH_CONNECTIONS, BENCH_DURATION, BENCH_WARM_UP, BENCH_THREADS.

A short check on any provider, deleting the VM afterwards:
  PROVIDER=hetzner BENCH_PROFILE=smoke BENCH_SERVERS=uhttp,uws BENCH_ROUTES=plain \
    ./run-cloud.sh all --yes --teardown

The published run on the default machine:
  ./run-cloud.sh all
EOF
}

main() {
  local command="${1:-help}"
  shift || true
  local arg
  for arg in "$@"; do
    case "$arg" in
      --yes) ASSUME_YES=1 ;;
      --teardown) TEARDOWN=1 ;;
      --dry-run) DRY_RUN=1 ;;
      *) die "unknown option: $arg" ;;
    esac
  done
  case "$command" in
    help | -h | --help) usage; return 0 ;;
  esac
  validate_settings
  prov_init
  [[ "$MACHINE_LABEL" =~ $MACHINE_LABEL_PATTERN ]] \
    || die "set BENCH_MACHINE_LABEL to up to 120 letters, digits, spaces, and the characters , . / ( ) _ -"
  case "$command" in
    sync | setup | run | logs | fetch | ssh) prov_connect ;;
  esac
  case "$command" in
    up) cmd_up ;;
    sync) cmd_sync ;;
    setup) cmd_setup ;;
    run) cmd_run ;;
    logs) cmd_logs ;;
    fetch) cmd_fetch ;;
    ssh) prov_ssh_interactive ;;
    status) cmd_status ;;
    down) cmd_down ;;
    all) cmd_all ;;
    *) die "unknown command: $command (try 'help')" ;;
  esac
}
