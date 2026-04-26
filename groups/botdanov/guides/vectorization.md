# Vectorization — Adding Content to the Knowledge Base

Process YouTube recordings and PDF documents into Pinecone vectors so they become searchable.

## Scope restrictions

**Only vectorize:**
- **YouTube videos**: STP meeting recordings from the theoreticalpractice.com YouTube channel. Do NOT process random videos, music, or non-STP content.
- **PDFs**: Academic articles, books, and theoretical texts relevant to STP’s work. Do NOT process random files, memes, or non-academic content.

If someone asks you to vectorize something outside this scope, politely explain that the knowledge base is reserved for STP research materials.

## Prerequisites

The container needs `yt-dlp` and `ffmpeg` for YouTube processing. If not installed, use the self-mod tool to request `install_packages` with apt packages `yt-dlp` and `ffmpeg`.

> **Auth is automatic.** exe.dev integrations inject credentials when you use the `*.int.exe.xyz` hostnames (Pinecone, Cohere, Deepgram, Mistral). Do NOT add auth headers for these services.


---

## YouTube Pipeline

Full flow: Extract audio → Transcribe (Deepgram) → Chunk transcript → Embed (Cohere) → Upsert (Pinecone)

### Step 1: Check if already indexed

Before processing, check if the video is already in Pinecone:

```bash
VIDEO_ID="PYm34ZWZ2k4"  # extract from URL
TITLE="Outline of a Research Project"  # from Strapi or video title

# Check by title
VECTOR=$(python3 -c "import json; print(json.dumps([0.1]*1024))")
RESULT=$(curl -gs -X POST "https://pinecone.int.exe.xyz/query" \
  -H "Content-Type: application/json" \
  -d "{\"vector\":$VECTOR,\"topK\":1,\"includeMetadata\":true,\"filter\":{\"title\":{\"\$eq\":\"$TITLE\"}}}")

echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
matches = data.get('matches', [])
if matches:
    print(f'ALREADY INDEXED: {len(matches)} chunks found')
else:
    print('NOT INDEXED: safe to process')
"
```

### Step 2: Download audio

```bash
mkdir -p /tmp/stp-audio
yt-dlp -x --audio-format wav --audio-quality 0 \
  -o "/tmp/stp-audio/%(id)s.%(ext)s" \
  "https://www.youtube.com/watch?v=$VIDEO_ID"

AUDIO_FILE="/tmp/stp-audio/${VIDEO_ID}.wav"
```

If yt-dlp isn’t available, you can also transcribe directly from URL using Deepgram’s URL mode (skip to Step 3 alt).

### Step 3: Transcribe with Deepgram

**Option A: From file** (requires audio download)
```bash
# For large files, increase timeout
TRANSCRIPT=$(curl -gs --max-time 600 \
  -X POST "https://deepgram.int.exe.xyz/v1/listen?model=nova-2&diarize=true&punctuate=true&smart_format=true&utterances=true" \
  -H "Content-Type: audio/wav" \
  --data-binary @"$AUDIO_FILE")

echo "$TRANSCRIPT" > "/tmp/stp-audio/${VIDEO_ID}_transcript.json"
```

**Option B: From YouTube URL directly** (no download needed, but less reliable for long videos)
```bash
TRANSCRIPT=$(curl -gs --max-time 600 \
  -X POST "https://deepgram.int.exe.xyz/v1/listen?model=nova-2&diarize=true&punctuate=true&smart_format=true&utterances=true" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://www.youtube.com/watch?v=$VIDEO_ID\"}")
```

### Step 4: Chunk the transcript

Use Python to chunk utterances into groups of ~5 exchanges with 2-exchange overlap:

```bash
python3 << 'PYEOF'
import json, sys

with open(f"/tmp/stp-audio/{VIDEO_ID}_transcript.json") as f:
    data = json.load(f)

utterances = data.get("results", {}).get("utterances", [])
if not utterances:
    # Fallback: use full transcript as single chunk
    text = data["results"]["channels"][0]["alternatives"][0]["transcript"]
    chunks = [{"id": f"{VIDEO_ID}_chunk0", "text": text, "start": 0, "end": 0, "speaker": ""}]
else:
    chunks = []
    window = []
    chunk_idx = 0
    MAX_EXCHANGES = 5
    OVERLAP = 2

    for i, utt in enumerate(utterances):
        window.append(utt)
        if len(window) >= MAX_EXCHANGES or i == len(utterances) - 1:
            text = "\n".join(f"speaker_{u['speaker']}: {u['transcript']}" for u in window)
            chunks.append({
                "id": f"{VIDEO_ID}_chunk{chunk_idx}",
                "text": text,
                "start": window[0]["start"],
                "end": window[-1]["end"],
                "speaker": ",".join(set(f"speaker_{u['speaker']}" for u in window))
            })
            chunk_idx += 1
            # Overlap: keep last N utterances
            window = window[-OVERLAP:] if len(window) > OVERLAP else []

with open(f"/tmp/stp-audio/{VIDEO_ID}_chunks.json", "w") as f:
    json.dump(chunks, f)

print(f"Created {len(chunks)} chunks")
PYEOF
```

**Note:** Replace `{VIDEO_ID}` with the actual variable in your script — use an f-string or pass it as an argument.

### Step 5: Embed and upsert

Process chunks in batches of 20 (Cohere limit) and upsert to Pinecone in batches of 100:

```bash
python3 << 'PYEOF'
import json, time, sys, urllib.request

VIDEO_ID = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VIDEO_ID")
TITLE = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("TITLE")
VIDEO_URL = sys.argv[3] if len(sys.argv) > 3 else f"https://www.youtube.com/watch?v={VIDEO_ID}"

import os
PINECONE_HOST = "https://pinecone.int.exe.xyz"

with open(f"/tmp/stp-audio/{VIDEO_ID}_chunks.json") as f:
    chunks = json.load(f)

print(f"Embedding {len(chunks)} chunks...")

# Embed in batches of 20
all_embeddings = []
for i in range(0, len(chunks), 20):
    batch = chunks[i:i+20]
    texts = [c["text"] for c in batch]
    
    req_data = json.dumps({
        "texts": texts,
        "model": "embed-multilingual-v3.0",
        "input_type": "search_document",
        "embedding_types": ["float"]
    }).encode()
    
    req = urllib.request.Request(
        "https://cohere.int.exe.xyz/v2/embed",
        data=req_data,
        headers={
            "Content-Type": "application/json"
        }
    )
    
    with urllib.request.urlopen(req) as resp:
        result = json.load(resp)
    
    all_embeddings.extend(result["embeddings"]["float"])
    print(f"  Embedded batch {i//20 + 1}/{-(-len(chunks)//20)}")
    time.sleep(0.2)  # Rate limit

print(f"Total embeddings: {len(all_embeddings)}")

# Build Pinecone vectors
vectors = []
for chunk, embedding in zip(chunks, all_embeddings):
    vectors.append({
        "id": chunk["id"],
        "values": embedding,
        "metadata": {
            "text": chunk["text"],
            "title": TITLE,
            "url": VIDEO_URL,
            "speaker": chunk.get("speaker", ""),
            "startTime": chunk.get("start", 0),
            "endTime": chunk.get("end", 0),
            "source": f"/tmp/stp-audio/{VIDEO_ID}_transcript.json"
        }
    })

# Upsert in batches of 100
for i in range(0, len(vectors), 100):
    batch = vectors[i:i+100]
    req_data = json.dumps({"vectors": batch}).encode()
    
    req = urllib.request.Request(
        f"{PINECONE_HOST}/vectors/upsert",
        data=req_data,
        headers={
            "Content-Type": "application/json"
        }
    )
    
    with urllib.request.urlopen(req) as resp:
        result = json.load(resp)
    
    print(f"  Upserted batch {i//100 + 1}/{-(-len(vectors)//100)}: {result}")

print(f"Done! Vectorized '{TITLE}' — {len(vectors)} vectors upserted.")
PYEOF
```

### Step 6: Cleanup

```bash
rm -f "/tmp/stp-audio/${VIDEO_ID}.wav" "/tmp/stp-audio/${VIDEO_ID}_transcript.json" "/tmp/stp-audio/${VIDEO_ID}_chunks.json"
```

---

## PDF Pipeline

Full flow: Extract text (Mistral OCR) → Chunk → Embed (Cohere) → Upsert (Pinecone)

### Step 1: Check if already indexed

```bash
PDF_URL="https://example.com/paper.pdf"
PDF_TITLE="Paper Title"  # clean, human-readable title

# Check by title or URL
VECTOR=$(python3 -c "import json; print(json.dumps([0.1]*1024))")
curl -gs -X POST "https://pinecone.int.exe.xyz/query" \
  -H "Content-Type: application/json" \
  -d "{\"vector\":$VECTOR,\"topK\":1,\"includeMetadata\":true,\"filter\":{\"title\":{\"\$eq\":\"$PDF_TITLE\"}}}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('ALREADY INDEXED' if d.get('matches') else 'NOT INDEXED')"
```

### Step 2: Extract text with Mistral OCR

```bash
# From URL
RESULT=$(curl -gs --max-time 120 "https://mistral.int.exe.xyz/v1/ocr" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"mistral-ocr-latest\",\"document\":{\"type\":\"document_url\",\"document_url\":\"$PDF_URL\"}}")

# Extract text from pages
echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
pages = data.get('pages', [])
text = '\n\n'.join(p.get('markdown', '') for p in pages)
with open('/tmp/pdf_extracted.txt', 'w') as f:
    f.write(text)
print(f'Extracted {len(text)} chars from {len(pages)} pages')
"
```

If Mistral OCR isn’t available, you can fall back to simpler extraction:
```bash
# Download the PDF and extract with python
curl -gs -o /tmp/doc.pdf "$PDF_URL"
python3 -c "
import subprocess
result = subprocess.run(['pdftotext', '/tmp/doc.pdf', '-'], capture_output=True, text=True)
with open('/tmp/pdf_extracted.txt', 'w') as f:
    f.write(result.stdout)
print(f'Extracted {len(result.stdout)} chars')
"
```
(Requires `pdftotext` — from apt package `poppler-utils`)

### Step 3: Chunk the text

```bash
python3 << 'PYEOF'
import json, hashlib

with open("/tmp/pdf_extracted.txt") as f:
    text = f.read()

# Generate content hash for deduplication
content_hash = hashlib.sha256(text.lower().strip().encode()).hexdigest()

# Split into paragraphs, then combine into ~1000 char chunks
paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
chunks = []
current = ""
chunk_idx = 0

for para in paragraphs:
    if len(current) + len(para) > 1000 and current:
        chunks.append({"id": f"{PDF_TITLE_SLUG}_chunk{chunk_idx}", "text": current})
        chunk_idx += 1
        current = para
    else:
        current += ("\n\n" + para) if current else para

if current:
    chunks.append({"id": f"{PDF_TITLE_SLUG}_chunk{chunk_idx}", "text": current})

with open("/tmp/pdf_chunks.json", "w") as f:
    json.dump({"chunks": chunks, "content_hash": content_hash}, f)

print(f"Created {len(chunks)} chunks (hash: {content_hash[:12]}...)")
PYEOF
```

**Note:** Set `PDF_TITLE_SLUG` to a filesystem-safe version of the title (e.g. `My_Paper_Title`).

### Step 4: Embed and upsert

Same pattern as YouTube Step 5, but with PDF-specific metadata:

```bash
python3 << 'PYEOF'
import json, time, os, urllib.request

PINECONE_HOST = "https://pinecone.int.exe.xyz"
PDF_TITLE = os.environ.get("PDF_TITLE", "Untitled")
PDF_URL = os.environ.get("PDF_URL", "")

with open("/tmp/pdf_chunks.json") as f:
    data = json.load(f)
chunks = data["chunks"]
content_hash = data["content_hash"]

print(f"Embedding {len(chunks)} PDF chunks...")

# Embed in batches of 20
all_embeddings = []
for i in range(0, len(chunks), 20):
    batch = chunks[i:i+20]
    texts = [c["text"] for c in batch]
    
    req_data = json.dumps({
        "texts": texts,
        "model": "embed-multilingual-v3.0",
        "input_type": "search_document",
        "embedding_types": ["float"]
    }).encode()
    
    req = urllib.request.Request(
        "https://cohere.int.exe.xyz/v2/embed",
        data=req_data,
        headers={
            "Content-Type": "application/json"
        }
    )
    
    with urllib.request.urlopen(req) as resp:
        result = json.load(resp)
    
    all_embeddings.extend(result["embeddings"]["float"])
    print(f"  Embedded batch {i//20 + 1}/{-(-len(chunks)//20)}")
    time.sleep(0.2)

# Build Pinecone vectors
vectors = []
for chunk, embedding in zip(chunks, all_embeddings):
    vectors.append({
        "id": chunk["id"],
        "values": embedding,
        "metadata": {
            "text": chunk["text"],
            "title": PDF_TITLE,
            "url": PDF_URL,
            "speaker": "",
            "startTime": 0,
            "endTime": 0,
            "source": PDF_URL,
            "contentHash": content_hash
        }
    })

# Upsert in batches of 100
for i in range(0, len(vectors), 100):
    batch = vectors[i:i+100]
    req_data = json.dumps({"vectors": batch}).encode()
    
    req = urllib.request.Request(
        f"{PINECONE_HOST}/vectors/upsert",
        data=req_data,
        headers={
            "Content-Type": "application/json"
        }
    )
    
    with urllib.request.urlopen(req) as resp:
        result = json.load(resp)
    
    print(f"  Upserted batch {i//100 + 1}/{-(-len(vectors)//100)}: {result}")

print(f"Done! Vectorized '{PDF_TITLE}' — {len(vectors)} vectors upserted.")
PYEOF
```

---

## Deletion

To remove a document from Pinecone (e.g., re-indexing or removing outdated content):

```bash
# Find all vector IDs for a title
VECTOR=$(python3 -c "import json; print(json.dumps([0.1]*1024))")
IDS=$(curl -gs -X POST "https://pinecone.int.exe.xyz/query" \
  -H "Content-Type: application/json" \
  -d "{\"vector\":$VECTOR,\"topK\":1000,\"includeMetadata\":false,\"filter\":{\"title\":{\"\$eq\":\"TITLE_HERE\"}}}" \
  | python3 -c "import sys,json; print(json.dumps([m['id'] for m in json.load(sys.stdin).get('matches',[])]))"
)

# Delete by IDs
curl -gs -X POST "https://pinecone.int.exe.xyz/vectors/delete" \
  -H "Content-Type: application/json" \
  -d "{\"ids\":$IDS}"
```

⚠️ Always confirm with the user before deleting. Deletions are permanent.

---

## Handling Discord requests

When a Discord member shares a PDF or asks you to vectorize a YouTube video:

1. **Validate scope** — Is it STP-related? Academic content?
2. **Check vectorization status** — Use the host API: `curl -gs -H "$AUTH" "$HOST/vectorization/search?q=keywords"`. See `guides/host-api.md` for details. If already indexed, skip. — Search Pinecone by title and/or URL first
3. **Confirm with the user** — "I’ll add this to the knowledge base. Processing may take a few minutes."
4. **Run the pipeline** — Use the appropriate steps above
5. **Update tracking** — After vectorizing, mark it: `curl -gs -X POST -H "$AUTH" -H 'Content-Type: application/json' $HOST/vectorization/mark -d '{"document_id":"<id>","status":"vectorized","vector_count":<N>}'`
6. **Report back** — "Done! Indexed [title] — X chunks added to the knowledge base."

For PDFs shared as Discord attachments, the URL is typically a `cdn.discordapp.com` link. These are temporary — download the PDF first, then process from the local file.

## Common issues

- **Deepgram timeout on long videos**: STP meetings are often 2+ hours. Use file upload (Option A) instead of URL mode. Increase `--max-time` to 900+.
- **Cohere rate limits**: The 200ms delay between batches usually suffices. If you get 429s, increase to 500ms.
- **Trailing spaces in titles**: Be consistent. Trim titles before indexing. Check `pinecone-rag.md` Pattern 5 to see existing title formats.
- **Duplicate content**: Always check before indexing. The content hash in PDF metadata helps detect re-uploads of the same document under different names.
- **Auth errors**: Make sure you’re using the `*.int.exe.xyz` hostnames, not the real API hostnames. The exe.dev integrations only inject credentials for requests to `*.int.exe.xyz`.

---

## Batch vectorization

When multiple meetings need vectorizing, use the vectorization tracking system instead of processing one at a time.

### Check what needs vectorizing

```bash
eval "$(bash /workspace/group/decrypt-secrets.sh)"
HOST="http://host.docker.internal:9900"
AUTH="Authorization: Bearer $HOST_API_TOKEN"

# Get all meetings with recordings but no Pinecone data
curl -gs -H "$AUTH" "$HOST/vectorization/status?filter=missing" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('meetings', []):
    if m.get('recording_url'):
        print(f'{m[\"date\"][:10] if m.get(\"date\") else \"no-date\"}: {m[\"title\"]}')
        print(f'  {m[\"recording_url\"]}')
"
```

### Process them in a loop

```bash
eval "$(bash /workspace/group/decrypt-secrets.sh)"
HOST="http://host.docker.internal:9900"
AUTH="Authorization: Bearer $HOST_API_TOKEN"

# Get the list
MEETINGS=$(curl -gs -H "$AUTH" "$HOST/vectorization/status?filter=missing")

# Process each one that has a recording URL
echo "$MEETINGS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('meetings', []):
    if m.get('recording_url'):
        print(f'{m[\"document_id\"]}|{m[\"title\"]}|{m[\"recording_url\"]}')
" | while IFS='|' read -r doc_id title url; do
    echo "=== Processing: $title ==="
    # Extract video ID
    VIDEO_ID=$(echo "$url" | grep -oP '(?:v=|youtu\.be/)([a-zA-Z0-9_-]{11})' | head -1 | sed 's/.*\///' | sed 's/v=//')
    
    if [ -z "$VIDEO_ID" ]; then
        echo "  Cannot extract video ID from $url"
        continue
    fi
    
    # Run the standard vectorization pipeline (Steps 1-6 from above)
    # ... (use the YouTube pipeline steps with VIDEO_ID and TITLE="$title")
    
    # After success, update tracking:
    curl -gs -X POST -H "$AUTH" -H 'Content-Type: application/json' \
      "$HOST/vectorization/mark" \
      -d "{\"document_id\":\"$doc_id\",\"status\":\"vectorized\",\"vector_count\":$CHUNK_COUNT}"
done
```

**Important:** After a batch, run a sync to verify: `curl -gs -X POST -H "$AUTH" $HOST/vectorization/sync`
