import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Per-user spend tracking and monthly caps (src/modules/budget/).
 *
 * usage_events: one row per (turn, model, user). A turn's cost is split
 *   evenly across the users whose @mentions it answered; `share` records the
 *   fraction and `cost_usd` is already scaled by it. Turns with no human
 *   triggerer (scheduled tasks, host-generated messages) are recorded with
 *   user_id 'system'.
 * user_budgets: per-user cap overrides. A NULL cap means uncapped. Users
 *   without a row get the default cap; owners are always uncapped.
 * budget_notices: last UTC day each over-cap user was sent the cap notice,
 *   so they get it at most once a day.
 */
export const migration016: Migration = {
  version: 16,
  name: 'usage-budget',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE usage_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        agent_group_id  TEXT NOT NULL,
        session_id      TEXT NOT NULL,
        model           TEXT NOT NULL,
        share           REAL NOT NULL,
        input_tokens    INTEGER NOT NULL,
        output_tokens   INTEGER NOT NULL,
        cache_read      INTEGER NOT NULL,
        cache_write_5m  INTEGER NOT NULL,
        cache_write_1h  INTEGER NOT NULL,
        cost_usd        REAL NOT NULL
      );
      CREATE INDEX idx_usage_events_user_ts ON usage_events(user_id, ts);

      CREATE TABLE user_budgets (
        user_id          TEXT PRIMARY KEY,
        monthly_cap_usd  REAL,
        note             TEXT
      );

      CREATE TABLE budget_notices (
        user_id          TEXT PRIMARY KEY,
        last_notice_day  TEXT NOT NULL
      );

      CREATE VIEW user_monthly_spend AS
        SELECT user_id || '@' || substr(ts, 1, 7) AS id,
               user_id,
               substr(ts, 1, 7) AS month,
               COALESCE((SELECT display_name FROM users u WHERE u.id = e.user_id), user_id) AS display_name,
               ROUND(SUM(cost_usd), 4) AS cost_usd,
               COUNT(DISTINCT ts || session_id) AS turns
        FROM usage_events e
        GROUP BY user_id, substr(ts, 1, 7);
    `);
  },
};
