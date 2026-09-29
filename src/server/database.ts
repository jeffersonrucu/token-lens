import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Database = DatabaseSync

export function openDatabase(path = process.env.MONITOR_DB_PATH ?? join(homedir(), '.tokenlens', 'app.db')): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (const [index, migrate] of migrations.entries()) {
    if (index < version) continue
    db.exec('BEGIN')
    try {
      migrate(db)
      db.exec(`PRAGMA user_version = ${index + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return db
}

// Each runs once, in order, and `user_version` counts the ones applied: append new ones, never edit them.
// The first is idempotent because databases from before `user_version` start at 0 with any of its tables.
const migrations: ((db: Database) => void)[] = [
  baseline,
  // Sessions the user starred, with an optional name of their own.
  (db) =>
    db.exec(`CREATE TABLE favorites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      name TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, session_id)
    )`),
]

function baseline(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar_seed TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    hidden_sections TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS privacy (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS ignored_projects (
    path TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  )`)
  // Each session's detail without the chat, kept after the agent deletes the transcript.
  db.exec(`CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    detail TEXT NOT NULL
  )`)
  // Added after the table first shipped, so older databases need the column.
  const columns = db.prepare('PRAGMA table_info(preferences)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'section_order')) db.exec("ALTER TABLE preferences ADD COLUMN section_order TEXT NOT NULL DEFAULT '[]'")
  // Accounts from before onboarding existed already use the dashboard, so they count as done.
  const userColumns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[]
  if (!userColumns.some((column) => column.name === 'onboarded_at')) {
    db.exec('ALTER TABLE users ADD COLUMN onboarded_at TEXT')
    db.exec('UPDATE users SET onboarded_at = created_at')
  }
  // Only the hub leaves it empty until the link in the e-mail is opened.
  if (!userColumns.some((column) => column.name === 'verified_at')) {
    db.exec('ALTER TABLE users ADD COLUMN verified_at TEXT')
    db.exec('UPDATE users SET verified_at = created_at')
  }
  // Local only: where this account sends its shares, and the links it made.
  db.exec(`CREATE TABLE IF NOT EXISTS hub_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    api_key TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS local_shares (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`)
  // Hub only: the tables below are unused on a local install.
  db.exec(`CREATE TABLE IF NOT EXISTS email_codes (
    code_hash TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS viewer_sessions (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS ingest_keys (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )`)
  // ponytail: the latest detail lives in one JSON column; move it out if shares grow past a few MB.
  db.exec(`CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    access TEXT NOT NULL,
    emails TEXT NOT NULL,
    expires_at TEXT,
    data TEXT,
    updated_at TEXT,
    created_at TEXT NOT NULL
  )`)
}
