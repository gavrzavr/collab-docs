import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "collab-docs.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const fs = require("fs");
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'Untitled',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS yjs_documents (
        doc_id TEXT PRIMARY KEY,
        state BLOB,
        FOREIGN KEY (doc_id) REFERENCES documents(id)
      );
    `);
  }
  return db;
}

export function createDocument(id: string): { id: string; createdAt: string } {
  const now = new Date().toISOString();
  const database = getDb();
  database
    .prepare("INSERT INTO documents (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, "Untitled", now, now);
  return { id, createdAt: now };
}

export function getDocument(id: string) {
  const database = getDb();
  return database.prepare("SELECT * FROM documents WHERE id = ?").get(id) as
    | { id: string; title: string; created_at: string; updated_at: string }
    | undefined;
}

export function updateDocumentTimestamp(id: string) {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare("UPDATE documents SET updated_at = ? WHERE id = ?").run(now, id);
}

export function saveYjsState(docId: string, state: Buffer) {
  const database = getDb();
  database
    .prepare(
      "INSERT INTO yjs_documents (doc_id, state) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET state = ?"
    )
    .run(docId, state, state);
}

export function loadYjsState(docId: string): Buffer | null {
  const database = getDb();
  const row = database.prepare("SELECT state FROM yjs_documents WHERE doc_id = ?").get(docId) as
    | { state: Buffer }
    | undefined;
  return row?.state ?? null;
}
