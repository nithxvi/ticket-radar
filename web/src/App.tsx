import { useEffect, useState } from "react";
import { Routes, Route, Link } from "react-router-dom";
import { listWatches } from "./api.ts";
import Dashboard from "./pages/Dashboard.tsx";
import NewWatch from "./pages/NewWatch.tsx";
import WatchDetail from "./pages/WatchDetail.tsx";
import Settings from "./pages/Settings.tsx";
import Login from "./pages/Login.tsx";
import Search from "./pages/Search.tsx";
import Alerts from "./pages/Alerts.tsx";

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    listWatches()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) return <div className="p-6">Loading…</div>;
  if (authed === false) return <Login onDone={() => setAuthed(true)} />;

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-lg font-bold">ticket-radar</Link>
          <nav className="flex gap-4 text-sm">
            <Link to="/">Dashboard</Link>
            <Link to="/search">Search</Link>
            <Link to="/alerts">Alerts</Link>
            <Link to="/new">New Watch</Link>
            <Link to="/settings">Settings</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/search" element={<Search />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/new" element={<NewWatch />} />
          <Route path="/watches/:id" element={<WatchDetail />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
