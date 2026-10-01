import { getDb } from '../db/database';
import { reimbursementFromDb, type ReimbursementAllocation } from '../models/loanDebt';
import { transactionDebitOutflowFromValues } from '../utils/transactionAmounts';

const EPSILON = 0.005;
const CHUNK = 800;

export interface ReimbursementAllocationDraft {
  expenseTransactionReference: string;
  appliedAmount: number;
}

function uniqueRefs(references: Iterable<string>): string[] {
  return [...new Set([...references].map((r) => r.trim()).filter(Boolean))];
}

export const reimbursementRepository = {
  async getAllocations(): Promise<ReimbursementAllocation[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM reimbursement_allocations ORDER BY id ASC');
    return rows.map(reimbursementFromDb);
  },

  async getForReimbursement(reimbursementReference: string): Promise<ReimbursementAllocation[]> {
    const reference = reimbursementReference.trim();
    if (!reference) return [];
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM reimbursement_allocations WHERE reimbursementTransactionReference = ? ORDER BY id ASC',
      [reference],
    );
    return rows.map(reimbursementFromDb);
  },

  async getForExpense(expenseReference: string): Promise<ReimbursementAllocation[]> {
    const reference = expenseReference.trim();
    if (!reference) return [];
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM reimbursement_allocations WHERE expenseTransactionReference = ? ORDER BY id ASC',
      [reference],
    );
    return rows.map(reimbursementFromDb);
  },

  async getAppliedTotalsForExpenses(expenseReferences: Iterable<string>): Promise<Map<string, number>> {
    const refs = uniqueRefs(expenseReferences);
    const totals = new Map<string, number>();
    if (refs.length === 0) return totals;
    const db = await getDb();
    for (let i = 0; i < refs.length; i += CHUNK) {
      const chunk = refs.slice(i, i + CHUNK);
      const rows = await db.getAllAsync<{ ref: string | null; total: number | null }>(
        `SELECT expenseTransactionReference AS ref, SUM(appliedAmount) AS total
         FROM reimbursement_allocations
         WHERE expenseTransactionReference IN (${chunk.map(() => '?').join(', ')})
         GROUP BY expenseTransactionReference`,
        chunk,
      );
      for (const row of rows) if (row.ref) totals.set(row.ref, Number(row.total ?? 0));
    }
    return totals;
  },

  async getLinkedReimbursementReferences(reimbursementReferences: Iterable<string>): Promise<Set<string>> {
    const refs = uniqueRefs(reimbursementReferences);
    const linked = new Set<string>();
    if (refs.length === 0) return linked;
    const db = await getDb();
    for (let i = 0; i < refs.length; i += CHUNK) {
      const chunk = refs.slice(i, i + CHUNK);
      const rows = await db.getAllAsync<{ ref: string | null }>(
        `SELECT DISTINCT reimbursementTransactionReference AS ref FROM reimbursement_allocations
         WHERE reimbursementTransactionReference IN (${chunk.map(() => '?').join(', ')})`,
        chunk,
      );
      for (const row of rows) {
        const ref = row.ref?.trim();
        if (ref) linked.add(ref);
      }
    }
    return linked;
  },

  /** Replaces every allocation of a reimbursement credit with the given drafts, after validating amounts. */
  async replaceForReimbursement(params: {
    reimbursementTransactionReference: string;
    allocations: Iterable<ReimbursementAllocationDraft>;
  }): Promise<void> {
    const reimbursementReference = params.reimbursementTransactionReference.trim();
    if (!reimbursementReference) throw new Error('A transaction reference is required.');

    const byExpense = new Map<string, number>();
    for (const allocation of params.allocations) {
      const ref = allocation.expenseTransactionReference.trim();
      const amount = allocation.appliedAmount;
      if (!ref || !Number.isFinite(amount) || amount <= EPSILON) continue;
      byExpense.set(ref, (byExpense.get(ref) ?? 0) + amount);
    }

    const db = await getDb();
    await db.withTransactionAsync(async () => {
      const reimbursement = await db.getFirstAsync<{ type: string | null; amount: number | null }>(
        'SELECT type, amount FROM transactions WHERE reference = ? LIMIT 1',
        [reimbursementReference],
      );
      if (!reimbursement) throw new Error('The reimbursement transaction no longer exists.');
      if (reimbursement.type?.toUpperCase() !== 'CREDIT') throw new Error('Only credit transactions can be reimbursements.');
      const reimbursementAmount = Math.abs(Number(reimbursement.amount ?? 0));
      const totalRequested = [...byExpense.values()].reduce((sum, v) => sum + v, 0);
      if (totalRequested - reimbursementAmount > EPSILON) {
        throw new Error('Applied reimbursements cannot exceed the received amount.');
      }

      for (const [ref, amount] of byExpense) {
        const expense = await db.getFirstAsync<{
          type: string | null;
          amount: number | null;
          serviceCharge: number | null;
          vat: number | null;
        }>('SELECT type, amount, serviceCharge, vat FROM transactions WHERE reference = ? LIMIT 1', [ref]);
        if (!expense) throw new Error('A selected expense no longer exists.');
        if (expense.type?.toUpperCase() !== 'DEBIT') throw new Error('Reimbursements can only be applied to expenses.');
        const other = await db.getFirstAsync<{ total: number }>(
          `SELECT COALESCE(SUM(appliedAmount), 0) AS total FROM reimbursement_allocations
           WHERE expenseTransactionReference = ? AND reimbursementTransactionReference <> ?`,
          [ref, reimbursementReference],
        );
        const available =
          transactionDebitOutflowFromValues({
            amount: Number(expense.amount ?? 0),
            serviceCharge: expense.serviceCharge,
            vat: expense.vat,
          }) - Number(other?.total ?? 0);
        if (amount - available > EPSILON) {
          throw new Error('An allocation exceeds the amount still available on an expense.');
        }
      }

      await db.runAsync('DELETE FROM reimbursement_allocations WHERE reimbursementTransactionReference = ?', [
        reimbursementReference,
      ]);
      const now = new Date().toISOString();
      for (const [ref, amount] of byExpense) {
        await db.runAsync(
          `INSERT OR REPLACE INTO reimbursement_allocations
             (reimbursementTransactionReference, expenseTransactionReference, appliedAmount, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?)`,
          [reimbursementReference, ref, amount, now, now],
        );
      }
    });
  },

  async deleteForReimbursement(reimbursementReference: string): Promise<void> {
    const reference = reimbursementReference.trim();
    if (!reference) return;
    const db = await getDb();
    await db.runAsync('DELETE FROM reimbursement_allocations WHERE reimbursementTransactionReference = ?', [reference]);
  },

  async clearAll(): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM reimbursement_allocations');
  },
};
