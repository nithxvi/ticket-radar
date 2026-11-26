import type {
  Availability,
  Notification,
  ProviderId,
  Seat,
  SeatSpec,
  SessionRecord,
  WatchConfig,
  WatchRecord,
  WatchStatus,
} from "./types.ts";
import type { Store } from "./store.ts";
import type { StoredSession } from "./store.ts";
import type { Notifier } from "./notify.ts";
import type { Logger } from "./log.ts";
import type { Provider } from "./types.ts";
import type { ProviderReport, SeatReport } from "./engine.ts";
import { matchesSeatSpec } from "./engine.ts";
import { daysUntil, isoNow, prettyDate, prettyTime } from "./time.ts";
import { env } from "./env.ts";
import { Notifier as NotifierClass } from "./notify.ts";
import { monitorIdFor, movieKeyFor, cityKeyFor, canPoll, sessionMatchesWatch, watchToTarget, minutesUntilStart } from "./watch-rules.ts";


export interface MonitorRun {
  monitorId: string;
  provider: ProviderId;
  movieTitle: string;
  cityKey: string;
  date: string;
  startedAt: string;
  availability: Availability;
  sessions: number;
  matchedWatches: number;
  seatsChecked: number;
  alerts: number;
  intervalSec: number;
  providers: ProviderReport[];
  seats: SeatReport[];
  watchStatuses: WatchStatus[];
}

export interface RunOptions {
  deliver: boolean;
}

interface AlertDraft {
  kind: string;
  keys: string[];
  notification: Notification;
  profileId: string;
  watchId: string;
}

interface ProviderIntent {
  provider: ProviderId;
  kind: "opened" | "new_shows";
  sessions: SessionRecord[];
}

export class PollPlanner {
  private readonly config: WatchConfig;
  private readonly store: Store;
  private readonly providers: Record<ProviderId, Provider>;
  private readonly log: Logger;

  constructor(
    config: WatchConfig,
    store: Store,
    providers: Record<ProviderId, Provider>,
    log: Logger,
  ) {
    this.config = config;
    this.store = store;
    this.providers = providers;
    this.log = log;
  }

  listSessionsForWatch(watch: WatchRecord): Array<StoredSession & { monitorId: string; provider: ProviderId }> {
    const out: Array<StoredSession & { monitorId: string; provider: ProviderId }> = [];
    for (const provider of watch.providers) {
      if (!canPoll(watch, provider)) continue;
      const monitorId = monitorIdFor(watch, provider);
      for (const s of this.store.listSessions(monitorId)) {
        out.push({ ...s, monitorId, provider });
      }
    }
    return out;
  }

  async getSeatMap(monitorId: string, sessionId: string): Promise<{ session: StoredSession; ok: boolean; seats: Seat[]; available: number; detail: string } | null> {
    const sessions = this.store.listSessions(monitorId);
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session) return null;
    const provider = this.providers[session.provider];
    if (!provider) return null;
    const map = await provider.getSeatMap(session as unknown as SessionRecord);
    return { session, ...map };
  }

  listMonitors(): Array<{ id: string; provider: ProviderId; watches: WatchRecord[] }> {
    const watches = this.store.listWatches({ enabledOnly: true });
    const groups = new Map<string, { id: string; provider: ProviderId; watches: WatchRecord[] }>();
    for (const w of watches) {
      for (const provider of w.providers) {
        if (!canPoll(w, provider)) continue;
        const id = monitorIdFor(w, provider);
        if (!groups.has(id)) groups.set(id, { id, provider, watches: [] });
        groups.get(id)!.watches.push(w);
      }
    }
    return [...groups.values()];
  }

  async runMonitor(
    monitorId: string,
    providerId: ProviderId,
    watches: WatchRecord[],
    options: RunOptions,
  ): Promise<MonitorRun> {
    const startedAt = isoNow();
    const drafts: AlertDraft[] = [];
    const provider = this.providers[providerId];
    const firstWatch = watches[0];
    const target = watchToTarget(firstWatch, providerId);

    const horizon = this.config.cadence.seatHorizonDays;

    // 1. listSessions once per monitor
    const started = Date.now();
    let result: { availability: Availability; sessions: SessionRecord[]; detail: string; observedDate?: string };
    let error: string | undefined;
    try {
      const r = await provider.listSessions(target);
      result = { availability: r.availability, sessions: r.sessions, detail: r.detail, observedDate: r.observedDate };
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      result = { availability: "UNKNOWN", sessions: [], detail: error ?? "error" };
    }
    const elapsedMs = Date.now() - started;

    this.store.logPoll(monitorId, providerId, result.availability, result.detail, elapsedMs, startedAt);

    const providerReport: ProviderReport = {
      provider: providerId,
      availability: result.availability,
      sessions: result.sessions.length,
      detail: result.detail,
      observedDate: result.observedDate,
      elapsedMs,
      error,
    };

    // save monitor
    this.store.saveMonitor({
      id: monitorId,
      provider: providerId,
      movieTitle: firstWatch.movie.title,
      movieKey: movieKeyFor(providerId, firstWatch),
      cityKey: cityKeyFor(providerId, firstWatch),
      date: firstWatch.date,
      availability: result.availability,
      sessionCount: result.sessions.length,
      lastCheckedAt: startedAt,
      detail: result.detail,
    });

    if (result.availability === "UNKNOWN") {
      // save statuses unknown
      const watchStatuses: WatchStatus[] = [];
      for (const watch of watches) {
        const status: WatchStatus = {
          watchId: watch.id,
          availability: "UNKNOWN",
          sessionCount: 0,
          matchedCount: 0,
          seatsFree: 0,
          watchedFree: 0,
          lastCheckedAt: startedAt,
          detail: result.detail,
        };
        this.store.saveWatchStatus(status);
        watchStatuses.push(status);
      }
      return {
        monitorId,
        provider: providerId,
        movieTitle: firstWatch.movie.title,
        cityKey: cityKeyFor(providerId, firstWatch),
        date: firstWatch.date,
        startedAt,
        availability: "UNKNOWN",
        sessions: 0,
        matchedWatches: 0,
        seatsChecked: 0,
        alerts: 0,
        intervalSec: this.config.cadence.baseSec,
        providers: [providerReport],
        seats: [],
        watchStatuses,
      };
    }

    const previous = this.store.getProviderState(monitorId, providerId);
    const { added, known } = this.store.upsertSessions(monitorId, providerId, result.sessions, startedAt);
    this.store.setProviderState(monitorId, providerId, result.availability);
    const firstObservation = previous === null && known === 0;
    const addedIds = new Set(added.map((s) => s.sessionId));

    // 2. getSeatMap per unique session
    const eligible = result.sessions.filter((session) => {
      const days = daysUntil(session.date);
      if (days < 0 || days > horizon) return false;
      return minutesUntilStart(session) > -30;
    });

    const seatData = new Map<
      string,
      { session: SessionRecord; map: { ok: boolean; seats: Seat[]; available: number; detail: string }; snapshot: { baseline: boolean; freed: Seat[]; available: number } | null; error?: string }
    >();

    const seatReports: SeatReport[] = [];

    // fetch with concurrency 2
    await this.mapLimit(eligible, 2, async (session) => {
      const base: SeatReport = {
        provider: providerId,
        sessionId: session.sessionId,
        venueName: session.venueName,
        startIst: session.startIst,
        available: 0,
        matched: 0,
        freed: 0,
        freedSeats: [],
        baseline: false,
      };
      if (!provider) {
        seatData.set(session.sessionId, { session, map: { ok: false, seats: [], available: 0, detail: "no provider" }, snapshot: null, error: "no provider" });
        seatReports.push({ ...base, error: "no provider" });
        return;
      }
      let map;
      try {
        map = await provider.getSeatMap(session);
      } catch (caught) {
        const msg = caught instanceof Error ? caught.message : String(caught);
        seatData.set(session.sessionId, { session, map: { ok: false, seats: [], available: 0, detail: msg }, snapshot: null, error: msg });
        seatReports.push({ ...base, error: msg });
        return;
      }
      if (!map.ok) {
        this.log.warn(`${monitorId}/${session.sessionId}: seat map unavailable — ${map.detail}`);
        seatData.set(session.sessionId, { session, map, snapshot: null, error: map.detail });
        seatReports.push({ ...base, error: map.detail });
        return;
      }
      const snapshot = this.store.applySeatSnapshot(monitorId, providerId, session.sessionId, map.seats, startedAt);
      seatData.set(session.sessionId, { session, map, snapshot });
      seatReports.push({
        ...base,
        available: snapshot.available,
        matched: snapshot.available,
        freed: snapshot.freed.length,
        freedSeats: snapshot.freed.map((s) => s.key),
        baseline: snapshot.baseline,
      });
    });

    // 3. evaluate each watch
    const watchStatuses: WatchStatus[] = [];
    let totalAlerts = 0;

    for (const watch of watches) {
      const matchedSessions = result.sessions.filter((s) => sessionMatchesWatch(s, watch));
      const spec: SeatSpec = { rows: watch.seats.rows, seats: watch.seats.numbers };

      // seat counts
      let seatsFree = 0;
      let watchedFree = 0;
      for (const session of matchedSessions) {
        const data = seatData.get(session.sessionId);
        if (!data || !data.map.ok || !data.snapshot) continue;
        seatsFree += data.snapshot.available;
        watchedFree += data.map.seats.filter(
          (seat) => seat.status === "available" && matchesSeatSpec(seat, spec),
        ).length;
      }

      const { firstObservation: watchFirstObs, added: watchAdded } = this.store.recordWatchSessions(
        watch.id,
        providerId,
        matchedSessions.map((s) => s.sessionId),
        startedAt,
      );
      const addedMatchedSet = new Set(watchAdded);
      const addedMatchedSessions = matchedSessions.filter((s) => addedMatchedSet.has(s.sessionId));

      // intents
      const intents: ProviderIntent[] = [];
      if (!watchFirstObs && !firstObservation) {
        // use monitor previous for opened detection
      }
      if (!watchFirstObs) {
        if (previous === "NOT_OPEN" && matchedSessions.length > 0) {
          intents.push({ provider: providerId, kind: "opened", sessions: matchedSessions });
        } else if (addedMatchedSessions.length > 0) {
          intents.push({ provider: providerId, kind: "new_shows", sessions: addedMatchedSessions });
        }
      }

      // opened/new alerts
      for (const intent of intents) {
        if (intent.kind === "opened") {
          drafts.push(this.openedAlert(watch, intent, seatData));
        } else {
          drafts.push(this.newShowsAlert(watch, intent, seatData));
        }
      }

      // seat freed alerts
      for (const session of matchedSessions) {
        const data = seatData.get(session.sessionId);
        if (!data || !data.map.ok || !data.snapshot || data.snapshot.baseline) continue;
        const freedMatched = data.snapshot.freed.filter((seat) => matchesSeatSpec(seat, spec));
        if (freedMatched.length === 0) continue;
        if (freedMatched.length < (watch.seats.minSeats || 1)) continue;
        drafts.push(this.seatFreedAlert(watch, session, freedMatched, data.snapshot.available));
      }

      const status: WatchStatus = {
        watchId: watch.id,
        availability: result.availability,
        sessionCount: result.sessions.length,
        matchedCount: matchedSessions.length,
        seatsFree,
        watchedFree,
        lastCheckedAt: startedAt,
        detail: result.detail,
      };
      this.store.saveWatchStatus(status);
      watchStatuses.push(status);
    }

    // deliver
    totalAlerts = await this.deliver(drafts, options);

    const intervalSec =
      totalAlerts > 0
        ? this.config.cadence.hotSec
        : result.availability === "NOT_OPEN"
          ? this.config.cadence.closedSec
          : this.config.cadence.baseSec;

    return {
      monitorId,
      provider: providerId,
      movieTitle: firstWatch.movie.title,
      cityKey: cityKeyFor(providerId, firstWatch),
      date: firstWatch.date,
      startedAt,
      availability: result.availability,
      sessions: result.sessions.length,
      matchedWatches: watches.length,
      seatsChecked: seatReports.filter((r) => !r.error).length,
      alerts: totalAlerts,
      intervalSec,
      providers: [providerReport],
      seats: seatReports,
      watchStatuses,
    };
  }

  private isQuietHours(): boolean {
    const qh = this.config.notify.quietHours;
    if (!qh?.from || !qh?.to) return false;
    const now = new Date();
    const ist = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
    const [h, m] = ist.split(":").map(Number);
    const mins = h * 60 + m;
    const [fh, fm] = qh.from.split(":").map(Number);
    const [th, tm] = qh.to.split(":").map(Number);
    const fromMins = fh * 60 + fm;
    const toMins = th * 60 + tm;
    if (fromMins <= toMins) return mins >= fromMins && mins <= toMins;
    return mins >= fromMins || mins <= toMins;
  }

  private notifierFor(profileId: string): NotifierClass {
    const profile = this.store.getProfile(profileId);
    const cfg = {
      onShowOpen: true,
      onSeatFreed: true,
      maxSeatsPerAlert: this.config.notify.maxSeatsPerAlert,
      ntfy: profile?.ntfyTopic
        ? {
            server: env("NTFY_SERVER") ?? this.config.notify.ntfy?.server ?? "https://ntfy.sh",
            topic: profile.ntfyTopic,
            token: env("NTFY_TOKEN"),
          }
        : this.config.notify.ntfy,
      telegram: profile?.telegramChat
        ? {
            botToken: env("TELEGRAM_BOT_TOKEN") ?? this.config.notify.telegram?.botToken ?? "",
            chatId: profile.telegramChat,
          }
        : this.config.notify.telegram,
    };
    return new NotifierClass(cfg as any, this.log);
  }

  private async deliver(drafts: AlertDraft[], options: RunOptions): Promise<number> {
    if (this.isQuietHours()) {
      for (const draft of drafts) {
        this.log.info(`ALERT suppressed (quiet hours) — ${draft.notification.title}`);
      }
      return 0;
    }
    let delivered = 0;
    for (const draft of drafts) {
      const fresh =
        options.deliver && draft.keys.length > 0
          ? draft.keys.filter((key) => this.store.claimAlert(key, draft.kind, "{}", isoNow()))
          : draft.keys;

      if (options.deliver && draft.keys.length > 0 && fresh.length === 0) continue;

      const notifier = this.notifierFor(draft.profileId);
      if (!notifier.configured) {
        this.log.info(`ALERT (no channels configured)\n  ${draft.notification.title}\n  ${draft.notification.message.replace(/\n/g, "\n  ")}`);
        delivered += 1;
        continue;
      }

      const results = await notifier.send(draft.notification);
      const succeeded = results.filter((r) => r.ok).length;

      if (succeeded === 0 && results.length > 0 && options.deliver) {
        for (const key of fresh) this.store.releaseAlert(key);
        this.log.error(`all channels failed for "${draft.notification.title}" — will retry next poll`);
        continue;
      }

      delivered += 1;
      const channels = results.map((r) => `${r.channel}:${r.ok ? "ok" : `fail(${r.error})`}`).join(" ");
      this.log.info(`ALERT sent (${channels || "log only"}) — ${draft.notification.title}`);
    }
    return delivered;
  }

  private openedAlert(watch: WatchRecord, intent: ProviderIntent, seatData: Map<string, any>): AlertDraft {
    const lines = intent.sessions.map((session) => {
      const data = seatData.get(session.sessionId);
      const suffix = data && data.map?.seats
        ? (() => {
            const spec: SeatSpec = { rows: watch.seats.rows, seats: watch.seats.numbers };
            const matched = data.map.seats.filter((s: Seat) => s.status === "available" && matchesSeatSpec(s, spec)).length;
            return matched > 0 ? ` — ${matched} watched seat(s) free` : "";
          })()
        : "";
      return `${prettyTime(session.startIst)} · ${session.venueName}${suffix}`;
    });

    return {
      kind: "show_open",
      keys: intent.sessions.map((s) => `open:${watch.id}:${s.provider}:${s.sessionId}`),
      notification: {
        title: `🎟️ Booking opened — ${providerLabel(intent.provider)}`,
        message: [
          `${watch.movie.title} · ${prettyDate(watch.date)}`,
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
      profileId: watch.profileId,
      watchId: watch.id,
    };
  }

  private newShowsAlert(watch: WatchRecord, intent: ProviderIntent, seatData: Map<string, any>): AlertDraft {
    const lines = intent.sessions.map((session) => {
      const data = seatData.get(session.sessionId);
      const suffix = data && data.map?.seats
        ? (() => {
            const spec: SeatSpec = { rows: watch.seats.rows, seats: watch.seats.numbers };
            const matched = data.map.seats.filter((s: Seat) => s.status === "available" && matchesSeatSpec(s, spec)).length;
            return matched > 0 ? ` — ${matched} watched seat(s) free` : "";
          })()
        : "";
      return `${prettyTime(session.startIst)} · ${session.venueName}${suffix}`;
    });

    return {
      kind: "show_added",
      keys: intent.sessions.map((s) => `open:${watch.id}:${s.provider}:${s.sessionId}`),
      notification: {
        title: `🆕 New show${intent.sessions.length > 1 ? "s" : ""} — ${providerLabel(intent.provider)}`,
        message: [`${watch.movie.title} · ${prettyDate(watch.date)}`, "", ...cap(lines, 12)].join("\n"),
        priority: "high",
        tags: ["ticket", "new"],
        url: intent.sessions[0]?.url,
      },
      profileId: watch.profileId,
      watchId: watch.id,
    };
  }

  private seatFreedAlert(watch: WatchRecord, session: SessionRecord, freed: Seat[], available: number): AlertDraft {
    const listed = cap(
      freed.map((s) => s.key),
      this.config.notify.maxSeatsPerAlert,
    ).join(", ");
    return {
      kind: "seat_freed",
      keys: [],
      notification: {
        title: `💺 ${freed.length} watched seat${freed.length === 1 ? "" : "s"} freed — ${session.venueName}`,
        message: [
          `${watch.movie.title} · ${prettyDate(watch.date)}`,
          `${prettyTime(session.startIst)} · ${session.format}`,
          "",
          `Freed: ${listed}`,
          `${available} seats are free in total.`,
          "",
          "Book before someone else does.",
        ].join("\n"),
        priority: "urgent",
        tags: ["seat", "rotating_light"],
        url: session.url,
      },
      profileId: watch.profileId,
      watchId: watch.id,
    };
  }

  private async mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
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
}

function providerLabel(provider: ProviderId): string {
  return provider === "bms" ? "BookMyShow" : "District";
}

function cap(lines: string[], limit: number): string[] {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `…and ${lines.length - limit} more`];
}
