import { describe, expect, test } from 'bun:test';
import { BUNDLED_BANKS } from '../src/data/banks';
import type { Account } from '../src/models/account';
import { makeTransaction, OwnerAssignment, type Transaction } from '../src/models/transaction';
import { checkSmsOwnership, resolveSmsOwnership, transactionBelongsToAccount } from '../src/utils/accountIdentity';
import { latestMessageBalance, ownershipChanges } from '../src/utils/accountReconcile';
import { detectUnlabeledAccounts } from '../src/utils/unlabeledAccounts';

const cbe = BUNDLED_BANKS.find((b) => b.id === 1)!;

function account(accountNumber: string, holder: string, extra: Partial<Account> = {}): Account {
  return { accountNumber, bank: 1, balance: 0, accountHolderName: holder, includeInTotals: true, isDormant: false, isDefault: false, ...extra };
}

function tx(input: Partial<Transaction> & { reference: string }): Transaction {
  return makeTransaction({ amount: 100, type: 'CREDIT', bankId: 1, time: '2026-03-01T10:00:00.000Z', ...input });
}

const first = account('1000111111234', 'Abebe Kebede', { isDefault: true });
const second = account('1000222225678', 'Abebe Kebede');
const accounts = [first, second];

const body = (acct: string, balance: string, name = 'Abebe') =>
  `Dear ${name} your Account ${acct} has been credited with ETB 100.00. Your Current Balance is ETB ${balance}. Thank you for Banking with CBE!`;

describe('two accounts at the same bank', () => {
  test('the printed account number wins over the greeting', () => {
    expect(resolveSmsOwnership({ body: body('1*********678', '900.00'), bank: cbe, accounts, parsedAccountNumber: '678' })?.account).toBe(second);
    expect(resolveSmsOwnership({ body: body('1*********234', '50.00'), bank: cbe, accounts, parsedAccountNumber: '234' })?.account).toBe(first);
  });

  test('a greeting only matching the first account does not take the second account’s messages', () => {
    const named = [first, account('1000222225678', '')];
    const owner = resolveSmsOwnership({ body: body('1*********678', '900.00'), bank: cbe, accounts: named, parsedAccountNumber: '678' });
    expect(owner?.account.accountNumber).toBe('1000222225678');
  });

  test('an unregistered number is not given to either account', () => {
    expect(resolveSmsOwnership({ body: body('1*********999', '1.00'), bank: cbe, accounts, parsedAccountNumber: '999' })).toBeNull();
  });

  test('without a number the default account is used', () => {
    const owner = resolveSmsOwnership({ body: 'Dear Customer, ETB 5 debited. Balance is ETB 1.', bank: cbe, accounts });
    expect(owner?.account).toBe(first);
  });

  test('messages already given to the wrong account move back; manual choices stay', () => {
    const wrong = tx({ reference: 'FT1', accountNumber: '678', ownerAccountNumber: first.accountNumber, ownerAssignmentSource: OwnerAssignment.automatic });
    const manual = tx({ reference: 'FT2', accountNumber: '678', ownerAccountNumber: first.accountNumber, ownerAssignmentSource: OwnerAssignment.manual });
    const right = tx({ reference: 'FT3', accountNumber: '234', ownerAccountNumber: first.accountNumber });
    const bodies = new Map([['FT1', body('1*********678', '900.00')]]);
    expect(ownershipChanges({ bank: cbe, accounts, transactions: [wrong, manual, right], bodies })).toEqual([
      { reference: 'FT1', ownerAccountNumber: second.accountNumber },
    ]);
  });

  test('balance comes from each account’s newest message', () => {
    const transactions = [
      tx({ reference: 'a', accountNumber: '678', currentBalance: '900.00', time: '2026-03-05T10:00:00.000Z', ownerAccountNumber: second.accountNumber }),
      tx({ reference: 'b', accountNumber: '678', currentBalance: '1,200.50', time: '2026-03-06T10:00:00.000Z', ownerAccountNumber: second.accountNumber }),
      tx({ reference: 'c', accountNumber: '234', currentBalance: '50.00', time: '2026-03-07T10:00:00.000Z', ownerAccountNumber: first.accountNumber }),
    ];
    const parse = (raw: string) => Number(raw.replace(/,/g, ''));
    expect(latestMessageBalance(second, cbe, accounts, transactions, parse)?.balance).toBe(1200.5);
    expect(latestMessageBalance(first, cbe, accounts, transactions, parse)?.balance).toBe(50);
    expect(transactions.filter((t) => transactionBelongsToAccount(t, second, cbe, accounts)).map((t) => t.reference)).toEqual(['a', 'b']);
  });
});

describe('name and account number are both checked', () => {
  const mine = account('1000111111234', 'Abebe Kebede', { isDefault: true, smsSubscriptionId: 1 });
  const hers = account('1000333339876', 'Sara Tesfaye');
  const both = [mine, hers];

  test('a message naming the holder of the account it prints is assigned', () => {
    const check = checkSmsOwnership({ body: body('1*********234', '5.00'), bank: cbe, accounts: both, parsedAccountNumber: '234' });
    expect(check.owner?.account).toBe(mine);
    expect(check.conflict).toBe(false);
  });

  test('matching digits addressed to another name are not assigned, even with the SIM and default', () => {
    const check = checkSmsOwnership({
      body: body('1*********234', '5.00', 'Sara'),
      bank: cbe,
      accounts: both,
      parsedAccountNumber: '234',
      subscriptionId: 1,
    });
    expect(check.owner).toBeNull();
    expect(check.conflict).toBe(true);
  });

  test('a surname alone still counts as the same person', () => {
    const owner = resolveSmsOwnership({ body: body('1*********234', '5.00', 'Kebede'), bank: cbe, accounts: both, parsedAccountNumber: '234' });
    expect(owner?.account).toBe(mine);
  });

  test('without a number the name decides', () => {
    const owner = resolveSmsOwnership({ body: 'Dear Sara, ETB 5 debited. Balance is ETB 1.', bank: cbe, accounts: both });
    expect(owner?.account).toBe(hers);
  });

  test('without a name the number decides', () => {
    const owner = resolveSmsOwnership({ body: 'Dear Customer, your Account 1*********876 has been debited.', bank: cbe, accounts: both, parsedAccountNumber: '876' });
    expect(owner?.account).toBe(hers);
  });

  test('with neither, the SIM and then the default account decide', () => {
    const plain = 'Dear Customer, ETB 5 debited. Balance is ETB 1.';
    expect(resolveSmsOwnership({ body: plain, bank: cbe, accounts: [mine, { ...hers, smsSubscriptionId: 2 }], subscriptionId: 2 })?.account.accountNumber).toBe(hers.accountNumber);
    expect(resolveSmsOwnership({ body: plain, bank: cbe, accounts: both })?.account).toBe(mine);
  });

  test('an account without a holder name is matched on its number', () => {
    const unnamed = account('1000111111234', '');
    expect(resolveSmsOwnership({ body: body('1*********234', '5.00', 'Sara'), bank: cbe, accounts: [unnamed], parsedAccountNumber: '234' })?.account).toBe(unnamed);
  });

  test('two accounts with the same digits are told apart by the name', () => {
    const lookalike = account('2000999991234', 'Sara Tesfaye');
    const owner = resolveSmsOwnership({ body: body('1*********234', '5.00', 'Sara'), bank: cbe, accounts: [mine, lookalike], parsedAccountNumber: '234' });
    expect(owner?.account).toBe(lookalike);
  });

  test('recheck takes conflicting messages off your account and lists them as unlabeled', () => {
    const misassigned = tx({ reference: 'FT9', accountNumber: '234', ownerAccountNumber: mine.accountNumber, ownerAssignmentSource: OwnerAssignment.automatic });
    const bodies = new Map([['FT9', body('1*********234', '5.00', 'Sara')]]);
    const changes = ownershipChanges({ bank: cbe, accounts: [mine], transactions: [misassigned], bodies });
    expect(changes).toEqual([{ reference: 'FT9', ownerAccountNumber: null, conflict: true }]);

    const flagged = tx({ reference: 'FT9', accountNumber: '234', ownerAccountNumber: null, ownerAssignmentSource: OwnerAssignment.conflict });
    expect(transactionBelongsToAccount(flagged, mine, cbe, [mine])).toBe(false);
    expect(detectUnlabeledAccounts([flagged], [mine], [cbe]).map((g) => g.references)).toEqual([['FT9']]);
    // Already flagged: nothing to change.
    expect(ownershipChanges({ bank: cbe, accounts: [mine], transactions: [flagged], bodies })).toEqual([]);
  });

  test('a conflict is lifted once the holder name fits', () => {
    const flagged = tx({ reference: 'FT9', accountNumber: '234', ownerAccountNumber: null, ownerAssignmentSource: OwnerAssignment.conflict });
    const bodies = new Map([['FT9', body('1*********234', '5.00', 'Sara')]]);
    const renamed = { ...mine, accountHolderName: 'Sara Tesfaye' };
    expect(ownershipChanges({ bank: cbe, accounts: [renamed], transactions: [flagged], bodies })).toEqual([
      { reference: 'FT9', ownerAccountNumber: renamed.accountNumber },
    ]);
  });
});
