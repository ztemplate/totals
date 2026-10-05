import type { Account } from '../models/account';
import { OwnerAssignment } from '../models/transaction';
import { accountRepository } from '../repositories/accountRepository';
import { bankRepository } from '../repositories/bankRepository';
import { sourceSmsRepository } from '../repositories/sourceSmsRepository';
import { transactionRepository } from '../repositories/transactionRepository';
import { registeredAccountNumbersMatch, resolveTransactionOwnership } from '../utils/accountIdentity';
import { latestMessageBalance, ownershipChanges } from '../utils/accountReconcile';
import { CASH_BANK_ID } from '../utils/cashConstants';
import { sanitizeAmount } from './smsService';

/**
 * Gives unowned messages of the account's bank to it when the ownership rules now pick it.
 * Used after an account is added from already-imported messages, so the inbox isn't parsed again.
 */
export async function claimMessagesForAccount(account: Pick<Account, 'accountNumber' | 'bank'>, extraReferences: string[] = []): Promise<number> {
  const bank = await bankRepository.getBank(account.bank);
  if (!bank) return 0;
  const accounts = await accountRepository.getAccounts();
  const target = accounts.find((a) => a.bank === account.bank && registeredAccountNumbersMatch(bank, a.accountNumber, account.accountNumber));
  if (!target) return 0;
  const references = new Set(extraReferences.map((r) => r.trim()).filter(Boolean));
  for (const tx of await transactionRepository.getTransactionsForBank(account.bank)) {
    if (tx.ownerAccountNumber && accounts.some((a) => a.bank === bank.id && registeredAccountNumbersMatch(bank, a.accountNumber, tx.ownerAccountNumber))) {
      continue;
    }
    if (tx.ownerAccountNumber) {
      // Left behind by a deleted account: it comes back when the same number is labeled again.
      if (registeredAccountNumbersMatch(bank, tx.ownerAccountNumber, target.accountNumber)) references.add(tx.reference);
      continue;
    }
    const owner = resolveTransactionOwnership(tx, bank, accounts);
    if (owner && owner.accountNumber === target.accountNumber) references.add(tx.reference);
  }
  if (references.size === 0) return 0;
  return transactionRepository.updateTransactionOwnerships(
    [...references].map((reference) => ({
      reference,
      ownerAccountNumber: target.accountNumber,
      ownerAssignmentSource: OwnerAssignment.automatic,
    })),
  );
}

/** Registers an account found in the imported messages and moves those messages under it. */
export async function labelDetectedAccount(params: {
  bankId: number;
  accountNumber: string;
  accountHolderName: string;
  balance: number;
  subscriptionId: number | null;
  references: string[];
}): Promise<number> {
  const accountNumber = params.accountNumber.trim();
  if (!accountNumber) throw new Error('Enter the account number.');
  if (await accountRepository.accountExists(accountNumber, params.bankId)) throw new Error('This account is already being tracked.');
  await accountRepository.saveAccount({
    accountNumber,
    bank: params.bankId,
    balance: params.balance,
    accountHolderName: params.accountHolderName.trim(),
    smsSubscriptionId: params.subscriptionId,
    includeInTotals: true,
    isDormant: false,
    isDefault: false,
  });
  return claimMessagesForAccount({ accountNumber, bank: params.bankId }, params.references);
}

/**
 * Re-checks which registered account owns each imported bank message, then sets every bank
 * account's balance from its newest message. Fixes accounts that share a bank (two CBE accounts,
 * say) after messages were given to the wrong one, and balances left stale by rescans.
 */
export async function reconcileAccounts(options: { balances?: boolean } = {}): Promise<{ moved: number; balances: number }> {
  const accounts = (await accountRepository.getAccounts()).filter((a) => a.bank !== CASH_BANK_ID);
  const banks = await bankRepository.getBanks();
  let moved = 0;
  let balances = 0;
  for (const bankId of new Set(accounts.map((a) => a.bank))) {
    const bank = banks.find((b) => b.id === bankId);
    if (!bank) continue;
    const bankAccounts = accounts.filter((a) => a.bank === bankId);
    let transactions = await transactionRepository.getTransactionsForBank(bankId);
    const sources = await sourceSmsRepository.getForTransactionReferences(transactions.map((t) => t.reference));
    const bodies = new Map(sources.map((s) => [s.transactionReference, s.body]));
    const changes = ownershipChanges({ bank, accounts: bankAccounts, transactions, bodies });
    if (changes.length > 0) {
      moved += await transactionRepository.updateTransactionOwnerships(
        changes.map((c) => ({
          reference: c.reference,
          ownerAccountNumber: c.ownerAccountNumber,
          ownerAssignmentSource: c.conflict ? OwnerAssignment.conflict : OwnerAssignment.automatic,
        })),
      );
      transactions = await transactionRepository.getTransactionsForBank(bankId);
    }
    if (options.balances === false) continue;
    for (const account of bankAccounts) {
      const latest = latestMessageBalance(account, bank, bankAccounts, transactions, sanitizeAmount);
      if (!latest || latest.balance === account.balance) continue;
      await accountRepository.updateBalance(account.accountNumber, account.bank, latest.balance);
      balances++;
    }
  }
  return { moved, balances };
}
