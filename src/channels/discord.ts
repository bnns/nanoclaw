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
// literal markdown. Other masked links (label != URL) pass through unchanged
// so descriptive ones still render as clickable text.
//
// These degenerate pairs are mostly *manufactured by the adapter itself*: it
// re-renders outbound markdown through an AST round-trip, where a bare URL
// parses as a GFM autolink and re-serializes as [url](url). That happens
// after transformOutboundText, so the collapse must also be applied to the
// converter's output (see the fromAst wrap in the factory below).
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
    // formatConverter is private in the typings but reachable at runtime;
    // renderPostable calls this.fromAst, so an own-property wrap shadows the
    // class method and post-processes everything the converter renders.
    const conv = (
      discordAdapter as unknown as {
        formatConverter?: { fromAst(ast: unknown): string };
      }
    ).formatConverter;
    if (conv) {
      const origFromAst = conv.fromAst.bind(conv);
      conv.fromAst = (ast: unknown) => collapseDegenerateMaskedLinks(origFromAst(ast));
    }
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
