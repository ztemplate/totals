import type { Account } from '../models/account';
import type { Bank } from '../models/bank';
import type { Category } from '../models/category';
import type { Transaction } from '../models/transaction';
import { accountRepository } from '../repositories/accountRepository';
import { bankRepository } from '../repositories/bankRepository';
import { categoryRepository } from '../repositories/categoryRepository';
import { reimbursementRepository } from '../repositories/reimbursementRepository';
import { transactionRepository } from '../repositories/transactionRepository';
import { CASH_ATM_REFERENCE_PREFIX, CASH_BANK_ID } from '../utils/cashConstants';
import { findOwnedAccountTransferMatches } from '../utils/ownedAccountTransfer';
import { addDays, endOfDay, startOfDay, startOfWeek } from '../utils/periodUtils';
import { transactionFeeAmount, transactionNetExpenseAmount } from '../utils/transactionAmounts';

/** ATM withdrawals mirrored into the cash wallet: both sides are internal movement. */
function cashTransferReferences(transactions: Transaction[]): Set<string> {
  const references = new Set<string>();
  const byReference = new Set(transactions.map((t) => t.reference));
  for (const tx of transactions) {
    if (tx.bankId !== CASH_BANK_ID || !tx.reference.startsWith(CASH_ATM_REFERENCE_PREFIX)) continue;
    const linked = tx.reference.substring(CASH_ATM_REFERENCE_PREFIX.length);
    if (!byReference.has(linked)) continue;
    references.add(tx.reference);
    references.add(linked);
  }
  return references;
}

/** References of transactions that moved money between the user's own accounts. */
export function buildSelfTransferReferences(params: {
  transactions: Transaction[];
  banks: Bank[];
  accounts: Account[];
}): Set<string> {
  if (params.transactions.length === 0) return new Set();
  const references = new Set<string>();
  for (const match of findOwnedAccountTransferMatches(params)) {
    references.add(match.debitTransaction.reference);
    references.add(match.creditTransaction.reference);
  }
  cashTransferReferences(params.transactions).forEach((r) => references.add(r));
  return references;
}

export function manualSelfCategoryIds(categories: Category[]): Set<number> {
  const ids = new Set<number>();
  for (const category of categories) {
    if (category.id != null && category.name.trim().toLowerCase() === 'self') ids.add(category.id);
  }
  return ids;
}

export function isSelfTransfer(tx: Transaction, references: Set<string>, selfCategoryIds: Set<number>): boolean {
  return references.has(tx.reference) || (tx.categoryId != null && selfCategoryIds.has(tx.categoryId));
}

/**
 * Removes self-transfers from a list, keeping manual cash expenses and the fee
 * portion of internal debits (the fee is real spending).
 */
async function filterOutSelfTransfers(transactions: Transaction[]): Promise<Transaction[]> {
  if (transactions.length === 0) return transactions;
  const [all, banks, accounts, categories] = await Promise.all([
    transactionRepository.getTransactions(),
    bankRepository.getBanks(),
    accountRepository.getAccounts(),
    categoryRepository.getCategories(),
  ]);
  const references = buildSelfTransferReferences({ transactions: all, banks, accounts });
  const selfIds = manualSelfCategoryIds(categories);
  if (references.size === 0 && selfIds.size === 0) return transactions;

  const filtered: Transaction[] = [];
  for (const tx of transactions) {
    const keepCashExpense = tx.bankId === CASH_BANK_ID && tx.type === 'DEBIT';
    if (!isSelfTransfer(tx, references, selfIds) || keepCashExpense) {
      filtered.push(tx);
      continue;
    }
    if (tx.type === 'DEBIT' && transactionFeeAmount(tx) > 0) filtered.push({ ...tx, amount: 0 });
  }
  return filtered;
}

export async function getSpendingForRange(start: Date, end: Date): Promise<number> {
  const transactions = await filterOutSelfTransfers(
    await transactionRepository.getTransactionsByDateRange(start, end, { type: 'DEBIT' }),
  );
  const reimbursed = await reimbursementRepository.getAppliedTotalsForExpenses(transactions.map((t) => t.reference));
  return transactions.reduce(
    (sum, tx) =>
      sum +
      transactionNetExpenseAmount(tx, { isSelfTransfer: false, reimbursedAmount: reimbursed.get(tx.reference.trim()) ?? 0 }),
    0,
  );
}

export const spendingSummary = {
  getTodaySpending(now = new Date()): Promise<number> {
    return getSpendingForRange(startOfDay(now), endOfDay(now));
  },

  getCurrentWeekSpending(now = new Date()): Promise<number> {
    return getSpendingForRange(startOfWeek(now), endOfDay(now));
  },

  getLastCompletedWeekSpending(now = new Date()): Promise<number> {
    const currentWeekStart = startOfWeek(now);
    return getSpendingForRange(addDays(currentWeekStart, -7), endOfDay(addDays(currentWeekStart, -1)));
  },

  getCurrentMonthSpending(now = new Date()): Promise<number> {
    return getSpendingForRange(new Date(now.getFullYear(), now.getMonth(), 1), endOfDay(now));
  },
};
