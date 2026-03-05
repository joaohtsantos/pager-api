# Pager API

Backend API for the Pager system. Express + better-sqlite3 + TypeScript.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your PAGER_API_KEY
```

## Scripts

```bash
npm run build   # Compile TypeScript
npm start       # Run compiled JS
npm run dev     # Dev mode with hot reload
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PAGER_API_KEY` | — | Required. Bearer token for API auth |
| `PORT` | `3100` | Server port |
| `CORS_ORIGIN` | `*` | Allowed CORS origin |

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Health check |
| GET | `/emails/inbox` | Yes | Mock inbox (sample emails) |
| POST | `/requests` | Yes | Create a proposal request |
| GET | `/requests` | Yes | List requests (`?status=pending\|approved\|rejected`) |
| GET | `/requests/:id` | Yes | Get request detail |
| PATCH | `/requests/:id` | Yes | Approve or reject a request |

## Auth

All endpoints except `/health` require `Authorization: Bearer <PAGER_API_KEY>`.

## Data

SQLite database stored at `./data/pager.db` (auto-created on first run).
