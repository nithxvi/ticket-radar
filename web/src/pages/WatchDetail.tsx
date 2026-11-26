import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { getWatch, updateWatch, deleteWatch, testWatch, listWatchSessions, getSeatMap, type Watch } from "../api.ts";
import SeatMapPreview, { type Seat } from "../components/SeatMapPreview.tsx";

export default function WatchDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [watch, setWatch] = useState<Watch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [seatmap, setSeatmap] = useState<{ seats: Seat[] } | null>(null);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [selectedSeats, setSelectedSeats] = useState<string[]>([]);

  const load = async () => {
    if (!id) return;
    try {
      const w = await getWatch(id);
      setWatch(w);
      setSelectedRows(w.seats?.rows ?? []);
      setSelectedSeats(w.seats?.numbers ?? []);
      const s = await listWatchSessions(id);
      setSessions(s);
      if (s.length > 0 && !selectedSession) setSelectedSession(s[0].sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (!selectedSession) return;
    const s = sessions.find((x) => x.sessionId === selectedSession);
    if (!s) return;
    getSeatMap(s.monitorId, selectedSession)
      .then((r) => setSeatmap(r as any))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [selectedSession, sessions]);

  if (!watch) return <p>{error ?? "Loading…"}</p>;

  const toggle = async () => {
    setBusy(true);
    try {
      const w = await updateWatch(watch.id, { enabled: !watch.enabled });
      setWatch(w);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    try {
      await testWatch(watch.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm("Soft-delete this watch?")) return;
    setBusy(true);
    try {
      await deleteWatch(watch.id);
      nav("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveSeats = async () => {
    setBusy(true);
    try {
      const w = await updateWatch(watch.id, {
        seats: { rows: selectedRows, numbers: selectedSeats, minSeats: watch.seats.minSeats },
      });
      setWatch(w);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleRow = (row: string) => {
    setSelectedRows((prev) =>
      prev.includes(row) ? prev.filter((r) => r !== row) : [...prev, row],
    );
  };

  const toggleSeat = (key: string) => {
    setSelectedSeats((prev) =>
      prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key],
    );
  };

  return (
    <div className="space-y-4">
      <Link to="/" className="text-sm text-blue-600">← Back</Link>
      <h1 className="text-2xl font-bold">{watch.name}</h1>
      {error && <p className="text-red-600">{error}</p>}
      <div className="rounded border p-4 dark:border-slate-800">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>Movie: {watch.movie.title}</div>
          <div>Date: {watch.date}</div>
          <div>Providers: {watch.providers.join(", ")}</div>
          <div>Enabled: {String(watch.enabled)}</div>
          <div>Venues: {watch.venues.include.join(", ") || "all"}</div>
          <div>Rows: {watch.seats.rows.join(", ") || "all"}</div>
        </div>
        {watch.status && (
          <div className="mt-3 border-t pt-3 text-sm dark:border-slate-800">
            <div>Availability: {watch.status.availability}</div>
            <div>Sessions: {watch.status.matchedCount}/{watch.status.sessionCount}</div>
            <div>Seats free: {watch.status.seatsFree} · watched free: {watch.status.watchedFree}</div>
            <div>Detail: {watch.status.detail}</div>
            <div>Checked: {new Date(watch.status.lastCheckedAt).toLocaleString()}</div>
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <button disabled={busy} onClick={toggle} className="rounded bg-slate-700 px-3 py-2 text-white disabled:opacity-50">
          {watch.enabled ? "Pause" : "Resume"}
        </button>
        <button disabled={busy} onClick={runTest} className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50">
          Test Poll
        </button>
        <button disabled={busy} onClick={remove} className="rounded bg-red-600 px-3 py-2 text-white disabled:opacity-50">
          Delete
        </button>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Seat map preview & row picker</h2>
        {sessions.length === 0 && <p className="text-sm text-slate-500">No sessions polled yet. Run Test Poll first.</p>}
        {sessions.length > 0 && (
          <div className="flex gap-2">
            <select
              className="rounded border px-3 py-2 dark:bg-slate-900 dark:border-slate-700"
              value={selectedSession ?? ""}
              onChange={(e) => setSelectedSession(e.target.value)}
            >
              {sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.provider} · {s.startIst} · {s.venueName}
                </option>
              ))}
            </select>
          </div>
        )}
        {seatmap && (
          <SeatMapPreview
            seats={seatmap.seats as Seat[]}
            selectedRows={selectedRows}
            selectedSeats={selectedSeats}
            onToggleRow={toggleRow}
            onToggleSeat={toggleSeat}
            watchedRows={selectedRows}
          />
        )}
        <div className="text-sm text-slate-500">
          Selected rows: {selectedRows.join(", ") || "all"} · seats: {selectedSeats.join(", ") || "all"}
        </div>
        <button disabled={busy} onClick={saveSeats} className="rounded bg-green-600 px-3 py-2 text-white disabled:opacity-50">
          Save seat rules
        </button>
      </section>
    </div>
  );
}
