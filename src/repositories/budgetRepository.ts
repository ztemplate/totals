import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb, type SqlValue } from '../db/database';
import { budgetFromDb, budgetIncludesCategory, budgetToDb, type Budget } from '../models/budget';
import { nextPeriodStart, periodEndInclusive, periodStart, type CalendarKind } from '../utils/periodUtils';

function normalizeCalendar(calendar?: string | null): CalendarKind | null {
  const value = calendar?.trim().toLowerCase();
  if (!value) return null;
  return value === 'ethiopian' ? 'ethiopian' : 'gregorian';
}

async function query(where: string[], args: SqlValue[], calendar?: string | null): Promise<Budget[]> {
  const db = await getDb();
  const cal = normalizeCalendar(calendar);
  const clauses = [...where];
  const params = [...args];
  if (cal) {
    clauses.push('calendar = ?');
    params.push(cal);
  }
  const sql = `SELECT * FROM budgets${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY createdAt DESC`;
  const rows = await db.getAllAsync<Record<string, unknown>>(sql, params);
  return rows.map(budgetFromDb);
}

async function insertRow(db: SQLiteDatabase, data: Record<string, unknown>): Promise<number> {
  const keys = Object.keys(data);
  const result = await db.runAsync(
    `INSERT INTO budgets (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => data[k] as SqlValue),
  );
  return result.lastInsertRowId;
}

async function updateRow(db: SQLiteDatabase, id: number, data: Record<string, unknown>): Promise<number> {
  const keys = Object.keys(data);
  const result = await db.runAsync(`UPDATE budgets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [
    ...keys.map((k) => data[k] as SqlValue),
    id,
  ]);
  return result.changes;
}

function monthBounds(month: Date, calendar: CalendarKind) {
  const monthStart = periodStart(month, 'monthly', calendar);
  const nextMonthStart = nextPeriodStart(month, 'monthly', calendar);
  const monthEnd = new Date(nextMonthStart.getTime() - 1000);
  return { monthStart, nextMonthStart, monthEnd };
}

function endBefore(date: Date): string {
  return new Date(date.getTime() - 1000).toISOString();
}

export const budgetRepository = {
  getAllBudgets(calendar?: string | null): Promise<Budget[]> {
    return query([], [], calendar);
  },

  getActiveBudgets(calendar?: string | null): Promise<Budget[]> {
    return query(['isActive = ?'], [1], calendar);
  },

  getBudgetsByType(type: string, calendar?: string | null): Promise<Budget[]> {
    return query(['type = ?', 'isActive = ?'], [type, 1], calendar);
  },

  getCategoryBudgets(calendar?: string | null): Promise<Budget[]> {
    return query(['type = ?', 'isActive = ?'], ['category', 1], calendar);
  },

  async getBudgetsByCategory(categoryId: number, calendar?: string | null): Promise<Budget[]> {
    const budgets = await this.getActiveBudgets(calendar);
    return budgets.filter((b) => budgetIncludesCategory(b, [categoryId]));
  },

  async getBudgetById(id: number): Promise<Budget | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM budgets WHERE id = ? LIMIT 1', [id]);
    return row ? budgetFromDb(row) : null;
  },

  async insertBudget(budget: Budget): Promise<number> {
    const db = await getDb();
    return insertRow(db, { ...budgetToDb(budget), updatedAt: new Date().toISOString() });
  },

  async updateBudget(budget: Budget): Promise<number> {
    if (budget.id == null) return 0;
    const db = await getDb();
    return updateRow(db, budget.id, { ...budgetToDb(budget), updatedAt: new Date().toISOString() });
  },

  /**
   * Applies edits only to the given month while preserving the original values
   * for months before and (optionally) after it. Returns the id of the edited segment.
   */
  async updateBudgetForMonthOnly(params: {
    originalBudget: Budget;
    editedBudget: Budget;
    month: Date;
    keepFutureSegment?: boolean;
  }): Promise<number> {
    const { originalBudget, editedBudget, month } = params;
    if (originalBudget.id == null) throw new Error('Original budget must have an id.');
    const originalId = originalBudget.id;
    const db = await getDb();
    const { monthStart, nextMonthStart, monthEnd } = monthBounds(month, editedBudget.calendar);
    const originalEnd = originalBudget.endDate ? new Date(originalBudget.endDate) : null;
    const hadPastSegment = new Date(originalBudget.startDate).getTime() < monthStart.getTime();
    const hasFutureSegment =
      (params.keepFutureSegment ?? true) && (originalEnd === null || originalEnd.getTime() > monthEnd.getTime());
    const nowIso = new Date().toISOString();
    let editedId = originalId;

    await db.withTransactionAsync(async () => {
      const editedData = {
        ...budgetToDb({ ...editedBudget, startDate: monthStart.toISOString(), endDate: monthEnd.toISOString() }),
        updatedAt: nowIso,
      };
      if (hadPastSegment) {
        await updateRow(db, originalId, { endDate: endBefore(monthStart), updatedAt: nowIso });
        editedId = await insertRow(db, editedData);
      } else {
        await updateRow(db, originalId, editedData);
      }
      if (hasFutureSegment) {
        await insertRow(db, {
          ...budgetToDb({
            ...originalBudget,
            id: null,
            startDate: nextMonthStart.toISOString(),
            endDate: originalBudget.endDate ?? null,
            createdAt: nowIso,
          }),
          updatedAt: nowIso,
        });
      }
    });
    return editedId;
  },

  async deleteBudget(id: number): Promise<number> {
    const db = await getDb();
    const result = await db.runAsync('DELETE FROM budgets WHERE id = ?', [id]);
    return result.changes;
  },

  /** Removes a budget for a single month, optionally removing it for all later months too. */
  async deleteBudgetForMonth(params: { originalBudget: Budget; month: Date; deleteFutureBudgets?: boolean }): Promise<void> {
    const { originalBudget, month } = params;
    if (originalBudget.id == null) throw new Error('Original budget must have an id.');
    const id = originalBudget.id;
    const db = await getDb();
    const { monthStart, nextMonthStart, monthEnd } = monthBounds(month, originalBudget.calendar);
    const originalEnd = originalBudget.endDate ? new Date(originalBudget.endDate) : null;
    const hadPastSegment = new Date(originalBudget.startDate).getTime() < monthStart.getTime();
    const hasFutureSegment = originalEnd === null || originalEnd.getTime() > monthEnd.getTime();
    const nowIso = new Date().toISOString();

    await db.withTransactionAsync(async () => {
      if (params.deleteFutureBudgets) {
        if (hadPastSegment) {
          await updateRow(db, id, { endDate: endBefore(monthStart), updatedAt: nowIso });
        } else {
          await db.runAsync('DELETE FROM budgets WHERE id = ?', [id]);
        }
        return;
      }
      if (hadPastSegment && hasFutureSegment) {
        await updateRow(db, id, { endDate: endBefore(monthStart), updatedAt: nowIso });
        await insertRow(db, {
          ...budgetToDb({
            ...originalBudget,
            id: null,
            startDate: nextMonthStart.toISOString(),
            endDate: originalBudget.endDate ?? null,
            createdAt: nowIso,
          }),
          updatedAt: nowIso,
        });
        return;
      }
      if (hadPastSegment) {
        await updateRow(db, id, { endDate: endBefore(monthStart), updatedAt: nowIso });
        return;
      }
      if (hasFutureSegment) {
        await updateRow(db, id, { startDate: nextMonthStart.toISOString(), updatedAt: nowIso });
        return;
      }
      await db.runAsync('DELETE FROM budgets WHERE id = ?', [id]);
    });
  },

  async deactivateBudget(id: number): Promise<void> {
    const db = await getDb();
    await updateRow(db, id, { isActive: 0, updatedAt: new Date().toISOString() });
  },

  async activateBudget(id: number): Promise<void> {
    const db = await getDb();
    await updateRow(db, id, { isActive: 1, updatedAt: new Date().toISOString() });
  },

  async clearAll(): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM budgets');
  },

  async getActiveBudgetsForCurrentPeriod(type: string, calendar?: string | null): Promise<Budget[]> {
    const cal = normalizeCalendar(calendar) ?? 'gregorian';
    const frame = type === 'daily' || type === 'yearly' ? type : 'monthly';
    const now = new Date();
    const start = periodStart(now, frame, cal);
    const end = periodEndInclusive(now, frame, cal);
    return query(
      ['type = ?', 'isActive = ?', 'startDate <= ?', '(endDate IS NULL OR endDate >= ?)'],
      [type, 1, end.toISOString(), start.toISOString()],
      calendar,
    );
  },
};
