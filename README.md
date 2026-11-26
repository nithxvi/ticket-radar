# ticket-radar

Tells you when tickets open on **BookMyShow** or **District**, and when the
seats or rows you care about get freed for a show you are watching.

First live watch: **Dune: Part Three · Chennai IMAX · Sat 19 Dec 2026**
(PVR Palazzo + INOX Phoenix Market City). District is already on sale; BMS
Chennai has not opened yet.

It only alerts. It never books, never holds seats, and never logs in as you.

---

## What it does

- Polls showtime availability for one date at one or more venues.
- Distinguishes **OPEN**, **NOT_OPEN** and **UNKNOWN**. A failed request is
  never reported as "not open" — unknown state keeps the last known state and
  says so in the log.
- Alerts when a date **opens**, and when **new shows** appear later.
- Takes seat-level snapshots and alerts when a watched seat or row moves from
  **booked → available**.
- Sends to **ntfy** and/or **Telegram** (both if configured).
- Remembers everything in SQLite so restarts don't re-alert.

---

## How it gets the data

No browser, no Playwright, no Cloudflare dance — both providers are plain HTTP.

**District**

- Guest session: `POST /gw/auth/skip_login` (`x-guest-token`, ~6 h).
- Showtimes: `GET /gw/consumer/movies/v5/movie?...&date=YYYY-MM-DD`.
  `204` / zero sessions means not on sale.
- Seats: `POST /gw/consumer/movies/v1/select-seat` with the cinema, session,
  provider and format codes taken from the showtime payload.

**BookMyShow**

- Showtimes: `GET /api/movies-data/v5/showtimes-by-event/primary-dynamic`
  (film-first, per region). If the date is closed there are no
  `showtimeWidgets`.
- Seats: `POST services-in.bookmyshow.com/doTrans.aspx` with
  `strCommand=GETSEATLAYOUT`. The `strData` blob is **AES-256-CBC with a zero
  IV and a static key bundled in the seat-layout JS**, so it decrypts in Node
  with `node:crypto`. Verified against a live 629-seat map.

Both can change their private endpoints or rotate the BMS key. If BMS starts
returning `decrypt failed`, the key in `src/providers/bms.ts` needs refreshing
from the current `app-*.js` bundle.

---

## Quick start

Requires **Node 24+** (uses `node:sqlite`; tested on Node 26).

```powershell
cd "D:\Personal projects\ticket-radar"
npm install

copy .env.example .env
notepad .env        # add ntfy topic and/or Telegram creds

npm run doctor      # read-only: does everything still work?
npm run once        # one real poll, records baselines
npm run watch       # the daemon
```

`doctor` and `seats` never write to the database and never notify.
`once` and `watch` do.

### Channels

**ntfy** (easiest): pick a hard-to-guess topic, install the ntfy app, subscribe.

```dotenv
NTFY_TOPIC=dune3-chennai-<random>
```

**Telegram**: create a bot with `@BotFather`, message it once, then read the
chat id from `https://api.telegram.org/bot<TOKEN>/getUpdates`.

```dotenv
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=123456789
```

Test with:

```powershell
npm run notify-test
```

---

## Configuration — `config/watch.json`

```jsonc
{
  "cadence": {
    "baseSec": 120,        // on sale, nothing happening
    "closedSec": 300,      // date has no shows yet
    "hotSec": 60,          // 15 min after an alert (hard floor is 60)
    "jitterPct": 25,       // randomise every interval by ±25%
    "seatHorizonDays": 60  // stop seat polling further out than this
  },
  "notify": {
    "onShowOpen": true,
    "onSeatFreed": true,
    "maxSeatsPerAlert": 12
  },
  "targets": [
    {
      "id": "dune3-chennai-2026-12-19",
      "label": "Dune: Part Three — Chennai IMAX — Sat 19 Dec",
      "date": "2026-12-19",
      "providers": ["district", "bms"],
      "movie": {
        "title": "Dune: Part Three",
        "districtContentId": "207332",
        "bmsEventCode": "ET00491771"
      },
      "city": {
        "districtKey": "chennai",
        "bmsRegion": "CHN",
        "bmsSlug": "chennai",
        "lat": 13.0569,
        "lng": 80.2425
      },
      "venues": {
        "include": ["PVR Palazzo", "INOX Phoenix"],
        "exclude": []
      },
      "seats": {
        "rows": ["H", "J", "K", "L"],
        "seats": []
      }
    }
  ]
}
```

`venues.include` is a case-insensitive substring match on the venue name. Empty
means "every venue in the city". `exclude` wins over `include`.

`seats` is your watch list:

- `rows: ["H", "J"]` → alert when **any** seat in those rows frees.
- `seats: ["H12", "H13"]` → alert only for those exact seats.
- Both → union.
- Both empty → alert on any freed seat (noisier; useful for testing).

Seat labels come from each platform's own map, so a row that is `H` on District
may be labelled differently on BMS. If you care about exact seats, confirm the
labels with:

```powershell
npm run seats -- dune3-chennai-2026-12-19 41559
```

That prints every row, how many seats are free, and their numbers.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run watch` | Long-running daemon, per-target adaptive cadence |
| `npm run once` | One real poll for every enabled target; updates state and sends alerts |
| `npm run doctor` | Read-only check: session lists, a seat probe, matching counts |
| `npm run seats -- <target> [sessionId]` | List shows, or dump a full seat map |
| `npm run notify-test` | Send a test notification |
| `npm test` | Parser/decryption unit tests |
| `npm run build` | Compile to `dist/` (optional; the source runs directly on Node 24+) |

Useful flags:

```powershell
npm run once -- --target dune3-chennai-2026-12-19 --verbose
npm run seats -- dune3-chennai-2026-12-19 41559 --provider district
```

---

## Alert behaviour

**First poll is a baseline.** If District is already on sale when you start the
daemon, the first pass records every session and every seat **without**
notifying. From then on:

| Event | Alert |
| --- | --- |
| Provider goes `NOT_OPEN → OPEN` | `🎟️ Booking opened` — urgent, lists all shows |
| A session id appears after booking opened | `🆕 New show` — high |
| A watched seat moves booked → available | `💺 N watched seats freed` — urgent |
| Provider returns `UNKNOWN` | No alert; previous state is kept |

Alerts are deduplicated in SQLite. A seat-freed alert is driven by the actual
snapshot transition, so it fires once per real change, not once per poll.

---

## Cadence and load

Each target polls independently:

- **300 s** while the date has no shows,
- **120 s** once it is on sale,
- **60 s** for 15 minutes after any alert (and a 60 s hard floor always),
- plus ±25% jitter.

With the current 10 Chennai sessions, a seat pass is 10 requests every ~2
minutes — about 5 requests/minute. That is deliberately human-paced. Don't run
two copies against the same database.

---

## Files

```
src/
  cli.ts               commands + readable output
  config.ts            watch.json loading, env channel merge, clamping
  engine.ts            diffing, seat matching, alert building
  scheduler.ts         per-target cadence, jitter, hot window
  store.ts             SQLite schema + snapshots + dedupe
  notify.ts            ntfy + Telegram
  types.ts             three-valued availability, provider contract
  time.ts              IST conversion, date maths
  providers/
    district.ts        guest token, showtimes, seat map
    bms.ts             film-first showtimes, doTrans seat decrypt/parse
config/watch.json      your targets
data/ticket-radar.db   state (created on first run)
fixtures/ recon/       local recon scratch, gitignored
```

---

## Running it 24/7 on Windows

Build once, then point Task Scheduler at it:

```powershell
npm run build
# Program:   node
# Arguments: dist\cli.js watch
# Start in:  D:\Personal projects\ticket-radar
# Trigger:   At log on
```

Set `LOG_LEVEL=debug` for per-session seat counts, or leave it at `info` for
one line per poll.

To reset state completely (baselines and dedupe), stop the daemon and delete
`data\`.

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No notifications | `npm run notify-test`; check `.env` is in the project root |
| `BMS ... UNKNOWN — provider answered for ...` | BMS silently fell back to another date; it will retry next poll |
| `BMS ... doTrans refused` | Session may have gone off sale, or the venue code is stale |
| `BMS ... decrypt failed` | Static seat key rotated — update `SEAT_LAYOUT_KEY` in `src/providers/bms.ts` |
| `District ... HTTP 403` | Guest token/cookies expired; `doctor` will show whether a fresh token fixes it |
| Alerts repeat forever | Delete `data/ticket-radar.db` to re-baseline |
| Want to see what it sees | `npm run doctor`, or `npm run once -- --verbose` |

---

## Scope and etiquette

- Alerts only — no booking, no seat holds, no account automation.
- Respect the sites: keep the 60 s floor, don't parallelise aggressively, don't
  run multiple instances.
- Private endpoints can change at any time; `doctor` is the fastest way to find
  out.
