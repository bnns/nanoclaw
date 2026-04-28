#!/bin/bash
# NanoClaw Security & Disk Audit
# Runs every 2 days via cron. Logs to /home/exedev/nanoclaw/logs/audit.log
set -uo pipefail
# Note: intentionally no -e; many checks use grep/find that return non-zero when no matches

LOG_DIR="/home/exedev/nanoclaw/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/audit.log"
ALERT=0

log() { echo "[$(date -Iseconds)] $1" >> "$LOG"; }
warn() { echo "[$(date -Iseconds)] ⚠️  WARNING: $1" >> "$LOG"; ALERT=1; }

log "========================================"
log "Security & Disk Audit started"
log "========================================"

# ── Disk Space ──────────────────────────────────────────────
log "--- Disk Space ---"
ROOT_USE=$(df / --output=pcent | tail -1 | tr -d ' %')
log "Root partition: ${ROOT_USE}% used"

if [ "$ROOT_USE" -ge 90 ]; then
  warn "CRITICAL: Root partition at ${ROOT_USE}% — immediate action needed"
elif [ "$ROOT_USE" -ge 80 ]; then
  warn "Root partition at ${ROOT_USE}% — approaching capacity"
fi

# Top space consumers
log "Top space consumers under /home/exedev:"
du -sh /home/exedev/*/ 2>/dev/null | sort -rh | head -10 >> "$LOG" 2>&1

# Docker disk usage
if command -v docker &>/dev/null; then
  log ""
  log "Docker disk usage:"
  docker system df 2>/dev/null >> "$LOG" || log "  (docker not accessible)"
  
  # Check for dangling images
  DANGLING=$(docker images -f dangling=true -q 2>/dev/null | wc -l)
  if [ "$DANGLING" -gt 0 ]; then
    warn "$DANGLING dangling Docker images wasting space"
  fi
  
  # Check build cache
  BUILD_CACHE=$(docker system df 2>/dev/null | grep 'Build Cache' | awk '{print $4}' | sed 's/GB//' | sed 's/MB//')
  log "Docker build cache reclaimable: $(docker system df 2>/dev/null | grep 'Build Cache' | awk '{print $4}')"
fi

# Large files (>100MB) that might be temp/forgotten
log ""
log "Files >100MB under /home/exedev:"
find /home/exedev -type f -size +100M -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/data/*' \
  -exec ls -lh {} \; 2>/dev/null | awk '{print $5, $9}' >> "$LOG" 2>&1 || true

# /tmp usage
TMP_USE=$(du -sm /tmp 2>/dev/null | awk '{print $1}')
log "/tmp usage: ${TMP_USE}MB"
if [ "$TMP_USE" -gt 500 ]; then
  warn "/tmp has ${TMP_USE}MB of data"
fi

# ── Plaintext Secrets ───────────────────────────────────────
log ""
log "--- Secrets Audit ---"

# Check for plaintext .secrets.env files (should only be .gpg)
PLAINTEXT_SECRETS=$(find /home/exedev -name '.secrets.env' -not -name '*.gpg' 2>/dev/null | grep -v node_modules || true)
if [ -n "$PLAINTEXT_SECRETS" ]; then
  warn "Plaintext secrets files found:"
  echo "$PLAINTEXT_SECRETS" >> "$LOG"
else
  log "No plaintext .secrets.env files found (good)"
fi

# Check for .env files with actual secrets (not examples)
ENV_FILES=$(find /home/exedev -name '.env' -not -path '*/node_modules/*' -not -name '.env.example' -not -name '.env.sample' 2>/dev/null || true)
if [ -n "$ENV_FILES" ]; then
  log "Found .env files (check for exposed credentials):"
  while IFS= read -r envfile; do
    # Count lines with KEY= or TOKEN= or SECRET= patterns that have values
    SENSITIVE=$(grep -cEi '(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)=' "$envfile" 2>/dev/null || echo 0)
    if [ "$SENSITIVE" -gt 0 ]; then
      warn "$envfile contains $SENSITIVE potential secret(s) in plaintext"
    else
      log "  $envfile (no sensitive keys detected)"
    fi
  done <<< "$ENV_FILES"
fi

# Check keyfile permissions
if [ -f /etc/nanoclaw-secrets.key ]; then
  KEYPERMS=$(stat -c '%a' /etc/nanoclaw-secrets.key)
  KEYOWNER=$(stat -c '%U' /etc/nanoclaw-secrets.key)
  if [ "$KEYPERMS" != "600" ]; then
    warn "Keyfile /etc/nanoclaw-secrets.key has permissive mode $KEYPERMS (should be 600)"
  else
    log "Keyfile permissions OK (600, owner: $KEYOWNER)"
  fi
else
  warn "Keyfile /etc/nanoclaw-secrets.key not found"
fi

# ── OneCLI Vault ─────────────────────────────────────────────
log ""
log "--- OneCLI Vault ---"
ONECLI_URL="http://172.17.0.1:10254"

# Check OneCLI is reachable
if curl -gs --max-time 5 "$ONECLI_URL/api/secrets" > /tmp/onecli_secrets.json 2>/dev/null; then
  log "OneCLI vault reachable"

  # Expected secrets that should be in the vault
  EXPECTED_SECRETS=("Pinecone" "Cohere" "Deepgram" "Mistral" "Anthropic")
  VAULT_CONTENTS=$(cat /tmp/onecli_secrets.json)

  for secret_name in "${EXPECTED_SECRETS[@]}"; do
    if echo "$VAULT_CONTENTS" | python3 -c "import sys,json; secrets=json.load(sys.stdin); sys.exit(0 if any(s['name']=='$secret_name' for s in secrets) else 1)" 2>/dev/null; then
      log "  ✓ $secret_name present in vault"
    else
      warn "$secret_name MISSING from OneCLI vault"
    fi
  done

  # Check agent secret mode
  if curl -gs --max-time 5 "$ONECLI_URL/api/agents" > /tmp/onecli_agents.json 2>/dev/null; then
    python3 -c "
import json
with open('/tmp/onecli_agents.json') as f:
    agents = json.load(f)
for a in agents:
    mode = a.get('secretMode', 'unknown')
    name = a.get('name', 'unknown')
    if mode != 'all':
        print(f'WARN:{name} has secretMode={mode} (should be all)')
    else:
        print(f'OK:{name} secretMode=all')
" 2>/dev/null | while IFS= read -r line; do
      if [[ "$line" == WARN:* ]]; then
        warn "${line#WARN:}"
      else
        log "  ${line#OK:}"
      fi
    done
  fi

  # Check for secrets that should NOT be in .secrets.env anymore
  if [ -f /etc/nanoclaw-secrets.key ]; then
    DECRYPTED=$(gpg --batch --yes --quiet --decrypt --passphrase-file /etc/nanoclaw-secrets.key \
      /home/exedev/nanoclaw/groups/botdanov/.secrets.env.gpg 2>/dev/null || true)
    for leaked_var in COHERE_API_KEY DEEPGRAM_API_KEY MISTRAL_API_KEY PINECONE_API_KEY ANTHROPIC_API_KEY; do
      if echo "$DECRYPTED" | grep -q "$leaked_var"; then
        warn "$leaked_var found in .secrets.env.gpg but should be OneCLI-managed only"
      fi
    done
  fi

  rm -f /tmp/onecli_secrets.json /tmp/onecli_agents.json
else
  warn "OneCLI vault unreachable at $ONECLI_URL"
fi

# ── File Permissions ────────────────────────────────────────
log ""
log "--- File Permissions ---"

# Check for world-readable sensitive files
WORLD_READABLE=$(find /home/exedev/nanoclaw/groups \( -name '*.gpg' -o -name '*.key' -o -name '*.env' \) 2>/dev/null | \
  while read f; do
    perms=$(stat -c '%a' "$f" 2>/dev/null || echo "000")
    group_bit=$(( (perms / 10) % 10 ))
    other_bit=$(( perms % 10 ))
    if [ "$group_bit" -gt 0 ] || [ "$other_bit" -gt 0 ]; then
      echo "$f ($perms)"
    fi
  done)
if [ -n "$WORLD_READABLE" ]; then
  warn "Sensitive files with group/world access:"
  echo "$WORLD_READABLE" >> "$LOG"
else
  log "Sensitive file permissions OK"
fi

# ── Listening Services ──────────────────────────────────────
log ""
log "--- Network Services ---"
log "Listening ports:"
ss -tlnp 2>/dev/null | grep LISTEN >> "$LOG" 2>&1 || true

# Check for unexpected listeners
# Known services: 3000=stp-frontend, 4000=strapi, 8000=dev, 9900=host-api,
# 9999=shelley, 10254+10255=onecli, 5432=postgres, 22=ssh
# Also ignore 127.0.0.1 high ports (Node debug/inspector, ephemeral)
UNEXPECTED=$(ss -tlnp 2>/dev/null | grep LISTEN | \
  grep -vE ':(3000|4000|8000|9900|9999|10254|10255|5432|22)\b' | \
  grep -vE '127\.0\.0\.1:[3-6][0-9]{4}' | \
  grep -v '127.0.0.53' || true)
if [ -n "$UNEXPECTED" ]; then
  warn "Unexpected listening services:"
  echo "$UNEXPECTED" >> "$LOG"
fi

# ── Session DB Size ─────────────────────────────────────────
log ""
log "--- Session DB Size ---"
SESSION_DIR="/home/exedev/nanoclaw/data/v2-sessions"
if [ -d "$SESSION_DIR" ]; then
  SESS_SIZE_MB=$(du -sm "$SESSION_DIR" 2>/dev/null | awk '{print $1}')
  log "Session DBs total: ${SESS_SIZE_MB}MB"

  if [ "$SESS_SIZE_MB" -ge 2000 ]; then
    warn "Session DBs at ${SESS_SIZE_MB}MB — pruning old messages recommended"
    log "  To prune: find sessions with large inbound.db, delete messages_in rows"
    log "  older than 90 days, then VACUUM. Same for outbound.db/messages_out."
    log "  Example:"
    log "    sqlite3 <path>/inbound.db \"DELETE FROM messages_in WHERE timestamp < datetime('now', '-90 days'); VACUUM;\""
  elif [ "$SESS_SIZE_MB" -ge 1000 ]; then
    warn "Session DBs at ${SESS_SIZE_MB}MB — monitor growth"
  else
    log "Session DB size OK (under 1GB)"
  fi

  # Largest individual session DBs
  log "Top 5 largest session DBs:"
  find "$SESSION_DIR" -name '*.db' -exec du -sm {} \; 2>/dev/null | sort -rn | head -5 >> "$LOG" 2>&1 || true
else
  log "Session directory not found: $SESSION_DIR"
fi

# ── SSH & Auth ──────────────────────────────────────────────
log ""
log "--- Authentication ---"

# Check for unauthorized SSH keys
AUTH_KEYS="/home/exedev/.ssh/authorized_keys"
if [ -f "$AUTH_KEYS" ]; then
  KEY_COUNT=$(wc -l < "$AUTH_KEYS")
  log "SSH authorized_keys: $KEY_COUNT key(s)"
  # Log key fingerprints (not the full keys)
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    [[ "$line" == \#* ]] && continue
    FP=$(echo "$line" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}') || FP="(could not fingerprint)"
    COMMENT=$(echo "$line" | awk '{print $NF}')
    log "  Key: $FP ($COMMENT)"
  done < "$AUTH_KEYS"
fi

# Recent failed auth attempts
FAILED_AUTH=$(journalctl -u ssh --since '2 days ago' 2>/dev/null | grep -c 'Failed password\|Invalid user' 2>/dev/null || true)
FAILED_AUTH=${FAILED_AUTH:-0}
if [ "$FAILED_AUTH" -gt 10 ]; then
  warn "$FAILED_AUTH failed SSH attempts in the last 2 days"
else
  log "Failed SSH attempts (2 days): $FAILED_AUTH"
fi

# ── Docker Security ─────────────────────────────────────────
log ""
log "--- Docker Security ---"
if command -v docker &>/dev/null; then
  # Running containers
  log "Running containers:"
  docker ps --format '  {{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null >> "$LOG" || true
  
  # Check for containers running as root
  ROOT_CONTAINERS=$(docker ps -q 2>/dev/null | while read cid; do
    USER=$(docker inspect --format '{{.Config.User}}' "$cid" 2>/dev/null)
    NAME=$(docker inspect --format '{{.Name}}' "$cid" 2>/dev/null | sed 's|^/||')
    if [ -z "$USER" ] || [ "$USER" = "root" ] || [ "$USER" = "0" ]; then
      echo "$NAME (user: ${USER:-unset})"
    fi
  done)
  if [ -n "$ROOT_CONTAINERS" ]; then
    log "Containers running as root (review if expected):"
    echo "$ROOT_CONTAINERS" | while read line; do log "  $line"; done
  fi
fi

# ── System Updates ──────────────────────────────────────────
log ""
log "--- System Updates ---"
SEC_UPDATES=$(apt list --upgradable 2>/dev/null | grep -c security || echo 0)
if [ "$SEC_UPDATES" -gt 0 ]; then
  warn "$SEC_UPDATES security update(s) available"
else
  log "No pending security updates"
fi

# ── Summary ─────────────────────────────────────────────────
log ""
if [ "$ALERT" -eq 1 ]; then
  log "🚨 AUDIT COMPLETED WITH WARNINGS — review above"
else
  log "✅ AUDIT COMPLETED — no issues found"
fi
log ""
