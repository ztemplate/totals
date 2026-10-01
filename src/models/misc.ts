export interface Profile {
  id?: number | null;
  name: string;
  createdAt: string;
  updatedAt?: string | null;
}

export interface FailedParse {
  id?: number | null;
  address: string;
  body: string;
  reason: string;
  timestamp: string;
}

export interface UserAccount {
  id?: number | null;
  accountNumber: string;
  bankId: number;
  accountHolderName: string;
  createdAt: string;
}

export interface TransactionSourceSms {
  transactionReference: string;
  body: string;
  senderAddress?: string | null;
  receivedAt?: string | null;
  messageId?: string | null;
}

export interface AutoCategoryRule {
  id?: number | null;
  counterparty: string;
  normalizedCounterparty: string;
  flow: 'income' | 'expense';
  categoryId: number;
  isPrimary: boolean;
  createdAt: string;
}

export interface AutoCategoryPromptDismissal {
  id?: number | null;
  counterparty: string;
  normalizedCounterparty: string;
  flow: 'income' | 'expense';
  createdAt: string;
}

/** Local-only shared expense groups (the Flutter app also syncs these remotely). */
export interface SharedGroup {
  id?: number | null;
  name: string;
  members: string[];
  createdAt: string;
  updatedAt?: string | null;
}

export interface SharedExpense {
  id?: number | null;
  groupId: number;
  description: string;
  amount: number;
  paidBy: string;
  /** Member name -> share of the amount. */
  splits: Record<string, number>;
  transactionReference?: string | null;
  date: string;
  createdAt: string;
  settled: boolean;
}

export interface SharedSettlement {
  id?: number | null;
  groupId: number;
  from: string;
  to: string;
  amount: number;
  date: string;
}
