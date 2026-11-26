#!/usr/bin/env node
import { loadEnvFile, env } from "./env.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { createProviders } from "./providers/index.ts";
import { Notifier } from "./notify.ts";
import { Radar, matchesSeatSpec } from "./engine.ts";
import type { RunOptions, TargetRun } from "./engine.ts";
import { runDaemon } from "./scheduler.ts";
import { createLogger } from "./log.ts";
import type { Logger } from "./log.ts";
import { seedWatchesFromConfig } from "./seed.ts";
import { PollPlanner } from "./poll-planner.ts";
import { startServer } from "./server.ts";
import { prettyDate, prettyTime } from "./time.ts";
import type {
  Availability,
  Provider,
  ProviderId,
  Seat,
  SessionListResult,
  WatchConfig,
  WatchTarget,
} from "./types.ts";

loadEnvFile();

const VALUE_FLAGS = new Set(["config", "target", "session", "provider"]);

interface Args {
  flags: Map<string, string | true>;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=");
    if (inline !== undefined) {
      flags.set(key, inline);
    } else if (VALUE_FLAGS.has(key) && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags.set(key, argv[++i]);
    } else {
      flags.set(key, true);
    }
  }

  return { flags, positional };
}

interface Context {
  config: WatchConfig;
  store: Store;
  log: Logger;
  providers: Record<ProviderId, Provider>;
  notifier: Notifier;
  radar: Radar;
  planner: PollPlanner;
}

function createContext(configPath?: string): Context {
  const config = loadConfig(configPath ?? "config/watch.json");
  const dbPath = env("TICKET_RADAR_DB") ?? "./data/ticket-radar.db";
  const store = new Store(dbPath);
  seedWatchesFromConfig(store, config);
  const log = createLogger("radar");
  const providers = createProviders(store, log);
  const notifier = new Notifier(config.notify, log);
  const radar = new Radar(config, store, providers, notifier, log);
  const planner = new PollPlanner(config, store, providers, log);
  return { config, store, log, providers, notifier, radar, planner };
}

function pickTarget(config: WatchConfig, id?: string | true): WatchTarget {
  if (id && id !== true) {
    const found = config.targets.find((t) => t.id === id);
    if (!found) throw new Error(`unknown target "${id}" — known: ${config.targets.map((t) => t.id).join(", ")}`);
    return found;
  }
  const enabled = config.targets.find((t) => t.enabled !== false);
  if (!enabled) throw new Error("no enabled targets");
  return enabled;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  const command = positional[0] ?? "help";

  switch (command) {
    case "watch":
      return cmdWatch(flags);
    case "serve":
      return cmdServe(flags);
    case "once":
      return cmdOnce(flags);
    case "doctor":
      return cmdDoctor(flags);
    case "seats":
      return cmdSeats(flags, positional);
    case "notify-test":
      return cmdNotifyTest(flags);
    case "help":
    case "--help":
    case "-h":
      return usage();
    default:
      console.error(`unknown command "${command}"`);
      usage();
      process.exitCode = 1;
  }
}

async function cmdWatch(flags: Map<string, string | true>): Promise<void> {
  const ctx = createContext(asString(flags.get("config")));
  try {
    const host = env("TICKET_RADAR_HOST") ?? "127.0.0.1";
    const port = Number(env("TICKET_RADAR_PORT") ?? "4317");
    const server = await startServer(ctx.store, ctx.planner, ctx.config, ctx.log, port, host);
    await runDaemon(ctx.planner, ctx.store, ctx.config, ctx.log);
    await server.close();
  } finally {
    ctx.store.close();
  }
}

async function cmdServe(flags: Map<string, string | true>): Promise<void> {
  const ctx = createContext(asString(flags.get("config")));
  try {
    const host = env("TICKET_RADAR_HOST") ?? "127.0.0.1";
    const port = Number(env("TICKET_RADAR_PORT") ?? "4317");
    const server = await startServer(ctx.store, ctx.planner, ctx.config, ctx.log, port, host);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await server.close();
  } finally {
    ctx.store.close();
  }
}

async function cmdOnce(flags: Map<string, string | true>): Promise<void> {
  const ctx = createContext(asString(flags.get("config")));
  const verbose = flags.has("verbose");
  try {
    if (!ctx.notifier.configured) {
      ctx.log.warn("no notification channels configured — alerts will only be logged");
    }

    const monitors = ctx.planner.listMonitors();
    if (monitors.length === 0) {
      console.log("no watches to poll");
      return;
    }

    for (const group of monitors) {
      const run = await ctx.planner.runMonitor(group.id, group.provider, group.watches, { deliver: true });
      printMonitorRun(run, verbose);
    }
  } finally {
    ctx.store.close();
  }
}

async function cmdDoctor(flags: Map<string, string | true>): Promise<void> {
  const ctx = createContext(asString(flags.get("config")));
  try {
    console.log(`Config OK · ${ctx.config.targets.length} target(s)`);
    console.log(
      `Channels: ${ctx.notifier.channels.length ? ctx.notifier.channels.join(", ") : "none (add NTFY_TOPIC or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to .env)"}`,
    );

    for (const target of ctx.config.targets) {
      console.log(`\n=== ${target.label}`);
      console.log(`    id:      ${target.id}`);
      console.log(`    movie:   ${target.movie.title} · ${prettyDate(target.date)}`);
      console.log(`    watch:   rows [${(target.seats.rows ?? []).join(", ") || "all"}]` +
        `${target.seats.seats?.length ? ` seats [${target.seats.seats.join(", ")}]` : ""}`);
      console.log(`    venues:  ${(target.venues.include ?? []).join(" / ") || "all"}`);

      for (const providerId of target.providers) {
        const provider = ctx.providers[providerId];
        if (!provider) continue;
        const started = Date.now();
        let result: SessionListResult;
        try {
          result = await provider.listSessions(target);
        } catch (error) {
          result = {
            availability: "UNKNOWN",
            sessions: [],
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        const elapsed = Date.now() - started;
        console.log(`\n  ${providerId.toUpperCase()}  ${result.availability}  (${elapsed}ms)  ${result.detail}`);
        if (result.observedDate) console.log(`    answered for: ${result.observedDate}`);

        for (const session of result.sessions.slice(0, 12)) {
          console.log(
            `    ${prettyTime(session.startIst).padStart(8)}  ${session.venueName.padEnd(46)}  ${session.format}  sid=${session.sessionId}`,
          );
        }
        if (result.sessions.length > 12) {
          console.log(`    … ${result.sessions.length - 12} more`);
        }

        if (result.availability === "OPEN" && result.sessions.length > 0) {
          const probe = result.sessions[0];
          const map = await provider.getSeatMap(probe);
          if (!map.ok) {
            console.log(`    seat probe failed: ${map.detail}`);
            continue;
          }
          const watched = map.seats.filter(
            (seat) => seat.status === "available" && matchesSeatSpec(seat, target.seats),
          );
          console.log(
            `    seat probe ${prettyTime(probe.startIst)}: ${map.available} free / ${map.seats.length} seats · ${watched.length} match your watch list`,
          );
          if (watched.length > 0) {
            console.log(`      ${watched.slice(0, 24).map((s) => s.key).join(", ")}`);
          }
        }
      }
    }
  } finally {
    ctx.store.close();
  }
}

async function cmdSeats(flags: Map<string, string | true>, positional: string[]): Promise<void> {
  const ctx = createContext(asString(flags.get("config")));
  try {
    const target = pickTarget(ctx.config, asString(flags.get("target")) ?? positional[1]);
    const wantedSession = asString(flags.get("session")) ?? positional[2];
    const wantedProvider = asString(flags.get("provider"));

    const providers = target.providers.filter((p) => !wantedProvider || p === wantedProvider);
    let listed = false;

    for (const providerId of providers) {
      const provider = ctx.providers[providerId];
      if (!provider) continue;

      let result: SessionListResult;
      try {
        result = await provider.listSessions(target);
      } catch (error) {
        console.log(`${providerId}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      if (!wantedSession) {
        listed = true;
        console.log(`\n${providerId.toUpperCase()} — ${result.availability}: ${result.sessions.length} show(s)`);
        for (const session of result.sessions) {
          console.log(
            `  ${prettyTime(session.startIst).padStart(8)}  ${session.venueName.padEnd(46)}  ${session.format}  sid=${session.sessionId}`,
          );
        }
        continue;
      }

      const session = result.sessions.find((s) => s.sessionId === wantedSession);
      if (!session) continue;

      const map = await provider.getSeatMap(session);
      console.log(
        `\n${session.venueName} · ${prettyTime(session.startIst)} · ${session.format} · ${providerId}/${session.sessionId}`,
      );
      if (!map.ok) {
        console.log(`  failed: ${map.detail}`);
        continue;
      }

      console.log(`  ${map.available} free / ${map.seats.length} seats`);
      printRows(map.seats, target);
    }

    if (!listed && !wantedSession) {
      console.log("\nNo sessions returned. The date may not be on sale yet.");
    }
  } finally {
    ctx.store.close();
  }
}

async function cmdNotifyTest(flags: Map<string, string | true>): Promise<void> {
  const ctx = createContext(asString(flags.get("config")));
  try {
    if (!ctx.notifier.configured) {
      console.log("No channels configured. Add these to .env:");
      console.log("  NTFY_TOPIC=your-topic");
      console.log("  or TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...");
      return;
    }
    const results = await ctx.notifier.send({
      title: "🎟️ ticket-radar test",
      message: "If you can read this, alerts are wired up correctly.",
      priority: "default",
      tags: ["white_check_mark"],
    });
    for (const result of results) {
      console.log(
        `${result.channel}: ${result.ok ? "delivered" : `failed — ${result.error ?? "unknown error"}`}`,
      );
    }
  } finally {
    ctx.store.close();
  }
}

function printMonitorRun(run: import("./poll-planner.ts").MonitorRun, verbose: boolean): void {
  console.log(`\n=== ${run.monitorId} (${run.provider})`);
  console.log(`Checked at ${run.startedAt} · next poll ~${run.intervalSec}s · ${run.sessions} show(s) · ${run.alerts} alert(s)`);

  if (run.seats.length > 0) {
    const ok = run.seats.filter((s) => !s.error);
    const free = ok.reduce((sum, s) => sum + s.available, 0);
    console.log(`  seats: ${ok.length}/${run.seats.length} checked · ${free} free`);
    if (verbose) {
      for (const seat of run.seats) {
        const status = seat.error ? `error: ${seat.error}` : `${seat.available} free, ${seat.matched} watched`;
        console.log(`    ${seat.provider}/${seat.sessionId} ${prettyTime(seat.startIst)} ${seat.venueName}: ${status}`);
      }
    }
  }
}

function printRun(run: TargetRun, verbose: boolean): void {
  console.log(`\n=== ${run.label} (${run.targetId})`);
  console.log(`Checked at ${run.startedAt} · next poll ~${run.intervalSec}s`);

  for (const report of run.providers) {
    console.log(
      `\n  ${report.provider.toUpperCase().padEnd(9)} ${pad(report.availability)} ` +
        `${report.sessions} show(s) · ${report.elapsedMs}ms · ${report.detail}`,
    );
  }

  if (run.seats.length > 0) {
    const ok = run.seats.filter((s) => !s.error);
    const free = ok.reduce((sum, s) => sum + s.available, 0);
    const watched = ok.reduce((sum, s) => sum + s.matched, 0);
    console.log(
      `\n  seats: ${ok.length}/${run.seats.length} checked · ${free} free · ${watched} match your watch list`,
    );

    if (verbose) {
      for (const seat of run.seats) {
        const status = seat.error ? `error: ${seat.error}` : `${seat.available} free, ${seat.matched} watched`;
        console.log(
          `    ${seat.provider}/${seat.sessionId} ${prettyTime(seat.startIst)} ${seat.venueName}: ${status}`,
        );
      }
    }
  }

  console.log(`\n  alerts delivered: ${run.alerts}`);
}

function printRows(seats: Seat[], target: WatchTarget): void {
  const rows = new Map<string, Seat[]>();
  for (const seat of seats) {
    const list = rows.get(seat.row) ?? [];
    list.push(seat);
    rows.set(seat.row, list);
  }

  for (const [row, list] of [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const free = list
      .filter((s) => s.status === "available")
      .sort((a, b) => Number(a.number) - Number(b.number));
    const watched = free.filter((s) => matchesSeatSpec(s, target.seats)).length;
    const label = watched > 0 ? `  ← ${watched} watched` : "";
    console.log(
      `  ${row.padEnd(3)} ${String(list.length).padStart(3)} seats · free ${String(free.length).padStart(3)}: ` +
        `${free.map((s) => s.number).join(", ") || "—"}${label}`,
    );
  }
}

function pad(value: Availability): string {
  return value.padEnd(9);
}

function asString(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function usage(): void {
  console.log(`
ticket-radar — seat & showtime alerts for BookMyShow / District

Usage:
  node src/cli.ts <command> [options]

Commands:
  watch                  Run the polling daemon + API (Ctrl+C to stop)
  serve                  Run the API server only
  once                   One real poll: updates state and sends alerts
  doctor                 Read-only connectivity + inventory check
  seats [target] [sid]   List shows, or dump a seat map for one session
  notify-test            Send a test notification to every channel

Options:
  --config <path>        Config file (default: config/watch.json)
  --target <id>          Target id for once/seats
  --session <id>         Session id for seats
  --provider <district|bms>
  --verbose              Extra detail for once

Examples:
  npm run doctor
  npm run seats -- dune3-chennai-2026-12-19 41559
  npm run once
  npm run watch
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
