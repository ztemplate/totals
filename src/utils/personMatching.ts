/**
 * Pure helpers that map transactions and loans to people. No React Native imports so they can be unit tested.
 *
 * Banks rarely print a counterparty's account number, so the main signal is the counterparty name as each
 * bank prints it (stored as a 'name' alias, optionally scoped to one bank). Account and phone aliases match
 * full or masked numbers that appear inside the creditor/receiver text. A manual per-transaction link always wins.
 */
import type { Person, PersonAccount, PersonAccountKind, PersonTransactionLink } from '../models/person';
import { isCredit, isDebit, txDate, type Transaction } from '../models/transaction';
import type { LoanDebtItem } from '../services/loanDebtSummary';

export type PersonMatchSource = 'manual' | 'number' | 'name';

export interface PersonMatch {
  personId: number;
  source: PersonMatchSource;
}

interface NameAlias {
  personId: number;
  /** null applies to every bank. */
  bankId: number | null;
}

export interface PeopleIndex {
  people: Person[];
  byId: Map<number, Person>;
  accounts: PersonAccount[];
  accountsByPerson: Map<number, PersonAccount[]>;
  /** Manual links. A null value means the transaction was explicitly unassigned. */
  links: Map<string, number | null>;
  names: Map<string, NameAlias[]>;
  numbers: PersonAccount[];
}

/** Lowercases and keeps only Latin/Ethiopic letters so "ABEBE KEBEDE (0911…)" and "Abebe  Kebede" compare equal. */
export function normalizePersonName(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-zሀ-፿]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Ethiopian mobile numbers are compared on their last 9 digits (9XXXXXXXX), ignoring +251 / 0 prefixes. */
export function normalizePhone(value: string | null | undefined): string {
  const digits = (value ?? '').replace(/\D+/g, '');
  return digits.length > 9 ? digits.slice(-9) : digits;
}

export function normalizePersonIdentifier(value: string | null | undefined, kind: PersonAccountKind): string {
  if (kind === 'name') return normalizePersonName(value);
  if (kind === 'phone') return normalizePhone(value);
  return (value ?? '').replace(/\D+/g, '');
}

/** Detects whether user input looks like a number or a name. */
export function guessIdentifierKind(value: string): PersonAccountKind {
  const digits = value.replace(/\D+/g, '');
  const letters = value.replace(/[^a-zA-Zሀ-፿]+/g, '');
  if (digits.length >= 6 && letters.length === 0) {
    return /^(\+?251|0)?9\d{8}$/.test(value.replace(/[\s-]+/g, '')) ? 'phone' : 'account';
  }
  return 'name';
}

/** The raw counterparty text: who paid you on credits, who you paid on debits. */
export function counterpartyRaw(tx: Pick<Transaction, 'type' | 'creditor' | 'receiver'>): string {
  const raw = isCredit(tx as Transaction) ? tx.creditor || tx.receiver : tx.receiver || tx.creditor;
  return (raw ?? '').trim();
}

export function buildPeopleIndex(
  people: Person[],
  accounts: PersonAccount[],
  links: PersonTransactionLink[],
): PeopleIndex {
  const byId = new Map(people.map((p) => [p.id, p]));
  const accountsByPerson = new Map<number, PersonAccount[]>();
  const names = new Map<string, NameAlias[]>();
  const numbers: PersonAccount[] = [];
  const addName = (key: string, alias: NameAlias) => {
    if (!key) return;
    const list = names.get(key) ?? [];
    if (!list.some((a) => a.personId === alias.personId && a.bankId === alias.bankId)) list.push(alias);
    names.set(key, list);
  };

  for (const account of accounts) {
    if (!byId.has(account.personId)) continue;
    const list = accountsByPerson.get(account.personId) ?? [];
    list.push(account);
    accountsByPerson.set(account.personId, list);
    if (account.kind === 'name') addName(account.normalizedIdentifier, { personId: account.personId, bankId: account.bankId });
    else if (account.normalizedIdentifier.length >= 4) numbers.push(account);
  }
  // A person's own name works as an alias at every bank.
  for (const person of people) addName(normalizePersonName(person.name), { personId: person.id, bankId: null });

  const linkMap = new Map<string, number | null>();
  for (const link of links) {
    if (link.personId !== null && !byId.has(link.personId)) continue;
    linkMap.set(link.transactionReference, link.personId);
  }
  return { people, byId, accounts, accountsByPerson, links: linkMap, names, numbers };
}

/** Number-ish tokens in free text, including masked ones such as 1000****1234 or 2519xxxx5678. */
function numberTokens(text: string): string[] {
  return (text.match(/[0-9*•][0-9*xX•.\-]{2,}[0-9]|[0-9]{4,}/g) ?? []).map((t) => t.replace(/[.\-]/g, '').replace(/[xX•]/g, '*'));
}

function numberCandidates(account: PersonAccount): string[] {
  const value = account.normalizedIdentifier;
  if (account.kind !== 'phone' || value.length !== 9) return [value];
  return [value, `0${value}`, `251${value}`];
}

/** True when a (possibly masked) token is consistent with a stored number. */
export function numberTokenMatches(token: string, stored: string): boolean {
  if (!stored) return false;
  if (!token.includes('*')) return token === stored;
  const first = token.indexOf('*');
  const last = token.lastIndexOf('*');
  const prefix = token.slice(0, first);
  const suffix = token.slice(last + 1);
  // Require enough visible digits to make an accidental match unlikely.
  if (prefix.length + suffix.length < 4 || prefix.length + suffix.length >= stored.length + 1) return false;
  return stored.startsWith(prefix) && stored.endsWith(suffix);
}

function matchByNumber(tx: Transaction, index: PeopleIndex): number | null {
  if (index.numbers.length === 0) return null;
  const text = [tx.creditor, tx.receiver].filter(Boolean).join(' ');
  const tokens = numberTokens(text);
  if (tokens.length === 0) return null;
  for (const account of index.numbers) {
    if (account.bankId !== null && tx.bankId != null && account.bankId !== tx.bankId) continue;
    const candidates = numberCandidates(account);
    if (tokens.some((token) => candidates.some((c) => numberTokenMatches(token, c)))) return account.personId;
  }
  return null;
}

function matchByName(tx: Transaction, index: PeopleIndex): number | null {
  const key = normalizePersonName(counterpartyRaw(tx));
  if (!key) return null;
  const aliases = index.names.get(key);
  if (!aliases || aliases.length === 0) return null;
  // Bank-specific aliases beat bank-wide ones.
  const scoped = aliases.find((a) => a.bankId !== null && a.bankId === tx.bankId);
  if (scoped) return scoped.personId;
  const general = aliases.find((a) => a.bankId === null);
  return general ? general.personId : null;
}

export function matchTransactionToPerson(tx: Transaction, index: PeopleIndex): PersonMatch | null {
  if (index.links.has(tx.reference)) {
    const personId = index.links.get(tx.reference) ?? null;
    return personId === null ? null : { personId, source: 'manual' };
  }
  const byNumber = matchByNumber(tx, index);
  if (byNumber !== null) return { personId: byNumber, source: 'number' };
  const byName = matchByName(tx, index);
  if (byName !== null) return { personId: byName, source: 'name' };
  return null;
}

/** personId -> that person's transactions (newest first is left to the caller). */
export function groupTransactionsByPerson(transactions: Transaction[], index: PeopleIndex): Map<number, Transaction[]> {
  const out = new Map<number, Transaction[]>();
  if (index.people.length === 0) return out;
  for (const tx of transactions) {
    const match = matchTransactionToPerson(tx, index);
    if (!match) continue;
    const list = out.get(match.personId) ?? [];
    list.push(tx);
    out.set(match.personId, list);
  }
  return out;
}

/**
 * Loans are stored with a free-text person name. They belong to a person when that name matches the person's
 * name or one of their name aliases; otherwise when the loan's transaction is mapped to the person.
 */
export function personIdForLoanItem(item: LoanDebtItem, index: PeopleIndex): number | null {
  const key = normalizePersonName(item.entry.personName);
  const aliases = key ? index.names.get(key) : undefined;
  if (aliases && aliases.length > 0) {
    const exact = index.people.find((p) => normalizePersonName(p.name) === key);
    return exact ? exact.id : aliases[0].personId;
  }
  if (item.transaction) return matchTransactionToPerson(item.transaction, index)?.personId ?? null;
  return null;
}

export function groupLoanItemsByPerson(items: LoanDebtItem[], index: PeopleIndex): Map<number, LoanDebtItem[]> {
  const out = new Map<number, LoanDebtItem[]>();
  for (const item of items) {
    const personId = personIdForLoanItem(item, index);
    if (personId === null) continue;
    const list = out.get(personId) ?? [];
    list.push(item);
    out.set(personId, list);
  }
  return out;
}

export interface PersonActivitySummary {
  /** Money you sent them (debits). */
  sent: number;
  /** Money they sent you (credits). */
  received: number;
  /** received - sent */
  net: number;
  count: number;
  firstDate: Date | null;
  lastDate: Date | null;
  /** Outstanding on active loans you gave them. */
  owesMe: number;
  /** Outstanding on active debts you took from them. */
  iOwe: number;
  activeLoans: number;
}

export function summarizePersonActivity(transactions: Transaction[], loanItems: LoanDebtItem[]): PersonActivitySummary {
  let sent = 0;
  let received = 0;
  let firstDate: Date | null = null;
  let lastDate: Date | null = null;
  for (const tx of transactions) {
    const amount = Math.abs(tx.amount);
    if (isCredit(tx)) received += amount;
    else if (isDebit(tx)) sent += amount;
    const date = txDate(tx);
    if (date) {
      if (!firstDate || date < firstDate) firstDate = date;
      if (!lastDate || date > lastDate) lastDate = date;
    }
  }
  let owesMe = 0;
  let iOwe = 0;
  let activeLoans = 0;
  for (const item of loanItems) {
    if (item.effectiveStatus !== 'active') continue;
    activeLoans += 1;
    const remaining = item.remaining ?? 0;
    if (item.entry.direction === 'lent') owesMe += remaining;
    else iOwe += remaining;
  }
  return {
    sent,
    received,
    net: received - sent,
    count: transactions.length,
    firstDate,
    lastDate,
    owesMe,
    iOwe,
    activeLoans,
  };
}

export interface CounterpartySuggestion {
  /** Counterparty text as printed by the bank. */
  name: string;
  normalized: string;
  bankId: number | null;
  count: number;
  total: number;
  /** Shared name tokens with the person, used for ranking. */
  score: number;
}

function tokens(value: string): string[] {
  return value.split(' ').filter((t) => t.length >= 2);
}

/**
 * Counterparties that are not mapped to anyone yet, grouped per bank. Ones that share words with
 * `personName` come first, then the most frequent.
 */
export function suggestCounterparties(
  transactions: Transaction[],
  index: PeopleIndex,
  personName: string,
  query = '',
): CounterpartySuggestion[] {
  const personTokens = new Set(tokens(normalizePersonName(personName)));
  const queryKey = normalizePersonName(query);
  const groups = new Map<string, CounterpartySuggestion>();
  for (const tx of transactions) {
    const raw = counterpartyRaw(tx);
    const normalized = normalizePersonName(raw);
    if (!normalized) continue;
    if (queryKey && !normalized.includes(queryKey)) continue;
    if (matchTransactionToPerson(tx, index)) continue;
    const key = `${tx.bankId ?? ''}|${normalized}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.total += Math.abs(tx.amount);
      continue;
    }
    const score = tokens(normalized).filter((t) => personTokens.has(t)).length;
    groups.set(key, { name: raw, normalized, bankId: tx.bankId ?? null, count: 1, total: Math.abs(tx.amount), score });
  }
  return [...groups.values()].sort((a, b) => b.score - a.score || b.count - a.count || a.name.localeCompare(b.name));
}
