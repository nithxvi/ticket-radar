const IST = "Asia/Kolkata";

const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export interface IstStamp {
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm (24h) */
  time: string;
}

function stampFrom(date: Date): IstStamp {
  const parts = partsFmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  // `hour` can come back as "24" at midnight in some ICU versions.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${hour}:${get("minute")}` };
}

/** Parse a provider timestamp that is either UTC (`...T04:10`) or zoned ISO. */
export function toIstStamp(raw: string): IstStamp {
  const trimmed = raw.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const normalised = hasZone ? trimmed : `${trimmed}Z`;
  const d = new Date(normalised);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  return stampFrom(d);
}

export function nowIst(): IstStamp {
  return stampFrom(new Date());
}

/** `20261219` -> `2026-12-19` */
export function dateCodeToIso(code: string): string {
  if (!/^\d{8}$/.test(code)) return code;
  return `${code.slice(0, 4)}-${code.slice(4, 6)}-${code.slice(6, 8)}`;
}

/** `2026-12-19` -> `20261219` */
export function isoToDateCode(iso: string): string {
  return iso.replaceAll("-", "");
}

export function daysUntil(isoDate: string, from = new Date()): number {
  const target = Date.parse(`${isoDate}T00:00:00+05:30`);
  if (Number.isNaN(target)) return Number.POSITIVE_INFINITY;
  const todayIst = nowIst().date;
  const today = Date.parse(`${todayIst}T00:00:00+05:30`);
  return Math.round((target - today) / 86_400_000);
}

/** "09:40" -> "9:40 AM" */
export function prettyTime(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const hour = Number(m[1]);
  const minute = m[2];
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${minute} ${suffix}`;
}

/** "2026-12-19" -> "Sat, 19 Dec 2026" */
export function prettyDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}

export function isoNow(): string {
  return new Date().toISOString();
}
