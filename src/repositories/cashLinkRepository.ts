import { getDb } from '../db/database';

export interface CashSpendLink {
  /** A cash wallet DEBIT. */
  cashReference: string;
  /** The ATM withdrawal (bank DEBIT) the cash came from. */
  withdrawalReference: string;
  createdAt: string;
}

/** Ties cash spending back to the ATM withdrawal it was paid from. */
export const cashLinkRepository = {
  async getAll(): Promise<CashSpendLink[]> {
    const db = await getDb();
    return db.getAllAsync<CashSpendLink>('SELECT cashReference, withdrawalReference, createdAt FROM cash_spend_links');
  },

  async link(cashReference: string, withdrawalReference: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      'INSERT OR REPLACE INTO cash_spend_links (cashReference, withdrawalReference, createdAt) VALUES (?, ?, ?)',
      [cashReference, withdrawalReference, new Date().toISOString()],
    );
  },

  async unlink(cashReference: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM cash_spend_links WHERE cashReference = ?', [cashReference]);
  },

  async clearAll(): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM cash_spend_links');
  },
};
