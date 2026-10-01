import { getDb } from '../db/database';
import type { FailedParse } from '../models/misc';

function fromDb(row: Record<string, any>): FailedParse {
  return {
    id: row.id ?? null,
    address: String(row.address ?? ''),
    body: String(row.body ?? ''),
    reason: String(row.reason ?? ''),
    timestamp: String(row.timestamp ?? ''),
  };
}

export const failedParseRepository = {
  async getAll(): Promise<FailedParse[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM failed_parses ORDER BY timestamp DESC');
    return rows.map(fromDb);
  },

  async count(): Promise<number> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM failed_parses');
    return row?.c ?? 0;
  },

  async add(item: FailedParse): Promise<void> {
    const db = await getDb();
    await db.runAsync('INSERT INTO failed_parses (address, body, reason, timestamp) VALUES (?, ?, ?, ?)', [
      item.address,
      item.body,
      item.reason,
      item.timestamp,
    ]);
  },

  async clear(): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM failed_parses');
  },

  async deleteById(id: number): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM failed_parses WHERE id = ?', [id]);
  },

  async deleteByIds(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await getDb();
    await db.runAsync(`DELETE FROM failed_parses WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  },
};
