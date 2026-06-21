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
- Env: `PAGER_API_KEY` (required, bearer), `PORT` (3100), `CORS_ORIGIN` (`*`), `PAGER_TRANSITION_WEBHOOK` (optional, presence automations)

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
| POST | `/location/event` | bearer | geofence enter/exit (from the app); single-occupancy state guard drops phantoms |
| POST | `/location/update` | bearer | significant-location-change ping (reverse-geocoded server-side); idempotent on device `timestamp` |
| GET | `/location/current` | bearer | current presence (zone or untagged) + dwell, staleness, accuracy flag |
| GET | `/location/history?from=&to=` | bearer | clean enter→exit intervals (phantoms collapsed, open interval GPS-reconciled) |
| GET | `/location/stats?period=day\|week\|month` | bearer | time per zone, visits, longest session, untagged time (or `?from=&to=`) |
| GET | `/location/timeline?period=day\|week\|month` | bearer | contiguous segments: zone stays + named untagged gaps, each with duration |
| GET | `/location/zones/suggestions?days=&minCount=` | bearer | clusters of untagged places worth tagging |

Auth header: `Authorization: Bearer $PAGER_API_KEY` on every endpoint except `/health`.

## Presence engine (`src/presence.ts`)
- **Single-occupancy model:** zones never overlap, so you're in at most one at a time. The raw
  `location_events` log is walked with a single-occupancy state machine that ignores phantoms
  (the relaunch initial-state burst) and self-heals missed transitions (an `enter` elsewhere
  closes a still-open zone). This is the authority for all reads — correct even on an un-cleaned log.
- **Time-at-a-place** = Σ(exit − enter) per zone; untagged time is the gaps, attributed to no zone.
- **GPS fusion (read-time):** geofence events miss transitions in BOTH directions (a late/absent
  enter on arrival, a missed exit on leaving), so the ping trail is fused in as ground truth — a
  ping inside a zone's radius opens it, a ping clearly beyond it (radius + 150 m + accuracy, on the
  exit side only) closes it. This recovers missed enters/exits (e.g. arriving home at 23:16 when the
  geofence enter didn't fire until 04:14). Same-zone intervals split by a <3 min gap are coalesced
  to absorb boundary jitter. Stored events are untouched — fusion happens only on read.
- **Sticky zones:** a gap between two stays in the *same* zone is absorbed when NO ping during it is
  actually outside the zone (radius + 150 m + accuracy). So phone-idle-at-home and stray geofence
  blips don't get mislabeled with the surrounding neighborhood. A ping demonstrably elsewhere (a real
  trip) keeps the gap untagged. Caveat: a real trip taken with no pings at all (phone off) bounded by
  the same zone is assumed "stayed" — no data means best-guess.
- **Ingest guard** (`POST /location/event`): single-occupancy, pure event-driven (no ping input),
  synthesizes a missed exit when you enter a new zone. Drops phantom exits / duplicate enters.
- **Transition webhook (opt-in):** set `PAGER_TRANSITION_WEBHOOK` to fire-and-forget a POST
  `{type,zone_id,zone_name,timestamp}` on every *real* transition — for presence automations.
  Unset ⇒ no-op.
- **Cleanup:** `scripts/cleanup-events.ts` rewrites `location_events` into the clean sequence
  (raw rows preserved in `location_events_raw_backup`). `DRY=1` to preview. `scripts/dryrun-presence.ts`
  inspects the engine against a DB copy.

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

## Location data — issues & fixes (audit 2026-06-12, fixed 2026-06-21)

Audit-day state: `location_pings` 436, `location_events` 292, `zones` 2 (🏠 Casa SP / 🏢 Segura,
8.1 km apart, 100 m radius). By 2026-06-21 the log had grown to 360 events of which **231 (64%)
were phantom**. All three issues are now addressed:

1. **Phantom geofence events — FIXED (server + client).** Root cause: on every app/OS relaunch the
   Expo app re-registers geofences and reports the *initial state* of every zone ("enter" the one
   you're in, "exit" each one you're not) instead of only real transitions → same-millisecond
   enter/exit pairs, exits ≫ enters.
   - **Server** (`POST /location/event`, no app rebuild): single-occupancy ingest guard accepts an
     event only when it changes presence; drops phantom exits / duplicate enters; synthesizes a
     missed exit on entering a new zone. See `src/presence.ts`.
   - **Client** (jonathan-pager `locationSetup.ts`, ships next rebuild): per-region AsyncStorage
     state guard — only forwards an event when that region's state changed, killing the burst at
     the source.
   - **Cleanup** (one-time): `scripts/cleanup-events.ts` collapsed the log 360 → 129 clean rows
     (raw preserved in `location_events_raw_backup`).
2. **Pings batched/late/out of order — MITIGATED.** iOS defers background uploads (lag p90 ≈ 16 min,
   max 2.3 h; some out of order; duplicate device timestamps). `POST /location/update` is now
   **idempotent on device `timestamp`**. The presence engine sorts by device `timestamp`, never
   `created_at` — keep doing so in any new reader.
3. **`accuracy = 100.0` is a fallback constant, not a measurement.** `presence.ts` exposes
   `ACCURACY_FALLBACK_M = 100`; `/location/current` returns `accuracy_reliable`, and zone
   suggestions ignore fallback pings. Still filter/flag `accuracy >= 100` before plotting raw pings.
