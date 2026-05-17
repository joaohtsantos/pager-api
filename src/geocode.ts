import { getDb } from "./database";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "pager-api/1.0 (joaohteixeirasantos@gmail.com)";
const MIN_SPACING_MS = 1100;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type Geocode = {
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
};

let lastFetchAt = 0;
let pending: Promise<unknown> = Promise.resolve();

function roundKey(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function readCache(latR: number, lonR: number): Geocode | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT neighborhood, city, state, country, fetched_at FROM reverse_geocode_cache WHERE lat_r = ? AND lon_r = ?"
  ).get(latR, lonR) as (Geocode & { fetched_at: string }) | undefined;
  if (!row) return null;
  const ageMs = Date.now() - new Date(row.fetched_at).getTime();
  if (ageMs > CACHE_TTL_MS) return null;
  return { neighborhood: row.neighborhood, city: row.city, state: row.state, country: row.country };
}

function writeCache(latR: number, lonR: number, g: Geocode): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO reverse_geocode_cache (lat_r, lon_r, neighborhood, city, state, country, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lat_r, lon_r) DO UPDATE SET
      neighborhood = excluded.neighborhood,
      city = excluded.city,
      state = excluded.state,
      country = excluded.country,
      fetched_at = excluded.fetched_at
  `).run(latR, lonR, g.neighborhood, g.city, g.state, g.country, new Date().toISOString());
}

async function fetchFromNominatim(lat: number, lon: number): Promise<Geocode> {
  const url = `${NOMINATIM_URL}?lat=${lat}&lon=${lon}&format=jsonv2&zoom=16&accept-language=pt-BR,en`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) {
    throw new Error(`Nominatim ${resp.status}`);
  }
  const data = await resp.json() as { address?: Record<string, string | undefined> };
  const a = data.address ?? {};
  return {
    neighborhood: a.neighbourhood ?? a.suburb ?? a.quarter ?? a.city_district ?? null,
    city: a.city ?? a.town ?? a.village ?? a.municipality ?? null,
    state: a.state ?? a.region ?? null,
    country: a.country ?? null,
  };
}

export async function reverseGeocode(lat: number, lon: number): Promise<Geocode> {
  const latR = roundKey(lat);
  const lonR = roundKey(lon);

  const cached = readCache(latR, lonR);
  if (cached) return cached;

  // Serialize Nominatim requests to honour the 1 req/s policy.
  const run = pending.then(async () => {
    const wait = Math.max(0, MIN_SPACING_MS - (Date.now() - lastFetchAt));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastFetchAt = Date.now();
    try {
      const g = await fetchFromNominatim(lat, lon);
      writeCache(latR, lonR, g);
      return g;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[geocode] failed for ${latR},${lonR}: ${msg}`);
      return { neighborhood: null, city: null, state: null, country: null };
    }
  });
  pending = run.catch(() => undefined);
  return run;
}
