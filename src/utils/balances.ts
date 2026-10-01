import type { Account } from '../models/account';
import type { Transaction } from '../models/transaction';
import { CASH_BANK_ID } from './cashConstants';
import { transactionBalanceDelta } from './transactionAmounts';

/** The cash wallet balance is derived from its transactions; bank balances come from SMS. */
export function accountDisplayBalance(account: Account, transactions: Transaction[]): number {
  if (account.bank !== CASH_BANK_ID) return account.balance;
  return transactions
    .filter((t) => t.bankId === CASH_BANK_ID)
    .reduce((sum, t) => sum + transactionBalanceDelta(t), account.balance);
}

export function totalBalance(accounts: Account[], transactions: Transaction[]): number {
  return accounts
    .filter((a) => a.includeInTotals && !a.isDormant)
    .reduce((sum, a) => sum + accountDisplayBalance(a, transactions), 0);
}
