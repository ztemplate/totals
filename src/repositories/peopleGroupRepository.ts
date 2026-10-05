import { getDb } from '../db/database';
import { peopleGroupFromDb, type PeopleGroup } from '../models/peopleGroup';
import { profileRepository } from './profileRepository';

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

async function attachMembers(rows: Record<string, unknown>[]): Promise<PeopleGroup[]> {
  if (rows.length === 0) return [];
  const db = await getDb();
  const members = await db.getAllAsync<{ groupId: number; personId: number }>(
    `SELECT m.groupId, m.personId FROM people_group_members m
     JOIN people p ON p.id = m.personId
     ORDER BY p.name COLLATE NOCASE`,
  );
  const byGroup = new Map<number, number[]>();
  for (const m of members) {
    const list = byGroup.get(Number(m.groupId)) ?? [];
    list.push(Number(m.personId));
    byGroup.set(Number(m.groupId), list);
  }
  return rows.map((row) => peopleGroupFromDb(row, byGroup.get(Number(row.id)) ?? []));
}

export const peopleGroupRepository = {
  /** Groups of the active profile, plus any that are not tied to a profile. */
  async getGroups(): Promise<PeopleGroup[]> {
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const rows =
      profileId !== null
        ? await db.getAllAsync<Record<string, unknown>>(
            'SELECT * FROM people_groups WHERE profileId = ? OR profileId IS NULL ORDER BY name COLLATE NOCASE',
            [profileId],
          )
        : await db.getAllAsync<Record<string, unknown>>('SELECT * FROM people_groups ORDER BY name COLLATE NOCASE');
    return attachMembers(rows);
  },

  async getAllGroups(): Promise<PeopleGroup[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM people_groups ORDER BY id');
    return attachMembers(rows);
  },

  async createGroup(name: string, memberIds: number[]): Promise<number> {
    const clean = cleanName(name);
    if (!clean) throw new Error('Enter a group name.');
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const now = new Date().toISOString();
    let id = 0;
    await db.withTransactionAsync(async () => {
      const result = await db.runAsync(
        'INSERT INTO people_groups (name, profileId, createdAt, updatedAt) VALUES (?, ?, ?, ?)',
        [clean, profileId, now, now],
      );
      id = Number(result.lastInsertRowId);
      for (const personId of new Set(memberIds)) {
        await db.runAsync('INSERT OR IGNORE INTO people_group_members (groupId, personId) VALUES (?, ?)', [id, personId]);
      }
    });
    return id;
  },

  async updateGroup(id: number, name: string, memberIds: number[]): Promise<void> {
    const clean = cleanName(name);
    if (!clean) throw new Error('Enter a group name.');
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('UPDATE people_groups SET name = ?, updatedAt = ? WHERE id = ?', [clean, new Date().toISOString(), id]);
      await db.runAsync('DELETE FROM people_group_members WHERE groupId = ?', [id]);
      for (const personId of new Set(memberIds)) {
        await db.runAsync('INSERT OR IGNORE INTO people_group_members (groupId, personId) VALUES (?, ?)', [id, personId]);
      }
    });
  },

  async deleteGroup(id: number): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM people_group_members WHERE groupId = ?', [id]);
      await db.runAsync('DELETE FROM people_groups WHERE id = ?', [id]);
    });
  },

  async clearAll(): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM people_group_members');
      await db.runAsync('DELETE FROM people_groups');
    });
  },
};
