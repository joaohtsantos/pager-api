// Presence engine — single-occupancy model.
//
// Core assumption (confirmed for João's setup): zones never overlap, so you are
// in at most ONE zone at any instant. That makes the raw event log self-healing:
// walking it with a single-occupancy state machine collapses the phantom
// "enter A + exit B at the same millisecond" pairs the Expo app emits on every
// relaunch, and recovers from missed transitions (an `enter` elsewhere closes a
// still-open zone). Reads are therefore correct even before the raw log is
// cleaned up — the cleanup is just hygiene.
//
// Time-at-a-place = sum of (exit − enter) per zone. Time spent at untagged
// places is simply the gaps between intervals, correctly attributed to no zone.

import type Database from "better-sqlite3";

export type Zone = {
  id: string;
  name: string;
  emoji: string | null;
  lat: number;
  lon: number;
  radius: number;
};

export type RawEvent = {
  id: string;
  type: string; // 'enter' | 'exit'
  zone_id: string;
  zone_name: string | null;
  timestamp: string;
};

export type Interval = {
  zone_id: string;
  zone_name: string | null;
  from: string;
  to: string | null;
  duration_ms: number | null;
  open: boolean;        // true => still ongoing (no exit yet)
  reconciled: boolean;  // true => close time inferred from GPS pings, not a real exit event
};

export type Ping = {
  lat: number;
  lon: number;
  accuracy: number | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  timestamp: string;
};

// How far outside a zone's radius a GPS ping must sit before we believe a missed
// exit happened (covers GPS jitter + reduced-accuracy fallback pings).
const RECONCILE_MARGIN_M = 150;
// Same-zone intervals split by a gap shorter than this are merged (GPS jitter).
const COALESCE_GAP_MS = 3 * 60 * 1000;
// A ping whose reported accuracy is this coarse is a fallback constant on iOS
// (reduced-accuracy / significant-change), not a real measurement.
export const ACCURACY_FALLBACK_M = 100;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function getZones(db: Database.Database): Zone[] {
  return db.prepare("SELECT id, name, emoji, lat, lon, radius FROM zones").all() as Zone[];
}

function getZone(db: Database.Database, zoneId: string): Zone | undefined {
  return db
    .prepare("SELECT id, name, emoji, lat, lon, radius FROM zones WHERE id = ?")
    .get(zoneId) as Zone | undefined;
}

// The single zone considered "open" as of `tsIso`, derived from the full
// single-occupancy walk of events up to that instant (NOT the raw latest event,
// which may be a phantom). Pure event-driven — no ping reconciliation — so the
// ingest guard never drops a real exit because of a noisy GPS ping.
export function currentZoneAt(
  db: Database.Database,
  tsIso: string
): { zone_id: string; since: string } | null {
  const ivs = computeIntervals(db, null, tsIso, false);
  const last = ivs[ivs.length - 1];
  if (last && last.open) return { zone_id: last.zone_id, since: last.from };
  return null;
}

type StreamEvent = {
  type: "enter" | "exit";
  zone_id: string;
  zone_name: string | null;
  timestamp: string;
  gps?: boolean; // true => derived from a GPS ping, not a geofence event
};

// Derive zone transitions from the GPS ping trail. Geofencing misses transitions
// in BOTH directions (a late/absent enter on arrival, a missed exit on leaving),
// so the pings are the ground truth that corrects them. Hysteresis + accuracy
// gating on the *exit* side prevents boundary jitter from fragmenting intervals.
function buildGpsTransitions(
  db: Database.Database,
  fromIso: string | null,
  toIso: string | null
): StreamEvent[] {
  const zones = getZones(db);
  if (zones.length === 0) return [];
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (fromIso) {
    conditions.push("timestamp >= ?");
    params.push(fromIso);
  }
  if (toIso) {
    conditions.push("timestamp <= ?");
    params.push(toIso);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const pings = db
    .prepare(`SELECT lat, lon, accuracy, timestamp FROM location_pings ${where} ORDER BY timestamp ASC`)
    .all(...params) as { lat: number; lon: number; accuracy: number | null; timestamp: string }[];

  const out: StreamEvent[] = [];
  const nameOf = (id: string) => zones.find((z) => z.id === id)?.name ?? null;
  let cur: string | null | undefined = undefined; // zone id | null (untagged) | undefined (unseeded)

  for (const p of pings) {
    // Non-overlapping zones ⇒ a ping is inside at most one.
    const inZone = zones.find((z) => haversineM(p.lat, p.lon, z.lat, z.lon) <= z.radius) ?? null;
    let next: string | null;
    if (cur) {
      const z = zones.find((zz) => zz.id === cur);
      const dist = z ? haversineM(p.lat, p.lon, z.lat, z.lon) : Infinity;
      // Coarse "fallback" pings can't be trusted to prove we left; only count
      // accuracy toward the leave-threshold when it's a real measurement.
      const acc = typeof p.accuracy === "number" && p.accuracy < ACCURACY_FALLBACK_M ? p.accuracy : 0;
      if (z && dist <= z.radius) next = cur; // still inside
      else if (inZone) next = inZone.id; // jumped straight into another zone
      else if (z && dist > z.radius + RECONCILE_MARGIN_M + acc) next = null; // clearly left
      else next = cur; // in the hysteresis band → hold state
    } else {
      next = inZone ? inZone.id : null;
    }

    if (cur === undefined) {
      cur = next; // seed from the first ping; don't emit a transition
      continue;
    }
    if (next !== cur) {
      if (cur) out.push({ type: "exit", zone_id: cur, zone_name: nameOf(cur), timestamp: p.timestamp, gps: true });
      if (next) out.push({ type: "enter", zone_id: next, zone_name: nameOf(next), timestamp: p.timestamp, gps: true });
      cur = next;
    }
  }
  return out;
}

// Authoritative interval list. Merges geofence events with GPS-derived
// transitions (when useGps) and walks the result under single-occupancy:
// phantoms collapse, and missed enters/exits are recovered from the ping trail.
export function computeIntervals(
  db: Database.Database,
  fromIso: string | null,
  toIso: string | null,
  useGps = true
): Interval[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (fromIso) {
    conditions.push("timestamp >= ?");
    params.push(fromIso);
  }
  if (toIso) {
    conditions.push("timestamp <= ?");
    params.push(toIso);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const raw = db
    .prepare(`SELECT type, zone_id, zone_name, timestamp FROM location_events ${where} ORDER BY timestamp ASC`)
    .all(...params) as RawEvent[];

  let stream: StreamEvent[] = raw.map((e) => ({
    type: e.type as "enter" | "exit",
    zone_id: e.zone_id,
    zone_name: e.zone_name,
    timestamp: e.timestamp,
  }));
  if (useGps) {
    stream = stream.concat(buildGpsTransitions(db, fromIso, toIso));
    stream.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  }

  const intervals: Interval[] = [];
  let open: { zone_id: string; name: string | null; from: string } | null = null;

  const close = (toTs: string, reconciled: boolean) => {
    if (!open) return;
    intervals.push({
      zone_id: open.zone_id,
      zone_name: open.name,
      from: open.from,
      to: toTs,
      duration_ms: new Date(toTs).getTime() - new Date(open.from).getTime(),
      open: false,
      reconciled,
    });
    open = null;
  };

  for (const ev of stream) {
    if (ev.type === "enter") {
      if (open && open.zone_id === ev.zone_id) continue; // already in this zone → ignore
      if (open) close(ev.timestamp, !!ev.gps); // entered elsewhere → close prior here
      open = { zone_id: ev.zone_id, name: ev.zone_name, from: ev.timestamp };
    } else if (ev.type === "exit") {
      if (open && open.zone_id === ev.zone_id) close(ev.timestamp, !!ev.gps);
      // else: exit for a zone we're not in → ignore
    }
  }

  if (open) {
    intervals.push({
      zone_id: open.zone_id,
      zone_name: open.name,
      from: open.from,
      to: null,
      duration_ms: null,
      open: true,
      reconciled: false,
    });
  }

  // Coalesce consecutive same-zone intervals separated by a sub-threshold gap —
  // GPS jitter (a single stray ping) shouldn't split one stay into two with a
  // fake untagged sliver between them. Real excursions (longer gaps) are kept.
  const merged: Interval[] = [];
  for (const iv of intervals) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      !prev.open &&
      prev.to &&
      prev.zone_id === iv.zone_id &&
      new Date(iv.from).getTime() - new Date(prev.to).getTime() <= COALESCE_GAP_MS
    ) {
      prev.to = iv.to;
      prev.open = iv.open;
      prev.duration_ms = prev.to ? new Date(prev.to).getTime() - new Date(prev.from).getTime() : null;
      prev.reconciled = prev.reconciled || iv.reconciled;
    } else {
      merged.push({ ...iv });
    }
  }

  return merged;
}

function latestPing(db: Database.Database): Ping | undefined {
  return db
    .prepare(
      `SELECT lat, lon, accuracy, neighborhood, city, state, country, timestamp
       FROM location_pings ORDER BY timestamp DESC LIMIT 1`
    )
    .get() as Ping | undefined;
}

export type CurrentPresence = {
  in_zone: boolean;
  zone_id?: string;
  zone?: string | null;
  emoji?: string | null;
  since?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  last_ping?: string | null;
  last_ping_age_ms?: number | null;
  stale?: boolean;          // last ping older than STALE threshold
  accuracy_reliable?: boolean | null; // false when last ping uses the iOS fallback constant
  note?: string;            // e.g. "left zone (inferred from GPS)"
};

const STALE_MS = 30 * 60 * 1000;

export function getCurrent(db: Database.Database): CurrentPresence {
  const nowIso = new Date().toISOString();
  const ping = latestPing(db);
  const lastAge = ping ? Date.now() - new Date(ping.timestamp).getTime() : null;
  const accReliable = ping ? (ping.accuracy == null ? null : ping.accuracy < ACCURACY_FALLBACK_M) : null;

  // Authoritative current state = tail of the reconciled single-occupancy walk.
  const ivs = computeIntervals(db, null, nowIso, true);
  const last = ivs[ivs.length - 1];

  if (last && last.open) {
    const zone = getZone(db, last.zone_id);
    return {
      in_zone: true,
      zone_id: last.zone_id,
      zone: zone?.name ?? last.zone_name ?? null,
      emoji: zone?.emoji ?? null,
      since: last.from,
      last_ping: ping?.timestamp ?? null,
      last_ping_age_ms: lastAge,
      stale: lastAge != null ? lastAge > STALE_MS : false,
      accuracy_reliable: accReliable,
    };
  }

  // Not in any zone. If the last interval was closed via GPS reconciliation
  // (rather than a real exit event), flag that we inferred the departure.
  const leftInferred = !!(last && !last.open && last.reconciled);
  if (!ping) {
    return { in_zone: false, zone: null, since: null, last_ping: null };
  }
  return {
    in_zone: false,
    zone: null,
    neighborhood: ping.neighborhood,
    city: ping.city,
    state: ping.state,
    country: ping.country,
    last_ping: ping.timestamp,
    last_ping_age_ms: lastAge,
    stale: lastAge != null ? lastAge > STALE_MS : false,
    accuracy_reliable: accReliable,
    ...(leftInferred ? { note: "left zone (inferred from GPS, no exit event)" } : {}),
  };
}

export type ZoneStat = {
  zone_id: string;
  zone_name: string | null;
  emoji: string | null;
  total_ms: number;
  visits: number;
  longest_ms: number;
  avg_ms: number;
  open: boolean; // currently inside this zone
};

export type Stats = {
  from: string;
  to: string;
  range_ms: number;
  tracked_ms: number;   // sum of all zone time in range
  untagged_ms: number;  // range_ms − tracked_ms (time outside any zone)
  zones: ZoneStat[];
};

// Clip an interval to [from,to] so totals never leak outside the window.
function clip(intervalFrom: number, intervalTo: number, from: number, to: number): number {
  const lo = Math.max(intervalFrom, from);
  const hi = Math.min(intervalTo, to);
  return Math.max(0, hi - lo);
}

export function getStats(db: Database.Database, fromIso: string, toIso: string): Stats {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  // Pull intervals overlapping the window (start a bit before `from` so an
  // interval that began earlier still counts its in-window portion).
  const intervals = computeIntervals(db, null, toIso).filter((iv) => {
    const ivTo = iv.to ? new Date(iv.to).getTime() : to;
    return ivTo >= from && new Date(iv.from).getTime() <= to;
  });

  const byZone = new Map<string, ZoneStat>();
  let tracked = 0;
  for (const iv of intervals) {
    const ivFrom = new Date(iv.from).getTime();
    const ivTo = iv.to ? new Date(iv.to).getTime() : Math.min(Date.now(), to);
    const dur = clip(ivFrom, ivTo, from, to);
    if (dur <= 0) continue;
    tracked += dur;
    let s = byZone.get(iv.zone_id);
    if (!s) {
      const z = getZone(db, iv.zone_id);
      s = {
        zone_id: iv.zone_id,
        zone_name: iv.zone_name ?? z?.name ?? null,
        emoji: z?.emoji ?? null,
        total_ms: 0,
        visits: 0,
        longest_ms: 0,
        avg_ms: 0,
        open: false,
      };
      byZone.set(iv.zone_id, s);
    }
    s.total_ms += dur;
    s.visits += 1;
    s.longest_ms = Math.max(s.longest_ms, dur);
    if (iv.open) s.open = true;
  }

  const zones = [...byZone.values()].map((s) => ({
    ...s,
    avg_ms: s.visits > 0 ? Math.round(s.total_ms / s.visits) : 0,
  }));
  zones.sort((a, b) => b.total_ms - a.total_ms);

  const rangeMs = Math.max(0, Math.min(to, Date.now()) - from);
  return {
    from: fromIso,
    to: toIso,
    range_ms: rangeMs,
    tracked_ms: tracked,
    untagged_ms: Math.max(0, rangeMs - tracked),
    zones,
  };
}

export type TimelineSegment = {
  kind: "zone" | "untagged";
  zone_id: string | null;
  label: string;            // zone name, dominant place name, or "Unknown"
  emoji: string | null;
  from: string;
  to: string;
  duration_ms: number;
  ongoing: boolean;         // segment runs up to "now"
  neighborhood?: string | null; // for untagged segments
  city?: string | null;
  lat?: number | null;      // representative coords for untagged (prefills "add zone")
  lon?: number | null;
};

// Minimum untagged gap that earns its own segment — anything shorter is just a
// transition instant between two zones, not a real "somewhere else".
const UNTAGGED_MIN_MS = 2 * 60 * 1000;

// For an untagged window, find where you most likely were from the ping trail:
// the most frequent neighborhood/city, plus the centroid of that cluster's pings
// (so the app can prefill an "add zone here" form).
function dominantPlace(
  db: Database.Database,
  fromIso: string,
  toIso: string
): { neighborhood: string | null; city: string | null; lat: number | null; lon: number | null } {
  const pings = db
    .prepare(
      `SELECT lat, lon, neighborhood, city FROM location_pings
       WHERE timestamp >= ? AND timestamp <= ?`
    )
    .all(fromIso, toIso) as { lat: number; lon: number; neighborhood: string | null; city: string | null }[];
  if (pings.length === 0) return { neighborhood: null, city: null, lat: null, lon: null };
  const counts = new Map<
    string,
    { n: number; neighborhood: string | null; city: string | null; sumLat: number; sumLon: number }
  >();
  for (const p of pings) {
    const key = `${p.neighborhood ?? ""}|${p.city ?? ""}`;
    const c = counts.get(key) ?? { n: 0, neighborhood: p.neighborhood, city: p.city, sumLat: 0, sumLon: 0 };
    c.n += 1;
    c.sumLat += p.lat;
    c.sumLon += p.lon;
    counts.set(key, c);
  }
  let best = { n: 0, neighborhood: null as string | null, city: null as string | null, sumLat: 0, sumLon: 0 };
  for (const c of counts.values()) if (c.n > best.n) best = c;
  return {
    neighborhood: best.neighborhood,
    city: best.city,
    lat: best.n > 0 ? Math.round((best.sumLat / best.n) * 1e6) / 1e6 : null,
    lon: best.n > 0 ? Math.round((best.sumLon / best.n) * 1e6) / 1e6 : null,
  };
}

// Contiguous human-readable timeline: zone stays AND the untagged gaps between
// them, each with a duration, so you read "home → unknown → work" top to bottom
// without summing intervals in your head.
export function buildTimeline(db: Database.Database, fromIso: string, toIso: string): TimelineSegment[] {
  const now = Date.now();
  const fromMs = new Date(fromIso).getTime();
  const toMs = Math.min(new Date(toIso).getTime(), now);

  // Clip zone intervals to the window.
  const clipped = computeIntervals(db, null, toIso, true)
    .map((iv) => {
      const s = Math.max(new Date(iv.from).getTime(), fromMs);
      const e = Math.min(iv.to ? new Date(iv.to).getTime() : now, toMs);
      return { iv, s, e };
    })
    .filter((x) => x.e > x.s)
    .sort((a, b) => a.s - b.s);

  const iso = (ms: number) => new Date(ms).toISOString();
  const out: TimelineSegment[] = [];

  const pushUntagged = (sMs: number, eMs: number) => {
    if (eMs - sMs < UNTAGGED_MIN_MS) return;
    const place = dominantPlace(db, iso(sMs), iso(eMs));
    const label = place.neighborhood ?? place.city ?? "Unknown";
    out.push({
      kind: "untagged",
      zone_id: null,
      label,
      emoji: null,
      from: iso(sMs),
      to: iso(eMs),
      duration_ms: eMs - sMs,
      ongoing: eMs >= now - 1000,
      neighborhood: place.neighborhood,
      city: place.city,
      lat: place.lat,
      lon: place.lon,
    });
  };

  let cursor = clipped.length > 0 ? Math.min(fromMs, clipped[0].s) : fromMs;
  for (const { iv, s, e } of clipped) {
    if (s > cursor) pushUntagged(cursor, s);
    const z = getZone(db, iv.zone_id);
    out.push({
      kind: "zone",
      zone_id: iv.zone_id,
      label: iv.zone_name ?? z?.name ?? iv.zone_id,
      emoji: z?.emoji ?? null,
      from: iso(s),
      to: iso(e),
      duration_ms: e - s,
      ongoing: iv.open && e >= now - 1000,
    });
    cursor = Math.max(cursor, e);
  }
  if (toMs > cursor) pushUntagged(cursor, toMs);

  return out;
}

export type ZoneSuggestion = {
  lat: number;
  lon: number;
  count: number;        // pings in cluster
  span_ms: number;      // time between first and last ping in cluster
  neighborhood: string | null;
  city: string | null;
  suggested_name: string | null;
};

// Greedy clustering of "good" pings that fall outside every existing zone, to
// surface places worth tagging. ~110 m clusters; only places with enough
// distinct visits/dwell are returned.
export function suggestZones(
  db: Database.Database,
  opts: { sinceIso: string; minCount?: number; radiusM?: number } = { sinceIso: new Date(0).toISOString() }
): ZoneSuggestion[] {
  const minCount = opts.minCount ?? 8;
  const clusterR = opts.radiusM ?? 120;
  const zones = getZones(db);
  const pings = db
    .prepare(
      `SELECT lat, lon, accuracy, neighborhood, city, timestamp FROM location_pings
       WHERE timestamp >= ? ORDER BY timestamp ASC`
    )
    .all(opts.sinceIso) as {
    lat: number;
    lon: number;
    accuracy: number | null;
    neighborhood: string | null;
    city: string | null;
    timestamp: string;
  }[];

  type Cluster = {
    lat: number;
    lon: number;
    n: number;
    first: string;
    last: string;
    neighborhood: string | null;
    city: string | null;
  };
  const clusters: Cluster[] = [];

  for (const p of pings) {
    if (p.accuracy != null && p.accuracy >= ACCURACY_FALLBACK_M) continue; // skip fallback pings
    if (zones.some((z) => haversineM(p.lat, p.lon, z.lat, z.lon) <= z.radius)) continue; // inside a known zone
    let placed = false;
    for (const c of clusters) {
      if (haversineM(p.lat, p.lon, c.lat, c.lon) <= clusterR) {
        // incremental centroid
        c.lat = (c.lat * c.n + p.lat) / (c.n + 1);
        c.lon = (c.lon * c.n + p.lon) / (c.n + 1);
        c.n += 1;
        c.last = p.timestamp;
        if (!c.neighborhood && p.neighborhood) c.neighborhood = p.neighborhood;
        if (!c.city && p.city) c.city = p.city;
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push({
        lat: p.lat,
        lon: p.lon,
        n: 1,
        first: p.timestamp,
        last: p.timestamp,
        neighborhood: p.neighborhood,
        city: p.city,
      });
    }
  }

  return clusters
    .filter((c) => c.n >= minCount)
    .map((c) => ({
      lat: Math.round(c.lat * 1e6) / 1e6,
      lon: Math.round(c.lon * 1e6) / 1e6,
      count: c.n,
      span_ms: new Date(c.last).getTime() - new Date(c.first).getTime(),
      neighborhood: c.neighborhood,
      city: c.city,
      suggested_name: c.neighborhood ?? c.city ?? null,
    }))
    .sort((a, b) => b.count - a.count);
}
