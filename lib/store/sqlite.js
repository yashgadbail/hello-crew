// Memory storage backed by SQLite, used by the desktop host.
//
// node:sqlite ships with Node (and therefore with Electron), so the desktop app
// needs no native module to compile and no database to install. The API is
// synchronous; the methods stay async to match ./postgres.js exactly.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  persona    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS messages_by_user ON messages (user_id, persona, id);

CREATE TABLE IF NOT EXISTS memory (
  user_id    TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/** @param {string} file path to the .db file (directories are created). */
export function sqliteStore(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const stmt = {
    history: db.prepare('SELECT role, content FROM messages WHERE user_id = ? AND persona = ? ORDER BY id DESC LIMIT ?'),
    add: db.prepare('INSERT INTO messages (user_id, persona, role, content) VALUES (?, ?, ?, ?)'),
    counts: db.prepare('SELECT persona, COUNT(*) AS n FROM messages WHERE user_id = ? GROUP BY persona'),
    getMem: db.prepare('SELECT data FROM memory WHERE user_id = ?'),
    setMem: db.prepare(
      `INSERT INTO memory (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
    ),
    delMsgs: db.prepare('DELETE FROM messages WHERE user_id = ?'),
    delMem: db.prepare('DELETE FROM memory WHERE user_id = ?'),
  };

  return {
    kind: 'sqlite',
    file,
    close: () => db.close(),

    async getHistory(userId, persona, limit) {
      return stmt.history
        .all(userId, persona, limit)
        .reverse()
        .map((m) => ({ role: m.role, content: m.content }));
    },

    async addMessage(userId, persona, role, content) {
      stmt.add.run(userId, persona, role, content);
    },

    async historyCounts(userId) {
      return Object.fromEntries(stmt.counts.all(userId).map((r) => [r.persona, Number(r.n)]));
    },

    async getMemoryData(userId) {
      const row = stmt.getMem.get(userId);
      if (!row) return null;
      try {
        return JSON.parse(row.data);
      } catch {
        return null; // corrupted row: start over rather than crash the call
      }
    },

    async saveMemoryData(userId, data) {
      stmt.setMem.run(userId, JSON.stringify(data));
    },

    async deleteMessages(userId) {
      stmt.delMsgs.run(userId);
    },

    async deleteMemory(userId) {
      stmt.delMem.run(userId);
    },
  };
}
