import { getDb, type SqlValue } from '../db/database';
import { accountFromDb } from '../models/account';
import { REIMBURSEMENT_KEY } from '../models/category';
import {
  OwnerAssignment,
  isCredit,
  makeTransaction,
  selectedCategoryIds,
  transactionFromJson,
  type Transaction,
} from '../models/transaction';
import { autoCategorization } from '../services/autoCategorization';
import { registeredAccountNumbersMatch, transactionBelongsToAccount } from '../utils/accountIdentity';
import { CASH_BANK_ID } from '../utils/cashConstants';
import { bankRepository } from './bankRepository';
import { profileRepository } from './profileRepository';

const MAX_SQL_VARS = 900;

const COLUMNS = [
  'amount',
  'reference',
  'creditor',
  'receiver',
  'note',
  'time',
  'status',
  'currentBalance',
  'serviceCharge',
  'vat',
  'bankId',
  'type',
  'transactionLink',
  'accountNumber',
  'ownerAccountNumber',
  'ownerAssignmentSource',
  'categoryId',
  'categoryIds',
  'profileId',
  'sourceType',
  'sourceMessageId',
  'sourceFingerprint',
  'sourceSubscriptionId',
  'year',
  'month',
  'day',
  'week',
] as const;

export interface TransactionOwnershipUpdate {
  reference: string;
  ownerAccountNumber: string | null;
  ownerAssignmentSource?: string | null;
  sourceSubscriptionId?: number | null;
  sourceMessageId?: string | null;
}

function chunks<T>(items: T[], size = MAX_SQL_VARS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

function encodeCategoryIds(tx: Transaction): string | null {
  const ids = selectedCategoryIds(tx);
  return ids.length === 0 ? null : JSON.stringify(ids);
}

function rowValues(tx: Transaction, profileId: number | null): SqlValue[] {
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;
  let week: number | null = null;
  if (tx.time) {
    const d = new Date(tx.time);
    if (!Number.isNaN(d.getTime())) {
      year = d.getFullYear();
      month = d.getMonth() + 1;
      day = d.getDate();
      week = Math.floor((day - 1) / 7) + 1;
    }
  }
  return [
    tx.amount,
    tx.reference,
    tx.creditor ?? null,
    tx.receiver ?? null,
    tx.note ?? null,
    tx.time ?? null,
    tx.status ?? null,
    tx.currentBalance ?? null,
    tx.serviceCharge ?? null,
    tx.vat ?? null,
    tx.bankId ?? null,
    tx.type ?? null,
    tx.transactionLink ?? null,
    tx.accountNumber ?? null,
    tx.ownerAccountNumber ?? null,
    tx.ownerAssignmentSource ?? null,
    tx.categoryId ?? null,
    encodeCategoryIds(tx),
    profileId,
    tx.sourceType ?? null,
    tx.sourceMessageId ?? null,
    tx.sourceFingerprint ?? null,
    tx.sourceSubscriptionId ?? null,
    year,
    month,
    day,
    week,
  ];
}

const INSERT_SQL = (conflict: 'REPLACE' | 'IGNORE') =>
  `INSERT OR ${conflict} INTO transactions (${COLUMNS.join(', ')}) VALUES (${placeholders(COLUMNS.length)})`;

async function applyAutoCategorization(tx: Transaction): Promise<Transaction> {
  const selection = await autoCategorization.getCategorySelectionForTransaction({
    type: tx.type,
    receiver: tx.receiver,
    creditor: tx.creditor,
  });
  if (!selection || selection.categoryIds.length === 0) return tx;
  return makeTransaction({ ...tx, categoryId: selection.primaryCategoryId, categoryIds: selection.categoryIds });
}

function profileFilter(profileId: number | null): { sql: string; args: SqlValue[] } {
  return profileId !== null ? { sql: ' AND profileId = ?', args: [profileId] } : { sql: '', args: [] };
}

/** Removes the built-in reimbursement category from credits that lost their final allocation. */
async function removeCategoryFromOrphanedReimbursements(references: Set<string>): Promise<void> {
  if (references.size === 0) return;
  const db = await getDb();
  const refs = [...references];
  const stillLinked = new Set<string>();
  for (const chunk of chunks(refs)) {
    const rows = await db.getAllAsync<{ r: string }>(
      `SELECT DISTINCT reimbursementTransactionReference AS r FROM reimbursement_allocations
       WHERE reimbursementTransactionReference IN (${placeholders(chunk.length)})`,
      chunk,
    );
    rows.forEach((row) => stillLinked.add(row.r));
  }
  const orphaned = refs.filter((r) => !stillLinked.has(r));
  if (orphaned.length === 0) return;
  const catRows = await db.getAllAsync<{ id: number }>('SELECT id FROM categories WHERE builtInKey = ?', [REIMBURSEMENT_KEY]);
  const reimbursementIds = new Set(catRows.map((r) => r.id));
  if (reimbursementIds.size === 0) return;

  for (const chunk of chunks(orphaned)) {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM transactions WHERE reference IN (${placeholders(chunk.length)})`,
      chunk,
    );
    for (const row of rows) {
      const tx = transactionFromJson(row);
      if (!isCredit(tx)) continue;
      const selected = selectedCategoryIds(tx);
      const remaining = selected.filter((id) => !reimbursementIds.has(id));
      if (remaining.length === selected.length) continue;
      const primary = tx.categoryId != null && remaining.includes(tx.categoryId) ? tx.categoryId : remaining[0] ?? null;
      await db.runAsync('UPDATE transactions SET categoryId = ?, categoryIds = ? WHERE reference = ?', [
        primary,
        remaining.length === 0 ? null : JSON.stringify(remaining),
        tx.reference,
      ]);
    }
  }
}

async function findReimbursementsLinkedToExpenses(references: string[]): Promise<Set<string>> {
  const db = await getDb();
  const out = new Set<string>();
  for (const chunk of chunks(references)) {
    const rows = await db.getAllAsync<{ r: string }>(
      `SELECT DISTINCT reimbursementTransactionReference AS r FROM reimbursement_allocations
       WHERE expenseTransactionReference IN (${placeholders(chunk.length)})`,
      chunk,
    );
    rows.forEach((row) => row.r && out.add(row.r));
  }
  return out;
}

async function deleteAllocationsFor(references: string[]): Promise<void> {
  const db = await getDb();
  for (const chunk of chunks(references)) {
    const ph = placeholders(chunk.length);
    await db.runAsync(`DELETE FROM reimbursement_allocations WHERE reimbursementTransactionReference IN (${ph})`, chunk);
    await db.runAsync(`DELETE FROM reimbursement_allocations WHERE expenseTransactionReference IN (${ph})`, chunk);
  }
}

async function deleteMatching(where: string, args: SqlValue[]): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    const rows = await db.getAllAsync<{ reference: string }>(`SELECT reference FROM transactions WHERE ${where}`, args);
    const refs = rows.map((r) => r.reference).filter(Boolean);
    const affected = await findReimbursementsLinkedToExpenses(refs);
    await db.runAsync(`DELETE FROM transactions WHERE ${where}`, args);
    await deleteAllocationsFor(refs);
    await removeCategoryFromOrphanedReimbursements(affected);
  });
}

export const transactionRepository = {
  async getTransactions(): Promise<Transaction[]> {
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const rows =
      profileId !== null
        ? await db.getAllAsync<Record<string, unknown>>(
            'SELECT * FROM transactions WHERE profileId = ? ORDER BY time DESC, id DESC',
            [profileId],
          )
        : await db.getAllAsync<Record<string, unknown>>('SELECT * FROM transactions ORDER BY time DESC, id DESC');
    return rows.map(transactionFromJson);
  },

  async getTransactionByReference(reference: string): Promise<Transaction | null> {
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    let row: Record<string, unknown> | null = null;
    if (profileId !== null) {
      row = await db.getFirstAsync('SELECT * FROM transactions WHERE reference = ? AND profileId = ? LIMIT 1', [
        reference,
        profileId,
      ]);
    }
    row ??= await db.getFirstAsync('SELECT * FROM transactions WHERE reference = ? LIMIT 1', [reference]);
    return row ? transactionFromJson(row) : null;
  },

  async findBySourceMessageId(sourceType: string, messageId: string): Promise<Transaction | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM transactions WHERE sourceType = ? AND sourceMessageId = ? LIMIT 1',
      [sourceType, messageId],
    );
    return row ? transactionFromJson(row) : null;
  },

  async findBySourceFingerprint(sourceType: string, fingerprint: string): Promise<Transaction | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM transactions WHERE sourceType = ? AND sourceFingerprint = ? LIMIT 1',
      [sourceType, fingerprint],
    );
    return row ? transactionFromJson(row) : null;
  },

  async getTransactionsForBank(bankId: number): Promise<Transaction[]> {
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const p = profileFilter(profileId);
    const rows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM transactions WHERE bankId = ?${p.sql} ORDER BY time DESC, id DESC`,
      [bankId, ...p.args],
    );
    return rows.map(transactionFromJson);
  },

  async saveTransaction(transaction: Transaction, options: { skipAutoCategorization?: boolean } = {}): Promise<void> {
    const db = await getDb();
    const profileId = transaction.profileId ?? (await profileRepository.getActiveProfileId());
    let tx = makeTransaction(transaction);
    if (!options.skipAutoCategorization && tx.categoryId == null) {
      tx = await applyAutoCategorization(tx);
    }
    await db.runAsync(INSERT_SQL('REPLACE'), rowValues(tx, profileId));
  },

  async saveAllTransactions(
    transactions: Transaction[],
    options: { skipAutoCategorization?: boolean } = {},
  ): Promise<void> {
    if (transactions.length === 0) return;
    const skip = options.skipAutoCategorization ?? true;
    const db = await getDb();
    const activeProfileId = await profileRepository.getActiveProfileId();
    const prepared: Transaction[] = [];
    for (const t of transactions) {
      let tx = makeTransaction(t);
      if (!skip && tx.categoryId == null) tx = await applyAutoCategorization(tx);
      prepared.push(tx);
    }
    await db.withTransactionAsync(async () => {
      const statement = await db.prepareAsync(INSERT_SQL('IGNORE'));
      try {
        for (const tx of prepared) {
          await statement.executeAsync(rowValues(tx, tx.profileId ?? activeProfileId));
        }
      } finally {
        await statement.finalizeAsync();
      }
    });
  },

  /** Updates only category fields for existing transactions. */
  async updateTransactionCategories(transactions: Transaction[]): Promise<number> {
    const deduped = new Map<string, Transaction>();
    for (const tx of transactions) if (tx.reference.trim()) deduped.set(tx.reference, tx);
    if (deduped.size === 0) return 0;
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const p = profileFilter(profileId);
    let changed = 0;
    await db.withTransactionAsync(async () => {
      for (const tx of deduped.values()) {
        const result = await db.runAsync(
          `UPDATE transactions SET categoryId = ?, categoryIds = ? WHERE reference = ?${p.sql}`,
          [tx.categoryId ?? null, encodeCategoryIds(tx), tx.reference, ...p.args],
        );
        changed += result.changes;
      }
    });
    return changed;
  },

  async updateNote(reference: string, note: string | null): Promise<void> {
    const db = await getDb();
    await db.runAsync('UPDATE transactions SET note = ? WHERE reference = ?', [note?.trim() ? note.trim() : null, reference]);
  },

  async updateTransactionLink(reference: string, link: string | null): Promise<void> {
    const db = await getDb();
    await db.runAsync('UPDATE transactions SET transactionLink = ? WHERE reference = ?', [link, reference]);
  },

  /** Updates ownership. Manual assignments are never overwritten by automatic ones. */
  async updateTransactionOwnership(update: TransactionOwnershipUpdate): Promise<boolean> {
    return (await this.updateTransactionOwnerships([update])) > 0;
  },

  async updateTransactionOwnerships(updates: TransactionOwnershipUpdate[]): Promise<number> {
    const deduped = new Map<string, TransactionOwnershipUpdate>();
    for (const u of updates) deduped.set(u.reference, u);
    if (deduped.size === 0) return 0;
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const p = profileFilter(profileId);
    let applied = 0;
    await db.withTransactionAsync(async () => {
      for (const u of deduped.values()) {
        const existing = await db.getFirstAsync<{ ownerAssignmentSource: string | null }>(
          `SELECT ownerAssignmentSource FROM transactions WHERE reference = ?${p.sql} LIMIT 1`,
          [u.reference, ...p.args],
        );
        if (!existing) continue;
        if (existing.ownerAssignmentSource === OwnerAssignment.manual && u.ownerAssignmentSource !== OwnerAssignment.manual) {
          continue;
        }
        const sets = ['ownerAccountNumber = ?'];
        const args: SqlValue[] = [u.ownerAccountNumber];
        if (u.ownerAssignmentSource != null) {
          sets.push('ownerAssignmentSource = ?');
          args.push(u.ownerAssignmentSource);
        }
        if (u.ownerAccountNumber === null) {
          // Clearing a disproven owner must also clear its SIM shortcut.
          sets.push('sourceSubscriptionId = NULL');
        } else if (u.sourceSubscriptionId != null && u.sourceSubscriptionId >= 0) {
          sets.push('sourceSubscriptionId = ?');
          args.push(u.sourceSubscriptionId);
        }
        if (u.sourceMessageId?.trim()) {
          sets.push('sourceMessageId = ?');
          args.push(u.sourceMessageId.trim());
        }
        const result = await db.runAsync(`UPDATE transactions SET ${sets.join(', ')} WHERE reference = ?${p.sql}`, [
          ...args,
          u.reference,
          ...p.args,
        ]);
        if (result.changes > 0) applied++;
      }
    });
    return applied;
  },

  async getTransactionsByDateRange(
    start: Date,
    end: Date,
    filters: { bankId?: number; type?: string } = {},
  ): Promise<Transaction[]> {
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const where: string[] = [];
    const args: SqlValue[] = [];
    if (profileId !== null) {
      where.push('profileId = ?');
      args.push(profileId);
    }
    const sy = start.getFullYear();
    const sm = start.getMonth() + 1;
    const sd = start.getDate();
    const ey = end.getFullYear();
    const em = end.getMonth() + 1;
    const ed = end.getDate();
    where.push(
      '(year > ? OR (year = ? AND month > ?) OR (year = ? AND month = ? AND day >= ?)) ' +
        'AND (year < ? OR (year = ? AND month < ?) OR (year = ? AND month = ? AND day <= ?))',
    );
    args.push(sy, sy, sm, sy, sm, sd, ey, ey, em, ey, em, ed);
    if (filters.bankId !== undefined) {
      where.push('bankId = ?');
      args.push(filters.bankId);
    }
    if (filters.type !== undefined) {
      where.push('type = ?');
      args.push(filters.type);
    }
    const rows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY time DESC, id DESC`,
      args,
    );
    return rows.map(transactionFromJson);
  },

  async getTransactionsByMonth(year: number, month: number, bankId?: number): Promise<Transaction[]> {
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const where = ['year = ? AND month = ?'];
    const args: SqlValue[] = [year, month];
    if (profileId !== null) {
      where.push('profileId = ?');
      args.push(profileId);
    }
    if (bankId !== undefined) {
      where.push('bankId = ?');
      args.push(bankId);
    }
    const rows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY time DESC, id DESC`,
      args,
    );
    return rows.map(transactionFromJson);
  },

  async clearAll(): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM transactions');
  },

  async clearBanks(bankIds: number[]): Promise<void> {
    if (bankIds.length === 0) return;
    await deleteMatching(`bankId IN (${placeholders(bankIds.length)})`, bankIds);
  },

  /** Deletes transactions that belong to a specific registered account in the active profile. */
  async deleteTransactionsByAccount(accountNumber: string, bank: number): Promise<void> {
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const p = profileFilter(profileId);
    if (bank === CASH_BANK_ID) {
      const where = [`bankId = ?`];
      const args: SqlValue[] = [bank];
      if (accountNumber) {
        where.push('accountNumber = ?');
        args.push(accountNumber);
      }
      await deleteMatching(`${where.join(' AND ')}${p.sql}`, [...args, ...p.args]);
      return;
    }

    const currentBank = await bankRepository.getBank(bank);
    if (!currentBank) return;
    const accountRows = await db.getAllAsync<Record<string, unknown>>(`SELECT * FROM accounts WHERE bank = ?${p.sql}`, [
      bank,
      ...p.args,
    ]);
    const bankAccounts = accountRows.map(accountFromDb);
    const targets = bankAccounts.filter((a) => registeredAccountNumbersMatch(currentBank, a.accountNumber, accountNumber));
    if (targets.length !== 1) return;
    const target = targets[0];
    const rows = await db.getAllAsync<Record<string, unknown>>(`SELECT * FROM transactions WHERE bankId = ?${p.sql}`, [
      bank,
      ...p.args,
    ]);
    const refs = rows
      .map(transactionFromJson)
      .filter((tx) => transactionBelongsToAccount(tx, target, currentBank, bankAccounts))
      .map((tx) => tx.reference);
    await this.deleteTransactionsByReferences(refs);
  },

  async deleteTransactionsByBank(bank: number): Promise<void> {
    const profileId = await profileRepository.getActiveProfileId();
    const p = profileFilter(profileId);
    await deleteMatching(`bankId = ?${p.sql}`, [bank, ...p.args]);
  },

  async deleteTransactionsByReferences(references: Iterable<string>): Promise<void> {
    const refs = [...new Set([...references].map((r) => r.trim()).filter(Boolean))];
    if (refs.length === 0) return;
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      const affected = await findReimbursementsLinkedToExpenses(refs);
      for (const chunk of chunks(refs)) {
        await db.runAsync(`DELETE FROM transactions WHERE reference IN (${placeholders(chunk.length)})`, chunk);
      }
      await deleteAllocationsFor(refs);
      await removeCategoryFromOrphanedReimbursements(affected);
    });
  },

  /** Removes one reimbursement link; the credit loses its reimbursement category when it was the last link. */
  async unlinkReimbursementAllocation(allocationId: number): Promise<void> {
    if (allocationId <= 0) return;
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      const row = await db.getFirstAsync<{ r: string }>(
        'SELECT reimbursementTransactionReference AS r FROM reimbursement_allocations WHERE id = ?',
        [allocationId],
      );
      if (!row) return;
      await db.runAsync('DELETE FROM reimbursement_allocations WHERE id = ?', [allocationId]);
      if (row.r?.trim()) await removeCategoryFromOrphanedReimbursements(new Set([row.r.trim()]));
    });
  },
};
