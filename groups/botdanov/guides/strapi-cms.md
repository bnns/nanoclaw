# Strapi CMS — STP Website Content

Local Strapi instance managing all STP website content: meetings, articles, bibliography, publications.

## Setup

```bash
eval "$(bash /workspace/group/decrypt-secrets.sh)"
STP_API="http://host.docker.internal:4000/api"
```

Note: Strapi is a local service (`host.docker.internal`). The `$STP_API_TOKEN` must be passed explicitly.

## Important: draft vs published meetings

Some meetings are **unpublished** (draft-only) — typically unlisted YouTube recordings that shouldn't appear on the public website but ARE part of the knowledge base. To see ALL meetings (including drafts), **always add `status=draft`** to your Strapi queries. Without it, you only see published entries and will miss ~40 meetings.

## Endpoints

### Meetings

```bash
# List ALL meetings including unpublished (newest first, paginated)
curl -gs "$STP_API/meetings?status=draft&sort=date:desc&pagination[pageSize]=10" \
  -H "Authorization: Bearer $STP_API_TOKEN"

# Oldest meeting first
curl -gs "$STP_API/meetings?status=draft&sort=date:asc&pagination[pageSize]=1" \
  -H "Authorization: Bearer $STP_API_TOKEN"

# Search by name (case-insensitive contains)
curl -gs "$STP_API/meetings?status=draft&filters[name][\$containsi]=dialectic&sort=date:desc" \
  -H "Authorization: Bearer $STP_API_TOKEN"

# Create
curl -gs -X POST "$STP_API/meetings" \
  -H "Authorization: Bearer $STP_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"data":{"name":"Meeting Title","date":"2026-05-01T19:00:00.000Z","description":"Optional"}}'

# Delete by documentId
curl -gs -X DELETE "$STP_API/meetings/<documentId>" \
  -H "Authorization: Bearer $STP_API_TOKEN"
```

### Articles

```bash
curl -gs "$STP_API/articles?sort=publishedAt:desc&populate=*" \
  -H "Authorization: Bearer $STP_API_TOKEN"
```

### Bibliography

```bash
curl -gs "$STP_API/bibliographies?populate=*" \
  -H "Authorization: Bearer $STP_API_TOKEN"
```

## Strapi + Pinecone cross-reference

Strapi has structured meeting metadata (title, date, video URL, description). Pinecone has the actual transcript content. For questions about meeting content:

1. Look up the meeting in Strapi to get the exact title/URL
2. Query Pinecone with a title or URL filter (see `pinecone-rag.md`)

This two-step approach is far more reliable than trying to find meeting content through semantic search alone.
