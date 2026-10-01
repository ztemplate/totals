export type LoanDebtDirection = 'lent' | 'borrowed';
export type LoanDebtStatus = 'active' | 'settled' | 'forgiven';
export type LoanDebtEntrySource = 'transaction' | 'repayment_surplus';

export interface LoanDebtEntry {
  id?: number | null;
  transactionReference: string;
  personName: string;
  direction: LoanDebtDirection;
  status: LoanDebtStatus;
  principalAmount?: number | null;
  source: LoanDebtEntrySource;
  returnDate?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoanDebtRepayment {
  id?: number | null;
  repaymentTransactionReference: string;
  loanDebtTransactionReference: string;
  appliedAmount: number;
  createdAt: string;
  updatedAt: string;
}

export function loanDebtDirectionFromStorage(value: unknown): LoanDebtDirection {
  return value === 'borrowed' ? 'borrowed' : 'lent';
}

export function loanDebtStatusFromStorage(value: unknown): LoanDebtStatus {
  return value === 'settled' || value === 'forgiven' ? value : 'active';
}

export function normalizeLoanDebtPersonName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function loanDebtEntryFromDb(row: Record<string, any>): LoanDebtEntry {
  const now = new Date().toISOString();
  const createdAt = row.createdAt ?? now;
  return {
    id: row.id ?? null,
    transactionReference: String(row.transactionReference ?? ''),
    personName: String(row.personName ?? ''),
    direction: loanDebtDirectionFromStorage(row.direction),
    status: loanDebtStatusFromStorage(row.status),
    principalAmount: row.principalAmount == null ? null : Number(row.principalAmount),
    source: row.source === 'repayment_surplus' ? 'repayment_surplus' : 'transaction',
    returnDate: row.returnDate ?? null,
    resolvedAt: row.resolvedAt ?? null,
    createdAt,
    updatedAt: row.updatedAt ?? createdAt,
  };
}

export function loanDebtRepaymentFromDb(row: Record<string, any>): LoanDebtRepayment {
  const now = new Date().toISOString();
  const createdAt = row.createdAt ?? now;
  return {
    id: row.id ?? null,
    repaymentTransactionReference: String(row.repaymentTransactionReference ?? ''),
    loanDebtTransactionReference: String(row.loanDebtTransactionReference ?? ''),
    appliedAmount: Number(row.appliedAmount ?? 0),
    createdAt,
    updatedAt: row.updatedAt ?? createdAt,
  };
}

export interface ReimbursementAllocation {
  id?: number | null;
  reimbursementTransactionReference: string;
  expenseTransactionReference: string;
  appliedAmount: number;
  createdAt: string;
  updatedAt: string;
}

export function reimbursementFromDb(row: Record<string, any>): ReimbursementAllocation {
  const now = new Date().toISOString();
  const createdAt = row.createdAt ?? now;
  return {
    id: row.id ?? null,
    reimbursementTransactionReference: String(row.reimbursementTransactionReference ?? ''),
    expenseTransactionReference: String(row.expenseTransactionReference ?? ''),
    appliedAmount: Number(row.appliedAmount ?? 0),
    createdAt,
    updatedAt: row.updatedAt ?? createdAt,
  };
}
