import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Seat, SessionRecord, ProviderId, Availability } from "./types.ts";

interface SessionRow {
  target_id: string;
  provider: ProviderId;
  venue_code: string;
  session_id: string;
  venue_name: string;
  date: string;
  start_ist: string;
  format: string;
  extra: string;
  url: string;
  first_seen: string;
  last_seen: string;
}

interface SeatRow {
  seat_key: string;
  area: string;
  row: string;
  number: string;
  status: string;
}

export interface StoredSession extends SessionRecord {
  firstSeen: string;
  lastSeen: string;
}

export interface SnapshotResult {
  /** True when this is the first time we have seen this seat map. */
  baseline: boolean;
  /** Seats that moved booked -> available since the previous snapshot. */
  freed: Seat[];
  available: number;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        target_id   TEXT NOT NULL,
        provider    TEXT NOT NULL,
        venue_code  TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        venue_name  TEXT NOT NULL,
        date        TEXT NOT NULL,
        start_ist   TEXT NOT NULL,
        format      TEXT NOT NULL,
        extra       TEXT NOT NULL,
        url         TEXT NOT NULL,
        first_seen  TEXT NOT NULL,
        last_seen   TEXT NOT NULL,
        PRIMARY KEY (target_id, provider, venue_code, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_lookup
        ON sessions (target_id, provider, date);

      CREATE TABLE IF NOT EXISTS seats (
        target_id  TEXT NOT NULL,
        provider   TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seat_key   TEXT NOT NULL,
        area       TEXT NOT NULL,
        row        TEXT NOT NULL,
        number     TEXT NOT NULL,
        status     TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (target_id, provider, session_id, seat_key)
      );

      CREATE TABLE IF NOT EXISTS alerts (
        key     TEXT PRIMARY KEY,
        kind    TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        payload TEXT
      );

      CREATE TABLE IF NOT EXISTS poll_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id    TEXT NOT NULL,
        provider     TEXT NOT NULL,
        availability TEXT NOT NULL,
        detail       TEXT,
        duration_ms  INTEGER NOT NULL,
        at           TEXT NOT NULL
      );
    `);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const value = fn();
      this.db.exec("COMMIT;");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  getProviderState(targetId: string, provider: ProviderId): Availability | null {
    const value = this.getMeta(`state:${targetId}:${provider}`);
    return value === "OPEN" || value === "NOT_OPEN" || value === "UNKNOWN" ? value : null;
  }

  setProviderState(targetId: string, provider: ProviderId, state: Availability): void {
    this.setMeta(`state:${targetId}:${provider}`, state);
  }

  /** Insert/refresh sessions. Returns the ones we had never seen before. */
  upsertSessions(
    targetId: string,
    provider: ProviderId,
    sessions: SessionRecord[],
    at: string,
  ): { added: SessionRecord[]; known: number } {
    const existing = this.db
      .prepare("SELECT session_id FROM sessions WHERE target_id = ? AND provider = ?")
      .all(targetId, provider) as Array<{ session_id: string }>;
    const knownIds = new Set(existing.map((r) => r.session_id));
    const added = sessions.filter((s) => !knownIds.has(s.sessionId));

    if (sessions.length > 0) {
      const stmt = this.db.prepare(`
        INSERT INTO sessions
          (target_id, provider, venue_code, session_id, venue_name, date, start_ist, format, extra, url, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(target_id, provider, venue_code, session_id) DO UPDATE SET
          venue_name = excluded.venue_name,
          date       = excluded.date,
          start_ist  = excluded.start_ist,
          format     = excluded.format,
          extra      = excluded.extra,
          url        = excluded.url,
          last_seen  = excluded.last_seen
      `);
      this.tx(() => {
        for (const s of sessions) {
          stmt.run(
            targetId,
            provider,
            s.venueCode,
            s.sessionId,
            s.venueName,
            s.date,
            s.startIst,
            s.format,
            JSON.stringify(s.extra),
            s.url,
            at,
            at,
          );
        }
      });
    }

    return { added, known: knownIds.size };
  }

  listSessions(targetId: string, provider?: ProviderId): StoredSession[] {
    const rows = (
      provider
        ? this.db
            .prepare(
              "SELECT * FROM sessions WHERE target_id = ? AND provider = ? ORDER BY date, start_ist",
            )
            .all(targetId, provider)
        : this.db
            .prepare("SELECT * FROM sessions WHERE target_id = ? ORDER BY date, start_ist")
            .all(targetId)
    ) as unknown as SessionRow[];

    return rows.map((r) => ({
      provider: r.provider,
      venueCode: r.venue_code,
      venueName: r.venue_name,
      sessionId: r.session_id,
      date: r.date,
      startIst: r.start_ist,
      format: r.format,
      extra: safeJson(r.extra),
      url: r.url,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    }));
  }

  applySeatSnapshot(
    targetId: string,
    provider: ProviderId,
    sessionId: string,
    seats: Seat[],
    at: string,
  ): SnapshotResult {
    const previous = this.db
      .prepare(
        "SELECT seat_key, area, row, number, status FROM seats WHERE target_id = ? AND provider = ? AND session_id = ?",
      )
      .all(targetId, provider, sessionId) as unknown as SeatRow[];

    const baseline = previous.length === 0;
    const prevStatus = new Map(previous.map((r) => [r.seat_key, r.status]));

    const freed: Seat[] = [];
    if (!baseline) {
      for (const seat of seats) {
        if (seat.status === "available" && prevStatus.get(seat.key) === "booked") {
          freed.push(seat);
        }
      }
    }

    const upsert = this.db.prepare(`
      INSERT INTO seats (target_id, provider, session_id, seat_key, area, row, number, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_id, provider, session_id, seat_key) DO UPDATE SET
        area       = excluded.area,
        row        = excluded.row,
        number     = excluded.number,
        status     = excluded.status,
        updated_at = excluded.updated_at
    `);

    const seen = new Set(seats.map((s) => s.key));

    this.tx(() => {
      for (const seat of seats) {
        upsert.run(
          targetId,
          provider,
          sessionId,
          seat.key,
          seat.area,
          seat.row,
          seat.number,
          seat.status,
          at,
        );
      }

      const stale = previous.filter((r) => !seen.has(r.seat_key));
      if (stale.length > 0) {
        const del = this.db.prepare(
          "DELETE FROM seats WHERE target_id = ? AND provider = ? AND session_id = ? AND seat_key = ?",
        );
        for (const row of stale) del.run(targetId, provider, sessionId, row.seat_key);
      }
    });

    return {
      baseline,
      freed,
      available: seats.filter((s) => s.status === "available").length,
    };
  }

  /** Returns true when the alert key is new (i.e. we should send it). */
  claimAlert(key: string, kind: string, payload: string, at: string): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO alerts (key, kind, sent_at, payload) VALUES (?, ?, ?, ?)")
      .run(key, kind, at, payload);
    return Number(result.changes) > 0;
  }

  releaseAlert(key: string): void {
    this.db.prepare("DELETE FROM alerts WHERE key = ?").run(key);
  }

  logPoll(
    targetId: string,
    provider: ProviderId,
    availability: Availability,
    detail: string,
    durationMs: number,
    at: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO poll_log (target_id, provider, availability, detail, duration_ms, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(targetId, provider, availability, detail, Math.round(durationMs), at);
  }

  close(): void {
    this.db.close();
  }
}

function safeJson(raw: string): Record<string, string | number | boolean> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
