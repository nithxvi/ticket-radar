import type { WatchConfig } from "./types.ts";
import type { Radar, TargetRun } from "./engine.ts";
import type { Logger } from "./log.ts";
import { jitter } from "./engine.ts";

export const HOT_WINDOW_MS = 15 * 60_000;

/**
 * Per-target scheduler. Each target gets its own next-due time so a closed
 * date can idle at 5 minutes while an open date polls at 2 minutes. When an
 * alert fires, that target drops to the hot cadence (60s floor) for 15
 * minutes, then drifts back. Every interval gets jitter.
 */
export async function runDaemon(radar: Radar, config: WatchConfig, log: Logger): Promise<void> {
  const targets = config.targets.filter((t) => t.enabled !== false);
  if (targets.length === 0) {
    log.warn("no enabled targets — nothing to do");
    return;
  }

  const nextDue = new Map<string, number>(targets.map((t) => [t.id, 0]));
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
    `watching ${targets.length} target(s) · base ${config.cadence.baseSec}s · ` +
      `closed ${config.cadence.closedSec}s · hot ${config.cadence.hotSec}s · ` +
      `jitter ±${config.cadence.jitterPct}% · 60s floor`,
  );

  while (!stopping) {
    const now = Date.now();
    const due = targets.filter((t) => (nextDue.get(t.id) ?? 0) <= now);

    if (due.length === 0) {
      const earliest = Math.min(...targets.map((t) => nextDue.get(t.id) ?? now));
      await sleep(clamp(earliest - now, 250, 5_000));
      continue;
    }

    for (const target of due) {
      if (stopping) break;

      try {
        const run = await radar.runTarget(target, { deliver: true });
        if (run.alerts > 0) hotUntil.set(target.id, Date.now() + HOT_WINDOW_MS);

        const hot = (hotUntil.get(target.id) ?? 0) > Date.now();
        const base = hot ? config.cadence.hotSec : run.intervalSec;
        const interval = jitter(base, config.cadence.jitterPct);
        nextDue.set(target.id, Date.now() + interval * 1000);

        logRun(run, hot, log);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`poll failed for ${target.id}: ${message}`);
        const interval = jitter(config.cadence.baseSec, config.cadence.jitterPct);
        nextDue.set(target.id, Date.now() + interval * 1000);
      }
    }
  }
}

export function logRun(run: TargetRun, hot: boolean, log: Logger): void {
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
    `[${run.targetId}] ${providers}${seats}` +
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
