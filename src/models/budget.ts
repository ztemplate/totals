import { decodeCategoryIds, normalizeCategoryIds } from './transaction';
import { periodEndInclusive, periodStart, type CalendarKind, type PeriodFrame } from '../utils/periodUtils';

export type BudgetType = 'daily' | 'monthly' | 'yearly' | 'category';
export type BudgetTimeFrame = 'daily' | 'monthly' | 'yearly' | 'never';

export interface Budget {
  id?: number | null;
  name: string;
  type: BudgetType;
  amount: number;
  categoryId?: number | null;
  categoryIds?: number[] | null;
  startDate: string;
  endDate?: string | null;
  rollover: boolean;
  alertThreshold: number;
  isActive: boolean;
  createdAt: string;
  updatedAt?: string | null;
  timeFrame?: BudgetTimeFrame | null;
  calendar: CalendarKind;
}

function normalizeTimeFrame(raw: unknown): BudgetTimeFrame | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim().toLowerCase();
  if (value === 'unlimited') return 'never';
  if (value === 'daily' || value === 'monthly' || value === 'yearly' || value === 'never') return value;
  return null;
}

export function budgetFromDb(row: Record<string, any>): Budget {
  const type = String(row.type ?? 'monthly') as BudgetType;
  return {
    id: row.id ?? null,
    name: String(row.name ?? ''),
    type,
    amount: Number(row.amount ?? 0),
    categoryId: row.categoryId ?? null,
    categoryIds: decodeCategoryIds(row.categoryIds),
    startDate: String(row.startDate),
    endDate: row.endDate ?? null,
    rollover: row.rollover === 1 || row.rollover === true,
    alertThreshold: Number(row.alertThreshold ?? 80),
    isActive: row.isActive === undefined ? true : row.isActive === 1 || row.isActive === true,
    createdAt: String(row.createdAt ?? new Date().toISOString()),
    updatedAt: row.updatedAt ?? null,
    timeFrame: normalizeTimeFrame(row.timeFrame),
    calendar: row.calendar === 'ethiopian' ? 'ethiopian' : 'gregorian',
  };
}

export function budgetToDb(budget: Budget): Record<string, unknown> {
  const ids = budgetSelectedCategoryIds(budget);
  return {
    name: budget.name,
    type: budget.type,
    amount: budget.amount,
    categoryId: budget.categoryId ?? null,
    categoryIds: ids.length === 0 ? null : JSON.stringify(ids),
    startDate: budget.startDate,
    endDate: budget.endDate ?? null,
    rollover: budget.rollover ? 1 : 0,
    alertThreshold: budget.alertThreshold,
    isActive: budget.isActive ? 1 : 0,
    createdAt: budget.createdAt,
    updatedAt: budget.updatedAt ?? null,
    timeFrame: budget.timeFrame ?? null,
    calendar: budget.calendar,
  };
}

export function budgetSelectedCategoryIds(budget: Budget): number[] {
  return normalizeCategoryIds(budget.categoryIds, budget.categoryId) ?? [];
}

export function budgetAppliesToAllExpenses(budget: Budget): boolean {
  return budgetSelectedCategoryIds(budget).length === 0;
}

export function budgetIncludesCategory(budget: Budget, categoryIds: number[]): boolean {
  if (budgetAppliesToAllExpenses(budget)) return true;
  const selected = budgetSelectedCategoryIds(budget);
  return categoryIds.some((id) => selected.includes(id));
}

export function budgetFrame(budget: Budget): PeriodFrame {
  if (budget.type === 'category') return budget.timeFrame ?? 'monthly';
  return budget.type;
}

export function getCurrentPeriodStart(budget: Budget, now = new Date()): Date {
  const frame = budgetFrame(budget);
  if (frame === 'never') return new Date(budget.startDate);
  return periodStart(now, frame, budget.calendar);
}

export function getCurrentPeriodEnd(budget: Budget, now = new Date()): Date {
  const frame = budgetFrame(budget);
  if (frame === 'never') return budget.endDate ? new Date(budget.endDate) : new Date(2100, 11, 31, 23, 59, 59);
  return periodEndInclusive(now, frame, budget.calendar);
}

export function budgetOverlapsRange(budget: Budget, start: Date, end: Date): boolean {
  const bStart = new Date(budget.startDate).getTime();
  const bEnd = budget.endDate ? new Date(budget.endDate).getTime() : Number.POSITIVE_INFINITY;
  return bStart <= end.getTime() && bEnd >= start.getTime();
}

export function budgetIsEffectiveOn(budget: Budget, date: Date): boolean {
  if (!budget.isActive) return false;
  return budgetOverlapsRange(budget, date, date);
}

export interface BudgetStatus {
  budget: Budget;
  spent: number;
  remaining: number;
  percentageUsed: number;
  periodStart: Date;
  periodEnd: Date;
  isExceeded: boolean;
  isApproachingLimit: boolean;
}

export function budgetFrameLabel(budget: Budget): string {
  switch (budgetFrame(budget)) {
    case 'daily':
      return 'Daily';
    case 'weekly':
      return 'Weekly';
    case 'monthly':
      return 'Monthly';
    case 'yearly':
      return 'Yearly';
    case 'never':
      return 'One-off';
  }
}
