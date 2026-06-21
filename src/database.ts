import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = path.resolve("./data/pager.db");

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    ensureDataDir();
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      email_subject TEXT,
      email_sender TEXT,
      email_date TEXT,
      email_message_id TEXT,
      summary TEXT,
      proposed_action TEXT,
      payload JSON,
      priority TEXT DEFAULT 'low',
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      handled INTEGER DEFAULT 0,
      handled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pushes (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      source TEXT DEFAULT 'system',
      expo_ticket_id TEXT,
      apns_id TEXT,
      collapse_id TEXT,
      provider_status TEXT,
      provider_response TEXT,
      delivered BOOLEAN DEFAULT 0,
      read BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS zones (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      radius REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS location_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      zone_id TEXT NOT NULL,
      zone_name TEXT,
      timestamp DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_location_events_zone_time
      ON location_events(zone_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS location_pings (
      id TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      accuracy REAL,
      neighborhood TEXT,
      city TEXT,
      state TEXT,
      country TEXT,
      timestamp DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_location_pings_time
      ON location_pings(timestamp DESC);

    CREATE TABLE IF NOT EXISTS presence_overrides (
      id TEXT PRIMARY KEY,
      from_ts DATETIME NOT NULL,
      to_ts DATETIME NOT NULL,
      kind TEXT DEFAULT 'zone', -- 'zone' | 'unknown' | 'transit'
      zone_id TEXT,             -- set only when kind = 'zone'
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_presence_overrides_range
      ON presence_overrides(from_ts, to_ts);

    CREATE TABLE IF NOT EXISTS reverse_geocode_cache (
      lat_r REAL NOT NULL,
      lon_r REAL NOT NULL,
      neighborhood TEXT,
      city TEXT,
      state TEXT,
      country TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (lat_r, lon_r)
    );
  `);

  // Migration: add handled columns to existing requests table
  try { db.exec("ALTER TABLE requests ADD COLUMN handled INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE requests ADD COLUMN handled_at TEXT"); } catch {}

  // Migration: presence_overrides gains a kind column (zone|unknown|transit)
  try { db.exec("ALTER TABLE presence_overrides ADD COLUMN kind TEXT DEFAULT 'zone'"); } catch {}

  // Migration: enrich pushes with delivery metadata
  try { db.exec("ALTER TABLE pushes ADD COLUMN apns_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE pushes ADD COLUMN collapse_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE pushes ADD COLUMN provider_status TEXT"); } catch {}
  try { db.exec("ALTER TABLE pushes ADD COLUMN provider_response TEXT"); } catch {}
}
