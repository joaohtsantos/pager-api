import { Router, Request, Response } from "express";
import crypto from "crypto";
import { execFile } from "child_process";
import { getDb } from "./database";

const router = Router();

// GET /emails/inbox - mock
router.get("/emails/inbox", (_req: Request, res: Response) => {
  res.json([
    {
      id: "msg-001",
      subject: "Invoice #1234 - Payment Due",
      sender: "billing@example.com",
      date: "2026-03-04T10:00:00Z",
      snippet: "Your invoice #1234 is due on March 10. Total: R$1,500.00.",
    },
    {
      id: "msg-002",
      subject: "Meeting Rescheduled",
      sender: "calendar@example.com",
      date: "2026-03-04T11:30:00Z",
      snippet: "The project review meeting has been moved to Thursday 3pm.",
    },
  ]);
});

// POST /requests
router.post("/requests", (req: Request, res: Response) => {
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

  // Send push notification for high priority requests
  if ((priority ?? "low") === "high") {
    const pushScript = "/home/joaohts/jonathan-pager/scripts/send-push.sh";
    const summaryText = summary || "Novo pedido de alta prioridade";
    execFile(pushScript, ["alert", "📧 Novo pedido", summaryText], (err) => {
      if (err) {
        console.error("Failed to send push notification:", err.message);
      }
    });
  }

  res.status(201).json(created);
});

// GET /requests
router.get("/requests", (req: Request, res: Response) => {
  const db = getDb();
  const { status } = req.query;

  if (status) {
    if (!["pending", "approved", "rejected"].includes(status as string)) {
      res.status(400).json({ error: "Invalid status filter. Must be: pending, approved, rejected" });
      return;
    }
    const rows = db.prepare("SELECT * FROM requests WHERE status = ? ORDER BY created_at DESC").all(status as string);
    res.json(rows);
    return;
  }

  const rows = db.prepare("SELECT * FROM requests ORDER BY created_at DESC").all();
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
  const { status } = req.body;

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

  db.prepare("UPDATE requests SET status = ?, resolved_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), req.params.id);

  const updated = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);
  res.json(updated);
});

export default router;
