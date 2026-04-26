#!/bin/bash
# Decrypt .secrets.env.gpg to stdout. Source with:
#   eval "$(bash /workspace/group/decrypt-secrets.sh)"
set -euo pipefail
KEYFILE="/workspace/extra/nanoclaw-secrets.key"
ENC_FILE="$(dirname "$0")/.secrets.env.gpg"

if [ ! -f "$KEYFILE" ]; then
  echo "ERROR: Keyfile not found at $KEYFILE" >&2
  exit 1
fi

if [ ! -f "$ENC_FILE" ]; then
  echo "ERROR: Encrypted secrets not found at $ENC_FILE" >&2
  exit 1
fi

gpg --batch --yes --quiet --decrypt --passphrase-file "$KEYFILE" "$ENC_FILE" 2>/dev/null
