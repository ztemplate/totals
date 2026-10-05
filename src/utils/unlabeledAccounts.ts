import type { Account } from '../models/account';
import type { Bank } from '../models/bank';
import { txDate, type Transaction } from '../models/transaction';
import { accountNumbersMatch, canonicalAccountNumber, isOwnershipConflict, isSimBank, resolveTransactionOwnership } from './accountIdentity';
import { CASH_BANK_ID } from './cashConstants';

/**
 * An account seen in bank messages that is not registered yet. Non-SIM banks are grouped by the
 * account number printed in the SMS (masked forms are merged when they agree); SIM banks such as
 * telebirr print the counterparty's number, so their messages are grouped by the SIM that received them.
 */
export interface UnlabeledAccount {
  key: string;
  bankId: number;
  /** Number as printed in the SMS, possibly masked. Null when the messages carry none. */
  accountNumber: string | null;
  /** SIM slot that received the messages (SIM banks). */
  subscriptionId: number | null;
  references: string[];
  count: number;
  credit: number;
  debit: number;
  firstDate: Date | null;
  lastDate: Date | null;
  /** Balance printed by the newest message, when there is one. */
  lastBalance: number | null;
}

const MASK_RE = /[*X•#?]/i;

export function isMaskedAccountNumber(value: string | null | undefined): boolean {
  return !!value && MASK_RE.test(value.replace(/^\s+|\s+$/g, ''));
}

function balanceOf(tx: Transaction): number | null {
  if (!tx.currentBalance) return null;
  const value = Number.parseFloat(String(tx.currentBalance).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function newGroup(key: string, bankId: number, accountNumber: string | null, subscriptionId: number | null): UnlabeledAccount {
  return {
    key,
    bankId,
    accountNumber,
    subscriptionId,
    references: [],
    count: 0,
    credit: 0,
    debit: 0,
    firstDate: null,
    lastDate: null,
    lastBalance: null,
  };
}

function addTransaction(group: UnlabeledAccount, tx: Transaction): void {
  group.references.push(tx.reference);
  group.count++;
  const amount = Math.abs(tx.amount);
  if (tx.type === 'CREDIT') group.credit += amount;
  else if (tx.type === 'DEBIT') group.debit += amount;
  const d = txDate(tx);
  if (!d) return;
  if (!group.firstDate || d < group.firstDate) group.firstDate = d;
  if (!group.lastDate || d >= group.lastDate) {
    group.lastDate = d;
    group.lastBalance = balanceOf(tx) ?? group.lastBalance;
  }
}

/**
 * Bank transactions no registered account claims, grouped into the accounts they came from. Once a
 * bank has accounts, only messages whose number matches none of them, or whose greeting names
 * someone else, count as a new account.
 */
export function detectUnlabeledAccounts(
  transactions: readonly Transaction[],
  accounts: readonly Account[],
  banks: readonly Bank[],
): UnlabeledAccount[] {
  const banksById = new Map(banks.map((b) => [b.id, b]));
  const accountList = [...accounts];
  const groupsByBank = new Map<number, UnlabeledAccount[]>();

  for (const tx of transactions) {
    const bankId = tx.bankId;
    if (bankId == null || bankId === CASH_BANK_ID) continue;
    const bank = banksById.get(bankId);
    if (!bank) continue;
    const bankAccounts = accountList.filter((a) => a.bank === bankId);
    if (bankAccounts.length > 0 && resolveTransactionOwnership(tx, bank, accountList)) continue;

    const sim = isSimBank(bank);
    // An owner left behind by a deleted account still names the account the message belongs to.
    const owner = tx.ownerAccountNumber?.trim() || null;
    const number = owner ?? (sim ? null : tx.accountNumber?.trim() || null);
    const subscriptionId = sim && !owner ? tx.sourceSubscriptionId ?? null : null;
    if (!owner && bankAccounts.length > 0 && !isOwnershipConflict(tx)) {
      // Only a number that matches none of the bank's accounts is evidence of another account, or
      // a message addressed to another person's account with the same visible digits.
      const contradicts = !sim && !!number && !bankAccounts.some((a) => accountNumbersMatch(bank, a.accountNumber, number));
      if (!contradicts) continue;
    }

    const groups = groupsByBank.get(bankId) ?? [];
    let group = number
      ? groups.find((g) => g.accountNumber !== null && accountNumbersMatch(bank, g.accountNumber, number))
      : groups.find((g) => g.accountNumber === null && g.subscriptionId === subscriptionId);
    if (!group) {
      const keyPart = number
        ? `no:${canonicalAccountNumber(bank, number) ?? number}`
        : `sim:${subscriptionId ?? 'unknown'}`;
      group = newGroup(`${bankId}|${keyPart}`, bankId, number, subscriptionId);
      groups.push(group);
      groupsByBank.set(bankId, groups);
    }
    // Prefer an unmasked spelling of the number once one is seen.
    if (number && isMaskedAccountNumber(group.accountNumber) && !isMaskedAccountNumber(number)) group.accountNumber = number;
    addTransaction(group, tx);
  }

  return [...groupsByBank.values()]
    .flat()
    .sort((a, b) => (b.lastDate?.getTime() ?? 0) - (a.lastDate?.getTime() ?? 0) || b.count - a.count);
}
