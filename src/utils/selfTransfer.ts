import type { Account } from '../models/account';
import type { Bank } from '../models/bank';
import type { Category } from '../models/category';
import { selectedCategoryIds, type Transaction } from '../models/transaction';
import { CASH_ATM_REFERENCE_PREFIX, CASH_BANK_ID } from './cashConstants';
import { findOwnedAccountTransferMatches } from './ownedAccountTransfer';

function cashTransferPair(transaction: Transaction, transactions: Transaction[]): Transaction[] {
  const reference = transaction.reference;
  const isCashSide = transaction.bankId === CASH_BANK_ID;
  let linkedReference: string;
  if (isCashSide) {
    if (!reference.startsWith(CASH_ATM_REFERENCE_PREFIX)) return [];
    linkedReference = reference.substring(CASH_ATM_REFERENCE_PREFIX.length);
  } else {
    linkedReference = `${CASH_ATM_REFERENCE_PREFIX}${reference}`;
  }
  const linked = transactions.find((candidate) => {
    const expectedSide = isCashSide ? candidate.bankId !== CASH_BANK_ID : candidate.bankId === CASH_BANK_ID;
    return candidate.reference === linkedReference && expectedSide;
  });
  return linked ? [transaction, linked] : [];
}

/**
 * Finds transactions whose notifications should be withdrawn because they
 * represent movement between the user's own accounts.
 */
export function transactionsToSuppress(params: {
  transaction: Transaction;
  transactions: Iterable<Transaction>;
  banks: Iterable<Bank>;
  accounts: Iterable<Account>;
  categories: Iterable<Category>;
}): Transaction[] {
  const { transaction } = params;
  const reference = transaction.reference.trim();
  if (!reference) return [];

  const transactionList = [...params.transactions];
  const matches = findOwnedAccountTransferMatches({
    transactions: transactionList,
    banks: params.banks,
    accounts: params.accounts,
  });
  for (const match of matches) {
    if (match.debitTransaction.reference === reference || match.creditTransaction.reference === reference) {
      return [match.debitTransaction, match.creditTransaction];
    }
  }

  const cashPair = cashTransferPair(transaction, transactionList);
  if (cashPair.length > 0) return cashPair;

  const selfCategoryIds = new Set<number>();
  for (const category of params.categories) {
    if (category.id != null && category.name.trim().toLowerCase() === 'self') selfCategoryIds.add(category.id);
  }
  if (selectedCategoryIds(transaction).some((id) => selfCategoryIds.has(id))) return [transaction];
  return [];
}
