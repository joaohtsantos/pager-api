# pager-api

Express + better-sqlite3 backend for the **Pager** system. Backend half of the pair `pager-api ↔ jonathan-pager` (mobile app). Exposed publicly via Cloudflare tunnel at `pager.jsplayground.cc`.

## Stack
- TypeScript, Express 4, better-sqlite3, express-rate-limit, cors
- Source: `src/{index,database,middleware,routes}.ts`
- Build: `tsc` → `dist/`
- Repo: `git@ssh.github.com:joaohtsantos/pager-api.git`

## Run
- Dev: `npm run dev` (tsx watch)
- Prod: `npm run build && npm start`
- Port: `3100` (override `PORT`)
- Env: `PAGER_API_KEY` (required, bearer), `PORT` (3100), `CORS_ORIGIN` (`*`)

## Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | open | liveness |
| GET | `/emails/inbox` | bearer | mock inbox (sample emails) |
| POST | `/requests` | bearer | create proposal request |
| GET | `/requests?status=pending\|approved\|rejected` | bearer | list requests |
| GET | `/requests/:id` | bearer | request detail |
| PATCH | `/requests/:id` | bearer | approve / reject |
| POST | `/pushes` | bearer | create push notification (called by pi-mcp `send_push`) |
| GET/POST | `/location/zones` | bearer | list / create geofence zones |
| PUT/DELETE | `/location/zones/:id` | bearer | edit / remove a zone |
| POST | `/location/event` | bearer | geofence enter/exit (from the app) |
| POST | `/location/update` | bearer | significant-location-change ping (reverse-geocoded server-side) |
| GET | `/location/current` | bearer | latest known zone state |

Auth header: `Authorization: Bearer $PAGER_API_KEY` on every endpoint except `/health`.

## Push policy (in `sendPush`, `src/routes.ts`)
- **Every push is forced to `urgent`.** `sendPush()` is the single chokepoint all pushes funnel
  through (POST /pushes + internal callers), and it hard-sets `category = "urgent"` → Expo
  `priority:"high"` + `channelId:"urgent"` (the app's MAX-importance channel). Callers may still
  send `info`/`alert`; it's overridden (delivery, stored category, and the app's label all become
  urgent). To revert, restore `opts.category` in the 4 spots (see `routes.ts.bak-freesource`).
- **`source` is free-form** — no allow-list; any string is accepted and stored as-is (defaults to
  `"system"`). The old `VALID_SOURCES` enum was removed.
- **`category` is being DEPRECATED.** Phase 1 (current): `POST /pushes` accepts it as **optional and
  ignored** — no longer required, never validated, not forwarded to `sendPush`. If a caller still
  sends it, the response carries `Deprecation: true` + a `299 Warning` header and the server logs it.
  Phase 2 (future): reject the field outright. New callers must NOT send `category`. (`VALID_CATEGORIES`
  is still used by the `GET /pushes?category=` history filter, so it stays.)
- Both are server-side, so no client/app rebuild is needed; just `npm run build` + restart.
- NB: the unit runs `tsx src/index.ts` (executes TS source directly), so edits go live on restart;
  `npm run build` is only a type-check here, not what's served.

## Data
- SQLite at `./data/pager.db` (auto-created on first boot).
- Schema lives in `src/database.ts`.
- Helper: `scripts/check-approved.sh` — quick CLI check on approved requests.

## Wiring
- **Frontend pair:** `~/jonathan-pager/` (Expo app) — its `constants.ts` hardcodes `API_BASE_URL = "https://pager.jsplayground.cc"` and the bearer key. Change one, change the other.
- **Inbound from pi-mcp:** `send_push` POSTs `/pushes` here.
- **Public surface:** Cloudflare tunnel → `pager.jsplayground.cc` → :3100.

## Gotchas
- `API_KEY` is hardcoded in the mobile app's `constants.ts` — rotating means rebuilding the app.
- `data/` is the source of truth; back up before destructive migrations.
- Rate limiting is on (`express-rate-limit`) — burst test traffic will get 429.

## Location data — known issues (audit 2026-06-12)

State of the tables that day: `location_pings` 436 rows, `location_events` 292, `zones` 2
(🏠 Casa SP / 🏢 Segura, 8.1 km apart, 100 m radius each). **~half of `location_events` is
phantom noise.** Numbers below are from that audit.

1. **Phantom geofence events (root cause, unfixed).** Exits far outnumber enters
   (Casa SP 89 exits / 56 enters; Segura 97 / 50) and there were 90 pairs of events for
   *both* zones at the same millisecond — physically impossible. Cause: on every
   app/OS relaunch the Expo app re-registers geofences and reports the *initial state*
   of every zone ("enter" for the one you're in, "exit" for each one you're not in)
   instead of only real transitions. The server doesn't catch it: the dedup in
   `src/routes.ts` (`POST /location/event`) only collapses same zone+type within ±30 s
   (`EVENT_DEDUP_WINDOW_MS`); it never checks whether the event changes state.
   - Fix A (server, ~10 lines, no app rebuild): before insert, fetch the last event for
     that zone regardless of age; if same `type`, drop it.
   - Fix B (client, needs app rebuild): in jonathan-pager, ignore the initial
     region-state callback from `Location.startGeofencingAsync`; forward transitions only.
   - Fix C (one-time): collapse existing `location_events` into a clean
     state-transition sequence (back up `data/pager.db` first).
2. **Pings arrive batched/late/out of order.** iOS defers background uploads: lag
   `created_at − timestamp` median 7 s but p90 ≈ 16 min, max 2.3 h; 13/436 rows arrived
   out of chronological order; 12 duplicate device timestamps (no idempotency key on
   `/location/update`). Always sort/display by device `timestamp`, never `created_at`.
3. **`accuracy = 100.0` is a fallback constant, not a measurement** (67 rows; iOS
   reduced-accuracy/significant-change pings). 159 rows have accuracy > 65 m — filter or
   flag `accuracy >= 100` before plotting. Reverse geocoding itself is healthy (2 NULLs).
