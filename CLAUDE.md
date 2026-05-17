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

Auth header: `Authorization: Bearer $PAGER_API_KEY` on every endpoint except `/health`.

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
