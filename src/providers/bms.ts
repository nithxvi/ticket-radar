import { createDecipheriv } from "node:crypto";
import { Impit } from "impit";
import type {
  Provider,
  Seat,
  SeatMapResult,
  SessionListResult,
  SessionRecord,
  WatchTarget,
} from "../types.ts";
import { isoToDateCode } from "../time.ts";
import type { Logger } from "../log.ts";

/**
 * BMS encrypts the GETSEATLAYOUT payload with AES-256-CBC, a zero IV, and a
 * static key that ships inside the seat-layout bundle. Verified against a live
 * 658-seat map; no browser or key handshake is involved.
 */
export const SEAT_LAYOUT_KEY = "kYp3s6v9y$B&E)H+MbQeThWmZq4t7w!z";

const WEB = "https://in.bookmyshow.com";
const TRANS = "https://services-in.bookmyshow.com/doTrans.aspx";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

interface BmsShowtime {
  sessionId?: string;
  showDateTime?: string;
  showDateCode?: string;
  showTime?: string;
  attributes?: string;
  availStatus?: string;
}

interface BmsContext {
  venueCode?: string;
  venueName?: string;
}

export class BmsProvider implements Provider {
  readonly id = "bms" as const;

  private readonly client = new Impit({ browser: "chrome" });
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  async listSessions(target: WatchTarget): Promise<SessionListResult> {
    const dateCode = isoToDateCode(target.date);
    const url =
      `${WEB}/api/movies-data/v5/showtimes-by-event/primary-dynamic` +
      `?etCodes=${encodeURIComponent(target.movie.bmsEventCode)}` +
      `&dateCode=${dateCode}` +
      `&regionCode=${encodeURIComponent(target.city.bmsRegion)}`;

    let response: Awaited<ReturnType<Impit["fetch"]>>;
    try {
      response = await this.client.fetch(url, {
        headers: this.headers(target),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return {
        availability: "UNKNOWN",
        sessions: [],
        detail: `request failed: ${messageOf(error)}`,
      };
    }

    if (response.status !== 200) {
      return { availability: "UNKNOWN", sessions: [], detail: `HTTP ${response.status}` };
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { availability: "UNKNOWN", sessions: [], detail: "response was not JSON" };
    }

    const found = this.collectShowtimes(json);
    const forDate = found.filter((f) => f.dateCode === dateCode);

    if (found.length > 0 && forDate.length === 0) {
      const dates = [...new Set(found.map((f) => f.dateCode))].slice(0, 3).join(", ");
      return {
        availability: "UNKNOWN",
        sessions: [],
        detail: `provider answered for ${dates}, not ${dateCode} (silent date fallback)`,
        observedDate: dates,
      };
    }

    if (forDate.length === 0) {
      return {
        availability: "NOT_OPEN",
        sessions: [],
        detail: "no showtime widgets for this date",
        observedDate: dateCode,
      };
    }

    const sessions: SessionRecord[] = [];
    for (const entry of forDate) {
      const show = entry.showtime;
      if (!show.sessionId || !show.showDateTime) continue;

      const venueName = entry.ctx.venueName ?? entry.ctx.venueCode ?? "BMS venue";
      if (!this.venueAllowed(venueName, target)) continue;

      const startIst = `${show.showDateTime.slice(8, 10)}:${show.showDateTime.slice(10, 12)}`;

      sessions.push({
        provider: "bms",
        venueCode: entry.ctx.venueCode ?? "",
        venueName,
        sessionId: String(show.sessionId),
        date: target.date,
        startIst,
        format: show.attributes || "—",
        url:
          `${WEB}/movies/${target.city.bmsSlug}/seat-layout/` +
          `${target.movie.bmsEventCode}/${entry.ctx.venueCode}/${show.sessionId}/${dateCode}`,
        extra: {
          venueCode: entry.ctx.venueCode ?? "",
          eventCode: target.movie.bmsEventCode,
          dateCode,
          regionCode: target.city.bmsRegion,
          regionSlug: target.city.bmsSlug,
          latitude: target.city.lat ?? 13.0569,
          longitude: target.city.lng ?? 80.2425,
        },
      });
    }

    sessions.sort((a, b) => a.startIst.localeCompare(b.startIst));

    return {
      availability: "OPEN",
      sessions,
      detail: `${forDate.length} showtimes across ${new Set(forDate.map((f) => f.ctx.venueCode)).size} venues`,
      observedDate: dateCode,
    };
  }

  async getSeatMap(session: SessionRecord): Promise<SeatMapResult> {
    const form = new FormData();
    const fields: Record<string, string> = {
      strAppCode: "WEB",
      lngTransactionIdentifier: "0",
      strCommand: "GETSEATLAYOUT",
      strVenueCode: String(session.extra.venueCode ?? session.venueCode),
      strParam1: session.sessionId,
      strParam2: "WEB",
      strParam3: "",
      strParam4: "",
      strParam5: "Y",
      strParam6: "N",
      strParam7: "N",
      strParam8: "",
      strParam9: "",
      strParam10: "",
      strFormat: "json",
    };
    for (const [key, value] of Object.entries(fields)) form.append(key, value);

    let response: Awaited<ReturnType<Impit["fetch"]>>;
    try {
      response = await this.client.fetch(TRANS, {
        method: "POST",
        headers: this.transHeaders(session),
        body: form,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return { ok: false, seats: [], available: 0, detail: `request failed: ${messageOf(error)}` };
    }

    if (response.status !== 200) {
      return { ok: false, seats: [], available: 0, detail: `HTTP ${response.status}` };
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, seats: [], available: 0, detail: "doTrans response was not JSON" };
    }

    const envelope = (json as { BookMyShow?: { blnSuccess?: unknown; strData?: unknown; strException?: unknown } })
      .BookMyShow;
    if (!envelope || String(envelope.blnSuccess) !== "true") {
      return {
        ok: false,
        seats: [],
        available: 0,
        detail: `doTrans refused: ${String(envelope?.strException ?? "unknown")}`,
      };
    }
    if (typeof envelope.strData !== "string") {
      return { ok: false, seats: [], available: 0, detail: "doTrans returned no strData" };
    }

    let plain: string;
    try {
      plain = decryptSeatLayout(envelope.strData);
    } catch (error) {
      return { ok: false, seats: [], available: 0, detail: `decrypt failed: ${messageOf(error)}` };
    }

    const parsed = parseSeatLayout(plain);
    if (parsed.length === 0) {
      return { ok: false, seats: [], available: 0, detail: "decrypted layout had no seats" };
    }

    return {
      ok: true,
      seats: parsed,
      available: parsed.filter((s) => s.status === "available").length,
      detail: `${parsed.length} seats decrypted`,
    };
  }

  /** Walk the widget tree, tracking the nearest venue context. */
  private collectShowtimes(root: unknown): Array<{ showtime: BmsShowtime; ctx: BmsContext; dateCode: string }> {
    const out: Array<{ showtime: BmsShowtime; ctx: BmsContext; dateCode: string }> = [];

    const visit = (node: unknown, ctx: BmsContext): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child, ctx);
        return;
      }

      const record = node as { additionalData?: Record<string, unknown> };
      const extra = record.additionalData;
      let nextCtx = ctx;

      if (extra && typeof extra.venueCode === "string") {
        nextCtx = {
          venueCode: extra.venueCode,
          venueName: typeof extra.venueName === "string" ? extra.venueName : ctx.venueName,
        };
      }

      if (extra && typeof extra.sessionId === "string" && typeof extra.showDateTime === "string") {
        const showDateTime = extra.showDateTime;
        out.push({
          showtime: {
            sessionId: extra.sessionId,
            showDateTime,
            showDateCode: typeof extra.showDateCode === "string" ? extra.showDateCode : undefined,
            showTime: typeof extra.showTime === "string" ? extra.showTime : undefined,
            attributes: typeof extra.attributes === "string" ? extra.attributes : undefined,
            availStatus: extra.availStatus === undefined ? undefined : String(extra.availStatus),
          },
          ctx: nextCtx,
          dateCode:
            (typeof extra.showDateCode === "string" ? extra.showDateCode : undefined) ??
            showDateTime.slice(0, 8),
        });
      }

      for (const value of Object.values(node as Record<string, unknown>)) visit(value, nextCtx);
    };

    visit(root, {});
    return out;
  }

  private venueAllowed(name: string, target: WatchTarget): boolean {
    const lower = name.toLowerCase();
    const exclude = target.venues.exclude ?? [];
    if (exclude.some((v) => lower.includes(v.toLowerCase()))) return false;
    const include = target.venues.include ?? [];
    if (include.length === 0) return true;
    return include.some((v) => lower.includes(v.toLowerCase()));
  }

  private headers(target: WatchTarget): Record<string, string> {
    return {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-IN,en;q=0.9",
      "user-agent": UA,
      origin: WEB,
      referer: `${WEB}/movies/${target.city.bmsSlug}`,
      "x-region-code": target.city.bmsRegion,
      "x-region-slug": target.city.bmsSlug,
      "x-app-code": "WEB",
      "x-platform": "WEB",
      "x-platform-code": "WEB",
      "x-bms-id": bmsId(),
      "sec-ch-ua": '"Chromium";v="141", "Not?A_Brand";v="24", "Google Chrome";v="141"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    };
  }

  private transHeaders(session: SessionRecord): Record<string, string> {
    return {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-IN,en;q=0.9",
      "user-agent": UA,
      origin: WEB,
      referer: `${WEB}/`,
      "x-region-code": String(session.extra.regionCode ?? ""),
      "x-region-slug": String(session.extra.regionSlug ?? ""),
      "x-app-code": "WEB",
      "x-platform": "WEB",
      "x-platform-code": "WEB",
      "x-latitude": String(session.extra.latitude ?? ""),
      "x-longitude": String(session.extra.longitude ?? ""),
      "x-bms-id": bmsId(),
      "sec-ch-ua": '"Chromium";v="141", "Not?A_Brand";v="24", "Google Chrome";v="141"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
    };
  }
}

export function decryptSeatLayout(strData: string): string {
  const decipher = createDecipheriv(
    "aes-256-cbc",
    Buffer.from(SEAT_LAYOUT_KEY, "utf8"),
    Buffer.alloc(16),
  );
  return decipher.update(Buffer.from(strData, "base64"), undefined, "utf8") + decipher.final("utf8");
}

/**
 * Layout format: `<areas>||<rows>`
 *   area: `desc:id:code:num:selected:current[:sofa]`
 *   row:  `rowId:rowLabel:token:token:...`
 *   token: `<areaId><status><internalSeat>+<cinemaSeat>`
 * `cinemaSeat` is the number printed on the seat; `internalSeat` is padded.
 */
export function parseSeatLayout(plain: string): Seat[] {
  const [areaPart, rowPart] = plain.split("||");
  if (!rowPart) return [];

  const areaNames = new Map<string, string>();
  for (const entry of (areaPart ?? "").split("|").filter(Boolean)) {
    const [description, id] = entry.split(":");
    if (id) areaNames.set(id, description || id);
  }

  const seats: Seat[] = [];
  for (const rowEntry of rowPart.split("|").filter(Boolean)) {
    const [rowId, rowLabelRaw, ...tokens] = rowEntry.split(":");
    const rowLabel = rowLabelRaw || rowId || "?";
    for (const token of tokens) {
      const [head, cinemaSeat] = token.split("+");
      if (!head || head.length < 2) continue;

      const areaId = head.charAt(0);
      const statusCode = Number.parseInt(head.charAt(1), 10);
      if (statusCode === 0) continue; // gangway spacing
      if (Number.isNaN(statusCode)) continue;

      const internal = head.slice(2).replace(/^0+(?=\d)/, "");
      const number = cinemaSeat && cinemaSeat !== "0" && cinemaSeat !== "00" ? cinemaSeat : internal;
      if (!number) continue;

      seats.push({
        key: `${rowLabel}${number}`,
        area: areaNames.get(areaId) ?? areaId,
        row: rowLabel,
        number,
        status: statusCode === 1 || statusCode === 4 ? "available" : "booked",
      });
    }
  }

  return seats;
}

function bmsId(): string {
  return `1.${Math.floor(Math.random() * 9e8 + 1e8)}.${Date.now()}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
