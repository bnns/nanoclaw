# Botdanov2 Capabilities Reference

All external APIs and data sources available to you. Use bash + curl. No framework needed.

## IMPORTANT: Credential handling

### exe.dev integrations (automatic credential injection)

Most API credentials are managed by **exe.dev integrations**. Instead of calling real API hostnames, you call `*.int.exe.xyz` proxy hostnames — the integration layer injects the correct auth headers automatically.

| Service | Use this hostname | Instead of |
|---------|-------------------|------------|
| Pinecone | `https://pinecone.int.exe.xyz` | `*.pinecone.io` |
| Cohere | `https://cohere.int.exe.xyz` | `api.cohere.com` |
| Deepgram | `https://deepgram.int.exe.xyz` | `api.deepgram.com` |
| Mistral | `https://mistral.int.exe.xyz` | `api.mistral.ai` |
| Library Agent | `https://stp-library.int.exe.xyz` | `*.ondigitalocean.app` |
| Anthropic | `https://anthropic.int.exe.xyz` | `api.anthropic.com` |
| Gemini | `https://gemini.int.exe.xyz` | `generativelanguage.googleapis.com` |

**Do NOT add auth headers** (`x-api-key`, `Api-Key`, `Authorization`) **for these services** — the exe.dev integration injects them.

### Local secrets (encrypted at rest)

A small number of secrets for local services and AWS-style signing are stored encrypted in `.secrets.env.gpg`. Decrypt into the current shell when needed:
```bash
eval "$(bash /workspace/group/decrypt-secrets.sh)"
```

This provides: `$STP_API_TOKEN`, `$HOST_API_TOKEN`, `$DO_SPACE_KEY`, `$DO_SPACE_SECRET`, `$DO_SPACE_BUCKET`, `$DO_SPACE_ENDPOINT`.

**NEVER** print, echo, or expose any tokens or secrets in messages.
**NEVER** write decrypted secrets to disk — only hold them in shell variables.
**ALWAYS** use `curl -gs` (the -g flag prevents bracket issues).

## Service guides

Detailed usage patterns and examples for each service:

| Guide | Service | When to read |
|-------|---------|--------------|
| [guides/pinecone-rag.md](guides/pinecone-rag.md) | Pinecone vector DB | Answering questions about STP meeting content, transcripts, uploaded documents |
| [guides/vectorization.md](guides/vectorization.md) | Vectorization pipeline | Adding new YouTube recordings or PDFs to the knowledge base |
| [guides/strapi-cms.md](guides/strapi-cms.md) | Strapi CMS | Looking up meeting metadata, articles, bibliography; editing website content |
| [guides/host-api.md](guides/host-api.md) | Host API | Restarting services, rebuilding frontend, git operations |
| [guides/other-services.md](guides/other-services.md) | Deepgram, Library Agent, DO Spaces | Transcription, bibliographic queries, file storage |

**Read the relevant guide before making API calls** — each contains query patterns, gotchas, and strategies specific to that service.

## Quick reference: what lives where

| Data | Source | Access |
|------|--------|--------|
| Meeting titles, dates, video URLs | Strapi CMS | `guides/strapi-cms.md` |
| Meeting transcript text, document content | Pinecone | `guides/pinecone-rag.md` |
| Articles, bibliography | Strapi CMS | `guides/strapi-cms.md` |
| Service restarts, git push/pull | Host API | `guides/host-api.md` |
| Audio transcription | Deepgram | `guides/other-services.md` |
| Book/paper lookups | Library Agent | `guides/other-services.md` |
| File uploads from Discord | DO Spaces | `guides/other-services.md` |
| Source code | Mounted repos | `/workspace/extra/stp`, `/workspace/extra/stp-frontend`, `/workspace/extra/botdanov` |

## Discussion recaps

Generate a recap of recent discussions when a user asks (e.g. "give us a recap", "what's been discussed").

```bash
source /workspace/group/.secrets.env
curl -gs -X POST -H "Authorization: Bearer $HOST_API_TOKEN" \
  http://host.docker.internal:9900/recap
```

The recap is also auto-posted to #botdanov every Friday at 5pm UTC if there are 15+ messages since the last recap.

Recap history is saved in `/workspace/group/memory/recaps/`.

## Redaction (user privacy)

Remove a user's messages from conversation logs.

```bash
eval "$(bash /workspace/group/decrypt-secrets.sh)"
HOST="http://host.docker.internal:9900"
AUTH="Authorization: Bearer $HOST_API_TOKEN"

# Redact ALL messages from a user
curl -gs -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  $HOST/redact -d '{"userId":"discord:123456789"}'

# Redact a specific message (use the Discord message ID from the replied-to message)
curl -gs -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  $HOST/redact -d '{"userId":"discord:123456789","discordMessageId":"1497677313007947867"}'
```

How to get the IDs:
- User's Discord ID: available in the inbound message metadata as `userId` field
- Discord message ID: when a user replies to a message saying "redact this",
  the replied-to message's Discord ID is in the inbound event's reference/reply fields
- Format for userId is `discord:<numeric_id>`
