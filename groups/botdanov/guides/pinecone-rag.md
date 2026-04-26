# Pinecone RAG — STP Knowledge Base

The Pinecone index contains ~130K vectors from STP YouTube meeting transcripts and uploaded PDFs/documents. 1024 dimensions, cosine metric. Embeddings are Cohere `embed-multilingual-v3.0`.

## Setup

No secrets or env vars needed for queries — auth is handled by exe.dev integrations.

> **Auth is automatic.** exe.dev integrations inject credentials when you use the `*.int.exe.xyz` hostnames:
> - **Pinecone** — `https://pinecone.int.exe.xyz`
> - **Cohere** — `https://cohere.int.exe.xyz`
>
> Do NOT add `Api-Key`, `x-api-key`, or `Authorization` headers for these services.

## Metadata fields

Every vector has:

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Meeting/document title (⚠️ may have trailing spaces) |
| `url` | string | YouTube URL or PDF source URL |
| `text` | string | The transcript chunk or document excerpt |
| `speaker` | string | Speaker label (`speaker_0`, `speaker_1`, etc.) — empty for PDFs |
| `startTime` | float | Start timestamp in seconds (0 for PDFs) |
| `endTime` | float | End timestamp in seconds (0 for PDFs) |
| `source` | string | Original file path or URL |
| `contentHash` | string | Present on PDFs only — hash of source content |

## Query patterns

Pinecone only supports **vector similarity search**, optionally combined with **metadata filters**. There is no full-text search. Choosing the right pattern matters — a vague semantic query often returns low-relevance results (scores < 0.2). Use metadata filters whenever you can narrow the scope first.

### Helper: create an embedding

```bash
embed_query() {
  curl -gs "https://cohere.int.exe.xyz/v2/embed" \
    -H "Content-Type: application/json" \
    -d "{\"texts\":[\"$1\"],\"model\":\"embed-multilingual-v3.0\",\"input_type\":\"search_query\",\"embedding_types\":[\"float\"]}" \
    | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['embeddings']['float'][0]))"
}
```

### Pattern 1: Title-filtered retrieval (BEST for known meetings)

When you know the meeting/document title (e.g. from Strapi), filter by title and pull all relevant chunks. This is the most reliable pattern.

```bash
# Get chunks from a specific meeting
VECTOR=$(python3 -c "import json; print(json.dumps([0.1]*1024))")
curl -gs -X POST "https://pinecone.int.exe.xyz/query" \
  -H "Content-Type: application/json" \
  -d "{\"vector\":$VECTOR,\"topK\":50,\"includeMetadata\":true,\"filter\":{\"title\":{\"\$eq\":\"Outline of a Research Project \"}}}" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('matches', []):
    md = m['metadata']
    print(f'[{md.get(\"startTime\",0):.0f}s] {md[\"text\"][:200]}')
"
```

⚠️ **Title matching is exact.** Some titles have trailing spaces or URL-encoded characters. If an exact match returns nothing, try these fallbacks:

```bash
# Fallback 1: Use $in with variations
"filter":{"title":{"$in":["Outline of a Research Project","Outline of a Research Project "]}}

# Fallback 2: List titles to find the exact string (see Pattern 5)
```

### Pattern 2: Semantic search (for topic/concept questions)

When the user asks about a concept or topic, not a specific meeting.

```bash
EMBEDDING=$(embed_query "dialectical materialism and organizational theory")
curl -gs -X POST "https://pinecone.int.exe.xyz/query" \
  -H "Content-Type: application/json" \
  -d "{\"vector\":$EMBEDDING,\"topK\":10,\"includeMetadata\":true}"
```

**Tips for better semantic results:**
- Use specific, content-level terms — not meta-queries like "first meeting" or "what happened"
- Include theoretical terms the speakers would actually use
- Scores > 0.3 are good hits; 0.15–0.3 are marginal; < 0.15 is noise
- If results are poor, reformulate with different terms and try again

### Pattern 3: Semantic + title filter (topic within a specific meeting)

Combine semantic search with a title filter to find relevant passages within one meeting.

```bash
EMBEDDING=$(embed_query "organizational theory cybernetics")
curl -gs -X POST "https://pinecone.int.exe.xyz/query" \
  -H "Content-Type: application/json" \
  -d "{\"vector\":$EMBEDDING,\"topK\":10,\"includeMetadata\":true,\"filter\":{\"title\":{\"\$eq\":\"Outline of a Research Project \"}}}"
```

### Pattern 4: URL-based lookup

When you have a YouTube video ID or URL. Useful for cross-referencing Strapi records.

```bash
VECTOR=$(python3 -c "import json; print(json.dumps([0.1]*1024))")

# YouTube URLs appear in several formats — try multiple
curl -gs -X POST "https://pinecone.int.exe.xyz/query" \
  -H "Content-Type: application/json" \
  -d "{\"vector\":$VECTOR,\"topK\":50,\"includeMetadata\":true,\"filter\":{\"url\":{\"\$eq\":\"https://www.youtube.com/watch?v=PYm34ZWZ2k4&list=PL8OmIRZsRoAJTkiCI6JB0xe4_fXd8aio8&index=3&t=1s\"}}}"
```

⚠️ URLs in Pinecone include full query strings (playlist ID, index, timestamp). A bare `watch?v=ID` may not match. If exact URL match fails, try the `youtu.be/ID` short form, or fall back to title-based filtering.

### Pattern 5: List all indexed titles (discovery)

When you need to know what's available or find the exact title string.

```bash
VECTOR=$(python3 -c "import json; print(json.dumps([0.1]*1024))")
curl -gs -X POST "https://pinecone.int.exe.xyz/query" \
  -H "Content-Type: application/json" \
  -d "{\"vector\":$VECTOR,\"topK\":1000,\"includeMetadata\":true}" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
titles = {}
for m in data.get('matches', []):
    t = m.get('metadata', {}).get('title', '')
    u = m.get('metadata', {}).get('url', '')
    if t and t not in titles:
        titles[t] = u
for t in sorted(titles):
    print(f'{t!r}  ->  {titles[t]}')
print(f'\nTotal: {len(titles)} unique titles')
"
```

This returns ~160 unique titles. Use it to discover exact title strings before doing Pattern 1 queries.

### Pattern 6: Multi-title query (compare across meetings)

```bash
"filter":{"title":{"$in":["Title One","Title Two","Title Three"]}}
```

## Retrieval strategy: how to answer questions

### "What happened in meeting X?" / "What was discussed in [title]?"

1. **Look up the meeting in Strapi** to get the exact title and video URL
2. **Use Pattern 1** (title filter) or **Pattern 4** (URL filter) to pull transcript chunks
3. Sort by `startTime` to reconstruct the conversation flow
4. Summarize the key points from the chunks

### "What has STP said about [topic]?"

1. **Use Pattern 2** (semantic search) with specific theoretical terms
2. Check which meetings come up in results — group by title
3. If a particular meeting looks relevant, use **Pattern 3** to get more context from it

### "Tell me about the first/earliest meeting" or time-based queries

1. **Query Strapi first** — `sort=date:asc&pagination[pageSize]=1` to find the earliest meeting
2. Get the title from Strapi
3. **Use Pattern 1** to pull that meeting's transcript chunks from Pinecone
4. Never assume a transcript "isn't indexed" without checking with a title filter — a vague semantic search proving unhelpful does NOT mean the content is absent

### "Is [document/video] in the knowledge base?"

1. **Use Pattern 5** to list titles and search for a match
2. Or **use Pattern 4** with the document URL

## Common pitfalls

- **Trailing spaces in titles** — Some titles have trailing whitespace. Use `$in` with both trimmed and untrimmed variants, or list titles first.
- **URL format mismatch** — YouTube URLs are stored with full query strings. A bare video ID won't match. Check exact format via Pattern 5.
- **Low semantic scores ≠ content not indexed** — Vague queries ("first meeting", "what happened") score poorly against transcript text. Always try metadata filters before concluding content is missing.
- **topK matters** — A meeting transcript may have hundreds of chunks. Use `topK: 50` for title-filtered queries to get good coverage. Use `topK: 5–10` for broad semantic search.
- **The dummy vector trick** — When you only need metadata filtering (not semantic similarity), use a uniform vector `[0.1]*1024`. The scores will be meaningless but the filter still works.
