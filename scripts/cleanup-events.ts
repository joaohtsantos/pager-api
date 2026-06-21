// One-time cleanup: collapse the phantom-polluted location_events log into a
// clean single-occupancy enter→exit sequence.
//
//   Dry run:  DRY=1 DB=/path/pager.db npx tsx scripts/cleanup-events.ts
//   Apply:    DB=/path/pager.db npx tsx scripts/cleanup-events.ts
//
// Always back up the DB file before applying. Raw rows are also preserved in a
// timestamped backup table so this is reversible from inside the DB.
import Database from "better-sqlite3";
import crypto from "crypto";
import { computeIntervals } from "../src/presence";

const DB_PATH = process.env.DB || "./data/pager.db";
const DRY = process.env.DRY === "1";

const db = new Database(DB_PATH);

const before = (db.prepare("SELECT COUNT(*) c FROM location_events").get() as { c: number }).c;

// Faithful clean log: pure event walk, NO ping reconciliation (reconciliation is
// a read-time concern; the stored log should reflect events only). The trailing
// open interval stays open (no synthetic exit).
const intervals = computeIntervals(db, null, null, false);

// Build the clean event rows.
const clean: { id: string; type: string; zone_id: string; zone_name: string | null; timestamp: string }[] = [];
for (const iv of intervals) {
  clean.push({ id: crypto.randomUUID(), type: "enter", zone_id: iv.zone_id, zone_name: iv.zone_name, timestamp: iv.from });
  if (iv.to) clean.push({ id: crypto.randomUUID(), type: "exit", zone_id: iv.zone_id, zone_name: iv.zone_name, timestamp: iv.to });
}

console.log(`DB: ${DB_PATH}`);
console.log(`raw events: ${before}`);
console.log(`clean intervals: ${intervals.length}  (open: ${intervals.filter((i) => i.open).length})`);
console.log(`clean events to write: ${clean.length}  → removing ${before - clean.length} phantom rows`);

if (DRY) {
  console.log("\n[DRY RUN] no changes written. Last 6 clean events:");
  for (const e of clean.slice(-6)) console.log(`  ${e.type.padEnd(5)} ${e.zone_name} ${e.timestamp}`);
  process.exit(0);
}

const backupTable = `location_events_raw_backup`;
const apply = db.transaction(() => {
  // Snapshot raw rows (idempotent table; append a backup batch marker via created_at).
  db.exec(`CREATE TABLE IF NOT EXISTS ${backupTable} (
    id TEXT, type TEXT, zone_id TEXT, zone_name TEXT, timestamp DATETIME, created_at DATETIME, backed_up_at DATETIME
  )`);
  db.exec(`INSERT INTO ${backupTable} (id, type, zone_id, zone_name, timestamp, created_at, backed_up_at)
           SELECT id, type, zone_id, zone_name, timestamp, created_at, datetime('now') FROM location_events`);
  db.exec("DELETE FROM location_events");
  const ins = db.prepare("INSERT INTO location_events (id, type, zone_id, zone_name, timestamp) VALUES (?, ?, ?, ?, ?)");
  for (const e of clean) ins.run(e.id, e.type, e.zone_id, e.zone_name, e.timestamp);
});
apply();

const after = (db.prepare("SELECT COUNT(*) c FROM location_events").get() as { c: number }).c;
const backed = (db.prepare(`SELECT COUNT(*) c FROM ${backupTable}`).get() as { c: number }).c;
console.log(`\n✅ done. location_events: ${before} → ${after}. Raw rows preserved in ${backupTable}: ${backed}.`);
