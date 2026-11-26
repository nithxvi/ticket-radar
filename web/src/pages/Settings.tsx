import { useEffect, useState } from "react";
import { listProfiles, type Profile } from "../api.ts";

export default function Settings() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProfiles().then(setProfiles).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Settings</h1>
      {error && <p className="text-red-600">{error}</p>}
      <section>
        <h2 className="text-lg font-semibold">Notification Profiles</h2>
        {profiles.length === 0 && <p className="text-sm text-slate-500">No profiles.</p>}
        <ul className="mt-2 space-y-2">
          {profiles.map((p) => (
            <li key={p.id} className="rounded border p-3 dark:border-slate-800">
              <div className="font-medium">{p.name} <span className="text-xs text-slate-400">({p.id})</span></div>
              <div className="text-sm text-slate-500">ntfy: {p.ntfyTopic ?? "—"} · telegram: {p.telegramChat ?? "—"}</div>
            </li>
          ))}
        </ul>
      </section>
      <section className="text-sm text-slate-500">
        <p>Phase 4 will add in-app profile creation, password/LAN access, quiet hours.</p>
      </section>
    </div>
  );
}
