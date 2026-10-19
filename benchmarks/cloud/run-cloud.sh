#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDER="${PROVIDER:-gcp}"

. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lib/benchmark.sh"

case "$PROVIDER" in
  gcp) . "$SCRIPT_DIR/providers/gcp.sh" ;;
  hetzner) . "$SCRIPT_DIR/providers/hetzner.sh" ;;
  digitalocean) . "$SCRIPT_DIR/providers/digitalocean.sh" ;;
  aws) . "$SCRIPT_DIR/providers/aws.sh" ;;
  *) die "unknown PROVIDER $(printf '%q' "$PROVIDER") (expected gcp, hetzner, digitalocean, or aws)" ;;
esac

main "$@"
