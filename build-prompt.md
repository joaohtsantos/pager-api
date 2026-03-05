Build a Pager backend API. Express + better-sqlite3 + TypeScript.

Schema:
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  email_subject TEXT, email_sender TEXT, email_date TEXT, email_message_id TEXT,
  summary TEXT, proposed_action TEXT, payload JSON,
  priority TEXT DEFAULT 'low', status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, resolved_at DATETIME
);

Endpoints:
- GET /emails/inbox - mock for now (return 2 sample emails)
- POST /requests - create proposal (auto UUID via crypto.randomUUID)
- GET /requests?status=... - list, filterable by status
- PATCH /requests/:id - approve/reject (set status + resolved_at)
- GET /requests/:id - detail
- GET /health - health check

Requirements:
- Auth middleware: Bearer token from PAGER_API_KEY env var. 401 if missing/wrong.
- Rate limiting (express-rate-limit, 100 req/15min)
- CORS (configurable CORS_ORIGIN env var, default *)
- Input validation on POST/PATCH
- Port from PORT env (default 3100)
- SQLite at ./data/pager.db (auto-create data/ dir if missing)
- On priority high request created, exec child_process: /home/joaohts/jonathan-pager/scripts/send-push.sh alert "📧 Novo pedido" "<summary>"
- NO email sending endpoints
- tsconfig.json, package.json with build/start/dev scripts
- .env.example, .gitignore, README.md
- Commit all files when done
