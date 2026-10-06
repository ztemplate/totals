import { boolToInt, getDb, type SqlValue } from '../db/database';
import {
  assetFromDb,
  incomeSourceFromDb,
  opportunityFromDb,
  plannedItemFromDb,
  type Asset,
  type IncomeSource,
  type MoneyOpportunity,
  type PlannedItem,
} from '../models/planning';
import { profileRepository } from './profileRepository';

type Row = Record<string, unknown>;

/** Fields a form edits: no id, profile or timestamps. */
export type PlannedItemDraft = Omit<PlannedItem, 'id' | 'profileId' | 'createdAt' | 'updatedAt'>;
export type IncomeSourceDraft = Omit<IncomeSource, 'id' | 'profileId' | 'createdAt' | 'updatedAt'>;
export type AssetDraft = Omit<Asset, 'id' | 'profileId' | 'createdAt' | 'updatedAt'>;
export type OpportunityDraft = Omit<MoneyOpportunity, 'id' | 'profileId' | 'createdAt' | 'updatedAt'>;

function cleanName(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('Enter a name.');
  return clean;
}

function cleanNote(note: string | null | undefined): string | null {
  return note?.trim() ? note.trim() : null;
}

/** Shared CRUD for the planning tables, which all scope rows to the active profile. */
function table<T, D>(name: string, fromDb: (row: Row) => T, columns: (draft: D) => Record<string, SqlValue>, orderBy: string) {
  return {
    async getAll(): Promise<T[]> {
      const db = await getDb();
      const profileId = await profileRepository.getActiveProfileId();
      const rows =
        profileId !== null
          ? await db.getAllAsync<Row>(`SELECT * FROM ${name} WHERE profileId = ? OR profileId IS NULL ORDER BY ${orderBy}`, [profileId])
          : await db.getAllAsync<Row>(`SELECT * FROM ${name} ORDER BY ${orderBy}`);
      return rows.map(fromDb);
    },

    async create(draft: D): Promise<number> {
      const values = columns(draft);
      const db = await getDb();
      const profileId = await profileRepository.getActiveProfileId();
      const now = new Date().toISOString();
      const keys = [...Object.keys(values), 'profileId', 'createdAt', 'updatedAt'];
      const result = await db.runAsync(
        `INSERT INTO ${name} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
        [...Object.values(values), profileId, now, now],
      );
      return Number(result.lastInsertRowId);
    },

    async update(id: number, draft: D): Promise<void> {
      const values = columns(draft);
      const db = await getDb();
      const keys = Object.keys(values);
      await db.runAsync(`UPDATE ${name} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updatedAt = ? WHERE id = ?`, [
        ...Object.values(values),
        new Date().toISOString(),
        id,
      ]);
    },

    async remove(id: number): Promise<void> {
      const db = await getDb();
      await db.runAsync(`DELETE FROM ${name} WHERE id = ?`, [id]);
    },
  };
}

export const plannedItemRepository = {
  ...table<PlannedItem, PlannedItemDraft>(
    'planned_items',
    plannedItemFromDb,
    (d) => ({
      name: cleanName(d.name),
      price: Math.max(0, d.price),
      priority: d.priority,
      neededBy: d.neededBy,
      saved: Math.max(0, d.saved),
      note: cleanNote(d.note),
      bought: boolToInt(d.bought),
      boughtAt: d.bought ? (d.boughtAt ?? new Date().toISOString()) : null,
    }),
    'bought, neededBy IS NULL, neededBy, id',
  ),

  async setBought(id: number, bought: boolean): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync('UPDATE planned_items SET bought = ?, boughtAt = ?, updatedAt = ? WHERE id = ?', [
      bought ? 1 : 0,
      bought ? now : null,
      now,
      id,
    ]);
  },
};

export const incomeSourceRepository = table<IncomeSource, IncomeSourceDraft>(
  'income_sources',
  incomeSourceFromDb,
  (d) => ({
    name: cleanName(d.name),
    amount: Math.max(0, d.amount),
    frequency: d.frequency,
    startDate: d.startDate,
    endDate: d.frequency === 'once' ? null : d.endDate,
    certainty: d.certainty,
    note: cleanNote(d.note),
  }),
  'startDate, id',
);

export const assetRepository = table<Asset, AssetDraft>(
  'assets',
  assetFromDb,
  (d) => ({ name: cleanName(d.name), value: Math.max(0, d.value), liquidity: d.liquidity, note: cleanNote(d.note) }),
  'value DESC, id',
);

export const opportunityRepository = table<MoneyOpportunity, OpportunityDraft>(
  'money_opportunities',
  opportunityFromDb,
  (d) => ({
    name: cleanName(d.name),
    reward: Math.max(0, d.reward),
    hours: Math.max(0, d.hours),
    strain: d.strain,
    chance: Math.min(100, Math.max(0, d.chance)),
    note: cleanNote(d.note),
    done: boolToInt(d.done),
  }),
  'done, id',
);
