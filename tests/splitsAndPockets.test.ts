import { describe, expect, test } from 'bun:test';
import { parentReferenceOfSplitLoan, splitLoanReference, type TransactionSplit } from '../src/models/split';
import { makeTransaction, type Transaction } from '../src/models/transaction';
import { CASH_ATM_REFERENCE_PREFIX, CASH_BANK_ID } from '../src/utils/cashConstants';
import { listPockets, unlinkedCashSpends } from '../src/utils/cashPocket';
import {
  amountInCategories,
  categoryAllocations,
  equalSplit,
  remainingAmount,
  transactionTouchesCategory,
  validateSplits,
} from '../src/utils/transactionSplits';

function tx(input: Partial<Transaction> & { reference: string }): Transaction {
  return makeTransaction({ amount: 100, type: 'DEBIT', bankId: 1, time: '2026-03-01T10:00:00.000Z', ...input });
}

let splitId = 0;
function split(input: Partial<TransactionSplit> & Pick<TransactionSplit, 'amount'>): TransactionSplit {
  splitId++;
  return {
    id: splitId,
    parentReference: 'P1',
    kind: 'expense',
    categoryId: null,
    personId: null,
    note: null,
    createdAt: '2026-03-01T10:00:00.000Z',
    ...input,
  };
}

describe('transaction splits', () => {
  test('equal split adds up to the total', () => {
    expect(equalSplit(100, 3)).toEqual([33.34, 33.33, 33.33]);
    expect(equalSplit(90, 3)).toEqual([30, 30, 30]);
    expect(equalSplit(0.05, 2)).toEqual([0.03, 0.02]);
    expect(equalSplit(10, 0)).toEqual([]);
  });

  test('validates parts against the parent amount', () => {
    expect(validateSplits(100, [split({ amount: 40 }), split({ amount: 60 })])).toBeNull();
    expect(validateSplits(100, [split({ amount: 40 }), split({ amount: 60.01 })])).toMatch(/more than/);
    expect(validateSplits(100, [split({ amount: 0 })])).toMatch(/positive/);
    expect(validateSplits(100, [split({ amount: 10, kind: 'loan', personId: null })])).toMatch(/person/);
    expect(remainingAmount(-100, [split({ amount: 33.33 }), split({ amount: 33.33 })])).toBe(33.34);
    expect(remainingAmount(100, [split({ amount: 100 })])).toBe(0);
  });

  test('allocates the principal over categories, leaving loans out of spending', () => {
    const shop = tx({ reference: 'P1', amount: 1000, categoryId: 1 });
    const parts = [
      split({ amount: 500, categoryId: 2 }), // groceries
      split({ amount: 200, categoryId: 3 }), // utility
      split({ amount: 150, kind: 'loan', personId: 9 }), // bought for a friend
    ];
    expect(categoryAllocations(shop, parts)).toEqual([
      { categoryId: 2, amount: 500 },
      { categoryId: 3, amount: 200 },
      { categoryId: 1, amount: 150 },
    ]);
    expect(amountInCategories(shop, parts, new Set([2]))).toBe(500);
    expect(amountInCategories(shop, parts, new Set([1]))).toBe(150);
    expect(amountInCategories(shop, undefined, new Set([1]))).toBe(1000);
    expect(transactionTouchesCategory(shop, parts, 3)).toBe(true);
    expect(transactionTouchesCategory(shop, parts, 4)).toBe(false);
  });

  test('uncategorized expense parts fall back to the parent category', () => {
    const shop = tx({ reference: 'P1', amount: 100, categoryId: 5 });
    expect(categoryAllocations(shop, [split({ amount: 30 })])).toEqual([{ categoryId: 5, amount: 100 }]);
  });

  test('split loan references point back to the parent', () => {
    const ref = splitLoanReference('FT2406#ABC', 12);
    expect(ref).toBe('FT2406#ABC#split-12');
    expect(parentReferenceOfSplitLoan(ref)).toBe('FT2406#ABC');
    expect(parentReferenceOfSplitLoan('FT2406')).toBeNull();
    expect(parentReferenceOfSplitLoan('x#split-abc')).toBeNull();
  });
});

describe('cash pockets', () => {
  const withdrawal = tx({ reference: 'ATM1', amount: 2000, time: '2026-03-01T09:00:00.000Z' });
  const mirror = tx({
    reference: `${CASH_ATM_REFERENCE_PREFIX}ATM1`,
    bankId: CASH_BANK_ID,
    type: 'CREDIT',
    amount: 2000,
    time: '2026-03-01T09:00:00.000Z',
  });
  const coffee = tx({ reference: 'cash_manual_1', bankId: CASH_BANK_ID, amount: 150, time: '2026-03-01T11:00:00.000Z' });
  const taxi = tx({ reference: 'cash_manual_2', bankId: CASH_BANK_ID, amount: 300, time: '2026-03-02T08:00:00.000Z' });
  const older = tx({ reference: 'cash_manual_0', bankId: CASH_BANK_ID, amount: 50, time: '2026-02-20T08:00:00.000Z' });
  const textAtm = tx({ reference: 'ATM2', amount: 500, receiver: 'ATM Bole', time: '2026-03-03T08:00:00.000Z' });
  const all = [withdrawal, mirror, coffee, taxi, older, textAtm];

  test('lists withdrawals with what is left of them', () => {
    const links = [{ cashReference: 'cash_manual_1', withdrawalReference: 'ATM1' }, { cashReference: 'cash_manual_2', withdrawalReference: 'ATM1' }];
    const pockets = listPockets(all, links);
    expect(pockets.map((p) => p.withdrawal.reference)).toEqual(['ATM2', 'ATM1']);
    const atm1 = pockets[1].summary;
    expect(atm1.withdrawn).toBe(2000);
    expect(atm1.spent).toBe(450);
    expect(atm1.remaining).toBe(1550);
    expect(atm1.spends.map((s) => s.reference)).toEqual(['cash_manual_2', 'cash_manual_1']);
    expect(pockets[0].summary.spent).toBe(0);
  });

  test('offers only unlinked cash spending after the withdrawal', () => {
    const links = [{ cashReference: 'cash_manual_1', withdrawalReference: 'ATM1' }];
    expect(unlinkedCashSpends(all, links, new Date('2026-03-01T09:00:00.000Z')).map((t) => t.reference)).toEqual(['cash_manual_2']);
    expect(unlinkedCashSpends(all, links).map((t) => t.reference)).toEqual(['cash_manual_2', 'cash_manual_0']);
  });
});
