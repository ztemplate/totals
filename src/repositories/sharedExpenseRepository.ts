import { getDb } from '../db/database';
import type { SharedExpense, SharedGroup, SharedSettlement } from '../models/misc';

/** The device owner is always a member of every group under this name. */
export const SELF_MEMBER = 'You';

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function groupFromDb(row: Record<string, any>): SharedGroup {
  const members = parseJson<unknown>(row.members, []);
  return {
    id: row.id ?? null,
    name: String(row.name ?? ''),
    members: Array.isArray(members) ? members.map(String) : [],
    createdAt: String(row.createdAt ?? ''),
    updatedAt: row.updatedAt ?? null,
  };
}

function expenseFromDb(row: Record<string, any>): SharedExpense {
  const splits = parseJson<Record<string, unknown>>(row.splits, {});
  const normalized: Record<string, number> = {};
  for (const [member, value] of Object.entries(splits ?? {})) {
    const n = Number(value);
    if (Number.isFinite(n)) normalized[member] = n;
  }
  return {
    id: row.id ?? null,
    groupId: Number(row.groupId),
    description: String(row.description ?? ''),
    amount: Number(row.amount ?? 0),
    paidBy: String(row.paidBy ?? ''),
    splits: normalized,
    transactionReference: row.transactionReference ?? null,
    date: String(row.date ?? ''),
    createdAt: String(row.createdAt ?? ''),
    settled: row.settled === 1 || row.settled === true,
  };
}

function settlementFromDb(row: Record<string, any>): SharedSettlement {
  return {
    id: row.id ?? null,
    groupId: Number(row.groupId),
    from: String(row.fromMember ?? ''),
    to: String(row.toMember ?? ''),
    amount: Number(row.amount ?? 0),
    date: String(row.date ?? ''),
  };
}

function normalizeMembers(members: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [SELF_MEMBER];
  seen.add(SELF_MEMBER.toLowerCase());
  for (const raw of members) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** Splits an amount equally between members, putting rounding remainders on the first member. */
export function equalSplits(amount: number, members: string[]): Record<string, number> {
  if (members.length === 0) return {};
  const cents = Math.round(amount * 100);
  const base = Math.floor(cents / members.length);
  let remainder = cents - base * members.length;
  const out: Record<string, number> = {};
  for (const m of members) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    out[m] = (base + extra) / 100;
  }
  return out;
}

export interface MemberBalance {
  member: string;
  /** Positive: the member is owed money. Negative: the member owes money. */
  net: number;
}

export interface SuggestedTransfer {
  from: string;
  to: string;
  amount: number;
}

export function computeBalances(
  group: SharedGroup,
  expenses: SharedExpense[],
  settlements: SharedSettlement[],
): MemberBalance[] {
  const net = new Map<string, number>(group.members.map((m) => [m, 0]));
  const add = (member: string, value: number) => net.set(member, (net.get(member) ?? 0) + value);
  for (const e of expenses) {
    if (e.settled) continue;
    add(e.paidBy, e.amount);
    for (const [member, share] of Object.entries(e.splits)) add(member, -share);
  }
  for (const s of settlements) {
    add(s.from, s.amount);
    add(s.to, -s.amount);
  }
  return [...net.entries()].map(([member, value]) => ({ member, net: Math.round(value * 100) / 100 }));
}

/** Greedy debt simplification: matches the largest debtor with the largest creditor. */
export function simplifyDebts(balances: MemberBalance[]): SuggestedTransfer[] {
  const debtors = balances.filter((b) => b.net < -0.005).map((b) => ({ ...b, net: -b.net }));
  const creditors = balances.filter((b) => b.net > 0.005).map((b) => ({ ...b }));
  debtors.sort((a, b) => b.net - a.net);
  creditors.sort((a, b) => b.net - a.net);
  const transfers: SuggestedTransfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].net, creditors[j].net);
    transfers.push({ from: debtors[i].member, to: creditors[j].member, amount: Math.round(amount * 100) / 100 });
    debtors[i].net -= amount;
    creditors[j].net -= amount;
    if (debtors[i].net <= 0.005) i++;
    if (creditors[j].net <= 0.005) j++;
  }
  return transfers;
}

export const sharedExpenseRepository = {
  async getGroups(): Promise<SharedGroup[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM shared_groups ORDER BY COALESCE(updatedAt, createdAt) DESC, id DESC',
    );
    return rows.map(groupFromDb);
  },

  async getGroup(id: number): Promise<SharedGroup | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM shared_groups WHERE id = ? LIMIT 1', [id]);
    return row ? groupFromDb(row) : null;
  },

  async createGroup(name: string, members: string[]): Promise<SharedGroup> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Group name is required.');
    const normalized = normalizeMembers(members);
    const now = new Date().toISOString();
    const db = await getDb();
    const result = await db.runAsync('INSERT INTO shared_groups (name, members, createdAt, updatedAt) VALUES (?, ?, ?, ?)', [
      trimmed,
      JSON.stringify(normalized),
      now,
      now,
    ]);
    return { id: result.lastInsertRowId, name: trimmed, members: normalized, createdAt: now, updatedAt: now };
  },

  async updateGroup(group: SharedGroup): Promise<void> {
    if (group.id == null) return;
    const db = await getDb();
    await db.runAsync('UPDATE shared_groups SET name = ?, members = ?, updatedAt = ? WHERE id = ?', [
      group.name.trim(),
      JSON.stringify(normalizeMembers(group.members)),
      new Date().toISOString(),
      group.id,
    ]);
  },

  async deleteGroup(id: number): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM shared_expenses WHERE groupId = ?', [id]);
      await db.runAsync('DELETE FROM shared_settlements WHERE groupId = ?', [id]);
      await db.runAsync('DELETE FROM shared_groups WHERE id = ?', [id]);
    });
  },

  async getExpenses(groupId: number): Promise<SharedExpense[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM shared_expenses WHERE groupId = ? ORDER BY date DESC, id DESC',
      [groupId],
    );
    return rows.map(expenseFromDb);
  },

  async getAllExpenses(): Promise<SharedExpense[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM shared_expenses ORDER BY date DESC, id DESC');
    return rows.map(expenseFromDb);
  },

  async getExpenseForTransaction(reference: string): Promise<SharedExpense | null> {
    const ref = reference.trim();
    if (!ref) return null;
    const db = await getDb();
    const row = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM shared_expenses WHERE transactionReference = ? LIMIT 1',
      [ref],
    );
    return row ? expenseFromDb(row) : null;
  },

  async saveExpense(expense: SharedExpense): Promise<number> {
    if (!expense.description.trim()) throw new Error('Description is required.');
    if (!Number.isFinite(expense.amount) || expense.amount <= 0) throw new Error('Amount must be greater than zero.');
    const splitTotal = Object.values(expense.splits).reduce((s, v) => s + v, 0);
    if (Math.abs(splitTotal - expense.amount) > 0.01) throw new Error('Splits must add up to the expense amount.');
    const db = await getDb();
    const values = [
      expense.groupId,
      expense.description.trim(),
      expense.amount,
      expense.paidBy,
      JSON.stringify(expense.splits),
      expense.transactionReference?.trim() || null,
      expense.date,
      expense.createdAt,
      expense.settled ? 1 : 0,
    ];
    let id: number;
    if (expense.id != null) {
      await db.runAsync(
        `UPDATE shared_expenses SET groupId = ?, description = ?, amount = ?, paidBy = ?, splits = ?, transactionReference = ?,
           date = ?, createdAt = ?, settled = ? WHERE id = ?`,
        [...values, expense.id],
      );
      id = expense.id;
    } else {
      const result = await db.runAsync(
        `INSERT INTO shared_expenses (groupId, description, amount, paidBy, splits, transactionReference, date, createdAt, settled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values,
      );
      id = result.lastInsertRowId;
    }
    await db.runAsync('UPDATE shared_groups SET updatedAt = ? WHERE id = ?', [new Date().toISOString(), expense.groupId]);
    return id;
  },

  async deleteExpense(id: number): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM shared_expenses WHERE id = ?', [id]);
  },

  async getSettlements(groupId: number): Promise<SharedSettlement[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM shared_settlements WHERE groupId = ? ORDER BY date DESC, id DESC',
      [groupId],
    );
    return rows.map(settlementFromDb);
  },

  async addSettlement(settlement: SharedSettlement): Promise<number> {
    if (settlement.from === settlement.to) throw new Error('A member cannot settle with themselves.');
    if (!Number.isFinite(settlement.amount) || settlement.amount <= 0) throw new Error('Amount must be greater than zero.');
    const db = await getDb();
    const result = await db.runAsync(
      'INSERT INTO shared_settlements (groupId, fromMember, toMember, amount, date) VALUES (?, ?, ?, ?, ?)',
      [settlement.groupId, settlement.from, settlement.to, settlement.amount, settlement.date],
    );
    await db.runAsync('UPDATE shared_groups SET updatedAt = ? WHERE id = ?', [new Date().toISOString(), settlement.groupId]);
    return result.lastInsertRowId;
  },

  async deleteSettlement(id: number): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM shared_settlements WHERE id = ?', [id]);
  },

  async getGroupSummary(groupId: number): Promise<{
    group: SharedGroup;
    expenses: SharedExpense[];
    settlements: SharedSettlement[];
    balances: MemberBalance[];
    transfers: SuggestedTransfer[];
  } | null> {
    const group = await this.getGroup(groupId);
    if (!group) return null;
    const [expenses, settlements] = await Promise.all([this.getExpenses(groupId), this.getSettlements(groupId)]);
    const balances = computeBalances(group, expenses, settlements);
    return { group, expenses, settlements, balances, transfers: simplifyDebts(balances) };
  },

  async clearAll(): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM shared_expenses');
      await db.runAsync('DELETE FROM shared_settlements');
      await db.runAsync('DELETE FROM shared_groups');
    });
  },

  async getAllForExport(): Promise<{ groups: SharedGroup[]; expenses: SharedExpense[]; settlements: SharedSettlement[] }> {
    const db = await getDb();
    const [groups, expenses, settlements] = await Promise.all([
      db.getAllAsync<Record<string, unknown>>('SELECT * FROM shared_groups'),
      db.getAllAsync<Record<string, unknown>>('SELECT * FROM shared_expenses'),
      db.getAllAsync<Record<string, unknown>>('SELECT * FROM shared_settlements'),
    ]);
    return { groups: groups.map(groupFromDb), expenses: expenses.map(expenseFromDb), settlements: settlements.map(settlementFromDb) };
  },
};
