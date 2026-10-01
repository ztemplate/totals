import type { Transaction } from '../models/transaction';

function nonNegative(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function principalAmount(tx: Transaction): number {
  const amount = Math.abs(tx.amount);
  return Number.isFinite(amount) ? amount : 0;
}

export function transactionFeeAmount(tx: Transaction): number {
  return nonNegative(tx.serviceCharge) + nonNegative(tx.vat);
}

export function transactionDebitOutflowFromValues(params: {
  amount: number;
  serviceCharge?: number | null;
  vat?: number | null;
}): number {
  const principal = Math.abs(params.amount);
  return (Number.isFinite(principal) ? principal : 0) + nonNegative(params.serviceCharge) + nonNegative(params.vat);
}

export function transactionDebitOutflow(tx: Transaction): number {
  if (tx.type !== 'DEBIT') return 0;
  return transactionDebitOutflowFromValues(tx);
}

export function transactionIncomeAmount(
  tx: Transaction,
  options: { isSelfTransfer: boolean; excludeFromIncome?: boolean },
): number {
  if (tx.type !== 'CREDIT' || options.isSelfTransfer || options.excludeFromIncome) return 0;
  return principalAmount(tx);
}

export function transactionExpenseAmount(tx: Transaction, options: { isSelfTransfer: boolean }): number {
  if (tx.type !== 'DEBIT') return 0;
  const principal = options.isSelfTransfer ? 0 : principalAmount(tx);
  return principal + transactionFeeAmount(tx);
}

export function expenseAmountAfterReimbursement(grossExpense: number, reimbursedAmount: number): number {
  if (!Number.isFinite(grossExpense) || grossExpense <= 0) return 0;
  if (!Number.isFinite(reimbursedAmount) || reimbursedAmount <= 0) return grossExpense;
  const net = grossExpense - reimbursedAmount;
  return net <= 0 ? 0 : net;
}

export function transactionNetExpenseAmount(
  tx: Transaction,
  options: { isSelfTransfer: boolean; reimbursedAmount?: number },
): number {
  return expenseAmountAfterReimbursement(transactionExpenseAmount(tx, options), options.reimbursedAmount ?? 0);
}

export function transactionBalanceDelta(tx: Transaction): number {
  if (tx.type === 'CREDIT') return principalAmount(tx);
  if (tx.type === 'DEBIT') return -transactionDebitOutflow(tx);
  return 0;
}
