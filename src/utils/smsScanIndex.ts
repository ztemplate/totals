import type { Account } from '../models/account';
import type { Bank } from '../models/bank';
import { OwnerAssignment, type Transaction } from '../models/transaction';
import { transactionBelongsToAccount } from './accountIdentity';
import { CASH_BANK_ID } from './cashConstants';
import { hasExactAmountAndBalanceDuplicate } from './duplicateDetector';
import { SMS_SOURCE_TYPE } from './smsTransactionSource';

/** The fields an SMS ownership check may change on a stored transaction. */
export interface OwnershipPatch {
  ownerAccountNumber: string | null;
  ownerAssignmentSource?: string | null;
  sourceSubscriptionId?: number | null;
  sourceMessageId?: string | null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Applies an ownership update to an in-memory transaction with the same rules as
 * transactionRepository.updateTransactionOwnerships: manual owners are never replaced
 * by automatic ones, clearing an owner clears its SIM shortcut. Returns whether any field changed.
 */
export function applyOwnershipPatch(tx: Transaction, patch: OwnershipPatch): boolean {
  if (tx.ownerAssignmentSource === OwnerAssignment.manual && patch.ownerAssignmentSource !== OwnerAssignment.manual) {
    return false;
  }
  const target = tx as Mutable<Transaction>;
  let changed = false;
  const set = <K extends keyof Transaction>(key: K, value: Transaction[K]) => {
    if ((target[key] ?? null) === (value ?? null)) return;
    target[key] = value;
    changed = true;
  };
  set('ownerAccountNumber', patch.ownerAccountNumber);
  if (patch.ownerAssignmentSource != null) set('ownerAssignmentSource', patch.ownerAssignmentSource);
  if (patch.ownerAccountNumber === null) {
    set('sourceSubscriptionId', null);
  } else if (patch.sourceSubscriptionId != null && patch.sourceSubscriptionId >= 0) {
    set('sourceSubscriptionId', patch.sourceSubscriptionId);
  }
  const messageId = patch.sourceMessageId?.trim();
  if (messageId) set('sourceMessageId', messageId);
  return changed;
}

function balanceTime(tx: Transaction): number | null {
  if (!tx.currentBalance?.trim() || !tx.time) return null;
  const time = new Date(tx.time).getTime();
  return Number.isNaN(time) ? null : time;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function removeFrom<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (!list) return;
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
  if (list.length === 0) map.delete(key);
}

/**
 * In-memory view of the stored transactions used while importing SMS, so each message
 * is checked against references, SMS sources and balances in O(1) instead of re-reading
 * and scanning the whole table. It is kept up to date as rows are added or re-owned.
 *
 * Lookups that the database answered with "first row ordered by time DESC, id DESC"
 * return the same row: rows loaded from the table keep their load order, and rows added
 * later count as having larger ids.
 */
export class TransactionIndex {
  private readonly rank = new Map<Transaction, number>();
  private readonly byReference = new Map<string, Transaction>();
  private readonly bySourceFingerprint = new Map<string, Transaction[]>();
  private readonly bySourceMessageId = new Map<string, Transaction[]>();
  private readonly byBank = new Map<number, Transaction[]>();
  /** Newest time of a row with a balance, per bank. */
  private readonly newestBalanceTime = new Map<number, number>();
  private nextRank: number;
  private cashDelta = 0;

  /** `transactions` in the order the repository returns them (time DESC, id DESC). */
  constructor(transactions: Iterable<Transaction> = []) {
    const list = [...transactions];
    this.nextRank = 1;
    // Loaded rows: earlier in the list = larger id among rows with the same time.
    for (let i = 0; i < list.length; i++) this.insert(list[i], -i, false);
  }

  get size(): number {
    return this.rank.size;
  }

  /** Adds a newly saved row. A row with the same reference is replaced, like INSERT OR REPLACE. */
  add(tx: Transaction): void {
    const previous = this.byReference.get(tx.reference);
    if (previous) this.remove(previous);
    this.insert(tx, 1_000_000_000 + this.nextRank++, true);
  }

  getByReference(reference: string): Transaction | null {
    return this.byReference.get(reference) ?? null;
  }

  hasReference(reference: string): boolean {
    return this.byReference.has(reference);
  }

  /** Same rules as the SMS source duplicate check: fingerprint, or message id with a compatible fingerprint. */
  findSmsSourceDuplicate(details: Record<string, unknown>): Transaction | null {
    const sourceType = typeof details.sourceType === 'string' ? details.sourceType.trim() : null;
    if (sourceType !== SMS_SOURCE_TYPE) return null;
    const messageId = details.sourceMessageId != null ? String(details.sourceMessageId).trim() : '';
    const fingerprint = details.sourceFingerprint != null ? String(details.sourceFingerprint).trim() : '';
    if (!messageId && !fingerprint) return null;

    const candidates: Transaction[] = [];
    if (fingerprint) candidates.push(...(this.bySourceFingerprint.get(fingerprint) ?? []));
    if (messageId) {
      for (const tx of this.bySourceMessageId.get(messageId) ?? []) {
        const existingFingerprint = tx.sourceFingerprint?.trim();
        if (!fingerprint || !existingFingerprint || existingFingerprint === fingerprint) candidates.push(tx);
      }
    }
    return this.firstInTableOrder(candidates);
  }

  /** Dashen sends some messages twice with different wording; same amount and balance means same row. */
  hasExactAmountAndBalanceDuplicate(candidate: Transaction): boolean {
    if (candidate.bankId == null) return false;
    return hasExactAmountAndBalanceDuplicate(candidate, this.byBank.get(candidate.bankId) ?? []);
  }

  /** Whether the account already has a message with a balance newer than `at` (epoch ms). */
  hasNewerBalance(params: { account: Account; at: number; bank: Bank | null | undefined; bankAccounts: Account[] }): boolean {
    const { account, at } = params;
    const newest = this.newestBalanceTime.get(account.bank);
    if (newest === undefined || !(newest > at)) return false;
    for (const tx of this.byBank.get(account.bank) ?? []) {
      const time = balanceTime(tx);
      if (time === null || !(time > at)) continue;
      if (transactionBelongsToAccount(tx, account, params.bank, params.bankAccounts)) return true;
    }
    return false;
  }

  /** Net amount of the cash wallet's own transactions (credits minus debits). */
  cashWalletDelta(): number {
    return this.cashDelta;
  }

  /** Applies an ownership update to the indexed row. Returns whether the row changed. */
  updateOwnership(reference: string, patch: OwnershipPatch): boolean {
    const tx = this.byReference.get(reference);
    if (!tx) return false;
    const before = tx.sourceMessageId;
    const changed = applyOwnershipPatch(tx, patch);
    if (changed && before !== tx.sourceMessageId && tx.sourceType === SMS_SOURCE_TYPE) {
      if (before) removeFrom(this.bySourceMessageId, before, tx);
      if (tx.sourceMessageId) pushTo(this.bySourceMessageId, tx.sourceMessageId, tx);
    }
    return changed;
  }

  private firstInTableOrder(candidates: Transaction[]): Transaction | null {
    let best: Transaction | null = null;
    for (const tx of candidates) {
      if (best === null || this.comesBefore(tx, best)) best = tx;
    }
    return best;
  }

  /** ORDER BY time DESC, id DESC; NULL times sort last. */
  private comesBefore(a: Transaction, b: Transaction): boolean {
    const at = a.time ?? null;
    const bt = b.time ?? null;
    if (at !== bt) {
      if (at === null) return false;
      if (bt === null) return true;
      return at > bt;
    }
    return (this.rank.get(a) ?? 0) > (this.rank.get(b) ?? 0);
  }

  private insert(tx: Transaction, rank: number, replace: boolean): void {
    if (!replace && this.byReference.has(tx.reference)) {
      // Duplicate references in the table: lookups keep returning the first row.
    } else {
      this.byReference.set(tx.reference, tx);
    }
    this.rank.set(tx, rank);
    if (tx.sourceType === SMS_SOURCE_TYPE) {
      if (tx.sourceFingerprint) pushTo(this.bySourceFingerprint, tx.sourceFingerprint, tx);
      if (tx.sourceMessageId) pushTo(this.bySourceMessageId, tx.sourceMessageId, tx);
    }
    if (tx.bankId != null) {
      pushTo(this.byBank, tx.bankId, tx);
      const time = balanceTime(tx);
      if (time !== null && !((this.newestBalanceTime.get(tx.bankId) ?? -Infinity) >= time)) {
        this.newestBalanceTime.set(tx.bankId, time);
      }
    }
    if (tx.bankId === CASH_BANK_ID) this.cashDelta += cashSign(tx) * tx.amount;
  }

  private remove(tx: Transaction): void {
    if (!this.rank.has(tx)) return;
    this.rank.delete(tx);
    if (this.byReference.get(tx.reference) === tx) this.byReference.delete(tx.reference);
    if (tx.sourceType === SMS_SOURCE_TYPE) {
      if (tx.sourceFingerprint) removeFrom(this.bySourceFingerprint, tx.sourceFingerprint, tx);
      if (tx.sourceMessageId) removeFrom(this.bySourceMessageId, tx.sourceMessageId, tx);
    }
    if (tx.bankId != null) removeFrom(this.byBank, tx.bankId, tx);
    if (tx.bankId === CASH_BANK_ID) this.cashDelta -= cashSign(tx) * tx.amount;
    // newestBalanceTime stays an upper bound; hasNewerBalance re-checks the rows.
  }
}

function cashSign(tx: Transaction): number {
  return tx.type === 'DEBIT' ? -1 : tx.type === 'CREDIT' ? 1 : 0;
}
