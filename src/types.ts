export type ProviderId = "district" | "bms";

/**
 * Three-valued availability. We never collapse "we could not tell" into
 * "closed" — a failed request must not look like a quiet market.
 */
export type Availability = "OPEN" | "NOT_OPEN" | "UNKNOWN";

export type SeatStatus = "available" | "booked";

export interface Seat {
  /** Stable, human-readable key such as `H12`. */
  key: string;
  area: string;
  row: string;
  number: string;
  status: SeatStatus;
}

export interface SessionRecord {
  provider: ProviderId;
  /** Provider's venue identifier: District cinema id, BMS venue code. */
  venueCode: string;
  venueName: string;
  sessionId: string;
  /** Show date in IST, `YYYY-MM-DD`. */
  date: string;
  /** Start time in IST, `HH:mm` (24h). */
  startIst: string;
  format: string;
  /** Provider-specific fields needed later to fetch the seat map. */
  extra: Record<string, string | number | boolean>;
  url: string;
}

export interface SessionListResult {
  availability: Availability;
  sessions: SessionRecord[];
  detail: string;
  /** Date the provider actually answered for, when it echoes one. */
  observedDate?: string;
}

export interface SeatMapResult {
  ok: boolean;
  seats: Seat[];
  available: number;
  detail: string;
}

export interface Provider {
  readonly id: ProviderId;
  listSessions(target: WatchTarget): Promise<SessionListResult>;
  getSeatMap(session: SessionRecord): Promise<SeatMapResult>;
}

export interface SeatSpec {
  /** Rows to watch. Any free seat in these rows triggers an alert. */
  rows?: string[];
  /** Exact seats to watch, e.g. `["H12", "H13"]`. */
  seats?: string[];
}

export interface WatchTarget {
  id: string;
  label: string;
  enabled?: boolean;
  /** Show date in IST, `YYYY-MM-DD`. */
  date: string;
  providers: ProviderId[];
  movie: {
    title: string;
    districtContentId: string;
    bmsEventCode: string;
  };
  city: {
    districtKey: string;
    bmsRegion: string;
    bmsSlug: string;
    lat?: number;
    lng?: number;
  };
  venues: {
    include?: string[];
    exclude?: string[];
  };
  seats: SeatSpec;
}

export interface CadenceConfig {
  /** Poll interval when the date is on sale and nothing is hot. */
  baseSec: number;
  /** Poll interval while the date has no shows yet. */
  closedSec: number;
  /** Poll interval for a short window after an alert fires. */
  hotSec: number;
  /** Random ± percentage applied to every interval. */
  jitterPct: number;
  /** Skip seat-level polling for shows further out than this. */
  seatHorizonDays: number;
}

export interface NtfyConfig {
  server: string;
  topic: string;
  token?: string;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface QuietHours {
  from: string;
  to: string;
}

export interface NotifyConfig {
  onShowOpen: boolean;
  onSeatFreed: boolean;
  maxSeatsPerAlert: number;
  quietHours?: QuietHours;
  ntfy?: NtfyConfig;
  telegram?: TelegramConfig;
}

export interface WatchConfig {
  timezone: string;
  cadence: CadenceConfig;
  notify: NotifyConfig;
  targets: WatchTarget[];
}

export interface NotifyProfile {
  id: string;
  name: string;
  ntfyTopic?: string;
  telegramChat?: string;
}

/** A user-defined alert. One watch can span both providers. */
export interface WatchRecord {
  id: string;
  name: string;
  owner: string;
  enabled: boolean;
  profileId: string;
  movie: {
    title: string;
    districtContentId?: string;
    bmsEventCode?: string;
  };
  city: {
    districtKey?: string;
    bmsRegion?: string;
    bmsSlug?: string;
    label?: string;
  };
  date: string;
  providers: ProviderId[];
  venues: {
    include: string[];
    exclude: string[];
  };
  timeWindow: {
    from?: string;
    to?: string;
  };
  seats: {
    rows: string[];
    numbers: string[];
    minSeats: number;
  };
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface CreateWatchInput {
  /** Optional explicit id (used when seeding from config). */
  id?: string;
  name: string;
  owner?: string;
  enabled?: boolean;
  profileId: string;
  movie: WatchRecord["movie"];
  city: WatchRecord["city"];
  date: string;
  providers: ProviderId[];
  venues?: Partial<WatchRecord["venues"]>;
  timeWindow?: Partial<WatchRecord["timeWindow"]>;
  seats?: Partial<WatchRecord["seats"]>;
}

export interface UpdateWatchInput {
  name?: string;
  owner?: string;
  enabled?: boolean;
  profileId?: string;
  venues?: Partial<WatchRecord["venues"]>;
  timeWindow?: Partial<WatchRecord["timeWindow"]>;
  seats?: Partial<WatchRecord["seats"]>;
}

export interface WatchStatus {
  watchId: string;
  availability: Availability;
  sessionCount: number;
  matchedCount: number;
  seatsFree: number;
  watchedFree: number;
  lastCheckedAt: string;
  detail: string;
}

export interface MonitorRecord {
  id: string;
  provider: ProviderId;
  movieTitle: string;
  movieKey: string;
  cityKey: string;
  date: string;
  availability: Availability;
  sessionCount: number;
  lastCheckedAt: string;
  detail: string;
}

export type Priority = "min" | "low" | "default" | "high" | "urgent";

export interface Notification {
  title: string;
  message: string;
  priority: Priority;
  tags?: string[];
  url?: string;
}
