import { getDb } from '../db/database';
import type { LoanDebtStatus } from '../models/loanDebt';
import { splitFromDb, splitLoanReference, type SplitKind, type TransactionSplit } from '../models/split';
import { loanDebtRepository } from './loanDebtRepository';
import { peopleRepository } from './peopleRepository';

export interface SplitDraft {
  /** Existing split id, or undefined for a new part. */
  id?: number;
  amount: number;
  kind: SplitKind;
  categoryId?: number | null;
  personId?: number | null;
  note?: string | null;
}

export const splitRepository = {
  async getAll(): Promise<TransactionSplit[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM transaction_splits ORDER BY id');
    return rows.map(splitFromDb);
  },

  async getForTransaction(parentReference: string): Promise<TransactionSplit[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM transaction_splits WHERE parentReference = ? ORDER BY id',
      [parentReference],
    );
    return rows.map(splitFromDb);
  },

  /**
   * Replaces the parts of a transaction. Loan parts keep a loan entry ("parent#split-id") in sync,
   * so they show up under Loans and on the person's page, with repayments and paid/pending status.
   */
  async saveSplits(params: { parentReference: string; parentType: string | null | undefined; drafts: SplitDraft[] }): Promise<void> {
    const parent = params.parentReference.trim();
    if (!parent) return;
    const db = await getDb();
    const existing = await splitRepository.getForTransaction(parent);
    const keep = new Set(params.drafts.map((d) => d.id).filter((id): id is number => id != null));
    const removed = existing.filter((s) => !keep.has(s.id));
    const now = new Date().toISOString();
    const saved: TransactionSplit[] = [];

    await db.withTransactionAsync(async () => {
      for (const split of removed) {
        await db.runAsync('DELETE FROM transaction_splits WHERE id = ?', [split.id]);
      }
      for (const draft of params.drafts) {
        const values = [
          Math.abs(draft.amount),
          draft.kind,
          draft.categoryId ?? null,
          draft.personId ?? null,
          draft.note?.trim() || null,
          now,
        ];
        let id = draft.id;
        if (id != null && existing.some((s) => s.id === id)) {
          await db.runAsync(
            'UPDATE transaction_splits SET amount = ?, kind = ?, categoryId = ?, personId = ?, note = ?, updatedAt = ? WHERE id = ?',
            [...values, id],
          );
        } else {
          const result = await db.runAsync(
            `INSERT INTO transaction_splits (amount, kind, categoryId, personId, note, updatedAt, parentReference, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [...values, parent, now],
          );
          id = Number(result.lastInsertRowId);
        }
        saved.push({
          id,
          parentReference: parent,
          amount: Math.abs(draft.amount),
          kind: draft.kind,
          categoryId: draft.categoryId ?? null,
          personId: draft.personId ?? null,
          note: draft.note ?? null,
          createdAt: now,
        });
      }
    });

    // Loan entries go through the loan repository so reminders stay in sync.
    for (const split of removed) await loanDebtRepository.deleteEntryForTransaction(splitLoanReference(parent, split.id));
    const direction = (params.parentType ?? '').trim().toUpperCase() === 'CREDIT' ? 'borrowed' : 'lent';
    for (const split of saved) {
      const reference = splitLoanReference(parent, split.id);
      if (split.kind !== 'loan' || split.personId == null) {
        await loanDebtRepository.deleteEntryForTransaction(reference);
        continue;
      }
      const person = await peopleRepository.getPerson(split.personId);
      if (!person) continue;
      const existingEntry = await loanDebtRepository.getEntryForTransaction(reference);
      await loanDebtRepository.upsertTransactionPerson({
        transactionReference: reference,
        personName: person.name,
        direction,
        principalAmount: split.amount,
      });
      // upsert reopens the entry; keep a part that was already marked paid as paid.
      if (existingEntry && existingEntry.status !== 'active') {
        await loanDebtRepository.updateEntryStatus({ transactionReference: reference, status: existingEntry.status });
      }
    }
  },

  async setLoanStatus(split: TransactionSplit, status: LoanDebtStatus): Promise<void> {
    await loanDebtRepository.updateEntryStatus({
      transactionReference: splitLoanReference(split.parentReference, split.id),
      status,
    });
  },

  async deleteForTransaction(parentReference: string): Promise<void> {
    await splitRepository.saveSplits({ parentReference, parentType: null, drafts: [] });
  },

  async clearAll(): Promise<void> {
    const db = await getDb();
    const rows = await db.getAllAsync<{ parentReference: string; id: number }>('SELECT parentReference, id FROM transaction_splits');
    await db.runAsync('DELETE FROM transaction_splits');
    for (const row of rows) await loanDebtRepository.deleteEntryForTransaction(splitLoanReference(row.parentReference, row.id));
  },

  /** Restores rows from a backup as-is (ids are remapped). Returns old id -> new id. */
  async insertRaw(split: Omit<TransactionSplit, 'id'>): Promise<number> {
    const db = await getDb();
    const result = await db.runAsync(
      `INSERT INTO transaction_splits (parentReference, amount, kind, categoryId, personId, note, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        split.parentReference,
        Math.abs(split.amount),
        split.kind,
        split.categoryId,
        split.personId,
        split.note,
        split.createdAt,
        split.updatedAt ?? null,
      ],
    );
    return Number(result.lastInsertRowId);
  },
};
