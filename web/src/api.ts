export interface Watch {
  id: string;
  name: string;
  owner: string;
  enabled: boolean;
  profileId: string;
  movie: { title: string; districtContentId?: string; bmsEventCode?: string };
  city: { districtKey?: string; bmsRegion?: string; bmsSlug?: string; label?: string };
  date: string;
  providers: string[];
  venues: { include: string[]; exclude: string[] };
  timeWindow: { from?: string; to?: string };
  seats: { rows: string[]; numbers: string[]; minSeats: number };
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  status?: WatchStatus | null;
}

export interface WatchStatus {
  watchId: string;
  availability: "OPEN" | "NOT_OPEN" | "UNKNOWN";
  sessionCount: number;
  matchedCount: number;
  seatsFree: number;
  watchedFree: number;
  lastCheckedAt: string;
  detail: string;
}

export interface Profile {
  id: string;
  name: string;
  ntfyTopic?: string;
  telegramChat?: string;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const listWatches = () => api<Watch[]>("/api/watches");
export const getWatch = (id: string) => api<Watch>(`/api/watches/${id}`);
export const createWatch = (body: any) => api<Watch>("/api/watches", { method: "POST", body: JSON.stringify(body) });
export const updateWatch = (id: string, body: any) => api<Watch>(`/api/watches/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteWatch = (id: string) => api<{ ok: boolean }>(`/api/watches/${id}`, { method: "DELETE" });
export const testWatch = (id: string) => api<any>(`/api/watches/${id}/test`, { method: "POST" });
export const resolveLink = (url: string) => api<any>("/api/resolve-link", { method: "POST", body: JSON.stringify({ url }) });
export const listProfiles = () => api<Profile[]>("/api/profiles");
export const listSessions = (monitorId: string) => api<any[]>(`/api/monitors/${monitorId}/sessions`);
export const listWatchSessions = (watchId: string) => api<any[]>(`/api/watches/${watchId}/sessions`);
export const getSeatMap = (monitorId: string, sessionId: string) =>
  api<{ session: any; ok: boolean; seats: any[]; available: number; detail: string }>(
    `/api/monitors/${monitorId}/sessions/${sessionId}/seatmap`,
  );
export const health = () => api<{ ok: boolean; time: string }>("/api/health");
