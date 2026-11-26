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

export interface NotifyConfig {
  onShowOpen: boolean;
  onSeatFreed: boolean;
  maxSeatsPerAlert: number;
  ntfy?: NtfyConfig;
  telegram?: TelegramConfig;
}

export interface WatchConfig {
  timezone: string;
  cadence: CadenceConfig;
  notify: NotifyConfig;
  targets: WatchTarget[];
}

export type Priority = "min" | "low" | "default" | "high" | "urgent";

export interface Notification {
  title: string;
  message: string;
  priority: Priority;
  tags?: string[];
  url?: string;
}
