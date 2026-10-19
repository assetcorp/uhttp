#!/usr/bin/env bash

. "$CLOUD_DIR/lib/raw-ssh.sh"

DIGITALOCEAN_DEFAULT_MACHINE_TYPE="g-8vcpu-32gb"

prov_init() {
  require_cmd doctl
  [ "$DRY_RUN" = "1" ] || doctl account get >/dev/null 2>&1 \
    || die "doctl is not authenticated; run 'doctl auth init'"
  MACHINE_TYPE="${MACHINE_TYPE:-$DIGITALOCEAN_DEFAULT_MACHINE_TYPE}"
  IMAGE="${IMAGE:-ubuntu-24-04-x64}"
  REGION="${DO_REGION:-nyc3}"
  MACHINE_LABEL="${MACHINE_LABEL:-DigitalOcean $MACHINE_TYPE, $REGION}"
  SSH_USER="${SSH_USER:-root}"
  if [ "$DRY_RUN" != "1" ]; then
    doctl compute size list --format Slug --no-header 2>/dev/null | grep -qxF "$MACHINE_TYPE" \
      || die "DigitalOcean has no size '$MACHINE_TYPE'; list the sizes with 'doctl compute size list'"
  fi
  resolve_ssh_key
}

prov_hourly() {
  if [ "$MACHINE_TYPE" = "$DIGITALOCEAN_DEFAULT_MACHINE_TYPE" ]; then
    echo "about \$0.38 an hour"
  else
    echo "price on the DigitalOcean pricing page"
  fi
}

digitalocean_droplet_id() {
  doctl compute droplet list --format ID,Name --no-header 2>/dev/null \
    | awk -v name="$VM_NAME" '$2 == name { print $1; exit }'
}

prov_exists() {
  [ -n "$(digitalocean_droplet_id)" ]
}

prov_ip() {
  local id
  id="$(digitalocean_droplet_id)"
  [ -n "$id" ] || return 1
  doctl compute droplet get "$id" --format PublicIPv4 --no-header 2>/dev/null
}

prov_create() {
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would import the SSH key '$SSH_KEY_NAME' when DigitalOcean lacks it, and then create the droplet"
    _run doctl compute droplet create "$VM_NAME" --size "$MACHINE_TYPE" \
      --image "$IMAGE" --region "$REGION" --ssh-keys "<fingerprint>" --wait
    return 0
  fi
  doctl compute ssh-key list --format Name --no-header 2>/dev/null | grep -qxF "$SSH_KEY_NAME" \
    || _run doctl compute ssh-key import "$SSH_KEY_NAME" --public-key-file "$SSH_PUBKEY"
  local fingerprint
  fingerprint="$(doctl compute ssh-key list --format Name,FingerPrint --no-header 2>/dev/null \
    | awk -v name="$SSH_KEY_NAME" '$1 == name { print $2; exit }')"
  [ -n "$fingerprint" ] || die "cannot resolve the DigitalOcean fingerprint of the SSH key $SSH_KEY_NAME"
  _run doctl compute droplet create "$VM_NAME" --size "$MACHINE_TYPE" \
    --image "$IMAGE" --region "$REGION" --ssh-keys "$fingerprint" --wait
}

prov_lifetime_note() {
  log "the script sets no self-delete backstop on DigitalOcean, so $VM_NAME bills until 'down', even when the suite stops early"
}

prov_delete() {
  if [ "$DRY_RUN" = "1" ]; then
    _run doctl compute droplet delete "<id of $VM_NAME>" --force
    return 0
  fi
  local id
  id="$(digitalocean_droplet_id)"
  [ -n "$id" ] || { log "$VM_NAME not found"; return 0; }
  _run doctl compute droplet delete "$id" --force
}

prov_status() {
  doctl compute droplet list --format Name,Status,Region,Memory,VCPUs --no-header 2>/dev/null \
    | awk -v name="$VM_NAME" '$1 == name' || log "$VM_NAME not found"
}
