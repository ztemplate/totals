import type { Account } from '../models/account';
import type { Bank } from '../models/bank';
import type { Transaction } from '../models/transaction';
import { registeredAccountNumbersMatch, resolveTransactionOwnership } from './accountIdentity';

export const IDENTITY_MATCH_WINDOW_MS = 10 * 60 * 1000;
export const TIMESTAMP_ONLY_MATCH_WINDOW_MS = 15 * 1000;
const AMOUNT_TOLERANCE = 0.01;

export interface OwnedAccountTransferMatch {
  debitTransaction: Transaction;
  creditTransaction: Transaction;
  debitAccount: Account;
  creditAccount: Account;
  timeDeltaMs: number;
}

interface OwnedTransaction {
  transaction: Transaction;
  owner: Account;
  bank: Bank;
  time: number;
}

interface TransferCandidate {
  debit: OwnedTransaction;
  credit: OwnedTransaction;
  timeDeltaMs: number;
  evidenceScore: number;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function transactionText(tx: Transaction): string {
  return [tx.creditor, tx.receiver, tx.note]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .trim();
}

function normalizedTransactionText(tx: Transaction): string {
  return normalizeToken(transactionText(tx));
}

function tokensForBank(bank: Bank): Set<string> {
  const tokens = new Set<string>([normalizeToken(bank.name), normalizeToken(bank.shortName)]);
  for (const code of bank.codes) tokens.add(normalizeToken(code));
  for (const token of [...tokens]) if (token.length < 3) tokens.delete(token);
  return tokens;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsBank(tx: Transaction, tokens: Set<string>): boolean {
  const rawText = transactionText(tx).toLowerCase();
  if (!rawText) return false;
  const normalizedText = normalizeToken(rawText);
  for (const token of tokens) {
    if (!token) continue;
    if (token.length > 3) {
      if (normalizedText.includes(token)) return true;
      continue;
    }
    // Short bank codes such as CBE and BOA must be complete words, so a
    // counterparty such as "CBEBirr" does not count as evidence for CBE.
    if (new RegExp(`(^|[^a-z0-9])${escapeRegex(token)}([^a-z0-9]|$)`).test(rawText)) return true;
  }
  return false;
}

function mentionsHolder(tx: Transaction, holderName: string): boolean {
  const holder = normalizeToken(holderName);
  if (holder.length < 4) return false;
  return normalizedTransactionText(tx).includes(holder);
}

function amountCents(amount: number): number {
  return Math.round(Math.abs(amount) * 100);
}

function amountsMatch(left: number, right: number): boolean {
  return Math.abs(Math.abs(left) - Math.abs(right)) <= AMOUNT_TOLERANCE + 1e-9;
}

function parseTime(raw: string | null | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? null : time;
}

function profilesCanMatch(left: OwnedTransaction, right: OwnedTransaction): boolean {
  const leftProfile = left.transaction.profileId ?? left.owner.profileId ?? null;
  const rightProfile = right.transaction.profileId ?? right.owner.profileId ?? null;
  return leftProfile === null || rightProfile === null || leftProfile === rightProfile;
}

function isSameAccount(left: OwnedTransaction, right: OwnedTransaction): boolean {
  if (left.bank.id !== right.bank.id) return false;
  return registeredAccountNumbersMatch(left.bank, left.owner.accountNumber, right.owner.accountNumber);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pairs debits and credits between the user's own registered accounts
 * (e.g. moving money from CBE to Telebirr), so they can be treated as self transfers.
 */
export function findOwnedAccountTransferMatches(params: {
  transactions: Iterable<Transaction>;
  banks: Iterable<Bank>;
  accounts: Iterable<Account>;
}): OwnedAccountTransferMatch[] {
  const bankList = [...params.banks];
  const accountList = [...params.accounts];
  const banksById = new Map(bankList.map((b) => [b.id, b]));
  const bankTokens = new Map(bankList.map((b) => [b.id, tokensForBank(b)]));

  const owned: OwnedTransaction[] = [];
  for (const transaction of params.transactions) {
    const bankId = transaction.bankId;
    const time = parseTime(transaction.time);
    if (bankId == null || time === null) continue;
    if (transaction.type !== 'CREDIT' && transaction.type !== 'DEBIT') continue;
    const bank = banksById.get(bankId);
    if (!bank) continue;
    const owner = resolveTransactionOwnership(transaction, bank, accountList);
    if (!owner) continue;
    owned.push({ transaction, owner, bank, time });
  }

  const creditsByCents = new Map<number, OwnedTransaction[]>();
  for (const item of owned) {
    if (item.transaction.type !== 'CREDIT') continue;
    const cents = amountCents(item.transaction.amount);
    const list = creditsByCents.get(cents);
    if (list) list.push(item);
    else creditsByCents.set(cents, [item]);
  }

  const empty = new Set<string>();
  const candidates: TransferCandidate[] = [];
  for (const debit of owned) {
    if (debit.transaction.type !== 'DEBIT') continue;
    const cents = amountCents(debit.transaction.amount);
    for (const candidateCents of [cents - 1, cents, cents + 1]) {
      for (const credit of creditsByCents.get(candidateCents) ?? []) {
        if (
          !profilesCanMatch(debit, credit) ||
          isSameAccount(debit, credit) ||
          !amountsMatch(debit.transaction.amount, credit.transaction.amount)
        ) {
          continue;
        }
        const delta = Math.abs(debit.time - credit.time);
        if (delta > IDENTITY_MATCH_WINDOW_MS) continue;

        const hasBankEvidence =
          mentionsBank(debit.transaction, bankTokens.get(credit.bank.id) ?? empty) ||
          mentionsBank(credit.transaction, bankTokens.get(debit.bank.id) ?? empty);
        const hasHolderEvidence =
          mentionsHolder(debit.transaction, credit.owner.accountHolderName ?? '') ||
          mentionsHolder(credit.transaction, debit.owner.accountHolderName ?? '');
        const hasTightUnlabeledPair =
          delta <= TIMESTAMP_ONLY_MATCH_WINDOW_MS &&
          normalizedTransactionText(debit.transaction) === '' &&
          normalizedTransactionText(credit.transaction) === '';
        if (!hasBankEvidence && !hasHolderEvidence && !hasTightUnlabeledPair) continue;

        candidates.push({
          debit,
          credit,
          timeDeltaMs: delta,
          evidenceScore: (hasBankEvidence ? 100 : 0) + (hasHolderEvidence ? 50 : 0) + (hasTightUnlabeledPair ? 20 : 0),
        });
      }
    }
  }

  candidates.sort(
    (l, r) =>
      r.evidenceScore - l.evidenceScore ||
      l.timeDeltaMs - r.timeDeltaMs ||
      compareStrings(l.debit.transaction.reference, r.debit.transaction.reference) ||
      compareStrings(l.credit.transaction.reference, r.credit.transaction.reference),
  );

  const used = new Set<string>();
  const matches: OwnedAccountTransferMatch[] = [];
  for (const candidate of candidates) {
    const debitRef = candidate.debit.transaction.reference;
    const creditRef = candidate.credit.transaction.reference;
    if (used.has(debitRef) || used.has(creditRef)) continue;
    used.add(debitRef);
    used.add(creditRef);
    matches.push({
      debitTransaction: candidate.debit.transaction,
      creditTransaction: candidate.credit.transaction,
      debitAccount: candidate.debit.owner,
      creditAccount: candidate.credit.owner,
      timeDeltaMs: candidate.timeDeltaMs,
    });
  }
  return matches;
}
