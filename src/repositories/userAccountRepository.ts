import { getDb } from '../db/database';
import type { UserAccount } from '../models/misc';

function fromDb(row: Record<string, any>): UserAccount {
  return {
    id: row.id ?? null,
    accountNumber: String(row.accountNumber ?? ''),
    bankId: Number(row.bankId),
    accountHolderName: String(row.accountHolderName ?? ''),
    createdAt: String(row.createdAt ?? ''),
  };
}

/** Accounts the user has saved for the Account Hub (QR sharing), independent of tracked accounts. */
export const userAccountRepository = {
  async getUserAccounts(): Promise<UserAccount[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM user_accounts ORDER BY createdAt DESC');
    return rows.map(fromDb);
  },

  async saveUserAccount(account: UserAccount): Promise<number> {
    const db = await getDb();
    const result = await db.runAsync(
      'INSERT OR REPLACE INTO user_accounts (accountNumber, bankId, accountHolderName, createdAt) VALUES (?, ?, ?, ?)',
      [account.accountNumber, account.bankId, account.accountHolderName, account.createdAt],
    );
    return result.lastInsertRowId;
  },

  async deleteUserAccount(id: number): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM user_accounts WHERE id = ?', [id]);
  },

  async deleteUserAccountByNumberAndBank(accountNumber: string, bankId: number): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM user_accounts WHERE accountNumber = ? AND bankId = ?', [accountNumber, bankId]);
  },

  async clearAll(): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM user_accounts');
  },

  async userAccountExists(accountNumber: string, bankId: number): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync('SELECT id FROM user_accounts WHERE accountNumber = ? AND bankId = ? LIMIT 1', [
      accountNumber,
      bankId,
    ]);
    return row !== null;
  },
};
