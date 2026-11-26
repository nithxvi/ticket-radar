import { Link } from "react-router-dom";
import { useWatches } from "../hooks/useWatches.ts";

function badge(av?: string) {
  if (av === "OPEN") return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200";
  if (av === "NOT_OPEN") return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
  return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200";
}

export default function Dashboard() {
  const { watches, error, loading } = useWatches();

  if (loading) return <p>Loading…</p>;
  if (error) return <p className="text-red-600">{error}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Link to="/new" className="rounded bg-blue-600 px-3 py-1 text-white">New Watch</Link>
      </div>
      {watches.length === 0 && <p>No watches yet.</p>}
      <div className="grid gap-3">
        {watches.map((w) => (
          <Link
            key={w.id}
            to={`/watches/${w.id}`}
            className="block rounded border border-slate-200 p-4 hover:bg-slate-100 dark:border-slate-800 dark:hover:bg-slate-900"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold">{w.name}</div>
                <div className="text-sm text-slate-500">{w.movie.title} · {w.date}</div>
              </div>
              <span className={`rounded px-2 py-1 text-xs font-medium ${badge(w.status?.availability)}`}>
                {w.status?.availability ?? "—"}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-sm text-slate-600 dark:text-slate-300">
              <div>Sessions: {w.status?.matchedCount ?? 0}/{w.status?.sessionCount ?? 0}</div>
              <div>Seats free: {w.status?.seatsFree ?? 0}</div>
              <div>Watched free: {w.status?.watchedFree ?? 0}</div>
            </div>
            {w.status?.lastCheckedAt && (
              <div className="mt-1 text-xs text-slate-400">checked {new Date(w.status.lastCheckedAt).toLocaleString()}</div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
