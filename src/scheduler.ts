import type { WatchConfig } from "./types.ts";
import type { PollPlanner, MonitorRun } from "./poll-planner.ts";
import type { Store } from "./store.ts";
import type { Logger } from "./log.ts";
import { jitter } from "./engine.ts";

export const HOT_WINDOW_MS = 15 * 60_000;

export async function runDaemon(
  planner: PollPlanner,
  store: Store,
  config: WatchConfig,
  log: Logger,
): Promise<void> {
  const nextDue = new Map<string, number>();
  const hotUntil = new Map<string, number>();
  let stopping = false;

  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received — stopping after the current poll`);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  log.info(
    `watching · base ${config.cadence.baseSec}s · ` +
      `closed ${config.cadence.closedSec}s · hot ${config.cadence.hotSec}s · ` +
      `jitter ±${config.cadence.jitterPct}% · 60s floor`,
  );

  while (!stopping) {
    const groups = planner.listMonitors();
    const ids = new Set(groups.map((g) => g.id));

    // prune
    for (const key of [...nextDue.keys()]) {
      if (!ids.has(key)) nextDue.delete(key);
    }
    for (const g of groups) {
      if (!nextDue.has(g.id)) nextDue.set(g.id, 0);
    }

    if (groups.length === 0) {
      log.warn("no enabled watches — nothing to do");
      await sleep(5_000);
      if (stopping) break;
      continue;
    }

    const now = Date.now();
    const due = groups.filter((g) => (nextDue.get(g.id) ?? 0) <= now);

    if (due.length === 0) {
      const earliest = Math.min(...groups.map((g) => nextDue.get(g.id) ?? now));
      await sleep(clamp(earliest - now, 250, 5_000));
      continue;
    }

    for (const group of due) {
      if (stopping) break;
      try {
        const run = await planner.runMonitor(group.id, group.provider, group.watches, { deliver: true });
        if (run.alerts > 0) hotUntil.set(group.id, Date.now() + HOT_WINDOW_MS);

        const hot = (hotUntil.get(group.id) ?? 0) > Date.now();
        const base = hot ? config.cadence.hotSec : run.intervalSec;
        const interval = jitter(base, config.cadence.jitterPct);
        nextDue.set(group.id, Date.now() + interval * 1000);

        logMonitor(run, hot, log);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`poll failed for ${group.id}: ${message}`);
        const interval = jitter(config.cadence.baseSec, config.cadence.jitterPct);
        nextDue.set(group.id, Date.now() + interval * 1000);
      }
    }
  }
}

export function logMonitor(run: MonitorRun, hot: boolean, log: Logger): void {
  const providers = run.providers
    .map((p) => {
      const state = p.availability.padEnd(8);
      const detail = p.availability === "UNKNOWN" ? ` ${p.detail}` : "";
      return `${p.provider}:${state}(${p.sessions} shows, ${p.elapsedMs}ms)${detail}`;
    })
    .join("  ");

  const seats = run.seats.length
    ? ` · seats ${run.seats.filter((s) => !s.error).length}/${run.seats.length} ok, ` +
      `${run.seats.reduce((sum, s) => sum + s.available, 0)} free, ` +
      `${run.seats.reduce((sum, s) => sum + s.matched, 0)} watched`
    : "";

  log.info(
    `[${run.monitorId}] ${providers}${seats}` +
      `${run.alerts > 0 ? ` · ${run.alerts} alert(s)` : ""}` +
      `${hot ? " · hot" : ""}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
