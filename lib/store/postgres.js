// Memory storage backed by PostgreSQL, used by the cloud server.
// See ./sqlite.js for the desktop equivalent and lib/memory.js for the contract.
import { one, many, query } from '../db.js';

export function postgresStore() {
  return {
    kind: 'postgres',

    async getHistory(userId, persona, limit) {
      const rows = await many(
        'SELECT role, content FROM messages WHERE user_id = $1 AND persona = $2 ORDER BY id DESC LIMIT $3',
        [userId, persona, limit],
      );
      return rows.reverse().map((m) => ({ role: m.role, content: m.content }));
    },

    async addMessage(userId, persona, role, content) {
      await query('INSERT INTO messages (user_id, persona, role, content) VALUES ($1, $2, $3, $4)', [userId, persona, role, content]);
    },

    async historyCounts(userId) {
      const rows = await many('SELECT persona, COUNT(*)::int AS n FROM messages WHERE user_id = $1 GROUP BY persona', [userId]);
      return Object.fromEntries(rows.map((r) => [r.persona, r.n]));
    },

    async getMemoryData(userId) {
      const row = await one('SELECT data FROM memory WHERE user_id = $1', [userId]);
      return row?.data || null;
    },

    async saveMemoryData(userId, data) {
      await query(
        `INSERT INTO memory (user_id, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = now()`,
        [userId, JSON.stringify(data)],
      );
    },

    async deleteMessages(userId) {
      await query('DELETE FROM messages WHERE user_id = $1', [userId]);
    },

    async deleteMemory(userId) {
      await query('DELETE FROM memory WHERE user_id = $1', [userId]);
    },
  };
}
