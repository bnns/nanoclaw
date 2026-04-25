---
name: discord-formatting
description: Format messages for Discord. Use when responding to Discord channels.
---

# Discord Message Formatting

When responding to Discord channels, follow these rules:

## Links

Discord does NOT support Markdown links. Never use `[text](url)` syntax — it renders literally.

- **Wrong:** `[Click here](https://example.com)`
- **Right:** Just paste the bare URL: `https://example.com`
- **Right:** Add context around it: `Check out the site — https://example.com`

Discord auto-embeds URLs. Suppress embeds by wrapping in angle brackets: `<https://example.com>`

## Supported formatting

| Style | Syntax |
|-------|--------|
| Bold | `**text**` |
| Italic | `*text*` or `_text_` |
| Bold italic | `***text***` |
| Strikethrough | `~~text~~` |
| Inline code | `` `code` `` |
| Code block | ` ```language\ncode\n``` ` |
| Block quote | `> text` |
| Spoiler | `\|\|text\|\|` |
| Heading 1 | `# text` |
| Heading 2 | `## text` |
| Heading 3 | `### text` |
| Bulleted list | `- item` or `* item` |
| Numbered list | `1. item` |

## Mentions

- User: `<@USER_ID>`
- Role: `<@&ROLE_ID>`
- Channel: `<#CHANNEL_ID>`

## What Discord does NOT support

- `[text](url)` links — renders literally, never use these
- Tables
- Images via Markdown (use attachments or URLs)
- HTML tags
