/**
 * Outbound message operations (container side).
 *
 * Writes to outbound.db (container-owned).
 * The host polls this DB (read-only) for undelivered messages.
 */
import { getInboundDb, getOutboundDb } from './connection.js';

export interface MessageOutRow {
  id: string;
  seq: number | null;
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

/**
 * Write a new outbound message, auto-assigning an odd seq number.
 * Container uses odd seq (1, 3, 5...), host uses even (2, 4, 6...).
 *
 * The disjoint namespace is load-bearing, not just collision avoidance:
 * seq is the agent-facing message ID returned by send_message and accepted
 * by edit_message / add_reaction, and getMessageIdBySeq() below looks up
 * by seq across BOTH tables. If inbound and outbound could share a seq,
 * the agent's "edit message #5" could resolve to the wrong row.
 */
export function writeMessageOut(msg: WriteMessageOut): number {
  const outbound = getOutboundDb();
  const inbound = getInboundDb();

  // Idempotency guard against double-emit. The agent can emit the same reply
  // through two output channels in a single turn — the send_message MCP tool
  // and a <message to="..."> block in its final text (dispatched by the
  // poll-loop). Each path writes its own messages_out row: identical content,
  // distinct id/seq. Host delivery dedups per-id, so it ships both and the
  // user sees the message twice.
  //
  // Byte-identical content to the same destination within a short window is
  // always this double-emit, never an intentional repeat. Collapse it: skip
  // the insert and return the existing row's seq so the caller's message id
  // still resolves. Scoped to immediate, non-recurring sends so scheduled and
  // recurring messages — which legitimately repeat — are never suppressed.
  if (msg.deliver_after == null && msg.recurrence == null) {
    const dup = outbound
      .prepare(
        `SELECT seq FROM messages_out
         WHERE content = $content
           AND kind = $kind
           AND IFNULL(platform_id, '') = IFNULL($platform_id, '')
           AND IFNULL(channel_type, '') = IFNULL($channel_type, '')
           AND IFNULL(thread_id, '') = IFNULL($thread_id, '')
           AND deliver_after IS NULL
           AND timestamp >= datetime('now', '-30 seconds')
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get({
        $content: msg.content,
        $kind: msg.kind,
        $platform_id: msg.platform_id ?? null,
        $channel_type: msg.channel_type ?? null,
        $thread_id: msg.thread_id ?? null,
      }) as { seq: number } | undefined;
    if (dup) {
      console.error(
        `[messages-out] Suppressed duplicate emission (seq ${dup.seq}, ${msg.content.length} chars) — identical content sent to the same destination <30s ago`,
      );
      return dup.seq;
    }
  }

  // Read max seq from both DBs to maintain global ordering.
  // Safe: each side only reads the other DB, never writes to it.
  const maxOut = (outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
  const maxIn = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  const max = Math.max(maxOut, maxIn);
  const nextSeq = max % 2 === 0 ? max + 1 : max + 2; // next odd

  // bun:sqlite requires named parameters to be passed with the prefix character
  // in the JS object keys (better-sqlite3 auto-stripped it, bun:sqlite does not).
  outbound
    .prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
     VALUES ($id, $seq, $in_reply_to, datetime('now'), $deliver_after, $recurrence, $kind, $platform_id, $channel_type, $thread_id, $content)`,
    )
    .run({
      $id: msg.id,
      $seq: nextSeq,
      $in_reply_to: msg.in_reply_to ?? null,
      $deliver_after: msg.deliver_after ?? null,
      $recurrence: msg.recurrence ?? null,
      $kind: msg.kind,
      $platform_id: msg.platform_id ?? null,
      $channel_type: msg.channel_type ?? null,
      $thread_id: msg.thread_id ?? null,
      $content: msg.content,
    });

  return nextSeq;
}

/**
 * Look up a message's platform ID by seq number.
 * Searches both inbound and outbound DBs since seq spans both.
 *
 * For inbound messages, the chat-sdk-native id lives inside the content JSON
 * (e.g. Discord snowflake "1499157370188599346", Telegram "6037840640:42").
 * The row's `id` column is `<chat-sdk-id>:<agent_group_id>` — namespaced by
 * the router (router.ts: messageIdForAgent) so multiple agent groups routed
 * from the same upstream message keep distinct rows. Platform APIs reject
 * the namespaced form, so reactions/edits must use the un-namespaced id
 * from content.
 *
 * For outbound messages, the internal ID (msg-xxx) won't work for edits/reactions.
 * Instead, look up the platform_message_id from the delivered table (host writes this
 * after successful delivery).
 */
export function getMessageIdBySeq(seq: number): string | null {
  const inbound = getInboundDb();

  // Inbound messages: parse content JSON for the chat-sdk-native id.
  const inRow = inbound.prepare('SELECT content FROM messages_in WHERE seq = ?').get(seq) as
    | { content: string }
    | undefined;
  if (inRow) {
    try {
      const parsed = JSON.parse(inRow.content) as { id?: unknown };
      if (typeof parsed.id === 'string' && parsed.id.length > 0) return parsed.id;
    } catch {
      // Malformed content — fall through to return null below.
    }
    return null;
  }

  // Outbound messages: look up platform message ID from delivered table
  const outRow = getOutboundDb().prepare('SELECT id FROM messages_out WHERE seq = ?').get(seq) as
    | { id: string }
    | undefined;
  if (!outRow) return null;

  // Check if host has stored the platform message ID after delivery
  const deliveredRow = inbound
    .prepare('SELECT platform_message_id FROM delivered WHERE message_out_id = ?')
    .get(outRow.id) as { platform_message_id: string | null } | undefined;
  if (deliveredRow?.platform_message_id) return deliveredRow.platform_message_id;

  // Fallback to internal ID (edits/reactions on undelivered messages won't work)
  return outRow.id;
}

/**
 * Look up the routing fields for a message by seq (for edit/reaction targeting).
 * Returns the channel_type, platform_id, thread_id of the referenced message.
 */
export function getRoutingBySeq(
  seq: number,
): { channel_type: string | null; platform_id: string | null; thread_id: string | null } | null {
  const inbound = getInboundDb();
  const inRow = inbound
    .prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE seq = ?')
    .get(seq) as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  if (inRow) return inRow;

  const outRow = getOutboundDb()
    .prepare('SELECT channel_type, platform_id, thread_id FROM messages_out WHERE seq = ?')
    .get(seq) as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  return outRow ?? null;
}

/** Get undelivered messages (for host polling — reads from outbound.db). */
export function getUndeliveredMessages(): MessageOutRow[] {
  return getOutboundDb()
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR deliver_after <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as MessageOutRow[];
}
