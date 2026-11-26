import { useMemo } from "react";

export interface Seat {
  key: string;
  area: string;
  row: string;
  number: string;
  status: "available" | "booked";
}

interface Props {
  seats: Seat[];
  selectedRows?: string[];
  selectedSeats?: string[];
  onToggleRow?: (row: string) => void;
  onToggleSeat?: (key: string) => void;
  watchedRows?: string[];
}

export default function SeatMapPreview({ seats, selectedRows = [], selectedSeats = [], onToggleRow, onToggleSeat, watchedRows }: Props) {
  const rows = useMemo(() => {
    const map = new Map<string, Seat[]>();
    for (const s of seats) {
      const list = map.get(s.row) ?? [];
      list.push(s);
      map.set(s.row, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [seats]);

  const selectedRowSet = new Set(selectedRows.map((r) => r.toUpperCase()));
  const selectedSeatSet = new Set(selectedSeats.map((s) => s.toUpperCase()));

  return (
    <div className="space-y-2">
      <div className="flex gap-3 text-xs text-slate-500">
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-green-400" /> available</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-slate-300" /> booked</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded ring-2 ring-blue-500" /> watched</span>
      </div>
      {rows.map(([row, list]) => {
        const sorted = [...list].sort((a, b) => Number(a.number) - Number(b.number));
        const free = sorted.filter((s) => s.status === "available").length;
        const isRowSelected = selectedRowSet.has(row.toUpperCase());
        return (
          <div key={row} className="flex items-start gap-2">
            <button
              type="button"
              onClick={() => onToggleRow?.(row)}
              className={`w-8 shrink-0 rounded px-1 py-0.5 text-xs font-bold ${
                isRowSelected ? "bg-blue-600 text-white" : "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
              }`}
              title={`Toggle row ${row}`}
            >
              {row}
            </button>
            <div className="text-xs text-slate-400 w-10 shrink-0 pt-1">{free} free</div>
            <div className="flex flex-wrap gap-1">
              {sorted.map((s) => {
                const isWatched = selectedSeatSet.has(s.key.toUpperCase()) || (watchedRows ?? []).includes(s.row.toUpperCase());
                const base = s.status === "available" ? "bg-green-400 hover:bg-green-500" : "bg-slate-300 dark:bg-slate-700";
                return (
                  <button
                    key={s.key}
                    type="button"
                    disabled={s.status !== "available" || !onToggleSeat}
                    onClick={() => onToggleSeat?.(s.key)}
                    className={`h-6 w-6 rounded text-[10px] font-medium text-white ${base} ${
                      isWatched ? "ring-2 ring-blue-500" : ""
                    } ${selectedSeatSet.has(s.key.toUpperCase()) ? "ring-2 ring-amber-500" : ""}`}
                    title={`${s.key} · ${s.status}`}
                  >
                    {s.number}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
