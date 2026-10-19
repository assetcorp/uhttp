#!/usr/bin/env bash

GCP_DEFAULT_MACHINE_TYPE="c3-standard-8"
GCP_DEFAULT_ZONE="us-central1-a"
GCP_DEADLINE_LABEL="bench_deadline_epoch"

prov_init() {
  require_cmd gcloud
  PROJECT="${GCP_PROJECT:-}"
  if [ -z "$PROJECT" ] && command -v gcloud >/dev/null 2>&1; then
    PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  fi
  [ -n "$PROJECT" ] || [ "$DRY_RUN" = "1" ] || die "no GCP project; export GCP_PROJECT or run 'gcloud config set project'"
  PROJECT="${PROJECT:-<gcp-project>}"
  ZONE="${GCP_ZONE:-$GCP_DEFAULT_ZONE}"
  MACHINE_TYPE="${MACHINE_TYPE:-$GCP_DEFAULT_MACHINE_TYPE}"
  MACHINE_LABEL="${MACHINE_LABEL:-GCP $MACHINE_TYPE, $ZONE}"
  IMAGE_FAMILY="${IMAGE_FAMILY:-ubuntu-2404-lts-amd64}"
  IMAGE_PROJECT="${IMAGE_PROJECT:-ubuntu-os-cloud}"
  IAP_ARGS=()
  if [ "${USE_IAP:-0}" = "1" ]; then
    IAP_ARGS=(--tunnel-through-iap)
  fi
}

prov_hourly() {
  if [ "$MACHINE_TYPE" = "$GCP_DEFAULT_MACHINE_TYPE" ] && [ "$ZONE" = "$GCP_DEFAULT_ZONE" ]; then
    echo "about \$0.40 an hour"
  else
    echo "price on the Compute Engine pricing page"
  fi
}

prov_exists() {
  gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" >/dev/null 2>&1
}

gcp_deadline_epoch() {
  printf '%s' $(($(date +%s) + VM_MAX_HOURS * 3600))
}

gcp_rfc3339() {
  date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ
}

prov_create() {
  local -a flags=(
    --project "$PROJECT" --zone "$ZONE"
    --machine-type "$MACHINE_TYPE"
    --image-family "$IMAGE_FAMILY" --image-project "$IMAGE_PROJECT"
    --boot-disk-size "${DISK_SIZE}GB" --boot-disk-type pd-balanced
    --no-service-account --no-scopes
  )
  if [ -n "${MIN_CPU_PLATFORM:-}" ]; then
    flags+=(--min-cpu-platform "$MIN_CPU_PLATFORM")
  fi
  if [ "$VM_MAX_HOURS" != "0" ]; then
    local deadline
    deadline="$(gcp_deadline_epoch)"
    flags+=(
      --termination-time "$(gcp_rfc3339 "$deadline")" --instance-termination-action DELETE
      --labels "$GCP_DEADLINE_LABEL=$deadline"
    )
  fi
  _run gcloud compute instances create "$VM_NAME" "${flags[@]}"
}

prov_termination_epoch() {
  gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
    --format="value(labels.$GCP_DEADLINE_LABEL)" 2>/dev/null
}

prov_lifetime_note() {
  if [ "$VM_MAX_HOURS" = "0" ]; then
    log "the self-delete backstop is off (VM_MAX_HOURS=0), so $VM_NAME bills until 'down'"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) $VM_NAME would delete itself ${VM_MAX_HOURS}h after creation"
    return 0
  fi
  local deadline
  deadline="$(prov_termination_epoch)" || deadline=""
  if [[ "$deadline" =~ $WHOLE_NUMBER_PATTERN ]]; then
    log "$VM_NAME deletes itself at $(gcp_rfc3339 "$deadline"), so fetch the results before then"
  else
    log "$VM_NAME has no self-delete deadline; recreate it with down and then up to set one"
  fi
}

prov_delete() {
  _run gcloud compute instances delete "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --quiet
}

prov_status() {
  gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
    --format='value(name,status,machineType.scope(machineTypes),zone.scope(zones))' 2>/dev/null \
    || log "$VM_NAME not found"
}

prov_connect() {
  :
}

prov_ssh() {
  _run gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" ${IAP_ARGS[@]+"${IAP_ARGS[@]}"} \
    --command "$1" -- -o ServerAliveInterval=15 -o ServerAliveCountMax=4
}

prov_ssh_interactive() {
  _run gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" ${IAP_ARGS[@]+"${IAP_ARGS[@]}"} \
    -- -o ServerAliveInterval=15 -o ServerAliveCountMax=4
}

prov_scp_up() {
  _run gcloud compute scp --project "$PROJECT" --zone "$ZONE" ${IAP_ARGS[@]+"${IAP_ARGS[@]}"} "$1" "${VM_NAME}:$2"
}

prov_scp_down() {
  _run gcloud compute scp --recurse --project "$PROJECT" --zone "$ZONE" ${IAP_ARGS[@]+"${IAP_ARGS[@]}"} \
    "${VM_NAME}:$1" "$2"
}
