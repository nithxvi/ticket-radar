import type {
  Availability,
  Notification,
  Provider,
  ProviderId,
  Seat,
  SeatSpec,
  SessionListResult,
  SessionRecord,
  WatchConfig,
  WatchTarget,
} from "./types.ts";
import type { Store } from "./store.ts";
import type { Notifier } from "./notify.ts";
import type { Logger } from "./log.ts";
import { daysUntil, isoNow, prettyDate, prettyTime } from "./time.ts";

export interface ProviderReport {
  provider: ProviderId;
  availability: Availability;
  sessions: number;
  detail: string;
  observedDate?: string;
  elapsedMs: number;
  error?: string;
}

export interface SeatReport {
  provider: ProviderId;
  sessionId: string;
  venueName: string;
  startIst: string;
  available: number;
  matched: number;
  freed: number;
  freedSeats: string[];
  baseline: boolean;
  error?: string;
}

export interface TargetRun {
  targetId: string;
  label: string;
  startedAt: string;
  availability: Availability;
  providers: ProviderReport[];
  seats: SeatReport[];
  alerts: number;
  intervalSec: number;
}

export interface RunOptions {
  /** When false, alerts are detected but neither persisted nor delivered. */
  deliver: boolean;
}

interface AlertDraft {
  kind: string;
  keys: string[];
  notification: Notification;
}

interface ProviderIntent {
  provider: ProviderId;
  kind: "opened" | "new_shows";
  sessions: SessionRecord[];
}

interface PendingSession {
  session: SessionRecord;
  isNew: boolean;
}

export class Radar {
  private readonly config: WatchConfig;
  private readonly store: Store;
  private readonly providers: Record<ProviderId, Provider>;
  private readonly notifier: Notifier;
  private readonly log: Logger;

  constructor(
    config: WatchConfig,
    store: Store,
    providers: Record<ProviderId, Provider>,
    notifier: Notifier,
    log: Logger,
  ) {
    this.config = config;
    this.store = store;
    this.providers = providers;
    this.notifier = notifier;
    this.log = log;
  }

  async runTarget(target: WatchTarget, options: RunOptions): Promise<TargetRun> {
    const startedAt = isoNow();
    const drafts: AlertDraft[] = [];
    const intents: ProviderIntent[] = [];
    const pending: PendingSession[] = [];
    const providerReports: ProviderReport[] = [];

    for (const providerId of target.providers) {
      const provider = this.providers[providerId];
      if (!provider) continue;

      const started = Date.now();
      let result: SessionListResult;
      let error: string | undefined;

      try {
        result = await provider.listSessions(target);
      } catch (caught) {
        error = messageOf(caught);
        result = { availability: "UNKNOWN", sessions: [], detail: error };
      }

      const elapsedMs = Date.now() - started;
      this.store.logPoll(
        target.id,
        providerId,
        result.availability,
        result.detail,
        elapsedMs,
        startedAt,
      );

      providerReports.push({
        provider: providerId,
        availability: result.availability,
        sessions: result.sessions.length,
        detail: result.detail,
        observedDate: result.observedDate,
        elapsedMs,
        error,
      });

      if (result.availability === "UNKNOWN") {
        this.log.warn(
          `${target.id}/${providerId}: unknown state — ${result.detail} (keeping previous state)`,
        );
        continue;
      }

      const previous = this.store.getProviderState(target.id, providerId);
      const { added, known } = this.store.upsertSessions(
        target.id,
        providerId,
        result.sessions,
        startedAt,
      );
      this.store.setProviderState(target.id, providerId, result.availability);

      const firstObservation = previous === null && known === 0;
      const addedIds = new Set(added.map((s) => s.sessionId));

      for (const session of result.sessions) {
        pending.push({ session, isNew: addedIds.has(session.sessionId) });
      }

      if (result.sessions.length === 0) continue;

      if (firstObservation) {
        this.log.info(
          `${target.id}/${providerId}: baseline — ${result.sessions.length} show(s) already listed, no alert`,
        );
        continue;
      }

      if (previous === "NOT_OPEN") {
        intents.push({ provider: providerId, kind: "opened", sessions: result.sessions });
      } else if (added.length > 0) {
        intents.push({ provider: providerId, kind: "new_shows", sessions: added });
      }
    }

    const seatReports = await this.checkSeats(target, pending, startedAt);
    const seatByKey = new Map(seatReports.map((r) => [`${r.provider}:${r.sessionId}`, r]));

    for (const intent of intents) {
      if (intent.kind === "opened") {
        drafts.push(this.openedAlert(target, intent, seatByKey));
      } else {
        drafts.push(this.newShowsAlert(target, intent, seatByKey));
      }
    }

    for (let i = 0; i < seatReports.length; i++) {
      const report = seatReports[i];
      if (report.error || report.baseline || report.freed === 0) continue;
      const session = findSession(pending, report);
      if (!session) continue;
      drafts.push(this.seatFreedAlert(target, session, seatByKey.get(`${report.provider}:${report.sessionId}`)!));
    }

    const alerts = await this.deliver(drafts, options);

    return {
      targetId: target.id,
      label: target.label,
      startedAt,
      availability: aggregateAvailability(providerReports),
      providers: providerReports,
      seats: seatReports,
      alerts,
      intervalSec: this.chooseInterval(providerReports, alerts),
    };
  }

  private async checkSeats(
    target: WatchTarget,
    pending: PendingSession[],
    at: string,
  ): Promise<SeatReport[]> {
    const horizon = this.config.cadence.seatHorizonDays;
    const eligible = pending.filter(({ session }) => {
      const days = daysUntil(session.date);
      if (days < 0 || days > horizon) return false;
      return minutesUntilStart(session) > -30;
    });

    const results = await mapLimit(eligible, 2, async ({ session }) => {
      const provider = this.providers[session.provider];
      const base: SeatReport = {
        provider: session.provider,
        sessionId: session.sessionId,
        venueName: session.venueName,
        startIst: session.startIst,
        available: 0,
        matched: 0,
        freed: 0,
        freedSeats: [],
        baseline: false,
      };

      if (!provider) return { ...base, error: "provider not configured" };

      let map;
      try {
        map = await provider.getSeatMap(session);
      } catch (caught) {
        return { ...base, error: messageOf(caught) };
      }

      if (!map.ok) {
        this.log.warn(
          `${target.id}/${session.provider}/${session.sessionId}: seat map unavailable — ${map.detail}`,
        );
        return { ...base, error: map.detail };
      }

      const snapshot = this.store.applySeatSnapshot(
        target.id,
        session.provider,
        session.sessionId,
        map.seats,
        at,
      );

      const matched = map.seats.filter(
        (seat) => seat.status === "available" && seatMatches(seat, target.seats),
      ).length;

      const freedMatched = snapshot.freed.filter((seat) => seatMatches(seat, target.seats));

      return {
        ...base,
        available: snapshot.available,
        matched,
        freed: freedMatched.length,
        freedSeats: freedMatched.map((seat) => seat.key),
        baseline: snapshot.baseline,
      };
    });

    for (const report of results) {
      this.log.debug(
        `${target.id}/${report.provider}/${report.sessionId}: ${report.available} available, ` +
          `${report.matched} matching, ${report.freed} freed${report.error ? ` (${report.error})` : ""}`,
      );
    }

    return results;
  }

  private async deliver(drafts: AlertDraft[], options: RunOptions): Promise<number> {
    let delivered = 0;

    for (const draft of drafts) {
      const fresh = options.deliver && draft.keys.length > 0
        ? draft.keys.filter((key) => this.store.claimAlert(key, draft.kind, "{}", isoNow()))
        : draft.keys;

      if (options.deliver && draft.keys.length > 0 && fresh.length === 0) continue;

      if (!this.notifier.configured) {
        this.log.info(`ALERT (no channels configured)\n  ${draft.notification.title}\n  ${draft.notification.message.replace(/\n/g, "\n  ")}`);
        delivered += 1;
        continue;
      }

      const results = await this.notifier.send(draft.notification);
      const succeeded = results.filter((r) => r.ok).length;

      if (succeeded === 0 && results.length > 0 && options.deliver) {
        for (const key of fresh) this.store.releaseAlert(key);
        this.log.error(
          `all channels failed for "${draft.notification.title}" — will retry next poll`,
        );
        continue;
      }

      delivered += 1;
      const channels = results.map((r) => `${r.channel}:${r.ok ? "ok" : `fail(${r.error})`}`).join(" ");
      this.log.info(`ALERT sent (${channels || "log only"}) — ${draft.notification.title}`);
    }

    return delivered;
  }

  private openedAlert(
    target: WatchTarget,
    intent: ProviderIntent,
    seats: Map<string, SeatReport>,
  ): AlertDraft {
    const lines = intent.sessions.map((session) => {
      const report = seats.get(`${session.provider}:${session.sessionId}`);
      const suffix = report && report.matched > 0 ? ` — ${report.matched} watched seat(s) free` : "";
      return `${prettyTime(session.startIst)} · ${session.venueName}${suffix}`;
    });

    return {
      kind: "show_open",
      keys: intent.sessions.map((s) => `open:${target.id}:${s.provider}:${s.sessionId}`),
      notification: {
        title: `🎟️ Booking opened — ${providerLabel(intent.provider)}`,
        message: [
          `${target.movie.title} · ${prettyDate(target.date)}`,
          `${intent.sessions.length} show(s) just went on sale:`,
          "",
          ...cap(lines, 12),
          "",
          "Open the app now — seats go fast.",
        ].join("\n"),
        priority: "urgent",
        tags: ["ticket", "rotating_light"],
        url: intent.sessions[0]?.url,
      },
    };
  }

  private newShowsAlert(
    target: WatchTarget,
    intent: ProviderIntent,
    seats: Map<string, SeatReport>,
  ): AlertDraft {
    const lines = intent.sessions.map((session) => {
      const report = seats.get(`${session.provider}:${session.sessionId}`);
      const suffix = report && report.matched > 0 ? ` — ${report.matched} watched seat(s) free` : "";
      return `${prettyTime(session.startIst)} · ${session.venueName}${suffix}`;
    });

    return {
      kind: "show_added",
      keys: intent.sessions.map((s) => `open:${target.id}:${s.provider}:${s.sessionId}`),
      notification: {
        title: `🆕 New show${intent.sessions.length > 1 ? "s" : ""} — ${providerLabel(intent.provider)}`,
        message: [
          `${target.movie.title} · ${prettyDate(target.date)}`,
          "",
          ...cap(lines, 12),
        ].join("\n"),
        priority: "high",
        tags: ["ticket", "new"],
        url: intent.sessions[0]?.url,
      },
    };
  }

  private seatFreedAlert(target: WatchTarget, session: SessionRecord, report: SeatReport): AlertDraft {
    const listed = cap(report.freedSeats, this.config.notify.maxSeatsPerAlert).join(", ");
    // Transition-driven: the seat snapshot already guarantees one alert per
    // booked -> available change, so there is no long-lived dedupe key.
    return {
      kind: "seat_freed",
      keys: [],
      notification: {
        title: `💺 ${report.freed} watched seat${report.freed === 1 ? "" : "s"} freed — ${session.venueName}`,
        message: [
          `${target.movie.title} · ${prettyDate(target.date)}`,
          `${prettyTime(session.startIst)} · ${session.format}`,
          "",
          `Freed: ${listed}`,
          `${report.available} seats are free in total.`,
          "",
          "Book before someone else does.",
        ].join("\n"),
        priority: "urgent",
        tags: ["seat", "rotating_light"],
        url: session.url,
      },
    };
  }

  private chooseInterval(providers: ProviderReport[], alerts: number): number {
    const cadence = this.config.cadence;
    if (alerts > 0) return cadence.hotSec;
    const known = providers.filter((p) => p.availability !== "UNKNOWN");
    if (known.length > 0 && known.every((p) => p.availability === "NOT_OPEN")) {
      return cadence.closedSec;
    }
    return cadence.baseSec;
  }
}

export function jitter(seconds: number, percent: number): number {
  const spread = (Math.random() * 2 - 1) * (percent / 100);
  return Math.max(60, Math.round(seconds * (1 + spread)));
}

export function aggregateAvailability(providers: ProviderReport[]): Availability {
  if (providers.some((p) => p.availability === "OPEN")) return "OPEN";
  if (providers.some((p) => p.availability === "NOT_OPEN")) return "NOT_OPEN";
  return "UNKNOWN";
}

function seatMatches(seat: Seat, spec: SeatSpec): boolean {
  return matchesSeatSpec(seat, spec);
}

export function matchesSeatSpec(seat: Seat, spec: SeatSpec): boolean {
  const rows = spec.rows ?? [];
  const exact = spec.seats ?? [];
  if (rows.length === 0 && exact.length === 0) return true;

  const row = normalise(seat.row);
  const key = normalise(`${seat.row}${seat.number}`);
  if (exact.some((s) => normalise(s) === key)) return true;
  if (rows.some((r) => normalise(r) === row)) return true;
  return false;
}

function normalise(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function minutesUntilStart(session: SessionRecord): number {
  const stamp = Date.parse(`${session.date}T${session.startIst}:00+05:30`);
  if (Number.isNaN(stamp)) return Number.POSITIVE_INFINITY;
  return (stamp - Date.now()) / 60_000;
}

function findSession(pending: PendingSession[], report: SeatReport): SessionRecord | undefined {
  return pending.find(
    (p) => p.session.provider === report.provider && p.session.sessionId === report.sessionId,
  )?.session;
}

function providerLabel(provider: ProviderId): string {
  return provider === "bms" ? "BookMyShow" : "District";
}

function cap(lines: string[], limit: number): string[] {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `…and ${lines.length - limit} more`];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return output;
}
