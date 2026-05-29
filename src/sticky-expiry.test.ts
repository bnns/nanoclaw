/**
 * Unit tests for mention-sticky lazy expiry.
 *
 * Builds real SQLite session DBs in a tmpdir matching the on-disk layout
 * (DATA_DIR/v2-sessions/<agentGroupId>/<sessionId>/{inbound,outbound}.db)
 * and exercises isStickyStillActive against them. No mocks of the helper
 * itself — we only mock DATA_DIR via config.js so session-manager's path
 * helpers resolve into the tmpdir.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return { TEST_DIR: nodePath.join(nodeOs.tmpdir(), 'nanoclaw-sticky-test') };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { isStickyStillActive, parseSessionTimestamp, STICKY_TTL_MS, STICKY_TTL_MESSAGES } from './sticky-expiry.js';

const AGENT = 'ag-test';
const SESSION = 'sess-test';
const SESSION_DIR = path.join(TEST_DIR, 'v2-sessions', AGENT, SESSION);

function isoZ(ms: number): string {
  return new Date(ms).toISOString();
}

function sqliteRendered(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function setupDbs(): { inDb: Database.Database; outDb: Database.Database } {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const inDb = new Database(path.join(SESSION_DIR, 'inbound.db'));
  const outDb = new Database(path.join(SESSION_DIR, 'outbound.db'));
  inDb.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY,
      seq INTEGER UNIQUE,
      timestamp TEXT NOT NULL
    );
  `);
  outDb.exec(`
    CREATE TABLE messages_out (
      id TEXT PRIMARY KEY,
      seq INTEGER UNIQUE,
      timestamp TEXT NOT NULL
    );
  `);
  return { inDb, outDb };
}

function insertInbound(db: Database.Database, seq: number, ms: number): void {
  db.prepare('INSERT INTO messages_in (id, seq, timestamp) VALUES (?, ?, ?)').run(`in-${seq}`, seq, isoZ(ms));
}

function insertOutbound(db: Database.Database, seq: number, ms: number): void {
  // outbound is stored by SDK with SQLite default rendering (no T, no Z)
  db.prepare('INSERT INTO messages_out (id, seq, timestamp) VALUES (?, ?, ?)').run(`out-${seq}`, seq, sqliteRendered(ms));
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('parseSessionTimestamp', () => {
  it('parses ISO-with-ms-and-Z (inbound format) as UTC', () => {
    expect(parseSessionTimestamp('2026-05-23T16:40:55.580Z')).toBe(Date.UTC(2026, 4, 23, 16, 40, 55, 580));
  });
  it('parses SQLite-rendered space-separated (outbound format) as UTC, not local', () => {
    expect(parseSessionTimestamp('2026-05-23 16:40:59')).toBe(Date.UTC(2026, 4, 23, 16, 40, 59));
  });
});

describe('isStickyStillActive', () => {
  it('returns false when no outbound DB exists', () => {
    expect(isStickyStillActive(AGENT, SESSION)).toBe(false);
  });

  it('returns false when outbound DB has never had a reply', () => {
    const { inDb, outDb } = setupDbs();
    insertInbound(inDb, 1, Date.now());
    inDb.close();
    outDb.close();
    expect(isStickyStillActive(AGENT, SESSION)).toBe(false);
  });

  it('returns true when last reply is recent and few inbound since', () => {
    const now = Date.parse('2026-05-23T17:00:00Z');
    const { inDb, outDb } = setupDbs();
    insertInbound(inDb, 1, now - 60_000);
    insertOutbound(outDb, 2, now - 50_000);
    insertInbound(inDb, 3, now - 30_000);
    inDb.close();
    outDb.close();
    expect(isStickyStillActive(AGENT, SESSION, now)).toBe(true);
  });

  it('returns false when last reply is older than STICKY_TTL_MS', () => {
    const now = Date.parse('2026-05-23T17:00:00Z');
    const { inDb, outDb } = setupDbs();
    insertOutbound(outDb, 1, now - STICKY_TTL_MS - 1);
    insertInbound(inDb, 2, now - 60_000);
    inDb.close();
    outDb.close();
    expect(isStickyStillActive(AGENT, SESSION, now)).toBe(false);
  });

  it('returns false when STICKY_TTL_MESSAGES inbound messages have arrived since last reply', () => {
    const now = Date.parse('2026-05-23T17:00:00Z');
    const { inDb, outDb } = setupDbs();
    insertOutbound(outDb, 1, now - 10 * 60_000);
    for (let i = 0; i < STICKY_TTL_MESSAGES; i++) {
      insertInbound(inDb, i + 2, now - (STICKY_TTL_MESSAGES - i) * 60_000);
    }
    inDb.close();
    outDb.close();
    expect(isStickyStillActive(AGENT, SESSION, now)).toBe(false);
  });

  it('returns true when fewer than STICKY_TTL_MESSAGES inbound since last reply', () => {
    const now = Date.parse('2026-05-23T17:00:00Z');
    const { inDb, outDb } = setupDbs();
    insertOutbound(outDb, 1, now - 10 * 60_000);
    insertInbound(inDb, 2, now - 5 * 60_000);
    insertInbound(inDb, 3, now - 2 * 60_000);
    inDb.close();
    outDb.close();
    expect(isStickyStillActive(AGENT, SESSION, now)).toBe(true);
  });
});
