import type { Account } from '../models/account';
import type { Bank } from '../models/bank';
import type { Transaction } from '../models/transaction';

export function isSimBank(bank: Bank | null | undefined): boolean {
  return bank?.simBased === true;
}

export function canonicalAccountNumber(bank: Bank | null | undefined, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (isSimBank(bank)) {
    const digits = raw.replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('00251') && digits.length === 14) return `0${digits.substring(5)}`;
    if (digits.startsWith('251') && digits.length === 12) return `0${digits.substring(3)}`;
    if (digits.length === 9 && (digits.startsWith('9') || digits.startsWith('7'))) return `0${digits}`;
    return digits;
  }
  const value = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return value.length === 0 ? null : value;
}

export function canonicalAccountHolderName(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function maskedPattern(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[*X•#]/g, '?')
    .replace(/[^A-Z0-9?]/g, '');
}

/** Returns the number of agreeing characters, or -1 on a mismatch / not a masked comparison. */
function maskedEvidence(a: string, b: string): number {
  const left = maskedPattern(a);
  const right = maskedPattern(b);
  if (!left.includes('?') && !right.includes('?')) return -1;
  if (!left || !right) return -1;

  const compareAt = (x: string, y: string): number => {
    let evidence = 0;
    for (let i = 0; i < x.length; i++) {
      const cx = x[i];
      const cy = y[i];
      if (cx === '?' || cy === '?') continue;
      if (cx !== cy) return -1;
      evidence++;
    }
    return evidence;
  };

  if (left.length === right.length) return compareAt(left, right);

  // Different lengths: compare the visible prefix and suffix edges.
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  const firstMask = shorter.indexOf('?');
  const lastMask = shorter.lastIndexOf('?');
  const prefix = firstMask < 0 ? shorter : shorter.substring(0, firstMask);
  const suffix = lastMask < 0 ? '' : shorter.substring(lastMask + 1);
  if (prefix.length + suffix.length > longer.length) return -1;
  const prefixEvidence = compareAt(prefix, longer.substring(0, prefix.length));
  if (prefixEvidence < 0) return -1;
  const suffixEvidence = compareAt(suffix, longer.substring(longer.length - suffix.length));
  if (suffixEvidence < 0) return -1;
  return prefixEvidence + suffixEvidence;
}

export function accountNumbersMatch(
  bank: Bank | null | undefined,
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (isSimBank(bank)) {
    const ca = canonicalAccountNumber(bank, a);
    const cb = canonicalAccountNumber(bank, b);
    return ca !== null && ca === cb;
  }
  const maskLength = bank?.uniformMasking ? bank.maskPattern ?? null : null;
  const minimumEvidence = maskLength !== null && maskLength > 0 ? maskLength : 3;
  const evidence = maskedEvidence(a, b);
  if (evidence >= minimumEvidence) return true;

  const ca = canonicalAccountNumber(bank, a);
  const cb = canonicalAccountNumber(bank, b);
  if (ca === null || cb === null) return false;
  if (maskLength !== null && maskLength > 0) {
    if (ca.length < maskLength || cb.length < maskLength) return false;
    return ca.substring(ca.length - maskLength) === cb.substring(cb.length - maskLength);
  }
  return ca === cb;
}

export function registeredAccountNumbersMatch(
  bank: Bank | null | undefined,
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ca = canonicalAccountNumber(bank, a);
  const cb = canonicalAccountNumber(bank, b);
  return ca !== null && ca === cb;
}

function unique<T>(items: T[]): T | null {
  return items.length === 1 ? items[0] : null;
}

export function resolveAccountOwnership(params: {
  bank: Bank | null | undefined;
  accounts: Account[];
  holderName?: string | null;
  subscriptionId?: number | null;
  parsedNumber?: string | null;
}): Account | null {
  const { bank, accounts } = params;
  const bankAccounts = accounts.filter((a) => bank && a.bank === bank.id);
  if (bankAccounts.length === 0) return null;

  const holder = canonicalAccountHolderName(params.holderName);
  if (holder) {
    const byName = unique(bankAccounts.filter((a) => canonicalAccountHolderName(a.accountHolderName) === holder));
    if (byName) return byName;
  }

  const sub = params.subscriptionId;
  if (sub !== null && sub !== undefined && sub >= 0) {
    const bySub = unique(bankAccounts.filter((a) => a.smsSubscriptionId === sub));
    if (bySub) return bySub;
  }

  if (params.parsedNumber) {
    const byNumber = unique(bankAccounts.filter((a) => accountNumbersMatch(bank, a.accountNumber, params.parsedNumber)));
    if (byNumber) return byNumber;
  }
  return null;
}

const GREETING_RE = /^\s*(?:dear|hi|hello)\s+([^,;:\r\n]{1,100})/i;
const GENERIC_GREETING_RE = /^(?:(?:valued|dear)\s+)?(?:customer|user|client|member|sir|madam)\b/i;
const YOUR_ACCOUNT_RE =
  /\byour\s+(?:(?:e-?money|bank|telebirr)\s+)?account(?:\s+(?:number|no\.?))?\s*(?:is|:)?\s*['"‘’]?([+0-9][+0-9Xx*\\/\-\s]{2,39})/gim;

export function greetingName(body: string): string | null {
  const match = body.match(GREETING_RE);
  if (!match) return null;
  const name = canonicalAccountHolderName(match[1].replace(/[\s.!]+$/, ''));
  return name || null;
}

export function isGenericGreeting(name: string | null | undefined): boolean {
  if (!name) return true;
  return GENERIC_GREETING_RE.test(name.trim());
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Matches an SMS greeting against account holder names (full name, then first name). */
export function matchGreetingOwner(greeting: string, accounts: Account[]): Account | null {
  const fullMatches: Account[] = [];
  const firstMatches: Account[] = [];
  for (const account of accounts) {
    const holder = canonicalAccountHolderName(account.accountHolderName);
    if (!holder) continue;
    const full = new RegExp(`(?:^|\\s)${escapeRegex(holder)}(?:\\s|$)`, 'i');
    if (full.test(greeting)) {
      fullMatches.push(account);
      continue;
    }
    const first = holder.split(' ')[0];
    const firstRe = new RegExp(`(?:^|\\s)${escapeRegex(first)}(?:\\s|$)`, 'i');
    if (first && firstRe.test(greeting)) firstMatches.push(account);
  }
  if (fullMatches.length === 1) return fullMatches[0];
  if (fullMatches.length > 1) return null;
  return unique(firstMatches);
}

export function suggestedAccountHolderNameFromSms(body: string): string | null {
  const match = body.match(GREETING_RE);
  if (!match) return null;
  const name = match[1].replace(/[\s.!]+$/, '').replace(/\s+/g, ' ').trim();
  if (!name || isGenericGreeting(name)) return null;
  return name;
}

export function yourAccountNumbers(body: string): string[] {
  const values: string[] = [];
  for (const match of body.matchAll(YOUR_ACCOUNT_RE)) {
    const value = match[1]?.trim();
    if (!value || !/\d/.test(value)) continue;
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

export function hasUnmatchedSpecificAccountGreeting(body: string, bank: Bank | null | undefined, accounts: Account[]): boolean {
  const greeting = greetingName(body);
  if (!greeting || isGenericGreeting(greeting)) return false;
  const bankAccounts = accounts.filter((a) => bank && a.bank === bank.id);
  return matchGreetingOwner(greeting, bankAccounts) === null;
}

export interface SmsOwnership {
  account: Account;
  matchedByGreeting: boolean;
}

export function resolveSmsOwnership(params: {
  body: string;
  bank: Bank | null | undefined;
  accounts: Account[];
  parsedAccountNumber?: string | null;
  subscriptionId?: number | null;
}): SmsOwnership | null {
  const { body, bank, accounts } = params;
  if (!bank) return null;
  const bankAccounts = accounts.filter((a) => a.bank === bank.id);
  if (bankAccounts.length === 0) return null;

  const greeting = greetingName(body);
  if (greeting && !isGenericGreeting(greeting)) {
    const owner = matchGreetingOwner(greeting, bankAccounts);
    if (!owner) return null;
    const resolved = resolveAccountOwnership({ bank, accounts: bankAccounts, holderName: owner.accountHolderName });
    return { account: resolved ?? owner, matchedByGreeting: true };
  }

  const numbers = yourAccountNumbers(body);
  if (numbers.length > 0) {
    const matches = bankAccounts.filter((a) => numbers.some((n) => accountNumbersMatch(bank, a.accountNumber, n)));
    const match = unique(matches);
    return match ? { account: match, matchedByGreeting: false } : null;
  }

  const resolved = resolveAccountOwnership({
    bank,
    accounts: bankAccounts,
    subscriptionId: params.subscriptionId,
    parsedNumber: isSimBank(bank) ? null : params.parsedAccountNumber,
  });
  if (resolved) return { account: resolved, matchedByGreeting: false };

  const fallback = unique(bankAccounts.filter((a) => a.isDefault));
  return fallback ? { account: fallback, matchedByGreeting: false } : null;
}

export function resolveTransactionOwnership(
  tx: Transaction,
  bank: Bank | null | undefined,
  accounts: Account[],
): Account | null {
  if (!bank || tx.bankId !== bank.id) return null;
  const bankAccounts = accounts.filter((a) => a.bank === bank.id);
  if (tx.ownerAccountNumber) {
    return unique(bankAccounts.filter((a) => registeredAccountNumbersMatch(bank, a.accountNumber, tx.ownerAccountNumber)));
  }
  return resolveAccountOwnership({
    bank,
    accounts: bankAccounts,
    parsedNumber: isSimBank(bank) ? null : tx.accountNumber,
    subscriptionId: tx.sourceSubscriptionId,
  });
}

/** Whether a transaction should be shown under a specific registered account. */
export function transactionBelongsToAccount(
  tx: Transaction,
  account: Account,
  bank: Bank | null | undefined,
  accounts: Account[],
): boolean {
  if (tx.bankId !== account.bank) return false;
  if (tx.ownerAccountNumber) {
    return registeredAccountNumbersMatch(bank, tx.ownerAccountNumber, account.accountNumber);
  }
  const owner = resolveTransactionOwnership(tx, bank, accounts);
  if (owner) return owner.accountNumber === account.accountNumber;
  const bankAccounts = accounts.filter((a) => a.bank === account.bank);
  // A single account for the bank owns everything that could not be attributed.
  return bankAccounts.length === 1;
}
