#!/usr/bin/env bash

. "$CLOUD_DIR/lib/raw-ssh.sh"

HETZNER_DEFAULT_MACHINE_TYPE="ccx33"
HETZNER_DEFAULT_LOCATION="fsn1"

prov_init() {
  require_cmd hcloud
  [ "$DRY_RUN" = "1" ] || [ -n "${HCLOUD_TOKEN:-}" ] || hcloud context active >/dev/null 2>&1 \
    || die "hcloud is not configured; run 'hcloud context create' or export HCLOUD_TOKEN"
  MACHINE_TYPE="${MACHINE_TYPE:-$HETZNER_DEFAULT_MACHINE_TYPE}"
  IMAGE="${IMAGE:-ubuntu-24.04}"
  LOCATION="${HCLOUD_LOCATION:-$HETZNER_DEFAULT_LOCATION}"
  MACHINE_LABEL="${MACHINE_LABEL:-Hetzner $MACHINE_TYPE, $LOCATION}"
  SSH_USER="${SSH_USER:-root}"
  resolve_ssh_key
}

prov_hourly() {
  if [ "$MACHINE_TYPE" = "$HETZNER_DEFAULT_MACHINE_TYPE" ] && [ "$LOCATION" = "$HETZNER_DEFAULT_LOCATION" ]; then
    echo "about \$0.25 an hour"
  else
    echo "price on the Hetzner Cloud pricing page"
  fi
}

prov_exists() {
  hcloud server describe "$VM_NAME" >/dev/null 2>&1
}

prov_ip() {
  hcloud server ip "$VM_NAME" 2>/dev/null
}

prov_create() {
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would register the SSH key '$SSH_KEY_NAME' when Hetzner lacks it, and then create the server"
    _run hcloud server create --name "$VM_NAME" --type "$MACHINE_TYPE" \
      --image "$IMAGE" --location "$LOCATION" --ssh-key "$SSH_KEY_NAME"
    return 0
  fi
  hcloud ssh-key describe "$SSH_KEY_NAME" >/dev/null 2>&1 \
    || _run hcloud ssh-key create --name "$SSH_KEY_NAME" --public-key-from-file "$SSH_PUBKEY"
  _run hcloud server create --name "$VM_NAME" --type "$MACHINE_TYPE" \
    --image "$IMAGE" --location "$LOCATION" --ssh-key "$SSH_KEY_NAME"
}

prov_lifetime_note() {
  log "the script sets no self-delete backstop on Hetzner, so $VM_NAME bills until 'down', even when the suite stops early"
}

prov_delete() {
  _run hcloud server delete "$VM_NAME"
}

prov_status() {
  hcloud server describe "$VM_NAME" 2>/dev/null || log "$VM_NAME not found"
}
