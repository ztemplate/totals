import { describe, expect, test } from 'bun:test';
import { normalizedCodes, senderMatchesCodes } from '../modules/sms-reader/senderFilter';
import { BUNDLED_BANKS } from '../src/data/banks';
import type { Account } from '../src/models/account';
import { makeTransaction, OwnerAssignment, type Transaction } from '../src/models/transaction';
import { transactionBelongsToAccount } from '../src/utils/accountIdentity';
import { findBankForSender } from '../src/utils/bankSenderMatcher';
import { CASH_BANK_ID } from '../src/utils/cashConstants';
import { hasExactAmountAndBalanceDuplicate } from '../src/utils/duplicateDetector';
import { applyOwnershipPatch, TransactionIndex } from '../src/utils/smsScanIndex';
import { SMS_SOURCE_TYPE } from '../src/utils/smsTransactionSource';

const cbe = BUNDLED_BANKS.find((b) => b.id === 1)!;

function tx(input: Partial<Transaction> & { reference: string }): Transaction {
  return makeTransaction({ amount: 100, type: 'CREDIT', bankId: 1, time: '2026-03-01T10:00:00.000Z', ...input });
}

function account(accountNumber: string, holder: string, extra: Partial<Account> = {}): Account {
  return { accountNumber, bank: 1, balance: 0, accountHolderName: holder, includeInTotals: true, isDormant: false, isDefault: false, ...extra };
}

/** The scan used to do this per message over the whole table (ORDER BY time DESC, id DESC). */
function naiveSourceDuplicate(details: Record<string, unknown>, existing: Transaction[]): Transaction | null {
  const sourceType = typeof details.sourceType === 'string' ? details.sourceType.trim() : null;
  if (sourceType !== SMS_SOURCE_TYPE) return null;
  const messageId = details.sourceMessageId != null ? String(details.sourceMessageId).trim() : '';
  const fingerprint = details.sourceFingerprint != null ? String(details.sourceFingerprint).trim() : '';
  if (!messageId && !fingerprint) return null;
  for (const t of existing) {
    if (t.sourceType !== SMS_SOURCE_TYPE) continue;
    if (fingerprint && t.sourceFingerprint === fingerprint) return t;
    if (!messageId || t.sourceMessageId !== messageId) continue;
    const existingFingerprint = t.sourceFingerprint?.trim();
    if (!fingerprint || !existingFingerprint || existingFingerprint === fingerprint) return t;
  }
  return null;
}

/** Deterministic pseudo-random generator so failures are reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomRows(count: number, seed: number, idOffset = 0): { rows: Transaction[]; ids: Map<Transaction, number> } {
  const random = rng(seed);
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
  const rows: Transaction[] = [];
  const ids = new Map<Transaction, number>();
  for (let i = 0; i < count; i++) {
    const row = tx({
      reference: `ref-${idOffset + i}`,
      bankId: pick([1, 1, 2, 4, CASH_BANK_ID]),
      type: pick(['CREDIT', 'DEBIT']),
      amount: pick([50, 100, 250]),
      currentBalance: pick([null, '1000.00', '2000.00']),
      accountNumber: pick([null, '234', '678']),
      time: pick([null, '2026-03-01T10:00:00.000Z', '2026-03-02T10:00:00.000Z', '2026-03-03T08:00:00.000Z']),
      sourceType: pick([SMS_SOURCE_TYPE, SMS_SOURCE_TYPE, null]),
      sourceFingerprint: pick([null, 'fp-a', 'fp-b', 'fp-c', ' fp-a']),
      sourceMessageId: pick([null, '11', '12', '13']),
    });
    rows.push(row);
    ids.set(row, idOffset + i + 1);
  }
  return { rows, ids };
}

function tableOrder(rows: Transaction[], ids: Map<Transaction, number>): Transaction[] {
  return [...rows].sort((a, b) => {
    const at = a.time ?? null;
    const bt = b.time ?? null;
    if (at !== bt) {
      if (at === null) return 1;
      if (bt === null) return -1;
      return at > bt ? -1 : 1;
    }
    return ids.get(b)! - ids.get(a)!;
  });
}

const queries: Record<string, unknown>[] = [];
for (const fp of [null, 'fp-a', 'fp-b', 'fp-x', ' fp-c ']) {
  for (const id of [null, '11', '12', '99', ' 13']) {
    queries.push({ sourceType: SMS_SOURCE_TYPE, sourceFingerprint: fp, sourceMessageId: id });
  }
}
queries.push({ sourceType: 'manual', sourceFingerprint: 'fp-a', sourceMessageId: '11' });

describe('TransactionIndex SMS source duplicates', () => {
  test('matches the full-table scan, including which row is returned', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { rows, ids } = randomRows(80, seed);
      const loaded = tableOrder(rows, ids);
      const index = new TransactionIndex(loaded);
      for (const query of queries) {
        expect(index.findSmsSourceDuplicate(query)).toBe(naiveSourceDuplicate(query, loaded));
      }
    }
  });

  test('rows added during a scan are found, ordered as if re-read from the table', () => {
    const { rows, ids } = randomRows(40, 7);
    const loaded = tableOrder(rows, ids);
    const index = new TransactionIndex(loaded);
    const added = randomRows(30, 8, 1000);
    for (const row of added.rows) {
      index.add(row);
      ids.set(row, added.ids.get(row)!);
    }
    const all = tableOrder([...rows, ...added.rows], ids);
    for (const query of queries) {
      expect(index.findSmsSourceDuplicate(query)).toBe(naiveSourceDuplicate(query, all));
    }
  });
});

describe('TransactionIndex references, balances and Dashen duplicates', () => {
  test('reference lookups see loaded and added rows', () => {
    const index = new TransactionIndex([tx({ reference: 'A' })]);
    expect(index.hasReference('A')).toBe(true);
    expect(index.hasReference('B')).toBe(false);
    const b = tx({ reference: 'B' });
    index.add(b);
    expect(index.getByReference('B')).toBe(b);
  });

  test('Dashen exact duplicate check equals the whole-table check', () => {
    const { rows } = randomRows(120, 11);
    const index = new TransactionIndex(rows);
    for (const candidate of randomRows(60, 12, 5000).rows) {
      expect(index.hasExactAmountAndBalanceDuplicate(candidate)).toBe(hasExactAmountAndBalanceDuplicate(candidate, rows));
    }
  });

  test('newer balance check equals the whole-table check', () => {
    const first = account('1000111111234', 'Abebe Kebede', { isDefault: true });
    const second = account('1000222225678', 'Abebe Kebede');
    const accounts = [first, second];
    const { rows } = randomRows(120, 21);
    const owned = rows.map((row, i) =>
      i % 3 === 0 ? makeTransaction({ ...row, ownerAccountNumber: i % 2 ? first.accountNumber : second.accountNumber }) : row,
    );
    const index = new TransactionIndex(owned);
    for (const at of ['2026-02-28T00:00:00.000Z', '2026-03-01T12:00:00.000Z', '2026-03-02T10:00:00.000Z', '2026-03-04T00:00:00.000Z']) {
      for (const acct of accounts) {
        const ms = Date.parse(at);
        const naive = owned.some((t) => {
          if (t.bankId !== acct.bank || !t.currentBalance?.trim() || !t.time) return false;
          return new Date(t.time).getTime() > ms && transactionBelongsToAccount(t, acct, cbe, accounts);
        });
        expect(index.hasNewerBalance({ account: acct, at: ms, bank: cbe, bankAccounts: accounts })).toBe(naive);
      }
    }
  });

  test('cash wallet delta follows added cash rows', () => {
    const index = new TransactionIndex([
      tx({ reference: 'c1', bankId: CASH_BANK_ID, type: 'CREDIT', amount: 500 }),
      tx({ reference: 'c2', bankId: CASH_BANK_ID, type: 'DEBIT', amount: 120 }),
      tx({ reference: 'b1', bankId: 1, type: 'CREDIT', amount: 999 }),
    ]);
    expect(index.cashWalletDelta()).toBe(380);
    index.add(tx({ reference: 'c3', bankId: CASH_BANK_ID, type: 'CREDIT', amount: 20 }));
    expect(index.cashWalletDelta()).toBe(400);
  });
});

describe('ownership updates in memory', () => {
  test('manual owners are kept, like the repository update', () => {
    const row = tx({ reference: 'm', ownerAccountNumber: '1', ownerAssignmentSource: OwnerAssignment.manual });
    expect(applyOwnershipPatch(row, { ownerAccountNumber: '2', ownerAssignmentSource: OwnerAssignment.automatic })).toBe(false);
    expect(row.ownerAccountNumber).toBe('1');
  });

  test('clearing an owner clears the SIM shortcut; unchanged patches report no change', () => {
    const row = tx({ reference: 'x', ownerAccountNumber: '1', ownerAssignmentSource: OwnerAssignment.automatic, sourceSubscriptionId: 3 });
    expect(applyOwnershipPatch(row, { ownerAccountNumber: null, ownerAssignmentSource: OwnerAssignment.conflict })).toBe(true);
    expect(row.sourceSubscriptionId).toBeNull();
    expect(applyOwnershipPatch(row, { ownerAccountNumber: null, ownerAssignmentSource: OwnerAssignment.conflict })).toBe(false);
  });

  test('a message id learned from an ownership update is indexed', () => {
    const row = tx({ reference: 'r', sourceType: SMS_SOURCE_TYPE, sourceFingerprint: 'fp-z', sourceMessageId: null });
    const index = new TransactionIndex([row]);
    const query = { sourceType: SMS_SOURCE_TYPE, sourceMessageId: '77', sourceFingerprint: null };
    expect(index.findSmsSourceDuplicate(query)).toBeNull();
    index.updateOwnership('r', { ownerAccountNumber: '1', ownerAssignmentSource: OwnerAssignment.automatic, sourceMessageId: ' 77 ' });
    expect(index.findSmsSourceDuplicate(query)).toBe(row);
  });
});

describe('native inbox sender prefilter', () => {
  test('keeps exactly the senders findBankForSender recognizes', () => {
    const codes = normalizedCodes(BUNDLED_BANKS.flatMap((b) => b.codes))!;
    const addresses = [
      'CBE',
      'cbe',
      'C.B.E',
      '+251CBE',
      'Dashen Bank',
      'DASHENBANK',
      'telebirr',
      '127',
      '8xxx',
      'AwashBank',
      'Zemen-Bank',
      'MyFriend',
      '+251911234567',
      '',
      '---',
      'BOA',
      'Abyssinia',
      ...BUNDLED_BANKS.flatMap((b) => b.codes.map((c) => `x${c}x`)),
    ];
    for (const address of addresses) {
      expect(senderMatchesCodes(address, codes)).toBe(findBankForSender(address, BUNDLED_BANKS) !== null);
    }
  });
});
