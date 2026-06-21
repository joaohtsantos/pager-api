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

// If a zone is still "open" but GPS pings show we've clearly left, infer the exit
// time from the last ping that was still inside the zone. Returns the inferred
// close timestamp, or null if we still appear to be inside (or can't tell).
function reconcileOpenExit(db: Database.Database, zone: Zone, fromIso: string): string | null {
  const latest = db
    .prepare(
      `SELECT lat, lon, accuracy, timestamp FROM location_pings
       WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 1`
    )
    .get(fromIso) as { lat: number; lon: number; accuracy: number | null; timestamp: string } | undefined;
  if (!latest) return null; // no pings since entering → can't tell, leave open

  const distLatest = haversineM(latest.lat, latest.lon, zone.lat, zone.lon);
  if (distLatest <= zone.radius + RECONCILE_MARGIN_M) return null; // still inside

  // We've left but no exit event fired. Find the last ping that was still inside
  // and close the interval there (best estimate of when we actually left).
  const insidePings = db
    .prepare(
      `SELECT lat, lon, timestamp FROM location_pings
       WHERE timestamp >= ? ORDER BY timestamp ASC`
    )
    .all(fromIso) as { lat: number; lon: number; timestamp: string }[];

  let lastInside: string | null = null;
  for (const p of insidePings) {
    const d = haversineM(p.lat, p.lon, zone.lat, zone.lon);
    if (d <= zone.radius + RECONCILE_MARGIN_M) lastInside = p.timestamp;
    else break; // first ping outside → we left around here
  }
  return lastInside ?? fromIso;
}

// Authoritative interval list. Walks the raw event log under single-occupancy,
// ignoring phantoms, and reconciles the trailing open interval against pings.
export function computeIntervals(
  db: Database.Database,
  fromIso: string | null,
  toIso: string | null,
  reconcile = true
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
  const events = db
    .prepare(
      `SELECT id, type, zone_id, zone_name, timestamp FROM location_events ${where} ORDER BY timestamp ASC`
    )
    .all(...params) as RawEvent[];

  const intervals: Interval[] = [];
  let open: { zone_id: string; name: string | null; from: string } | null = null;

  const close = (toTs: string, reconciled = false) => {
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

  for (const ev of events) {
    if (ev.type === "enter") {
      if (open && open.zone_id === ev.zone_id) continue; // duplicate enter → ignore
      if (open) close(ev.timestamp); // entered elsewhere → missed exit, close here
      open = { zone_id: ev.zone_id, name: ev.zone_name, from: ev.timestamp };
    } else if (ev.type === "exit") {
      if (open && open.zone_id === ev.zone_id) close(ev.timestamp); // real exit
      // else: phantom exit for a zone we're not in → ignore
    }
  }

  if (open) {
    const zone = reconcile ? getZone(db, open.zone_id) : undefined;
    const inferred = zone ? reconcileOpenExit(db, zone, open.from) : null;
    if (inferred) {
      close(inferred, true);
    } else {
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
  }

  return intervals;
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
