#!/usr/bin/env bash

SSH_OPTS=(
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
  -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o IdentitiesOnly=yes
)
SSH_KEY_NAME_PATTERN='^[A-Za-z0-9._-]{1,64}$'
SERVER_IP_PATTERN='^[0-9]{1,3}([.][0-9]{1,3}){3}$'

resolve_ssh_key() {
  if [ -z "${SSH_KEY:-}" ]; then
    local candidate
    for candidate in "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_rsa"; do
      [ -f "$candidate" ] && { SSH_KEY="$candidate"; break; }
    done
  fi
  if [ -z "${SSH_KEY:-}" ] || [ ! -f "$SSH_KEY" ]; then
    [ "$DRY_RUN" = "1" ] || die "no SSH private key found; set SSH_KEY=/path/to/key"
    SSH_KEY="${SSH_KEY:-<ssh-key>}"
  fi
  SSH_PUBKEY="${SSH_PUBKEY:-${SSH_KEY}.pub}"
  [ -f "$SSH_PUBKEY" ] || [ "$DRY_RUN" = "1" ] || die "public key $SSH_PUBKEY not found; set SSH_PUBKEY"
  SSH_KEY_NAME="${SSH_KEY_NAME:-uhttp-bench}"
  [[ "$SSH_KEY_NAME" =~ $SSH_KEY_NAME_PATTERN ]] \
    || die "set SSH_KEY_NAME to letters, digits, dots, underscores, and hyphens, up to 64 characters"
}

resolve_server_ip() {
  [ -n "${SERVER_IP:-}" ] && return 0
  if [ "$DRY_RUN" = "1" ]; then
    SERVER_IP="<server-ip>"
    return 0
  fi
  local address
  address="$(prov_ip)" || address=""
  if ! [[ "$address" =~ $SERVER_IP_PATTERN ]]; then
    printf 'error: cannot resolve the public IPv4 address of %s\n' "$VM_NAME" >&2
    return 1
  fi
  SERVER_IP="$address"
}

prov_connect() {
  resolve_server_ip || die "cannot reach $VM_NAME without its public IP address"
}

prov_ssh() {
  resolve_server_ip || return 1
  _run ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "${SSH_USER}@${SERVER_IP}" "$1"
}

prov_ssh_interactive() {
  resolve_server_ip || return 1
  _run ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "${SSH_USER}@${SERVER_IP}"
}

prov_scp_up() {
  resolve_server_ip || return 1
  _run scp "${SSH_OPTS[@]}" -i "$SSH_KEY" "$1" "${SSH_USER}@${SERVER_IP}:$2"
}

prov_scp_down() {
  resolve_server_ip || return 1
  _run scp -r "${SSH_OPTS[@]}" -i "$SSH_KEY" "${SSH_USER}@${SERVER_IP}:$1" "$2"
}
