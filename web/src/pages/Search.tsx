import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.ts";

export default function Search() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const run = async (query: string) => {
    try {
      const data = await api<any[]>(`/api/search?q=${encodeURIComponent(query)}`);
      setResults(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { run(""); }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Search watches</h1>
      <input
        className="w-full rounded border px-3 py-2 dark:bg-slate-900 dark:border-slate-700"
        placeholder="Film, city, or watch name"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && run(q)}
      />
      <button onClick={() => run(q)} className="rounded bg-blue-600 px-3 py-2 text-white">Search</button>
      {error && <p className="text-red-600">{error}</p>}
      <div className="grid gap-2">
        {results.map((w) => (
          <Link key={w.id} to={`/watches/${w.id}`} className="block rounded border p-3 hover:bg-slate-100 dark:border-slate-800 dark:hover:bg-slate-900">
            <div className="font-semibold">{w.name}</div>
            <div className="text-sm text-slate-500">{w.movie.title} · {w.city?.districtKey ?? ""} · {w.date}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
