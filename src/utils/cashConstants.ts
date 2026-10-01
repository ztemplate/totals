import type { Bank } from '../models/bank';

export const CASH_BANK_ID = 100;
export const CASH_BANK_NAME = 'Cash Wallet';
export const CASH_ACCOUNT_NUMBER = 'CASH';
export const CASH_ATM_REFERENCE_PREFIX = 'cash_atm_';
export const CASH_MANUAL_REFERENCE_PREFIX = 'cash_manual_';

export const CASH_BANK: Bank = {
  id: CASH_BANK_ID,
  name: CASH_BANK_NAME,
  shortName: 'Cash',
  codes: [],
  image: 'assets/images/cash.png',
  maskPattern: 0,
  uniformMasking: false,
  simBased: false,
  colors: ['#0f766e', '#14b8a6'],
};

export function isCashReference(reference: string | null | undefined): boolean {
  const ref = reference ?? '';
  return ref.startsWith(CASH_ATM_REFERENCE_PREFIX) || ref.startsWith(CASH_MANUAL_REFERENCE_PREFIX);
}

export function newManualCashReference(): string {
  return `${CASH_MANUAL_REFERENCE_PREFIX}${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
