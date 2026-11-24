#!/bin/sh
# Connect to the BRL VPS using creds from ~/.secrets/suyashh/deploy.env (outside any repo).
# This file holds NO secrets. Read-only by default - it only runs what you pass it.
# Usage:
#   sh scripts/ssh-vps.sh                 # interactive shell on the VPS
#   sh scripts/ssh-vps.sh 'pm2 list'      # run a command and return
#
# Deploy model for this box is manual push + PM2 restart. Do NOT touch the GoComet
# processes (autopilot / server / best-spot-bidding-dev) - the SP bidder runs as its
# own separately-named PM2 process.

SECRETS="$HOME/.secrets/suyashh/deploy.env"
[ -f "$SECRETS" ] || { echo "Missing secrets file: $SECRETS" >&2; exit 1; }

# shellcheck disable=SC1090
. "$SECRETS"

ASKPASS="$(mktemp)"
trap 'rm -f "$ASKPASS"' EXIT
printf '#!/bin/sh\nprintf "%%s\\n" "$SUYASHH_VPS_PASSWORD"\n' > "$ASKPASS"
chmod +x "$ASKPASS"

SSH_ASKPASS="$ASKPASS"
SSH_ASKPASS_REQUIRE=force
DISPLAY=:0
export SUYASHH_VPS_PASSWORD SSH_ASKPASS SSH_ASKPASS_REQUIRE DISPLAY

ssh -p "${SUYASHH_VPS_SSH_PORT:-22}" \
  -o StrictHostKeyChecking=accept-new \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o NumberOfPasswordPrompts=1 \
  "${SUYASHH_VPS_USER}@${SUYASHH_VPS_IP}" "$@"
