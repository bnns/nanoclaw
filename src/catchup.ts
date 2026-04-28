/**
 * Post-connect catch-up.
 *
 * After channel adapters reconnect (restart, network blip), fetch recent
 * messages from channels with active sessions and replay any that were
 * missed during the downtime.
 *
 * Strategy: for each active session, read the last ingested message ID
 * from inbound.db and use it as the "after" cursor for Discord's
 * fetchMessages API. Discord snowflake IDs are chronologically ordered,
 * so this fetches exactly the messages we missed — zero waste.
 *
 * Fetches are serialized with a delay to avoid Discord rate limits.
 */
import Database from 'better-sqlite3';

import { getChannelAdapter } from './channels/channel-registry.js';
import { getActiveSessions } from './db/sessions.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { log } from './log.js';
import { routeInbound } from './router.js';
import { openInboundDb } from './session-manager.js';
import type { InboundEvent } from './channels/adapter.js';

/** Delay after startup before running catch-up (let Gateway settle). */
const CATCHUP_DELAY_MS = 8_000;

/** Delay between API calls to avoid rate limits. */
const INTER_FETCH_DELAY_MS = 1_500;

/** Max messages to fetch per channel. */
const FETCH_LIMIT = 20;

/** Only catch up sessions active within this window. */
const RECENCY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Schedule a catch-up sweep after a short delay.
 * Called once at startup, after channel adapters are initialized.
 */
export function scheduleCatchUp(): void {
  setTimeout(() => {
    runCatchUp().catch((err) => {
      log.error('Catch-up sweep failed', { err });
    });
  }, CATCHUP_DELAY_MS);
}

interface CatchUpTarget {
  channelType: string;
  platformId: string;
  threadId: string | null;
  agentGroupId: string;
  /** Raw platform message ID (before :agentGroupId suffix) of the last ingested message. */
  lastMessageId: string;
}

async function runCatchUp(): Promise<void> {
  const sessions = getActiveSessions();
  if (sessions.length === 0) return;

  // Build deduplicated targets: one per (channelType, threadId/platformId).
  // Use the highest last-message-ID across sessions sharing a thread.
  const targets = new Map<string, CatchUpTarget>();

  const cutoff = new Date(Date.now() - RECENCY_WINDOW_MS).toISOString();

  for (const session of sessions) {
    if (!session.messaging_group_id) continue;
    // Skip sessions that haven't been active recently
    if (session.last_active && session.last_active < cutoff) continue;

    const mg = getMessagingGroup(session.messaging_group_id);
    if (!mg) continue;

    const adapter = getChannelAdapter(mg.channel_type);
    if (!adapter?.fetchRecentMessages) continue;

    const lastId = getLastMessageId(session.agent_group_id, session.id);
    if (!lastId) continue; // No messages in this session — nothing to catch up

    const key = session.thread_id ?? mg.platform_id;
    const existing = targets.get(key);
    // Keep the highest (most recent) message ID as cursor
    if (!existing || lastId > existing.lastMessageId) {
      targets.set(key, {
        channelType: mg.channel_type,
        platformId: mg.platform_id,
        threadId: session.thread_id,
        agentGroupId: session.agent_group_id,
        lastMessageId: lastId,
      });
    }
  }

  if (targets.size === 0) return;

  let totalReplayed = 0;

  for (const [, target] of targets) {
    const adapter = getChannelAdapter(target.channelType);
    if (!adapter?.fetchRecentMessages) continue;

    try {
      const messages = await adapter.fetchRecentMessages(
        target.platformId,
        target.threadId,
        FETCH_LIMIT,
        target.lastMessageId,
      );

      let replayed = 0;
      for (const msg of messages) {
        if (!msg.id) continue;

        const event: InboundEvent = {
          channelType: target.channelType,
          platformId: target.platformId,
          threadId: target.threadId,
          message: {
            id: msg.id,
            kind: msg.kind,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            timestamp: msg.timestamp,
            isMention: msg.isMention,
            isGroup: msg.isGroup,
          },
        };

        await routeInbound(event).catch((err) => {
          // UNIQUE constraint = message already ingested (normal race with Gateway)
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('UNIQUE constraint')) {
            log.debug('Catch-up: message already ingested', { messageId: msg.id });
            replayed--; // Don't count as replayed
          } else {
            log.warn('Catch-up: failed to route message', { messageId: msg.id, err });
          }
        });
        replayed++;
      }

      if (replayed > 0) {
        totalReplayed += replayed;
        log.info('Catch-up: replayed missed messages', {
          channelType: target.channelType,
          threadId: target.threadId,
          replayed,
          fetched: messages.length,
        });
      }
    } catch (err) {
      log.warn('Catch-up: failed to fetch messages', {
        channelType: target.channelType,
        threadId: target.threadId,
        err,
      });
    }

    // Throttle between fetches
    await sleep(INTER_FETCH_DELAY_MS);
  }

  if (totalReplayed > 0) {
    log.info('Catch-up sweep complete', { totalReplayed });
  } else {
    log.info('Catch-up sweep: no missed messages');
  }
}

/**
 * Get the raw platform message ID of the last ingested chat message
 * in a session's inbound.db. Strips the `:agentGroupId` suffix.
 */
function getLastMessageId(agentGroupId: string, sessionId: string): string | null {
  let db: Database.Database;
  try {
    db = openInboundDb(agentGroupId, sessionId);
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare(
        `SELECT id FROM messages_in
         WHERE kind IN ('chat', 'chat-sdk')
         ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (!row) return null;
    // Strip ":agentGroupId" suffix to get the raw platform message ID
    const colonIdx = row.id.lastIndexOf(':');
    return colonIdx > 0 ? row.id.slice(0, colonIdx) : row.id;
  } finally {
    db.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
