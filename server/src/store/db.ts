import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { withTransaction } from "./tx.ts";

export const MIGRATIONS: string[] = [
  `CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, position)
);

CREATE TABLE turn_traces (
  id TEXT PRIMARY KEY,
  user_message_id TEXT NOT NULL REFERENCES messages(id),
  attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  trace_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,
  // v2: every turn reads the next attempt number and the trace endpoint reads by message, both by
  // user_message_id. Without this, each is a scan of every trace ever written.
  `CREATE INDEX turn_traces_by_message ON turn_traces (user_message_id, attempt);`,
];

export type OpenResult = {
  db: DatabaseSync;
  warning: "previous_history_unreadable" | null;
  recoveredTo: string | null;
};

const SNAPSHOT = ".pre-open";

function tryOpen(path: string): DatabaseSync | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path);
    // Opening a corrupt file often succeeds; the first query is what fails.
    const rows = db.prepare("PRAGMA quick_check").all();
    const first = rows[0] as Record<string, unknown> | undefined;
    if (rows.length === 1 && first && Object.values(first)[0] === "ok") return db;
  } catch {
    // fall through to close
  }
  try {
    db?.close();
  } catch {
    // already unusable
  }
  return null;
}

function moveAside(path: string, now: () => Date): string {
  const stamp = now().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  // ISO "2026-11-14T12:00:00.000Z" -> "2026-11-14T12-00-00-000Z"
  let target = `${path}.broken-${stamp}`;
  // A second recovery in the same millisecond must not overwrite the first.
  for (let n = 1; ["", "-wal", "-shm"].some((s) => existsSync(target + s)); n++) {
    target = `${path}.broken-${stamp}-${n}`;
  }
  renameSync(path, target);
  for (const suffix of ["-wal", "-shm"]) {
    // SQLite deletes a sidecar it cannot use while failing to open, so the preserved
    // copy is the one taken before the open attempt.
    if (existsSync(path + suffix + SNAPSHOT)) renameSync(path + suffix + SNAPSHOT, target + suffix);
    rmSync(path + suffix, { force: true });
  }
  return target;
}

function configure(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  // Only matters for another process holding the file (eval script, sqlite3 shell);
  // tabs share this process's single connection.
  db.exec("PRAGMA busy_timeout = 5000");
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version >= MIGRATIONS.length) return;
  withTransaction(db, () => {
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
  });
}

export function openDatabase(path: string, opts: { now?: () => Date } = {}): OpenResult {
  const now = opts.now ?? (() => new Date());
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  if (existed) {
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(path + suffix)) copyFileSync(path + suffix, path + suffix + SNAPSHOT);
    }
  }
  let db = existed ? tryOpen(path) : null;
  if (db) for (const suffix of ["-wal", "-shm"]) rmSync(path + suffix + SNAPSHOT, { force: true });
  let warning: OpenResult["warning"] = null;
  let recoveredTo: string | null = null;
  if (!db) {
    if (existsSync(path)) {
      recoveredTo = moveAside(path, now);
      warning = "previous_history_unreadable";
    }
    db = new DatabaseSync(path);
  }
  configure(db);
  migrate(db);
  return { db, warning, recoveredTo };
}
