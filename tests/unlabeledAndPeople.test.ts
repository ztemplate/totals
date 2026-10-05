import { describe, expect, test } from 'bun:test';
import { BUNDLED_BANKS } from '../src/data/banks';
import type { Account } from '../src/models/account';
import type { LoanDebtEntry } from '../src/models/loanDebt';
import type { Person, PersonType } from '../src/models/person';
import { makeTransaction, type Transaction } from '../src/models/transaction';
import type { LoanDebtItem } from '../src/services/loanDebtSummary';
import { analyzePeople } from '../src/utils/peopleAnalytics';
import { detectUnlabeledAccounts, isMaskedAccountNumber } from '../src/utils/unlabeledAccounts';

const CBE = 1;
const TELEBIRR = 6;

function tx(input: Partial<Transaction> & { reference: string }): Transaction {
  return makeTransaction({ amount: 100, type: 'DEBIT', bankId: CBE, time: '2026-03-01T10:00:00.000Z', ...input });
}

function account(accountNumber: string, bank = CBE): Account {
  return { id: 1, accountNumber, bank, balance: 0, accountHolderName: 'Me', includeInTotals: true, isDormant: false, isDefault: false };
}

describe('unlabeled accounts', () => {
  test('recognises masked numbers', () => {
    expect(isMaskedAccountNumber('1****5678')).toBe(true);
    expect(isMaskedAccountNumber('1XXXX5678')).toBe(true);
    expect(isMaskedAccountNumber('1000123455678')).toBe(false);
    expect(isMaskedAccountNumber(null)).toBe(false);
  });

  test('groups bank messages by the account printed in them', () => {
    const transactions = [
      tx({ reference: 'a1', accountNumber: '1****5678', type: 'CREDIT', amount: 500, currentBalance: '1,500.00', time: '2026-03-02T10:00:00.000Z' }),
      tx({ reference: 'a2', accountNumber: '1000123455678', amount: 200, time: '2026-03-01T10:00:00.000Z' }),
      tx({ reference: 'b1', accountNumber: '1****9999', amount: 50, time: '2026-02-01T10:00:00.000Z' }),
      tx({ reference: 't1', bankId: TELEBIRR, accountNumber: '0911000000', sourceSubscriptionId: 2 }),
      tx({ reference: 't2', bankId: TELEBIRR, accountNumber: '0922000000', sourceSubscriptionId: 2 }),
      tx({ reference: 'cash', bankId: 100 }),
    ];
    const groups = detectUnlabeledAccounts(transactions, [], BUNDLED_BANKS);
    expect(groups).toHaveLength(3);

    const main = groups.find((g) => g.references.includes('a1'))!;
    expect(main.references.sort()).toEqual(['a1', 'a2']);
    // The unmasked spelling wins once one is seen.
    expect(main.accountNumber).toBe('1000123455678');
    expect(main.credit).toBe(500);
    expect(main.debit).toBe(200);
    expect(main.lastBalance).toBe(1500);

    // telebirr prints the counterparty, so messages are grouped by the receiving SIM.
    const sim = groups.find((g) => g.bankId === TELEBIRR)!;
    expect(sim.accountNumber).toBeNull();
    expect(sim.subscriptionId).toBe(2);
    expect(sim.count).toBe(2);
  });

  test('once a bank has accounts only contradicting numbers are new accounts', () => {
    const transactions = [
      tx({ reference: 'mine', accountNumber: '1****5678' }),
      tx({ reference: 'other', accountNumber: '1****9999' }),
      tx({ reference: 'none', accountNumber: null }),
    ];
    const groups = detectUnlabeledAccounts(transactions, [account('1000123455678')], BUNDLED_BANKS);
    expect(groups.map((g) => g.references)).toEqual([['other']]);
  });
});

function person(id: number, name: string, type: PersonType): Person {
  return { id, name, type, createdAt: '2026-01-01T00:00:00.000Z' };
}

function lent(personName: string, original: number, remaining: number, createdAt = '2026-03-01T00:00:00.000Z'): LoanDebtItem {
  const entry: LoanDebtEntry = {
    transactionReference: `loan-${personName}-${original}`,
    personName,
    direction: 'lent',
    status: 'active',
    principalAmount: original,
    source: 'manual' as LoanDebtEntry['source'],
    createdAt,
    updatedAt: createdAt,
  };
  return {
    entry,
    transaction: null,
    sourceTransaction: null,
    original,
    repaid: original - remaining,
    remaining,
    effectiveStatus: remaining > 0 ? 'active' : 'settled',
    repayments: [],
  };
}

describe('people analytics', () => {
  const abebe = person(1, 'Abebe', 'friend');
  const cafe = person(2, 'Tomoca', 'cafe');
  const donut = person(3, 'Donut place', 'cafe');
  const shop = person(4, 'Shoa', 'shop');
  const people = [abebe, cafe, donut, shop];

  const byPerson = new Map<number, Transaction[]>([
    [1, [tx({ reference: 'f1', amount: 1000 }), tx({ reference: 'f2', amount: 400, type: 'CREDIT' }), tx({ reference: 'self', amount: 9999 })]],
    [2, [tx({ reference: 'c1', amount: 80 }), tx({ reference: 'c2', amount: 80 }), tx({ reference: 'c3', amount: 80 })]],
    [3, [tx({ reference: 'd1', amount: 120 }), tx({ reference: 'd-old', amount: 500, time: '2025-12-01T00:00:00.000Z' })]],
    [4, [tx({ reference: 's1', amount: 2000 })]],
  ]);
  const loansByPerson = new Map<number, LoanDebtItem[]>([
    [1, [lent('Abebe', 1000, 600), lent('Abebe', 300, 0)]],
    [4, [lent('Shoa', 200, 200, '2025-11-01T00:00:00.000Z')]],
  ]);

  const result = analyzePeople({
    people,
    byPerson,
    loansByPerson,
    since: new Date('2026-01-01T00:00:00.000Z'),
    exclude: new Set(['self']),
  });

  test('ranks where the money goes', () => {
    expect(result.totalSpent).toBe(1000 + 240 + 120 + 2000);
    expect(result.totalReceived).toBe(400);
    expect(result.topSpending.map((r) => r.person.name)).toEqual(['Shoa', 'Abebe', 'Tomoca', 'Donut place']);
    expect(result.byType.map((t) => [t.type, t.amount, t.people])).toEqual([
      ['shop', 2000, 1],
      ['friend', 1000, 1],
      ['cafe', 360, 2],
    ]);
  });

  test('finds who borrows the most and who you deal with most', () => {
    expect(result.topBorrowers.map((b) => [b.person.name, b.lent, b.outstanding, b.loans])).toEqual([
      ['Abebe', 1300, 600, 2],
      // Lent before the period, but still owing.
      ['Shoa', 0, 200, 0],
    ]);
    expect(result.mostTransactions[0].person.name).toBe('Tomoca');
    expect(result.mostTransactions[0].count).toBe(3);
  });
});
