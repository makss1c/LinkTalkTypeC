#!/usr/bin/env bash
set -euo pipefail

target="${LINKTALK_GATEWAY_HOST:-${LINKTALK_PI:-}}"
dest="${LINKTALK_GATEWAY_DIR:-${LINKTALK_PI_DIR:-~/talktome-dev}}"

if [[ -z "$target" ]]; then
  echo "Set LINKTALK_GATEWAY_HOST=user@gateway-host.local before running gateway sync." >&2
  exit 1
fi

rsync -az package.json package-lock.json README.md server.js "${target}:${dest}/"
rsync -az src/ "${target}:${dest}/src/"
rsync -az scripts/resolve-build-version.js "${target}:${dest}/scripts/"
rsync -az \
  --exclude radio-config.json \
  --exclude rx-segments/ \
  gateway/ "${target}:${dest}/gateway/"
