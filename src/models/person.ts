export type PersonAccountKind = 'name' | 'account' | 'phone';

export type PersonType = 'friend' | 'family' | 'shop' | 'restaurant' | 'cafe' | 'service' | 'work' | 'other';

export const PERSON_TYPES: { value: PersonType; label: string; icon: string }[] = [
  { value: 'friend', label: 'Friend', icon: 'person' },
  { value: 'family', label: 'Family', icon: 'family-restroom' },
  { value: 'shop', label: 'Shop', icon: 'storefront' },
  { value: 'restaurant', label: 'Restaurant', icon: 'restaurant' },
  { value: 'cafe', label: 'Cafe', icon: 'local-cafe' },
  { value: 'service', label: 'Service', icon: 'build' },
  { value: 'work', label: 'Work', icon: 'work' },
  { value: 'other', label: 'Other', icon: 'label' },
];

export function personTypeFromStorage(value: unknown): PersonType {
  return PERSON_TYPES.some((t) => t.value === value) ? (value as PersonType) : 'friend';
}

export function personTypeMeta(type: PersonType | null | undefined) {
  return PERSON_TYPES.find((t) => t.value === type) ?? PERSON_TYPES[0];
}

export interface Person {
  id: number;
  name: string;
  phone?: string | null;
  note?: string | null;
  /** Friend, shop, restaurant… Missing means friend. */
  type?: PersonType;
  /** Telegram username, kept for the planned Telegram bot nudges. */
  telegram?: string | null;
  email?: string | null;
  address?: string | null;
  profileId?: number | null;
  createdAt: string;
  updatedAt?: string | null;
}

/**
 * One way a person shows up in bank messages: the counterparty name a bank prints,
 * an account number or a phone number. bankId null means "any bank".
 */
export interface PersonAccount {
  id: number;
  personId: number;
  bankId: number | null;
  identifier: string;
  normalizedIdentifier: string;
  kind: PersonAccountKind;
  createdAt: string;
}

/** Manual per-transaction assignment. personId null means "explicitly nobody". */
export interface PersonTransactionLink {
  transactionReference: string;
  personId: number | null;
  createdAt: string;
}

export function personAccountKindFromStorage(value: unknown): PersonAccountKind {
  return value === 'account' || value === 'phone' ? value : 'name';
}

export function personFromDb(row: Record<string, any>): Person {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    phone: row.phone ?? null,
    note: row.note ?? null,
    type: personTypeFromStorage(row.type),
    telegram: row.telegram ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    profileId: row.profileId ?? null,
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? null,
  };
}

export function personAccountFromDb(row: Record<string, any>): PersonAccount {
  return {
    id: Number(row.id),
    personId: Number(row.personId),
    bankId: row.bankId == null ? null : Number(row.bankId),
    identifier: String(row.identifier ?? ''),
    normalizedIdentifier: String(row.normalizedIdentifier ?? ''),
    kind: personAccountKindFromStorage(row.kind),
    createdAt: row.createdAt ?? new Date().toISOString(),
  };
}

export function personTransactionLinkFromDb(row: Record<string, any>): PersonTransactionLink {
  return {
    transactionReference: String(row.transactionReference ?? ''),
    personId: row.personId == null ? null : Number(row.personId),
    createdAt: row.createdAt ?? new Date().toISOString(),
  };
}
