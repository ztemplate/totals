import type { Account } from '../models/account';
import type { Bank } from '../models/bank';
import { OwnerAssignment, type Transaction } from '../models/transaction';

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

  // A printed account number is the strongest evidence: with several accounts at one bank the
  // holder name and the SIM are usually shared, the number is not.
  let candidates = bankAccounts;
  if (params.parsedNumber) {
    candidates = bankAccounts.filter((a) => accountNumbersMatch(bank, a.accountNumber, params.parsedNumber));
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
  }

  const holder = canonicalAccountHolderName(params.holderName);
  if (holder) {
    const byName = unique(candidates.filter((a) => canonicalAccountHolderName(a.accountHolderName) === holder));
    if (byName) return byName;
  }

  const sub = params.subscriptionId;
  if (sub !== null && sub !== undefined && sub >= 0) {
    const bySub = unique(candidates.filter((a) => a.smsSubscriptionId === sub));
    if (bySub) return bySub;
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

function nameRe(name: string): RegExp {
  return new RegExp(`(?:^|\\s)${escapeRegex(name)}(?:\\s|$)`, 'i');
}

/** How a greeting matches a holder name: the full name, only the first name, or not at all. */
function greetingNameMatch(greeting: string, holderName: string | null | undefined): 'full' | 'first' | null {
  const holder = canonicalAccountHolderName(holderName);
  if (!holder) return null;
  if (nameRe(holder).test(greeting)) return 'full';
  const first = holder.split(' ')[0];
  return first && nameRe(first).test(greeting) ? 'first' : null;
}

/**
 * Whether a greeting can be addressed to this holder: it shares a word of the name ("Dear Kebede"
 * or "Dear A. Kebede" for Abebe Kebede). Looser than matchGreetingOwner, which picks an owner; this
 * only rules accounts out.
 */
function greetingFitsHolder(greeting: string, holderName: string | null | undefined): boolean {
  if (greetingNameMatch(greeting, holderName)) return true;
  const words = canonicalAccountHolderName(holderName)
    .split(' ')
    .filter((w) => w.replace(/[^\p{L}]/gu, '').length >= 2);
  return words.some((w) => nameRe(w).test(greeting));
}

/** Matches an SMS greeting against account holder names (full name, then first name). */
export function matchGreetingOwner(greeting: string, accounts: Account[]): Account | null {
  const fullMatches: Account[] = [];
  const firstMatches: Account[] = [];
  for (const account of accounts) {
    const match = greetingNameMatch(greeting, account.accountHolderName);
    if (match === 'full') fullMatches.push(account);
    else if (match === 'first') firstMatches.push(account);
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

export interface SmsOwnershipCheck {
  owner: SmsOwnership | null;
  /**
   * The message names a person and an account, and no registered account has both: it is someone
   * else's message (a family member's account at the same bank, say) and must not be given to an
   * account on the number, SIM or default alone.
   */
  conflict: boolean;
}

/**
 * Decides which registered account an SMS belongs to.
 *
 * Evidence is the account number printed in the message and the name it greets. When the message
 * has both, the owner must match both. An account without a holder name can't be checked on the
 * name, so its number decides. Only when one of them is missing does the other decide, and only
 * when both are missing (or several accounts still fit) do the receiving SIM and then the default
 * account decide.
 */
export function checkSmsOwnership(params: {
  body: string;
  bank: Bank | null | undefined;
  accounts: Account[];
  parsedAccountNumber?: string | null;
  subscriptionId?: number | null;
}): SmsOwnershipCheck {
  const none: SmsOwnershipCheck = { owner: null, conflict: false };
  const { body, bank, accounts } = params;
  if (!bank) return none;
  const bankAccounts = accounts.filter((a) => a.bank === bank.id);
  if (bankAccounts.length === 0) return none;

  // Wallet numbers parsed from SIM-based banks can be the counterparty, so only "your account ..."
  // counts there.
  const yours = yourAccountNumbers(body);
  const printed = yours.length > 0 ? yours : !isSimBank(bank) && params.parsedAccountNumber ? [params.parsedAccountNumber] : [];
  const rawGreeting = greetingName(body);
  const greeting = rawGreeting && !isGenericGreeting(rawGreeting) ? rawGreeting : null;

  let candidates = bankAccounts;
  if (printed.length > 0) {
    candidates = bankAccounts.filter((a) => printed.some((n) => accountNumbersMatch(bank, a.accountNumber, n)));
    // An account that isn't registered; it shows up as an unlabeled account.
    if (candidates.length === 0) return none;
  }

  let nameFits = false;
  if (greeting) {
    const owner = matchGreetingOwner(greeting, candidates);
    if (owner) return { owner: { account: owner, matchedByGreeting: true }, conflict: false };
    const byName = candidates.filter((a) => greetingFitsHolder(greeting, a.accountHolderName));
    // Accounts without a holder name can't be ruled out by the greeting, so for them the name counts
    // as missing.
    const unnamed = candidates.filter((a) => !canonicalAccountHolderName(a.accountHolderName));
    if (byName.length === 0 && unnamed.length === 0) return { owner: null, conflict: true };
    nameFits = byName.length > 0;
    candidates = nameFits ? byName : unnamed;
  }

  const found = (account: Account): SmsOwnershipCheck => ({ owner: { account, matchedByGreeting: false }, conflict: false });
  if (candidates.length === 1 && (printed.length > 0 || nameFits)) return found(candidates[0]);

  const subscriptionId = params.subscriptionId;
  if (subscriptionId != null && subscriptionId >= 0) {
    const bySub = unique(candidates.filter((a) => a.smsSubscriptionId === subscriptionId));
    if (bySub) return found(bySub);
  }

  const fallback = unique(candidates.filter((a) => a.isDefault));
  return fallback ? found(fallback) : none;
}

export function resolveSmsOwnership(params: Parameters<typeof checkSmsOwnership>[0]): SmsOwnership | null {
  return checkSmsOwnership(params).owner;
}

/** Whether a message was found to be addressed to someone else's account. */
export function isOwnershipConflict(tx: Transaction): boolean {
  return tx.ownerAssignmentSource === OwnerAssignment.conflict && !tx.ownerAccountNumber;
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
  if (isOwnershipConflict(tx)) return null;
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
  if (isOwnershipConflict(tx)) return false;
  const owner = resolveTransactionOwnership(tx, bank, accounts);
  if (owner) return owner.accountNumber === account.accountNumber;
  const bankAccounts = accounts.filter((a) => a.bank === account.bank);
  // A single account for the bank owns everything that could not be attributed.
  return bankAccounts.length === 1;
}
