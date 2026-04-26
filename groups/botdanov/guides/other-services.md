# Other Services

> **Auth is automatic** for external APIs. exe.dev integrations inject credentials when you use the `*.int.exe.xyz` hostnames. Do NOT add auth headers for these services.

## Deepgram (speech-to-text)

Transcribe audio with speaker diarization.

```bash
curl -gs -X POST "https://deepgram.int.exe.xyz/v1/listen?model=nova-2&diarize=true&punctuate=true&smart_format=true" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/audio.mp3"}'
```

## Library Agent

External librarian agent for bibliographic info. May be slow (30s+) or down.

```bash
curl -gs --max-time 60 "https://stp-library.int.exe.xyz/api/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Your question here"}],"stream":false}'
```

Auth is injected automatically by the exe.dev integration. No API keys or secrets needed.

## DigitalOcean Spaces (file storage)

S3-compatible object storage for file uploads from Discord. Uses AWS sigv4 signing — credentials must be loaded explicitly.

```bash
eval "$(bash /workspace/group/decrypt-secrets.sh)"

curl -gs "https://${DO_SPACE_BUCKET}.${DO_SPACE_ENDPOINT}" \
  --aws-sigv4 "aws:amz:us-east-1:s3" \
  -u "${DO_SPACE_KEY}:${DO_SPACE_SECRET}"
```

## Mounted repos (direct file access)

- `/workspace/extra/stp` — Strapi CMS source
- `/workspace/extra/stp-frontend` — Next.js frontend source  
- `/workspace/extra/botdanov` — Original Botdanov v1 source (reference)

You can read and edit files directly. After editing frontend files, call the Host API rebuild endpoint to apply changes.
