import type { Account } from '../models/account';
import type { Bank } from '../models/bank';
import { hasManualOwnerAssignment, txDate, type Transaction } from '../models/transaction';
import {
  accountNumbersMatch,
  checkSmsOwnership,
  isOwnershipConflict,
  isSimBank,
  registeredAccountNumbersMatch,
  resolveAccountOwnership,
  transactionBelongsToAccount,
} from './accountIdentity';

export interface OwnerChange {
  reference: string;
  /** Registered account number, or null to clear an owner the message contradicts. */
  ownerAccountNumber: string | null;
  /** The message names a person and an account that no registered account has together. */
  conflict?: boolean;
}

/**
 * Re-applies the ownership rules to a bank's imported messages. Automatic owners picked by older
 * rules (or before a second account at the same bank was added) move to the account the message
 * names, and messages addressed to someone else's account are taken off yours. Manual choices are kept.
 */
export function ownershipChanges(params: {
  bank: Bank;
  accounts: Account[];
  transactions: Transaction[];
  /** Original SMS bodies by transaction reference, when they were kept. */
  bodies: Map<string, string>;
}): OwnerChange[] {
  const { bank } = params;
  const accounts = params.accounts.filter((a) => a.bank === bank.id);
  if (accounts.length === 0) return [];
  const changes: OwnerChange[] = [];
  for (const tx of params.transactions) {
    if (tx.bankId !== bank.id || hasManualOwnerAssignment(tx)) continue;
    const body = params.bodies.get(tx.reference);
    const current = tx.ownerAccountNumber ?? null;
    let owner;
    if (body) {
      const check = checkSmsOwnership({
        body,
        bank,
        accounts,
        parsedAccountNumber: tx.accountNumber,
        subscriptionId: tx.sourceSubscriptionId,
      });
      if (check.conflict) {
        if (current || !isOwnershipConflict(tx)) changes.push({ reference: tx.reference, ownerAccountNumber: null, conflict: true });
        continue;
      }
      owner = check.owner?.account ?? null;
    } else {
      // Without the message text a conflict can't be re-checked; keep it.
      if (isOwnershipConflict(tx)) continue;
      owner = resolveAccountOwnership({
        bank,
        accounts,
        parsedNumber: isSimBank(bank) ? null : tx.accountNumber,
        subscriptionId: tx.sourceSubscriptionId,
      });
    }
    const contradicted = !!current && !isSimBank(bank) && !!tx.accountNumber && !accountNumbersMatch(bank, current, tx.accountNumber);
    // Without the message text the owner may have come from its greeting; keep it unless the
    // printed account number says otherwise.
    if (!body && current && !contradicted) continue;
    if (owner) {
      if (!current || !registeredAccountNumbersMatch(bank, current, owner.accountNumber)) {
        changes.push({ reference: tx.reference, ownerAccountNumber: owner.accountNumber });
      }
      continue;
    }
    // No owner now. Only drop the old one when the message's own account number disagrees with it,
    // and lift a conflict the current accounts no longer have (a holder name was corrected, say).
    if (contradicted || isOwnershipConflict(tx)) {
      changes.push({ reference: tx.reference, ownerAccountNumber: null });
    }
  }
  return changes;
}

/** Balance printed in the account's newest message, or null when none of its messages has one. */
export function latestMessageBalance(
  account: Account,
  bank: Bank,
  accounts: Account[],
  transactions: Transaction[],
  parseBalance: (raw: string) => number,
): { balance: number; time: Date } | null {
  let best: { balance: number; time: Date } | null = null;
  for (const tx of transactions) {
    if (!tx.currentBalance?.trim()) continue;
    const time = txDate(tx);
    if (!time || (best && time.getTime() < best.time.getTime())) continue;
    if (!transactionBelongsToAccount(tx, account, bank, accounts)) continue;
    best = { balance: parseBalance(tx.currentBalance), time };
  }
  return best;
}
