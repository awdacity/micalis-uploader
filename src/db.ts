import Database from "better-sqlite3";
import path from "path";

const dbPath =
  process.env.NODE_ENV === "production"
    ? "/data/db.sqlite"
    : path.join(__dirname, "..", "dev.sqlite");

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    used_at TEXT,
    invalidated_at TEXT,
    files_uploaded TEXT DEFAULT '[]'
  )
`);

export interface TokenRow {
  id: number;
  token: string;
  label: string;
  created_at: string;
  used_at: string | null;
  invalidated_at: string | null;
  files_uploaded: string;
}

export function createToken(token: string, label: string): TokenRow {
  const stmt = db.prepare(
    "INSERT INTO tokens (token, label) VALUES (?, ?)"
  );
  stmt.run(token, label);
  return getToken(token)!;
}

export function getToken(token: string): TokenRow | undefined {
  return db
    .prepare("SELECT * FROM tokens WHERE token = ?")
    .get(token) as TokenRow | undefined;
}

export function listTokens(): TokenRow[] {
  return db.prepare("SELECT * FROM tokens ORDER BY created_at DESC").all() as TokenRow[];
}

export function invalidateToken(token: string): void {
  db.prepare(
    "UPDATE tokens SET invalidated_at = datetime('now') WHERE token = ?"
  ).run(token);
}

export function markTokenUsed(
  token: string,
  files: { name: string; size: number }[]
): void {
  db.prepare(
    "UPDATE tokens SET used_at = datetime('now'), invalidated_at = datetime('now'), files_uploaded = ? WHERE token = ?"
  ).run(JSON.stringify(files), token);
}

export function isTokenValid(row: TokenRow): boolean {
  return !row.used_at && !row.invalidated_at;
}

export default db;
