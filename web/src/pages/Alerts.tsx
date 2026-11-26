import { useEffect, useState } from "react";
import { api } from "../api.ts";

export default function Alerts() {
  const [q, setQ] = useState("");
  const [alerts, setAlerts] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async (query: string) => {
    try {
      const url = query ? `/api/alerts?q=${encodeURIComponent(query)}` : "/api/alerts";
      setAlerts(await api<any[]>(url));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { load(""); }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Alerts</h1>
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border px-3 py-2 dark:bg-slate-900 dark:border-slate-700"
          placeholder="Search alerts"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load(q)}
        />
        <button onClick={() => load(q)} className="rounded bg-blue-600 px-3 py-2 text-white">Search</button>
      </div>
      {error && <p className="text-red-600">{error}</p>}
      <ul className="space-y-2">
        {alerts.map((a) => (
          <li key={a.key} className="rounded border p-3 text-sm dark:border-slate-800">
            <div className="font-medium">{a.kind}</div>
            <div className="text-slate-500">{a.key}</div>
            <div className="text-xs text-slate-400">{new Date(a.sentAt).toLocaleString()}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
