import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "./env.ts";
import type {
  CadenceConfig,
  NotifyConfig,
  ProviderId,
  WatchConfig,
  WatchTarget,
} from "./types.ts";

const DEFAULT_CADENCE: CadenceConfig = {
  baseSec: 120,
  closedSec: 300,
  hotSec: 60,
  jitterPct: 25,
  seatHorizonDays: 60,
};

const DEFAULT_NOTIFY: NotifyConfig = {
  onShowOpen: true,
  onSeatFreed: true,
  maxSeatsPerAlert: 12,
};

const FLOOR_SEC = 60;

export function loadConfig(path = "config/watch.json"): WatchConfig {
  const file = resolve(path);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<WatchConfig>;

  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new Error(`${file}: "targets" must contain at least one watch target`);
  }

  const targets = raw.targets.map((t, i) => normalizeTarget(t, i));
  assertUniqueIds(targets);

  const config: WatchConfig = {
    timezone: raw.timezone ?? "Asia/Kolkata",
    cadence: clampCadence({ ...DEFAULT_CADENCE, ...(raw.cadence ?? {}) }),
    notify: { ...DEFAULT_NOTIFY, ...(raw.notify ?? {}) },
    targets,
  };

  attachEnvChannels(config.notify);
  validate(config);
  return config;
}

function normalizeTarget(raw: WatchTarget, index: number): WatchTarget {
  const where = `targets[${index}]`;
  if (!raw || typeof raw !== "object") throw new Error(`${where}: must be an object`);
  if (!raw.id) throw new Error(`${where}: missing "id"`);
  if (!raw.date) throw new Error(`${where}: missing "date"`);
  if (!raw.movie?.districtContentId) throw new Error(`${where}: missing "movie.districtContentId"`);
  if (!raw.movie?.bmsEventCode) throw new Error(`${where}: missing "movie.bmsEventCode"`);
  if (!raw.city?.districtKey) throw new Error(`${where}: missing "city.districtKey"`);
  if (!raw.city?.bmsRegion) throw new Error(`${where}: missing "city.bmsRegion"`);
  if (!raw.city?.bmsSlug) throw new Error(`${where}: missing "city.bmsSlug"`);

  const providers = (raw.providers ?? ["district", "bms"]) as ProviderId[];
  for (const p of providers) {
    if (p !== "district" && p !== "bms") {
      throw new Error(`${where}: unknown provider "${String(p)}" (expected "district" or "bms")`);
    }
  }

  return {
    ...raw,
    label: raw.label ?? raw.id,
    enabled: raw.enabled !== false,
    providers,
    movie: {
      title: raw.movie.title ?? raw.id,
      districtContentId: String(raw.movie.districtContentId),
      bmsEventCode: String(raw.movie.bmsEventCode).toUpperCase(),
    },
    city: {
      districtKey: String(raw.city.districtKey).toLowerCase(),
      bmsRegion: String(raw.city.bmsRegion).toUpperCase(),
      bmsSlug: String(raw.city.bmsSlug).toLowerCase(),
      lat: raw.city.lat,
      lng: raw.city.lng,
    },
    venues: {
      include: raw.venues?.include ?? [],
      exclude: raw.venues?.exclude ?? [],
    },
    seats: {
      rows: (raw.seats?.rows ?? []).map((r) => String(r).toUpperCase().trim()).filter(Boolean),
      seats: (raw.seats?.seats ?? []).map((s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "")),
    },
  };
}

function clampCadence(cadence: CadenceConfig): CadenceConfig {
  return {
    baseSec: Math.max(FLOOR_SEC, Number(cadence.baseSec) || DEFAULT_CADENCE.baseSec),
    closedSec: Math.max(FLOOR_SEC, Number(cadence.closedSec) || DEFAULT_CADENCE.closedSec),
    hotSec: Math.max(FLOOR_SEC, Number(cadence.hotSec) || DEFAULT_CADENCE.hotSec),
    jitterPct: Math.min(80, Math.max(0, Number(cadence.jitterPct) || 0)),
    seatHorizonDays: Math.max(0, Number(cadence.seatHorizonDays) || DEFAULT_CADENCE.seatHorizonDays),
  };
}

function attachEnvChannels(notify: NotifyConfig): void {
  const topic = env("NTFY_TOPIC");
  if (topic) {
    notify.ntfy = {
      server: env("NTFY_SERVER") ?? notify.ntfy?.server ?? "https://ntfy.sh",
      topic,
      token: env("NTFY_TOKEN"),
    };
  }

  const botToken = env("TELEGRAM_BOT_TOKEN");
  const chatId = env("TELEGRAM_CHAT_ID");
  if (botToken && chatId) {
    notify.telegram = { botToken, chatId };
  }
}

function assertUniqueIds(targets: WatchTarget[]): void {
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.id)) throw new Error(`duplicate target id "${t.id}"`);
    seen.add(t.id);
  }
}

function validate(config: WatchConfig): void {
  for (const t of config.targets) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) {
      throw new Error(`target "${t.id}": date must be YYYY-MM-DD, got "${t.date}"`);
    }
  }
}
