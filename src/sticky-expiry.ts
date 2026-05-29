/**
 * Lazy expiry for mention-sticky engagement.
 *
 * Background: in mention-sticky mode the router engages on any message in
 * a thread where a session already exists, because the original @-mention
 * "subscribed" the thread. Without an expiry, that subscription is
 * permanent: months later, two other users continuing to chat in that
 * thread still wake the agent every message.
 *
 * This helper adds a soft expiry checked at engage time: the sticky is
 * considered still active only if the agent has replied recently in this
 * session. Stale subscriptions naturally fall through and require a fresh
 * @-mention to revive. The session itself stays put — accumulated context
 * still feeds memory.
 */
import Database from 'better-sqlite3';
import { inboundDbPath, outboundDbPath } from './session-manager.js';

/** Sticky expires this long after the agent's last reply. */
export const STICKY_TTL_MS = 30 * 60 * 1000;

/** Sticky expires after this many unreplied inbound messages since the last reply. */
export const STICKY_TTL_MESSAGES = 3;

/**
 * Parse a session-DB timestamp to ms-since-epoch. messages_in uses ISO
 * format with milliseconds and Z ("2026-05-23T16:40:55.580Z"); messages_out
 * uses the SQLite default rendering of a stored ISO value, which drops the
 * T separator and the trailing Z ("2026-05-23 16:40:59"). Both represent
 * UTC; normalize before handing to Date.parse so the SQLite-rendered form
 * isn't misread as local time.
 */
export function parseSessionTimestamp(ts: string): number {
  const normalized = ts.includes('T') && ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z';
  return Date.parse(normalized);
}

/**
 * Returns true if a mention-sticky session should still engage automatically.
 *
 * Expires if either:
 *   - the agent has never replied in this session, or
 *   - more than STICKY_TTL_MS has passed since the last reply, or
 *   - STICKY_TTL_MESSAGES inbound messages have arrived since the last reply
 *     without a reply going out.
 *
 * Missing DB files are treated as "expired" (returns false) — there is no
 * reply history to anchor stickiness to.
 */
export function isStickyStillActive(agentGroupId: string, sessionId: string, now: number = Date.now()): boolean {
  const inPath = inboundDbPath(agentGroupId, sessionId);
  const outPath = outboundDbPath(agentGroupId, sessionId);

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = new Database(outPath, { readonly: true, fileMustExist: true });
  } catch {
    return false;
  }
  try {
    inDb = new Database(inPath, { readonly: true, fileMustExist: true });
  } catch {
    outDb.close();
    return false;
  }

  try {
    const lastReply = outDb
      .prepare('SELECT timestamp FROM messages_out ORDER BY seq DESC LIMIT 1')
      .get() as { timestamp: string } | undefined;
    if (!lastReply) return false;

    const lastReplyMs = parseSessionTimestamp(lastReply.timestamp);
    if (now - lastReplyMs >= STICKY_TTL_MS) return false;

    const recent = inDb
      .prepare('SELECT timestamp FROM messages_in ORDER BY seq DESC LIMIT ?')
      .all(STICKY_TTL_MESSAGES) as { timestamp: string }[];
    if (recent.length < STICKY_TTL_MESSAGES) return true;

    const oldestOfRecentMs = parseSessionTimestamp(recent[recent.length - 1].timestamp);
    if (oldestOfRecentMs > lastReplyMs) return false;

    return true;
  } finally {
    inDb.close();
    outDb.close();
  }
}
