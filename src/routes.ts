import { Router, Request, Response } from "express";
import crypto from "crypto";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "./database";

const router = Router();
let pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// Load push token on startup
const PUSH_TOKEN_PATH = path.join(os.homedir(), ".jonathan-pager-token");
let pushToken: string | null = null;
try {
  pushToken = fs.readFileSync(PUSH_TOKEN_PATH, "utf-8").trim();
} catch {
  console.warn("Push token not found at", PUSH_TOKEN_PATH);
}

const VALID_CATEGORIES = ["urgent", "alert", "info"] as const;
const VALID_SOURCES = ["system", "email-agent", "cron", "manual", "mcp", "sleep-cycle", "agent-monitor"] as const;

export async function sendPush(opts: {
  category: string;
  title: string;
  body?: string;
  source?: string;
  collapseId?: string;
}): Promise<{ id: string; expo_ticket_id: string | null }> {
  const db = getDb();
  const id = crypto.randomUUID();
  const source = opts.source ?? "system";
  const apnsId = crypto.randomUUID();
  const collapseId = opts.collapseId ?? null;

  let expoTicketId: string | null = null;
  let delivered = 0;
  let providerStatus: string | null = null;
  let providerResponse: string | null = null;

  if (pushToken) {
    try {
      const resp = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apns-id": apnsId,
          ...(collapseId ? { "apns-collapse-id": collapseId } : {}),
        },
        body: JSON.stringify({
          to: pushToken,
          title: opts.title,
          body: opts.body,
          data: { category: opts.category, apnsId, collapseId },
          channelId: opts.category,
          sound: "default",
          priority: opts.category === "urgent" ? "high" : "default",
        }),
      });
      const result = await resp.json() as { data?: { id?: string; status?: string }; errors?: unknown[] };
      providerStatus = result.data?.status ?? (resp.ok ? "ok" : "error");
      providerResponse = JSON.stringify(result);
      if (result.data?.id) {
        expoTicketId = result.data.id;
        delivered = 1;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      providerStatus = "error";
      providerResponse = msg;
      console.error("Failed to send push via Expo:", msg);
    }
  }

  db.prepare(`
    INSERT INTO pushes (id, category, title, body, source, expo_ticket_id, apns_id, collapse_id, provider_status, provider_response, delivered)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, opts.category, opts.title, opts.body ?? null, source, expoTicketId, apnsId, collapseId, providerStatus, providerResponse, delivered);

  console.log(`[push] id=${id} apns_id=${apnsId} collapse_id=${collapseId ?? "<none>"} delivered=${delivered} status=${providerStatus ?? "unknown"}`);

  return { id, expo_ticket_id: expoTicketId };
}

// GET /emails/inbox - real emails via himalaya
router.get("/emails/inbox", (req: Request, res: Response) => {
  const pageSize = String(req.query.pageSize || "10");
  const himalayaBin = "/usr/local/bin/himalaya";
  execFile(himalayaBin, ["envelope", "list", "--folder", "INBOX", "--page-size", pageSize, "--output", "json", "not", "flag", "seen"], (err, stdout, stderr) => {
    if (err) {
      console.error("himalaya envelope list failed:", err.message, stderr);
      res.status(500).json({ error: "Failed to fetch inbox" });
      return;
    }
    try {
      const envelopes = JSON.parse(stdout);
      res.json(envelopes);
      // Mark all returned emails as seen
      if (envelopes.length > 0) {
        const ids: string[] = envelopes.map((e: any) => String(e.id));
        const flagArgs: string[] = ["flag", "add", "--folder", "INBOX", ...ids, "seen"];
        execFile(himalayaBin, flagArgs, (flagErr: Error | null) => {
          if (flagErr) console.error("Failed to mark emails as seen:", flagErr.message);
          else console.log(`[inbox] Marked ${ids.length} emails as seen`);
        });
      }
    } catch (parseErr) {
      console.error("Failed to parse himalaya output:", stdout);
      res.status(500).json({ error: "Failed to parse inbox data" });
    }
  });
});

// GET /emails/:id - read full email via himalaya
router.get("/emails/:id", (req: Request, res: Response) => {
  const himalayaBin = "/usr/local/bin/himalaya";
  const emailId = req.params.id as string;
  execFile(himalayaBin, ["message", "read", "--folder", "INBOX", emailId], (err: Error | null, stdout: string, stderr: string) => {
    if (err) {
      console.error("himalaya message read failed:", err.message, stderr);
      res.status(500).json({ error: "Failed to read email" });
      return;
    }
    res.json({ id: emailId, content: stdout });
  });
});

// POST /requests/notify - send a single push summarizing new pending requests
router.post("/requests/notify", async (req: Request, res: Response) => {
  const { count, summary } = req.body;
  if (!count || count < 1) {
    res.json({ ok: true, skipped: true, reason: "no important emails" });
    return;
  }
  const title = count === 1 ? "📧 1 email importante" : `📧 ${count} emails importantes`;
  const body = summary || "Novos emails precisam da sua atenção";
  try {
    const result = await sendPush({ category: "alert", title, body, source: "email-agent" });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("Failed to send push:", err);
    res.status(500).json({ error: "Failed to send push" });
  }
});

// POST /emails/mark-seen - mark multiple emails as seen
router.post("/emails/mark-seen", (req: Request, res: Response) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "Field 'ids' must be a non-empty array of email IDs" });
    return;
  }
  const himalayaBin = "/usr/local/bin/himalaya";
  const args = ["flag", "add", "--folder", "INBOX", ...ids.map(String), "seen"];
  execFile(himalayaBin, args, (err, _stdout, stderr) => {
    if (err) {
      console.error("himalaya flag add failed:", err.message, stderr);
      res.status(500).json({ error: "Failed to mark emails as seen" });
      return;
    }
    res.json({ ok: true, marked: ids.length });
  });
});

// POST /requests
router.post("/requests", async (req: Request, res: Response) => {
  const { type, email_subject, email_sender, email_date, email_message_id, summary, proposed_action, payload, priority } = req.body;

  if (!type || typeof type !== "string") {
    res.status(400).json({ error: "Field 'type' is required and must be a string" });
    return;
  }
  if (summary !== undefined && typeof summary !== "string") {
    res.status(400).json({ error: "Field 'summary' must be a string" });
    return;
  }
  if (priority !== undefined && !["low", "medium", "high"].includes(priority)) {
    res.status(400).json({ error: "Field 'priority' must be one of: low, medium, high" });
    return;
  }

  const id = crypto.randomUUID();
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO requests (id, type, email_subject, email_sender, email_date, email_message_id, summary, proposed_action, payload, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    type,
    email_subject ?? null,
    email_sender ?? null,
    email_date ?? null,
    email_message_id ?? null,
    summary ?? null,
    proposed_action ?? null,
    payload ? JSON.stringify(payload) : null,
    priority ?? "low"
  );

  const created = db.prepare("SELECT * FROM requests WHERE id = ?").get(id);

  // Debounced push: wait 10s after last request creation, then send ONE push with count
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
  pushDebounceTimer = setTimeout(async () => {
    try {
      const pending = db.prepare("SELECT COUNT(*) as count FROM requests WHERE status = 'pending'").get() as any;
      const n = pending.count;
      if (n > 0) {
        const title = n === 1 ? "📧 1 email importante" : `📧 ${n} emails importantes`;
        await sendPush({ category: "alert", title, body: "Novos emails precisam da sua atenção", source: "email-agent" });
        console.log(`[requests] Push sent: ${n} pending`);
      }
    } catch (err: any) {
      console.error("[requests] Failed to send batch push:", err.message);
    }
  }, 30000);

  res.status(201).json(created);
});

// GET /requests
router.get("/requests", (req: Request, res: Response) => {
  const db = getDb();
  const { status, handled } = req.query;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status) {
    if (!["pending", "approved", "rejected"].includes(status as string)) {
      res.status(400).json({ error: "Invalid status filter. Must be: pending, approved, rejected" });
      return;
    }
    conditions.push("status = ?");
    params.push(status as string);
  }

  if (handled !== undefined) {
    conditions.push("handled = ?");
    params.push(handled === "true" ? 1 : 0);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM requests ${where} ORDER BY created_at DESC`).all(...params);
  res.json(rows);
});

// GET /requests/:id
router.get("/requests/:id", (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);

  if (!row) {
    res.status(404).json({ error: "Request not found" });
    return;
  }

  res.json(row);
});

// PATCH /requests/:id
router.patch("/requests/:id", (req: Request, res: Response) => {
  const { status, proposed_action } = req.body;

  if (!status || !["approved", "rejected"].includes(status)) {
    res.status(400).json({ error: "Field 'status' is required and must be 'approved' or 'rejected'" });
    return;
  }

  const db = getDb();
  const existing = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);

  if (!existing) {
    res.status(404).json({ error: "Request not found" });
    return;
  }

  // Optionally overwrite proposed_action before status transition (used by mobile app's edit-then-approve flow).
  if (typeof proposed_action === "string" && proposed_action.trim().length > 0) {
    db.prepare("UPDATE requests SET proposed_action = ? WHERE id = ?")
      .run(proposed_action, req.params.id);
  }

  db.prepare("UPDATE requests SET status = ?, resolved_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), req.params.id);

  const updated = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id) as Record<string, unknown>;

  if (status === "approved") {
    const subject = (updated.email_subject as string) || "Request";

    // Append actionable TODO to Jonathan's list for the todo-resolver to pick up
    const todoFile = path.join(os.homedir(), "obsidian-vault/jonathan/TODO-Jonathan.md");
    const type = updated.type as string || "unknown";
    const action = (updated.proposed_action as string) || "";
    let line = "";
    const shortSubject = subject.slice(0, 80);
    if (type === "add_todo") {
      line = `- [ ] 📧 Adicionar ao TODO-Personal.md: "${shortSubject}" (id:${updated.id})\n`;
    } else if (type === "add_calendar") {
      line = `- [ ] 📧 Adicionar ao calendar.md: "${shortSubject}" (id:${updated.id})\n`;
    } else if (type === "summary") {
      line = `- [ ] 📧 Ler e extrair insights: "${shortSubject}" (id:${updated.id})\n`;
    }
    if (line) {
      try {
        fs.appendFileSync(todoFile, line);
        console.log(`[approve] Appended to ${todoFile}: ${type}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[approve] Failed to append to TODO-Jonathan: ${msg}`);
      }
    }
  }

  res.json(updated);
});

// PATCH /requests/:id/handled
router.patch("/requests/:id/handled", (req: Request, res: Response) => {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  db.prepare("UPDATE requests SET handled = 1, handled_at = ? WHERE id = ?")
    .run(new Date().toISOString(), req.params.id);
  const updated = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);
  res.json(updated);
});

// POST /pushes
router.post("/pushes", async (req: Request, res: Response) => {
  const { category, title, body, source } = req.body;

  if (!category || !VALID_CATEGORIES.includes(category)) {
    res.status(400).json({ error: "Field 'category' must be one of: urgent, alert, info" });
    return;
  }
  if (!title || typeof title !== "string") {
    res.status(400).json({ error: "Field 'title' is required and must be a string" });
    return;
  }
  if (source !== undefined && !VALID_SOURCES.includes(source)) {
    res.status(400).json({ error: "Field 'source' must be one of: system, email-agent, cron, manual, mcp, sleep-cycle, agent-monitor" });
    return;
  }

  const { id } = await sendPush({ category, title, body, source });

  const db = getDb();
  const created = db.prepare("SELECT * FROM pushes WHERE id = ?").get(id);
  res.status(201).json(created);
});

// GET /pushes
router.get("/pushes", (req: Request, res: Response) => {
  const db = getDb();
  const { category, read } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (category) {
    if (!VALID_CATEGORIES.includes(category as typeof VALID_CATEGORIES[number])) {
      res.status(400).json({ error: "Invalid category filter. Must be: urgent, alert, info" });
      return;
    }
    conditions.push("category = ?");
    params.push(category);
  }

  if (read !== undefined) {
    conditions.push("read = ?");
    params.push(read === "true" ? 1 : 0);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM pushes ${where}`).get(...params) as { total: number };
  res.setHeader("X-Total-Count", countRow.total);

  const rows = db.prepare(`SELECT * FROM pushes ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json(rows);
});

// GET /pushes/:id
router.get("/pushes/:id", (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM pushes WHERE id = ?").get(req.params.id);

  if (!row) {
    res.status(404).json({ error: "Push not found" });
    return;
  }

  res.json(row);
});

// PATCH /pushes/:id
router.patch("/pushes/:id", (req: Request, res: Response) => {
  const { read } = req.body;

  if (typeof read !== "boolean") {
    res.status(400).json({ error: "Field 'read' must be a boolean" });
    return;
  }

  const db = getDb();
  const existing = db.prepare("SELECT * FROM pushes WHERE id = ?").get(req.params.id);

  if (!existing) {
    res.status(404).json({ error: "Push not found" });
    return;
  }

  if (read) {
    db.prepare("UPDATE pushes SET read = 1, read_at = ? WHERE id = ?")
      .run(new Date().toISOString(), req.params.id);
  } else {
    db.prepare("UPDATE pushes SET read = 0, read_at = NULL WHERE id = ?")
      .run(req.params.id);
  }

  const updated = db.prepare("SELECT * FROM pushes WHERE id = ?").get(req.params.id);
  res.json(updated);
});

// POST /pushes/read-all
router.post("/pushes/read-all", (_req: Request, res: Response) => {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare("UPDATE pushes SET read = 1, read_at = ? WHERE read = 0").run(now);
  res.json({ updated: result.changes });
});

export default router;
