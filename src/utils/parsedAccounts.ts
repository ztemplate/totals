/**
 * Every account found in parsed bank SMS: the user's registered accounts, unlabeled ones (seen in
 * messages but not registered) and the counterparty numbers printed in messages. Each one can belong
 * to a person through the person's saved account or phone numbers (person_accounts), so one person
 * can own several accounts across banks and wallets. Pure, so it can be unit tested.
 */
import type { Account } from '../models/account';
import type { Bank } from '../models/bank';
import type { Person, PersonAccount } from '../models/person';
import { txDate, type Transaction } from '../models/transaction';
import {
  accountNumbersMatch,
  canonicalAccountNumber,
  isOwnershipConflict,
  isSimBank,
  registeredAccountNumbersMatch,
  resolveTransactionOwnership,
} from './accountIdentity';
import { CASH_BANK_ID } from './cashConstants';
import { counterpartyRaw, matchTransactionToPerson, normalizePersonName, normalizePhone, type PeopleIndex } from './personMatching';
import { detectUnlabeledAccounts, isMaskedAccountNumber, type UnlabeledAccount } from './unlabeledAccounts';

/** mine: registered account. unlabeled: the user's (or a family member's) account not registered yet. counterparty: who they paid or were paid by. */
export type ParsedAccountKind = 'mine' | 'unlabeled' | 'counterparty';

/** banks: ordinary banks. providers: SIM-based wallets such as telebirr and M-Pesa. */
export type ParsedAccountScope = 'all' | 'banks' | 'providers';

export type ParsedAccountPersonSource = 'number' | 'transactions';

export interface ParsedAccount {
  key: string;
  kind: ParsedAccountKind;
  bankId: number;
  /** SIM-based wallet (telebirr, M-Pesa, CBE Birr…). */
  provider: boolean;
  /** Number as registered or as printed in the SMS (possibly masked). Null when the messages carry none. */
  accountNumber: string | null;
  /** SIM that received the messages, for wallets whose own number isn't printed. */
  subscriptionId: number | null;
  /** Account holder (registered accounts), greeting name or counterparty name. */
  holderName: string | null;
  /** The registered account, for kind 'mine'. */
  account: Account | null;
  /** The unlabeled group, for kind 'unlabeled'. */
  unlabeled: UnlabeledAccount | null;
  /** Transactions of this account, oldest first as found. */
  references: string[];
  count: number;
  credit: number;
  debit: number;
  firstDate: Date | null;
  lastDate: Date | null;
  /** Balance printed by the newest message (registered accounts fall back to their stored balance). */
  lastBalance: number | null;
  personId: number | null;
  personSource: ParsedAccountPersonSource | null;
  /** person_accounts rows that tie this account's number to a person; removed when the owner changes. */
  personAliasIds: number[];
}

export interface ParsedAccountsInput {
  transactions: readonly Transaction[];
  accounts: readonly Account[];
  banks: readonly Bank[];
  people?: readonly Person[];
  personAccounts?: readonly PersonAccount[];
  /** Used to guess the person of a counterparty from its transactions when no number is saved. */
  peopleIndex?: PeopleIndex | null;
  includeCounterparties?: boolean;
}

function balanceOf(tx: Transaction): number | null {
  if (!tx.currentBalance) return null;
  const value = Number.parseFloat(String(tx.currentBalance).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function emptyAccount(
  key: string,
  kind: ParsedAccountKind,
  bank: Bank,
  accountNumber: string | null,
  subscriptionId: number | null,
): ParsedAccount {
  return {
    key,
    kind,
    bankId: bank.id,
    provider: isSimBank(bank),
    accountNumber,
    subscriptionId,
    holderName: null,
    account: null,
    unlabeled: null,
    references: [],
    count: 0,
    credit: 0,
    debit: 0,
    firstDate: null,
    lastDate: null,
    lastBalance: null,
    personId: null,
    personSource: null,
    personAliasIds: [],
  };
}

function addTransaction(item: ParsedAccount, tx: Transaction, date: Date | null, withBalance: boolean): void {
  item.references.push(tx.reference);
  item.count++;
  const amount = Math.abs(tx.amount);
  if (tx.type === 'CREDIT') item.credit += amount;
  else if (tx.type === 'DEBIT') item.debit += amount;
  if (!date) return;
  if (!item.firstDate || date < item.firstDate) item.firstDate = date;
  if (!item.lastDate || date >= item.lastDate) {
    item.lastDate = date;
    if (withBalance) item.lastBalance = balanceOf(tx) ?? item.lastBalance;
  }
}

/** Number-ish tokens in counterparty text: full or masked account and phone numbers. */
const NUMBER_TOKEN_RE = /\+?[0-9*xX•][0-9*xX•\-]{4,}[0-9]/g;

export function counterpartyNumbers(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const match of text.match(NUMBER_TOKEN_RE) ?? []) {
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(match)) continue; // a date
    const token = match.replace(/-/g, '');
    const digits = token.replace(/\D/g, '').length;
    const masked = /[*xX•]/.test(token);
    // Masked numbers need a few visible digits; plain ones must be long enough for an account or a phone.
    if (masked ? digits < 4 || token.length < 6 : digits < 8) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/** Counterparty name without the numbers banks print next to it. */
function counterpartyName(tx: Transaction): string | null {
  const name = counterpartyRaw(tx)
    .replace(NUMBER_TOKEN_RE, ' ')
    .replace(/[()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalizePersonName(name) ? name : null;
}

/**
 * person_accounts rows that say a number belongs to someone. Bank-specific rows beat any-bank ones and
 * exact numbers beat masked matches. Name aliases never decide who owns an account.
 */
export function personAliasesForNumber(
  bank: Bank,
  number: string | null | undefined,
  aliases: readonly PersonAccount[],
): { personId: number | null; aliasIds: number[] } {
  if (!number) return { personId: null, aliasIds: [] };
  // Wallet numbers, and numbers shaped like an Ethiopian or Kenyan mobile number, can be matched on a phone alias.
  const sim = isSimBank(bank) || /^(?:\+?251|\+?254|0)?[79]\d{8}$/.test(number.replace(/[\s-]/g, ''));
  const phone = normalizePhone(number);
  let best: { personId: number; score: number } | null = null;
  const aliasIds: number[] = [];
  for (const alias of aliases) {
    if (alias.kind === 'name') continue;
    if (alias.bankId !== null && alias.bankId !== bank.id) continue;
    let exact = false;
    if (alias.kind === 'phone') {
      // A phone number only owns a wallet, or an account it was saved for.
      if (!sim && alias.bankId === null) continue;
      if (phone.length < 9 || normalizePhone(alias.identifier) !== phone) continue;
      exact = true;
    } else {
      if (!accountNumbersMatch(bank, alias.identifier, number)) continue;
      exact = registeredAccountNumbersMatch(bank, alias.identifier, number);
    }
    aliasIds.push(alias.id);
    const score = (alias.bankId !== null ? 2 : 0) + (exact ? 1 : 0);
    if (!best || score > best.score) best = { personId: alias.personId, score };
  }
  return { personId: best?.personId ?? null, aliasIds };
}

/** Lists every account found in the parsed messages. Linear in the number of transactions. */
export function buildParsedAccounts(input: ParsedAccountsInput): ParsedAccount[] {
  const banksById = new Map(input.banks.map((b) => [b.id, b]));
  const accounts = input.accounts.filter((a) => a.bank !== CASH_BANK_ID && banksById.has(a.bank));
  const accountsByBank = new Map<number, Account[]>();
  for (const account of accounts) {
    const list = accountsByBank.get(account.bank) ?? [];
    list.push(account);
    accountsByBank.set(account.bank, list);
  }

  // Registered accounts, even without messages.
  const mine = new Map<Account, ParsedAccount>();
  for (const account of accounts) {
    const bank = banksById.get(account.bank)!;
    const item = emptyAccount(
      `${bank.id}|mine:${canonicalAccountNumber(bank, account.accountNumber) ?? account.accountNumber}`,
      'mine',
      bank,
      account.accountNumber,
      account.smsSubscriptionId ?? null,
    );
    item.account = account;
    item.holderName = account.accountHolderName.trim() || null;
    mine.set(account, item);
  }

  const unlabeledGroups = detectUnlabeledAccounts(input.transactions, accounts, input.banks);
  const unlabeledRefs = new Set<string>();
  const unlabeled: ParsedAccount[] = [];
  for (const group of unlabeledGroups) {
    const bank = banksById.get(group.bankId);
    if (!bank) continue;
    for (const reference of group.references) unlabeledRefs.add(reference);
    unlabeled.push({
      ...emptyAccount(group.key, 'unlabeled', bank, group.accountNumber, group.subscriptionId),
      unlabeled: group,
      references: [...group.references],
      count: group.count,
      credit: group.credit,
      debit: group.debit,
      firstDate: group.firstDate,
      lastDate: group.lastDate,
      lastBalance: group.lastBalance,
    });
  }

  const counterpartiesByBank = new Map<number, ParsedAccount[]>();
  const counterpartyTxs = new Map<ParsedAccount, Transaction[]>();
  const counterpartyByNumber = new Map<string, ParsedAccount | null>();
  const owners = new Map<string, Account | null>();
  const includeCounterparties = input.includeCounterparties !== false;

  for (const tx of input.transactions) {
    const bankId = tx.bankId;
    if (bankId == null || bankId === CASH_BANK_ID) continue;
    const bank = banksById.get(bankId);
    if (!bank) continue;
    const date = txDate(tx);
    const bankAccounts = accountsByBank.get(bankId) ?? [];

    let owner: Account | null = null;
    if (!unlabeledRefs.has(tx.reference) && bankAccounts.length > 0) {
      // Ownership only depends on these fields; inboxes repeat them, so resolve each combination once.
      const ownerKey = [
        bankId,
        tx.ownerAccountNumber ?? '',
        isOwnershipConflict(tx) ? 1 : 0,
        tx.accountNumber ?? '',
        tx.sourceSubscriptionId ?? '',
      ].join('\u0000');
      const cached = owners.get(ownerKey);
      if (cached !== undefined) owner = cached;
      else {
        owner = resolveTransactionOwnership(tx, bank, bankAccounts);
        // Same rule as the account screens: a bank's only account owns what could not be attributed.
        if (!owner && bankAccounts.length === 1 && !tx.ownerAccountNumber && !isOwnershipConflict(tx)) owner = bankAccounts[0];
        owners.set(ownerKey, owner);
      }
      if (owner) addTransaction(mine.get(owner)!, tx, date, true);
    }

    if (!includeCounterparties) continue;
    const ownNumber = owner?.accountNumber ?? null;
    const numbers = counterpartyNumbers([tx.creditor, tx.receiver].filter(Boolean).join(' '));
    // Wallets print the other side's number as the parsed account number.
    if (isSimBank(bank) && tx.accountNumber?.trim()) numbers.unshift(tx.accountNumber.trim());
    if (numbers.length === 0) continue;
    const groups = counterpartiesByBank.get(bankId) ?? [];
    const seen = new Set<ParsedAccount>();
    for (const number of numbers) {
      if (ownNumber && accountNumbersMatch(bank, ownNumber, number)) continue;
      const numberKey = `${bankId}\u0000${number}`;
      let group = counterpartyByNumber.get(numberKey);
      if (group === undefined) {
        const canonical = canonicalAccountNumber(bank, number);
        if (!canonical || bankAccounts.some((a) => registeredAccountNumbersMatch(bank, a.accountNumber, number))) {
          group = null;
        } else {
          group = groups.find((g) => accountNumbersMatch(bank, g.accountNumber, number)) ?? null;
          if (!group) {
            group = emptyAccount(`${bankId}|cp:${canonical}`, 'counterparty', bank, number, null);
            groups.push(group);
            counterpartiesByBank.set(bankId, groups);
            counterpartyTxs.set(group, []);
          }
        }
        counterpartyByNumber.set(numberKey, group);
      }
      if (!group || seen.has(group)) continue;
      seen.add(group);
      if (isMaskedAccountNumber(group.accountNumber) && !isMaskedAccountNumber(number)) group.accountNumber = number;
      const isNewest = !group.lastDate || (date !== null && date >= group.lastDate);
      addTransaction(group, tx, date, false);
      const name = counterpartyName(tx);
      if (name && (isNewest || !group.holderName)) group.holderName = name;
      counterpartyTxs.get(group)!.push(tx);
    }
  }

  // Registered accounts: newest message balance, else the stored balance.
  for (const item of mine.values()) {
    if (item.lastBalance === null) item.lastBalance = item.account?.balance ?? null;
  }

  const all = [...mine.values(), ...unlabeled, ...[...counterpartiesByBank.values()].flat()];
  const people = new Set((input.people ?? input.peopleIndex?.people ?? []).map((p) => p.id));
  const aliases = (input.personAccounts ?? input.peopleIndex?.accounts ?? []).filter((a) => people.has(a.personId));
  for (const item of all) {
    const bank = banksById.get(item.bankId)!;
    const { personId, aliasIds } = personAliasesForNumber(bank, item.accountNumber, aliases);
    item.personAliasIds = aliasIds;
    if (personId !== null) {
      item.personId = personId;
      item.personSource = 'number';
      continue;
    }
    const index = input.peopleIndex;
    if (item.kind !== 'counterparty' || !index || index.people.length === 0) continue;
    // Who the counterparty's transactions are matched to most often (names, manual links).
    const votes = new Map<number, number>();
    for (const tx of counterpartyTxs.get(item) ?? []) {
      const match = matchTransactionToPerson(tx, index);
      if (match) votes.set(match.personId, (votes.get(match.personId) ?? 0) + 1);
    }
    let top: [number, number] | null = null;
    for (const entry of votes) if (!top || entry[1] > top[1]) top = entry;
    if (top) {
      item.personId = top[0];
      item.personSource = 'transactions';
    }
  }

  const kindOrder: Record<ParsedAccountKind, number> = { mine: 0, unlabeled: 1, counterparty: 2 };
  return all.sort(
    (a, b) =>
      kindOrder[a.kind] - kindOrder[b.kind] ||
      (b.lastDate?.getTime() ?? 0) - (a.lastDate?.getTime() ?? 0) ||
      b.count - a.count ||
      a.key.localeCompare(b.key),
  );
}

export interface ParsedAccountFilter {
  scope?: ParsedAccountScope;
  bankId?: number | null;
  /** A person's id, 'unassigned' for accounts nobody owns, or null for everyone. */
  person?: number | 'unassigned' | null;
  kinds?: readonly ParsedAccountKind[] | null;
  query?: string;
}

/** The number as shown: masked numbers as printed, SIM-only wallets by their SIM. */
export function parsedAccountNumberLabel(item: Pick<ParsedAccount, 'accountNumber' | 'provider' | 'subscriptionId'>): string {
  if (item.accountNumber) return item.accountNumber;
  if (item.provider) return item.subscriptionId != null && item.subscriptionId >= 0 ? `SIM ${item.subscriptionId}` : 'Your number';
  return 'Number not in SMS';
}

export function filterParsedAccounts(
  items: readonly ParsedAccount[],
  filter: ParsedAccountFilter,
  lookup: { banks?: readonly Bank[]; people?: readonly Person[] } = {},
): ParsedAccount[] {
  const scope = filter.scope ?? 'all';
  const kinds = filter.kinds && filter.kinds.length > 0 ? new Set(filter.kinds) : null;
  const query = (filter.query ?? '').trim().toLowerCase();
  const queryDigits = query.replace(/\D/g, '');
  const banksById = new Map((lookup.banks ?? []).map((b) => [b.id, b]));
  const peopleById = new Map((lookup.people ?? []).map((p) => [p.id, p]));
  return items.filter((item) => {
    if (scope === 'banks' && item.provider) return false;
    if (scope === 'providers' && !item.provider) return false;
    if (filter.bankId != null && item.bankId !== filter.bankId) return false;
    if (filter.person === 'unassigned' && item.personId !== null) return false;
    if (typeof filter.person === 'number' && item.personId !== filter.person) return false;
    if (kinds && !kinds.has(item.kind)) return false;
    if (!query) return true;
    const bank = banksById.get(item.bankId);
    const person = item.personId !== null ? peopleById.get(item.personId) : undefined;
    const text = [bank?.name, bank?.shortName, item.holderName, person?.name, parsedAccountNumberLabel(item)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (text.includes(query)) return true;
    return queryDigits.length >= 3 && (item.accountNumber ?? '').replace(/\D/g, '').includes(queryDigits);
  });
}

export interface ParsedAccountPersonGroup {
  /** Null collects the accounts nobody owns. */
  person: Person | null;
  accounts: ParsedAccount[];
}

/** People with their accounts, the busiest first; unassigned accounts last. */
export function groupParsedAccountsByPerson(items: readonly ParsedAccount[], people: readonly Person[]): ParsedAccountPersonGroup[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const groups = new Map<number | null, ParsedAccount[]>();
  for (const item of items) {
    const key = item.personId !== null && byId.has(item.personId) ? item.personId : null;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const count = (list: ParsedAccount[]) => list.reduce((sum, a) => sum + a.count, 0);
  return [...groups.entries()]
    .map(([id, accounts]) => ({ person: id === null ? null : byId.get(id)!, accounts }))
    .sort((a, b) => {
      if (a.person === null) return 1;
      if (b.person === null) return -1;
      return count(b.accounts) - count(a.accounts) || a.person.name.localeCompare(b.person.name);
    });
}
