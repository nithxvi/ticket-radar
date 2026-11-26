import { createHash } from "node:crypto";
import type {
  Availability,
  ProviderId,
  Seat,
  SeatSpec,
  SessionRecord,
  WatchRecord,
  WatchTarget,
} from "./types.ts";

export interface SeatRule {
  rows?: string[];
  /** Exact seats, e.g. `["H12"]` (WatchTarget shape). */
  seats?: string[];
  /** Exact seats, WatchRecord shape. */
  numbers?: string[];
}

/** Empty rule means "anything goes". */
export function matchesSeatRule(seat: Seat, rule: SeatRule): boolean {
  const rows = rule.rows ?? [];
  const exact = [...(rule.seats ?? []), ...(rule.numbers ?? [])];
  if (rows.length === 0 && exact.length === 0) return true;

  const row = normalise(seat.row);
  const key = normalise(`${seat.row}${seat.number}`);
  if (exact.some((s) => normalise(s) === key)) return true;
  if (rows.some((r) => normalise(r) === row)) return true;
  return false;
}

export function normalise(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function movieKeyFor(provider: ProviderId, watch: WatchRecord): string {
  return (provider === "district" ? watch.movie.districtContentId : watch.movie.bmsEventCode) ?? "";
}

export function cityKeyFor(provider: ProviderId, watch: WatchRecord): string {
  return (provider === "district" ? watch.city.districtKey : watch.city.bmsRegion) ?? "";
}

export function canPoll(watch: WatchRecord, provider: ProviderId): boolean {
  if (provider === "district") {
    return Boolean(watch.movie.districtContentId && watch.city.districtKey);
  }
  return Boolean(watch.movie.bmsEventCode && watch.city.bmsRegion && watch.city.bmsSlug);
}

/** Deterministic: watches on the same film/city/date share one monitor. */
export function monitorIdFor(watch: WatchRecord, provider: ProviderId): string {
  const raw = `${provider}|${movieKeyFor(provider, watch)}|${cityKeyFor(provider, watch)}|${watch.date}`;
  return createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

export function watchToTarget(watch: WatchRecord, provider: ProviderId): WatchTarget {
  return {
    id: watch.id,
    label: watch.name,
    enabled: watch.enabled,
    date: watch.date,
    providers: [provider],
    movie: {
      title: watch.movie.title,
      districtContentId: watch.movie.districtContentId ?? "",
      bmsEventCode: watch.movie.bmsEventCode ?? "",
    },
    city: {
      districtKey: watch.city.districtKey ?? "",
      bmsRegion: watch.city.bmsRegion ?? "",
      bmsSlug: watch.city.bmsSlug ?? "",
    },
    venues: {
      include: watch.venues.include,
      exclude: watch.venues.exclude,
    },
    seats: {
      rows: watch.seats.rows,
      seats: watch.seats.numbers,
    },
  };
}

export function venueMatches(name: string, venues: WatchRecord["venues"]): boolean {
  const lower = name.toLowerCase();
  if (venues.exclude.some((v) => lower.includes(v.toLowerCase()))) return false;
  if (venues.include.length === 0) return true;
  return venues.include.some((v) => lower.includes(v.toLowerCase()));
}

export function sessionMatchesWatch(session: SessionRecord, watch: WatchRecord): boolean {
  if (!venueMatches(session.venueName, watch.venues)) return false;
  return timeInWindow(session.startIst, watch.timeWindow.from, watch.timeWindow.to);
}

/** HH:mm string comparison; supports windows that cross midnight. */
export function timeInWindow(time: string, from?: string, to?: string): boolean {
  if (!time) return true;
  if (!from && !to) return true;
  if (from && to && from > to) {
    // e.g. 22:00 → 02:00
    return time >= from || time <= to;
  }
  if (from && time < from) return false;
  if (to && time > to) return false;
  return true;
}

export function aggregateAvailability(states: Availability[]): Availability {
  if (states.some((s) => s === "OPEN")) return "OPEN";
  if (states.some((s) => s === "NOT_OPEN")) return "NOT_OPEN";
  return "UNKNOWN";
}

export function jitter(seconds: number, percent: number): number {
  const spread = (Math.random() * 2 - 1) * (percent / 100);
  return Math.max(60, Math.round(seconds * (1 + spread)));
}

export function minutesUntilStart(session: SessionRecord): number {
  const stamp = Date.parse(`${session.date}T${session.startIst}:00+05:30`);
  if (Number.isNaN(stamp)) return Number.POSITIVE_INFINITY;
  return (stamp - Date.now()) / 60_000;
}
