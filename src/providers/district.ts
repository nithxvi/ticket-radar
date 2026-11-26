import { randomUUID } from "node:crypto";
import type {
  Provider,
  Seat,
  SeatMapResult,
  SessionListResult,
  SessionRecord,
  WatchTarget,
} from "../types.ts";
import { toIstStamp } from "../time.ts";
import type { Logger } from "../log.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const BASE = "https://www.district.in";
const MOVIE_URL = `${BASE}/gw/consumer/movies/v5/movie`;
const SEAT_URL = `${BASE}/gw/consumer/movies/v1/select-seat?version=3&site_id=1&channel=web&child_site_id=1&platform=district`;
const LOGIN_URL = `${BASE}/gw/auth/skip_login`;

interface DistrictSession {
  sid?: string;
  pid?: number;
  cid?: number;
  mid?: string;
  showTime?: string;
  scrnFmt?: string;
  mcd?: string;
  audi?: string;
  avail?: number;
  total?: number;
  areas?: Array<{ code?: string; label?: string }>;
}

interface DistrictCinema {
  id?: number;
  cinemaInfo?: { name?: string };
  sessions?: DistrictSession[];
}

interface DistrictSeat {
  GridSeatNum?: number;
  SeatStatus?: string;
  seatNumber?: number | string;
  displaySeatNumber?: string;
}

export class DistrictProvider implements Provider {
  readonly id = "district" as const;

  private readonly cookies = new Map<string, string>();
  private token: { value: string; expiresAt: number } | null = null;
  private tokenPromise: Promise<void> | null = null;

  private readonly deviceId: string;
  private readonly log: Logger;

  constructor(deviceId: string, log: Logger) {
    this.deviceId = deviceId;
    this.log = log;
  }

  async listSessions(target: WatchTarget): Promise<SessionListResult> {
    const params = new URLSearchParams({
      version: "3",
      site_id: "1",
      channel: "mweb",
      child_site_id: "1",
      platform: "district",
      movieCode: "",
      city_key: target.city.districtKey,
      content_id: target.movie.districtContentId,
      date: target.date,
      latitude: String(target.city.lat ?? 13.0569),
      longitude: String(target.city.lng ?? 80.2425),
      cinemaOrderLogic: "3",
    });

    const token = await this.ensureToken();
    let response: Response;
    try {
      response = await fetch(`${MOVIE_URL}?${params}`, {
        headers: this.listHeaders(target, token),
        signal: AbortSignal.timeout(20_000),
      });
      this.absorb(response);
    } catch (error) {
      return {
        availability: "UNKNOWN",
        sessions: [],
        detail: `request failed: ${messageOf(error)}`,
      };
    }

    if (response.status === 204) {
      return { availability: "NOT_OPEN", sessions: [], detail: "HTTP 204 (no shows)" };
    }

    if (response.status !== 200) {
      return {
        availability: "UNKNOWN",
        sessions: [],
        detail: `HTTP ${response.status}`,
      };
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { availability: "UNKNOWN", sessions: [], detail: "response was not JSON" };
    }

    const page = (json as { pageData?: { nearbyCinemas?: DistrictCinema[]; farCinemas?: DistrictCinema[] } })
      .pageData;
    const cinemas = [...(page?.nearbyCinemas ?? []), ...(page?.farCinemas ?? [])];

    const allSessions = cinemas.flatMap((cinema) =>
      (cinema.sessions ?? []).map((session) => ({ cinema, session })),
    );

    if (allSessions.length === 0) {
      return {
        availability: "NOT_OPEN",
        sessions: [],
        detail: `0 sessions across ${cinemas.length} cinemas`,
        observedDate: target.date,
      };
    }

    const sessions: SessionRecord[] = [];
    for (const { cinema, session } of allSessions) {
      const venueName = cinema.cinemaInfo?.name ?? `Cinema ${cinema.id ?? "?"}`;
      if (!this.venueAllowed(venueName, target)) continue;
      if (!session.sid) continue;

      const stamp = toIstStamp(String(session.showTime ?? ""));
      if (stamp.date && stamp.date !== target.date) continue;

      sessions.push({
        provider: "district",
        venueCode: String(cinema.id ?? session.cid ?? ""),
        venueName,
        sessionId: String(session.sid),
        date: stamp.date || target.date,
        startIst: stamp.time,
        format: session.scrnFmt || "—",
        url: this.movieUrl(target),
        extra: {
          cinemaId: Number(cinema.id ?? session.cid),
          providerId: Number(session.pid),
          moviecode: String(session.mid ?? ""),
          movieFormatCode: String(session.mcd ?? "").toLowerCase(),
          screenFormat: String(session.scrnFmt ?? ""),
          sessionDate: stamp.date || target.date,
          contentId: target.movie.districtContentId,
          cityKey: target.city.districtKey,
        },
      });
    }

    sessions.sort((a, b) => a.startIst.localeCompare(b.startIst));

    return {
      availability: "OPEN",
      sessions,
      detail: `${allSessions.length} sessions across ${cinemas.length} cinemas`,
      observedDate: target.date,
    };
  }

  async getSeatMap(session: SessionRecord): Promise<SeatMapResult> {
    const body = {
      cinemaId: Number(session.extra.cinemaId),
      sessionId: session.sessionId,
      providerId: Number(session.extra.providerId),
      screenOnTop: true,
      freeSeating: false,
      screenFormat: String(session.extra.screenFormat ?? ""),
      moviecode: String(session.extra.moviecode ?? ""),
      config: { socialDistancing: 1 },
      contentId: String(session.extra.contentId ?? ""),
      cityKey: String(session.extra.cityKey ?? ""),
      sessionDate: String(session.extra.sessionDate ?? session.date),
      fetchSessions: true,
      movieFormatCode: String(session.extra.movieFormatCode ?? ""),
    };

    const token = await this.ensureToken();
    let response: Response;
    try {
      response = await fetch(SEAT_URL, {
        method: "POST",
        headers: this.seatHeaders(token),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      this.absorb(response);
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
      return { ok: false, seats: [], available: 0, detail: "response was not JSON" };
    }

    const layout = (
      json as {
        seatLayout?: {
          colAreas?: {
            objArea?: Array<{
              AreaCode?: string;
              AreaDesc?: string;
              objRow?: Array<{ PhyRowId?: string; GridRowId?: number; objSeat?: DistrictSeat[] }>;
            }>;
          };
        };
      }
    ).seatLayout;
    const areas = layout?.colAreas?.objArea ?? [];
    if (areas.length === 0) {
      return { ok: false, seats: [], available: 0, detail: "empty seat layout" };
    }

    const byKey = new Map<string, Seat>();
    for (const area of areas) {
      const areaLabel = area.AreaDesc || area.AreaCode || "—";
      for (const row of area.objRow ?? []) {
        const rowLabel = String(row.PhyRowId ?? row.GridRowId ?? "?");
        for (const raw of row.objSeat ?? []) {
          const number = String(raw.displaySeatNumber ?? raw.seatNumber ?? raw.GridSeatNum ?? "");
          if (!number) continue;
          const seat: Seat = {
            key: `${rowLabel}${number}`,
            area: areaLabel,
            row: rowLabel,
            number,
            status: raw.SeatStatus === "0" ? "available" : "booked",
          };
          const existing = byKey.get(seat.key);
          // Keep the most optimistic copy if a seat key appears twice.
          if (!existing || (existing.status === "booked" && seat.status === "available")) {
            byKey.set(seat.key, seat);
          }
        }
      }
    }

    const seats = [...byKey.values()];
    return {
      ok: true,
      seats,
      available: seats.filter((s) => s.status === "available").length,
      detail: `${areas.length} areas`,
    };
  }

  private venueAllowed(name: string, target: WatchTarget): boolean {
    const lower = name.toLowerCase();
    const exclude = target.venues.exclude ?? [];
    if (exclude.some((v) => lower.includes(v.toLowerCase()))) return false;
    const include = target.venues.include ?? [];
    if (include.length === 0) return true;
    return include.some((v) => lower.includes(v.toLowerCase()));
  }

  private movieUrl(target: WatchTarget): string {
    const slug = target.movie.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `${BASE}/movies/${slug}-movie-tickets-in-${target.city.districtKey}-MV${target.movie.districtContentId}?fromdate=${target.date}`;
  }

  private listHeaders(target: WatchTarget, token: string): Record<string, string> {
    return {
      accept: "*/*",
      "accept-language": "en-IN,en;q=0.9",
      "user-agent": UA,
      api_source: "district",
      "x-app-type": "ed_mweb",
      "x-guest-token": token,
      "x-request-id": randomUUID(),
      referer: `${BASE}/movies/${target.city.districtKey}`,
      ...this.cookieHeader(),
    };
  }

  private seatHeaders(token: string): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      "accept-language": "en-IN,en;q=0.9",
      "user-agent": UA,
      "x-device-id": this.deviceId,
      "x-guest-token": token,
      "x-app-type": "ed_web",
      "x-client-id": "district-web",
      "x-app-version": "11.11.1",
      api_source: "district",
      "x-request-id": randomUUID(),
      ...this.cookieHeader(),
    };
  }

  private cookieHeader(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    return {
      cookie: [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    };
  }

  private absorb(response: Response): void {
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1));
    }
  }

  /**
   * District hands out a ~6h guest token. Fetch it lazily, refresh a few
   * minutes early, and de-duplicate concurrent refreshes. A synthetic token is
   * a usable fallback if the handshake itself is failing.
   */
  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (!this.tokenPromise) {
      this.tokenPromise = this.refreshToken().finally(() => {
        this.tokenPromise = null;
      });
    }
    await this.tokenPromise;
    return this.token?.value ?? syntheticToken();
  }

  private async refreshToken(): Promise<void> {
    try {
      const response = await fetch(LOGIN_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "accept-language": "en-IN,en;q=0.9",
          "user-agent": UA,
          "x-device-id": this.deviceId,
          "x-guest-token": syntheticToken(),
          "x-app-type": "ed_web",
          "x-client-id": "district-web",
          "x-app-version": "11.11.1",
          api_source: "district",
          "x-request-id": randomUUID(),
          ...this.cookieHeader(),
        },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      });
      this.absorb(response);
      if (!response.ok) {
        this.log.warn(`guest token refresh HTTP ${response.status}`);
        return;
      }
      const json = (await response.json()) as {
        token?: { guest_token?: string; expires_at?: number | string };
      };
      const value = json.token?.guest_token;
      if (!value) {
        this.log.warn("guest token response had no guest_token");
        return;
      }
      const raw = Number(json.token?.expires_at);
      const expiresAt = Number.isFinite(raw) && raw > 0
        ? raw > 1e12
          ? raw
          : raw * 1000
        : Date.now() + 5 * 3600_000;
      // Refresh five minutes early.
      this.token = { value, expiresAt: expiresAt - 5 * 60_000 };
      this.cookies.set("x-guest-token", value);
    } catch (error) {
      this.log.warn(`guest token refresh failed: ${messageOf(error)}`);
    }
  }
}

function syntheticToken(): string {
  let digits = "";
  for (let i = 0; i < 18; i++) digits += Math.floor(Math.random() * 10);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 11; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${Date.now()}_${digits}_${suffix}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
