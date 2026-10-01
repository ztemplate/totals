import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb, type SqlValue } from '../db/database';
import { accountFromDb, type Account } from '../models/account';
import { CASH_ACCOUNT_NUMBER, CASH_BANK_ID } from '../utils/cashConstants';
import { registeredAccountNumbersMatch } from '../utils/accountIdentity';
import { bankRepository } from './bankRepository';
import { profileRepository } from './profileRepository';

function profileClause(profileId: number | null, strict: boolean): { sql: string; args: SqlValue[] } {
  if (profileId !== null) return { sql: ' AND profileId = ?', args: [profileId] };
  return strict ? { sql: ' AND profileId IS NULL', args: [] } : { sql: '', args: [] };
}

async function ensureCashAccount(db: SQLiteDatabase, profileId: number | null): Promise<void> {
  const p = profileClause(profileId, false);
  const existing = await db.getFirstAsync(
    `SELECT id FROM accounts WHERE bank = ? AND accountNumber = ?${p.sql} LIMIT 1`,
    [CASH_BANK_ID, CASH_ACCOUNT_NUMBER, ...p.args],
  );
  if (existing) return;
  await db.runAsync(
    `INSERT OR REPLACE INTO accounts (accountNumber, bank, balance, accountHolderName, settledBalance, pendingCredit, isDefault, profileId)
     VALUES (?, ?, 0, 'Cash', 0, 0, 1, ?)`,
    [CASH_ACCOUNT_NUMBER, CASH_BANK_ID, profileId],
  );
}

async function ensureDefaultAccountForBank(db: SQLiteDatabase, bank: number, profileId: number | null): Promise<void> {
  const p = profileClause(profileId, true);
  const rows = await db.getAllAsync<{ id: number; isDefault: number }>(
    `SELECT id, isDefault FROM accounts WHERE bank = ?${p.sql} ORDER BY id ASC`,
    [bank, ...p.args],
  );
  if (rows.length === 0 || rows.some((r) => r.isDefault === 1)) return;
  await db.runAsync('UPDATE accounts SET isDefault = 1 WHERE id = ?', [rows[0].id]);
}

export const accountRepository = {
  async getAccounts(): Promise<Account[]> {
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    await ensureCashAccount(db, profileId);
    const rows =
      profileId !== null
        ? await db.getAllAsync<Record<string, unknown>>('SELECT * FROM accounts WHERE profileId = ? ORDER BY id ASC', [profileId])
        : await db.getAllAsync<Record<string, unknown>>('SELECT * FROM accounts ORDER BY id ASC');
    return rows.map(accountFromDb);
  },

  /**
   * Inserts or updates an account. Existing user preferences (totals inclusion,
   * dormancy, default) are never reset by balance refreshes.
   */
  async saveAccount(account: Account): Promise<void> {
    const db = await getDb();
    const profileId = account.profileId ?? (await profileRepository.getActiveProfileId());
    const existing = await db.getFirstAsync<Record<string, any>>(
      'SELECT * FROM accounts WHERE accountNumber = ? AND bank = ? LIMIT 1',
      [account.accountNumber, account.bank],
    );
    const p = profileClause(profileId, true);
    const hasBankAccount = await db.getFirstAsync(`SELECT id FROM accounts WHERE bank = ?${p.sql} LIMIT 1`, [
      account.bank,
      ...p.args,
    ]);

    const values: SqlValue[] = [
      account.accountNumber,
      account.bank,
      account.balance,
      account.accountHolderName,
      account.settledBalance ?? null,
      account.pendingCredit ?? null,
      profileId,
      account.smsSubscriptionId ?? existing?.smsSubscriptionId ?? null,
      existing ? existing.includeInTotals : account.includeInTotals ? 1 : 0,
      existing ? existing.isDormant : account.isDormant ? 1 : 0,
      existing ? existing.isDefault : hasBankAccount ? 0 : 1,
    ];
    if (!existing) {
      await db.runAsync(
        `INSERT INTO accounts (accountNumber, bank, balance, accountHolderName, settledBalance, pendingCredit, profileId,
           smsSubscriptionId, includeInTotals, isDormant, isDefault)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values,
      );
    } else {
      await db.runAsync(
        `UPDATE accounts SET accountNumber = ?, bank = ?, balance = ?, accountHolderName = ?, settledBalance = ?,
           pendingCredit = ?, profileId = ?, smsSubscriptionId = ?, includeInTotals = ?, isDormant = ?, isDefault = ?
         WHERE id = ?`,
        [...values, existing.id],
      );
    }
  },

  /** Bulk import; rows that already exist are ignored. */
  async saveAllAccounts(accounts: Account[]): Promise<void> {
    if (accounts.length === 0) return;
    const db = await getDb();
    const activeProfileId = await profileRepository.getActiveProfileId();
    const existingRows = await db.getAllAsync<{ bank: number; profileId: number | null; isDefault: number }>(
      'SELECT bank, profileId, isDefault FROM accounts',
    );
    const key = (bank: number, profileId: number | null | undefined) => `${bank}|${profileId ?? ''}`;
    const banksWithAccounts = new Set(existingRows.map((r) => key(r.bank, r.profileId)));
    const banksWithDefaults = new Set(existingRows.filter((r) => r.isDefault === 1).map((r) => key(r.bank, r.profileId)));
    const preferred = new Map<string, string>();
    for (const account of accounts) {
      const k = key(account.bank, account.profileId ?? activeProfileId);
      if (!preferred.has(k) || account.isDefault) preferred.set(k, account.accountNumber);
    }

    await db.withTransactionAsync(async () => {
      for (const account of accounts) {
        const profileId = account.profileId ?? activeProfileId;
        const k = key(account.bank, profileId);
        const canChoose = !banksWithAccounts.has(k) && !banksWithDefaults.has(k);
        const isDefault = canChoose && preferred.get(k) === account.accountNumber;
        if (isDefault) banksWithDefaults.add(k);
        await db.runAsync(
          `INSERT OR IGNORE INTO accounts (accountNumber, bank, balance, accountHolderName, settledBalance, pendingCredit,
             profileId, smsSubscriptionId, includeInTotals, isDormant, isDefault)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            account.accountNumber,
            account.bank,
            account.balance,
            account.accountHolderName,
            account.settledBalance ?? null,
            account.pendingCredit ?? null,
            profileId,
            account.smsSubscriptionId ?? null,
            account.includeInTotals ? 1 : 0,
            account.isDormant ? 1 : 0,
            isDefault ? 1 : 0,
          ],
        );
      }
    });
  },

  async accountExists(accountNumber: string, bank: number): Promise<boolean> {
    const accounts = await this.getAccounts();
    const bankInfo = await bankRepository.getBank(bank);
    if (!bankInfo) return accounts.some((a) => a.bank === bank && a.accountNumber === accountNumber);
    return accounts.some((a) => a.bank === bank && registeredAccountNumbersMatch(bankInfo, a.accountNumber, accountNumber));
  },

  async updateAccountPreferences(params: {
    accountNumber: string;
    bank: number;
    includeInTotals?: boolean;
    isDormant?: boolean;
  }): Promise<boolean> {
    const { accountNumber, bank, includeInTotals, isDormant } = params;
    if (includeInTotals === undefined && isDormant === undefined) return false;
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const sets: string[] = [];
    const args: SqlValue[] = [];
    if (isDormant === true) {
      sets.push('includeInTotals = 0');
    } else if (includeInTotals !== undefined) {
      sets.push('includeInTotals = ?');
      args.push(includeInTotals ? 1 : 0);
    }
    if (isDormant !== undefined) {
      sets.push('isDormant = ?');
      args.push(isDormant ? 1 : 0);
    }
    const p = profileClause(profileId, false);
    const result = await db.runAsync(`UPDATE accounts SET ${sets.join(', ')} WHERE accountNumber = ? AND bank = ?${p.sql}`, [
      ...args,
      accountNumber,
      bank,
      ...p.args,
    ]);
    return result.changes > 0;
  },

  async updateAccountDetails(params: {
    accountNumber: string;
    bank: number;
    newAccountNumber?: string;
    accountHolderName?: string;
    balance?: number;
  }): Promise<void> {
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const p = profileClause(profileId, false);
    const sets: string[] = [];
    const args: SqlValue[] = [];
    if (params.newAccountNumber !== undefined) {
      sets.push('accountNumber = ?');
      args.push(params.newAccountNumber);
    }
    if (params.accountHolderName !== undefined) {
      sets.push('accountHolderName = ?');
      args.push(params.accountHolderName);
    }
    if (params.balance !== undefined) {
      sets.push('balance = ?');
      args.push(params.balance);
    }
    if (sets.length === 0) return;
    await db.runAsync(`UPDATE accounts SET ${sets.join(', ')} WHERE accountNumber = ? AND bank = ?${p.sql}`, [
      ...args,
      params.accountNumber,
      params.bank,
      ...p.args,
    ]);
    if (params.newAccountNumber !== undefined && params.newAccountNumber !== params.accountNumber) {
      await db.runAsync(
        `UPDATE transactions SET ownerAccountNumber = ? WHERE ownerAccountNumber = ? AND bankId = ?${p.sql}`,
        [params.newAccountNumber, params.accountNumber, params.bank, ...p.args],
      );
    }
  },

  async setDefaultAccount(accountNumber: string, bank: number): Promise<boolean> {
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const p = profileClause(profileId, true);
    const rows = await db.getAllAsync<{ accountNumber: string }>(
      `SELECT accountNumber FROM accounts WHERE bank = ?${p.sql}`,
      [bank, ...p.args],
    );
    if (!rows.some((r) => r.accountNumber === accountNumber)) return false;
    await db.withTransactionAsync(async () => {
      // Clear first: a partial unique index allows only one default per bank.
      await db.runAsync(`UPDATE accounts SET isDefault = 0 WHERE bank = ?${p.sql}`, [bank, ...p.args]);
      await db.runAsync(`UPDATE accounts SET isDefault = 1 WHERE bank = ?${p.sql} AND accountNumber = ?`, [
        bank,
        ...p.args,
        accountNumber,
      ]);
    });
    return true;
  },

  /** Stores a learned SMS subscription mapping without touching user-entered fields. */
  async bindSmsSubscription(accountNumber: string, bank: number, subscriptionId: number): Promise<boolean> {
    if (subscriptionId < 0) return false;
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const p = profileClause(profileId, false);
    const conflicts = await db.getAllAsync<{ accountNumber: string }>(
      `SELECT accountNumber FROM accounts WHERE bank = ? AND smsSubscriptionId = ?${p.sql}`,
      [bank, subscriptionId, ...p.args],
    );
    if (conflicts.some((r) => r.accountNumber !== accountNumber)) return false;
    const result = await db.runAsync(
      `UPDATE accounts SET smsSubscriptionId = ? WHERE accountNumber = ? AND bank = ?${p.sql}`,
      [subscriptionId, accountNumber, bank, ...p.args],
    );
    return result.changes > 0;
  },

  async updateBalance(accountNumber: string, bank: number, balance: number): Promise<void> {
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const p = profileClause(profileId, false);
    await db.runAsync(`UPDATE accounts SET balance = ? WHERE accountNumber = ? AND bank = ?${p.sql}`, [
      balance,
      accountNumber,
      bank,
      ...p.args,
    ]);
  },

  async clearAll(): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM accounts');
  },

  async clearBanks(bankIds: number[]): Promise<void> {
    if (bankIds.length === 0) return;
    const db = await getDb();
    await db.runAsync(`DELETE FROM accounts WHERE bank IN (${bankIds.map(() => '?').join(', ')})`, bankIds);
  },

  /**
   * Deletes an account and its transactions. Deleting the final account of a
   * bank removes every transaction for that bank.
   */
  async deleteAccount(accountNumber: string, bank: number): Promise<void> {
    // Imported lazily to avoid a require cycle.
    const { transactionRepository } = await import('./transactionRepository');
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const p = profileClause(profileId, true);
    const bankRows = await db.getAllAsync<{ accountNumber: string }>(
      `SELECT accountNumber FROM accounts WHERE bank = ?${p.sql}`,
      [bank, ...p.args],
    );
    const isFinal = bankRows.length === 1 && bankRows[0].accountNumber === accountNumber;

    if (bank === CASH_BANK_ID || !isFinal) {
      await transactionRepository.deleteTransactionsByAccount(accountNumber, bank);
    } else {
      await transactionRepository.deleteTransactionsByBank(bank);
    }
    await db.runAsync(`DELETE FROM accounts WHERE accountNumber = ? AND bank = ?${p.sql}`, [accountNumber, bank, ...p.args]);
    await ensureDefaultAccountForBank(db, bank, profileId);
  },
};
