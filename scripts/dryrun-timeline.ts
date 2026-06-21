// Render the contiguous timeline for eyeballing. Read-only.
// DRYRUN_DB=/path/pager.db npx tsx scripts/dryrun-timeline.ts
import Database from "better-sqlite3";
import { buildTimeline } from "../src/presence";

const db = new Database(process.env.DRYRUN_DB || "/tmp/pager-dryrun/pager.db", { readonly: true });

const dur = (ms: number) => {
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
};
// BRT (UTC-3) for display
const brt = (iso: string) => {
  const d = new Date(new Date(iso).getTime() - 3 * 3600000);
  return d.toISOString().slice(5, 16).replace("T", " ");
};

function show(label: string, fromIso: string, toIso: string) {
  console.log(`\n=== ${label} (BRT) ===`);
  const segs = buildTimeline(db, fromIso, toIso);
  for (const s of segs) {
    const where = s.kind === "zone" ? `${(s.emoji ?? "").trim()} ${s.label}` : `❓ ${s.label}`;
    console.log(
      `  ${brt(s.from)} → ${s.ongoing ? "agora " : brt(s.to)}  ${dur(s.duration_ms).padStart(6)}  ${where}`
    );
  }
}

const now = new Date();
const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
show("HOJE", startToday.toISOString(), now.toISOString());

const twoDays = new Date(now.getTime() - 2 * 864e5);
show("ÚLTIMOS 2 DIAS", twoDays.toISOString(), now.toISOString());
