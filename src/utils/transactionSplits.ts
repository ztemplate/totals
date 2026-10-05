import type { TransactionSplit } from '../models/split';
import { selectedCategoryIds, type Transaction } from '../models/transaction';

const EPSILON = 0.005;

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function splitTotal(splits: readonly Pick<TransactionSplit, 'amount'>[]): number {
  return roundMoney(splits.reduce((sum, s) => sum + Math.abs(s.amount), 0));
}

/** What is left of the parent after its splits. Never negative. */
export function remainingAmount(parentAmount: number, splits: readonly Pick<TransactionSplit, 'amount'>[]): number {
  const left = roundMoney(Math.abs(parentAmount) - splitTotal(splits));
  return left <= EPSILON ? 0 : left;
}

/** Returns an error message, or null when the parts fit inside the parent amount. */
export function validateSplits(
  parentAmount: number,
  splits: readonly Pick<TransactionSplit, 'amount' | 'kind' | 'personId'>[],
): string | null {
  for (const split of splits) {
    if (!Number.isFinite(split.amount) || split.amount <= 0) return 'Every part needs a positive amount.';
    if (split.kind === 'loan' && split.personId == null) return 'Pick a person for every loan part.';
  }
  if (splitTotal(splits) - Math.abs(parentAmount) > EPSILON) return 'The parts add up to more than the transaction.';
  return null;
}

/**
 * Splits total into n shares that add up exactly, cent remainders going to the first shares.
 * equalSplit(100, 3) -> [33.34, 33.33, 33.33]
 */
export function equalSplit(total: number, n: number): number[] {
  if (n <= 0 || !Number.isFinite(total)) return [];
  const cents = Math.round(Math.abs(total) * 100);
  const base = Math.floor(cents / n);
  const extra = cents - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < extra ? 1 : 0)) / 100);
}

export interface CategoryAllocation {
  /** null = uncategorized */
  categoryId: number | null;
  amount: number;
}

/**
 * How a transaction's principal is spread over categories once split.
 * Expense parts go to their own category (or the parent's primary one when they have none),
 * loan parts are not spending, and the unsplit remainder stays with the parent's categories.
 */
export function categoryAllocations(
  tx: Transaction,
  splits: readonly TransactionSplit[] | undefined,
  amount: number = Math.abs(tx.amount),
): CategoryAllocation[] {
  const parentIds = selectedCategoryIds(tx);
  const parentPrimary = parentIds[0] ?? null;
  if (!splits || splits.length === 0) return [{ categoryId: parentPrimary, amount }];
  const byCategory = new Map<number | null, number>();
  const add = (id: number | null, value: number) => {
    if (value <= EPSILON) return;
    byCategory.set(id, roundMoney((byCategory.get(id) ?? 0) + value));
  };
  // Fees and other differences between amount and the principal stay with the parent.
  let rest = amount;
  for (const split of splits) {
    const part = Math.min(Math.abs(split.amount), Math.max(rest, 0));
    rest -= part;
    if (split.kind === 'expense') add(split.categoryId ?? parentPrimary, part);
  }
  add(parentPrimary, rest);
  return [...byCategory.entries()].map(([categoryId, value]) => ({ categoryId, amount: value }));
}

/** Amount of a transaction that counts toward any of the given categories, honouring splits. */
export function amountInCategories(
  tx: Transaction,
  splits: readonly TransactionSplit[] | undefined,
  categoryIds: ReadonlySet<number>,
  amount: number = Math.abs(tx.amount),
): number {
  if (!splits || splits.length === 0) {
    return selectedCategoryIds(tx).some((id) => categoryIds.has(id)) ? amount : 0;
  }
  const parentMatches = selectedCategoryIds(tx).some((id) => categoryIds.has(id));
  let total = 0;
  let rest = amount;
  for (const split of splits) {
    const part = Math.min(Math.abs(split.amount), Math.max(rest, 0));
    rest -= part;
    if (split.kind !== 'expense') continue;
    const matches = split.categoryId != null ? categoryIds.has(split.categoryId) : parentMatches;
    if (matches) total += part;
  }
  if (parentMatches) total += Math.max(rest, 0);
  return roundMoney(total);
}

/** True when the transaction or one of its expense parts is in the category. */
export function transactionTouchesCategory(
  tx: Transaction,
  splits: readonly TransactionSplit[] | undefined,
  categoryId: number,
): boolean {
  if (selectedCategoryIds(tx).includes(categoryId)) return true;
  return (splits ?? []).some((s) => s.kind === 'expense' && s.categoryId === categoryId);
}

export function groupSplitsByParent(splits: readonly TransactionSplit[]): Map<string, TransactionSplit[]> {
  const out = new Map<string, TransactionSplit[]>();
  for (const split of splits) {
    const list = out.get(split.parentReference) ?? [];
    list.push(split);
    out.set(split.parentReference, list);
  }
  return out;
}
