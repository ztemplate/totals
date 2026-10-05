export type SplitKind = 'expense' | 'loan';

/**
 * One part of a transaction. Expense parts carry their own category; loan parts are money
 * paid (or received) on behalf of a person and are tracked as a loan entry keyed
 * by splitLoanReference(parentReference, id).
 */
export interface TransactionSplit {
  id: number;
  parentReference: string;
  amount: number;
  kind: SplitKind;
  categoryId: number | null;
  personId: number | null;
  note: string | null;
  createdAt: string;
  updatedAt?: string | null;
}

export const SPLIT_LOAN_SEPARATOR = '#split-';

export function splitLoanReference(parentReference: string, splitId: number): string {
  return `${parentReference}${SPLIT_LOAN_SEPARATOR}${splitId}`;
}

/** The parent transaction of a split loan reference, or null for an ordinary reference. */
export function parentReferenceOfSplitLoan(reference: string | null | undefined): string | null {
  const ref = reference ?? '';
  const index = ref.lastIndexOf(SPLIT_LOAN_SEPARATOR);
  if (index <= 0) return null;
  return /^\d+$/.test(ref.slice(index + SPLIT_LOAN_SEPARATOR.length)) ? ref.slice(0, index) : null;
}

export function splitFromDb(row: Record<string, any>): TransactionSplit {
  return {
    id: Number(row.id),
    parentReference: String(row.parentReference ?? ''),
    amount: Math.abs(Number(row.amount) || 0),
    kind: row.kind === 'loan' ? 'loan' : 'expense',
    categoryId: row.categoryId == null ? null : Number(row.categoryId),
    personId: row.personId == null ? null : Number(row.personId),
    note: row.note ?? null,
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? null,
  };
}
