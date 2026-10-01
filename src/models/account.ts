export interface Account {
  id?: number | null;
  accountNumber: string;
  bank: number;
  balance: number;
  accountHolderName: string;
  settledBalance?: number | null;
  pendingCredit?: number | null;
  profileId?: number | null;
  /** Device-local Android SMS subscription learned for this account. */
  smsSubscriptionId?: number | null;
  includeInTotals: boolean;
  isDormant: boolean;
  isDefault: boolean;
}

export function accountFromDb(row: Record<string, any>): Account {
  return {
    id: row.id ?? null,
    accountNumber: String(row.accountNumber ?? ''),
    bank: Number(row.bank),
    balance: Number(row.balance ?? 0),
    accountHolderName: String(row.accountHolderName ?? ''),
    settledBalance: row.settledBalance ?? null,
    pendingCredit: row.pendingCredit ?? null,
    profileId: row.profileId ?? null,
    smsSubscriptionId: row.smsSubscriptionId ?? null,
    includeInTotals: (row.includeInTotals ?? 1) === 1 || row.includeInTotals === true,
    isDormant: row.isDormant === 1 || row.isDormant === true,
    isDefault: row.isDefault === 1 || row.isDefault === true,
  };
}

export function accountFromJson(json: Record<string, any>): Account {
  const toBool = (v: unknown, fallback: boolean) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
      const n = v.trim().toLowerCase();
      if (n === 'true' || n === '1') return true;
      if (n === 'false' || n === '0') return false;
    }
    return fallback;
  };
  const toNum = (v: unknown) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const p = Number.parseFloat(v);
      return Number.isNaN(p) ? null : p;
    }
    return null;
  };
  return {
    id: json.id ?? null,
    accountNumber: String(json.accountNumber ?? ''),
    bank: Number(json.bank),
    balance: toNum(json.balance) ?? 0,
    accountHolderName: String(json.accountHolderName ?? ''),
    settledBalance: toNum(json.settledBalance),
    pendingCredit: toNum(json.pendingCredit),
    profileId: json.profileId ?? null,
    smsSubscriptionId: json.smsSubscriptionId ?? null,
    includeInTotals: toBool(json.includeInTotals, true),
    isDormant: toBool(json.isDormant, false),
    isDefault: toBool(json.isDefault, false),
  };
}

export function accountToDb(account: Account): Record<string, unknown> {
  return {
    accountNumber: account.accountNumber,
    bank: account.bank,
    balance: account.balance,
    accountHolderName: account.accountHolderName,
    settledBalance: account.settledBalance ?? null,
    pendingCredit: account.pendingCredit ?? null,
    profileId: account.profileId ?? null,
    smsSubscriptionId: account.smsSubscriptionId ?? null,
    includeInTotals: account.includeInTotals ? 1 : 0,
    isDormant: account.isDormant ? 1 : 0,
    isDefault: account.isDefault ? 1 : 0,
  };
}

export function accountToJson(account: Account): Record<string, unknown> {
  return {
    accountNumber: account.accountNumber,
    bank: account.bank,
    balance: account.balance,
    accountHolderName: account.accountHolderName,
    settledBalance: account.settledBalance ?? null,
    pendingCredit: account.pendingCredit ?? null,
    profileId: account.profileId ?? null,
    includeInTotals: account.includeInTotals,
    isDormant: account.isDormant,
    isDefault: account.isDefault,
  };
}
