import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Availability,
  CreateWatchInput,
  MonitorRecord,
  NotifyProfile,
  ProviderId,
  Seat,
  SessionRecord,
  UpdateWatchInput,
  WatchRecord,
  WatchStatus,
} from "./types.ts";
import { isoNow } from "./time.ts";

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

      CREATE TABLE IF NOT EXISTS notify_profiles (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        ntfy_topic    TEXT,
        telegram_chat TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS watches (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        owner               TEXT NOT NULL,
        enabled             INTEGER NOT NULL DEFAULT 1,
        profile_id          TEXT NOT NULL,
        movie_title         TEXT NOT NULL,
        district_content_id TEXT,
        bms_event_code      TEXT,
        district_city_key   TEXT,
        bms_region          TEXT,
        bms_slug            TEXT,
        city_label          TEXT,
        date                TEXT NOT NULL,
        providers           TEXT NOT NULL,
        venue_include       TEXT NOT NULL,
        venue_exclude       TEXT NOT NULL,
        time_from           TEXT,
        time_to             TEXT,
        seat_rows           TEXT NOT NULL,
        seat_numbers        TEXT NOT NULL,
        min_seats           INTEGER NOT NULL DEFAULT 1,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        deleted_at          TEXT
      );

      CREATE TABLE IF NOT EXISTS watch_status (
        watch_id       TEXT PRIMARY KEY,
        availability   TEXT NOT NULL,
        session_count  INTEGER NOT NULL,
        matched_count  INTEGER NOT NULL,
        seats_free     INTEGER NOT NULL,
        watched_free   INTEGER NOT NULL,
        last_checked_at TEXT NOT NULL,
        detail         TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS monitors (
        id              TEXT PRIMARY KEY,
        provider        TEXT NOT NULL,
        movie_title     TEXT NOT NULL,
        movie_key       TEXT NOT NULL,
        city_key        TEXT NOT NULL,
        date            TEXT NOT NULL,
        availability    TEXT NOT NULL,
        session_count   INTEGER NOT NULL,
        last_checked_at TEXT NOT NULL,
        detail          TEXT NOT NULL,
        min_interval    INTEGER NOT NULL DEFAULT 60,
        UNIQUE (provider, movie_key, city_key, date)
      );

      CREATE TABLE IF NOT EXISTS watch_sessions (
        watch_id   TEXT NOT NULL,
        provider   TEXT NOT NULL,
        session_id TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        PRIMARY KEY (watch_id, provider, session_id)
      );
    `);
    try {
      this.db.exec("ALTER TABLE monitors ADD COLUMN min_interval INTEGER NOT NULL DEFAULT 60;");
    } catch {
      // column already exists
    }
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

  // ── watches ──────────────────────────────────────────────────────────────

  createWatch(input: CreateWatchInput): WatchRecord {
    const at = isoNow();
    const id = input.id ?? randomUUID();
    const record: WatchRecord = {
      id,
      name: input.name,
      owner: input.owner ?? "me",
      enabled: input.enabled !== false,
      profileId: input.profileId,
      movie: input.movie,
      city: input.city,
      date: input.date,
      providers: input.providers,
      venues: {
        include: input.venues?.include ?? [],
        exclude: input.venues?.exclude ?? [],
      },
      timeWindow: {
        from: input.timeWindow?.from,
        to: input.timeWindow?.to,
      },
      seats: {
        rows: input.seats?.rows ?? [],
        numbers: input.seats?.numbers ?? [],
        minSeats: input.seats?.minSeats ?? 1,
      },
      createdAt: at,
      updatedAt: at,
    };

    this.db
      .prepare(
        `INSERT INTO watches (
           id, name, owner, enabled, profile_id,
           movie_title, district_content_id, bms_event_code,
           district_city_key, bms_region, bms_slug, city_label,
           date, providers, venue_include, venue_exclude,
           time_from, time_to, seat_rows, seat_numbers, min_seats,
           created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        record.id,
        record.name,
        record.owner,
        record.enabled ? 1 : 0,
        record.profileId,
        record.movie.title,
        record.movie.districtContentId ?? null,
        record.movie.bmsEventCode ?? null,
        record.city.districtKey ?? null,
        record.city.bmsRegion ?? null,
        record.city.bmsSlug ?? null,
        record.city.label ?? null,
        record.date,
        JSON.stringify(record.providers),
        JSON.stringify(record.venues.include),
        JSON.stringify(record.venues.exclude),
        record.timeWindow.from ?? null,
        record.timeWindow.to ?? null,
        JSON.stringify(record.seats.rows),
        JSON.stringify(record.seats.numbers),
        record.seats.minSeats,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  getWatch(id: string, includeDeleted = false): WatchRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM watches WHERE id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}`,
      )
      .get(id) as unknown as WatchRow | undefined;
    return row ? toWatchRecord(row) : null;
  }

  listWatches(options: { includeDeleted?: boolean; enabledOnly?: boolean } = {}): WatchRecord[] {
    const where: string[] = [];
    if (!options.includeDeleted) where.push("deleted_at IS NULL");
    if (options.enabledOnly) where.push("enabled = 1");
    const sql =
      "SELECT * FROM watches" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY created_at";
    return (this.db.prepare(sql).all() as unknown as WatchRow[]).map(toWatchRecord);
  }

  countWatches(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM watches").get() as unknown as { n: number };
    return Number(row?.n ?? 0);
  }

  updateWatch(id: string, input: UpdateWatchInput): WatchRecord | null {
    const current = this.getWatch(id);
    if (!current) return null;

    const next: WatchRecord = {
      ...current,
      name: input.name ?? current.name,
      owner: input.owner ?? current.owner,
      enabled: input.enabled ?? current.enabled,
      profileId: input.profileId ?? current.profileId,
      venues: {
        include: input.venues?.include ?? current.venues.include,
        exclude: input.venues?.exclude ?? current.venues.exclude,
      },
      timeWindow: {
        from: input.timeWindow?.from ?? current.timeWindow.from,
        to: input.timeWindow?.to ?? current.timeWindow.to,
      },
      seats: {
        rows: input.seats?.rows ?? current.seats.rows,
        numbers: input.seats?.numbers ?? current.seats.numbers,
        minSeats: input.seats?.minSeats ?? current.seats.minSeats,
      },
      updatedAt: isoNow(),
    };

    this.db
      .prepare(
        `UPDATE watches SET
           name = ?, owner = ?, enabled = ?, profile_id = ?,
           venue_include = ?, venue_exclude = ?,
           time_from = ?, time_to = ?,
           seat_rows = ?, seat_numbers = ?, min_seats = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.owner,
        next.enabled ? 1 : 0,
        next.profileId,
        JSON.stringify(next.venues.include),
        JSON.stringify(next.venues.exclude),
        next.timeWindow.from ?? null,
        next.timeWindow.to ?? null,
        JSON.stringify(next.seats.rows),
        JSON.stringify(next.seats.numbers),
        next.seats.minSeats,
        next.updatedAt,
        id,
      );

    return next;
  }

  /** Soft delete by default; `hard` removes the row and its per-watch history. */
  deleteWatch(id: string, hard = false): boolean {
    if (hard) {
      const result = this.db.prepare("DELETE FROM watches WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM watch_sessions WHERE watch_id = ?").run(id);
      this.db.prepare("DELETE FROM watch_status WHERE watch_id = ?").run(id);
      return Number(result.changes) > 0;
    }
    const at = isoNow();
    const result = this.db
      .prepare("UPDATE watches SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(at, at, id);
    return Number(result.changes) > 0;
  }

  // ── notification profiles ────────────────────────────────────────────────

  saveProfile(profile: NotifyProfile): NotifyProfile {
    this.db
      .prepare(
        `INSERT INTO notify_profiles (id, name, ntfy_topic, telegram_chat, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           ntfy_topic = excluded.ntfy_topic,
           telegram_chat = excluded.telegram_chat`,
      )
      .run(profile.id, profile.name, profile.ntfyTopic ?? null, profile.telegramChat ?? null, isoNow());
    return profile;
  }

  getProfile(id: string): NotifyProfile | null {
    const row = this.db
      .prepare("SELECT id, name, ntfy_topic, telegram_chat FROM notify_profiles WHERE id = ?")
      .get(id) as unknown as ProfileRow | undefined;
    return row ? toProfile(row) : null;
  }

  listProfiles(): NotifyProfile[] {
    const rows = this.db
      .prepare("SELECT id, name, ntfy_topic, telegram_chat FROM notify_profiles ORDER BY name")
      .all() as unknown as ProfileRow[];
    return rows.map(toProfile);
  }

  deleteProfile(id: string): boolean {
    const inUse = this.db
      .prepare("SELECT COUNT(*) AS n FROM watches WHERE profile_id = ? AND deleted_at IS NULL")
      .get(id) as unknown as { n: number };
    if (Number(inUse?.n ?? 0) > 0) return false;
    const result = this.db.prepare("DELETE FROM notify_profiles WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  // ── monitors ─────────────────────────────────────────────────────────────

  saveMonitor(monitor: MonitorRecord): void {
    this.db
      .prepare(
        `INSERT INTO monitors
           (id, provider, movie_title, movie_key, city_key, date, availability, session_count, last_checked_at, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           movie_title     = excluded.movie_title,
           availability    = excluded.availability,
           session_count   = excluded.session_count,
           last_checked_at = excluded.last_checked_at,
           detail          = excluded.detail`,
      )
      .run(
        monitor.id,
        monitor.provider,
        monitor.movieTitle,
        monitor.movieKey,
        monitor.cityKey,
        monitor.date,
        monitor.availability,
        monitor.sessionCount,
        monitor.lastCheckedAt,
        monitor.detail,
      );
  }

  getMonitor(id: string): MonitorRecord | null {
    const row = this.db.prepare("SELECT * FROM monitors WHERE id = ?").get(id) as unknown as
      | MonitorRow
      | undefined;
    return row ? toMonitorRecord(row) : null;
  }

  listMonitors(): MonitorRecord[] {
    const rows = this.db.prepare("SELECT * FROM monitors ORDER BY provider, movie_title").all() as unknown as MonitorRow[];
    return rows.map(toMonitorRecord);
  }

  // ── per-watch show history ───────────────────────────────────────────────

  /**
   * Records the sessions a watch has been told about. Returns the ids that are
   * new to this watch, plus whether this was its very first observation (in
   * which case the caller should stay silent and just build a baseline).
   */
  recordWatchSessions(
    watchId: string,
    provider: ProviderId,
    sessionIds: string[],
    at: string,
  ): { firstObservation: boolean; added: string[] } {
    const knownRows = this.db
      .prepare("SELECT session_id FROM watch_sessions WHERE watch_id = ? AND provider = ?")
      .all(watchId, provider) as unknown as Array<{ session_id: string }>;
    const known = new Set(knownRows.map((r) => r.session_id));
    const added = sessionIds.filter((id) => !known.has(id));

    if (added.length > 0) {
      const stmt = this.db.prepare(
        "INSERT OR IGNORE INTO watch_sessions (watch_id, provider, session_id, first_seen) VALUES (?, ?, ?, ?)",
      );
      this.tx(() => {
        for (const id of added) stmt.run(watchId, provider, id, at);
      });
    }

    return { firstObservation: knownRows.length === 0, added };
  }

  saveWatchStatus(status: WatchStatus): void {
    this.db
      .prepare(
        `INSERT INTO watch_status
           (watch_id, availability, session_count, matched_count, seats_free, watched_free, last_checked_at, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(watch_id) DO UPDATE SET
           availability    = excluded.availability,
           session_count   = excluded.session_count,
           matched_count   = excluded.matched_count,
           seats_free      = excluded.seats_free,
           watched_free    = excluded.watched_free,
           last_checked_at = excluded.last_checked_at,
           detail          = excluded.detail`,
      )
      .run(
        status.watchId,
        status.availability,
        status.sessionCount,
        status.matchedCount,
        status.seatsFree,
        status.watchedFree,
        status.lastCheckedAt,
        status.detail,
      );
  }

  getWatchStatus(watchId: string): WatchStatus | null {
    const row = this.db.prepare("SELECT * FROM watch_status WHERE watch_id = ?").get(watchId) as unknown as
      | StatusRow
      | undefined;
    return row ? toStatus(row) : null;
  }

  listWatchStatuses(): WatchStatus[] {
    const rows = this.db.prepare("SELECT * FROM watch_status").all() as unknown as StatusRow[];
    return rows.map(toStatus);
  }

  listAlerts(limit = 50): Array<{ key: string; kind: string; sentAt: string; payload?: string }> {
    const rows = this.db
      .prepare("SELECT key, kind, sent_at, payload FROM alerts ORDER BY sent_at DESC LIMIT ?")
      .all(limit) as unknown as Array<{ key: string; kind: string; sent_at: string; payload: string | null }>;
    return rows.map((r) => ({ key: r.key, kind: r.kind, sentAt: r.sent_at, payload: r.payload ?? undefined }));
  }

  searchAlerts(query: string, limit = 50): Array<{ key: string; kind: string; sentAt: string; payload?: string }> {
    const q = `%${query}%`;
    const rows = this.db
      .prepare(
        "SELECT key, kind, sent_at, payload FROM alerts WHERE key LIKE ? OR kind LIKE ? OR payload LIKE ? ORDER BY sent_at DESC LIMIT ?",
      )
      .all(q, q, q, limit) as unknown as Array<{ key: string; kind: string; sent_at: string; payload: string | null }>;
    return rows.map((r) => ({ key: r.key, kind: r.kind, sentAt: r.sent_at, payload: r.payload ?? undefined }));
  }

  close(): void {
    this.db.close();
  }
}

interface WatchRow {
  id: string;
  name: string;
  owner: string;
  enabled: number;
  profile_id: string;
  movie_title: string;
  district_content_id: string | null;
  bms_event_code: string | null;
  district_city_key: string | null;
  bms_region: string | null;
  bms_slug: string | null;
  city_label: string | null;
  date: string;
  providers: string;
  venue_include: string;
  venue_exclude: string;
  time_from: string | null;
  time_to: string | null;
  seat_rows: string;
  seat_numbers: string;
  min_seats: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface ProfileRow {
  id: string;
  name: string;
  ntfy_topic: string | null;
  telegram_chat: string | null;
}

interface MonitorRow {
  id: string;
  provider: ProviderId;
  movie_title: string;
  movie_key: string;
  city_key: string;
  date: string;
  availability: Availability;
  session_count: number;
  last_checked_at: string;
  detail: string;
}

interface StatusRow {
  watch_id: string;
  availability: string;
  session_count: number;
  matched_count: number;
  seats_free: number;
  watched_free: number;
  last_checked_at: string;
  detail: string;
}

function toWatchRecord(row: WatchRow): WatchRecord {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    enabled: row.enabled === 1,
    profileId: row.profile_id,
    movie: {
      title: row.movie_title,
      districtContentId: row.district_content_id ?? undefined,
      bmsEventCode: row.bms_event_code ?? undefined,
    },
    city: {
      districtKey: row.district_city_key ?? undefined,
      bmsRegion: row.bms_region ?? undefined,
      bmsSlug: row.bms_slug ?? undefined,
      label: row.city_label ?? undefined,
    },
    date: row.date,
    providers: safeJsonArray(row.providers) as ProviderId[],
    venues: {
      include: safeJsonArray(row.venue_include),
      exclude: safeJsonArray(row.venue_exclude),
    },
    timeWindow: {
      from: row.time_from ?? undefined,
      to: row.time_to ?? undefined,
    },
    seats: {
      rows: safeJsonArray(row.seat_rows),
      numbers: safeJsonArray(row.seat_numbers),
      minSeats: Number(row.min_seats) || 1,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function toProfile(row: ProfileRow): NotifyProfile {
  return {
    id: row.id,
    name: row.name,
    ntfyTopic: row.ntfy_topic ?? undefined,
    telegramChat: row.telegram_chat ?? undefined,
  };
}

function toMonitorRecord(row: MonitorRow): MonitorRecord {
  return {
    id: row.id,
    provider: row.provider,
    movieTitle: row.movie_title,
    movieKey: row.movie_key,
    cityKey: row.city_key,
    date: row.date,
    availability: row.availability,
    sessionCount: Number(row.session_count),
    lastCheckedAt: row.last_checked_at,
    detail: row.detail,
  };
}

function toStatus(row: StatusRow): WatchStatus {
  return {
    watchId: row.watch_id,
    availability: row.availability as Availability,
    sessionCount: Number(row.session_count),
    matchedCount: Number(row.matched_count),
    seatsFree: Number(row.seats_free),
    watchedFree: Number(row.watched_free),
    lastCheckedAt: row.last_checked_at,
    detail: row.detail,
  };
}

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
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
