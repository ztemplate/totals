import type { LoanDebtEntry, LoanDebtRepayment, LoanDebtStatus } from '../models/loanDebt';
import { parentReferenceOfSplitLoan } from '../models/split';
import type { Transaction } from '../models/transaction';
import { loanDebtRepository } from '../repositories/loanDebtRepository';

const EPSILON = 0.005;

export interface LoanDebtItem {
  entry: LoanDebtEntry;
  /** The originating transaction, when it belongs to the active profile. */
  transaction: Transaction | null;
  /**
   * The transaction to show for the entry: its own, or for a split loan ("parent#split-N") the parent
   * payment it was part of.
   */
  sourceTransaction: Transaction | null;
  original: number | null;
  repaid: number;
  remaining: number | null;
  /** Active entries that are fully repaid are reported as settled. */
  effectiveStatus: LoanDebtStatus;
  repayments: LoanDebtRepayment[];
}

export function buildLoanDebtItems(
  entries: LoanDebtEntry[],
  repayments: LoanDebtRepayment[],
  transactions: Transaction[],
): LoanDebtItem[] {
  const byReference = new Map(transactions.map((t) => [t.reference.trim(), t]));
  const repaymentsByTarget = new Map<string, LoanDebtRepayment[]>();
  for (const r of repayments) {
    const key = r.loanDebtTransactionReference.trim();
    const list = repaymentsByTarget.get(key) ?? [];
    list.push(r);
    repaymentsByTarget.set(key, list);
  }
  return entries.map((entry) => {
    const reference = entry.transactionReference.trim();
    const transaction = byReference.get(reference) ?? null;
    const parentReference = transaction ? null : parentReferenceOfSplitLoan(reference);
    const sourceTransaction = transaction ?? (parentReference ? byReference.get(parentReference) ?? null : null);
    const original =
      entry.principalAmount != null && Number.isFinite(entry.principalAmount)
        ? Math.abs(entry.principalAmount)
        : transaction
          ? Math.abs(transaction.amount)
          : null;
    const own = repaymentsByTarget.get(reference) ?? [];
    const repaid = own.reduce((sum, r) => sum + r.appliedAmount, 0);
    const remaining = original === null ? null : original - repaid <= EPSILON ? 0 : original - repaid;
    const effectiveStatus: LoanDebtStatus = entry.status === 'active' && remaining === 0 ? 'settled' : entry.status;
    return { entry, transaction, sourceTransaction, original, repaid, remaining, effectiveStatus, repayments: own };
  });
}

export async function loadLoanDebtItems(transactions: Transaction[]): Promise<LoanDebtItem[]> {
  const [entries, repayments] = await Promise.all([loanDebtRepository.getEntries(), loanDebtRepository.getRepayments()]);
  return buildLoanDebtItems(entries, repayments, transactions);
}
