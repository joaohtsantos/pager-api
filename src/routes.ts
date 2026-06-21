import { Router, Request, Response } from "express";
import crypto from "crypto";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "./database";
import { reverseGeocode } from "./geocode";
import {
  computeIntervals,
  currentZoneAt,
  getCurrent,
  getStats,
  buildTimeline,
  suggestZones,
} from "./presence";

const router = Router();
const MAX_ZONES = 20;
const MIN_RADIUS_M = 10;
const MAX_RADIUS_M = 2000;

// Optional automation hook: on a *real* zone transition (after phantom
// filtering) fire-and-forget a POST to this URL. Unset => no-op. Enables
// presence automations ("arrived home → ...") without coupling them in here.
const TRANSITION_WEBHOOK = process.env.PAGER_TRANSITION_WEBHOOK || null;
function fireTransition(payload: { type: "enter" | "exit"; zone_id: string; zone_name: string | null; timestamp: string }): void {
  if (!TRANSITION_WEBHOOK) return;
  fetch(TRANSITION_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => console.error("[location] transition webhook failed:", err instanceof Error ? err.message : String(err)));
}

function validateZoneFields(body: Record<string, unknown>, requireAll: boolean): string | null {
  const { name, lat, lon, radius, emoji } = body;
  if (requireAll || name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0) return "Field 'name' must be a non-empty string";
    if (name.length > 60) return "Field 'name' must be at most 60 characters";
  }
  if (requireAll || lat !== undefined) {
    if (typeof lat !== "number" || lat < -90 || lat > 90) return "Field 'lat' must be a number between -90 and 90";
  }
  if (requireAll || lon !== undefined) {
    if (typeof lon !== "number" || lon < -180 || lon > 180) return "Field 'lon' must be a number between -180 and 180";
  }
  if (requireAll || radius !== undefined) {
    if (typeof radius !== "number" || radius < MIN_RADIUS_M || radius > MAX_RADIUS_M) {
      return `Field 'radius' must be a number between ${MIN_RADIUS_M} and ${MAX_RADIUS_M} (metres)`;
    }
  }
  if (emoji !== undefined && emoji !== null && (typeof emoji !== "string" || emoji.length > 8)) {
    return "Field 'emoji' must be a short string";
  }
  return null;
}
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
// `source` is intentionally free-form (no allow-list): any string is accepted and
// stored as-is; it's only a provenance tag, never gates behaviour. Defaults to
// "system" when absent (see sendPush).

// Format a multi-line body listing the subjects of pending email requests.
// Android shows body collapsed (1-2 lines) and expanded (all lines), so the
// notification reveals what's queued when the user expands it.
function buildPendingBody(maxLines = 5): string {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT email_subject FROM requests " +
      "WHERE status='pending' AND email_subject IS NOT NULL AND email_subject != '' " +
      "ORDER BY created_at DESC LIMIT ?"
    ).all(maxLines + 1) as { email_subject: string }[];

    if (rows.length === 0) return "Novos emails precisam da sua atenção";

    const lines = rows.slice(0, maxLines).map((r) => {
      // 30 chars (29 + ellipsis) keeps each subject on a single line in
      // the Android notification across phone sizes and default font scale.
      const subj = r.email_subject.length > 30
        ? r.email_subject.slice(0, 29) + "…"
        : r.email_subject;
      return `• ${subj}`;
    });
    if (rows.length > maxLines) lines.push("+ mais…");
    return lines.join("\n");
  } catch {
    return "Novos emails precisam da sua atenção";
  }
}

export async function sendPush(opts: {
  category?: string; // DEPRECATED & ignored — every push is forced to "urgent" below
  title: string;
  body?: string;
  source?: string;
  collapseId?: string;
  androidTag?: string;
}): Promise<{ id: string; expo_ticket_id: string | null }> {
  const db = getDb();
  const id = crypto.randomUUID();
  const source = opts.source ?? "system";
  // FULL-URGENT policy: every push is forced to "urgent" regardless of what the
  // caller sent. This is the single chokepoint all pushes funnel through (POST
  // /pushes + internal callers), so this one line covers the whole system.
  const category = "urgent";
  const apnsId = crypto.randomUUID();
  const collapseId = opts.collapseId ?? null;
  const androidTag = opts.androidTag ?? null;

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
          // androidTag is forwarded to FCM V1 android.notification.tag so a
          // second push with the same tag replaces the first in the system tray
          // instead of stacking. Field name is unofficial; we set it both at
          // top level and inside data to maximize the chance Expo's bridge
          // honors it. If Expo strips it we fall back to direct FCM (option C).
          data: { category, apnsId, collapseId, ...(androidTag ? { androidTag } : {}) },
          channelId: category,
          sound: "default",
          priority: "high",
          ...(androidTag ? { _androidTag: androidTag } : {}),
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
  `).run(id, category, opts.title, opts.body ?? null, source, expoTicketId, apnsId, collapseId, providerStatus, providerResponse, delivered);

  console.log(`[push] id=${id} apns_id=${apnsId} collapse_id=${collapseId ?? "<none>"} android_tag=${androidTag ?? "<none>"} delivered=${delivered} status=${providerStatus ?? "unknown"}`);

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
  // Caller's `count` only gates whether to notify. The displayed number
  // comes from the DB so title and body always agree.
  const db = getDb();
  const pending = db.prepare("SELECT COUNT(*) as n FROM requests WHERE status = 'pending'").get() as { n: number };
  const n = pending.n;
  if (n < 1) {
    res.json({ ok: true, skipped: true, reason: "no pending requests in DB" });
    return;
  }
  const title = n === 1 ? "Email · 1 pendente" : `Email · ${n} pendentes`;
  const body = summary || buildPendingBody();
  try {
    const result = await sendPush({ category: "urgent", title, body, source: "email-agent", androidTag: "pager-email-bundle" });
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
        const title = n === 1 ? "Email · 1 pendente" : `Email · ${n} pendentes`;
        await sendPush({ category: "urgent", title, body: buildPendingBody(), source: "email-agent", androidTag: "pager-email-bundle" });
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

  // Approved requests are executed by the Opus executor (jonathan-crons/executor.sh),
  // which polls GET /requests?status=approved&handled=false and marks each handled.
  // (Previously this appended a line to jonathan/TODO-Jonathan.md for the openclaw resolver;
  //  removed to avoid double-execution now that the executor owns this.)

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

  if (!title || typeof title !== "string") {
    res.status(400).json({ error: "Field 'title' is required and must be a string" });
    return;
  }

  // DEPRECATION (phase 1): `category` is optional and IGNORED — every push is urgent.
  // We still accept it for backward compatibility, but signal deprecation so callers
  // migrate off it before phase 2 (reject). RFC 8594 Deprecation + a 299 Warning header.
  if (category !== undefined) {
    res.set("Deprecation", "true");
    res.set("Warning", '299 - "The \'category\' field is deprecated and ignored; all pushes are urgent. It will be rejected in a future release."');
    console.warn(`[deprecation] /pushes received category="${category}" (ignored) source="${source ?? "system"}"`);
  }
  // source is free-form — no validation; stored as-is (defaults to "system" if absent).

  const { id } = await sendPush({ title, body, source }); // category intentionally not forwarded

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

// ============================================================================
// Location: zones CRUD
// ============================================================================

// GET /location/zones
router.get("/location/zones", (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM zones ORDER BY created_at ASC").all();
  res.json(rows);
});

// POST /location/zones
router.post("/location/zones", (req: Request, res: Response) => {
  const err = validateZoneFields(req.body ?? {}, true);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) as c FROM zones").get() as { c: number }).c;
  if (count >= MAX_ZONES) {
    res.status(400).json({ error: `Zone limit reached (${MAX_ZONES})` });
    return;
  }
  const id = crypto.randomUUID();
  const { name, emoji, lat, lon, radius } = req.body;
  db.prepare(`
    INSERT INTO zones (id, name, emoji, lat, lon, radius)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), emoji ?? null, lat, lon, radius);
  const created = db.prepare("SELECT * FROM zones WHERE id = ?").get(id);
  res.status(201).json(created);
});

// PUT /location/zones/:id
router.put("/location/zones/:id", (req: Request, res: Response) => {
  const err = validateZoneFields(req.body ?? {}, false);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  const db = getDb();
  const existing = db.prepare("SELECT * FROM zones WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: "Zone not found" });
    return;
  }
  const { name, emoji, lat, lon, radius } = req.body;
  db.prepare(`
    UPDATE zones SET
      name = COALESCE(?, name),
      emoji = COALESCE(?, emoji),
      lat = COALESCE(?, lat),
      lon = COALESCE(?, lon),
      radius = COALESCE(?, radius),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name?.trim() ?? null,
    emoji ?? null,
    lat ?? null,
    lon ?? null,
    radius ?? null,
    req.params.id
  );
  const updated = db.prepare("SELECT * FROM zones WHERE id = ?").get(req.params.id);
  res.json(updated);
});

// DELETE /location/zones/:id
router.delete("/location/zones/:id", (req: Request, res: Response) => {
  const db = getDb();
  const result = db.prepare("DELETE FROM zones WHERE id = ?").run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: "Zone not found" });
    return;
  }
  res.json({ ok: true });
});

// ============================================================================
// Location: ingest
// ============================================================================

// POST /location/event — geofence enter/exit
router.post("/location/event", (req: Request, res: Response) => {
  const { type, zoneId, timestamp } = req.body ?? {};
  if (type !== "enter" && type !== "exit") {
    res.status(400).json({ error: "Field 'type' must be 'enter' or 'exit'" });
    return;
  }
  if (typeof zoneId !== "string" || zoneId.length === 0) {
    res.status(400).json({ error: "Field 'zoneId' is required" });
    return;
  }
  const ts = typeof timestamp === "string" ? timestamp : new Date().toISOString();
  const tsMs = new Date(ts).getTime();
  if (Number.isNaN(tsMs)) {
    res.status(400).json({ error: "Field 'timestamp' must be an ISO date string" });
    return;
  }

  const db = getDb();
  const zone = db.prepare("SELECT name FROM zones WHERE id = ?").get(zoneId) as { name: string } | undefined;
  const zoneName = zone?.name ?? null;

  const insertEvent = (evType: "enter" | "exit", evZoneId: string, evZoneName: string | null, evTs: string): string => {
    const eid = crypto.randomUUID();
    db.prepare(
      `INSERT INTO location_events (id, type, zone_id, zone_name, timestamp) VALUES (?, ?, ?, ?, ?)`
    ).run(eid, evType, evZoneId, evZoneName, evTs);
    return eid;
  };

  // Single-occupancy state guard. The Expo app re-emits the initial state of
  // every zone on each relaunch ("enter" the one you're in + "exit" each one
  // you're not), producing phantom events. We accept an event only when it
  // actually changes presence, and self-heal missed transitions.
  const current = currentZoneAt(db, ts); // open zone as of this event's timestamp

  if (type === "enter") {
    if (current && current.zone_id === zoneId) {
      res.json({ ok: true, deduped: true, reason: "already in zone" });
      return;
    }
    let synthesizedExit: string | null = null;
    if (current) {
      // Entered a new zone with no exit from the old one → synthesize the exit
      // (you can only be in one zone at a time).
      const prev = db.prepare("SELECT name FROM zones WHERE id = ?").get(current.zone_id) as { name: string } | undefined;
      insertEvent("exit", current.zone_id, prev?.name ?? null, ts);
      synthesizedExit = current.zone_id;
      fireTransition({ type: "exit", zone_id: current.zone_id, zone_name: prev?.name ?? null, timestamp: ts });
    }
    const id = insertEvent("enter", zoneId, zoneName, ts);
    fireTransition({ type: "enter", zone_id: zoneId, zone_name: zoneName, timestamp: ts });
    console.log(`[location] enter zone=${zoneName ?? zoneId} at ${ts}${synthesizedExit ? ` (auto-exit ${synthesizedExit})` : ""}`);
    res.status(201).json({ ok: true, id, ...(synthesizedExit ? { synthesized_exit: synthesizedExit } : {}) });
    return;
  }

  // type === "exit"
  if (!current || current.zone_id !== zoneId) {
    console.log(`[location] dropped phantom exit zone=${zoneName ?? zoneId} at ${ts}`);
    res.json({ ok: true, dropped: true, reason: "not in zone (phantom exit)" });
    return;
  }
  const id = insertEvent("exit", zoneId, zoneName, ts);
  fireTransition({ type: "exit", zone_id: zoneId, zone_name: zoneName, timestamp: ts });
  console.log(`[location] exit zone=${zoneName ?? zoneId} at ${ts}`);
  res.status(201).json({ ok: true, id });
});

// POST /location/update — significant location change ping
router.post("/location/update", async (req: Request, res: Response) => {
  const { lat, lon, accuracy, timestamp } = req.body ?? {};
  if (typeof lat !== "number" || lat < -90 || lat > 90) {
    res.status(400).json({ error: "Field 'lat' must be a number between -90 and 90" });
    return;
  }
  if (typeof lon !== "number" || lon < -180 || lon > 180) {
    res.status(400).json({ error: "Field 'lon' must be a number between -180 and 180" });
    return;
  }
  const ts = typeof timestamp === "string" ? timestamp : new Date().toISOString();
  const id = crypto.randomUUID();
  const db = getDb();

  // Idempotency: iOS batches and retries background uploads, so the same device
  // timestamp can arrive more than once. Treat it as one reading.
  const dup = db.prepare("SELECT id FROM location_pings WHERE timestamp = ? LIMIT 1").get(ts) as { id: string } | undefined;
  if (dup) {
    res.json({ ok: true, deduped: true, id: dup.id });
    return;
  }

  let g: Awaited<ReturnType<typeof reverseGeocode>> = { neighborhood: null, city: null, state: null, country: null };
  try {
    g = await reverseGeocode(lat, lon);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[location] reverse geocode failed: ${msg}`);
  }

  db.prepare(`
    INSERT INTO location_pings (id, lat, lon, accuracy, neighborhood, city, state, country, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, lat, lon, typeof accuracy === "number" ? accuracy : null, g.neighborhood, g.city, g.state, g.country, ts);

  res.status(201).json({ ok: true, id, neighborhood: g.neighborhood, city: g.city });
});

// ============================================================================
// Location: read
// ============================================================================

// GET /location/current
router.get("/location/current", (_req: Request, res: Response) => {
  res.json(getCurrent(getDb()));
});

// GET /location/history?from=&to=
// Clean enter→exit intervals (single-occupancy; phantoms collapsed). The
// trailing open interval is reconciled against GPS pings.
router.get("/location/history", (req: Request, res: Response) => {
  const from = typeof req.query.from === "string" ? req.query.from : null;
  const to = typeof req.query.to === "string" ? req.query.to : null;
  res.json({ intervals: computeIntervals(getDb(), from, to) });
});

// Resolve a `period` shortcut (day|week|month) into [from,to] using server-local
// boundaries, or fall back to explicit from/to query params.
function resolveRange(req: Request): { from: string; to: string } {
  const now = new Date();
  const period = typeof req.query.period === "string" ? req.query.period : null;
  if (period) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (period === "week") start.setDate(start.getDate() - 6);
    else if (period === "month") start.setMonth(start.getMonth() - 1);
    // "day" => since local midnight (default of `start`)
    return { from: start.toISOString(), to: now.toISOString() };
  }
  const from = typeof req.query.from === "string" ? req.query.from : new Date(now.getTime() - 7 * 864e5).toISOString();
  const to = typeof req.query.to === "string" ? req.query.to : now.toISOString();
  return { from, to };
}

// GET /location/stats?period=day|week|month  (or ?from=&to=)
// Time per zone, visit counts, longest session, and untagged time.
router.get("/location/stats", (req: Request, res: Response) => {
  const { from, to } = resolveRange(req);
  res.json(getStats(getDb(), from, to));
});

// GET /location/timeline
// Contiguous segments — zone stays AND the named untagged gaps between them.
// Two modes:
//   - Infinite scroll: ?limit=N[&before=<iso>]  → newest-first paging. Returns
//     `segments` (chronological) + `next_before` cursor (pass as `before` for the
//     older page; null when history is exhausted).
//   - Range: ?period=day|week|month  or  ?from=&to=
router.get("/location/timeline", (req: Request, res: Response) => {
  const db = getDb();
  if (req.query.limit !== undefined) {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 200);
    const lookbackDays = Math.min(Math.max(parseInt(req.query.lookbackDays as string, 10) || 60, 1), 365);
    const beforeIso = typeof req.query.before === "string" ? req.query.before : new Date().toISOString();
    const fromIso = new Date(new Date(beforeIso).getTime() - lookbackDays * 864e5).toISOString();
    const all = buildTimeline(db, fromIso, beforeIso); // chronological asc
    const page = all.slice(Math.max(0, all.length - limit));
    const next_before = all.length > limit && page.length > 0 ? page[0].from : null;
    res.json({ segments: page, next_before });
    return;
  }
  const { from, to } = resolveRange(req);
  res.json({ from, to, segments: buildTimeline(db, from, to) });
});

// GET /location/zones/suggestions?days=14&minCount=8
// Clusters of frequently-visited untagged places worth turning into zones.
router.get("/location/zones/suggestions", (req: Request, res: Response) => {
  const days = Math.min(Math.max(parseInt(req.query.days as string, 10) || 30, 1), 365);
  const minCount = Math.max(parseInt(req.query.minCount as string, 10) || 8, 2);
  const sinceIso = new Date(Date.now() - days * 864e5).toISOString();
  res.json({ suggestions: suggestZones(getDb(), { sinceIso, minCount }) });
});

export default router;
