#!/usr/bin/env bash

set -euo pipefail

NODE_MAJOR=24
UV_VERSION="0.12.21"
UV_SHA256_X86_64="23f02075b652bb1df64178cfae41b5caf160822e720e2663568f3f5d63bc52c0"
UV_SHA256_AARCH64="030b69227b40af8c1981b7301793dc66e71ed3c796ea8688209dd268bd91ec51"
NGHTTP2_VERSION="1.70.0"
NGHTTP2_SHA256="e05cb1388eaca3830aded4ccf20044b6e1ac1a61411dcca11b0437c4285c8bc2"
NGHTTP2_COMPILER_MAJOR=14
APT_LOCK_TIMEOUT_SECONDS=600
MIN_PINNING_CPUS=6
REPO="$HOME/uhttp"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

log() { printf '[bootstrap] %s\n' "$*"; }
die() { printf '[bootstrap] error: %s\n' "$*" >&2; exit 1; }

as_root() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  else
    sudo "$@"
  fi
}

apt_get() {
  as_root env DEBIAN_FRONTEND=noninteractive apt-get -o "DPkg::Lock::Timeout=$APT_LOCK_TIMEOUT_SECONDS" "$@"
}

[ -f "$REPO/package.json" ] || die "$REPO/package.json is missing; sync the working tree first"

if command -v cloud-init >/dev/null 2>&1; then
  log "wait for cloud-init to finish its first boot"
  as_root cloud-init status --wait >/dev/null 2>&1 || true
fi

log "stop the automatic apt timers, so that no upgrade starts during a measurement"
as_root systemctl disable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service >/dev/null 2>&1 || true
as_root systemctl mask apt-daily.service apt-daily-upgrade.service >/dev/null 2>&1 || true

log "install curl, git, gnupg, taskset, and the tools that build h2load from apt"
apt_get update -qq
apt_get install -y -qq ca-certificates curl git gnupg util-linux xz-utils build-essential pkg-config \
  "g++-$NGHTTP2_COMPILER_MAJOR" libev-dev libssl-dev zlib1g-dev libc-ares-dev

install_h2load() {
  local scratch source_dir
  scratch="$(mktemp -d)"
  source_dir="$scratch/nghttp2-$NGHTTP2_VERSION"
  if ! curl -fsSL -o "$scratch/nghttp2.tar.xz" \
    "https://github.com/nghttp2/nghttp2/releases/download/v$NGHTTP2_VERSION/nghttp2-$NGHTTP2_VERSION.tar.xz"; then
    rm -rf "$scratch"
    die "could not download nghttp2 $NGHTTP2_VERSION"
  fi
  if ! printf '%s  %s\n' "$NGHTTP2_SHA256" "$scratch/nghttp2.tar.xz" | sha256sum -c --quiet -; then
    rm -rf "$scratch"
    die "the nghttp2 $NGHTTP2_VERSION download does not match its pinned SHA-256"
  fi
  tar -xJf "$scratch/nghttp2.tar.xz" -C "$scratch"
  if ! (cd "$source_dir" \
    && CC="gcc-$NGHTTP2_COMPILER_MAJOR" CXX="g++-$NGHTTP2_COMPILER_MAJOR" ./configure --quiet --enable-app \
      --disable-shared --disable-python-bindings --without-systemd --without-jemalloc --without-libxml2 \
    && make --quiet -j"$(nproc)" >/dev/null); then
    rm -rf "$scratch"
    die "could not build h2load from nghttp2 $NGHTTP2_VERSION"
  fi
  as_root install -m 755 "$source_dir/src/h2load" /usr/local/bin/h2load
  rm -rf "$scratch"
}

case "$(h2load --version 2>/dev/null || true)" in
  *"nghttp2/$NGHTTP2_VERSION"*) log "h2load $NGHTTP2_VERSION is already installed" ;;
  *)
    log "build h2load from nghttp2 $NGHTTP2_VERSION, checked against the pinned SHA-256, because Ubuntu 24.04 packages 1.59.0"
    install_h2load
    ;;
esac

current_node_major="$(node -v 2>/dev/null | sed -n 's/^v\([0-9]*\)\..*/\1/p' || true)"
if [ "$current_node_major" != "$NODE_MAJOR" ]; then
  log "install Node $NODE_MAJOR from the NodeSource apt repository"
  as_root install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | as_root gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' "$NODE_MAJOR" \
    | as_root tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  apt_get update -qq
  apt_get install -y -qq nodejs
fi

log "enable pnpm at the version in the packageManager field of package.json"
as_root corepack enable
(cd "$REPO" && corepack install)

install_uv() {
  local arch expected scratch
  case "$(uname -m)" in
    x86_64) arch="x86_64"; expected="$UV_SHA256_X86_64" ;;
    aarch64 | arm64) arch="aarch64"; expected="$UV_SHA256_AARCH64" ;;
    *) die "no uv build is pinned for $(uname -m)" ;;
  esac
  scratch="$(mktemp -d)"
  if ! curl -fsSL -o "$scratch/uv.tar.gz" \
    "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$arch-unknown-linux-gnu.tar.gz"; then
    rm -rf "$scratch"
    die "could not download uv $UV_VERSION"
  fi
  if ! printf '%s  %s\n' "$expected" "$scratch/uv.tar.gz" | sha256sum -c --quiet -; then
    rm -rf "$scratch"
    die "the uv $UV_VERSION download does not match its pinned SHA-256"
  fi
  tar -xzf "$scratch/uv.tar.gz" -C "$scratch"
  as_root install -m 755 "$scratch/uv-$arch-unknown-linux-gnu/uv" "$scratch/uv-$arch-unknown-linux-gnu/uvx" /usr/local/bin/
  rm -rf "$scratch"
}

case "$(uv --version 2>/dev/null || true)" in
  "uv $UV_VERSION" | "uv $UV_VERSION "*) log "uv $UV_VERSION is already installed" ;;
  *)
    log "install uv $UV_VERSION from its GitHub release, checked against the pinned SHA-256"
    install_uv
    ;;
esac

log "install the Python and matplotlib that benchmarks/writeup pins"
(cd "$REPO/benchmarks/writeup" && uv sync --frozen --quiet)

cpus="$(nproc)"
if [ "$cpus" -lt "$MIN_PINNING_CPUS" ]; then
  log "warning: this VM has $cpus CPUs, and the suite pins nothing below $MIN_PINNING_CPUS"
fi

log "node $(node -v), pnpm $(cd "$REPO" && pnpm --version), $(h2load --version | head -n 1), $(uv --version), $cpus CPUs"
log "done"
