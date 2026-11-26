import { useEffect, useState } from "react";
import { listWatches, type Watch } from "../api.ts";

export function useWatches() {
  const [watches, setWatches] = useState<Watch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        const data = await listWatches();
        if (!cancelled) {
          setWatches(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    if (typeof EventSource !== "undefined") {
      try {
        es = new EventSource("/api/events");
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data) as Watch[];
            if (!cancelled) setWatches(data);
          } catch {
            // ignore
          }
        };
        es.onerror = () => {
          // fall back to polling
          if (!pollTimer) pollTimer = setInterval(load, 5000);
        };
      } catch {
        pollTimer = setInterval(load, 5000);
      }
    } else {
      pollTimer = setInterval(load, 5000);
    }

    return () => {
      cancelled = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, []);

  return { watches, error, loading, reload: listWatches };
}
