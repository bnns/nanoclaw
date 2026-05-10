/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

// Collapse `[X](Y)` → `Y` when X equals Y exactly. Discord renders masked
// links only when the label differs from the URL; identical pairs render as
// literal markdown, which agents sometimes emit when they have no better
// label than the URL itself. Other masked links (label != URL) pass through
// unchanged so descriptive ones still render as clickable text.
function collapseDegenerateMaskedLinks(text: string): string {
  return text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, url) =>
    label.trim() === url.trim() ? url : match,
  );
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    return createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      extractReplyContext,
      supportsThreads: true,
      maxTextLength: 2000,
      transformOutboundText: collapseDegenerateMaskedLinks,
    });
  },
});
