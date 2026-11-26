import type { WatchConfig } from "./types.ts";
import type { Store } from "./store.ts";

// ensureDefaultProfile defined locally to avoid circular imports with server.ts.
export function ensureDefaultProfile(store: Store, config?: WatchConfig): string {
  const existing = store.listProfiles();
  if (existing.length > 0) return existing[0].id;
  const profile = {
    id: "default",
    name: "Default",
    ntfyTopic: config?.notify?.ntfy?.topic,
    telegramChat: config?.notify?.telegram?.chatId,
  };
  store.saveProfile(profile);
  return profile.id;
}

export function seedWatchesFromConfig(store: Store, config: WatchConfig): void {
  if (store.countWatches() > 0) return;
  const profileId = ensureDefaultProfile(store, config);
  for (const target of config.targets) {
    store.createWatch({
      id: target.id,
      name: target.label ?? target.id,
      owner: "me",
      enabled: target.enabled !== false,
      profileId,
      movie: {
        title: target.movie.title,
        districtContentId: target.movie.districtContentId,
        bmsEventCode: target.movie.bmsEventCode,
      },
      city: {
        districtKey: target.city.districtKey,
        bmsRegion: target.city.bmsRegion,
        bmsSlug: target.city.bmsSlug,
        label: target.city.districtKey,
      },
      date: target.date,
      providers: target.providers,
      venues: {
        include: target.venues?.include ?? [],
        exclude: target.venues?.exclude ?? [],
      },
      timeWindow: {},
      seats: {
        rows: target.seats?.rows ?? [],
        numbers: target.seats?.seats ?? [],
        minSeats: 1,
      },
    });
  }
}
