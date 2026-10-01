import { describe, expect, test } from 'bun:test';
import type { LoanDebtEntry } from '../src/models/loanDebt';
import type { Person, PersonAccount, PersonAccountKind, PersonTransactionLink } from '../src/models/person';
import { makeTransaction, type Transaction } from '../src/models/transaction';
import type { LoanDebtItem } from '../src/services/loanDebtSummary';
import {
  buildPeopleIndex,
  guessIdentifierKind,
  matchTransactionToPerson,
  normalizePersonIdentifier,
  normalizePersonName,
  normalizePhone,
  numberTokenMatches,
  personIdForLoanItem,
  suggestCounterparties,
  summarizePersonActivity,
} from '../src/utils/personMatching';

const NOW = '2025-01-01T00:00:00.000Z';

function person(id: number, name: string): Person {
  return { id, name, createdAt: NOW };
}

let accountId = 0;
function alias(personId: number, identifier: string, kind: PersonAccountKind, bankId: number | null = null): PersonAccount {
  accountId += 1;
  return {
    id: accountId,
    personId,
    bankId,
    identifier,
    normalizedIdentifier: normalizePersonIdentifier(identifier, kind),
    kind,
    createdAt: NOW,
  };
}

function tx(input: Partial<Transaction> & { reference: string }): Transaction {
  return makeTransaction({ amount: 100, type: 'DEBIT', bankId: 1, time: NOW, ...input });
}

function loanItem(input: {
  personName: string;
  direction: LoanDebtEntry['direction'];
  remaining: number;
  status?: LoanDebtItem['effectiveStatus'];
  transaction?: Transaction | null;
}): LoanDebtItem {
  return {
    entry: {
      transactionReference: input.transaction?.reference ?? `loan-${input.personName}`,
      personName: input.personName,
      direction: input.direction,
      status: input.status ?? 'active',
      source: 'transaction',
      createdAt: NOW,
      updatedAt: NOW,
    },
    transaction: input.transaction ?? null,
    original: input.remaining,
    repaid: 0,
    remaining: input.remaining,
    effectiveStatus: input.status ?? 'active',
    repayments: [],
  };
}

describe('normalization', () => {
  test('names ignore case, punctuation and digits', () => {
    expect(normalizePersonName('  ABEBE   KEBEDE (0911223344)')).toBe('abebe kebede');
    expect(normalizePersonName('Abebe-Kebede.')).toBe('abebe kebede');
    expect(normalizePersonName(null)).toBe('');
  });

  test('phones compare on the last 9 digits', () => {
    expect(normalizePhone('+251 911 223 344')).toBe('911223344');
    expect(normalizePhone('0911223344')).toBe('911223344');
    expect(normalizePhone('911223344')).toBe('911223344');
  });

  test('account numbers keep only digits', () => {
    expect(normalizePersonIdentifier('1000-1234-5678', 'account')).toBe('100012345678');
  });

  test('guesses identifier kind from input', () => {
    expect(guessIdentifierKind('0911223344')).toBe('phone');
    expect(guessIdentifierKind('+251 911 223344')).toBe('phone');
    expect(guessIdentifierKind('1000123456789')).toBe('account');
    expect(guessIdentifierKind('Abebe Kebede')).toBe('name');
    expect(guessIdentifierKind('1234')).toBe('name');
  });
});

describe('numberTokenMatches', () => {
  test('exact and masked numbers', () => {
    expect(numberTokenMatches('1000123451234', '1000123451234')).toBe(true);
    expect(numberTokenMatches('1000****1234', '1000123451234')).toBe(true);
    expect(numberTokenMatches('1000****9999', '1000123451234')).toBe(false);
  });

  test('requires enough visible digits', () => {
    expect(numberTokenMatches('1****4', '1000123451234')).toBe(false);
  });
});

describe('matchTransactionToPerson', () => {
  const people = [person(1, 'Abebe Kebede'), person(2, 'Selam Tesfaye'), person(3, 'Selam')];

  test("a person's own name matches at any bank", () => {
    const index = buildPeopleIndex(people, [], []);
    expect(matchTransactionToPerson(tx({ reference: 'a', receiver: 'ABEBE KEBEDE', bankId: 4 }), index)).toEqual({
      personId: 1,
      source: 'name',
    });
  });

  test('credits use the creditor, debits the receiver', () => {
    const index = buildPeopleIndex(people, [], []);
    const credit = tx({ reference: 'c', type: 'CREDIT', creditor: 'Selam Tesfaye', receiver: 'Abebe Kebede' });
    expect(matchTransactionToPerson(credit, index)?.personId).toBe(2);
    const debit = tx({ reference: 'd', type: 'DEBIT', creditor: 'Selam Tesfaye', receiver: 'Abebe Kebede' });
    expect(matchTransactionToPerson(debit, index)?.personId).toBe(1);
  });

  test('bank-scoped aliases only apply to their bank and beat bank-wide ones', () => {
    const accounts = [alias(1, 'ABEBE K.', 'name', 1), alias(2, 'Selam', 'name', 6)];
    const index = buildPeopleIndex(people, accounts, []);
    expect(matchTransactionToPerson(tx({ reference: 'a1', receiver: 'Abebe K', bankId: 1 }), index)?.personId).toBe(1);
    expect(matchTransactionToPerson(tx({ reference: 'a2', receiver: 'Abebe K', bankId: 2 }), index)).toBeNull();
    // "Selam" is person 3's own name everywhere, but person 2 on telebirr.
    expect(matchTransactionToPerson(tx({ reference: 's1', receiver: 'SELAM', bankId: 6 }), index)?.personId).toBe(2);
    expect(matchTransactionToPerson(tx({ reference: 's2', receiver: 'SELAM', bankId: 1 }), index)?.personId).toBe(3);
  });

  test('phone numbers match in any format, including masked telebirr numbers', () => {
    const index = buildPeopleIndex(people, [alias(2, '0911223344', 'phone')], []);
    const plain = tx({ reference: 'p1', receiver: 'Someone (0911223344)' });
    expect(matchTransactionToPerson(plain, index)).toEqual({ personId: 2, source: 'number' });
    const masked = tx({ reference: 'p2', type: 'CREDIT', creditor: 'S*** T*** (2519****3344)', bankId: 6 });
    expect(matchTransactionToPerson(masked, index)?.personId).toBe(2);
    const other = tx({ reference: 'p3', receiver: 'Someone (0911000000)' });
    expect(matchTransactionToPerson(other, index)).toBeNull();
  });

  test('masked account numbers match a saved account at the same bank', () => {
    const index = buildPeopleIndex(people, [alias(1, '1000123451234', 'account', 1)], []);
    expect(matchTransactionToPerson(tx({ reference: 'n1', receiver: 'A*** K. 1000****1234', bankId: 1 }), index)?.personId).toBe(1);
    expect(matchTransactionToPerson(tx({ reference: 'n2', receiver: 'A*** K. 1000****1234', bankId: 2 }), index)).toBeNull();
  });

  test('numbers win over names', () => {
    const index = buildPeopleIndex(people, [alias(2, '0911223344', 'phone')], []);
    const t = tx({ reference: 'x', receiver: 'Abebe Kebede 0911223344' });
    expect(matchTransactionToPerson(t, index)).toEqual({ personId: 2, source: 'number' });
  });

  test('manual links override matching, and a null link means nobody', () => {
    const links: PersonTransactionLink[] = [
      { transactionReference: 'm1', personId: 3, createdAt: NOW },
      { transactionReference: 'm2', personId: null, createdAt: NOW },
      { transactionReference: 'm3', personId: 99, createdAt: NOW },
    ];
    const index = buildPeopleIndex(people, [], links);
    expect(matchTransactionToPerson(tx({ reference: 'm1', receiver: 'Abebe Kebede' }), index)).toEqual({
      personId: 3,
      source: 'manual',
    });
    expect(matchTransactionToPerson(tx({ reference: 'm2', receiver: 'Abebe Kebede' }), index)).toBeNull();
    // Links to deleted people are ignored.
    expect(matchTransactionToPerson(tx({ reference: 'm3', receiver: 'Abebe Kebede' }), index)?.personId).toBe(1);
  });

  test('aliases of deleted people are ignored', () => {
    const index = buildPeopleIndex(people, [alias(42, 'Ghost', 'name')], []);
    expect(matchTransactionToPerson(tx({ reference: 'g', receiver: 'Ghost' }), index)).toBeNull();
  });
});

describe('personIdForLoanItem', () => {
  const people = [person(1, 'Abebe Kebede'), person(2, 'Selam')];

  test('matches the loan name against people and their name aliases', () => {
    const index = buildPeopleIndex(people, [alias(2, 'Selam T', 'name', 1)], []);
    expect(personIdForLoanItem(loanItem({ personName: 'abebe kebede', direction: 'lent', remaining: 10 }), index)).toBe(1);
    expect(personIdForLoanItem(loanItem({ personName: 'Selam T', direction: 'lent', remaining: 10 }), index)).toBe(2);
  });

  test("falls back to the loan transaction's person", () => {
    const index = buildPeopleIndex(people, [], []);
    const loanTx = tx({ reference: 'l1', receiver: 'SELAM' });
    expect(personIdForLoanItem(loanItem({ personName: 'my sister', direction: 'lent', remaining: 10, transaction: loanTx }), index)).toBe(2);
    expect(personIdForLoanItem(loanItem({ personName: 'my sister', direction: 'lent', remaining: 10 }), index)).toBeNull();
  });
});

describe('summarizePersonActivity', () => {
  test('totals money both ways and open loans', () => {
    const transactions = [
      tx({ reference: '1', type: 'CREDIT', amount: 500, time: '2025-01-05T10:00:00.000Z' }),
      tx({ reference: '2', type: 'DEBIT', amount: 200, time: '2025-01-02T10:00:00.000Z' }),
      tx({ reference: '3', type: 'DEBIT', amount: -100, time: '2025-02-01T10:00:00.000Z' }),
    ];
    const loans = [
      loanItem({ personName: 'A', direction: 'lent', remaining: 300 }),
      loanItem({ personName: 'A', direction: 'borrowed', remaining: 50 }),
      loanItem({ personName: 'A', direction: 'lent', remaining: 0, status: 'settled' }),
    ];
    const summary = summarizePersonActivity(transactions, loans);
    expect(summary.received).toBe(500);
    expect(summary.sent).toBe(300);
    expect(summary.net).toBe(200);
    expect(summary.count).toBe(3);
    expect(summary.firstDate?.toISOString()).toBe('2025-01-02T10:00:00.000Z');
    expect(summary.lastDate?.toISOString()).toBe('2025-02-01T10:00:00.000Z');
    expect(summary.owesMe).toBe(300);
    expect(summary.iOwe).toBe(50);
    expect(summary.activeLoans).toBe(2);
  });

  test('empty input', () => {
    const summary = summarizePersonActivity([], []);
    expect(summary).toMatchObject({ sent: 0, received: 0, net: 0, count: 0, owesMe: 0, iOwe: 0, firstDate: null });
  });
});

describe('suggestCounterparties', () => {
  const people = [person(1, 'Abebe Kebede')];
  const transactions = [
    tx({ reference: '1', receiver: 'Abebe Kebede', bankId: 1 }),
    tx({ reference: '2', receiver: 'ABEBE K', bankId: 1, amount: 50 }),
    tx({ reference: '3', receiver: 'Abebe K.', bankId: 1, amount: 70 }),
    tx({ reference: '4', receiver: 'Abebe K', bankId: 6 }),
    tx({ reference: '5', receiver: 'Coffee Shop', bankId: 1 }),
    tx({ reference: '6', receiver: 'Coffee Shop', bankId: 1 }),
    tx({ reference: '7', receiver: 'Coffee Shop', bankId: 1 }),
  ];

  test('lists unmapped counterparties per bank, similar names first', () => {
    const index = buildPeopleIndex(people, [], []);
    const suggestions = suggestCounterparties(transactions, index, 'Abebe Kebede');
    expect(suggestions.map((s) => [s.normalized, s.bankId, s.count])).toEqual([
      ['abebe k', 1, 2],
      ['abebe k', 6, 1],
      ['coffee shop', 1, 3],
    ]);
    expect(suggestions[0].total).toBe(120);
  });

  test('filters by query and drops mapped counterparties', () => {
    const index = buildPeopleIndex(people, [alias(1, 'Abebe K', 'name', 1)], []);
    expect(suggestCounterparties(transactions, index, 'Abebe Kebede', 'abebe').map((s) => s.bankId)).toEqual([6]);
  });
});
