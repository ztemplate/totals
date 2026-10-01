import { getDb } from '../db/database';
import { BUNDLED_BANKS } from '../data/banks';
import { bankFromJson, type Bank } from '../models/bank';
import { CASH_BANK, CASH_BANK_ID } from '../utils/cashConstants';

let cache: Bank[] | null = null;

export const bankRepository = {
  async getBanks(): Promise<Bank[]> {
    if (cache) return cache;
    try {
      const db = await getDb();
      const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM banks ORDER BY id ASC');
      cache = rows.length > 0 ? rows.map(bankFromJson) : BUNDLED_BANKS;
    } catch {
      cache = BUNDLED_BANKS;
    }
    return cache;
  },

  /** Banks plus the synthetic cash wallet. */
  async getBanksWithCash(): Promise<Bank[]> {
    return [...(await this.getBanks()), CASH_BANK];
  },

  async getBank(id: number | null | undefined): Promise<Bank | null> {
    if (id === null || id === undefined) return null;
    if (id === CASH_BANK_ID) return CASH_BANK;
    return (await this.getBanks()).find((b) => b.id === id) ?? null;
  },

  invalidate(): void {
    cache = null;
  },
};

export function bankById(banks: Bank[], id: number | null | undefined): Bank | null {
  if (id === null || id === undefined) return null;
  if (id === CASH_BANK_ID) return CASH_BANK;
  return banks.find((b) => b.id === id) ?? null;
}
