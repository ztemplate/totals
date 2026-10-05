import type { TransactionSplit } from '../models/split';
import type { SplitDraft } from '../repositories/splitRepository';
import { parseAmountInput } from './format';
import { equalSplit, roundMoney, validateSplits } from './transactionSplits';

/**
 * One row of the split editor. personId null means the part is yours ("Me"): it is saved as an
 * expense part in its category. A part for someone else is saved as a loan to that person and
 * keeps its category too, so you can see what the money was for.
 */
export interface SplitEntry {
  key: string;
  /** Existing split id, or undefined for a new row. */
  id?: number;
  amount: string;
  categoryId: number | null;
  personId: number | null;
  note: string;
}

let entryKeySeq = 0;

export function amountString(value: number): string {
  return value > 0 ? String(roundMoney(value)) : '';
}

export function newEntry(amount = 0, personId: number | null = null, categoryId: number | null = null): SplitEntry {
  entryKeySeq += 1;
  return { key: `new-${entryKeySeq}`, amount: amountString(amount), categoryId, personId, note: '' };
}

export function entriesFromSplits(splits: readonly TransactionSplit[]): SplitEntry[] {
  return splits.map((s) => ({
    key: `id-${s.id}`,
    id: s.id,
    amount: amountString(s.amount),
    categoryId: s.categoryId,
    personId: s.kind === 'loan' ? s.personId : null,
    note: s.note ?? '',
  }));
}

export function entriesToDrafts(entries: readonly SplitEntry[]): SplitDraft[] {
  return entries.map((e) => ({
    id: e.id,
    amount: parseAmountInput(e.amount) ?? 0,
    kind: e.personId == null ? 'expense' : 'loan',
    categoryId: e.categoryId,
    personId: e.personId,
    note: e.note,
  }));
}

export function allocatedAmount(entries: readonly SplitEntry[]): number {
  return roundMoney(entries.reduce((sum, e) => sum + Math.max(0, parseAmountInput(e.amount) ?? 0), 0));
}

/** Error message for the entries, or null when they can be saved. */
export function validateEntries(total: number, entries: readonly SplitEntry[]): string | null {
  if (entries.length === 0) return 'Add at least one part.';
  return validateSplits(
    total,
    entriesToDrafts(entries).map((d) => ({ amount: d.amount, kind: d.kind, personId: d.personId ?? null })),
  );
}

/**
 * n equal parts of the total. Existing rows keep their person, category and note (in order);
 * missing rows are added as "Me" and extra rows are dropped.
 */
export function equalEntries(total: number, n: number, existing: readonly SplitEntry[]): SplitEntry[] {
  const shares = equalSplit(total, n);
  return shares.map((share, i) => {
    const row = existing[i];
    return row ? { ...row, amount: amountString(share) } : newEntry(share);
  });
}

/**
 * Equal parts for you and every member of a group. Rows already in the editor for the same
 * person (or your own row) are reused so their categories and notes survive.
 */
export function groupEntries(
  total: number,
  memberIds: readonly number[],
  existing: readonly SplitEntry[],
  includeMe = true,
): SplitEntry[] {
  const members = [...new Set(memberIds)];
  const n = members.length + (includeMe ? 1 : 0);
  if (n === 0) return [...existing];
  const shares = equalSplit(total, n);
  const mine = existing.find((e) => e.personId == null);
  const byPerson = new Map(existing.filter((e) => e.personId != null).map((e) => [e.personId!, e]));
  const rows: SplitEntry[] = [];
  if (includeMe) rows.push(mine ? { ...mine, amount: amountString(shares[0]) } : newEntry(shares[0]));
  members.forEach((personId, i) => {
    const share = shares[i + (includeMe ? 1 : 0)];
    const row = byPerson.get(personId);
    rows.push(row ? { ...row, amount: amountString(share) } : newEntry(share, personId, mine?.categoryId ?? null));
  });
  return rows;
}
