# Host API — Service Management

Manage host services and git repos from inside the container. All requests require auth.

## Setup

```bash
eval "$(bash /workspace/group/decrypt-secrets.sh)"
HOST="http://host.docker.internal:9900"
AUTH="Authorization: Bearer $HOST_API_TOKEN"
```

Note: Host API is a local service (`host.docker.internal`). The `$HOST_API_TOKEN` must be passed explicitly.

## Service management

Services: `strapi`, `stp-frontend`, `nanoclaw`

```bash
# Status
curl -gs -H "$AUTH" $HOST/status/strapi

# Restart
curl -gs -X POST -H "$AUTH" $HOST/restart/stp-frontend

# Rebuild (frontend only)
curl -gs -X POST -H "$AUTH" $HOST/rebuild/stp-frontend
```

## Git operations

Repos: `stp`, `stp-frontend`, `botdanov`

```bash
# Status
curl -gs -H "$AUTH" $HOST/git/status/stp-frontend

# Pull
curl -gs -X POST -H "$AUTH" $HOST/git/pull/stp

# Push
curl -gs -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  $HOST/git/push/stp -d '{"message":"update"}'
```

## Vectorization tracking

Track which STP meetings have been vectorized into Pinecone. Data synced from Strapi + Pinecone into a tracking DB.

```bash
# Summary: how many meetings are vectorized vs missing
curl -gs -H "$AUTH" $HOST/vectorization/status

# Filter by status: 'missing', 'vectorized', or 'unknown'
curl -gs -H "$AUTH" "$HOST/vectorization/status?filter=missing"

# Look up a specific meeting by Strapi document_id
curl -gs -H "$AUTH" $HOST/vectorization/status/<document_id>

# Search meetings by title keyword
curl -gs -H "$AUTH" "$HOST/vectorization/search?q=dialectic"

# Trigger a full sync (checks Strapi + Pinecone, updates tracking DB)
curl -gs -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  $HOST/vectorization/sync -d '{"force": false}'
# Use {"force": true} to recheck all meetings regardless of when last checked

# Manually mark a meeting after vectorizing it
curl -gs -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  $HOST/vectorization/mark -d '{"document_id": "abc123", "status": "vectorized", "vector_count": 150}'
```

Response fields per meeting:
- `document_id` — Strapi document ID
- `title` — meeting name
- `date` — meeting date (ISO)
- `recording_url` — YouTube link
- `vector_count` — number of Pinecone chunks (0 if not vectorized)
- `status` — `vectorized`, `missing`, or `unknown`
- `last_checked_at` — when Pinecone was last queried for this meeting

**After vectorizing a meeting**, call `/vectorization/mark` to update the tracking DB immediately, or call `/vectorization/sync` to recheck everything.

## When to use

- After editing files in `/workspace/extra/stp-frontend`, call rebuild to apply
- After editing Strapi content types in `/workspace/extra/stp`, restart strapi
- You cannot run `systemctl` or host-level git from inside the container — always use this API
