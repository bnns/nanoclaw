/**
 * Per-user spend tracking and monthly caps.
 *
 * The container reports each turn's per-model token usage as a
 * `record_usage` system action (see container/agent-runner/src/poll-loop.ts
 * reportUsage). recordUsage() prices it and splits it across the users whose
 * @mentions the turn answered. checkBudget() runs in the router before a
 * container is woken, so an over-cap user costs nothing further.
 *
 * The check is pre-turn: a user just under the cap can still run one more
 * turn, so actual spend can end slightly above the cap.
 */
import type Database from 'better-sqlite3';

import { getDb, hasTable } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { FALLBACK_RATES, ratesFor, type Rates } from './pricing.js';

export const DEFAULT_MONTHLY_CAP_USD = 20;

/** user_id for turns no human triggered (scheduled tasks, host messages). */
export const SYSTEM_USER = 'system';

interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

function tokenCost(t: ModelTokens, r: Rates): number {
  return (
    (t.input * r.input +
      t.output * r.output +
      t.cacheRead * r.cacheRead +
      t.cacheWrite5m * r.cacheWrite5m +
      t.cacheWrite1h * r.cacheWrite1h) /
    1_000_000
  );
}

// Same resolution as the container's extractSenderId (formatter.ts), so ids
// match the router's userId ("discord:<snowflake>").
function senderOf(channelType: string | null, content: string): string | null {
  let parsed: { senderId?: string; author?: { userId?: string } };
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const raw = parsed?.senderId || parsed?.author?.userId || null;
  if (!raw) return null;
  if (raw.includes(':') || !channelType) return raw;
  return `${channelType}:${raw}`;
}

/** The distinct users whose triggering (wake) messages a turn answered. */
function triggerersOf(inDb: Database.Database, messageIds: string[]): string[] {
  const users = new Set<string>();
  const stmt = inDb.prepare('SELECT channel_type, content, trigger FROM messages_in WHERE id = ?');
  for (const id of messageIds) {
    const row = stmt.get(id) as { channel_type: string | null; content: string; trigger: number } | undefined;
    if (!row || row.trigger !== 1) continue;
    const user = senderOf(row.channel_type, row.content);
    if (user) users.add(user);
  }
  return [...users];
}

/** Delivery action handler for `record_usage`. */
export async function recordUsage(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const usage = content.usage as Record<string, ModelTokens> | undefined;
  const messageIds = Array.isArray(content.messageIds) ? (content.messageIds as string[]) : [];
  if (!usage || typeof usage !== 'object') return;

  const triggerers = triggerersOf(inDb, messageIds);
  const users = triggerers.length > 0 ? triggerers : [SYSTEM_USER];
  const share = 1 / users.length;
  const ts = new Date().toISOString();

  const insert = getDb().prepare(
    `INSERT INTO usage_events (ts, user_id, agent_group_id, session_id, model, share,
       input_tokens, output_tokens, cache_read, cache_write_5m, cache_write_1h, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  getDb().transaction(() => {
    for (const [model, raw] of Object.entries(usage)) {
      const t: ModelTokens = {
        input: n(raw?.input),
        output: n(raw?.output),
        cacheRead: n(raw?.cacheRead),
        cacheWrite5m: n(raw?.cacheWrite5m),
        cacheWrite1h: n(raw?.cacheWrite1h),
      };
      let rates = ratesFor(model);
      if (!rates) {
        log.warn('No price for model — charging fallback rates; add it to modules/budget/pricing.ts', { model });
        rates = FALLBACK_RATES;
      }
      const cost = tokenCost(t, rates) * share;
      for (const user of users) {
        insert.run(
          ts,
          user,
          session.agent_group_id,
          session.id,
          model,
          share,
          t.input,
          t.output,
          t.cacheRead,
          t.cacheWrite5m,
          t.cacheWrite1h,
          cost,
        );
      }
    }
  })();

  log.info('Usage recorded', { sessionId: session.id, users, models: Object.keys(usage) });
}

function isOwner(userId: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'owner'").get(userId);
}

/** The user's monthly cap in USD, or null when uncapped. */
export function capFor(userId: string): number | null {
  if (isOwner(userId)) return null;
  const row = getDb().prepare('SELECT monthly_cap_usd FROM user_budgets WHERE user_id = ?').get(userId) as
    | { monthly_cap_usd: number | null }
    | undefined;
  return row ? row.monthly_cap_usd : DEFAULT_MONTHLY_CAP_USD;
}

/** Spend in the current UTC calendar month. */
export function monthSpend(userId: string, now = new Date()): number {
  const month = now.toISOString().slice(0, 7);
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_events WHERE user_id = ? AND ts >= ?')
    .get(userId, `${month}-01`) as { total: number };
  return row.total;
}

export interface BudgetDecision {
  allowed: boolean;
  spent: number;
  cap: number | null;
  /** First over-cap attempt today — send the notice. Later ones get a reaction only. */
  sendNotice: boolean;
}

/**
 * Pre-wake check. Fails open: if the budget tables are missing or the query
 * throws, the message goes through (and the error is logged) — a bug here
 * must not take the agent down.
 */
export function checkBudget(userId: string, now = new Date()): BudgetDecision {
  try {
    if (!hasTable(getDb(), 'usage_events')) return { allowed: true, spent: 0, cap: null, sendNotice: false };
    const cap = capFor(userId);
    const spent = monthSpend(userId, now);
    if (cap === null || spent < cap) return { allowed: true, spent, cap, sendNotice: false };

    const today = now.toISOString().slice(0, 10);
    const row = getDb().prepare('SELECT last_notice_day FROM budget_notices WHERE user_id = ?').get(userId) as
      | { last_notice_day: string }
      | undefined;
    const sendNotice = row?.last_notice_day !== today;
    if (sendNotice) {
      getDb()
        .prepare(
          `INSERT INTO budget_notices (user_id, last_notice_day) VALUES (?, ?)
           ON CONFLICT(user_id) DO UPDATE SET last_notice_day = excluded.last_notice_day`,
        )
        .run(userId, today);
    }
    return { allowed: false, spent, cap, sendNotice };
  } catch (err) {
    log.error('Budget check failed — allowing message', { userId, err });
    return { allowed: true, spent: 0, cap: null, sendNotice: false };
  }
}

/** In-voice notice for a user who has reached their monthly cap. */
export function capNotice(cap: number, now = new Date()): string {
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const resetDay = reset.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  return (
    `Comrade, you have used up your share of my thinking-power for this month ` +
    `(each member of the collective gets $${cap.toFixed(0)} worth). ` +
    `It renews on ${resetDay}. Until then I must save my strength for the others — ` +
    `if this is urgent, ask one of the stewards to raise your share.`
  );
}
