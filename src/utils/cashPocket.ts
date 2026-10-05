import { isCredit, isDebit, txDate, type Transaction } from '../models/transaction';
import { CASH_ATM_REFERENCE_PREFIX, CASH_BANK_ID } from './cashConstants';

export interface CashLinkLike {
  cashReference: string;
  withdrawalReference: string;
}

/** True for the cash wallet CREDIT mirrored from an ATM withdrawal. */
export function isAtmCashCredit(tx: Transaction): boolean {
  return tx.bankId === CASH_BANK_ID && isCredit(tx) && tx.reference.startsWith(CASH_ATM_REFERENCE_PREFIX);
}

/** The bank withdrawal behind an ATM cash credit. */
export function withdrawalReferenceOf(tx: Transaction): string | null {
  return isAtmCashCredit(tx) ? tx.reference.slice(CASH_ATM_REFERENCE_PREFIX.length) : null;
}

/**
 * Bank debits that are ATM withdrawals: those mirrored into the cash wallet, plus any whose text says ATM.
 */
export function atmWithdrawalReferences(transactions: readonly Transaction[]): Set<string> {
  const out = new Set<string>();
  const byRef = new Set(transactions.map((t) => t.reference));
  for (const tx of transactions) {
    const linked = withdrawalReferenceOf(tx);
    if (linked && byRef.has(linked)) out.add(linked);
    if (tx.bankId !== CASH_BANK_ID && isDebit(tx) && looksLikeAtm(tx)) out.add(tx.reference);
  }
  return out;
}

function looksLikeAtm(tx: Transaction): boolean {
  const text = [tx.receiver, tx.creditor, tx.note].filter(Boolean).join(' ').toLowerCase();
  return /\batm\b/.test(text);
}

export interface PocketSummary {
  withdrawalReference: string;
  withdrawn: number;
  spent: number;
  remaining: number;
  spends: Transaction[];
}

/** How much of one withdrawal has been accounted for by linked cash spending. */
export function summarizePocket(
  withdrawal: Transaction,
  links: readonly CashLinkLike[],
  transactions: readonly Transaction[],
): PocketSummary {
  const byRef = new Map(transactions.map((t) => [t.reference, t]));
  const spends = links
    .filter((l) => l.withdrawalReference === withdrawal.reference)
    .map((l) => byRef.get(l.cashReference))
    .filter((t): t is Transaction => !!t && isDebit(t))
    .sort((a, b) => (txDate(b)?.getTime() ?? 0) - (txDate(a)?.getTime() ?? 0));
  const withdrawn = Math.abs(withdrawal.amount);
  const spent = Math.round(spends.reduce((sum, t) => sum + Math.abs(t.amount), 0) * 100) / 100;
  return { withdrawalReference: withdrawal.reference, withdrawn, spent, remaining: Math.max(0, withdrawn - spent), spends };
}

/** Cash debits not yet tied to any withdrawal, newest first, optionally only after a date. */
export function unlinkedCashSpends(
  transactions: readonly Transaction[],
  links: readonly CashLinkLike[],
  after?: Date | null,
): Transaction[] {
  const linked = new Set(links.map((l) => l.cashReference));
  return transactions
    .filter((t) => t.bankId === CASH_BANK_ID && isDebit(t) && !linked.has(t.reference))
    .filter((t) => !after || (txDate(t)?.getTime() ?? 0) >= after.getTime() - 60_000)
    .sort((a, b) => (txDate(b)?.getTime() ?? 0) - (txDate(a)?.getTime() ?? 0));
}

/** Only http(s) links can be opened as receipts; ATM cash credits store a transaction reference there. */
export function isOpenableLink(value: string | null | undefined): boolean {
  return /^https?:\/\//i.test((value ?? '').trim());
}

export interface Pocket {
  withdrawal: Transaction;
  summary: PocketSummary;
}

/** Every ATM withdrawal with what is left of it, newest first. */
export function listPockets(transactions: readonly Transaction[], links: readonly CashLinkLike[]): Pocket[] {
  const refs = atmWithdrawalReferences(transactions);
  return transactions
    .filter((t) => refs.has(t.reference))
    .map((withdrawal) => ({ withdrawal, summary: summarizePocket(withdrawal, links, transactions) }))
    .sort((a, b) => (txDate(b.withdrawal)?.getTime() ?? 0) - (txDate(a.withdrawal)?.getTime() ?? 0));
}
