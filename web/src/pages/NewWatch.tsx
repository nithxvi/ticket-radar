import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createWatch, resolveLink } from "../api.ts";

export default function NewWatch() {
  const nav = useNavigate();
  const [url, setUrl] = useState("");
  const [resolved, setResolved] = useState<any>(null);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [rows, setRows] = useState("H, J, K, L");
  const [venues, setVenues] = useState("");
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [profileId, setProfileId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doResolve = async () => {
    setError(null);
    try {
      const r = await resolveLink(url);
      setResolved(r);
      if (r.movieTitle) setName(r.movieTitle);
      if (r.date) setDate(r.date);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: any = {
        name: name || resolved?.movieTitle || "Watch",
        owner: "me",
        profileId: profileId || undefined,
        movie: {
          title: name || resolved?.movieTitle || "Untitled",
          districtContentId: resolved?.districtContentId,
          bmsEventCode: resolved?.bmsEventCode,
        },
        city: {
          districtKey: resolved?.districtCityKey,
          bmsRegion: resolved?.bmsRegion,
          bmsSlug: resolved?.bmsSlug,
        },
        date: date || resolved?.date,
        providers: resolved?.provider && resolved.provider !== "unknown" ? [resolved.provider] : ["district", "bms"],
        venues: { include: venues.split(",").map((s) => s.trim()).filter(Boolean), exclude: [] },
        timeWindow: { from: timeFrom || undefined, to: timeTo || undefined },
        seats: { rows: rows.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean), numbers: [], minSeats: 1 },
      };
      const w = await createWatch(body);
      nav(`/watches/${w.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">New Watch</h1>
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border px-3 py-2 dark:bg-slate-900 dark:border-slate-700"
          placeholder="Paste BMS or District link"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button onClick={doResolve} className="rounded bg-slate-700 px-3 py-2 text-white">Resolve</button>
      </div>
      {resolved && (
        <pre className="rounded bg-slate-100 p-3 text-xs dark:bg-slate-900">{JSON.stringify(resolved, null, 2)}</pre>
      )}
      <form onSubmit={submit} className="space-y-3">
        <input className="w-full rounded border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="w-full rounded border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="Date YYYY-MM-DD" value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="w-full rounded border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="Rows (comma)" value={rows} onChange={(e) => setRows(e.target.value)} />
        <input className="w-full rounded border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="Venues include (comma)" value={venues} onChange={(e) => setVenues(e.target.value)} />
        <div className="flex gap-2">
          <input className="flex-1 rounded border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="Time from HH:mm" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} />
          <input className="flex-1 rounded border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="Time to HH:mm" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} />
        </div>
        <input className="w-full rounded border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="Profile ID (optional)" value={profileId} onChange={(e) => setProfileId(e.target.value)} />
        {error && <p className="text-red-600">{error}</p>}
        <button disabled={busy} className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
          {busy ? "Creating…" : "Create Watch"}
        </button>
      </form>
    </div>
  );
}
