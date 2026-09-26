import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';
import { capNotice, checkBudget, DEFAULT_MONTHLY_CAP_USD, monthSpend, recordUsage, SYSTEM_USER } from './budget.js';
import { ratesFor } from './pricing.js';

const TEST_DIR = '/tmp/nanoclaw-budget-test';
const session = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;
const ALICE = 'discord:111';
const BOB = 'discord:222';
const OWNER = 'discord:999';

let inDb: ReturnType<typeof openInboundDb>;
let seq = 0;

function addInbound(id: string, rawAuthor: string, trigger: 0 | 1): void {
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, trigger, channel_type, platform_id, content)
       VALUES (?, ?, 'chat-sdk', datetime('now'), ?, 'discord', 'chan', ?)`,
    )
    .run(id, ++seq * 2, trigger, JSON.stringify({ text: 'hi', author: { userId: rawAuthor } }));
}

// 1M output tokens on Opus 5.5 = $20.
const oneMillionOut = {
  'claude-opus-5-5': { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
};

beforeEach(() => {
  runMigrations(initTestDb());
  getDb()
    .prepare("INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'discord', 'owner', datetime('now'))")
    .run(OWNER);
  getDb().prepare("INSERT INTO user_roles (user_id, role, granted_at) VALUES (?, 'owner', datetime('now'))").run(OWNER);
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(path.join(TEST_DIR, 'inbound.db'), 'inbound');
  inDb = openInboundDb(path.join(TEST_DIR, 'inbound.db'));
});

afterEach(() => {
  inDb.close();
  closeDb();
});

describe('pricing', () => {
  it('resolves dated ids to their family and prefers the longest prefix', () => {
    expect(ratesFor('claude-haiku-4-5-20251001')?.input).toBe(1);
    expect(ratesFor('claude-opus-5-5')?.input).toBe(4);
    expect(ratesFor('claude-opus-5')?.input).toBe(5);
    expect(ratesFor('claude-fable-5-1')?.cacheRead).toBe(0.25);
    expect(ratesFor('gpt-4')).toBeNull();
  });
});

describe('recordUsage', () => {
  it('prices cache writes by TTL', async () => {
    addInbound('m1', '111', 1);
    await recordUsage(
      {
        messageIds: ['m1'],
        usage: {
          'claude-opus-5-5': {
            input: 0,
            output: 0,
            cacheRead: 1_000_000,
            cacheWrite5m: 1_000_000,
            cacheWrite1h: 1_000_000,
          },
        },
      },
      session,
      inDb,
    );
    // 0.20 + 5.00 + 8.00
    expect(monthSpend(ALICE)).toBeCloseTo(13.2, 6);
  });

  it('splits a turn evenly among triggerers and ignores context-only senders', async () => {
    addInbound('m1', '111', 1);
    addInbound('m2', '222', 1);
    addInbound('m3', '333', 0); // accumulated context, no @mention
    await recordUsage({ messageIds: ['m1', 'm2', 'm3'], usage: oneMillionOut }, session, inDb);
    expect(monthSpend(ALICE)).toBeCloseTo(10, 6);
    expect(monthSpend(BOB)).toBeCloseTo(10, 6);
    expect(monthSpend('discord:333')).toBe(0);
  });

  it('charges turns with no human triggerer to system', async () => {
    await recordUsage({ messageIds: ['missing'], usage: oneMillionOut }, session, inDb);
    expect(monthSpend(SYSTEM_USER)).toBeCloseTo(20, 6);
  });

  it('charges unknown models at the fallback (most expensive) rates', async () => {
    addInbound('m1', '111', 1);
    await recordUsage(
      {
        messageIds: ['m1'],
        usage: { 'claude-new-9': { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } },
      },
      session,
      inDb,
    );
    expect(monthSpend(ALICE)).toBeCloseTo(50, 6);
  });
});

describe('checkBudget', () => {
  it('allows users under the default cap', async () => {
    addInbound('m1', '111', 1);
    await recordUsage(
      { messageIds: ['m1'], usage: { 'claude-opus-5-5': { ...oneMillionOut['claude-opus-5-5'], output: 500_000 } } },
      session,
      inDb,
    );
    expect(checkBudget(ALICE)).toMatchObject({ allowed: true, cap: DEFAULT_MONTHLY_CAP_USD });
  });

  it('blocks at the cap and sends the notice once per day', async () => {
    addInbound('m1', '111', 1);
    await recordUsage({ messageIds: ['m1'], usage: oneMillionOut }, session, inDb);
    const day1 = new Date();
    expect(checkBudget(ALICE, day1)).toMatchObject({ allowed: false, sendNotice: true });
    expect(checkBudget(ALICE, day1)).toMatchObject({ allowed: false, sendNotice: false });
    const day2 = new Date(day1.getTime() + 86_400_000);
    if (day2.getUTCMonth() === day1.getUTCMonth()) {
      expect(checkBudget(ALICE, day2)).toMatchObject({ allowed: false, sendNotice: true });
    }
  });

  it('resets at the start of the next UTC month', async () => {
    getDb()
      .prepare(
        `INSERT INTO usage_events (ts, user_id, agent_group_id, session_id, model, share, input_tokens, output_tokens,
           cache_read, cache_write_5m, cache_write_1h, cost_usd) VALUES ('2026-08-31T23:59:59.000Z', ?, 'ag-1', 's', 'm', 1, 0, 0, 0, 0, 0, 100)`,
      )
      .run(ALICE);
    expect(checkBudget(ALICE, new Date('2026-08-31T23:59:59.500Z')).allowed).toBe(false);
    expect(checkBudget(ALICE, new Date('2026-09-01T00:00:00.000Z')).allowed).toBe(true);
  });

  it('never caps owners, and honours per-user overrides', async () => {
    addInbound('m1', '999', 1);
    addInbound('m2', '111', 1);
    await recordUsage(
      { messageIds: ['m1'], usage: { 'claude-opus-5-5': { ...oneMillionOut['claude-opus-5-5'], output: 10_000_000 } } },
      session,
      inDb,
    );
    await recordUsage({ messageIds: ['m2'], usage: oneMillionOut }, session, inDb);
    expect(checkBudget(OWNER)).toMatchObject({ allowed: true, cap: null });

    getDb().prepare('INSERT INTO user_budgets (user_id, monthly_cap_usd) VALUES (?, 50)').run(ALICE);
    expect(checkBudget(ALICE)).toMatchObject({ allowed: true, cap: 50 });
    getDb().prepare('UPDATE user_budgets SET monthly_cap_usd = NULL WHERE user_id = ?').run(ALICE);
    expect(checkBudget(ALICE)).toMatchObject({ allowed: true, cap: null });
  });

  it('exposes monthly spend through the view', async () => {
    addInbound('m1', '111', 1);
    await recordUsage({ messageIds: ['m1'], usage: oneMillionOut }, session, inDb);
    const rows = getDb().prepare('SELECT user_id, cost_usd, turns FROM user_monthly_spend').all();
    expect(rows).toEqual([{ user_id: ALICE, cost_usd: 20, turns: 1 }]);
  });
});

describe('capNotice', () => {
  it('names the cap and the reset date', () => {
    expect(capNotice(20, new Date('2026-09-26T12:00:00Z'))).toContain('$20');
    expect(capNotice(20, new Date('2026-12-26T12:00:00Z'))).toContain('1 January');
  });
});
