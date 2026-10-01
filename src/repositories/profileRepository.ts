import { getDb } from '../db/database';
import type { Profile } from '../models/misc';
import { PrefKeys, prefs } from '../services/prefs';

let cachedActiveProfileId: number | null = null;

export const profileRepository = {
  async getProfiles(): Promise<Profile[]> {
    const db = await getDb();
    return db.getAllAsync<Profile>('SELECT * FROM profiles ORDER BY id ASC');
  },

  async getProfile(id: number): Promise<Profile | null> {
    const db = await getDb();
    return (await db.getFirstAsync<Profile>('SELECT * FROM profiles WHERE id = ?', [id])) ?? null;
  },

  async createProfile(name: string): Promise<number> {
    const db = await getDb();
    const now = new Date().toISOString();
    const result = await db.runAsync('INSERT INTO profiles (name, createdAt, updatedAt) VALUES (?, ?, ?)', [
      name.trim() || 'Profile',
      now,
      now,
    ]);
    return result.lastInsertRowId;
  },

  async renameProfile(id: number, name: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('UPDATE profiles SET name = ?, updatedAt = ? WHERE id = ?', [name.trim(), new Date().toISOString(), id]);
  },

  /** Deletes a profile and every row scoped to it. The last profile cannot be deleted. */
  async deleteProfile(id: number): Promise<boolean> {
    const db = await getDb();
    const count = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM profiles');
    if ((count?.c ?? 0) <= 1) return false;
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM transactions WHERE profileId = ?', [id]);
      await db.runAsync('DELETE FROM accounts WHERE profileId = ?', [id]);
      await db.runAsync('DELETE FROM profiles WHERE id = ?', [id]);
    });
    if ((await this.getActiveProfileId()) === id) {
      const first = await db.getFirstAsync<{ id: number }>('SELECT id FROM profiles ORDER BY id ASC LIMIT 1');
      if (first) await this.setActiveProfile(first.id);
    }
    return true;
  },

  /** Ensures at least one profile exists and returns the active profile id. */
  async ensureDefaultProfile(): Promise<number> {
    const db = await getDb();
    const first = await db.getFirstAsync<{ id: number }>('SELECT id FROM profiles ORDER BY id ASC LIMIT 1');
    let defaultId = first?.id;
    if (defaultId === undefined) {
      defaultId = await this.createProfile('Personal');
    }
    // Rows created before profiles existed belong to the first profile.
    await db.runAsync('UPDATE transactions SET profileId = ? WHERE profileId IS NULL', [defaultId]);
    await db.runAsync('UPDATE accounts SET profileId = ? WHERE profileId IS NULL', [defaultId]);

    const stored = await prefs.getNumber(PrefKeys.activeProfileId);
    if (stored !== null && (await this.getProfile(stored))) {
      cachedActiveProfileId = stored;
      return stored;
    }
    await this.setActiveProfile(defaultId);
    return defaultId;
  },

  async getActiveProfileId(): Promise<number | null> {
    if (cachedActiveProfileId !== null) return cachedActiveProfileId;
    const stored = await prefs.getNumber(PrefKeys.activeProfileId);
    if (stored !== null) {
      cachedActiveProfileId = stored;
      return stored;
    }
    return this.ensureDefaultProfile();
  },

  async setActiveProfile(id: number): Promise<void> {
    cachedActiveProfileId = id;
    await prefs.setNumber(PrefKeys.activeProfileId, id);
  },

  async getActiveProfile(): Promise<Profile | null> {
    const id = await this.getActiveProfileId();
    return id === null ? null : this.getProfile(id);
  },
};
