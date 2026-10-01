import { hasManualOwnerAssignment, OwnerAssignment, type Transaction } from '../models/transaction';
import { canonicalReference, displayReference } from './smsTransactionSource';

const EPS = 1e-4;
export const DASHEN_CANONICAL_MASK_PATTERN = 3;
export const DASHEN_LEGACY_MASK_PATTERN = 4;
const WINDOW_MS = 10 * 60 * 60 * 1000;

export interface DeduplicationPlan {
  keeper: Transaction;
  mergedKeeper: Transaction;
  duplicates: Transaction[];
}

function parseBalance(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.replace(/,/g, '').trim());
  return Number.isNaN(parsed) ? null : parsed;
}

function nearlyEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) < EPS;
}

function timeMs(tx: Transaction): number | null {
  if (!tx.time) return null;
  const ms = Date.parse(tx.time);
  return Number.isNaN(ms) ? null : ms;
}

export function hasExactAmountAndBalanceDuplicate(candidate: Transaction, existing: Transaction[]): boolean {
  const type = (candidate.type ?? '').toUpperCase();
  const balance = parseBalance(candidate.currentBalance);
  if (balance === null) return false;
  return existing.some((tx) => {
    if (tx.bankId !== candidate.bankId) return false;
    if ((tx.type ?? '').toUpperCase() !== type) return false;
    if (!nearlyEqual(tx.amount, candidate.amount)) return false;
    if (!nearlyEqual(parseBalance(tx.currentBalance), balance)) return false;
    if (candidate.accountNumber == null || tx.accountNumber == null) return true;
    return candidate.accountNumber.trim() === tx.accountNumber.trim();
  });
}

function populated(value: string | null | undefined): boolean {
  return !!value && value.trim().length > 0;
}

export function detailScore(tx: Transaction): number {
  let score = 0;
  if (hasManualOwnerAssignment(tx)) score += 10000;
  if (populated(tx.receiver)) score += 5;
  if (populated(tx.creditor)) score += 5;
  if (tx.vat != null && Math.abs(tx.vat) > EPS) score += 4;
  if (tx.serviceCharge != null && Math.abs(tx.serviceCharge) > EPS) score += 4;
  if (populated(tx.transactionLink)) score += 2;
  if (populated(tx.accountNumber)) score += 2;
  if (populated(tx.currentBalance)) score += 2;
  if (populated(tx.status)) score += 1;
  if (populated(tx.time)) score += 1;
  if (tx.categoryId != null) score += 2;
  return score;
}

function populatedFieldCount(tx: Transaction): number {
  return Object.values(tx).filter((v) => v !== null && v !== undefined && v !== '').length;
}

function textLength(tx: Transaction): number {
  return [tx.creditor, tx.receiver, tx.note, tx.status, tx.transactionLink, tx.accountNumber]
    .map((v) => (v ?? '').trim().length)
    .reduce((a, b) => a + b, 0);
}

function compareRichness(a: Transaction, b: Transaction): number {
  const score = detailScore(b) - detailScore(a);
  if (score !== 0) return score;
  const fields = populatedFieldCount(b) - populatedFieldCount(a);
  if (fields !== 0) return fields;
  const text = textLength(b) - textLength(a);
  if (text !== 0) return text;
  const ta = timeMs(a) ?? 0;
  const tb = timeMs(b) ?? 0;
  if (ta !== tb) return tb - ta;
  return b.reference.localeCompare(a.reference);
}

function longer(a: string | null | undefined, b: string | null | undefined): string | null {
  const ta = (a ?? '').trim();
  const tb = (b ?? '').trim();
  if (!ta && !tb) return a ?? b ?? null;
  return tb.length > ta.length ? b ?? null : a ?? null;
}

function largerAbs(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.abs(b) - Math.abs(a) > EPS ? b : a;
}

export function mergeTransactions(keeper: Transaction, duplicates: Transaction[]): Transaction {
  let merged: Transaction = { ...keeper };
  for (const dup of duplicates) {
    const manual = [merged, dup].find(hasManualOwnerAssignment);
    merged = {
      ...merged,
      creditor: longer(merged.creditor, dup.creditor),
      receiver: longer(merged.receiver, dup.receiver),
      note: longer(merged.note, dup.note),
      time: longer(merged.time, dup.time),
      status: longer(merged.status, dup.status),
      currentBalance: longer(merged.currentBalance, dup.currentBalance),
      transactionLink: longer(merged.transactionLink, dup.transactionLink),
      accountNumber: longer(merged.accountNumber, dup.accountNumber),
      ownerAccountNumber: manual ? manual.ownerAccountNumber : longer(merged.ownerAccountNumber, dup.ownerAccountNumber),
      ownerAssignmentSource: manual
        ? OwnerAssignment.manual
        : merged.ownerAssignmentSource ?? dup.ownerAssignmentSource ?? null,
      categoryId: merged.categoryId ?? dup.categoryId ?? null,
      categoryIds: (() => {
        const ids = [...(merged.categoryIds ?? []), ...(dup.categoryIds ?? [])];
        const unique = Array.from(new Set(ids.filter((id) => id > 0)));
        return unique.length === 0 ? null : unique;
      })(),
      profileId: merged.profileId ?? dup.profileId ?? null,
      serviceCharge: largerAbs(merged.serviceCharge, dup.serviceCharge),
      vat: largerAbs(merged.vat, dup.vat),
      sourceType: merged.sourceType ?? dup.sourceType ?? null,
      sourceMessageId: merged.sourceMessageId ?? dup.sourceMessageId ?? null,
      sourceFingerprint: merged.sourceFingerprint ?? dup.sourceFingerprint ?? null,
      sourceSubscriptionId:
        merged.sourceSubscriptionId != null && merged.sourceSubscriptionId >= 0
          ? merged.sourceSubscriptionId
          : dup.sourceSubscriptionId != null && dup.sourceSubscriptionId >= 0
            ? dup.sourceSubscriptionId
            : merged.sourceSubscriptionId ?? null,
    };
  }
  return merged;
}

function isScoped(tx: Transaction): boolean {
  return tx.reference.trim() !== displayReference(tx.bankId, tx.reference);
}

function legacyScore(tx: Transaction): number {
  let score = detailScore(tx);
  if (hasManualOwnerAssignment(tx)) score += 10000;
  if (isScoped(tx)) score += 100;
  if (populated(tx.ownerAccountNumber)) score += 40;
  if (populated(tx.sourceMessageId)) score += 15;
  if (tx.sourceSubscriptionId != null && tx.sourceSubscriptionId >= 0) score += 10;
  if (populated(tx.sourceFingerprint)) score += 5;
  return score;
}

/** Collapses legacy (unscoped) Telebirr rows into their scoped leg equivalents. */
export function buildLegacySmsReferenceDeduplicationPlans(transactions: Transaction[]): DeduplicationPlan[] {
  const groups = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const key = `${tx.profileId ?? ''}|${tx.bankId ?? ''}|${canonicalReference(tx.bankId, tx.reference)}|${(tx.type ?? '').toUpperCase()}|${tx.amount.toFixed(4)}`;
    const list = groups.get(key) ?? [];
    list.push(tx);
    groups.set(key, list);
  }
  const plans: DeduplicationPlan[] = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const scoped = rows.filter(isScoped);
    const legacy = rows.filter((r) => !isScoped(r));
    if (scoped.length === 0 || legacy.length === 0) continue;
    const manualOwners = new Set(rows.filter(hasManualOwnerAssignment).map((r) => r.ownerAccountNumber ?? ''));
    const owners = new Set(rows.map((r) => r.ownerAccountNumber).filter((o): o is string => !!o));
    if (manualOwners.size > 1) continue;
    if (manualOwners.size === 0 && owners.size > 1) continue;
    const sorted = [...rows].sort((a, b) => legacyScore(b) - legacyScore(a));
    const keeper = sorted[0];
    const duplicates = sorted.slice(1);
    plans.push({ keeper, mergedKeeper: mergeTransactions(keeper, duplicates), duplicates });
  }
  return plans;
}

function suffix(value: string, length: number): string | null {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.length < length) return null;
  return normalized.substring(normalized.length - length);
}

export function buildDashenDeduplicationSuffixes(accountNumbers: string[], transactionAccountNumbers: string[] = []): string[] {
  const suffixes = new Set<string>();
  const normalized = accountNumbers.map((a) => a.trim()).filter(Boolean);
  const canonicalCounts = new Map<string, number>();
  for (const account of normalized) {
    const canonical = suffix(account, DASHEN_CANONICAL_MASK_PATTERN);
    if (canonical) canonicalCounts.set(canonical, (canonicalCounts.get(canonical) ?? 0) + 1);
  }
  for (const account of normalized) {
    const legacy = suffix(account, DASHEN_LEGACY_MASK_PATTERN);
    if (legacy) suffixes.add(legacy);
    const canonical = suffix(account, DASHEN_CANONICAL_MASK_PATTERN);
    if (canonical && (normalized.length === 1 || canonicalCounts.get(canonical) === 1)) suffixes.add(canonical);
  }
  if (suffixes.size === 0) {
    for (const account of transactionAccountNumbers) {
      const legacy = suffix(account, DASHEN_LEGACY_MASK_PATTERN);
      if (legacy) suffixes.add(legacy);
      const canonical = suffix(account, DASHEN_CANONICAL_MASK_PATTERN);
      if (canonical) suffixes.add(canonical);
    }
  }
  return Array.from(suffixes);
}

export function buildExactAmountAndBalanceDeduplicationPlans(
  bankId: number,
  type: string,
  transactions: Transaction[],
  accountSuffix?: string | null,
  matchTransactionsWithoutAccountNumber = false,
): DeduplicationPlan[] {
  const wantedType = type.toUpperCase();
  const groups = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    if (tx.bankId !== bankId || (tx.type ?? '').toUpperCase() !== wantedType) continue;
    const balance = parseBalance(tx.currentBalance);
    if (balance === null) continue;
    let accountKey: string | null;
    if (accountSuffix) {
      const account = tx.accountNumber?.trim();
      if (!account) {
        if (!matchTransactionsWithoutAccountNumber) continue;
        accountKey = accountSuffix;
      } else {
        const normalized = account.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!normalized.endsWith(accountSuffix.toUpperCase())) continue;
        accountKey = accountSuffix;
      }
    } else {
      accountKey = tx.accountNumber?.trim() ?? '';
    }
    const key = `${accountKey}|${tx.amount.toFixed(4)}|${balance.toFixed(4)}`;
    const list = groups.get(key) ?? [];
    list.push(tx);
    groups.set(key, list);
  }

  const plans: DeduplicationPlan[] = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) => (timeMs(a) ?? 0) - (timeMs(b) ?? 0));
    const clusters: Transaction[][] = [];
    let current: Transaction[] = [];
    let start: number | null = null;
    for (const tx of sorted) {
      const t = timeMs(tx);
      if (current.length === 0) {
        current = [tx];
        start = t;
        continue;
      }
      if (t === null || start === null || t - start <= WINDOW_MS) {
        current.push(tx);
        if (start === null) start = t;
      } else {
        clusters.push(current);
        current = [tx];
        start = t;
      }
    }
    if (current.length) clusters.push(current);

    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      const ranked = [...cluster].sort(compareRichness);
      const keeper = ranked[0];
      const duplicates = ranked.slice(1);
      plans.push({ keeper, mergedKeeper: mergeTransactions(keeper, duplicates), duplicates });
    }
  }
  return plans;
}
