import { displayReference as smsDisplayReference } from '../utils/smsTransactionSource';

export const OwnerAssignment = {
  manual: 'manual',
  automatic: 'automatic',
  default: 'default',
  conflict: 'conflict',
} as const;

export interface Transaction {
  amount: number;
  reference: string;
  creditor?: string | null;
  receiver?: string | null;
  note?: string | null;
  /** ISO string */
  time?: string | null;
  status?: string | null;
  currentBalance?: string | null;
  bankId?: number | null;
  /** CREDIT or DEBIT */
  type?: string | null;
  transactionLink?: string | null;
  accountNumber?: string | null;
  /** User-entered account number selected as the authoritative owner. */
  ownerAccountNumber?: string | null;
  /** How ownerAccountNumber was chosen. Manual choices are authoritative. */
  ownerAssignmentSource?: string | null;
  categoryId?: number | null;
  categoryIds?: number[] | null;
  profileId?: number | null;
  serviceCharge?: number | null;
  vat?: number | null;
  sourceType?: string | null;
  sourceMessageId?: string | null;
  sourceFingerprint?: string | null;
  /** Android SMS subscription that delivered the source message. */
  sourceSubscriptionId?: number | null;
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function toDouble(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function toStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

export function decodeCategoryIds(raw: unknown): number[] | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    const parsed = raw.map(toInt).filter((v): v is number => v !== null);
    return parsed.length === 0 ? null : parsed;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return decodeCategoryIds(JSON.parse(trimmed));
    } catch {
      const parsed = trimmed
        .split(',')
        .map((v) => toInt(v))
        .filter((v): v is number => v !== null);
      return parsed.length === 0 ? null : parsed;
    }
  }
  if (typeof raw === 'number') return decodeCategoryIds([raw]);
  return null;
}

export function normalizeCategoryIds(
  ids: readonly number[] | null | undefined,
  primaryCategoryId?: number | null,
): number[] | null {
  const ordered: number[] = [];
  const add = (value: number | null | undefined) => {
    if (value === null || value === undefined || value <= 0 || ordered.includes(value)) return;
    ordered.push(value);
  };
  add(primaryCategoryId);
  for (const id of ids ?? []) add(id);
  return ordered.length === 0 ? null : ordered;
}

export function resolvePrimaryCategoryId(
  categoryId: number | null | undefined,
  categoryIds: readonly number[] | null | undefined,
): number | null {
  if (categoryId !== null && categoryId !== undefined && categoryId > 0) return categoryId;
  const normalized = normalizeCategoryIds(categoryIds);
  return normalized?.[0] ?? null;
}

/** Applies the same category invariants as the Flutter constructor. */
export function makeTransaction(input: Transaction): Transaction {
  const primary = resolvePrimaryCategoryId(input.categoryId, input.categoryIds);
  return {
    ...input,
    categoryId: primary,
    categoryIds: normalizeCategoryIds(input.categoryIds, primary),
  };
}

export function selectedCategoryIds(tx: Transaction): number[] {
  return normalizeCategoryIds(tx.categoryIds, tx.categoryId) ?? [];
}

export function txDisplayReference(tx: Transaction): string {
  return smsDisplayReference(tx.bankId, tx.reference);
}

export function txIncludesCategory(tx: Transaction, id: number | null | undefined): boolean {
  if (id === null || id === undefined) return false;
  return selectedCategoryIds(tx).includes(id);
}

export function hasManualOwnerAssignment(tx: Transaction): boolean {
  return tx.ownerAssignmentSource === OwnerAssignment.manual;
}

export function isCredit(tx: Transaction): boolean {
  return (tx.type ?? '').trim().toUpperCase() === 'CREDIT';
}

export function isDebit(tx: Transaction): boolean {
  return (tx.type ?? '').trim().toUpperCase() === 'DEBIT';
}

export function transactionFromJson(json: Record<string, unknown>): Transaction {
  return makeTransaction({
    amount: toDouble(json.amount),
    reference: (json.reference as string) ?? '',
    creditor: toStr(json.creditor),
    receiver: toStr(json.receiver),
    note: toStr(json.note),
    time: toStr(json.time),
    status: toStr(json.status),
    currentBalance: toStr(json.currentBalance),
    bankId: toInt(json.bankId),
    type: toStr(json.type),
    transactionLink: toStr(json.transactionLink),
    accountNumber: toStr(json.accountNumber),
    ownerAccountNumber: toStr(json.ownerAccountNumber),
    ownerAssignmentSource: toStr(json.ownerAssignmentSource),
    categoryId: toInt(json.categoryId),
    categoryIds: decodeCategoryIds(json.categoryIds),
    profileId: toInt(json.profileId),
    serviceCharge: json.serviceCharge === null || json.serviceCharge === undefined ? null : toDouble(json.serviceCharge),
    vat: json.vat === null || json.vat === undefined ? null : toDouble(json.vat),
    sourceType: toStr(json.sourceType),
    sourceMessageId: toStr(json.sourceMessageId),
    sourceFingerprint: toStr(json.sourceFingerprint),
    sourceSubscriptionId: toInt(json.sourceSubscriptionId),
  });
}

export function transactionToJson(tx: Transaction): Record<string, unknown> {
  const ids = selectedCategoryIds(tx);
  const json: Record<string, unknown> = {
    amount: tx.amount,
    reference: tx.reference,
    bankReference: txDisplayReference(tx),
    creditor: tx.creditor ?? null,
    receiver: tx.receiver ?? null,
    note: tx.note ?? null,
    time: tx.time ?? null,
    status: tx.status ?? null,
    currentBalance: tx.currentBalance ?? null,
    bankId: tx.bankId ?? null,
    type: tx.type ?? null,
    transactionLink: tx.transactionLink ?? null,
    accountNumber: tx.accountNumber ?? null,
    ownerAccountNumber: tx.ownerAccountNumber ?? null,
    ownerAssignmentSource: tx.ownerAssignmentSource ?? null,
    categoryId: tx.categoryId ?? null,
    categoryIds: ids.length === 0 ? null : ids,
  };
  if (tx.profileId != null) json.profileId = tx.profileId;
  if (tx.serviceCharge != null) json.serviceCharge = tx.serviceCharge;
  if (tx.vat != null) json.vat = tx.vat;
  if (tx.sourceType != null) json.sourceType = tx.sourceType;
  if (tx.sourceMessageId != null) json.sourceMessageId = tx.sourceMessageId;
  if (tx.sourceFingerprint != null) json.sourceFingerprint = tx.sourceFingerprint;
  return json;
}

export function txDate(tx: Transaction): Date | null {
  if (!tx.time) return null;
  const d = new Date(tx.time);
  return Number.isNaN(d.getTime()) ? null : d;
}
