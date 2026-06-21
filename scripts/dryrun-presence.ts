// Dry-run the presence engine against a copy of the real DB. Read-only.
// Usage: DRYRUN_DB=/tmp/pager-dryrun/pager.db npx tsx scripts/dryrun-presence.ts
import Database from "better-sqlite3";
import { computeIntervals, getCurrent, getStats, suggestZones, currentZoneAt } from "../src/presence";

const db = new Database(process.env.DRYRUN_DB || "/tmp/pager-dryrun/pager.db", { readonly: true });

const fmt = (ms: number | null) => {
  if (ms == null) return "—";
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return `${h}h${String(m).padStart(2, "0")}`;
};

const rawEvents = db.prepare("SELECT COUNT(*) c FROM location_events").get() as { c: number };
const byType = db.prepare("SELECT type, COUNT(*) c FROM location_events GROUP BY type").all();
console.log("=== RAW EVENTS ===", rawEvents.c, JSON.stringify(byType));

const intervals = computeIntervals(db, null, null);
console.log(`\n=== CLEAN INTERVALS (single-occupancy walk): ${intervals.length} ===`);
console.log(`(implied clean events ≈ ${intervals.length * 2} vs ${rawEvents.c} raw → ${rawEvents.c - intervals.length * 2} phantom)`);
for (const iv of intervals.slice(-12)) {
  console.log(
    `  ${iv.zone_name?.padEnd(10)} ${iv.from}  ->  ${iv.to ?? "(open)"}  ${fmt(iv.duration_ms)}` +
      `${iv.reconciled ? " [reconciled]" : ""}${iv.open ? " [OPEN]" : ""}`
  );
}

console.log("\n=== CURRENT ===");
console.log(JSON.stringify(getCurrent(db), null, 2));

for (const period of ["day", "week", "month"]) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "week") start.setDate(start.getDate() - 6);
  if (period === "month") start.setMonth(start.getMonth() - 1);
  const s = getStats(db, start.toISOString(), now.toISOString());
  console.log(`\n=== STATS (${period}) tracked=${fmt(s.tracked_ms)} untagged=${fmt(s.untagged_ms)} range=${fmt(s.range_ms)} ===`);
  for (const z of s.zones) {
    console.log(`  ${(z.emoji ?? "").trim()} ${(z.zone_name ?? z.zone_id).padEnd(10)} total=${fmt(z.total_ms)} visits=${z.visits} longest=${fmt(z.longest_ms)} avg=${fmt(z.avg_ms)}${z.open ? " [here now]" : ""}`);
  }
}

console.log("\n=== ZONE SUGGESTIONS (last 30d, minCount 5) ===");
const sugg = suggestZones(db, { sinceIso: new Date(Date.now() - 30 * 864e5).toISOString(), minCount: 5 });
console.log(sugg.length ? JSON.stringify(sugg, null, 2) : "  (none)");
