/**
 * Who your money goes to: spending per person and per kind of person, who borrows the most and who you
 * deal with most often. Pure so it can be unit tested.
 */
import { PERSON_TYPES, personTypeMeta, type Person, type PersonType } from '../models/person';
import { isCredit, isDebit, txDate, type Transaction } from '../models/transaction';
import type { LoanDebtItem } from '../services/loanDebtSummary';

export interface PersonRank {
  person: Person;
  /** The measure the list is ranked by. */
  amount: number;
  count: number;
}

export interface TypeSpending {
  type: PersonType;
  label: string;
  icon: string;
  amount: number;
  count: number;
  people: number;
}

export interface BorrowerRank {
  person: Person;
  /** Total lent to them over the period. */
  lent: number;
  /** Still to be paid back, across all their active loans. */
  outstanding: number;
  loans: number;
}

export interface PeopleAnalytics {
  totalSpent: number;
  totalReceived: number;
  topSpending: PersonRank[];
  topReceiving: PersonRank[];
  byType: TypeSpending[];
  topBorrowers: BorrowerRank[];
  mostTransactions: PersonRank[];
}

function inRange(date: Date | null, since: Date | null): boolean {
  if (!since) return true;
  return !!date && date >= since;
}

function loanDate(item: LoanDebtItem): Date | null {
  const source = item.sourceTransaction ? txDate(item.sourceTransaction) : null;
  if (source) return source;
  const created = new Date(item.entry.createdAt);
  return Number.isNaN(created.getTime()) ? null : created;
}

export function analyzePeople(params: {
  people: Person[];
  byPerson: Map<number, Transaction[]>;
  loansByPerson: Map<number, LoanDebtItem[]>;
  /** Only count activity on or after this date. */
  since?: Date | null;
  /** References to leave out (e.g. transfers between your own accounts). */
  exclude?: ReadonlySet<string>;
  limit?: number;
}): PeopleAnalytics {
  const since = params.since ?? null;
  const limit = params.limit ?? 5;
  const spending: PersonRank[] = [];
  const receiving: PersonRank[] = [];
  const activity: PersonRank[] = [];
  const borrowers: BorrowerRank[] = [];
  const types = new Map<PersonType, TypeSpending>();
  let totalSpent = 0;
  let totalReceived = 0;

  for (const person of params.people) {
    let sent = 0;
    let sentCount = 0;
    let received = 0;
    let receivedCount = 0;
    for (const tx of params.byPerson.get(person.id) ?? []) {
      if (params.exclude?.has(tx.reference)) continue;
      if (!inRange(txDate(tx), since)) continue;
      const amount = Math.abs(tx.amount);
      if (isDebit(tx)) {
        sent += amount;
        sentCount++;
      } else if (isCredit(tx)) {
        received += amount;
        receivedCount++;
      }
    }
    totalSpent += sent;
    totalReceived += received;
    if (sentCount > 0) spending.push({ person, amount: sent, count: sentCount });
    if (receivedCount > 0) receiving.push({ person, amount: received, count: receivedCount });
    if (sentCount + receivedCount > 0) activity.push({ person, amount: sent + received, count: sentCount + receivedCount });

    if (sentCount > 0) {
      const type = person.type ?? 'friend';
      const meta = personTypeMeta(type);
      const entry = types.get(type) ?? { type, label: meta.label, icon: meta.icon, amount: 0, count: 0, people: 0 };
      entry.amount += sent;
      entry.count += sentCount;
      entry.people++;
      types.set(type, entry);
    }

    let lent = 0;
    let outstanding = 0;
    let loans = 0;
    for (const item of params.loansByPerson.get(person.id) ?? []) {
      if (item.entry.direction !== 'lent') continue;
      if (item.effectiveStatus === 'active') outstanding += item.remaining ?? 0;
      if (!inRange(loanDate(item), since)) continue;
      lent += item.original ?? 0;
      loans++;
    }
    if (loans > 0 || outstanding > 0.005) borrowers.push({ person, lent, outstanding, loans });
  }

  const byAmount = (a: PersonRank, b: PersonRank) => b.amount - a.amount || b.count - a.count;
  const typeOrder = new Map(PERSON_TYPES.map((t, i) => [t.value, i]));
  return {
    totalSpent,
    totalReceived,
    topSpending: spending.sort(byAmount).slice(0, limit),
    topReceiving: receiving.sort(byAmount).slice(0, limit),
    byType: [...types.values()].sort((a, b) => b.amount - a.amount || (typeOrder.get(a.type) ?? 0) - (typeOrder.get(b.type) ?? 0)),
    topBorrowers: borrowers
      .sort((a, b) => b.lent - a.lent || b.outstanding - a.outstanding || b.loans - a.loans)
      .slice(0, limit),
    mostTransactions: activity.sort((a, b) => b.count - a.count || b.amount - a.amount).slice(0, limit),
  };
}
