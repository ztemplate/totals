import { describe, expect, test } from 'bun:test';
import { BUNDLED_BANKS } from '../src/data/banks';
import type { SmsPattern } from '../src/models/smsPattern';
import { findBankForSender, senderAddressMatchesBank } from '../src/utils/bankSenderMatcher';
import { cleanNumber, parsePatternMessage } from '../src/utils/patternParser';
import { isTelebirrAtmAuthorization, looksLikeTransaction } from '../src/utils/smsMessageClassifier';
import { displayReference, fnv1a64Hex, scopeReference } from '../src/utils/smsTransactionSource';

const cbe = BUNDLED_BANKS.find((bank) => bank.id === 1)!;

const debitPattern: SmsPattern = {
  bankId: 1,
  senderId: 'CBE',
  regex:
    'account\\s+(?<account>\\d+)\\s+has\\s+been\\s+debited\\s+ETB\\s*(?<amount>[\\d,]+(?:\\.\\d+)?)[\\s\\S]*?balance\\s+is\\s+ETB\\s*(?<balance>[\\d,]+(?:\\.\\d+)?)[\\s\\S]*?Ref\\s+(?<reference>\\w+)',
  type: 'DEBIT',
  description: 'test debit',
  refRequired: true,
  hasAccount: true,
};

const creditPattern: SmsPattern = {
  bankId: 1,
  senderId: 'CBE',
  regex: 'credited\\s+with\\s+ETB\\s*(?<amount>[\\d,]+(?:\\.\\d+)?)',
  type: 'CREDIT',
  description: 'test credit',
  refRequired: false,
  hasAccount: false,
};

describe('pattern parser', () => {
  test('parses a debit with masking, balance and inferred receipt link', () => {
    const parsed = parsePatternMessage({
      message:
        'Dear customer, your account 1000123456789 has been debited ETB 1,250.50. Your balance is ETB 10,000.75. Ref FT12345ABC',
      patterns: [creditPattern, debitPattern],
      bank: cbe,
      bankId: 1,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('DEBIT');
    expect(parsed!.amount).toBe(1250.5);
    expect(parsed!.currentBalance).toBe('10000.75');
    expect(parsed!.accountNumber).toBe('789');
    expect(parsed!.reference).toBe('FT12345ABC');
    expect(parsed!.transactionLink).toBe('https://apps.cbe.come.et:100/?id=FT12345ABC');
  });

  test('falls back to the sender phrase for credits and synthesizes a reference', () => {
    const messageDate = new Date('2026-10-01T08:00:00.000Z');
    const parsed = parsePatternMessage({
      message: 'Your account has been credited with ETB 500.00 from Abebe Kebede on 01/10/2026.',
      patterns: [creditPattern],
      bank: cbe,
      bankId: 1,
      messageDate,
    });
    expect(parsed!.type).toBe('CREDIT');
    expect(parsed!.amount).toBe(500);
    expect(parsed!.creditor).toBe('Abebe Kebede');
    expect(parsed!.reference).toBe(`1_${messageDate.toISOString()}`);
  });

  test('returns null when nothing matches', () => {
    expect(
      parsePatternMessage({ message: 'Your OTP is 1234', patterns: [debitPattern, creditPattern], bank: cbe, bankId: 1 }),
    ).toBeNull();
  });

  test('cleanNumber strips separators and trailing punctuation', () => {
    expect(cleanNumber('1,234.50.')).toBe('1234.50');
    expect(cleanNumber(' 99 ')).toBe('99');
    expect(cleanNumber('')).toBeNull();
    expect(cleanNumber(null)).toBeNull();
  });
});

describe('bank sender matching', () => {
  test('prefers exact and longest codes', () => {
    expect(findBankForSender('CBE', BUNDLED_BANKS)?.id).toBe(1);
    expect(findBankForSender('CBEBirr', BUNDLED_BANKS)?.id).toBe(37);
    expect(findBankForSender('127', BUNDLED_BANKS)?.id).toBe(6);
    expect(findBankForSender('Dashen Bank', BUNDLED_BANKS)?.id).toBe(4);
    expect(findBankForSender('+251911000000', BUNDLED_BANKS)).toBeNull();
  });

  test('does not attribute CBE Birr messages to CBE', () => {
    expect(senderAddressMatchesBank(cbe, 'CBEBirr', BUNDLED_BANKS)).toBe(false);
    expect(senderAddressMatchesBank(cbe, 'CBE', BUNDLED_BANKS)).toBe(true);
  });
});

describe('message classification', () => {
  test('looksLikeTransaction', () => {
    expect(looksLikeTransaction('Your account has been debited ETB 100')).toBe(true);
    expect(looksLikeTransaction('Your OTP code is 1234')).toBe(false);
  });

  test('telebirr ATM codes are not transactions', () => {
    expect(isTelebirrAtmAuthorization(6, 'Your ATM withdrawal secret code is 123456')).toBe(true);
    expect(isTelebirrAtmAuthorization(1, 'Your ATM withdrawal secret code is 123456')).toBe(false);
  });
});

describe('sms source identity', () => {
  test('FNV-1a 64 matches reference vectors', () => {
    expect(fnv1a64Hex('')).toBe('cbf29ce484222325');
    expect(fnv1a64Hex('a')).toBe('af63dc4c8601ec8c');
  });

  test('telebirr references are scoped per leg and displayed without the marker', () => {
    const scoped = scopeReference({ bankId: 6, reference: 'ABC123', type: 'DEBIT', source: { fingerprint: 'x' } });
    expect(scoped).toBe('ABC123__totals_tb_leg_debit');
    expect(displayReference(6, scoped)).toBe('ABC123');
    expect(scopeReference({ bankId: 1, reference: 'FT1', type: 'DEBIT', source: { fingerprint: 'x' } })).toBe('FT1');
  });
});
