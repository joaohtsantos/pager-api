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
  `);

  // Migration: add handled columns to existing requests table
  try { db.exec("ALTER TABLE requests ADD COLUMN handled INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE requests ADD COLUMN handled_at TEXT"); } catch {}

  // Migration: enrich pushes with delivery metadata
  try { db.exec("ALTER TABLE pushes ADD COLUMN apns_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE pushes ADD COLUMN collapse_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE pushes ADD COLUMN provider_status TEXT"); } catch {}
  try { db.exec("ALTER TABLE pushes ADD COLUMN provider_response TEXT"); } catch {}
}
