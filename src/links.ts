import type { ProviderId } from "./types.ts";

export interface ParsedLink {
  provider: ProviderId | "unknown";
  movieTitle?: string;
  districtContentId?: string;
  bmsEventCode?: string;
  districtCityKey?: string;
  bmsSlug?: string;
  bmsRegion?: string;
  date?: string;
  venueCode?: string;
  sessionId?: string;
}

/** BMS region codes we know; extend as needed. */
const BMS_REGION_BY_SLUG: Record<string, string> = {
  chennai: "CHN",
  hyderabad: "HYD",
  mumbai: "MUM",
  bengaluru: "BLR",
  bangalore: "BLR",
  delhi: "NCR",
  "new-delhi": "NCR",
  gurugram: "NCR",
  noida: "NCR",
  pune: "PUN",
  kolkata: "KOL",
  ahmedabad: "AHM",
  kochi: "KOC",
  coimbatore: "COB",
  madurai: "MDU",
  jaipur: "JAI",
  lucknow: "LKO",
  chandigarh: "CHD",
};

export function parseTicketLink(raw: string): ParsedLink {
  const url = raw.trim();
  if (!url) return { provider: "unknown" };

  const district = parseDistrict(url);
  if (district) return district;

  const bms = parseBms(url);
  if (bms) return bms;

  return { provider: "unknown" };
}

function parseDistrict(url: string): ParsedLink | null {
  const movieMatch = /\/movies\/([^/?#]+)-MV(\d+)/i.exec(url);
  const loose = /\bMV(\d+)\b/i.exec(url);
  if (!movieMatch && !loose) return null;

  const contentId = movieMatch?.[2] ?? loose?.[1] ?? "";
  if (!contentId) return null;

  let titleSlug: string | undefined;
  let citySlug: string | undefined;

  const prefix = movieMatch?.[1];
  if (prefix) {
    const cityMatch = /-movie-tickets-in-([a-z0-9-]+)$/i.exec(prefix);
    if (cityMatch) {
      citySlug = cityMatch[1];
      titleSlug = prefix.slice(0, cityMatch.index);
    } else {
      titleSlug = prefix.replace(/-movie-tickets-in-.*$/i, "");
    }
  }

  const cityParam = /[?&](?:city_key|cityKey)=([a-z0-9-]+)/i.exec(url)?.[1];
  const date =
    /[?&]fromdate=(\d{4}-\d{2}-\d{2})/i.exec(url)?.[1] ??
    /[?&]date=(\d{4}-\d{2}-\d{2})/i.exec(url)?.[1];

  return {
    provider: "district",
    movieTitle: titleSlug ? titleFromSlug(titleSlug) : undefined,
    districtContentId: contentId,
    districtCityKey: (cityParam ?? citySlug)?.toLowerCase(),
    date,
  };
}

function parseBms(url: string): ParsedLink | null {
  const eventCode = /\b(ET\d{6,})\b/i.exec(url)?.[1]?.toUpperCase();
  if (!eventCode) return null;

  const citySlug = /\/movies\/([a-z0-9-]+)\//i.exec(url)?.[1]?.toLowerCase();
  const titleSlug = new RegExp(
    `/movies/[a-z0-9-]+/([a-z0-9-]+)/${eventCode}`,
    "i",
  ).exec(url)?.[1];

  const seatMatch = new RegExp(
    `/seat-layout/${eventCode}/([A-Z0-9]+)/(\\d+)/(\\d{8})`,
    "i",
  ).exec(url);

  const dateCode =
    seatMatch?.[3] ??
    /[?&]dateCode=(\d{8})/i.exec(url)?.[1] ??
    /\/movies\/[a-z0-9-]+\/[a-z0-9-]+\/[A-Z0-9]+\/(\d{8})/i.exec(url)?.[1];

  const date = dateCode ? `${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}` : undefined;

  return {
    provider: "bms",
    movieTitle: titleSlug ? titleFromSlug(titleSlug) : undefined,
    bmsEventCode: eventCode,
    bmsSlug: citySlug,
    bmsRegion: citySlug ? BMS_REGION_BY_SLUG[citySlug] : undefined,
    date,
    venueCode: seatMatch?.[1],
    sessionId: seatMatch?.[2],
  };
}

export function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}
