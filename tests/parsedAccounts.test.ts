import { describe, expect, test } from 'bun:test';
import { BUNDLED_BANKS } from '../src/data/banks';
import type { Account } from '../src/models/account';
import type { Person, PersonAccount } from '../src/models/person';
import { makeTransaction, type Transaction } from '../src/models/transaction';
import {
  buildParsedAccounts,
  counterpartyNumbers,
  filterParsedAccounts,
  groupParsedAccountsByPerson,
  parsedAccountNumberLabel,
  personAliasesForNumber,
} from '../src/utils/parsedAccounts';
import { buildPeopleIndex, normalizePersonIdentifier } from '../src/utils/personMatching';

const CBE = 1;
const AWASH = 2;
const TELEBIRR = 6;
const MPESA = 8;

function tx(input: Partial<Transaction> & { reference: string }): Transaction {
  return makeTransaction({ amount: 100, type: 'DEBIT', bankId: CBE, time: '2026-03-01T10:00:00.000Z', ...input });
}

function account(accountNumber: string, bank = CBE, extra: Partial<Account> = {}): Account {
  return {
    id: 1,
    accountNumber,
    bank,
    balance: 42,
    accountHolderName: 'Me',
    includeInTotals: true,
    isDormant: false,
    isDefault: false,
    ...extra,
  };
}

function person(id: number, name: string): Person {
  return { id, name, type: 'friend', createdAt: '2026-01-01T00:00:00.000Z' };
}

let aliasId = 0;
function alias(personId: number, identifier: string, kind: PersonAccount['kind'], bankId: number | null): PersonAccount {
  return {
    id: ++aliasId,
    personId,
    bankId,
    identifier,
    normalizedIdentifier: normalizePersonIdentifier(identifier, kind),
    kind,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const transactions: Transaction[] = [
  // My registered CBE account.
  tx({ reference: 'm1', accountNumber: '1****5678', currentBalance: '900.00', time: '2026-03-03T10:00:00.000Z' }),
  tx({ reference: 'm2', accountNumber: '1****5678', type: 'CREDIT', amount: 300, receiver: 'Abebe Kebede 1000****4321' }),
  // Another CBE account in the same inbox: masked and full spellings merge into one unlabeled account.
  tx({ reference: 'u1', accountNumber: '1****9999', currentBalance: '50.00', time: '2026-03-05T10:00:00.000Z' }),
  tx({ reference: 'u2', accountNumber: '1000111119999', time: '2026-02-01T10:00:00.000Z' }),
  // Awash, nothing registered there.
  tx({ reference: 'a1', bankId: AWASH, accountNumber: '01320xxxx0001', time: '2026-01-10T10:00:00.000Z' }),
  // telebirr wallet on SIM 1, paying two numbers.
  tx({ reference: 't1', bankId: TELEBIRR, accountNumber: '0911000001', receiver: 'Sara', sourceSubscriptionId: 1 }),
  tx({ reference: 't2', bankId: TELEBIRR, accountNumber: '251911000001', receiver: 'Sara', sourceSubscriptionId: 1 }),
  tx({ reference: 't3', bankId: TELEBIRR, accountNumber: '0922000002', creditor: 'Kebede', type: 'CREDIT', sourceSubscriptionId: 1 }),
  // M-Pesa wallet registered.
  tx({ reference: 'p1', bankId: MPESA, ownerAccountNumber: '0700000000', accountNumber: '0733000003', receiver: 'Shop' }),
  // Cash never shows.
  tx({ reference: 'cash', bankId: 100 }),
];

const accounts = [account('1000222225678'), account('0700000000', MPESA, { accountHolderName: 'Me M-Pesa' }), account('CASH', 100)];

describe('parsed accounts', () => {
  const people = [person(1, 'Abebe'), person(2, 'Sara'), person(3, 'Hanna')];
  const personAccounts = [
    alias(1, '1000****4321', 'account', CBE),
    alias(2, '0911000001', 'phone', null),
    // Hanna owns the second CBE account (saved with its full number) and the Awash one (any bank).
    alias(3, '1000111119999', 'account', CBE),
    alias(3, '01320xxxx0001', 'account', null),
  ];
  const items = buildParsedAccounts({ transactions, accounts, banks: BUNDLED_BANKS, people, personAccounts });
  const byKey = (part: string) => items.find((i) => i.key.includes(part));

  test('lists registered, unlabeled and counterparty accounts', () => {
    const mine = items.filter((i) => i.kind === 'mine');
    expect(mine.map((i) => i.accountNumber).sort()).toEqual(['0700000000', '1000222225678']);
    const cbe = mine.find((i) => i.bankId === CBE)!;
    expect(cbe.references.sort()).toEqual(['m1', 'm2']);
    expect(cbe.lastBalance).toBe(900);
    expect(cbe.holderName).toBe('Me');

    const unlabeled = items.filter((i) => i.kind === 'unlabeled');
    expect(unlabeled.map((i) => i.bankId).sort()).toEqual([CBE, AWASH, TELEBIRR].sort());
    // Masked and full spellings are one account, shown with the full number.
    const second = unlabeled.find((i) => i.bankId === CBE)!;
    expect(second.references.sort()).toEqual(['u1', 'u2']);
    expect(second.accountNumber).toBe('1000111119999');
    expect(second.lastBalance).toBe(50);
    expect(second.firstDate?.toISOString()).toBe('2026-02-01T10:00:00.000Z');
    expect(second.lastDate?.toISOString()).toBe('2026-03-05T10:00:00.000Z');
    // telebirr prints the counterparty, so the wallet is the SIM.
    const wallet = unlabeled.find((i) => i.bankId === TELEBIRR)!;
    expect(wallet.accountNumber).toBeNull();
    expect(wallet.count).toBe(3);
    expect(parsedAccountNumberLabel(wallet)).toBe('SIM 1');

    expect(items.some((i) => i.bankId === 100)).toBe(false);
  });

  test('collects counterparty numbers per bank and merges phone spellings', () => {
    const counterparties = items.filter((i) => i.kind === 'counterparty');
    const sara = counterparties.find((i) => i.bankId === TELEBIRR && i.references.includes('t1'))!;
    expect(sara.references.sort()).toEqual(['t1', 't2']);
    expect(sara.holderName).toBe('Sara');
    expect(counterparties.find((i) => i.references.includes('t3'))?.holderName).toBe('Kebede');
    const abebe = counterparties.find((i) => i.bankId === CBE)!;
    expect(abebe.accountNumber).toBe('1000****4321');
    expect(abebe.holderName).toBe('Abebe Kebede');
    // The registered M-Pesa number is mine, the other side is a counterparty.
    expect(counterparties.filter((i) => i.bankId === MPESA).map((i) => i.accountNumber)).toEqual(['0733000003']);
  });

  test('assigns people from their saved numbers, so one person can own several accounts', () => {
    expect(byKey(`${CBE}|cp:`)?.personId).toBe(1);
    expect(items.find((i) => i.kind === 'counterparty' && i.references.includes('t1'))?.personId).toBe(2);
    const hanna = items.filter((i) => i.personId === 3);
    expect(hanna.map((i) => i.bankId).sort()).toEqual([CBE, AWASH].sort());
    expect(hanna.every((i) => i.personSource === 'number' && i.personAliasIds.length === 1)).toBe(true);
    // A phone alias without a bank never owns a bank account.
    expect(items.filter((i) => i.kind === 'mine').every((i) => i.personId === null)).toBe(true);
  });

  test('bank-specific numbers beat any-bank ones', () => {
    const cbe = BUNDLED_BANKS.find((b) => b.id === CBE)!;
    const result = personAliasesForNumber(cbe, '1000333334444', [
      alias(7, '1000333334444', 'account', null),
      alias(8, '1000****4444', 'account', CBE),
    ]);
    expect(result.personId).toBe(8);
    expect(result.aliasIds).toHaveLength(2);
    expect(personAliasesForNumber(cbe, null, [alias(7, '1', 'account', null)]).personId).toBeNull();
  });

  test('filters by banks, providers, bank, person and search', () => {
    const banks = BUNDLED_BANKS;
    const providers = filterParsedAccounts(items, { scope: 'providers' });
    expect(new Set(providers.map((i) => i.bankId))).toEqual(new Set([TELEBIRR, MPESA]));
    const onlyBanks = filterParsedAccounts(items, { scope: 'banks' });
    expect(onlyBanks.every((i) => i.bankId === CBE || i.bankId === AWASH)).toBe(true);
    expect(filterParsedAccounts(items, { bankId: AWASH }).map((i) => i.key)).toHaveLength(1);
    expect(filterParsedAccounts(items, { person: 3 }).every((i) => i.personId === 3)).toBe(true);
    const unassigned = filterParsedAccounts(items, { person: 'unassigned', kinds: ['mine', 'unlabeled'] });
    expect(unassigned.map((i) => i.kind).sort()).toEqual(['mine', 'mine', 'unlabeled']);
    expect(filterParsedAccounts(items, { query: 'hanna' }, { banks, people })).toHaveLength(2);
    expect(filterParsedAccounts(items, { query: 'awash' }, { banks, people })).toHaveLength(1);
    expect(filterParsedAccounts(items, { query: '9999' }, { banks, people }).map((i) => i.bankId)).toEqual([CBE]);
  });

  test('groups accounts under their person, unassigned last', () => {
    const groups = groupParsedAccountsByPerson(items, people);
    expect(groups[groups.length - 1].person).toBeNull();
    const hanna = groups.find((g) => g.person?.id === 3)!;
    expect(hanna.accounts).toHaveLength(2);
  });

  test('guesses a counterparty person from matched transactions when no number is saved', () => {
    const index = buildPeopleIndex([person(5, 'Kebede')], [], []);
    const result = buildParsedAccounts({ transactions, accounts, banks: BUNDLED_BANKS, peopleIndex: index });
    const kebede = result.find((i) => i.kind === 'counterparty' && i.references.includes('t3'))!;
    expect(kebede.personId).toBe(5);
    expect(kebede.personSource).toBe('transactions');
  });

  test('extracts counterparty numbers but not dates or short codes', () => {
    expect(counterpartyNumbers('Abebe 1000****4321 on 2026-03-01')).toEqual(['1000****4321']);
    expect(counterpartyNumbers('Ref 12345 to +251911223344')).toEqual(['+251911223344']);
    expect(counterpartyNumbers(null)).toEqual([]);
  });

  test('handles thousands of transactions quickly', () => {
    const many: Transaction[] = [];
    for (let i = 0; i < 5000; i++) {
      many.push(
        tx({
          reference: `x${i}`,
          accountNumber: i % 2 ? '1****5678' : '1****9999',
          receiver: `Person ${i % 50} 1000****${String(1000 + (i % 50))}`,
          time: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
        }),
      );
    }
    const started = performance.now();
    const result = buildParsedAccounts({ transactions: many, accounts, banks: BUNDLED_BANKS });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(result.filter((i) => i.kind === 'counterparty')).toHaveLength(50);
    expect(result.find((i) => i.kind === 'unlabeled')?.count).toBe(2500);
  });
});
